import { describe, expect, it } from "vitest";
import { shouldAutoRefresh } from "../claim-ledger-precommit.mjs";
import { CLAIM_LEDGER_BUDGET_COMMITS } from "../lib/store-budgets.mjs";

/**
 * Fix 2's threshold logic, isolated from git/process/filesystem: trailing at
 * or under half the budget is a no-op (an ordinary commit must stay fast);
 * strictly more than half triggers the auto-refresh.
 */
describe("claim-ledger-precommit — shouldAutoRefresh", () => {
  it("does not refresh at half the budget or under", () => {
    expect(shouldAutoRefresh(0, 10)).toBe(false);
    expect(shouldAutoRefresh(5, 10)).toBe(false);
  });

  it("refreshes once strictly past half the budget", () => {
    expect(shouldAutoRefresh(6, 10)).toBe(true);
    expect(shouldAutoRefresh(10, 10)).toBe(true);
    expect(shouldAutoRefresh(11, 10)).toBe(true);
  });

  it("uses the same budget store-freshness-gate.mjs enforces — imported, not duplicated", () => {
    expect(CLAIM_LEDGER_BUDGET_COMMITS).toBe(10);
    // The real budget's half-point: exactly the "12 behind, budget 10" and
    // "26 behind, budget 25"-style incidents this hook exists to preempt.
    expect(shouldAutoRefresh(5, CLAIM_LEDGER_BUDGET_COMMITS)).toBe(false);
    expect(shouldAutoRefresh(6, CLAIM_LEDGER_BUDGET_COMMITS)).toBe(true);
  });
});
