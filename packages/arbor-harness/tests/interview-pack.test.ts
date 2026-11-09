import { describe, expect, it } from "vitest";
import {
  askInterviewPack,
  parseInterviewChoice,
  renderInterviewQuestion,
  type InterviewPackQuestion,
  type InterviewQuestionPack,
} from "../src/interview-pack.js";
import type { NativeHumanInputPort, NativeHumanInputRequest, NativeHumanInputResult } from "../src/inference.js";

/**
 * The governance interview's native egress: a question pack asked through the
 * human-input port. The operator's reply must survive verbatim (it is the
 * witness the recorder binds to the pack digest), and nothing may be invented
 * when the port cannot produce a real answer.
 */
const option = (label: string, recommended = false, requiresDate = false) => ({
  label,
  recommended,
  consequence: `consequence of ${label}`,
  produces: { requires_date: requiresDate },
});

const question = (id: string, options = [option("accept", true), option("reject"), option("keep proposed with a review date", false, true)]): InterviewPackQuestion => ({
  id,
  item_ids: [id.replace(/^q:/, "")],
  item_kind: "proposed_record",
  header: "Proposed",
  question: `What is the decision on ${id}?`,
  gate_effect: "blocking",
  recordable: true,
  options,
});

const pack = (questions: InterviewPackQuestion[]): InterviewQuestionPack => ({
  schema_version: 1,
  kind: "revoy2.interview_question_pack",
  derived_at: "2026-10-06",
  questions,
  pack_digest: "sha256:abc",
});

const human = { tag: "claimed", claimant: "operator" } as const;

function scriptedPort(replies: NativeHumanInputResult[]): NativeHumanInputPort & { asked: NativeHumanInputRequest[] } {
  const asked: NativeHumanInputRequest[] = [];
  return {
    asked,
    async request(request) {
      asked.push(request);
      const next = replies.shift();
      if (next === undefined) throw new Error("port asked more questions than scripted");
      return next;
    },
  };
}

const now = () => new Date("2026-10-06T14:00:00.000Z");

describe("renderInterviewQuestion", () => {
  it("puts the question and every option, in pack order, into one human-input request bound to the pack digest", () => {
    const request = renderInterviewQuestion(question("q:ADR-900"), "sha256:abc");
    expect(request.request_id).toBe("q:ADR-900@sha256:abc");
    expect(request.question).toContain("What is the decision on q:ADR-900?");
    expect(request.question).toMatch(/1\. accept \(recommended\)[\s\S]*2\. reject[\s\S]*3\. keep proposed with a review date .*YYYY-MM-DD/);
    expect(request.evidence).toEqual([]);
  });
});

describe("parseInterviewChoice", () => {
  const q = question("q:ADR-900", [option("fix", true), option("fix later"), option("re-attest")]);
  it("accepts a number, a bare label, or a label followed by the operator's words", () => {
    expect(parseInterviewChoice(q, "2")?.label).toBe("fix later");
    expect(parseInterviewChoice(q, "RE-ATTEST")?.label).toBe("re-attest");
    expect(parseInterviewChoice(q, "fix — the guard is dead")?.label).toBe("fix");
    expect(parseInterviewChoice(q, "fix later, after the release")?.label).toBe("fix later");
  });
  it("names nothing for a reply that chose none of the options", () => {
    expect(parseInterviewChoice(q, "9")).toBeNull();
    expect(parseInterviewChoice(q, "fixation")).toBeNull();
    expect(parseInterviewChoice(q, "whatever you think")).toBeNull();
  });
});

describe("askInterviewPack", () => {
  it("returns an answers document in the recorder's shape, keeping each reply verbatim", async () => {
    const port = scriptedPort([
      { kind: "submitted", response: "1 — ship it", provenance: human },
      { kind: "submitted", response: "keep proposed with a review date 2026-10-20", provenance: human },
    ]);
    const result = await askInterviewPack(pack([question("q:ADR-900"), question("q:ADR-901")]), port, { session_id: "canopy-1", now });
    expect(port.asked).toHaveLength(2);
    expect(result.unanswered).toEqual([]);
    expect(result.answers).toEqual({
      schema_version: 1,
      kind: "revoy2.interview_answers",
      pack_digest: "sha256:abc",
      egress: { channel: "arbor.native.human_input", session_id: "canopy-1", asked_at: "2026-10-06T14:00:00.000Z" },
      answers: [
        { question_id: "q:ADR-900", selected: "accept", verbatim: "1 — ship it", provenance_tag: "claimed" },
        { question_id: "q:ADR-901", selected: "keep proposed with a review date", verbatim: "keep proposed with a review date 2026-10-20", deferred_to: "2026-10-20", provenance_tag: "claimed" },
      ],
    });
  });

  it("stops at a handoff and invents nothing for the questions it could not ask", async () => {
    const port = scriptedPort([{ kind: "handoff", reason: "operator away" }]);
    const result = await askInterviewPack(pack([question("q:ADR-900"), question("q:ADR-901")]), port, { session_id: "canopy-1", now });
    expect(port.asked).toHaveLength(1);
    expect(result.answers).toBeNull();
    expect(result.unanswered.map((u) => u.question_id)).toEqual(["q:ADR-900", "q:ADR-901"]);
    expect(result.unanswered[1]?.reason).toMatch(/handoff: operator away/);
  });

  it("leaves a question open when the reply names no option, or a dated option carries no date", async () => {
    const port = scriptedPort([
      { kind: "submitted", response: "not sure yet", provenance: human },
      { kind: "submitted", response: "3", provenance: human },
    ]);
    const result = await askInterviewPack(pack([question("q:ADR-900"), question("q:ADR-901")]), port, { session_id: "canopy-1", now });
    expect(result.answers).toBeNull();
    expect(result.unanswered).toEqual([
      { question_id: "q:ADR-900", reason: "reply named none of the offered options" },
      { question_id: "q:ADR-901", reason: "\"keep proposed with a review date\" needs a date and the reply carried none" },
    ]);
  });

  it("never asks a question the pack marks unrecordable", async () => {
    const port = scriptedPort([]);
    const result = await askInterviewPack(pack([{ ...question("q:hazard:ADR-041", []), recordable: false }]), port, { session_id: "canopy-1", now });
    expect(port.asked).toEqual([]);
    expect(result.unanswered[0]?.reason).toMatch(/unrecordable/);
  });
});
