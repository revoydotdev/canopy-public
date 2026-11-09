#!/usr/bin/env node
/**
 * scripts/vi-observe.mjs — ADR-042 Half A producer: the observed plane.
 *
 *   bun scripts/vi-observe.mjs            (also: bun run vi:observe)
 *   bun scripts/vi-observe.mjs --json
 *
 * WHAT THIS DOES. Runs every scenario in the closed catalog
 * (scripts/observation/scenarios.json) as a real child process under
 * `NODE_V8_COVERAGE`, maps every covered function's start offset through the
 * tsc-emitted `.js.map` sitting next to its `packages/*\/dist/**.js` file back
 * to a `packages/*\/src/*.ts` position, resolves that position to the
 * innermost enclosing graph symbol, and aggregates `{symbol_id, scenario_id,
 * run_class, count}` into `.visual-intelligence/observed/observations.jsonl`.
 * This is the dynamic instrument ADR-042 adds alongside the graph's static
 * derived plane — `vi-observed-compare.mjs` is what turns it into findings.
 *
 * WHY BIN/ARBOR-MCP.MJS IS NEVER THE ENTRY. That launcher esbuild-bundles
 * cli.ts fresh into a throwaway temp file on every invocation. A bundle has
 * no committed, stable `.js.map` under `packages/*\/dist/` for this script to
 * resolve function offsets through — the whole resolution mechanism below
 * depends on the dist file and its sourcemap being the same file on disk
 * every run. So every scenario's argv[1] MUST be a real
 * `packages/*\/dist/**.js` file, enforced below.
 *
 * THE CROSS-PACKAGE RESOLUTION GAP (undocumented in ADR-042, discovered
 * while building this). Running `node packages/arbor-mcp/dist/cli.js`
 * directly does NOT work out of the box: every `packages/*\/package.json` in
 * this repository points "main"/"exports" at `./src/index.ts`, so Node
 * resolves every `@arbor/*` cross-package import straight back to
 * unparseable-as-plain-ESM TypeScript — verified empirically, and it is the
 * exact defect `bin/arbor-mcp.mjs`'s own header comment describes as the
 * reason a compiled dist entry "does not fix this either". This script
 * works around it with a small, hand-rolled Node module-customization hook
 * (scripts/observation/dist-resolve-hook.mjs) that redirects bare
 * `@arbor/<pkg>` specifiers to that package's own dist/index.js — no
 * bundling, no new dependency, no source change. It is injected uniformly
 * via `NODE_OPTIONS=--import=...` for every scenario (not per-scenario catalog
 * data): every scenario's contract already requires a dist entry point, so
 * every scenario needs this, and duplicating an environment-specific
 * absolute path into scenarios.json would also poison its content hash
 * across checkouts.
 *
 * COUNT DETERMINISM. `count` is the exact V8 invocation count EXCEPT for
 * scenarios the catalog marks `count_semantics: "presence_only"`, where it is
 * clamped to 1 — see the doc comment beside this file's `count_semantics`
 * handling below for the empirical evidence (real-wall-clock timer races and
 * real /proc enumeration, neither of which the harness can make
 * deterministic) and why findings never depended on the raw magnitude anyway.
 *
 * OFFSET UNIT. V8 coverage offsets are UTF-16 code-unit character offsets
 * into the generated file's text — verified empirically with a multibyte
 * fixture, see scripts/observation/sourcemap.mjs's header and
 * scripts/tests/vi-observe.test.mjs's regression test.
 *
 * SYMBOL SPAN, HONESTLY. `.visual-intelligence/graph/evidence.jsonl` records
 * only `line_start` for every one of its 14094+ records — `line_end` is
 * `null` on 100% of them (verified empirically over the committed store).
 * The graph therefore does not actually carry symbol EXTENTS, only symbol
 * START lines. "Innermost enclosing symbol" is approximated the only way the
 * available data supports: per file, sort every symbol's start line, and
 * resolve a covered position to the LAST symbol whose start line is <= the
 * position's line. This is exact for a symbol's own declaration line (a
 * covered function's start offset lands on or just after its own
 * declaration, so it matches its own node before any other), and correct for
 * nested named symbols (an inner helper function has its own node at its own
 * start line, which sorts after its enclosing function's and so wins first).
 * It is an approximation for genuinely anonymous, undeclared closures, which
 * resolve to their nearest NAMED enclosing symbol — the best available
 * answer given the graph's shape, and the intended one ("innermost
 * *symbol*", and an anonymous closure is not itself a symbol in this graph).
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as http from "node:http";
import { devNull, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSourceMap, offsetToLineColumn, resolvePosition } from "./observation/sourcemap.mjs";
import { computeEvidenceContentHashForStore, readGraphInputBinding } from "./lib/store-provenance.mjs";
import { profileOrDefaults } from "./lib/project-profile.mjs";
import { assertEvidenceProducerAuthority } from "./evidence-transaction.mjs";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
/** Overridable so tests can inject a small failure-mode fixture catalog without running the real, expensive one. */
const CATALOG_PATH = process.env.REVOY2_VI_OBSERVE_CATALOG
  ? resolve(process.env.REVOY2_VI_OBSERVE_CATALOG)
  : join(REPO_ROOT, "scripts", "observation", "scenarios.json");
const REGISTER_HOOK = join(REPO_ROOT, "scripts", "observation", "register-dist-hook.mjs");
const GRAPH_DIR = join(REPO_ROOT, ".visual-intelligence", "graph");

/** Overridable for fixture-based tests — see completion-depth.mjs's REVOY2_COMPLETION_DEPTH_DIR note. */
const STORE_DIR = process.env.REVOY2_VI_OBSERVED_DIR
  ? resolve(process.env.REVOY2_VI_OBSERVED_DIR)
  : join(REPO_ROOT, ".visual-intelligence", "observed");
const OBSERVATIONS_PATH = join(STORE_DIR, "observations.jsonl");
const VISIBILITY_PATH = join(STORE_DIR, "instrument-visibility.jsonl");
const UNMAPPABLE_PATH = join(STORE_DIR, "unmappable.jsonl");
/**
 * Outcome-aware observation (T5.3, 2026-08-23 remediation, hollow-parity.mjs
 * item 2). One JSONL row `{scenario, kind, direction, code, summary}` per
 * `RuntimeCatalogRouter` result with `ok:false`, captured while a scenario
 * runs — see `recordRouterOutcomeIfSinkConfigured` in runtime-catalog.ts for
 * the producer side of the `ARBOR_VI_OUTCOME_SINK` env var this file sets
 * per scenario.
 */
const OUTCOMES_PATH = join(STORE_DIR, "outcomes.jsonl");
const MANIFEST_PATH = join(STORE_DIR, "manifest.json");

const JSON_OUT = process.argv.includes("--json");

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const DIST_ENTRY_PATTERN = /^packages\/[^/]+\/dist\/.+\.js$/;
/**
 * "production"/"demo" are this catalog's pre-existing run classes.
 * "tui"/"web"/"cli" (T5.3, 2026-08-23 remediation) mark the "product-surface"
 * scenarios hollow-parity.mjs item 2 specifically watches for a `validation`
 * outcome from — a real operator-reachable surface producing a validation
 * failure is exactly the Hollow shape that gate exists to catch.
 */
const VALID_RUN_CLASSES = new Set(["production", "demo", "tui", "web", "cli"]);

function loadCatalog(catalogPath) {
  const raw = readFileSync(catalogPath, "utf8");
  const parsed = JSON.parse(raw);
  const scenarios = parsed.scenarios ?? [];
  if (scenarios.length === 0) throw new Error(`vi-observe: catalog at ${catalogPath} declares zero scenarios`);

  const seenIds = new Set();
  for (const s of scenarios) {
    if (!s.id || typeof s.id !== "string") throw new Error(`vi-observe: scenario missing a string id: ${JSON.stringify(s)}`);
    if (seenIds.has(s.id)) throw new Error(`vi-observe: duplicate scenario id '${s.id}'`);
    seenIds.add(s.id);
    if (!VALID_RUN_CLASSES.has(s.run_class)) throw new Error(`vi-observe: scenario '${s.id}' has invalid run_class '${s.run_class}'`);
    if (s.count_semantics !== undefined && s.count_semantics !== "presence_only") {
      throw new Error(`vi-observe: scenario '${s.id}' has invalid count_semantics '${s.count_semantics}' (only "presence_only" is defined; omit the field for the default exact-count semantics)`);
    }
    if (!Array.isArray(s.argv) || s.argv.length < 2 || s.argv[0] !== "node") {
      throw new Error(`vi-observe: scenario '${s.id}' argv must be ["node", <dist entry>, ...]`);
    }
    if (!DIST_ENTRY_PATTERN.test(s.argv[1])) {
      throw new Error(
        `vi-observe: scenario '${s.id}' argv[1] ('${s.argv[1]}') is not a packages/*/dist/**.js entry point — ` +
        `bin/arbor-mcp.mjs and other launchers are forbidden here (see this file's header comment).`,
      );
    }
    if (!Number.isFinite(s.timeout_ms) || s.timeout_ms <= 0) throw new Error(`vi-observe: scenario '${s.id}' needs a positive timeout_ms`);
    if (!Number.isInteger(s.expected_exit)) throw new Error(`vi-observe: scenario '${s.id}' needs an integer expected_exit`);
    if (s.stdin !== undefined && typeof s.stdin !== "string") throw new Error(`vi-observe: scenario '${s.id}' stdin must be a string when present`);
    if (s.stdin_linger_ms !== undefined) {
      if (!Number.isFinite(s.stdin_linger_ms) || s.stdin_linger_ms <= 0) throw new Error(`vi-observe: scenario '${s.id}' stdin_linger_ms must be a positive number when present`);
      if (s.http_probe !== undefined) throw new Error(`vi-observe: scenario '${s.id}' stdin_linger_ms and http_probe are mutually exclusive`);
    }
    if (s.stdin_await_response !== undefined) {
      if (s.stdin_await_response !== true) throw new Error(`vi-observe: scenario '${s.id}' stdin_await_response must be true when present`);
      if (s.stdin_linger_ms === undefined || s.stdin === undefined) throw new Error(`vi-observe: scenario '${s.id}' stdin_await_response requires stdin and stdin_linger_ms`);
    }
    if (s.seed_files !== undefined) {
      if (typeof s.seed_files !== "object" || s.seed_files === null || Array.isArray(s.seed_files)) {
        throw new Error(`vi-observe: scenario '${s.id}' seed_files must be an object of relative-path -> string content`);
      }
      for (const [relPath, content] of Object.entries(s.seed_files)) {
        if (typeof content !== "string") throw new Error(`vi-observe: scenario '${s.id}' seed_files['${relPath}'] must be a string`);
        if (relPath.startsWith("/") || relPath.split("/").includes("..")) {
          throw new Error(`vi-observe: scenario '${s.id}' seed_files key '${relPath}' must be a relative path contained within the scratch cwd`);
        }
      }
    }
    if (s.git_init !== undefined && typeof s.git_init !== "boolean") {
      throw new Error(`vi-observe: scenario '${s.id}' git_init must be a boolean when present`);
    }
    if (s.git_linked_worktree !== undefined) {
      if (typeof s.git_linked_worktree !== "boolean") {
        throw new Error(`vi-observe: scenario '${s.id}' git_linked_worktree must be a boolean when present`);
      }
      if (s.git_linked_worktree && !s.git_init) {
        throw new Error(`vi-observe: scenario '${s.id}' sets git_linked_worktree without git_init — a linked worktree needs a real repo to link from`);
      }
    }
    if (s.http_probe !== undefined) {
      const probe = s.http_probe;
      if (typeof probe !== "object" || probe === null || Array.isArray(probe)) {
        throw new Error(`vi-observe: scenario '${s.id}' http_probe must be an object`);
      }
      if (typeof probe.ready_pattern !== "string" || probe.ready_pattern.length === 0) {
        throw new Error(`vi-observe: scenario '${s.id}' http_probe.ready_pattern must be a non-empty string`);
      }
      if (!Array.isArray(probe.requests)) {
        throw new Error(`vi-observe: scenario '${s.id}' http_probe.requests must be an array`);
      }
      if (probe.bootstrap_operator_session !== undefined && typeof probe.bootstrap_operator_session !== "boolean") {
        throw new Error(`vi-observe: scenario '${s.id}' http_probe.bootstrap_operator_session must be a boolean when present`);
      }
      for (const [index, request] of probe.requests.entries()) {
        if (typeof request !== "object" || request === null) throw new Error(`vi-observe: scenario '${s.id}' http_probe.requests[${index}] must be an object`);
        if (typeof request.method !== "string") throw new Error(`vi-observe: scenario '${s.id}' http_probe.requests[${index}].method must be a string`);
        if (typeof request.path !== "string" || !request.path.startsWith("/")) throw new Error(`vi-observe: scenario '${s.id}' http_probe.requests[${index}].path must be an absolute path`);
        if (request.body !== undefined && typeof request.body !== "string" && typeof request.body !== "object") {
          throw new Error(`vi-observe: scenario '${s.id}' http_probe.requests[${index}].body must be a string or object when present`);
        }
      }
      if (probe.shutdown_signal !== undefined && typeof probe.shutdown_signal !== "string") {
        throw new Error(`vi-observe: scenario '${s.id}' http_probe.shutdown_signal must be a string when present`);
      }
    }
  }

  const catalogHash = sha256Hex(canonical(parsed)).slice(0, 16);
  return { scenarios, catalogHash };
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

const scratchDirs = [];
function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/**
 * Env vars that redirect git's repo/work-tree discovery away from `-C`/`cwd`
 * — the same leak `@arbor/campaign-support`'s `WorktreeManager` guards
 * against (see its `sanitizedGitEnv` doc comment). vi-observe runs from
 * inside this checkout, which git commands elsewhere in the parent process
 * could in principle have exported one of these into; stripped here so the
 * scratch `git init` below is genuinely isolated from wherever it's invoked.
 */
const GIT_SCOPE_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];
function sanitizedGitEnv(base = process.env) {
  const env = { ...base };
  // The same isolation the vitest suite gets from
  // scripts/tests/setup-isolate-operator-scope.mjs: a scenario that asserts
  // "no native provider" or "credential absent" was true only while the
  // operator had no ~/.arbor/arbor.jsonc or ~/.config/revoy/revoy.env. On
  // 2026-09-04 the close's rebind failed on the operator's OpenRouter block.
  const operatorScope = mkdtempSync(join(tmpdir(), "vi-observe-operator-scope-"));
  env.ARBOR_USER_CONFIG_DIR = join(operatorScope, "user");
  env.ARBOR_ORGANIZATION_CONFIG_DIR = join(operatorScope, "organization");
  env.XDG_CONFIG_HOME = join(operatorScope, "xdg");
  for (const key of ["ARBOR_NATIVE_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete env[key];
  for (const key of GIT_SCOPE_ENV_VARS) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG_")) delete env[key];
  delete env.GIT_TEMPLATE_DIR;
  // Scenarios are hermetic evidence fixtures. They may read/write repository-
  // local config, but neither the operator's global config nor system config
  // may inject hooks, aliases, templates, signing, or other workstation state
  // into nested git commands the production process launches.
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

/**
 * Pre-spawn hook for `git_init: true` scenarios (ADR-001 worktree isolation
 * needs a REAL git repository with a resolvable HEAD — `git rev-parse HEAD`
 * and `git worktree add` cannot be satisfied by hand-seeded UTF-8 files,
 * since git objects are SHA-1-addressed zlib binary; see this file's header
 * comment and the scenario schema notes above `git_init`'s validation). Runs
 * strictly after `seed_files` so any seeded content lands in the initial
 * commit. Produces a genuine one-commit repo — deterministic in shape (a
 * fixed branch name, a fixed committer identity, one commit) but not in
 * hash (commit ids embed a wall-clock timestamp), which is fine: nothing
 * downstream depends on a specific commit SHA, only on `HEAD` resolving and
 * the working tree being clean enough for `git worktree add` to succeed.
 * The scratch repo also pins `core.hooksPath` locally. Git otherwise inherits
 * the operator's global managed-hook path, which can execute repository-
 * specific hooks inside this intentionally minimal fixture and make evidence
 * generation depend on ambient workstation configuration.
 */
function gitInitScratchRepo(cwd, scenarioId) {
  const env = sanitizedGitEnv();
  const run = (args) => {
    const res = spawnSync("git", args, { cwd, env, encoding: "utf-8" });
    if (res.status !== 0) {
      throw new Error(`vi-observe: scenario '${scenarioId}' git_init step 'git ${args.join(" ")}' failed:\n${res.stderr}`);
    }
  };
  // Branch name deliberately not "main"/"master": `arbor selfhost` refuses
  // to target a repo checked out on either (FORBIDDEN_BRANCHES,
  // selfhost.ts), and a git_init scenario needs to compose with every
  // consumer of a real repo, not just WorktreeManager (which names its own
  // branches and never cares about the starting one).
  run(["init", "-q", "-b", "vi-observe-scratch"]);
  run(["config", "core.hooksPath", ".git/hooks"]);
  run(["config", "user.email", "vi-observe@revoy2.invalid"]);
  run(["config", "user.name", "vi-observe"]);
  run(["add", "-A"]);
  run(["commit", "-q", "--allow-empty", "-m", "vi-observe scratch seed"]);
}

/**
 * `git_linked_worktree: true` scenarios also grow a real LINKED worktree at
 * `<cwd>/linked-worktree`, checked out on its own non-forbidden branch. This
 * exists because `arbor selfhost` (selfhost.ts's `resolvePrimaryCheckout` /
 * `evaluateTargetSafety`) refuses to target its own primary checkout — the
 * exact repo `process.cwd()` belongs to — as a self-hosting safety boundary.
 * A bare `git_init` repo IS its own primary checkout (one worktree, nothing
 * to distinguish), so `arbor selfhost --target .` inside one always trips
 * `forbidden_primary_checkout`. Passing `--target linked-worktree` (a
 * genuine linked worktree of the same repo) is a different, non-primary
 * checkout and clears the guard — the real distinction the guard is
 * checking for, reproduced with a real second worktree rather than defeated.
 */
function gitAddLinkedWorktree(cwd, scenarioId) {
  const env = sanitizedGitEnv();
  const run = (args) => {
    const res = spawnSync("git", args, { cwd, env, encoding: "utf-8" });
    if (res.status !== 0) {
      throw new Error(`vi-observe: scenario '${scenarioId}' git_linked_worktree step 'git ${args.join(" ")}' failed:\n${res.stderr}`);
    }
  };
  run(["worktree", "add", "-b", "vi-observe-linked", "linked-worktree", "vi-observe-scratch"]);
}

/**
 * All outcome rows recorded by every scenario run this process, in
 * completion order — folded into `.visual-intelligence/observed/outcomes.jsonl`
 * by `main()`. See `OUTCOMES_PATH`'s doc comment.
 */
const outcomeRows = [];

/**
 * One process-scoped scratch outcome sink per scenario, wired to
 * `ARBOR_VI_OUTCOME_SINK` (see runtime-catalog.ts's
 * `recordRouterOutcomeIfSinkConfigured`). Reads back whatever the scenario's
 * child process appended, tags each row with `scenario`/`run_class`, and
 * folds it into the shared `outcomeRows` array. Absence (no file — the
 * scenario never hit an `ok:false` router result) is not an error.
 *
 * `scratchCwd` is replaced with a stable placeholder inside `summary`: some
 * real router errors interpolate an absolute path under the scenario's own
 * `mkdtempSync` scratch cwd (e.g. a governance ENOENT naming its scanned
 * directory) — a random suffix by construction, on every scenario that
 * reaches that path, not only new ones. Left unredacted, outcomes.jsonl
 * would never be byte-identical across two `vi:observe` runs regardless of
 * this lane's own changes, defeating gate:vi-reproducible's discipline.
 */
function collectScenarioOutcomes(sinkPath, scenario, scratchCwd) {
  if (!existsSync(sinkPath)) return;
  for (const line of readFileSync(sinkPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const summary = scratchCwd ? record.summary.split(scratchCwd).join("<scenario-scratch-cwd>") : record.summary;
    outcomeRows.push({ scenario: scenario.id, kind: record.kind, direction: record.direction, code: record.code, summary });
  }
}

/**
 * Run one scenario as a real child process. Returns the coverage directory's
 * contents (parsed) on success. Throws on timeout or exit-code mismatch —
 * ADR-042: "a scenario exiting != expected_exit fails the whole run loudly."
 */
function runProcessScenario(scenario) {
  const scratch = scratchDir(`vi-observe-${scenario.id}-`);
  const cwd = join(scratch, "cwd");
  const coverageDir = join(scratch, "coverage");
  const outcomeSinkPath = join(scratch, "outcomes.jsonl");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(coverageDir, { recursive: true });

  // Optional hermetic pre-seeding: writes each entry's content into `cwd`
  // before the scenario runs (e.g. a populated project-registry.json a
  // freshly-minted scratch dir could otherwise never contain). Keys are
  // relative paths validated in loadCatalog to stay inside the scratch
  // cwd; content is a literal string committed in scenarios.json, so it
  // participates in the catalog's own content hash rather than depending
  // on any external fixture file (which would poison the hash the same
  // way an absolute path would — see this file's header comment).
  for (const [relPath, content] of Object.entries(scenario.seed_files ?? {})) {
    const abs = join(cwd, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  // Optional pre-spawn hook: turns the scratch cwd into a real git
  // repository before the scenario process is spawned. See
  // `gitInitScratchRepo`'s doc comment for why this is a `git init`, not
  // hand-forged `.git` bytes.
  if (scenario.git_init) gitInitScratchRepo(cwd, scenario.id);
  if (scenario.git_linked_worktree) gitAddLinkedWorktree(cwd, scenario.id);

  const entryAbs = resolve(REPO_ROOT, scenario.argv[1]);
  if (!existsSync(entryAbs)) {
    throw new Error(`vi-observe: scenario '${scenario.id}' entry point does not exist: ${entryAbs} — run \`npm run build\` first`);
  }
  const args = [entryAbs, ...scenario.argv.slice(2)];

  const scenarioNodeOptions = scenario.env?.NODE_OPTIONS;
  const nodeOptions = [`--import=${pathToFileURL(REGISTER_HOOK).href}`, scenarioNodeOptions].filter(Boolean).join(" ");
  const additiveEnv = Object.fromEntries(Object.entries(scenario.env ?? {}).filter(([k]) => k !== "NODE_OPTIONS"));

  const env = sanitizedGitEnv({
    ...process.env,
    ...additiveEnv,
    NODE_V8_COVERAGE: coverageDir,
    NODE_OPTIONS: nodeOptions,
    // T5.3: every scenario's own scratch-dir outcome sink — see
    // `collectScenarioOutcomes`'s doc comment and runtime-catalog.ts's
    // `recordRouterOutcomeIfSinkConfigured`.
    ARBOR_VI_OUTCOME_SINK: outcomeSinkPath,
    // Hermetic: no ambient persistence root leaks in from the caller's shell.
    ARBOR_PERSISTENCE_DIR: undefined,
  });
  delete env.ARBOR_PERSISTENCE_DIR;

  // Literal "node", never process.execPath: this producer is itself runnable
  // via `bun scripts/vi-observe.mjs` (bun run vi:observe), under which
  // process.execPath is the bun binary — every scenario's contract (argv[0]
  // === "node", enforced in loadCatalog above) declares Node specifically,
  // and the whole NODE_V8_COVERAGE + node:module-hooks mechanism this file
  // depends on is Node-specific. Verified empirically: running scenarios
  // under bun produced zero coverage files where node produced hundreds.
  const result = spawnSync("node", args, {
    cwd,
    env,
    encoding: "utf-8",
    timeout: scenario.timeout_ms,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    // Written to the child's stdin then the pipe is closed (Node's own
    // spawnSync contract) — the mechanism `arbor serve` and `arbor tui`
    // both rely on for a clean EOF-driven shutdown. Absent scenarios keep
    // today's behavior: no `input` still yields an immediately-closed
    // empty stdin (verified empirically), unchanged for every prior entry.
    ...(scenario.stdin === undefined ? {} : { input: scenario.stdin }),
  });

  if (result.error && result.error.code === "ETIMEDOUT") {
    throw new Error(`vi-observe: scenario '${scenario.id}' exceeded its ${scenario.timeout_ms}ms timeout`);
  }
  if (result.signal) {
    throw new Error(`vi-observe: scenario '${scenario.id}' was killed by signal ${result.signal} (timeout budget ${scenario.timeout_ms}ms)`);
  }
  if (result.status !== scenario.expected_exit) {
    throw new Error(
      `vi-observe: scenario '${scenario.id}' exited ${result.status}, expected ${scenario.expected_exit}.\n` +
      `  argv: ${JSON.stringify(scenario.argv)}\n` +
      `  stdout (tail): ${(result.stdout ?? "").slice(-2000)}\n` +
      `  stderr (tail): ${(result.stderr ?? "").slice(-2000)}`,
    );
  }

  collectScenarioOutcomes(outcomeSinkPath, scenario, cwd);
  const coverageFiles = readdirSync(coverageDir).filter((f) => f.startsWith("coverage-") && f.endsWith(".json"));
  return coverageFiles.map((f) => JSON.parse(readFileSync(join(coverageDir, f), "utf8")));
}

// ---------------------------------------------------------------------------
// HTTP-probe scenario execution (T5.3, 2026-08-23 remediation)
// ---------------------------------------------------------------------------

/** One HTTP request against a live scenario server, returned once its response settles. */
function httpRequestOnce(port, request, sessionHeaders = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hasBody = request.body !== undefined;
    const bodyText = hasBody ? (typeof request.body === "string" ? request.body : JSON.stringify(request.body)) : undefined;
    const options = {
      host: "127.0.0.1",
      port,
      method: request.method,
      path: request.path,
      headers: hasBody ? { ...sessionHeaders, "content-type": "application/json", "content-length": Buffer.byteLength(bodyText) } : sessionHeaders,
    };
    const clientRequest = http.request(options, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk.toString(); });
      response.on("end", () => resolvePromise({ status: response.statusCode, body, headers: response.headers }));
      if (request.sse) {
        // An SSE response never ends on its own — take the first pushed
        // event (or timeout) as proof the route was reached, then let the
        // scenario's own shutdown_signal close the whole child process
        // (which drops this socket too).
        setTimeout(() => { clientRequest.destroy(); resolvePromise({ status: response.statusCode, body, headers: response.headers }); }, request.wait_ms ?? 200);
      }
    });
    clientRequest.on("error", (error) => {
      // A destroyed SSE socket legitimately raises ECONNRESET/ECONNABORTED
      // after this function already resolved — never let it become an
      // unhandled rejection for a request nobody is awaiting any more.
      if (request.sse) return;
      rejectPromise(error);
    });
    if (hasBody) clientRequest.write(bodyText);
    clientRequest.end();
  });
}

/**
 * Run one `http_probe` scenario: spawn its dist entry as a real child
 * process (same coverage/outcome-sink instrumentation as `runProcessScenario`),
 * wait for `http_probe.ready_pattern` to appear on stderr (capturing the
 * live port when HTTP requests are declared), issue every configured request
 * in order against it, then send
 * `http_probe.shutdown_signal` (default SIGINT) and await a clean exit —
 * the same interrupt-driven shutdown path `arbor webui`/`arbor serve` use
 * for a real operator Ctrl-C. Never uses `spawnSync`: probing a live server
 * mid-run is inherently asynchronous.
 */
function runHttpProbeScenario(scenario) {
  const scratch = scratchDir(`vi-observe-${scenario.id}-`);
  const cwd = join(scratch, "cwd");
  const coverageDir = join(scratch, "coverage");
  const outcomeSinkPath = join(scratch, "outcomes.jsonl");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(coverageDir, { recursive: true });

  for (const [relPath, content] of Object.entries(scenario.seed_files ?? {})) {
    const abs = join(cwd, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  if (scenario.git_init) gitInitScratchRepo(cwd, scenario.id);
  if (scenario.git_linked_worktree) gitAddLinkedWorktree(cwd, scenario.id);

  const entryAbs = resolve(REPO_ROOT, scenario.argv[1]);
  if (!existsSync(entryAbs)) {
    throw new Error(`vi-observe: scenario '${scenario.id}' entry point does not exist: ${entryAbs} — run \`npm run build\` first`);
  }
  const args = [entryAbs, ...scenario.argv.slice(2)];
  const scenarioNodeOptions = scenario.env?.NODE_OPTIONS;
  const nodeOptions = [`--import=${pathToFileURL(REGISTER_HOOK).href}`, scenarioNodeOptions].filter(Boolean).join(" ");
  const additiveEnv = Object.fromEntries(Object.entries(scenario.env ?? {}).filter(([k]) => k !== "NODE_OPTIONS"));
  const env = sanitizedGitEnv({
    ...process.env,
    ...additiveEnv,
    NODE_V8_COVERAGE: coverageDir,
    NODE_OPTIONS: nodeOptions,
    ARBOR_VI_OUTCOME_SINK: outcomeSinkPath,
    ARBOR_PERSISTENCE_DIR: undefined,
  });
  delete env.ARBOR_PERSISTENCE_DIR;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("node", args, { cwd, env });
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    let requestsStarted = false;
    const readyPattern = new RegExp(scenario.http_probe.ready_pattern);

    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timeoutHandle); fn(); };

    const timeoutHandle = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error(`vi-observe: scenario '${scenario.id}' exceeded its ${scenario.timeout_ms}ms http_probe timeout (ready_pattern matched: ${requestsStarted})`));
      });
    }, scenario.timeout_ms);

    child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString(); });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      if (requestsStarted) return;
      const match = readyPattern.exec(stderrBuf);
      if (!match) return;
      requestsStarted = true;
      const port = Number(match[1]);
      (async () => {
        let sessionHeaders = {};
        if (scenario.http_probe.bootstrap_operator_session) {
          const bootstrapToken = match[2];
          if (!bootstrapToken) throw new Error("ready_pattern must capture the operator bootstrap token as group 2");
          const bootstrap = await httpRequestOnce(port, { method: "GET", path: `/?operator_token=${encodeURIComponent(bootstrapToken)}` });
          const cookie = bootstrap.headers["set-cookie"]?.[0]?.split(";", 1)[0];
          if (bootstrap.status !== 303 || !cookie) throw new Error(`operator bootstrap exchange failed with HTTP ${bootstrap.status ?? "unknown"}`);
          sessionHeaders = { cookie };
        }
        for (const request of scenario.http_probe.requests) {
          await httpRequestOnce(port, request, sessionHeaders);
        }
      })()
        .catch((error) => { stderrBuf += `\n[vi-observe http_probe request error] ${error instanceof Error ? error.message : String(error)}`; })
        .finally(() => { child.kill(scenario.http_probe.shutdown_signal ?? "SIGINT"); });
    });
    child.on("error", (error) => finish(() => rejectPromise(error)));
    child.on("exit", (code, signal) => {
      finish(() => {
        if (code !== scenario.expected_exit) {
          rejectPromise(new Error(
            `vi-observe: scenario '${scenario.id}' exited ${code} (signal ${signal}), expected ${scenario.expected_exit}.\n` +
            `  argv: ${JSON.stringify(scenario.argv)}\n` +
            `  stdout (tail): ${stdoutBuf.slice(-2000)}\n` +
            `  stderr (tail): ${stderrBuf.slice(-2000)}`,
          ));
          return;
        }
        collectScenarioOutcomes(outcomeSinkPath, scenario, cwd);
        const coverageFiles = readdirSync(coverageDir).filter((f) => f.startsWith("coverage-") && f.endsWith(".json"));
        resolvePromise(coverageFiles.map((f) => JSON.parse(readFileSync(join(coverageDir, f), "utf8"))));
      });
    });
  });
}

/**
 * Run one `stdin_linger_ms` scenario: a real child process (same coverage/
 * outcome-sink instrumentation as `runProcessScenario`), stdin written
 * immediately but held open — NOT closed the instant the write completes —
 * for at least `stdin_linger_ms` real milliseconds before EOF, then awaited
 * to exit.
 *
 * Why this exists: `runProcessScenario` uses `spawnSync` with a static
 * `input` string, which Node writes and closes essentially instantly (sub-
 * second, verified empirically 2026-09-18) — fine for every scenario whose
 * target reacts to stdin bytes or an immediate EOF, but unable to observe a
 * product surface whose only call path is a periodic `setInterval` the
 * process's own stdin-EOF shutdown handler tears down before it can ever
 * fire (e.g. `arbor tui`'s 2s `executionStatusTimer` racing its
 * `stdin.once("end", finish)` teardown). This scenario kind buys that timer
 * real wall-clock headroom the same way `http_probe`'s `wait_ms` buys an SSE
 * response one, without inventing a second transport: still one real spawned
 * dist entry, same env/coverage/outcome-sink wiring, only the EOF timing
 * differs.
 */
function runLingeringStdinScenario(scenario) {
  const scratch = scratchDir(`vi-observe-${scenario.id}-`);
  const cwd = join(scratch, "cwd");
  const coverageDir = join(scratch, "coverage");
  const outcomeSinkPath = join(scratch, "outcomes.jsonl");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(coverageDir, { recursive: true });

  for (const [relPath, content] of Object.entries(scenario.seed_files ?? {})) {
    const abs = join(cwd, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  if (scenario.git_init) gitInitScratchRepo(cwd, scenario.id);
  if (scenario.git_linked_worktree) gitAddLinkedWorktree(cwd, scenario.id);

  const entryAbs = resolve(REPO_ROOT, scenario.argv[1]);
  if (!existsSync(entryAbs)) {
    throw new Error(`vi-observe: scenario '${scenario.id}' entry point does not exist: ${entryAbs} — run \`npm run build\` first`);
  }
  const args = [entryAbs, ...scenario.argv.slice(2)];
  const scenarioNodeOptions = scenario.env?.NODE_OPTIONS;
  const nodeOptions = [`--import=${pathToFileURL(REGISTER_HOOK).href}`, scenarioNodeOptions].filter(Boolean).join(" ");
  const additiveEnv = Object.fromEntries(Object.entries(scenario.env ?? {}).filter(([k]) => k !== "NODE_OPTIONS"));
  const env = sanitizedGitEnv({
    ...process.env,
    ...additiveEnv,
    NODE_V8_COVERAGE: coverageDir,
    NODE_OPTIONS: nodeOptions,
    ARBOR_VI_OUTCOME_SINK: outcomeSinkPath,
    ARBOR_PERSISTENCE_DIR: undefined,
  });
  delete env.ARBOR_PERSISTENCE_DIR;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("node", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timeoutHandle); fn(); };

    const timeoutHandle = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error(`vi-observe: scenario '${scenario.id}' exceeded its ${scenario.timeout_ms}ms timeout (stdin_linger_ms ${scenario.stdin_linger_ms})`));
      });
    }, scenario.timeout_ms);

    child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString(); });
    child.on("error", (error) => finish(() => rejectPromise(error)));
    child.on("exit", (code, signal) => {
      finish(() => {
        if (code !== scenario.expected_exit) {
          rejectPromise(new Error(
            `vi-observe: scenario '${scenario.id}' exited ${code} (signal ${signal}), expected ${scenario.expected_exit}.\n` +
            `  argv: ${JSON.stringify(scenario.argv)}\n` +
            `  stdout (tail): ${stdoutBuf.slice(-2000)}\n` +
            `  stderr (tail): ${stderrBuf.slice(-2000)}`,
          ));
          return;
        }
        collectScenarioOutcomes(outcomeSinkPath, scenario, cwd);
        const coverageFiles = readdirSync(coverageDir).filter((f) => f.startsWith("coverage-") && f.endsWith(".json"));
        resolvePromise(coverageFiles.map((f) => JSON.parse(readFileSync(join(coverageDir, f), "utf8"))));
      });
    });

    // `stdin_await_response` paces stdin by the child's own answers: a line that
    // is a JSON-RPC request (has an `id`) is followed by the next line only
    // once a stdout line carrying that same id has arrived, so a server that
    // handles requests concurrently sees request N+1 only after request N has
    // finished (a retry that must observe the prior retry's state). Pacing on
    // the response, never on a fixed delay, keeps this independent of host
    // load. The scenario's own timeout bounds a response that never comes,
    // and `stdin_linger_ms` still runs after the last line.
    const writeAll = async () => {
      const lines = scenario.stdin === undefined ? [] : scenario.stdin_await_response ? scenario.stdin.split(/(?<=\n)/u).filter((line) => line.length > 0) : [scenario.stdin];
      for (const line of lines) {
        if (settled || child.stdin.destroyed) return;
        child.stdin.write(line);
        if (!scenario.stdin_await_response) continue;
        let id;
        try { id = JSON.parse(line).id; } catch { id = undefined; }
        if (id === undefined) continue;
        while (!settled && !stdoutLines().some((out) => { try { return JSON.parse(out).id === id; } catch { return false; } })) {
          await new Promise((done) => setTimeout(done, 50));
        }
      }
    };
    const stdoutLines = () => stdoutBuf.split("\n").filter((line) => line.length > 0);
    void writeAll().then(() => { setTimeout(() => { if (!child.stdin.destroyed) child.stdin.end(); }, scenario.stdin_linger_ms); });
  });
}

/** Dispatch to the process-based, HTTP-probe, or lingering-stdin scenario runner. Always returns a Promise. */
async function runScenario(scenario) {
  if (scenario.http_probe) return runHttpProbeScenario(scenario);
  if (scenario.stdin_linger_ms) return runLingeringStdinScenario(scenario);
  return runProcessScenario(scenario);
}

// ---------------------------------------------------------------------------
// Graph symbol index
// ---------------------------------------------------------------------------

function readJsonlLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

/** Map repository_path -> [{ line (1-indexed), id }], sorted ascending by line. */
function loadGraphSymbolIndex() {
  const evidenceById = new Map();
  for (const line of readJsonlLines(join(GRAPH_DIR, "evidence.jsonl"))) {
    const record = JSON.parse(line);
    evidenceById.set(record.id, record);
  }

  const byFile = new Map();
  for (const line of readJsonlLines(join(GRAPH_DIR, "nodes.jsonl"))) {
    const record = JSON.parse(line);
    if (record.kind !== "symbol") continue;
    const startLines = (record.source_evidence ?? [])
      .map((id) => evidenceById.get(id))
      .filter(Boolean)
      .map((e) => e.line_start)
      .filter((n) => typeof n === "number" && n > 0);
    if (startLines.length === 0) continue;
    const startLine = Math.min(...startLines);
    if (!byFile.has(record.repository_path)) byFile.set(record.repository_path, []);
    byFile.get(record.repository_path).push({ line: startLine, id: record.id });
  }
  for (const arr of byFile.values()) arr.sort((a, b) => a.line - b.line);
  return byFile;
}

/** Innermost-enclosing-by-start-line resolution — see this file's header comment for why. */
function resolveSymbolAt(symbolIndex, repositoryPath, oneIndexedLine) {
  const arr = symbolIndex.get(repositoryPath);
  if (!arr) return { symbolId: null, reason: "file_not_in_graph" };
  let lo = 0;
  let hi = arr.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].line <= oneIndexedLine) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best === -1) return { symbolId: null, reason: "no_enclosing_symbol" };
  return { symbolId: arr[best].id, reason: null };
}

// ---------------------------------------------------------------------------
// Coverage -> source position
// ---------------------------------------------------------------------------

function loadDistCacheEntry(cache, distAbsPath) {
  if (cache.has(distAbsPath)) return cache.get(distAbsPath);
  let text = null;
  let map = null;
  try { text = readFileSync(distAbsPath, "utf8"); } catch { /* file vanished between listing and read */ }
  const mapPath = `${distAbsPath}.map`;
  if (existsSync(mapPath)) {
    try { map = loadSourceMap(readFileSync(mapPath, "utf8")); } catch { map = null; }
  }
  const entry = { text, map };
  cache.set(distAbsPath, entry);
  return entry;
}

/** Resolve a covered function's start offset in one dist file to a repo-relative src path + 1-indexed line. */
function mapOffsetToSource(cache, distAbsPath, startOffset) {
  const entry = loadDistCacheEntry(cache, distAbsPath);
  if (!entry.text) return { reason: "dist_file_unreadable" };
  if (!entry.map) return { reason: "no_sourcemap" };
  const { line, column } = offsetToLineColumn(entry.text, startOffset);
  const pos = resolvePosition(entry.map, line, column);
  if (!pos) return { reason: "no_mapping" };
  const srcAbs = resolve(dirname(distAbsPath), pos.source);
  const repositoryPath = relative(REPO_ROOT, srcAbs);
  if (repositoryPath.startsWith("..")) return { reason: "mapped_outside_repo" };
  return { repositoryPath, line: pos.line + 1 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  assertEvidenceProducerAuthority(REPO_ROOT);
  const { scenarios, catalogHash } = loadCatalog(CATALOG_PATH);
  const symbolIndex = loadGraphSymbolIndex();

  // observation key: `${symbol_id}::${scenario_id}` -> { symbol_id, scenario_id, run_class, count }
  const observations = new Map();
  // visibility key: `${symbol_id}::${run_class}` -> { symbol_id, run_class }.
  // V8 lists every function of a LOADED script, invoked or not — a mapped
  // zero-count range proves the instrument CAN see the symbol. A symbol with
  // no function range at all (an exported constant, a pure type) can never be
  // observed, and treating its permanent absence as a hollow lead is noise;
  // the compare step therefore requires visibility before candidacy.
  const visibility = new Map();
  // unmappable key: `${file}::${reason}` -> { file, reason, occurrences, example }
  const unmappable = new Map();
  const distCache = new Map();

  for (const scenario of scenarios) {
    const coverageFiles = await runScenario(scenario);
    for (const coverage of coverageFiles) {
      for (const script of coverage.result ?? []) {
        if (!script.url.startsWith("file://")) continue;
        let scriptPath;
        try { scriptPath = fileURLToPath(script.url); } catch { continue; }
        const scriptRel = relative(REPO_ROOT, scriptPath);
        if (scriptRel.startsWith("..")) continue; // outside this checkout entirely (node internals, etc.)
        if (!scriptRel.startsWith(`packages${"/"}`) || !scriptRel.includes(`${"/"}dist${"/"}`)) continue;

        script.functions.forEach((fn, index) => {
          // The first entry is V8's synthetic whole-script wrapper (empty name,
          // offset 0..EOF) — not a symbol, skip it. Later anonymous functions
          // (also empty name, nonzero offset) are real coverage and proceed
          // through normal resolution.
          if (index === 0 && fn.functionName === "" && fn.ranges[0]?.startOffset === 0) return;
          const rootRange = fn.ranges[0];
          if (!rootRange) return;
          // Uninvoked functions of a loaded script still contribute
          // instrument VISIBILITY (mapped best-effort, no unmappable noise
          // for support evidence); only invoked ones become observations.
          const invoked = rootRange.count > 0;

          const mapped = mapOffsetToSource(distCache, scriptPath, rootRange.startOffset);
          if (mapped.reason) {
            if (!invoked) return;
            const key = `${scriptRel}::${mapped.reason}`;
            const existing = unmappable.get(key);
            if (existing) existing.occurrences += 1;
            else unmappable.set(key, { file: scriptRel, reason: mapped.reason, occurrences: 1, example_function: fn.functionName || "(anonymous)" });
            return;
          }

          const { symbolId, reason } = resolveSymbolAt(symbolIndex, mapped.repositoryPath, mapped.line);
          if (reason) {
            if (!invoked) return;
            const key = `${mapped.repositoryPath}::${reason}`;
            const existing = unmappable.get(key);
            if (existing) existing.occurrences += 1;
            else {
              unmappable.set(key, {
                file: mapped.repositoryPath, reason, occurrences: 1,
                example_function: fn.functionName || "(anonymous)", example_line: mapped.line,
              });
            }
            return;
          }

          const visKey = `${symbolId}::${scenario.run_class}`;
          if (!visibility.has(visKey)) visibility.set(visKey, { symbol_id: symbolId, run_class: scenario.run_class });
          if (!invoked) return;

          // count_semantics: "presence_only" (2026-09-18 determinism remediation).
          // A handful of scenarios spawn a process whose invocation counts are
          // provably a function of real wall-clock scheduling (a long-lived
          // TUI's several independent setInterval timers racing the scenario's
          // observation window) or of literal host-machine state (sandbox-
          // broker.ts's and repo-flight-process.ts's real /proc enumeration,
          // whose count is exactly "how many processes exist on this machine
          // right now") rather than of the scenario's own deterministic input.
          // Verified empirically 2026-09-18 over 3 consecutive full-catalog
          // `vi:observe` runs plus 5 isolated single-scenario runs: PRESENCE
          // (was this symbol invoked at least once under this scenario) was
          // 100% stable across every run; only the raw magnitude varied, by
          // as much as ~30% run to run. vi-observed-compare.mjs's
          // hollow_candidate/observed_unreachable findings already depend
          // only on presence (`productionTotal > 0`), never on magnitude —
          // this clamp makes the STORED fact match the fact findings actually
          // rely on, instead of persisting a number that looks precise but
          // is not reproducible. Every other scenario's count remains the
          // exact, already-deterministic V8 invocation count — this is a
          // narrow, evidence-scoped clamp, not a blanket one.
          const obsKey = `${symbolId}::${scenario.id}`;
          const existing = observations.get(obsKey);
          if (scenario.count_semantics === "presence_only") {
            if (!existing) observations.set(obsKey, { symbol_id: symbolId, scenario_id: scenario.id, run_class: scenario.run_class, count: 1 });
          } else if (existing) existing.count += rootRange.count;
          else observations.set(obsKey, { symbol_id: symbolId, scenario_id: scenario.id, run_class: scenario.run_class, count: rootRange.count });
        });
      }
    }
  }

  const observationRows = [...observations.values()].sort((a, b) =>
    a.symbol_id < b.symbol_id ? -1 : a.symbol_id > b.symbol_id ? 1 : (a.scenario_id < b.scenario_id ? -1 : 1));
  const visibilityRows = [...visibility.values()].sort((a, b) =>
    a.symbol_id < b.symbol_id ? -1 : a.symbol_id > b.symbol_id ? 1 : (a.run_class < b.run_class ? -1 : 1));
  const unmappableRows = [...unmappable.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.reason < b.reason ? -1 : 1)));
  // Deterministic, byte-identical ordering across runs (gate:vi-reproducible) —
  // same sort discipline as every other plane above: total order over every
  // field the schema declares, never insertion order.
  const outcomeRowsSorted = [...outcomeRows].sort((a, b) => {
    for (const key of ["scenario", "kind", "direction", "code", "summary"]) {
      if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
    }
    return 0;
  });

  const rev = (() => { try { return git(["rev-parse", "HEAD"]); } catch { return "unknown"; } })();
  // Same dirtiness idea vi-refresh.mjs uses for the graph: uncommitted paths
  // outside the generated planes mean this store describes a working tree,
  // not necessarily the named revision.
  // Every configured evidence store, not just this one. `evidence:rebind`
  // runs the producers in sequence, so by the time this stamps `tree_state`
  // its SIBLINGS have already written `.claim-ledger/` and
  // `.completion-depth/` and left them uncommitted for the caller to commit.
  // Counting a sibling's derived output as source drift made `tree_state`
  // "dirty" on every single refresh, which `gate:vi-freshness` then rejected
  // as "a state no commit has" — the chain poisoned its own next run.
  const evidenceStorePrefixes = profileOrDefaults(REPO_ROOT).governance.evidence_stores;
  const dirtyPaths = (() => {
    try {
      return git(["status", "--porcelain"]).split("\n")
        .filter((l) => l.trim() && !evidenceStorePrefixes.some((store) => l.includes(`${store}/`)))
        .length;
    } catch { return -1; }
  })();

  mkdirSync(STORE_DIR, { recursive: true });
  const manifest = {
    schema_version: 1,
    scanned_up_to_revision: rev,
    content_hash: computeEvidenceContentHashForStore(REPO_ROOT, "vi-observed"),
    // ADR-183: the graph this observation consumed, by input binding (null = none).
    graph_input_binding: readGraphInputBinding(REPO_ROOT),
    tree_state: dirtyPaths === 0 ? "clean" : dirtyPaths > 0 ? "dirty" : "unknown",
    catalog_content_hash: catalogHash,
    scenario_count: scenarios.length,
    node_version: process.version,
    generated_at: new Date().toISOString(),
    observation_count: observationRows.length,
    // Bounded by symbol count x run classes — never by event count.
    visibility_count: visibilityRows.length,
    unmappable_count: unmappableRows.length,
    // Bound (Commandment IX): unmappable entries are deduped per (file, reason)
    // with an occurrence tally, not one row per hit — proportional to distinct
    // files x failure modes, never to event count.
    unmappable_bound_basis: "one row per distinct (file, reason) pair",
    // T5.3, hollow-parity.mjs item 2: every RuntimeCatalogRouter ok:false
    // result observed while a scenario ran. Bounded by real router
    // rejections, never by event volume — see OUTCOMES_PATH's doc comment.
    outcome_count: outcomeRowsSorted.length,
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(OBSERVATIONS_PATH, observationRows.length ? `${observationRows.map((r) => JSON.stringify(r)).join("\n")}\n` : "", "utf8");
  writeFileSync(VISIBILITY_PATH, visibilityRows.length ? `${visibilityRows.map((r) => JSON.stringify(r)).join("\n")}\n` : "", "utf8");
  writeFileSync(UNMAPPABLE_PATH, unmappableRows.length ? `${unmappableRows.map((r) => JSON.stringify(r)).join("\n")}\n` : "", "utf8");
  writeFileSync(OUTCOMES_PATH, outcomeRowsSorted.length ? `${outcomeRowsSorted.map((r) => JSON.stringify(r)).join("\n")}\n` : "", "utf8");

  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });

  const summary = {
    ok: true,
    scenarios: scenarios.length,
    observations: observationRows.length,
    unmappable: unmappableRows.length,
    outcomes: outcomeRowsSorted.length,
    catalog_content_hash: catalogHash,
    revision: rev,
    tree_state: manifest.tree_state,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`vi-observe — ran ${scenarios.length} scenario(s), wrote ${observationRows.length} observation(s) to ${relative(REPO_ROOT, OBSERVATIONS_PATH)}`);
    console.log(`  catalog hash: ${catalogHash}   revision: ${rev.slice(0, 12)}   tree: ${manifest.tree_state}`);
    console.log(`  outcomes: ${outcomeRowsSorted.length} ok:false router result(s) observed`);
    if (unmappableRows.length > 0) {
      console.log(`  unmappable: ${unmappableRows.length} distinct (file, reason) pair(s):`);
      for (const row of unmappableRows) console.log(`    ${row.reason.padEnd(20)} ${row.file}  (${row.occurrences}x, e.g. ${row.example_function})`);
    }
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
