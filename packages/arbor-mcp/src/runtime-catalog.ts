import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  validateRuntimeCommand,
  validateRuntimeQuery,
  type ApplicationCommand,
  type CommandAcknowledgement,
  type RuntimeCommandEnvelope,
  type RuntimeError,
  type RuntimeQueryEnvelope,
  type OperationRecord,
  DEFAULT_OUTPUT_POLICY,
  abbreviateOutput,
  cursorPage,
  cursorOffset,
  enforceAction,
  CapabilityError,
  ACTION_CLASSES,
  entitledActionClasses,
  isMutating,
  requiredCapability,
  type ActionClass,
  type CapabilityTier,
  rankByFrecency,
  deriveCandidateNodeCard,
  CAPABILITY_TIER,
} from "@arbor/core";
import type { NodeCommunication, RawOutputAuthorization } from "@arbor/audit";
import { verifyApprovedAuthority } from "./approval-service.js";
import { deliverUserInputAnswer } from "./user-input-delivery.js";
import { adoptCapturedResult, inspectCapturedResult, listCapturedResults, revertCapturedResult } from "./result-adoption.js";
import { FencedResultAdoptionService, fencedResultAdoptionFromEnvironment } from "./fenced-result-adoption.js";
import { isResultAdoptCommandEnvelope, isResultScopeAuthorizeCommandEnvelope, isResultRevertCommandEnvelope, isResultReviewMutationEnvelope, isResultReviewQueryEnvelope, parseResultAdoptFingerprint, parseResultRevertFingerprint, validateResultAdoptCommand, validateResultScopeAuthorizeCommand, validateResultRevertCommand, validateResultReviewMutation, validateResultReviewQuery, type ResultReviewMutationAcknowledgement } from "./result-review-contracts.js";
import { ResultReviewWorkspaceService } from "./result-review-workspace.js";
import { ArborRuntime, CAMPAIGN_RUN_JOB_KIND } from "./runtime.js";
import { isGitWorkspaceCommandEnvelope, isGitWorkspaceQueryEnvelope, type GitWorkspaceCommandEnvelope, type GitWorkspaceQueryEnvelope } from "./git-workspace-contracts.js";
import type { GitWorkspaceService } from "./git-workspace-projection.js";
import { declarativeSubagentIdentity } from "./declarative-subagent-executor.js";
import type { RecoveryRequest, RecoveryResult, RecoveryService } from "./recovery-service.js";
import {
  isCommunicationCommandEnvelope,
  isCommunicationQueryEnvelope,
  validateCommunicationCommand,
  validateCommunicationQuery,
  type CommunicationCommandEnvelope,
  type CommunicationProjection,
  type CommunicationQueryEnvelope,
} from "./communication-contracts.js";
import {
  isOutputCaptureEnvelope,
  isOutputListQueryEnvelope,
  isOutputQueryEnvelope,
  validateOutputListQuery,
  validateOutputCapture,
  validateOutputQuery,
  type OutputCaptureAcknowledgement,
  type OutputCaptureCommandEnvelope,
  type OutputDescriptorProjection,
  type OutputDescriptorQueryProjection,
  type OutputListProjection,
  type OutputListQueryEnvelope,
  type OutputQueryEnvelope,
} from "./output-contracts.js";
import {
  isSurveillanceQueryEnvelope, isSurveillanceScanEnvelope, validateSurveillanceQuery, validateSurveillanceScan,
  type SurveillanceFindingsProjection, type SurveillanceFindingsQueryEnvelope, type SurveillanceScanAcknowledgement,
  type SurveillanceScanCommandEnvelope,
} from "./surveillance-contracts.js";
import { isInterruptionCommandEnvelope, validateInterruptionCommand, type InterruptionCommandEnvelope } from "./interruption-contracts.js";
import { isConfigQueryEnvelope, validateConfigQuery, type ConfigQueryEnvelope, type ConfigInspectionProjection } from "./config-contracts.js";
import { isAgentQueryEnvelope, validateAgentQuery, type AgentQueryEnvelope, type AgentRegistryProjection } from "./agent-contracts.js";
import {
  buildGovernanceSnapshot, isGovernanceQueryEnvelope, validateGovernanceQuery, type GovernanceQueryEnvelope,
  buildGovernanceBacklog, isGovernanceBacklogQueryEnvelope, validateGovernanceBacklogQuery, type GovernanceBacklogQueryEnvelope,
} from "./governance-projection.js";
import {
  executeGovernanceRecordQuery, isGovernanceRecordQueryEnvelope, validateGovernanceRecordQuery,
  type GovernanceRecordQueryEnvelope,
} from "./governance-record-query.js";
import {
  buildProjectRegistryListProjection, isProjectRegistryListQueryEnvelope, validateProjectRegistryListQuery, type ProjectRegistryListQueryEnvelope,
  isProjectManageQueryEnvelope, validateProjectManageQuery, type ProjectManageQueryEnvelope,
} from "./project-registry-projection.js";
import { manageProjects } from "./project-manage.js";
import { defaultGateRemediation, GATE_REFUSAL_PROJECTION_MAX_TEXT, projectApprovalRefusal, projectGateRefusal } from "./gate-refusal-projection.js";
import { isKbListQueryEnvelope, validateKbListQuery, type KbListQueryEnvelope, type KbListProjection } from "./kb-list-contracts.js";
import { isAuditListQueryEnvelope, validateAuditListQuery, type AuditListQueryEnvelope, type AuditListProjection } from "./audit-list-contracts.js";
import { isOperationListQueryEnvelope, validateOperationListQuery, type OperationListQueryEnvelope, type OperationListProjection } from "./operation-list-contracts.js";
import { isRecoveryPendingQueryEnvelope, recoveryPendingFingerprint, validateRecoveryPendingQuery, type RecoveryPendingProjection, type RecoveryPendingQueryEnvelope } from "./recovery-list-contracts.js";
import {
  isJobCommandEnvelope, isJobListQueryEnvelope, validateJobCommand, validateJobListQuery,
  type JobCommandEnvelope, type JobListQueryEnvelope, type JobListProjection, type JobCommandAcknowledgement,
} from "./job-contracts.js";
import {
  isApprovalRequestEnvelope, isApprovalListQueryEnvelope, validateApprovalRequest, validateApprovalListQuery,
  type ApprovalRequestEnvelope, type ApprovalListQueryEnvelope, type ApprovalListProjection, type ApprovalRequestAcknowledgement,
} from "./approval-contracts.js";
import {
  isCompactionCommandEnvelope, isCompactionQueryEnvelope, validateCompactionCommand, validateCompactionQuery,
  type CompactionCommandEnvelope, type CompactionQueryEnvelope, type CompactionGuardProjection, type CompactionListProjection,
} from "./compaction-contracts.js";
import {
  isPhaseMessageQueryEnvelope, validatePhaseMessageQuery,
  type PhaseMessageQueryEnvelope, type PhaseMessageListProjection,
} from "./phase-message-contracts.js";
import {
  isGovernedContextCommandEnvelope, isGovernedContextQueryEnvelope, validateGovernedContextCommand, validateGovernedContextQuery,
  type GovernedContextCommandEnvelope, type GovernedContextQueryEnvelope,
} from "./governed-context-contracts.js";
import {
  isUserInputCommandEnvelope, isUserInputQueryEnvelope, validateUserInputCommand, validateUserInputQuery,
  type UserInputCommandEnvelope, type UserInputQueryEnvelope, type UserInputListProjection, type UserInputAwaitingProjection,
} from "./userinput-contracts.js";
import {
  isBusCommandEnvelope, isBusQueryEnvelope, validateBusCommand, validateBusQuery,
  type BusCommandEnvelope, type BusQueryEnvelope, type BusHistoryProjection,
} from "./bus-contracts.js";
import {
  isSiblingStatusQueryEnvelope, validateSiblingStatusQuery,
  type SiblingStatusQueryEnvelope, type SiblingStatusProjection,
} from "./sibling-contracts.js";
import { isSiblingSpawnEnvelope, validateSiblingSpawn, type SiblingSpawnEnvelope } from "./sibling-spawn-contracts.js";
import {
  isA2ASendCommandEnvelope, isA2AReceiveCommandEnvelope, validateA2ASendCommand, validateA2AReceiveCommand,
  type A2ASendCommandEnvelope, type A2AReceiveCommandEnvelope, type A2ASendAcknowledgement,
} from "./a2a-runtime-contracts.js";
import { inboundA2AToNodeCommunication, outboundNodeCommunicationToA2A, publishNodeCardAsA2A, verifyA2AAgentCard, type A2ABridgeConfig } from "./a2a-bridge.js";
import { validateA2ATask } from "./a2a-contracts.js";
import { messageToWire, messageFromWire, taskToWire, taskStateFromWire, wireStateIsLossy } from "./a2a-wire.js";
import { verifyLocalSessionProof } from "./local-session.js";
import { deriveDispatchForeground, DEFAULT_NODE_CARD_SECRET } from "@arbor/opencode";
import {
  isLiveProjectionQueryEnvelope, validateLiveProjectionQuery,
  type A2ACardsProjection, type ForegroundProjectionResult, type LiveProjectionQueryEnvelope, type NodeCardProjection,
} from "./live-projection-contracts.js";
import {
  isParentChildThreadAckEnvelope, isParentChildThreadHistoryEnvelope, isParentChildThreadSendEnvelope,
  validateParentChildThreadAck, validateParentChildThreadHistory, validateParentChildThreadSend,
  type ParentChildThreadAckEnvelope,
  type ParentChildThreadHistoryEnvelope, type ParentChildThreadHistoryProjection,
  type ParentChildThreadSendAcknowledgement, type ParentChildThreadSendEnvelope,
} from "./parent-child-thread-contracts.js";
import type { ParentChildThreadPushAdapter, ParentChildThreadPushEvent } from "./thread-push.js";
import {
  isCapabilityIntrospectionQueryEnvelope, validateCapabilityIntrospectionQuery,
  type CapabilityIntrospectionProjection,
} from "./capability-contracts.js";
import {
  isTrustSessionCommandEnvelope, isTrustSessionQueryEnvelope, validateTrustSessionCommand, validateTrustSessionQuery,
  type TrustSessionCommandEnvelope, type TrustSessionListProjection, type TrustSessionQueryEnvelope,
} from "./trust-session-contracts.js";
import { isHarnessSessionContinuationEnvelope, isHarnessSessionInterruptEnvelope, isHarnessSessionQueryEnvelope, isHarnessSessionSteerEnvelope, validateHarnessSessionContinuation, validateHarnessSessionInterrupt, validateHarnessSessionQuery, validateHarnessSessionSteer, type HarnessSessionContinuationEnvelope, type HarnessSessionInterruptEnvelope, type HarnessSessionQueryEnvelope, type HarnessSessionSteerEnvelope } from "./harness-session-contracts.js";
import { runRecoveryCommand } from "./recovery/recovery-command.js";
import { isNativeCampaignBudgetQueryEnvelope, validateNativeCampaignBudgetQuery, type NativeCampaignBudgetProjection, type NativeCampaignBudgetQueryEnvelope } from "./native-campaign-budget-contracts.js";
import { DEFAULT_DIRECT_NATIVE_CAMPAIGN_REQUIREMENTS } from "./harness-control-plane.js";
import { isHarnessConnectorInventoryQueryEnvelope, validateHarnessConnectorInventoryQuery, type HarnessConnectorInventoryProjection, type HarnessConnectorInventoryQueryEnvelope } from "./harness-connector-contracts.js";
import { isNativeHarnessReadinessQueryEnvelope, validateNativeHarnessReadinessQuery, type NativeHarnessReadinessQueryEnvelope } from "./native-harness-readiness-contracts.js";
import { applyMigration, previewMigration, rollbackMigration } from "./operator-maintenance.js";
import { isOperatorMaintenanceCommandEnvelope, isOperatorMaintenanceQueryEnvelope, validateOperatorMaintenanceCommand, validateOperatorMaintenanceQuery, type OperatorMaintenanceCommandEnvelope, type OperatorMaintenanceQueryEnvelope } from "./operator-maintenance-contracts.js";
import { isProductIntegrationCommandEnvelope, isProductIntegrationQueryEnvelope, validateProductIntegrationCommand, validateProductIntegrationQuery, type ProductIntegrationCommandEnvelope, type ProductIntegrationQueryEnvelope } from "./product-integration-contracts.js";
import { IntegrationControlReceiptJournal, type IntegrationControlSnapshot } from "./integrations/control-receipts.js";
import { productIntegrationLifecycleRefusal } from "./integrations/lifecycle-policy.js";
import { isProductUxCommandEnvelope, isProductUxQueryEnvelope, validateProductUxCommand, validateProductUxQuery, type ProductUxCommandEnvelope, type ProductUxQueryEnvelope } from "./product-ux-contracts.js";
import { isNativePeerCommandEnvelope, isNativePeerQueryEnvelope, validateNativePeerCommand, validateNativePeerQuery, type NativePeerCommandEnvelope, type NativePeerQueryEnvelope, type NativePeerTrustedCaller } from "./native-peer-channel-contracts.js";
import {
  validateTaskComposerCommand,
  validateTaskComposerQuery,
  type TaskComposerDraft,
} from "./task-composer-contracts.js";
import { isDistributedControlQueryEnvelope, validateDistributedControlQuery, type DistributedControlQueryEnvelope } from "./distributed-control-contracts.js";

/**
 * `output.descriptor`'s live variant (ADR-104 O4): returned in place of
 * `OutputDescriptorQueryProjection` when the queried `evidence_id` resolves
 * to a live native session instead of a persisted evidence record. Shaped
 * to match exactly what `packages/arbor-tui/src/screens/output.ts`'s
 * already-tested `projectDescriptor` reads (`evidence_id` at the top level,
 * `preview.content`/`preview.in_progress`) -- never `OutputArtifactRecord`,
 * which this has no sealed hash/byte-count/provenance to honestly fill in.
 */
export interface OutputLiveSessionDescriptorProjection {
  readonly evidence_id: string;
  readonly preview: { readonly content: string; readonly in_progress: true };
}

/**
 * `output.list`'s live variant (ADR-104 O4): one row per currently-running
 * native session, listed alongside (never inside) `OutputListEntry`'s real
 * `{status:"ok"|"corrupt", ...}` union -- a live session is not a sealed,
 * content-addressed record and must not be dressed up as one.
 */
export interface LiveSessionOutputListEntry {
  readonly status: "in_progress";
  readonly record: {
    readonly id: string;
    readonly operation_id: string;
    readonly campaign_id: string;
    readonly node_id: string;
    readonly stream: "model";
    readonly byte_count: number;
  };
}

/**
 * A live native session's `session_id` never matches `validateOutputQuery`'s
 * real content-hash `out_[a-f0-9]{64}` evidence-id format (session ids are
 * `${campaign_id}:${node_id}:${operation}:${uuid}`), and that regex stays a
 * real validation boundary rather than being loosened to admit arbitrary
 * strings. This derives an id in the same shape instead -- a genuine
 * SHA-256 of the session id, not a fabricated hash claiming sealed
 * evidence -- so `output.list`'s live rows and `output.descriptor`'s
 * lookup can round-trip through the exact same `evidence_id` field
 * `arbor-tui/src/update.ts`'s row-selection dispatch already sends, with no
 * change to that file or to the real evidence-id validation.
 */
function liveSessionEvidenceId(sessionId: string): string {
  return `out_${createHash("sha256").update(sessionId).digest("hex")}`;
}

export type { RuntimeCatalogKind, RuntimeCatalogEntry } from "@arbor/core";
import {
  RUNTIME_CATALOG_MANIFEST,
  DESTRUCTIVE_RUNTIME_KINDS as ADVISORY_DESTRUCTIVE_KINDS,
  OPEN_WORLD_RUNTIME_KINDS as ADVISORY_OPEN_WORLD_KINDS,
  type RuntimeCatalogKind,
  type RuntimeCatalogEntry,
} from "@arbor/core";

export const RUNTIME_CATALOG = RUNTIME_CATALOG_MANIFEST;
export { RUNTIME_CATALOG_MANIFEST };

/** Advisory effect classification for one catalog operation. This describes
 * the selected operation; the router remains the authority for dispatch. */
export interface RuntimeOperationHints {
  readonly read_only: boolean;
  readonly repeatable: boolean;
  readonly mutating: boolean;
  readonly destructive: boolean;
  readonly open_world: boolean;
}

const DESTRUCTIVE_RUNTIME_KINDS = new Set<RuntimeCatalogKind>(ADVISORY_DESTRUCTIVE_KINDS);
const OPEN_WORLD_RUNTIME_KINDS = new Set<RuntimeCatalogKind>(ADVISORY_OPEN_WORLD_KINDS);

export function runtimeOperationHints(entry: Pick<RuntimeCatalogEntry, "kind" | "direction">): RuntimeOperationHints {
  const readOnly = entry.direction === "query";
  return Object.freeze({
    read_only: readOnly,
    repeatable: readOnly,
    mutating: !readOnly,
    destructive: DESTRUCTIVE_RUNTIME_KINDS.has(entry.kind),
    open_world: OPEN_WORLD_RUNTIME_KINDS.has(entry.kind),
  });
}


export type RuntimeRouterResult<T> =
  | { ok: true; value: T; capability: string }
  | { ok: false; error: RuntimeError; capability: string | null };

export interface RuntimeRouterOptions {
  /** Omit to grant catalog capabilities; supply a set to enforce a transport policy. */
  granted_capabilities?: ReadonlySet<string>;
  /**
   * The caller's capability tier (ADR-028). `senior` may perform mutating
   * (`preview-confirm`) kinds; `junior` is restricted to reads.
   *
   * Defaults to `senior`, matching `granted_capabilities`'s existing
   * omit-to-grant convention: revoy2's own composition roots are trusted
   * in-process callers, and defaulting to `junior` would silently disable
   * every command on every current surface. A transport that accepts
   * instructions from a party it does not control should pass `junior`
   * explicitly — that is the case this gate exists for.
   */
  caller_tier?: CapabilityTier;
  /** Optional until a complete lease/campaign recovery port is composed. */
  recovery_service?: RecoveryService;
  /** Governs both readable sensitivity and the highest sensitivity this adapter may author. */
  communication_tier?: NodeCommunication["capability_tier"];
  /** Optional until a signing secret is provisioned; a2a.send/a2a.receive are unavailable without it. */
  a2a_bridge?: A2ABridgeConfig;
  /**
   * Require signed local-session proofs for every command and for raw-output
   * reads. Only the TUI composition sets this (security review 2026-10-06,
   * ADR-084 amendment of that date). A local-session proof is
   * self-certifying — it carries its own public key — so it authenticates
   * nothing; it binds `actor_id` to a key so actor text cannot be forged.
   * That is meaningful only where the in-process adapter is the router's sole
   * caller. Never set it on a router a transport peer reaches: the peer could
   * mint two keys and satisfy proposer != decider. Those surfaces carry
   * their authority elsewhere — OS process ownership (in-process CLI), caller
   * tier (stdio serve, ADR-084), the bootstrap cookie (loopback web), signed
   * remote proofs (`RemoteRuntimeIngress`, commands only) — and approvals stay
   * refused on all of them without an authenticated identity (D41).
   * `tests/router-session-boundaries.test.ts` pins each site.
   */
  require_local_session?: boolean;
  /**
   * Optional best-effort wake-up after a durable direct-thread append.  It is
   * deliberately not a transport authority: recipients replay history using
   * the supplied cursor, and delivery failure never changes command outcome.
   */
  thread_push?: ParentChildThreadPushAdapter;
  /** Authenticated peer identity supplied by the transport/session host. Never derive this from an envelope. */
  peer_caller?: NativePeerTrustedCaller;
  /** When configured, every real result adoption is globally fenced and crash-journaled. */
  fenced_result_adoption?: FencedResultAdoptionService;
  /** Optional governed Git/worktree projection and mutation seam. */
  git_workspace?: GitWorkspaceService;
}

/**
 * Identity established by a transport before it enters the approval boundary.
 *
 * This is deliberately an input to `dispatchAuthenticatedApproval`, rather
 * than an envelope field: an envelope is controlled by its sender and cannot
 * attest to the sender's identity.  Today `RemoteRuntimeIngress` is the only
 * non-local producer, after it verifies its signed remote-session proof.
 */
export interface AuthenticatedApprovalIdentity {
  readonly actor_id: string;
  readonly source: "remote_session";
}

/** A no-throw adapter from typed runtime contracts to canonical runtime services. */
export class RuntimeCatalogRouter {
  private readonly evaluationAbortControllers = new Map<string, AbortController>();
  private integrationControlJournal: IntegrationControlReceiptJournal | null = null;
  private readonly campaignRunStatusProjections = new Map<string, ReturnType<ArborRuntime["getCampaignRunStatusProjection"]>>();
  private readonly resultReviewWorkspace: ResultReviewWorkspaceService;
  private readonly fencedResultAdoption: FencedResultAdoptionService | null;
  constructor(private readonly runtime: ArborRuntime, private readonly options: RuntimeRouterOptions = {}) { this.resultReviewWorkspace = new ResultReviewWorkspaceService(runtime.persistenceRoot === null ? {} : { persistence_dir: runtime.persistenceRoot }); this.fencedResultAdoption = options.fenced_result_adoption ?? (runtime.persistenceRoot === null ? null : fencedResultAdoptionFromEnvironment(process.env, runtime.persistenceRoot)); }

  /**
   * M1.1: read-only passthrough of the runtime's own canonical event stream.
   * `RuntimePortAdapter.events` uses this to open bounded subscriptions
   * directly (no catalog entry gates a raw subscribe/poll handle, same as
   * `devtools.stream`'s reasoning) while still routing `resume()` through
   * `executeQuery`'s real `event.resume` case below, so that half stays
   * capability-checked.
   */
  get eventStream(): ArborRuntime["eventStream"] {
    return this.runtime.eventStream;
  }

  /**
   * The sole mutating runtime boundary is awaited. Most legacy handlers are
   * synchronous today, but returning their result through this async boundary
   * prevents a newly asynchronous authority (notably TaskComposer planning)
   * from being detached by a transport or UI adapter.
   *
   * Thin outcome-observing wrapper (T5.3, see `recordRouterOutcomeIfSinkConfigured`'s
   * doc comment) — the real dispatch logic is unchanged, in `dispatchCommandObserved`.
   */
  async dispatchCommand(input: unknown): Promise<RuntimeRouterResult<CommandAcknowledgement | ResultReviewMutationAcknowledgement | OutputCaptureAcknowledgement | SurveillanceScanAcknowledgement | JobCommandAcknowledgement | ApprovalRequestAcknowledgement | A2ASendAcknowledgement | { accepted: boolean; operation_id: string; draft?: TaskComposerDraft; error?: RuntimeError }>> {
    const result = await this.dispatchCommandObserved(input);
    if (!result.ok) recordRouterOutcomeIfSinkConfigured("command", outcomeKindOf(input, "command"), result.error);
    return result;
  }

  /**
   * Dispatch an approval after a transport has authenticated its caller.
   * Ordinary catalog dispatch deliberately has no fallback to caller-supplied
   * `metadata.actor_id`: surfaces that cannot establish identity cannot create
   * or decide approvals.
   */
  async dispatchAuthenticatedApproval(input: unknown, identity: AuthenticatedApprovalIdentity): Promise<RuntimeRouterResult<ApprovalRequestAcknowledgement>> {
    if (identity.actor_id.trim().length === 0) return this.failure("permission", "authenticated approval identity is required");
    if (!isApprovalRequestEnvelope(input)) return this.failure("validation", "authenticated approval dispatch only accepts approval commands");
    return this.dispatchApprovalRequest(input, identity.actor_id);
  }

  private async dispatchCommandObserved(input: unknown): Promise<RuntimeRouterResult<CommandAcknowledgement | ResultReviewMutationAcknowledgement | OutputCaptureAcknowledgement | SurveillanceScanAcknowledgement | JobCommandAcknowledgement | ApprovalRequestAcknowledgement | A2ASendAcknowledgement | { accepted: boolean; operation_id: string; draft?: TaskComposerDraft; error?: RuntimeError }>> {
    const unsupported = unsupportedCommandKind(input);
    if (unsupported) return this.unavailable(unsupported);
    const session = this.commandSession(input, this.options.require_local_session === true || isGitWorkspaceCommandEnvelope(input));
    if (!session.ok) return this.failure("permission", session.error);
    if (isGitWorkspaceCommandEnvelope(input)) return this.dispatchGitWorkspace(input);
    if (isTaskComposerCommandInput(input)) return this.dispatchTaskComposer(input);
    if (isResultScopeAuthorizeCommandEnvelope(input)) return this.dispatchResultScopeAuthorization(input);
    if (isResultAdoptCommandEnvelope(input)) return this.dispatchResultAdoption(input);
    if (isResultRevertCommandEnvelope(input)) return this.dispatchResultRevert(input);
    if (isResultReviewMutationEnvelope(input)) return this.dispatchResultReviewMutation(input);
    if (isApprovalRequestEnvelope(input)) return this.dispatchApprovalRequest(input, session.actor_id);
    if (isTrustSessionCommandEnvelope(input)) return this.dispatchTrustSession(input);
    if (isJobCommandEnvelope(input)) return this.dispatchJobCommand(input);
    if (isSurveillanceScanEnvelope(input)) return this.dispatchSurveillanceScan(input);
    if (isOutputCaptureEnvelope(input)) return this.dispatchOutputCapture(input);
    if (isCommunicationCommandEnvelope(input)) return this.dispatchCommunication(input);
    if (isInterruptionCommandEnvelope(input)) return this.dispatchInterruption(input);
    if (isHarnessSessionInterruptEnvelope(input)) return this.dispatchHarnessSessionInterrupt(input);
    if (isHarnessSessionSteerEnvelope(input)) return this.dispatchHarnessSessionSteer(input);
    if (isHarnessSessionContinuationEnvelope(input)) return this.dispatchHarnessSessionContinuation(input);
    if (isOperatorMaintenanceCommandEnvelope(input)) return this.dispatchOperatorMaintenance(input);
    if (isProductIntegrationCommandEnvelope(input)) return this.dispatchProductIntegration(input);
    if (isNativePeerCommandEnvelope(input)) return this.dispatchNativePeer(input);
    if (isProductUxCommandEnvelope(input)) return this.dispatchProductUx(input);
    if (isCompactionCommandEnvelope(input)) return this.dispatchCompactionRecord(input);
    if (isGovernedContextCommandEnvelope(input)) return this.dispatchGovernedContext(input);
    if (isUserInputCommandEnvelope(input)) return this.dispatchUserInput(input);
    if (isBusCommandEnvelope(input)) return this.dispatchBusRecord(input);
    if (isParentChildThreadSendEnvelope(input)) return this.dispatchParentChildThreadSend(input);
    if (isParentChildThreadAckEnvelope(input)) return this.dispatchParentChildThreadAck(input);
    if (isA2ASendCommandEnvelope(input)) return this.dispatchA2ASend(input);
    if (isA2AReceiveCommandEnvelope(input)) return this.dispatchA2AReceive(input);
    if (isSiblingSpawnEnvelope(input)) return this.dispatchSiblingSpawn(input);
    const validation = validateRuntimeCommand(input);
    if (!validation.ok) return this.failure("validation", "invalid runtime command", validation.violations.map((v) => `${v.path}: ${v.message}`).join("; "));
    const envelope = validation.value;
    const entry = catalogEntry(envelope.command.kind, "command");
    const fingerprint = JSON.stringify(envelope.command);
    let operation;
    try { operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    const rejection = (code: RuntimeError["code"], summary: string) => {
      const error = routerError(code, summary, undefined, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, error);
      return { ok: true as const, value: { accepted: false as const, operation_id: envelope.metadata.operation_id, error }, capability: entry.capability };
    };
    if ((envelope.command.kind === "recovery.retry" || envelope.command.kind === "recovery.abandon") && this.options.recovery_service === undefined) return rejection("unavailable", "recovery service is not configured");
    if (!entry.supported) return rejection("unavailable", entry.unavailable_reason ?? "not available");
    if (!this.authorized(entry)) return rejection("permission", this.denialSummary(entry));
    try {
      const acknowledgement = this.executeCommand(envelope);
      const campaignId = campaignIdForCommand(envelope.command);
      if (acknowledgement.accepted && campaignId !== null) this.runtime.scanSurveillance(campaignId);
      if (acknowledgement.accepted) this.runtime.operations.complete(envelope.metadata.operation_id, (acknowledgement as CommandAcknowledgement & { recovery?: RecoveryResult }).recovery?.status ?? "command accepted");
      else this.rejectOperation(envelope.metadata.operation_id, acknowledgement.error);
      return { ok: true, value: acknowledgement, capability: entry.capability };
    } catch (error) {
      const mapped = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, mapped);
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: mapped }, capability: entry.capability };
    }
  }

  /** Delegates every pre-campaign mutation to the one TaskComposer instance. */
  private async dispatchTaskComposer(input: unknown): Promise<RuntimeRouterResult<{ accepted: boolean; operation_id: string; draft?: TaskComposerDraft; error?: RuntimeError }>> {
    const metadata = composerMetadata(input);
    if (!metadata.ok) return this.failure("validation", metadata.error);
    const command = validateTaskComposerCommand((input as { command?: unknown }).command);
    if (!command.ok) return this.failure("validation", "invalid task composer command", command.error);
    const entry = catalogEntry(command.value.kind, "command");
    if (!entry.supported) return this.unavailable(entry);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const fingerprint = JSON.stringify(command.value);
    let operation: OperationRecord;
    try {
      operation = this.runtime.operations.accept({ metadata: metadata.value, capability: entry.capability, fingerprint });
    } catch (error) {
      return this.failure("conflict", errorMessage(error), undefined, entry.capability, metadata.value);
    }
    if (operation.state !== "accepted" && operation.state !== "running") {
      return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    }
    try {
      const draft = await this.runtime.taskComposer.dispatch(command.value);
      this.runtime.operations.complete(metadata.value.operation_id, `task composer draft ${draft.id} is ${draft.status}`);
      return { ok: true, value: { accepted: true, operation_id: metadata.value.operation_id, draft }, capability: entry.capability };
    } catch (error) {
      const mapped = mapRuntimeBoundaryError(error, metadata.value);
      this.rejectOperation(metadata.value.operation_id, mapped);
      return { ok: true, value: { accepted: false, operation_id: metadata.value.operation_id, error: mapped }, capability: entry.capability };
    }
  }

  /** Apply only the exact verified patch the operator inspected and confirmed. */
  private dispatchResultScopeAuthorization(input: unknown): RuntimeRouterResult<CommandAcknowledgement> {
    const metadata = composerMetadata(input);
    if (!metadata.ok) return this.failure("validation", metadata.error);
    const command = validateResultScopeAuthorizeCommand((input as { command?: unknown }).command);
    if (!command.ok) return this.failure("validation", "invalid result scope authorization command", command.error);
    const entry = catalogEntry("result.scope.authorize", "command");
    const fingerprint = JSON.stringify(command.value);
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: metadata.value, capability: entry.capability, fingerprint }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, metadata.value); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    const reject = (code: RuntimeError["code"], summary: string): RuntimeRouterResult<CommandAcknowledgement> => {
      const mapped = routerError(code, summary, undefined, metadata.value);
      this.rejectOperation(metadata.value.operation_id, mapped);
      return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: metadata.value.operation_id, error: mapped } };
    };
    if (!this.authorized(entry)) return reject("permission", this.denialSummary(entry));
    if (this.runtime.persistenceRoot === null) return reject("unavailable", "durable result capture is not configured");
    const outcome = this.runtime.manager.authorizeCapturedResultScope({
      campaign_id: command.value.campaign_id,
      node_id: command.value.node_id,
      persistence_dir: this.runtime.persistenceRoot,
      expected_patch_sha256: command.value.expected_patch_sha256,
      authorization_id: command.value.authorization_id,
      authorized_by: command.value.authorized_by,
      ...(command.value.authorized_paths === undefined ? {} : { authorized_paths: command.value.authorized_paths }),
    });
    if (!outcome.ok) return reject("conflict", outcome.reason);
    this.runtime.operations.complete(metadata.value.operation_id, `authorized scope expansion ${outcome.authorization.authorization_id}`);
    this.runtime.checkpointOperations();
    return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: metadata.value.operation_id } };
  }

  /** Apply only the exact verified patch the operator inspected and confirmed. */
  private async dispatchResultAdoption(input: unknown): Promise<RuntimeRouterResult<CommandAcknowledgement>> {
    const metadata = composerMetadata(input);
    if (!metadata.ok) return this.failure("validation", metadata.error);
    const command = validateResultAdoptCommand((input as { command?: unknown }).command);
    if (!command.ok) return this.failure("validation", "invalid result adoption command", command.error);
    const entry = catalogEntry("result.adopt", "command");
    const fingerprint = JSON.stringify(command.value);
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: metadata.value, capability: entry.capability, fingerprint }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, metadata.value); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    const persistenceRoot = this.runtime.persistenceRoot;
    const workspaceRoot = this.runtime.workspaceRoot;
    if (persistenceRoot === null || workspaceRoot === null) {
      const mapped = routerError("unavailable", "durable result capture and an operator workspace must be configured", undefined, metadata.value);
      this.rejectOperation(metadata.value.operation_id, mapped);
      return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: metadata.value.operation_id, error: mapped } };
    }
    if (!this.authorized(entry)) {
      const mapped = routerError("permission", this.denialSummary(entry), undefined, metadata.value);
      this.rejectOperation(metadata.value.operation_id, mapped);
      return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: metadata.value.operation_id, error: mapped } };
    }
    // Repeat the exact selected-subset preview at the mutation boundary. The
    // UI preview is advisory; only this hash-bound, manifest-bound check closes
    // the TOCTOU window before adoption mutates the operator workspace.
    let adoptionReview: ReturnType<ResultReviewWorkspaceService["inspect"]>;
    try {
      adoptionReview = this.resultReviewWorkspace.inspect({
        persistence_dir: persistenceRoot, workspace_root: workspaceRoot,
        campaign_id: command.value.campaign_id, node_id: command.value.node_id,
        selected_files: command.value.files,
        ...(command.value.scope_expansion_authorization_id === undefined ? {} : { scope_expansion_authorization_id: command.value.scope_expansion_authorization_id }),
      });
      if (adoptionReview.patch_sha256 !== command.value.expected_patch_sha256) throw new Error("captured patch changed since it was inspected");
      if (adoptionReview.conflict_preview.status !== "clean") throw new Error(adoptionReview.conflict_preview.detail);
    } catch (error) {
      const mapped = routerError("conflict", `selected-subset preflight failed: ${errorMessage(error)}`, undefined, metadata.value);
      this.rejectOperation(metadata.value.operation_id, mapped);
      return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: metadata.value.operation_id, error: mapped } };
    }
    const outcome = this.fencedResultAdoption === null
      ? adoptCapturedResult({ persistence_dir: persistenceRoot, target_root: workspaceRoot, campaign_id: command.value.campaign_id, node_id: command.value.node_id, expected_patch_sha256: command.value.expected_patch_sha256, ...(command.value.files === undefined ? {} : { files: command.value.files }), ...(command.value.scope_expansion_authorization_id === undefined ? {} : { scope_expansion_authorization_id: command.value.scope_expansion_authorization_id }) })
      : await this.fencedResultAdoption.adopt({ target_root: workspaceRoot, campaign_id: command.value.campaign_id, node_id: command.value.node_id, expected_patch_sha256: command.value.expected_patch_sha256, ...(command.value.files === undefined ? {} : { files: command.value.files }), ...(command.value.scope_expansion_authorization_id === undefined ? {} : { scope_expansion_authorization_id: command.value.scope_expansion_authorization_id }) });
    if (!outcome.ok) {
      const mapped = routerError("conflict", outcome.reason, undefined, metadata.value);
      this.rejectOperation(metadata.value.operation_id, mapped);
      return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: metadata.value.operation_id, error: mapped } };
    }
    const provenance = { tag: "generated" as const, generator: "arbor-runtime-catalog/result-adoption", input_hash: createHash("sha256").update(`${metadata.value.operation_id}:${command.value.campaign_id}:${command.value.node_id}`).digest("hex") };
    let retainedVerification = this.runtime.resultVerification.get(command.value.campaign_id, command.value.node_id);
    try {
      const node = this.runtime.manager.getNodeInfo(command.value.campaign_id, command.value.node_id);
      const verified = node?.provenance?.tag === "verified" && node.provenance.exit === 0 && node.provenance.strength !== "outputs_check" ? node.provenance : null;
      const declaredCommand = node?.action.high_risk_tool_scope?.command_argv.find((entry) => Array.isArray(entry) && entry.join(" ") === verified?.cmd);
      retainedVerification = verified !== null && Array.isArray(declaredCommand)
        ? this.runtime.resultVerification.record({
          campaign_id: command.value.campaign_id, node_id: command.value.node_id,
          checks: [{ command: [...declaredCommand], exit_status: verified.exit, duration_ms: null, summary: `machine verification passed: ${verified.cmd}`, provenance: verified }],
          files: [...adoptionReview.capture.files],
          diffstat: { additions: adoptionReview.counts.additions, deletions: adoptionReview.counts.deletions, files_changed: adoptionReview.counts.files },
          confidence: "verified", absence_reason: null, provenance: verified,
          idempotency_key: `result-adoption-verification:${metadata.value.operation_id}:verified`,
        })
        : this.runtime.resultVerification.record({
          campaign_id: command.value.campaign_id, node_id: command.value.node_id, checks: [], files: [...adoptionReview.capture.files],
          diffstat: { additions: adoptionReview.counts.additions, deletions: adoptionReview.counts.deletions, files_changed: adoptionReview.counts.files }, confidence: "unavailable",
          absence_reason: "result adoption applied a verified patch but no canonical verification command evidence was retained", provenance,
          idempotency_key: `result-adoption-verification:${metadata.value.operation_id}`,
        });
    } catch { this.runtime.recordProductObservabilityFailure("result_verification", "result adoption verification evidence could not be persisted"); }
    try {
      this.runtime.notificationInbox.publish({
        id: `result-adopted-${metadata.value.operation_id}`, fingerprint: `result-adopted:${command.value.campaign_id}:${command.value.node_id}`,
        project_id: command.value.campaign_id, severity: "info", title: "Result adopted",
        body: retainedVerification?.confidence === "verified"
          ? `Verified result ${command.value.node_id} was adopted with its machine-check evidence retained.`
          : `Verified result ${command.value.node_id} was adopted; inspect its verification record for evidence availability.`,
        actions: [{ label: "Inspect verification", action: "result.verification.get" }],
        delivery: { channels: ["tui", "terminal"], quiet_hours: null }, provenance,
        idempotency_key: `result-adoption-notification:${metadata.value.operation_id}`,
      });
    } catch { this.runtime.recordProductObservabilityFailure("notification_inbox", "result adoption notification could not be persisted"); }
    this.runtime.operations.complete(metadata.value.operation_id, `adopted verified result ${command.value.node_id}`);
    this.runtime.checkpointOperations();
    return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: metadata.value.operation_id } };
  }

  /** Reverse only a completed adoption operation's exact recorded patch subset. */
  private async dispatchResultRevert(input: unknown): Promise<RuntimeRouterResult<CommandAcknowledgement>> {
    const metadata = composerMetadata(input);
    if (!metadata.ok) return this.failure("validation", metadata.error);
    const command = validateResultRevertCommand((input as { command?: unknown }).command);
    if (!command.ok) return this.failure("validation", "invalid result revert command", command.error);
    const entry = catalogEntry("result.revert", "command");
    const fingerprint = JSON.stringify(command.value);
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: metadata.value, capability: entry.capability, fingerprint }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, metadata.value); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    const reject = (code: RuntimeError["code"], summary: string): RuntimeRouterResult<CommandAcknowledgement> => {
      const mapped = routerError(code, summary, undefined, metadata.value);
      this.rejectOperation(metadata.value.operation_id, mapped);
      return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: metadata.value.operation_id, error: mapped } };
    };
    if (!this.authorized(entry)) return reject("permission", this.denialSummary(entry));
    const persistenceRoot = this.runtime.persistenceRoot;
    const workspaceRoot = this.runtime.workspaceRoot;
    if (persistenceRoot === null || workspaceRoot === null) return reject("unavailable", "durable result capture and an operator workspace must be configured");
    const adoption = this.runtime.operations.get(command.value.adoption_operation_id);
    if (!adoption || adoption.state !== "completed" || adoption.capability !== "result.adopt") return reject("conflict", "revert requires a completed result adoption operation");
    const adoptedCommand = parseResultAdoptFingerprint(adoption.fingerprint);
    if (!adoptedCommand.ok) return reject("corrupt_data", "adoption operation fingerprint is invalid");
    if (adoptedCommand.value.expected_patch_sha256 !== command.value.expected_patch_sha256) return reject("conflict", "revert hash does not match the completed adoption");
    const alreadyReverted = this.runtime.operations.list(true).some((candidate) => {
      if (candidate.capability !== "result.revert" || candidate.state !== "completed") return false;
      const prior = parseResultRevertFingerprint(candidate.fingerprint);
      return prior.ok && prior.value.adoption_operation_id === command.value.adoption_operation_id;
    });
    if (alreadyReverted) return reject("conflict", "this adoption operation has already been reverted");
    const outcome = this.fencedResultAdoption === null
      ? revertCapturedResult({ persistence_dir: persistenceRoot, target_root: workspaceRoot, campaign_id: adoptedCommand.value.campaign_id, node_id: adoptedCommand.value.node_id, expected_patch_sha256: adoptedCommand.value.expected_patch_sha256, ...(adoptedCommand.value.files === undefined ? {} : { files: adoptedCommand.value.files }) })
      : await this.fencedResultAdoption.revert({ target_root: workspaceRoot, campaign_id: adoptedCommand.value.campaign_id, node_id: adoptedCommand.value.node_id, expected_patch_sha256: adoptedCommand.value.expected_patch_sha256, ...(adoptedCommand.value.files === undefined ? {} : { files: adoptedCommand.value.files }) });
    if (!outcome.ok) return reject("conflict", outcome.reason);
    this.runtime.operations.complete(metadata.value.operation_id, `reverted adoption ${command.value.adoption_operation_id}`);
    this.runtime.checkpointOperations();
    return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: metadata.value.operation_id } };
  }

  /** Persist review collaboration and editor continuity without mutating project files. */
  private dispatchResultReviewMutation(input: unknown): RuntimeRouterResult<ResultReviewMutationAcknowledgement> {
    const metadata = composerMetadata(input); if (!metadata.ok) return this.failure("validation", metadata.error);
    const command = validateResultReviewMutation((input as { command?: unknown }).command); if (!command.ok) return this.failure("validation", "invalid result review mutation", command.error);
    const entry = catalogEntry(command.value.kind, "command");
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: metadata.value, capability: entry.capability, fingerprint: JSON.stringify(command.value) }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, metadata.value); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, capability: entry.capability, value: acknowledgementFromOperation(operation) };
    const persistenceRoot = this.runtime.persistenceRoot; const workspaceRoot = this.runtime.workspaceRoot;
    const reject = (code: RuntimeError["code"], summary: string): RuntimeRouterResult<ResultReviewMutationAcknowledgement> => { const mapped = routerError(code, summary, undefined, metadata.value); this.rejectOperation(metadata.value.operation_id, mapped); return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: metadata.value.operation_id, error: mapped } }; };
    if (!this.authorized(entry)) return reject("permission", this.denialSummary(entry));
    if (persistenceRoot === null) return reject("unavailable", "durable result review is not configured");
    try {
      if (command.value.kind === "result.review.comment") this.resultReviewWorkspace.addComment(command.value);
      else if (command.value.kind === "result.review.request_revision") this.resultReviewWorkspace.requestRevision(command.value);
      else {
        if (workspaceRoot === null) return reject("unavailable", "an operator workspace is required for editor handoff");
        this.resultReviewWorkspace.createEditorHandoff({ ...command.value, workspace_root: workspaceRoot });
      }
      const review = this.resultReviewWorkspace.inspect({ persistence_dir: persistenceRoot, workspace_root: workspaceRoot, campaign_id: command.value.campaign_id, node_id: command.value.node_id, verification: this.runtime.resultVerification.get(command.value.campaign_id, command.value.node_id) });
      this.runtime.operations.complete(metadata.value.operation_id, `${command.value.kind} recorded at review revision ${review.review_revision}`); this.runtime.checkpointOperations();
      return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: metadata.value.operation_id, review } };
    } catch (error) { return reject("conflict", errorMessage(error)); }
  }

  private dispatchInterruption(envelope: InterruptionCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const entry = catalogEntry("tree.interrupt", "command");
    const failures = validateInterruptionCommand(envelope);
    if (failures.length) return this.failure("validation", "invalid interruption command", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const fingerprint = JSON.stringify(envelope.command);
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata); }
    if (operation.state !== "accepted" && operation.state !== "running") {
      return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    }
    try {
      this.runtime.interrupt({
        campaign_id: envelope.command.campaign_id, node_id: envelope.command.node_id,
        operation_id: envelope.metadata.operation_id, scope: envelope.command.scope,
        reason: envelope.command.reason, expected_version: envelope.metadata.expected_version,
        partial_evidence_ids: envelope.command.partial_evidence_ids,
        provenance: envelope.command.provenance,
      });
      this.runtime.operations.complete(envelope.metadata.operation_id, "interruption applied");
      this.runtime.checkpointOperations();
      return { ok: true, value: { accepted: true, operation_id: envelope.metadata.operation_id }, capability: entry.capability };
    } catch (error) {
      const mapped = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, mapped);
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: mapped }, capability: entry.capability };
    }
  }

  /** Thin outcome-observing wrapper (T5.3) — real dispatch is unchanged, in `executeQueryObserved`. */
  executeQuery(input: unknown): RuntimeRouterResult<unknown> {
    const result = this.executeQueryObserved(input);
    if (!result.ok) recordRouterOutcomeIfSinkConfigured("query", outcomeKindOf(input, "query"), result.error);
    return result;
  }

  private executeQueryObserved(input: unknown): RuntimeRouterResult<unknown> {
    const unsupported = unsupportedQueryKind(input);
    if (unsupported) return this.unavailable(unsupported);
    if (isGitWorkspaceQueryEnvelope(input)) return this.executeGitWorkspace(input);
    if (isDistributedControlQueryEnvelope(input)) return this.executeDistributedControl(input);
    if (isProductIntegrationQueryEnvelope(input)) return this.executeProductIntegration(input);
    if (isNativePeerQueryEnvelope(input)) return this.executeNativePeer(input);
    if (isOperatorMaintenanceQueryEnvelope(input)) return this.executeOperatorMaintenance(input);
    if (isProductUxQueryEnvelope(input)) return this.executeProductUx(input);
    if (isTaskComposerQueryInput(input)) return this.executeTaskComposerQuery(input);
    if (isResultReviewQueryEnvelope(input)) return this.executeResultReviewQuery(input);
    if (isNativeCampaignBudgetQueryEnvelope(input)) return this.executeNativeCampaignBudgetQuery(input);
    if (isNativeHarnessReadinessQueryEnvelope(input)) return this.executeNativeHarnessReadinessQuery(input);
    if (isHarnessConnectorInventoryQueryEnvelope(input)) return this.executeHarnessConnectorInventoryQuery(input);
    if (isHarnessSessionQueryEnvelope(input)) return this.executeHarnessSessionQuery(input);
    if (isCapabilityIntrospectionQueryEnvelope(input)) return this.executeCapabilityIntrospection(input);
    if (isTrustSessionQueryEnvelope(input)) return this.executeTrustSessionQuery(input);
    if (isSurveillanceQueryEnvelope(input)) return this.executeSurveillanceQuery(input);
    if (isOutputQueryEnvelope(input)) return this.executeOutputQuery(input);
    if (isOutputListQueryEnvelope(input)) return this.executeOutputListQuery(input);
    if (isGovernanceRecordQueryEnvelope(input)) return this.executeGovernanceRecordQuery(input);
    if (isGovernanceQueryEnvelope(input)) return this.executeGovernanceQuery(input);
    if (isGovernanceBacklogQueryEnvelope(input)) return this.executeGovernanceBacklogQuery(input);
    if (isProjectRegistryListQueryEnvelope(input)) return this.executeProjectRegistryListQuery(input);
    if (isProjectManageQueryEnvelope(input)) return this.executeProjectManageQuery(input);
    if (isKbListQueryEnvelope(input)) return this.executeKbListQuery(input);
    if (isAuditListQueryEnvelope(input)) return this.executeAuditListQuery(input);
    if (isCommunicationQueryEnvelope(input)) return this.executeCommunicationQuery(input);
    if (isConfigQueryEnvelope(input)) return this.executeConfigQuery(input);
    if (isAgentQueryEnvelope(input)) return this.executeAgentQuery(input);
    if (isOperationListQueryEnvelope(input)) return this.executeOperationListQuery(input);
    if (isInspectActionQueryEnvelope(input)) return this.executeInspectActionQuery(input);
    if (isRecoveryPendingQueryEnvelope(input)) return this.executeRecoveryPendingQuery(input);
    if (isJobListQueryEnvelope(input)) return this.executeJobListQuery(input);
    if (isApprovalListQueryEnvelope(input)) return this.executeApprovalListQuery(input);
    if (isCompactionQueryEnvelope(input)) return this.executeCompactionQuery(input);
    if (isPhaseMessageQueryEnvelope(input)) return this.executePhaseMessageQuery(input);
    if (isGovernedContextQueryEnvelope(input)) return this.executeGovernedContextQuery(input);
    if (isUserInputQueryEnvelope(input)) return this.executeUserInputQuery(input);
    if (isBusQueryEnvelope(input)) return this.executeBusHistory(input);
    if (isParentChildThreadHistoryEnvelope(input)) return this.executeParentChildThreadHistory(input);
    if (isSiblingStatusQueryEnvelope(input)) return this.executeSiblingStatus(input);
    if (isLiveProjectionQueryEnvelope(input)) return this.executeLiveProjectionQuery(input);
    // Future unsupported catalog kinds are recognized before core validation
    // so callers receive a documented reason rather than a generic shape
    // failure from core's deliberately smaller ApplicationQuery union.
    const validation = validateRuntimeQuery(input);
    if (!validation.ok) {
      // A supported kind that reached here failed its family's shape predicate:
      // report the PAYLOAD as invalid, never the kind as unsupported.
      const declared = declaredSupportedQueryKind(input);
      if (declared !== null) {
        return this.failure("validation", `invalid ${declared.kind} query`,
          `the ${declared.kind} query is supported, but this payload does not match its required shape (capability ${declared.capability})`,
          declared.capability);
      }
      return this.failure("validation", "invalid runtime query", validation.violations.map((v) => `${v.path}: ${v.message}`).join("; "));
    }
    const envelope = validation.value;
    const entry = catalogEntry(envelope.query.kind, "query");
    if (!entry.supported) return this.unavailable(entry);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      return { ok: true, value: this.executeQueryValue(envelope), capability: entry.capability };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private executeDistributedControl(envelope: DistributedControlQueryEnvelope): RuntimeRouterResult<unknown> {
    const failures = validateDistributedControlQuery(envelope), entry = catalogEntry(envelope.query.kind, "query");
    if (failures.length) return this.failure("validation", "invalid distributed control query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const projection = this.runtime.distributedControlProjection(envelope.query.kind);
    if (projection.availability === "configured" && envelope.query.limit !== undefined && projection.kind === "control.discover") return { ok: true, capability: entry.capability, value: { ...projection, value: { hosts: projection.value.hosts.slice(0, envelope.query.limit), truncated: projection.value.truncated || projection.value.hosts.length > envelope.query.limit } } };
    if (projection.availability === "configured" && envelope.query.limit !== undefined && projection.kind === "control.inbox") return { ok: true, capability: entry.capability, value: { ...projection, value: { messages: projection.value.messages.slice(0, envelope.query.limit), truncated: projection.value.truncated || projection.value.messages.length > envelope.query.limit } } };
    return { ok: true, capability: entry.capability, value: projection };
  }

  private executeGitWorkspace(envelope: GitWorkspaceQueryEnvelope): RuntimeRouterResult<unknown> {
    const entry = catalogEntry("git.workspace", "query");
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const service = this.options.git_workspace ?? this.runtime.gitWorkspace;
    if (service == null) return this.failure("unavailable", "Git workspace projection is not composed", undefined, entry.capability);
    try { return { ok: true, capability: entry.capability, value: service.inspect(envelope.query.path, { ancestry_limit: envelope.query.ancestry_limit, cached_diff: envelope.query.cached_diff }) }; }
    catch (error) { return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) }; }
  }

  private dispatchGitWorkspace(envelope: GitWorkspaceCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const entry = catalogEntry(envelope.command.kind, "command");
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata); }
    if (operation.state === "running" || this.runtime.operations.requiresReconciliation(operation.operation_id)) return { ok: true, value: { accepted: true, operation_id: operation.operation_id }, capability: entry.capability };
    if (operation.state !== "accepted") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    const reject = (code: RuntimeError["code"], summary: string): RuntimeRouterResult<CommandAcknowledgement> => {
      const error = routerError(code, summary, undefined, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, error);
      const checkpoint = this.runtime.checkpointOperations();
      if (!checkpoint.ok) return { ok: false, capability: entry.capability, error: checkpoint.failures[0] ?? routerError("internal", "unable to persist Git operation outcome", undefined, envelope.metadata) };
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error }, capability: entry.capability };
    };
    if (!entry.supported) return reject("unavailable", entry.unavailable_reason ?? "not available");
    if (!this.authorized(entry)) return reject("permission", this.denialSummary(entry));
    const service = this.options.git_workspace ?? this.runtime.gitWorkspace;
    if (service == null) return reject("unavailable", "Git worktree management is not composed");
    const requestedActiveRun = envelope.command.kind !== "git.worktree.create" && envelope.command.active_run === true;
    const runtimeActiveRun = this.runtime.supervisor.list().some((task) =>
      task.kind === CAMPAIGN_RUN_JOB_KIND && (task.state === "started" || task.state === "retrying" || task.state === "cancel_requested"));
    const activeRun = requestedActiveRun || runtimeActiveRun;
    if (runtimeActiveRun && envelope.command.kind === "git.worktree.cleanup") return reject("conflict", "refusing worktree cleanup while a campaign.run is active");
    const acceptedCheckpoint = this.runtime.checkpointOperations();
    if (!acceptedCheckpoint.ok) {
      const error = acceptedCheckpoint.failures[0] ?? routerError("internal", "unable to persist Git operation identity", undefined, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, error);
      const rejectionCheckpoint = this.runtime.checkpointOperations();
      if (!rejectionCheckpoint.ok) return { ok: false, capability: entry.capability, error: rejectionCheckpoint.failures[0] ?? error };
      return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: envelope.metadata.operation_id, error } };
    }
    let result: ReturnType<GitWorkspaceService["operations"]["create"]>;
    try {
      result = envelope.command.kind === "git.worktree.create"
        ? service.operations.create({ campaign_id: envelope.command.campaign_id, node_id: envelope.command.node_id, specialist: envelope.command.specialist })
        : envelope.command.kind === "git.worktree.switch"
          ? service.switch(envelope.command.path, activeRun)
          : service.operations.cleanup(envelope.command.node_id, { authorized: envelope.command.authorized, active_run: activeRun });
    } catch (error) {
      const mapped = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, mapped);
      const rejectionCheckpoint = this.runtime.checkpointOperations();
      if (!rejectionCheckpoint.ok) return { ok: false, capability: entry.capability, error: rejectionCheckpoint.failures[0] ?? routerError("internal", "unable to persist Git operation outcome", undefined, envelope.metadata) };
      return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: mapped } };
    }
    if (!result.ok) return reject("conflict", result.diagnostic ?? result.reason ?? "Git worktree operation refused");
    service.notifyMutation?.();
    this.runtime.operations.complete(envelope.metadata.operation_id, `${envelope.command.kind} accepted`);
    // If the terminal checkpoint fails, the durable accepted record is a
    // reconciliation marker. Restored active operations are never replayed.
    const completionCheckpoint = this.runtime.checkpointOperations();
    if (!completionCheckpoint.ok) return { ok: false, capability: entry.capability, error: completionCheckpoint.failures[0] ?? routerError("internal", "Git mutation completed but its terminal operation state could not be persisted", undefined, envelope.metadata) };
    return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id } };
  }

  private executeProductIntegration(envelope: ProductIntegrationQueryEnvelope): RuntimeRouterResult<unknown> {
    const failures = validateProductIntegrationQuery(envelope); const entry = catalogEntry(envelope.query.kind, "query");
    if (failures.length) return this.failure("validation", "invalid integration query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    this.runtime.refreshProductIntegrationDiscovery(); const plane = this.runtime.productIntegrations; const query = envelope.query;
    if (query.kind === "integration.list") return { ok: true, capability: entry.capability, value: { integrations: plane.list(query.category) } };
    if (query.kind === "integration.admit") return { ok: true, capability: entry.capability, value: plane.admit(query.integration_id!, query.capabilities ?? []) };
    let receipts: ReturnType<IntegrationControlReceiptJournal["list"]>;
    try { receipts = this.integrationControlReceipts().list(query.kind === "integration.inspect" ? query.integration_id! : query.kind === "remote.inspect" ? "remote.control" : "scheduler.control"); }
    catch (error) { return this.failure("internal", "integration control receipts could not be read", errorMessage(error), entry.capability); }
    if (query.kind === "integration.inspect") { const integration = plane.inspect(query.integration_id!); return integration === null ? this.failure("conflict", "integration is not composed", undefined, entry.capability) : { ok: true, capability: entry.capability, value: { ...integration, receipts } }; }
    const id = query.kind === "remote.inspect" ? "remote.control" : "scheduler.control"; const integration = plane.inspect(id); if (integration === null) return this.failure("unavailable", "control integration is unavailable", undefined, entry.capability);
    if (query.kind === "remote.inspect") return { ok: true, capability: entry.capability, value: { integration, sessions: this.runtime.remoteSessionAuthority.list(), receipts } };
    if (query.kind === "scheduler.inspect") { const scheduler = this.runtime.longHorizonScheduler; return scheduler === null ? this.failure("unavailable", "scheduler is not composed", undefined, entry.capability) : { ok: true, capability: entry.capability, value: { integration, schedules: scheduler.list(), runs: scheduler.runHistory(), receipts } }; }
    return this.failure("validation", "unsupported product integration query", undefined, entry.capability);
  }

  /**
   * Every authorized or refused control command leaves one durable receipt
   * (`integration.inspect` / `remote.inspect` / `scheduler.inspect` project
   * them). Malformed envelopes are rejected before a target is known and
   * leave none.
   */
  private dispatchProductIntegration(envelope: ProductIntegrationCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement & { receipt_id?: string }> {
    const failures = validateProductIntegrationCommand(envelope); const entry = catalogEntry(envelope.command.kind, "command");
    if (failures.length) return this.failure("validation", "invalid integration command", failures.join("; "), entry.capability);
    const command = envelope.command;
    const governed = command.kind === "remote.control" || command.kind === "scheduler.control" ? command.kind : command.integration_id!;
    const target = command.kind === "remote.control" ? command.session_id! : command.kind === "scheduler.control" ? command.schedule_id! : command.integration_id!;
    const before = this.integrationControlSnapshot(command);
    const record = (outcome: "applied" | "refused", refusal: { code: RuntimeError["code"]; summary: string } | null, after: IntegrationControlSnapshot | null): string => this.integrationControlReceipts().append({
      kind: command.kind, integration_id: governed, target_id: target, action: command.action ?? null, operation_id: envelope.metadata.operation_id,
      actor_id: envelope.metadata.actor_id, outcome, refusal, before, after,
    }).receipt_id;
    const refuse = (code: RuntimeError["code"], summary: string): RuntimeRouterResult<never> => {
      try { return this.failure(code, summary, `receipt ${record("refused", { code, summary }, before)}`, entry.capability); }
      catch (error) { return this.failure("internal", `${summary}; the refusal receipt could not be recorded`, errorMessage(error), entry.capability); }
    };
    if (!this.authorized(entry)) return refuse("permission", this.denialSummary(entry));
    if (command.kind !== "remote.control" && command.kind !== "scheduler.control") {
      const refusal = productIntegrationLifecycleRefusal({ kind: command.kind, integration_id: command.integration_id!, view: this.runtime.productIntegrations.inspect(command.integration_id!), ...(command.version === undefined ? {} : { version: command.version }), ...(command.plugin_manifest === undefined ? {} : { plugin_manifest: command.plugin_manifest }) });
      if (refusal !== null) return refuse("unavailable", refusal);
    }
    try {
      if (command.kind === "remote.control") this.runtime.remoteSessionAuthority.revokeSession(command.session_id!);
      else if (command.kind === "scheduler.control") { const scheduler = this.runtime.longHorizonScheduler; if (scheduler === null) return refuse("unavailable", "scheduler is not composed"); if (command.action === "suspend") scheduler.suspendForHuman(command.schedule_id!, command.reason!); else scheduler.resume(command.schedule_id!); }
      else this.runtime.applyProductIntegrationLifecycle({ ...command, kind: command.kind, integration_id: command.integration_id! });
    } catch (error) { return refuse("conflict", errorMessage(error)); }
    let receiptId: string;
    try { receiptId = record("applied", null, this.integrationControlSnapshot(command)); }
    catch (error) { return this.failure("internal", `${command.kind} was applied but its receipt could not be recorded`, errorMessage(error), entry.capability); }
    return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id, receipt_id: receiptId } };
  }

  private integrationControlReceipts(): IntegrationControlReceiptJournal {
    this.integrationControlJournal ??= new IntegrationControlReceiptJournal({ persistence_dir: this.runtime.persistenceRoot });
    return this.integrationControlJournal;
  }

  /** Review-safe observed state of the exact control target, or null when it does not exist. */
  private integrationControlSnapshot(command: ProductIntegrationCommandEnvelope["command"]): IntegrationControlSnapshot | null {
    if (command.kind === "remote.control") { const session = this.runtime.remoteSessionAuthority.list().find((item) => item.session_id === command.session_id) ?? null; return session === null ? null : { state: session.state ?? null, revoked_at: session.revoked_at ?? null }; }
    if (command.kind === "scheduler.control") { const schedule = this.runtime.longHorizonScheduler?.list().find((item) => item.schedule_id === command.schedule_id) ?? null; return schedule === null ? null : { state: schedule.state, version: schedule.version, human_reason: schedule.human_reason }; }
    const view = this.runtime.productIntegrations.inspect(command.integration_id!);
    return view === null ? null : { state: view.state, version: view.version, health: view.health.status };
  }

  private dispatchNativePeer(envelope: NativePeerCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement & { message_id?: string; escalation_id?: string }> {
    const failures = validateNativePeerCommand(envelope); const entry = catalogEntry(envelope.command.kind, "command");
    if (failures.length) return this.failure("validation", "invalid native peer command", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const command = envelope.command;
    const caller = this.peerCaller(command.kind === "peer.grant" ? command.campaign_id : undefined, envelope.metadata.actor_id);
    if (caller === null) return this.failure("permission", "authenticated peer caller context is required", undefined, entry.capability);
    if (command.kind === "peer.grant" && (caller.kind !== "parent" || caller.node_id !== command.parent_node_id)) return this.failure("permission", "only the authenticated campaign parent may grant a peer relationship", undefined, entry.capability);
    if (command.kind !== "peer.grant" && (caller.kind !== "peer" || caller.node_id !== command.from_node_id)) return this.failure("permission", "a peer command may only act as its authenticated node", undefined, entry.capability);
    const result = command.kind === "peer.grant" ? this.runtime.nativePeerChannels.grant(command, caller)
      : command.kind === "peer.query" ? this.runtime.nativePeerChannels.query(command, envelope.metadata.idempotency_key, envelope.metadata.requested_at, caller)
        : this.runtime.nativePeerChannels.reply(command, envelope.metadata.idempotency_key, envelope.metadata.requested_at, caller);
    if (!result.accepted) return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: routerError(result.code === "scope_denied" || result.code === "capability_denied" ? "permission" : "conflict", result.reason, undefined, envelope.metadata), ...(result.escalation_id === undefined ? {} : { escalation_id: result.escalation_id }) } };
    return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id, ...(result.message_id === undefined ? {} : { message_id: result.message_id }), ...(result.escalation_id === undefined ? {} : { escalation_id: result.escalation_id }) } };
  }

  private executeNativePeer(envelope: NativePeerQueryEnvelope): RuntimeRouterResult<unknown> {
    const failures = validateNativePeerQuery(envelope); const entry = catalogEntry(envelope.query.kind, "query");
    if (failures.length) return this.failure("validation", "invalid native peer query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const caller = this.peerCaller(envelope.query.kind === "peer.grants" ? envelope.query.campaign_id : undefined);
    if (caller === null) return this.failure("permission", "authenticated peer caller context is required", undefined, entry.capability);
    if (envelope.query.kind === "peer.grants") return { ok: true, capability: entry.capability, value: { grants: this.runtime.nativePeerChannels.list(caller.campaign_id).filter((grant) => caller.kind === "parent" || grant.left_node_id === caller.node_id || grant.right_node_id === caller.node_id) } };
    const history = this.runtime.nativePeerChannels.history(envelope.query, caller);
    return history === null ? this.failure("permission", "peer history is outside the granted relationship", undefined, entry.capability) : { ok: true, capability: entry.capability, value: history };
  }

  private peerCaller(campaignId?: string, actorId?: string): NativePeerTrustedCaller | null {
    const caller = this.options.peer_caller;
    if (caller === undefined || campaignId !== undefined && caller.campaign_id !== campaignId || actorId !== undefined && caller.actor_id !== actorId) return null;
    return caller;
  }

  private executeProductUx(envelope: ProductUxQueryEnvelope): RuntimeRouterResult<unknown> {
    const failures = validateProductUxQuery(envelope); const entry = catalogEntry(envelope.query.kind, "query");
    if (failures.length) return this.failure("validation", "invalid product UX query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const query = envelope.query;
    if (query.kind === "session.identity.get") return { ok: true, capability: entry.capability, value: this.runtime.sessionIdentities.get(query.session_id) };
    if (query.kind === "session.identity.search") return { ok: true, capability: entry.capability, value: this.runtime.sessionIdentities.search({ query: query.query, limit: query.limit, cursor: query.cursor }) };
    if (query.kind === "result.verification.get") return { ok: true, capability: entry.capability, value: this.runtime.resultVerification.get(query.campaign_id, query.node_id) };
    if (query.kind === "result.verification.list") return { ok: true, capability: entry.capability, value: { records: this.runtime.resultVerification.list(query.campaign_id, query.limit ?? 100) } };
    if (query.kind === "notification.list") return { ok: true, capability: entry.capability, value: { notifications: this.runtime.notificationInbox.list({ project_id: query.project_id, unread_only: query.unread_only, limit: query.limit ?? 100 }) } };
    if (query.kind === "followup.list") return { ok: true, capability: entry.capability, value: { follow_ups: this.runtime.followUpLineage.list(query.parent_campaign_id, query.limit ?? 100) } };
    return this.failure("validation", "unsupported product UX query", undefined, entry.capability);
  }

  private dispatchProductUx(envelope: ProductUxCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const metadata = composerMetadata(envelope);
    if (!metadata.ok) return this.failure("validation", metadata.error);
    const failures = validateProductUxCommand(envelope); const entry = catalogEntry(envelope.command.kind, "command");
    if (failures.length) return this.failure("validation", "invalid product UX command", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const command = envelope.command;
      if (command.kind === "session.identity.mutate") this.runtime.sessionIdentities.mutate({ session_id: command.session_id, display_name: command.display_name, tags: command.tags, provenance: command.provenance, idempotency_key: metadata.value.idempotency_key });
      else if (command.kind === "notification.read") this.runtime.notificationInbox.markRead({ id: command.notification_id, idempotency_key: metadata.value.idempotency_key });
      else if (command.kind === "followup.create") this.runtime.followUpLineage.create({ id: command.id, parent_campaign_id: command.parent_campaign_id, source_result: command.source_result, source_node: command.source_node, provenance: command.provenance, idempotency_key: metadata.value.idempotency_key });
      else return this.failure("validation", "unsupported product UX command", undefined, entry.capability);
      return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: metadata.value.operation_id } };
    } catch (error) { return this.failure("conflict", error instanceof Error ? error.message : String(error), undefined, entry.capability, metadata.value); }
  }

  private executeOperatorMaintenance(envelope: OperatorMaintenanceQueryEnvelope): RuntimeRouterResult<unknown> {
    const failures = validateOperatorMaintenanceQuery(envelope); const entry = catalogEntry(envelope.query.kind, "query");
    if (failures.length) return this.failure("validation", "invalid operator maintenance query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    if (envelope.query.kind === "doctor.get") { const report = this.runtime.inspectOperatorDoctor(); return report === null ? this.failure("unavailable", "operator doctor requires a composed workspace, persistence root, and integration inspection", undefined, entry.capability) : { ok: true, capability: entry.capability, value: report }; }
    if (envelope.query.kind === "migration.inspect") { const inspection = this.runtime.inspectMigration(); return inspection === null ? this.failure("unavailable", "migration inspection requires a configured workspace", undefined, entry.capability) : { ok: true, capability: entry.capability, value: inspection }; }
    const root = this.runtime.workspaceRoot; if (root === null) return this.failure("unavailable", "migration preview requires a configured workspace", undefined, entry.capability);
    try { return { ok: true, capability: entry.capability, value: previewMigration({ cwd: root, source_path: envelope.query.source_path! }) }; } catch (error) { return this.failure("validation", error instanceof Error ? error.message : String(error), undefined, entry.capability); }
  }

  private dispatchOperatorMaintenance(envelope: OperatorMaintenanceCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const failures = validateOperatorMaintenanceCommand(envelope); const entry = catalogEntry(envelope.command.kind, "command");
    if (failures.length) return this.failure("validation", "invalid migration command", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    const root = this.runtime.workspaceRoot;
    if (root === null) {
      const mapped = routerError("unavailable", "migration command requires a configured workspace", undefined, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, mapped);
      return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: mapped } };
    }
    try {
      if (envelope.command.kind === "migration.apply") applyMigration({ cwd: root, source_path: envelope.command.source_path, expected_source_sha256: envelope.command.expected_source_sha256, overwrite: envelope.command.overwrite });
      else rollbackMigration({ cwd: root, receipt_id: envelope.command.receipt_id });
      this.runtime.operations.complete(envelope.metadata.operation_id, `${envelope.command.kind} applied`);
      return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id } };
    } catch (error) {
      const mapped = routerError("conflict", errorMessage(error), undefined, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, mapped);
      return { ok: true, capability: entry.capability, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: mapped } };
    }
  }

  /** TaskComposer owns state and pagination; the router only gates the seam. */
  private executeTaskComposerQuery(input: unknown): RuntimeRouterResult<unknown> {
    const raw = (input as { query?: unknown }).query;
    const query = validateTaskComposerQuery(raw);
    if (!query.ok) return this.failure("validation", "invalid task composer query", query.error);
    const entry = catalogEntry(query.value.kind, "query");
    if (!entry.supported) return this.unavailable(entry);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const result = this.runtime.taskComposer.query(query.value);
      if (query.value.kind === "taskcomposer.get") {
        return result === null
          ? this.failure("conflict", `task composer draft ${query.value.draft_id} was not found`, undefined, entry.capability)
          : { ok: true, value: { draft: result }, capability: entry.capability };
      }
      return { ok: true, value: result, capability: entry.capability };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /** Captured-result review is read-only, bounded, and backed by durable runtime state. */
  private executeResultReviewQuery(input: unknown): RuntimeRouterResult<unknown> {
    const validation = validateResultReviewQuery(input);
    if (!validation.ok) return this.failure("validation", "invalid result review query", validation.error);
    const envelope = validation.value;
    const entry = catalogEntry(envelope.query.kind, "query");
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const persistenceRoot = this.runtime.persistenceRoot;
    if (persistenceRoot === null) return this.failure("unavailable", "durable result capture is not configured", undefined, entry.capability);
    try {
      if (envelope.query.kind === "result.list") {
        return {
          ok: true,
          capability: entry.capability,
          value: { campaign_id: envelope.query.campaign_id, items: listCapturedResults(persistenceRoot, envelope.query.campaign_id) },
        };
      }
      if (envelope.query.kind === "result.review.workspace") {
        const nodeId = envelope.query.node_id ?? listCapturedResults(persistenceRoot, envelope.query.campaign_id)[0]?.node_id;
        const criticVerdict = nodeId === undefined ? null : this.runtime.manager.getCampaignSnapshot(envelope.query.campaign_id)?.nodes.find((node) => node.id === nodeId)?.critic_verdict ?? null;
        return { ok: true, capability: entry.capability, value: this.resultReviewWorkspace.inspect({ persistence_dir: persistenceRoot, workspace_root: this.runtime.workspaceRoot, campaign_id: envelope.query.campaign_id, ...(nodeId === undefined ? {} : { node_id: nodeId, verification: this.runtime.resultVerification.get(envelope.query.campaign_id, nodeId), critic_verdict: criticVerdict }), ...(envelope.query.files === undefined ? {} : { selected_files: envelope.query.files }), ...(envelope.query.max_patch_bytes === undefined ? {} : { max_patch_bytes: envelope.query.max_patch_bytes }) }) };
      }
      return {
        ok: true,
        capability: entry.capability,
        value: inspectCapturedResult({
          persistence_dir: persistenceRoot,
          campaign_id: envelope.query.campaign_id,
          node_id: envelope.query.node_id,
          ...(envelope.query.max_patch_bytes === undefined ? {} : { max_patch_bytes: envelope.query.max_patch_bytes }),
        }),
      };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private executeHarnessSessionQuery(envelope: HarnessSessionQueryEnvelope): RuntimeRouterResult<unknown> {
    const entry = catalogEntry(envelope.query.kind, "query");
    const failures = validateHarnessSessionQuery(envelope);
    if (failures.length) return this.failure("validation", "invalid harness session query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    if (!this.runtime.hasHarnessSessionSource()) return this.failure("unavailable", "no durable or live harness session source is available", undefined, entry.capability);
    const q = envelope.query;
    if (q.kind === "harness.session.list") {
      const limit = q.limit ?? 100;
      const ordered = (this.runtime.listHarnessSessions(q.campaign_id) ?? []).slice().sort((left, right) => String(left.session_id).localeCompare(String(right.session_id)));
      const remaining = q.cursor === undefined ? ordered : ordered.filter((session) => String(session.session_id).localeCompare(q.cursor!) > 0);
      const sessions = remaining.slice(0, limit);
      return { ok: true, capability: entry.capability, value: { sessions, next_cursor: remaining.length > sessions.length ? String(sessions.at(-1)?.session_id) : null, diagnostics: this.runtime.harnessSessions?.replayDiagnostics() ?? [] } };
    }
    if (q.kind === "harness.session.inspect") {
      const session = this.runtime.inspectHarnessSession(q.session_id!);
      return session === null
        ? this.failure("conflict", `harness session ${q.session_id} was not found`, undefined, entry.capability)
        : {
            ok: true,
            capability: entry.capability,
            // Terminal evidence manifests are read-only redacted projections.
            // They deliberately are not a session continuation/replay handle.
            value: {
              ...session,
              tool_audits: this.runtime.harnessSessionToolAudits(q.session_id!, 50),
              artifacts: this.runtime.harnessSessionArtifacts(q.session_id!, 50),
            },
          };
    }
    if (q.kind === "harness.session.attach") {
      const session = this.runtime.inspectHarnessSession(q.session_id!);
      const events = this.runtime.harnessSessionEvents(q.session_id!, q.after_sequence, q.limit);
      if (session === null || events === null) return this.failure("conflict", `harness session ${q.session_id} was not found`, undefined, entry.capability);
      const live = this.runtime.nativeSessionRegistry.inspect(q.session_id!);
      return { ok: true, capability: entry.capability, value: { session, events, live: live !== null, pending_steering: live?.pending_steering ?? 0, next_after_sequence: events.at(-1)?.sequence ?? q.after_sequence ?? 0 } };
    }
    if (q.kind === "harness.session.availability") return { ok: true, capability: entry.capability, value: { session_id: q.session_id, ...this.runtime.sessionContinuationAvailability(q.session_id!) } };
    const events = this.runtime.harnessSessionEvents(q.session_id!, q.after_sequence, q.limit);
    return events === null
      ? this.failure("conflict", `harness session ${q.session_id} was not found`, undefined, entry.capability)
      : { ok: true, capability: entry.capability, value: { session_id: q.session_id, events } };
  }

  /**
   * One canonical, read-only meta-harness inventory.  It deliberately reports
   * a connector fallback as *unattested* instead of treating the presence of
   * an OpenCode code path as evidence that an external binary/provider is
   * healthy.  Direct-native selection comes from the same negotiation that
   * production campaign.run performs.
   */
  private executeHarnessConnectorInventoryQuery(envelope: HarnessConnectorInventoryQueryEnvelope): RuntimeRouterResult<HarnessConnectorInventoryProjection> {
    const entry = catalogEntry("harness.connector.inventory", "query");
    const failures = validateHarnessConnectorInventoryQuery(envelope);
    if (failures.length) return this.failure("validation", "invalid harness connector inventory query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const requirements = DEFAULT_DIRECT_NATIVE_CAMPAIGN_REQUIREMENTS.map((requirement) => ({ ...requirement }));
    const selection = this.runtime.selectHarnessConnector(requirements);
    // Connector negotiation alone cannot distinguish “nothing configured”
    // from explicit native mode that failed composition: in both cases no
    // native descriptor is registered. The CLI runner does distinguish them,
    // so surface the same read-only readiness decision here rather than
    // falsely advertising OpenCode fallback for a campaign that will refuse
    // to dispatch.
    const nativeReadiness = this.runtime.nativeHarnessReadiness?.inspect().execution;
    const selected_execution = nativeReadiness?.kind === "unavailable"
      ? {
          kind: "unavailable" as const,
          connector_id: "revoy-native" as const,
          readiness: "blocked" as const,
          reason: `explicit direct-native execution is unavailable: ${nativeReadiness.reason}`,
        }
      : selection.kind === "selected"
      ? { kind: "direct_native" as const, connector_id: selection.connector.connector_id, readiness: "selected" as const, reason: null }
      : {
          kind: "connector_fallback" as const,
          connector_id: "opencode" as const,
          readiness: "fallback_unattested" as const,
          reason: selection.reason === "not_configured"
            ? "no direct-native connector is configured"
            : `direct-native admission unavailable: ${selection.reason}`,
        };
    const safeSelection = selection.kind === "selected"
      ? Object.freeze({ kind: "selected" as const, connector_id: selection.connector.connector_id })
      : Object.freeze({
          kind: "unavailable" as const,
          reason: selection.reason,
          candidates: Object.freeze(selection.candidates.map((candidate) => Object.freeze({
            connector_id: candidate.connector.connector_id,
            health: candidate.connector.health,
            admitted: candidate.negotiation.admitted,
            rejected: Object.freeze(candidate.negotiation.rejected.map((rejection) => Object.freeze({
              capability: rejection.requirement.capability,
              reason: rejection.reason,
              observed_grade: rejection.support?.grade ?? null,
            }))),
          }))),
        });
    const connectors = this.runtime.listHarnessConnectors().map((connector) => Object.freeze({
      connector_id: connector.connector_id,
      implementation_version: connector.implementation_version,
      supported_upstream_range: connector.supported_upstream_range,
      health: connector.health,
      // Free-form connector diagnostic and evidence detail can contain
      // upstream/provider material. Inventory needs grades/readiness, not
      // transcripts or opaque diagnostics, so omit them structurally.
      capabilities: Object.freeze(connector.capabilities.map((capability) => Object.freeze({
        capability: capability.capability,
        grade: capability.grade,
        observed_at: capability.evidence.observed_at,
      }))),
    }));
    return {
      ok: true,
      capability: entry.capability,
      value: Object.freeze({
        requirements: Object.freeze(requirements),
        connectors: Object.freeze(connectors),
        selection: safeSelection,
        selected_execution: Object.freeze(selected_execution),
      }),
    };
  }

  private executeNativeHarnessReadinessQuery(envelope: NativeHarnessReadinessQueryEnvelope): RuntimeRouterResult<unknown> {
    const entry = catalogEntry("harness.native.readiness", "query");
    const failures = validateNativeHarnessReadinessQuery(envelope);
    if (failures.length) return this.failure("validation", "invalid native harness readiness query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    if (this.runtime.nativeHarnessReadiness === null) return this.failure("unavailable", "native harness readiness is not composed by this host", undefined, entry.capability);
    return { ok: true, capability: entry.capability, value: this.runtime.nativeHarnessReadiness.inspect() };
  }

  private executeNativeCampaignBudgetQuery(envelope: NativeCampaignBudgetQueryEnvelope): RuntimeRouterResult<NativeCampaignBudgetProjection> {
    const entry = catalogEntry("native.budget.get", "query");
    const failures = validateNativeCampaignBudgetQuery(envelope);
    if (failures.length) return this.failure("validation", "invalid native campaign budget query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const campaign_id = envelope.query.campaign_id;
    const snapshot = this.runtime.nativeCampaignBudget.snapshot(campaign_id);
    return {
      ok: true,
      capability: entry.capability,
      value: snapshot === null
        ? { availability: "unconfigured", campaign_id }
        : { availability: "configured", ...snapshot },
    };
  }

  private dispatchHarnessSessionInterrupt(envelope: HarnessSessionInterruptEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const entry = catalogEntry("harness.session.interrupt", "command"); const failures = validateHarnessSessionInterrupt(envelope);
    if (failures.length) return this.failure("validation", "invalid harness session interruption", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const interruption = this.runtime.nativeSessionRegistry.interrupt(envelope.command.session_id, envelope.command.reason);
    if (interruption.kind === "not_found") {
      const known = this.runtime.inspectHarnessSession(envelope.command.session_id);
      if (known?.terminal) return this.failure("conflict", `harness session ${known.session_id} is already terminal`, undefined, entry.capability);
      return this.failure("unavailable", `harness session ${envelope.command.session_id} is not live in this runtime`, undefined, entry.capability);
    }
    // The controller is the session-scoped cancellation authority. Never
    // substitute campaign/node interruption here: that could stop unrelated
    // work and would falsely claim a session-specific round trip.
    this.runtime.harnessSessions?.markInterruptRequested(envelope.command.session_id);
    return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id } };
  }

  private dispatchHarnessSessionSteer(envelope: HarnessSessionSteerEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const entry = catalogEntry("harness.session.steer", "command"); const failures = validateHarnessSessionSteer(envelope);
    if (failures.length) return this.failure("validation", "invalid harness session steering", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const result = this.runtime.nativeSessionRegistry.steer(envelope.command.session_id, envelope.metadata.operation_id, envelope.command.message, envelope.command.provenance);
    if (result.kind === "not_found") return this.failure("unavailable", `harness session ${envelope.command.session_id} is not live in this runtime`, undefined, entry.capability);
    if (result.kind === "terminal") return this.failure("conflict", `harness session ${envelope.command.session_id} is terminal or stopping`, undefined, entry.capability);
    if (result.kind === "full") return this.failure("conflict", `harness session ${envelope.command.session_id} steering inbox is full`, undefined, entry.capability);
    return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id } };
  }

  private dispatchHarnessSessionContinuation(envelope: HarnessSessionContinuationEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const failures = validateHarnessSessionContinuation(envelope); const entry = catalogEntry(envelope.command.kind, "command");
    if (failures.length) return this.failure("validation", "invalid harness session continuation", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const service = this.runtime.recoveryService; const plan = service?.previewSession(envelope.command.session_id) ?? null;
    if (service === null || plan === null) return this.failure("unavailable", "terminal session continuation is not configured", undefined, entry.capability);
    if (envelope.command.kind !== "harness.session.fork") {
      const recoverable = service.previewContinuation(plan.campaign_id, plan.node_id).some((candidate) => candidate.source_session_id === plan.source_session_id);
      if (!recoverable) return this.failure("conflict", "resume and respawn require a governed interrupted source session", undefined, entry.capability);
      const result = runRecoveryCommand({ runtime: this.runtime, campaign_id: plan.campaign_id, node_id: plan.node_id, authorize: true, actor_id: envelope.metadata.actor_id, reason: envelope.command.reason, dispositions: envelope.command.dispositions, continuation_kind: envelope.command.kind === "harness.session.respawn" ? "respawn" : "resume" });
      return !result.ok ? this.failure("conflict", result.reason, undefined, entry.capability) : { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id } };
    }
    const existing = this.runtime.harnessSessions?.continuationByIdempotencyKey(envelope.metadata.idempotency_key);
    if (existing !== null && existing !== undefined) {
      if (existing.continuation_kind !== "fork" || existing.source_session_id !== plan.source_session_id) return this.failure("conflict", "idempotency key names a different continuation", undefined, entry.capability);
      // A durable authorization proves that this fork was once admitted; it
      // does not prove that its worktree lease is still live and isolated or
      // that the accepted recovery task still belongs to this run. Never
      // redispatch solely from the journal record on an idempotent replay.
      return this.failure("conflict", "durable fork authorization replay cannot establish a current isolated lease and registered supervisor task", undefined, entry.capability);
    }
    const snapshot = this.runtime.manager.getCampaignSnapshot(plan.campaign_id); const source = snapshot?.nodes.find((node) => node.id === plan.node_id);
    if (!source) return this.failure("conflict", "source campaign node was not found", undefined, entry.capability);
    if (!["verified", "claimed", "failed", "pruned", "abandoned"].includes(source.state)) return this.failure("conflict", "fork requires a terminal source node", undefined, entry.capability);
    // A fork dispatches through the ordinary supervised campaign run, whose
    // node selection never picks anything once the campaign has halted.
    // A `no_nodes` or `converged` halt means the search ran out, which is
    // exactly when an operator forks to try another direction: the fork
    // reopens it (ADR-043 amendment, fork reopen). Every other halt — budget
    // above all, and an audited manual stop — stays closed, and is refused
    // here, with its typed remedy, before any child, authorization or lease
    // exists for a session that could never start.
    const reopening = snapshot!.halted;
    if (reopening) {
      const preview = this.runtime.manager.forkReopenPreview(plan.campaign_id, plan.node_id);
      if (preview.kind === "refused") {
        const summary = `fork cannot dispatch: ${preview.detail}`;
        return { ok: false, capability: entry.capability, error: routerError("conflict", summary, undefined, undefined, haltedForkRefusal(preview.code, preview.halt_reason, summary)) };
      }
    } else {
      // A fork from a non-halted campaign is subject to the same selection
      // rule: a child under a failed/pruned/abandoned node that is not the
      // only pending node is never selected, so the authorized session
      // would strand. Refuse before any child, authorization or lease exists.
      const unselectable = this.runtime.manager.forkChildSelectionRefusal(plan.campaign_id, plan.node_id);
      if (unselectable !== null) {
        const summary = `fork cannot dispatch: ${unselectable}`;
        return { ok: false, capability: entry.capability, error: routerError("conflict", summary, undefined, undefined, haltedForkRefusal("fork_child_unselectable", null, summary)) };
      }
    }
    let childId: string | null = null;
    let authorizationId: string | null = null;
    let reopened = false;
    const discardForkTarget = (): string | null => {
      // Re-halt first: a crash after this leaves a halted campaign with an
      // orphan pending child (inert), never an open campaign with nothing to
      // run (which `reconcileForkReopens` would otherwise have to repair).
      if (reopened) {
        const reverted = this.runtime.manager.revertForkReopen(plan.campaign_id, envelope.metadata.operation_id, "the fork did not reach dispatch");
        if (!reverted.ok) return reverted.detail;
      }
      if (authorizationId !== null) {
        const cancelled = this.runtime.harnessSessions?.cancelContinuationAuthorization(authorizationId);
        if (cancelled !== undefined && !cancelled.ok) return cancelled.reason;
      }
      if (childId !== null) this.runtime.manager.prune(plan.campaign_id, childId);
      return null;
    };
    try {
      childId = this.runtime.manager.branch(plan.campaign_id, plan.node_id, [{
        description: source.action_description,
        category: source.action_category as import("@arbor/core").Action["category"],
        delegate_to: source.action_delegate,
        estimated_gain: source.action_estimated_gain,
        estimated_cost: source.action_estimated_cost,
      }])[0] ?? null;
      if (childId === null) return this.failure("conflict", "fork did not create a pending child", undefined, entry.capability);
      // The child is branched before the reopen, so the durable reopen record
      // always names a pending node that exists.
      if (reopening) {
        const reopen = this.runtime.manager.reopenForFork(plan.campaign_id, { operation_id: envelope.metadata.operation_id, actor_id: envelope.metadata.actor_id, source_session_id: plan.source_session_id, fork_node_id: childId, reason: envelope.command.reason });
        if (!reopen.ok) {
          const cleanupFailure = discardForkTarget();
          return this.failure("conflict", cleanupFailure === null ? `fork cannot dispatch: ${reopen.detail}` : `fork cannot dispatch: ${reopen.detail}; ${cleanupFailure}`, undefined, entry.capability);
        }
        reopened = true;
      }
      const forkAuthorizationId = `fork-${createHash("sha256").update(`${envelope.metadata.idempotency_key}:${plan.source_session_id}:${childId}`).digest("hex").slice(0, 32)}`;
      authorizationId = forkAuthorizationId;
      const prepared = service.prepareFork(plan, childId, { authorization_id: forkAuthorizationId, idempotency_key: envelope.metadata.idempotency_key, operation_id: envelope.metadata.operation_id, expected_version: this.runtime.manager.getCampaignVersion(plan.campaign_id), actor_id: envelope.metadata.actor_id, actor_role: "operator", reason: envelope.command.reason, dispositions: envelope.command.dispositions, authorized_at: new Date().toISOString(), continuation_kind: "fork" });
      if (prepared.status !== "ready") {
        const cleanupFailure = discardForkTarget();
        return this.failure(prepared.status === "conflict" ? "conflict" : "unavailable", cleanupFailure === null ? prepared.reason : `${prepared.reason}; ${cleanupFailure}`, undefined, entry.capability);
      }
      const dispatched = this.runtime.runPreparedContinuation(plan.campaign_id, prepared.authorization.authorization_id);
      if (!dispatched.ok) {
        const cleanupFailure = discardForkTarget();
        return this.failure("conflict", cleanupFailure === null ? dispatched.reason : `${dispatched.reason}; ${cleanupFailure}`, undefined, entry.capability);
      }
      return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      let cleanupFailure: string | null = null;
      try { cleanupFailure = discardForkTarget(); }
      catch (cleanupError) { cleanupFailure = cleanupError instanceof Error ? cleanupError.message : String(cleanupError); }
      return this.failure("conflict", cleanupFailure === null ? reason : `${reason}; ${cleanupFailure}`, undefined, entry.capability);
    }
  }

  private executeCapabilityIntrospection(input: import("./capability-contracts.js").CapabilityIntrospectionQueryEnvelope): RuntimeRouterResult<CapabilityIntrospectionProjection> {
    const entry = catalogEntry("capability.introspect", "query");
    const failures = validateCapabilityIntrospectionQuery(input);
    if (failures.length > 0) return this.failure("validation", "invalid capability introspection query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const tiers: CapabilityTier[] = ["junior", "senior"];
    return {
      ok: true,
      capability: entry.capability,
      value: {
        action_classes: [...ACTION_CLASSES],
        catalog: RUNTIME_CATALOG.map((candidate) => {
          const actionClass = catalogActionClass(candidate);
          const minimum = requiredCapability(actionClass);
          return {
            kind: candidate.kind, direction: candidate.direction, capability: candidate.capability, supported: candidate.supported,
            ...(candidate.supported ? {} : { unavailable_reason: (candidate as { unavailable_reason?: string }).unavailable_reason }),
            action_class: actionClass, mutating: isMutating(actionClass), minimum_tier: minimum,
          };
        }),
        tiers: tiers.map((tier) => ({ tier, entitled_action_classes: entitledActionClasses(tier) })),
      },
    };
  }

  /**
   * G-29 closure: cards and foregrounds are derived from one fresh manager
   * snapshot. They never read an event cache or a separately persisted card,
   * so a tree mutation is visible to every transport on its next query.
   */
  private executeLiveProjectionQuery(envelope: LiveProjectionQueryEnvelope): RuntimeRouterResult<NodeCardProjection | ForegroundProjectionResult | A2ACardsProjection> {
    const entry = catalogEntry(envelope.query.kind, "query");
    const failures = validateLiveProjectionQuery(envelope);
    if (failures.length) return this.failure("validation", "invalid live projection query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const snapshot = this.runtime.manager.getCampaignSnapshot(envelope.query.campaign_id);
    if (!snapshot) return this.failure("conflict", `campaign ${envelope.query.campaign_id} was not found`, undefined, entry.capability);
    try {
      if (envelope.query.kind === "a2a.cards") {
        if (!this.options.a2a_bridge) {
          return this.failure("unavailable", "A2A card publication is not configured", undefined, entry.capability);
        }
        const bridge = this.options.a2a_bridge;
        const cards = snapshot.nodes.map((node) => {
          const card = publishNodeCardAsA2A(this.deriveLiveNodeCard(node), bridge!);
          // A configured bridge validates its own emitted authentication
          // material before exposing it. This is not peer/network transport;
          // it is a fail-closed guard on the typed local projection.
          if (!verifyA2AAgentCard(card, bridge!.signing_secret)) {
            throw new Error("configured a2a bridge produced an unverifiable agent card");
          }
          return card;
        });
        return { ok: true, capability: entry.capability, value: { campaign_id: snapshot.id, cards } };
      }
      const nodeId = envelope.query.node_id;
      const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return this.failure("conflict", `node ${nodeId} was not found in campaign ${snapshot.id}`, undefined, entry.capability);
      if (envelope.query.kind === "nodecard.resolve") {
        return { ok: true, capability: entry.capability, value: { campaign_id: snapshot.id, node_id: node.id, card: this.deriveLiveNodeCard(node) } };
      }
      if (envelope.query.kind === "foreground.derive" && !Object.hasOwn(CAPABILITY_TIER, node.action_delegate)) {
        return this.failure("unavailable", `node ${node.id} delegates to ${node.action_delegate}, which has no configured botanical foreground`, undefined, entry.capability);
      }
      const agent = node.action_delegate as Parameters<typeof deriveDispatchForeground>[0];
      const configured = this.runtime.agentConfig[agent]?.foreground;
      const overrides = configured === undefined ? undefined : {
        ...(configured.modes === undefined ? {} : { modes: new Set(configured.modes) }),
        ...(configured.inputs === undefined ? {} : { inputs: configured.inputs }),
        ...(configured.outputs === undefined ? {} : { outputs: configured.outputs }),
      };
      const modelOverrides = Object.fromEntries(Object.entries(this.runtime.agentConfig).map(([name, value]) => [name, value.model]));
      return {
        ok: true,
        capability: entry.capability,
        value: { campaign_id: snapshot.id, node_id: node.id, foreground: deriveDispatchForeground(agent, node.id, overrides, undefined, modelOverrides) },
      };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private deriveLiveNodeCard(node: {
    id: string; action_description: string; action_category: string; action_delegate: string;
  }) {
    return deriveCandidateNodeCard(node, DEFAULT_NODE_CARD_SECRET);
  }

  private dispatchSurveillanceScan(envelope: SurveillanceScanCommandEnvelope): RuntimeRouterResult<SurveillanceScanAcknowledgement | CommandAcknowledgement> {
    const entry = catalogEntry("surveillance.scan", "command");
    const failures = validateSurveillanceScan(envelope);
    if (failures.length) return this.failure("validation", "invalid surveillance scan command", failures.join("; "));
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    const reject = (code: RuntimeError["code"], summary: string): RuntimeRouterResult<CommandAcknowledgement> => {
      const error = routerError(code, summary, undefined, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, error);
      this.runtime.checkpointOperations();
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error }, capability: entry.capability };
    };
    if (!this.authorized(entry)) return reject("permission", this.denialSummary(entry));
    const scan = this.runtime.scanSurveillance(envelope.command.campaign_id, envelope.command.as_of);
    if (!scan.ok || scan.value === null) {
      const failure = scan.failures.at(-1);
      return reject(failure?.code ?? "internal", failure?.summary ?? "surveillance scan failed");
    }
    this.runtime.operations.complete(envelope.metadata.operation_id, `surveillance scan recorded ${scan.value.newly_recorded.length} new findings`);
    this.runtime.checkpointOperations();
    return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id, scanned_at: scan.value.scanned_at, finding_count: scan.value.findings.length, newly_recorded_count: scan.value.newly_recorded.length } };
  }

  private executeSurveillanceQuery(envelope: SurveillanceFindingsQueryEnvelope): RuntimeRouterResult<SurveillanceFindingsProjection> {
    const entry = catalogEntry("surveillance.findings", "query");
    const failures = validateSurveillanceQuery(envelope);
    if (failures.length) return this.failure("validation", "invalid surveillance findings query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try { return { ok: true, capability: entry.capability, value: { campaign_id: envelope.query.campaign_id, findings: this.runtime.surveillance.query(envelope.query.campaign_id, envelope.query.limit) } }; }
    catch (error) { return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) }; }
  }

  private dispatchOutputCapture(envelope: OutputCaptureCommandEnvelope): RuntimeRouterResult<OutputCaptureAcknowledgement | CommandAcknowledgement> {
    const entry = catalogEntry("output.capture", "command");
    const failures = validateOutputCapture(envelope);
    if (failures.length) return this.failure("validation", "invalid output capture command", failures.join("; "));
    let operation: OperationRecord;
    try {
      const fingerprint = createHash("sha256").update(JSON.stringify(envelope.command)).digest("hex");
      operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: `output.capture:${fingerprint}` });
    }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    const reject = (code: RuntimeError["code"], summary: string): RuntimeRouterResult<CommandAcknowledgement> => {
      const error = routerError(code, summary, undefined, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, error);
      this.runtime.checkpointOperations();
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error }, capability: entry.capability };
    };
    if (!this.authorized(entry)) return reject("permission", this.denialSummary(entry));
    if (!this.runtime.outputEvidence) return reject("unavailable", "output evidence persistence is not configured");
    try {
      const descriptor = this.runtime.outputEvidence.put({ ...envelope.command.artifact, operation_id: envelope.metadata.operation_id }, envelope.command.content);
      const preview: OutputDescriptorProjection = {
        descriptor,
        preview: abbreviateOutput(envelope.command.content, DEFAULT_OUTPUT_POLICY.preview),
      };
      this.runtime.operations.complete(envelope.metadata.operation_id, `output evidence ${descriptor.id} captured`);
      this.runtime.checkpointOperations();
      return { ok: true, value: { accepted: true, operation_id: envelope.metadata.operation_id, output: preview }, capability: entry.capability };
    } catch (error) {
      const mapped = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, mapped);
      this.runtime.checkpointOperations();
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: mapped }, capability: entry.capability };
    }
  }

  private executeOutputQuery(envelope: OutputQueryEnvelope): RuntimeRouterResult<OutputDescriptorQueryProjection | OutputLiveSessionDescriptorProjection | { evidence_id: string; content: string }> {
    const entry = catalogEntry(envelope.query.kind, "query");
    const failures = validateOutputQuery(envelope);
    if (failures.length) return this.failure("validation", "invalid output query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      if (envelope.query.kind === "output.raw") {
        if (!this.runtime.outputEvidence) return this.failure("unavailable", "output evidence persistence is not configured", undefined, entry.capability);
        const session = this.rawQuerySession(envelope);
        if (!session.ok) return this.failure("permission", `raw output session denied: ${session.error}`, undefined, entry.capability);
        const authority = verifyApprovedAuthority(
          this.runtime.approvals.get(envelope.query.approval_id),
          { action: "output.raw", resource_id: envelope.query.evidence_id },
          this.runtime.approvals.now(),
        );
        if (!authority.ok) {
          // The approval record is this read's only authority, so the remedy
          // is to obtain one, never to re-authenticate (ADR-179 amendment
          // 2026-10-06). Attached here so no transport re-derives it from text.
          const summary = `raw output approval denied: ${authority.error}`;
          return { ok: false, capability: entry.capability, error: routerError("permission", summary, undefined, undefined, projectApprovalRefusal("output.raw", summary)) };
        }
        const rawAuthorization: RawOutputAuthorization = {
          actor: session.actor_id,
          capability: "auditor",
          reason: authority.record.rationale,
        };
        const bytes = this.runtime.outputEvidence.readRaw(envelope.query.evidence_id, rawAuthorization);
        return { ok: true, capability: entry.capability, value: { evidence_id: envelope.query.evidence_id, content: Buffer.from(bytes).toString("utf8") } };
      }
      // ADR-104 O4: an `evidence_id` that resolves (via `liveSessionEvidenceId`)
      // to a currently live native session is checked before the persisted
      // evidence store -- there is no persisted record yet for a turn that
      // has not finished (`output.capture` writes one whole finished blob
      // in a single shot; nothing writes partial content mid-stream). A
      // live session has no real evidence id (`validateOutputQuery`'s
      // `out_[a-f0-9]{64}` regex is a real content-hash format a raw
      // session id never matches), so `output.list` below hands the screen
      // a derived id in that same shape; this is where it is resolved back.
      // `nativeSessionRegistry` is process-local and never persists, so
      // this is strictly additive: a settled session's descriptor is found
      // through the ordinary path below once its output is actually
      // captured.
      const liveSession = this.runtime.nativeSessionRegistry.list().find((session) => liveSessionEvidenceId(session.session_id) === envelope.query.evidence_id);
      if (liveSession !== undefined) {
        const content = this.runtime.nativeSessionRegistry.preview(liveSession.session_id) ?? "";
        return { ok: true, capability: entry.capability, value: { evidence_id: envelope.query.evidence_id, preview: { content, in_progress: true } } };
      }
      if (!this.runtime.outputEvidence) return this.failure("unavailable", "output evidence persistence is not configured", undefined, entry.capability);
      const descriptor = this.runtime.outputEvidence.getRecord(envelope.query.evidence_id);
      if (!descriptor) throw new Error(`output evidence ${envelope.query.evidence_id} was not found`);
      // Descriptor reads never carry an approval id, therefore must never
      // disclose a blob-derived preview. Raw review is a separate, durable
      // approval-bound query above.
      return { ok: true, capability: entry.capability, value: { descriptor } };
    } catch (error) { return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) }; }
  }

  /**
   * `output.list` — enumerates persisted output evidence via the store's own
   * `list()`, so the `output` screen has an honest query to issue with no
   * `evidence_id` required, closing the gap `output.descriptor`/`output.raw`
   * left open. Descriptor records only; blob bytes stay behind `output.raw`.
   *
   * ADR-104 O4: every currently-live native session is listed first, ahead
   * of settled captures -- an operator watching a running turn should not
   * have to page past finished output to find it. These rows are honestly
   * distinct from `OutputListEntry`: `nativeSessionRegistry` is a
   * process-local live control plane, never a persisted, hashed,
   * content-addressed record, so they carry `status: "in_progress"` and a
   * plain `record` shape rather than pretending to be a sealed
   * `OutputArtifactRecord`.
   */
  private executeOutputListQuery(envelope: OutputListQueryEnvelope): RuntimeRouterResult<readonly (OutputListProjection[number] | LiveSessionOutputListEntry)[]> {
    const entry = catalogEntry("output.list", "query");
    const failures = validateOutputListQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid output list query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    if (!this.runtime.outputEvidence) return this.failure("unavailable", "output evidence persistence is not configured", undefined, entry.capability);
    try {
      const live: readonly LiveSessionOutputListEntry[] = this.runtime.nativeSessionRegistry.list().map((session) => ({
        status: "in_progress" as const,
        record: {
          // A raw native session id (`${campaign_id}:${node_id}:${operation}:${uuid}`)
          // never matches `validateOutputQuery`'s real content-hash
          // `out_[a-f0-9]{64}` format, so this is a derived id in that same
          // shape -- resolved back to the live session in `executeOutputQuery`
          // above -- rather than a claim that this row has a real content
          // hash.
          id: liveSessionEvidenceId(session.session_id),
          operation_id: `native-session:${session.session_id}`,
          campaign_id: session.campaign_id,
          node_id: session.node_id,
          stream: "model" as const,
          byte_count: this.runtime.nativeSessionRegistry.preview(session.session_id)?.length ?? 0,
        },
      }));
      const settled = this.runtime.outputEvidence.list({ limit: envelope.query.limit });
      const combined = [...live, ...settled];
      const value = envelope.query.limit === undefined ? combined : combined.slice(0, envelope.query.limit);
      return { ok: true, capability: entry.capability, value };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /**
   * `governance.snapshot` — projects the real `decisions/` corpus. Returns the
   * builder's own GovernanceResult envelope contents; a build failure is a
   * real `unavailable`, never an empty snapshot that would read as "nothing
   * to govern".
   */
  private executeGovernanceQuery(envelope: GovernanceQueryEnvelope): RuntimeRouterResult<unknown> {
    const entry = catalogEntry("governance.snapshot", "query");
    const failures = validateGovernanceQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid governance query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      // Clock injected at the boundary, keeping buildGovernanceSnapshot pure.
      const result = buildGovernanceSnapshot({
        repo_root: envelope.query.repo_root ?? process.cwd(),
        at: new Date().toISOString(),
        max_records: envelope.query.max_records,
      });
      if (!result.ok) return this.failure("unavailable", result.error.message, result.error.at, entry.capability);
      return { ok: true, capability: entry.capability, value: result.value };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /** The live Governance tab's search/reader surface over the canonical ADR corpus. */
  private executeGovernanceRecordQuery(envelope: GovernanceRecordQueryEnvelope): RuntimeRouterResult<unknown> {
    const entry = catalogEntry(envelope.query.kind, "query");
    const failures = validateGovernanceRecordQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid governance record query", failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const result = executeGovernanceRecordQuery(envelope);
      if (!result.ok) return this.failure("unavailable", result.error.message, result.error.at, entry.capability);
      return { ok: true, capability: entry.capability, value: result.value };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /**
   * `governance.backlog` (finding 15) — the same real `decisions/` corpus
   * `governance.snapshot` reads, projected through `deriveBacklog`/
   * `selectNextBacklogItem` instead: the ranked POL-04 work backlog
   * `selfhost.ts` already drives a self-host campaign's next task from.
   */
  private executeGovernanceBacklogQuery(envelope: GovernanceBacklogQueryEnvelope): RuntimeRouterResult<unknown> {
    const entry = catalogEntry("governance.backlog", "query");
    const failures = validateGovernanceBacklogQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid governance backlog query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const result = buildGovernanceBacklog({
        repo_root: envelope.query.repo_root ?? process.cwd(),
        at: envelope.query.at ?? new Date().toISOString(),
      });
      if (!result.ok) return this.failure("unavailable", result.error.message, result.error.at, entry.capability);
      return { ok: true, capability: entry.capability, value: result.value };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /**
   * `project.registry.list` — the real ADR-076 registry, re-verified fresh
   * (see project-registry-projection.ts's doc comment). `envelope.query.project_id`
   * scopes the report to one entry, which IS the "re-check this entry"
   * operator action — the same `verifyRegistryEntry` discharge function
   * either way, never a second evaluation path.
   */
  private executeProjectRegistryListQuery(envelope: ProjectRegistryListQueryEnvelope): RuntimeRouterResult<unknown> {
    const entry = catalogEntry("project.registry.list", "query");
    const failures = validateProjectRegistryListQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid project registry list query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const persistenceDir = this.runtime.persistenceRoot;
    if (persistenceDir === null) return this.failure("unavailable", "no persistence directory is configured for this host", undefined, entry.capability);
    try {
      const value = buildProjectRegistryListProjection(persistenceDir, { project_id: envelope.query.project_id });
      return { ok: true, capability: entry.capability, value };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /**
   * `project.manage` — Roadmap 23 W6's real per-entry gate battery
   * (`manageProjects`, project-manage.ts). Reports only; never writes
   * project-registry.json or any target project's own files.
   */
  private executeProjectManageQuery(envelope: ProjectManageQueryEnvelope): RuntimeRouterResult<unknown> {
    const entry = catalogEntry("project.manage", "query");
    const failures = validateProjectManageQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid project manage query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const persistenceDir = this.runtime.persistenceRoot;
    if (persistenceDir === null) return this.failure("unavailable", "no persistence directory is configured for this host", undefined, entry.capability);
    try {
      const value = manageProjects(persistenceDir);
      return { ok: true, capability: entry.capability, value };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /**
   * `kb.list` (finding 8) — real, capability-gated KB entries for a campaign.
   * Uses the `critic` capability tier (the same tier `webui.ts`/`resources.ts`
   * already grant a read-only diagnostic surface): every entry the KB gates
   * from a `specialist` (critic_only findings) stays visible to an operator
   * inspecting the ledger, matching the "auditor/critic sees everything"
   * discipline AGENTS.md states for those tiers.
   */
  private executeKbListQuery(envelope: KbListQueryEnvelope): RuntimeRouterResult<KbListProjection> {
    const entry = catalogEntry("kb.list", "query");
    const failures = validateKbListQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid kb list query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const filter = envelope.query.type ? { type: envelope.query.type } : null;
      const limit = envelope.query.limit ?? 200;
      const results = this.runtime.manager.kbQuery(envelope.query.campaign_id, filter, { tier: "critic" }).slice(0, limit);
      return { ok: true, capability: entry.capability, value: results };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /**
   * `audit.list` (finding 9) — the real, complete per-campaign evidence
   * ledger `CampaignManager.getAuditRecords` already exposes to in-process
   * observers, now reachable through the catalog.
   */
  private executeAuditListQuery(envelope: AuditListQueryEnvelope): RuntimeRouterResult<AuditListProjection> {
    const entry = catalogEntry("audit.list", "query");
    const failures = validateAuditListQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid audit list query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const limit = envelope.query.limit ?? 200;
      const records = this.runtime.manager.getAuditRecords(envelope.query.campaign_id).slice(0, limit);
      return { ok: true, capability: entry.capability, value: records };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private dispatchCommunication(envelope: CommunicationCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const entry = catalogEntry("communication.record", "command");
    const failures = validateCommunicationCommand(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid communication command", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const operationId = envelope.metadata.operation_id;
    let operation: OperationRecord;
    try {
      operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) });
    } catch (error) {
      return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata);
    }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    try {
      const communication = envelope.command.communication;
      if (communication.idempotency_key !== envelope.metadata.idempotency_key) throw new Error("communication idempotency key must match operation metadata");
      if (!canReadTier(this.options.communication_tier ?? "orchestrator", communication.capability_tier)) throw new Error("communication capability tier exceeds adapter authority");
      this.runtime.manager.recordNodeCommunication({
        campaign_id: envelope.command.campaign_id,
        node_id: envelope.command.node_id,
        ...communication,
      });
      this.runtime.operations.complete(operationId, "communication durably recorded");
      return { ok: true, value: { accepted: true, operation_id: operationId }, capability: entry.capability };
    } catch (error) {
      const runtimeError = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(operationId, runtimeError);
      return { ok: true, value: { accepted: false, operation_id: operationId, error: runtimeError }, capability: entry.capability };
    }
  }

  private executeCommunicationQuery(envelope: CommunicationQueryEnvelope): RuntimeRouterResult<CommunicationProjection> {
    const entry = catalogEntry(envelope.query.kind, "query");
    const failures = validateCommunicationQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid communication query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const tier = this.options.communication_tier ?? "orchestrator";
      const asOf = envelope.query.as_of ?? new Date().toISOString();
      const communications = envelope.query.kind === "communication.selection"
        ? this.runtime.manager.getSelectionCommunications(envelope.query.campaign_id, envelope.query.node_id, tier, { limit: envelope.query.limit, as_of: asOf })
        : this.runtime.manager.getNodeCommunications(envelope.query.campaign_id, envelope.query.node_id, tier, envelope.query.limit);
      // Declare the tier this projection was BUILT for. The view must not
      // re-derive an access decision (ADR-005 puts capability gating at the
      // envelope-construction layer); without this field the Communications
      // screen defaulted to "no tier" and redacted every message from every
      // operator, while the Bus screen showed the same records in full.
      return { ok: true, capability: entry.capability, value: { campaign_id: envelope.query.campaign_id, node_id: envelope.query.node_id, as_of: asOf, consumer_tier: tier, communications } };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private dispatchCompactionRecord(envelope: CompactionCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const entry = catalogEntry("compaction.record", "command");
    const failures = validateCompactionCommand(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid compaction record command", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const operationId = envelope.metadata.operation_id;
    let operation: OperationRecord;
    try {
      operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) });
    } catch (error) {
      return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata);
    }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    try {
      const lifecycle = envelope.command.lifecycle;
      this.runtime.manager.recordCompactionLifecycle({
        campaign_id: envelope.command.campaign_id,
        node_id: envelope.command.node_id,
        ...lifecycle,
      });
      this.runtime.operations.complete(operationId, "compaction lifecycle durably recorded");
      return { ok: true, value: { accepted: true, operation_id: operationId }, capability: entry.capability };
    } catch (error) {
      const runtimeError = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(operationId, runtimeError);
      return { ok: true, value: { accepted: false, operation_id: operationId, error: runtimeError }, capability: entry.capability };
    }
  }

  /** Governed RLM/ACE/continual-harness mutations share the canonical operation/idempotency boundary. */
  private dispatchGovernedContext(envelope: GovernedContextCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const entry = catalogEntry(envelope.command.kind, "command");
    const failures = validateGovernedContextCommand(envelope);
    if (failures.length > 0) return this.failure("validation", `invalid ${entry.kind} command`, failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    try {
      const c = envelope.command;
      switch (c.kind) {
        case "context.artifact.capture": this.runtime.governedContext.captureArtifact({ ...c.artifact, content: c.content }); break;
        case "fold.propose": this.runtime.governedContext.proposeFold(c.proposal); break;
        case "fold.approve": this.runtime.governedContext.approveFold(c.fold_id, envelope.metadata.actor_id, c.fidelity_ratio); break;
        case "fold.rollback": this.runtime.governedContext.rollbackFold(c.fold_id, envelope.metadata.actor_id); break;
        case "playbook.propose": this.runtime.governedContext.proposePlaybook(c.delta); break;
        case "playbook.approve": this.runtime.governedContext.approvePlaybook(c.delta_id, envelope.metadata.actor_id); break;
        case "harness.propose": this.runtime.governedContext.proposeRevision(c.revision); break;
        case "harness.approve": this.runtime.governedContext.approveRevision(c.revision_id, envelope.metadata.actor_id); break;
        case "harness.rollback": this.runtime.governedContext.rollbackRevision(c.revision_id, envelope.metadata.actor_id); break;
        case "harness.evaluate": this.runtime.governedContext.recordEvaluation(c.revision_id, c.evaluation); break;
        case "harness.promote": this.runtime.governedContext.promoteRevision(c.revision_id, c.human_approver); break;
        case "harness.quarantine": this.runtime.governedContext.quarantineRevision(c.revision_id, envelope.metadata.actor_id, c.reason, c.evidence_ids); break;
        case "harness.evaluation.start": {
          const evaluator = this.runtime.harnessEvaluator; if (!evaluator) throw new Error("controlled harness evaluator is not composed for this runtime");
          // `OperationRegistry.accept` intentionally returns a live accepted
          // record for same-key retries.  That is normally useful to a
          // synchronous command, but a second evaluator dispatch here would
          // run the same durable run twice. The in-flight controller is the
          // local exactly-once marker; restart has no controller and service
          // reconciliation makes the old run explicitly retryable instead.
          if (this.evaluationAbortControllers.has(envelope.metadata.operation_id)) {
            return { ok: true, value: { accepted: true, operation_id: envelope.metadata.operation_id }, capability: entry.capability };
          }
          const run = this.runtime.governedContext.startEvaluation({ id: `evaluation:${envelope.metadata.operation_id}`, revision_id: c.revision_id, requested_by: envelope.metadata.actor_id, evaluator_id: evaluator.evaluator_id });
          const controller = new AbortController(); this.evaluationAbortControllers.set(envelope.metadata.operation_id, controller);
          void evaluator.evaluate({ revision_id: c.revision_id, run_id: run.id, signal: controller.signal }).then((result) => {
            const cancelled = controller.signal.aborted;
            const settlement = cancelled
              ? { kind: "unmeasured" as const, reason: "controlled evaluation was cancelled" }
              : result.kind === "measured"
                ? { kind: "measured" as const, evaluation: result.evaluation, evidence_ids: result.evidence_ids, detail: result.detail }
                : { kind: "unmeasured" as const, reason: result.reason };
            this.runtime.governedContext.settleEvaluation(run.id, settlement);
            if (!cancelled) this.runtime.operations.complete(envelope.metadata.operation_id, `harness evaluation ${result.kind}`);
          }).catch((error: unknown) => { this.runtime.governedContext.failEvaluation(run.id, errorMessage(error)); if (!controller.signal.aborted) this.rejectOperation(envelope.metadata.operation_id, mapRuntimeBoundaryError(error, envelope.metadata)); }).finally(() => { this.evaluationAbortControllers.delete(envelope.metadata.operation_id); });
          return { ok: true, value: { accepted: true, operation_id: envelope.metadata.operation_id }, capability: entry.capability };
        }
        case "subagent.execute": {
          const executor = this.runtime.declarativeSubagentExecutor;
          if (!executor) throw new Error("declarative subagent execution is not composed for this runtime");
          const identity = declarativeSubagentIdentity({ campaign_id: c.campaign_id, parent_node_id: c.parent_node_id, revision_id: c.revision_id, operation_id: envelope.metadata.operation_id });
          const already = this.runtime.governedContext.listSubagentExecutions(c.campaign_id).some((item) => item.id === identity.execution_id
            || (item.parent_node_id === c.parent_node_id && item.revision_id === c.revision_id));
          const execution = this.runtime.governedContext.requestSubagentExecution({
            id: identity.execution_id, campaign_id: c.campaign_id, parent_node_id: c.parent_node_id, revision_id: c.revision_id,
            requested_by: envelope.metadata.actor_id, child_session_id: identity.child_session_id, worktree_node_id: identity.worktree_node_id,
          });
          if (!already && execution.state === "requested") {
            // Do not await a provider turn on the request router.  The durable
            // request exists before dispatch; its eventual real result/failure
            // settles this same canonical operation and is queryable via the
            // catalog. A restarted process never auto-replays it.
            void executor.execute({ ...identity, campaign_id: c.campaign_id, parent_node_id: c.parent_node_id, revision_id: c.revision_id })
              .then((result) => {
                this.runtime.governedContext.completeSubagentExecution({ id: execution.id, result_artifact_id: result.result_artifact_id, result_provenance: result.result_provenance, evidence_ids: result.evidence_ids });
                this.runtime.operations.complete(envelope.metadata.operation_id, "declarative native child completed");
              })
              .catch((error: unknown) => {
                const reason = errorMessage(error);
                this.runtime.governedContext.failSubagentExecution(execution.id, reason);
                this.rejectOperation(envelope.metadata.operation_id, mapRuntimeBoundaryError(error, envelope.metadata));
              });
            return { ok: true, value: { accepted: true, operation_id: envelope.metadata.operation_id }, capability: entry.capability };
          }
          break;
        }
      }
      this.runtime.operations.complete(envelope.metadata.operation_id, `${c.kind} durably recorded`);
      return { ok: true, value: { accepted: true, operation_id: envelope.metadata.operation_id }, capability: entry.capability };
    } catch (error) {
      const runtimeError = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, runtimeError);
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: runtimeError }, capability: entry.capability };
    }
  }

  private executeGovernedContextQuery(envelope: GovernedContextQueryEnvelope): RuntimeRouterResult<unknown> {
    const entry = catalogEntry(envelope.query.kind, "query");
    const failures = validateGovernedContextQuery(envelope);
    if (failures.length > 0) return this.failure("validation", `invalid ${entry.kind} query`, failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const q = envelope.query;
      if (q.kind === "context.workspace") return { ok: true, capability: entry.capability, value: this.runtime.governedContext.readWorkspace(q) };
      if (q.kind === "context.overlays") return { ok: true, capability: entry.capability, value: this.runtime.governedContext.overlays(q.campaign_id) };
      if (q.kind === "subagent.executions") return { ok: true, capability: entry.capability, value: this.runtime.governedContext.listSubagentExecutions(q.campaign_id) };
      if (q.kind === "harness.evaluation.runs") return { ok: true, capability: entry.capability, value: this.runtime.governedContext.listEvaluationRuns(q.campaign_id) };
      if (q.kind === "harness.evaluation.candidates") return { ok: true, capability: entry.capability, value: this.runtime.governedContext.list(q.campaign_id).revisions.filter((revision) => revision.status === "active" && revision.evaluation.outcome === "not_yet_measured") };
      if (q.kind === "harness.evaluation.detail") { const run = this.runtime.governedContext.getEvaluationRun(q.run_id); if (!run) throw new Error("harness evaluation run was not found"); return { ok: true, capability: entry.capability, value: run }; }
      return { ok: true, capability: entry.capability, value: this.runtime.governedContext.list(q.campaign_id) };
    } catch (error) { return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) }; }
  }

  private executeCompactionQuery(envelope: CompactionQueryEnvelope): RuntimeRouterResult<CompactionListProjection | CompactionGuardProjection> {
    const entry = catalogEntry(envelope.query.kind, "query");
    const failures = validateCompactionQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid compaction query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      if (envelope.query.kind === "compaction.guard") {
        const nodeId = envelope.query.node_id;
        if (!nodeId) return this.failure("validation", "compaction.guard query requires node_id", undefined, entry.capability);
        const result = this.runtime.manager.getCompactionGuard(envelope.query.campaign_id, nodeId);
        return { ok: true, capability: entry.capability, value: { campaign_id: envelope.query.campaign_id, node_id: nodeId, ...result } };
      }
      const records = this.runtime.manager.getCompactionLifecycles(
        envelope.query.campaign_id,
        envelope.query.node_id,
        { as_of: envelope.query.as_of, limit: envelope.query.limit },
      );
      return { ok: true, capability: entry.capability, value: { campaign_id: envelope.query.campaign_id, node_id: envelope.query.node_id, as_of: envelope.query.as_of, records } };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private executePhaseMessageQuery(envelope: PhaseMessageQueryEnvelope): RuntimeRouterResult<PhaseMessageListProjection> {
    // The literal kind, not `envelope.query.kind`. `phase_message` has exactly
    // one catalog entry, so the literal is both accurate and clearer — and
    // gate:registration-integrity's catalogDispatchDrift check scans this file
    // for a literal kind string to establish that a supported entry is really
    // dispatched. A single-kind domain resolved only through a variable is
    // invisible to it, which is precisely the drift the check exists to catch:
    // an entry could be marked supported here with no reachable handler at all.
    // Sibling domains like `compaction` pass incidentally because one of their
    // several kinds appears literally somewhere in this file.
    const entry = catalogEntry("phase_message.list", "query");
    const failures = validatePhaseMessageQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid phase_message query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const records = this.runtime.manager.getPhaseMessages(envelope.query.campaign_id, {
        node_id: envelope.query.node_id, phase: envelope.query.phase, limit: envelope.query.limit,
      });
      return {
        ok: true, capability: entry.capability,
        value: { campaign_id: envelope.query.campaign_id, node_id: envelope.query.node_id, phase: envelope.query.phase, records },
      };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private dispatchUserInput(envelope: UserInputCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement | { accepted: true; operation_id: string; record_id: string }> {
    const entry = catalogEntry(envelope.command.kind, "command");
    const failures = validateUserInputCommand(envelope);
    if (failures.length > 0) return this.failure("validation", `invalid ${entry.kind} command`, failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const operationId = envelope.metadata.operation_id;
    let operation: OperationRecord;
    try {
      operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) });
    } catch (error) {
      return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata);
    }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    try {
      if (envelope.command.kind === "userinput.answer") {
        const answered = this.runtime.manager.answerUserInput(envelope.command.record_id, envelope.command.answer);
        // The answer is durable first; delivery to the still-running asking
        // session (if any) is best-effort and never fails the answer.
        const delivery = deliverUserInputAnswer(this.runtime.nativeSessionRegistry, answered, envelope.command.answer);
        this.runtime.operations.complete(operationId, delivery.delivered ? `user input answer durably recorded and delivered to session ${delivery.session_id}` : "user input answer durably recorded");
        return { ok: true, value: { accepted: true, operation_id: operationId }, capability: entry.capability };
      }
      const id = this.runtime.manager.askForUserInput({
        campaign_id: envelope.command.campaign_id,
        node_id: envelope.command.node_id,
        ...envelope.command.question,
      });
      this.runtime.operations.complete(operationId, `user input requested (${id})`);
      // `record_id` is additive to the base command acknowledgement so a
      // `userinput.ask` caller (notably the native `userinput.ask` tool port,
      // native-tool-host.ts) can address the ledger record it just created
      // without a second round-trip query.
      return { ok: true, value: { accepted: true, operation_id: operationId, record_id: id }, capability: entry.capability };
    } catch (error) {
      const runtimeError = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(operationId, runtimeError);
      return { ok: true, value: { accepted: false, operation_id: operationId, error: runtimeError }, capability: entry.capability };
    }
  }

  private executeUserInputQuery(envelope: UserInputQueryEnvelope): RuntimeRouterResult<UserInputListProjection | UserInputAwaitingProjection> {
    const entry = catalogEntry(envelope.query.kind, "query");
    const failures = validateUserInputQuery(envelope);
    if (failures.length > 0) return this.failure("validation", `invalid ${entry.kind} query`, failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      if (envelope.query.kind === "userinput.awaiting") {
        if (envelope.query.campaign_id === undefined) {
          // Cross-campaign aggregate for the attention feed: every pending
          // (unanswered) request, bounded by the query limit.
          const limit = envelope.query.limit ?? 100;
          const requests: { campaign_id: string; node_id: string; record_id: string; question: string }[] = [];
          for (const campaign of this.runtime.manager.listCampaigns()) {
            if (requests.length >= limit) break;
            const answered = new Set(this.runtime.manager.answeredUserInputIds(campaign.id));
            for (const record of this.runtime.manager.getUserInputs(campaign.id)) {
              if (requests.length >= limit) break;
              if (!answered.has(record.id)) requests.push({ campaign_id: campaign.id, node_id: record.node_id, record_id: record.id, question: record.question.question });
            }
          }
          return { ok: true, capability: entry.capability, value: { awaiting: requests.length > 0, requests } };
        }
        const awaiting = this.runtime.manager.awaitingUserInput(envelope.query.campaign_id!, envelope.query.node_id, "any");
        return { ok: true, capability: entry.capability, value: { campaign_id: envelope.query.campaign_id, node_id: envelope.query.node_id, awaiting } };
      }
      // userinput.list: the validator has already required campaign_id here.
      const records = this.runtime.manager.getUserInputs(
        envelope.query.campaign_id!,
        envelope.query.node_id,
        { limit: envelope.query.limit },
      );
      const answered_record_ids = this.runtime.manager.answeredUserInputIds(envelope.query.campaign_id!, envelope.query.node_id);
      return { ok: true, capability: entry.capability, value: { campaign_id: envelope.query.campaign_id!, node_id: envelope.query.node_id, records, answered_record_ids } };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private dispatchBusRecord(envelope: BusCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const entry = catalogEntry("bus.record", "command");
    const failures = validateBusCommand(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid bus record command", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const operationId = envelope.metadata.operation_id;
    let operation: OperationRecord;
    try {
      operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) });
    } catch (error) {
      return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata);
    }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    try {
      const communication = envelope.command.communication;
      if (communication.idempotency_key !== envelope.metadata.idempotency_key) throw new Error("bus message idempotency key must match operation metadata");
      this.runtime.manager.recordBusMessage({
        campaign_id: envelope.command.campaign_id,
        node_id: envelope.command.node_id,
        ...communication,
      });
      this.runtime.operations.complete(operationId, "bus message durably recorded");
      return { ok: true, value: { accepted: true, operation_id: operationId }, capability: entry.capability };
    } catch (error) {
      const runtimeError = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(operationId, runtimeError);
      return { ok: true, value: { accepted: false, operation_id: operationId, error: runtimeError }, capability: entry.capability };
    }
  }

  private executeBusHistory(envelope: BusQueryEnvelope): RuntimeRouterResult<BusHistoryProjection> {
    const entry = catalogEntry("bus.history", "query");
    const failures = validateBusQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid bus history query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const tier = envelope.query.tier ?? this.options.communication_tier ?? "orchestrator";
      const projection = this.runtime.manager.getConversationBus(envelope.query.campaign_id, {
        as_of: envelope.query.as_of, limit: envelope.query.limit, conversation_id: envelope.query.conversation_id, tier,
      });
      return { ok: true, capability: entry.capability, value: projection };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private dispatchParentChildThreadSend(envelope: ParentChildThreadSendEnvelope): RuntimeRouterResult<ParentChildThreadSendAcknowledgement | CommandAcknowledgement> {
    const entry = catalogEntry("bus.thread.send", "command");
    const failures = validateParentChildThreadSend(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid parent-child thread send", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const operationId = envelope.metadata.operation_id;
    let operation: OperationRecord;
    try {
      operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) });
    } catch (error) {
      return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata);
    }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    try {
      const command = envelope.command;
      const recipient = command.from_node_id === command.parent_node_id ? command.child_node_id : command.parent_node_id;
      const recorded = this.runtime.manager.recordParentChildThreadMessage({
        campaign_id: command.campaign_id,
        node_id: command.from_node_id,
        parent_node_id: command.parent_node_id,
        child_node_id: command.child_node_id,
        expected_thread_version: command.expected_thread_version,
        author_node_id: command.from_node_id,
        recipient_node_id: recipient,
        other_recipient_node_ids: [],
        kind: command.message_kind,
        payload: { content: command.content, provenance: command.provenance, ...(command.evidence_refs === undefined ? {} : { evidence_refs: command.evidence_refs }) },
        capability_tier: command.capability_tier,
        // ADVISORY ONLY today: `trigger_turn` is validated and persisted here and
        // at every other writer (peer channel, A2A bridge, TUI forms) but no
        // source file reads it -- nothing wakes a recipient. Delivery is
        // agent-comms Stage S2 (docs/research/agent-comms/PROPOSAL.md): a
        // ledger-backed per-recipient inbox that injects labelled messages at
        // the turn boundary, where this flag becomes the "inject vs pull-only"
        // switch. Do not build a second delivery path before then.
        trigger_turn: command.trigger_turn ?? true,
        as_of: envelope.metadata.requested_at,
        correlation_id: envelope.metadata.correlation_id,
        idempotency_key: envelope.metadata.idempotency_key,
        acknowledges_communication_id: command.acknowledges_communication_id ?? null,
        retracts_communication_id: command.retracts_communication_id ?? null,
        parent_communication_id: command.parent_communication_id ?? null,
        intent: command.intent ?? "notify",
        reply_to_communication_id: command.reply_to_communication_id ?? null,
        ack_required: command.ack_required ?? false,
        deadline_at: command.deadline_at ?? null,
        ...(envelope.metadata.remote_session === undefined ? {} : { remote_attribution: {
          session_id: envelope.metadata.remote_session.session_id,
          key_id: envelope.metadata.remote_session.key_id,
          certificate_id: envelope.metadata.remote_session.certificate_id,
          nonce: envelope.metadata.remote_session.nonce,
          integrity: envelope.metadata.remote_session.integrity,
          ...(envelope.metadata.remote_session.proof_digest === undefined ? {} : { proof_digest: envelope.metadata.remote_session.proof_digest }),
        } }),
      });
      this.runtime.operations.complete(operationId, `parent-child thread message durably recorded (${recorded.message_id})`);
      this.notifyThreadPush({
        campaign_id: command.campaign_id, thread_id: recorded.thread_id, message_id: recorded.message_id,
        parent_node_id: command.parent_node_id, child_node_id: command.child_node_id, reason: "message_appended",
      });
      return { ok: true, value: { accepted: true, operation_id: operationId, ...recorded, delivery: "durable" }, capability: entry.capability };
    } catch (error) {
      const runtimeError = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(operationId, runtimeError);
      return { ok: true, value: { accepted: false, operation_id: operationId, error: runtimeError }, capability: entry.capability };
    }
  }

  private dispatchParentChildThreadAck(envelope: ParentChildThreadAckEnvelope): RuntimeRouterResult<ParentChildThreadSendAcknowledgement | CommandAcknowledgement> {
    const entry = catalogEntry("bus.thread.ack", "command");
    const failures = validateParentChildThreadAck(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid parent-child thread acknowledgement", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const operationId = envelope.metadata.operation_id;
    let operation: OperationRecord;
    try {
      operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) });
    } catch (error) {
      return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata);
    }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    try {
      const command = envelope.command;
      const recorded = this.runtime.manager.acknowledgeParentChildThreadMessage({
        campaign_id: command.campaign_id, parent_node_id: command.parent_node_id, child_node_id: command.child_node_id,
        from_node_id: command.from_node_id, expected_thread_version: command.expected_thread_version,
        message_id: command.message_id, provenance: command.provenance, capability_tier: command.capability_tier,
        as_of: envelope.metadata.requested_at, correlation_id: envelope.metadata.correlation_id,
        idempotency_key: envelope.metadata.idempotency_key,
        ...(envelope.metadata.remote_session === undefined ? {} : { remote_attribution: {
          session_id: envelope.metadata.remote_session.session_id,
          key_id: envelope.metadata.remote_session.key_id,
          certificate_id: envelope.metadata.remote_session.certificate_id,
          nonce: envelope.metadata.remote_session.nonce,
          integrity: envelope.metadata.remote_session.integrity,
          ...(envelope.metadata.remote_session.proof_digest === undefined ? {} : { proof_digest: envelope.metadata.remote_session.proof_digest }),
        } }),
      });
      this.runtime.operations.complete(operationId, `parent-child thread acknowledgement durably recorded (${recorded.message_id})`);
      this.notifyThreadPush({
        campaign_id: command.campaign_id, thread_id: recorded.thread_id, message_id: recorded.message_id,
        parent_node_id: command.parent_node_id, child_node_id: command.child_node_id, reason: "acknowledgement_appended",
      });
      return { ok: true, value: { accepted: true, operation_id: operationId, ...recorded, delivery: "durable" }, capability: entry.capability };
    } catch (error) {
      const runtimeError = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(operationId, runtimeError);
      return { ok: true, value: { accepted: false, operation_id: operationId, error: runtimeError }, capability: entry.capability };
    }
  }

  private executeParentChildThreadHistory(envelope: ParentChildThreadHistoryEnvelope): RuntimeRouterResult<ParentChildThreadHistoryProjection> {
    const entry = catalogEntry("bus.thread.history", "query");
    const failures = validateParentChildThreadHistory(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid parent-child thread history query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const query = envelope.query;
      const tier = query.tier ?? this.options.communication_tier ?? "orchestrator";
      return { ok: true, capability: entry.capability, value: this.runtime.manager.getParentChildThread(query.campaign_id, query.parent_node_id, query.child_node_id, { as_of: query.as_of, limit: query.limit, tier }) };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /**
   * Push is intentionally after the ledger-backed append and operation
   * completion.  The adapter gets a cursor only; it must query/replay the
   * canonical projection, so duplicate, delayed, or failed wake-ups cannot
   * invent or lose durable history.
   */
  private notifyThreadPush(input: Omit<ParentChildThreadPushEvent, "version">): void {
    const adapter = this.options.thread_push;
    if (!adapter) return;
    try {
      const projection = this.runtime.manager.getParentChildThread(
        input.campaign_id, input.parent_node_id, input.child_node_id, { limit: 1_000, tier: "orchestrator" },
      );
      const result = adapter.notify(Object.freeze({ ...input, version: projection.version }));
      if (result && typeof (result as Promise<void>).then === "function") void (result as Promise<void>).catch(() => undefined);
    } catch {
      // Delivery is an optional optimization.  Never turn a durable message
      // into a failed command because a client wake-up did not succeed.
    }
  }

  private executeSiblingStatus(envelope: SiblingStatusQueryEnvelope): RuntimeRouterResult<SiblingStatusProjection> {
    const entry = catalogEntry("sibling.status", "query");
    const failures = validateSiblingStatusQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid sibling status query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const status = this.runtime.manager.getSiblingStatus(envelope.query.campaign_id, envelope.query.node_id);
      return { ok: true, capability: entry.capability, value: { campaign_id: envelope.query.campaign_id, node_id: envelope.query.node_id, ...status } };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private dispatchSiblingSpawn(envelope: SiblingSpawnEnvelope): RuntimeRouterResult<CommandAcknowledgement & { child_node_id?: string; task_id?: string; worktree_path?: string }> {
    const entry = catalogEntry("sibling.spawn", "command"); const failures=validateSiblingSpawn(envelope);
    if(failures.length) return this.failure("validation","invalid sibling spawn",failures.join("; "));
    if(!this.authorized(entry)) return this.failure("permission",this.denialSummary(entry),undefined,entry.capability);
    if(!this.runtime.siblingSpawner) return this.failure("unavailable","sibling spawning requires a worktree-isolation composition",undefined,entry.capability);
    let op:OperationRecord; try { op=this.runtime.operations.accept({metadata:envelope.metadata,capability:entry.capability,fingerprint:JSON.stringify(envelope.command)}); } catch(error) { return this.failure("conflict",errorMessage(error),undefined,entry.capability,envelope.metadata); }
    if(op.state!=="accepted"&&op.state!=="running") return {ok:true,value:acknowledgementFromOperation(op),capability:entry.capability};
    try { const result=this.runtime.siblingSpawner.spawn({...envelope.command,operation_id:envelope.metadata.operation_id}); this.runtime.checkpointSupervisor(); this.runtime.operations.complete(envelope.metadata.operation_id,"sibling spawned in isolated worktree"); return {ok:true,capability:entry.capability,value:{accepted:true,operation_id:envelope.metadata.operation_id,child_node_id:result.child_node_id,task_id:result.task_id,worktree_path:result.lease.path}}; }
    catch(error) { const mapped=mapRuntimeBoundaryError(error,envelope.metadata); this.rejectOperation(envelope.metadata.operation_id,mapped); return {ok:true,capability:entry.capability,value:{accepted:false,operation_id:envelope.metadata.operation_id,error:mapped}}; }
  }

  private dispatchA2ASend(envelope: A2ASendCommandEnvelope): RuntimeRouterResult<A2ASendAcknowledgement | CommandAcknowledgement> {
    const entry = catalogEntry("a2a.send", "command");
    const failures = validateA2ASendCommand(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid a2a send command", failures.join("; "));
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    const reject = (code: RuntimeError["code"], summary: string): RuntimeRouterResult<CommandAcknowledgement> => {
      const error = routerError(code, summary, undefined, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, error);
      return { ok: true as const, value: { accepted: false as const, operation_id: envelope.metadata.operation_id, error }, capability: entry.capability };
    };
    if (this.options.a2a_bridge === undefined) return reject("unavailable", "a2a bridge is not configured");
    if (!this.authorized(entry)) return reject("permission", this.denialSummary(entry));
    try {
      const communication = envelope.command.communication;
      if (communication.idempotency_key !== envelope.metadata.idempotency_key) throw new Error("a2a send idempotency key must match operation metadata");
      this.runtime.manager.recordNodeCommunication({
        campaign_id: envelope.command.campaign_id,
        node_id: envelope.command.node_id,
        ...communication,
      });
      const message = outboundNodeCommunicationToA2A(communication, this.options.a2a_bridge);
      if (message.task !== undefined) {
        const taskFailures = validateA2ATask(message.task);
        if (taskFailures.length > 0) throw new Error(`configured a2a bridge produced an invalid task: ${taskFailures.join("; ")}`);
      }
      // The internal projection is what revoy2 reasons about; `wire` is that
      // same message rendered in A2A v1.0.0's actual format, so anything
      // speaking the protocol receives a conformant payload rather than
      // revoy2's snake_case DTO. Additive — existing consumers of `message`
      // are untouched.
      const wire = messageToWire(message);
      const wire_task = message.task === undefined ? undefined : taskToWire(message.task);
      this.runtime.operations.complete(envelope.metadata.operation_id, "a2a message durably recorded and projected");
      return {
        ok: true,
        value: { accepted: true, operation_id: envelope.metadata.operation_id, message, wire, ...(wire_task === undefined ? {} : { wire_task }) },
        capability: entry.capability,
      };
    } catch (error) {
      const runtimeError = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, runtimeError);
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: runtimeError }, capability: entry.capability };
    }
  }

  private dispatchA2AReceive(envelope: A2AReceiveCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const entry = catalogEntry("a2a.receive", "command");
    const failures = validateA2AReceiveCommand(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid a2a receive command", failures.join("; "));
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    const reject = (code: RuntimeError["code"], summary: string): RuntimeRouterResult<CommandAcknowledgement> => {
      const error = routerError(code, summary, undefined, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, error);
      return { ok: true as const, value: { accepted: false as const, operation_id: envelope.metadata.operation_id, error }, capability: entry.capability };
    };
    if (this.options.a2a_bridge === undefined) return reject("unavailable", "a2a bridge is not configured");
    if (!this.authorized(entry)) return reject("permission", this.denialSummary(entry));
    try {
      // A peer speaking real A2A hands us v1.0.0 shapes, not revoy2's internal
      // DTO. Accept either: when `wire` is present it is authoritative for the
      // message CONTENT, translated inward here. It is never authoritative for
      // task STATE — that stays derived from ledger-witnessed records, and a
      // peer-asserted state is recorded only as a fidelity note.
      const inboundMessage = envelope.command.wire === undefined
        ? envelope.command.message
        : messageFromWire(envelope.command.wire, {
            author_node_ref: envelope.command.message.author_node_ref,
            as_of: envelope.command.message.as_of,
          });
      const peerState = envelope.command.wire?.metadata?.["arbor.dev/task-state"];
      const peerStateNote = typeof peerState === "string"
        ? ` (peer asserted ${taskStateFromWire(peerState as never)}${wireStateIsLossy(peerState as never) ? ", narrowed" : ""}; not trusted for authority)`
        : "";
      const { communication } = inboundA2AToNodeCommunication(inboundMessage, this.options.a2a_bridge);
      this.runtime.manager.recordNodeCommunication({
        campaign_id: envelope.command.campaign_id,
        node_id: envelope.command.node_id,
        ...communication,
      });
      this.runtime.operations.complete(envelope.metadata.operation_id, `a2a inbound message durably recorded${peerStateNote}`);
      return { ok: true, value: { accepted: true, operation_id: envelope.metadata.operation_id }, capability: entry.capability };
    } catch (error) {
      const runtimeError = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, runtimeError);
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: runtimeError }, capability: entry.capability };
    }
  }

  private executeConfigQuery(envelope: ConfigQueryEnvelope): RuntimeRouterResult<ConfigInspectionProjection> {
    const entry = catalogEntry("config.get", "query");
    const failures = validateConfigQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid config query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      return { ok: true, capability: entry.capability, value: this.runtime.configInspection.inspect() };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private executeAgentQuery(envelope: AgentQueryEnvelope): RuntimeRouterResult<AgentRegistryProjection> {
    const entry = catalogEntry("agent.list", "query");
    const failures = validateAgentQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid agent query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      return { ok: true, capability: entry.capability, value: this.runtime.agentRegistry.reg({ include_terminal: envelope.query.include_terminal }) };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /**
   * `operation.list` — enumerates the canonical `OperationRegistry` (a real
   * bounded snapshot, never a fabricated shape) so the `operations` TUI
   * screen has an honest query to issue with no id required, closing the gap
   * `operation.get`'s per-id requirement left open.
   */
  private executeOperationListQuery(envelope: OperationListQueryEnvelope): RuntimeRouterResult<OperationListProjection> {
    const entry = catalogEntry("operation.list", "query");
    const failures = validateOperationListQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid operation list query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      return { ok: true, capability: entry.capability, value: this.runtime.operations.list(envelope.query.include_terminal ?? false) };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /** M6 structured Inspect route: read-only, canonical, and snapshot-stamped. */
  private executeInspectActionQuery(envelope: InspectActionQueryEnvelope): RuntimeRouterResult<unknown> {
    const entry = catalogEntry("inspect.action", "query");
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    const operation = this.runtime.operations.get(envelope.query.action_id);
    if (operation === undefined) return this.failure("conflict", `action ${envelope.query.action_id} was not found`, undefined, entry.capability);
    return { ok: true, capability: entry.capability, value: {
      snapshot_id: `operation:${operation.operation_id}:${operation.accepted_at}`,
      as_of: operation.completed_at ?? operation.accepted_at,
      action_id: operation.operation_id,
      owner: operation.actor_id,
      attempt_id: operation.task_id,
      lifecycle: operation.state,
      gate_state: null,
      dependencies: [],
      activity: operation.result_summary === null ? [] : [operation.result_summary],
      records: [operation.operation_id],
      evidence_ids: [],
      state: "known",
    } };
  }

  /** Bounded, durable recovery targets for the operator recovery surface. */
  private executeRecoveryPendingQuery(envelope: RecoveryPendingQueryEnvelope): RuntimeRouterResult<RecoveryPendingProjection> {
    const entry = catalogEntry("recovery.pending", "query");
    const failures = validateRecoveryPendingQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid recovery pending query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      const sourceVersion = this.runtime.manager.getCampaignVersion(envelope.query.campaign_id);
      const nodes = this.runtime.manager.getRecoverableNodes(envelope.query.campaign_id);
      const sourceVersionAfterRead = this.runtime.manager.getCampaignVersion(envelope.query.campaign_id);
      if (sourceVersion !== sourceVersionAfterRead) return this.failure("conflict", "campaign changed while recovery targets were being projected", undefined, entry.capability);
      for (const node of nodes) {
        if (node.campaign_id !== envelope.query.campaign_id || node.expected_version !== sourceVersion
          || (node.state !== "interrupted" && node.state !== "expanding")
          || (node.state === "interrupted" && (typeof node.prior_operation_id !== "string" || node.prior_operation_id.trim().length === 0))) {
          return this.failure("corrupt_data", "recovery target projection failed source freshness checks", undefined, entry.capability);
        }
      }
      const boundedNodes = nodes.slice(0, envelope.query.limit ?? 200);
      return { ok: true, capability: entry.capability, value: {
        schema_version: 1,
        campaign_id: envelope.query.campaign_id,
        source_version: sourceVersion,
        fingerprint: recoveryPendingFingerprint(envelope.query.campaign_id, sourceVersion, boundedNodes),
        nodes: boundedNodes,
      } };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /**
   * WA-31: `job.retry`/`task.retry` must not blindly re-dispatch a task
   * whose last attempt left a spawned effect with no terminal settlement
   * and no compensation contract. Reuses the same conservative
   * `EffectClassifier` projection the recovery flow already authorizes
   * continuations from (`RecoveryService.previewContinuation` →
   * `buildContinuationPlan` → `EffectClassifier.classify`), scoped to the
   * retried task/job's own campaign — a task/job whose owner scope carries
   * no recovery-required session, or only settled/idempotent evidence,
   * retries exactly as before.
   */
  private indeterminateRetryConflict(ownerScopeId: string): string | null {
    const service = this.runtime.recoveryService;
    if (service === null) return null;
    for (const plan of service.previewContinuation(ownerScopeId)) {
      const indeterminate = plan.classifications.find((item) => item.classification === "indeterminate");
      if (indeterminate === undefined) continue;
      return `session ${plan.source_session_id} left an indeterminate effect (${indeterminate.operation_id}: ${indeterminate.reason}); run \`arbor recover --campaign ${ownerScopeId}\` to resolve it before retrying`;
    }
    return null;
  }

  private dispatchJobCommand(envelope: JobCommandEnvelope): RuntimeRouterResult<JobCommandAcknowledgement> {
    const kind = envelope.command.kind as RuntimeCatalogKind;
    const entry = catalogEntry(kind, "command");
    const failures = validateJobCommand(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid job command", failures.join("; "));
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: { accepted: true, operation_id: envelope.metadata.operation_id }, capability: entry.capability };
    const reject = (code: RuntimeError["code"], summary: string): RuntimeRouterResult<JobCommandAcknowledgement> => {
      const err = routerError(code, summary, undefined, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, err);
      return { ok: true as const, value: { accepted: false as const, operation_id: envelope.metadata.operation_id, error: err }, capability: entry.capability };
    };
    if (!this.authorized(entry)) return reject("permission", this.denialSummary(entry));
    try {
      switch (envelope.command.kind) {
        case "job.submit": {
          const c = envelope.command;
          const submitted = this.runtime.jobScheduler.submit({ id: c.id, operation_id: c.operation_id, kind: c.job_kind, owner_scope_id: c.owner_scope_id, idempotency_key: c.idempotency_key });
          if (!submitted.ok) return reject("conflict", submitted.error);
          // Wave 1 Lane A (todo 1): a fresh dispatch of the CAMPAIGN_RUN_JOB_KIND
          // job actually starts the tree-search loop against owner_scope_id
          // (the campaign_id). A replayed idempotent submit (`dispatched:
          // false`) never re-triggers a second run of the same job.
          if (submitted.dispatched && c.job_kind === CAMPAIGN_RUN_JOB_KIND) {
            const started = this.runtime.runCampaignJob(c.owner_scope_id, c.id);
            if (!started.ok) {
              try { this.runtime.supervisor.fail(c.id); } catch { /* best-effort — task state stays visible for the operator either way */ }
              this.runtime.checkpointSupervisor();
              return reject("unavailable", started.reason);
            }
          }
          this.runtime.checkpointSupervisor();
          this.runtime.operations.complete(envelope.metadata.operation_id, `job ${c.id} submitted`);
          return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id, job: submitted.job, dispatched: submitted.dispatched } };
        }
        case "job.cancel": {
          const cancelled = this.runtime.jobScheduler.cancel(envelope.command.job_id);
          if (!cancelled.ok) return reject("conflict", cancelled.error);
          this.runtime.checkpointSupervisor();
          this.runtime.operations.complete(envelope.metadata.operation_id, `job ${envelope.command.job_id} cancel requested`);
          return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id, job: cancelled.job } };
        }
        case "job.retry": {
          const prior = this.runtime.supervisor.get(envelope.command.job_id);
          if (prior !== undefined) {
            const conflict = this.indeterminateRetryConflict(prior.owner_scope_id);
            if (conflict !== null) return reject("conflict", conflict);
          }
          // A campaign runner owns the whole lifetime of its fire-and-forget
          // task. Once it has settled there is no subordinate supervisor task
          // left to clean, but older persisted runs may still carry the
          // generic terminal `cleanup: pending` marker. The operator's
          // explicit retry is the recovery authorization here: acknowledge
          // that completed runner cleanup before applying the retry
          // transition. Other job kinds retain the stricter generic contract.
          if (prior?.kind === CAMPAIGN_RUN_JOB_KIND && prior.cleanup === "pending") {
            this.runtime.supervisor.completeCleanup(prior.id);
          }
          const retried = this.runtime.jobScheduler.retry(envelope.command.job_id);
          if (!retried.ok) return reject("conflict", retried.error);
          if (retried.job.kind === CAMPAIGN_RUN_JOB_KIND) {
            const started = this.runtime.runCampaignJob(retried.job.owner_scope_id, retried.job.id);
            if (!started.ok) {
              try { this.runtime.supervisor.fail(retried.job.id); } catch { /* preserve the typed dispatch failure */ }
              this.runtime.checkpointSupervisor();
              return reject("unavailable", started.reason);
            }
          }
          this.runtime.checkpointSupervisor();
          this.runtime.operations.complete(envelope.metadata.operation_id, `job ${envelope.command.job_id} retried`);
          return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id, job: retried.job } };
        }
        case "job.pause":
          this.runtime.jobScheduler.pause();
          this.runtime.operations.complete(envelope.metadata.operation_id, "queue paused");
          return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id } };
        case "job.resume":
          this.runtime.jobScheduler.resume();
          this.runtime.operations.complete(envelope.metadata.operation_id, "queue resumed");
          return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id } };
      }
    } catch (error) {
      const mapped = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, mapped);
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: mapped }, capability: entry.capability }; // job catch
    }
  }

  private executeJobListQuery(envelope: JobListQueryEnvelope): RuntimeRouterResult<JobListProjection> {
    const entry = catalogEntry("job.list", "query");
    const failures = validateJobListQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid job list query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      return { ok: true, capability: entry.capability, value: this.runtime.jobScheduler.view({ include_terminal: envelope.query.include_terminal }) };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  private dispatchApprovalRequest(envelope: ApprovalRequestEnvelope, authenticatedActor: string | null): RuntimeRouterResult<ApprovalRequestAcknowledgement> {
    const kind = envelope.command.kind as RuntimeCatalogKind;
    const entry = catalogEntry(kind, "command");
    const failures = validateApprovalRequest(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid approval command", failures.join("; "));
    let operation: OperationRecord;
    try { operation = this.runtime.operations.accept({ metadata: envelope.metadata, capability: entry.capability, fingerprint: JSON.stringify(envelope.command) }); }
    catch (error) { return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata); }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: { accepted: true, operation_id: envelope.metadata.operation_id }, capability: entry.capability };
    const reject = (code: RuntimeError["code"], summary: string): RuntimeRouterResult<ApprovalRequestAcknowledgement> => {
      const err = routerError(code, summary, undefined, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, err);
      return { ok: true as const, value: { accepted: false as const, operation_id: envelope.metadata.operation_id, error: err }, capability: entry.capability };
    };
    if (!this.authorized(entry)) return reject("permission", this.denialSummary(entry));
    // Approval records are durable authority.  Actor-looking text in a CLI,
    // MCP, or Web envelope is only a claim; accepting it here would let one
    // caller invent both sides of a checks-and-balances decision.  The TUI
    // reaches this with a verified local-session identity, and remote ingress
    // uses dispatchAuthenticatedApproval only after proof verification.
    if (authenticatedActor === null) return reject("permission", "approval commands require an authenticated identity");
    try {
      switch (envelope.command.kind) {
        case "approval.request": {
          const c = envelope.command;
          if (c.proposer !== authenticatedActor) return reject("permission", "approval proposer must equal the authenticated session actor");
          const requested = this.runtime.approvals.request({ request_id: c.request_id, idempotency_key: c.idempotency_key, action: c.action as never, subject: c.subject, resource_id: c.resource_id, proposer: authenticatedActor, rationale: c.rationale ?? "", expires_at: c.expires_at });
          if (!requested.ok) return reject("conflict", requested.error);
          this.runtime.operations.complete(envelope.metadata.operation_id, `approval ${c.request_id} requested`);
          return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id, record: requested.record } };
        }
        case "approval.approve":
        case "approval.reject": {
          const c = envelope.command;
          if (c.actor !== authenticatedActor) return reject("permission", "approval decider must equal the authenticated session actor");
          const decided = c.kind === "approval.approve"
            ? this.runtime.approvals.approve({ request_id: c.request_id, actor: c.actor, clock: c.at ?? this.runtime.approvals.now(), memory_scope: c.memory_scope })
            : this.runtime.approvals.reject({ request_id: c.request_id, actor: c.actor, clock: c.at ?? this.runtime.approvals.now() });
          if (!decided.ok) return reject(decided.code as RuntimeError["code"], decided.error);
          this.runtime.operations.complete(envelope.metadata.operation_id, `approval ${c.request_id} ${decided.record.status}`);
          return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id, record: decided.record } };
        }
        case "approval.expire": {
          const expired = this.runtime.approvals.expire(envelope.command.request_id);
          if (!expired.ok) return reject("conflict", expired.error);
          this.runtime.operations.complete(envelope.metadata.operation_id, `approval ${envelope.command.request_id} expired`);
          return { ok: true, capability: entry.capability, value: { accepted: true, operation_id: envelope.metadata.operation_id, record: expired.record } };
        }
      }
    } catch (error) {
      const mapped = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, mapped);
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: mapped }, capability: entry.capability };
    }
  }

  private executeApprovalListQuery(envelope: ApprovalListQueryEnvelope): RuntimeRouterResult<ApprovalListProjection> {
    const entry = catalogEntry("approval.list", "query");
    const failures = validateApprovalListQuery(envelope);
    if (failures.length > 0) return this.failure("validation", "invalid approval list query", failures.join("; "));
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    try {
      return { ok: true, capability: entry.capability, value: { records: this.runtime.approvals.list({ status: envelope.query.status, limit: envelope.query.limit }) } };
    } catch (error) {
      return { ok: false, capability: entry.capability, error: mapRuntimeBoundaryError(error) };
    }
  }

  /**
   * Bounded lifecycle controls for the persisted, host-local authority. The
   * operation registry is checkpointed before and after the authority change,
   * preserving actor/correlation attribution across a restart without putting
   * key material in the operation fingerprint or result summary.
   */
  private dispatchTrustSession(envelope: TrustSessionCommandEnvelope): RuntimeRouterResult<CommandAcknowledgement> {
    const entry = catalogEntry(envelope.command.kind, "command");
    const failures = validateTrustSessionCommand(envelope);
    if (failures.length > 0) return this.failure("validation", `invalid ${entry.kind} command`, failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    let operation: OperationRecord;
    try {
      operation = this.runtime.operations.accept({
        metadata: envelope.metadata,
        capability: entry.capability,
        fingerprint: trustSessionFingerprint(envelope),
      });
      this.runtime.checkpointOperations();
    } catch (error) {
      return this.failure("conflict", errorMessage(error), undefined, entry.capability, envelope.metadata);
    }
    if (operation.state !== "accepted" && operation.state !== "running") return { ok: true, value: acknowledgementFromOperation(operation), capability: entry.capability };
    try {
      const command = envelope.command;
      switch (command.kind) {
        case "trust.session.enroll":
          this.runtime.remoteSessionAuthority.register(command.registration);
          break;
        case "trust.session.rotate":
          this.runtime.remoteSessionAuthority.rotateKey(command);
          break;
        case "trust.session.revoke":
          this.runtime.remoteSessionAuthority.revokeSession(command.session_id);
          break;
      }
      this.runtime.operations.complete(envelope.metadata.operation_id, trustSessionAuditSummary(command));
      this.runtime.checkpointOperations();
      return { ok: true, value: { accepted: true, operation_id: envelope.metadata.operation_id }, capability: entry.capability };
    } catch (error) {
      const mapped = mapRuntimeBoundaryError(error, envelope.metadata);
      this.rejectOperation(envelope.metadata.operation_id, mapped);
      this.runtime.checkpointOperations();
      return { ok: true, value: { accepted: false, operation_id: envelope.metadata.operation_id, error: mapped }, capability: entry.capability };
    }
  }

  /** Read-only, public-key-free trust projections for local operators. */
  private executeTrustSessionQuery(envelope: TrustSessionQueryEnvelope): RuntimeRouterResult<TrustSessionListProjection | unknown> {
    const entry = catalogEntry(envelope.query.kind, "query");
    const failures = validateTrustSessionQuery(envelope);
    if (failures.length > 0) return this.failure("validation", `invalid ${entry.kind} query`, failures.join("; "), entry.capability);
    if (!this.authorized(entry)) return this.failure("permission", this.denialSummary(entry), undefined, entry.capability);
    if (envelope.query.kind === "trust.session.list") {
      const sessions = this.runtime.remoteSessionAuthority.list();
      const limit = envelope.query.limit ?? 100;
      return { ok: true, capability: entry.capability, value: { sessions: sessions.slice(0, limit), total: sessions.length } };
    }
    const session = this.runtime.remoteSessionAuthority.status(envelope.query.session_id);
    if (session === null) return this.failure("conflict", `remote session ${envelope.query.session_id} was not found`, undefined, entry.capability);
    return { ok: true, capability: entry.capability, value: session };
  }

  private executeCommand(envelope: RuntimeCommandEnvelope): CommandAcknowledgement {
    const command = envelope.command;
    switch (command.kind) {
      case "tree.prune":
        this.runtime.manager.prune(command.campaign_id, command.node_id);
        return { accepted: true, operation_id: envelope.metadata.operation_id };
      case "operation.cancel": {
        const evaluation = this.evaluationAbortControllers.get(command.target_operation_id);
        if (evaluation) {
          evaluation.abort("operator cancelled controlled evaluation");
          this.runtime.operations.cancel(command.target_operation_id, "controlled evaluation cancellation requested");
          return { accepted: true, operation_id: envelope.metadata.operation_id };
        }
        const task = this.runtime.supervisor.list({ include_terminal: true })
          .find((candidate) => candidate.operation_id === command.target_operation_id);
        if (!task) throw new Error(`operation ${command.target_operation_id} has no supervised task`);
        this.runtime.supervisor.requestCancellation(task.id);
        return { accepted: true, operation_id: envelope.metadata.operation_id };
      }
      case "task.retry": {
        const task = this.runtime.supervisor.get(command.task_id);
        if (task !== undefined) {
          const conflict = this.indeterminateRetryConflict(task.owner_scope_id);
          if (conflict !== null) return { accepted: false, operation_id: envelope.metadata.operation_id, error: routerError("conflict", conflict, undefined, envelope.metadata) };
        }
        this.runtime.supervisor.retry(command.task_id);
        return { accepted: true, operation_id: envelope.metadata.operation_id };
      }
      case "campaign.start": {
        if (command.plan_review && (!command.plan_review.plan_reviewed || !command.plan_review.resources_available)) {
          return { accepted: false, operation_id: envelope.metadata.operation_id, error: routerError("conflict", "admission inputs did not pass review", undefined, envelope.metadata) };
        }
        const started = this.runtime.manager.startCampaign(
          command.campaign_id,
          command.plan_path,
          command.root_action,
          command.config,
        );
        if (started.ok) return { accepted: true, operation_id: envelope.metadata.operation_id };
        // ADR-118: project the recorded admission-gate refusal through the
        // shared, versioned envelope instead of a one-off template string,
        // so the TUI/web reader of this command result gets the same
        // owning-gate/evidence-deficit/remediation shape the MCP tool
        // response and CLI failure summary carry for the same refusal.
        const refusal = this.runtime.getGateRefusalProjection(
          { available: true, record: started.gate },
          defaultGateRemediation(started.gate.gate),
        ).value;
        return {
          accepted: false,
          operation_id: envelope.metadata.operation_id,
          error: routerError("conflict", refusal?.summary ?? `admission gate ${started.gate.result}`, refusal?.remediation, envelope.metadata, refusal ?? undefined),
        };
      }
      case "campaign.halt": {
        const authority = verifyApprovedAuthority(
          this.runtime.approvals.get(command.approval_id),
          { action: "campaign.halt", resource_id: command.campaign_id },
          this.runtime.approvals.now(),
        );
        if (!authority.ok) {
          return { accepted: false, operation_id: envelope.metadata.operation_id, error: routerError("permission", `campaign halt approval denied: ${authority.error}`, undefined, envelope.metadata) };
        }
        const halted = this.runtime.manager.manualHalt(command.campaign_id, {
          requested_by: authority.record.proposer,
          auditor_agent: authority.record.decided_by,
          auditor_agrees: true,
          operation_id: envelope.metadata.operation_id,
          expected_version: envelope.metadata.expected_version,
        });
        if (halted.ok) return { accepted: true, operation_id: envelope.metadata.operation_id };
        // ADR-118: only `audit_failed` carries a real recorded audit-gate
        // result (`halted.gate`); the other refusal reasons (invalid
        // request, version conflict, already halted) never reached the
        // audit gate at all and stay their existing plain-text reason —
        // projecting a gate refusal for them would fabricate a gate result
        // that was never computed.
        if (halted.reason !== "audit_failed" || halted.gate === undefined) {
          return { accepted: false, operation_id: envelope.metadata.operation_id, error: routerError("conflict", `manual halt ${halted.reason}`, undefined, envelope.metadata) };
        }
        const refusal = this.runtime.getGateRefusalProjection(
          { available: true, record: halted.gate },
          defaultGateRemediation(halted.gate.gate),
        ).value;
        return {
          accepted: false,
          operation_id: envelope.metadata.operation_id,
          error: routerError("conflict", refusal?.summary ?? `manual halt ${halted.reason}`, refusal?.remediation, envelope.metadata, refusal ?? undefined),
        };
      }
      case "tree.branch":
        this.runtime.manager.branch(command.campaign_id, command.node_id, command.actions);
        return { accepted: true, operation_id: envelope.metadata.operation_id };
      case "recovery.retry":
      case "recovery.abandon":
        return this.executeRecovery(envelope);
    }
  }

  private executeQueryValue(envelope: RuntimeQueryEnvelope): unknown {
    const query = envelope.query;
    switch (query.kind) {
      case "campaign.list": {
        const now = new Date();
        const all = rankByFrecency(this.runtime.manager.listCampaigns(), (campaign) => {
          const records = this.runtime.manager.getAuditRecords(campaign.id);
          return { frequency: campaign.iterations_completed + 1, last_used_at: records.at(-1)?.timestamp ?? campaign.started_at };
        }, now);
        const page = cursorPage({ stream_id: "campaigns", offset: cursorOffset(query.cursor, "campaigns"), limit: query.limit, items: all });
        return { items: page.items, next_cursor: page.next_cursor, total: page.total, limit: query.limit };
      }
      case "campaign.snapshot": {
        const snapshot = this.runtime.manager.getCampaignSnapshot(query.campaign_id);
        if (snapshot === null) throw new Error(`campaign ${query.campaign_id} was not found`);
        // Campaign detail is an operator-facing read. Carry the canonical
        // run-status lifecycle envelope alongside the snapshot so consumers
        // can distinguish a fresh observation from a stale/failed refresh.
        // The runtime remains the sole producer of execution status.
        const prior = this.campaignRunStatusProjections.get(query.campaign_id);
        const campaignRunStatus = this.runtime.getCampaignRunStatusProjection(query.campaign_id, undefined, prior);
        this.campaignRunStatusProjections.delete(query.campaign_id);
        this.campaignRunStatusProjections.set(query.campaign_id, campaignRunStatus);
        // Retain stale read models for recent campaigns without letting an
        // indefinitely long-lived router accumulate every campaign snapshot.
        while (this.campaignRunStatusProjections.size > 128) {
          const oldestCampaignId = this.campaignRunStatusProjections.keys().next().value;
          if (oldestCampaignId === undefined) break;
          this.campaignRunStatusProjections.delete(oldestCampaignId);
        }
        return {
          ...snapshot,
          campaign_run_status: campaignRunStatus,
        };
      }
      case "campaign.tree": {
        const stream = `tree:${query.campaign_id}`;
        const snapshot = this.runtime.manager.getCampaignSnapshot(query.campaign_id);
        if (snapshot === null) throw new Error(`campaign ${query.campaign_id} was not found`);
        const latestByNode = new Map<string, string>();
        for (const record of this.runtime.manager.getAuditRecords(query.campaign_id)) latestByNode.set(record.node_id, record.timestamp);
        const children = new Map<string | null, typeof snapshot.nodes>();
        for (const node of snapshot.nodes) children.set(node.parent_id, [...(children.get(node.parent_id) ?? []), node]);
        const ranked: typeof snapshot.nodes = [];
        const visit = (parent: string | null): void => {
          const siblings = rankByFrecency(children.get(parent) ?? [], (node) => ({ frequency: node.visit_count + 1, last_used_at: latestByNode.get(node.id) ?? node.created_at }));
          for (const node of siblings) { ranked.push(node); visit(node.id); }
        };
        visit(null);
        for (const node of snapshot.nodes) if (!ranked.some((entry) => entry.id === node.id)) ranked.push(node);
        const page = cursorPage({ stream_id: stream, offset: cursorOffset(query.cursor, stream), limit: query.limit, items: ranked });
        return {
          campaign_id: snapshot.id, root_id: snapshot.root_id, decomposed: snapshot.decomposed,
          halted: snapshot.halted, halt_reason: snapshot.halt_reason,
          nodes: page.items, next_cursor: page.next_cursor, total: page.total,
          // `campaign.tree` and this cursor are read synchronously on the
          // runtime thread. A TUI can therefore seed its semantic topology at
          // this exact canonical event boundary and fold only later envelopes.
          event_cursor: this.runtime.eventStream.cursor(),
        };
      }
      case "task.list": {
        const stream = `tasks:${query.scope_id ?? "all"}`;
        // EC-053: a task restored as `started` with no process behind it is
        // durable evidence, not a live worker. Project that fact so no screen
        // renders it as work in flight; the supervisor already tracks the set.
        const interrupted = new Set(this.runtime.supervisor.reconciliationTasks().map((task) => task.id));
        const all = this.runtime.supervisor.list({ scope_id: query.scope_id }).map((task) => (interrupted.has(task.id) ? { ...task, interrupted: true } : task));
        const page = cursorPage({ stream_id: stream, offset: cursorOffset(query.cursor, stream), limit: query.limit, items: all });
        return { items: page.items, next_cursor: page.next_cursor, total: page.total, limit: query.limit };
      }
      case "event.resume": {
        const snapshot = this.runtime.snapshot();
        if (!snapshot.ok || snapshot.value === null) {
          throw new Error(snapshot.failures.map((failure) => failure.summary).join("; ") || "runtime snapshot unavailable");
        }
        return this.runtime.eventStream.resume(query.cursor, snapshot.value.value);
      }
      case "operation.get": {
        const operation = this.runtime.operations.get(query.operation_id);
        if (!operation) throw new Error(`operation ${query.operation_id} was not found`);
        return operation;
      }
    }
  }

  /**
   * `recovery.retry`'s `lease` field (`arbor-core/src/runtime-contracts.ts`)
   * is now optional (`lease?: RecoveryLeaseInput`), fixed at the source:
   * previously it was a *required* field that `validateRuntimeCommand`
   * enforced the shape of, yet the `RecoveryRequest` built below never read
   * `command.lease` — the real lease for a retry is minted fresh,
   * server-side, by `RecoveryLeaseAuthority.acquireFresh` a few lines into
   * `RecoveryService.perform` (`recovery-service.ts`), which takes no
   * caller-supplied lease input at all. A client has no legitimate lease to
   * report before dispatching a retry (it cannot know the fresh lease before
   * the server mints it), so requiring one was validating theater, not a
   * real input — confirmed by `server.test.ts`'s `recoveryRetryCommand`
   * fixture, whose `lease: { lease_id: "stale-lease", ... }` the
   * `RecoveryLeaseAuthority` mock never inspects.
   *
   * Making it optional is the honest fix without a second, uncoordinated
   * definition of what the field means: a caller (including a TUI wiring
   * this control for the first time) can now omit `lease` entirely. If one
   * is supplied anyway, `validateRuntimeCommand` still checks its shape, but
   * this router still never reads `command.lease` — there is no genuine use
   * to thread it through to, since `RecoveryRequest`/`RecoveryLeaseAuthority`
   * have no parameter that would accept it.
   */
  private executeRecovery(envelope: RuntimeCommandEnvelope): CommandAcknowledgement & { recovery: RecoveryResult } {
    const command = envelope.command;
    if (command.kind !== "recovery.retry" && command.kind !== "recovery.abandon") {
      throw new Error("recovery command was not supplied");
    }
    const request: RecoveryRequest = command.kind === "recovery.retry"
      ? {
        operation_id: envelope.metadata.operation_id, idempotency_key: envelope.metadata.idempotency_key,
        campaign_id: command.campaign_id, node_id: command.node_id, prior_operation_id: command.prior_operation_id,
        expected_version: envelope.metadata.expected_version!, action: "retry", actor_id: envelope.metadata.actor_id,
        actor_role: "crown", reason: command.reason,
      }
      : {
        operation_id: envelope.metadata.operation_id, idempotency_key: envelope.metadata.idempotency_key,
        campaign_id: command.campaign_id, node_id: command.node_id, prior_operation_id: command.prior_operation_id,
        expected_version: envelope.metadata.expected_version!, action: "abandon", actor_id: envelope.metadata.actor_id,
        actor_role: command.authorization.authority, reason: command.reason,
      };
    const recovery = this.options.recovery_service!.execute(request);
    switch (recovery.status) {
      case "ready":
      case "abandoned":
        return { accepted: true, operation_id: envelope.metadata.operation_id, recovery };
      case "planned":
        return { accepted: false, operation_id: envelope.metadata.operation_id, error: routerError("unavailable", recovery.reason, recovery.required_integration, envelope.metadata), recovery };
      case "blocked":
        return { accepted: false, operation_id: envelope.metadata.operation_id, error: routerError("conflict", recovery.reason, undefined, envelope.metadata), recovery };
      case "conflict":
        return { accepted: false, operation_id: envelope.metadata.operation_id, error: routerError("conflict", recovery.reason, undefined, envelope.metadata), recovery };
    }
  }

  private commandSession(input: unknown, required = this.options.require_local_session === true): { ok: true; actor_id: string | null } | { ok: false; error: string } {
    if (!required) return { ok: true, actor_id: null };
    if (typeof input !== "object" || input === null) return { ok: false, error: "signed local session proof is required" };
    const envelope = input as { metadata?: unknown; command?: unknown };
    if (typeof envelope.metadata !== "object" || envelope.metadata === null || typeof envelope.command !== "object" || envelope.command === null) return { ok: false, error: "signed local session proof is required" };
    const metadata = envelope.metadata as Record<string, unknown>; const command = envelope.command as Record<string, unknown>;
    if (typeof command.kind !== "string") return { ok: false, error: "command kind is required" };
    const { session, ...signedMetadata } = metadata; const { kind, ...params } = command;
    const verified = verifyLocalSessionProof(session, { type: "command", kind, metadata: signedMetadata, params });
    if (!verified.ok) return verified;
    return signedMetadata.actor_id === verified.actor_id ? { ok: true, actor_id: verified.actor_id } : { ok: false, error: "command actor does not match signed local session" };
  }

  /**
   * `unauthenticated-local` is an attribution label, not a grant: the raw
   * read it reaches is authorized solely by the approved, unexpired,
   * non-self-approved `output.raw` record for that exact evidence id, which
   * only an authenticated proposer and a distinct decider can create.
   * `OutputEvidenceStore.readRaw` validates the actor as non-empty and does
   * not persist it.
   */
  private rawQuerySession(envelope: OutputQueryEnvelope): { ok: true; actor_id: string } | { ok: false; error: string } {
    if (!this.options.require_local_session) return { ok: true, actor_id: "unauthenticated-local" };
    const query = envelope.query as unknown as Record<string, unknown>;
    const { session, kind, ...params } = query;
    return verifyLocalSessionProof(session, { type: "query", kind, query_id: envelope.query_id, params });
  }

  private get callerTier(): CapabilityTier {
    return this.options.caller_tier ?? "senior";
  }

  /**
   * Both halves of the authorization decision: the transport's capability
   * policy, then ADR-028's tier gate. Returns the denial reason, or `null`
   * when the caller may proceed — one evaluation, so the message a caller
   * receives always names the check that actually rejected it.
   */
  private denialReason(entry: RuntimeCatalogEntry): string | null {
    if (this.options.granted_capabilities !== undefined && !this.options.granted_capabilities.has(entry.capability)) {
      return `missing capability ${entry.capability}`;
    }
    try {
      enforceAction(catalogActionClass(entry), this.callerTier, entry.kind);
    } catch (error) {
      if (error instanceof CapabilityError) return error.message;
      throw error;
    }
    return null;
  }

  private authorized(entry: RuntimeCatalogEntry): boolean {
    return this.denialReason(entry) === null;
  }

  /** The denial message for a rejected dispatch; never called on an authorized entry. */
  private denialSummary(entry: RuntimeCatalogEntry): string {
    return this.denialReason(entry) ?? `missing capability ${entry.capability}`;
  }

  /** Error reporting must not recursively escape when a restored operation is reconciliation-only. */
  private rejectOperation(operationId: string, error: RuntimeError): void {
    try { this.runtime.operations.reject(operationId, error); } catch { /* preserve the boundary error; reconciliation remains authoritative */ }
  }

  private unavailable(entry: RuntimeCatalogEntry): RuntimeRouterResult<never> {
    return this.failure("unavailable", entry.unavailable_reason ?? "not available", undefined, entry.capability);
  }

  private failure(
    code: RuntimeError["code"], summary: string, diagnostic?: string, capability: string | null = null,
    metadata?: RuntimeCommandEnvelope["metadata"],
  ): RuntimeRouterResult<never> {
    return { ok: false, capability, error: routerError(code, summary, diagnostic, metadata) };
  }
}

/**
 * ADR-028: the capability action class a catalog kind falls into.
 *
 * Derived from `direction` rather than stored as a per-entry column. Every
 * command in this catalog mutates durable state, and `preview-confirm` is
 * `capability.ts`'s only mutating class, so a per-kind column would today be an
 * exact restatement of `direction` — a second source of truth for one fact,
 * which is the defect this repository's own gates exist to catch.
 *
 * Exported because it is the total mapping ADR-028 turns on, and a claim that
 * "every mutating kind is gated" should be checkable directly rather than
 * inferred from a private method's behaviour. It is also the one place to
 * encode a divergence if a kind ever needs one — a genuinely `forbidden` kind,
 * or a command that only plans.
 */
export function catalogActionClass(entry: RuntimeCatalogEntry): ActionClass {
  return entry.direction === "command" ? "preview-confirm" : "read";
}

/**
 * Best-effort outcome-observation hook (T5.3, 2026-08-23 remediation,
 * "outcome-aware observation" — hollow-parity.mjs item 2). When
 * `ARBOR_VI_OUTCOME_SINK` names a writable path, every `ok:false` result
 * this router returns from its two public entrypoints (`dispatchCommand`,
 * `executeQuery`) is appended there as one JSONL line
 * `{kind, direction, code, summary}`. `scripts/vi-observe.mjs` is the sole
 * intended consumer: it sets this per real-process scenario to a
 * scratch-dir file, reads the file back after the scenario exits, tags each
 * row with the scenario id, and folds the result into
 * `.visual-intelligence/observed/outcomes.jsonl`.
 *
 * Absent the env var (every caller outside vi-observe.mjs — production,
 * every other test) this is a complete no-op: no env var means no branch
 * taken, so it can never affect a real command/query's response, memory
 * footprint, or timing in any observable way. A sink write failure is
 * swallowed rather than surfaced for the same reason a coverage instrument
 * failing must never fail the thing it is observing: instrumentation must
 * never become load-bearing for the response it is only supposed to watch.
 */
function recordRouterOutcomeIfSinkConfigured(direction: "command" | "query", kind: string, error: RuntimeError): void {
  const sinkPath = process.env.ARBOR_VI_OUTCOME_SINK;
  if (!sinkPath) return;
  try {
    appendFileSync(sinkPath, `${JSON.stringify({ kind, direction, code: error.code, summary: error.summary })}\n`);
  } catch { /* best-effort instrument — see this function's doc comment */ }
}

/** Best-effort `kind` extraction across this router's heterogeneous envelope shapes, for outcome observation only. */
function outcomeKindOf(input: unknown, direction: "command" | "query"): string {
  if (input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const nested = record[direction];
    if (nested !== null && typeof nested === "object" && typeof (nested as Record<string, unknown>).kind === "string") {
      return (nested as Record<string, unknown>).kind as string;
    }
    if (typeof record.kind === "string") return record.kind;
  }
  return "unknown";
}

function catalogEntry(kind: RuntimeCatalogKind, direction: RuntimeCatalogEntry["direction"]): RuntimeCatalogEntry {
  const entry = RUNTIME_CATALOG.find((candidate) => candidate.kind === kind && candidate.direction === direction);
  if (!entry) throw new Error(`catalog lacks ${direction} ${kind}`);
  return entry;
}

/** Recognize the extension discriminator before core's smaller command union. */
function isTaskComposerCommandInput(input: unknown): input is { command: { kind: string } } {
  if (typeof input !== "object" || input === null) return false;
  const command = (input as { command?: unknown }).command;
  return typeof command === "object" && command !== null
    && typeof (command as { kind?: unknown }).kind === "string"
    && (command as { kind: string }).kind.startsWith("taskcomposer.");
}

/** Recognize the extension discriminator before core's smaller query union. */
function isTaskComposerQueryInput(input: unknown): input is { query: { kind: string } } {
  if (typeof input !== "object" || input === null) return false;
  const query = (input as { query?: unknown }).query;
  return typeof query === "object" && query !== null
    && typeof (query as { kind?: unknown }).kind === "string"
    && (query as { kind: string }).kind.startsWith("taskcomposer.");
}

/**
 * Reuse core's envelope-metadata validation without pretending a composer
 * command is an ApplicationCommand. The harmless probe command is never
 * dispatched; it exists only to keep one authoritative validation rule for
 * operation identity, idempotency, actor, correlation, and timestamps.
 */
function composerMetadata(input: unknown): { ok: true; value: RuntimeCommandEnvelope["metadata"] } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "task composer command envelope must be an object" };
  const candidate = input as Record<string, unknown>;
  const validation = validateRuntimeCommand({
    ...candidate,
    command: { kind: "tree.prune", campaign_id: "taskcomposer-validation", node_id: "taskcomposer-validation" },
  });
  return validation.ok
    ? { ok: true, value: validation.value.metadata }
    : { ok: false, error: validation.violations.map((violation) => `${violation.path}: ${violation.message}`).join("; ") };
}

/**
 * Recognizes an unsupported query kind purely from its `query.kind`
 * discriminator, without assuming the rest of the envelope is well-formed —
 * this runs before any shape validation specifically so an unsupported kind
 * gets the catalog's real reason instead of a generic validation complaint.
 */
function unsupportedQueryKind(input: unknown): RuntimeCatalogEntry | null {
  if (typeof input !== "object" || input === null) return null;
  const query = (input as { query?: unknown }).query;
  if (typeof query !== "object" || query === null) return null;
  const kind = (query as { kind?: unknown }).kind;
  if (typeof kind !== "string") return null;
  const entry = RUNTIME_CATALOG.find((candidate) => candidate.kind === kind && candidate.direction === "query");
  return entry && !entry.supported ? entry : null;
}

/**
 * The catalog entry for a query kind this router DOES support, recognized from
 * the `query.kind` discriminator alone.
 *
 * `executeQuery` matches a shape predicate per query family and only then
 * falls through to core's `validateRuntimeQuery`, whose union is deliberately
 * smaller (six kinds). A SUPPORTED kind whose payload is malformed therefore
 * matches no predicate, reaches core, and came back as
 * `unsupported query kind "output.raw"` -- which denies that the capability
 * exists rather than saying the payload was wrong. Both exemplars keep those
 * two answers apart: OpenCode returns `InvalidRequestError` carrying the
 * schema issue, and Claude Code separates "Unknown command" from
 * "Invalid input: ...". This lets the caller do the same.
 */
function declaredSupportedQueryKind(input: unknown): RuntimeCatalogEntry | null {
  if (typeof input !== "object" || input === null) return null;
  const query = (input as { query?: unknown }).query;
  if (typeof query !== "object" || query === null) return null;
  const kind = (query as { kind?: unknown }).kind;
  if (typeof kind !== "string") return null;
  const entry = RUNTIME_CATALOG.find((candidate) => candidate.kind === kind && candidate.direction === "query");
  return entry && entry.supported ? entry : null;
}

interface InspectActionQueryEnvelope { readonly query: { readonly kind: "inspect.action"; readonly action_id: string }; }
function isInspectActionQueryEnvelope(input: unknown): input is InspectActionQueryEnvelope {
  if (typeof input !== "object" || input === null) return false;
  const query = (input as { query?: unknown }).query;
  if (typeof query !== "object" || query === null) return false;
  const value = query as { kind?: unknown; action_id?: unknown };
  return value.kind === "inspect.action" && typeof value.action_id === "string" && value.action_id.length > 0 && value.action_id.length <= 256;
}

function unsupportedCommandKind(input: unknown): RuntimeCatalogEntry | null {
  if (typeof input !== "object" || input === null) return null;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "object" || command === null) return null;
  const kind = (command as { kind?: unknown }).kind;
  if (typeof kind !== "string") return null;
  const entry = RUNTIME_CATALOG.find((candidate) => candidate.kind === kind && candidate.direction === "command");
  return entry && !entry.supported ? entry : null;
}

/**
 * ADR-179 typed remedy for a session fork refused because its campaign is
 * halted and the halt is not one a fork reopens. A budget halt (or a reopen
 * that would re-halt on budget) is the operator's to raise; every other
 * closed halt is cleared by planning new work, not by forking.
 */
function haltedForkRefusal(code: "halt_not_reopenable" | "would_rehalt" | "fork_child_unselectable", haltReason: import("@arbor/core").HaltReason, summary: string): import("./gate-refusal-projection.js").GateRefusalProjection {
  const bounded = summary.slice(0, GATE_REFUSAL_PROJECTION_MAX_TEXT);
  if (code === "would_rehalt" || haltReason === "budget_exhausted" || haltReason === "max_iterations") {
    return projectGateRefusal({ gate: "budget", code: code === "would_rehalt" ? "fork_reopen_would_rehalt" : "fork_halt_not_reopenable", summary: bounded,
      remediation: "A fork never reopens a budget halt or resets budget. Raise the configured budget (campaign config max_seconds, or the native usage_budget ceilings in arbor.jsonc) for a new campaign that continues from this one's evidence." });
  }
  if (code === "fork_child_unselectable") {
    return projectGateRefusal({ gate: "admission", code: "fork_child_unselectable", summary: bounded,
      remediation: "Fork from a verified or claimed session, or branch the alternative under a live node with tree.branch, so the reopened campaign can select it." });
  }
  return projectGateRefusal({ gate: "admission", code: "fork_halt_not_reopenable", summary: bounded,
    remediation: haltReason === "stranded_work"
      ? "Recover the interrupted or awaiting-review node (arbor recover) instead of forking; a fork reopens only a no_nodes or converged halt."
      : `A ${String(haltReason ?? "unspecified")} halt is closed to forks; only a no_nodes or converged halt is reopened. Start a new campaign for the alternative direction.` });
}

function routerError(code: RuntimeError["code"], summary: string, diagnostic?: string, metadata?: RuntimeCommandEnvelope["metadata"], gateRefusal?: import("./gate-refusal-projection.js").GateRefusalProjection): RuntimeError {
  return {
    code, severity: code === "validation" || code === "permission" ? "warning" : "error", recoverable: code !== "internal",
    source: "runtime_catalog_router", summary, diagnostic,
    operation_id: metadata?.operation_id, correlation_id: metadata?.correlation_id,
    ...(gateRefusal === undefined ? {} : { gate_refusal: gateRefusal }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Normalizes failures crossing a command/query boundary without exposing a
 * transport-specific exception type. Domain validation and authorization are
 * mapped before this function; this classifier is for operational failures.
 */
export function mapRuntimeBoundaryError(error: unknown, metadata?: RuntimeCommandEnvelope["metadata"]): RuntimeError {
  const value = error as { code?: unknown; name?: unknown } | null;
  const machineCode = typeof value?.code === "string" ? value.code.toUpperCase() : "";
  const name = typeof value?.name === "string" ? value.name.toLowerCase() : "";
  const summary = errorMessage(error);
  const normalized = summary.toLowerCase();
  let code: RuntimeError["code"] = "internal";

  if (machineCode === "ETIMEDOUT" || machineCode === "ESOCKETTIMEDOUT" || name.includes("timeout") || /\btimed?\s*out\b/.test(normalized)) code = "timeout";
  else if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH"].includes(machineCode)
    || /\b(transport|connection|socket)\b.*\b(closed|disconnect|lost|reset|refused)\b/.test(normalized)) code = "transport";
  else if (machineCode === "EILSEQ" || /\b(corrupt|checksum|hash chain|invalid json|unsupported version)\b/.test(normalized)) code = "corrupt_data";
  else if (/\b(unavailable|offline|not configured|not available)\b/.test(normalized)) code = "unavailable";
  else if (/\b(conflict|duplicate|idempotenc|stale|not found|no supervised task|requires reconciliation|cannot|already)\b/.test(normalized)
    || normalized.includes("version no longer matches")) code = "conflict";

  return routerError(code, summary || "runtime boundary failed", undefined, metadata);
}

function acknowledgementFromOperation(operation: OperationRecord): CommandAcknowledgement {
  if (operation.state === "completed") return { accepted: true, operation_id: operation.operation_id };
  return {
    accepted: false,
    operation_id: operation.operation_id,
    error: operation.error ?? routerError("conflict", operation.result_summary ?? "operation did not complete"),
  };
}

/** Deliberately excludes public-key PEM from persisted operation metadata. */
function trustSessionFingerprint(envelope: TrustSessionCommandEnvelope): string {
  const command = envelope.command;
  switch (command.kind) {
    case "trust.session.enroll":
      return JSON.stringify({
        kind: command.kind,
        session_id: command.registration.session_id,
        actor_id: command.registration.actor_id,
        key_id: command.registration.key_id,
        certificate_id: command.registration.certificate_id,
        expires_at: command.registration.expires_at,
        edge_count: command.registration.thread_audiences.length,
        approval_authority: command.registration.approval_authority === true,
      });
    case "trust.session.rotate":
      return JSON.stringify({ kind: command.kind, session_id: command.session_id, key_id: command.key_id, certificate_id: command.certificate_id });
    case "trust.session.revoke":
      return JSON.stringify({ kind: command.kind, session_id: command.session_id });
  }
}

function trustSessionAuditSummary(command: TrustSessionCommandEnvelope["command"]): string {
  switch (command.kind) {
    case "trust.session.enroll": return `remote session ${command.registration.session_id} enrolled by ${command.registration.actor_id}`;
    case "trust.session.rotate": return `remote session ${command.session_id} key rotated to ${command.key_id}`;
    case "trust.session.revoke": return `remote session ${command.session_id} revoked`;
  }
}

function campaignIdForCommand(command: ApplicationCommand): string | null {
  return "campaign_id" in command ? command.campaign_id : null;
}

function canReadTier(reader: NodeCommunication["capability_tier"], required: NodeCommunication["capability_tier"]): boolean {
  const rank: Record<NodeCommunication["capability_tier"], number> = { specialist: 0, critic: 1, auditor: 2, orchestrator: 3 };
  return rank[reader] >= rank[required];
}
