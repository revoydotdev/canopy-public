import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SurveillanceInput } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { CampaignSurveillanceSource, SurveillanceMonitor, type SurveillanceProjectionSource } from "../src/surveillance-monitor.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

const NOW = "2026-08-01T12:00:00.000Z";
const OLD = "2026-08-01T10:00:00.000Z";
const base = (): SurveillanceInput => ({ campaign_id: "campaign", as_of: NOW, rejections: [], branch_selections: [], evidence: [], work: [] });
const source = (input: SurveillanceInput): SurveillanceProjectionSource => ({ project: () => structuredClone(input) });

describe("SurveillanceMonitor", () => {
  it.each([
    ["repeated_rejection", { rejections: [0, 1, 2].map((i) => ({ node_id: `n${i}`, branch_id: "root", action_fingerprint: "same", occurred_at: NOW, evidence_ref: `audit:${i}` })) }],
    ["branch_oscillation", { branch_selections: ["a", "b", "a", "b"].map((node_id, index) => ({ parent_id: "root", node_id, occurred_at: `2026-08-01T12:00:0${index}.000Z` })) }],
    ["stale_evidence", { evidence: [{ evidence_ref: "audit:old", node_id: "n", as_of: OLD, terminal: false }] }],
    ["orphaned_work", { work: [{ operation_id: "op", node_id: "n", work_active: true, node_state: "pending", evidence_ref: "task:t" }] }],
    ["convergence_anomaly", { convergence: { reported_converged: true, iterations_without_kb_entry: 0, configured_iterations: 2, new_kb_entries: 0, selectable_nodes: 1, evidence_ref: "campaign:c" } }],
  ] as const)("projects %s without inventing a gate", (kind, patch) => {
    const input = Object.freeze({ ...base(), ...patch }) as SurveillanceInput;
    const before = structuredClone(input);
    const result = new SurveillanceMonitor({ source: source(input) }).scan("campaign", NOW);
    expect(result.findings.map((finding) => finding.kind)).toContain(kind);
    expect(result.findings.every((finding) => !("gate" in finding) && !("gate_type" in finding))).toBe(true);
    expect(input).toEqual(before);
  });

  it("checkpoints before emission and deduplicates repeated scans across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-surveillance-"));
    directories.push(directory);
    const input = { ...base(), work: [{ operation_id: "op", node_id: "n", work_active: true, node_state: "missing" as const, evidence_ref: "task:t" }] };
    const emitted: string[] = [];
    const first = new SurveillanceMonitor({ source: source(input), persistence_dir: directory, on_finding: (finding) => emitted.push(finding.dedup_key) });
    expect(first.scan("campaign", NOW).newly_recorded).toHaveLength(1);
    expect(first.scan("campaign", NOW).newly_recorded).toHaveLength(0);
    const restarted = new SurveillanceMonitor({ source: source(input), persistence_dir: directory, on_finding: (finding) => emitted.push(finding.dedup_key) });
    expect(restarted.scan("campaign", NOW).newly_recorded).toHaveLength(0);
    expect(restarted.query("campaign", 1)).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it("derives bounded canonical facts from manager and supervisor views without mutation", () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "PLAN.md", { description: "root", category: "plan", delegate_to: "seed", estimated_gain: 1, estimated_cost: 1 });
    const before = manager.getCampaignSnapshot("campaign");
    const tasks = { list: () => [{ id: "ghost", operation_id: "op", kind: "node_expansion:ghost", owner_scope_id: "campaign", parent_id: null, state: "started" as const, started_at: NOW, deadline_at: null, progress: null, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null }] };
    const monitor = new SurveillanceMonitor({ source: new CampaignSurveillanceSource(manager, tasks) });
    expect(monitor.scan("campaign", NOW).findings.map((finding) => finding.kind)).toContain("orphaned_work");
    expect(manager.getCampaignSnapshot("campaign")).toEqual(before);
  });

  it("recognizes the canonical converged halt reason", () => {
    const manager = {
      getCampaignSnapshot: () => ({ id: "campaign", config: { convergence_iterations: 2 }, root_id: "root", halted: true,
        halt_reason: "converged", iterations_without_kb_entry: 2, nodes: [] }),
      getAuditRecords: () => [],
    } as unknown as CampaignManager;
    const projection = new CampaignSurveillanceSource(manager, { list: () => [] }).project("campaign", NOW, 10);
    expect(projection.convergence?.reported_converged).toBe(true);
    expect(new SurveillanceMonitor({ source: source(projection) }).scan("campaign", NOW).findings).toHaveLength(0);
  });

  it("bounds retained findings and queries", () => {
    let current = base();
    const monitor = new SurveillanceMonitor({ source: { project: () => current }, max_retained_findings: 2 });
    for (const node of ["a", "b", "c"]) {
      current = { ...base(), work: [{ operation_id: `op-${node}`, node_id: node, work_active: true, node_state: "missing", evidence_ref: `task:${node}` }] };
      monitor.scan("campaign", NOW);
    }
    expect(monitor.query("campaign", 2)).toHaveLength(2);
    expect(() => monitor.query("campaign", 3)).toThrow(/within retention/);
  });
});
