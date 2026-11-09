export type { Action, ActionExecutionRole, ActionHighRiskToolScope, HighRiskCommandIntent, HighRiskCommandArgvEntry, BoundHighRiskIntent, AcceptanceCheckAssignment, TreeNode, NodeState, NodeOutcome, NodeError, CandidateArtifact, ReviewStatus, ContextOverflowSignal, MessagePhase, MemoryMode, CampaignState, CampaignConfig, HaltStatus, HaltReason, ScoreContext, ScoreConfig, MarginalCostObservation, AgentUctScoreEvidence, AgentUctScoreConfig, ScorePolicy, Provenance, VerificationCheck, VerificationCheckKind, VerificationCheckBreadth, VerificationStrength, Envelope, AbsenceReason, AgentTier, CapabilityContext, CriticVerdict, CriticCheck, GateType, GateRecord, RecoveryAttempt, RecoveryAbandonment, ProvenanceBackedOutcome, NodeErrorKind, OutcomeKind, TokenUsageResult, Cost, DecompositionRequest, DecompositionResult, DecomposerPort, TerminalOutcome, GovernanceTier, ArbiterDecisionSource, ArbiterBlastRadius, ArbiterDecision, RaceOutcomeObservation } from "./types.js";
export { isVerificationCheck, isHighRiskCommandIntent, HALT_REASONS, HALT_STATUS_REASONS, isHaltReason } from "./types.js";
export { isAllowedHarnessComponent } from "./governed-context.js";
export type { ContextArtifactRef, ContextWorkspaceView, FoldScale, MessageRangeRef, FoldMeasures, FoldProposal, FoldRecord, GovernedProjectionStatus, PlaybookDeltaKind, PlaybookDelta, HarnessMutableComponent, NonExecutableSubagentDescriptor, DeclarativeSubagentExecution, HarnessEvaluationRun, ForbiddenHarnessComponent, RevisionEvaluation, HarnessRevision, GovernedContextOverlays } from "./governed-context.js";
export { NODE_ERROR_KINDS, OUTCOME_KINDS, TERMINAL_NODE_STATES, isTerminalNodeState, STATES_CLOSED_TO_DIRECT_INPUT, isClosedToDirectInput } from "./types.js";
export { canonicalizeForHash, CanonicalizationError } from "./canonical.js";
export { assertValidCampaignId, isSafeRelativePath, isValidCampaignId } from "./campaign-id.js";
export { scoreAction, scoreActionWithPolicy, scoreAgentUct, deriveDecayingLambda, haltCheck } from "./scoring.js";
export type { HaltResult } from "./scoring.js";
export { combineReward, DEFAULT_REWARD_CONTRACT, RewardContractError } from "./reward.js";
export type { BackedUpReward, RewardCalibration, RewardComponent, RewardContractConfig, RewardObservation, RewardSource, VerifiedProvenance } from "./reward.js";
export { selectNode, createChild, beginExpansion, verifyNode, failNode, backpropagate, pruneNode, interruptNode, retryInterruptedNode, resumeAwaitingUserInputNode, abandonInterruptedNode, createCampaign, reviveFailedNode, reviveScopeBlockedNode } from "./tree.js";
export type { InterruptNodeInput, InterruptNodeResult, InterruptScope } from "./tree.js";
export { DEFAULT_SCORE_CONFIG, DEFAULT_AGENT_UCT_SCORE_CONFIG, DEFAULT_SCORE_POLICY, DEFAULT_CAMPAIGN_CONFIG } from "./types.js";
export { saveCampaign, loadCampaignResult, listCampaigns, reconcileCampaignTemporaryFiles, quarantinePersistenceFile, validateCampaignSnapshot } from "./persist.js";
export { frecencyScore, rankByFrecency } from "./frecency.js";
export { resolvePersistenceDir } from "./persistence-path.js";
export { acquireWriterLock, WRITER_LOCK_FILENAME } from "./writer-lock.js";
export type { WriterLockHandle, WriterLockRecord, WriterLockResult } from "./writer-lock.js";
export type { PersistenceArtifact, PersistenceDiagnosticCode, PersistenceDiagnostic, PersistenceLoadResult } from "./persist.js";
export { writeBoulder, readBoulderResult, reconcileBoulderTemporaryFiles } from "./boulder.js";
export type { BoulderState } from "./boulder.js";
export { RUNTIME_CONTRACT_VERSION, RUNTIME_REFUSAL_REMEDIES, isAuthorizedRefusalRemedy, isRefusalAuthority, isRuntimeGateRefusal, validateRuntimeCommand, validateRuntimeQuery, validateRuntimeEvent, validateRuntimeError, validateSupervisorTask } from "./runtime-contracts.js";
export type { RuntimeContractVersion, RuntimeCursor, OperationMetadata, ApplicationCommand, RuntimeCommandEnvelope, ApplicationQuery, RuntimeQueryEnvelope, SupervisorTaskState, SupervisorTask, RuntimeEvent, RuntimeEventEnvelope, RuntimeErrorCode, RuntimeError, RuntimeGateRefusalV1, RuntimeGateRefusalV2, RuntimeGateRefusal, RuntimeRefusalAuthority, RuntimeRemedyActor, RuntimeCorrectiveAction, CommandAcknowledgement, RuntimeContractViolation, RuntimeValidationResult } from "./runtime-contracts.js";
export { RuntimeEventStream, EventStreamError } from "./event-stream.js";
export type { RuntimeSnapshot, RuntimeResyncReason, RuntimeResumeResult, RuntimeSubscriptionOptions, RuntimeEventSubscription, RuntimeSubscriptionStatus } from "./event-stream.js";
export { TaskSupervisor, SupervisorInvariantError, DEFAULT_SIBLING_BOUNDS } from "./task-supervisor.js";
export type { SupervisorClock, TaskSupervisorOptions, TaskRegistration, TaskListOptions, SupervisorRestoreResult, SiblingBounds, ChildConcurrencyLease, ReconciliationDisposition } from "./task-supervisor.js";
export { OperationRegistry, OperationRegistryError } from "./operation-registry.js";
export type { OperationState, OperationRecord, OperationRegistration, OperationRegistryOptions } from "./operation-registry.js";
export { DEFAULT_OUTPUT_POLICY, estimateTokens, captureDescriptor, abbreviateOutput } from "./output-policy.js";
export type { OutputChannel, OutputBudget, OutputPolicy, OutputExcerpt, CaptureDescriptor } from "./output-policy.js";
export { DEFAULT_SURVEILLANCE_CONFIG, detectSurveillanceFindings } from "./surveillance.js";
export type { RejectionSignal, BranchSelectionSignal, EvidenceSignal, WorkSignal, ConvergenceSignal, SurveillanceInput, SurveillanceConfig, SurveillanceFindingKind, SurveillanceFinding } from "./surveillance.js";
export { countWithCharacterFallback, resolveTokenBudget, createExpansionTokenEpoch, claimBudgetWarning, recordTokenUsage, claimOverflowRetry, recordTokenPrefill, willManageContext, manageContext, foldStructuralContext } from "./token-economy.js";
export type { CapabilitySource, ProviderTokenCapability, TokenCount, TokenCounter, AppliedTokenBudget, TokenUsage, ContextManagementClaim, ExpansionTokenEpoch, ManagementPrediction, ManageContextResult, ContextCapability, StructuralContextEntry, StructuralFoldPolicy, FoldedStructure, FoldedContext } from "./token-economy.js";
export { deriveNodeCard, signNodeCard, verifyNodeCard, canonicalNodeCardJson, cardsForCapability, selectNodeByCapability, deriveForeground, NODE_CARD_MAX_SKILLS, NODE_CARD_MAX_INPUTS, NODE_CARD_MAX_OUTPUTS, NODE_CARD_MAX_FIELD_BYTES, FOREGROUND_MAX_DELEGATION_ENTRIES, FOREGROUND_MAX_MODEL_FAMILY_BYTES, FOREGROUND_MAX_PROMPT_FRAGMENT_BYTES } from "./node-card.js";
export type { NodeCard, NodeCardInputs, NodeCardMode, NodeCardSource, ForegroundInputs, ForegroundProjection, ForegroundDelegationEntry } from "./node-card.js";
export { ACTION_CLASSES, CapabilityError, isMutating, entitledActionClasses, requiredCapability, enforceAction } from "./capability.js";
export type { ActionClass, CapabilityTier } from "./capability.js";
export {
  NATIVE_ROLE_IDS,
  NATIVE_ROLE_AUTHORITY_MANIFEST,
  NATIVE_MODEL_TOOL_IDS,
  MCP_SERVER_OPERATIONS,
  MCP_SERVER_OPERATION_NAMES,
  NATIVE_TOOL_RISK_MANIFEST,
  NATIVE_SKILL_CAPABILITY_MANIFEST,
  NATIVE_SKILL_DESCRIPTOR_MANIFEST,
  CAPABILITY_MANIFEST_REVISION,
} from "./capability-manifest.js";
export type { NativeRoleProfileId, NativeRoleId, NativeToolRisk } from "./capability-manifest.js";
export { RUNTIME_CATALOG_MANIFEST, DESTRUCTIVE_RUNTIME_KINDS, OPEN_WORLD_RUNTIME_KINDS } from "./runtime-catalog-manifest.js";
export type { RuntimeCatalogKind, RuntimeCatalogEntry } from "./runtime-catalog-manifest.js";
export { cursorPage, cursorOffset } from "./cursor-pager.js";
export type { CursorPage, CursorPageInput } from "./cursor-pager.js";
export { compareCodeUnits } from "./ordering.js";
export {
  AGENT_MODEL_DEFAULTS,
  ARBOR_CATEGORIES,
  CROWN_STRUCTURAL,
  HEARTWOOD_DEEP,
  SEED_QUICK,
  LEAF_VISUAL,
  SAP_WRITE,
  CAPABILITY_TIER,
  routeCategory,
  deriveCandidateNodeCard,
  resolveCategoryModel,
  resolveCategoryModelWithFallback,
} from "./agent-taxonomy.js";
export type {
  ArborAgentName,
  ArborCategoryName,
  ArborCategory,
  CategoryModelOverrides,
  AvailableModelCatalog,
  CategoryModelResolution,
} from "./agent-taxonomy.js";
export { INTENT_LIFECYCLE_SCHEMA_VERSION, validateIntentLifecycleRecord, appendIntentLifecycleRecord, parseIntentLedger, serializeIntentLedger } from "./intent-lifecycle.js";
export type { IntentLifecycleSchemaVersion, IntentClass, IntentConfidence, IntentDisposition, IntentRefusalCode, IntentRefusal, IntentDecision, IntentLifecyclePhase, IntentLifecycleKind, IntentLifecycleRecord, IntentLedger, IntentLifecycleViolationCode, IntentLifecycleViolation, IntentLifecycleValidation, IntentLedgerAppendResult } from "./intent-lifecycle.js";
export { validateIntentAdmission, createIntentAdmissionState, resetIntentTurn, transitionIntentAdmission } from "./intent-admission.js";
export type { IntentScopeKind, IntentScope, IntentDependency, IntentAdmissionVerb, IntentAdmissionRefusalCode, IntentAdmissionInput, IntentAdmissionPolicy, IntentAdmissionBlocker, IntentAdmissionResult, IntentAdmissionPhase, IntentAdmissionResetOrigin, IntentAdmissionState, IntentAdmissionEvent, IntentAdmissionTransitionFailure, IntentAdmissionTransitionResult } from "./intent-admission.js";
export { GOVERNED_RUN_ENV, withGovernedRun, isGovernedRun } from "./governed-run.js";
export { createSeededRng, deriveDecisionState, hashSeed, sampleBeta, sampleGamma } from "./search/rng.js";
export type { SeededRng } from "./search/rng.js";
export { selectSearchAction } from "./search/policy.js";
export type { SearchSelection } from "./search/policy.js";
export { applySearchObservation, createSearchStep, decideSearchStep, replaySearchStep, validateSearchConfig } from "./search/step.js";
export type { SearchReplayResult } from "./search/step.js";
export { SEARCH_DECISION_SCHEMA, SEARCH_POLICY_KINDS, SearchContractError } from "./search/types.js";
export type { BetaPrior, SearchAction, SearchArm, SearchArmEvaluation, SearchArmStats, SearchAttempt, SearchBudget, SearchConfig, SearchDecisionLevel, SearchDecisionRecord, SearchDuplicateLink, SearchLedgerEvent, SearchPolicyConfig, SearchPolicyKind, SearchRewardInput, SearchStepDecision, SearchStepPrior, SearchStepState, SearchStopReason } from "./search/types.js";
export { OPERATOR_VOCABULARY } from "./vocabulary.js";
export type { OperatorVocabularyCategory, OperatorVocabularyTerms } from "./vocabulary.js";
// Agent communication contracts (ADR-083 amendment; S1 of docs/research/agent-comms/PROPOSAL.md)
export { COMMS_ROLE_TIER, COMMS_AGENTS, LIVE_MODEL_ORCHESTRATOR_AGENT, isArborAgentName, isC2IssuerAgent, isC2TargetAgent } from "./comms/roles.js";
export type { CommsRoleTier, CommsPrincipal, CommsAgentPrincipal, CommsTreeView } from "./comms/roles.js";
export { C2_TEXT_BOUNDS, C2_COUNT_BOUNDS, C2_COMMAND_KINDS, C2_HALT_REASONS, C2_ANSWER_ACTIONS, C2_REPLY_KINDS, C2_TERMINAL_REPLY_KINDS, C2_BLOCKED_NEEDS, C2_PROGRESS_PHASES, C2_FAILURE_CLASSES, C2_REPLY_A2A_STATE, isTerminalC2Reply, validateC2Command, validateC2Reply, answerSatisfiesClarify } from "./comms/c2.js";
export type { C2CommandKind, C2HaltReason, C2AnswerAction, C2AnswerValue, C2Command, C2ReplyKind, C2ClarifyField, C2ClarifySchema, C2Reply } from "./comms/c2.js";
export { C2_REFUSAL_CODES, authorizeC2Issue, canIssueC2, authorizeC2Reply, applyC2Reply } from "./comms/authority.js";
export type { C2RefusalCode, C2AuthorityBasis, C2AuthorityDecision, C2ReplyDecision, C2CommandState } from "./comms/authority.js";
export { COMMS_CHANNELS, COMMS_ENVELOPE_SCHEMA_VERSION, COMMS_TEXT_MAX_BYTES, COMMS_MAX_ADDRESSEES, payloadCarriesFreeText, validateCommsEnvelope } from "./comms/envelope.js";
export type { CommsChannel, CommsPayload, CommsEnvelope } from "./comms/envelope.js";
export { COMMS_ROOM_TIERS, canOpenRoom, canBeRoomMember, roomMembershipViolations, canReadRoom, canPostToRoom, mentionsAreMembers } from "./comms/rooms.js";
export type { CommsRoomTier, CommsRoom } from "./comms/rooms.js";
export { deliveryModeFor, injectionLabel } from "./comms/delivery.js";
export type { CommsDeliveryMode } from "./comms/delivery.js";
