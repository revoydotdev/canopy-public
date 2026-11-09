import { describe, expect, it } from "vitest";
import { C2_COMMAND_KINDS, C2_REPLY_A2A_STATE, C2_REPLY_KINDS, C2_TEXT_BOUNDS, answerSatisfiesClarify, validateC2Command, validateC2Reply, type C2Command, type C2Reply } from "../../src/comms/c2.js";
import { createSeededRng, hashSeed } from "../../src/search/rng.js";
import { COMMANDS, REFUSAL, REPLIES, clone } from "./fixtures.js";

const REQUIRED_COMMAND_FIELDS: Record<C2Command["kind"], string[]> = {
  "task.assign": ["kind", "command_id", "objective", "acceptance", "output_contract"],
  "task.amend": ["kind", "command_id", "instruction"],
  "task.halt": ["kind", "command_id", "mode", "reason_code"],
  "status.request": ["kind", "command_id"],
  "clarification.answer": ["kind", "command_id", "clarification_id", "action"],
};
const REQUIRED_REPLY_FIELDS: Record<C2Reply["kind"], string[]> = {
  ack: ["kind", "command_id"],
  decline: ["kind", "command_id", "remedy"],
  blocked: ["kind", "command_id", "needs", "detail"],
  clarify: ["kind", "command_id", "clarification_id", "question", "schema"],
  progress: ["kind", "command_id", "phase"],
  done: ["kind", "command_id", "result_summary", "evidence_refs", "provenance"],
  failed: ["kind", "command_id", "failure_class", "error", "evidence_refs"],
};

describe("C2 commands", () => {
  it("accept one valid command of every kind", () => {
    for (const kind of C2_COMMAND_KINDS) expect(validateC2Command(COMMANDS[kind])).toMatchObject({ ok: true });
  });

  it("refuse unknown fields, missing required fields and unknown kinds", () => {
    for (const kind of C2_COMMAND_KINDS) {
      expect(validateC2Command({ ...COMMANDS[kind], authority: "grant" }).ok).toBe(false);
      for (const field of REQUIRED_COMMAND_FIELDS[kind]) {
        const copy = clone(COMMANDS[kind]) as Record<string, unknown>;
        delete copy[field];
        expect({ kind, field, ok: validateC2Command(copy).ok }).toEqual({ kind, field, ok: false });
      }
    }
    for (const kind of ["task.approve", "task.promote", "authority.grant", "verify", "steer", ""]) {
      expect(validateC2Command({ kind, command_id: "c" }).ok).toBe(false);
    }
  });

  it("bound the free-text fields in UTF-8 bytes", () => {
    const at = (bytes: number) => "é".repeat(bytes / 2);
    const assign = (objective: string) => validateC2Command({ ...COMMANDS["task.assign"], objective });
    expect(assign(at(C2_TEXT_BOUNDS.objective)).ok).toBe(true);
    expect(assign(at(C2_TEXT_BOUNDS.objective) + "x").ok).toBe(false);
    const amend = (instruction: string) => validateC2Command({ ...COMMANDS["task.amend"], instruction });
    expect(amend(at(C2_TEXT_BOUNDS.instruction)).ok).toBe(true);
    expect(amend(at(C2_TEXT_BOUNDS.instruction) + "x").ok).toBe(false);
    expect(validateC2Command({ ...COMMANDS["task.halt"], note: "x".repeat(C2_TEXT_BOUNDS.halt_note + 1) }).ok).toBe(false);
    expect(validateC2Command({ ...COMMANDS["task.assign"], objective: "   " }).ok).toBe(false);
  });

  it("carry answer content with accept and only with accept", () => {
    const answer = COMMANDS["clarification.answer"];
    expect(validateC2Command({ ...answer, action: "decline", content: undefined }).ok).toBe(true);
    expect(validateC2Command({ kind: "clarification.answer", command_id: "c", clarification_id: "q", action: "cancel" }).ok).toBe(true);
    expect(validateC2Command({ ...answer, action: "decline" }).ok).toBe(false);
    expect(validateC2Command({ kind: "clarification.answer", command_id: "c", clarification_id: "q", action: "accept" }).ok).toBe(false);
    expect(validateC2Command({ ...answer, content: { nested: { a: 1 } } }).ok).toBe(false);
    expect(validateC2Command({ ...answer, content: { n: Number.NaN } }).ok).toBe(false);
  });
});

describe("C2 reply palette", () => {
  it("is closed: exactly ack, decline, blocked, clarify, progress, done, failed", () => {
    expect([...C2_REPLY_KINDS]).toEqual(["ack", "decline", "blocked", "clarify", "progress", "done", "failed"]);
    expect(Object.keys(C2_REPLY_A2A_STATE).sort()).toEqual([...C2_REPLY_KINDS].sort());
    for (const kind of C2_REPLY_KINDS) expect(validateC2Reply(REPLIES[kind])).toMatchObject({ ok: true });
    for (const kind of ["accept", "approve", "verified", "promote", "steer", "delegate", "grant", "completed", "Done", ""]) {
      expect({ kind, ok: validateC2Reply({ kind, command_id: "cmd-1" }).ok }).toEqual({ kind, ok: false });
    }
  });

  it("refuses unknown fields and missing required fields on every member", () => {
    for (const kind of C2_REPLY_KINDS) {
      expect(validateC2Reply({ ...REPLIES[kind], objective: "now do X" }).ok).toBe(false);
      for (const field of REQUIRED_REPLY_FIELDS[kind]) {
        const copy = clone(REPLIES[kind]) as Record<string, unknown>;
        delete copy[field];
        expect({ kind, field, ok: validateC2Reply(copy).ok }).toEqual({ kind, field, ok: false });
      }
    }
  });

  it("never lets done carry anything but claimed provenance", () => {
    const done = REPLIES.done;
    const stronger = [
      { tag: "verified", cmd: "bun run build", exit: 0, stdout_hash: "abc" },
      { tag: "critic_approved", critic: "lenticel", rationale: "looks right" },
      { tag: "generated", generator: "loop", input_hash: "h" },
      { tag: "verified", claimant: "n-child" },
      { tag: "critic_approved", claimant: "n-child" },
      { tag: "claimed", claimant: "" },
      { tag: "claimed", claimant: "n-child", verified: true },
    ];
    for (const provenance of stronger) expect(validateC2Reply({ ...done, provenance }).ok).toBe(false);
    expect(C2_REPLY_A2A_STATE.done).toBe("TASK_STATE_COMPLETED");
  });

  it("requires decline to carry an authorized ADR-179 v2 refused remedy", () => {
    expect(validateC2Reply({ ...REPLIES.decline, remedy: { ...REFUSAL, state: "unavailable" } }).ok).toBe(false);
    expect(validateC2Reply({ ...REPLIES.decline, remedy: { ...REFUSAL, correcting_actor: "specialist" } }).ok).toBe(false);
    expect(validateC2Reply({ ...REPLIES.decline, remedy: { ...REFUSAL, schema_version: 1 } }).ok).toBe(false);
    expect(validateC2Reply({ ...REPLIES.decline, remedy: { ...REFUSAL, extra: 1 } }).ok).toBe(false);
    expect(validateC2Reply({ ...REPLIES.decline, remedy: "no" }).ok).toBe(false);
  });

  it("restricts clarify to a flat elicitation schema", () => {
    const clarify = REPLIES.clarify as Extract<C2Reply, { kind: "clarify" }>;
    const withSchema = (schema: unknown) => validateC2Reply({ ...clarify, schema });
    expect(withSchema({ fields: { a: { type: "object" } }, required: [] }).ok).toBe(false);
    expect(withSchema({ fields: { a: { type: "string", nested: {} } }, required: [] }).ok).toBe(false);
    expect(withSchema({ fields: { a: { type: "enum", values: [] } }, required: [] }).ok).toBe(false);
    expect(withSchema({ fields: { a: { type: "string" } }, required: ["b"] }).ok).toBe(false);
    expect(withSchema({ fields: {}, required: [] }).ok).toBe(false);
  });

  it("matches an answer to its clarify by id, action and declared field types", () => {
    const clarify = REPLIES.clarify as Extract<C2Reply, { kind: "clarify" }>;
    const answer = COMMANDS["clarification.answer"] as Extract<C2Command, { kind: "clarification.answer" }>;
    expect(answerSatisfiesClarify(clarify, answer)).toBe(true);
    expect(answerSatisfiesClarify(clarify, { ...answer, clarification_id: "q-2" })).toBe(false);
    expect(answerSatisfiesClarify(clarify, { ...answer, content: { retries: 1 } })).toBe(false);
    expect(answerSatisfiesClarify(clarify, { ...answer, content: { target: "other" } })).toBe(false);
    expect(answerSatisfiesClarify(clarify, { ...answer, content: { target: "main", extra: true } })).toBe(false);
    expect(answerSatisfiesClarify(clarify, { ...answer, content: { target: "main", retries: "3" } })).toBe(false);
    expect(answerSatisfiesClarify(clarify, { kind: "clarification.answer", command_id: "c", clarification_id: "q-1", action: "cancel" })).toBe(true);
  });
});

describe("C2 validators under random mutation", () => {
  it("never throw, and never accept a value carrying an undeclared field", () => {
    const rng = createSeededRng(hashSeed("c2-schema-fuzz"));
    const samples: unknown[] = [...Object.values(COMMANDS), ...Object.values(REPLIES)];
    const junk: unknown[] = [null, 0, -1, 1e400, "", "x", true, [], {}, ["a"], { tag: "verified" }];
    for (let trial = 0; trial < 2000; trial++) {
      const base = clone(samples[rng.nextUint32() % samples.length]) as Record<string, unknown>;
      const keys = Object.keys(base);
      const op = rng.nextUint32() % 3;
      if (op === 0) base[keys[rng.nextUint32() % keys.length]] = junk[rng.nextUint32() % junk.length];
      else if (op === 1) delete base[keys[rng.nextUint32() % keys.length]];
      else base[`extra_${trial}`] = junk[rng.nextUint32() % junk.length];
      const command = validateC2Command(base);
      const reply = validateC2Reply(base);
      // An undeclared field is never accepted, whatever else the mutation did.
      expect(command.ok && Object.keys(base).some((key) => key.startsWith("extra_"))).toBe(false);
      expect(reply.ok && Object.keys(base).some((key) => key.startsWith("extra_"))).toBe(false);
    }
  });
});
