import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessSessionJournal } from "../../src/harness-session-journal.js";
import { FRESH_ADMISSION_KINDS, type ContinuationAuthorization, type RecoveryOperationCheckpoint } from "../../src/recovery/contracts.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const dir = (): string => { const value = mkdtempSync(join(tmpdir(), "arbor-continuation-")); dirs.push(value); return value; };
const started = (journal: HarnessSessionJournal): void => { expect(journal.recordStarted({ session_id: "source", campaign_id: "campaign", node_id: "node", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0 })).toBe(true); };
const point = (phase: RecoveryOperationCheckpoint["phase"]): RecoveryOperationCheckpoint => ({ session_id: "source", operation_id: "call", operation_kind: "tool", operation: "file.patch", phase, effect_kind: "file_patch", repeatable: false, idempotency_key_hash: null, acknowledged_by: null, outcome: phase === "settled" ? "succeeded" : null, effect: phase === "settled" ? "applied" : null, compensation_id: null, occurred_at: "2026-08-12T00:00:00.000Z" });
const authorization = (): ContinuationAuthorization => ({
  authorization_id: "auth", idempotency_key: "key", campaign_id: "campaign", node_id: "node", source_session_id: "source", source_checkpoint: 0,
  new_session_id: "continuation:auth", classification_fingerprint: `sha256:${"a".repeat(64)}`, effects: [{ operation_id: "call", operation: "file.patch", classification: "indeterminate" }], dispositions: [{ operation_id: "call", decision: "retry", reason: "operator reconciled external state" }],
  admissions: FRESH_ADMISSION_KINDS.map((kind) => ({ kind, admitted: true, evidence_id: `${kind}:fresh`, reason: "freshly checked" })), context: [{ kind: "summary", reference_id: "source:0", summary: "bounded structural summary", provenance: { tag: "generated", generator: "test", input_hash: "source:0" } }],
  actor_id: "operator", authorized_at: "2026-08-12T00:00:00.000Z",
});

describe("durable continuation journal", () => {
  it("persists write-ahead phases and rejects invalid phase ordering", () => {
    const journal = new HarnessSessionJournal(); started(journal);
    expect(journal.recordOperationCheckpoint(point("dispatched"))).toBe(false);
    expect(journal.recordOperationCheckpoint(point("prepared"))).toBe(true);
    expect(journal.recordOperationCheckpoint(point("dispatched"))).toBe(true);
    expect(journal.recordOperationCheckpoint(point("settled"))).toBe(true);
    expect(journal.operationCheckpoints("source").map((item) => item.phase)).toEqual(["prepared", "dispatched", "settled"]);
  });

  it("replays authorization, conflicts changed identity reuse, and admits exactly one linked fresh session", () => {
    const persistence = dir(); const before = new HarnessSessionJournal({ persistence_dir: persistence }); started(before);
    expect(before.recordContinuationAuthorization(authorization())).toMatchObject({ ok: true, replayed: false });
    const after = new HarnessSessionJournal({ persistence_dir: persistence });
    expect(after.continuationByIdempotencyKey("key")).toMatchObject({ authorization_id: "auth" });
    expect(after.recordContinuationAuthorization(authorization())).toMatchObject({ ok: true, replayed: true });
    expect(after.recordContinuationAuthorization({ ...authorization(), actor_id: "different" })).toMatchObject({ ok: false, conflict: true });
    const lineage = { kind: "continuation" as const, source_session_id: "source", checkpoint: 0, authorization_id: "auth" };
    expect(after.recordStarted({ session_id: "continuation:auth", campaign_id: "campaign", node_id: "node", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0, lineage })).toBe(true);
    expect(after.inspect("continuation:auth")?.lineage).toEqual(lineage);
    expect(after.pendingContinuation("campaign", "node")).toBeNull();
  });
});
