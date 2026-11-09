/**
 * Native-only FOI integration proof.
 *
 * The model ports below are deterministic in-process simulations: they make
 * no provider, connector, network, or credential call.  Everything after the
 * model boundary is production code: NativeAgentExecutor/NativeSessionEngine,
 * the live registry and durable journal, RuntimeCatalogRouter/RuntimePortAdapter,
 * and the launchable runTui composition.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { CapabilitySupport, NativeModelPort } from "@arbor/harness";
import { clearRegisteredScreens, type OperatorMetricReceipt } from "@arbor/tui";
import { NativeAgentExecutor } from "../src/native-agent-executor.js";
import { captureFOINativeRuntimeScenario } from "../src/foi-native-runtime-capture.js";
import { HarnessSessionJournal } from "../src/harness-session-journal.js";
import { ArborRuntime } from "../src/runtime.js";
import { runTui } from "../src/tui.js";

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting",
].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "foi-native-runtime-roundtrip", observed_at: "2026-08-30T00:00:00.000Z", detail: "deterministic in-process model simulation" },
})) as readonly CapabilitySupport[];

const directories: string[] = [];

afterEach(() => {
  clearRegisteredScreens();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function journalCallbacks(journal: HarnessSessionJournal): Pick<ConstructorParameters<typeof NativeAgentExecutor>[0], "on_session_started" | "on_session_event" | "on_session"> {
  return {
    on_session_started(record) {
      const accepted = journal.recordStarted({
        session_id: record.inspection.session_id,
        campaign_id: record.campaign_id,
        node_id: record.node_id,
        operation: record.operation,
        connector_id: record.connector_id,
        execution_kind: record.execution_kind,
        profile_id: record.profile_id,
        state: record.inspection.state,
        latest_sequence: record.inspection.latest_sequence,
        lineage: record.inspection.lineage,
      });
      if (!accepted) throw new Error("native session admission was not journaled");
    },
    on_session_event(record) {
      if (!journal.recordEvent(record.event)) throw new Error("native session event was not journaled");
    },
    on_session(record) {
      if (!journal.record(record)) throw new Error("native session completion was not journaled");
    },
  };
}

async function attachLiveSession(stdin: PassThrough, painted: () => string, sessionId: string): Promise<void> {
  // Ctrl+S opens the production Live Session screen. The Help palette action
  // then attaches its selected live row through the normal RuntimePort query.
  stdin.write("\u0013");
  await waitFor(() => painted().includes("Live sessions (1)"), "Live Session list was not rendered");
  stdin.write("?");
  await waitFor(() => painted().includes("Command palette · live-session"), "Help palette was not rendered");
  stdin.write("Attach Harness Session Tail");
  stdin.write("\r");
  await waitFor(() => painted().includes(`Session ${sessionId}: live`), "attached native session was not rendered as live");
}

function launch(runtime: ArborRuntime, directory: string): {
  readonly stdin: PassThrough;
  readonly painted: () => string;
  readonly receipts: readonly OperatorMetricReceipt[];
  readonly ready: Promise<void>;
  readonly finished: Promise<number>;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  const observed: OperatorMetricReceipt[] = [];
  stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const ready = deferred<void>();
  const finished = runTui({
    cwd: directory,
    stdin,
    stdout,
    stderr,
    frame_interval_ms: 5,
    runtime_factory: () => runtime,
    on_ready: () => ready.resolve(),
    on_operator_metric: (receipt) => observed.push(receipt),
  });
  return { stdin, painted: () => output, receipts: observed, ready: ready.promise, finished };
}

function specialize(executor: NativeAgentExecutor, sessionId: string, directory: string): Promise<unknown> {
  return executor.specialize({
    campaign_id: "foi-runtime-campaign",
    node_id: "foi-runtime-node",
    action: {},
    prompt: "deterministic native FOI runtime scenario",
    worktree_path: directory,
    specialist_agent: "seed",
    session_id: sessionId,
  });
}

describe("FOI native-session RuntimePort → runTui round trips", () => {
  it("S01: renders a real native session live, then its canonical completed terminal state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-foi-native-s01-"));
    directories.push(directory);
    const journal = new HarnessSessionJournal();
    const runtime = new ArborRuntime({ harness_sessions: journal });
    const entered = deferred<void>();
    const release = deferred<void>();
    const model: NativeModelPort = {
      async run() {
        entered.resolve();
        await release.promise;
        return { text: [{ text: "native final answer", phase: "final" }], tool_calls: [], final_message: "native final answer" };
      },
    };
    const executor = new NativeAgentExecutor({
      workspace_root: directory,
      capabilities,
      model_for_role: () => model,
      live_sessions: runtime.nativeSessionRegistry,
      ...journalCallbacks(journal),
    });
    const running = specialize(executor, "foi-native-s01", directory);
    await entered.promise;

    const tui = launch(runtime, directory);
    await tui.ready;
    await attachLiveSession(tui.stdin, tui.painted, "foi-native-s01");
    expect(journal.events("foi-native-s01").map((event) => event.kind)).toEqual(["lifecycle"]);

    release.resolve();
    await running;
    await waitFor(() => tui.painted().includes("terminal (completed)"), "canonical completed terminal state was not rendered");
    expect(journal.inspect("foi-native-s01")).toMatchObject({ state: "completed", terminal: { cause: "completed" } });
    expect(runtime.nativeSessionRegistry.inspect("foi-native-s01")).toBeNull();

    tui.stdin.end();
    await expect(tui.finished).resolves.toBe(0);
    expect(tui.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "resource_settlement", resources: expect.objectContaining({ settlement: "settled" }) }),
    ]));
  }, 10_000);

  it("S12: routes a TUI row-interrupt through RuntimePort to the exact native session and renders canonical interruption", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-foi-native-s12-"));
    directories.push(directory);
    const journal = new HarnessSessionJournal();
    const runtime = new ArborRuntime({ harness_sessions: journal });
    const entered = deferred<void>();
    const model: NativeModelPort = {
      async run(_request, _secret, signal) {
        entered.resolve();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("deterministic model observed native abort"));
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        });
        throw new Error("unreachable");
      },
    };
    const executor = new NativeAgentExecutor({
      workspace_root: directory,
      capabilities,
      model_for_role: () => model,
      live_sessions: runtime.nativeSessionRegistry,
      ...journalCallbacks(journal),
    });
    const running = specialize(executor, "foi-native-s12", directory);
    await entered.promise;

    const tui = launch(runtime, directory);
    await tui.ready;
    await attachLiveSession(tui.stdin, tui.painted, "foi-native-s12");

    // The Harness Sessions list owns the selected row that the shared `c`
    // action turns into a RuntimePort `harness.session.interrupt` command.
    tui.stdin.write(".");
    await waitFor(() => tui.painted().includes("Harness sessions"), "Harness Sessions list was not rendered");
    tui.stdin.write("cc");
    await running;
    await waitFor(() => journal.inspect("foi-native-s12")?.terminal?.cause === "interrupted", "native session did not settle as interrupted");

    // Return to the already-attached Live Session tail: the renderer must not
    // report a successful cancellation before this durable terminal arrives.
    tui.stdin.write("\u0013");
    await waitFor(() => tui.painted().includes("terminal (interrupted)"), "canonical interrupted terminal state was not rendered");
    expect(journal.events("foi-native-s12").map((event) => event.kind)).toContain("terminal");
    expect(runtime.nativeSessionRegistry.inspect("foi-native-s12")).toBeNull();

    tui.stdin.end();
    await expect(tui.finished).resolves.toBe(0);
    expect(tui.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "resource_settlement", resources: expect.objectContaining({ settlement: "settled" }) }),
    ]));
  }, 10_000);

  it("drives a non-executor corpus fixture through NativeSessionEngine and keeps projection losses unmeasured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-foi-native-s06-"));
    directories.push(directory);

    const receipt = await captureFOINativeRuntimeScenario("S06", directory);

    expect(receipt.execution).toMatchObject({
      native_session_engine: true,
      runtime_port: true,
      launchable_tui: true,
      native_renderer_commit: false,
      driver: "native-session-fixture",
      renderer_evidence: "not_captured",
    });
    expect(receipt.artifacts.terminal_output).toContain("terminal (completed)");
    expect(receipt.artifacts.event_trace).toContain('"kind":"tool_intent"');
    expect(receipt.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "native-runtime-roundtrip", status: "pass" }),
      expect.objectContaining({ id: "projection-boundary:tool_content_and_relationships_redacted", status: "unmeasured" }),
      expect.objectContaining({ id: "projection-boundary:fixture_devtools_not_driven", status: "unmeasured" }),
    ]));
    expect(receipt.semantic_losses.map((loss) => loss.id)).toEqual([
      "tool_content_and_relationships_redacted",
      "fixture_devtools_not_driven",
    ]);
    expect(receipt.verdict).toBe("inconclusive");
  }, 10_000);

  it("drives the first-run corpus state through RuntimePort without fabricating a native session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-foi-native-s20-"));
    directories.push(directory);

    const receipt = await captureFOINativeRuntimeScenario("S20", directory);

    expect(receipt.execution).toMatchObject({
      native_session_engine: false,
      runtime_port: true,
      launchable_tui: true,
      driver: "runtime-empty-state",
      renderer_evidence: "not_captured",
    });
    expect(receipt.artifacts.terminal_output).toContain("No live sessions");
    expect(receipt.artifacts.event_trace).toBe("\n");
    expect(receipt.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "native-runtime-roundtrip", status: "pass" }),
    ]));
  }, 10_000);

  it("drives S16 through the native runtime while retaining only the bounded 200-event RuntimePort tail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-foi-native-s16-"));
    directories.push(directory);

    const receipt = await captureFOINativeRuntimeScenario("S16", directory);

    expect(receipt.execution).toMatchObject({ driver: "native-session-fixture", native_session_engine: true });
    expect(receipt.artifacts.event_trace.trim().split("\n")).toHaveLength(200);
    expect(receipt.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "native-runtime-roundtrip", status: "pass" }),
    ]));
    expect(receipt.verdict).toBe("pass");
  }, 15_000);
});
