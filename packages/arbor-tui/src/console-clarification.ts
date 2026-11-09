/** Shared display/dispatch identity for Console's plain-language reply box. */
export interface ConsoleClarification {
  readonly draft_id: string;
  readonly expected_revision: number;
  readonly question_id: string;
  readonly question: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectConsoleClarification(drafts: unknown): ConsoleClarification | null {
  if (!record(drafts) || !Array.isArray(drafts.items)) return null;
  const candidates = drafts.items.filter(record).filter((draft) => draft.status === "awaiting_clarification")
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  for (const draft of candidates) {
    if (typeof draft.id !== "string" || draft.id.trim().length === 0
      || typeof draft.revision !== "number" || !Number.isSafeInteger(draft.revision) || draft.revision < 0
      || !record(draft.proposal) || !Array.isArray(draft.proposal.questions)) continue;
    const question = draft.proposal.questions.find((value) => record(value) && value.answer === null);
    if (!record(question) || typeof question.id !== "string" || question.id.trim().length === 0
      || typeof question.question !== "string" || question.question.trim().length === 0) continue;
    return { draft_id: draft.id, expected_revision: draft.revision, question_id: question.id, question: question.question };
  }
  return null;
}
