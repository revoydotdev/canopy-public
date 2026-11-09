import { wrapDisplay } from "./widgets.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ConsolePlanPreview {
  readonly planning: boolean;
  readonly summary: string;
  readonly actions: readonly string[];
  readonly checks: readonly string[];
  readonly assumptions: readonly string[];
  readonly unanswered: number;
}

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  : [];

/** Only canonical draft proposals supply plan content; streamed model JSON never does. */
export function selectConsolePlanPreview(drafts: unknown): ConsolePlanPreview | null {
  if (!record(drafts) || !Array.isArray(drafts.items)) return null;
  const draft = drafts.items.filter(record)
    .filter((item) => item.campaign_id == null && (item.status === "planning" || item.status === "awaiting_clarification"))
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
  if (draft === undefined || !record(draft.proposal)) return null;
  const proposal = draft.proposal;
  if (typeof proposal.summary !== "string" || !Array.isArray(proposal.actions)) return null;
  return {
    planning: draft.status === "planning",
    summary: proposal.summary,
    actions: proposal.actions.filter(record).flatMap((action) => typeof action.description === "string" ? [action.description] : []),
    checks: strings(proposal.acceptance_checks),
    assumptions: strings(proposal.assumptions),
    unanswered: Array.isArray(proposal.questions) ? proposal.questions.filter((question) => record(question) && question.answer === null).length : 0,
  };
}

export function consolePlanPreviewLines(preview: ConsolePlanPreview, width: number): readonly string[] {
  const wrap = (text: string): string[] => wrapDisplay(text, Math.max(1, width));
  const section = (title: string, entries: readonly string[]): string[] => entries.length === 0 ? []
    : ["", ...wrap(`${title} (${entries.length})`), ...entries.flatMap((entry, index) => wrap(`${index + 1}. ${entry}`))];
  return [
    ...wrap(preview.planning ? "REVISING PLAN - not approved" : "PROPOSED PLAN - needs your input"),
    ...wrap(preview.planning
      ? "The previous proposal is shown below while the planner incorporates your answers."
      : `Use the input box to answer the highlighted question. ${preview.unanswered} unanswered.`),
    "", ...wrap(preview.summary),
    ...section("WORK UNITS", preview.actions),
    ...section("ACCEPTANCE CHECKS", preview.checks),
    ...section("ASSUMPTIONS - not verified", preview.assumptions),
  ];
}
