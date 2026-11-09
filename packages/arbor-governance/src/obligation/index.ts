/**
 * obligation/index.ts — internal barrel for this subpackage. NOT wired into
 * `@arbor/governance`'s own top-level `src/index.ts`, which is orchestrator-
 * owned (see this package's ownership split). Re-exporting this from the
 * package barrel is a one-line HANDOFF REQUEST — see this workstream's final
 * report for exactly what to add and why reachability currently fails
 * without it.
 */
export type { Obligation, ObligationProofComment, RecordObligations } from "./parse.js";
export { deriveRecordId, parseObligationsFromText } from "./parse.js";

export type { FieldResolution, FieldResolutionState, ProofResolution, ResolveProofOptions } from "./proof.js";
export {
  findSymbolAcrossRepo,
  hashContent,
  isCollectedByVitest,
  PRODUCER_ID,
  readVitestIncludeGlobs,
  resolveProofComment,
  resolveRepoRoot,
  symbolAppearsInFile,
} from "./proof.js";

export type { ObligationAttestation, ObligationCoverage, RecordCoverage } from "./coverage.js";
export { computeObligationCoverage, computeRecordCoverage } from "./coverage.js";

export type { BuildReportOptions, ObligationCoverageReport } from "./report.js";
export { buildObligationCoverageReport } from "./report.js";
