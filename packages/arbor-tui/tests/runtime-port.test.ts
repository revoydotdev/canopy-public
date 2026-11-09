import { describe, it, expect } from "vitest";
import { HeadlessHarness, type HeadlessDependencies } from "../src/headless.js";
import { initialModel } from "../src/model.js";
import type { AppModel } from "../src/types.js";
import type { RuntimePort, RuntimeQueryRequest, RuntimeCommandRequest } from "../src/runtime-port.js";
import { registerScreen, clearRegisteredScreens, getScreen, availableScreens, type ScreenModule } from "../src/screens/screen.js";

const inertRuntime: RuntimePort = {
  command: async () => ({ ok: false, error: { code: "unavailable", summary: "test runtime is inactive" }, capability: null }),
  query: async () => ({ ok: false, error: { code: "unavailable", summary: "test runtime is inactive" }, capability: null }),
  activeOperationCount: () => 0,
};

function makeHarness(overrides: Partial<HeadlessDependencies> = {}): { harness: HeadlessHarness; model: () => AppModel; dispatched: string[] } {
  const dispatched: string[] = [];
  const client = {
    connect: async (target: string) => { dispatched.push(`connect:${target}`); },
    disconnect: async () => { dispatched.push("disconnect"); },
    requestSnapshot: async (afterCursor: string | null) => { dispatched.push(`snapshot:${afterCursor}`); },
    close: async () => { dispatched.push("close"); },
    interruptCampaign: async () => { dispatched.push("interrupt"); },
  };
  const h = new HeadlessHarness({
    client,
    terminal: { restore: async () => { dispatched.push("restore"); } },
    clock: { now: () => 1000 },
    telemetrySource: { fetch: async () => ({ campaign_id: "c1", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) },
    runtime: inertRuntime,
    ...overrides,
  });
  return { harness: h, model: () => h.model, dispatched };
}

describe("screen registry", () => {
  it("registers and rejects unknown screens", () => {
    clearRegisteredScreens();
    registerScreen({ id: "campaigns", title: "Campaigns", required_capabilities: ["campaign.read"], surface: { commands: [], queries: ["campaign.list"] }, render: () => [], project: () => ({ screen: "campaigns", rows: [], columns: [], variant: "empty" }) });
    expect(getScreen("campaigns").id).toBe("campaigns");
    expect(() => registerScreen({ id: "campaigns", title: "dup", required_capabilities: ["x"], surface: { commands: [], queries: [] }, render: () => [], project: () => ({ screen: "campaigns", rows: [], columns: [], variant: "empty" }) })).toThrow(/already registered/);
    expect(() => getScreen("tree" as never)).toThrow(/not registered/);
  });

  it("filters screens by granted capabilities and validates required caps", () => {
    clearRegisteredScreens();
    const mod: ScreenModule = { id: "tree", title: "Tree", required_capabilities: ["tree.read"], surface: { commands: ["tree.prune"], queries: ["campaign.tree"] }, render: () => [], project: () => ({ screen: "tree", rows: [], columns: [], variant: "empty" }) };
    registerScreen(mod);
    expect(availableScreens(new Set(["tree.read"])).length).toBe(1);
    expect(availableScreens(new Set([])).length).toBe(0);
    expect(() => registerScreen({ ...mod, required_capabilities: [] })).toThrow(/required capabilities/);
  });
});

describe("runtime port wiring through the headless harness", () => {
  it("dispatches commands through the injected runtime port", async () => {
    clearRegisteredScreens();
    const commands: RuntimeCommandRequest[] = [];
    const runtime: RuntimePort = {
      command: async (request) => { commands.push(request); return { ok: true, value: { accepted: true, operation_id: request.metadata.operation_id }, capability: "campaign.write" }; },
      query: async () => ({ ok: true, value: [], capability: "campaign.read" }),
      activeOperationCount: () => 1,
    };
    const { harness: h1 } = makeHarness({ runtime });
    // "issue_command" was a generic dispatch_command passthrough nothing in
    // production ever constructed (DEF-02) -- deleted. Real command dispatch
    // is screen-scoped; the tree screen's `branch_selected_node` builds and
    // dispatches a real RuntimeCommandRequest off the selected node, so it
    // exercises the identical runtime.command plumbing this test cares about.
    await h1.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tree" }, at: 999 });
    await h1.dispatch({ type: "ui_intent", intent: { type: "select_row_identity", screen: "tree", selection: { id: "n1", context: { campaign_id: "c1" } } }, at: 999 });
    await h1.dispatch({ type: "ui_intent", intent: { type: "branch_selected_node" }, at: 1000 });
    expect(commands).toHaveLength(1);
    expect(commands[0].kind).toBe("tree.branch");
  });

  it("routes query results into the model and surfaces transport errors as diagnostics", async () => {
    clearRegisteredScreens();
    const runtime: RuntimePort = {
      command: async () => ({ ok: true, value: { accepted: true, operation_id: "o" }, capability: "x" }),
      query: async (request: RuntimeQueryRequest) => {
        if (request.params.fail) return { ok: false, error: { code: "unavailable", summary: "no backend" }, capability: null };
        return { ok: true, value: [{ id: "n1" }], capability: "tree.read" };
      },
      activeOperationCount: () => 0,
    };
    const { harness, model } = makeHarness({ runtime });
    await harness.dispatch({ type: "command_dispatched", request: { kind: "tree.prune", metadata: { operation_id: "o2", idempotency_key: "k2" }, params: {} }, at: 1000 });
    await harness.dispatch({ type: "query_results", queryId: "q1", screen: "campaigns", value: [{ id: "n1" }] });
    expect(model().latestQueryId).toBe("q1");
    expect(model().latestQueryValue).toEqual([{ id: "n1" }]);
    await harness.dispatch({ type: "error_raised", error: { code: "unavailable", message: "no backend", source: "runtime-query", recoverable: true, fingerprint: "q1" }, at: 1000 });
    expect(model().diagnostics.some((d) => d.fingerprint === "q1")).toBe(true);
  });

  it("changes the focused screen through a ui_intent", async () => {
    clearRegisteredScreens();
    const { harness: h2, model } = makeHarness();
    expect(model().screen).toBe("console");
    await h2.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tree" }, at: 1000 });
    expect(model().screen).toBe("tree");
  });

  it("keeps initial model sane without a runtime port", () => {
    const m = initialModel();
    expect(m.screen).toBe("console");
    expect(m.grantedCapabilities.size).toBe(0);
    expect(m.latestQueryId).toBeNull();
  });
});
