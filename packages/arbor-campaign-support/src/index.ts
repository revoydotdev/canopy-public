/**
 * @arbor/campaign-support — public API.
 *
 * Revoy-owned, harness-agnostic campaign support contracts extracted out of
 * `@arbor/opencode` (ADR-061 step 1 / tranche 1 of
 * docs/proposals/opencode-deprecation-migration.md). Every symbol here has
 * zero OpenCode SDK/schema coupling: worktree leasing, the panel-of-critics,
 * the retry-context capsule, token-economy dispatch, selection
 * communications, output evidence capture, node cost attribution, X-1
 * sibling-site scanning, and decomposition depth/fanout policy.
 *
 * `@arbor/opencode` re-exports these symbols from its own index for
 * backward compatibility; new callers should prefer importing directly from
 * `@arbor/campaign-support`.
 */

export { WorktreeManager, GIT_SCOPE_ENV_VARS, sanitizedGitEnv } from "./worktree.js";
export type {
  WorktreeLease,
  WorktreeManagerOptions,
  LeaseReconciliationOutcome,
  LeaseReconciliationResult,
  ReleaseOutcome,
  ReleaseIntegrationRung,
} from "./worktree.js";

export { checkIntegration } from "./integration-check.js";
export type { IntegrationRung, IntegrationClassification, IntegrationCheckInput, IntegrationCheckResult } from "./integration-check.js";

export { preserveWork, computeWorkingTreeSnapshotId } from "./preservation.js";
export type { PreserveWorkParams, PreserveWorkResult, PreservationManifest, PreservedArtifactRef } from "./preservation.js";

export { provisionWorktreeDependencies, DEFAULT_PROVISION_TIMEOUT_MS } from "./dependency-provisioning.js";
export type {
  PackageEcosystem,
  DependencyProvisioningOptions,
  DependencyProvisioningOutcome,
} from "./dependency-provisioning.js";

export { OpenCodeRecoveryLeaseAdapter } from "./recovery-lease.js";
export type { OpenCodeRecoveryLeaseOptions, RecoveryLeaseManagerPort } from "./recovery-lease.js";

export { readProcessIdentity, isProcessAlive, identityStillMatches } from "./process-identity.js";
export type { ProcessIdentity } from "./process-identity.js";

export { PanelOfCritics, PANEL_CRITICS, reconcile, aggregatePanelUsageCost } from "./critics.js";
export type {
  PanelCritic,
  PanelReviewers,
  ReviewerVerdict,
  ReviewerUsageCost,
  PanelDecision,
  PanelContext,
  PanelOfCriticsOptions,
  ReviewerRunner,
} from "./critics.js";

export {
  CAPSULE_MAX_BYTES,
  PROJECTION_MAX_BYTES,
  FIELD_MAX_BYTES,
  MAX_LIST_ITEMS,
  MAX_TOOL_SIGNATURES,
  buildRetryContextCapsule,
  projectRetryContextCapsule,
  verifyRetryContextCapsule,
  decideRetryContinuation,
  deriveFailureFingerprint,
} from "./retry-context-capsule.js";
export type {
  CampaignIdentity,
  FailureClassificationInput,
  FailureClassification,
  TaskFact,
  ChangeKind,
  ChangedFile,
  EvidenceRef,
  CriticRequirement,
  ToolSignature,
  FieldTruncationRecord,
  RetryContextCapsuleInput,
  RetryContextCapsule,
  RetryContextProjection,
  RetryContextCapsuleError,
  CapsuleBuildResult,
  ProjectionBuildResult,
  RetryDecisionAction,
  RetryDecisionInput,
  RetryDecision,
} from "./retry-context-capsule.js";

export { ContextOverflowError, prepareTokenDispatch, projectTokenDispatchPrompt } from "./token-economy-boundary.js";
export type {
  ExpansionTokenEpochPort,
  ProviderTokenBridge,
  StructuralContextPort,
  TokenEconomyConfig,
  TokenDispatchPreparation,
} from "./token-economy-boundary.js";

export { modelCapabilityTokenBridge } from "./canonical-adapter.js";

export { appendSelectionCommunications } from "./communications.js";
export type {
  CommunicationCapabilityTier,
  SelectionCommunication,
  SelectionCommunicationKind,
  SelectionCommunicationPort,
  SelectionCommunicationContext,
} from "./communications.js";

export { prepareOutput, suppressRoutineSuccess, excerptCapturedField } from "./output-boundary.js";
export type { OutputEvidenceKind, OutputEvidenceCapturePort, PreparedOutput } from "./output-boundary.js";

export { buildNodeCostAttribution, detectRedundantToolCalls } from "./cost-attribution.js";
export type { AttributableCall } from "./cost-attribution.js";

export {
  computeSiblingSites,
  computeSiblingSiteNote,
  computeDiffChangedFiles,
  assessAnalyzerApplicability,
} from "./sibling-scan.js";
export type { SiblingScanOptions, SiblingSite, AnalyzerApplicability } from "./sibling-scan.js";

export {
  MAX_DECOMPOSITION_DEPTH,
  MIN_DECOMPOSITION_FANOUT,
  MAX_DECOMPOSITION_FANOUT,
  decompositionDepthOf,
  depthBoundReached,
  validateDecomposition,
  decompositionProvenance,
} from "./decompose-policy.js";
export type { DecompositionOutcome } from "./decompose-policy.js";
