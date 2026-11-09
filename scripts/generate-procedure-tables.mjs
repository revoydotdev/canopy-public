#!/usr/bin/env node
/**
 * scripts/generate-procedure-tables.mjs — generates the two tables inside
 * `.claude/skills/revoy2-procedure/SKILL.md` from the repository's own
 * source of truth, rather than letting them be hand-typed prose.
 *
 * WHY THIS EXISTS. This repository has been bitten twice by hand-maintained
 * tables drifting from what the code actually does: the ROADMAP.md gap
 * register described fixed work as open for twelve commits, and an ADR
 * named a contract point closed eight minutes after it was authored. A
 * dispatch skill that confidently names the wrong gate, tier, or command is
 * worse than no skill — it steers with false authority. So neither table
 * below is typed directly into SKILL.md. Both are computed here, from:
 *
 *   - `scripts/execution-profile.json`'s declared cost classes (parsed as
 *     JSON, the same machine-readable registry CI/pre-push consume) and
 *     `scripts/gate-all.mjs`'s `HOOK_ADVISORY` (parsed as text) plus its exported
 *     `enumerateGates()` (imported directly — it IS exported, and importing
 *     a module never runs its `main()`, guarded at the bottom of that file).
 *   - `packages/arbor-mcp/src/cli.ts`'s top-level `args[0] === "..."`
 *     dispatch chain and its `subcommand`/`action` sub-dispatches (parsed as
 *     text — this script does not execute untrusted TypeScript).
 *   - `packages/arbor-mcp/src/native-tool-host.ts`'s `case "tool.name":`
 *     registrations (parsed as text, same reasoning).
 *   - `package.json`'s `scripts` object (parsed as JSON — a legitimate read
 *     of a manifest, not a require of executable code).
 *
 * The CRUD reference appendix's "none — hand-edit" cells are the direct
 * output of this: a cell reads "none — hand-edit" only when the entity's
 * curated candidate command strings were checked against all four extracted
 * sets and NONE matched. It is never asserted from memory.
 *
 * `scripts/tests/procedure-tables-freshness.test.mjs` proves this file is
 * sourced rather than static: it mutates a tier in a SCRATCH COPY of
 * `scripts/execution-profile.json`, regenerates against that copy, and asserts the
 * rendered output changed.
 *
 * Usage:
 *   bun scripts/generate-procedure-tables.mjs --write
 *   bun scripts/generate-procedure-tables.mjs --stdout
 *   bun scripts/generate-procedure-tables.mjs --check   (exit 1 if SKILL.md is stale)
 *
 * All source paths are overridable (`--repo`, `--execution-profile`, `--gate-all`, `--cli`,
 * `--native-tool-host`, `--package-json`, `--skill`) so a test can point
 * this generator at a scratch copy of any single input without touching the
 * real one.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

export function resolvePaths(argv, repoRootDefault = resolvePath(__dirname, "..")) {
  const repo = resolvePath(argValue(argv, "--repo") ?? repoRootDefault);
  return {
    repo,
    executionProfile: resolvePath(argValue(argv, "--execution-profile") ?? resolvePath(repo, "scripts/execution-profile.json")),
    gateAll: resolvePath(argValue(argv, "--gate-all") ?? resolvePath(repo, "scripts/gate-all.mjs")),
    cli: resolvePath(argValue(argv, "--cli") ?? resolvePath(repo, "packages/arbor-mcp/src/cli.ts")),
    nativeToolHost: resolvePath(argValue(argv, "--native-tool-host") ?? resolvePath(repo, "packages/arbor-mcp/src/native-tool-host.ts")),
    packageJson: resolvePath(argValue(argv, "--package-json") ?? resolvePath(repo, "package.json")),
    skill: resolvePath(argValue(argv, "--skill") ?? resolvePath(repo, ".claude/skills/revoy2-procedure/SKILL.md")),
    // The dispatch table lands in SKILL.md (loaded on every invocation); the
    // larger CRUD appendix lands in this companion, loaded only when a reader
    // actually needs an entity's create/read/update/delete mechanism. Keeping
    // the appendix out of SKILL.md is what keeps an invocation's resident
    // token footprint small.
    crudReference: resolvePath(argValue(argv, "--crud-reference") ?? resolvePath(repo, ".claude/skills/revoy2-procedure/reference/crud-reference.md")),
  };
}

// ---------------------------------------------------------------------------
// Extraction — every function below reads TEXT and returns plain data. None
// of them execute the source they parse.
// ---------------------------------------------------------------------------

/** Extracts tier/cost classes from the sole declarative execution profile. */
export function extractGateTiers(executionProfileSource) {
  let profile;
  try { profile = JSON.parse(executionProfileSource); } catch (error) { throw new Error(`could not parse execution profile JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!profile || typeof profile !== "object" || !profile.gates || typeof profile.gates !== "object") throw new Error("execution profile has no gates object");
  const tiers = {};
  for (const [name, entry] of Object.entries(profile.gates)) {
    if (name === "gate:all") continue;
    if (!entry || typeof entry.cost_class !== "string") throw new Error(`execution profile gate ${name} has no cost_class`);
    tiers[name] = entry.cost_class;
  }
  return tiers;
}

/** Parses the `const HOOK_ADVISORY = new Map([ ... ]);` literal. Returns a Set of advisory gate names. */
export function extractHookAdvisory(gateAllSource) {
  const start = gateAllSource.indexOf("const HOOK_ADVISORY = new Map([");
  if (start === -1) throw new Error("could not locate `const HOOK_ADVISORY = new Map([` in gate-all.mjs");
  const end = gateAllSource.indexOf("]);", start);
  if (end === -1) throw new Error("could not locate the closing `]);` for HOOK_ADVISORY");
  const body = gateAllSource.slice(start, end);
  const advisory = new Set();
  const keyRe = /\[\s*"(gate:[\w:-]+)"/g;
  let match;
  while ((match = keyRe.exec(body)) !== null) advisory.add(match[1]);
  return advisory;
}

/** Top-level `if (args[0] === "xxx")` dispatch names from cli.ts's `main()`. */
export function extractTopLevelCliVerbs(cliSource) {
  const verbs = new Set();
  const re = /if \(args\[0\] === "([\w-]+)"/g;
  let match;
  while ((match = re.exec(cliSource)) !== null) verbs.add(match[1]);
  return verbs;
}

/** Every `subcommand === "xxx"` / `action === "xxx"` literal anywhere in cli.ts — a flat pool of second-level verbs (project status/enroll/repair/registry/manage, task list/show/answer/confirm/reject/follow-up, ledger verify/repair/audit, plugin install, command list, etc.). Deliberately flat rather than nested per parent command: good enough to answer "does ANY arbor subcommand named X exist", which is what the CRUD appendix needs. */
export function extractSecondLevelCliVerbs(cliSource) {
  const verbs = new Set();
  const re = /(?:subcommand|action)(?:Name)? === "([\w-]+)"/g;
  let match;
  while ((match = re.exec(cliSource)) !== null) verbs.add(match[1]);
  return verbs;
}

/** Index of the `{` at `openIndex`'s matching `}`, by depth-counting braces (good enough for TS source with no unbalanced braces inside string/template literals in the scanned regions — the same assumption every other extractor in this file already makes about cli.ts). */
function matchBraceEnd(source, openIndex) {
  if (source[openIndex] !== "{") throw new Error(`matchBraceEnd: no "{" at index ${openIndex}`);
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`matchBraceEnd: no matching "}" found for "{" at index ${openIndex}`);
}

/** The full `{ ... }` body of a same-file `function name(...) { ... }` / `async function name(...) { ... }` declaration, or `null` if no such declaration exists. */
function extractNamedFunctionBody(source, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`);
  const match = re.exec(source);
  if (!match) return null;
  const openIndex = match.index + match[0].length - 1;
  return source.slice(openIndex, matchBraceEnd(source, openIndex) + 1);
}

/**
 * D13 (flat-namespace matching): `extractSecondLevelCliVerbs` below pools
 * every `subcommand === "x"` / `action === "x"` literal in cli.ts into ONE
 * set, so a generic word (`"status"`, `"repair"`) is attributed to every
 * top-level verb whether or not it is actually that verb's child — nothing
 * is wrong TODAY only because every current CRUD_ENTITIES second-level
 * candidate happens to be paired with its own top-level verb already being
 * present, but the attribution itself is unsound. This scopes each
 * second-level verb to its real parent by finding the source region that
 * implements each top-level `if (args[0] === "x") { ... }` dispatch and
 * scanning only within it.
 *
 * Two dispatch shapes exist in cli.ts, and both are followed:
 *  - INLINE: the top-level block itself contains the `subcommand === "..."`
 *    checks (e.g. `project`, whose `status`/`enroll`/`repair`/`registry`/
 *    `manage` children are literally inside the `if (args[0] === "project")`
 *    block, including the nested `action === "..."` checks for `project
 *    registry`).
 *  - DELEGATED: the top-level block immediately hands off to a same-file
 *    function (`return taskComposerCommand(args.slice(1), ...)`); that
 *    function's own body is then scanned too (e.g. `task`).
 *
 * A verb whose second-level dispatch lives in neither shape here — because
 * it delegates into a *different file* entirely (`ledger` → a dynamic
 * `import("./ledger-command.js")`) — correctly yields no second-level
 * entries: this function only proves what it can see in cli.ts, and a
 * caller needing that other file's truth must read it directly rather than
 * assume this flat/scoped pool covers it.
 */
export function extractScopedSecondLevelCliVerbs(cliSource) {
  const byParent = new Map();
  const topRe = /if \(args\[0\] === "([\w-]+)"\)\s*\{/g;
  let topMatch;
  while ((topMatch = topRe.exec(cliSource)) !== null) {
    const verb = topMatch[1];
    const openIndex = topMatch.index + topMatch[0].length - 1;
    const blockEnd = matchBraceEnd(cliSource, openIndex);
    const blockText = cliSource.slice(openIndex, blockEnd + 1);
    const subs = byParent.get(verb) ?? new Set();
    const subRe = /(?:subcommand|action)(?:Name)? === "([\w-]+)"/g;
    let subMatch;
    while ((subMatch = subRe.exec(blockText)) !== null) subs.add(subMatch[1]);
    const delegate = /return\s+(?:await\s+)?([A-Za-z_]\w*)\(args\.slice\(1\)/.exec(blockText);
    if (delegate) {
      const fnBody = extractNamedFunctionBody(cliSource, delegate[1]);
      if (fnBody) {
        let fnSubMatch;
        const fnSubRe = /(?:subcommand|action)(?:Name)? === "([\w-]+)"/g;
        while ((fnSubMatch = fnSubRe.exec(fnBody)) !== null) subs.add(fnSubMatch[1]);
      }
    }
    if (subs.size > 0) byParent.set(verb, subs);
  }
  return byParent;
}

/** `case "entity.verb":` registrations from native-tool-host.ts's dispatch switch — the complete native MCP tool surface. */
export function extractNativeToolNames(nativeToolHostSource) {
  const tools = new Set();
  const re = /^\s*case "([a-z_]+\.[a-z_]+)":/gm;
  let match;
  while ((match = re.exec(nativeToolHostSource)) !== null) tools.add(match[1]);
  return tools;
}

/** `package.json`'s `scripts` object keys — legitimate manifest data, not executable code. */
export function extractPackageScripts(packageJsonSource) {
  return new Set(Object.keys(JSON.parse(packageJsonSource).scripts ?? {}));
}

// ---------------------------------------------------------------------------
// Derivation — turns the four extracted sets into checked existence, never
// asserted absence.
// ---------------------------------------------------------------------------

/**
 * One entity's governed-CRUD candidate keys. `cli`/`mcp`/`script` are lists
 * of ANY-match candidate strings this entity would plausibly surface as if a
 * mechanism existed; `gates` are gate names that report on it (reporting is
 * not the same as CRUD, and is listed separately, never folded into a false
 * "has a Create/Update mechanism"). The curated part is WHICH strings to
 * check for an entity (the entity taxonomy itself, same as the proposal's
 * own list) — the checked part, and the only part that can be wrong, is
 * whether those strings actually appear in the real source.
 */
const CRUD_ENTITIES = [
  { name: "Reachability waivers", store: "scripts/reachability/allowlist.json", cli: [], mcp: [], script: ["waiver"], gates: ["gate:reachability"] , deleteVerb: "bun run waiver remove" },
  { name: "Branch dispositions", store: "scripts/branch-accounting/dispositions.json", cli: [], mcp: [], script: ["waiver"], gates: ["gate:branch-accounting"] , deleteVerb: "bun run waiver remove" },
  { name: "anti-stub TRIAGE", store: "scripts/anti-stub/triage.json", cli: [], mcp: [], script: ["waiver"], gates: ["gate:anti-stub", "gate:anti-stub:blocking"] , deleteVerb: "bun run waiver remove" },
  { name: "closed-enum-hygiene waivers", store: "scripts/closed-enum-hygiene/waivers.json", cli: [], mcp: [], script: ["waiver"], gates: ["gate:closed-enum-hygiene"] , deleteVerb: "bun run waiver remove" },
  { name: "Gap-register rows", store: "ROADMAP.md", cli: [], mcp: [], script: [], gates: ["gate:gap-status"] },
  { name: "ADR body / supersession", store: "decisions/*.md", cli: [], mcp: [], script: ["adr:allocate"], gates: ["gate:adr-registry", "gate:adr-status", "gate:adr-trace", "gate:adr-sections"] },
  { name: "ADR retirement", store: "decisions/*.md", storeNote: "Superseded/Retired status", cli: [], mcp: [], script: [], gates: [] },
  { name: "Obligation proof comments", store: "decisions/*.md", storeNote: "proof comments live inside the ADR body text", cli: [], mcp: [], script: [], gates: ["gate:obligations"] },
  // D13: candidates below are "parent sub" pairs (space-separated), checked
  // against the SCOPED second-level pool (extractScopedSecondLevelCliVerbs)
  // rather than the flat one, so "status"/"repair"/"manage" can only match
  // as children of the "project" verb specifically. A bare single-token
  // candidate (used by every other entity in this list) still checks the
  // top-level verb set directly.
  { name: "Projects (multi-project registry, ADR-076)", store: ".arbor/project-registry.json", cli: ["project", "project status", "project enroll", "project repair", "project registry", "project manage"], mcp: [], script: [], gates: ["gate:project-conform", "gate:project-registry"] },
  { name: "Campaigns / jobs", store: ".arbor/tree/<campaign>.json + .arbor/audit/<campaign>.jsonl", cli: ["task", "report", "adopt", "recover", "run", "demo"], mcp: [], script: [], gates: ["gate:ledger-audit"] },
  { name: "Evidence stores (claim-ledger, completion-depth, vi-observed, determinism-baseline)", store: ".claim-ledger/, .completion-depth/, .visual-intelligence/observed/, .determinism-baseline/", cli: ["evidence"], mcp: ["evidence.refresh"], script: ["claims:refresh", "completion-depth:refresh", "vi:observe", "determinism:refresh"], gates: ["gate:store-freshness", "gate:claim-ledger", "gate:completion-depth", "gate:determinism", "gate:vi-freshness"] },
  { name: "VI findings / triage", store: ".visual-intelligence/", cli: [], mcp: [], script: ["vi:refresh", "vi:observe", "gate:vi-findings"], deleteVerb: "bun scripts/vi-findings.mjs --prune-orphans", gates: ["gate:vi-findings"] },
  { name: "Completion-depth findings", store: ".completion-depth/", cli: [], mcp: [], script: ["completion-depth:refresh"], gates: ["gate:completion-depth"] },
  { name: "Determinism seams", store: ".determinism-baseline/", cli: [], mcp: [], script: ["determinism:refresh"], gates: ["gate:determinism"] },
  { name: "Claim-ledger claims", store: ".claim-ledger/", cli: [], mcp: ["evidence.refresh"], script: ["claims:refresh"], gates: ["gate:claim-ledger"] },
];

function anyPresent(candidates, pool) {
  return candidates.some((candidate) => pool.has(candidate));
}

/**
 * D13: a CLI candidate is either a bare top-level verb ("task") checked
 * against `sets.topLevelCliVerbs`, or a "parent sub" pair ("project status")
 * checked against `sets.scopedSecondLevelCliVerbs.get(parent)` — the actual
 * children of that specific top-level verb, never the flat cross-verb pool.
 */
function cliCandidateMatches(candidate, sets) {
  const parts = candidate.split(" ");
  if (parts.length === 1) return sets.topLevelCliVerbs.has(parts[0]);
  const [parent, sub] = parts;
  return sets.scopedSecondLevelCliVerbs.get(parent)?.has(sub) ?? false;
}

function anyCliPresent(candidates, sets) {
  return candidates.some((candidate) => cliCandidateMatches(candidate, sets));
}

/**
 * Checks one entity against the four extracted sets. Never returns "none"
 * by omission — every cell states WHICH check ran and WHAT it found.
 */
function deriveCrudRow(entity, sets) {
  const cliOk = anyCliPresent(entity.cli, sets);
  const mcpOk = anyPresent(entity.mcp, sets.mcpTools);
  const scriptOk = anyPresent(entity.script, sets.packageScripts);
  const gateNames = entity.gates.filter((gate) => sets.packageScripts.has(gate));
  const mechanismParts = [];
  if (cliOk) mechanismParts.push(`arbor ${entity.cli.find((c) => cliCandidateMatches(c, sets))}`);
  if (mcpOk) mechanismParts.push(`MCP tool ${entity.mcp.find((m) => sets.mcpTools.has(m))}`);
  if (scriptOk) mechanismParts.push(`bun run ${entity.script.find((s) => sets.packageScripts.has(s))}`);
  const create = mechanismParts.length > 0 ? mechanismParts.join(" / ") : "none — hand-edit";
  const read = gateNames.length > 0 ? `${gateNames.join(", ")} (report)` : create !== "none — hand-edit" ? "via the mechanism above" : "none — hand-edit";
  const reportOnly = gateNames.length > 0 && !cliOk && !mcpOk;
  return {
    entity: entity.name,
    store: entity.storeNote ? `${entity.store} — ${entity.storeNote}` : entity.store,
    create,
    read,
    update: create,
    // A delete verb is DECLARED per entity and then checked like every other
    // mechanism — it is not assumed absent. The blanket "no dedicated delete
    // verb" this used to emit was false for the waiver stores from the day
    // `waiver remove` landed, and false for VI triage once --prune-orphans
    // existed. A table that under-reports a mechanism sends its reader to
    // hand-edit a store a real command would have validated.
    delete: create === "none — hand-edit"
      ? "none — hand-edit"
      : entity.deleteVerb && scriptOk
        ? `${entity.deleteVerb}`
        : `${create} (no dedicated delete verb — hand-edit the store directly)`,
    report_only: reportOnly,
  };
}

/**
 * D13: checks one entity's `store` declaration against the real filesystem.
 * `store` may name several physical locations (joined with " + " or ", ")
 * and may contain a `<placeholder>` segment for a per-instance id (e.g.
 * `.arbor/tree/<campaign>.json`) — those are reduced to their static
 * directory prefix, which the declaration still commits to being real.
 * Returns the list of tokens that do NOT exist under `repoRoot`; an empty
 * array means every physical location the entity claims genuinely exists.
 *
 * This is deliberately a real `existsSync`, not a re-assertion: prose that
 * was never a path at all (the historical "an inline JS array literal"
 * anti-stub description) fails this exactly the way a moved/renamed real
 * path would, because neither resolves to anything on disk.
 */
function verifyEntityStore(entity, repoRoot) {
  const missing = [];
  const tokens = entity.store.split(/\s*(?:\+|,)\s*/).filter((token) => token.length > 0);
  for (const token of tokens) {
    // Reduce a placeholder/glob segment to its static, checkable directory
    // prefix: `.arbor/tree/<campaign>.json` -> `.arbor/tree`;
    // `decisions/*.md` -> `decisions`. A token with neither wildcard is
    // checked exactly as declared (file or directory).
    const indices = [token.indexOf("<"), token.indexOf("*")].filter((index) => index !== -1);
    const wildcardIndex = indices.length > 0 ? Math.min(...indices) : -1;
    const target = wildcardIndex === -1
      ? token
      : token.slice(0, wildcardIndex).replace(/[^/]*$/, "") || ".";
    if (!existsSync(resolvePath(repoRoot, target))) missing.push(`${entity.name}: "${token}" (checked "${target}")`);
  }
  return missing;
}

/** Runs `verifyEntityStore` over every declared entity; returns the flat list of failing tokens across all of them. */
function verifyEntityStores(entities, repoRoot) {
  return entities.flatMap((entity) => verifyEntityStore(entity, repoRoot));
}

function renderCrudTable(rows) {
  const header = "| Entity | Store | Create | Read | Update | Delete |\n|---|---|---|---|---|---|";
  const body = rows.map((row) => `| ${row.entity} | \`${row.store}\` | ${row.create} | ${row.read} | ${row.update} | ${row.delete} |`).join("\n");
  return `${header}\n${body}`;
}

/**
 * The situational dispatch table. The SITUATION and INVARIANT columns are
 * curated editorial judgment (there is no mechanical way to derive "what
 * moment in a workflow needs steering" from source code) — the same
 * position `docs/proposals/procedural-knowledge-hooks-vs-skills.md` itself
 * takes for its own illustrative table. What is NOT hand-typed is the
 * MECHANISM cell: each one is checked against the extracted CLI/gate/script
 * sets below, so a row can never name a command that doesn't exist, and at
 * least one row's rendered text is a direct function of `GATE_TIERS`
 * (`pushOnlyGates` below), which is what
 * `scripts/tests/procedure-tables-freshness.test.mjs` exercises.
 */
function buildDispatchRows(sets) {
  const pushOnlyGates = Object.entries(sets.gateTiers)
    .filter(([, tier]) => tier !== "stop")
    .map(([name]) => name)
    .sort();
  const evidenceMechanism = sets.cliVerbs.has("evidence")
    ? "route to `arbor evidence refresh`, do not hand-run the four store scripts"
    : "arbor evidence refresh is not registered — this row is STALE, see the generator's source check";
  const rebindMechanism = sets.packageScripts.has("evidence:rebind")
    ? "`bun run evidence:rebind` — runs the automatic chain fail-fast (graph, vi:observe, claims, completion-depth), then STOP: review and commit those stores; determinism measurement is a separate manual ADR-034 action"
    : "evidence:rebind script not found — this row is STALE, see the generator's source check";
  return [
    {
      situation: "changed source, about to commit",
      invariant: "graph before stores (ADR-079's constraint 3; hash semantics ADR-055); commit before verify",
      mechanism: evidenceMechanism,
      blast_radius: "all four evidence stores (`.claim-ledger/`, `.completion-depth/`, `.visual-intelligence/observed/`, `.determinism-baseline/`)",
    },
    {
      situation: "changed source, ALREADY committed — evidence stores are now stale",
      invariant: "the stores are definitionally stale until rebound; `gate-failure-modes.test.mjs`'s self-test goes red with them, and ADR-079 tolerates that ONE self-test (never any other red test) rather than deadlocking",
      mechanism: rebindMechanism,
      blast_radius: "same four evidence stores; a partial rebind (stopped mid-chain by a failure) must be re-run from the top, not resumed, since later producers depend on earlier ones' output",
    },
    {
      situation: "moving or renaming a file",
      invariant: "five path-keyed stores break on a bare `mv`",
      mechanism: "ADR proof citations · anti-stub TRIAGE · determinism seams · ROADMAP/docs prose · `tsconfig.tests.json` — grep each for the old path before committing the move",
      blast_radius: "silent until the next run of each store's own gate; no single gate catches all five",
    },
    {
      situation: "authoring a decision",
      invariant: "authoring ≠ allocation ≠ acceptance (ADR-059, ADR-072)",
      mechanism: sets.packageScripts.has("adr:allocate") ? "scaffold → `bun run adr:allocate` → substantive commit → separate status-only accept" : "adr:allocate script not found — this row is STALE",
      blast_radius: `${sets.gateNamesMatching(/^gate:adr-/).join(", ")} verify the result`,
    },
    {
      situation: "adding a test that touches REPO_ROOT",
      invariant: "broad-state reads race the live checkout (ADR-078)",
      mechanism: "classify the test as A (broad-state reader → frozen worktree snapshot), B (real-entry-point driver → isolated cwd/persistence dir), or C (deliberately live — stays live, must fail only for its own reason)",
      blast_radius: "a misclassified test flips verdicts under concurrent agent activity, exactly the failure ADR-078 records",
    },
    {
      situation: "dispatching a subagent",
      invariant: "constraint block + ownership split; git writes are forbidden from subagent context",
      mechanism: "state the file-ownership split explicitly in the brief; the sanctioned read-only alternative is `git show <rev>:<path>`, never `git stash`/`reset`/`checkout --`/`rebase`",
      blast_radius: "an unbounded write can race a sibling agent's concurrent commit (see the concurrent-git-index-race class of incident)",
    },
    {
      situation: "dispatching a wave of subagents (parallel or background)",
      invariant: "a subagent that arms a monitor/wait and ends its turn reads as \"completed\" to the caller, not \"waiting\"; re-dispatching across /loop re-entries with summarized context can overlap a still-running agent (2026-08-24 incident: two duplicate builds, ~450k wasted subagent tokens)",
      mechanism: "ListAgents plus a durable in-flight-capability ledger (capability -> agentId -> status) checked before every dispatch and diffed against the intended wave; brief each background agent to run its bounded work to actual completion and adjudicate the result itself, never end its turn on \"waiting\" for a child monitor",
      blast_radius: "wasted subagent tokens and duplicate work product on a false-stalled nudge or an undetected overlap; independent verification of delegated work (repo-local instructions Sec. 5.2) keeps this a cost, not a correctness incident",
    },
    {
      situation: "about to push",
      invariant: "some gates fire only outside the Stop tier",
      mechanism: pushOnlyGates.length > 0
        ? `${pushOnlyGates.length} gate(s) run only at fast/full tier and are invisible to the Stop hook: ${pushOnlyGates.join(", ")}`
        : "every gate currently runs at the stop tier — this is a live count, not asserted",
      blast_radius: "a Stop-hook-clean tree can still fail pre-push or CI on any gate in that list",
    },
    {
      situation: "authoring or renewing a waiver",
      invariant: "a waiver is a dated, self-cancelling exception, never a silent norm",
      mechanism: "every entry requires a reason, a gap/ADR reference, and an expiry date; an expired entry fails its gate regardless of whether the underlying issue is fixed",
      blast_radius: "all three stores (reachability allowlist, branch dispositions, anti-stub TRIAGE) share one predicate in scripts/lib/waiver-store.mjs, so schema and expiry rules are validated identically — edit them through `bun run waiver`, which validates at write time, rather than hand-editing the JSON and hoping the gate catches it",
    },
  ];
}

function renderDispatchTable(rows) {
  const header = "| Situation | Invariant | Mechanism | Blast radius |\n|---|---|---|---|";
  const body = rows.map((row) => `| ${row.situation} | ${row.invariant} | ${row.mechanism} | ${row.blast_radius} |`).join("\n");
  return `${header}\n${body}`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function generate(paths) {
  const executionProfileSource = readFileSync(paths.executionProfile, "utf8");
  const gateAllSource = readFileSync(paths.gateAll, "utf8");
  const cliSource = readFileSync(paths.cli, "utf8");
  const nativeToolHostSource = readFileSync(paths.nativeToolHost, "utf8");
  const packageJsonSource = readFileSync(paths.packageJson, "utf8");

  const gateTiers = extractGateTiers(executionProfileSource);
  const hookAdvisory = extractHookAdvisory(gateAllSource);
  const packageScripts = extractPackageScripts(packageJsonSource);
  const declaredGates = [...packageScripts].filter((name) => name.startsWith("gate:") && name !== "gate:all").sort();

  const topLevelCliVerbs = extractTopLevelCliVerbs(cliSource);
  // Flat pool kept only for the dispatch table's own single-verb checks
  // (`sets.cliVerbs.has("evidence")`, etc.), where "which verb" is already
  // unambiguous by construction. CRUD_ENTITIES derivation uses the SCOPED
  // pool below instead (D13).
  const cliVerbs = new Set([...topLevelCliVerbs, ...extractSecondLevelCliVerbs(cliSource)]);
  const scopedSecondLevelCliVerbs = extractScopedSecondLevelCliVerbs(cliSource);
  const mcpTools = extractNativeToolNames(nativeToolHostSource);

  const sets = {
    gateTiers,
    hookAdvisory,
    declaredGates,
    cliVerbs,
    topLevelCliVerbs,
    scopedSecondLevelCliVerbs,
    mcpTools,
    packageScripts,
    gateNamesMatching(re) { return declaredGates.filter((name) => re.test(name)); },
  };

  // D13: a CRUD_ENTITIES.store declaration is prose, curated by hand, and
  // was wrong on record (anti-stub's store described as "an inline JS array
  // literal" long after it became `scripts/anti-stub/triage.json`) without
  // --check ever catching it, because the table only proved the RENDERING
  // matched the DECLARATION, never that the declaration matched reality.
  // Every store path is checked against the real filesystem before either
  // table renders; a stale path fails generation outright rather than
  // rendering cleanly. See `verifyEntityStores` below.
  // These stores are created lazily by the first project/campaign. Their
  // declarations are valid in a clean clone even though no operator state
  // exists yet; every non-runtime store must still resolve on disk.
  const lazyRuntimeStores = [
    '".arbor/project-registry.json"',
    '".arbor/tree/<campaign>.json"',
    '".arbor/audit/<campaign>.jsonl"',
  ];
  const storeFailures = verifyEntityStores(CRUD_ENTITIES, paths.repo).filter(
    (failure) => !lazyRuntimeStores.some((store) => failure.includes(store)),
  );
  if (storeFailures.length > 0) {
    throw new Error(`CRUD_ENTITIES has ${storeFailures.length} store declaration(s) that do not exist on disk — the entity list is stale:\n${storeFailures.join("\n")}`);
  }

  const crudRows = CRUD_ENTITIES.map((entity) => deriveCrudRow(entity, sets));
  const dispatchRows = buildDispatchRows(sets);

  return {
    dispatchTable: renderDispatchTable(dispatchRows),
    crudTable: renderCrudTable(crudRows),
    generatedAt: new Date().toISOString(),
    gateCount: declaredGates.length,
    advisoryCount: hookAdvisory.size,
  };
}

const MARKERS = {
  dispatch: ["<!-- GENERATED:DISPATCH-TABLE:START -->", "<!-- GENERATED:DISPATCH-TABLE:END -->"],
  crud: ["<!-- GENERATED:CRUD-TABLE:START -->", "<!-- GENERATED:CRUD-TABLE:END -->"],
};

function spliceBetweenMarkers(source, [startMarker, endMarker], replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`markers not found or out of order: ${startMarker} / ${endMarker}`);
  }
  const before = source.slice(0, start + startMarker.length);
  const after = source.slice(end);
  return `${before}\n<!-- Generated by scripts/generate-procedure-tables.mjs — do not hand-edit between these markers. -->\n\n${replacement}\n\n${after}`;
}

/**
 * Splices the dispatch table into SKILL.md and the CRUD appendix into its
 * companion reference file, writing both. Returns the two rendered file
 * bodies so `--check` can compare each against what is committed.
 */
export function writeGenerated(paths, result) {
  const skillSource = readFileSync(paths.skill, "utf8");
  const skillOut = spliceBetweenMarkers(skillSource, MARKERS.dispatch, result.dispatchTable);
  writeFileSync(paths.skill, skillOut);

  const crudSource = readFileSync(paths.crudReference, "utf8");
  const crudOut = spliceBetweenMarkers(crudSource, MARKERS.crud, result.crudTable);
  writeFileSync(paths.crudReference, crudOut);

  return { skill: skillOut, crudReference: crudOut };
}

async function main() {
  const argv = process.argv.slice(2);
  const paths = resolvePaths(argv);
  const result = await generate(paths);

  if (argv.includes("--stdout")) {
    console.log("## Dispatch table\n");
    console.log(result.dispatchTable);
    console.log("\n## CRUD reference appendix\n");
    console.log(result.crudTable);
    return;
  }

  if (argv.includes("--check")) {
    const skillBefore = readFileSync(paths.skill, "utf8");
    const crudBefore = readFileSync(paths.crudReference, "utf8");
    const after = writeGenerated(paths, result);
    const stale = skillBefore !== after.skill || crudBefore !== after.crudReference;
    if (stale) {
      writeFileSync(paths.skill, skillBefore); // never leave --check with a mutated file
      writeFileSync(paths.crudReference, crudBefore);
      console.error("procedure tables are STALE — run `bun scripts/generate-procedure-tables.mjs --write`");
      process.exit(1);
    }
    console.log("procedure tables are current.");
    return;
  }

  // default and `--write` both write.
  writeGenerated(paths, result);
  console.log(`wrote ${paths.skill} + ${paths.crudReference} (${result.gateCount} gates, ${result.advisoryCount} advisory)`);
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
