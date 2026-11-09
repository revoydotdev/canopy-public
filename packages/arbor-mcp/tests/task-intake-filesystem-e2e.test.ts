import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { main } from "../src/cli.js";
import { runTui } from "../src/tui.js";
import { ArborWebUIServer } from "../src/webui.js";
import { createTaskIntakeFilesystemFixture } from "./helpers/task-intake-filesystem-fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => { const value = createTaskIntakeFilesystemFixture(); roots.push(value.root); return value; };
const waitFor = async (predicate: () => boolean, milestone: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${milestone}`); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
const post = (port: number, payload: unknown, headers: Readonly<Record<string, string>> = {}): Promise<void> => new Promise((resolve, reject) => {
  const body = JSON.stringify(payload);
  const request = http.request({ hostname: "127.0.0.1", port, path: "/api/runtime/command", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (response) => {
    response.resume(); response.on("end", resolve);
  });
  request.on("error", reject); request.end(body);
});

describe("plain-language intake adopts verified filesystem bytes end to end", () => {
  it("CLI", async () => {
    const f = fixture(); const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    expect(await main(["task", "Create delivered.txt with the requested content", "--json"], { cwd: f.root, persistence_dir: f.persistence, stdin, stdout, stderr, env: {}, runtime_factory: () => f.runtime })).toBe(0);
    expect(readFileSync(f.targetFile, "utf8")).toBe(f.expectedContent);
    expect(f.runtime.manager.listCampaigns()).toEqual([expect.objectContaining({ halted: true })]);
  });

  it("Web", async () => {
    const f = fixture(); expect((await f.runtime.start()).ok).toBe(true);
    const server = new ArborWebUIServer(f.runtime); await new Promise<void>((resolve) => server.start(0, resolve));
    try {
      await post(server.getPort()!, { kind: "taskcomposer.submit", task: "Create delivered.txt with the requested content", source: "web", idempotency_key: "web-e2e", auto_confirm: true, metadata: { operation_id: "web-e2e", idempotency_key: "web-e2e", correlation_id: "web-e2e", actor_id: "web-operator", requested_at: new Date().toISOString() } }, server.operatorRequestHeaders());
      await waitFor(() => { try { return readFileSync(f.targetFile, "utf8") === f.expectedContent; } catch { return false; } }, "Web adoption");
      expect(f.runtime.manager.listCampaigns()).toEqual([expect.objectContaining({ halted: true })]);
    } finally { await server.stop(); await f.runtime.close(); }
  });

  it("TUI", async () => {
    const f = fixture(); const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    let painted = ""; stdout.on("data", (chunk) => { painted += chunk.toString(); });
    let markInputReady!: () => void;
    const inputReady = new Promise<void>((resolve) => { markInputReady = resolve; });
    const running = runTui({ cwd: f.root, persistence_dir: f.persistence, stdin, stdout, stderr, frame_interval_ms: 5, runtime_factory: () => f.runtime, on_ready: markInputReady });
    await waitFor(() => painted.includes("Ctrl+P palette"), "initial unified Console frame");
    await inputReady;
    // Prove focus through the behavior the operator needs: the next bytes
    // appear in the Console composer. The responsive renderer may elide its
    // secondary key-hint copy at narrow widths, so that copy is not a focus
    // state oracle.
    // The first Console frame already owns input. Empty Enter would blur it.
    stdin.write("Create delivered.txt with the requested content");
    await waitFor(() => painted.includes("Create delivered.txt with the requested content"), "Console task text");
    stdin.write("\n");
    await waitFor(() => { try { return readFileSync(f.targetFile, "utf8") === f.expectedContent; } catch { return false; } }, "TUI verified adoption");

    // Terminal review remains live: once the campaign halts, the manager's
    // active pointer is null, but a durable interview on that completed
    // campaign must still appear and be answerable in the TUI.
    const campaign = f.runtime.manager.listCampaigns()[0];
    if (campaign === undefined) throw new Error("verified TUI adoption did not leave a campaign");
    const snapshot = f.runtime.manager.getCampaignSnapshot(campaign.id);
    if (snapshot === null) throw new Error("verified TUI campaign snapshot disappeared");
    const rootId = snapshot.root_id;
    f.runtime.manager.askForUserInput({
      campaign_id: campaign.id,
      node_id: rootId,
      operation_id: "tui-e2e-terminal-interview",
      question: "Text or JSON output?",
      options: [{ id: "text", text: "Text", is_other: false }, { id: "json", text: "JSON", is_other: false }],
      authority: "lead",
      blocking: "blocking",
      requester_role: "taproot",
      idempotency_key: "tui-e2e-terminal-interview",
      as_of: new Date().toISOString(),
    });
    stdin.write("i");
    await waitFor(() => painted.includes("Text or JSON output?"), "terminal campaign interview in TUI");
    stdin.write("\u0003"); stdin.end(); expect(await running).toBe(0);
    expect(f.runtime.manager.listCampaigns()).toEqual([expect.objectContaining({ halted: true })]);
  // The TUI drives three real asynchronous milestones (first frame, task
  // entry, verified filesystem adoption). Each milestone has a labeled 30 s
  // bound so runner load cannot turn the former 10 s polling deadline into a
  // false product failure, while the complete interaction remains bounded.
  }, 90_000);
});
