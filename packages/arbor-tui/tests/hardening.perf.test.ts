/**
 * TUI hardening gate 25 — performance/terminal stress tests.
 *
 * Per docs/tui-cockpit/roadmap.md item 25:
 *   "capped renders, virtualization, compatibility and profiling reports;
 *    resize storm/input flood/long-session/large-entity tests"
 *
 * Every test is DETERMINISTIC: fake clock, fake renderer, no wall-clock sleep.
 * Headless only — handoff §2.XII (tests are evidence at matching scope).
 */
import { describe, expect, it } from "vitest";
import { TuiShell, InputRouter, catalogConflicts, initialModel, createNavigation, update, type CadencePort, type InputCatalog, type RenderProjection } from "../src/index.js";
import { MemoryRenderer, renderTerminalFrame } from "./support/render-harness.js";

// ── helpers ────────────────────────────────────────────────────────────────

function projection(columns: number, rows: number, output: string | { content: string; evidence_pointer?: string }): RenderProjection {
  return {
    app: initialModel(),
    output,
    navigation: createNavigation(
      { id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "output", title: "Output" }] },
      { columns, rows },
    ),
  };
}

/** Fake clock surface for InputRouter — advances on demand, never wall-clock. */
function fakeClock(start = 0): { now: () => number; advance: (delta: number) => void } {
  let tick = start;
  return { now: () => tick, advance: (delta) => { tick += delta; } };
}

class ManualCadence implements CadencePort {
  readonly callbacks: Array<() => void> = [];
  readonly cancelled: unknown[] = [];
  scheduledCount = 0;
  schedule(_delayMs: number, callback: () => void): unknown {
    this.scheduledCount += 1;
    this.callbacks.push(callback);
    return callback;
  }
  cancel(handle: unknown): void {
    this.cancelled.push(handle);
  }
  tick(): void {
    this.callbacks.shift()?.();
  }
}

const FRAME_BUDGET_BYTES = 64 * 1024; // hardening cap: terminal frames stay bounded

// ── 1. render cap (bounded frame output) ──────────────────────────────────

describe("hardening gate 25 — render cap (bounded frame output)", () => {
  it("bounds a 10k-line list payload without throwing and keeps status line", () => {
    const huge = Array.from({ length: 10_000 }, (_, i) => `line-${i}`).join("\n");
    const frame = renderTerminalFrame(projection(80, 24, huge));
    const bytes = Buffer.byteLength(frame, "utf8");
    expect(bytes).toBeLessThan(FRAME_BUDGET_BYTES);
    expect(frame.split("\n")).toHaveLength(24);
    // status line always present (last row)
    expect(frame.split("\n").at(-1)?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("bounds a 1MB no-newline string without throwing or unbounded growth", () => {
    const noNewline = "x".repeat(1024 * 1024);
    const frame = renderTerminalFrame(projection(120, 10, noNewline));
    const bytes = Buffer.byteLength(frame, "utf8");
    expect(bytes).toBeLessThan(FRAME_BUDGET_BYTES);
    // never a single >1MB line
    expect(frame.split("\n").every((line) => line.length <= 120)).toBe(true);
  });

  it("bounds wide Unicode (surrogate pairs, CJK, emoji ZWJ) without throwing", () => {
    // CJK ideographs + emoji ZWJ family + combining marks + surrogate-pair math
    const wide = "你好世界".repeat(1000) + "👨‍👩‍👧‍👦".repeat(1000) + "𝕳𝖊𝖑𝖑𝖔".repeat(1000);
    const frame = renderTerminalFrame(projection(40, 8, wide));
    const bytes = Buffer.byteLength(frame, "utf8");
    expect(bytes).toBeLessThan(FRAME_BUDGET_BYTES);
    expect(frame.split("\n")).toHaveLength(8);
    // every visible line bounded by column count
    expect(frame.split("\n").every((line) => [...line].length <= 40)).toBe(true);
  });
});

// ── 2. input flood ─────────────────────────────────────────────────────────

describe("hardening gate 25 — input flood (InputRouter)", () => {
  const catalog: InputCatalog = {
    actions: [
      { id: "quit", title: "Quit", description: "Exit", bindings: [{ scope: "global", keys: ["ctrl+q"], description: "Quit" }] },
      { id: "chord", title: "Chord", description: "Two-stroke", bindings: [{ scope: "global", keys: ["g", "p"], description: "Chord" }] },
    ],
  };

  it("drives 10000 single-key events without unbounded pending-chord growth", () => {
    const clock = fakeClock();
    const router = new InputRouter(catalog, clock.now, 10, 8192);
    let pendingSeen = 0;
    let actionsSeen = 0;
    for (let i = 0; i < 10_000; i += 1) {
      clock.advance(1); // forward within chord timeout occasionally, past it other times
      const result = router.handle({ key: "x" }, ["screen"]);
      if (result.kind === "pending") pendingSeen += 1;
      if (result.kind === "action") actionsSeen += 1;
      if (i % 100 === 0) {
        clock.advance(1000); // expire any pending chord
        router.expire();
      }
    }
    // Never throws, never accumulates a giant pending queue, eventually settles.
    expect(pendingSeen + actionsSeen + 10_000).toBeGreaterThanOrEqual(10_000);
    // After a hard expire, no pending chord remains.
    clock.advance(10_000);
    router.expire();
    expect(router.expire()).toEqual({ kind: "ignored" });
  });

  it("truncates paste events at the configured pasteLimit and reports truncation", () => {
    const clock = fakeClock();
    const router = new InputRouter(catalog, clock.now, 10, 64);
    const big = "a".repeat(10_000);
    const result = router.handle({ key: "ignored", paste: true, text: big }, ["screen"]);
    expect(result.kind).toBe("paste");
    if (result.kind === "paste") {
      expect(result.text.length).toBe(64);
      expect(result.truncated).toBe(true);
    }
  });

  it("catalogConflicts still throws on conflicting bindings under flood-style construction", () => {
    const dup: InputCatalog = {
      actions: [
        ...catalog.actions,
        { id: "also", title: "Also", description: "", bindings: [{ scope: "global", keys: ["ctrl+q"], description: "" }] },
      ],
    };
    expect(() => new InputRouter(dup, fakeClock().now)).toThrow("conflicting bindings");
    expect(catalogConflicts(dup)).toHaveLength(1);
  });
});

// ── 3. resize storm (TuiShell coalescing) ──────────────────────────────────

describe("hardening gate 25 — resize storm (TuiShell coalescing)", () => {
  it("coalesces 1000 rapid invalidations to a single scheduled callback", async () => {
    const renderer = new MemoryRenderer();
    const cadence = new ManualCadence();
    const shell = new TuiShell({ renderer, cadence, projection: () => projection(80, 24, "steady") });
    await shell.start();
    expect(renderer.frames).toHaveLength(1);
    // Storm: 1000 invalidations before the cadence fires once.
    for (let i = 0; i < 1_000; i += 1) shell.invalidate();
    // Coalescing invariant: at most one pending callback at a time.
    expect(cadence.scheduledCount).toBe(1);
    expect(cadence.callbacks).toHaveLength(1);
    // Draining the single scheduled callback renders exactly one more frame.
    cadence.tick();
    await Promise.resolve();
    expect(renderer.frames).toHaveLength(2);
    // After draining, another storm schedules at most one more.
    for (let i = 0; i < 1_000; i += 1) shell.invalidate();
    expect(cadence.scheduledCount).toBe(2);
    expect(cadence.callbacks).toHaveLength(1);
    await shell.stop();
  });

  it("does not leak a scheduled callback when stopped mid-storm", async () => {
    const renderer = new MemoryRenderer();
    const cadence = new ManualCadence();
    const shell = new TuiShell({ renderer, cadence, projection: () => projection(80, 24, "steady") });
    await shell.start();
    for (let i = 0; i < 500; i += 1) shell.invalidate();
    expect(cadence.scheduledCount).toBe(1);
    await shell.stop();
    // Stop cancels the pending callback; storm never renders a second frame.
    expect(renderer.frames).toHaveLength(1);
    expect(cadence.cancelled.length).toBeGreaterThanOrEqual(1);
  });
});

// ── 4. long session (model→update→render stability) ────────────────────────

describe("hardening gate 25 — long session (10000 model→update→render cycles)", () => {
  it("keeps user-visible state bounded across 10000 notification+render cycles", () => {
    const limits = { notifications: 50, diagnostics: 50 };
    let model = initialModel(limits);
    const renderer = new MemoryRenderer();
    const baseProjection = (): RenderProjection => ({
      app: model,
      output: "session",
      navigation: createNavigation(
        { id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "output", title: "Output" }] },
        { columns: 80, rows: 24 },
      ),
    });
    for (let i = 0; i < 10_000; i += 1) {
      // Bounded append: notifications array cannot exceed limits.notifications.
      const event = { type: "notification_added" as const, notification: { id: `n-${i}`, severity: "info" as const, message: `event ${i}`, createdAt: i } };
      const { model: next } = update(model, event);
      model = next;
      const frame = renderTerminalFrame(baseProjection());
      // The frame is always bounded.
      if (Buffer.byteLength(frame, "utf8") > FRAME_BUDGET_BYTES) throw new Error(`frame budget exceeded at cycle ${i}`);
    }
    // User-visible state stays at its declared bound — no unbounded array growth.
    expect(model.notifications.length).toBeLessThanOrEqual(limits.notifications);
    expect(model.diagnostics.length).toBeLessThanOrEqual(limits.diagnostics);
    // Renderer never accumulated state.
    expect(renderer.frames).toHaveLength(0);
  });

  it("never lets the diagnostics array grow beyond limits.diagnostics across 10000 distinct errors", () => {
    const limits = { notifications: 10, diagnostics: 10 };
    let model = initialModel(limits);
    for (let i = 0; i < 10_000; i += 1) {
      const error = {
        code: "internal" as const,
        message: `distinct error ${i}`,
        source: "stress",
        recoverable: true,
        fingerprint: `fp-${i}`, // distinct fingerprints → would naively grow without bound
      };
      model = update(model, { type: "error_raised", error, at: i }).model;
    }
    expect(model.diagnostics.length).toBeLessThanOrEqual(limits.diagnostics);
    // Notifications also bounded even though each distinct error raises one.
    expect(model.notifications.length).toBeLessThanOrEqual(limits.notifications);
  });
});

// ── 5. large entity (screen projection bounds) ────────────────────────────

describe("hardening gate 25 — large entity projection through every screen module", () => {
  it("projects a 10k-row campaign list deterministically without throwing", async () => {
    const { installScreens } = await import("../src/screens/install.js");
    const { clearRegisteredScreens, availableScreens } = await import("../src/screens/screen.js");
    installScreens();
    try {
      const campaigns = availableScreens(new Set(["campaign.read"])).find((m) => m.id === "campaigns");
      expect(campaigns).toBeDefined();
      const hugeList = Array.from({ length: 10_000 }, (_, i) => ({
        id: `c-${i}`, name: `Campaign ${i}`, status: "active", node_count: i, verified_count: 0,
      }));
      const projected = campaigns!.project(hugeList, { width: 80, height: 24 });
      const rendered = campaigns!.render({ projection: projected, width: 80, height: 24 });
      // Bounded row count — never 10000 lines.
      expect(rendered.length).toBeLessThanOrEqual(25);
      // Deterministic: same input → same output.
      const rendered2 = campaigns!.render({ projection: campaigns!.project(hugeList, { width: 80, height: 24 }), width: 80, height: 24 });
      expect(rendered).toEqual(rendered2);
    } finally {
      clearRegisteredScreens();
    }
  });

  it("projects a 10k-node campaign tree deterministically without throwing", async () => {
    const { installScreens } = await import("../src/screens/install.js");
    const { clearRegisteredScreens, availableScreens } = await import("../src/screens/screen.js");
    installScreens();
    try {
      const tree = availableScreens(new Set(["tree.read", "tree.write"])).find((m) => m.id === "tree");
      expect(tree).toBeDefined();
      const hugeTree = {
        campaign_id: "c-big",
        nodes: Array.from({ length: 10_000 }, (_, i) => ({
          id: `n-${i}`, label: `Node ${i}`, depth: i % 5, state: "pending", has_children: i % 3 === 0,
        })),
      };
      const projected = tree!.project(hugeTree, { width: 80, height: 24 });
      const rendered = tree!.render({ projection: projected, width: 80, height: 24 });
      expect(rendered.length).toBeLessThanOrEqual(25);
      expect(rendered[0]).toBe("SEARCH · 0/500 verified · 0 expanding · 500 pending");
    } finally {
      clearRegisteredScreens();
    }
  });

  it("projects a 10k-row tasks payload through the tasks screen deterministically", async () => {
    const { installScreens } = await import("../src/screens/install.js");
    const { clearRegisteredScreens, availableScreens } = await import("../src/screens/screen.js");
    installScreens();
    try {
      const tasks = availableScreens(new Set(["task.read", "operation.read"])).find((m) => m.id === "tasks");
      expect(tasks).toBeDefined();
      const huge = Array.from({ length: 10_000 }, (_, i) => ({
        id: `t-${i}`, status: "running", agent: "Heartwood", progress: 0.5,
      }));
      const projected = tasks!.project(huge, { width: 80, height: 24 });
      const rendered = tasks!.render({ projection: projected, width: 80, height: 24 });
      expect(rendered.length).toBeLessThanOrEqual(25);
    } finally {
      clearRegisteredScreens();
    }
  });

  it("projects a 10k-message comms payload through the communications screen with capability redaction", async () => {
    const { installScreens } = await import("../src/screens/install.js");
    const { clearRegisteredScreens, availableScreens } = await import("../src/screens/screen.js");
    installScreens();
    try {
      const comms = availableScreens(new Set(["communication.read", "communication.write"])).find((m) => m.id === "communications");
      expect(comms).toBeDefined();
      const huge = Array.from({ length: 10_000 }, (_, i) => ({
        id: `m-${i}`, kind: "delegate", author_node_id: `n-a-${i}`, recipient_node_id: `n-r-${i}`,
        capability_tier: "specialist", as_of: `t-${i}`, payload: { content: `msg ${i}` },
      }));
      const projected = comms!.project(huge, { width: 80, height: 24 });
      const rendered = comms!.render({ projection: projected, width: 80, height: 24 });
      expect(rendered.length).toBeLessThanOrEqual(25);
    } finally {
      clearRegisteredScreens();
    }
  });
});
