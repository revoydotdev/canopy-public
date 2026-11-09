/**
 * The inject and observe lanes must CARRY an async handler, not drop it.
 *
 * This file exists for one defect shape, and it is the same shape the
 * ADR-032 liveness work found twice already: a handler that is registered,
 * declared, and dispatched, and that never actually does anything — with a
 * ledger row that reads exactly like a handler that legitimately had
 * nothing to say.
 *
 * `HookInjectHandler` declares a Promise arm (`contracts.ts`). Before this
 * lane could await, the bus measured the *synchronous* call — `runBounded`
 * is `(fn: () => unknown) => BoundedOutcome<unknown>`, so no `await` was
 * even expressible at the call site. A handler returning
 * `Promise<Tropism>` therefore measured ~0 ms, PASSED the 50 ms bound, and
 * handed a Promise to `catalog.validateTropism`, whose `plain()` check
 * refused it as `tropism_malformed`. A handler that does I/O — spawns
 * `scripts/decision-queue.mjs`, appends to `.dirty`, runs the battery — is
 * not slow. It is unreachable, and it is indistinguishable from a handler
 * that returned `null`.
 *
 * So every assertion here is on what the BUS decided from a handler that
 * did real asynchronous work, through the real `HookBus` and the real
 * on-disk descriptor load (`HookCatalog.fromDirectory` — the call
 * `native-executor-composition.ts` makes), never by calling a handler
 * directly. A unit test of the handler would have stayed green through the
 * whole defect.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookBus, type HookFiredRecord } from "../../src/hooks/bus.js";
import type { HookHandlerRegistry, HookKind } from "../../src/hooks/contracts.js";
import type { Tropism } from "@arbor/prompts";

const BODY = "The owed-decision queue has 2 open records.";

const tropism = (overrides: Partial<Tropism> = {}): Tropism => ({
  id: "owed-decisions", trigger: "session_start", lane: "ADVISORY", provenance: "generated",
  derived_from: ["ring:async1"], body: BODY, expires_after_turns: 3, enforcing_ref: null, ...overrides,
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
/** A genuinely blocking handler, so the wall-clock bound is measured against real elapsed time. */
const spin = (ms: number): void => { const until = Date.now() + ms; while (Date.now() < until) { /* deliberate */ } };

const writeDescriptor = (hooksDir: string, hookId: string, kind: HookKind, event: string, handlerRef: string, why: string): void => {
  writeFileSync(join(hooksDir, `${hookId}@1.0.0.json`), JSON.stringify({ schema_version: 1, hook_id: hookId, version: "1.0.0", kind, event, handler_ref: handlerRef, why }, null, 2));
};

describe("async dispatch: an inject handler that does I/O is reached, not dropped", () => {
  let root = "";
  let hooksDir = "";

  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arbor-hooks-async-"));
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "T");
    mkdirSync(join(root, ".arbor", "hooks"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# fixture\n");
    git("add", "-A");
    git("commit", "-q", "-m", "root");
    hooksDir = join(root, ".arbor", "hooks");
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /**
   * Descriptors on real disk, loaded through the production path. A catalog
   * built in memory cannot catch a handler the composition root would never
   * resolve; a descriptor written to disk is what an operator's
   * `.arbor/hooks` directory actually contains.
   */
  const bus = (handlers: HookHandlerRegistry, onFired?: (record: HookFiredRecord) => void): HookBus =>
    HookBus.fromDirectory(hooksDir, onFired === undefined ? { handlers } : { handlers, on_fired: onFired });

  const sessionStart = { session_id: "s-async", campaign_id: "c-1", node_id: "n-1", turn: 0 } as const;

  it("injects the tropism an ASYNC inject handler returns", async () => {
    const handlers: HookHandlerRegistry = {
      // The shape the blocked waves need: read governed state, await real
      // I/O, propose a tropism. Nothing about it is exotic except the await.
      "inject.owed-decisions-async": { kind: "inject", handler: async () => { await delay(5); return tropism(); } },
    };
    writeDescriptor(hooksDir, "owed-decisions-async", "inject", "session_start", "inject.owed-decisions-async", "surface the operator decision queue at session start");

    const scope = await bus(handlers).injectForSession("session_start", sessionStart);

    expect(scope.content).toContain(BODY);
    expect(scope.truncated).toBe(false);
  });

  it("keeps the derivation ledgered, so rule 2 still dedupes an async handler's output", async () => {
    const handlers: HookHandlerRegistry = {
      "inject.owed-decisions-async": { kind: "inject", handler: async () => { await delay(1); return tropism(); } },
    };
    writeDescriptor(hooksDir, "owed-decisions-async", "inject", "session_start", "inject.owed-decisions-async", "surface the operator decision queue at session start");
    const wired = bus(handlers);

    expect((await wired.injectForSession("session_start", sessionStart)).content).toContain(BODY);
    expect((await wired.injectForSession("session_start", { ...sessionStart, turn: 1 })).content).toBe("");

    const injected = wired.ledger().find((entry) => entry.evidence_ref.includes("injected=owed-decisions"));
    const deduped = wired.ledger().find((entry) => entry.evidence_ref.includes("deduped=owed-decisions"));
    expect(injected?.derived_from).toEqual(["ring:async1"]);
    expect(deduped?.derived_from).toEqual(["ring:async1"]);
  });

  it("keeps firing the lane after an async refusal — a dropped tropism is an outcome, not a dead descriptor", async () => {
    const handlers: HookHandlerRegistry = {
      "inject.owed-decisions-async": { kind: "inject", handler: async () => { await delay(1); return tropism({ body: "Always run gate:all." }); } },
    };
    writeDescriptor(hooksDir, "owed-decisions-async", "inject", "session_start", "inject.owed-decisions-async", "surface the operator decision queue at session start");
    const wired = bus(handlers);

    expect((await wired.injectForSession("session_start", sessionStart)).content).toBe("");
    expect(wired.ledger()[0]?.evidence_ref).toContain("refused=advisory_imperative");
    expect(wired.neverFired()).toEqual([]);
  });

  it("surfaces an async handler that exceeds its DECLARED bound as a named, attributed error", async () => {
    const handlers: HookHandlerRegistry = {
      // The declared bound is the whole mechanism: the bus-wide 50 ms default
      // is right for an in-process handler and meaningless for one that
      // spawns a process, so a handler that does I/O states its own cost.
      "inject.slow-io": { kind: "inject", timeout_ms: 25, handler: async () => { await delay(400); return tropism(); } },
    };
    writeDescriptor(hooksDir, "slow-io-tropism", "inject", "session_start", "inject.slow-io", "surface state read through a slow governed subprocess");

    const wired = bus(handlers);
    const scope = await wired.injectForSession("session_start", sessionStart);

    // Not a silent no-op and not a crash: the lane returns an empty scope,
    // and the ledger names the hook, the cause, and the bound it declared.
    expect(scope.content).toBe("");
    expect(wired.ledger()).toHaveLength(1);
    expect(wired.ledger()[0]).toMatchObject({ hook_id: "slow-io-tropism", kind: "inject", event: "session_start", decision: "error" });
    expect(wired.ledger()[0]?.evidence_ref).toContain("hook_timeout_exceeded");
    expect(wired.ledger()[0]?.evidence_ref).toContain("25");
  });

  it("distinguishes the three ways a handler contributes nothing", async () => {
    const handlers: HookHandlerRegistry = {
      "inject.quiet": { kind: "inject", handler: async () => { await delay(1); return null; } },
      "inject.malformed": { kind: "inject", handler: async () => { await delay(1); return { ...tropism(), derived_from: [] }; } },
      "inject.over-bound": { kind: "inject", timeout_ms: 20, handler: async () => { await delay(300); return tropism(); } },
    };
    writeDescriptor(hooksDir, "quiet-tropism", "inject", "session_start", "inject.quiet", "nothing new to say");
    writeDescriptor(hooksDir, "malformed-tropism", "inject", "session_start", "inject.malformed", "propose a malformed tropism");
    writeDescriptor(hooksDir, "over-bound-tropism", "inject", "session_start", "inject.over-bound", "exceed the declared bound");
    const wired = bus(handlers);

    await wired.injectForSession("session_start", sessionStart);
    const byHook = new Map(wired.ledger().map((entry) => [entry.hook_id, entry.evidence_ref]));

    // "Nothing to say" is an observation. A malformed value and an overrun
    // are errors with DIFFERENT names. Before the fix a Promise read as
    // malformed — which is how an I/O handler came to look like a handler
    // with nothing to contribute.
    expect(byHook.get("quiet-tropism")).toContain("note=-");
    expect(byHook.get("malformed-tropism")).toContain("refused=tropism_malformed");
    expect(byHook.get("over-bound-tropism")).toContain("error=hook_timeout_exceeded");
  });

  it("leaves a slow SYNCHRONOUS handler behaving exactly as it does today", async () => {
    const handlers: HookHandlerRegistry = {
      "inject.slow-sync": { kind: "inject", handler: () => { spin(120); return tropism(); } },
    };
    writeDescriptor(hooksDir, "slow-sync-tropism", "inject", "session_start", "inject.slow-sync", "a synchronous handler that overruns the bus-wide bound");

    const wired = bus(handlers);
    const scope = await wired.injectForSession("session_start", sessionStart);

    expect(scope.content).toBe("");
    expect(wired.ledger()[0]?.decision).toBe("error");
    expect(wired.ledger()[0]?.evidence_ref).toContain("hook_timeout_exceeded");
    // The bus-wide default is unchanged: an in-process handler declares no
    // bound of its own, so 50 ms is still the line.
    expect(wired.ledger()[0]?.evidence_ref).toContain("50");
  });
});

describe("async dispatch: the observe lane reaches a handler that returns a Promise", () => {
  let root = "";
  let hooksDir = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arbor-hooks-async-observe-"));
    mkdirSync(join(root, ".arbor", "hooks"), { recursive: true });
    hooksDir = join(root, ".arbor", "hooks");
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /**
   * The observe lane is a SUBSCRIBER to a synchronous host stream: it is
   * called from `on_audit` and from the session engine's own `on_event`,
   * neither of which can be awaited, so the caller cannot own the
   * settlement. The test therefore listens on the bus's own `on_fired` seam
   * — every row the bus writes is announced — instead of polling. The
   * timeout is a bound on a hung test, not a wait for the handler.
   */
  const settle = (handlers: HookHandlerRegistry): { bus: HookBus; settled: () => Promise<readonly string[]> } => {
    const refs: string[] = [];
    let announce: (() => void) | null = null;
    const bus = HookBus.fromDirectory(hooksDir, {
      handlers,
      on_fired: (record) => {
        refs.push(record.evidence_ref);
        if (record.evidence_ref.includes("settled=") || record.evidence_ref.includes("error=")) announce?.();
      },
    });
    return {
      bus,
      settled: () => new Promise<readonly string[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the observe lane never settled; rows so far: ${JSON.stringify(refs)}`)), 2_000);
        announce = () => { clearTimeout(timer); resolve(refs); };
      }),
    };
  };

  it("records the note an async observe handler returns, and shows it was in flight", async () => {
    writeDescriptor(hooksDir, "async-notes", "observe", "phase", "observe.async-notes", "note a phase asynchronously");
    const { bus: wired, settled } = settle({
      "observe.async-notes": { kind: "observe", handler: async () => { await delay(5); return { note: "phase observed" }; } },
    });

    const arrival = settled();
    wired.observePhase("c-1", "execute", "ok");
    const refs = await arrival;

    // A handler in flight is visible: the dispatch row is written at the
    // observation point, so a bus that never settles is still evidence.
    expect(refs.some((ref) => ref.includes("pending="))).toBe(true);
    expect(refs.some((ref) => ref.includes("note=phase observed"))).toBe(true);
  });

  it("surfaces an async observe handler that exceeds its declared bound as a named error", async () => {
    writeDescriptor(hooksDir, "slow-io-notes", "observe", "phase", "observe.slow-io", "run governed I/O on a phase transition");
    const { bus: wired, settled } = settle({
      "observe.slow-io": { kind: "observe", timeout_ms: 25, handler: async () => { await delay(400); return { note: "never recorded" }; } },
    });

    const arrival = settled();
    wired.observePhase("c-1", "execute", "ok");
    const refs = await arrival;

    expect(refs.some((ref) => ref.includes("hook_timeout_exceeded"))).toBe(true);
    expect(refs.some((ref) => ref.includes("note=never recorded"))).toBe(false);
  });

  it("leaves a synchronous observe handler's row shape untouched", () => {
    writeDescriptor(hooksDir, "sync-notes", "observe", "phase", "observe.sync-notes", "note a phase synchronously");
    const wired = HookBus.fromDirectory(hooksDir, {
      handlers: { "observe.sync-notes": { kind: "observe", handler: () => ({ note: "phase observed" }) } },
    });

    wired.observePhase("c-1", "execute", "ok");

    // One row, written at the observation point, with no `pending=`/
    // `settled=` scaffolding: the async arm must not tax a sync handler.
    expect(wired.ledger()).toHaveLength(1);
    expect(wired.ledger()[0]?.evidence_ref).toContain("note=phase observed");
    expect(wired.ledger()[0]?.evidence_ref).not.toContain("pending=");
  });
});
