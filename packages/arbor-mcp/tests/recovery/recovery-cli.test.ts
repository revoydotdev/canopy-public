import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../../src/cli.js";
import { HarnessSessionJournal } from "../../src/harness-session-journal.js";
import { EXIT_CODES } from "../../src/exit-codes.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("arbor recover CLI", () => {
  it("previews every matched interrupted session without authorizing or dispatching it", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-recover-cli-")); roots.push(root);
    const journal = new HarnessSessionJournal({ persistence_dir: join(root, ".arbor") });
    journal.recordStarted({ session_id: "crashed", campaign_id: "campaign", node_id: "node", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0 });
    journal.recordOperationCheckpoint({ session_id: "crashed", operation_id: "shell-call", operation_kind: "tool", operation: "shell.execute", phase: "prepared", effect_kind: "shell", repeatable: false, idempotency_key_hash: null, acknowledged_by: null, outcome: null, effect: null, compensation_id: null, occurred_at: "2026-08-12T00:00:00.000Z" });
    journal.recordOperationCheckpoint({ session_id: "crashed", operation_id: "shell-call", operation_kind: "tool", operation: "shell.execute", phase: "dispatched", effect_kind: "shell", repeatable: false, idempotency_key_hash: null, acknowledged_by: null, outcome: null, effect: null, compensation_id: null, occurred_at: "2026-08-12T00:00:01.000Z" });
    const stdout = new PassThrough(); let output = ""; stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const code = await main(["recover", "--campaign", "campaign"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(output).toContain("indeterminate"); expect(output).toContain("shell-call"); expect(output).toContain("explicit disposition required");
    const replayed = new HarnessSessionJournal({ persistence_dir: join(root, ".arbor") });
    expect(replayed.continuationAuthorizationsFor("campaign")).toEqual([]);
  });
});
