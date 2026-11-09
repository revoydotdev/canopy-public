/**
 * `arbor doctor reconcile`: the inventory divergence the doctor reports is
 * repaired by quarantine with a receipt, never by deletion, and the doctor
 * agrees with itself afterwards.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileStore } from "../src/doctor.js";
import { applyPersistenceReconciliation, formatReconcilePlan, planPersistenceReconciliation } from "../src/persistence-reconcile.js";
import { CampaignManager } from "../src/manager.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("persistence reconciliation", () => {
  it("plans nothing for a consistent store", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-")); roots.push(dir);
    const manager = new CampaignManager({ persistence_dir: dir });
    manager.startCampaign("c1", "plan.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
    const plan = planPersistenceReconciliation(dir);
    expect(plan.inventory_agrees).toBe(true);
    expect(plan.actions).toEqual([]);
    expect(formatReconcilePlan(plan, null)).toContain("inventory agrees");
  });

  it("quarantines an orphan snapshot and an orphan ledger, writes a receipt, and leaves the doctor consistent", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-")); roots.push(dir);
    const manager = new CampaignManager({ persistence_dir: dir });
    manager.startCampaign("kept", "plan.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
    mkdirSync(join(dir, "tree"), { recursive: true }); mkdirSync(join(dir, "audit"), { recursive: true });
    writeFileSync(join(dir, "tree", "orphan-snapshot.json"), JSON.stringify({ campaign_id: "orphan-snapshot" }), "utf8");
    writeFileSync(join(dir, "audit", "orphan-ledger.jsonl"), "", "utf8");
    expect(reconcileStore(dir).inventory_agrees).toBe(false);

    const plan = planPersistenceReconciliation(dir, () => new Date("2026-09-03T21:00:00.000Z"));
    // The hand-made snapshot is not a valid tree shape, which is its own
    // mismatch kind; both orphans are still quarantined by the same plan.
    expect(plan.actions.map((a) => [a.kind, a.relative_path]).sort()).toEqual([
      ["invalid_tree_shape", "tree/orphan-snapshot.json"],
      ["ledger_without_tree", "audit/orphan-ledger.jsonl"],
    ]);
    const preview = formatReconcilePlan(plan, null);
    expect(preview).toContain("would be quarantined");
    expect(preview).toContain("--apply");

    const receipt = applyPersistenceReconciliation(plan, () => new Date("2026-09-03T21:00:01.000Z"));
    expect(receipt.moved).toHaveLength(2);
    expect(existsSync(join(dir, "tree", "orphan-snapshot.json"))).toBe(false);
    expect(existsSync(join(plan.quarantine_dir, "tree", "orphan-snapshot.json"))).toBe(true);
    expect(existsSync(join(plan.quarantine_dir, "audit", "orphan-ledger.jsonl"))).toBe(true);
    const written = JSON.parse(readFileSync(receipt.receipt_path, "utf8"));
    expect(written.kind).toBe("revoy2.persistence_reconciliation");
    expect(written.moved).toHaveLength(2);
    // The kept campaign is untouched and the doctor now agrees.
    expect(existsSync(join(dir, "tree", "kept.json"))).toBe(true);
    expect(reconcileStore(dir).inventory_agrees).toBe(true);
    expect(formatReconcilePlan(plan, receipt)).toContain("Receipt:");
  });
});
