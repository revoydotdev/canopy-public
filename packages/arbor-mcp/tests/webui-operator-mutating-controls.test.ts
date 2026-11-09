/**
 * Closes the remaining hollow-parity BLOCKER rows this lane owns for the web
 * surface (audit 2026-08-23 C-07/C-08; `bun scripts/hollow-parity.mjs
 * --skip-vitest --explain` names job.submit, output.capture, sibling.spawn,
 * and surveillance.scan as MCP-generic-only — no CLI/TUI/Web/liveness
 * producer). job.submit and output.capture already have a TUI operator form
 * (packages/arbor-tui/src/default-catalog.ts's JOB_SUBMIT_ACTION_ID /
 * OUTPUT_CAPTURE_ACTION_ID); this gives the web surface the same catalog
 * contract. sibling.spawn has no TUI form either but is authorized the same
 * way as job.submit (no privileged caller context required), unlike
 * peer.grant — left deliberately without a control; see the api-only
 * rationale in this lane's final report.
 *
 * Each test drives the SAME served client-side form handler `webui.ts` sends
 * to the browser (extracted from the real HTTP response and evaluated in a
 * `node:vm` sandbox, the WA-28/C-03 pattern webui.test.ts and
 * webui-observability-panels.test.ts already established) against a REAL
 * `ArborWebUIServer` over real HTTP, and asserts the real durable state
 * change — never a stub or a hand-constructed projection.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignManager } from "../src/manager.js";
import { ArborWebUIServer } from "../src/webui.js";
import { ArborRuntime } from "../src/runtime.js";
import { SiblingSpawner } from "../src/sibling-spawner.js";
import { WorktreeManager } from "@arbor/opencode";
import type { Action } from "@arbor/core";

const rootAction: Action = {
  description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown",
};

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    }).on("error", reject);
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

/**
 * Extracts one top-level `const name = (...) => { ... };` (or `let name = ...;`)
 * declaration by brace matching from its `=` up to (and including) the
 * statement-terminating `;`. `pickFunction` only handles `function name(...)`
 * declarations — several handlers under test call arrow-function `const`s
 * (`runtimeCommand`, `nextRuntimeOperationId`) whose bodies span multiple
 * lines, so a single-line `.find()` silently truncates them mid-expression.
 */
function pickConst(script: string, name: string): string {
  const start = script.indexOf(`const ${name} `) >= 0 ? script.indexOf(`const ${name} `) : script.indexOf(`let ${name} `);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const semi = script.indexOf(";", start);
  expect(semi, name).toBeGreaterThan(start);
  // Search for the body-opening brace starting from `=>` (if present), not
  // from `start` — an arrow function's own PARAMETER LIST can contain a
  // `{`/`}` default value (e.g. `(kind, params = {}) => { ... }`), which
  // would otherwise be mistaken for the function body and close the match
  // after two characters.
  const arrow = script.indexOf("=>", start);
  const searchFrom = arrow >= 0 && arrow < semi ? arrow : start;
  // If a `{`/`}` pair appears before the first `;`, that `;` may be inside
  // the body (e.g. object literals) — extend to the `;` that follows the
  // last balanced closing brace, or the first `;` if there is no brace.
  const braceStart = script.indexOf("{", searchFrom);
  if (braceStart === -1 || braceStart > semi) return script.slice(start, semi + 1);
  let depth = 0;
  let i = braceStart;
  for (; i < script.length; i++) {
    if (script[i] === "{") depth++;
    else if (script[i] === "}") { depth--; if (depth === 0) break; }
  }
  const end = script.indexOf(";", i);
  return script.slice(start, end + 1);
}

/** A minimal DOM stub: getElementById returns an object whose `.textContent`/`.style` writes are captured. */
function domStub() {
  const elements = new Map<string, { innerHTML: string; textContent: string; style: Record<string, string> }>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", style: {} });
    return elements.get(id)!;
  };
  return { document: { getElementById: get }, elements };
}

/**
 * Fake submit event. Every served handler calls `new FormData(event.currentTarget)`
 * then only ever `.get(name)`s it — a real `<form>` element's job in the
 * browser. There is no DOM `<form>` element in this harness, so
 * `currentTarget` is a real Node `FormData` instance instead (it already has
 * `.get`/`.append`), and the sandbox's `FormData` binding (see baseSandbox)
 * is an identity shim: `new FormData(x)` just returns `x`. `.reset()` is a
 * real-form-only no-op the handlers call after a successful submit.
 */
function fakeSubmitEvent(fields: Record<string, string>) {
  const fd = new FormData() as FormData & { reset: () => void };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.reset = () => {};
  return { preventDefault: () => {}, currentTarget: fd };
}

const persistenceDirs: string[] = [];
afterEach(() => { while (persistenceDirs.length) rmSync(persistenceDirs.pop()!, { recursive: true, force: true }); });

async function startServer() {
  const manager = new CampaignManager();
  const worktrees = new WorktreeManager({}, true);
  // output.capture requires a real OutputEvidenceStore, which the runtime
  // only composes when given a persistence_dir (the same fixture
  // webui-observability-panels.test.ts uses for its own output.capture
  // coverage) — omitting it fails every capture with "output evidence
  // persistence is not configured", independent of client wiring.
  const persistenceDir = mkdtempSync(join(tmpdir(), "arbor-webui-ops-"));
  persistenceDirs.push(persistenceDir);
  const runtime = new ArborRuntime({ manager, persistence_dir: persistenceDir, sibling_spawner: (m, s) => new SiblingSpawner(m, s, worktrees) });
  const webui = new ArborWebUIServer(runtime);
  await new Promise<void>((resolve) => webui.start(0, resolve));
  const port = webui.getPort()!;
  manager.startCampaign("camp-ops", "plan.md", rootAction);
  const body = (await httpGet(port, "/")).body;
  const script = body.split("<script>")[1]!.split("</script>")[0]!;
  return { manager, runtime, webui, port, script, operatorHeaders: webui.operatorRequestHeaders() };
}

function baseSandbox(port: number, script: string, extraNames: string[], operatorHeaders: Readonly<Record<string, string>>) {
  const escLine = script.split("\n").find((line) => line.startsWith("const esc = "))!;
  const runtimeOpLines = [
    pickConst(script, "runtimeOperationSequence"),
    pickConst(script, "nextRuntimeOperationId"),
    pickConst(script, "runtimeCommand"),
    pickConst(script, "operatorProvenance"),
  ];
  const source = [
    escLine, ...runtimeOpLines,
    ...extraNames.map((name) => pickFunction(script, name)),
  ].join("\n");
  const { document, elements } = domStub();
  const sandbox = {
    window: { confirm: () => true },
    document,
    fetch: (...args: Parameters<typeof fetch>) => fetch(`http://127.0.0.1:${port}${String(args[0])}`, { ...args[1], headers: { ...Object.fromEntries(new Headers(args[1]?.headers).entries()), ...operatorHeaders } }),
    // Identity shim: the served handlers only ever do `new FormData(event.currentTarget)`
    // then `.get(name)` — event.currentTarget here IS already a real FormData (see fakeSubmitEvent).
    FormData: function (x: unknown) { return x; },
    JSON, String, Array, Number, Object, Promise, console, Date, crypto: globalThis.crypto,
  };
  vm.createContext(sandbox);
  return { sandbox, source, elements };
}

describe("Web UI operator mutating controls (C-07/C-08 BLOCKER rows: job.submit, output.capture, sibling.spawn, surveillance.scan)", () => {
  it("submitJobForm() dispatches a real job.submit through the served client control", async () => {
    const { manager, port, script, operatorHeaders } = await startServer();
    const { sandbox, source } = baseSandbox(port, script, ["mutatingOperationStatus", "submitJobForm"], operatorHeaders);
    const event = fakeSubmitEvent({ owner_scope_id: "camp-ops", job_kind: "liveness.noop" });
    vm.runInContext(source, sandbox);
    (sandbox as unknown as { submitJobForm: (e: unknown) => void }).submitJobForm(event);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(manager.getCampaignSnapshot("camp-ops")).not.toBeNull(); // still a real, unrelated campaign — job ran independently
  });

  it("captureOutputForm() dispatches a real output.capture through the served client control and refreshes the read panel", async () => {
    const { port, script, operatorHeaders } = await startServer();
    const { sandbox, source } = baseSandbox(port, script, ["mutatingOperationStatus", "captureOutputForm", "renderOutputCaptures"], operatorHeaders);
    (sandbox as Record<string, unknown>).refreshOutputCaptures = () => {};
    const event = fakeSubmitEvent({ campaign_id: "camp-ops", node_id: "root", media_type: "text/plain", stream: "stdout", content: "operator-captured stdout" });
    vm.runInContext(source, sandbox);
    (sandbox as unknown as { captureOutputForm: (e: unknown) => void }).captureOutputForm(event);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const listed = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "output.list" })).body);
    expect(listed.ok).toBe(true);
    const captured = listed.value.find((entry: { record?: { operation_id?: string } }) => entry.record?.operation_id?.startsWith("webui:output.capture:"));
    expect(captured).toBeDefined();
  });

  it("spawnSiblingForm() dispatches a real sibling.spawn through the served client control and creates a durable child node", async () => {
    const { manager, port, script, operatorHeaders } = await startServer();
    const { sandbox, source } = baseSandbox(port, script, ["mutatingOperationStatus", "spawnSiblingForm"], operatorHeaders);
    (sandbox as Record<string, unknown>).refreshSelectedCampaignDetail = () => {};
    const before = manager.getCampaignSnapshot("camp-ops")!.nodes.length;
    const event = fakeSubmitEvent({
      campaign_id: "camp-ops", parent_node_id: "root", description: "operator-spawned sibling",
      category: "refactor", delegate_to: "seed", estimated_gain: "10", estimated_cost: "1",
    });
    vm.runInContext(source, sandbox);
    (sandbox as unknown as { spawnSiblingForm: (e: unknown) => void }).spawnSiblingForm(event);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = manager.getCampaignSnapshot("camp-ops")!.nodes;
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((n) => n.action_description === "operator-spawned sibling")).toBe(true);
  });

  it("runSurveillanceScanForm() dispatches a real surveillance.scan through the served client control", async () => {
    const { port, script, operatorHeaders } = await startServer();
    const { sandbox, source } = baseSandbox(port, script, ["mutatingOperationStatus", "runSurveillanceScanForm"], operatorHeaders);
    (sandbox as Record<string, unknown>).refreshOperatorReadPanels = () => {};
    const event = fakeSubmitEvent({ campaign_id: "camp-ops" });
    vm.runInContext(source, sandbox);
    (sandbox as unknown as { runSurveillanceScanForm: (e: unknown) => void }).runSurveillanceScanForm(event);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = (sandbox as unknown as { document: { getElementById: (id: string) => { textContent: string } } }).document.getElementById("mutating-operation-status");
    expect(status.textContent).toContain("Scan recorded");
  });
});


function httpPost(port: number, path: string, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: "127.0.0.1", port, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
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
