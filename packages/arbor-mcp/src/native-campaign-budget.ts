/** Durable, single-writer campaign budget reservations for native sessions. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Cost, Provenance } from "@arbor/core";
import type { NativeUsageAndCost } from "@arbor/harness";

export interface NativeCampaignBudgetConfig {
  readonly max_tokens?: number;
  readonly max_cost?: Extract<Cost, { kind: "priced" }>;
  readonly provenance: Provenance;
}
export interface NativeCampaignBudgetSnapshot {
  readonly campaign_id: string; readonly revision: number; readonly configured: NativeCampaignBudgetConfig;
  readonly consumed_tokens: number; readonly reserved_tokens: number; readonly remaining_tokens: number | null;
  readonly consumed_cost: Cost; readonly reserved_cost: Cost; readonly remaining_cost: Cost;
  readonly reservations: readonly NativeCampaignBudgetReservation[];
}
export const NATIVE_BUDGET_REMEDIATION_RESERVE_FRACTION = 0.10;

export interface NativeCampaignBudgetReservation {
  readonly reservation_id: string; readonly session_id: string; readonly estimated: NativeUsageAndCost;
  /** The amount actually charged. It is never an invented zero: unavailable
   * telemetry is charged at the persisted conservative reservation instead. */
  readonly settled: NativeUsageAndCost | null;
  readonly settlement: NativeCampaignBudgetSettlement | null;
  readonly state: "reserved" | "settled"; readonly provenance: Provenance;
}
export interface NativeCampaignBudgetSettlement {
  /** Which durable accounting evidence supplied the charged dimensions. */
  readonly source: "observed" | "mixed" | "conservative_estimate";
  /** A redacted accounting explanation, never provider response text. */
  readonly reason?: string;
}
type Store = NativeCampaignBudgetSnapshot;

/**
 * Files are durable and revisioned. The enclosing ArborRuntime already owns
 * ADR-029's one-writer lock; callers must provide the revision they observed,
 * so an accidental second in-process writer fails rather than overspending.
 */
export class NativeCampaignBudgetAuthority {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true }); }
  snapshot(campaignId: string): NativeCampaignBudgetSnapshot | null { return this.read(campaignId); }
  initialize(campaignId: string, config: NativeCampaignBudgetConfig): NativeCampaignBudgetSnapshot {
    const current = this.read(campaignId); if (current) return current;
    validateConfig(config);
    const empty: Store = freeze({ campaign_id: campaignId, revision: 0, configured: config, consumed_tokens: 0, reserved_tokens: 0, remaining_tokens: config.max_tokens === undefined ? null : config.max_tokens, consumed_cost: unpriced("no measured native cost yet"), reserved_cost: unpriced("no active priced reservations"), remaining_cost: config.max_cost === undefined ? unpriced("no configured campaign cost ceiling") : { ...config.max_cost, minor_units: config.max_cost.minor_units }, reservations: [] });
    this.write(campaignId, empty); return empty;
  }
  reserve(input: { campaign_id: string; expected_revision: number; reservation_id: string; session_id: string; estimate: NativeUsageAndCost; provenance: Provenance }): { status: "reserved" | "idempotent" | "conflict" | "denied"; snapshot: NativeCampaignBudgetSnapshot; reason?: string } {
    const state = this.required(input.campaign_id);
    const prior = state.reservations.find((item) => item.reservation_id === input.reservation_id);
    if (prior) return prior.session_id === input.session_id ? { status: "idempotent", snapshot: state } : { status: "conflict", snapshot: state, reason: "reservation identity belongs to a different session" };
    if (state.revision !== input.expected_revision) return { status: "conflict", snapshot: state, reason: "campaign budget revision changed" };
    const estimate = tokens(input.estimate);
    if (estimate === null && state.configured.max_tokens !== undefined) return { status: "denied", snapshot: state, reason: "campaign token budget requires an explicit estimate" };
    const cost = input.estimate.cost;
    if (state.configured.max_cost !== undefined && !sameDenomination(cost, state.configured.max_cost)) return { status: "denied", snapshot: state, reason: "campaign cost budget requires an attributable configured price estimate" };
    if (state.configured.max_tokens !== undefined) {
      const reserve = Math.max(1, Math.ceil(state.configured.max_tokens * NATIVE_BUDGET_REMEDIATION_RESERVE_FRACTION));
      const operatorCeiling = Math.max(1, state.configured.max_tokens - reserve);
      if (state.consumed_tokens + state.reserved_tokens + (estimate ?? 0) > operatorCeiling) return { status: "denied", snapshot: state, reason: `campaign token operator ceiling would be exceeded; ${reserve} tokens are reserved for remediation` };
    }
    if (state.configured.max_cost !== undefined && priced(state.consumed_cost) + priced(state.reserved_cost) + priced(cost) > state.configured.max_cost.minor_units) return { status: "denied", snapshot: state, reason: "campaign cost budget would be exceeded" };
    const reservation: NativeCampaignBudgetReservation = freeze({ reservation_id: input.reservation_id, session_id: input.session_id, estimated: input.estimate, settled: null, settlement: null, state: "reserved", provenance: input.provenance });
    const next = recalc({ ...state, revision: state.revision + 1, reservations: [...state.reservations, reservation] }); this.write(input.campaign_id, next); return { status: "reserved", snapshot: next };
  }
  /**
   * Finalize a reservation exactly once. Provider telemetry is evidence, not
   * an entitlement to release budget: each missing/unattributable bounded
   * dimension retains its admission estimate. This also makes a crash-safe
   * recovery settlement honest when the original worker can no longer report.
   */
  settle(input: { campaign_id: string; expected_revision: number; reservation_id: string; observed: NativeUsageAndCost | null }): { status: "settled" | "idempotent" | "conflict"; snapshot: NativeCampaignBudgetSnapshot } {
    const state = this.required(input.campaign_id); const prior = state.reservations.find((item) => item.reservation_id === input.reservation_id);
    if (!prior) return { status: "conflict", snapshot: state };
    if (prior.state === "settled") return { status: "idempotent", snapshot: state };
    if (state.revision !== input.expected_revision) return { status: "conflict", snapshot: state };
    const settlement = conservativeSettlement(state.configured, prior.estimated, input.observed);
    const next = recalc({ ...state, revision: state.revision + 1, reservations: state.reservations.map((item) => item.reservation_id === input.reservation_id ? freeze({ ...item, state: "settled", settled: settlement.observed, settlement: settlement.evidence }) : item) }); this.write(input.campaign_id, next); return { status: "settled", snapshot: next };
  }
  /**
   * A freshly opened runtime has no surviving native workers. Settle every
   * durable in-flight reservation at its already-admitted ceiling rather than
   * pretending that a lost completion spent nothing. The method is safe to
   * repeat and retries CAS conflicts caused by the single authorized writer.
   */
  reconcileOrphanedReservations(): readonly NativeCampaignBudgetSnapshot[] {
    const reconciled: NativeCampaignBudgetSnapshot[] = [];
    for (const filename of readdirSync(this.directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const parsed = normalizeStore(JSON.parse(readFileSync(join(this.directory, filename), "utf8")) as Store);
      const campaignId = parsed.campaign_id;
      // The filename is the campaign identity commitment. Do not let an
      // unrelated JSON file redirect reconciliation to another record.
      if (filename !== `${createHash("sha256").update(campaignId).digest("hex")}.json`) throw new Error("invalid native campaign budget record identity");
      let attempts = 0;
      // Three CAS retries per entry bound a competing stale writer without
      // leaving a long recovered reservation list half accounted.
      while (attempts < Math.max(3, (parsed.reservations?.length ?? 0) * 3)) {
        const snapshot = this.snapshot(campaignId); if (snapshot === null) break;
        const pending = snapshot.reservations.filter((reservation) => reservation.state === "reserved");
        if (pending.length === 0) break;
        const target = pending[0]!;
        const result = this.settle({ campaign_id: campaignId, expected_revision: snapshot.revision, reservation_id: target.reservation_id, observed: null });
        attempts += 1;
        if (result.status === "conflict") continue;
        reconciled.push(result.snapshot);
      }
    }
    return Object.freeze(reconciled);
  }
  private required(id: string): Store { const value = this.read(id); if (!value) throw new Error(`native campaign budget not initialized: ${id}`); return value; }
  private path(id: string): string { return join(this.directory, `${createHash("sha256").update(id).digest("hex")}.json`); }
  private read(id: string): Store | null { const path = this.path(id); if (!existsSync(path)) return null; const parsed = normalizeStore(JSON.parse(readFileSync(path, "utf8")) as Store); if (parsed.campaign_id !== id) throw new Error("invalid native campaign budget record"); return freeze(parsed); }
  private write(id: string, state: Store): void { const path = this.path(id); mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.${Date.now()}.tmp`; writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 }); renameSync(tmp, path); }
}
function recalc(state: Omit<Store, "consumed_tokens" | "reserved_tokens" | "remaining_tokens" | "consumed_cost" | "reserved_cost" | "remaining_cost">): Store {
  const settled = state.reservations.filter((r) => r.settled !== null).map((r) => r.settled!); const pending = state.reservations.filter((r) => r.state === "reserved").map((r) => r.estimated);
  const consumedTokens = settled.reduce((n, v) => n + (tokens(v) ?? 0), 0); const reservedTokens = pending.reduce((n, v) => n + (tokens(v) ?? 0), 0);
  const consumedCost = sumCost(settled.map((v) => v.cost), "no measured native cost yet"); const reservedCost = sumCost(pending.map((v) => v.cost), "no active priced reservations");
  const remainingCost = state.configured.max_cost === undefined ? unpriced("no configured campaign cost ceiling") : sameDenomination(consumedCost, state.configured.max_cost) && (pending.length === 0 || sameDenomination(reservedCost, state.configured.max_cost)) ? { ...state.configured.max_cost, minor_units: state.configured.max_cost.minor_units - priced(consumedCost) - priced(reservedCost) } : unpriced("campaign cost remaining is unavailable because observed cost is unpriced or has a different schedule");
  return freeze({ ...state, consumed_tokens: consumedTokens, reserved_tokens: reservedTokens, remaining_tokens: state.configured.max_tokens === undefined ? null : state.configured.max_tokens - consumedTokens - reservedTokens, consumed_cost: consumedCost, reserved_cost: reservedCost, remaining_cost: remainingCost });
}
function conservativeSettlement(config: NativeCampaignBudgetConfig, estimated: NativeUsageAndCost, observed: NativeUsageAndCost | null): { readonly observed: NativeUsageAndCost; readonly evidence: NativeCampaignBudgetSettlement } {
  const observedTokens = observed?.tokens.kind === "measured";
  const observedCost = observed !== null && (config.max_cost === undefined || sameDenomination(observed.cost, config.max_cost));
  const tokens = observedTokens ? observed!.tokens : estimated.tokens;
  const cost = observedCost ? observed!.cost : estimated.cost;
  const source = observedTokens && observedCost
    ? "observed" as const
    : !observedTokens && !observedCost
      ? "conservative_estimate" as const
      : "mixed" as const;
  const reason = source === "observed" ? undefined : observed === null
    ? "provider telemetry unavailable; charged persisted conservative reservation"
    : "provider telemetry was incomplete or unattributable; charged persisted conservative reservation for affected dimensions";
  return { observed: { tokens, cost }, evidence: { source, ...(reason === undefined ? {} : { reason }) } };
}
/** Older durable rows predate settlement provenance. Preserve their charged
 * amount and normalize only the absent optional field; never reinterpret it
 * as observed telemetry. */
function normalizeStore(value: Store): Store {
  if (typeof value !== "object" || value === null || typeof value.campaign_id !== "string" || !Number.isSafeInteger(value.revision) || !Array.isArray(value.reservations)) throw new Error("invalid native campaign budget record");
  return {
    ...value,
    reservations: value.reservations.map((reservation) => {
      if (typeof reservation !== "object" || reservation === null || typeof reservation.reservation_id !== "string" || typeof reservation.session_id !== "string" || (reservation.state !== "reserved" && reservation.state !== "settled")) throw new Error("invalid native campaign budget reservation");
      // A settled row without a charge would be indistinguishable from a
      // fabricated free provider call. Refuse that corruption rather than
      // reconstructing a zero from partial durable state.
      if (reservation.state === "settled" && reservation.settled === null) throw new Error("invalid settled native campaign budget reservation");
      return reservation.settlement === undefined ? { ...reservation, settlement: null } : reservation;
    }),
  };
}
function tokens(value: NativeUsageAndCost): number | null { return value.tokens.kind === "measured" ? value.tokens.input_tokens + value.tokens.output_tokens + value.tokens.cache_read_tokens + value.tokens.cache_write_tokens : null; }
function unpriced(reason: string): Extract<Cost, { kind: "unpriced" }> { return { kind: "unpriced", reason }; }
function priced(cost: Cost): number { return cost.kind === "priced" ? cost.minor_units : 0; }
function sameDenomination(cost: Cost, max: Extract<Cost, { kind: "priced" }>): boolean { return cost.kind === "priced" && cost.currency === max.currency && cost.minor_unit_exponent === max.minor_unit_exponent && cost.price_source_id === max.price_source_id; }
function sumCost(costs: readonly Cost[], empty: string): Cost { if (costs.length === 0) return unpriced(empty); const first = costs[0]!; return first.kind === "priced" && costs.every((cost) => sameDenomination(cost, first)) ? { ...first, minor_units: costs.reduce((sum, cost) => sum + priced(cost), 0) } : unpriced("one or more native cost observations are unpriced or use different schedules"); }
function validateConfig(config: NativeCampaignBudgetConfig): void { if (!config.provenance || config.provenance.tag === undefined) throw new Error("campaign budget requires provenance"); if (config.max_tokens !== undefined && (!Number.isSafeInteger(config.max_tokens) || config.max_tokens <= 0)) throw new Error("max_tokens must be positive"); if (config.max_cost !== undefined && (!Number.isSafeInteger(config.max_cost.minor_units) || config.max_cost.minor_units < 0)) throw new Error("max_cost must be non-negative"); }
function freeze<T>(value: T): T { return Object.freeze(value); }
