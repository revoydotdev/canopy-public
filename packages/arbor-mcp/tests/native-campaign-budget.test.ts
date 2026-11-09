import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCampaignBudgetAuthority } from "../src/native-campaign-budget.js";
import { ArborRuntime } from "../src/runtime.js";

const dirs: string[] = [];
const dir = (): string => { const value = mkdtempSync(join(tmpdir(), "arbor-campaign-budget-")); dirs.push(value); return value; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const config = { max_tokens: 20, max_cost: { kind: "priced" as const, minor_units: 20, currency: "USD", minor_unit_exponent: 6, price_source_id: "operator-price" }, provenance: { tag: "generated" as const, generator: "operator-budget", input_hash: "config" } };
const measured = (input: number, output: number, cost = input + output, cacheRead = 0, cacheWrite = 0) => ({ tokens: { kind: "measured" as const, input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite }, cost: { kind: "priced" as const, minor_units: cost, currency: "USD", minor_unit_exponent: 6, price_source_id: "operator-price" } });

describe("NativeCampaignBudgetAuthority", () => {
  it("reserves remediation headroom below the hard ceiling and names the remedy", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-native-budget-remedy-"));
    try {
      const authority = new NativeCampaignBudgetAuthority(dir);
      const initial = authority.initialize("campaign", { ...config, max_tokens: 100, max_cost: { ...config.max_cost, minor_units: 200 } });
      const denied = authority.reserve({ campaign_id: "campaign", expected_revision: initial.revision, reservation_id: "too-close", session_id: "session", estimate: measured(45, 46), provenance: config.provenance });
      expect(denied).toMatchObject({ status: "denied", reason: expect.stringContaining("reserved for remediation") });
      const allowed = authority.reserve({ campaign_id: "campaign", expected_revision: initial.revision, reservation_id: "allowed", session_id: "session", estimate: measured(30, 30), provenance: config.provenance });
      expect(allowed.status).toBe("reserved");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("reserves conservatively, settles exactly once, and survives restart without double charging", () => {
    const path = dir(); const first = new NativeCampaignBudgetAuthority(path); const initial = first.initialize("campaign", config);
    const reservation = first.reserve({ campaign_id: "campaign", expected_revision: initial.revision, reservation_id: "op-1", session_id: "session-1", estimate: measured(4, 6), provenance: config.provenance });
    expect(reservation.status).toBe("reserved");
    expect(reservation.snapshot).toMatchObject({ reserved_tokens: 10, remaining_tokens: 10 });
    const restarted = new NativeCampaignBudgetAuthority(path);
    expect(restarted.reserve({ campaign_id: "campaign", expected_revision: 0, reservation_id: "op-1", session_id: "session-1", estimate: measured(4, 6), provenance: config.provenance }).status).toBe("idempotent");
    const settled = restarted.settle({ campaign_id: "campaign", expected_revision: reservation.snapshot.revision, reservation_id: "op-1", observed: measured(3, 4, 7) });
    expect(settled).toMatchObject({ status: "settled", snapshot: { consumed_tokens: 7, reserved_tokens: 0, remaining_tokens: 13, consumed_cost: { kind: "priced", minor_units: 7 } } });
    expect(restarted.settle({ campaign_id: "campaign", expected_revision: 99, reservation_id: "op-1", observed: measured(9, 9, 18) }).status).toBe("idempotent");
  });

  it("includes measured cache-read and cache-write tokens in campaign reservations and settlement", () => {
    const authority = new NativeCampaignBudgetAuthority(dir()); const initial = authority.initialize("campaign", config);
    const reservation = authority.reserve({ campaign_id: "campaign", expected_revision: initial.revision, reservation_id: "cache-usage", session_id: "cache-session", estimate: measured(2, 2, 8, 3, 1), provenance: config.provenance });
    expect(reservation.snapshot).toMatchObject({ reserved_tokens: 8, remaining_tokens: 12 });
    const settled = authority.settle({ campaign_id: "campaign", expected_revision: reservation.snapshot.revision, reservation_id: "cache-usage", observed: measured(1, 1, 5, 2, 1) });
    expect(settled.snapshot).toMatchObject({ consumed_tokens: 5, remaining_tokens: 15 });
  });

  it("fails closed for unavailable estimates, enforces CAS, and records overage truthfully", () => {
    const authority = new NativeCampaignBudgetAuthority(dir()); const initial = authority.initialize("campaign", config);
    expect(authority.reserve({ campaign_id: "campaign", expected_revision: initial.revision, reservation_id: "unknown", session_id: "s", estimate: { tokens: { kind: "unavailable", reason: "no estimator" }, cost: { kind: "unpriced", reason: "no price" } }, provenance: config.provenance })).toMatchObject({ status: "denied" });
    const one = authority.reserve({ campaign_id: "campaign", expected_revision: initial.revision, reservation_id: "one", session_id: "s1", estimate: measured(5, 5), provenance: config.provenance });
    expect(authority.reserve({ campaign_id: "campaign", expected_revision: initial.revision, reservation_id: "two", session_id: "s2", estimate: measured(1, 1), provenance: config.provenance })).toMatchObject({ status: "conflict" });
    const settled = authority.settle({ campaign_id: "campaign", expected_revision: one.snapshot.revision, reservation_id: "one", observed: measured(15, 10, 25) });
    expect(settled.snapshot).toMatchObject({ consumed_tokens: 25, remaining_tokens: -5, remaining_cost: { kind: "priced", minor_units: -5 } });
  });

  it("normalizes a legacy reservation without settlement provenance without reclassifying its charged amount", () => {
    const path = dir(); const first = new NativeCampaignBudgetAuthority(path); const initial = first.initialize("campaign", config);
    const reserved = first.reserve({ campaign_id: "campaign", expected_revision: initial.revision, reservation_id: "legacy", session_id: "legacy", estimate: measured(4, 6), provenance: config.provenance });
    first.settle({ campaign_id: "campaign", expected_revision: reserved.snapshot.revision, reservation_id: "legacy", observed: measured(3, 4, 7) });
    const file = join(path, readdirSync(path).find((entry) => entry.endsWith(".json"))!);
    const legacy = JSON.parse(readFileSync(file, "utf8")) as { reservations: Array<Record<string, unknown>> };
    delete legacy.reservations[0]!.settlement;
    writeFileSync(file, `${JSON.stringify(legacy)}\n`, "utf8");

    const reopened = new NativeCampaignBudgetAuthority(path).snapshot("campaign")!;
    expect(reopened).toMatchObject({ consumed_tokens: 7, reservations: [expect.objectContaining({ reservation_id: "legacy", settled: measured(3, 4, 7), settlement: null })] });
  });

  it("uses observed dimensions only when attributable and retains the admission estimate for a missing priced dimension", () => {
    const authority = new NativeCampaignBudgetAuthority(dir()); const initial = authority.initialize("campaign", config);
    const reserved = authority.reserve({ campaign_id: "campaign", expected_revision: initial.revision, reservation_id: "partial", session_id: "partial", estimate: measured(4, 6, 10), provenance: config.provenance });
    const result = authority.settle({
      campaign_id: "campaign", expected_revision: reserved.snapshot.revision, reservation_id: "partial",
      observed: { tokens: { kind: "measured", input_tokens: 3, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0 }, cost: { kind: "unpriced", reason: "provider omitted price" } },
    });
    expect(result.snapshot).toMatchObject({ consumed_tokens: 7, consumed_cost: { kind: "priced", minor_units: 10 } });
    expect(result.snapshot.reservations).toEqual(expect.arrayContaining([expect.objectContaining({ settlement: expect.objectContaining({ source: "mixed" }), settled: expect.objectContaining({ tokens: expect.objectContaining({ input_tokens: 3, output_tokens: 4 }), cost: expect.objectContaining({ kind: "priced", minor_units: 10 }) }) })]));
  });

  it("reconciles a reservation stranded by process reopen at its durable ceiling, and repeats are idempotent", () => {
    const root = dir(); const first = new NativeCampaignBudgetAuthority(join(root, "native-campaign-budget"));
    const initial = first.initialize("campaign", config);
    const reserved = first.reserve({ campaign_id: "campaign", expected_revision: initial.revision, reservation_id: "lost-worker", session_id: "lost-worker", estimate: measured(4, 6), provenance: config.provenance });
    expect(reserved.status).toBe("reserved");

    // A new runtime is the single-writer restart boundary: no prior worker is
    // still live to provide telemetry, so restoring the reservation as free
    // budget would be a fabricated zero-spend claim.
    new ArborRuntime({ persistence_dir: root });
    const reopened = new NativeCampaignBudgetAuthority(join(root, "native-campaign-budget"));
    expect(reopened.snapshot("campaign")).toMatchObject({ consumed_tokens: 10, reserved_tokens: 0 });
    expect(reopened.snapshot("campaign")!.reservations).toEqual(expect.arrayContaining([expect.objectContaining({ reservation_id: "lost-worker", state: "settled", settled: measured(4, 6), settlement: expect.objectContaining({ source: "conservative_estimate" }) })]));
    expect(reopened.reconcileOrphanedReservations()).toEqual([]);
    expect(reopened.settle({ campaign_id: "campaign", expected_revision: 0, reservation_id: "lost-worker", observed: null }).status).toBe("idempotent");
  });
});
