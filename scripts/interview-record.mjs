#!/usr/bin/env node
/**
 * scripts/interview-record.mjs — record the operator's verbatim answers to a
 * question pack, bound to the pack they answered and to the native tool that
 * carried the question.
 *
 * Usage:
 *   bun run interview:record --pack <pack.json> --answers <answers.json>
 *   bun scripts/interview-record.mjs --pack <pack.json> --answers -          # answers on stdin
 *   bun scripts/interview-record.mjs ... --dry-run                           # validate, print, write nothing
 *
 * This is THE entry point for recording an interview (`bun run
 * interview:record`). scripts/record-interview.mjs remains only as the
 * low-level payload writer for fixtures and historical replay; it cannot
 * produce a witness, so it cannot record an interview held after ADR-178.
 *
 * Answers file:
 *   {
 *     "schema_version": 1,
 *     "kind": "revoy2.interview_answers",
 *     "pack_digest": "sha256:…",                       // from the pack that was asked
 *     "egress": { "channel": "claude-code.AskUserQuestion",
 *                 "session_id": "…", "asked_at": "2026-10-06T14:02:11Z" },
 *     "answers": [
 *       { "question_id": "q:ADR-180", "selected": "accept",
 *         "verbatim": "accept — the mechanism is live", "deferred_to": "2026-10-20" }
 *     ],
 *     "note": "optional"
 *   }
 *
 * WHERE THE WITNESS LIVES. Not in a skill. The operator directed (2026-10-06)
 * that the host's native Q&A tool is the sole egress for these questions, so
 * the witness of an interview is what that tool returned: the operator's
 * VERBATIM answer, bound to the digest of the question pack it answered and to
 * the egress that carried it (channel, session, time). Each recorded outcome IS
 * the verbatim answer, and the binding is the record's structured `witness`
 * field, schema-checked by `validateWitness` (scripts/lib/discharge-store.mjs)
 * — inside the content the ADR-158 receipt digests, so editing either after
 * the fact orphans the record from its receipt. (The first records carried it
 * as a `witness:v1 {...}` line in `note`; `readRecordWitness` still reads that
 * form.)
 *
 * WHAT IT REFUSES, all before anything is written:
 *   - a pack whose content no longer matches its own digest;
 *   - answers whose `pack_digest` names a different pack;
 *   - an undeclared egress channel, or one without a session id and timestamp;
 *   - an answer with no verbatim text, an option not offered by that question,
 *     a question not in the pack, the same question twice, or a question the
 *     pack itself marks unrecordable;
 *   - a dated option with no date after the interview.
 *
 * It then writes through `recordInterviewAnswer` (scripts/lib/discharge-store.mjs)
 * — the sole ledger writer, which mints the receipt and queues discharge
 * obligations. This module adds validation and binding; it is not a second
 * writer.
 *
 * WHAT IT DOES NOT PROVE. That a human typed the verbatim text. An agent that
 * fabricates an answers file can run this command; the pack digest makes the
 * fabrication specific (it must name a real pack, a real option, and a real
 * egress) and the receipt makes it visible to a gate, but neither is a
 * signature. Same ceiling as ADR-158, stated for the same reason.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyQuestionPack } from "./interview-pack.mjs";
import {
  EGRESS_CHANNELS, WITNESS_SCHEMA_VERSION, readRecordWitness, recordInterviewAnswer,
} from "./lib/discharge-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");

export const ANSWERS_KIND = "revoy2.interview_answers";
export const ANSWERS_SCHEMA_VERSION = 1;
export { EGRESS_CHANNELS };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Hosts decorate the recommended label ("accept (Recommended)"); match the bare option. */
function normalizeLabel(label) {
  return String(label ?? "").replace(/\s*\(recommended\)\s*$/i, "").trim().toLowerCase();
}

function refuse(message) {
  throw new Error(`interview-record: ${message}`);
}

/**
 * Pure: check `answers` against `pack` and return the `recordInterviewAnswer`
 * payload. Throws on the first refusal; never returns a partial payload.
 */
export function buildInterviewPayload(pack, answers) {
  const packDigest = verifyQuestionPack(pack);
  if (!answers || answers.kind !== ANSWERS_KIND || answers.schema_version !== ANSWERS_SCHEMA_VERSION) {
    refuse(`answers must be a ${ANSWERS_KIND} v${ANSWERS_SCHEMA_VERSION}`);
  }
  if (answers.pack_digest !== packDigest) {
    refuse(`answers are bound to ${answers.pack_digest ?? "(no pack)"}, but the pack supplied is ${packDigest} — re-derive and re-ask rather than re-pointing answers at a different question set`);
  }
  const egress = answers.egress ?? {};
  if (!EGRESS_CHANNELS.includes(egress.channel)) {
    refuse(`egress.channel ${JSON.stringify(egress.channel ?? null)} is not a declared native question tool (${EGRESS_CHANNELS.join(", ")})`);
  }
  if (typeof egress.session_id !== "string" || egress.session_id.trim() === "") refuse("egress.session_id is required");
  if (typeof egress.asked_at !== "string" || Number.isNaN(Date.parse(egress.asked_at))) refuse("egress.asked_at must be an ISO timestamp");
  const heldAt = answers.held_at ?? new Date(egress.asked_at).toISOString().slice(0, 10);
  if (!DATE_RE.test(heldAt)) refuse(`held_at ${JSON.stringify(heldAt)} is not an ISO date`);
  if (!Array.isArray(answers.answers) || answers.answers.length === 0) refuse("answers must be a non-empty array — record nothing rather than an empty interview");

  const questions = new Map(pack.questions.map((q) => [q.id, q]));
  const seen = new Set();
  const payloadAnswers = [];
  const witnessed = [];
  for (const answer of answers.answers) {
    const question = questions.get(answer?.question_id);
    if (!question) refuse(`question ${JSON.stringify(answer?.question_id ?? null)} is not in pack ${packDigest}`);
    if (seen.has(question.id)) refuse(`question ${question.id} answered twice`);
    seen.add(question.id);
    if (!question.recordable) refuse(`question ${question.id} is not recordable: ${question.not_recordable_reason ?? "the pack says so"}`);
    if (typeof answer.verbatim !== "string" || answer.verbatim.trim() === "") {
      refuse(`question ${question.id} has no verbatim answer — the operator's own words are the witness; a selection alone is not`);
    }
    const option = question.options.find((o) => normalizeLabel(o.label) === normalizeLabel(answer.selected));
    if (!option) {
      refuse(`question ${question.id}: ${JSON.stringify(answer.selected ?? null)} is not one of the options asked (${question.options.map((o) => o.label).join(" / ")}); a free-text "Other" answer leaves the item open`);
    }
    const deferredTo = answer.deferred_to ?? null;
    if (option.produces?.requires_date && !(DATE_RE.test(deferredTo ?? "") && deferredTo > heldAt)) {
      refuse(`question ${question.id}: "${option.label}" needs deferred_to, an ISO date after ${heldAt} (got ${JSON.stringify(deferredTo)})`);
    }
    if (deferredTo !== null && !DATE_RE.test(deferredTo)) refuse(`question ${question.id}: deferred_to ${JSON.stringify(deferredTo)} is not an ISO date`);
    for (const itemId of question.item_ids) {
      payloadAnswers.push({
        itemId,
        itemKind: question.item_kind,
        option: option.label,
        outcome: answer.verbatim,
        ...(deferredTo ? { deferredTo } : {}),
      });
    }
    witnessed.push(question.id);
  }

  const witness = {
    schema_version: WITNESS_SCHEMA_VERSION,
    egress: { channel: egress.channel, session_id: egress.session_id, asked_at: egress.asked_at },
    pack_digest: packDigest,
    questions: witnessed,
  };
  const note = typeof answers.note === "string" && answers.note.trim() ? answers.note : null;
  return { heldAt, answers: payloadAnswers, witness, ...(note ? { note } : {}) };
}

/** The witness a recorded line carries, structured or legacy (`witness:v1` note); null when it has none. */
export function recordWitness(record) {
  return readRecordWitness(record)?.witness ?? null;
}

/** Validate, then write through the sole ledger writer. */
export function recordInterviewFromAnswers(repo, { pack, answers }) {
  return recordInterviewAnswer(repo, buildInterviewPayload(pack, answers));
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function readJson(source) {
  return JSON.parse(source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8"));
}

export function main(argv = process.argv.slice(2)) {
  const packPath = argValue(argv, "--pack");
  const answersPath = argValue(argv, "--answers");
  if (!packPath || !answersPath) {
    console.error("Usage: bun scripts/interview-record.mjs --pack <pack.json> --answers <answers.json>|- [--dry-run] [--repo <dir>]");
    return 1;
  }
  const repo = resolvePath(argValue(argv, "--repo") ?? REPO_ROOT);
  let payload;
  try {
    payload = buildInterviewPayload(readJson(packPath), readJson(answersPath));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (argv.includes("--dry-run")) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  const { interviewRecord, obligations } = recordInterviewAnswer(repo, payload);
  console.log(`recorded interview held_at=${interviewRecord.held_at}, covered ${interviewRecord.covered.length} item(s), receipt ${interviewRecord.receipt_id}`);
  for (const obligation of obligations) console.log(`  queued ${obligation.id}  due ${obligation.due}  — ${obligation.mechanism}`);
  return 0;
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
