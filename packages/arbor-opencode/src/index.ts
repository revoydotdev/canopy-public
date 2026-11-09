/**
 * @arbor/opencode — public API.
 *
 * Exports:
 *   - arborPlugin, buildArborConfigBlock — for opencode plugin loading
 *   - buildAgentConfig, buildAllAgents   — for programmatic agent registration
 *   - ARBOR_CATEGORIES, routeCategory    — for skill-driven dispatch
 *   - permissionsFor, CAPABILITY_TIER    — for diagnostics and audit
 *   - Types (ArborAgentName, ArborCategoryName, OpencodeAgentConfig, ...)
 */

export { arborPlugin, buildArborConfigBlock, default } from "./plugin.js";
export type { ArborPluginContext, ArborHooks, ArborConfigBlock } from "./plugin.js";

export { buildAgentConfig, buildAllAgents, CAPABILITY_TIER, deriveAgentForeground, deriveDispatchForeground, DEFAULT_AGENT_FOREGROUND_SECRET } from "./agents.js";

// `ArborCategory`-related symbols moved to `@arbor/core` — see agent-taxonomy.ts.
// Re-exported here for backward compatibility.
export {
  ARBOR_CATEGORIES,
  CROWN_STRUCTURAL,
  HEARTWOOD_DEEP,
  SEED_QUICK,
  LEAF_VISUAL,
  SAP_WRITE,
  routeCategory,
  deriveCandidateNodeCard,
  resolveCategoryModel,
} from "@arbor/core";
export type { ArborCategory, CategoryModelOverrides } from "@arbor/core";

export { permissionsFor } from "./permissions.js";

export { runCampaign, DEFAULT_LOOP_CONFIG, DEFAULT_NODE_CARD_SECRET, FAULT_MATRIX, appendGovernedOverlay, composeSpecialistPrompt } from "./loop.js";
export type {
  LoopExecutor,
  SpecialistResult,
  CriticResult,
  ExecutorUsageCost,
  ExecutorContextComposition,
  ExecutorContextSourceComposition,
  LoopEvent,
  CampaignLoopConfig,
  CampaignExecutionStrategy,
  CampaignReport,
  NeedsUserInputSignal,
  LoopTelemetryPhase,
  LoopTelemetryOutcome,
  LoopTelemetryPort,
  LoopInterruptionPort,
  GovernedOverlayCheckpoint,
  GovernedOverlayCheckpointPort,
  CampaignRetryContextPort,
  NodeRoutingDecision,
  SpecialistPromptInput,
} from "./loop.js";

// The following symbols moved to `@arbor/campaign-support` in ADR-061 step 1
// / tranche 1 (docs/proposals/opencode-deprecation-migration.md) — they carry
// zero OpenCode SDK coupling. Re-exported here for backward compatibility;
// new callers should prefer importing directly from `@arbor/campaign-support`.
export { appendSelectionCommunications } from "@arbor/campaign-support";
export type {
  CommunicationCapabilityTier,
  SelectionCommunication,
  SelectionCommunicationKind,
  SelectionCommunicationPort,
  SelectionCommunicationContext,
} from "@arbor/campaign-support";
export { prepareOutput, suppressRoutineSuccess, excerptCapturedField } from "@arbor/campaign-support";
export type { OutputEvidenceKind, OutputEvidenceCapturePort, PreparedOutput } from "@arbor/campaign-support";

export { WorktreeManager, GIT_SCOPE_ENV_VARS, sanitizedGitEnv } from "@arbor/campaign-support";
export type {
  WorktreeLease,
  WorktreeManagerOptions,
  LeaseReconciliationOutcome,
  LeaseReconciliationResult,
} from "@arbor/campaign-support";
export { provisionWorktreeDependencies, DEFAULT_PROVISION_TIMEOUT_MS } from "@arbor/campaign-support";
export type {
  PackageEcosystem,
  DependencyProvisioningOptions,
  DependencyProvisioningOutcome,
} from "@arbor/campaign-support";
export { OpenCodeRecoveryLeaseAdapter } from "@arbor/campaign-support";
export type { OpenCodeRecoveryLeaseOptions, RecoveryLeaseManagerPort } from "@arbor/campaign-support";

export { PanelOfCritics, PANEL_CRITICS, reconcile } from "@arbor/campaign-support";
export type {
  PanelCritic,
  PanelReviewers,
  ReviewerVerdict,
  PanelDecision,
  PanelContext,
  PanelOfCriticsOptions,
  ReviewerRunner,
} from "@arbor/campaign-support";

export { ContextOverflowError, prepareTokenDispatch, projectTokenDispatchPrompt } from "@arbor/campaign-support";
export type { ExpansionTokenEpochPort, ProviderTokenBridge, StructuralContextPort, TokenEconomyConfig, TokenDispatchPreparation } from "@arbor/campaign-support";
export { modelCapabilityTokenBridge } from "@arbor/campaign-support";
export { buildNodeCostAttribution, detectRedundantToolCalls } from "@arbor/campaign-support";
export type { AttributableCall } from "@arbor/campaign-support";
export { buildContextEconomyObservation } from "./context-economy.js";
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
} from "@arbor/campaign-support";
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
} from "@arbor/campaign-support";
// `ArborAgentName`/`ArborCategoryName` moved to `@arbor/core`; re-exported via
// `./types.js`'s own re-export for backward compatibility.
export type {
  ArborAgentName,
  ArborCategoryName,
  OpencodeAgentConfig,
  PermissionConfig,
  PermissionEffect,
  PermissionContext,
  PlanDocument,
  PlanStep,
  PlanRisk,
  PlanIntent,
  XylemFinding,
  LenticelPlanVerdict,
  BurlPlanVerdict,
  PlanReviewDecision,
} from "./types.js";
export { resolveLearnedForkThresholdMs, type LearnedForkThreshold } from "./race-threshold.js";
