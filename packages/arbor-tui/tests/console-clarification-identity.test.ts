import { describe, expect, it } from "vitest";
import { selectConsoleClarification } from "../src/console-clarification.js";
import { consoleScreen } from "../src/screens/console.js";

const questions = [
  { id: "dependencies", question: "Which dependencies are installed?", answer: null },
  { id: "fonts", question: "Which font strategy?", answer: null },
  { id: "events", question: "How many events?", answer: null },
];
const draft = { id: "draft-1", revision: 6, status: "awaiting_clarification", updated_at: "2026-09-05T10:00:00Z", proposal: { questions } };

describe("Console displayed/submitted clarification identity", () => {
  it("displays the first unanswered question selected for submission, not the last attention event", () => {
    const drafts = { items: [draft] };
    const target = selectConsoleClarification(drafts);
    expect(target).toEqual({ draft_id: "draft-1", expected_revision: 6, question_id: "dependencies", question: questions[0].question });
    const size = { width: 120, height: 24 };
    const projection = consoleScreen.project({ captured_at: "2026-09-05T10:00:00Z", drafts, sidebar_visibility: "hidden" }, size);
    expect(projection.rows.find((row) => row.region === "attention")?.label).toBe(`QUESTION · ${target!.question}`);
  });

  it("uses the latest draft and advances only past answered questions", () => {
    const later = { ...draft, id: "draft-2", revision: 7, updated_at: "2026-09-05T11:00:00Z",
      proposal: { questions: [{ ...questions[0], answer: "None" }, questions[1], questions[2]] } };
    expect(selectConsoleClarification({ items: [draft, later] }))
      .toEqual({ draft_id: "draft-2", expected_revision: 7, question_id: "fonts", question: questions[1].question });
  });

  it("does not invent a target for malformed, inactive, or fully answered drafts", () => {
    for (const value of [null, {}, { items: [{ ...draft, revision: NaN }] }, { items: [{ ...draft, status: "failed" }] },
      { items: [{ ...draft, proposal: { questions: questions.map((question) => ({ ...question, answer: "answered" })) } }] }]) {
      expect(selectConsoleClarification(value)).toBeNull();
    }
  });
});
