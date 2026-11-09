import { compareCodeUnits, TERMINAL_NODE_STATES } from "@arbor/core";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SURVEILLANCE_CONFIG,
  detectSurveillanceFindings,
  type SurveillanceConfig,
  type SurveillanceFinding,
  type SurveillanceInput,
  type SupervisorTask,
} from "@arbor/core";
import type { AuditRecord, TracePacket } from "@arbor/audit";
import type { CampaignManager } from "./manager.js";

const SNAPSHOT_VERSION = 1;

export interface SurveillanceProjectionSource {
  project(campaignId: string, asOf: string, limit: number): SurveillanceInput;
}

export interface SurveillanceMonitorOptions {
  source: SurveillanceProjectionSource;
  persistence_dir?: string;
  config?: Partial<SurveillanceConfig>;
  max_retained_findings?: number;
  on_finding?: (finding: SurveillanceFinding) => void;
}

export interface SurveillanceScanResult {
  campaign_id: string;
  scanned_at: string;
  findings: readonly SurveillanceFinding[];
  newly_recorded: readonly SurveillanceFinding[];
}

interface FindingSnapshot {
  version: 1;
  findings: SurveillanceFinding[];
  content_hash: string;
}

/**
 * Bounded, advisory surveillance projection. It receives immutable facts and
 * cannot mutate a campaign, task, audit record, or gate. A finding becomes
 * emitted only after its dedup snapshot is durably replaced. The snapshot is
 * replay/dedup state, not audit evidence; `on_finding` is the integration port
 * that may publish the generated finding into a canonical evidence stream.
 */
export class SurveillanceMonitor {
  private readonly source: SurveillanceProjectionSource;
  private readonly config: SurveillanceConfig;
  private readonly maxRetained: number;
  private readonly persistenceDir: string | null;
  private readonly onFinding: ((finding: SurveillanceFinding) => void) | null;
  private findings = new Map<string, SurveillanceFinding>();

  constructor(options: SurveillanceMonitorOptions) {
    this.source = options.source;
    this.config = { ...DEFAULT_SURVEILLANCE_CONFIG, ...options.config };
    this.maxRetained = options.max_retained_findings ?? 1_024;
    if (!Number.isSafeInteger(this.maxRetained) || this.maxRetained < 1) throw new Error("max_retained_findings must be a positive safe integer");
    this.persistenceDir = options.persistence_dir ?? null;
    this.onFinding = options.on_finding ?? null;
    this.restore();
  }

  scan(campaignId: string, asOf = new Date().toISOString()): SurveillanceScanResult {
    if (!campaignId.trim() || !Number.isFinite(Date.parse(asOf))) throw new Error("campaignId and valid asOf are required");
    const detected = detectSurveillanceFindings(this.source.project(campaignId, asOf, this.config.max_signals_per_kind), this.config);
    const freshByKey = new Map<string, SurveillanceFinding>();
    for (const finding of detected) if (!this.findings.has(finding.dedup_key)) freshByKey.set(finding.dedup_key, finding);
    const fresh = [...freshByKey.values()];
    if (fresh.length > 0) {
      for (const finding of fresh) this.findings.set(finding.dedup_key, structuredClone(finding));
      this.trim();
      this.checkpoint();
      for (const finding of fresh) this.emit(finding);
    }
    return { campaign_id: campaignId, scanned_at: asOf, findings: structuredClone(detected), newly_recorded: structuredClone(fresh) };
  }

  query(campaignId: string, limit = 100): readonly SurveillanceFinding[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxRetained) throw new Error("limit must be a positive safe integer within retention");
    return [...this.findings.values()].filter((finding) => finding.campaign_id === campaignId)
      .sort((a, b) => compareCodeUnits(b.observed_at, a.observed_at) || compareCodeUnits(a.dedup_key, b.dedup_key))
      .slice(0, limit).map((finding) => structuredClone(finding));
  }

  private trim(): void {
    const ordered = [...this.findings.values()].sort((a, b) => compareCodeUnits(a.observed_at, b.observed_at) || compareCodeUnits(a.dedup_key, b.dedup_key));
    while (ordered.length > this.maxRetained) this.findings.delete(ordered.shift()!.dedup_key);
  }

  private checkpoint(): void {
    if (!this.persistenceDir) return;
    mkdirSync(this.persistenceDir, { recursive: true });
    const findings = [...this.findings.values()].sort((a, b) => compareCodeUnits(a.dedup_key, b.dedup_key));
    const snapshot: FindingSnapshot = { version: SNAPSHOT_VERSION, findings, content_hash: hash(findings) };
    const path = join(this.persistenceDir, "surveillance-findings.json");
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
    const temporaryFd = openSync(temporary, "r");
    try { fsyncSync(temporaryFd); } finally { closeSync(temporaryFd); }
    renameSync(temporary, path);
    const directoryFd = openSync(this.persistenceDir, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }

  private restore(): void {
    if (!this.persistenceDir) return;
    const path = join(this.persistenceDir, "surveillance-findings.json");
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FindingSnapshot>;
    if (parsed.version !== SNAPSHOT_VERSION || !Array.isArray(parsed.findings) || parsed.content_hash !== hash(parsed.findings)) {
      throw new Error("surveillance finding snapshot failed integrity validation");
    }
    for (const finding of parsed.findings) this.findings.set(finding.dedup_key, structuredClone(finding));
    this.trim();
  }

  private emit(finding: SurveillanceFinding): void {
    try { this.onFinding?.(structuredClone(finding)); } catch { /* advisory observers cannot invalidate durable evidence */ }
  }
}

/** Read-only adapter over canonical manager, supervisor, and audit facts. */
export class CampaignSurveillanceSource implements SurveillanceProjectionSource {
  constructor(private readonly manager: CampaignManager, private readonly tasks: { list(options?: { scope_id?: string; include_terminal?: boolean }): SupervisorTask[] }) {}

  project(campaignId: string, asOf: string, limit: number): SurveillanceInput {
    const snapshot = this.manager.getCampaignSnapshot(campaignId);
    if (!snapshot) throw new Error(`campaign ${campaignId} was not found`);
    const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const records = [...this.manager.getAuditRecords(campaignId)].slice(-limit);
    const traces = records.filter(isTrace);
    const rejections = traces.filter((trace) => trace.critic_verdict_approved === false).map((trace) => ({
      node_id: trace.node_id,
      branch_id: nodes.get(trace.node_id)?.parent_id ?? snapshot.root_id,
      action_fingerprint: createHash("sha256").update(`${trace.action_category}\0${trace.action_description}`).digest("hex").slice(0, 16),
      occurred_at: trace.timestamp,
      evidence_ref: `audit:${trace.id}`,
    }));
    const branch_selections = traces.filter((trace) => nodes.get(trace.node_id)?.parent_id !== null).map((trace) => ({
      parent_id: nodes.get(trace.node_id)?.parent_id ?? snapshot.root_id, node_id: trace.node_id, occurred_at: trace.timestamp,
    }));
    const evidence = records.filter((record) => record.kind !== "node_communication").map((record) => ({
      evidence_ref: `audit:${record.id}`, node_id: record.node_id, as_of: record.timestamp,
      terminal: isTerminal(nodes.get(record.node_id)?.state),
    }));
    const work = this.tasks.list({ scope_id: campaignId, include_terminal: false }).slice(-limit).map((task) => {
      const nodeId = nodeIdForTask(task);
      return { operation_id: task.operation_id, node_id: nodeId, work_active: true,
        node_state: nodes.get(nodeId)?.state ?? "missing" as const, evidence_ref: `task:${task.id}` };
    });
    const selectable = snapshot.nodes.filter((node) => node.state === "pending").length;
    return {
      campaign_id: campaignId, as_of: asOf, rejections, branch_selections, evidence, work,
      convergence: { reported_converged: snapshot.halted && snapshot.halt_reason === "converged",
        iterations_without_kb_entry: snapshot.iterations_without_kb_entry,
        configured_iterations: snapshot.config.convergence_iterations,
        new_kb_entries: 0, selectable_nodes: selectable, evidence_ref: `campaign:${campaignId}` },
    };
  }
}

function isTrace(record: AuditRecord): record is TracePacket { return record.kind === undefined || record.kind === "trace"; }
// One canonical definition (@arbor/core's TERMINAL_NODE_STATES). The `string`
// parameter is deliberate: this reads a state off a record whose shape predates
// the union, so an unknown value must be non-terminal rather than throw.
function isTerminal(state: string | undefined): boolean { return state !== undefined && (TERMINAL_NODE_STATES as ReadonlySet<string>).has(state); }
function nodeIdForTask(task: SupervisorTask): string { return task.kind.startsWith("node_expansion:") ? task.kind.slice("node_expansion:".length) : task.id; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
