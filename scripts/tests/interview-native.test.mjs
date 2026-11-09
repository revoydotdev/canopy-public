/**
 * scripts/tests/interview-native.test.mjs — the owed-decision queue as a
 * question pack, and the writer that records verbatim answers bound to it.
 *
 * The property worth protecting: an answer reaches the ledger only as the
 * operator's own words, naming the exact pack and option it answered and the
 * native tool that carried the question — and once recorded, the queue reads
 * it exactly as it reads any other recorder-written record.
 *
 * Every test runs against a throwaway fixture repository (ADR-078); none
 * touches the real decisions/interviews.jsonl.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveDecisionQueue, readInterviews, interviewAttestation } from "../decision-queue.mjs";
import { deriveQuestionPack, questionPackDigest, verifyQuestionPack, MAX_OPTIONS_PER_QUESTION } from "../interview-pack.mjs";
import {
  buildInterviewPayload, recordInterviewFromAnswers, recordWitness, EGRESS_CHANNELS,
} from "../interview-record.mjs";
import { auditInterviewWitnesses, validateWitness, readRecordWitness, WITNESS_REQUIRED_AFTER } from "../lib/discharge-store.mjs";
import { readInterviewReceipts, canonicalRecordDigest } from "../lib/interview-receipts.mjs";
import { askInterviewPack } from "../../packages/arbor-harness/src/interview-pack.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TODAY = "2026-10-06";

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "interview-native-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "decisions"), { recursive: true });
  mkdirSync(join(dir, "docs/proposals"), { recursive: true });
  mkdirSync(join(dir, "scripts/interview"), { recursive: true });
  mkdirSync(join(dir, ".visual-intelligence/findings"), { recursive: true });
  writeFileSync(join(dir, "decisions/ADR-900-native-egress.md"),
    "# ADR-900: Native Egress\n\n**Status:** Proposed\n**Date:** 2026-10-01\n");
  writeFileSync(join(dir, "docs/proposals/operator-decisions-2026-09-01.md"), "## D1 — retire the old dashboard\n");
  // One orphaned triage row (its finding is gone) is an operator_call: due now.
  writeFileSync(join(dir, ".visual-intelligence/findings/findings.jsonl"), "");
  writeFileSync(join(dir, ".visual-intelligence/findings/triage.jsonl"), `${JSON.stringify({ finding_id: "vi:gone", verdict: "false_positive" })}\n`);
  writeFileSync(join(dir, "scripts/interview/baseline.json"), JSON.stringify({ records_historical_through: "2026-08-31" }));
  // An empty discharge store is the tracked "owes nothing yet" state; an ABSENT
  // one after a post-baseline interview is unexplained and blocks (ADR-137).
  writeFileSync(join(dir, "decisions/discharge-obligations.jsonl"), "");
  return dir;
}

const packFor = (repo, today = TODAY) => deriveQuestionPack(deriveDecisionQueue({ repo, today }));

const answersFor = (pack, answers, over = {}) => ({
  schema_version: 1,
  kind: "revoy2.interview_answers",
  pack_digest: pack.pack_digest,
  egress: { channel: "claude-code.AskUserQuestion", session_id: "session-abc", asked_at: `${TODAY}T14:00:00.000Z` },
  answers,
  ...over,
});

describe("deriveQuestionPack", () => {
  it("asks every owed item with at most four catalog options, recommended first, ordered by consequence", () => {
    const pack = packFor(fixture());
    const ids = pack.questions.map((q) => q.id);
    expect(ids).toEqual(["q:operator-decisions-2026-09-01:D1", "q:operator-call:vi-triage-orphans", "q:ADR-900"]);
    for (const question of pack.questions) {
      expect(question.recordable).toBe(true);
      expect(question.options.length).toBeGreaterThan(0);
      expect(question.options.length).toBeLessThanOrEqual(MAX_OPTIONS_PER_QUESTION);
      expect(question.options[0].recommended).toBe(true);
      expect(question.options.filter((o) => o.recommended)).toHaveLength(1);
      for (const option of question.options) {
        expect(option.consequence).toBeTruthy();
        expect(option.produces.ledger).toContain("decisions/interviews.jsonl");
      }
    }
    const call = pack.questions.find((q) => q.item_kind === "operator_call");
    expect(call.options[0].label).toBe("do the disposal now");
    expect(call.options.find((o) => o.label === "defer with a date").produces.requires_date).toBe(true);
  });

  it("is digested, deterministic, and refuses to verify once edited", () => {
    const repo = fixture();
    const pack = packFor(repo);
    expect(verifyQuestionPack(pack)).toBe(pack.pack_digest);
    expect(packFor(repo).pack_digest).toBe(pack.pack_digest);
    const edited = structuredClone(pack);
    edited.questions[0].question = "Shall we just accept everything?";
    expect(() => verifyQuestionPack(edited)).toThrow(/edited after derivation/);
    expect(questionPackDigest(edited)).not.toBe(pack.pack_digest);
  });

  it("asks a hazard as a recordable question with the catalog's hazard options, re-grounding first", () => {
    const pack = deriveQuestionPack({
      today: TODAY,
      hazards: [{ id: "hazard:ADR-041", cites: "ADR-041", status: "rejected", dependents: ["w1"], earliest_due: "2026-10-09", detail: "ADR-041 is REJECTED" }],
    });
    const [question] = pack.questions;
    expect(question).toMatchObject({ id: "q:hazard:ADR-041", item_kind: "hazard", recordable: true });
    expect(question.not_recordable_reason).toBeUndefined();
    expect(question.options.map((o) => o.label)).toEqual(["re-ground the commitments", "accept the cited record", "defer with a date"]);
    expect(question.options[0].recommended).toBe(true);
    expect(question.options[0].produces.discharge_obligation).toMatch(/cite a record that governs/);
    expect(question.options[2].produces).toMatchObject({ discharge_obligation: null, requires_date: true });
    const payload = buildInterviewPayload(pack, answersFor(pack, [{ question_id: "q:hazard:ADR-041", selected: "re-ground the commitments", verbatim: "re-justify w1 on ADR-178" }]));
    expect(payload.answers).toEqual([{ itemId: "hazard:ADR-041", itemKind: "hazard", option: "re-ground the commitments", outcome: "re-justify w1 on ADR-178" }]);
  });
});

describe("interview-record", () => {
  it("records verbatim answers bound to the pack and egress, attested, and the queue reads them as coverage", () => {
    const repo = fixture();
    expect(deriveDecisionQueue({ repo, today: TODAY }).ok).toBe(false);
    const pack = packFor(repo);
    const answers = answersFor(pack, [
      { question_id: "q:operator-decisions-2026-09-01:D1", selected: "schedule it (Recommended)", verbatim: "Schedule it for the November cleanup." },
      { question_id: "q:operator-call:vi-triage-orphans", selected: "retain deliberately, with the reason", verbatim: "Retain: the rows document a past verdict." },
    ]);
    const { interviewRecord, obligations } = recordInterviewFromAnswers(repo, { pack, answers });
    expect(obligations).toEqual([]);
    expect(interviewRecord.held_at).toBe(TODAY);
    expect(interviewRecord.outcomes["operator-decisions-2026-09-01:D1"]).toBe("Schedule it for the November cleanup.");
    // The witness is a structured, schema-valid field — not a line in `note`.
    expect(interviewRecord.witness).toEqual({
      schema_version: 1,
      egress: answers.egress,
      pack_digest: pack.pack_digest,
      questions: ["q:operator-decisions-2026-09-01:D1", "q:operator-call:vi-triage-orphans"],
    });
    expect(validateWitness(interviewRecord.witness)).toEqual([]);
    expect(interviewRecord.note).toBeUndefined();

    // Schema-valid for every ledger reader: covered is string[], outcomes is string->string.
    const [row] = readInterviews(repo);
    expect(row.covered.every((id) => typeof id === "string")).toBe(true);
    expect(Object.values(row.outcomes).every((v) => typeof v === "string")).toBe(true);
    // Attested by the ADR-158 receipt, which digests the witness too.
    const { receipts } = readInterviewReceipts(repo);
    expect(receipts.map((r) => r.record_digest)).toContain(canonicalRecordDigest(row));
    const attestation = interviewAttestation(repo, [row]);
    expect(attestation.active).toBe(true);
    expect(attestation.isAttested(row)).toBe(true);

    const after = deriveDecisionQueue({ repo, today: TODAY });
    expect(after.over_age).toEqual([]);
    expect(after.operator_calls).toEqual([]);
    expect(after.ok).toBe(true);
  });

  it("queues the discharge obligation an answer declares, through the same writer", () => {
    const repo = fixture();
    const pack = packFor(repo);
    const { obligations } = recordInterviewFromAnswers(repo, {
      pack,
      answers: answersFor(pack, [{ question_id: "q:ADR-900", selected: "accept", verbatim: "accept" }]),
    });
    expect(obligations.map((o) => o.id)).toEqual(["discharge:ADR-900"]);
  });

  it("records a dated deferral that covers until its date and then returns the item", () => {
    const repo = fixture();
    const pack = packFor(repo);
    recordInterviewFromAnswers(repo, {
      pack,
      answers: answersFor(pack, [{ question_id: "q:operator-call:vi-triage-orphans", selected: "defer with a date", verbatim: "Not now; ask again on the 20th.", deferred_to: "2026-10-20" }]),
    });
    expect(deriveDecisionQueue({ repo, today: "2026-10-19" }).operator_calls).toEqual([]);
    expect(deriveDecisionQueue({ repo, today: "2026-10-21" }).operator_calls.map((c) => c.id)).toEqual(["operator-call:vi-triage-orphans"]);
  });

  describe("refuses before writing anything", () => {
    const cases = [
      ["a missing verbatim answer", (p) => answersFor(p, [{ question_id: "q:ADR-900", selected: "accept", verbatim: "  " }]), /no verbatim answer/],
      ["answers bound to a different pack", (p) => answersFor(p, [{ question_id: "q:ADR-900", selected: "accept", verbatim: "accept" }], { pack_digest: "sha256:0000" }), /bound to sha256:0000/],
      ["an undeclared egress", (p) => answersFor(p, [{ question_id: "q:ADR-900", selected: "accept", verbatim: "accept" }], { egress: { channel: "chat.prose", session_id: "s", asked_at: `${TODAY}T00:00:00Z` } }), /not a declared native question tool/],
      ["an egress with no session id", (p) => answersFor(p, [{ question_id: "q:ADR-900", selected: "accept", verbatim: "accept" }], { egress: { channel: EGRESS_CHANNELS[0], session_id: "", asked_at: `${TODAY}T00:00:00Z` } }), /session_id is required/],
      ["an option that was not offered", (p) => answersFor(p, [{ question_id: "q:ADR-900", selected: "approve", verbatim: "approve" }]), /not one of the options asked/],
      ["a question not in the pack", (p) => answersFor(p, [{ question_id: "q:ADR-999", selected: "accept", verbatim: "accept" }]), /not in pack/],
      ["a question answered twice", (p) => answersFor(p, [{ question_id: "q:ADR-900", selected: "accept", verbatim: "accept" }, { question_id: "q:ADR-900", selected: "reject", verbatim: "reject" }]), /answered twice/],
      ["a dated option with no date", (p) => answersFor(p, [{ question_id: "q:operator-call:vi-triage-orphans", selected: "defer with a date", verbatim: "later" }]), /needs deferred_to/],
      ["a dated option dated before the interview", (p) => answersFor(p, [{ question_id: "q:ADR-900", selected: "keep proposed with a review date", verbatim: "keep it", deferred_to: "2026-10-01" }]), /needs deferred_to/],
      ["an empty answer set", (p) => answersFor(p, []), /non-empty/],
    ];
    for (const [name, build, pattern] of cases) {
      it(name, () => {
        const repo = fixture();
        const pack = packFor(repo);
        expect(() => recordInterviewFromAnswers(repo, { pack, answers: build(pack) })).toThrow(pattern);
        expect(readInterviews(repo)).toEqual([]);
      });
    }

    it("a pack edited after derivation, even with answers re-pointed at its new digest", () => {
      const repo = fixture();
      const pack = packFor(repo);
      const edited = structuredClone(pack);
      edited.questions[0].question = "Something the operator never saw";
      expect(() => buildInterviewPayload(edited, answersFor(edited, [{ question_id: edited.questions[0].id, selected: "do it now", verbatim: "yes" }]))).toThrow(/edited after derivation/);
      expect(readInterviews(repo)).toEqual([]);
    });

    it("an unrecordable question", () => {
      const pack = deriveQuestionPack({ today: TODAY, over_age: [{ id: "x:1", kind: "no_such_kind", summary: "s" }] });
      expect(pack.questions[0].recordable).toBe(false);
      expect(() => buildInterviewPayload(pack, answersFor(pack, [{ question_id: "q:x:1", selected: "accept", verbatim: "accept" }]))).toThrow(/not recordable/);
    });
  });

  it("records what arbor's native human-input port asked, end to end", async () => {
    const repo = fixture();
    const pack = packFor(repo);
    const replies = ["2 — put it in the November slot", "retain deliberately, with the reason: history", "accept"];
    const port = { async request() { return { kind: "submitted", response: replies.shift(), provenance: { tag: "claimed", claimant: "operator" } }; } };
    const { answers, unanswered } = await askInterviewPack(pack, port, { session_id: "canopy-7", now: () => new Date(`${TODAY}T09:00:00.000Z`) });
    expect(unanswered).toEqual([]);
    const { interviewRecord } = recordInterviewFromAnswers(repo, { pack, answers });
    expect(recordWitness(interviewRecord).egress.channel).toBe("arbor.native.human_input");
    expect(interviewRecord.outcomes["operator-decisions-2026-09-01:D1"]).toBe("2 — put it in the November slot");
    const after = deriveDecisionQueue({ repo, today: TODAY });
    expect(after.over_age).toEqual([]);
    expect(after.operator_calls).toEqual([]);
    expect(after.flagged_proposed).toEqual([]);
    // "accept" is recorded, not performed: its discharge (adr:accept) is now owed.
    expect(after.due_soon.map((i) => i.id)).toEqual(["discharge:ADR-900"]);
  });

  it("the CLI's --dry-run validates and prints the payload without writing", () => {
    const repo = fixture();
    const pack = packFor(repo);
    const packPath = join(repo, "pack.json");
    const answersPath = join(repo, "answers.json");
    writeFileSync(packPath, JSON.stringify(pack));
    writeFileSync(answersPath, JSON.stringify(answersFor(pack, [{ question_id: "q:ADR-900", selected: "accept", verbatim: "accept it" }])));
    const out = execFileSync("bun", [join(ROOT, "scripts/interview-record.mjs"), "--pack", packPath, "--answers", answersPath, "--repo", repo, "--dry-run"], { encoding: "utf8" });
    expect(JSON.parse(out).answers).toEqual([{ itemId: "ADR-900", itemKind: "proposed_record", option: "accept", outcome: "accept it" }]);
    expect(readFileSync(join(repo, "decisions/ADR-900-native-egress.md"), "utf8")).toContain("Proposed");
    expect(readInterviews(repo)).toEqual([]);
  });
});

describe("the witness as a structured field (ADR-178)", () => {
  it("keeps the operator's note on the record, outside the witness binding", () => {
    const repo = fixture();
    const pack = packFor(repo);
    const { interviewRecord } = recordInterviewFromAnswers(repo, {
      pack,
      answers: answersFor(pack, [{ question_id: "q:ADR-900", selected: "accept", verbatim: "accept" }], { note: "asked at the end of the session" }),
    });
    expect(interviewRecord.note).toBe("asked at the end of the session");
    expect(Object.keys(interviewRecord.witness).sort()).toEqual(["egress", "pack_digest", "questions", "schema_version"]);
  });

  it("reads a legacy `witness:v1` note as the same binding, so old records stay readable", () => {
    const binding = { egress: { channel: EGRESS_CHANNELS[0], session_id: "s", asked_at: `${TODAY}T00:00:00Z` }, pack_digest: `sha256:${"b".repeat(64)}`, questions: ["q:ADR-900"] };
    const found = readRecordWitness({ held_at: TODAY, note: `witness:v1 ${JSON.stringify({ ...binding, note: "prose" })}` });
    expect(found).toEqual({ witness: { schema_version: 1, ...binding }, legacy: true });
    expect(validateWitness(found.witness)).toEqual([]);
    expect(readRecordWitness({ held_at: TODAY, note: "an ordinary note" })).toBeNull();
  });

  it("auditInterviewWitnesses reports only post-cutoff records with no valid witness, and undated ones", () => {
    const witness = { schema_version: 1, egress: { channel: EGRESS_CHANNELS[1], session_id: "s", asked_at: "2026-10-08T00:00:00Z" }, pack_digest: `sha256:${"c".repeat(64)}`, questions: ["q:A"] };
    const violations = auditInterviewWitnesses([
      { held_at: WITNESS_REQUIRED_AFTER, covered: ["A"] },
      { held_at: "2026-10-08", covered: ["A"], witness },
      { held_at: "2026-10-08", covered: ["B"] },
      { covered: ["C"], witness },
      { held_at: "2026-10-08", covered: ["D"], witness: { ...witness, questions: ["q:A", "q:A"] } },
    ]);
    expect(violations.map((v) => [v.line, v.errors[0]])).toEqual([
      [3, "record carries no witness"],
      [4, "record carries no held_at, so it cannot be dated against the witness cutoff"],
      [5, "witness.questions names a question twice"],
    ]);
  });

  it("the low-level writer refuses a post-cutoff payload that carries no witness", () => {
    const repo = fixture();
    const payload = join(repo, "payload.json");
    const after = "2026-10-07";
    expect(after > WITNESS_REQUIRED_AFTER).toBe(true);
    writeFileSync(payload, JSON.stringify({ heldAt: after, answers: [{ itemId: "ADR-900", itemKind: "proposed_record", option: "accept", outcome: "accept" }] }));
    const run = spawnSync("bun", [join(ROOT, "scripts/record-interview.mjs"), payload], { cwd: repo, encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/needs a witness \(ADR-178\)/);
    expect(readInterviews(repo)).toEqual([]);
  });
});

describe("one obvious entry point", () => {
  it("`bun run interview:record` is the native recorder and `interview:pack` derives what it records against", () => {
    const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(scripts["interview:record"]).toBe("bun scripts/interview-record.mjs");
    expect(scripts["interview:pack"]).toBe("bun scripts/interview-pack.mjs");
    expect(Object.values(scripts).some((command) => command.includes("record-interview.mjs"))).toBe(false);
  });
});
