/**
 * Delivery of an operator's answer to a `userinput.ask` question back to the
 * session that asked it. The answer is already durable in the ledger
 * (`answerUserInput`); this is the live half: if the asking native session is
 * still running, the answer is queued on the same steering inbox operator
 * steering uses, so it reaches the model as a user turn at its next turn
 * boundary. Before this, `getUserInputAnswers` had no caller and an answered
 * question reached no agent at all (agent-comms S0 item 2).
 *
 * The text names itself as an operator answer to a specific question, carries
 * the answerer as a `claimed` provenance (a human assertion is never
 * `verified`), and is redacted and byte-bounded here so the worker's own
 * steering validation (8 KiB) can never fail the session over a long answer.
 * A session that has already ended is not an error: the answer stays in the
 * ledger and `delivered` is false. Durable delivery to a LATER session is the
 * ledger-backed inbox of agent-comms Stage S2, not this module.
 */
import { redactNativeText } from "@arbor/harness";
import type { RequestUserInputRecord, UserInputAnswer } from "@arbor/audit";
import type { LiveNativeSessionRegistry } from "./live-native-session-registry.js";

const MAX_DELIVERED_BYTES = 6_000;

export type UserInputAnswerDelivery =
  | { readonly delivered: true; readonly session_id: string; readonly message_id: string }
  | { readonly delivered: false; readonly reason: "no_origin_session" | "session_not_live" | "session_terminal" | "inbox_full" };

export function userInputAnswerSteeringText(question: RequestUserInputRecord, answer: UserInputAnswer): string {
  const option = answer.option_id === null ? undefined : question.question.options.find((candidate) => candidate.id === answer.option_id);
  const chosen = option === undefined ? "" : `Chosen option ${option.id}: ${option.text}. `;
  const custom = answer.custom_text.trim().length === 0 ? "" : `Free-text answer: ${answer.custom_text}`;
  const text = `Operator answer to your userinput.ask question ${question.id} ("${question.question.question}"). ${chosen}${custom}`.trim();
  return boundUtf8(redactNativeText(text), MAX_DELIVERED_BYTES);
}

/** An identical re-answer is idempotent in the ledger; it must not re-inject after the inbox was drained. */
const delivered = new WeakMap<LiveNativeSessionRegistry, Set<string>>();

export function deliverUserInputAnswer(registry: LiveNativeSessionRegistry, question: RequestUserInputRecord, answer: UserInputAnswer): UserInputAnswerDelivery {
  const sessionId = question.question.origin_session_id;
  if (sessionId === undefined) return { delivered: false, reason: "no_origin_session" };
  const messageId = `userinput-answer:${question.id}`;
  const seen = delivered.get(registry) ?? new Set<string>();
  delivered.set(registry, seen);
  if (seen.has(messageId)) return { delivered: true, session_id: sessionId, message_id: messageId };
  const result = registry.steer(sessionId, messageId, userInputAnswerSteeringText(question, answer), { tag: "claimed", claimant: answer.answered_by });
  if (result.kind === "queued") seen.add(messageId);
  if (result.kind === "queued") return { delivered: true, session_id: sessionId, message_id: messageId };
  return { delivered: false, reason: result.kind === "not_found" ? "session_not_live" : result.kind === "terminal" ? "session_terminal" : "inbox_full" };
}

function boundUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes - 3) end -= 1;
  // Never end on a lone surrogate half.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}...`;
}
