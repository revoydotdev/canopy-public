/**
 * interview-selection.test.ts — the operator is never handed a question they
 * have already answered.
 *
 * THE DEFECT THIS CLOSES. A `request_user_input` record's `status` is frozen at
 * `"awaiting"` and its `answer` at `null` for the life of the ledger: ADR-019
 * appends the answer as a SEPARATE record rather than mutating a hash-covered
 * packet. So `status === "awaiting"` matches every question ever asked, and
 * `latestInterview` compensated by taking the newest question outright.
 *
 * That is right only while something is genuinely pending. Once the newest
 * question was answered, the interviews screen kept presenting it as the live
 * target — an operator with nothing to do was shown a question they had already
 * answered, and the two query surfaces disagreed: `userinput.awaiting` said
 * false while this selection still named a target.
 *
 * `userinput.list` now carries `answered_record_ids`, the ledger's own
 * reconciliation, so the newest UNANSWERED question can be chosen directly.
 */

import { describe, expect, it } from "vitest";
import { latestInterview } from "../src/index.js";

function question(id: string, text: string) {
  return {
    id,
    question: { operation_id: `ask:${id}`, question: text, authority: "lead", blocking: "blocking", requester_role: "taproot" },
    status: "awaiting",
    answer: null,
  };
}

const projection = (answered: string[]) => ({
  campaign_id: "c1",
  records: [question("userinput_1", "First?"), question("userinput_2", "Second?")],
  answered_record_ids: answered,
});

describe("latestInterview", () => {
  it("returns null when every question has been answered", () => {
    // The defect: this used to return "Second?" — status is "awaiting" on both
    // records forever, so nothing in the record itself says otherwise.
    expect(latestInterview(projection(["userinput_1", "userinput_2"]))).toBeNull();
  });

  it("skips a newer answered question to reach the older pending one", () => {
    // Not merely "return the last record": the newest question is answered and
    // the older one is not, so the older one is the live target.
    expect(latestInterview(projection(["userinput_2"]))).toMatchObject({
      record_id: "userinput_1",
      question: "First?",
    });
  });

  it("returns the newest question when nothing is answered", () => {
    // A fix that always returned null, or always reached backwards, would pass
    // the cases above and break the ordinary one.
    expect(latestInterview(projection([]))).toMatchObject({
      record_id: "userinput_2",
      question: "Second?",
    });
  });

  it("preserves operator-facing option text alongside the durable option id", () => {
    const base = question("userinput_choice", "Which format?");
    const candidate = {
      ...base,
      question: {
        ...base.question,
        options: [
          { id: "text", text: "Text (recommended)", is_other: false },
          { id: "json", text: "JSON", is_other: false },
        ],
      },
    };
    expect(latestInterview({ records: [candidate], answered_record_ids: [] })).toMatchObject({
      record_id: "userinput_choice",
      options: [
        { id: "text", text: "Text (recommended)", is_other: false },
        { id: "json", text: "JSON", is_other: false },
      ],
    });
  });

  it("honors a selected still-pending question, then falls back when the selection is no longer live", () => {
    expect(latestInterview(projection([]), "userinput_1")).toMatchObject({ record_id: "userinput_1", question: "First?" });
    expect(latestInterview(projection(["userinput_1"]), "userinput_1")).toMatchObject({ record_id: "userinput_2", question: "Second?" });
  });

  it("treats a projection without answered_record_ids as nothing-answered", () => {
    // Degradation, not blanking: an older projection keeps the previous
    // behaviour rather than reporting an empty interview queue.
    expect(latestInterview({ campaign_id: "c1", records: projection([]).records }))
      .toMatchObject({ record_id: "userinput_2" });
  });

  it("ignores malformed entries rather than selecting them", () => {
    expect(latestInterview({ records: [question("userinput_1", "First?"), { nope: true }], answered_record_ids: [] }))
      .toMatchObject({ record_id: "userinput_1" });
    expect(latestInterview({ records: [] })).toBeNull();
    expect(latestInterview(null)).toBeNull();
  });
});
