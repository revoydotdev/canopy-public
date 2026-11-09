/**
 * S03 (P1, active cancellation): `serve` raced stdin EOF against the OS
 * shutdown signal with no shared cleanup — whichever settled first just
 * closed the stdio session. A client hanging up its pipe while a campaign
 * was still expanding therefore left that campaign running unattended: the
 * same "durably expanding campaign" defect the historical SIGINT bug had,
 * reached through EOF instead of a signal.
 *
 * This drives the REAL `serve` dispatch in cli.ts end-to-end over the real
 * MCP stdio protocol: a real `ArborRuntime` with a real pending node,
 * `main(["serve"])` bound to a real `ShutdownGate`, a real `initialize`
 * handshake, then a bare `stdin.end()` — no SIGINT/SIGTERM, no test code
 * calling `gate.trigger()` itself. If `serve` still only reacted to
 * whichever of {EOF, signal} won the race, the node here would stay
 * "pending" forever. Assert on the runtime's own durable campaign snapshot,
 * not on `main()`'s exit code alone — a clean exit code proves the process
 * quit, not that anyone reached the campaign to cancel it.
 *
 * The interruption record IS the deliverable here, not just the state
 * transition: an operator reading a durable `cli_sigint_shutdown` reason
 * must be able to trust that someone actually pressed Ctrl-C. `serve` now
 * threads which door fired (EOF vs. OS signal) into `ShutdownGate` as a
 * `ShutdownCause`, so the second describe block below drives BOTH doors and
 * asserts each produces its own distinct, honest `reason`/`operation_id` —
 * a single-door test would pass even with a hardcoded string.
 */
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { main, resolvePersistenceDir, ShutdownGate } from "../src/cli.js";
import { ArborRuntime } from "../src/runtime.js";

function collect(stream: PassThrough): { text(): string } {
  let buf = "";
  stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { text: () => buf };
}

async function initializeMcp(input: PassThrough, id: string | number): Promise<void> {
  input.write(`${JSON.stringify({
    jsonrpc: "2.0", id, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s03-eof-test", version: "1" } },
  })}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A fresh runtime with exactly one pending, interruptible node. */
async function runtimeWithPendingNode(root: string, campaignId: string): Promise<{ runtime: ArborRuntime; nodeId: string }> {
  const runtime = new ArborRuntime({ persistence_dir: resolvePersistenceDir(root), workspace_root: root });
  await runtime.start();
  const rootAction: Action = { description: "plan", estimated_gain: 10, estimated_cost: 1, category: "root", delegate_to: "crown" };
  runtime.manager.startCampaign(campaignId, "plan.md", rootAction);
  const child: Action = { description: "do work", estimated_gain: 5, estimated_cost: 1, category: "work", delegate_to: "seed" };
  runtime.manager.branch(campaignId, "root", [child]);
  const snap = runtime.manager.getCampaignSnapshot(campaignId)!;
  const nodeId = snap.nodes.find((n) => n.state === "pending")!.id;
  return { runtime, nodeId };
}

describe("S03 — serve EOF alone must run the same owned cancellation sweep as a shutdown signal", () => {
  it("stdin EOF with no SIGINT/SIGTERM and no test-driven gate.trigger() still durably interrupts a pending node", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-s03-eof-"));
    try {
      const { runtime, nodeId } = await runtimeWithPendingNode(root, "camp-s03-eof");

      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      collect(stdout);
      const gate = new ShutdownGate(0); // 0ms ack — proves the real interrupt+ack round-trip without a slow wait
      const donePromise = main(["serve"], {
        cwd: root, stdin, stdout, stderr,
        runtime_factory: () => runtime,
      }, gate);

      await new Promise((r) => setImmediate(r));
      await initializeMcp(stdin, 1);

      // The client hangs up its pipe. No signal is ever sent, and this test
      // never calls gate.trigger() itself — only cli.ts's own EOF handling
      // may do that.
      stdin.end();

      expect(await donePromise).toBe(0);

      const after = runtime.manager.getCampaignSnapshot("camp-s03-eof")!;
      const node = after.nodes.find((n) => n.id === nodeId)!;
      expect(node.state).toBe("interrupted");
      await runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("S03 follow-up — the durable interruption record names the door that actually fired, not a hardcoded string", () => {
  it("stdin EOF (no signal) records a client_disconnect reason and operation_id — never the SIGINT wording", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-s03-reason-eof-"));
    try {
      const { runtime, nodeId } = await runtimeWithPendingNode(root, "camp-s03-reason-eof");
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      collect(stdout);
      const gate = new ShutdownGate(0);
      const donePromise = main(["serve"], { cwd: root, stdin, stdout, stderr, runtime_factory: () => runtime }, gate);

      await new Promise((r) => setImmediate(r));
      await initializeMcp(stdin, 1);
      stdin.end(); // EOF only — no SIGINT/SIGTERM, no test-driven gate.trigger()
      expect(await donePromise).toBe(0);

      const node = runtime.manager.getCampaignSnapshot("camp-s03-reason-eof")!.nodes.find((n) => n.id === nodeId)!;
      expect(node.outcome?.kind).toBe("interrupted");
      const outcome = node.outcome as Extract<NonNullable<typeof node.outcome>, { kind: "interrupted" }>;
      expect(outcome.message).toBe("cli_client_disconnect_shutdown");
      expect(outcome.operation_id).toContain("client-disconnect");
      expect(outcome.message).not.toBe("cli_sigint_shutdown");
      expect(outcome.operation_id).not.toContain("sigint");
      await runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an OS-signal trigger (no EOF) records the sigint reason and operation_id — distinct from the disconnect door above", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-s03-reason-signal-"));
    try {
      const { runtime, nodeId } = await runtimeWithPendingNode(root, "camp-s03-reason-signal");
      const gate = new ShutdownGate(0);
      gate.bind(runtime);
      gate.trigger(); // the real signal-handler call shape: no cause argument
      await gate.signal;

      const node = runtime.manager.getCampaignSnapshot("camp-s03-reason-signal")!.nodes.find((n) => n.id === nodeId)!;
      expect(node.outcome?.kind).toBe("interrupted");
      const outcome = node.outcome as Extract<NonNullable<typeof node.outcome>, { kind: "interrupted" }>;
      expect(outcome.message).toBe("cli_sigint_shutdown");
      expect(outcome.operation_id).toContain("sigint");
      expect(outcome.message).not.toBe("cli_client_disconnect_shutdown");
      expect(outcome.operation_id).not.toContain("client-disconnect");
      await runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
