/**
 * arbor-eval — evaluation harness for the revoy2 tree-search engine.
 *
 * Exports the benchmark runner, baseline, metrics, tasks, and report generator.
 */

export { runBenchmark } from "./benchmark.js";
export { runBaseline } from "./baseline.js";
export { computeMetrics, aggregateMetrics, computeCriticReliability } from "./metrics.js";
export { generateReport, buildComparisonSummary } from "./report.js";
export { defaultTasks, createLearningOutcomeGenerator } from "./tasks.js";
export { evaluateGovernedScenarios } from "./governed-scenarios.js";
export { evaluateStagedNativeSafety, stagedNativeSafetyScenarios } from "./staged-native-safety.js";
export { runAgentUctExperiment, budgetAnnealedScore, clippedResidualValue } from "./agent-uct.js";
export { evaluateAnalytics, parseEvalAnalyticsFixture, EvalAnalyticsInputError } from "./analytics.js";
export { buildRunManifest, validateRunManifest, rightForRightReasons, falseAcceptanceByVerification, compareEvalEstimates, unresolvedComparisonRate, siblingOutcomeSignals, evaluateEconomizationGuard } from "./trajectory-metrics.js";
export { evaluateRepositoryRetrieval, evaluateRepositoryRetrievalAblation } from "./repository-retrieval-eval.js";
export type { RepositoryRetrievalTask, RepositoryRetrievalCohort, RepositoryRetrievalTaskResult, RepositoryRetrievalEvaluation, RepositoryRetrievalAblation } from "./repository-retrieval-eval.js";
export { evaluatePairedEconomy, generatePairedEconomyReport } from "./paired-economy-eval.js";
export type { PairedEconomyAttempt, PairedEconomyEvaluation, PairedEconomyPolicy, PairedEconomyPrice, PairedEconomyTokens, PairedArmSummary } from "./paired-economy-eval.js";
export { runVerificationCommand, verifiedProvenanceFromRun } from "./live-verification.js";
export type { VerificationCommand, VerificationRunResult } from "./live-verification.js";
export { resolveLiveModelConfigFromEnv, createLiveModelPort, callLiveModel, LiveModelCallError } from "./live-model-port.js";
export type { LiveModelConfig } from "./live-model-port.js";
export { defaultLiveTasks } from "./live-tasks.js";
export type { LiveEvalTask } from "./live-tasks.js";
export { estimateLiveRunCostUsd, assertWithinCostCeiling, LiveCostCeilingExceededError } from "./live-cost-guard.js";
export type { LiveRunCostEstimateInput } from "./live-cost-guard.js";
export { runLiveAblation, evaluateFalsifiability, wilsonInterval, computeLiveSeed } from "./live-ablation.js";
export type { LiveArm, LiveAttemptResult, LiveSeedRunResult, LiveTaskArmResult, FalsifiabilityFinding, LiveAblationReport, RunLiveAblationInput } from "./live-ablation.js";
export { generateLiveAblationReport } from "./live-report.js";
export { evaluateGovernanceFriction, parseGovernanceFrictionFixture, generateGovernanceFrictionReport, GovernanceFrictionInputError } from "./governance-friction.js";
export type { GovernanceFrictionFixture, GovernanceFrictionEpisode, GovernanceFrictionReport, GovernanceFrictionCohortReport } from "./governance-friction.js";
export { runLiveCli, parseLiveArgs, resolveFrontierFlashLiveConfig } from "./live-cli.js";
export { runFrontierInterfaceCli, runFrontierInterfaceNativeCli } from "./frontier-interface-cli.js";
export {
  ORIGINAL_INTERFACE_BASELINE_REVISION,
  ORIGINAL_INTERFACE_BASELINE_BUNDLE_TYPE,
  CURRENT_LEGACY_NATIVE_CANDIDATE_BUNDLE_TYPE,
  LEGACY_NATIVE_MATCHED_PAIR_BUNDLE_TYPE,
  captureOriginalInterfaceBaseline,
  captureCurrentLegacyNativeCandidate,
  recordLegacyNativeMatchedPair,
  verifyOriginalInterfaceBaseline,
  verifyCurrentLegacyNativeCandidate,
  verifyLegacyNativeMatchedPair,
} from "./foi-historical-native-baseline.js";
export type {
  OriginalInterfaceBaselineCaptureInput,
  OriginalInterfaceBaselineVerification,
  CurrentLegacyNativeCandidateCaptureInput,
  CurrentLegacyNativeCandidateVerification,
  LegacyNativeMatchedPairInput,
  LegacyNativeMatchedPairVerification,
} from "./foi-historical-native-baseline.js";
export type { LiveCliArgs } from "./live-cli.js";
export {
  FRONTIER_FLASH_TESTING_PROFILE,
  resolveFrontierFlashTestingProfile,
  createFrontierFlashCatalogAttestation,
} from "./frontier-flash-profile.js";
export type {
  FrontierFlashTestingProfile,
  FrontierFlashObservedMetadata,
  FrontierFlashCatalogAttestation,
  ResolveFrontierFlashProfileInput,
  FrontierFlashProfileSkipReason,
  FrontierFlashProfileInvalidReason,
  FrontierFlashProfileOutcome,
  CreateFrontierFlashCatalogAttestationInput,
  CreateFrontierFlashCatalogAttestationOutcome,
} from "./frontier-flash-profile.js";
export type { RunManifestInput, EvalRunManifest, TokenEconomyBreakdown, AgentTokenEconomyBreakdown, TrajectoryOutcome, VerificationOutcome, FalseAcceptanceRow, OracleClass, EvalEstimate, EvalComparison, SiblingOutcomeSignal, EconomizationTaskOutcome, EconomizationArm, EconomizationCohortEvidence, EconomizationGuardPolicy, EconomizationGuardResult } from "./trajectory-metrics.js";
export {
  ReuseLedgerConflictError,
  createPrefixReuseLedger,
  savePrefixReuseLedger,
  loadPrefixReuseLedgerResult,
  reconcileReuseLedgerTemporaryFiles,
  recordPrefixReuseObservation,
  persistPrefixReuseObservation,
  summarizePrefixReuseLedger,
} from "./reuse-ledger.js";
export type {
  EvalTask,
  CampaignMetrics,
  CriticReliabilitySample,
  CriticReliabilityMetrics,
  AggregatedMetrics,
  BaselineResult,
  AggregatedBaseline,
  EvalReport,
  ScriptedOutcome,
  OutcomeGenerator,
  GovernedScenarioAttempt,
  GovernedEvalScenario,
  GovernedScenarioMetrics,
  GovernedScenarioComparison,
  StagedNativeSafetyScenario,
  StagedNativeSafetyAuditEvidence,
  StagedNativeSafetyScore,
  StagedNativeSafetyEpisode,
  EvalBenchmarkTargetInput,
  EvalPrefixDescriptorInput,
  EvalPrefixObservationInput,
  EvalPrefixEntity,
  EvalBenchmarkTarget,
  EvalPrefixObservationRecord,
  EvalReuseLedgerOperationReceipt,
  EvalPrefixReuseLedger,
  EvalPrefixReuseCostTotal,
  EvalPrefixReuseEdgeSummary,
  EvalPrefixReuseSummary,
} from "./types.js";
export type {
  EvalReuseLedgerPersistenceArtifact,
  EvalReuseLedgerPersistenceDiagnosticCode,
  EvalReuseLedgerPersistenceDiagnostic,
  EvalReuseLedgerLoadResult,
  PersistedPrefixObservationResult,
} from "./reuse-ledger.js";
export type {
  AgentUctFixture,
  AgentUctFixtureDimension,
  AgentUctFixtureCluster,
  AgentUctExperimentPolicy,
  AgentUctBatch,
  AgentUctPolicyCandidate,
  AgentUctIterationTrace,
  AgentUctExperimentResult,
} from "./agent-uct.js";
export type { EvalAnalyticsFixture, EvalAnalyticsDiagnostic, EvalAnalyticsReport } from "./analytics.js";
