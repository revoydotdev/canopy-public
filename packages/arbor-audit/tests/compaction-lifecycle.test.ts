import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  type CompactionLifecycleInput,
  COMPACTION_MAX_PARTIAL_EVIDENCE,
  COMPACTION_MAX_REASON_BYTES,
  COMPACTION_MAX_ID_BYTES,
  validateCompactionLifecycle,
} from "../src/audit.js";

function lifecycle(overrides: Partial<CompactionLifecycleInput> = {}): CompactionLifecycleInput {
  return {
    campaign_id: "campaign",
    node_id: "node-a",
    operation_id: "compact:1",
    trigger: "auto",
    strategy: "local_model",
    status: "completed",
    pre_evidence_id: "trace_abc123",
    post_evidence_id: "trace_def456",
    anchor_summary_id: "trace_xyz789",
    reason: "token budget threshold exceeded",
    partial_evidence_ids: [],
    idempotency_key: "compact-key:1",
    as_of: "seq:100",
    ...overrides,
  };
}

describe("CompactionLifecycle audit evidence", () => {
  it("recordCompactionLifecycle appends a hash-chained record and is idempotent on same idempotency_key", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordCompactionLifecycle(lifecycle());
    expect(id).toMatch(/^compaction_/);
    // Same payload → same id (idempotent)
    expect(ledger.recordCompactionLifecycle(lifecycle())).toBe(id);
    // Different payload with same key → conflict
    expect(() =>
      ledger.recordCompactionLifecycle(
        lifecycle({ operation_id: "compact:different" }),
      ),
    ).toThrow("idempotency conflict");
  });

  it("interrupted ≠ failed: statuses are distinct in the union; both round-trip; the validator rejects out-of-union statuses", () => {
    const ledger = new EvidenceLedger();
    const interrupted = ledger.recordCompactionLifecycle(
      lifecycle({ status: "interrupted", post_evidence_id: null }),
    );
    const failed = ledger.recordCompactionLifecycle(
      lifecycle({
        status: "failed",
        post_evidence_id: null,
        idempotency_key: "compact-key:2",
      }),
    );
    expect(interrupted).not.toBe(failed);

    const records = ledger.getCompactionLifecycles("campaign");
    expect(records).toHaveLength(2);
    expect(records[0].lifecycle.status).toBe("interrupted");
    expect(records[1].lifecycle.status).toBe("failed");

    // Validator rejects out-of-union statuses
    expect(() =>
      validateCompactionLifecycle(
        lifecycle({ status: "unknown" as never, post_evidence_id: null }),
      ),
    ).toThrow("invalid trigger, status, or strategy");

    // Validator rejects null post_evidence_id for completed status
    expect(() =>
      validateCompactionLifecycle(
        lifecycle({ status: "completed", post_evidence_id: null }),
      ),
    ).toThrow("requires a non-null post_evidence_id");

    // Validator rejects non-null post_evidence_id for interrupted status
    expect(() =>
      validateCompactionLifecycle(
        lifecycle({
          status: "interrupted",
          post_evidence_id: "trace_abc",
          idempotency_key: "compact-key:3",
        }),
      ),
    ).toThrow("must have null post_evidence_id");
  });

  it("getCompactionLifecycles returns bounded, snapshot-stable, as-of-filtered records", () => {
    const ledger = new EvidenceLedger();
    const id1 = ledger.recordCompactionLifecycle(lifecycle({ as_of: "seq:100", idempotency_key: "k1" }));
    ledger.recordCompactionLifecycle(
      lifecycle({ as_of: "seq:200", idempotency_key: "k2", node_id: "node-b" }),
    );

    // All records for campaign
    const all = ledger.getCompactionLifecycles("campaign");
    expect(all).toHaveLength(2);

    // Filter by node
    const nodeA = ledger.getCompactionLifecycles("campaign", "node-a");
    expect(nodeA).toHaveLength(1);
    expect(nodeA[0].id).toBe(id1);

    // Filter by as_of
    const asOf = ledger.getCompactionLifecycles("campaign", undefined, { as_of: "seq:100" });
    expect(asOf).toHaveLength(1);
    expect(asOf[0].id).toBe(id1);

    // Bounded
    const bounded = ledger.getCompactionLifecycles("campaign", undefined, { limit: 1 });
    expect(bounded).toHaveLength(1);

    // Snapshot-stable: mutations don't affect returned arrays
    const before = ledger.getCompactionLifecycles("campaign");
    ledger.recordCompactionLifecycle(lifecycle({ idempotency_key: "k3", as_of: "seq:300" }));
    expect(before).toHaveLength(2);
  });

  it("replay byte-identity: toJSONL → fromJSONL round-trip preserves every field including nulls", () => {
    const ledger = new EvidenceLedger();
    ledger.recordCompactionLifecycle(
      lifecycle({
        status: "interrupted",
        post_evidence_id: null,
        anchor_summary_id: null,
        reason: "interrupted during pre-compaction evidence gathering",
        idempotency_key: "k-replay",
      }),
    );

    const jsonl = ledger.toJSONL();
    const restored = new EvidenceLedger();
    restored.fromJSONL(jsonl);

    const original = ledger.getCompactionLifecycles("campaign");
    const replayed = restored.getCompactionLifecycles("campaign");
    expect(replayed).toHaveLength(1);
    expect(replayed[0].lifecycle.post_evidence_id).toBeNull();
    expect(replayed[0].lifecycle.anchor_summary_id).toBeNull();
    expect(replayed[0].lifecycle.status).toBe("interrupted");
    expect(replayed[0].lifecycle.reason).toBe("interrupted during pre-compaction evidence gathering");
    expect(JSON.stringify(original[0])).toBe(JSON.stringify(replayed[0]));
    expect(restored.verifyIntegrity()).toMatchObject({ valid: true });
  });

  it("hash-chain integrity: tampering with fields after append is detected on replay", () => {
    const ledger = new EvidenceLedger();
    ledger.recordCompactionLifecycle(lifecycle({ idempotency_key: "k-chain" }));
    const jsonl = ledger.toJSONL();
    const lines = jsonl.split("\n");
    const tampered = JSON.parse(lines[0]);
    tampered.lifecycle.reason = "tampered reason";
    const restored = new EvidenceLedger();
    restored.fromJSONL([JSON.stringify(tampered), ...lines.slice(1)].join("\n"));
    expect(restored.verifyIntegrity()).toMatchObject({ valid: false });
  });

  it("hash-chain detects truncation, reorder, and duplicate records", () => {
    const ledger = new EvidenceLedger();
    ledger.recordCompactionLifecycle(lifecycle({ idempotency_key: "k-trunc-1", as_of: "seq:1" }));
    ledger.recordCompactionLifecycle(lifecycle({ idempotency_key: "k-trunc-2", as_of: "seq:2" }));

    // Truncation
    const truncated = new EvidenceLedger();
    const lines = ledger.toJSONL().split("\n");
    truncated.fromJSONL(lines.slice(0, 1).join("\n"));
    expect(truncated.verifyIntegrity()).toMatchObject({ valid: true });
    expect(truncated.getCompactionLifecycles("campaign")).toHaveLength(1);

    // Reorder
    const reordered = new EvidenceLedger();
    reordered.fromJSONL([lines[1], lines[0]].join("\n"));
    expect(reordered.verifyIntegrity()).toMatchObject({ valid: false });

    // Duplicate (same id) — fromJSONL skips duplicates
    const duplicate = new EvidenceLedger();
    duplicate.fromJSONL(lines.join("\n"));
    duplicate.fromJSONL(lines.join("\n")); // reload same data
    expect(duplicate.getCompactionLifecycles("campaign")).toHaveLength(2);
  });

  it("validates bounds: MAX_PARTIAL_EVIDENCE, MAX_REASON_BYTES, MAX_ID_BYTES", () => {
    const manyIds = Array.from({ length: COMPACTION_MAX_PARTIAL_EVIDENCE + 1 }, (_, i) => `evidence_${i}`);
    expect(() =>
      validateCompactionLifecycle(
        lifecycle({ partial_evidence_ids: manyIds, idempotency_key: "k-bounds" }),
      ),
    ).toThrow("exceeds partial_evidence");

    const longReason = "x".repeat(COMPACTION_MAX_REASON_BYTES + 1);
    expect(() =>
      validateCompactionLifecycle(
        lifecycle({ reason: longReason, idempotency_key: "k-bounds2" }),
      ),
    ).toThrow("exceeds");

    const longId = "x".repeat(COMPACTION_MAX_ID_BYTES + 1);
    expect(() =>
      validateCompactionLifecycle(
        lifecycle({ operation_id: longId, idempotency_key: "k-bounds3" }),
      ),
    ).toThrow("exceeds");
  });

  it("validates duplicate partial_evidence_ids are rejected", () => {
    expect(() =>
      validateCompactionLifecycle(
        lifecycle({
          partial_evidence_ids: ["ev1", "ev1"],
          idempotency_key: "k-dup-ev",
        }),
      ),
    ).toThrow("must be unique");
  });

  it("validates timestamp must be ISO-parseable", () => {
    expect(() =>
      validateCompactionLifecycle(
        lifecycle({ timestamp: "not-a-timestamp", idempotency_key: "k-ts" }),
      ),
    ).toThrow("timestamp must be ISO-parseable");
  });

  it("validates required fields are present", () => {
    expect(() =>
      validateCompactionLifecycle(
        lifecycle({ campaign_id: "" }),
      ),
    ).toThrow("requires campaign");
    expect(() =>
      validateCompactionLifecycle(
        lifecycle({ operation_id: "" }),
      ),
    ).toThrow("requires campaign");
    expect(() =>
      validateCompactionLifecycle(
        lifecycle({ idempotency_key: "" }),
      ),
    ).toThrow("requires campaign");
  });
});