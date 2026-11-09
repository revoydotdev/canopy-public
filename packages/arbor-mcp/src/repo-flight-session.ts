import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { redactNativeText } from "@arbor/harness";
import { repoFlightRepositoryId } from "./repo-flight-contracts.js";

const REPO_FLIGHT_SESSION_SCHEMA_VERSION = 1 as const;
export const REPO_FLIGHT_MAX_INTENTS = 128;
export const REPO_FLIGHT_MAX_CHILD_PIDS = 256;

export type RepoFlightProvider = "claude" | "codex" | "opencode" | "native";
export type RepoFlightSessionState = "live" | "draining" | "quiesced" | "disconnected" | "dead_confirmed" | "ambiguous";
export type RepoFlightControlChannelState = "connected" | "disconnected" | "unknown";
export type RepoFlightWriteOperation = "create" | "modify" | "delete" | "git_index" | "git_ref" | "git_stash" | "worktree_admin" | "dependency_lockfile" | "evidence_publish";
export type RepoFlightGateMode = "snapshot" | "quiescent";

export interface RepoFlightRepositoryIdentity {
  readonly repository_id: string;
  readonly repository_root: string;
  readonly git_common_dir: string;
  readonly worktree_root: string;
  readonly branch: string | null;
  readonly base_oid: string;
  readonly head_oid: string;
}

export interface RepoFlightWriteIntent { readonly operation: RepoFlightWriteOperation; readonly path: string; readonly purpose: string }
export interface RepoFlightGateIntent { readonly gate_id: string; readonly mode: RepoFlightGateMode; readonly purpose: string }
export interface RepoFlightProcessGroup { readonly pgid: number | null; readonly child_pids: readonly number[] }
export interface RepoFlightDelegation { readonly parent_instance_id: string | null; readonly delegation_id: string | null }

export interface RepoFlightSessionManifest {
  readonly schema_version: typeof REPO_FLIGHT_SESSION_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly repository: RepoFlightRepositoryIdentity;
  readonly provider: RepoFlightProvider;
  readonly provider_session_id: string;
  readonly revoy_session_id: string;
  readonly repo_run_id: string;
  readonly pid: number;
  readonly process_start_token: string;
  readonly host_boot_id: string;
  readonly campaign_id: string | null;
  readonly node_id: string | null;
  readonly task_id: string;
  readonly delegation: RepoFlightDelegation;
  readonly adapter_version: string;
  readonly write_intents: readonly RepoFlightWriteIntent[];
  readonly gate_intents: readonly RepoFlightGateIntent[];
  readonly process_group: RepoFlightProcessGroup;
}

export interface RepoFlightSessionRecord {
  readonly manifest: RepoFlightSessionManifest;
  readonly state: RepoFlightSessionState;
  readonly fenced: boolean;
  readonly enrolled_at: string;
  readonly heartbeat_at: string;
  readonly control_channel: RepoFlightControlChannelState;
  readonly revision: number;
  readonly disposition_reason: string | null;
}

export interface RepoFlightProcessObservation {
  readonly observed_at: string;
  readonly pid_exists: boolean | null;
  readonly process_start_token: string | null;
  readonly host_boot_id: string | null;
  readonly control_channel: RepoFlightControlChannelState;
}

export interface RepoFlightSessionProjection {
  readonly instance_id: string;
  readonly repository_id: string;
  readonly worktree_root: string;
  readonly provider: RepoFlightProvider;
  readonly provider_session_ref: string;
  readonly revoy_session_id: string;
  readonly repo_run_id: string;
  readonly pid: number;
  readonly process_identity_ref: string;
  readonly campaign_id: string | null;
  readonly node_id: string | null;
  readonly task_id: string;
  readonly state: RepoFlightSessionState;
  readonly fenced: boolean;
  readonly heartbeat_at: string;
  readonly control_channel: RepoFlightControlChannelState;
  readonly write_intents: readonly RepoFlightWriteIntent[];
  readonly gate_intents: readonly RepoFlightGateIntent[];
  readonly disposition_reason: string | null;
}

export type RepoFlightSessionManifestInput = Omit<RepoFlightSessionManifest, "schema_version" | "instance_id" | "provider" | "repository" | "write_intents" | "gate_intents" | "process_group" | "delegation"> & {
  readonly provider: string;
  readonly repository: Omit<RepoFlightRepositoryIdentity, "repository_id">;
  readonly write_intents?: readonly RepoFlightWriteIntent[];
  readonly gate_intents?: readonly RepoFlightGateIntent[];
  readonly process_group?: Partial<RepoFlightProcessGroup>;
  readonly delegation?: Partial<RepoFlightDelegation>;
};

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INSTANCE_ID = /^agent:v1:[a-f0-9]{64}$/;
const STATES: readonly RepoFlightSessionState[] = ["live", "draining", "quiesced", "disconnected", "dead_confirmed", "ambiguous"];
const CHANNELS: readonly RepoFlightControlChannelState[] = ["connected", "disconnected", "unknown"];
const WRITE_OPERATIONS: readonly RepoFlightWriteOperation[] = ["create", "modify", "delete", "git_index", "git_ref", "git_stash", "worktree_admin", "dependency_lockfile", "evidence_publish"];
const GATE_MODES: readonly RepoFlightGateMode[] = ["snapshot", "quiescent"];

export function normalizeRepoFlightProvider(value: string): RepoFlightProvider {
  const normalized = value.trim().toLowerCase().replace(/[ _]/g, "-");
  if (["claude", "claude-code", "anthropic-claude"].includes(normalized)) return "claude";
  if (["codex", "codex-cli", "openai-codex"].includes(normalized)) return "codex";
  if (["opencode", "open-code"].includes(normalized)) return "opencode";
  if (["native", "revoy", "revoy-native"].includes(normalized)) return "native";
  throw new Error("provider is not admitted by the closed provider vocabulary");
}

export function createRepoFlightSessionManifest(input: RepoFlightSessionManifestInput): RepoFlightSessionManifest {
  return buildRepoFlightSessionManifest(input, true);
}

function buildRepoFlightSessionManifest(input: RepoFlightSessionManifestInput, requireExistingPaths: boolean): RepoFlightSessionManifest {
  const repositoryRoot = canonicalPath(input.repository.repository_root, "repository_root", requireExistingPaths);
  const commonGitDir = canonicalPath(input.repository.git_common_dir, "git_common_dir", requireExistingPaths);
  const worktree = canonicalPath(input.repository.worktree_root, "worktree_root", requireExistingPaths);
  const repositoryId = repoFlightRepositoryId(commonGitDir);
  const provider = normalizeRepoFlightProvider(input.provider);
  const branch = input.repository.branch === null ? null : boundedAtom(input.repository.branch, "branch", 256);
  const repository = Object.freeze({ repository_id: repositoryId, repository_root: repositoryRoot, git_common_dir: commonGitDir, worktree_root: worktree, branch, base_oid: oid(input.repository.base_oid, "base_oid"), head_oid: oid(input.repository.head_oid, "head_oid") });
  const providerSessionId = boundedAtom(input.provider_session_id, "provider_session_id", 256);
  const revoySessionId = boundedAtom(input.revoy_session_id, "revoy_session_id", 256);
  const repoRunId = boundedAtom(input.repo_run_id, "repo_run_id", 256);
  const processStartToken = boundedAtom(input.process_start_token, "process_start_token", 256);
  const hostBootId = boundedAtom(input.host_boot_id, "host_boot_id", 256);
  const pid = positiveInteger(input.pid, "pid");
  const identityMaterial = { repository_id: repositoryId, worktree, provider, provider_session_id: providerSessionId, revoy_session_id: revoySessionId, repo_run_id: repoRunId, pid, process_start_token: processStartToken, host_boot_id: hostBootId };
  const instanceId = `agent:v1:${sha256(canonicalJson(identityMaterial))}`;
  const writeIntents = normalizeWriteIntents(input.write_intents ?? []);
  const gateIntents = normalizeGateIntents(input.gate_intents ?? []);
  const childPids = [...new Set(input.process_group?.child_pids ?? [])].map((value) => positiveInteger(value, "child pid")).sort((a, b) => a - b);
  if (childPids.length > REPO_FLIGHT_MAX_CHILD_PIDS) throw new Error("child process group exceeds its bound");
  const pgid = input.process_group?.pgid == null ? null : positiveInteger(input.process_group.pgid, "pgid");
  const manifest: RepoFlightSessionManifest = {
    schema_version: 1,
    instance_id: instanceId,
    repository,
    provider,
    provider_session_id: providerSessionId,
    revoy_session_id: revoySessionId,
    repo_run_id: repoRunId,
    pid,
    process_start_token: processStartToken,
    host_boot_id: hostBootId,
    campaign_id: nullableAtom(input.campaign_id, "campaign_id"),
    node_id: nullableAtom(input.node_id, "node_id"),
    task_id: boundedAtom(input.task_id, "task_id", 256),
    delegation: Object.freeze({ parent_instance_id: nullableInstanceId(input.delegation?.parent_instance_id ?? null), delegation_id: nullableAtom(input.delegation?.delegation_id ?? null, "delegation_id") }),
    adapter_version: boundedAtom(input.adapter_version, "adapter_version", 128),
    write_intents: writeIntents,
    gate_intents: gateIntents,
    process_group: Object.freeze({ pgid, child_pids: Object.freeze(childPids) }),
  };
  return Object.freeze(manifest);
}

export function validateRepoFlightSessionManifest(value: unknown): RepoFlightSessionManifest {
  const record = exactRecord(value, ["schema_version", "instance_id", "repository", "provider", "provider_session_id", "revoy_session_id", "repo_run_id", "pid", "process_start_token", "host_boot_id", "campaign_id", "node_id", "task_id", "delegation", "adapter_version", "write_intents", "gate_intents", "process_group"], "session manifest");
  if (record.schema_version !== 1 || typeof record.instance_id !== "string" || !INSTANCE_ID.test(record.instance_id)) throw new Error("session manifest schema or instance identity is malformed");
  const repositoryRaw = exactRecord(record.repository, ["repository_id", "repository_root", "git_common_dir", "worktree_root", "branch", "base_oid", "head_oid"], "repository identity");
  const delegationRaw = exactRecord(record.delegation, ["parent_instance_id", "delegation_id"], "delegation");
  const processGroupRaw = exactRecord(record.process_group, ["pgid", "child_pids"], "process group");
  // Restore cannot require a worktree to still exist: a dead process may have
  // lost its worktree, and that durable identity is precisely what recovery
  // needs to retain. Enrollment itself always resolves existing real paths.
  const rebuilt = buildRepoFlightSessionManifest({
    repository: { repository_root: requiredString(repositoryRaw.repository_root), git_common_dir: requiredString(repositoryRaw.git_common_dir), worktree_root: requiredString(repositoryRaw.worktree_root), branch: nullableString(repositoryRaw.branch), base_oid: requiredString(repositoryRaw.base_oid), head_oid: requiredString(repositoryRaw.head_oid) },
    provider: requiredString(record.provider), provider_session_id: requiredString(record.provider_session_id), revoy_session_id: requiredString(record.revoy_session_id), repo_run_id: requiredString(record.repo_run_id), pid: requiredNumber(record.pid), process_start_token: requiredString(record.process_start_token), host_boot_id: requiredString(record.host_boot_id), campaign_id: nullableString(record.campaign_id), node_id: nullableString(record.node_id), task_id: requiredString(record.task_id), adapter_version: requiredString(record.adapter_version),
    delegation: { parent_instance_id: nullableString(delegationRaw.parent_instance_id), delegation_id: nullableString(delegationRaw.delegation_id) },
    process_group: { pgid: processGroupRaw.pgid === null ? null : requiredNumber(processGroupRaw.pgid), child_pids: numberArray(processGroupRaw.child_pids) },
    write_intents: writeIntentArray(record.write_intents), gate_intents: gateIntentArray(record.gate_intents),
  }, false);
  if (rebuilt.instance_id !== record.instance_id || rebuilt.repository.repository_id !== repositoryRaw.repository_id || canonicalJson(rebuilt) !== canonicalJson(value)) throw new Error("session manifest is non-canonical or its identity binding does not verify");
  return rebuilt;
}

export function reconcileRepoFlightSession(record: RepoFlightSessionRecord, observation: RepoFlightProcessObservation): RepoFlightSessionRecord {
  const observedAt = isoInstant(observation.observed_at, "observed_at");
  if (!CHANNELS.includes(observation.control_channel)) throw new Error("control channel state is not admitted");
  if (Date.parse(observedAt) < Date.parse(record.heartbeat_at)) return record;
  const expected = record.manifest;
  let state: RepoFlightSessionState;
  let fenced = record.fenced;
  let reason: string | null = null;
  if (record.state === "dead_confirmed") return record;
  if (record.state === "ambiguous" || record.fenced) return Object.freeze({ ...record, control_channel: observation.control_channel, heartbeat_at: laterInstant(record.heartbeat_at, observedAt) });
  if (observation.host_boot_id !== null && observation.host_boot_id !== expected.host_boot_id) {
    state = "ambiguous"; fenced = true; reason = "host boot identity changed; prior PID identity cannot be trusted";
  } else if (observation.pid_exists === true && observation.process_start_token !== expected.process_start_token) {
    state = "ambiguous"; fenced = true; reason = "PID exists with a different process-start token";
  } else if (observation.pid_exists === false) {
    if (observation.host_boot_id === expected.host_boot_id) { state = "dead_confirmed"; fenced = true; reason = "identity-bound process probe confirmed the PID is absent"; }
    else { state = "ambiguous"; fenced = true; reason = "PID absence was not bound to the enrolled host boot identity"; }
  } else if (observation.pid_exists === true && observation.process_start_token === expected.process_start_token && observation.host_boot_id === expected.host_boot_id) {
    state = record.state === "draining" || record.state === "quiesced" ? record.state : observation.control_channel === "connected" ? "live" : "disconnected";
    reason = state === "disconnected" ? "process identity is live but its control channel is unavailable" : null;
  } else {
    state = observation.control_channel === "connected" ? record.state : "disconnected";
    reason = "process liveness is not identity-bound; heartbeat or channel state cannot prove death";
  }
  return Object.freeze({ ...record, state, fenced, control_channel: observation.control_channel, revision: record.revision + 1, disposition_reason: reason, heartbeat_at: laterInstant(record.heartbeat_at, observedAt) });
}

export function transitionRepoFlightSession(record: RepoFlightSessionRecord, requested: "draining" | "quiesced"): RepoFlightSessionRecord {
  if (record.fenced || record.state === "dead_confirmed" || record.state === "ambiguous") throw new Error("a fenced or terminal session cannot transition");
  if (requested === "quiesced" && record.state !== "draining") throw new Error("quiescence requires a prior draining transition");
  if (requested === "draining" && !["live", "disconnected", "draining"].includes(record.state)) throw new Error("session cannot enter draining from its current state");
  return Object.freeze({ ...record, state: requested, revision: record.revision + 1, disposition_reason: null });
}

export function projectRepoFlightSession(record: RepoFlightSessionRecord): RepoFlightSessionProjection {
  const safeIntent = (purpose: string): string => redactNativeText(purpose).slice(0, 512);
  return Object.freeze({
    instance_id: record.manifest.instance_id,
    repository_id: record.manifest.repository.repository_id,
    worktree_root: record.manifest.repository.worktree_root,
    provider: record.manifest.provider,
    provider_session_ref: `sha256:${sha256(record.manifest.provider_session_id)}`,
    revoy_session_id: record.manifest.revoy_session_id,
    repo_run_id: record.manifest.repo_run_id,
    pid: record.manifest.pid,
    process_identity_ref: `sha256:${sha256(`${record.manifest.host_boot_id}\0${record.manifest.process_start_token}`)}`,
    campaign_id: record.manifest.campaign_id,
    node_id: record.manifest.node_id,
    task_id: record.manifest.task_id,
    state: record.state,
    fenced: record.fenced,
    heartbeat_at: record.heartbeat_at,
    control_channel: record.control_channel,
    write_intents: Object.freeze(record.manifest.write_intents.map((intent) => Object.freeze({ ...intent, purpose: safeIntent(intent.purpose) }))),
    gate_intents: Object.freeze(record.manifest.gate_intents.map((intent) => Object.freeze({ ...intent, purpose: safeIntent(intent.purpose) }))),
    disposition_reason: record.disposition_reason === null ? null : safeIntent(record.disposition_reason),
  });
}

export function validateRepoFlightSessionRecord(value: unknown): RepoFlightSessionRecord {
  const raw = exactRecord(value, ["manifest", "state", "fenced", "enrolled_at", "heartbeat_at", "control_channel", "revision", "disposition_reason"], "session record");
  const manifest = validateRepoFlightSessionManifest(raw.manifest);
  if (typeof raw.state !== "string" || !STATES.includes(raw.state as RepoFlightSessionState) || typeof raw.fenced !== "boolean" || typeof raw.control_channel !== "string" || !CHANNELS.includes(raw.control_channel as RepoFlightControlChannelState) || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) throw new Error("session record lifecycle fields are malformed");
  if ((raw.state === "ambiguous" || raw.state === "dead_confirmed") && raw.fenced !== true) throw new Error("ambiguous and dead-confirmed sessions must be fenced");
  const enrolledAt = isoInstant(raw.enrolled_at, "enrolled_at"), heartbeatAt = isoInstant(raw.heartbeat_at, "heartbeat_at");
  if (Date.parse(heartbeatAt) < Date.parse(enrolledAt)) throw new Error("heartbeat predates enrollment");
  const disposition = raw.disposition_reason === null ? null : boundedText(raw.disposition_reason, "disposition_reason", 512);
  return Object.freeze({ manifest, state: raw.state as RepoFlightSessionState, fenced: raw.fenced, enrolled_at: enrolledAt, heartbeat_at: heartbeatAt, control_channel: raw.control_channel as RepoFlightControlChannelState, revision: raw.revision as number, disposition_reason: disposition });
}

function normalizeWriteIntents(values: readonly RepoFlightWriteIntent[]): readonly RepoFlightWriteIntent[] {
  if (!Array.isArray(values) || values.length > REPO_FLIGHT_MAX_INTENTS) throw new Error("write intents exceed their bound");
  return Object.freeze(values.map((value) => { const raw = exactRecord(value, ["operation", "path", "purpose"], "write intent"); if (typeof raw.operation !== "string" || !WRITE_OPERATIONS.includes(raw.operation as RepoFlightWriteOperation)) throw new Error("write operation is not admitted"); return Object.freeze({ operation: raw.operation as RepoFlightWriteOperation, path: boundedRelativePath(raw.path), purpose: redactedBoundedText(raw.purpose, "write intent purpose", 512) }); }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))));
}
function normalizeGateIntents(values: readonly RepoFlightGateIntent[]): readonly RepoFlightGateIntent[] {
  if (!Array.isArray(values) || values.length > REPO_FLIGHT_MAX_INTENTS) throw new Error("gate intents exceed their bound");
  return Object.freeze(values.map((value) => { const raw = exactRecord(value, ["gate_id", "mode", "purpose"], "gate intent"); if (typeof raw.mode !== "string" || !GATE_MODES.includes(raw.mode as RepoFlightGateMode)) throw new Error("gate mode is not admitted"); return Object.freeze({ gate_id: boundedAtom(raw.gate_id, "gate_id", 128), mode: raw.mode as RepoFlightGateMode, purpose: redactedBoundedText(raw.purpose, "gate intent purpose", 512) }); }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))));
}
function canonicalPath(value: unknown, name: string, requireExisting: boolean): string { const path = boundedText(value, name, 4096); if (!isAbsolute(path) || normalize(path) !== path) throw new Error(`${name} must be an absolute normalized path`); if (!requireExisting) return path; const canonical = realpathSync.native(path); if (canonical !== path) throw new Error(`${name} must already be canonical`); return canonical; }
function oid(value: unknown, name: string): string { const text = boundedText(value, name, 64); if (!SHA1.test(text) && !SHA256.test(text)) throw new Error(`${name} must be a lowercase Git object id`); return text; }
function boundedAtom(value: unknown, name: string, max = 256): string { const text = boundedText(value, name, max); if (/\s|[\u0000-\u001f\u007f]/u.test(text) || text.normalize("NFKC") !== text) throw new Error(`${name} must be a canonical non-whitespace atom`); return text; }
function nullableAtom(value: unknown, name: string): string | null { return value === null ? null : boundedAtom(value, name); }
function nullableInstanceId(value: unknown): string | null { if (value === null) return null; const text = boundedAtom(value, "parent_instance_id"); if (!INSTANCE_ID.test(text)) throw new Error("parent_instance_id is malformed"); return text; }
function boundedText(value: unknown, name: string, max: number): string { if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`${name} is missing, malformed, or oversized`); return value; }
function redactedBoundedText(value: unknown, name: string, max: number): string { return redactNativeText(boundedText(value, name, max)).slice(0, max); }
function boundedRelativePath(value: unknown): string { const path = boundedText(value, "intent path", 4096); if (isAbsolute(path) || path.split(/[\\/]/u).includes("..") || path.includes("\\")) throw new Error("intent path must be a normalized repository-relative POSIX path"); return path.replace(/^\.\//u, ""); }
function positiveInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive safe integer`); return value as number; }
function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`); const record = value as Record<string, unknown>, actual = Object.keys(record).sort(), expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${name} uses unknown or missing fields`); return record; }
function requiredString(value: unknown): string { if (typeof value !== "string") throw new Error("expected string"); return value; }
function nullableString(value: unknown): string | null { if (value === null) return null; return requiredString(value); }
function requiredNumber(value: unknown): number { if (typeof value !== "number") throw new Error("expected number"); return value; }
function numberArray(value: unknown): number[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) throw new Error("expected number array"); return value as number[]; }
function writeIntentArray(value: unknown): RepoFlightWriteIntent[] { if (!Array.isArray(value)) throw new Error("expected write intent array"); return value as RepoFlightWriteIntent[]; }
function gateIntentArray(value: unknown): RepoFlightGateIntent[] { if (!Array.isArray(value)) throw new Error("expected gate intent array"); return value as RepoFlightGateIntent[]; }
function isoInstant(value: unknown, name: string): string { const text = boundedText(value, name, 64), instant = Date.parse(text); if (!Number.isFinite(instant) || new Date(instant).toISOString() !== text) throw new Error(`${name} must be a canonical ISO instant`); return text; }
function laterInstant(a: string, b: string): string { return Date.parse(a) > Date.parse(b) ? a : b; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`; }
