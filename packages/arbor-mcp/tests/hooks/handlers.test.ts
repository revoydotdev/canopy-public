import { describe, expect, it } from "vitest";
import { HOOK_HANDLERS } from "../../src/hooks/handlers.js";
import type { HookLifecycleContext, HookObserveContext, HookVetoContext } from "../../src/hooks/contracts.js";

const vetoContext = (tool: string): HookVetoContext => Object.freeze({ event: "tool_preflight", hook_id: "h", version: "1.0.0", session_id: "s", call_id: "c", tool, subagent: false, tool_input: Object.freeze({ command: "", path: "", added_text: "", removed_text: "" }) });
const observeContext = (summary: string): HookObserveContext => Object.freeze({ event: "tool_audit", hook_id: "h", version: "1.0.0", session_id: "s", summary, detail: {} });
const lifecycleContext = (event: HookLifecycleContext["event"]): HookLifecycleContext => Object.freeze({ event, hook_id: "h", version: "1.0.0", session_id: "s", campaign_id: "c", node_id: "n", role: null, outcome: null });

describe("production hook handler registry", () => {
  it("veto.deny-shell-execute denies only shell.execute", () => {
    const entry = HOOK_HANDLERS["veto.deny-shell-execute"]!;
    if (entry.kind !== "veto") throw new Error("expected a veto handler");
    expect(entry.handler(vetoContext("shell.execute"))).toMatchObject({ allow: false });
    expect(entry.handler(vetoContext("file.read"))).toEqual({ allow: true });
  });

  it("veto.deny-high-risk-repository-tool denies only tools the closed risk map marks high", () => {
    const entry = HOOK_HANDLERS["veto.deny-high-risk-repository-tool"]!;
    if (entry.kind !== "veto") throw new Error("expected a veto handler");
    expect(entry.handler(vetoContext("file.write"))).toMatchObject({ allow: false });
    expect(entry.handler(vetoContext("shell.execute"))).toMatchObject({ allow: false });
    expect(entry.handler(vetoContext("file.read"))).toEqual({ allow: true });
    expect(entry.handler(vetoContext("mcp.fs.read"))).toEqual({ allow: true });
  });

  it("observe.tool-audit-notes echoes the bounded summary it was given, nothing more", () => {
    const entry = HOOK_HANDLERS["observe.tool-audit-notes"]!;
    if (entry.kind !== "observe") throw new Error("expected an observe handler");
    expect(entry.handler(observeContext("wrote file.txt"))).toEqual({ note: "wrote file.txt" });
  });

  it("lifecycle.deny-session-start always denies", () => {
    const entry = HOOK_HANDLERS["lifecycle.deny-session-start"]!;
    if (entry.kind !== "lifecycle_start") throw new Error("expected a lifecycle_start handler");
    expect(entry.handler(lifecycleContext("session_start"))).toMatchObject({ allow: false });
  });

  it("lifecycle.session-boundary-notes is a pure observation across events", () => {
    const entry = HOOK_HANDLERS["lifecycle.session-boundary-notes"]!;
    if (entry.kind !== "lifecycle_observe") throw new Error("expected a lifecycle_observe handler");
    expect(entry.handler(lifecycleContext("node_end"))).toEqual({ note: "node_end campaign=c" });
  });
});
