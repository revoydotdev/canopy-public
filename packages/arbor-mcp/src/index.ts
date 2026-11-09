export { CampaignManager } from "./manager.js";
export type { RecoverableNodeView, RecoveryDiagnostic, RecoveryDiagnosticCode } from "./manager.js";
export { TaskComposer } from "./task-composer.js";
export type { TaskComposerOptions, TaskComposerPlannerPort, TaskComposerAdmissionPort } from "./task-composer.js";
export { parseTaskComposerProposal, validateTaskComposerCommand, validateTaskComposerQuery, validateTaskComposerProposal } from "./task-composer-contracts.js";
export type { TaskComposerSource, TaskComposerStatus, TaskComposerQuestion, TaskComposerProposal, TaskComposerPlannerProjection, TaskComposerDraft, TaskComposerCommand, TaskComposerQuery, TaskComposerCommandEnvelope, TaskComposerQueryEnvelope, TaskComposerValidation } from "./task-composer-contracts.js";
export { isResultAdoptCommandEnvelope, isResultRevertCommandEnvelope, isResultReviewQueryEnvelope, parseResultAdoptFingerprint, parseResultRevertFingerprint, validateResultAdoptCommand, validateResultRevertCommand, validateResultReviewQuery } from "./result-review-contracts.js";
export type { ResultAdoptCommand, ResultRevertCommand, ResultReviewQuery, ResultReviewQueryEnvelope, ResultReviewValidation } from "./result-review-contracts.js";
export { adoptCapturedResult, authorizeScopeExpansion, bestVerifiedResult, captureWorktreeResult, inspectCapturedResult, listCapturedResults, readScopeExpansion, readScopeExpansionAuthorization, revertCapturedResult } from "./result-adoption.js";
export type { AdoptOutcome, CapturedResult, CapturedResultInspection, RevertOutcome, ScopeExpansionAuthorization, ScopeExpansionAuthorizationOutcome, ScopeExpansionRecord } from "./result-adoption.js";
export { classifyGovernanceTier, createHeuristicArbiterIntakePort, incorporatePlannerWritePaths, parseArbiterDecisionOutput, validateArbiterDecisionOutput, ARBITER_DECISION_CONTRACT, ARBITER_DECISION_SCHEMA, ARBITER_DECISION_SCHEMA_ID } from "./arbiter-intake.js";
export { composeArbiterIntakePort, createNativeArbiterPort, nativeArbiterDecisionInstruction, ARBOR_ARBITER_TRANSPORT_ENV, ARBOR_NATIVE_ARBITER_MODEL_ENV } from "./native-arbiter-transport.js";
export type { NativeArbiterIntakePort, NativeArbiterPortDeps } from "./native-arbiter-transport.js";
export type { ArbiterIntakePort, ArbiterDecisionOutput, ArbiterDecisionValidation, HeuristicArbiterIntakePortOptions } from "./arbiter-intake.js";
export { ArborMCPServer } from "./server.js";
export type { ServerTool, ResourceDefinition } from "./server.js";
export { defineTools } from "./tools.js";
export { defineResources } from "./resources.js";
export { ArborWebUIServer } from "./webui.js";
export { ArborRuntime, CAMPAIGN_RUN_JOB_KIND } from "./runtime.js";
export { RuntimePerformanceProbe, RUNTIME_COST_BUCKETS_MS } from "./runtime-performance-probe.js";
export type { RuntimeCostObservation, RuntimeCostOperation, RuntimeCostSummary } from "./runtime-performance-probe.js";
export { CampaignRunAttemptIndex, CAMPAIGN_RUN_ATTEMPT_INDEX_VERSION } from "./campaign-run-attempt-index.js";
export type {
  CampaignRunAttempt,
  CampaignRunAttemptRefusal,
  CampaignRunAttemptAdmissionInput,
  CampaignRunAttemptRefusalInput,
  CampaignRunAttemptResult,
  CampaignRunAttemptIndexOptions,
  CampaignRunAttemptLatestTaskState,
  CampaignRunAttemptDiagnostic,
  CampaignRunAttemptDiagnosticCode,
} from "./campaign-run-attempt-index.js";
export { projectCampaignRunStatus, isTerminalSupervisorTaskState } from "./campaign-run-status-projection.js";
export type {
  CampaignRunExecutionState,
  CampaignRunTerminalOutcome,
  CampaignRunStatus,
  CampaignRunStatusIntegrityError,
  CampaignRunStatusProjection,
  CampaignRunStatusCampaignFact,
  CampaignRunStatusDiagnostic,
  ProjectCampaignRunStatusInput,
} from "./campaign-run-status-projection.js";
export {
  initialProjectionLifecycle,
  beginProjectionRequest,
  resolveProjectionSuccess,
  resolveProjectionFailure,
  markProjectionUnavailable,
  checkProjectionFreshness,
} from "./projection-lifecycle.js";
export type {
  ProjectionLifecycleState,
  ProjectionTransportState,
  ProjectionResyncState,
  ProjectionFailure,
  ProjectionLifecycle,
  ProjectionClock,
  ProjectionFreshnessPolicy,
  ResolveProjectionSuccessParams,
  ResolveProjectionFailureParams,
  MarkProjectionUnavailableParams,
} from "./projection-lifecycle.js";
export {
  PROJECTION_FRESHNESS_CATALOG,
  isRegisteredProjectionClass,
  resolveProjectionFreshnessPolicy,
  projectCampaignRunStatusLifecycle,
} from "./projection-lifecycle-catalog.js";
export type { ProjectionClass, CampaignRunStatusLifecycleParams } from "./projection-lifecycle-catalog.js";
export { projectGateRefusalLifecycle } from "./projection-lifecycle-catalog.js";
export type { GateRefusalLifecycleParams } from "./projection-lifecycle-catalog.js";
export {
  GATE_REFUSAL_PROJECTION_MAX_TEXT,
  GATE_REFUSAL_PROJECTION_SCHEMA_VERSION,
  projectGateRefusal,
  projectGateUnavailable,
  projectGateRecord,
  isGateRefusalProjection,
  defaultGateRemediation,
} from "./gate-refusal-projection.js";
export type { GateRefusalProjection, GateRefusalProjectionState, GateCorrectingActor, GateCorrectiveAction, GateRefusalInput, GateUnavailableInput } from "./gate-refusal-projection.js";
export { AcpIdeJourney, createAcpIdeRuntimePort } from "./acp-ide.js";
export type { AcpIdeDraft, AcpIdeQuestion, AcpIdeNotification, AcpIdeRequest, AcpIdeResponse, AcpIdeRuntimePort, AcpIdeVerifiedResult } from "./acp-ide.js";
export { runAcpIdeStdio } from "./acp-ide-stdio.js";
export type { AcpIdeStdioInput, AcpIdeStdioOutput } from "./acp-ide-stdio.js";
export { SessionIdentityService } from "./session-identity-service.js";
export type { SessionIdentity, SessionIdentityMutation } from "./session-identity-service.js";
export { ResultVerificationService } from "./result-verification-service.js";
export type { ResultVerificationRecord, VerificationCheck, VerificationConfidence } from "./result-verification-service.js";
export { NotificationInboxService } from "./notification-inbox-service.js";
export type { InboxNotification, NotificationDeliveryPolicy, NotificationSeverity, QuietHours } from "./notification-inbox-service.js";
export { FollowUpLineageService } from "./follow-up-lineage-service.js";
export type { FollowUpLineage } from "./follow-up-lineage-service.js";
export { isProductUxCommandEnvelope, isProductUxQueryEnvelope, validateProductUxCommand, validateProductUxQuery } from "./product-ux-contracts.js";
export type { ProductUxCommand, ProductUxCommandEnvelope, ProductUxQuery, ProductUxQueryEnvelope } from "./product-ux-contracts.js";
export { RemoteSessionAuthority, createRemoteSessionIdentity } from "./remote-session.js";
export type { RemoteSessionIdentity, RemoteSessionProof, RemoteSessionRegistration, RemoteSessionStatus, RemoteSessionVerification, RemoteThreadAudience } from "./remote-session.js";
export { RemoteRuntimeIngress } from "./remote-ingress.js";
export type { RemoteIngressEnvelope } from "./remote-ingress.js";
export { A2ADirectThreadProfileAdapter, createA2ADirectThreadProfileAdapter, A2A_DIRECT_THREAD_A2A_VERSION, A2A_DIRECT_THREAD_PROFILE_ID } from "./a2a-direct-thread-profile.js";
export type { A2ADirectThreadAckInput, A2ADirectThreadProfileCard, A2ADirectThreadProfileResult, A2ADirectThreadSendInput, A2ADirectThreadTask } from "./a2a-direct-thread-profile.js";
export {
  ManagerSelectionCommunicationAdapter,
  ManagerOutputEvidenceCaptureAdapter,
  ManagerTelemetryAdapter,
  ManagerScoreContextAdapter,
  RuntimeModelCapabilityAdapter,
} from "./loop-adapters.js";
export type {
  ManagerSelectionCommunicationPort,
  ManagerOutputEvidenceCapturePort,
  ManagerTelemetryPort,
  CommunicationCapabilityTier,
  ProviderModelCapabilityPort,
  ResolvedOutputLimit,
  CanonicalLoopPorts,
} from "./loop-adapters.js";
export { CampaignSurveillanceSource, SurveillanceMonitor } from "./surveillance-monitor.js";
export type { SurveillanceMonitorOptions, SurveillanceProjectionSource, SurveillanceScanResult } from "./surveillance-monitor.js";
export type { SurveillanceRuntimeEvent } from "./runtime.js";
export * from "./surveillance-contracts.js";
export type {
  RuntimeCompositionOptions,
  CampaignRunner,
  CampaignRunOutcome,
  RuntimeHealth,
  RuntimeLifecycleParticipant,
  RuntimeLifecycleState,
  RuntimeResult,
  RuntimeView,
} from "./runtime.js";
export { HarnessControlPlane, NATIVE_HARNESS_CONNECTOR_ID, createNativeHarnessConnectorDescriptor } from "./harness-control-plane.js";
export type { HarnessConnectorSelection, HarnessControlPlaneOptions } from "./harness-control-plane.js";
export { createNativeLoopExecutor } from "./native-loop-executor.js";
export { resolveCampaignExecutorLane, parseCampaignExecutorRequest, CanopyLaneUnavailableError, type CampaignExecutorLane, type CampaignLaneResolution } from "./campaign-executor-lane.js";
export { admitDeprecatedHarnessLane, CANOPY_CONNECTOR_ID, DEFAULT_HARNESS_INTEGRATION_ID, DeprecatedHarnessRefusal, projectDeprecatedHarnessRefusal, recordDeprecatedHarnessAdmission, resolveConfiguredHarnessIntegrationId, resolveDeprecatedHarnessOptIn, type DeprecatedHarnessAdmission, type DeprecatedHarnessLane } from "./canopy-lane-policy.js";
export type { NativeLoopExecutorOptions, NativeLoopSessionRecord, NativeLiveSessionPort } from "./native-loop-executor.js";
export { LiveNativeSessionRegistry } from "./live-native-session-registry.js";
export type { LiveNativeSessionRegistration, LiveNativeSessionView, LiveNativeSessionInterruptResult } from "./live-native-session-registry.js";
export { HarnessSessionJournal } from "./harness-session-journal.js";
export type { HarnessSessionSummary, HarnessSessionRecoveryDisposition, HarnessSessionEventProjection, HarnessSessionDiagnostic, HarnessSessionCorruptionDiagnostic, HarnessSessionToolAuditProjection, HarnessSessionArtifactProjection, HarnessSessionContinuationIntentHistory } from "./harness-session-journal.js";
export { HookBus } from "./hooks/bus.js";
export { HookCatalog } from "./hooks/catalog.js";
export type { HookFiredRecord, HookBusOptions } from "./hooks/bus.js";
export type { HookDescriptor, HookEvent, HookHandlerRegistry, HookKind, ValidatedHook } from "./hooks/contracts.js";
export { CommandCatalog, CommandCatalogError, commandPaletteActions, invokeUserCommand } from "./extensibility/command-catalog.js";
export type { CommandCatalogDiagnostic, InvokedUserCommand, UserCommand } from "./extensibility/command-catalog.js";
export { canonicalPluginPayload, parsePluginManifest, validateTierAuthority, verifyPluginManifest } from "./extensibility/plugin-manifest.js";
export type { PluginGate, PluginManifest, PluginSource, PluginTrustTier } from "./extensibility/plugin-manifest.js";
export { PluginRegistry, PluginTierLedger } from "./extensibility/plugin-registry.js";
export { InstallableIntegrationSdk, INSTALLABLE_INTEGRATION_SDK_VERSION, commandSkillIntegrationAdapter, mcpIntegrationAdapter, parseIntegrationPackage, probeInstallableIntegrationHealth } from "./integration-sdk.js";
export type { InstallableIntegrationPackage, InstallableIntegrationInspection, InstallableIntegrationSdkOptions, IntegrationSdkAdapter, IntegrationSdkHealth, IntegrationSdkHealthState } from "./integration-sdk.js";
export { RELEASE_ARTIFACT_MAX_BYTES, RELEASE_MANIFEST_SCHEMA_VERSION, RELEASE_PRODUCT, RELEASE_TRUST_STORE_FILENAME, activeReleaseVersion, activateVerifiedRelease, canonicalReleasePayload, compareReleaseVersions, fetchReleaseCandidate, initializeReleaseTrustStore, loadReleaseTrustStore, parseReleaseManifest, releaseTrustRootFingerprint, rollbackVerifiedRelease, verifyRelease } from "./distribution.js";
export type { ReleaseActivation, ReleaseActivationOptions, ReleaseAuditRecord, ReleaseCandidate, ReleaseChannel, ReleaseManifest, ReleaseTrustRoot, ReleaseTrustStore, VerifiedRelease, VerifyReleaseOptions } from "./distribution.js";
export { planSafeStartup, SafeStartupController } from "./safe-startup.js";
export type { SafeStartupDiagnostic, SafeStartupParticipant, SafeStartupParticipantKind, SafeStartupPlan, SafeStartupTrust } from "./safe-startup.js";
export { LocalIntegrationRegistry } from "./integration-local-registry.js";
export type { LocalIntegrationRegistryEntry } from "./integration-local-registry.js";
export { createNativePeerToolPorts } from "./native-peer-tools.js";
export type { NativePeerToolScope } from "./native-peer-tools.js";
export { SignedIntegrationMarketplace } from "./integration-marketplace.js";
export type { SignedMarketplaceIndex, MarketplacePackage, MarketplaceFetch, IntegrationBundle } from "./integration-marketplace.js";
export { REPRESENTATIVE_INTEGRATIONS, REPRESENTATIVE_PROVIDER_BRIDGE_SOURCE, createRepresentativeIntegrationPackage, createRepresentativeIntegrationBundle } from "./representative-integrations.js";
export type { AdmittedPlugin, PluginRegistryOptions, PluginTierFact } from "./extensibility/plugin-registry.js";
export { extractHarnessSessionModelIdentity } from "./harness-session-journal.js";
export { DIRECT_NATIVE_SESSION_EXECUTION, OPENCODE_FALLBACK_SESSION_EXECUTION } from "./harness-session-execution.js";
export type { HarnessSessionConnectorId, HarnessSessionExecutionKind, HarnessSessionExecution } from "./harness-session-execution.js";
export { NativeAgentExecutor, createNativeSessionContext, NATIVE_SUBAGENT_TOOL_RISKS } from "./native-agent-executor.js";
export { NATIVE_TOOL_RISK_MANIFEST } from "./native-tool-risk-manifest.js";
export { NativePeerChannelService } from "./native-peer-channel.js";
export type { NativePeerRelationshipGrant, NativePeerMutationResult } from "./native-peer-channel.js";
export { isNativePeerCommandEnvelope, isNativePeerQueryEnvelope, validateNativePeerCommand, validateNativePeerQuery } from "./native-peer-channel-contracts.js";
export type { NativePeerCapability, NativePeerCapabilityTier, NativePeerCommand, NativePeerCommandEnvelope, NativePeerQuery, NativePeerQueryEnvelope, NativePeerTrustedCaller } from "./native-peer-channel-contracts.js";
export { createOpenAICompatibleModelPort } from "@arbor/harness";
export { DEFAULT_REPOSITORY_RETRIEVAL_STRATEGY, RepositoryGraphIndex } from "./repository-graph.js";
export type { RepositoryGraphQuery, RepositoryGraphResult, RepositoryRetrievalSignals, RepositoryRetrievalStrategy, VerifiedMemoryRetrievalSignal } from "./repository-graph.js";
export type { NativeAgentExecutorOptions, NativeAgentExecutorSessionRecord, NativeReadOnlyEvaluationResult, NativeSpecialistVerificationPort, NativeSessionContextScope } from "./native-agent-executor.js";
export { NATIVE_CRITIC_VERDICT_CONTRACT, NATIVE_CRITIC_VERDICT_SCHEMA, NATIVE_CRITIC_VERDICT_SCHEMA_ID, nativeCriticVerdictInstruction, parseNativeCriticVerdict } from "./native-critic-contract.js";
export type { NativeCriticStructuredVerdict, NativeCriticVerdictContract } from "./native-critic-contract.js";
export { NATIVE_TASK_PLAN_CONTRACT, NATIVE_TASK_PLAN_SCHEMA, NATIVE_TASK_PLAN_SCHEMA_ID, normalizeProviderPlan } from "./native-task-plan-contract.js";
export { ProductionHarnessEvaluator } from "./production-harness-evaluator.js";
export { WorktreeMachineVerifier } from "./worktree-machine-verifier.js";
export { createSandboxBroker, SANDBOX_CONFINEMENT_LEVELS, DEFAULT_SANDBOX_CONFINEMENT_LEVEL, SandboxConfinementUnavailableError } from "./sandbox/sandbox-broker.js";
export type { SandboxBrokerOptions, SandboxConfinementLevel } from "./sandbox/sandbox-broker.js";
export { SandboxedVerificationCommandPort } from "./sandbox/confined-command.js";
export type { ConfinementGrade, SandboxBroker, SandboxedCommandRequest, SandboxedCommandResult } from "./sandbox/contracts.js";
export type {
  MachineVerificationCommandPort,
  MachineVerificationCommandRequest,
  MachineVerificationCommandResult,
  SpecialistWorktreeVerificationInput,
  SpecialistWorktreeVerificationPort,
  VerificationNetworkPolicy,
  WorktreeMachineVerifierOptions,
  WorktreeVerificationCommand,
  WorktreeVerificationSpec,
  StagedWorktreeVerificationCommand,
  VerificationStageResult,
} from "./worktree-machine-verifier.js";
export { ScopedNativeCredentialBroker, ScopedCredentialLeaseError } from "./scoped-native-credential-broker.js";
export type { NativeCredentialSessionScope, ScopedNativeCredentialBrokerOptions } from "./scoped-native-credential-broker.js";
export { NativeSystemPolicyApprovalPort } from "./native-system-policy-approval.js";
export type { NativeSystemPolicyApprovalOptions } from "./native-system-policy-approval.js";
export { composeNativeRole, defaultNativeRoleFor } from "./native-role-composer.js";
export type { NativeRoleComposition, NativeRoleCompositionInput } from "./native-role-composer.js";
export { createNativeRepositoryToolHost, nativeRepositoryToolPorts, NATIVE_REPOSITORY_TOOL_RISKS, NATIVE_USERINPUT_TOOL_RISKS, NATIVE_IMAGE_TOOL_RISKS, createNativeImageToolPorts, NATIVE_DOCUMENTATION_WRITE_PATH_POLICY, enforcesDocumentationWritePaths } from "./native-tool-host.js";
export type { NativeGovernedImageCatalogPort } from "./native-tool-host.js";
export type {
  NativeRepositoryToolDescriptor,
  NativeRepositoryToolHostOptions,
  NativeToolAuditRecord,
  NativeToolFilesystemPolicy,
  NativeToolIntent,
  NativeToolOutcome,
  NativeToolOutcomeStage,
  NativeWritePathPolicy,
} from "./native-tool-host.js";
export { DevToolsTraceLogger, createDevToolsTraceLogger, devtoolsLoopHook, devtoolsHookForRuntime } from "./devtools-log.js";
export type { DevToolsLogLine, DevToolsLoopEventLike, DevToolsTraceLoggerOptions } from "./devtools-log.js";
export { defineDevToolsTools } from "./devtools.js";
export type {
  DevToolsBreakpointInput,
  DevToolsClearInput,
  DevToolsOpenCampaignInput,
  DevToolsProbeInput,
  DevToolsSnapshotInput,
  DevToolsStepInput,
  DevToolsTraceTailInput,
  DevToolsView,
} from "./devtools.js";
export { BreakpointRegistry, kindMatches } from "./devtools-breakpoints.js";
export type {
  DevToolsBreakpointKind,
  DevToolsBreakpointMatch,
  DevToolsBreakpointRejection,
  DevToolsBreakpointRegistration,
  RegisteredBreakpoint,
} from "./devtools-breakpoints.js";
export { RUNTIME_CATALOG, RuntimeCatalogRouter, mapRuntimeBoundaryError } from "./runtime-catalog.js";
export { CAPABILITY_INDEX, CAPABILITY_INDEX_REVISION, compareCapabilitySurfaces } from "./capability-index.js";
export type { CapabilityObservation, CapabilitySurfaceDrift, CapabilityDriftReport } from "./capability-index.js";
export { MCP_SERVER_OPERATIONS, MCP_SERVER_OPERATION_NAMES } from "./mcp-operation-manifest.js";
export { RuntimePortAdapter } from "./tui-adapter.js";
export type { RuntimePortTelemetrySink } from "./tui-adapter.js";
export type { TuiPort, TuiPortCommandAcknowledgement, TuiPortError, TuiPortResult, DevtoolsStreamLine, DevtoolsStreamResult } from "./tui-adapter.js";
export { demomain } from "./demo.js";
export { runTui, tuimain } from "./tui.js";
export type { TuiLaunchOptions } from "./tui.js";
export { captureFOINativeRuntimeRoundTrip, captureFOINativeRuntimeScenario } from "./foi-native-runtime-capture.js";
export type { FOINativeRuntimeCapture, FOINativeRuntimeScenarioId } from "./foi-native-runtime-capture.js";
export { createCanopyDebugCaptureStore } from "./canopy-debug-capture.js";
export type { CanopyDebugCaptureKind, CanopyDebugCaptureRecord, CanopyDebugCaptureStore, CanopyDebugCaptureStoreOptions } from "./canopy-debug-capture.js";
export { createCanopyDebugJournal, defaultCanopyDebugPersistenceDir } from "./canopy-debug-journal.js";
export type { CanopyDebugJournal, CanopyDebugJournalOptions, CanopyDebugArtifactInput, CanopyDebugArtifactRecord } from "./canopy-debug-journal.js";
export { isCanopyDebugEnabled } from "./canopy-debug-launch.js";
// Evaluation-facing operator-interface contracts are re-exported through the
// product composition package so @arbor/eval does not acquire a second direct
// dependency on the presentation package.
export {
  FOI_CORPUS_ID, FOI_EVIDENCE_SCHEMA_VERSION, FOI_V1_SCENARIOS,
  foiScenario, materializeFOIScenario, validateFOIScenarioEvidence,
  captureFOIScenarioArtifacts, captureFOINativeScenarioArtifacts,
  captureFOIInteractionBenchmark,
} from "@arbor/tui";
export type { FOICapturedArtifacts, FOINativeCapturedArtifacts, FOIScenarioId } from "@arbor/tui";
export type {
  OutputCaptureAcknowledgement, OutputCaptureCommandEnvelope, OutputDescriptorProjection, OutputQueryEnvelope,
} from "./output-contracts.js";
export type {
  CommunicationCommand, CommunicationQuery, CommunicationCommandEnvelope,
  CommunicationQueryEnvelope, CommunicationProjection,
} from "./communication-contracts.js";
export type {
  CompactionCommand, CompactionQuery, CompactionCommandEnvelope,
  CompactionQueryEnvelope, CompactionListProjection, CompactionGuardProjection,
} from "./compaction-contracts.js";
export { isPhaseMessageQueryEnvelope, validatePhaseMessageQuery } from "./phase-message-contracts.js";
export type {
  PhaseMessageQuery, PhaseMessageQueryEnvelope, PhaseMessageListProjection,
} from "./phase-message-contracts.js";
export type {
  RuntimeCatalogEntry,
  RuntimeCatalogKind,
  RuntimeRouterOptions,
  RuntimeRouterResult,
} from "./runtime-catalog.js";
export { projectMemoryFacts, projectMemoryFactsPage } from "./memory-projector.js";
export type {
  MemoryProjectionPage, MemoryProjectionPageRequest, MemoryProjectionRequest, ProjectedMemoryEntry,
} from "./memory-projector.js";
export {
  SUPERVISOR_SNAPSHOT_VERSION,
  loadSupervisorSnapshot,
  reconcileSupervisorTemporaryFiles,
  saveSupervisorSnapshot,
} from "./supervisor-persist.js";

export { TokenEpochService } from "./token-epoch-service.js";
export { NativeCampaignBudgetAuthority } from "./native-campaign-budget.js";
export { NATIVE_BUDGET_REMEDIATION_RESERVE_FRACTION } from "./native-campaign-budget.js";
export type { NativeCampaignBudgetConfig, NativeCampaignBudgetSnapshot, NativeCampaignBudgetReservation, NativeCampaignBudgetSettlement } from "./native-campaign-budget.js";
export { isNativeCampaignBudgetQueryEnvelope, validateNativeCampaignBudgetQuery } from "./native-campaign-budget-contracts.js";
export type { NativeCampaignBudgetProjection, NativeCampaignBudgetQueryEnvelope } from "./native-campaign-budget-contracts.js";
export { PHASE_DURATION_BUCKETS_MS, projectTelemetry } from "./metrics-projector.js";
export { projectCostHud, renderCostStatusLine, formatCostStatusLine, ShellStatusLineRenderer } from "./cost/hud-projection.js";
export type { CostHudProjection, StatusLineRenderer } from "./cost/hud-projection.js";
export type {
  MetricEvidencePointer, MetricCounterRow, PhaseHistogramRow, UsageCostRow, ContextEconomyRow, ToolEconomyRow,
  TelemetryProjection, TelemetryProjectionOptions,
} from "./metrics-projector.js";
export type { EnsureTokenEpochInput, TokenEpochDiagnostic } from "./token-epoch-service.js";
export { isInterruptionCommandEnvelope, validateInterruptionCommand } from "./interruption-contracts.js";
export type { InterruptionCommandEnvelope } from "./interruption-contracts.js";
export { RecoveryService } from "./recovery-service.js";
export { EffectClassifier, classificationFingerprint } from "./recovery/effect-classifier.js";
export { buildContinuationPlan, validateContinuationDispositions } from "./recovery/continuation-plan.js";
export { runRecoveryCommand } from "./recovery/recovery-command.js";
export * from "./recovery/contracts.js";
export { ConfigInspectionService, composeEffectiveConfig } from "./config-inspection.js";
export type { ConfigLeaf, ConfigSourceKind, EffectiveConfigView } from "./config-inspection.js";
export { isConfigQueryEnvelope, validateConfigQuery } from "./config-contracts.js";
export { isCompactionCommandEnvelope, isCompactionQueryEnvelope, validateCompactionCommand, validateCompactionQuery } from "./compaction-contracts.js";
export type { ConfigInspectionProjection, ConfigQueryEnvelope } from "./config-contracts.js";
export {
  validateA2AMessage, validateA2ATask, isA2AMessage,
  A2A_MAX_NODE_REF_BYTES, A2A_MAX_TEXT_PART_BYTES, A2A_MAX_PARTS, A2A_MAX_RECIPIENTS,
} from "./a2a-contracts.js";
export type { A2AAgentCard, A2AArtifact, A2AMessage, A2APart, A2APartKind, A2ATask, A2ATaskState } from "./a2a-contracts.js";
export { inboundA2AToNodeCommunication, outboundNodeCommunicationToA2A, publishNodeCardAsA2A, verifyA2AAgentCard } from "./a2a-bridge.js";
export type { A2ABridgeConfig } from "./a2a-bridge.js";
export { AgentRegistry, agentFromTaskKind, composeAgentRegistry, isAgentRole, AGENT_ROLES } from "./agent-registry.js";
export type { AgentCapabilityTier, AgentDefinition, AgentDefinitionSource, AgentRegistryView, AgentRole, LiveAgentInstance } from "./agent-registry.js";
export { isAgentQueryEnvelope, validateAgentQuery } from "./agent-contracts.js";
export type { AgentQueryEnvelope, AgentRegistryProjection } from "./agent-contracts.js";
export { isBusCommandEnvelope, isBusQueryEnvelope, validateBusCommand, validateBusQuery } from "./bus-contracts.js";
export type { BusCommand, BusQuery, BusCommandEnvelope, BusQueryEnvelope, BusHistoryProjection } from "./bus-contracts.js";
export { isParentChildThreadAckEnvelope, isParentChildThreadSendEnvelope, isParentChildThreadHistoryEnvelope, validateParentChildThreadAck, validateParentChildThreadSend, validateParentChildThreadHistory } from "./parent-child-thread-contracts.js";
export type { ParentChildThreadAckCommand, ParentChildThreadAckEnvelope, ParentChildThreadSendCommand, ParentChildThreadHistoryQuery, ParentChildThreadSendEnvelope, ParentChildThreadHistoryEnvelope, ParentChildThreadSendAcknowledgement, ParentChildThreadHistoryProjection } from "./parent-child-thread-contracts.js";
export type { ParentChildThreadPushAdapter, ParentChildThreadPushEvent } from "./thread-push.js";
export { projectCrossSessionHandoff } from "./cross-session-handoff.js";
export type { CrossSessionHandoffInput, CrossSessionHandoffProjection, HandoffCampaignNode, ReplanTrigger } from "./cross-session-handoff.js";
export { isSiblingStatusQueryEnvelope, validateSiblingStatusQuery } from "./sibling-contracts.js";
export type { SiblingStatusQuery, SiblingStatusQueryEnvelope, SiblingStatusProjection } from "./sibling-contracts.js";
export {
  isA2ASendCommandEnvelope, isA2AReceiveCommandEnvelope, validateA2ASendCommand, validateA2AReceiveCommand,
} from "./a2a-runtime-contracts.js";
export type {
  A2ASendCommand, A2AReceiveCommand, A2ASendCommandEnvelope, A2AReceiveCommandEnvelope, A2ASendAcknowledgement,
} from "./a2a-runtime-contracts.js";
export { JobScheduler } from "./job-scheduler.js";
export type { Job, JobQueueView, JobSchedulerOptions, JobState, JobSubmitInput } from "./job-scheduler.js";
export { LongHorizonScheduler } from "./scheduler/scheduler.js";
export { DurableScheduleStore } from "./scheduler/schedule-store.js";
export { PlanReuseCache, intentTemplate } from "./scheduler/plan-reuse.js";
export { nextCronOccurrence } from "./scheduler/cron.js";
export type { CampaignSchedule, CatchUpPolicy, ReusedPlan, ScheduledCampaignLauncher, ScheduledRunRecord, ScheduleState, ScheduleTrigger, VerifiedPlanTemplate } from "./scheduler/contracts.js";
export { DifficultyCalibrator } from "./routing/difficulty.js";
export { DifficultyRoutingPolicy } from "./routing/routing-policy.js";
export type { DifficultyTaskFeatures } from "./routing/difficulty.js";
export type { ModelRoutingDescriptor, RoutingDecision, RoutingModelTier } from "./routing/routing-policy.js";
export { isJobCommandEnvelope, isJobListQueryEnvelope, validateJobCommand, validateJobListQuery } from "./job-contracts.js";
export type { JobCommandAcknowledgement, JobCommandEnvelope, JobCommandKind, JobListProjection, JobListQueryEnvelope } from "./job-contracts.js";
export { ApprovalService, isApprovalAction } from "./approval-service.js";
export type { ApprovalAction, ApprovalDecisionInput, ApprovalLeaseScope, ApprovalMemoryRule, ApprovalMemoryScope, ApprovalRecord, ApprovalRequestInput, ApprovalServiceOptions, ApprovalStatus } from "./approval-service.js";
export { isApprovalListQueryEnvelope, isApprovalRequestEnvelope, validateApprovalListQuery, validateApprovalRequest } from "./approval-contracts.js";
export type { ApprovalCommandKind, ApprovalDecisionKind, ApprovalListProjection, ApprovalListQueryEnvelope, ApprovalRequestAcknowledgement, ApprovalRequestEnvelope } from "./approval-contracts.js";
export { isTrustSessionCommandEnvelope, isTrustSessionQueryEnvelope, validateTrustSessionCommand, validateTrustSessionQuery } from "./trust-session-contracts.js";
export type { TrustSessionAcknowledgement, TrustSessionCommandEnvelope, TrustSessionListProjection, TrustSessionQueryEnvelope } from "./trust-session-contracts.js";
export type {
  RecoveryAction,
  RecoveryActorRole,
  RecoveryCampaignPort,
  RecoveryLeaseAuthority,
  RecoveryNodeView,
  RecoveryRequest,
  RecoveryResult,
  RecoveryContinuationAdmissionAuthority,
  ContinuationPreparationRequest,
  ContinuationPreparationResult,
} from "./recovery-service.js";
export { createWorktreeRecoveryLeaseAuthority } from "./recovery-lease-adapter.js";
export type { WorktreeRecoveryLeaseOptions } from "./recovery-lease-adapter.js";
export { GovernedContextService } from "./governed-context-service.js";
export { isGovernedContextCommandEnvelope, isGovernedContextQueryEnvelope, validateGovernedContextCommand, validateGovernedContextQuery } from "./governed-context-contracts.js";
export type { GovernedContextCommand, GovernedContextQuery, GovernedContextCommandEnvelope, GovernedContextQueryEnvelope } from "./governed-context-contracts.js";
export {
  OPERATION_SNAPSHOT_VERSION,
  loadOperationSnapshot,
  reconcileOperationTemporaryFiles,
  saveOperationSnapshot,
} from "./operation-persist.js";
export type {
  OperationPersistenceDiagnostic,
  OperationPersistenceDiagnosticCode,
  OperationPersistenceLoadResult,
  OperationSnapshot,
} from "./operation-persist.js";
export type {
  SupervisorPersistenceDiagnostic,
  SupervisorPersistenceDiagnosticCode,
  SupervisorPersistenceLoadResult,
  SupervisorSnapshot,
} from "./supervisor-persist.js";

// Liveness attestation — the invocation-based counterpart to the static gates.
// See `liveness.ts`'s header for why "reachable" and "answers when called" are
// different questions, and which defects live in the gap between them.
export {
  classifyRuntimeError,
  probeCatalog,
  probeConsumers,
  buildLivenessReport,
  summarize,
  probePayloads,
} from "./liveness.js";
export type {
  LivenessOutcome,
  CatalogLivenessProbe,
  ConsumerLivenessProbe,
  LivenessReport,
  LivenessSummary,
  LivenessProbeContext,
  DeclaredConsumer,
  ProbePayload,
} from "./liveness.js";
export { runLiveness, formatLivenessReport, livenessRouterFromCompositionRoot } from "./liveness-runner.js";
export type { LivenessRunOptions } from "./liveness-runner.js";
export { LocalSessionAuthority, verifyLocalSessionProof } from "./local-session.js";
export type { LocalSessionIdentity, LocalSessionProof } from "./local-session.js";
export { buildRunReport, formatRunReport } from "./run-report.js";
export type { RunReport, RunReportOptions, RunReportResult } from "./run-report.js";
export { RemoteOperationTokenAuthority, RemoteGrantError } from "./remote/ephemeral-token.js";
export { RemoteResultReconciler } from "./remote/remote-reconcile.js";
export { AuthenticatedRemoteHttpHost, createAuthenticatedRemoteHttpHost } from "./remote/http-listener.js";
export type { RemoteOperationCapability, RemoteOperationScope, RemoteGrantProjection, RemoteGrantState } from "./remote/ephemeral-token.js";
export type { RemoteResultClaim, LocalRemoteResultVerifier } from "./remote/remote-reconcile.js";
export type { AuthenticatedRemoteHttpOptions } from "./remote/http-listener.js";
export type { BoundRemoteTransportAddress, BoundRemoteTransportHost } from "./remote/transport-contract.js";
export {
  REMOTE_TRANSPORT_PROTOCOL,
  REMOTE_TRANSPORT_CANONICALIZATION,
  REMOTE_TRANSPORT_MIN_NONCE_BYTES,
  REMOTE_TRANSPORT_MIN_NONCE_CHARACTERS,
  REMOTE_TRANSPORT_COMMAND_KINDS,
  remoteTransportError,
  remoteTransportSigningEnvelope,
  canonicalizeRemoteTransportSigningEnvelope,
  canonicalizeJcs,
  parseIJson,
  validateRemoteTransportEnvelope,
} from "./remote-transport-contracts.js";
export type {
  RemoteTransportProof,
  RemoteTransportCommandMetadata,
  RemoteTransportCommand,
  RemoteTransportCommandKind,
  RemoteTransportSigningEnvelope,
  RemoteTransportEnvelope,
  RemoteTransportAuditAttribution,
  RemoteTransportErrorCode,
  RemoteTransportErrorCategory,
  RemoteTransportError,
} from "./remote-transport-contracts.js";
export {
  TUI_SCREEN_CONSUMERS,
  screensWithDispatch,
  consumersCoverScreens,
} from "./liveness-consumers.js";
export * from "./doctor.js";
export * from "./operator-maintenance.js";
export * from "./operator-maintenance-contracts.js";
export * from "./product-integrations.js";
export * from "./product-integration-contracts.js";
export { isHarnessSessionContinuationEnvelope, validateHarnessSessionContinuation } from "./harness-session-contracts.js";
export type { HarnessSessionContinuationEnvelope } from "./harness-session-contracts.js";
export * from "./operator-maintenance.js";
export * from "./operator-maintenance-contracts.js";
export * from "./prompt-input-debug.js";
export {
  loadProjectRegistry,
  saveProjectRegistry,
  computeProfileHash,
  resolveProjectRevision,
  runConformanceCheck,
  registerProject,
  verifyRegistryEntry,
  evaluateProjectRegistry,
  formatProjectRegistryReport,
  PROJECT_REGISTRY_SCHEMA_VERSION,
  PROJECT_REGISTRY_FILENAME,
  DEFAULT_REGISTRY_ENTRY_TTL_DAYS,
} from "./project-registry.js";
export type {
  ProjectRegistry,
  ProjectRegistryEntry,
  ConformanceCheckResult,
  RegisterProjectOutcome,
  RegistryEntryFailureCode,
  RegistryEntryVerification,
  ProjectRegistryReport,
} from "./project-registry.js";
export {
  enumerateGateCatalog,
  classifyGateCatalog,
  manageProjects,
  formatProjectManageReport,
} from "./project-manage.js";
export type {
  GateCatalogEntry,
  GateClassification,
  ProjectGateStatus,
  ProjectGateResult,
  ProjectManageEntryReport,
  ProjectManageReport,
} from "./project-manage.js";
export * from "./harness-session-replay-store.js";
export * from "./distributed-control-plane.js";
export * from "./distributed-remote-bridge.js";
export * from "./distributed-control-runtime.js";
export * from "./distributed-control-contracts.js";
export * from "./repo-flight-operator.js";
export * from "./repo-flight-controller.js";
export * from "./repo-flight-authority.js";
export * from "./repo-flight-contracts.js";
export * from "./repo-flight-delivery.js";
export * from "./repo-flight-effects.js";
export * from "./repo-flight-enrollment.js";
export * from "./repo-flight-gates.js";
export * from "./repo-flight-git.js";
export * from "./repo-flight-profile.js";
export * from "./repo-flight-process.js";
export * from "./repo-flight-session.js";
export * from "./repo-flight-state.js";
export * from "./repo-flight-store.js";
export * from "./repo-flight-transport.js";
export * from "./repo-flight-director.js";
export * from "./repo-flight-execution-plan.js";
export * from "./repo-flight-validation-cache.js";
export * from "./repo-flight-telemetry.js";
export * from "./repo-flight-dual-authority.js";
export * from "./repo-flight-governance-adapter.js";
export * from "./repo-flight-provider-transport-hook.js";
export * from "./repo-flight-native-transport-hook.js";
export * from "./integrations/repo-flight-provider-hook.js";
export * from "./integrations/repo-flight-native-hook.js";
export * from "./git-workspace-projection.js";
export * from "./git-workspace-contracts.js";
