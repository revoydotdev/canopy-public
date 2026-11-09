#!/usr/bin/env node
/**
 * Revision-bound enforcement control plane.
 *
 * This module deliberately separates a local quality battery from central
 * authority. A local run can produce diagnostics, never a server-enforcement
 * claim. Only an authenticated CI issuer can satisfy attestation verification.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProgressReporter, gateStageId, selectProgressRenderer } from "./finalization-progress.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(MODULE_DIR, "..");
export const EXECUTION_CONTEXTS = Object.freeze(["stop", "precommit", "prepush", "trunk_submit", "ci"]);
export const GATE_STATUSES = Object.freeze(["passed", "unresolved", "failed", "timed_out", "cancelled", "blocked_by_prerequisite", "identity_mismatch", "cached"]);
export const DEFAULT_REGISTRY_PATH = join(MODULE_DIR, "execution-profile.json");
export const FAILURE_POLICIES = Object.freeze(["fail_fast", "complete_all"]);
export const GATE_EFFECTS = Object.freeze(["blocking", "advisory"]);

/**
 * The ONLY statuses an aggregate may treat as green. Everything else — including
 * `unresolved` — is not a pass.
 *
 * WHY A NAMED SET AND NOT AN INLINE `["passed", "cached"]`. A gate that observed
 * nothing on an input declared non-empty cannot be said to have passed it: it
 * reported no evidence either way. Collapsing that into `passed` is the false
 * green this set exists to prevent, and the inline literal appeared at seven
 * call sites, each of which had to be re-audited whenever a status was added.
 * One predicate, one answer, and `unresolved` cannot be aggregated as green by
 * omission because it is not in the set.
 */
export const GREEN_GATE_STATUSES = Object.freeze(["passed", "cached"]);

export function isGreenGateStatus(status) {
  return GREEN_GATE_STATUSES.includes(status);
}

/**
 * The one convention by which a gate reports how much it actually looked at.
 * See `scripts/guard-canaries.mjs` for why this is a plain line and not a JSON
 * channel: most gates in this corpus have no JSON mode, and adding one to each
 * would be a larger change than the fact being reported. A gate that has not
 * adopted the line reports `null` and is never downgraded — silence is not
 * evidence of emptiness, and only a gate that opted in by declaring
 * `observes.min` is held to it.
 */
export function parseGateObservedCount(output) {
  const match = /^observed_count:\s*(\d+)\s*$/m.exec(String(output ?? ""));
  return match ? Number(match[1]) : null;
}
export const RESOURCE_CLASSES = Object.freeze(["light", "git_admin", "typescript", "vitest", "coverage", "lsp", "network"]);
/**
 * ADR-108: whether a gate's subject artifact exists only in arbor's own
 * governed tree ("self"), is source code or a conformance profile meaningful
 * for any repo ("target"), or both. Assigned by the existence test, never by
 * whether a gate happens to parse `--root`/`--repo`.
 */
export const GATE_SCOPES = Object.freeze(["self", "target", "both"]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable JSON is used for all fingerprints; timestamps and paths never enter a cache key. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function git(repo, args, options = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown failure").trim()}`);
  return result.stdout.trim();
}

function gitTry(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export function resolveCandidateIdentity(repo = REPO_ROOT, candidate = "HEAD") {
  const oid = git(repo, ["rev-parse", `${candidate}^{commit}`]);
  const tree = git(repo, ["rev-parse", `${oid}^{tree}`]);
  // The full tree listing binds every tracked path, mode, object identity and
  // filename. It is independent of checkout mtime and path location.
  const treeListing = git(repo, ["ls-tree", "-r", "--full-tree", oid]);
  return Object.freeze({ candidate_oid: oid, input_digest: sha256(`${tree}\0${treeListing}\0`), tree_oid: tree });
}

export function resolveWorkingIdentity(repo = REPO_ROOT, candidate = "HEAD") {
  const candidateIdentity = resolveCandidateIdentity(repo, candidate);
  const status = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const unstaged = git(repo, ["diff", "--binary", "--no-ext-diff"]);
  const staged = git(repo, ["diff", "--cached", "--binary", "--no-ext-diff"]);
  return Object.freeze({
    ...candidateIdentity,
    working_digest: sha256(`${candidateIdentity.input_digest}\0${status}\0${unstaged}\0${staged}\0`),
    clean: status.length === 0,
  });
}

export function loadExecutionProfile(registryPath = DEFAULT_REGISTRY_PATH) {
  const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.gates || typeof parsed.gates !== "object") {
    throw new Error(`${registryPath}: expected an execution-profile object with a gates object`);
  }
  return Object.freeze(parsed);
}

function typedReason(value) {
  return !!value && typeof value === "object" && typeof value.code === "string" && value.code.length > 0 && typeof value.detail === "string" && value.detail.length > 0;
}

/**
 * Context scheduling is profile data, not a caller-side convention.  The
 * fallback keeps tiny historical fixtures usable; production profiles must
 * declare this block and are audited below.
 */
export function executionContext(registry, context) {
  if (!EXECUTION_CONTEXTS.includes(context)) throw new Error(`unknown execution context ${context}`);
  const declared = registry?.execution?.contexts?.[context];
  if (!declared) return Object.freeze({
    max_readers: 4,
    failure_policy: "complete_all",
    resource_limits: Object.freeze(Object.fromEntries(RESOURCE_CLASSES.map((name) => [name, name === "light" ? 4 : 1]))),
  });
  return Object.freeze({
    max_readers: declared.max_readers,
    failure_policy: declared.failure_policy,
    resource_limits: Object.freeze({ ...declared.resource_limits }),
  });
}

function orderedGateRanks(registry) {
  const ranks = new Map();
  for (const [index, group] of (registry?.execution?.gate_order ?? []).entries()) {
    for (const name of group.gates ?? []) ranks.set(name, index);
  }
  return ranks;
}

function compareGateOrder(registry, left, right) {
  const ranks = orderedGateRanks(registry);
  const leftRank = ranks.get(left.name) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = ranks.get(right.name) ?? Number.MAX_SAFE_INTEGER;
  return leftRank - rightRank || left.name.localeCompare(right.name);
}

/**
 * The gate_order GROUP a gate belongs to, ignoring position within it.
 *
 * The prerequisite audit below must use this and not `compareGateOrder`.
 * That comparator exists to give the scheduler a stable total order, so it
 * breaks a group tie on the gate's NAME — correct for scheduling, wrong for a
 * structural question. Used for the audit it made the verdict depend on
 * alphabetical accident: `gate:hollow-parity` requiring `gate:coverage` in the
 * same group passed silently, while the same relationship reversed was
 * rejected with a message about groups that was not the real reason. The real
 * profile passed only because "gate:coverage" happens to sort first.
 */
function gateOrderRank(registry, name) {
  return orderedGateRanks(registry).get(name) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Validates both directions of the roster invariant. Every package gate must
 * be present, and every declared profile entry must resolve to a package gate.
 */
export function auditExecutionProfile(registry, packageJson, options = {}) {
  const problems = [];
  const scripts = packageJson?.scripts ?? {};
  const packageGates = Object.keys(scripts).filter((name) => name.startsWith("gate:")).sort();
  const entries = registry?.gates && typeof registry.gates === "object" ? registry.gates : {};
  const names = Object.keys(entries).sort();
  if (registry?.schema_version !== 1) problems.push("execution profile schema_version must be 1");
  if (typeof registry?.profile_version !== "string" || registry.profile_version.length === 0) problems.push("execution profile must declare a non-empty profile_version");
  for (const name of packageGates) if (!(name in entries)) problems.push(`${name} is declared in package.json but missing from execution-profile.json`);
  for (const name of names) if (!(name in scripts)) problems.push(`${name} is registered in execution-profile.json but missing from package.json`);
  if (registry?.execution !== undefined) {
    const groups = registry.execution?.gate_order;
    if (!Array.isArray(groups) || groups.length === 0) {
      problems.push("execution profile must declare non-empty execution.gate_order groups");
    } else {
      const ordered = [];
      for (const group of groups) {
        if (!group || typeof group.id !== "string" || group.id.length === 0 || !Array.isArray(group.gates) || group.gates.length === 0) {
          problems.push("every execution.gate_order group must have an id and non-empty gates array");
          continue;
        }
        ordered.push(...group.gates);
      }
      for (const name of ordered.filter((name, index) => ordered.indexOf(name) !== index)) problems.push(`execution.gate_order duplicates ${name}`);
      for (const name of names.filter((name) => !ordered.includes(name))) problems.push(`execution.gate_order omits ${name}`);
      for (const name of ordered.filter((name) => !(name in entries))) problems.push(`execution.gate_order names unknown gate ${name}`);
    }
    for (const context of EXECUTION_CONTEXTS) {
      const schedule = registry.execution?.contexts?.[context];
      if (!schedule || !Number.isSafeInteger(schedule.max_readers) || schedule.max_readers < 1) problems.push(`execution context ${context} must declare positive integer max_readers`);
      if (!FAILURE_POLICIES.includes(schedule?.failure_policy)) problems.push(`execution context ${context} must declare failure_policy fail_fast or complete_all`);
      for (const resourceClass of RESOURCE_CLASSES) {
        if (!Number.isSafeInteger(schedule?.resource_limits?.[resourceClass]) || schedule.resource_limits[resourceClass] < 1) {
          problems.push(`execution context ${context} must declare a positive resource limit for ${resourceClass}`);
        }
      }
      for (const resourceClass of Object.keys(schedule?.resource_limits ?? {})) {
        if (!RESOURCE_CLASSES.includes(resourceClass)) problems.push(`execution context ${context} names unknown resource class ${resourceClass}`);
      }
    }
    const phases = registry.execution?.finalization?.phases;
    if (!Array.isArray(phases) || phases.length === 0) problems.push("execution profile must declare non-empty finalization phases");
    else {
      const phaseIds = phases.map((phase) => phase?.id);
      for (const phase of phases) {
        if (!phase || typeof phase.id !== "string" || !Array.isArray(phase.depends_on) || typeof phase.mutability !== "string") problems.push("every finalization phase must declare id, depends_on, and mutability");
        for (const prerequisite of phase?.depends_on ?? []) if (!phaseIds.includes(prerequisite)) problems.push(`finalization phase ${phase?.id ?? "?"} names unknown prerequisite ${prerequisite}`);
      }
    }
    for (const [hookContext, hook] of Object.entries(registry.execution?.managed_hooks ?? {})) {
      if (!EXECUTION_CONTEXTS.includes(hookContext)) problems.push(`managed hook names unknown context ${hookContext}`);
      for (const [variant, definition] of Object.entries(hook?.variants ?? {})) {
        for (const [name, reason] of Object.entries(definition?.omitted_gates ?? {})) {
          if (!(name in entries)) problems.push(`managed hook ${hookContext}/${variant} omits unknown gate ${name}`);
          else if (entries[name].contexts?.[hookContext] !== true) problems.push(`managed hook ${hookContext}/${variant} omits gate ${name} that is not selected in that context`);
          if (!typedReason(reason)) problems.push(`managed hook ${hookContext}/${variant} omission for ${name} requires typed code/detail reason`);
        }
      }
    }
  }
  for (const [name, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") { problems.push(`${name} is not an object`); continue; }
    if (typeof entry.command !== "string" || entry.command.length === 0) problems.push(`${name} has no command`);
    if (name in scripts && entry.command !== `bun run ${name}`) problems.push(`${name} command must invoke its package.json command as \`bun run ${name}\``);
    if (!Array.isArray(entry.prerequisites)) problems.push(`${name} prerequisites must be an array`);
    if (typeof entry.timeout_ms !== "number" || entry.timeout_ms <= 0) problems.push(`${name} timeout_ms must be a positive number`);
    if (!["stop", "fast", "full"].includes(entry.cost_class)) problems.push(`${name} has an invalid cost_class`);
    if (!["read_only", "verification_sandbox", "evidence_writer"].includes(entry.mutability)) problems.push(`${name} has an invalid mutability`);
    if (!GATE_EFFECTS.includes(entry.effect)) problems.push(`${name} must declare effect blocking or advisory`);
    if (!RESOURCE_CLASSES.includes(entry.resource_class)) problems.push(`${name} must declare a recognized resource_class`);
    if (typeof entry.required !== "boolean") problems.push(`${name} required must be boolean`);
    if (entry.required === true && entry.effect !== "blocking") problems.push(`${name} is required and must be blocking`);
    if (entry.effect === "advisory" && entry.required !== false) problems.push(`${name} is advisory and cannot be required`);
    // ADR-108 rule 2: a `gates` entry with no scope, or an unrecognized one, is
    // rejected exactly like a package.json gate absent from this manifest.
    if (!GATE_SCOPES.includes(entry.scope)) problems.push(`${name} must declare scope self, target, or both`);
    if (entry.observes !== undefined) {
      const observes = entry.observes;
      if (!observes || typeof observes !== "object" || !Number.isSafeInteger(observes.min) || observes.min < 1) {
        problems.push(`${name} observes must declare a positive integer min`);
      }
    }
    // Arboretum M2: `inputs` lets the native stop battery schedule a gate out
    // when none of these repository paths changed. Optional, because an
    // undeclared gate always runs; when present it must be a non-empty list of
    // repository-relative globs, since an empty list would schedule the gate
    // out on every turn and a path escaping the repository can never match.
    if (entry.inputs !== undefined) {
      const inputs = entry.inputs;
      if (!Array.isArray(inputs) || inputs.length === 0) problems.push(`${name} inputs must be a non-empty array of repository-relative globs`);
      else for (const value of inputs) {
        if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.split("/").includes("..")) {
          problems.push(`${name} inputs entry ${JSON.stringify(value)} must be a non-empty repository-relative glob`);
        }
      }
    }
    // The canary block is what makes a gate's green mean anything. It is
    // optional — migration is incremental, and `guard:canaries` reports a
    // missing block as `unmigrated` — but a block that is present must be
    // complete, because a canary naming no reason would classify a gate that
    // failed for any reason as proven.
    if (entry.canary !== undefined) {
      const canary = entry.canary;
      if (!canary || typeof canary !== "object" || Array.isArray(canary)) problems.push(`${name} canary must be an object`);
      else {
        if (typeof canary.fixture !== "string" || canary.fixture.length === 0) problems.push(`${name} canary must name a fixture directory`);
        if (typeof canary.expected_failure_reason !== "string" || canary.expected_failure_reason.length === 0) problems.push(`${name} canary must declare a non-empty expected_failure_reason`);
        if (canary.args !== undefined && (!Array.isArray(canary.args) || canary.args.some((value) => typeof value !== "string"))) problems.push(`${name} canary args must be an array of strings`);
        if (canary.git_repo !== undefined && typeof canary.git_repo !== "boolean") problems.push(`${name} canary git_repo must be boolean`);
        if (canary.link_repo_paths !== undefined && (!Array.isArray(canary.link_repo_paths) || canary.link_repo_paths.some((value) => typeof value !== "string"))) problems.push(`${name} canary link_repo_paths must be an array of strings`);
        // `command` and `env` are the two keys the validator used to ignore
        // silently, and they are the two with the widest blast radius: a
        // `command` replaces the spawn path, and an `env` overlays arbitrary
        // keys onto the gate's environment. Both were accepted unchallenged
        // while the five keys above were policed, which is the shape of the
        // defect: not that a rule is weak, but that an unpoliced key sits beside
        // a policed one and inherits the appearance of approval.
        //
        // `command` is refused outright rather than shape-checked, because there
        // is no legitimate value of it. `guard-canaries` spawns every real canary
        // as `bun run <gate>` so a proof is a fact about the gate the control
        // plane runs; an override would let a canary report `proven` without the
        // gate ever executing (demonstrated with an `sh -c` payload echoing the
        // declared reason). The runner refuses such a canary too, and
        // `internalCommands` on `runCensus` is the negative control's channel —
        // a runner parameter, so no profile can set it.
        if (canary.command !== undefined) problems.push(`${name} canary must not declare command: every canary is spawned as \`bun run ${name}\`; use args, or the runner's internalCommands for the negative control`);
        // `env` is legitimate and is the honest route to a gate that reads its
        // corpus from an environment variable rather than a flag — an `sh -c`
        // wrapper that injected REPO_ROOT kept the bespoke spawn path intact
        // instead of the production one, which is backwards. So the shape is
        // constrained rather than the key banned:
        //   - a flat object, because the overlay is a flat merge and an array or
        //     a nested object is a caller who believes they are expressing
        //     something they are not;
        //   - POSIX identifier names, since that is the whole grammar the spawn
        //     can carry, and the three JS prototype keys are refused because no
        //     gate reads an environment variable by any of those names;
        //   - string, number or boolean values, because those are the only values
        //     whose `String()` is a fact rather than a guess. `null` becoming
        //     "null" and `{}` becoming "[object Object]" are the two coercions
        //     that would let a mistyped gate setting pass as a value.
        // GIT_DIR and GIT_WORK_TREE are deliberately NOT refused: two real
        // canaries must set them to point git at an object store inside their own
        // fixture. What makes that safe is that the runner strips the git-scope
        // variables from the INHERITED environment before applying this overlay,
        // so a git-scope variable reaching a gate is always a declared one.
        if (canary.env !== undefined) {
          const env = canary.env;
          if (!env || typeof env !== "object" || Array.isArray(env)) {
            problems.push(`${name} canary env must be an object of environment variable names to values`);
          } else {
            for (const [key, value] of Object.entries(env)) {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") {
                problems.push(`${name} canary env key ${JSON.stringify(key)} is not a POSIX environment variable name`);
              }
              if (!["string", "number", "boolean"].includes(typeof value)) {
                problems.push(`${name} canary env ${key} must be a string, number, or boolean, not ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}`);
              }
            }
          }
        }
      }
    }
    if (entry.remote_receipt !== undefined) {
      const receipt = entry.remote_receipt;
      if (!receipt || receipt.kind !== "github_api" || typeof receipt.environment !== "string" || typeof receipt.argument !== "string") {
        problems.push(`${name} remote_receipt must declare github_api, environment, and argument`);
      } else if (name in scripts && !scripts[name].includes(receipt.argument)) {
        problems.push(`${name} must pass ${receipt.argument} so its remote receipt cannot be silently omitted`);
      }
    }
    for (const context of EXECUTION_CONTEXTS) {
      if (typeof entry.contexts?.[context] !== "boolean") problems.push(`${name} must declare boolean context ${context}`);
      if (entry.contexts?.[context] === false && !typedReason(entry.excluded_contexts?.[context])) {
        problems.push(`${name} excludes ${context} without a typed code/detail reason`);
      }
      if (entry.contexts?.[context] === true && entry.excluded_contexts?.[context] !== undefined) {
        problems.push(`${name} both includes and excludes ${context}`);
      }
    }
    for (const prerequisite of entry.prerequisites ?? []) {
      if (!(prerequisite in entries)) problems.push(`${name} names unknown prerequisite ${prerequisite}`);
      if (prerequisite === name) problems.push(`${name} cannot depend on itself`);
      for (const context of EXECUTION_CONTEXTS) {
        if (entry.contexts?.[context] === true && entries[prerequisite]?.contexts?.[context] !== true) {
          problems.push(`${name} selects ${context} but prerequisite ${prerequisite} is not selected there`);
        }
      }
      // A prerequisite may share the dependent's group, but never sit in a
      // LATER one. gate_order is documented as a stable PRIORITY and not a
      // dependency (see planGateDag) -- genuine ordering is expressed through
      // prerequisites -- so requiring a strictly earlier group would contradict
      // the module's own design. A prerequisite in a later group is a real
      // contradiction between the two mechanisms, and that is what this checks.
      if (registry?.execution?.gate_order
        && gateOrderRank(registry, prerequisite) > gateOrderRank(registry, name)) {
        problems.push(`${name} prerequisite ${prerequisite} must not occur in a later execution.gate_order group`);
      }
    }
    // A blocking check omitted from CI is a conscious and reviewable policy
    // exception, not a default. The aggregate pseudo-gate is the only one
    // allowed to be non-required.
    if (entry.required === true && entry.contexts?.ci !== true) problems.push(`${name} is required but not represented in authoritative CI`);
    // A gate can satisfy every per-context and CI-enrollment rule above while
    // declaring `contexts.<x>: false` for every context — each with its own
    // fully typed excluded_contexts reason — and therefore never run
    // anywhere at all. That is a silent omission this validator must catch
    // directly rather than rely on some other rule to catch incidentally.
    // gate:all is the sole deliberate exception: an operator-facing
    // aggregate that would recursively invoke this same profile runner if
    // the DAG ever selected it.
    if (entry.effect === "blocking" && !EXECUTION_CONTEXTS.some((context) => entry.contexts?.[context] === true)) {
      problems.push(`${name} is not selected by any execution context and will never run`);
    }
  }
  if (options.requireAllCi !== false) {
    for (const [name, entry] of Object.entries(entries)) {
      if (entry.required && entry.contexts.ci !== true) problems.push(`${name} lacks CI enrollment`);
    }
  }
  for (const context of EXECUTION_CONTEXTS) {
    try { planGateDag({ ...registry, gates: entries }, context); }
    catch (error) { problems.push(`${context} execution plan is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return Object.freeze(problems);
}

export function selectedGates(registry, context) {
  if (!EXECUTION_CONTEXTS.includes(context)) throw new Error(`unknown execution context ${context}`);
  return Object.entries(registry.gates)
    .filter(([, entry]) => entry.contexts[context] === true)
    .map(([name, entry]) => Object.freeze({ name, ...entry }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function selectClosure(registry, context) {
  const selected = new Map(selectedGates(registry, context).map((entry) => [entry.name, entry]));
  const expanded = new Set();
  const include = (name) => {
    if (expanded.has(name)) return;
    expanded.add(name);
    const entry = registry.gates[name];
    if (!entry) throw new Error(`unknown prerequisite ${name}`);
    if (!selected.has(name)) selected.set(name, Object.freeze({ name, ...entry }));
    for (const dependency of entry.prerequisites) include(dependency);
  };
  for (const name of [...selected.keys()]) include(name);
  return selected;
}

/**
 * Produce the stable execution waves for one profile context.
 *
 * This is deliberately the scheduler's input as well as the operator-facing
 * projection.  A separately formatted "plan" would be another roster that
 * could disagree with what actually ran.  Names are sorted before batching,
 * so harmless JSON object reordering cannot change execution order.  Writers
 * remain exclusive; read-only gates use the same bounded width as execution.
 */
export function planGateDag(registry, context, { maxReaders = 4 } = {}) {
  const configured = executionContext(registry, context);
  const readerWidth = maxReaders === 4 && registry?.execution?.contexts?.[context] ? configured.max_readers : maxReaders;
  if (!Number.isSafeInteger(readerWidth) || readerWidth < 1) throw new Error("maxReaders must be a positive integer");
  const definitions = selectClosure(registry, context);
  const planned = new Set();
  const waves = [];
  while (planned.size < definitions.size) {
    const ready = [...definitions.values()]
      .filter((entry) => !planned.has(entry.name) && entry.prerequisites.every((name) => planned.has(name)))
      .sort((a, b) => compareGateOrder(registry, a, b));
    if (ready.length === 0) {
      const blocked = [...definitions.keys()].filter((name) => !planned.has(name)).sort();
      throw new Error(`execution profile dependency cycle: ${blocked.join(", ")}`);
    }
    // gate_order is a stable priority, not a fabricated dependency. Genuine
    // ordering is expressed through prerequisites; otherwise disjoint work
    // may share a wave when both the reader width and resource limits allow it.
    const orderedReady = ready;
    // Only a gate that mutates the SHARED tree needs a wave to itself.
    // `mutability` names three things and they are not equivalent:
    // `evidence_writer` rewrites tracked evidence in place and must be alone;
    // `verification_sandbox` writes only into its own detached snapshot or
    // worktree, which is what the finalization phase of that name means. Giving
    // the sandbox class exclusivity too was pure additive latency -- in CI it
    // put gate:coverage, the single most expensive gate in the system, alone in
    // wave 1 with the other fifty gates waiting behind it, and gave
    // gate:vi-reproducible a wave of its own as well, for no correctness
    // reason. Resource limits (`coverage: 1`, `lsp: 1`) already stop two heavy
    // sandboxes colliding, and the before/after identity watcher is what
    // actually proves a declared reader or sandbox touched nothing.
    const writers = orderedReady.filter((entry) => entry.mutability === "evidence_writer");
    const resourceUse = Object.fromEntries(RESOURCE_CLASSES.map((name) => [name, 0]));
    const scheduled = [];
    if (writers.length > 0) {
      scheduled.push(writers[0]);
      resourceUse[writers[0].resource_class] += 1;
    } else {
      for (const entry of orderedReady) {
        if (scheduled.length >= readerWidth) break;
        const resourceClass = entry.resource_class ?? "light";
        const limit = configured.resource_limits?.[resourceClass] ?? 1;
        if (resourceUse[resourceClass] >= limit) continue;
        resourceUse[resourceClass] += 1;
        scheduled.push(entry);
      }
    }
    if (scheduled.length === 0) {
      throw new Error(`execution profile resource limits cannot admit ready gates: ${orderedReady.map((entry) => entry.name).join(", ")}`);
    }
    const wave = Object.freeze({
      wave: waves.length + 1,
      // The wave reports the strongest mutability it actually contains, so a
      // wave carrying a sandbox gate is not projected as purely read-only.
      mutability: scheduled.some((entry) => entry.mutability === "evidence_writer")
        ? "evidence_writer"
        : scheduled.some((entry) => entry.mutability === "verification_sandbox")
          ? "verification_sandbox"
          : "read_only",
      resources: Object.freeze(Object.fromEntries(Object.entries(resourceUse).filter(([, count]) => count > 0))),
      gates: Object.freeze(scheduled.map((entry) => entry.name)),
    });
    waves.push(wave);
    for (const entry of scheduled) planned.add(entry.name);
  }
  return Object.freeze({
    schema_version: 1,
    context,
    max_readers: readerWidth,
    resource_limits: configured.resource_limits,
    waves: Object.freeze(waves),
  });
}

function stableFingerprint(identity, registry, context) {
  return sha256(canonicalJson({
    candidate_oid: identity.candidate_oid,
    input_digest: identity.input_digest,
    profile_version: registry.profile_version,
    profile_digest: sha256(canonicalJson(registry.gates)),
    context,
  }));
}

/** The verifier derives this value; reports cannot select their own profile identity. */
export function executionProfileFingerprint(identity, registry, context) {
  return stableFingerprint(identity, registry, context);
}

/**
 * A report carries a content-addressed execution manifest. It is deliberately
 * not a client signature: CI authentication is verified separately through a
 * platform receipt. The digest makes a report substitution or omitted gate
 * mechanically detectable before it is used to make an attestation.
 */
export function createExecutionManifest({ candidate_oid, input_digest, profile_version, profile_fingerprint, context, status, gates }) {
  const payload = {
    schema_version: 1,
    kind: "revoy2.revision_bound_execution_manifest",
    candidate_oid,
    input_digest,
    profile_version,
    profile_fingerprint,
    context,
    status,
    gates: [...gates].map((gate) => ({
      gate: gate.gate,
      status: gate.status,
      // The manifest is the record a later attestation is verified against, so
      // it carries the observation the status was derived from. A report whose
      // `unresolved` gate does not say how much it saw is a report that cannot
      // be re-checked.
      observed_count: gate.observed_count ?? null,
      candidate_oid: gate.candidate_oid,
      input_digest: gate.input_digest,
      profile_version: gate.profile_version,
      prerequisite_failures: gate.prerequisite_failures ?? [],
    })).sort((left, right) => left.gate.localeCompare(right.gate)),
  };
  return Object.freeze({ ...payload, digest: sha256(canonicalJson(payload)) });
}

/** Verifies that a CI report proves every required registry entry ran for one identity. */
export function validateAggregateExecutionReport({ report, registry, context = "ci", expectedCandidate = null }) {
  const failures = [];
  if (!report || typeof report !== "object") return Object.freeze({ ok: false, code: "report_absent", failures: ["aggregate report is absent"] });
  if (!report.candidate_oid || !report.input_digest) failures.push("report_identity_absent");
  if (expectedCandidate && report.candidate_oid !== expectedCandidate.candidate_oid) failures.push("report_candidate_oid_mismatch");
  if (expectedCandidate && report.input_digest !== expectedCandidate.input_digest) failures.push("report_input_digest_mismatch");
  if (report.profile_version !== registry.profile_version) failures.push("report_profile_version_mismatch");
  const expectedFingerprint = report.candidate_oid && report.input_digest
    ? executionProfileFingerprint({ candidate_oid: report.candidate_oid, input_digest: report.input_digest }, registry, context)
    : null;
  if (expectedFingerprint !== null && report.profile_fingerprint !== expectedFingerprint) failures.push("report_profile_fingerprint_mismatch");
  const selected = selectedGates(registry, context);
  const records = new Map();
  for (const gate of Array.isArray(report.gates) ? report.gates : []) {
    if (records.has(gate.gate)) failures.push(`duplicate_gate_result:${gate.gate}`);
    records.set(gate.gate, gate);
  }
  for (const entry of selected.filter((entry) => entry.required)) {
    const result = records.get(entry.name);
    if (!result) { failures.push(`required_gate_not_executed:${entry.name}`); continue; }
    if (!isGreenGateStatus(result.status)) failures.push(`required_gate_not_green:${entry.name}:${result.status}`);
    if (result.candidate_oid !== report.candidate_oid) failures.push(`gate_candidate_oid_mismatch:${entry.name}`);
    if (result.input_digest !== report.input_digest) failures.push(`gate_input_digest_mismatch:${entry.name}`);
    if (result.profile_version !== registry.profile_version) failures.push(`gate_profile_mismatch:${entry.name}`);
  }
  const manifest = createExecutionManifest({
    candidate_oid: report.candidate_oid,
    input_digest: report.input_digest,
    profile_version: report.profile_version,
    profile_fingerprint: expectedFingerprint,
    context,
    status: report.status,
    gates: Array.isArray(report.gates) ? report.gates : [],
  });
  if (report.execution_manifest?.digest !== manifest.digest) failures.push("execution_manifest_digest_mismatch");
  return Object.freeze({ ok: failures.length === 0, code: failures.length === 0 ? "remote_execution_proven" : failures[0], failures: Object.freeze(failures), manifest });
}

/**
 * Run one process in its own process group and terminate the entire group at
 * its deadline. `onSpawn`/`onOutput` are ADR-091 observation hooks only: they
 * report already-happening facts (pid, byte counts) to a progress reporter and
 * never influence scheduling, timeout, or the resolved result.
 */
export async function runDeadlineProcess({ command, args, cwd, timeout_ms, env = process.env, onSpawn = null, onOutput = null }) {
  return new Promise((resolveResult) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolveResult(Object.freeze({ ok: false, status: "failed", exit_code: null, duration_ms: Date.now() - started, output: "", error: String(error) }));
      return;
    }
    if (onSpawn) {
      try { onSpawn({ pid: child.pid ?? null, process_group_id: process.platform !== "win32" ? (child.pid ?? null) : null }); }
      catch { /* observation hook failure must never affect the gate result */ }
    }
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (onOutput) { try { onOutput({ stdout: chunk.length, stderr: 0 }); } catch { /* observation only */ } }
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
      if (onOutput) { try { onOutput({ stdout: 0, stderr: chunk.length }); } catch { /* observation only */ } }
    });
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { /* process already exited */ }
      setTimeout(() => {
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { /* process already exited */ }
      }, 250).unref();
    }, timeout_ms);
    child.on("error", (error) => {
      clearTimeout(deadline);
      resolveResult(Object.freeze({ ok: false, status: "failed", exit_code: null, duration_ms: Date.now() - started, output, error: String(error) }));
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolveResult(Object.freeze({ ok: !timedOut && code === 0, status: timedOut ? "timed_out" : code === 0 ? "passed" : "failed", exit_code: code, duration_ms: Date.now() - started, output, error: null }));
    });
  });
}

/** ADR-091: gate status -> progress-protocol terminal outcome/reason_code. Observation only, never fed back into scheduling. */
function gateProgressOutcome(status) {
  if (isGreenGateStatus(status)) return { outcome: "succeeded", reason_code: status === "cached" ? "gate_cached" : "gate_passed" };
  // A distinct reason_code, not `gate_failed`: the operator reading a progress
  // stream needs to tell "the gate looked and said no" from "the gate reported
  // no evidence", because only the second is fixed by supplying input.
  if (status === "unresolved") return { outcome: "failed", reason_code: "gate_unresolved" };
  if (status === "timed_out") return { outcome: "timed_out", reason_code: "gate_timed_out" };
  if (status === "cancelled") return { outcome: "cancelled", reason_code: "gate_cancelled_fail_fast" };
  if (status === "blocked_by_prerequisite") return { outcome: "cancelled", reason_code: "gate_blocked_by_prerequisite" };
  return { outcome: "failed", reason_code: "gate_failed" };
}

/**
 * Executes the selected dependency DAG. Read-only gates have bounded
 * concurrency; verification/evidence writers are exclusive in the shared
 * snapshot. A prerequisite runs once, and dependents report a blocked state.
 *
 * `progress` is an optional ADR-091 reporter (see finalization-progress.mjs).
 * It only observes this already-authoritative schedule; passing one changes
 * no scheduling, timeout, or pass/fail decision here.
 */
export async function executeGateDag({ registry, context, identity, cwd, executor, cache = new Map(), beforeIdentity = null, afterIdentity = null, progress = null, progressPhaseId = null, progressOrdinalStart = 0 }) {
  const definitions = selectClosure(registry, context);
  const executionPlan = planGateDag(registry, context);
  const schedule = executionContext(registry, context);
  const fingerprint = stableFingerprint(identity, registry, context);
  const results = new Map();
  const emissions = [];
  const waveTimings = [];
  const run = executor ?? (async (entry, _identity, _execution, hooks) => runDeadlineProcess({
    command: "bun",
    args: ["run", entry.name],
    cwd,
    timeout_ms: entry.timeout_ms,
    env: { ...process.env, REVOY_ENFORCEMENT_CONTEXT: context },
    onSpawn: hooks?.onSpawn ?? null,
    onOutput: hooks?.onOutput ?? null,
  }));
  const first = beforeIdentity ? beforeIdentity() : null;

  if (progress) {
    let ordinal = progressOrdinalStart;
    for (const wave of executionPlan.waves) {
      for (const name of wave.gates) {
        ordinal += 1;
        const entry = definitions.get(name);
        progress.planStage({ id: gateStageId(name), kind: "gate", ordinal, phase_id: progressPhaseId, wave: wave.wave, deadline_ms: entry.timeout_ms });
      }
    }
  }

  for (const [waveIndex, wave] of executionPlan.waves.entries()) {
    const waveStarted = Date.now();
    const scheduled = [];
    for (const name of wave.gates) {
      const entry = definitions.get(name);
      if (!entry) throw new Error(`planned unknown gate ${name}`);
      const dependencies = entry.prerequisites.map((dependency) => results.get(dependency));
      if (dependencies.some((value) => value && !isGreenGateStatus(value.status))) {
        const blockedResult = Object.freeze({ gate: name, status: "blocked_by_prerequisite", prerequisite_failures: dependencies.filter((value) => value && !isGreenGateStatus(value.status)).map((value) => value.gate), execution_wave: wave.wave, candidate_oid: identity.candidate_oid, input_digest: identity.input_digest, profile_version: registry.profile_version, duration_ms: 0 });
        results.set(name, blockedResult);
        if (progress) progress.stageTerminal(gateStageId(name), { ...gateProgressOutcome("blocked_by_prerequisite"), exit_code: null });
        continue;
      }
      scheduled.push(entry);
    }
    if (progress) for (const entry of scheduled) progress.startStage(gateStageId(entry.name), { deadline_ms: entry.timeout_ms, kind: "gate" });
    const layer = await Promise.all(scheduled.map(async (entry) => {
      const stageId = gateStageId(entry.name);
      const cacheKey = sha256(canonicalJson({ fingerprint, gate: entry.name, command: entry.command }));
      const cached = cache.get(cacheKey);
      if (cached?.status === "passed") {
        const result = Object.freeze({ ...cached, status: "cached", cached_from: cacheKey, execution_wave: wave.wave, duration_ms: 0 });
        if (progress) progress.markExitedPendingWave(stageId);
        return [entry.name, result];
      }
      const hooks = progress
        ? {
            onSpawn: (child) => progress.attachChild(stageId, { role: "gate", command_id: entry.command, pid: child.pid, process_group_id: child.process_group_id }),
            onOutput: (bytes) => progress.observeChildBytes(stageId, bytes),
          }
        : null;
      const raw = await run(entry, Object.freeze({ ...identity, profile_version: registry.profile_version, fingerprint }), Object.freeze({ cwd }), hooks);
      const output = raw.output ?? "";
      // A gate that declares `observes: { min: N }` is saying its input is
      // expected to be non-empty. Exiting 0 after observing fewer than N things
      // is not a pass — the gate reported no evidence about the input, and
      // `passed` would assert that it did. A gate that declared the expectation
      // and then reported NOTHING counts as zero observed, for the same reason:
      // silence is not a result. `unresolved` is the honest status and it is not
      // in GREEN_GATE_STATUSES, so every blocking decision below already treats
      // it as a failure.
      const observed_count = parseGateObservedCount(output);
      const expected_observed_min = Number.isSafeInteger(entry.observes?.min) && entry.observes.min >= 1 ? entry.observes.min : null;
      const unresolved = expected_observed_min !== null && (observed_count ?? 0) < expected_observed_min;
      const result = Object.freeze({
        gate: entry.name,
        effect: entry.effect,
        resource_class: entry.resource_class,
        mutability: entry.mutability,
        execution_wave: wave.wave,
        status: raw.status === "passed" && raw.ok ? (unresolved ? "unresolved" : "passed") : raw.status === "timed_out" ? "timed_out" : "failed",
        exit_code: raw.exit_code ?? null,
        duration_ms: raw.duration_ms ?? 0,
        observed_count,
        expected_observed_min,
        output,
        error: raw.error ?? null,
        candidate_oid: identity.candidate_oid,
        input_digest: identity.input_digest,
        profile_version: registry.profile_version,
        fingerprint,
      });
      if (result.status === "passed") cache.set(cacheKey, result);
      if (progress) progress.markExitedPendingWave(stageId);
      return [entry.name, result];
    }));
    for (const [name, result] of layer.sort(([left], [right]) => left.localeCompare(right))) {
      results.set(name, result);
      emissions.push(Object.freeze({ sequence: emissions.length + 1, wave: wave.wave, gate: name, status: result.status }));
      if (progress) progress.stageTerminal(gateStageId(name), { ...gateProgressOutcome(result.status), exit_code: result.exit_code ?? null });
    }
    waveTimings.push(Object.freeze({
      wave: wave.wave,
      duration_ms: Date.now() - waveStarted,
      gate_duration_ms: Object.freeze(Object.fromEntries(layer.map(([name, result]) => [name, result.duration_ms ?? 0]).sort(([left], [right]) => left.localeCompare(right)))),
      critical_gate: [...layer].sort((left, right) => (right[1].duration_ms ?? 0) - (left[1].duration_ms ?? 0) || left[0].localeCompare(right[0]))[0]?.[0] ?? null,
    }));
    const failed = layer.some(([, result]) => registry.gates[result.gate]?.effect === "blocking" && !isGreenGateStatus(result.status));
    if (failed && schedule.failure_policy === "fail_fast") {
      const failedGates = layer.filter(([, result]) => registry.gates[result.gate]?.effect === "blocking" && !isGreenGateStatus(result.status)).map(([name]) => name).sort();
      for (const laterWave of executionPlan.waves.slice(waveIndex + 1)) {
        for (const name of laterWave.gates) {
          const entry = definitions.get(name);
          if (!entry) throw new Error(`planned unknown gate ${name}`);
          const dependencies = entry.prerequisites.map((dependency) => results.get(dependency));
          const blocked = dependencies.filter((result) => result && !isGreenGateStatus(result.status)).map((result) => result.gate);
          const status = blocked.length > 0 ? "blocked_by_prerequisite" : "cancelled";
          const result = Object.freeze({
            gate: name,
            execution_wave: laterWave.wave,
            status,
            prerequisite_failures: blocked,
            cancelled_by_fail_fast: status === "cancelled" ? failedGates : undefined,
            candidate_oid: identity.candidate_oid,
            input_digest: identity.input_digest,
            profile_version: registry.profile_version,
            effect: entry.effect,
            resource_class: entry.resource_class,
            mutability: entry.mutability,
            duration_ms: 0,
          });
          results.set(name, result);
          emissions.push(Object.freeze({ sequence: emissions.length + 1, wave: laterWave.wave, gate: name, status }));
          if (progress) progress.stageTerminal(gateStageId(name), { ...gateProgressOutcome(status), exit_code: null });
        }
      }
      break;
    }
  }
  const last = afterIdentity ? afterIdentity() : null;
  const identityMismatch = first !== null && last !== null && first !== last;
  const gateResults = [...results.values()].sort((a, b) => a.gate.localeCompare(b.gate));
  const finalResults = identityMismatch
    ? gateResults.map((result) => Object.freeze({ ...result, invalidated_by: "watched_input_identity_mismatch" }))
    : gateResults;
  const blockingFailure = (result) => registry.gates[result.gate]?.effect === "blocking"
    && !isGreenGateStatus(result.status);
  const status = identityMismatch ? "identity_mismatch" : finalResults.some(blockingFailure) ? "failed" : "passed";
  const execution_manifest = createExecutionManifest({
    candidate_oid: identity.candidate_oid,
    input_digest: identity.input_digest,
    profile_version: registry.profile_version,
    profile_fingerprint: fingerprint,
    context,
    status,
    gates: finalResults,
  });
  return Object.freeze({
    ok: !identityMismatch && !finalResults.some(blockingFailure),
    status,
    candidate_oid: identity.candidate_oid,
    input_digest: identity.input_digest,
    profile_version: registry.profile_version,
    profile_fingerprint: fingerprint,
    execution_plan: executionPlan,
    execution_emissions: Object.freeze(emissions),
    timing_ms: Object.freeze({
      waves: Object.freeze(waveTimings),
      critical_path: Object.freeze(waveTimings.map((wave) => ({ wave: wave.wave, gate: wave.critical_gate, duration_ms: wave.duration_ms }))),
      critical_path_ms: waveTimings.reduce((sum, wave) => sum + wave.duration_ms, 0),
    }),
    gates: Object.freeze(finalResults),
    execution_manifest,
  });
}

const SNAPSHOT_WRITABLE_PREFIXES = Object.freeze([
  ".visual-intelligence/",
  ".claim-ledger/",
  ".completion-depth/",
  ".determinism-baseline/",
  ".arbor/",
]);
function snapshotWritablePath(path) {
  const normalized = path.replaceAll("\\", "/");
  return SNAPSHOT_WRITABLE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
/**
 * Record the tracked input set without changing its filesystem modes.
 *
 * A chmod-based freeze is not safe for a test battery: normal fixture-copy
 * helpers preserve source modes, so a read-only candidate leaks unreadable
 * modes into the fixture being tested. The detached worktree and content
 * identity are the immutable boundary; `runImmutableBattery` watches its
 * complete working digest before and after every battery, and rejects any
 * source mutation rather than relying on inherited permissions.
 */
export function freezeTrackedInputs(snapshot) {
  const tracked = git(snapshot, ["ls-files", "-z"]).split("\0").filter(Boolean);
  return Object.freeze(tracked);
}

export function createImmutableSnapshot(repo = REPO_ROOT, candidate = "HEAD") {
  const identity = resolveCandidateIdentity(repo, candidate);
  const reserved = mkdtempSync(join(tmpdir(), "revoy2-enforcement-snapshot-"));
  rmSync(reserved, { recursive: true, force: true });
  try {
    const result = spawnSync("git", ["-C", repo, "worktree", "add", "--detach", reserved, identity.candidate_oid], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`could not create immutable snapshot: ${(result.stderr || result.stdout).trim()}`);
    const snapshotIdentity = resolveCandidateIdentity(reserved, "HEAD");
    if (snapshotIdentity.candidate_oid !== identity.candidate_oid || snapshotIdentity.input_digest !== identity.input_digest) {
      throw new Error("immutable snapshot identity did not match requested candidate");
    }
  } catch (error) {
    rmSync(reserved, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({ path: reserved, identity, cleanup: () => {
    const remove = spawnSync("git", ["-C", repo, "worktree", "remove", "--force", reserved], { encoding: "utf8" });
    if (remove.status !== 0) rmSync(reserved, { recursive: true, force: true });
  } });
}

/**
 * Run the production battery exclusively from one committed candidate tree.
 *
 * A caller's live checkout is transport, not input. It may contain unrelated
 * tracked or untracked work and may continue changing while the selected
 * candidate runs. Registry and package metadata therefore resolve inside the
 * detached snapshot as well; otherwise a dirty live profile could silently
 * control which gates attest a different commit.
 */
/**
 * ADR-091: the shared progress reporter. Passing `progress: null` opts a
 * caller (a unit test, a diagnostic script) out of emission entirely; leaving
 * it unset (the pre-push hook and CI both call this with no `progress`
 * argument) creates the real reporter so the governed path always streams —
 * there is no separate silent code path to regain.
 */
function defaultBatteryReporter({ context, progressMode }) {
  const renderer = selectProgressRenderer(progressMode, process.stderr.isTTY === true);
  return createProgressReporter({
    workflowId: "prepush_finalization",
    context,
    onEvent: (event) => { process.stderr.write(`${renderer(event)}\n`); },
  });
}

export async function runImmutableBattery({ repo = REPO_ROOT, candidate = "HEAD", context = "ci", registryPath = null, executor = null, cache = new Map(), prepareSnapshot = true, preparedSnapshotPath = null, progress = undefined, progressMode = "auto" } = {}) {
  // Kept in the returned receipt so a benchmark can separate immutable setup,
  // candidate build, and gate critical path without parsing progress text. The
  // values are observational only: scheduling, cache keys, and pass/fail
  // remain exactly the same with or without a consumer reading them.
  const timing_ms = { snapshot: 0, dependency_install: 0, candidate_build: 0, gates: 0 };
  const ownsReporter = progress === undefined;
  const reporter = ownsReporter ? defaultBatteryReporter({ context, progressMode }) : progress;
  if (ownsReporter) reporter.startRealHeartbeat();
  // A caller that supplies its own `progress` reporter (finalize.mjs, threading
  // one reporter across several finalization phases) owns run_started/
  // run_terminal itself; this battery only contributes stage-level events to
  // that shared stream. A standalone call (the common case: no `progress`
  // argument) owns its own single run lifecycle.
  const emitRunStarted = () => { if (ownsReporter) reporter?.runStarted(); };
  const emitRunTerminal = (event) => { if (ownsReporter) reporter?.runTerminal(event); };
  try {
    emitRunStarted();
    let snapshot;
    try {
      const snapshotStarted = Date.now();
      if (preparedSnapshotPath === null) snapshot = createImmutableSnapshot(repo, candidate);
      else {
        const prepared = resolve(preparedSnapshotPath);
        const expected = resolveCandidateIdentity(repo, candidate);
        const observed = resolveCandidateIdentity(prepared, "HEAD");
        const branch = spawnSync("git", ["-C", prepared, "symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8" });
        if (observed.candidate_oid !== expected.candidate_oid || observed.input_digest !== expected.input_digest || branch.status !== 1) throw new Error("prepared snapshot is not the exact detached candidate");
        snapshot = Object.freeze({ path: prepared, identity: expected, cleanup: () => {} });
      }
      timing_ms.snapshot = Date.now() - snapshotStarted;
    } catch (error) {
      emitRunTerminal({ outcome: "refused", reason_code: "candidate_snapshot_unavailable", exit_code: null });
      throw error;
    }
    try {
      reporter?.planStage({ id: "candidate_snapshot", kind: "candidate_snapshot", ordinal: 1, phase_id: "immutable_prepush", wave: null, deadline_reason: "unbounded_setup" });
      reporter?.startStage("candidate_snapshot", { deadline_reason: "unbounded_setup", kind: "candidate_snapshot" });
      reporter?.stageTerminal("candidate_snapshot", { outcome: "succeeded", reason_code: "snapshot_created", exit_code: null });

      const requestedRegistry = resolve(registryPath ?? join(repo, "scripts", "execution-profile.json"));
      const registryRelativePath = relative(resolve(repo), requestedRegistry);
      if (registryRelativePath === "" || registryRelativePath === ".." || registryRelativePath.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`) || isAbsolute(registryRelativePath)) {
        emitRunTerminal({ outcome: "refused", reason_code: "registry_outside_candidate", exit_code: null });
        return Object.freeze({ ok: false, status: "registry_outside_candidate", candidate_oid: snapshot.identity.candidate_oid, input_digest: snapshot.identity.input_digest, gates: [] });
      }
      const registry = loadExecutionProfile(join(snapshot.path, registryRelativePath));
      const packageJson = JSON.parse(readFileSync(join(snapshot.path, "package.json"), "utf8"));
      const rosterProblems = auditExecutionProfile(registry, packageJson);
      if (rosterProblems.length) {
        emitRunTerminal({ outcome: "refused", reason_code: "roster_invalid", exit_code: null });
        return Object.freeze({ ok: false, status: "roster_invalid", roster_problems: rosterProblems, gates: [] });
      }
      let progressOrdinalStart = 1;
      // Dependency resolution belongs to the snapshot too. Linking a live
      // checkout's node_modules would let the candidate observe a different
      // lockfile/workspace shape than the identity it attests.
      if (prepareSnapshot && executor === null) {
        reporter?.planStage({ id: "dependency_install", kind: "dependency_install", ordinal: 2, phase_id: "immutable_prepush", wave: null, deadline_reason: "unbounded_setup" });
        reporter?.planStage({ id: "candidate_build", kind: "candidate_build", ordinal: 3, phase_id: "immutable_prepush", wave: null, deadline_reason: "unbounded_setup" });
        progressOrdinalStart = 3;
        reporter?.startStage("dependency_install", { deadline_reason: "unbounded_setup", kind: "dependency_install" });
        if (preparedSnapshotPath === null) {
          const installStarted = Date.now();
          const prepared = spawnSync("bun", ["install", "--frozen-lockfile"], { cwd: snapshot.path, encoding: "utf8", timeout: 600_000 });
          timing_ms.dependency_install = Date.now() - installStarted;
          if (prepared.status !== 0) {
            reporter?.stageTerminal("dependency_install", { outcome: "failed", reason_code: "frozen_install_failed", exit_code: prepared.status ?? null });
            emitRunTerminal({ outcome: "failed", reason_code: "snapshot_setup_failed", exit_code: prepared.status ?? null });
            return Object.freeze({ ok: false, status: "snapshot_setup_failed", candidate_oid: snapshot.identity.candidate_oid, input_digest: snapshot.identity.input_digest, detail: (prepared.stderr || prepared.stdout || "bun install failed").trim(), gates: [], timing_ms: Object.freeze({ ...timing_ms }) });
          }
          reporter?.stageTerminal("dependency_install", { outcome: "succeeded", reason_code: "frozen_install_complete", exit_code: prepared.status ?? 0 });
        } else reporter?.stageTerminal("dependency_install", { outcome: "succeeded", reason_code: "frozen_install_reused", exit_code: 0 });
        // Process-level and coverage gates consume compiled package entry points.
        // Build exactly once inside the candidate snapshot before any DAG gate;
        // a live-checkout build would not attest the candidate's own bytes.
        reporter?.startStage("candidate_build", { deadline_reason: "unbounded_setup", kind: "candidate_build" });
        const buildStarted = Date.now();
        const built = spawnSync("bun", ["run", "build"], { cwd: snapshot.path, encoding: "utf8", timeout: 1_800_000 });
        timing_ms.candidate_build = Date.now() - buildStarted;
        if (built.status !== 0) {
          reporter?.stageTerminal("candidate_build", { outcome: "failed", reason_code: "candidate_build_failed", exit_code: built.status ?? null });
          emitRunTerminal({ outcome: "failed", reason_code: "snapshot_setup_failed", exit_code: built.status ?? null });
          return Object.freeze({ ok: false, status: "snapshot_setup_failed", candidate_oid: snapshot.identity.candidate_oid, input_digest: snapshot.identity.input_digest, detail: (built.stderr || built.stdout || "candidate build failed").trim(), gates: [], timing_ms: Object.freeze({ ...timing_ms }) });
        }
        reporter?.stageTerminal("candidate_build", { outcome: "succeeded", reason_code: "candidate_build_complete", exit_code: built.status ?? 0 });
      }
      // The detached worktree is the only gate input. Source modes stay normal
      // so gates can make writable fixture copies; the identity watcher below
      // fails closed for every tracked/untracked/staged source mutation.
      freezeTrackedInputs(snapshot.path);
      const snapshotBefore = resolveWorkingIdentity(snapshot.path, snapshot.identity.candidate_oid).working_digest;
      const gatesStarted = Date.now();
      const report = await executeGateDag({
        registry,
        context,
        identity: snapshot.identity,
        cwd: snapshot.path,
        executor,
        cache,
        beforeIdentity: () => snapshotBefore,
        afterIdentity: () => resolveWorkingIdentity(snapshot.path, snapshot.identity.candidate_oid).working_digest,
        progress: reporter,
        progressPhaseId: "immutable_prepush",
        progressOrdinalStart,
      });
      timing_ms.gates = Date.now() - gatesStarted;
      emitRunTerminal({
        outcome: report.status === "identity_mismatch" ? "cancelled" : report.ok ? "succeeded" : "failed",
        reason_code: report.status,
        exit_code: null,
      });
      return Object.freeze({
        ...report,
        snapshot: { candidate_oid: snapshot.identity.candidate_oid, input_digest: snapshot.identity.input_digest },
        timing_ms: Object.freeze({
          ...timing_ms,
          wave_timings: report.timing_ms?.waves ?? [],
          critical_path: report.timing_ms?.critical_path ?? [],
          critical_path_ms: report.timing_ms?.critical_path_ms ?? timing_ms.gates,
          total_ms: timing_ms.snapshot + timing_ms.dependency_install + timing_ms.candidate_build + timing_ms.gates,
        }),
      });
    } finally {
      snapshot.cleanup();
    }
  } finally {
    if (ownsReporter) reporter.stopRealHeartbeat();
  }
}

/** CI/profile contract is textual by design: the workflow must call the one aggregate runner, not hand-copy a roster. */
export function auditWorkflowProfile({ registry, workflowText, prePushText, preCommitText = null, trunkSubmitText }) {
  const problems = [];
  if (!workflowText.includes("bun run enforcement:ci")) problems.push("CI must run the aggregate enforcement:ci profile");
  if (!/id:\s*battery/.test(workflowText) || !/continue-on-error:\s*true/.test(workflowText)) problems.push("CI must retain a named battery step so failed execution still emits an explicit report");
  if (!workflowText.includes("aggregate-report.json")) problems.push("CI must retain the aggregate execution report for remote execution proof");
  if (!workflowText.includes("attestation:emit")) problems.push("CI must publish the aggregate enforcement attestation");
  if (!workflowText.includes("actions/upload-artifact@")) problems.push("CI must upload the aggregate attestation artifact");
  const jobsBlock = workflowText.slice(workflowText.indexOf("\njobs:\n") + 7);
  const jobStarts = [...jobsBlock.matchAll(/^  ([a-z0-9-]+):\s*$/gm)];
  const jobs = jobStarts.map((match, index) => ({
    id: match[1],
    body: jobsBlock.slice(match.index, jobStarts[index + 1]?.index ?? jobsBlock.length),
  }));
  const linuxAuthorities = jobs.filter(({ body }) => /runs-on:\s*\[self-hosted, Linux, X64\]/.test(body)).map(({ id }) => id);
  if (linuxAuthorities.length !== 1 || linuxAuthorities[0] !== "enforcement-control-plane") {
    problems.push(`CI must have exactly one Linux authority job (enforcement-control-plane), found: ${linuxAuthorities.join(", ") || "none"}`);
  }
  if (!prePushText.includes("bun run enforcement:prepush")) problems.push("pre-push must consume the declarative prepush profile");
  if (preCommitText !== null && !preCommitText.includes("bun run enforcement:precommit")) problems.push("pre-commit must consume the declarative managed-hook profile");
  if (!trunkSubmitText.includes("verifyTrunkSubmitExecutionProfile")) problems.push("trunk:submit must mechanically verify its hook-authority profile");
  for (const [name, entry] of Object.entries(registry.gates)) {
    if (entry.contexts.ci && entry.remote_receipt?.kind === "github_api") {
      const tokenBinding = `${entry.remote_receipt.environment}: \${{ github.token }}`;
      if (!workflowText.includes(tokenBinding)) problems.push(`${name} requires CI to bind ${entry.remote_receipt.environment} to github.token`);
      for (const [permission, access] of Object.entries(entry.remote_receipt.permissions ?? {})) {
        if (!workflowText.includes(`${permission}: ${access}`)) problems.push(`${name} requires CI permission ${permission}: ${access}`);
      }
    }
  }
  for (const [name, entry] of Object.entries(registry.gates)) {
    if (entry.required && entry.contexts.ci !== true) problems.push(`${name} required gate is omitted from CI`);
  }
  return Object.freeze(problems);
}

/**
 * trunk:submit delegates source commit admission to the managed pre-commit and
 * pre-push hooks. Its registry context records that non-duplication explicitly.
 */
export function verifyTrunkSubmitExecutionProfile(repo = REPO_ROOT, registryPath = null) {
  const registry = loadExecutionProfile(registryPath ?? join(repo, "scripts", "execution-profile.json"));
  const packageJson = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const problems = auditExecutionProfile(registry, packageJson);
  for (const [name, entry] of Object.entries(registry.gates)) {
    if (entry.contexts.trunk_submit === false && entry.excluded_contexts.trunk_submit?.code !== "inherited_by_managed_hooks") {
      problems.push(`${name} trunk_submit exclusion must be inherited_by_managed_hooks or be selected directly`);
    }
  }
  return Object.freeze({ ok: problems.length === 0, problems });
}

/**
 * `--verify` used to validate only execution-profile.json's own shape; it
 * never checked that `gate-all.mjs` (the Stop-hook battery) actually obeys
 * that profile. On 2026-08-24 that gap let `gate:organization-enrollment`
 * (cost_class "stop", `contexts.stop: false`) run at every Stop anyway,
 * because gate-all selected its stop tier by cost_class alone. This proves
 * the two stay in lockstep going forward: for every tier name that is ALSO a
 * real execution context (today, only "stop"), gate-all's own `tierRoster`
 * must equal `selectedGates` exactly — the one authoritative selector,
 * imported directly rather than re-derived, so there is only ever one answer
 * to "which gates run in context X".
 */
export async function auditGateAllTierAgreement({ repo = REPO_ROOT, registry = null, registryPath = DEFAULT_REGISTRY_PATH } = {}) {
  const resolvedRegistry = registry ?? loadExecutionProfile(registryPath);
  const gateAllModule = await import(pathToFileURL(join(repo, "scripts", "gate-all.mjs")).href);
  const { tierRoster, enumerateGates, TIER_NAMES: tierNames } = gateAllModule;
  const declared = enumerateGates(repo);
  const problems = [];
  for (const tier of tierNames) {
    if (!EXECUTION_CONTEXTS.includes(tier)) continue;
    const battery = new Set(tierRoster(tier, { profile: resolvedRegistry, declared }));
    const authoritative = new Set(selectedGates(resolvedRegistry, tier).map((entry) => entry.name));
    const missingFromBattery = [...authoritative].filter((name) => !battery.has(name)).sort();
    const extraInBattery = [...battery].filter((name) => !authoritative.has(name)).sort();
    if (missingFromBattery.length > 0) {
      problems.push(`gate-all.mjs --tier ${tier} is missing gate(s) that selectedGates(registry, "${tier}") selects: ${missingFromBattery.join(", ")}`);
    }
    if (extraInBattery.length > 0) {
      problems.push(`gate-all.mjs --tier ${tier} runs gate(s) that selectedGates(registry, "${tier}") does not select: ${extraInBattery.join(", ")} — a stop-tier gate must also declare contexts.${tier}: true, or it must not be cost_class "${tier}"`);
    }
  }
  return Object.freeze(problems);
}

function parseFlag(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const repo = resolve(parseFlag(args, "--repo", REPO_ROOT));
  const registryPath = resolve(parseFlag(args, "--registry", DEFAULT_REGISTRY_PATH));
  if (args.includes("--verify")) {
    const registry = loadExecutionProfile(registryPath);
    const packageJson = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    const problems = [
      ...auditExecutionProfile(registry, packageJson),
      ...(await auditGateAllTierAgreement({ repo, registry })),
    ];
    const result = { ok: problems.length === 0, problems, profile_version: registry.profile_version };
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  const context = parseFlag(args, "--context", "ci");
  const report = await runImmutableBattery({ repo, candidate: parseFlag(args, "--candidate", "HEAD"), context, registryPath });
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`enforcement control plane: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
