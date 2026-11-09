/**
 * scripts/lib/store-budgets.mjs — shared store-freshness budgets.
 *
 * `store-freshness-gate.mjs` is the authority on how many commits each
 * committed, generated store may trail HEAD before it FAILS. Anything else
 * that needs to reason about that number imports it from here rather than
 * hardcoding a second copy that can silently drift out of step with the
 * gate's own budget — currently `scripts/claim-ledger-precommit.mjs`, which
 * decides whether a commit is far enough behind to auto-refresh.
 */

/** Commits the claim-ledger store may trail HEAD before store-freshness-gate.mjs fails it. */
export const CLAIM_LEDGER_BUDGET_COMMITS = 10;

/** Git-common-dir marker written only while the conductor owns regeneration. */
export const STORE_REGENERATION_MARKER = "revoy2-store-regeneration.json";
