import { describe, it, expect } from "vitest";
import {
  EvidenceLedger,
  AuditIntegrityError,
  PHASE_MESSAGE_MAX_CONTENT_BYTES,
  PHASE_MESSAGE_MAX_PER_CAMPAIGN,
  validatePhaseMessage,
} from "../src/audit.js";
import type { PhaseMessageInput } from "../src/index.js";
import type { Provenance } from "@arbor/core";

const claimed: Provenance = { tag: "claimed", claimant: "seed" };

function message(overrides: Partial<PhaseMessageInput> = {}): PhaseMessageInput {
  return {
    campaign_id: "camp1",
    node_id: "n1",
    operation_id: "op1",
    phase: "commentary",
    content: "this is a brief commentary note",
    content_length_bytes: Buffer.byteLength("this is a brief commentary note", "utf8"),
    provenance: claimed,
    idempotency_key: "commentary:n1:op1:1",
    ...overrides,
  };
}

describe("PhaseMessageRecord — commentary/final phase boundary", () => {
  it("records a single commentary phase message and retrieves it", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordPhaseMessage(message());
    expect(id).toMatch(/^phase_/);
    const msgs = ledger.getPhaseMessages("camp1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message.phase).toBe("commentary");
    expect(msgs[0].message.content).toBe("this is a brief commentary note");
  });

  it("records final phase and filters by phase", () => {
    const ledger = new EvidenceLedger();
    ledger.recordPhaseMessage(message({ phase: "commentary", idempotency_key: "c1" }));
    ledger.recordPhaseMessage(message({ phase: "final", content: "final word", content_length_bytes: Buffer.byteLength("final word", "utf8"), idempotency_key: "f1" }));
    expect(ledger.getPhaseMessages("camp1", { phase: "commentary" })).toHaveLength(1);
    expect(ledger.getPhaseMessages("camp1", { phase: "final" })).toHaveLength(1);
    expect(ledger.getPhaseMessages("camp1")).toHaveLength(2);
  });

  it("enforces content length bound", () => {
    const ledger = new EvidenceLedger();
    const oversized = "x".repeat(PHASE_MESSAGE_MAX_CONTENT_BYTES + 1);
    expect(() => ledger.recordPhaseMessage(message({
      content: oversized,
      content_length_bytes: Buffer.byteLength(oversized, "utf8"),
      idempotency_key: "oversized",
    }))).toThrow(AuditIntegrityError);
  });

  it("rejects mismatched content_length_bytes", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordPhaseMessage(message({
      content: "hello",
      content_length_bytes: 999,
      idempotency_key: "bad_length",
    }))).toThrow(/content_length_bytes must match/);
  });

  it("enforces campaign-level bound", () => {
    const ledger = new EvidenceLedger();
    const max = PHASE_MESSAGE_MAX_PER_CAMPAIGN;
    for (let i = 0; i < max; i++) {
      ledger.recordPhaseMessage(message({
        content: `msg ${i}`,
        content_length_bytes: Buffer.byteLength(`msg ${i}`, "utf8"),
        idempotency_key: `bound:${i}`,
      }));
    }
    expect(ledger.getPhaseMessages("camp1")).toHaveLength(max);
    expect(() => ledger.recordPhaseMessage(message({
      content: "overflow",
      content_length_bytes: Buffer.byteLength("overflow", "utf8"),
      idempotency_key: "over_limit",
    }))).toThrow(/phase message limit/);
  });

  it("is idempotent on duplicate idempotency_key", () => {
    const ledger = new EvidenceLedger();
    const id1 = ledger.recordPhaseMessage(message({ idempotency_key: "dup" }));
    const id2 = ledger.recordPhaseMessage(message({ idempotency_key: "dup" }));
    expect(id1).toBe(id2);
    expect(ledger.getPhaseMessages("camp1")).toHaveLength(1);
  });

  it("rejects conflicting idempotency payload", () => {
    const ledger = new EvidenceLedger();
    const firstContent = "first content here";
    ledger.recordPhaseMessage(message({
      idempotency_key: "dup2",
      content: firstContent,
      content_length_bytes: Buffer.byteLength(firstContent, "utf8"),
    }));
    const secondContent = "second content here";
    expect(() => ledger.recordPhaseMessage(message({
      idempotency_key: "dup2",
      content: secondContent,
      content_length_bytes: Buffer.byteLength(secondContent, "utf8"),
    }))).toThrow(/conflicting phase message/);
  });

  it("respects query limit", () => {
    const ledger = new EvidenceLedger();
    for (let i = 0; i < 20; i++) {
      ledger.recordPhaseMessage(message({
        content: `m${i}`,
        content_length_bytes: Buffer.byteLength(`m${i}`, "utf8"),
        idempotency_key: `limit:${i}`,
      }));
    }
    expect(ledger.getPhaseMessages("camp1", { limit: 5 })).toHaveLength(5);
  });

  it("rejects invalid phase", () => {
    expect(() => validatePhaseMessage(message({ phase: "bogus" as any })))
      .toThrow(/phase must be commentary or final/);
  });

  it("integrity check validates phase messages", () => {
    const ledger = new EvidenceLedger();
    ledger.recordPhaseMessage(message());
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });
});

describe("PhaseMessage — empty content is rejected", () => {
  const ledger = new EvidenceLedger();

  it("rejects empty string content", () => {
    expect(() => ledger.recordPhaseMessage(message({
      content: "",
      content_length_bytes: 0,
      idempotency_key: "empty",
    }))).toThrow(/must be a non-empty string/);
  });
});

describe("phase message evidence-first — record before query", () => {
  it("query before any records returns empty", () => {
    const empty = new EvidenceLedger();
    expect(empty.getPhaseMessages("camp1")).toHaveLength(0);
  });
});
