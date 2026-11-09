/**
 * The ADVISORY `inject` half of the per-turn boundary: `turn_end` is bindable
 * by an `inject` descriptor, `HookBus.injectTurnEnd` dispatches it through the
 * SAME `TropismInjector` the session lane uses, and the deny boundary is
 * untouched.
 *
 * Why this lane exists at all, and why it is safe, in one place:
 *
 *  - Two hooks devolved here were MODEL-FACING PROSE in the shell and had no
 *    place to go: `vi-graph-debt` had to become a ledger NOTE, and the
 *    evidence-staleness nudge would have become a note too — which is not a
 *    loss of information (the same finding reaches the model through an
 *    existing injection) but IS a loss of TIMING. A nudge whose whole product
 *    is "do this before your next turn" cannot be a note.
 *  - The operator's approval was specifically for an ADVISORY lane, and the
 *    difference is structural, not rhetorical: an inject handler's return type
 *    (`Tropism | null`) carries no decision field, so binding `turn_end` to
 *    the inject lane cannot widen `HOOK_LIFECYCLE_VETO_EVENT`, cannot make a
 *    descriptor deny-capable, and leaves the catalog's load-time reduction
 *    check refusing exactly what it refused before. The three assertions at
 *    the top of this file are that claim, made executable.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilitySupport } from "@arbor/harness";
import { NativeSessionEngine } from "@arbor/harness";
import { NativeHarnessWorker, type NativeModelPort, type NativeToolResponse } from "@arbor/harness";
import type { ExecutionPolicy, SessionStartRequest } from "@arbor/harness";
import type { Tropism } from "@arbor/prompts";

import { HookBus } from "../../src/hooks/bus.js";
import { HookCatalog } from "../../src/hooks/catalog.js";
import {
  HOOK_INJECT_EVENTS,
  HOOK_LIFECYCLE_EVENTS,
  HOOK_LIFECYCLE_VETO_EVENT,
  HOOK_VETO_EVENTS,
  type HookHandlerRegistry,
  type HookKind,
} from "../../src/hooks/contracts.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const descriptor = (hook_id: string, kind: HookKind, event: string, handler_ref: string): string =>
  JSON.stringify({ schema_version: 1, hook_id, version: "1.0.0", kind, event, handler_ref, why: "why" });

const tropism = (id: string, derived: string, body = "the finding"): Tropism => Object.freeze({
  id, trigger: "turn_end", lane: "ADVISORY", provenance: "generated",
  derived_from: Object.freeze([derived]), body, expires_after_turns: 8, enforcing_ref: null,
});

describe("the advisory inject turn_end lane", () => {
  let root = "";
  let hooksDir = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arbor-hooks-turn-inject-"));
    hooksDir = join(root, ".arbor", "hooks");
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const busFor = (handlers: HookHandlerRegistry): HookBus => HookBus.fromDirectory(hooksDir, { handlers });

  it("binds turn_end for inject, and leaves the deny boundary exactly where it was", () => {
    // The widening is one entry in ONE list. Everything that could turn
    // `turn_end` into a place a turn is refused is deliberately not touched.
    expect(HOOK_INJECT_EVENTS).toContain("turn_end");
    expect(HOOK_LIFECYCLE_EVENTS).not.toContain("turn_end");
    expect(HOOK_VETO_EVENTS).not.toContain("turn_end");
    expect(HOOK_LIFECYCLE_VETO_EVENT).toBe("session_start");

    const catalog = new HookCatalog();
    // Legal: an event may be bindable by several KINDS. `session_start`
    // already is lifecycle_start + lifecycle_observe + inject; `turn_end` is
    // now observe + inject.
    expect(catalog.register(Buffer.from(descriptor("turn-advisory", "inject", "turn_end", "inject.governance-orient"))).event).toBe("turn_end");
    // Still refused, at load, for the same reasons as before the widening.
    expect(() => catalog.register(Buffer.from(descriptor("turn-veto", "veto", "turn_end", "veto.deny-shell-execute"))))
      .toThrowError(expect.objectContaining({ code: "hook_escalation" }));
    expect(() => catalog.register(Buffer.from(descriptor("turn-lifecycle", "lifecycle", "turn_end", "lifecycle.deny-session-start"))))
      .toThrowError(expect.objectContaining({ code: "hook_escalation" }));
    // And an inject descriptor may not bind a non-inject handler — the kind
    // check is unchanged, so `turn_end` is not a way around it.
    expect(() => catalog.register(Buffer.from(descriptor("turn-wrong-kind", "inject", "turn_end", "observe.tool-audit-notes"))))
      .toThrowError(expect.objectContaining({ code: "hook_escalation" }));
  });

  it("renders a handler's tropism as bounded prompt text for the next turn", async () => {
    writeFileSync(join(hooksDir, "turn-advisory@1.0.0.json"), descriptor("turn-advisory", "inject", "turn_end", "inject.turn-test"));
    const bus = busFor({ "inject.turn-test": { kind: "inject", handler: async () => tropism("turn-finding", "turn:aaaa") } });

    const scope = await bus.injectTurnEnd({ session_id: "s-inject", turn: 4 });

    expect(scope.content).toContain("the finding");
    expect(scope.source_paths).toEqual(["turn:aaaa"]);
    expect(bus.ledger().at(-1)?.evidence_ref).toContain("injected=turn-finding");
  });

  it("renders nothing, and says so, when the handler has nothing new", async () => {
    writeFileSync(join(hooksDir, "turn-quiet@1.0.0.json"), descriptor("turn-quiet", "inject", "turn_end", "inject.turn-test"));
    const bus = busFor({ "inject.turn-test": { kind: "inject", handler: () => null } });

    const scope = await bus.injectTurnEnd({ session_id: "s-quiet", turn: 1 });

    // `null` IS the handler's verdict, and silence is a verdict: the healthy
    // case must cost no prompt bytes.
    expect(scope.content).toBe("");
    expect(bus.ledger().at(-1)).toMatchObject({ decision: "observed" });
    expect(bus.ledger().at(-1)?.evidence_ref).toContain("note=-");
  });

  it("§5.3 dedupe suppresses a scope whose derivation has not moved, and re-renders one that has", async () => {
    writeFileSync(join(hooksDir, "turn-dedupe@1.0.0.json"), descriptor("turn-dedupe", "inject", "turn_end", "inject.turn-test"));
    let derivation = "turn:same";
    const bus = busFor({ "inject.turn-test": { kind: "inject", handler: () => tropism("turn-nudge", derivation) } });

    expect((await bus.injectTurnEnd({ session_id: "s-dedupe", turn: 1 })).content).not.toBe("");
    // Same derivation, next turn: suppressed. This is the anti-spam property
    // that makes a PER-TURN lane affordable, and it is also why a handler whose
    // `derived_from` stops moving goes silent rather than lying.
    expect((await bus.injectTurnEnd({ session_id: "s-dedupe", turn: 2 })).content).toBe("");
    expect(bus.ledger().at(-1)?.evidence_ref).toContain("deduped=turn-nudge");
    // Moved derivation: it renders again, because something in the repository
    // actually changed.
    derivation = "turn:moved";
    expect((await bus.injectTurnEnd({ session_id: "s-dedupe", turn: 3 })).content).not.toBe("");
  });

  it("keeps the TTL window: a suppressed scope re-renders once its claim expires", async () => {
    writeFileSync(join(hooksDir, "turn-ttl@1.0.0.json"), descriptor("turn-ttl", "inject", "turn_end", "inject.turn-test"));
    const bus = busFor({
      "inject.turn-test": {
        kind: "inject",
        handler: () => Object.freeze({ ...tropism("turn-ttl-nudge", "turn:constant"), expires_after_turns: 2 }),
      },
    });

    expect((await bus.injectTurnEnd({ session_id: "s-ttl", turn: 1 })).content).not.toBe("");
    expect((await bus.injectTurnEnd({ session_id: "s-ttl", turn: 2 })).content).toBe("");
    // Past `expires_after_turns` the claim is RELEASED, so a still-true
    // finding is not suppressed forever by a window that was only ever meant
    // to stop an immediate repeat.
    expect((await bus.injectTurnEnd({ session_id: "s-ttl", turn: 3 })).content).not.toBe("");
  });

  it("awaits the handler under its own declared bound and reports an overrun by name", async () => {
    writeFileSync(join(hooksDir, "turn-slow@1.0.0.json"), descriptor("turn-slow", "inject", "turn_end", "inject.turn-test"));
    const bus = busFor({
      "inject.turn-test": { kind: "inject", timeout_ms: 25, handler: async () => { await delay(400); return tropism("turn-late", "turn:late"); } },
    });

    const scope = await bus.injectTurnEnd({ session_id: "s-slow", turn: 1 });

    // The product is TEXT, so this lane cannot be fire-and-forget like an
    // observe note: an overrun must degrade to a NAMED dropped state and an
    // empty scope, never silence and never an exception at the turn boundary.
    expect(scope.content).toBe("");
    const failure = bus.ledger().find((row) => row.decision === "error");
    expect(failure?.evidence_ref).toContain("hook_timeout_exceeded");
    expect(failure?.evidence_ref).toContain("bound_ms=25");
  });

  // --- the lane end to end, through the REAL worker ----------------------

  it("reaches the model through the real worker, and an unchanged nudge reaches it once", async () => {
    writeFileSync(join(hooksDir, "turn-e2e@1.0.0.json"), descriptor("turn-e2e", "inject", "turn_end", "inject.turn-test"));
    const bus = busFor({ "inject.turn-test": { kind: "inject", handler: () => tropism("turn-e2e-nudge", "turn:constant", "STALE-STORE-NUDGE") } });

    const capabilities: readonly CapabilitySupport[] = [
      "streaming", "interruption", "resumption", "forking", "ephemeral_sessions", "structured_output", "tool_policy", "workspace_isolation", "approval_mediation", "usage_reporting", "artifact_capture", "remote_transport",
    ].map((capability) => ({
      capability, grade: "native",
      evidence: { implementation_id: "native-reference", observed_at: "2026-08-09T00:00:00.000Z", detail: "native conformance" },
    })) as readonly CapabilitySupport[];
    const policy: ExecutionPolicy = {
      filesystem: "read_only", approvals: "never", tool_allow: ["read"], tool_deny: [], workspace_roots: ["/workspace"],
      max_wall_clock_ms: 3_600_000, max_events: 200, network_allowed: false, ambient_plugins_allowed: false,
      user_configuration_allowed: false, inherited_credentials_allowed: false,
    };
    const start: SessionStartRequest = { session_id: "s-e2e", policy, required_capabilities: [], lineage: { kind: "new" }, ephemeral: false };
    const read = (): NativeToolResponse => ({
      result_summary: "read", model_output: "source text",
      evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", action_scope: { status: "not_required" } },
    });
    const prompts: string[] = [];
    const model: NativeModelPort = {
      async run(request) {
        prompts.push(request.prompt);
        return prompts.length <= 3
          ? { text: [], tool_calls: [{ call_id: `c${prompts.length}`, tool: "read", input: { path: "a.ts" }, input_summary: "read a.ts", risk: "low" }], final_message: null }
          : { text: [], tool_calls: [], final_message: "the answer" };
      },
    };

    const result = await new NativeHarnessWorker({
      session_engine: new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities }),
      model,
      tools: [{ tool: "read", async execute() { return read(); } }],
      turn_inject: async (boundary) => {
        const scope = await bus.injectTurnEnd({ session_id: boundary.session_id, turn: boundary.turn });
        return scope.content === "" ? null : scope.content;
      },
    }).run({ start, prompt: "do the work", max_turns: 6 });

    expect(result.session.state).toBe("completed");
    expect(prompts).toHaveLength(4);
    // §5.3's dedupe (the derivation never moves) and the worker's
    // consume-on-delivery are DIFFERENT properties and both are needed: dedupe
    // alone would still let a changed derivation repeat every turn, and
    // consumption alone would repeat an unchanged nudge forever. Together the
    // advisory reaches the model once, and reaches it AT ALL.
    const deliveries = prompts.reduce((sum, prompt) => sum + (prompt.split("STALE-STORE-NUDGE").length - 1), 0);
    expect(deliveries).toBe(1);
    expect(prompts[0]).not.toContain("STALE-STORE-NUDGE");
    expect(prompts[1]).toContain("STALE-STORE-NUDGE");
  });
});
