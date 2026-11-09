/**
 * `turn_end` is the bus's OBSERVE half of the per-turn boundary seam, and it
 * has exactly one job: reach a handler that does governed I/O (the stop-tier
 * battery, which costs tens of seconds and cannot be asked for a synchronous
 * answer) without making the turn wait for it, and without dropping it.
 *
 * Two properties are asserted here and both are the defect class this repo has
 * now shipped three times:
 *
 *  - It is REACHED. Before the async observe lane (W7a) a Promise-returning
 *    handler measured ~0 ms, passed the bound, and was then refused by the
 *    validator as malformed — indistinguishable in the ledger from a handler
 *    with nothing to say. The firing row is written at the observation point
 *    for exactly this reason: a bus that never settles is still evidence.
 *  - It CANNOT DENY. `turn_end` is observe-kind only, and a descriptor that
 *    declares a veto handler on it is refused at catalog load. The refusal a
 *    turn actually needs is the WORKER's `turn_gate`, not a bus event — see
 *    `packages/arbor-harness/tests/turn-gate.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookBus, type HookFiredRecord } from "../../src/hooks/bus.js";
import { HookCatalog } from "../../src/hooks/catalog.js";
import type { HookHandlerRegistry, HookKind } from "../../src/hooks/contracts.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const writeDescriptor = (hooksDir: string, hookId: string, kind: HookKind, event: string, handlerRef: string, why: string): void => {
  writeFileSync(join(hooksDir, `${hookId}@1.0.0.json`), JSON.stringify({ schema_version: 1, hook_id: hookId, version: "1.0.0", kind, event, handler_ref: handlerRef, why }, null, 2));
};

const descriptor = (hook_id: string, kind: HookKind, event: string, handler_ref: string): string =>
  JSON.stringify({ schema_version: 1, hook_id, version: "1.0.0", kind, event, handler_ref, why: "why" });

describe("the turn_end observe lane", () => {
  let root = "";
  let hooksDir = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arbor-hooks-turn-end-"));
    mkdirSync(join(root, ".arbor", "hooks"), { recursive: true });
    hooksDir = join(root, ".arbor", "hooks");
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const settle = (handlers: HookHandlerRegistry): { bus: HookBus; settled: () => Promise<readonly HookFiredRecord[]> } => {
    const rows: HookFiredRecord[] = [];
    let announce: (() => void) | null = null;
    const bus = HookBus.fromDirectory(hooksDir, {
      handlers,
      on_fired: (record) => {
        rows.push(record);
        if (record.evidence_ref.includes("settled=") || record.evidence_ref.includes("error=")) announce?.();
      },
    });
    return {
      bus,
      settled: () => new Promise<readonly HookFiredRecord[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`turn_end never settled; rows so far: ${JSON.stringify(rows.map((row) => row.evidence_ref))}`)), 2_000);
        announce = () => { clearTimeout(timer); resolve(rows); };
      }),
    };
  };

  it("reaches a handler that does governed I/O, and records that it was in flight", async () => {
    writeDescriptor(hooksDir, "stop-battery", "observe", "turn_end", "observe.turn-end-battery", "run the stop-tier battery out of band");
    const { bus, settled } = settle({
      "observe.turn-end-battery": { kind: "observe", handler: async () => { await delay(5); return { note: "stop tier green" }; } },
    });

    const arrival = settled();
    bus.observeTurnEnd("s-turn", 3);
    const rows = await arrival;

    expect(rows[0]).toMatchObject({ hook_id: "stop-battery", kind: "observe", event: "turn_end", decision: "observed" });
    expect(rows[0]?.evidence_ref).toContain("pending=");
    expect(rows.at(-1)?.evidence_ref).toContain("note=stop tier green");
    // The turn number crosses the boundary so a handler can tell a first turn
    // from the twentieth, and no consumer of the row has to parse the summary.
    expect(rows[0]?.evidence_ref).toContain("turn=3");
  });

  it("surfaces a handler that exceeds its declared bound as a named, attributed error", async () => {
    writeDescriptor(hooksDir, "slow-stop-battery", "observe", "turn_end", "observe.turn-end-slow", "run a battery that overruns its budget");
    const { bus, settled } = settle({
      // The bound a real battery handler declares is the repo's own ratcheted
      // ceiling from scripts/gate-budget/stop-budget.json (25000 ms). This
      // fixture uses a small one so the test is fast; what is under test is
      // that the overrun is NAMED, never silent.
      "observe.turn-end-slow": { kind: "observe", timeout_ms: 25, handler: async () => { await delay(400); return { note: "never recorded" }; } },
    });

    const arrival = settled();
    bus.observeTurnEnd("s-turn", 1);
    const rows = await arrival;

    const failure = rows.find((row) => row.decision === "error");
    expect(failure?.evidence_ref).toContain("hook_timeout_exceeded");
    // The bound that was crossed is in the row: a refusal that does not say
    // which limit it crossed is one an operator cannot act on.
    expect(failure?.evidence_ref).toContain("bound_ms=25");
    expect(rows.some((row) => row.evidence_ref.includes("never recorded"))).toBe(false);
  });

  it("leaves a synchronous handler on exactly one row, with no in-flight scaffolding", () => {
    writeDescriptor(hooksDir, "sync-turn-note", "observe", "turn_end", "observe.turn-end-sync", "note the turn boundary synchronously");
    const bus = HookBus.fromDirectory(hooksDir, {
      handlers: { "observe.turn-end-sync": { kind: "observe", handler: () => ({ note: "observed" }) } },
    });

    bus.observeTurnEnd("s-turn", 1);

    expect(bus.ledger()).toHaveLength(1);
    expect(bus.ledger()[0]?.evidence_ref).toContain("note=observed");
    expect(bus.ledger()[0]?.evidence_ref).not.toContain("pending=");
  });

  it("does not become an unhandled rejection when the handler rejects", async () => {
    writeDescriptor(hooksDir, "rejecting-turn-note", "observe", "turn_end", "observe.turn-end-rejecting", "a handler whose governed read rejects");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { bus, settled } = settle({
        "observe.turn-end-rejecting": { kind: "observe", handler: async () => { await delay(1); throw new Error("the evidence store was locked"); } },
      });

      const arrival = settled();
      bus.observeTurnEnd("s-turn", 1);
      const rows = await arrival;

      expect(rows.at(-1)?.decision).toBe("error");
      expect(rows.at(-1)?.evidence_ref).toContain("hook_handler_failed");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("is observe-kind only: a veto handler on turn_end is refused at load", () => {
    const catalog = new HookCatalog();
    expect(catalog.register(Buffer.from(descriptor("turn-end-observer", "observe", "turn_end", "observe.tool-audit-notes"))).event).toBe("turn_end");
    // Reduction at load. A deny-capable turn_end would be a synchronous,
    // in-process, non-preemptible handler by contract — which is exactly what a
    // multi-second battery is not — and widening HOOK_LIFECYCLE_VETO_EVENT
    // from one value to two would weaken that load-time reduction check.
    expect(() => catalog.register(Buffer.from(descriptor("turn-end-veto", "veto", "turn_end", "veto.deny-shell-execute"))))
      .toThrowError(expect.objectContaining({ code: "hook_escalation" }));
  });
});
