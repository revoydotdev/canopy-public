import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceLedger, AuditIntegrityError, validateRequestUserInput, validateUserInputAnswer } from "../src/index.js";

const baseInput = {
  operation_id: "op-1",
  question: "Proceed with the refactor?",
  options: [
    { id: "proceed", text: "Proceed", is_other: false },
    { id: "pivot", text: "Pivot", is_other: false, follow_up: { text: "pivot to greenfield", kind: "steer" as const } },
  ],
  authority: "lead" as const,
  blocking: "blocking" as const,
  requester_role: "taproot",
  idempotency_key: "idem-1",
  as_of: "2026-08-03T00:00:00.000Z",
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("EvidenceLedger request_user_input", () => {
  it("records an awaiting request, hash-chained, and reconciles awaiting=true", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordRequestUserInput({ campaign_id: "c1", node_id: "root", ...baseInput });
    expect(id).toMatch(/^userinput_/);
    const records = ledger.getRequestUserInputs("c1");
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("awaiting");
    expect(records[0].answer).toBeNull();
    expect(records[0].content_hash).toBeTruthy();
    expect(ledger.awaitingUserInput("c1")).toBe(true);
  });

  it("is idempotent on idempotency_key; different payload conflicts", () => {
    const ledger = new EvidenceLedger();
    const a = ledger.recordRequestUserInput({ campaign_id: "c1", node_id: "root", ...baseInput });
    const b = ledger.recordRequestUserInput({ campaign_id: "c1", node_id: "root", ...baseInput });
    expect(b).toBe(a);
    expect(ledger.getRequestUserInputs("c1")).toHaveLength(1);
    expect(() => ledger.recordRequestUserInput({
      campaign_id: "c1", node_id: "root", ...baseInput, question: "DIFFERENT QUESTION",
    })).toThrow(AuditIntegrityError);
  });

  it("answers an awaiting record by appending (approve-from-ledger) and flips awaiting=false", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordRequestUserInput({ campaign_id: "c1", node_id: "root", ...baseInput });
    expect(ledger.awaitingUserInput("c1")).toBe(true);
    ledger.recordUserInputAnswer({
      campaign_id: "c1", node_id: "root", question_record_id: id,
      answer: { option_id: "proceed", custom_text: "", answered_by: "human", answered_at: "2026-08-03T00:05:00.000Z" },
    });
    expect(ledger.awaitingUserInput("c1")).toBe(false);
    expect(ledger.getUserInputAnswers("c1", id)).toHaveLength(1);
    expect(ledger.getUserInputAnswers("c1", id)[0].answer.option_id).toBe("proceed");
    // a second identical answer is idempotent; a different one conflicts
    expect(() => ledger.recordUserInputAnswer({
      campaign_id: "c1", node_id: "root", question_record_id: id,
      answer: { option_id: "pivot", custom_text: "", answered_by: "human", answered_at: "2026-08-03T00:06:00.000Z" },
    })).toThrow(AuditIntegrityError);
  });

  it("hash-chain integrity survives; tamper is detected on replay", () => {
    const ledger = new EvidenceLedger();
    ledger.recordRequestUserInput({ campaign_id: "c1", node_id: "root", ...baseInput });
    ledger.recordRequestUserInput({
      campaign_id: "c1", node_id: "root", operation_id: "op-2", idempotency_key: "idem-2", as_of: "2026-08-03T00:01:00.000Z",
      question: "Second?", options: [{ id: "a", text: "A", is_other: false }], authority: "lead", blocking: "async", requester_role: "taproot",
    });
    expect(ledger.verifyIntegrity().valid).toBe(true);
    // tamper a row via its JSONL serialization (mutating the ledger's own rows)
    const rows = ledger.toJSONL().split("\n");
    const altered = JSON.parse(rows[1]) as { content_hash: string };
    altered.content_hash = "deadbeef";
    rows[1] = JSON.stringify(altered);
    const tampered = new EvidenceLedger();
    tampered.fromJSONL(rows.join("\n"));
    expect(tampered.verifyIntegrity().valid).toBe(false);
  });

  it("getRequestUserInputs filters by node", () => {
    const ledger = new EvidenceLedger();
    ledger.recordRequestUserInput({ campaign_id: "c1", node_id: "root", ...baseInput });
    expect(ledger.getRequestUserInputs("c1", "root")).toHaveLength(1);
    expect(ledger.getRequestUserInputs("c1", "other-node")).toHaveLength(0);
  });
});

describe("validateRequestUserInput / validateUserInputAnswer", () => {
  it("accepts a valid lead blocking question", () => {
    expect(() => validateRequestUserInput({ campaign_id: "c1", node_id: "root", ...baseInput })).not.toThrow();
  });

  it("rejects bad authority / blocking / oversized question / bad options", () => {
    const bad = (patch: Record<string, unknown>) => validateRequestUserInput({ campaign_id: "c1", node_id: "root", ...baseInput, ...patch });
    expect(() => bad({ authority: "nobody" })).toThrow(AuditIntegrityError);
    expect(() => bad({ blocking: "maybe" })).toThrow(AuditIntegrityError);
    expect(() => bad({ question: "" })).toThrow(AuditIntegrityError);
    expect(() => bad({ question: "x".repeat(5000) })).toThrow(AuditIntegrityError);
    expect(() => bad({ options: [] })).toThrow(AuditIntegrityError);
    expect(() => bad({ options: [{ id: "a", text: "A", is_other: false }, { id: "a", text: "dup", is_other: false }] }))
      .toThrow(AuditIntegrityError);
  });

  it("is persisted and restored with the answer intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-"));
    dirs.push(dir);
    const { saveLedger, loadLedger } = await import("../src/persist.js");
    const ledger = new EvidenceLedger();
    const id = ledger.recordRequestUserInput({ campaign_id: "c1", node_id: "root", ...baseInput });
    ledger.recordUserInputAnswer({
      campaign_id: "c1", node_id: "root", question_record_id: id,
      answer: { option_id: "proceed", custom_text: "", answered_by: "human", answered_at: "2026-08-03T00:05:00.000Z" },
    });
    saveLedger(ledger, dir, "c1");
    const restored = loadLedger(dir, "c1");
    expect(restored.getRequestUserInputs("c1")).toHaveLength(1);
    expect(restored.getUserInputAnswers("c1", id)).toHaveLength(1);
    expect(restored.getUserInputAnswers("c1", id)[0].answer.option_id).toBe("proceed");
    expect(restored.awaitingUserInput("c1")).toBe(false);
  });

  it("validateUserInputAnswer requires option or text and a parseable time", () => {
    const good = { option_id: "a", custom_text: "", answered_by: "human", answered_at: "2026-08-03T00:00:00.000Z" };
    expect(() => validateUserInputAnswer(good)).not.toThrow();
    expect(() => validateUserInputAnswer({ option_id: null, custom_text: "", answered_by: "human", answered_at: "2026-08-03T00:00:00.000Z" })).toThrow(AuditIntegrityError);
    expect(() => validateUserInputAnswer({ ...good, answered_at: "not-a-date" })).toThrow(AuditIntegrityError);
  });
});

describe("answeredQuestionIds — the one reconciliation both surfaces share", () => {
  it("names exactly the answered questions, and agrees with awaitingUserInput", () => {
    const ledger = new EvidenceLedger();
    const first = ledger.recordRequestUserInput({ campaign_id: "c1", node_id: "root", ...baseInput });
    const second = ledger.recordRequestUserInput({
      campaign_id: "c1", node_id: "root", ...baseInput, idempotency_key: "idem-2", question: "Second?",
    });
    expect(ledger.answeredQuestionIds("c1")).toEqual([]);
    expect(ledger.awaitingUserInput("c1")).toBe(true);

    ledger.recordUserInputAnswer({
      campaign_id: "c1", node_id: "root", question_record_id: second,
      answer: { option_id: "proceed", custom_text: "", answered_by: "human", answered_at: "2026-08-03T00:05:00.000Z" },
    });
    // The newer question is answered while the older is not — the case the
    // interviews screen used to get wrong by taking the newest record outright.
    expect(ledger.answeredQuestionIds("c1")).toEqual([second]);
    expect(ledger.awaitingUserInput("c1")).toBe(true);

    ledger.recordUserInputAnswer({
      campaign_id: "c1", node_id: "root", question_record_id: first,
      answer: { option_id: "proceed", custom_text: "", answered_by: "human", answered_at: "2026-08-03T00:06:00.000Z" },
    });
    expect(ledger.answeredQuestionIds("c1")).toEqual([first, second]);
    expect(ledger.awaitingUserInput("c1")).toBe(false);

    // ...while the records themselves still read as they were hashed.
    const records = ledger.getRequestUserInputs("c1");
    expect(records.map((r) => r.status)).toEqual(["awaiting", "awaiting"]);
    expect(records.map((r) => r.answer)).toEqual([null, null]);
  });
});
