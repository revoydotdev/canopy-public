/**
 * Persistence reconciliation: the repair `arbor doctor` promised and never
 * named.
 *
 * `reconcileStore` (doctor.ts) detects a paired-inventory divergence between
 * campaign snapshots under `tree/` and audit ledgers under `audit/`, plus
 * ledgers that fail to parse or fail their hash chain. The doctor's next
 * action told the operator to "repair only with the named recovery command"
 * and no such command existed (self-hosting blockers A4); `arbor recover`
 * continues a campaign, it does not repair the inventory.
 *
 * Repair here is preview-then-apply and never destructive: every orphaned or
 * untrusted file is MOVED into `<persistence>/quarantine/reconcile-<stamp>/`
 * keeping its relative path, and a receipt records what moved and why. A
 * snapshot without a ledger cannot be trusted as history; a ledger without a
 * snapshot cannot be resumed. Neither is deleted.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { reconcileStore, type StoreMismatch } from "./doctor.js";

export interface ReconcileAction {
  readonly kind: StoreMismatch["kind"];
  readonly campaign_id: string | null;
  readonly path: string;
  readonly relative_path: string;
  readonly detail: string;
  readonly action: "quarantine";
}

export interface ReconcilePlan {
  readonly persistence_dir: string;
  readonly quarantine_dir: string;
  readonly inventory_agrees: boolean;
  readonly actions: readonly ReconcileAction[];
}

export interface ReconcileReceipt extends ReconcilePlan {
  readonly kind: "revoy2.persistence_reconciliation";
  readonly applied_at: string;
  readonly moved: readonly { readonly from: string; readonly to: string }[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly receipt_path: string;
}

export function planPersistenceReconciliation(persistenceDir: string, now: () => Date = () => new Date()): ReconcilePlan {
  const report = reconcileStore(persistenceDir);
  const stamp = now().toISOString().replace(/[:.]/gu, "-");
  const quarantineDir = join(persistenceDir, "quarantine", `reconcile-${stamp}`);
  const seen = new Set<string>();
  const actions: ReconcileAction[] = [];
  for (const mismatch of report.mismatches) {
    if (seen.has(mismatch.path)) continue;
    seen.add(mismatch.path);
    actions.push({
      kind: mismatch.kind, campaign_id: mismatch.campaign_id ?? null, path: mismatch.path,
      relative_path: relative(persistenceDir, mismatch.path), detail: mismatch.detail, action: "quarantine",
    });
  }
  return Object.freeze({ persistence_dir: persistenceDir, quarantine_dir: quarantineDir, inventory_agrees: report.inventory_agrees, actions: Object.freeze(actions) });
}

export function applyPersistenceReconciliation(plan: ReconcilePlan, now: () => Date = () => new Date()): ReconcileReceipt {
  const moved: { from: string; to: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  if (plan.actions.length > 0) mkdirSync(plan.quarantine_dir, { recursive: true });
  for (const action of plan.actions) {
    if (!existsSync(action.path)) { skipped.push({ path: action.path, reason: "no longer present" }); continue; }
    const target = join(plan.quarantine_dir, action.relative_path);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(action.path, target);
    moved.push({ from: action.path, to: target });
  }
  const receiptPath = join(plan.quarantine_dir, "receipt.json");
  const receipt: ReconcileReceipt = { ...plan, kind: "revoy2.persistence_reconciliation", applied_at: now().toISOString(), moved, skipped, receipt_path: receiptPath };
  if (plan.actions.length > 0) writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

export function formatReconcilePlan(plan: ReconcilePlan, applied: ReconcileReceipt | null): string {
  const lines: string[] = [];
  if (plan.actions.length === 0) return "persistence reconcile — inventory agrees; nothing to quarantine";
  lines.push(`persistence reconcile — ${plan.actions.length} file(s) ${applied === null ? "would be" : "were"} quarantined under ${plan.quarantine_dir}`);
  for (const action of plan.actions) lines.push(`  ${action.kind.padEnd(24)} ${action.relative_path}  — ${action.detail}${action.campaign_id ? ` (${action.campaign_id})` : ""}`);
  if (applied === null) lines.push("Preview only. Re-run with --apply to move them; nothing is deleted, and the receipt names every move.");
  else {
    lines.push(`Receipt: ${applied.receipt_path}`);
    for (const skip of applied.skipped) lines.push(`  skipped ${skip.path}: ${skip.reason}`);
  }
  return lines.join("\n");
}
