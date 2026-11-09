/**
 * specialist-command-surfacing.test.ts — the commands a specialist actually
 * ran must reach the ledger.
 *
 * WHY THIS EXISTS. Unlike every comparable harness, revoy2's cockpit showed no
 * representation of commands being run. The cause was structural, not a
 * missing view: the executor spawned `opencode run` with `--format default`,
 * buffered the whole stdout, and parsed it only after the process exited. The
 * entire specialist turn was a black box, so the only `loop.tool_call` events
 * that existed were harness-level dispatch records (`opencode.run`,
 * `opencode.panel_review`) — never the individual commands the agent ran.
 *
 * `opencode run` has supported `--format json` (line-delimited raw events)
 * all along and revoy2 never used it. A live probe against the real binary
 * confirmed the shape: `tool_use` events carry `part.state.input.command`,
 * `part.state.metadata.exit`, and timings.
 *
 * Switching the specialist to `--format json` also changes how its answer is
 * recovered: the deliverable text is no longer the raw stdout, it is
 * reassembled from the stream's `text` parts. That is the risk these tests
 * exist to pin — a wrong reassembly silently empties every specialist result.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action } from "@arbor/core";
import { createOpenCodeLoopExecutor } from "../src/opencode-executor.js";

const FAKE_OPENCODE_BIN = join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-opencode.mjs");

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "arbor-cmd-surface-"));
  writeFileSync(join(work, "arbor.jsonc"), JSON.stringify({ agents: {} }), "utf8");
});
afterAll(() => { rmSync(work, { recursive: true, force: true }); });
afterEach(() => { delete process.env.FAKE_OPENCODE_STDOUT; });

const action: Action = {
  description: "probe action", estimated_gain: 1, estimated_cost: 1,
  category: "testing", delegate_to: "seed",
};

function harness(): { lines: Record<string, unknown>[]; executor: ReturnType<typeof createOpenCodeLoopExecutor> } {
  const lines: Record<string, unknown>[] = [];
  const executor = createOpenCodeLoopExecutor(
    { pushDevtoolsLine: (line: unknown) => { lines.push(line as Record<string, unknown>); } } as never,
    () => {},
    "c-cmd",
    { opencodeBin: FAKE_OPENCODE_BIN, timeoutMs: 20_000, configDir: work },
  );
  return { lines, executor };
}

function dispatch(worktree: string): Parameters<ReturnType<typeof createOpenCodeLoopExecutor>["specialize"]>[0] {
  return {
    campaign_id: "c-cmd", node_id: "n1", action,
    prompt: "do the work", specialist_agent: "seed", worktree_path: worktree,
  } as never;
}

/** Real event lines, in the shape the live `opencode run --format json` probe produced. */
const JSON_STREAM = [
  JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "ses_1" }),
  JSON.stringify({
    type: "tool_use", timestamp: 2, sessionID: "ses_1",
    part: {
      type: "tool", tool: "bash", callID: "call_1",
      state: {
        status: "completed",
        input: { command: "bun test packages/arbor-tui", workdir: "/w" },
        output: "12 pass", metadata: { output: "12 pass", exit: 0, truncated: false },
        title: "bun test packages/arbor-tui", time: { start: 10, end: 40 },
      },
    },
  }),
  JSON.stringify({
    type: "text", timestamp: 3, sessionID: "ses_1",
    part: { id: "prt_1", type: "text", text: "Added the region primitive and its tests.", time: { start: 5, end: 9 } },
  }),
  JSON.stringify({ type: "step_finish", timestamp: 4, sessionID: "ses_1" }),
].join("\n");

describe("the specialist's real commands reach the ledger", () => {
  it("recovers the deliverable from the event stream, not from raw stdout", async () => {
    // The whole risk of switching to --format json: if the answer is not
    // reassembled correctly, every specialist result silently becomes JSON
    // soup or empty.
    process.env.FAKE_OPENCODE_STDOUT = JSON_STREAM;
    const { executor } = harness();
    const result = await executor.specialize(dispatch(work));
    expect(result.output).toBe("Added the region primitive and its tests.");
    expect(result.output).not.toContain("step_start");
  });

  it("emits a tool_call for the bash command the agent actually ran", async () => {
    process.env.FAKE_OPENCODE_STDOUT = JSON_STREAM;
    const { lines, executor } = harness();
    await executor.specialize(dispatch(work));
    const commands = lines.filter((l) => {
      const ev = l.loop_event as Record<string, unknown> | undefined;
      return l.event_kind === "loop.tool_call" && ev?.tool === "bash";
    });
    expect(commands).toHaveLength(1);
    expect(String((commands[0]!.loop_event as Record<string, unknown>).args)).toContain("bun test");
  });

  it("carries the command's exit code so a failure is legible", async () => {
    process.env.FAKE_OPENCODE_STDOUT = JSON_STREAM;
    const { lines, executor } = harness();
    await executor.specialize(dispatch(work));
    const bash = lines.find((l) => (l.loop_event as Record<string, unknown> | undefined)?.tool === "bash");
    expect((bash!.loop_event as Record<string, unknown>).exit).toBe(0);
  });

  it("still records the harness-level dispatch alongside the agent's own commands", async () => {
    // The existing `opencode.run` record is how the cockpit knows a
    // specialist was dispatched at all; surfacing inner commands must add to
    // it, not replace it.
    process.env.FAKE_OPENCODE_STDOUT = JSON_STREAM;
    const { lines, executor } = harness();
    await executor.specialize(dispatch(work));
    expect(lines.some((l) => (l.loop_event as Record<string, unknown> | undefined)?.tool === "opencode.run")).toBe(true);
  });

  it("falls back to raw stdout when the response is not an event stream", async () => {
    // Degrading to the previous behaviour is what keeps this change safe: if
    // the flag is ever unsupported or the format changes, the specialist's
    // answer must still survive rather than being parsed into nothing.
    process.env.FAKE_OPENCODE_STDOUT = "just a plain text answer";
    const { executor } = harness();
    const result = await executor.specialize(dispatch(work));
    expect(result.output).toBe("just a plain text answer");
  });

  it("does not lose the answer when the stream carries no text parts", async () => {
    // A turn that only ran tools and said nothing is a real outcome; it must
    // not be reported as an empty deliverable with no explanation.
    process.env.FAKE_OPENCODE_STDOUT = JSON.stringify({ type: "step_finish", timestamp: 1, sessionID: "s" });
    const { executor } = harness();
    const result = await executor.specialize(dispatch(work));
    expect(result.output.length).toBeGreaterThan(0);
  });
});
