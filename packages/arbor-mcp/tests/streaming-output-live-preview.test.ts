/**
 * ADR-104 O4, closing the gap the audit found: `on_model_delta` and
 * `output.ts`'s in-progress render path each existed in isolation with no
 * production caller connecting them. This drives the actual production
 * composition `cli.ts`'s `configuredNativeAgentExecutor` now uses --
 * `live_sessions: runtime.nativeSessionRegistry` plus an `on_model_delta`
 * that forwards `kind: "text"` deltas into `nativeSessionRegistry.pushDelta`
 * -- against a real `ArborRuntime`/`RuntimeCatalogRouter`, the same query
 * round trip `arbor tui`'s `output` screen issues. A model port that blocks
 * mid-stream (mirroring `native-agent-delta-forwarding.test.ts`'s proof
 * technique) is what makes "genuinely visible while the turn is still
 * running", not just "visible after it finished", a real assertion here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilitySupport, NativeInferenceDelta, NativeModelPort } from "@arbor/harness";
import { NativeAgentExecutor } from "../src/native-agent-executor.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting",
].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "streaming-output-live-preview-test", observed_at: "2026-08-26T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function persistenceDir(): string {
  const value = mkdtempSync(join(tmpdir(), "arbor-streaming-output-"));
  roots.push(value);
  return value;
}

const descriptorQuery = (evidenceId: string) => ({ schema_version: 1 as const, query_id: `q:${evidenceId}`, query: { kind: "output.descriptor" as const, evidence_id: evidenceId } });
const listQuery = () => ({ schema_version: 1 as const, query_id: "list", query: { kind: "output.list" as const } });

/**
 * Wires the executor exactly the way `cli.ts`'s `configuredNativeAgentExecutor`
 * now does for these two options: `live_sessions` bound to the real
 * `nativeSessionRegistry`, and `on_model_delta` forwarding `kind: "text"`
 * deltas into that same registry's `pushDelta`.
 */
function buildExecutor(runtime: ArborRuntime, model: NativeModelPort): NativeAgentExecutor {
  return new NativeAgentExecutor({
    workspace_root: "/workspace",
    capabilities,
    model_for_role: () => model,
    live_sessions: runtime.nativeSessionRegistry,
    on_model_delta(record) {
      if (record.delta.kind === "text") runtime.nativeSessionRegistry.pushDelta(record.session_id, record.delta.text);
    },
  });
}

describe("ADR-104 O4: a live streamed turn is visible through the output.descriptor/output.list round trip", () => {
  it("output.descriptor returns the partial text while the model is still mid-stream, before the turn settles", async () => {
    const runtime = new ArborRuntime({ persistence_dir: persistenceDir() });
    const router = new RuntimeCatalogRouter(runtime);
    const secondGate = deferred<void>();
    const firstDeltaPushed = deferred<void>();

    const model: NativeModelPort = {
      async run() { throw new Error("run() must not be used when the port exposes stream()"); },
      async *stream(): AsyncIterable<NativeInferenceDelta> {
        yield { kind: "text", text: "The answer is ", phase: "commentary" };
        await secondGate.promise;
        yield { kind: "text", text: "forty-two.", phase: "commentary" };
        yield { kind: "final", message: "The answer is forty-two." };
      },
    };
    // Wired exactly like `buildExecutor`, plus one extra test-only signal so
    // the assertions below run only once `pushDelta` has actually landed --
    // waiting for the real event, never a fixed sleep (ADR-078 / this
    // session's own determinism-gate finding).
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace",
      capabilities,
      model_for_role: () => model,
      live_sessions: runtime.nativeSessionRegistry,
      on_model_delta(record) {
        if (record.delta.kind === "text") {
          runtime.nativeSessionRegistry.pushDelta(record.session_id, record.delta.text);
          firstDeltaPushed.resolve();
        }
      },
    });

    const specializePromise = executor.specialize({
      campaign_id: "c", node_id: "n", action: {}, prompt: "compute the answer",
      worktree_path: "", specialist_agent: "seed", session_id: "live-turn",
    });
    await firstDeltaPushed.promise;

    // The turn is deliberately still gated mid-stream here: only a sink
    // invoked ahead of batch collection (ADR-104 O3, already proven by
    // native-agent-delta-forwarding.test.ts) could have populated the
    // buffer this early.
    //
    // `output.list` is queried first and its row's own `id` is what feeds
    // the `output.descriptor` follow-up -- exactly the round trip
    // `arbor-tui/src/update.ts`'s `view_selected_row_detail` performs for a
    // selected "output" row (`{ evidence_id: selected.id }`), never a
    // literal session id: a real native session id never satisfies
    // `output.descriptor`'s own `out_[a-f0-9]{64}` evidence-id format.
    const midList = router.executeQuery(listQuery());
    expect(midList.ok).toBe(true);
    if (!midList.ok) throw new Error("output.list failed");
    expect(midList.value).toContainEqual(expect.objectContaining({
      status: "in_progress",
      record: expect.objectContaining({ campaign_id: "c", node_id: "n", stream: "model" }),
    }));
    const listRows = midList.value as readonly Record<string, unknown>[];
    const liveEntry = listRows.find((entry) => entry.status === "in_progress") as { record: { id: string } } | undefined;
    if (liveEntry === undefined) throw new Error("no in_progress row in output.list");
    const rowId = liveEntry.record.id;
    expect(rowId).toMatch(/^out_[a-f0-9]{64}$/);

    const midStream = router.executeQuery(descriptorQuery(rowId));
    expect(midStream).toMatchObject({ ok: true, value: { evidence_id: rowId, preview: { content: "The answer is ", in_progress: true } } });

    secondGate.resolve();
    await specializePromise;

    // Once the session settles, its live buffer is gone (LiveNativeSessionRegistry.settle)
    // and its derived row id is no longer distinguishable from an unknown one.
    const afterSettle = router.executeQuery(descriptorQuery(rowId));
    expect(afterSettle).toMatchObject({ ok: false });
    const afterSettleList = router.executeQuery(listQuery());
    if (afterSettleList.ok) expect(afterSettleList.value).not.toContainEqual(expect.objectContaining({ status: "in_progress" }));
  });

  it("a model port with no .stream() never reaches the live buffer (additive-only, ADR-104 Decision 1)", async () => {
    const runtime = new ArborRuntime({ persistence_dir: persistenceDir() });
    const router = new RuntimeCatalogRouter(runtime);
    const model: NativeModelPort = {
      async run() { return { text: [{ text: "done", phase: "final" }], tool_calls: [], final_message: "done", usage: { input_tokens: 1, output_tokens: 1 } }; },
    };
    const executor = buildExecutor(runtime, model);
    await executor.specialize({ campaign_id: "c", node_id: "n", action: {}, prompt: "no streaming here", worktree_path: "", specialist_agent: "seed", session_id: "batch-only-turn" });
    expect(runtime.nativeSessionRegistry.preview("batch-only-turn")).toBeNull();
    const list = router.executeQuery(listQuery());
    if (list.ok) expect(list.value).not.toContainEqual(expect.objectContaining({ status: "in_progress" }));
  });

  it("LiveNativeSessionRegistry.pushDelta keeps only the trailing window and redacts secret-shaped text, driven through the real delta path", async () => {
    const runtime = new ArborRuntime({ persistence_dir: persistenceDir() });
    const gate1 = deferred<void>();
    const firstPushed = deferred<void>();
    const secondPushed = deferred<void>();
    let pushes = 0;

    const model: NativeModelPort = {
      async run() { throw new Error("run() must not be used when the port exposes stream()"); },
      async *stream(): AsyncIterable<NativeInferenceDelta> {
        yield { kind: "text", text: "x".repeat(3000), phase: "commentary" };
        await gate1.promise;
        yield { kind: "text", text: "api_key=SECRETVALUE123456 " + "y".repeat(2000), phase: "commentary" };
        yield { kind: "final", message: "done" };
      },
    };
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace",
      capabilities,
      model_for_role: () => model,
      live_sessions: runtime.nativeSessionRegistry,
      on_model_delta(record) {
        if (record.delta.kind !== "text") return;
        runtime.nativeSessionRegistry.pushDelta(record.session_id, record.delta.text);
        pushes++;
        if (pushes === 1) firstPushed.resolve(); else if (pushes === 2) secondPushed.resolve();
      },
    });

    const specializePromise = executor.specialize({
      campaign_id: "c", node_id: "n", action: {}, prompt: "grow the buffer past its bound",
      worktree_path: "", specialist_agent: "seed", session_id: "bounded-turn",
    });
    await firstPushed.promise;
    expect(runtime.nativeSessionRegistry.preview("bounded-turn")).toBe("x".repeat(3000));

    gate1.resolve();
    await secondPushed.promise;
    const bounded = runtime.nativeSessionRegistry.preview("bounded-turn");
    expect(bounded).not.toBeNull();
    // Bounded: the combined 5,027 chars never appear in full.
    expect(bounded!.length).toBeLessThanOrEqual(4_000);
    // Redacted: the raw secret text never enters the buffer, even though it
    // falls inside the surviving trailing window (only the leading run of
    // "x" is old enough to have been trimmed off).
    expect(bounded).not.toContain("SECRETVALUE123456");
    expect(bounded).toContain("[REDACTED]");
    expect(bounded!.endsWith("y".repeat(2000))).toBe(true);

    await specializePromise;
  });
});
