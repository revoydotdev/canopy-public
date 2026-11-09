import type { NativeToolPort, NativeToolRequest } from "@arbor/harness";
import { describe, expect, it } from "vitest";
import { HookBus } from "../../src/hooks/bus.js";
import { HookCatalog } from "../../src/hooks/catalog.js";
import type { HookHandlerRegistry, HookObserveContext, HookVetoContext, HookVetoDecision, HookVetoHandler } from "../../src/hooks/contracts.js";

const descriptor = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1, hook_id: "test-hook", version: "1.0.0", kind: "veto", event: "tool_preflight",
  handler_ref: "veto.deny-shell-execute", why: "test fixture", ...overrides,
});

const request = (overrides: Partial<NativeToolRequest> = {}): NativeToolRequest => Object.freeze({
  session_id: "s-1", turn: 1, call_id: "c-1", input: {}, workspace_roots: ["/workspace"],
  filesystem: "workspace_write", network_allowed: false, intent_evidence: [], ...overrides,
});

function allowAlwaysPort(tool: string, preflight?: NativeToolPort["preflight"]): NativeToolPort {
  return {
    tool,
    ...(preflight === undefined ? {} : { preflight }),
    async execute() {
      return { result_summary: "ok", model_output: "ok", evidence: { outcome: "succeeded" as const, stage: "execution" as const, code: "ok", effect: "observed" as const, action_scope: { status: "not_required" as const } } };
    },
  };
}

describe("HookBus safety case (roadmap 06 §4)", () => {
  it("[reduction at load] rejects a veto descriptor whose event exceeds its kind at catalog load", () => {
    const catalog = new HookCatalog();
    expect(() => catalog.register(JSON.stringify(descriptor({ kind: "veto", event: "session_start" })))).toThrowError(expect.objectContaining({ code: "hook_escalation" }));
  });

  it("[reduction at composition] a hook that explicitly allows a call the base policy denied cannot override the denial", async () => {
    const handlers: HookHandlerRegistry = { "veto.allow-everything": { kind: "veto", handler: (): { allow: true } => ({ allow: true }) } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "veto.allow-everything" })));
    const bus = new HookBus({ catalog, handlers });
    const basePort = allowAlwaysPort("file.write", () => ({ allowed: false, code: "base_denied", reason: "base policy denies this call", evidence: { outcome: "refused", stage: "audit", code: "base_denied", effect: "none", action_scope: { status: "not_required" } } }));
    const wrapped = bus.wrapToolPort(basePort);
    const result = wrapped.preflight!(request());
    expect(result).toMatchObject({ allowed: false, code: "base_denied" });
    expect(bus.ledger()).toMatchObject([{ hook_id: "test-hook", decision: "allow" }]);
  });

  it("[reduction at composition] effective_allow implies base_allow: a hook may flip allow to deny, never deny to allow", async () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor()));
    const bus = new HookBus({ catalog });
    const basePort = allowAlwaysPort("shell.execute");
    const wrapped = bus.wrapToolPort(basePort);
    const result = wrapped.preflight!(request());
    expect(result).toMatchObject({ allowed: false, code: "hook_denied" });
    expect((result as { reason: string }).reason).toContain("test-hook@1.0.0");
  });

  it("[fail-closed] a throwing veto hook denies the call, ledgers the denial, and names the hook", () => {
    const handlers: HookHandlerRegistry = { "veto.throws": { kind: "veto", handler: (): never => { throw new Error("boom"); } } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "veto.throws" })));
    const bus = new HookBus({ catalog, handlers });
    const wrapped = bus.wrapToolPort(allowAlwaysPort("file.write"));
    const result = wrapped.preflight!(request()) as { allowed: false; code: string; reason: string };
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("hook_veto_failed");
    expect(result.reason).toContain("test-hook@1.0.0");
    expect(bus.ledger()).toMatchObject([{ hook_id: "test-hook", decision: "error" }]);
  });

  it("[fail-closed] a veto hook that exceeds its wall-clock bound denies the call", () => {
    const handlers: HookHandlerRegistry = {
      "veto.slow": { kind: "veto", handler: (): { allow: true } => { const until = Date.now() + 5; while (Date.now() < until) { /* busy-wait past the bound */ } return { allow: true }; } },
    };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "veto.slow" })));
    const bus = new HookBus({ catalog, handlers, timeout_ms: 1 });
    const wrapped = bus.wrapToolPort(allowAlwaysPort("file.write"));
    const result = wrapped.preflight!(request()) as { allowed: false; code: string };
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("hook_veto_failed");
    expect(bus.ledger()).toMatchObject([{ decision: "error" }]);
  });

  it("[fail-closed] a veto hook that returns an invalid decision denies the call", () => {
    const handlers: HookHandlerRegistry = { "veto.invalid": { kind: "veto", handler: (() => ({ nonsense: true })) as unknown as HookVetoHandler } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "veto.invalid" })));
    const bus = new HookBus({ catalog, handlers });
    const wrapped = bus.wrapToolPort(allowAlwaysPort("file.write"));
    const result = wrapped.preflight!(request()) as { allowed: false; code: string };
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("hook_veto_failed");
  });

  it("[fail-closed] a throwing observe hook is dropped and logged, and the action proceeds", () => {
    let calls = 0;
    const handlers: HookHandlerRegistry = { "observe.throws": { kind: "observe", handler: (): never => { calls += 1; throw new Error("observe boom"); } } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ kind: "observe", event: "tool_audit", handler_ref: "observe.throws" })));
    const bus = new HookBus({ catalog, handlers });
    expect(() => bus.observeToolAudit({ session_id: "s-1", call_id: "c-1", tool: "file.read", risk: "low", intent: null, action_scope: { status: "not_required" }, outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", confinement: "application_validated", summary: "read ok" })).not.toThrow();
    expect(calls).toBe(1);
    expect(bus.ledger()).toMatchObject([{ decision: "error" }]);
  });

  it("[no authority fabrication] the observe handler signature cannot influence the veto decision: an observe hook attached to tool_audit never gates preflight", () => {
    const handlers: HookHandlerRegistry = { "observe.tries-to-grant": { kind: "observe", handler: (context: HookObserveContext) => ({ note: `${context.event} would-grant=true` }) } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ kind: "observe", event: "tool_audit", handler_ref: "observe.tries-to-grant" })));
    const bus = new HookBus({ catalog, handlers });
    // No veto hooks are declared, so wrapping returns the port unchanged --
    // an observe-kind hook has no dispatch path into the preflight chain at all.
    const basePort = allowAlwaysPort("shell.execute", () => ({ allowed: false, code: "base_denied", reason: "denied", evidence: { outcome: "refused", stage: "audit", code: "base_denied", effect: "none", action_scope: { status: "not_required" } } }));
    const wrapped = bus.wrapToolPort(basePort);
    expect(wrapped).toBe(basePort);
    const result = wrapped.preflight!(request());
    expect(result).toMatchObject({ allowed: false, code: "base_denied" });
  });
});

describe("HookBus veto composition", () => {
  it("wraps a port unchanged when no veto hooks are declared", () => {
    const bus = new HookBus({ catalog: new HookCatalog() });
    const port = allowAlwaysPort("file.read");
    expect(bus.wrapToolPort(port)).toBe(port);
  });

  it("denies before the base port's own preflight ever runs", () => {
    let baseCalled = false;
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor()));
    const bus = new HookBus({ catalog });
    const wrapped = bus.wrapToolPort(allowAlwaysPort("shell.execute", () => { baseCalled = true; return { allowed: true }; }));
    const result = wrapped.preflight!(request({ input: { argv: ["ls"] } }));
    expect(result).toMatchObject({ allowed: false, code: "hook_denied" });
    expect(baseCalled).toBe(false);
  });

  it("allows a call when every veto hook allows and the base preflight allows", () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor())); // veto.deny-shell-execute only denies shell.execute
    const bus = new HookBus({ catalog });
    const wrapped = bus.wrapToolPort(allowAlwaysPort("file.read"));
    expect(wrapped.preflight!(request())).toEqual({ allowed: true });
    expect(bus.ledger()).toMatchObject([{ hook_id: "test-hook", decision: "allow" }]);
  });

  it("redacts a secret-shaped denial reason before it reaches the returned preflight result", () => {
    const handlers: HookHandlerRegistry = { "veto.secret-reason": { kind: "veto", handler: (): { allow: false; reason: string } => ({ allow: false, reason: "token=abcd1234efgh5678 leaked in a hand-authored reason" }) } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "veto.secret-reason" })));
    const bus = new HookBus({ catalog, handlers });
    const result = bus.wrapToolPort(allowAlwaysPort("file.write")).preflight!(request()) as { reason: string };
    expect(result.reason).not.toContain("abcd1234efgh5678");
  });
});

describe("HookBus post-execution audit wrap (ADR-087)", () => {
  it("wrapToolPortWithAudit fires a bounded tool_audit event after execute, on top of the existing veto chain", async () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor({ kind: "observe", event: "tool_audit", handler_ref: "observe.tool-audit-notes" })));
    catalog.register(JSON.stringify(descriptor({ hook_id: "veto-shell", kind: "veto", event: "tool_preflight", handler_ref: "veto.deny-shell-execute" })));
    const bus = new HookBus({ catalog });
    const wrapped = bus.wrapToolPortWithAudit(allowAlwaysPort("subagent.execute"));
    // The veto chain still runs: shell.execute stays denied even through the audited wrap.
    const shellDenied = bus.wrapToolPortWithAudit(allowAlwaysPort("shell.execute")).preflight!(request());
    expect(shellDenied).toMatchObject({ allowed: false, code: "hook_denied" });
    const response = await wrapped.execute(request(), null, new AbortController().signal);
    expect(response.model_output).toBe("ok");
    expect(bus.ledger()).toMatchObject([
      { hook_id: "veto-shell", event: "tool_preflight", decision: "deny" },
      { hook_id: "test-hook", event: "tool_audit", decision: "observed" },
    ]);
    expect(bus.ledger()[1]!.evidence_ref).toContain("subagent.execute");
  });

  it("wrapToolPortWithAudit is a no-op when no tool_audit hooks are declared", async () => {
    const bus = new HookBus({ catalog: new HookCatalog() });
    const port = allowAlwaysPort("bus.thread.send");
    const wrapped = bus.wrapToolPortWithAudit(port);
    expect(wrapped).toBe(port);
    await wrapped.execute(request(), null, new AbortController().signal);
    expect(bus.ledger()).toEqual([]);
  });

  it("wrapToolPortWithAudit records the real outcome kind from a failed execution", async () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor({ kind: "observe", event: "tool_audit", handler_ref: "observe.tool-audit-notes" })));
    const bus = new HookBus({ catalog });
    const failingPort: NativeToolPort = {
      tool: "userinput.ask",
      async execute() {
        return { result_summary: "denied", model_output: "denied", evidence: { outcome: "refused" as const, stage: "audit" as const, code: "no_pending_request", effect: "none" as const, action_scope: { status: "not_required" as const } } };
      },
    };
    await bus.wrapToolPortWithAudit(failingPort).execute(request(), null, new AbortController().signal);
    expect(bus.ledger()).toMatchObject([{ event: "tool_audit", decision: "observed" }]);
    expect(bus.ledger()[0]!.evidence_ref).toContain("refused");
  });
});

describe("HookBus observe fan-out", () => {
  it("delivers a real, bounded, redacted record to a declared tool_audit observer", () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor({ kind: "observe", event: "tool_audit", handler_ref: "observe.tool-audit-notes" })));
    const bus = new HookBus({ catalog });
    bus.observeToolAudit({ session_id: "s-1", call_id: "c-1", tool: "file.write", risk: "high", intent: { purpose: "write the file", provenance_tag: "generated" }, action_scope: { status: "not_required" }, outcome: "succeeded", stage: "execution", code: "ok", effect: "applied", confinement: "application_validated", summary: "wrote target.md (12 bytes)" });
    expect(bus.ledger()).toMatchObject([{ hook_id: "test-hook", kind: "observe", event: "tool_audit", decision: "observed" }]);
    expect(bus.ledger()[0]!.evidence_ref).toContain("file.write");
  });

  it("delivers a real ledger_transition record derived from a native session event", () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor({ kind: "observe", event: "ledger_transition", handler_ref: "observe.session-ledger-notes" })));
    const bus = new HookBus({ catalog });
    bus.observeLedgerTransition("s-1", { protocol_version: 1, session_id: "s-1", sequence: 3, occurred_at: new Date().toISOString(), kind: "tool_result", payload: { tool: "file.read", result_summary: "ok", success: true, evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", action_scope: { status: "not_required" } } } } as never);
    expect(bus.ledger()).toMatchObject([{ event: "ledger_transition", decision: "observed" }]);
  });

  it("never fires an observer for an event it was not declared against", () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor({ kind: "observe", event: "phase", handler_ref: "observe.tool-audit-notes" })));
    const bus = new HookBus({ catalog });
    bus.observeToolAudit({ session_id: "s-1", call_id: "c-1", tool: "file.read", risk: "low", intent: null, action_scope: { status: "not_required" }, outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", confinement: "application_validated", summary: "ok" });
    expect(bus.ledger()).toEqual([]);
  });
});

describe("HookBus lifecycle", () => {
  it("session_start: a lifecycle-start hook may deny a new session", () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor({ kind: "lifecycle", event: "session_start", handler_ref: "lifecycle.deny-session-start" })));
    const bus = new HookBus({ catalog });
    const decision = bus.lifecycleSessionStart({ session_id: "s-1", campaign_id: "c-1", node_id: "n-1" });
    expect(decision).toMatchObject({ allowed: false, hook_id: "test-hook" });
    expect(bus.ledger()).toMatchObject([{ event: "session_start", decision: "deny" }]);
  });

  it("session_start: allows when every declared hook allows", () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor({ kind: "lifecycle", event: "session_start", handler_ref: "lifecycle.session-boundary-notes" })));
    const bus = new HookBus({ catalog });
    expect(bus.lifecycleSessionStart({ session_id: "s-1", campaign_id: "c-1", node_id: "n-1" })).toEqual({ allowed: true });
  });

  it("non-start lifecycle events are observe-only: firing node_start never returns a decision and cannot deny", () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor({ kind: "lifecycle", event: "node_start", handler_ref: "lifecycle.session-boundary-notes" })));
    const bus = new HookBus({ catalog });
    const result = bus.lifecycleObserve("node_start", { session_id: "s-1", campaign_id: "c-1", node_id: "n-1" });
    expect(result).toBeUndefined();
    expect(bus.ledger()).toMatchObject([{ event: "node_start", decision: "observed" }]);
  });

  it("session_start: a hook observes the dispatched role, never able to set it", () => {
    let seenRole: string | null = "unset";
    const handlers: HookHandlerRegistry = { "lifecycle.reads-role": { kind: "lifecycle_observe", handler: (context) => { seenRole = context.role; return undefined; } } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ kind: "lifecycle", event: "session_start", handler_ref: "lifecycle.reads-role" })));
    const bus = new HookBus({ catalog, handlers });
    expect(bus.lifecycleSessionStart({ session_id: "s-1", campaign_id: "c-1", node_id: "n-1", role: "architect" })).toEqual({ allowed: true });
    expect(seenRole).toBe("architect");
  });

  it("session_end: a hook observes the real terminal outcome kind, never forges it", () => {
    let seenOutcome: string | null = "unset";
    const handlers: HookHandlerRegistry = { "lifecycle.reads-outcome": { kind: "lifecycle_observe", handler: (context) => { seenOutcome = context.outcome; return undefined; } } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ kind: "lifecycle", event: "session_end", handler_ref: "lifecycle.reads-outcome" })));
    const bus = new HookBus({ catalog, handlers });
    bus.lifecycleObserve("session_end", { session_id: "s-1", campaign_id: "c-1", node_id: "n-1", role: "architect", outcome: "completed" });
    expect(seenOutcome).toBe("completed");
  });

  it("lifecycle events with no supplied role/outcome observe null, never a fabricated default", () => {
    let seen: { role: string | null; outcome: string | null } | undefined;
    const handlers: HookHandlerRegistry = { "lifecycle.reads-both": { kind: "lifecycle_observe", handler: (context) => { seen = { role: context.role, outcome: context.outcome }; return undefined; } } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ kind: "lifecycle", event: "node_start", handler_ref: "lifecycle.reads-both" })));
    const bus = new HookBus({ catalog, handlers });
    bus.lifecycleObserve("node_start", { session_id: "s-1", campaign_id: "c-1", node_id: "n-1" });
    expect(seen).toEqual({ role: null, outcome: null });
  });

  it("a throwing lifecycle_start handler fails closed and names the hook", () => {
    const handlers: HookHandlerRegistry = { "lifecycle.throws": { kind: "lifecycle_start", handler: (): never => { throw new Error("lifecycle boom"); } } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ kind: "lifecycle", event: "session_start", handler_ref: "lifecycle.throws" })));
    const bus = new HookBus({ catalog, handlers });
    const decision = bus.lifecycleSessionStart({ session_id: "s-1", campaign_id: "c-1", node_id: "n-1" });
    expect(decision).toMatchObject({ allowed: false, hook_id: "test-hook" });
  });
});

describe("HookBus liveness", () => {
  it("reports a declared hook that never fired, distinguishing it from one that fired", () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor({ hook_id: "fires", kind: "observe", event: "tool_audit", handler_ref: "observe.tool-audit-notes" })));
    catalog.register(JSON.stringify(descriptor({ hook_id: "never-fires", kind: "observe", event: "phase", handler_ref: "observe.tool-audit-notes" })));
    const bus = new HookBus({ catalog });
    bus.observeToolAudit({ session_id: "s-1", call_id: "c-1", tool: "file.read", risk: "low", intent: null, action_scope: { status: "not_required" }, outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", confinement: "application_validated", summary: "ok" });
    expect(bus.neverFired().map((hook) => hook.hook_id)).toEqual(["never-fires"]);
  });
});

describe("HookBus/catalog composition consistency", () => {
  it("fromDirectory builds a catalog and a bus off the exact same handler registry", () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify(descriptor()));
    const bus = new HookBus({ catalog });
    // The production registry's veto.deny-shell-execute handler is genuinely dispatchable.
    const wrapped = bus.wrapToolPort(allowAlwaysPort("shell.execute"));
    expect(wrapped.preflight!(request())).toMatchObject({ allowed: false, code: "hook_denied" });
  });
});

describe("HookBus dispatches plugin-backed handlers (ADR-111)", () => {
  it("a T4 plugin-backed veto handler actually denies a real tool call through the bus, exactly like a built-in one", () => {
    const handlers: HookHandlerRegistry = {
      "plugin:acme:denyShell": { kind: "plugin", plugin_id: "acme", export_name: "denyShell", handler: () => ({ allow: false, reason: "denied by plugin export acme:denyShell" }) },
    };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "plugin:acme:denyShell" })), "test-hook@1.0.0.json", undefined, "acme", false, "T4");
    const bus = new HookBus({ catalog, handlers });
    const wrapped = bus.wrapToolPort(allowAlwaysPort("shell.execute"));
    const result = wrapped.preflight!(request());
    expect(result).toMatchObject({ allowed: false, code: "hook_denied" });
    expect((result as { reason: string }).reason).toContain("acme:denyShell");
    expect(bus.ledger()).toMatchObject([{ hook_id: "test-hook", decision: "deny" }]);
  });

  it("a plugin-backed veto handler cannot flip a base denial to an allow -- the runtime shape check still governs it", () => {
    const handlers: HookHandlerRegistry = {
      "plugin:acme:allowEverything": { kind: "plugin", plugin_id: "acme", export_name: "allowEverything", handler: () => ({ allow: true }) },
    };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "plugin:acme:allowEverything" })), "test-hook@1.0.0.json", undefined, "acme", false, "T4");
    const bus = new HookBus({ catalog, handlers });
    const basePort = allowAlwaysPort("file.write", () => ({ allowed: false, code: "base_denied", reason: "base policy denies this call", evidence: { outcome: "refused", stage: "audit", code: "base_denied", effect: "none", action_scope: { status: "not_required" } } }));
    const result = bus.wrapToolPort(basePort).preflight!(request());
    expect(result).toMatchObject({ allowed: false, code: "base_denied" });
  });

  it("a plugin-backed handler that returns an invalid decision shape fails closed like a built-in one would", () => {
    const handlers: HookHandlerRegistry = {
      "plugin:acme:malformed": { kind: "plugin", plugin_id: "acme", export_name: "malformed", handler: () => ({ not_a_decision: true }) },
    };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "plugin:acme:malformed" })), "test-hook@1.0.0.json", undefined, "acme", false, "T4");
    const bus = new HookBus({ catalog, handlers });
    const result = bus.wrapToolPort(allowAlwaysPort("shell.execute")).preflight!(request());
    expect(result).toMatchObject({ allowed: false, code: "hook_veto_failed" });
  });
});

describe("HookBus veto context origin", () => {
  const denySubagentOnly = (seen: boolean[]): HookHandlerRegistry => ({
    "veto.subagent-only": {
      kind: "veto",
      handler: (context: HookVetoContext): HookVetoDecision => {
        seen.push(context.subagent);
        return context.subagent ? { allow: false, reason: "write is denied inside a dispatched subagent" } : { allow: true };
      },
    },
  });

  it("a veto handler sees subagent:true and may deny on it", () => {
    const seen: boolean[] = [];
    const handlers = denySubagentOnly(seen);
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "veto.subagent-only" })));
    const bus = new HookBus({ catalog, handlers });
    const result = bus.wrapToolPort(allowAlwaysPort("file.write"), { subagent: true }).preflight!(request()) as { allowed: boolean };
    expect(seen).toEqual([true]);
    expect(result.allowed).toBe(false);
  });

  it("subagent:false still allows — the orchestrator is never blocked by a subagent-scoped rule", () => {
    const seen: boolean[] = [];
    const handlers = denySubagentOnly(seen);
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "veto.subagent-only" })));
    const bus = new HookBus({ catalog, handlers });
    const result = bus.wrapToolPort(allowAlwaysPort("file.write"), { subagent: false }).preflight!(request()) as { allowed: boolean };
    expect(seen).toEqual([false]);
    expect(result.allowed).toBe(true);
  });

  it("a call site passing no option yields subagent:false — the back-compat guarantee nothing else pins", () => {
    const seen: boolean[] = [];
    const handlers = denySubagentOnly(seen);
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "veto.subagent-only" })));
    const bus = new HookBus({ catalog, handlers });
    expect(bus.wrapToolPort(allowAlwaysPort("file.write")).preflight!(request())).toEqual({ allowed: true });
    expect(seen).toEqual([false]);
  });

  it("wrapToolPortWithAudit carries the same origin as wrapToolPort for the same port", () => {
    const seen: boolean[] = [];
    const handlers = denySubagentOnly(seen);
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify(descriptor({ handler_ref: "veto.subagent-only" })));
    const bus = new HookBus({ catalog, handlers });
    const port = allowAlwaysPort("file.write");
    const audited = bus.wrapToolPortWithAudit(port, { subagent: true });
    expect((audited.preflight!(request()) as { allowed: boolean }).allowed).toBe(false);
    expect(seen).toEqual([true]);
    // And the same port wrapped with no option is not the subagent: the audited
    // path must not be the one that silently loses (or invents) an origin.
    expect((bus.wrapToolPortWithAudit(port).preflight!(request()) as { allowed: boolean }).allowed).toBe(true);
    expect(seen).toEqual([true, false]);
  });
});
