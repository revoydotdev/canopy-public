/**
 * Native egress for the governance interview.
 *
 * The owed-decision queue is published as a host-neutral question pack
 * (`scripts/interview-pack.mjs`). In Claude Code the host's AskUserQuestion
 * tool asks it; inside a Canopy run this module asks it through the native
 * human-input port, one question per request, and returns an answers document
 * in the exact shape `scripts/interview-record.mjs` validates and records.
 *
 * Two properties are deliberate. The operator's reply is kept VERBATIM — it is
 * the witness, bound to the pack digest the writer re-checks — and nothing is
 * ever invented: a reply that names no offered option, or a port that hands
 * off, declines, or is unavailable, leaves the question unanswered rather than
 * substituting a default. A red gate is still true; a fabricated answer is not.
 *
 * Its production caller is `arbor interview` (packages/arbor-mcp/src/
 * interview-command.ts), which asks the derived pack through a terminal-backed
 * port and records through `scripts/interview-record.mjs`. Offering the pack
 * inside a running Canopy session (a TUI affordance) is follow-up work.
 *
 * Governing records: ADR-178 (the host question tool is the interview's sole egress), ADR-159 (native ask carries real choices).
 */
import type { NativeHumanInputPort, NativeHumanInputRequest } from "./inference.js";

export const INTERVIEW_QUESTION_PACK_KIND = "revoy2.interview_question_pack";
export const INTERVIEW_ANSWERS_KIND = "revoy2.interview_answers";
export const NATIVE_HUMAN_INPUT_EGRESS = "arbor.native.human_input";

export interface InterviewPackOption {
  readonly label: string;
  readonly recommended: boolean;
  readonly consequence: string;
  readonly produces: { readonly requires_date: boolean; readonly [key: string]: unknown };
}

export interface InterviewPackQuestion {
  readonly id: string;
  readonly item_ids: readonly string[];
  readonly item_kind: string;
  readonly header: string;
  readonly question: string;
  readonly gate_effect: string;
  readonly recordable: boolean;
  readonly options: readonly InterviewPackOption[];
}

export interface InterviewQuestionPack {
  readonly schema_version: 1;
  readonly kind: typeof INTERVIEW_QUESTION_PACK_KIND;
  readonly derived_at: string;
  readonly questions: readonly InterviewPackQuestion[];
  readonly pack_digest: string;
}

export interface InterviewAnswer {
  readonly question_id: string;
  readonly selected: string;
  readonly verbatim: string;
  readonly deferred_to?: string;
  readonly provenance_tag: string;
}

export interface InterviewAnswersDocument {
  readonly schema_version: 1;
  readonly kind: typeof INTERVIEW_ANSWERS_KIND;
  readonly pack_digest: string;
  readonly egress: { readonly channel: typeof NATIVE_HUMAN_INPUT_EGRESS; readonly session_id: string; readonly asked_at: string };
  readonly answers: readonly InterviewAnswer[];
}

export interface InterviewUnanswered {
  readonly question_id: string;
  readonly reason: string;
}

export interface AskInterviewPackResult {
  /** Null when nothing was answered — there is nothing honest to record. */
  readonly answers: InterviewAnswersDocument | null;
  readonly unanswered: readonly InterviewUnanswered[];
}

export interface AskInterviewPackOptions {
  readonly session_id: string;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

/** One pack question as a human-input request: the question verbatim, options numbered in pack order. */
export function renderInterviewQuestion(question: InterviewPackQuestion, packDigest: string): NativeHumanInputRequest {
  const lines = question.options.map((option, index) =>
    `  ${index + 1}. ${option.label}${option.recommended ? " (recommended)" : ""} — ${option.consequence}${option.produces.requires_date ? " [reply with a YYYY-MM-DD date]" : ""}`);
  return {
    request_id: `${question.id}@${packDigest}`,
    question: [`[${question.header}] ${question.question}`, ...lines, "Reply with the option number or its label; anything after it is kept as your words."].join("\n"),
    reason: `governance interview (${question.gate_effect})`,
    evidence: [],
  };
}

/**
 * The option a reply chose, or null. Accepts the option's number or its label
 * at the start of the reply (case-insensitive), so "2", "fix", and
 * "fix — the guard is dead code" all select `fix`. Longest label wins, so a
 * label that prefixes another cannot shadow it.
 */
export function parseInterviewChoice(question: InterviewPackQuestion, reply: string): InterviewPackOption | null {
  const text = reply.trim().toLowerCase();
  const numbered = /^(\d+)(?:\b|$)/.exec(text);
  if (numbered) {
    const option = question.options[Number(numbered[1]) - 1];
    return option ?? null;
  }
  const byLength = [...question.options].sort((a, b) => b.label.length - a.label.length);
  return byLength.find((option) => {
    const label = option.label.toLowerCase();
    return text === label || (text.startsWith(label) && !/[a-z0-9]/.test(text.charAt(label.length)));
  }) ?? null;
}

/** Ask every recordable question in `pack` through `port`; stop at the first handoff, decline, or unavailability. */
export async function askInterviewPack(pack: InterviewQuestionPack, port: NativeHumanInputPort, options: AskInterviewPackOptions): Promise<AskInterviewPackResult> {
  if (pack.kind !== INTERVIEW_QUESTION_PACK_KIND) throw new Error(`not a ${INTERVIEW_QUESTION_PACK_KIND}`);
  if (options.session_id.trim().length === 0) throw new Error("askInterviewPack requires a session id: it is part of the egress witness");
  const now = options.now ?? (() => new Date());
  const signal = options.signal ?? new AbortController().signal;
  const askedAt = now().toISOString();
  const answers: InterviewAnswer[] = [];
  const unanswered: InterviewUnanswered[] = [];
  let stopped: string | null = null;
  for (const question of pack.questions) {
    if (!question.recordable) { unanswered.push({ question_id: question.id, reason: "the pack marks this question unrecordable" }); continue; }
    if (stopped !== null) { unanswered.push({ question_id: question.id, reason: stopped }); continue; }
    const result = await port.request(renderInterviewQuestion(question, pack.pack_digest), signal);
    if (result.kind !== "submitted") {
      stopped = `human input ${result.kind}: ${result.reason}`;
      unanswered.push({ question_id: question.id, reason: stopped });
      continue;
    }
    const option = parseInterviewChoice(question, result.response);
    if (option === null) { unanswered.push({ question_id: question.id, reason: "reply named none of the offered options" }); continue; }
    const date = ISO_DATE.exec(result.response)?.[1];
    if (option.produces.requires_date && date === undefined) { unanswered.push({ question_id: question.id, reason: `"${option.label}" needs a date and the reply carried none` }); continue; }
    answers.push({
      question_id: question.id,
      selected: option.label,
      verbatim: result.response,
      ...(date !== undefined && option.produces.requires_date ? { deferred_to: date } : {}),
      provenance_tag: result.provenance.tag,
    });
  }
  return {
    answers: answers.length === 0 ? null : {
      schema_version: 1,
      kind: INTERVIEW_ANSWERS_KIND,
      pack_digest: pack.pack_digest,
      egress: { channel: NATIVE_HUMAN_INPUT_EGRESS, session_id: options.session_id, asked_at: askedAt },
      answers,
    },
    unanswered,
  };
}
