/**
 * N2 (audit 2026-08-23, canvas rows C-03/C-07/C-08): Web UI surface parity.
 *
 * The Web dashboard historically had no control for interrupting a campaign
 * and no read-only view for governance, communications, output evidence,
 * surveillance findings, the capability catalog, or declarative subagent
 * executions — even though every one of these is a real, `supported:true`
 * catalog query the TUI already renders. This file drives the SAME served
 * client-side JS `webui.ts` sends to the browser (extracted from the real
 * HTTP response and evaluated in a `node:vm` sandbox, the WA-28 pattern
 * `webui.test.ts` already established) against a REAL `ArborWebUIServer`
 * over real HTTP, and checks the rendered HTML reflects real seeded data —
 * never a stub or a hand-constructed projection.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignManager } from "../src/manager.js";
import { ArborWebUIServer } from "../src/webui.js";
import { ArborRuntime } from "../src/runtime.js";
import type { Action, Provenance } from "@arbor/core";

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

const refactorAction: Action = {
  description: "refactor auth module",
  estimated_gain: 50,
  estimated_cost: 10,
  category: "refactor",
  delegate_to: "seed",
};

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" };

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    }).on("error", reject);
  });
}

let operatorHeaders: Record<string, string> = {};
function httpPost(port: number, path: string, payload: unknown, headers: Readonly<Record<string, string>> = operatorHeaders): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: "127.0.0.1", port, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Extracts one top-level `function name(...) {...}` body from the served client script by brace matching. */
function pickFunction(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let i = script.indexOf("{", start);
  for (; i < script.length; i++) {
    if (script[i] === "{") depth++;
    else if (script[i] === "}") { depth--; if (depth === 0) break; }
  }
  return script.slice(start, i + 1);
}

/** A minimal DOM stub: getElementById returns an object whose `.innerHTML`/`.textContent` writes are captured. */
function domStub() {
  const elements = new Map<string, { innerHTML: string; textContent: string; style: Record<string, string> }>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", style: {} });
    return elements.get(id)!;
  };
  return { document: { getElementById: get }, elements };
}

describe("Web UI operator read panels (C-03/C-07/C-08)", () => {
  const manager = new CampaignManager();
  const persistenceDir = mkdtempSync(join(tmpdir(), "arbor-webui-panels-"));
  const runtime = new ArborRuntime({ manager, persistence_dir: persistenceDir });
  let webui: ArborWebUIServer;
  let port: number;
  let script: string;

  beforeAll(async () => {
    manager.startCampaign("camp-panels", "plan.md", rootAction);
    const [childId] = manager.branch("camp-panels", "root", [refactorAction]);
    manager.expandNode("camp-panels", childId, {
      worktree_isolated: true, starting_commit_correct: true, lease_acquired: true,
    });
    manager.recordResult("camp-panels", childId, {
      specialist_output: "done", specialist_agent: "seed", provenance: verifiedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "clean",
      score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 1 },
    });

    webui = new ArborWebUIServer(runtime);
    await new Promise<void>((resolve) => webui.start(0, resolve));
    port = webui.getPort()!;
    operatorHeaders = { ...webui.operatorRequestHeaders() };
    script = (await httpGet(port, "/")).body.split("<script>")[1]!.split("</script>")[0]!;
  });

  afterAll(async () => {
    await webui.stop();
    rmSync(persistenceDir, { recursive: true, force: true });
  });

  it("serves controls/panels for governance, communications, output, surveillance, capabilities, and subagent executions", () => {
    for (const kind of [
      "communication.selection", "communication.history",
      "output.list", "output.descriptor",
      "surveillance.findings", "capability.introspect", "subagent.executions",
      "governance.snapshot", "governance.backlog",
    ]) {
      expect(script, kind).toContain(kind);
    }
    for (const id of [
      "governance-panel", "output-captures-panel", "capability-catalog-panel",
      "surveillance-findings-panel", "communications-panel", "subagent-executions-panel",
      "interrupt-status",
    ]) {
      expect(script, id).toContain(id);
    }
    expect(script).toContain("interruptCampaign");
  });

  // C-03: the node_id-optional whole-campaign interrupt form, driven through
  // the SAME client function the "Interrupt campaign" button's onclick calls
  // — real fetch, real server, real node transition (not the raw HTTP
  // assertion webui.test.ts's own interrupt suite already covers).
  it("interruptCampaign() sweeps a real expanding node to 'interrupted' through the served client control", async () => {
    const localManager = new CampaignManager();
    const localRuntime = new ArborRuntime({ manager: localManager });
    const localWebui = new ArborWebUIServer(localRuntime);
    await new Promise<void>((resolve) => localWebui.start(0, resolve));
    const localPort = localWebui.getPort()!;
    try {
      localManager.startCampaign("camp-interrupt-client", "plan.md", rootAction);
      const [childId] = localManager.branch("camp-interrupt-client", "root", [refactorAction]);
      localManager.expandNode("camp-interrupt-client", childId, {
        worktree_isolated: true, starting_commit_correct: true, lease_acquired: true,
      });
      expect(localManager.getNodeInfo("camp-interrupt-client", childId)?.state).toBe("expanding");

      const body = (await httpGet(localPort, "/")).body;
      const localScript = body.split("<script>")[1]!.split("</script>")[0]!;
      const escLine = localScript.split("\n").find((line) => line.startsWith("const esc = "))!;
      const sessionArgLine = localScript.split("\n").find((line) => line.startsWith("const sessionArg = "))!;
      const { document, elements } = domStub();
      const sandbox = {
        window: { confirm: () => true },
        document,
        fetch: (...args: Parameters<typeof fetch>) => fetch(`http://127.0.0.1:${localPort}${args[0]}`, { ...args[1], headers: { ...Object.fromEntries(new Headers(args[1]?.headers).entries()), ...localWebui.operatorRequestHeaders() } }),
        encodeURIComponent, decodeURIComponent, JSON, String, Array, Promise, console,
        refreshSelectedCampaignDetail: () => {},
      };
      const source = [escLine, sessionArgLine, pickFunction(localScript, "interruptStatus"), pickFunction(localScript, "interruptCampaign"),
        "interruptCampaign('camp-interrupt-client');"].join("\n");
      vm.createContext(sandbox);
      vm.runInContext(source, sandbox);
      // interruptCampaign() dispatches a real fetch() promise; give the event
      // loop a turn to let the real HTTP round-trip and server-side interrupt
      // complete before asserting the node's durable state.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(localManager.getNodeInfo("camp-interrupt-client", childId)?.state).toBe("interrupted");
      expect(elements.get("interrupt-status")?.textContent).toContain("Interrupt accepted");
    } finally {
      await localWebui.stop();
    }
  });

  // C-08: governance snapshot + backlog rendered read-only from the real
  // decisions/ corpus (the router defaults `repo_root` to `process.cwd()`,
  // which in this test process IS the repo root, so this is a real read of
  // this repository's own governance state — never a stub).
  it("renderGovernancePanel() shows real decision-status/backlog fields from the live decisions/ corpus", async () => {
    const snapshot = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "governance.snapshot" })).body);
    const backlog = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "governance.backlog" })).body);
    expect(snapshot.ok).toBe(true);
    expect(backlog.ok).toBe(true);

    const escLine = script.split("\n").find((line) => line.startsWith("const esc = "))!;
    const humanizeLine = script.split("\n").find((line) => line.startsWith("const humanizeEnum = "))!;
    const { document, elements } = domStub();
    const sandbox = { document, JSON, String, Array, Object, console };
    const source = [escLine, humanizeLine, pickFunction(script, "renderGovernancePanel"),
      `renderGovernancePanel(${JSON.stringify(snapshot.value)}, ${JSON.stringify(backlog.value)});`].join("\n");
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const rendered = elements.get("governance-panel")!.innerHTML;
    expect(rendered).toContain("Governance");
    expect(rendered).toContain("Governance backlog");
    expect(rendered).toContain(String(backlog.value.backlog.total_records_scanned));
    if (snapshot.value.legacy_classification?.total !== undefined) {
      expect(rendered).toContain(String(snapshot.value.legacy_classification.total));
    }
  });

  it("renderCapabilityCatalog() lists real catalog entries, including a well-known supported kind", async () => {
    const catalog = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "capability.introspect" })).body);
    expect(catalog.ok).toBe(true);
    expect(Array.isArray(catalog.value.catalog)).toBe(true);
    expect(catalog.value.catalog.length).toBeGreaterThan(0);

    const escLine = script.split("\n").find((line) => line.startsWith("const esc = "))!;
    const { document, elements } = domStub();
    const sandbox = { document, JSON, String, Array, console };
    const source = [escLine, pickFunction(script, "renderCapabilityCatalog"),
      `renderCapabilityCatalog(${JSON.stringify(catalog.value)});`].join("\n");
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const rendered = elements.get("capability-catalog-panel")!.innerHTML;
    expect(rendered).toContain("campaign.start");
    expect(rendered).toContain("Capability catalog ("+catalog.value.catalog.length+")");
  });

  it("renderOutputCaptures()/loadOutputDescriptor() show a real captured output evidence record", async () => {
    const capture = JSON.parse((await httpPost(port, "/api/runtime/command", {
      kind: "output.capture",
      artifact: { campaign_id: "camp-panels", node_id: "root", media_type: "text/plain", stream: "stdout", provenance: verifiedProv },
      content: "real captured stdout for the panel test",
      metadata: { operation_id: "op-output-panel", idempotency_key: "op-output-panel", correlation_id: "op-output-panel", actor_id: "test", requested_at: "2026-08-23T00:00:00.000Z" },
    })).body);
    expect(capture.ok).toBe(true);
    expect(capture.value.accepted).toBe(true);

    const list = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "output.list" })).body);
    expect(list.ok).toBe(true);
    expect(Array.isArray(list.value)).toBe(true);
    expect(list.value.length).toBeGreaterThan(0);

    const escLine = script.split("\n").find((line) => line.startsWith("const esc = "))!;
    const sessionArgLine = script.split("\n").find((line) => line.startsWith("const sessionArg = "))!;
    const { document, elements } = domStub();
    const sandbox = {
      document, JSON, String, Array, Promise, console,
      fetch: (...args: Parameters<typeof fetch>) => fetch(`http://127.0.0.1:${port}${args[0]}`, { ...args[1], headers: { ...Object.fromEntries(new Headers(args[1]?.headers).entries()), ...operatorHeaders } }),
      runtimeQuery: (kind: string, params: Record<string, unknown> = {}) =>
        fetch(`http://127.0.0.1:${port}/api/runtime/query`, { method: "POST", headers: { "content-type": "application/json", ...operatorHeaders }, body: JSON.stringify({ kind, ...params }) })
          .then((r) => r.json() as Promise<{ ok: boolean; value: unknown; error?: { summary?: string } }>)
          .then((r) => { if (!r.ok) throw new Error(r.error?.summary ?? "query failed"); return r.value; }),
    };
    const source = [escLine, sessionArgLine, pickFunction(script, "renderOutputCaptures"), pickFunction(script, "loadOutputDescriptor"),
      `renderOutputCaptures(${JSON.stringify(list.value)});`].join("\n");
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const rendered = elements.get("output-captures-panel")!.innerHTML;
    expect(rendered).toContain("stdout");
    expect(rendered).toContain("view</button>");

    const evidenceId = list.value.find((entry: { status: string }) => entry.status === "ok").record.id;
    vm.runInContext(`loadOutputDescriptor(${JSON.stringify(evidenceId)});`, sandbox);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const descriptorHtml = elements.get("output-descriptor-view")!.innerHTML;
    expect(descriptorHtml).toContain(evidenceId);
    expect(descriptorHtml).toContain("text/plain");
  });

  it("renderSurveillanceFindings() reflects a real scan result for the seeded campaign", async () => {
    const scan = JSON.parse((await httpPost(port, "/api/runtime/command", {
      kind: "surveillance.scan", campaign_id: "camp-panels",
      metadata: { operation_id: "op-surveillance-panel", idempotency_key: "op-surveillance-panel", correlation_id: "op-surveillance-panel", actor_id: "test", requested_at: "2026-08-23T00:00:00.000Z" },
    })).body);
    expect(scan.ok).toBe(true);

    const findings = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "surveillance.findings", campaign_id: "camp-panels", limit: 200 })).body);
    expect(findings.ok).toBe(true);
    expect(Array.isArray(findings.value.findings)).toBe(true);

    const escLine = script.split("\n").find((line) => line.startsWith("const esc = "))!;
    const { document, elements } = domStub();
    const sandbox = { document, JSON, String, Array, console };
    const source = [escLine, pickFunction(script, "renderSurveillanceFindings"),
      `renderSurveillanceFindings(${JSON.stringify(findings.value)});`].join("\n");
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const rendered = elements.get("surveillance-findings-panel")!.innerHTML;
    expect(rendered).toContain("Surveillance findings ("+findings.value.findings.length+")");
  });

  it("renderCommunications() shows a real node_communication record from the durable ledger", async () => {
    manager.recordNodeCommunication({
      campaign_id: "camp-panels", node_id: "root", author_node_id: "crown", recipient_node_id: "root",
      other_recipient_node_ids: [], kind: "steer",
      payload: { content: "preserve this operator constraint", provenance: { tag: "claimed", claimant: "operator" } },
      capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-23T00:00:00.000Z",
      correlation_id: "panel-test", idempotency_key: "panel-test-comm-1", acknowledges_communication_id: null,
      retracts_communication_id: null,
    });
    const selection = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "communication.selection", campaign_id: "camp-panels", node_id: "root", limit: 50 })).body);
    const history = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "communication.history", campaign_id: "camp-panels", node_id: "root", limit: 50 })).body);
    expect(selection.ok).toBe(true);
    expect(history.ok).toBe(true);
    expect(history.value.communications.length).toBeGreaterThan(0);

    const escLine = script.split("\n").find((line) => line.startsWith("const esc = "))!;
    const { document, elements } = domStub();
    const sandbox = { document, JSON, String, Array, console };
    const source = [escLine, pickFunction(script, "renderCommunications"),
      `renderCommunications(${JSON.stringify(selection.value)}, ${JSON.stringify(history.value)});`].join("\n");
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const rendered = elements.get("communications-panel")!.innerHTML;
    expect(rendered).toContain("steer");
    expect(rendered).toContain("crown");
  });

  it("renderSubagentExecutions() shows a real declarative subagent execution record", async () => {
    // requireMessageRanges (governed-context-service.ts) validates the
    // referenced range against a REAL recorded node_communication — it is
    // not a free-form id. Record one first so the descriptor revision has
    // durable evidence to point at, the same way a real caller would.
    const commId = manager.recordNodeCommunication({
      campaign_id: "camp-panels", node_id: "root", author_node_id: "crown", recipient_node_id: "root",
      other_recipient_node_ids: [], kind: "steer",
      payload: { content: "context backing the subagent descriptor", provenance: { tag: "claimed", claimant: "operator" } },
      capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-23T00:00:00.000Z",
      correlation_id: "panel-subagent", idempotency_key: "panel-subagent-comm-1", acknowledges_communication_id: null,
      retracts_communication_id: null, conversation_id: "conv-panel-subagent",
    });
    const descriptor = runtime.governedContext.proposeRevision({
      id: "panel-descriptor", campaign_id: "camp-panels", task_id: "task-panels", component: "subagent_descriptor",
      patch: { descriptor: { role: "seed", objective: "inspect", allowed_context_artifact_ids: [], allowed_message_ranges: [], max_children: 1, recursive_delegation: false } },
      source_event_ids: ["event-panels"],
      source_message_ranges: [{ context_id: "conv-panel-subagent", thread_id: "root", start_communication_id: commId, end_communication_id: commId, start_byte: 0, end_byte: 4 }],
      expected_benefit: "delegate a bounded inspection", proposed_by: "seed", provenance: { tag: "claimed", claimant: "seed" },
      created_at: "2026-08-23T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z",
    });
    runtime.governedContext.approveRevision(descriptor.id, "lenticel");
    runtime.governedContext.requestSubagentExecution({
      id: "panel-execution", campaign_id: "camp-panels", parent_node_id: "root", revision_id: descriptor.id,
      requested_by: "operator", child_session_id: "child-panels", worktree_node_id: "worktree-panels",
    });

    const executions = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "subagent.executions", campaign_id: "camp-panels" })).body);
    expect(executions.ok).toBe(true);
    expect(Array.isArray(executions.value)).toBe(true);
    expect(executions.value.length).toBeGreaterThan(0);

    const escLine = script.split("\n").find((line) => line.startsWith("const esc = "))!;
    const humanizeLine = script.split("\n").find((line) => line.startsWith("const humanizeEnum = "))!;
    const { document, elements } = domStub();
    const sandbox = { document, JSON, String, Array, console };
    const source = [escLine, humanizeLine, pickFunction(script, "renderSubagentExecutions"),
      `renderSubagentExecutions(${JSON.stringify(executions.value)});`].join("\n");
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const rendered = elements.get("subagent-executions-panel")!.innerHTML;
    expect(rendered).toContain("panel-execution");
    expect(rendered).toContain("requested");
  });
});
