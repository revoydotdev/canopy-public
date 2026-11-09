import { compareCodeUnits } from "./ordering.js";
import { createHash } from "node:crypto";
import type { NodeState, Provenance } from "./types.js";

export interface RejectionSignal {
  readonly node_id: string;
  readonly branch_id: string;
  readonly action_fingerprint: string;
  readonly occurred_at: string;
  readonly evidence_ref: string;
}

export interface BranchSelectionSignal {
  readonly parent_id: string;
  readonly node_id: string;
  readonly occurred_at: string;
}

export interface EvidenceSignal {
  readonly evidence_ref: string;
  readonly node_id: string;
  readonly as_of: string;
  readonly terminal: boolean;
}

export interface WorkSignal {
  readonly operation_id: string;
  readonly node_id: string;
  readonly work_active: boolean;
  readonly node_state: NodeState | "missing";
  readonly evidence_ref: string;
}

export interface ConvergenceSignal {
  readonly reported_converged: boolean;
  readonly iterations_without_kb_entry: number;
  readonly configured_iterations: number;
  readonly new_kb_entries: number;
  readonly selectable_nodes: number;
  readonly evidence_ref: string;
}

/** A finite projection supplied by the runtime. Detection never reads or mutates the tree. */
export interface SurveillanceInput {
  readonly campaign_id: string;
  readonly as_of: string;
  readonly rejections: readonly RejectionSignal[];
  readonly branch_selections: readonly BranchSelectionSignal[];
  readonly evidence: readonly EvidenceSignal[];
  readonly work: readonly WorkSignal[];
  readonly convergence?: ConvergenceSignal;
}

export interface SurveillanceConfig {
  readonly max_signals_per_kind: number;
  readonly repeated_rejection_threshold: number;
  readonly rejection_window_ms: number;
  readonly oscillation_sample_size: number;
  readonly stale_evidence_ms: number;
}

export const DEFAULT_SURVEILLANCE_CONFIG: SurveillanceConfig = {
  max_signals_per_kind: 512,
  repeated_rejection_threshold: 3,
  rejection_window_ms: 30 * 60_000,
  oscillation_sample_size: 4,
  stale_evidence_ms: 60 * 60_000,
};

export type SurveillanceFindingKind =
  | "repeated_rejection"
  | "branch_oscillation"
  | "stale_evidence"
  | "orphaned_work"
  | "convergence_anomaly";

export interface SurveillanceFinding {
  readonly kind: SurveillanceFindingKind;
  readonly campaign_id: string;
  /** Stable across replay of the same condition; suitable for audited deduplication. */
  readonly dedup_key: string;
  readonly severity: "warning" | "critical";
  readonly summary: string;
  readonly subject_ids: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly observed_at: string;
  readonly provenance: Provenance;
}

/**
 * Detects suspicious runtime patterns from a bounded immutable projection.
 * Findings are advisory evidence: this function has no tree reference, performs
 * no I/O, and cannot pass/fail/bypass a process gate.
 */
export function detectSurveillanceFindings(
  input: SurveillanceInput,
  config: SurveillanceConfig = DEFAULT_SURVEILLANCE_CONFIG,
): readonly SurveillanceFinding[] {
  validate(input, config);
  const findings: SurveillanceFinding[] = [];
  detectRepeatedRejections(input, config, findings);
  detectOscillation(input, config, findings);
  detectStaleEvidence(input, config, findings);
  detectOrphanedWork(input, findings);
  detectConvergence(input, findings);
  return findings.sort((a, b) => compareCodeUnits(a.dedup_key, b.dedup_key));
}

function detectRepeatedRejections(input: SurveillanceInput, config: SurveillanceConfig, out: SurveillanceFinding[]): void {
  const asOf = Date.parse(input.as_of);
  const groups = new Map<string, RejectionSignal[]>();
  for (const signal of input.rejections) {
    if (asOf - Date.parse(signal.occurred_at) > config.rejection_window_ms) continue;
    const key = `${signal.branch_id}\u0000${signal.action_fingerprint}`;
    const group = groups.get(key) ?? [];
    group.push(signal);
    groups.set(key, group);
  }
  for (const [key, signals] of groups) {
    if (signals.length < config.repeated_rejection_threshold) continue;
    const [branchId, fingerprint] = key.split("\u0000") as [string, string];
    out.push(finding(input, "repeated_rejection", "warning", [branchId, fingerprint],
      `Action ${fingerprint} was rejected ${signals.length} times on branch ${branchId}`,
      signals.map((signal) => signal.evidence_ref)));
  }
}

function detectOscillation(input: SurveillanceInput, config: SurveillanceConfig, out: SurveillanceFinding[]): void {
  const parents = new Map<string, BranchSelectionSignal[]>();
  for (const signal of input.branch_selections) {
    const group = parents.get(signal.parent_id) ?? [];
    group.push(signal);
    parents.set(signal.parent_id, group);
  }
  for (const [parentId, signals] of parents) {
    const ordered = [...signals].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || compareCodeUnits(a.node_id, b.node_id));
    const sample = ordered.slice(-config.oscillation_sample_size);
    if (sample.length < config.oscillation_sample_size) continue;
    const [a, b] = sample;
    if (a.node_id === b.node_id || !sample.every((signal, index) => signal.node_id === (index % 2 === 0 ? a.node_id : b.node_id))) continue;
    out.push(finding(input, "branch_oscillation", "warning", [parentId, ...[a.node_id, b.node_id].sort()],
      `Selection alternated between ${a.node_id} and ${b.node_id} under ${parentId}`));
  }
}

function detectStaleEvidence(input: SurveillanceInput, config: SurveillanceConfig, out: SurveillanceFinding[]): void {
  const asOf = Date.parse(input.as_of);
  for (const signal of input.evidence) {
    if (signal.terminal || asOf - Date.parse(signal.as_of) <= config.stale_evidence_ms) continue;
    out.push(finding(input, "stale_evidence", "warning", [signal.node_id, signal.evidence_ref],
      `Non-terminal evidence ${signal.evidence_ref} is older than the configured freshness bound`, [signal.evidence_ref]));
  }
}

function detectOrphanedWork(input: SurveillanceInput, out: SurveillanceFinding[]): void {
  for (const signal of input.work) {
    if (!signal.work_active || signal.node_state === "expanding") continue;
    out.push(finding(input, "orphaned_work", "critical", [signal.node_id, signal.operation_id],
      `Active operation ${signal.operation_id} has no expanding node owner`, [signal.evidence_ref]));
  }
}

function detectConvergence(input: SurveillanceInput, out: SurveillanceFinding[]): void {
  const signal = input.convergence;
  if (signal === undefined) return;
  const shouldConverge = signal.iterations_without_kb_entry >= signal.configured_iterations
    && signal.new_kb_entries === 0;
  if (signal.reported_converged === shouldConverge) return;
  out.push(finding(input, "convergence_anomaly", "critical", [input.campaign_id],
    `Reported convergence (${signal.reported_converged}) disagrees with the bounded convergence projection`, [signal.evidence_ref]));
}

function finding(input: SurveillanceInput, kind: SurveillanceFindingKind, severity: SurveillanceFinding["severity"], subjectIds: string[], summary: string, evidenceRefs: string[] = []): SurveillanceFinding {
  const subjects = [...new Set(subjectIds)].sort();
  const refs = [...new Set(evidenceRefs)].sort();
  const dedupKey = ["surveillance.v1", input.campaign_id, kind, ...subjects].map(encodeURIComponent).join(":");
  const inputHash = createHash("sha256").update(JSON.stringify({ kind, campaign_id: input.campaign_id, subjects, refs })).digest("hex");
  return { kind, campaign_id: input.campaign_id, dedup_key: dedupKey, severity, summary, subject_ids: subjects, evidence_refs: refs, observed_at: input.as_of, provenance: { tag: "generated", generator: "arbor-core.surveillance.v1", input_hash: inputHash } };
}

function validate(input: SurveillanceInput, config: SurveillanceConfig): void {
  if (!input.campaign_id.trim() || !Number.isFinite(Date.parse(input.as_of))) throw new Error("campaign_id and valid as_of are required");
  for (const value of Object.values(config)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("surveillance config values must be positive safe integers");
  if (config.repeated_rejection_threshold > config.max_signals_per_kind || config.oscillation_sample_size > config.max_signals_per_kind) throw new Error("detection thresholds cannot exceed the signal bound");
  for (const signals of [input.rejections, input.branch_selections, input.evidence, input.work]) if (signals.length > config.max_signals_per_kind) throw new Error("surveillance input exceeds max_signals_per_kind");
  for (const signal of input.rejections) requireDate(signal.occurred_at);
  for (const signal of input.branch_selections) requireDate(signal.occurred_at);
  for (const signal of input.evidence) requireDate(signal.as_of);
  if (input.convergence !== undefined) {
    for (const value of [input.convergence.iterations_without_kb_entry, input.convergence.configured_iterations, input.convergence.new_kb_entries, input.convergence.selectable_nodes]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("convergence counters must be non-negative safe integers");
    if (input.convergence.configured_iterations < 1) throw new Error("configured_iterations must be positive");
  }
}

function requireDate(value: string): void { if (!Number.isFinite(Date.parse(value))) throw new Error(`invalid surveillance timestamp: ${value}`); }
