#!/usr/bin/env node
/**
 * Repository-common evidence writer lease.
 *
 * The lease is a directory acquired with mkdir, not a PID file. A contender
 * never removes it. A dead owner is evidence for an explicit recovery command,
 * never permission for automatic lock theft.
 *
 * `bun run evidence:status` reports the lease without touching it: who holds
 * it, since when, and whether that owner is live/dead/ambiguous — printing
 * the exact `evidence:recover` command when it is provably dead. Run it FIRST
 * whenever a producer refuses with `not_lock_owner` or `owner_exists`.
 *
 * ADR-092 extends this with a durable, versioned lifecycle observation
 * contract (schema_version 2): who holds the lease, which closed phase it is
 * in and since when, a structured heartbeat, the currently-armed deadline (if
 * any), a redacted projection of the child processes it owns, and a terminal
 * outcome recorded before cleanup/release. It is an extension of the same
 * lease — the directory lock remains the single writer authority — not a
 * second lease implementation.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCandidateIdentity } from "./enforcement-control-plane.mjs";
import { createGovernanceProducerPlan } from "./lib/governance-plan.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_SCHEMA_VERSION = 2;
// This is not an invented shape: it matches the schema-2 lock already
// observed live on this machine, written by a sibling worktree that shares
// this repository's git-common-dir (and therefore this exact lock file) —
// see ADR-101 Context (b) and ADR-092's Decision §1. Matching its `kind`,
// `phase_timestamps`, `heartbeat{sequence,at}`, `children`, and
// `deadline{status,at}` shape means a v2 lock either process writes stays
// mutually recognizable instead of inventing a second, incompatible v2.
const LOCK_KIND = "revoy2.evidence_transaction_lifecycle";
const TERMINAL_RECEIPT_SCHEMA_VERSION = 2;
const TERMINAL_RECEIPT_KIND = "revoy2.evidence_transaction_terminal_receipt";
/** ADR-092 §2: the declared heartbeat staleness threshold. */
export const EVIDENCE_HEARTBEAT_STALE_MS = 30_000;
/** ADR-092 §1: the closed lifecycle phase vocabulary. */
export const LIFECYCLE_PHASES = Object.freeze([
  "acquired", "snapshot_prepared", "dependency_install", "candidate_build",
  "producer_running", "normalizing_evidence", "atomic_publish",
  "completed", "failed", "timed_out", "cancelled",
]);
/** ADR-092 §1: the closed terminal outcome vocabulary. */
export const TERMINAL_OUTCOMES = Object.freeze(["succeeded", "failed", "timed_out", "cancelled", "refused"]);
const TERMINAL_PHASE_FOR_OUTCOME = Object.freeze({ succeeded: "completed", failed: "failed", timed_out: "timed_out", cancelled: "cancelled", refused: "failed" });
const PRODUCER_DEFAULT_DEADLINE_MS = 1_800_000;
const SETUP_DEADLINE_MS = 600_000;
const BUILD_DEADLINE_MS = 1_800_000;
const KILL_GRACE_MS = 1_000;
export const EVIDENCE_PATH_PREFIXES = Object.freeze([
  ".visual-intelligence/",
  ".claim-ledger/",
  ".completion-depth/",
  ".determinism-baseline/",
]);
export class EvidenceTransactionRefusal extends Error {
  constructor(code, message, state = null) { super(message); this.code = code; this.state = state; }
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function now() { return new Date().toISOString(); }
/**
 * The minimum readable envelope every lock schema version is contractually
 * required to preserve (ADR-101 rule 1). A ~70-worktree checkout shares this
 * lock path across concurrent branches running different revisions of this
 * very file; a newer (or older) writer's healthy lock must never be mistaken
 * for corruption just because its `schema_version` differs from this
 * reader's. Fields *outside* the envelope (phase, lifecycle, deadline, …)
 * remain opaque to a reader that does not recognize the schema — only these
 * fields are load-bearing across every version.
 */
function isValidEnvelope(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  if (typeof state.schema_version !== "number") return false;
  if (typeof state.transaction_id !== "string" || state.transaction_id.length === 0) return false;
  if (typeof state.heartbeat_at !== "string" || state.heartbeat_at.length === 0) return false;
  const owner = state.owner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return false;
  if (typeof owner.pid !== "number") return false;
  if (typeof owner.owner_id !== "string" || owner.owner_id.length === 0) return false;
  // `acquired_at` is part of the envelope contract every real writer sets
  // (acquireEvidenceTransaction always stamps it), but is display-only here
  // — ownerLiveness needs only pid/process_start_identity — so a state that
  // omits it is not treated as malformed, only mistyped-if-present.
  if (owner.acquired_at !== undefined && typeof owner.acquired_at !== "string") return false;
  if (owner.process_start_identity !== undefined && owner.process_start_identity !== null && typeof owner.process_start_identity !== "string") return false;
  return true;
}
/** True only for a well-formed schema-2 lifecycle envelope (ADR-092 §1). */
function isValidLifecycleV2(state) {
  if (state.kind !== LOCK_KIND) return false;
  if (typeof state.phase !== "string") return false;
  const lifecycle = state.lifecycle;
  if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) return false;
  if (!lifecycle.heartbeat || typeof lifecycle.heartbeat.sequence !== "number" || typeof lifecycle.heartbeat.at !== "string") return false;
  if (!lifecycle.phase_timestamps || typeof lifecycle.phase_timestamps !== "object") return false;
  if (!lifecycle.children || typeof lifecycle.children !== "object") return false;
  if (!lifecycle.deadline || typeof lifecycle.deadline.status !== "string") return false;
  return true;
}
function heartbeatAgeMs(state, clock = null) {
  const parsed = Date.parse(state.heartbeat_at);
  const observedAt = typeof clock === "function" ? clock() : Date.now();
  return Number.isFinite(parsed) ? Math.max(0, observedAt - parsed) : null;
}
function formatAge(ms) { return ms === null ? "unknown" : `${Math.round(ms / 1000)}s`; }
function ownerSummary(state) { return `pid ${state.owner.pid} (owner: ${state.owner.owner_id})`; }
/**
 * ADR-101 rule 2: names the holder and a heartbeat age computed from
 * `heartbeat_at`, never a fabricated persisted deadline — schema 1 does not
 * persist one, even though a newer schema (observed: schema 2's
 * `lifecycle.heartbeat: { sequence, at }` and persisted `lifecycle.deadline`)
 * might. Those richer, version-specific fields stay opaque here by design;
 * only the envelope is interpreted.
 */
function unsupportedSchemaVersionMessage(paths, state) {
  return `evidence lock state at ${paths.state} is held by ${ownerSummary(state)} using schema_version ${state.schema_version}, which this checkout's evidence-transaction.mjs (schema_version ${LOCK_SCHEMA_VERSION}) does not recognize; last heartbeat ${formatAge(heartbeatAgeMs(state))} ago. This is a newer or older writer's healthy lock, not corruption — wait for it to release, or run \`bun run evidence:status\` to check liveness before considering \`evidence:recover\`.`;
}
function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
function gitCommonDir(repo) {
  const result = spawnSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
  if (result.status !== 0) throw new EvidenceTransactionRefusal("not_a_git_repository", `cannot resolve repository common git directory: ${(result.stderr || result.stdout).trim()}`);
  return resolve(repo, result.stdout.trim());
}
export function evidenceTransactionPaths(repo = REPO_ROOT, commonDir = null) {
  const common = commonDir ?? gitCommonDir(repo);
  const directory = join(common, "arbor", "evidence-refresh");
  return Object.freeze({ common_dir: common, directory, lock: join(directory, "lock"), state: join(directory, "lock", "state.json"), receipts: join(directory, "receipts") });
}
export function processStartIdentity(pid = process.pid) {
  const path = `/proc/${pid}/stat`;
  try {
    const text = readFileSync(path, "utf8").trim();
    const afterCommand = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTicks = afterCommand[19]; // field 22 minus pid/comm fields
    return typeof startTicks === "string" && startTicks.length > 0 ? `linux-proc-start:${startTicks}` : null;
  } catch { return null; }
}
export function ownerLiveness(owner) {
  if (!owner || typeof owner.pid !== "number") return "ambiguous";
  try { process.kill(owner.pid, 0); } catch (error) { return error?.code === "ESRCH" ? "dead" : "ambiguous"; }
  const actual = processStartIdentity(owner.pid);
  if (owner.process_start_identity === null || actual === null) return "ambiguous";
  return actual === owner.process_start_identity ? "live" : "dead";
}
export function readState(paths) {
  if (!existsSync(paths.state)) throw new EvidenceTransactionRefusal("ambiguous_lock", `evidence lock exists at ${paths.lock} but has no readable state.json; do not remove it. Inspect it and use explicit recovery only after establishing ownership.`);
  let state;
  try {
    state = JSON.parse(readFileSync(paths.state, "utf8"));
    if (!isValidEnvelope(state)) throw new Error("envelope fields missing or mistyped (schema_version, transaction_id, owner{pid,owner_id,acquired_at,process_start_identity}, heartbeat_at)");
  } catch (error) {
    // ADR-101 rule 1: this is the genuinely-malformed case — either the JSON
    // does not parse, or the minimum readable envelope every schema version
    // must preserve is absent or mistyped. A schema_version that merely
    // differs from LOCK_SCHEMA_VERSION, with a valid envelope, is NOT this
    // case (see below) — it is a distinct, safe, waitable state.
    throw new EvidenceTransactionRefusal("ambiguous_lock", `evidence lock state at ${paths.state} is malformed; no process may steal it automatically (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (state.schema_version === 1) {
    // A v1 residue is fully readable and recoverable under the existing
    // proven-dead rule (ADR-092 Decision §1) — it is a known, older schema,
    // not an unrecognized one. It is never silently rewritten and never
    // treated as fresh by a missing v2 field.
    return Object.freeze({ ...state, legacy_schema_v1: true });
  }
  if (state.schema_version === LOCK_SCHEMA_VERSION) {
    if (!isValidLifecycleV2(state)) throw new EvidenceTransactionRefusal("ambiguous_lock", `evidence lock state at ${paths.state} declares schema_version ${LOCK_SCHEMA_VERSION} but its lifecycle envelope is missing or mistyped; no process may steal it automatically.`);
    return state;
  }
  // A newer (or older, but not v1) writer's healthy lock, not corruption —
  // the envelope validated above is exactly what lets ownerLiveness and
  // message construction still run against `state.owner`. Everything else
  // in `state` (phase, lifecycle, deadline, …) remains opaque here.
  throw new EvidenceTransactionRefusal("unsupported_schema_version", unsupportedSchemaVersionMessage(paths, state), state);
}
function assertOwner(state, transactionId, delegationToken) {
  if (state.legacy_schema_v1) throw new EvidenceTransactionRefusal("legacy_lock_requires_recovery", `legacy (schema_version 1) evidence lock ${state.transaction_id} cannot delegate a schema_version ${LOCK_SCHEMA_VERSION} producer; run evidence transaction recovery explicitly`, state);
  if (state.transaction_id !== transactionId || !delegationToken || digest(delegationToken) !== state.delegation_token_digest) {
    throw new EvidenceTransactionRefusal("not_lock_owner", `evidence refresh is owned by transaction ${state.transaction_id}; this producer was not delegated by that owner. First diagnostic step: \`bun run evidence:status\``, state);
  }
  const liveness = ownerLiveness(state.owner);
  if (liveness !== "live") throw new EvidenceTransactionRefusal(liveness === "dead" ? "dead_owner_requires_recovery" : "ambiguous_owner_requires_recovery", `evidence transaction ${state.transaction_id} is ${liveness}; run evidence transaction recovery explicitly before any producer writes`, state);
}
export function acquireEvidenceTransaction({ repo = REPO_ROOT, transactionId = randomUUID(), expectedCandidate = null, expectedInputDigest = null, ownerId = `pid:${process.pid}`, commonDir = null } = {}) {
  const paths = evidenceTransactionPaths(repo, commonDir);
  const identity = expectedCandidate && expectedInputDigest ? { candidate_oid: expectedCandidate, input_digest: expectedInputDigest } : resolveCandidateIdentity(repo);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const delegationToken = randomUUID();
  const acquiredAt = now();
  const state = Object.freeze({
    schema_version: LOCK_SCHEMA_VERSION,
    kind: LOCK_KIND,
    transaction_id: transactionId,
    owner: Object.freeze({ owner_id: ownerId, pid: process.pid, process_start_identity: processStartIdentity(), acquired_at: acquiredAt }),
    expected_candidate_oid: identity.candidate_oid,
    expected_input_digest: identity.input_digest,
    phase: "acquired",
    lifecycle: Object.freeze({
      phase_timestamps: Object.freeze({ acquired: acquiredAt }),
      heartbeat: Object.freeze({ sequence: 1, at: acquiredAt }),
      children: Object.freeze({ setup: Object.freeze({ status: "pending" }), build: Object.freeze({ status: "pending" }), producer: Object.freeze({ status: "pending" }) }),
      deadline: Object.freeze({ status: "unarmed", at: null }),
      terminal: null,
    }),
    heartbeat_at: acquiredAt,
    delegation_token_digest: digest(delegationToken),
  });
  try {
    mkdirSync(paths.lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let existing;
    try {
      existing = readState(paths);
    } catch (readError) {
      // A newer/older schema's healthy lock still blocks acquisition — it
      // just isn't "malformed." readState already validated its envelope,
      // so ownerLiveness can still run against it.
      if (readError instanceof EvidenceTransactionRefusal && readError.code === "unsupported_schema_version") existing = readError.state;
      else throw readError;
    }
    const liveness = ownerLiveness(existing.owner);
    throw new EvidenceTransactionRefusal(liveness === "live" ? "owner_exists" : liveness === "dead" ? "dead_owner_requires_recovery" : "ambiguous_owner_requires_recovery", `evidence refresh transaction ${existing.transaction_id} already owns ${paths.lock} (${liveness}); it was not removed or stolen. First diagnostic step: \`bun run evidence:status\`. ${liveness === "dead" ? "Run `bun run evidence:recover -- --transaction " + existing.transaction_id + "` after review." : "Wait for the owner or inspect its state."}`, existing);
  }
  atomicJson(paths.state, state);
  const mutate = (patch = {}) => {
    const current = readState(paths);
    assertOwner(current, transactionId, delegationToken);
    const updatedAt = now();
    const nextPhase = patch.phase ?? current.phase;
    const lifecyclePatch = patch.lifecycle ?? {};
    const currentLifecycle = current.lifecycle;
    const nextLifecycle = Object.freeze({
      ...currentLifecycle,
      ...lifecyclePatch,
      phase_timestamps: Object.freeze({ ...currentLifecycle.phase_timestamps, ...(nextPhase !== current.phase ? { [nextPhase]: updatedAt } : {}), ...(lifecyclePatch.phase_timestamps ?? {}) }),
      heartbeat: Object.freeze({ sequence: (currentLifecycle.heartbeat?.sequence ?? 0) + 1, at: updatedAt }),
      children: Object.freeze({ ...currentLifecycle.children, ...(lifecyclePatch.children ?? {}) }),
      deadline: Object.freeze({ ...currentLifecycle.deadline, ...(lifecyclePatch.deadline ?? {}) }),
      terminal: lifecyclePatch.terminal !== undefined ? lifecyclePatch.terminal : currentLifecycle.terminal,
    });
    const next = Object.freeze({ ...current, phase: nextPhase, lifecycle: nextLifecycle, heartbeat_at: updatedAt });
    atomicJson(paths.state, next);
    return next;
  };
  const release = () => {
    const current = readState(paths);
    assertOwner(current, transactionId, delegationToken);
    rmSync(paths.lock, { recursive: true, force: false });
  };
  // `transition` is intentionally permissive about unrecognized phase names:
  // scripts/trunk-submit.mjs (outside this ADR's file ownership) already
  // calls `lease.transition("graph_precheck_and_evidence_producers")`, a
  // phase the ADR-092 closed vocabulary does not define. Rejecting it here
  // would break a real, unrelated caller this tranche does not own. Every
  // phase this file itself passes to `transition` stays inside
  // LIFECYCLE_PHASES.
  const transition = (phase) => mutate({ phase });
  /** Redacted child-process identity/status projection (ADR-092 §1). */
  const child = (name, status, extra = {}) => mutate({ lifecycle: { children: { [name]: Object.freeze({ status, at: now(), ...extra }) } } });
  const deadline = (status, at = null) => mutate({ lifecycle: { deadline: Object.freeze({ status, at }) } });
  const terminal = (outcome, reason = null) => {
    if (!TERMINAL_OUTCOMES.includes(outcome)) throw new EvidenceTransactionRefusal("unknown_terminal_outcome", `evidence transaction does not define terminal outcome ${outcome}`);
    return mutate({ phase: TERMINAL_PHASE_FOR_OUTCOME[outcome], lifecycle: { terminal: Object.freeze({ outcome, at: now(), reason }) } });
  };
  return Object.freeze({
    paths, state, transaction_id: transactionId, delegation_token: delegationToken,
    heartbeat: () => mutate({}), transition, child, deadline, terminal, release,
    environment: Object.freeze({ REVOY_EVIDENCE_TRANSACTION_ID: transactionId, REVOY_EVIDENCE_DELEGATION_TOKEN: delegationToken, REVOY_EVIDENCE_EXPECTED_OID: identity.candidate_oid, REVOY_EVIDENCE_INPUT_DIGEST: identity.input_digest }),
  });
}
/** Wait only for a bounded interval; expiry remains an actionable refusal, never lock theft. */
export async function acquireEvidenceTransactionWithWait({ wait_ms = 0, ...options } = {}) {
  const deadline = Date.now() + Math.max(0, wait_ms);
  while (true) {
    try { return acquireEvidenceTransaction(options); }
    catch (error) {
      if (!(error instanceof EvidenceTransactionRefusal) || error.code !== "owner_exists" || Date.now() >= deadline) {
        if (error instanceof EvidenceTransactionRefusal && error.code === "owner_exists" && wait_ms > 0) {
          // ADR-101 rule 2: name the holder and its heartbeat age, and be
          // explicit that `wait_ms` is THIS CALLER's own polling deadline,
          // never a timer persisted on the lock itself.
          const state = error.state;
          const ownerDetail = state?.owner ? ` ${ownerSummary(state)}` : "";
          const ageDetail = state ? `, last heartbeat ${formatAge(heartbeatAgeMs(state))} ago` : "";
          throw new EvidenceTransactionRefusal("bounded_wait_exhausted", `evidence transaction owner${ownerDetail} did not release the lease within this caller's own ${wait_ms}ms polling deadline${ageDetail}; no lock was stolen and no timer is persisted on the lock itself`, error.state);
        }
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
  }
}
/** Direct evidence writers call this before writing. Absence is valid; a present lock requires an owner delegation. */
/**
 * Beat a lease from OUTSIDE the owning closure.
 *
 * The in-process interval a direct owner starts cannot help a producer that
 * blocks its own event loop, and both of this repository's slow producers do:
 * `determinism-baseline` is a synchronous `spawnSync` loop, and `vi-refresh`
 * was observed printing progress with a 149-second-stale heartbeat against a
 * 30-second threshold. A beat therefore has to be reachable from a separate
 * process, which means it cannot live in the closure `acquireEvidenceTransaction`
 * returns.
 *
 * This is deliberately NOT a way to keep a foreign or dead owner looking
 * alive: it asserts ownership with the same `assertOwner` every other mutation
 * uses, so a caller without the transaction's delegation token is refused.
 */
export function heartbeatEvidenceTransaction({ repo = REPO_ROOT, transactionId, delegationToken, commonDir = null }) {
  const paths = evidenceTransactionPaths(repo, commonDir);
  const current = readState(paths);
  assertOwner(current, transactionId, delegationToken);
  const at = now();
  const lifecycle = Object.freeze({
    ...current.lifecycle,
    heartbeat: Object.freeze({ sequence: (current.lifecycle.heartbeat?.sequence ?? 0) + 1, at }),
  });
  atomicJson(paths.state, Object.freeze({ ...current, lifecycle, heartbeat_at: at }));
  return Object.freeze({ transaction_id: transactionId, heartbeat_at: at, sequence: lifecycle.heartbeat.sequence });
}

export function assertEvidenceProducerAuthority(repo = REPO_ROOT, environment = process.env, commonDir = null) {
  const paths = evidenceTransactionPaths(repo, commonDir);
  if (!existsSync(paths.lock)) {
    // A direct writer is allowed to be the transaction owner, but it may not
    // race another direct writer through a check-then-write gap; the atomic
    // `mkdirSync` below is what actually decides that, not this check.
    const directLease = acquireEvidenceTransaction({ repo, commonDir });
    // A direct owner must beat its own lease. Without this, every producer
    // `evidence:rebind` spawns — and it spawns each one separately, so this
    // branch, not `runEvidenceRefreshTransaction`'s composite path, is what
    // every `evidence:rebind` run actually takes — reports "LIVE but
    // heartbeat is STALE (no confirmed progress)" the moment it runs longer
    // than EVIDENCE_HEARTBEAT_STALE_MS. Observed ages of 383s, 450s and 497s on
    // perfectly healthy owners, which leaves `evidence:status` unable to
    // separate a slow producer from a wedged one and forces a manual
    // `ps -p` to decide whether recovery is safe.
    //
    // `unref` so the timer can never hold the process open past its work.
    const beat = setInterval(() => {
      try { directLease.heartbeat(); } catch { /* the owner reports its own original failure */ }
    }, 10_000);
    beat.unref?.();

    // A producer whose own event loop is blocked cannot fire that timer at
    // all — `determinism-baseline` is a synchronous spawnSync loop, and
    // `vi-refresh` was observed printing progress with a 149s-stale heartbeat.
    // So beat from OUTSIDE as well: a detached sidecar that beats only while
    // this pid is alive and exits the moment it is not. Best effort by
    // construction — if it cannot start, the heartbeat merely goes stale as it
    // did before, which is the fail-safe direction.
    let sidecar = null;
    try {
      sidecar = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "evidence-heartbeat-sidecar.mjs")], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          REVOY_HEARTBEAT_REPO: repo,
          REVOY_HEARTBEAT_OWNER_PID: String(process.pid),
          REVOY_EVIDENCE_TRANSACTION_ID: directLease.transaction_id,
          REVOY_EVIDENCE_DELEGATION_TOKEN: directLease.delegation_token,
        },
      });
      sidecar.unref();
    } catch { /* a producer that cannot spawn a helper still does its own work */ }

    process.once("exit", () => {
      clearInterval(beat);
      try { sidecar?.kill(); } catch { /* it exits on its own when this pid disappears */ }
      try { directLease.release(); } catch { /* an abnormal exit is recovered explicitly */ }
    });
    return Object.freeze({
      delegated: false, direct_owner: true,
      transaction_id: directLease.transaction_id,
      transition: directLease.transition,
      heartbeat: directLease.heartbeat,
      // Handed out so a synchronous producer can spawn an out-of-process beat
      // (see heartbeatEvidenceTransaction). This is the same token already
      // passed to delegated child producers through `lease.environment`, so it
      // widens no authority that composition did not already grant.
      delegation_token: directLease.delegation_token,
    });
  }
  const state = readState(paths);
  assertOwner(state, environment.REVOY_EVIDENCE_TRANSACTION_ID, environment.REVOY_EVIDENCE_DELEGATION_TOKEN);
  if (environment.REVOY_EVIDENCE_EXPECTED_OID !== state.expected_candidate_oid) throw new EvidenceTransactionRefusal("candidate_identity_mismatch", "delegated producer candidate OID does not match its transaction lease", state);
  if (environment.REVOY_EVIDENCE_INPUT_DIGEST !== state.expected_input_digest) throw new EvidenceTransactionRefusal("input_identity_mismatch", "delegated producer input digest does not match its transaction lease", state);
  return Object.freeze({ delegated: true, transaction_id: state.transaction_id, expected_candidate_oid: state.expected_candidate_oid, expected_input_digest: state.expected_input_digest });
}
function receiptPath(paths, transactionId) { return join(paths.receipts, `${transactionId}.terminal.json`); }
/**
 * ADR-092 §1: a bounded, redacted terminal receipt is atomically retained
 * beside the lock directory after release so `evidence:status` can
 * distinguish "no active transaction" from "the immediately preceding
 * transaction timed out/cancelled." It is not a second lock and never
 * authorizes a writer. It MUST NOT contain raw argv, environment, tokens,
 * source patches, or child stdout/stderr — only the closed lifecycle
 * projection, exit code, and a typed failure code.
 */
function writeTerminalReceipt(lease, outcome, details = {}) {
  const state = readState(lease.paths);
  assertOwner(state, lease.transaction_id, lease.delegation_token);
  const receipt = Object.freeze({
    schema_version: TERMINAL_RECEIPT_SCHEMA_VERSION,
    kind: TERMINAL_RECEIPT_KIND,
    transaction_id: lease.transaction_id,
    outcome,
    recorded_at: now(),
    expected_candidate_oid: state.expected_candidate_oid,
    expected_input_digest: state.expected_input_digest,
    final_phase: state.phase,
    lifecycle: state.lifecycle,
    publication: details.publication ?? null,
    exit_code: Number.isInteger(details.exit_code) ? details.exit_code : null,
    failure_code: typeof details.failure_code === "string" ? details.failure_code : null,
  });
  mkdirSync(lease.paths.receipts, { recursive: true, mode: 0o700 });
  atomicJson(receiptPath(lease.paths, lease.transaction_id), receipt);
  return receipt;
}
function readTerminalReceipt(paths, state) {
  const path = receiptPath(paths, state.transaction_id);
  if (!existsSync(path)) return null;
  try {
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    if (receipt?.schema_version !== TERMINAL_RECEIPT_SCHEMA_VERSION || receipt.kind !== TERMINAL_RECEIPT_KIND || receipt.transaction_id !== state.transaction_id || receipt.expected_candidate_oid !== state.expected_candidate_oid || receipt.expected_input_digest !== state.expected_input_digest || !TERMINAL_OUTCOMES.includes(receipt.outcome)) return null;
    return Object.freeze(receipt);
  } catch { return null; }
}
/**
 * Archive a dead residue. A terminal-success receipt (or a v1 residue, which
 * predates receipts entirely) is mechanically safe to archive. Any other
 * outcome — failed, timed out, cancelled, or no receipt at all because the
 * owner died before it could write one — requires an explicit, named human
 * review (`--reviewed --reason "…"`) so a dead-but-unexplained transaction
 * can never be mistaken for lock theft or an automatic stale-lock collector.
 */
export function recoverEvidenceTransaction({ repo = REPO_ROOT, transactionId, reviewed = false, review_reason = null, commonDir = null } = {}) {
  if (!transactionId) throw new EvidenceTransactionRefusal("missing_transaction_id", "recovery requires the exact transaction ID from the lock state");
  const paths = evidenceTransactionPaths(repo, commonDir);
  if (!existsSync(paths.lock)) throw new EvidenceTransactionRefusal("lock_absent", "there is no evidence transaction lock to recover");
  const state = readState(paths);
  if (state.transaction_id !== transactionId) throw new EvidenceTransactionRefusal("transaction_mismatch", `lock belongs to ${state.transaction_id}, not requested ${transactionId}`);
  const liveness = ownerLiveness(state.owner);
  if (liveness === "live") throw new EvidenceTransactionRefusal("live_owner", `transaction ${transactionId} is still live; recovery would be lease theft and is refused`, state);
  if (liveness === "ambiguous") throw new EvidenceTransactionRefusal("ambiguous_owner", `transaction ${transactionId} cannot be proven dead; recovery is refused rather than guessing`, state);
  const receipt = state.legacy_schema_v1 ? null : readTerminalReceipt(paths, state);
  const reviewedNonterminal = !state.legacy_schema_v1 && receipt?.outcome !== "succeeded";
  if (reviewedNonterminal && (reviewed !== true || typeof review_reason !== "string" || review_reason.trim().length < 8)) {
    throw new EvidenceTransactionRefusal("recovery_review_required", `transaction ${transactionId} is dead but lacks a terminal-success receipt; it requires \`--reviewed --reason "<specific reason>"\` after explicit review and is not mechanically archived.`, state);
  }
  const archive = join(paths.directory, `recovered-${transactionId}-${Date.now()}-${randomUUID()}`);
  try { renameSync(paths.lock, archive); } catch (error) { throw new EvidenceTransactionRefusal("recovery_race", `could not atomically archive lock for recovery: ${error instanceof Error ? error.message : String(error)}`, state); }
  atomicJson(join(archive, "recovery.json"), {
    recovered_at: now(), recovered_by_pid: process.pid, source_state: state, terminal_receipt: receipt,
    reason: state.legacy_schema_v1 ? "legacy_v1_owner_process_proven_dead" : reviewedNonterminal ? "owner_process_proven_dead_reviewed_nonterminal" : "owner_process_proven_dead_terminal_success",
    review: reviewedNonterminal ? Object.freeze({ reviewed: true, reason: review_reason.trim() }) : null,
  });
  return Object.freeze({ ok: true, transaction_id: transactionId, archive, reviewed: reviewedNonterminal });
}
function redactedChild(child) {
  if (!child || typeof child !== "object") return null;
  const { status, at, command_id, pid, process_start_identity, process_group_id, started_at, deadline_at, deadline_ms, cancel_requested_at, exit_code, signal, mode } = child;
  return Object.freeze({
    status: status ?? null, at: at ?? null, command_id: command_id ?? null,
    pid: pid ?? null, process_start_identity: process_start_identity ?? null, process_group_id: process_group_id ?? null,
    started_at: started_at ?? null, deadline_at: deadline_at ?? null, deadline_ms: deadline_ms ?? null,
    cancel_requested_at: cancel_requested_at ?? null, exit_code: Number.isInteger(exit_code) ? exit_code : null,
    signal: signal ?? null, mode: mode ?? null,
  });
}
function progressLiveness({ heartbeatAt, terminal, clock }) {
  if (terminal) return "terminal";
  if (!heartbeatAt) return "not_started";
  const parsed = Date.parse(heartbeatAt);
  if (!Number.isFinite(parsed)) return "unknown_clock";
  const observedAt = typeof clock === "function" ? clock() : Date.now();
  const age = Math.max(0, observedAt - parsed);
  return age > EVIDENCE_HEARTBEAT_STALE_MS ? "stale" : "fresh";
}
/**
 * `bun run evidence:status` — the missing status verb (2026-08-24). Reproduced
 * live: a pre-commit claim refresh died mid-transaction holding the lease;
 * every later commit failed with `not_lock_owner` until an operator dug the
 * transaction id out of `.git/arbor/evidence-refresh/lock/state.json` by hand
 * to run `evidence:recover`. This never mutates the lock — it only reads and
 * classifies it, and when the holder is dead it prints the recovery command
 * with the id already filled in, so nobody has to go spelunking in git's
 * common dir again.
 *
 * ADR-092 §2: owner liveness (process-identity based: live/dead/ambiguous)
 * and progress liveness (heartbeat-based: fresh/stale/not_started/terminal/
 * unknown_clock) are deliberately two independent dimensions. A live owner
 * with a stale heartbeat is reported honestly — never as dead, and never
 * with a recovery command, which is offered only when `liveness === "dead"`.
 * `clock` is an optional injected `() => number` for deterministic tests.
 */
export function evidenceTransactionStatus({ repo = REPO_ROOT, commonDir = null, clock = null } = {}) {
  const paths = evidenceTransactionPaths(repo, commonDir);
  if (!existsSync(paths.lock)) {
    return Object.freeze({ ok: true, held: false, message: "no evidence transaction held" });
  }
  let state;
  try {
    state = readState(paths);
  } catch (error) {
    if (error instanceof EvidenceTransactionRefusal && error.code === "unsupported_schema_version") {
      // ADR-101 rule 1 + 2: a newer/older writer's healthy lock, reported as
      // a distinct waitable state — never as "malformed." Still names the
      // holder and heartbeat age (ownerLiveness can run against the
      // validated envelope even though this schema version is otherwise
      // opaque to this reader).
      const unsupportedState = error.state;
      const liveness = ownerLiveness(unsupportedState.owner);
      return Object.freeze({
        ok: true,
        held: true,
        transaction_id: unsupportedState.transaction_id,
        owner: unsupportedState.owner,
        schema_version: unsupportedState.schema_version,
        schema_supported: false,
        projection: "unsupported",
        liveness: "unsupported_schema_version",
        owner_liveness: liveness,
        progress_liveness: "unknown_clock",
        recovery_command: null,
        recommended_action: "wait",
        message: `${error.message} Process liveness: ${liveness}.`,
      });
    }
    return Object.freeze({
      ok: true,
      held: true,
      liveness: "ambiguous",
      owner_liveness: "ambiguous",
      progress_liveness: "unknown_clock",
      recommended_action: "inspect_ambiguous",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const legacy = state.legacy_schema_v1 === true;
  const liveness = ownerLiveness(state.owner);
  const phase = state.phase;
  const phaseEnteredAt = legacy ? null : (state.lifecycle.phase_timestamps?.[phase] ?? null);
  const heartbeatAt = legacy ? state.heartbeat_at : state.lifecycle.heartbeat.at;
  const heartbeatSequence = legacy ? null : state.lifecycle.heartbeat.sequence;
  const terminal = legacy ? null : state.lifecycle.terminal;
  const deadline = legacy ? null : state.lifecycle.deadline;
  const children = legacy ? null : Object.fromEntries(Object.entries(state.lifecycle.children ?? {}).map(([name, child]) => [name, redactedChild(child)]));
  const producer = children?.producer ?? null;
  const progress = progressLiveness({ heartbeatAt, terminal, clock });
  const receipt = legacy ? null : readTerminalReceipt(paths, state);
  const archive_eligible = liveness === "dead" && (legacy || receipt?.outcome === "succeeded");
  const recovery_command = archive_eligible ? `bun run evidence:recover -- --transaction ${state.transaction_id}` : null;
  const reviewed_recovery_command = liveness === "dead" && !archive_eligible ? `bun run evidence:recover -- --transaction ${state.transaction_id} --reviewed --reason "<reviewed failure reason>"` : null;
  const recommended_action = liveness === "dead" ? (archive_eligible ? "recover" : "recover_reviewed") : liveness === "ambiguous" ? "inspect_ambiguous" : progress === "stale" ? "wait_stale" : "wait";
  const heartbeat_age_ms = heartbeatAgeMs(state, clock);
  const phase_age_ms = phaseEnteredAt ? Math.max(0, (typeof clock === "function" ? clock() : Date.now()) - Date.parse(phaseEnteredAt)) : null;
  const summary = `evidence transaction ${state.transaction_id} is held by ${ownerSummary(state)} (phase: ${phase}, acquired_at: ${state.owner.acquired_at}, heartbeat ${formatAge(heartbeat_age_ms)} ago)`;
  const message = liveness === "live"
    ? (progress === "stale" ? `${summary} — LIVE but heartbeat is STALE (no confirmed progress); wait or inspect the owner. Recovery is never offered for a live owner.` : `${summary} — LIVE; wait for the owner to release it.`)
    : liveness === "dead"
      ? (archive_eligible ? `${summary} — DEAD with a terminal-success (or legacy) receipt. Recover with: \`${recovery_command}\`` : `${summary} — DEAD without a terminal-success receipt. Inspect it explicitly, then recover only with: \`${reviewed_recovery_command}\``)
      : `${summary} — liveness is AMBIGUOUS; do not remove or steal it automatically. Inspect the owning process by hand.`;
  return Object.freeze({
    ok: true,
    held: true,
    transaction_id: state.transaction_id,
    owner: state.owner,
    phase,
    schema_version: state.schema_version,
    schema_supported: true,
    projection: legacy ? "legacy_incomplete" : "v2",
    liveness,
    owner_liveness: liveness,
    progress_liveness: progress,
    heartbeat_at: heartbeatAt,
    heartbeat_age_ms,
    heartbeat_sequence: heartbeatSequence,
    phase_entered_at: phaseEnteredAt,
    phase_age_ms,
    source: Object.freeze({ candidate_oid: state.expected_candidate_oid, input_digest: state.expected_input_digest }),
    children,
    producer,
    deadline,
    terminal,
    terminal_receipt: receipt ? Object.freeze({ outcome: receipt.outcome, recorded_at: receipt.recorded_at, failure_code: receipt.failure_code ?? null }) : null,
    archive_eligible,
    recovery_command,
    reviewed_recovery_command,
    recommended_action,
    message,
  });
}
/**
 * A transaction owner may delegate narrowly-scoped read access to its
 * detached candidate setup or producer.  The ordinary status API intentionally
 * remains conservative: only this verifier turns a held lease into an
 * allowed read, and only after validating the lease's unforgeable delegation
 * token and candidate identity.
 */
export function evidenceTransactionReadStatus({ repo = REPO_ROOT, environment = process.env, commonDir = null } = {}) {
  const status = evidenceTransactionStatus({ repo, commonDir });
  if (!status.held) return status;
  const scope = environment.REVOY_EVIDENCE_READ_SCOPE;
  if (scope !== "candidate_setup" && scope !== "candidate_producer") return status;
  try {
    const paths = evidenceTransactionPaths(repo, commonDir);
    const state = readState(paths);
    assertOwner(state, environment.REVOY_EVIDENCE_TRANSACTION_ID, environment.REVOY_EVIDENCE_DELEGATION_TOKEN);
    if (environment.REVOY_EVIDENCE_EXPECTED_OID !== state.expected_candidate_oid) {
      throw new EvidenceTransactionRefusal("candidate_identity_mismatch", "delegated evidence reader candidate OID does not match its transaction lease", state);
    }
    if (environment.REVOY_EVIDENCE_INPUT_DIGEST !== state.expected_input_digest) {
      throw new EvidenceTransactionRefusal("input_identity_mismatch", "delegated evidence reader input digest does not match its transaction lease", state);
    }
    return Object.freeze({ ...status, delegated_read: true, read_scope: scope });
  } catch {
    // A forged, expired, or incomplete delegation has exactly the same safe
    // outcome as no delegation: the consumer remains blocked by the writer.
    return status;
  }
}
function gitResult(repo, args, options = {}) {
  // Content-addressed graphs and reports can produce a full-index binary patch
  // larger than spawnSync's 1 MiB default. Keep the whole patch or refuse;
  // never derive publication from a truncated diff.
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, ...options });
}
function evidencePath(path) {
  const normalized = path.replaceAll("\\", "/");
  return EVIDENCE_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
function statusRecords(repo) {
  const status = gitResult(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.status !== 0) throw new EvidenceTransactionRefusal("source_status_failed", (status.stderr || status.stdout).trim());
  const records = status.stdout.split("\0");
  const output = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4) throw new EvidenceTransactionRefusal("source_status_malformed", "git returned a malformed NUL-delimited status record");
    const code = record.slice(0, 2);
    output.push({ code, path: record.slice(3) });
    if (code.includes("R") || code.includes("C")) output.push({ code, path: records[++index] ?? "" });
  }
  return output;
}
function sourceDiff(repo) {
  const excluded = EVIDENCE_PATH_PREFIXES.map((prefix) => `:(exclude)${prefix}**`);
  const result = gitResult(repo, ["diff", "--binary", "--full-index", "HEAD", "--", ".", ...excluded]);
  if (result.status !== 0) throw new EvidenceTransactionRefusal("source_diff_failed", (result.stderr || result.stdout).trim());
  return result.stdout;
}
function filteredTreeDigest(repo, tree) {
  const listing = gitResult(repo, ["ls-tree", "-r", "--full-tree", tree]);
  if (listing.status !== 0) throw new EvidenceTransactionRefusal("source_tree_failed", (listing.stderr || listing.stdout).trim());
  const sourceListing = listing.stdout.split("\n").filter((line) => {
    const separator = line.indexOf("\t");
    return separator >= 0 && !evidencePath(line.slice(separator + 1));
  }).join("\n");
  return digest(`revoy2-evidence-source-tree-v1\0${sourceListing}\0`);
}
/**
 * Freeze exactly the non-evidence source tree. A source overlay is allowed only
 * when it consists of tracked bytes; pre-existing evidence or untracked source
 * bytes would make publication ambiguous and are refused rather than guessed.
 */
export function resolveEvidenceSourceIdentity(repo = REPO_ROOT, { allowEvidenceChanges = false } = {}) {
  const base = resolveCandidateIdentity(repo);
  const untracked = [];
  for (const record of statusRecords(repo)) {
    if (evidencePath(record.path)) {
      if (!allowEvidenceChanges) throw new EvidenceTransactionRefusal("preexisting_evidence_changes", `atomic evidence refresh refuses pre-existing evidence change ${record.path}; commit or discard it before starting a transaction`);
      continue;
    }
    if (record.code === "??") untracked.push(record.path);
  }
  // Gate design rule (scripts/README.md): name every cause and the remedies in
  // one message. Refusing on the first untracked path sent an agent around
  // this loop once per file on 2026-08-23.
  if (untracked.length > 0) {
    throw new EvidenceTransactionRefusal("untracked_source_input_refused", `atomic evidence refresh requires an explicit tracked source candidate; ${untracked.length} untracked source path(s) refused: ${untracked.join(", ")} — commit them, add them to .gitignore, or move them out of the tree`);
  }
  const patch = sourceDiff(repo);
  const indexDir = mkdtempSync(join(tmpdir(), "revoy2-evidence-source-index-"));
  const index = join(indexDir, "index");
  const environment = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const readTree = gitResult(repo, ["read-tree", "HEAD"], { env: environment });
    if (readTree.status !== 0) throw new EvidenceTransactionRefusal("source_index_failed", (readTree.stderr || readTree.stdout).trim());
    if (patch.length > 0) {
      const applied = gitResult(repo, ["apply", "--cached", "--whitespace=error"], { env: environment, input: patch });
      if (applied.status !== 0) throw new EvidenceTransactionRefusal("source_snapshot_failed", `could not stage immutable source overlay: ${(applied.stderr || applied.stdout).trim()}`);
    }
    const written = gitResult(repo, ["write-tree"], { env: environment });
    if (written.status !== 0) throw new EvidenceTransactionRefusal("source_tree_failed", (written.stderr || written.stdout).trim());
    const source_tree_oid = written.stdout.trim();
    return Object.freeze({ candidate_oid: base.candidate_oid, input_digest: filteredTreeDigest(repo, source_tree_oid), source_tree_oid, source_patch: patch });
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}
export function assertEvidenceSourceIdentity(repo, identity, { allowEvidenceChanges = false } = {}) {
  const expectedCandidate = identity.candidate_oid ?? identity.expected_candidate_oid;
  const expectedDigest = identity.input_digest ?? identity.expected_input_digest;
  const current = resolveEvidenceSourceIdentity(repo, { allowEvidenceChanges });
  if (current.candidate_oid !== expectedCandidate || current.input_digest !== expectedDigest) {
    throw new EvidenceTransactionRefusal("candidate_identity_mismatch", "evidence transaction source input changed after its candidate identity was acquired");
  }
  return current;
}
const SNAPSHOT_BINDING_PATH = ".visual-intelligence/transaction-snapshot.json";
function snapshotBindingPath(repo) { return join(repo, SNAPSHOT_BINDING_PATH); }
function writeSnapshotBinding(staging, lease) {
  const manifest = join(staging, ".visual-intelligence", "manifest.json");
  if (!existsSync(manifest)) return null;
  const source = assertEvidenceSourceIdentity(staging, lease.state, { allowEvidenceChanges: true });
  const binding = Object.freeze({
    schema_version: 1,
    kind: "revoy2.evidence_transaction_snapshot",
    transaction_id: lease.transaction_id,
    candidate_oid: lease.state.expected_candidate_oid,
    input_digest: lease.state.expected_input_digest,
    source_tree_digest: source.input_digest,
    created_at: now(),
  });
  atomicJson(snapshotBindingPath(staging), binding);
  return binding;
}
/** Normal freshness gates accept a dirty graph only when this committed binding proves the same source tree. */
export function validateEvidenceSnapshotBinding(repo = REPO_ROOT) {
  const path = snapshotBindingPath(repo);
  if (!existsSync(path)) return Object.freeze({ ok: false, code: "snapshot_binding_absent" });
  let binding;
  try { binding = JSON.parse(readFileSync(path, "utf8")); }
  catch { return Object.freeze({ ok: false, code: "snapshot_binding_malformed" }); }
  if (!binding || binding.schema_version !== 1 || binding.kind !== "revoy2.evidence_transaction_snapshot" || typeof binding.candidate_oid !== "string" || typeof binding.input_digest !== "string" || typeof binding.source_tree_digest !== "string") {
    return Object.freeze({ ok: false, code: "snapshot_binding_schema_invalid" });
  }
  let source;
  try { source = resolveEvidenceSourceIdentity(repo, { allowEvidenceChanges: true }); }
  catch (error) { return Object.freeze({ ok: false, code: error?.code ?? "snapshot_binding_source_unverifiable" }); }
  if (source.input_digest !== binding.input_digest || source.input_digest !== binding.source_tree_digest) return Object.freeze({ ok: false, code: "snapshot_binding_input_mismatch", binding });
  const reachable = gitResult(repo, ["merge-base", "--is-ancestor", binding.candidate_oid, "HEAD"]);
  if (reachable.status !== 0) return Object.freeze({ ok: false, code: "snapshot_binding_candidate_not_ancestor", binding });
  return Object.freeze({ ok: true, binding: Object.freeze(binding) });
}
function createStagingWorktree(repo, identity, sourcePatch = "") {
  const candidateOid = identity.candidate_oid ?? identity.expected_candidate_oid;
  const path = mkdtempSync(join(tmpdir(), "revoy2-evidence-transaction-"));
  rmSync(path, { recursive: true, force: true });
  const added = gitResult(repo, ["worktree", "add", "--detach", path, candidateOid]);
  if (added.status !== 0) throw new EvidenceTransactionRefusal("staging_snapshot_failed", `could not create evidence staging snapshot: ${(added.stderr || added.stdout).trim()}`);
  const stagedIdentity = resolveCandidateIdentity(path);
  if (stagedIdentity.candidate_oid !== candidateOid) {
    gitResult(repo, ["worktree", "remove", "--force", path]);
    throw new EvidenceTransactionRefusal("staging_identity_mismatch", "evidence staging snapshot did not bind the acquired candidate identity");
  }
  if (sourcePatch.length > 0) {
    const applied = gitResult(path, ["apply", "--whitespace=error"], { input: sourcePatch });
    if (applied.status !== 0) {
      gitResult(repo, ["worktree", "remove", "--force", path]);
      throw new EvidenceTransactionRefusal("staging_source_overlay_failed", `could not apply the acquired source overlay: ${(applied.stderr || applied.stdout).trim()}`);
    }
  }
  return path;
}
function assertCanonicalEvidencePath(root, path, { allowMissing = false } = {}) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || isAbsolute(path)) throw new EvidenceTransactionRefusal("evidence_path_invalid", "evidence staging received an unsafe absolute or empty path");
  const normalized = path.replaceAll("\\", "/");
  if (!EVIDENCE_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix)) || normalized.split("/").includes("..")) throw new EvidenceTransactionRefusal("evidence_scope_violation", `evidence staging refuses non-canonical path ${path}`);
  const rootReal = realpathSync(root);
  const target = resolve(root, normalized);
  if (target !== rootReal && !target.startsWith(`${rootReal}${sep}`)) throw new EvidenceTransactionRefusal("evidence_path_escape", `evidence path escapes its staging root: ${path}`);
  let cursor = rootReal;
  for (const component of relative(rootReal, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) { if (allowMissing) break; continue; }
    if (lstatSync(cursor).isSymbolicLink()) throw new EvidenceTransactionRefusal("evidence_symlink_refused", `evidence staging refuses symlinked path ${path}`);
  }
  return normalized;
}
function porcelainPaths(repo) {
  const status = gitResult(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.status !== 0) throw new EvidenceTransactionRefusal("staging_status_failed", (status.stderr || status.stdout).trim());
  const records = status.stdout.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4) throw new EvidenceTransactionRefusal("staging_status_malformed", "git returned a malformed NUL-delimited status record");
    const code = record.slice(0, 2);
    paths.push(record.slice(3));
    if (code.includes("R") || code.includes("C")) paths.push(records[++index] ?? "");
  }
  return paths;
}
/** Stage only canonical evidence paths, including genuinely new untracked evidence. */
export function stageEvidencePatch(staging, identity = null) {
  if (identity !== null) assertEvidenceSourceIdentity(staging, identity, { allowEvidenceChanges: true });
  const changedPaths = porcelainPaths(staging);
  const evidencePaths = identity === null ? changedPaths : changedPaths.filter(evidencePath);
  for (const path of identity === null ? changedPaths : evidencePaths) assertCanonicalEvidencePath(staging, path, { allowMissing: true });
  if (evidencePaths.length === 0) return "";
  const added = gitResult(staging, ["add", "--all", "--force", "--", ...evidencePaths]);
  if (added.status !== 0) throw new EvidenceTransactionRefusal("evidence_stage_failed", (added.stderr || added.stdout).trim());
  const names = gitResult(staging, ["diff", "--cached", "--name-only", "-z", "HEAD"]);
  if (names.status !== 0) throw new EvidenceTransactionRefusal("staging_diff_failed", (names.stderr || names.stdout).trim());
  for (const path of names.stdout.split("\0").filter(Boolean)) assertCanonicalEvidencePath(staging, path, { allowMissing: true });
  const patch = gitResult(staging, ["diff", "--cached", "--binary", "--full-index", "HEAD"]);
  if (patch.status !== 0) throw new EvidenceTransactionRefusal("staging_diff_failed", (patch.stderr || patch.stdout).trim());
  return patch.stdout;
}
/** Check then publish one index-aware patch; reverse any race-partial application before refusal. */
function rollbackPublishedEvidencePatch(repo, patch) {
  const rollback = gitResult(repo, ["apply", "-R", "--index", "--whitespace=error"], { input: patch });
  if (rollback.status !== 0) throw new EvidenceTransactionRefusal("atomic_publish_rollback_failed", "evidence apply failed and rollback was refused; inspect the target immediately");
}
export function publishEvidencePatch({ repo, patch, identity, afterApply = null }) {
  assertEvidenceSourceIdentity(repo, identity);
  if (patch.length === 0) return Object.freeze({ published: false, patch_digest: digest(patch) });
  const checked = gitResult(repo, ["apply", "--check", "--index", "--whitespace=error"], { input: patch });
  if (checked.status !== 0) throw new EvidenceTransactionRefusal("atomic_publish_rejected", `evidence patch failed preflight: ${(checked.stderr || checked.stdout).trim()}`);
  assertEvidenceSourceIdentity(repo, identity);
  const applied = gitResult(repo, ["apply", "--index", "--whitespace=error"], { input: patch });
  if (applied.status === 0) {
    try {
      afterApply?.();
      assertEvidenceSourceIdentity(repo, identity, { allowEvidenceChanges: true });
    } catch (error) {
      rollbackPublishedEvidencePatch(repo, patch);
      if (error instanceof EvidenceTransactionRefusal) throw new EvidenceTransactionRefusal("post_apply_identity_mismatch", "evidence patch was applied but the source identity changed before publication completed; the exact patch was rolled back", error.state);
      throw new EvidenceTransactionRefusal("post_apply_identity_mismatch", "evidence patch was applied but post-apply validation failed; the exact patch was rolled back");
    }
    return Object.freeze({ published: true, patch_digest: digest(patch) });
  }
  rollbackPublishedEvidencePatch(repo, patch);
  throw new EvidenceTransactionRefusal("atomic_publish_failed", "evidence patch was rejected and rolled back without publication");
}
function removeStagingWorktree(repo, path) {
  rmSync(join(path, "node_modules"), { recursive: true, force: true });
  const removed = gitResult(repo, ["worktree", "remove", "--force", path]);
  if (removed.status !== 0) rmSync(path, { recursive: true, force: true });
}
function terminateChildProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    // A detached child leads its own process group on POSIX, so terminating
    // -pid reaches grandchildren too rather than leaving a compiler running
    // orphaned after its supervising owner gives up on it.
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { try { child.kill(signal); } catch { /* child has already exited */ } }
}
/**
 * Run one child in its own process group, honoring an owner-declared
 * deadline and an optional owner-originated abort signal, and reporting its
 * live identity through `onSpawn` the instant it starts (ADR-092 §1/§3: the
 * producer object must be observable while `state: "running"`, not only
 * after it exits). Deadline expiry and owner abort both terminate the whole
 * group (SIGTERM, then SIGKILL after a bounded grace) and are reported as
 * distinct outcomes, never conflated with an ordinary nonzero exit.
 */
function runOwnedChild({ command, args, cwd, env, deadlineMs, abortSignal, onSpawn }) {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolveResult({ ok: false, outcome: "failed", exit_code: null, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    onSpawn?.(child);
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    let outcome = null;
    const escalate = () => {
      terminateChildProcessGroup(child, "SIGTERM");
      setTimeout(() => terminateChildProcessGroup(child, "SIGKILL"), KILL_GRACE_MS).unref?.();
    };
    const deadlineTimer = deadlineMs > 0 ? setTimeout(() => { outcome = "timed_out"; escalate(); }, deadlineMs) : null;
    const onAbort = () => { outcome = "cancelled"; escalate(); };
    if (abortSignal) { if (abortSignal.aborted) onAbort(); else abortSignal.addEventListener("abort", onAbort, { once: true }); }
    const settle = (code, error) => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      if (error) { resolveResult({ ok: false, outcome: outcome ?? "failed", exit_code: null, output: `${output}${error.message ?? error}` }); return; }
      resolveResult({ ok: outcome === null && code === 0, outcome: outcome ?? (code === 0 ? "succeeded" : "failed"), exit_code: code, output });
    };
    child.once("error", (error) => settle(null, error));
    child.once("close", (code) => settle(code, null));
  });
}
/**
 * Run detached candidate setup without blocking the supervisor event loop
 * (ADR-092 §2). `lease` and `abortSignal` are optional: without a `lease`
 * this stays a plain synchronous fallback for any caller that is not the
 * durable lease owner and cannot heartbeat (kept for source and behavioral
 * compatibility with callers outside this ADR's file ownership — see
 * `scripts/tests/enforcement-control-plane.test.mjs`, which still calls this
 * synchronously). Every production caller inside this file passes `lease`.
 */
export function runEvidenceStagingSetup({
  cwd, environment, lease = null, abortSignal = null,
  setupCommand = Object.freeze({ command: "bun", args: ["install", "--frozen-lockfile"] }),
  buildCommand = Object.freeze({ command: "bun", args: ["run", "build"] }),
  setupDeadlineMs = SETUP_DEADLINE_MS,
  buildDeadlineMs = BUILD_DEADLINE_MS,
} = {}) {
  if (lease === null) {
    const installed = spawnSync(setupCommand.command, setupCommand.args, { cwd, env: { ...process.env, ...environment }, encoding: "utf8", timeout: setupDeadlineMs });
    if (installed.status !== 0) throw new EvidenceTransactionRefusal("staging_setup_failed", (installed.stderr || installed.stdout || "bun install failed").trim());
    const built = spawnSync(buildCommand.command, buildCommand.args, { cwd, env: { ...process.env, ...environment }, encoding: "utf8", timeout: buildDeadlineMs });
    if (built.status !== 0) throw new EvidenceTransactionRefusal("staging_setup_failed", (built.stderr || built.stdout || "candidate build failed").trim());
    return;
  }
  const runStage = async (name, phase, command, args, deadlineMs) => {
    lease.transition(phase);
    const deadlineAt = new Date(Date.now() + deadlineMs).toISOString();
    lease.deadline("armed", deadlineAt);
    const result = await runOwnedChild({
      command, args, cwd, env: { ...process.env, ...environment }, deadlineMs, abortSignal,
      onSpawn: (child) => lease.child(name, "running", { command_id: name, pid: child.pid ?? null, process_start_identity: child.pid ? processStartIdentity(child.pid) : null, process_group_id: process.platform !== "win32" ? (child.pid ?? null) : null, started_at: now(), deadline_at: deadlineAt, deadline_ms: deadlineMs, mode: "child_process" }),
    });
    lease.deadline("unarmed", null);
    lease.child(name, result.outcome === "succeeded" ? "succeeded" : result.outcome, { exit_code: result.exit_code, mode: "child_process" });
    if (!result.ok) {
      const code = result.outcome === "timed_out" ? "staging_setup_timed_out" : result.outcome === "cancelled" ? "staging_setup_cancelled" : "staging_setup_failed";
      throw new EvidenceTransactionRefusal(code, (result.output || `${command} ${args.join(" ")} failed`).trim());
    }
  };
  return (async () => {
    await runStage("setup", "dependency_install", setupCommand.command, setupCommand.args, setupDeadlineMs);
    // VI observation and process-level evidence commands consume compiled
    // package entry points. Build only inside the detached candidate so no
    // producer can accidentally read the live checkout's dist output.
    await runStage("build", "candidate_build", buildCommand.command, buildCommand.args, buildDeadlineMs);
  })();
}
export async function runEvidenceRefreshTransaction({ repo = REPO_ROOT, scope = "all", wait_ms = 0, producer = null, producerDeadlineMs = PRODUCER_DEFAULT_DEADLINE_MS, abortSignal = null, stagingSetup = {}, producerCommand = null } = {}) {
  const acquiredIdentity = resolveEvidenceSourceIdentity(repo);
  const lease = await acquireEvidenceTransactionWithWait({ repo, expectedCandidate: acquiredIdentity.candidate_oid, expectedInputDigest: acquiredIdentity.input_digest, wait_ms });
  const plan = createGovernanceProducerPlan({ name: "evidence-refresh" });
  let staging = null;
  const args = producerCommand?.args ?? ["packages/arbor-mcp/bin/arbor-mcp.mjs", "evidence", "refresh", "--scope", scope, "--json", "--delegated-evidence-transaction"];
  const producerBinary = producerCommand?.command ?? "bun";
  let heartbeat = null;
  let outcome = null; // set once a terminal outcome has been recorded, so cleanup never double-records one
  try {
    assertEvidenceSourceIdentity(repo, lease.state);
    staging = createStagingWorktree(repo, lease.state, acquiredIdentity.source_patch);
    assertEvidenceSourceIdentity(staging, lease.state);
    lease.transition("snapshot_prepared");
    // A synchronous setup/build path (spawnSync) would block this event
    // loop and starve the heartbeat below for the entire install/build —
    // exactly the "looks exactly like a stuck owner" failure ADR-092's
    // Context names. The async staging setup below yields between children.
    heartbeat = setInterval(() => { try { lease.heartbeat(); } catch { /* owner process will report its original failure */ } }, 10_000);
    const setupEnvironment = Object.freeze({ ...lease.environment, REVOY_EVIDENCE_READ_SCOPE: "candidate_setup" });
    const producerEnvironment = Object.freeze({ ...lease.environment, REVOY_EVIDENCE_READ_SCOPE: "candidate_producer" });
    let output = "";
    let code;
    let producerOutcome;
    plan.start("producer");
    if (producer !== null) {
      lease.transition("producer_running");
      lease.child("producer", "running", { command_id: "delegated_callback", mode: "delegated_callback", started_at: now(), deadline_at: new Date(Date.now() + producerDeadlineMs).toISOString(), deadline_ms: producerDeadlineMs });
      let timedOut = false;
      const timer = producerDeadlineMs > 0 ? setTimeout(() => { timedOut = true; }, producerDeadlineMs) : null;
      try {
        const result = await producer(Object.freeze({ cwd: staging, environment: producerEnvironment, transaction_id: lease.transaction_id }));
        output = result?.output ?? "";
        code = result?.exit_code ?? 0;
        producerOutcome = timedOut ? "timed_out" : code === 0 ? "succeeded" : "failed";
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      lease.child("producer", producerOutcome, { exit_code: code, mode: "delegated_callback" });
    } else {
      await runEvidenceStagingSetup({ cwd: staging, environment: setupEnvironment, lease, abortSignal, ...stagingSetup });
      lease.transition("producer_running");
      const deadlineAt = new Date(Date.now() + producerDeadlineMs).toISOString();
      lease.deadline("armed", deadlineAt);
      const result = await runOwnedChild({
        command: producerBinary, args, cwd: staging, env: { ...process.env, ...producerEnvironment, REVOY_EVIDENCE_SNAPSHOT_MODE: "immutable_source_overlay_v1" }, deadlineMs: producerDeadlineMs, abortSignal,
        onSpawn: (child) => lease.child("producer", "running", { command_id: "arbor_evidence_refresh_delegated", pid: child.pid ?? null, process_start_identity: child.pid ? processStartIdentity(child.pid) : null, process_group_id: process.platform !== "win32" ? (child.pid ?? null) : null, started_at: now(), deadline_at: deadlineAt, deadline_ms: producerDeadlineMs, mode: "child_process" }),
      });
      lease.deadline("unarmed", null);
      output = result.output;
      code = result.exit_code ?? (result.ok ? 0 : 1);
      producerOutcome = result.outcome;
      lease.child("producer", producerOutcome === "succeeded" ? "succeeded" : producerOutcome, { exit_code: code, mode: "child_process" });
    }
    if (producerOutcome === "timed_out" || producerOutcome === "cancelled") {
      plan.fail("producer");
      outcome = producerOutcome;
      lease.terminal(outcome, outcome === "timed_out" ? "producer_deadline_exceeded" : "owner_abort_signal");
      writeTerminalReceipt(lease, outcome, { exit_code: Number.isInteger(code) ? code : null, failure_code: outcome === "timed_out" ? "producer_deadline_exceeded" : "owner_abort_signal" });
      return Object.freeze({ ok: false, exit_code: code, transaction_id: lease.transaction_id, output, published: false, phase_events: plan.events(), outcome });
    }
    if (code !== 0) {
      plan.fail("producer");
      outcome = "failed";
      lease.terminal("failed", "producer_nonzero_exit");
      writeTerminalReceipt(lease, "failed", { exit_code: code, failure_code: "producer_nonzero_exit" });
      return Object.freeze({ ok: false, exit_code: code, transaction_id: lease.transaction_id, output, published: false, phase_events: plan.events(), outcome });
    }
    plan.succeed("producer");
    plan.start("normalization");
    lease.transition("normalizing_evidence");
    writeSnapshotBinding(staging, lease);
    const patch = stageEvidencePatch(staging, lease.state);
    plan.succeed("normalization");
    plan.start("commit");
    lease.transition("atomic_publish");
    const publication = publishEvidencePatch({ repo, patch, identity: lease.state });
    plan.succeed("commit");
    outcome = "succeeded";
    lease.terminal("succeeded", null);
    writeTerminalReceipt(lease, "succeeded", { exit_code: 0, publication });
    return Object.freeze({ ok: true, exit_code: 0, transaction_id: lease.transaction_id, output, ...publication, phase_events: plan.events(), outcome });
  } catch (error) {
    if (outcome === null) {
      const code = error instanceof EvidenceTransactionRefusal ? error.code : "transaction_failed";
      try {
        lease.terminal("failed", code);
        writeTerminalReceipt(lease, "failed", { failure_code: code });
      } catch { /* best-effort; the original error below remains authoritative */ }
    }
    throw error;
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    if (staging !== null) removeStagingWorktree(repo, staging);
    lease.release();
  }
}
function value(flag) { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : null; }
if (import.meta.main) {
  const repo = value("--repo") ?? process.cwd();
  const json = process.argv.includes("--json");
  try {
    if (process.argv.includes("--status")) {
      const result = evidenceTransactionStatus({ repo });
      process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.message}\n`);
      process.exitCode = 0;
    } else if (process.argv.includes("--recover")) {
      const result = recoverEvidenceTransaction({ repo, transactionId: value("--transaction"), reviewed: process.argv.includes("--reviewed"), review_reason: value("--reason") });
      console.log(JSON.stringify(result, null, 2));
    } else {
      const wait_ms = Number.parseInt(value("--wait-ms") ?? "0", 10);
      // An operator SIGINT/SIGTERM is the owner-originated abort signal ADR-092
      // §3 requires: it terminates the currently-owned child's process group
      // and records a `cancelled` terminal outcome rather than leaving an
      // orphaned compiler/producer and a lock with no explanation.
      const controller = new AbortController();
      const onSignal = () => controller.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      let result;
      try {
        result = await runEvidenceRefreshTransaction({ repo, scope: value("--scope") ?? "all", wait_ms: Number.isSafeInteger(wait_ms) && wait_ms >= 0 ? wait_ms : 0, abortSignal: controller.signal });
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`${result.output}\n`);
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error?.code ?? "evidence_transaction_error", error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}
