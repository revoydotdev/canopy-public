import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { SessionEvent, SessionInspection } from "@arbor/harness";
import { clearRegisteredScreens, type OperatorMetricReceipt } from "@arbor/tui";
import { ArborRuntime } from "../src/runtime.js";
import { runTui } from "../src/tui.js";

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForPaintedText(painted: () => string, needle: string, offset = 0, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (painted().slice(offset).includes(needle)) return;
    await pause(10);
  }
  throw new Error(`timed out waiting for painted text: ${needle}`);
}

describe("native Live Session stream", () => {
  let directory = "";

  afterEach(() => {
    clearRegisteredScreens();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("retains the attached tail, appends cursor reads, emits measurements, and settles its scoped resources", async () => {
    directory = mkdtempSync(join(tmpdir(), "arbor-tui-live-session-"));
    const runtime = new ArborRuntime();
    const controller = new AbortController();
    const events: SessionEvent[] = [{
      protocol_version: "1", session_id: "foi-live", sequence: 1,
      occurred_at: "2026-08-30T00:00:00.000Z", kind: "lifecycle",
      payload: { state: "started", lineage: { kind: "new" }, ephemeral: true },
    }];
    const inspect = (): SessionInspection => ({
      session_id: "foi-live", state: "running", latest_sequence: events.length,
      terminal: null, ephemeral: true,
      policy: { filesystem: "read_only", approvals: "never", tool_allow: [], tool_deny: [], workspace_roots: [directory], max_wall_clock_ms: 10_000, max_events: 500, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
      capabilities: [], lineage: { kind: "new" },
    });
    runtime.nativeSessionRegistry.register({
      session_id: "foi-live", campaign_id: "foi-campaign", node_id: "foi-node",
      operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native",
      profile_id: "testing", controller, inspect,
      events: (after = 0) => events.filter((event) => event.sequence > after),
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let painted = "";
    stdout.on("data", (chunk: Buffer) => { painted += chunk.toString(); });
    const receipts: OperatorMetricReceipt[] = [];
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
    const running = runTui({
      cwd: directory, stdin, stdout, stderr, frame_interval_ms: 5,
      runtime_factory: () => runtime, on_ready: ready,
      on_operator_metric: (receipt) => receipts.push(receipt),
    });

    await readyPromise;
    stdin.write("\u0013");
    await waitForPaintedText(() => painted, "Live sessions (1)");

    stdin.write("?");
    await pause(30);
    stdin.write("Attach Harness Session Tail");
    await pause(30);
    stdin.write("\r");
    await pause(100);
    expect(painted).toContain("Session foi-live: live");

    events.push({
      protocol_version: "1", session_id: "foi-live", sequence: 2,
      occurred_at: "2026-08-30T00:00:01.000Z", kind: "model_text",
      payload: { text: "incremental frontier update", phase: "commentary" },
    });
    await pause(700);
    expect(painted).toContain("2 canonical event(s)");
    expect(receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "renderer_invocation_ms", state: "observed" }),
      expect.objectContaining({ metric: "queue_retention_high_water", state: "observed" }),
    ]));

    const beforeReturn = painted.length;
    stdin.write("\u0013");
    await waitForPaintedText(() => painted, "Live sessions (1)", beforeReturn);

    stdin.end();
    expect(await running).toBe(0);
    expect(receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "resource_settlement", resources: expect.objectContaining({ settlement: "settled" }) }),
    ]));
  }, 10_000);
});
