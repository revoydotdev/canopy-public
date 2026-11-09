import type { Provenance, HighRiskCommandIntent } from "@arbor/core";
import type { ConfinementGrade, NativeToolActionScopeEvidence, NativeToolEffect, NativeToolExecutionOutcome, NativeToolExecutionStage, NativeToolPort, NativeToolRequest, NativeToolRisk } from "@arbor/harness";
import type { SandboxBroker } from "../sandbox/contracts.js";
import type { SandboxConfinementLevel } from "../sandbox/sandbox-broker.js";
import { NATIVE_TOOL_RISK_MANIFEST } from "../native-capability-manifest.js";

export type { HighRiskCommandIntent } from "@arbor/core";

/** A trusted, provenance-bearing reason for a tool invocation. */
export interface NativeToolIntent {
  readonly purpose: string;
  readonly provenance: Provenance;
}

/**
 * System-owned, action-specific authority for high-risk repository tools.
 * Paths and argv vectors are exact, canonical-relative declarations—not
 * globs, snippets, or model-generated context references.  The scope is
 * session-bound so a valid action for one worktree turn cannot be replayed
 * in another session.
 */
export interface NativeHighRiskToolScope {
  readonly scope_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly session_id: string;
  readonly worktree_root: string;
  readonly provenance: Provenance;
  /**
   * Who stands behind this scope. "authored": a planner/operator declaration
   * on a governed campaign — a boundary the host refuses beyond. "mined": a
   * scope derived from task text (the heuristic arbiter's blast radius on a
   * direct/reviewed campaign, or the manager's own text mining) — guidance,
   * bound in the audit tier. Stamped at composition from the campaign's
   * governance tier, the same structural rule the verifier's
   * `scopeIsAuthored` applies; absent means the generator alone decides.
   */
  readonly authority?: "authored" | "mined";
  readonly write_paths: readonly string[];
  /**
   * Always literal, exact argv entries — never an ADR-119 intent entry.
   * `narrowScopeToSkill` (native-agent-executor.ts) spreads every entry as
   * an array; keeping this field array-only, and carrying intents
   * separately in `command_intents`, is what keeps that spread safe.
   */
  readonly command_argv: readonly (readonly string[])[];
  /**
   * ADR-119: unbound, not-yet-resolved command intents this session may
   * still bind on first use. `bind_id` is this intent's stable position
   * within the node's own declared `command_argv` (an already-bound intent
   * is promoted into `command_argv` above and dropped from here — see
   * `CampaignManager.bindNativeHighRiskScope`).
   */
  readonly command_intents?: readonly { readonly bind_id: number; readonly intent: HighRiskCommandIntent }[];
  /**
   * ADR-119 O3: durably record an intent bind the moment it happens, before
   * the call it authorizes returns a result. Absent means this session's
   * composition never wired a durable sink for scope binds — in that case
   * `native-tool-host.ts` must refuse to bind rather than authorize a call
   * with no durable trace of it. Returns false (never binds) on any
   * refusal — e.g. a governed-tier session, or a slot already bound.
   */
  readonly bind_intent?: (input: { readonly bind_id: number; readonly argv: readonly string[] }) => boolean;
}

/**
 * How many write paths / command argv entries an authority description
 * names explicitly before it truncates (ADR-118). A scope with hundreds of
 * entries must not produce an unbounded refusal or advance-note string.
 */
/**
 * The provenance generator `CampaignManager.deriveNativeHighRiskToolScope`
 * stamps on a scope it MINED from task text (direct/reviewed tier, planner
 * left the action unscoped). A mined scope names what the task text
 * mentions; it is not an authored authorization boundary, and the pilot of
 * 2026-09-03 showed why the distinction matters: presented as a boundary,
 * the specialist refused to create the test file the task asked for, and the
 * host would have refused the write anyway.
 */
export const MINED_ACTION_SCOPE_GENERATOR = "campaign-manager/mined-action-scope-v1";

export function isMinedHighRiskScope(scope: NativeHighRiskToolScope | null): boolean {
  if (scope === null) return false;
  if (scope.authority !== undefined) return scope.authority === "mined";
  return scope.provenance.tag === "generated" && scope.provenance.generator === MINED_ACTION_SCOPE_GENERATOR;
}

export const AUTHORITY_DESCRIPTION_ITEM_LIMIT = 20;

/**
 * Describes the write-path authority a scope holds, in the shared phrasing
 * both `highRiskScopeFailure`'s refusal reason (native-tool-host.ts) and
 * `coherenceScopeNote`'s advance note (native-agent-executor.ts) build from,
 * so the two moments describe the same authority identically instead of two
 * independently-maintained strings that can drift (ADR-118 Decision §3).
 * Deterministically bounded by `AUTHORITY_DESCRIPTION_ITEM_LIMIT`.
 */
export function describeAuthorizedWritePaths(writePaths: readonly string[]): string {
  if (writePaths.length === 0) return "no write paths are authorized for this task";
  const shown = writePaths.slice(0, AUTHORITY_DESCRIPTION_ITEM_LIMIT);
  const remainder = writePaths.length - shown.length;
  return `authorized write paths: ${shown.join(", ")}${remainder > 0 ? ` (+${remainder} more, not listed)` : ""}`;
}

/**
 * Describes the command authority a scope holds. Same sharing rationale and
 * bounding as `describeAuthorizedWritePaths`.
 */
export function describeAuthorizedCommands(commandArgv: readonly (readonly string[])[]): string {
  if (commandArgv.length === 0) return "no commands are authorized for this task";
  const shown = commandArgv.slice(0, AUTHORITY_DESCRIPTION_ITEM_LIMIT);
  const remainder = commandArgv.length - shown.length;
  return `authorized commands: ${shown.map((argv) => argv.join(" ")).join("; ")}${remainder > 0 ? ` (+${remainder} more, not listed)` : ""}`;
}

/**
 * S02: why `resolve_high_risk_scope` returned `null` for this call, so a
 * refusal can say which without changing its `code` (the harness's
 * `RECOVERABLE_PREFLIGHT_CODES` allowlist stays untouched):
 * - `tier_forbids_declared_scope`: the action DID declare a high-risk scope
 *   (e.g. an intent-style command entry), but the campaign's governance
 *   tier does not permit that declaration shape. Authority was withheld by
 *   tier policy, not by omission.
 * - `declared_scope_invalid`: the action declared a scope, but it is
 *   structurally malformed regardless of tier (bad path, empty argv, ...).
 * - `no_declared_scope`: the action declared nothing, and (outside
 *   `governed` tier) nothing could be mined from its own text either.
 */
export type NativeHighRiskScopeDenialReason = "tier_forbids_declared_scope" | "declared_scope_invalid" | "no_declared_scope";

/** The boundary at which a tool stopped.  It is deliberately not inferred from a blank result. */
export type NativeToolOutcomeStage = NativeToolExecutionStage;
export type NativeToolOutcome = NativeToolExecutionOutcome;
export type NativeToolEffectEvidence = NativeToolEffect;

/**
 * Redacted operational evidence.  The callback is for a durable audit sink;
 * it never receives tool input, file content, command output, or credentials.
 */
export interface NativeToolAuditRecord {
  readonly session_id: string;
  readonly call_id: string;
  readonly tool: string;
  readonly risk: NativeToolRisk;
  readonly intent: Readonly<{ purpose: string; provenance_tag: Provenance["tag"] }> | null;
  /** Content-free binding evidence; raw paths, argv, and scope ids never leave the host. */
  readonly action_scope: NativeToolActionScopeEvidence;
  readonly outcome: NativeToolOutcome;
  readonly stage: NativeToolOutcomeStage;
  readonly code: string;
  readonly effect: NativeToolEffectEvidence;
  readonly confinement: ConfinementGrade;
  readonly summary: string;
}

export type NativeToolFilesystemPolicy = "read_only" | "workspace_write" | "isolated";

/**
 * System-owned, immutable restriction for a documentation-only worker.  This
 * is an object (rather than a caller-supplied list of globs) so the execution
 * boundary has one auditable policy identity to recognize.  It admits only
 * Markdown documentation below `docs/` and `.arbor/`, plus the two root
 * repository documents declared by the role catalog.  It never authorizes a
 * path based on model input.
 */
export const NATIVE_DOCUMENTATION_WRITE_PATH_POLICY = Object.freeze({
  kind: "documentation_only" as const,
  path_classes: Object.freeze(["docs_markdown", "arbor_markdown", "root_readme", "root_changelog"] as const),
});

/** The only non-default write-path restriction supported by this host. */
export type NativeWritePathPolicy = typeof NATIVE_DOCUMENTATION_WRITE_PATH_POLICY;

/**
 * Identity, not structural equality, is intentional: composition must use
 * the system-owned frozen policy above, not a model/configuration lookalike.
 */
export function enforcesDocumentationWritePaths(policy: NativeWritePathPolicy | undefined): boolean {
  return policy === NATIVE_DOCUMENTATION_WRITE_PATH_POLICY;
}

export interface NativeRepositoryToolDescriptor {
  readonly tool: string;
  readonly risk: NativeToolRisk;
  readonly port: NativeToolPort;
}

export interface NativeRepositoryToolHostOptions {
  /** Bound by composition to the immutable session policy; write tools require workspace_write. */
  readonly filesystem: NativeToolFilesystemPolicy;
  /**
   * Optional system-owned restriction for `file.write`/`file.patch`.  Omit it
   * for normal worktree execution; documentation roles receive the immutable
   * policy object at the native executor composition root.
   */
  readonly write_path_policy?: NativeWritePathPolicy;
  /** Each call's roots are re-canonicalized.  When set, they must exactly match this admission set. */
  readonly workspace_roots?: readonly string[];
  /** The trusted caller supplies intent by session/call identity; the model cannot mint provenance. */
  readonly resolve_intent: (request: NativeToolRequest) => NativeToolIntent | null;
  /**
   * Required for every high-risk invocation. Composition derives this from
   * the durable action and admitted worktree policy; task prose/model refs
   * are deliberately insufficient.
   */
  readonly resolve_high_risk_scope?: (request: NativeToolRequest) => NativeHighRiskToolScope | null;
  /**
   * S02: when `resolve_high_risk_scope` returns `null`, this optionally
   * names WHY -- tier denial vs. no declared/mineable authority -- so
   * `highRiskScopeFailure`'s refusal message can say so truthfully instead
   * of always claiming nothing was declared. Absent or returning `null`
   * keeps today's generic message; never widens what is authorized.
   */
  readonly resolve_high_risk_scope_denial_reason?: (request: NativeToolRequest) => NativeHighRiskScopeDenialReason | null;
  /** A redacted, append-only audit boundary. */
  readonly on_audit?: (record: NativeToolAuditRecord) => void;
  /** Generic executable names/absolute paths that may be invoked without a shell. Empty is fail-closed. */
  readonly allowed_commands?: readonly string[];
  readonly max_read_bytes?: number;
  readonly max_output_bytes?: number;
  readonly max_command_output_bytes?: number;
  readonly max_command_timeout_ms?: number;
  readonly sandbox_broker?: SandboxBroker;
  /**
   * Confinement policy for the default `createSandboxBroker()` used when
   * `sandbox_broker` is not injected (LR-NH-04). Composition should source
   * this from `ArborConfig.sandbox.confinement`; omitted uses the
   * recommended `os_best_effort` default. Ignored when `sandbox_broker` is
   * supplied directly — an injected broker carries its own already-resolved
   * confinement.
   */
  readonly sandbox_confinement_level?: SandboxConfinementLevel;
}

export const NATIVE_REPOSITORY_TOOL_RISKS = NATIVE_TOOL_RISK_MANIFEST.repository satisfies Record<string, NativeToolRisk>;
