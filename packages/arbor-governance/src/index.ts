// @arbor/governance — the ADR governance control plane (ADR-027, Draft).
//
// NOTE ON REACHABILITY: exporting from this barrel does NOT by itself satisfy
// gate:reachability. That gate walks from the three declared entry points in
// scripts/reachability/entry-points.json. arbor-mcp's cli.ts (`arbor
// governance`) is now the first real, reachable consumer of
// `classifyLegacyRecord`/`DecisionStatus` — see ADR-027 Decision point 4.
// Exports below with no reachable consumer yet still carry dated allowlist
// entries citing that ADR until their own first real consumer lands.

export type {
  RecordId, RecordNamespace, RecordClass, ObligationId, GovernanceEventId,
  DecisionStatus, ImplementationStatus, VerificationStatus, ComplianceStatus,
  StatusVector, ResearchStatus,
  ArtifactKind, ArtifactIdentity, IdentityAmbiguity,
  GraphPlane, EdgeType, Confidence, DiscoveryMethod, EvidenceRef, GovernanceEdge,
  AuthorityVerdict, AuthorityDecision,
  Severity, PolicyFinding,
  GovernanceErrorCode, GovernanceError, GovernanceResult,
  QueryBudget, QueryPage,
} from "./contracts.js";

// Canonical record model, lifecycle, and legacy compatibility reader.
export { parseRecord } from "./record/parse.js";
export { classifyLegacyRecord } from "./record/legacy.js";
export { scanDecisionsCorpus } from "./record/corpus.js";
export { GovernanceRecordStore } from "./record/store.js";
export type {
  GovernanceRecordStoreOptions,
  GovernanceIndex,
  GovernanceIndexEntry,
  GovernanceRecordRevision,
  GovernanceRecordError,
  GovernanceBrowseResult,
  GovernanceInterviewRecord,
  InterviewState,
} from "./record/store.js";
export { classifyCorpusCitations, CITATION_MIGRATION_PRODUCER, CITATION_MIGRATION_AT_UNSET } from "./record/migrate.js";
export { validateTransition, deriveStatusVector, ZERO_OBLIGATIONS } from "./record/status.js";
export { canonicalRecordView, recordContentHash, sha256Hex } from "./record/canonical.js";

// Artifact identity. (Lineage reconciliation was retired 2026-08-06: no
// intra-package caller could use it without either a synthetic
// self-comparison call or new speculative snapshot-persistence machinery —
// see the reachability waiver retirement notes in this branch's history.
// duplicateSymbolIds/groupBySymbolKey/symbolId/parseSymbolId/scan() survive
// via artifact/duplicates.ts's POL-06 check, which record/corpus.ts calls.)
export {
  assertPosixRelativePath, contentHashOfFile, contentHashOfString,
  symbolId, parseSymbolId, createArtifactIdentity,
  groupBySymbolKey, duplicateSymbolIds,
  ARTIFACT_IDENTITY_SCHEMA_VERSION, InvalidArtifactPathError,
} from "./artifact/identity.js";
export { scan } from "./artifact/scan.js";
export type { ScanOptions } from "./artifact/scan.js";

// Derived repository counts and the SUR-05 drift check.
export { deriveRepositoryCounts } from "./counts/derive.js";
export type { DeriveRepositoryCountsOptions } from "./counts/derive.js";
// The one runtime-catalog reader, shared with scripts/{registration-integrity.mjs,lib/tui-catalog-parity/}.
export { readRuntimeCatalog, readCatalogFromSource, catalogKinds, isDispatchableDirection, CATALOG_SYMBOL } from "./counts/catalog.js";
export type { RuntimeCatalogEntry, CatalogRead, CatalogMeasured, CatalogUnmeasured, ReadRuntimeCatalogOptions } from "./counts/catalog.js";
export { checkCounts, findExemptedClaims, COUNTS_CHECK_PRODUCER, SUR_05_RULE_ID, HISTORICAL_CLAIM_MARKER } from "./counts/check.js";
export type { ExemptedClaim } from "./counts/check.js";
export { deriveCountDriftDocuments, COUNT_DRIFT_SCAN_ROOTS, HISTORICAL_LEDGER_PREFIXES } from "./counts/documents.js";

// Gap-register status consistency: SUR-06 (ROADMAP.md's Verified gap
// register vs. status assertions elsewhere in the corpus).
export { parseGapRegister, gapRegisterMap } from "./gap-status/register.js";
export type { GapStatus, GapRegisterRow, GapRegister } from "./gap-status/register.js";
export { findGapStatusMentions } from "./gap-status/mentions.js";
export type { GapMention } from "./gap-status/mentions.js";
export { checkGapStatusConsistency, GAP_STATUS_CHECK_PRODUCER, SUR_06_RULE_ID } from "./gap-status/check.js";
export { deriveGapStatusScanDocuments, GAP_REGISTER_DOCUMENT } from "./gap-status/documents.js";
export type { DeriveGapStatusScanDocumentsOptions } from "./gap-status/documents.js";

// Obligations and the proof-comment resolver.
export { deriveRecordId, parseObligationsFromText } from "./obligation/parse.js";
export {
  hashContent, resolveRepoRoot, readVitestIncludeGlobs, isCollectedByVitest,
  symbolAppearsInFile, findSymbolAcrossRepo, resolveProofComment, PRODUCER_ID,
  VITEST_CONFIG_CANDIDATES,
} from "./obligation/proof.js";
export { computeObligationCoverage, computeRecordCoverage } from "./obligation/coverage.js";
export { buildObligationCoverageReport } from "./obligation/report.js";

// NOTE: no generic hash-chain verifier lives here. src/verify/chain.ts was
// retired 2026-08-06: its `verifyChain`/`verifyScopedChains` re-implemented
// the exact continuity/hash-recompute mechanism `@arbor/audit`'s
// `EvidenceLedger.verifyIntegrity()` already provides (same
// `canonicalizeForHash`-based recipe, same previous_hash chain walk) — ADR-027
// Decision point 1/Alternative 3 name that shape a governance violation, not
// a refactor, regardless of the extra anchor/completeness feature it added.

// Work backlog derived from real governance findings (Track B3). The backlog
// says which records need obligations authored AND which legitimately have
// nothing to build — ADR-023 decided rollback is a non-goal, ADR-025's fix is
// an operator action. Manufacturing an obligation for those would be fabrication.
export { deriveBacklog, classifyRecordBuildability, selectNextBacklogItem } from "./backlog/derive.js";
export type { Backlog, BacklogItem, BacklogItemEvidence, BacklogClassification, DeriveBacklogOptions } from "./backlog/derive.js";
export { renderBrief } from "./backlog/brief.js";

export { checkStatusTransitions, POL_STATUS_TRANSITION } from "./record/transitions.js";
export type { StatusBaseline } from "./record/transitions.js";

// Visual-intelligence extractors (ADR-031's absorption). These replace the
// untyped `.mjs` scripts that carried their own ADR parsing and counts probes;
// see `vi/intent.ts`'s header for the divergences the canonical reader exposes.
export { buildIntentGraph } from "./vi/intent.js";
export type {
  IntentRecord, IntentCitation, DanglingCitation, IntentFinding,
  IntentGraphReport, RecordLifecycle, IntentMismatch, IntentSeverity,
  BuildIntentGraphOptions,
} from "./vi/intent.js";
export { extractExceptions, ALLOWLIST_PATH, EXCEPTION_EXTRACT_CAPABILITY, EXCEPTION_EXTRACT_PRODUCER, RULE_UNRESOLVED_AUTHORITY, RULE_EXPIRY } from "./vi/exceptions.js";
export type { AllowlistEntry, ExceptionRecord, ExceptionExtraction, ExceptionExtractionSummary, ExtractExceptionsOptions } from "./vi/exceptions.js";
export { deriveRepositoryBaseline } from "./vi/baseline.js";
export type { RepositoryBaseline, DeriveBaselineOptions, Probe } from "./vi/baseline.js";

// External governance warrants consumed (but never issued) by Flight.
export { GOVERNANCE_ADMISSION_WORK_CLASSES, issueGovernanceAdmissionAttestation, verifyGovernanceAdmissionAttestation, governanceAdmissionAttestationDigest } from "./admission-attestation.js";
export type { GovernanceAdmissionWorkClass, GovernanceAdmissionFacts, GovernanceAdmissionPayload, GovernanceAdmissionAttestation, GovernanceAdmissionExpectedBindings, GovernanceAdmissionTrustState, GovernanceAdmissionVerification } from "./admission-attestation.js";
