import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessSessionReplayStore } from "../src/harness-session-replay-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string { const value = mkdtempSync(join(tmpdir(), "arbor-replay-")); roots.push(value); return value; }

describe("HarnessSessionReplayStore", () => {
  it("persists protected redacted continuity and strips stale evidence authority on admission", () => {
    const persistence = root();
    const store = new HarnessSessionReplayStore({ persistence_dir: persistence, clock: () => "2026-08-20T00:00:00.000Z" });
    expect(store.record({ campaign_id: "campaign-1", node_id: "node-1", operation: "specialize", checkpoint: {
      version: 1, session_id: "session-1", next_turn: 2, captured_sequence: 5, prompt: "API_KEY=supersecretvalue",
      history: [{ kind: "tool_result", tool: "file.read", call_id: "call-1", text: "token=anothersecretvalue", evidence: [{ entry_id: "old-context", provenance: { tag: "claimed", claimant: "source" } }] }],
    } })).toBe(true);
    const file = join(persistence, "protected", "harness-session-replay.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("supersecretvalue");
    expect(readFileSync(file, "utf8")).not.toContain("anothersecretvalue");
    const restored = new HarnessSessionReplayStore({ persistence_dir: persistence });
    const admission = restored.admit({ kind: "resume", source_session_id: "session-1", new_session_id: "session-2" });
    expect(admission).toMatchObject({ kind: "resume", source_session_id: "session-1", source_checkpoint: 5, new_session_id: "session-2" });
    expect(admission?.initial_history[0]).toEqual({ kind: "tool_result", tool: "file.read", call_id: "call-1", text: "token=[REDACTED]" });
  });

  it("fails closed when persisted continuity is tampered", () => {
    const persistence = root();
    const store = new HarnessSessionReplayStore({ persistence_dir: persistence });
    expect(store.record({ campaign_id: "campaign-1", node_id: "node-1", operation: "review", checkpoint: { version: 1, session_id: "session-1", next_turn: 1, captured_sequence: 1, prompt: "review", history: [] } })).toBe(true);
    const file = join(persistence, "protected", "harness-session-replay.json");
    writeFileSync(file, readFileSync(file, "utf8").replace("review", "forged"));
    const restored = new HarnessSessionReplayStore({ persistence_dir: persistence });
    expect(restored.latest("session-1")).toBeNull();
    expect(restored.diagnostics()).toContain("protected replay store failed integrity validation");
  });
});
