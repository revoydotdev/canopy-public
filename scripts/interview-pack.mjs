#!/usr/bin/env node
/**
 * scripts/interview-pack.mjs — the owed-decision queue as a host-neutral
 * QUESTION PACK, so whatever native question tool the host has is the egress.
 *
 * Usage:
 *   bun scripts/interview-pack.mjs                     # pack for every owed item, as JSON
 *   bun scripts/interview-pack.mjs --include-upcoming  # also the not-yet-blocking items
 *   bun scripts/interview-pack.mjs --out <pack.json>   # write instead of print
 *   bun scripts/decision-queue.mjs --question-pack     # same pack, from the queue's own CLI
 *
 * WHY THIS EXISTS. The interview used to be a Claude Code skill that read the
 * queue, composed questions in prose, and asked them. The questions therefore
 * existed only inside one host's transcript: arbor's own native harness could
 * not ask them, and nothing bound a recorded answer to the question it
 * answered. The operator directed (2026-10-06) that the host's native Q&A tool
 * is the sole egress — Claude Code's AskUserQuestion when working in Claude
 * Code, arbor's human-input port inside a Canopy run. This module is the half
 * that makes that possible: it turns the derived queue into data any such tool
 * can render, and digests it so an answer can name exactly what it answered.
 *
 * WHAT A QUESTION CARRIES. One question per owed item (hazards are already
 * grouped by the record they cite, and are recordable under the catalog's
 * `hazard` kind). Each carries at most four options — the
 * closed per-kind set declared in scripts/lib/discharge-catalog.mjs, so the
 * recorder can never be handed an option it would refuse — with the
 * recommended one first, the consequence of each, and what record each answer
 * produces (the ledger coverage, any discharge obligation it queues, and
 * whether a date is required).
 *
 * WHAT THE DIGEST BINDS. `pack_digest` is sha256 over the canonical pack with
 * the digest removed. scripts/interview-record.mjs refuses answers whose
 * `pack_digest` does not match the pack it is given, and refuses a pack whose
 * content no longer matches its own digest. That binds an answer to the exact
 * question text and option set that was put to the operator. It does not prove
 * a human answered — the same ceiling ADR-158 states for receipts.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./enforcement-control-plane.mjs";
// Circular with decision-queue.mjs (its --question-pack flag imports this
// module). Safe for the same reason discharge-catalog.mjs's cycle is: every
// imported binding is read only inside function bodies.
import { deriveDecisionQueue } from "./decision-queue.mjs";
import { DISCHARGE_CATALOG } from "./lib/discharge-catalog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");

export const QUESTION_PACK_KIND = "revoy2.interview_question_pack";
export const QUESTION_PACK_SCHEMA_VERSION = 1;
/** AskUserQuestion's ceiling, and a reasonable one for any choice surface. */
export const MAX_OPTIONS_PER_QUESTION = 4;

/**
 * Options whose answer is incomplete without a date. The recorder itself only
 * enforces "defer with a date"; a review date that is never written down is
 * the same untracked promise, so the pack demands it for both.
 */
const DATED_OPTIONS = new Set(["defer with a date", "keep proposed with a review date"]);

/**
 * The option recommended for each kind, and why. A static default is a
 * starting point the asking agent should state, not a verdict: the operator
 * sees every option and the recommendation is only the ordering.
 */
const RECOMMENDATIONS = {
  proposed_record: { option: "accept", basis: "a record is authored to be decided; keeping it Proposed is the backlog this queue exists to end" },
  waiver: { option: "renew with a new expiry", basis: "a renewal is checkable (the store's expiry must move); act or delete once the underlying work is done" },
  vi_triage: { option: "re-attest", basis: "re-attesting is checkable (a fresh triage row must be written after this interview)" },
  completion_depth: { option: "re-attest", basis: "re-attesting is checkable (a fresh verdict must be written after this interview)" },
  operator_decision: { option: "schedule it", basis: "an aged operator decision usually needs a slot, not an immediate act" },
  operator_call: { option: "do the disposal now", basis: "\"retain\" chosen by default is how this pile grew; the disposal command is named in the summary" },
  discharge_obligation: { option: "defer with a date", basis: "the only recordable answer; discharging it is doing the work, not answering a question" },
  hazard: { option: "re-ground the commitments", basis: "the commitments, not the record, are what this question owns; the record's own fate is its own question, and re-grounding is checkable (no dated commitment may still cite it)" },
};

const HEADERS = {
  proposed_record: "Proposed",
  waiver: "Waiver",
  vi_triage: "VI triage",
  completion_depth: "Depth triage",
  operator_decision: "Op decision",
  operator_call: "Op call",
  discharge_obligation: "Discharge",
  hazard: "Hazard",
};

/** The queue caps summaries at 160 characters; say so rather than end mid-word silently. */
function summaryOf(item) {
  const text = item.summary || "(no reason recorded)";
  return text.length >= 160 ? `${text}…` : text;
}

function questionText(item) {
  const expires = (item.days_remaining ?? 0) < 0 ? "expired" : "expires";
  switch (item.kind) {
    case "proposed_record":
      return `${item.id}${item.unallocated ? " (unallocated)" : ""} has been Proposed for ${item.age_days ?? "?"} day(s): "${item.summary}". What is the decision?`;
    case "waiver":
      return `Waiver ${item.id} ${expires} ${item.due}: ${summaryOf(item)}. What should happen to it?`;
    case "vi_triage":
    case "completion_depth":
      return `The accepted-tradeoff verdict on ${item.id} ${expires} ${item.due}: ${summaryOf(item)}. What should happen to it?`;
    case "operator_decision":
      return `${item.id} has been open ${item.age_days ?? "?"} day(s): ${item.summary}. What should happen to it?`;
    case "operator_call":
      return `${item.summary}. What is the disposition?`;
    case "discharge_obligation":
      return `${item.summary}. Postpone it to a date?`;
    default:
      return `${item.summary ?? item.id}. What is the decision?`;
  }
}

function optionsFor(kind, itemIds) {
  const catalog = DISCHARGE_CATALOG[kind];
  if (!catalog) return [];
  const recommended = RECOMMENDATIONS[kind]?.option ?? null;
  const keys = Object.keys(catalog);
  const ordered = recommended && keys.includes(recommended) ? [recommended, ...keys.filter((k) => k !== recommended)] : keys;
  return ordered.slice(0, MAX_OPTIONS_PER_QUESTION).map((option) => {
    const entry = catalog[option];
    const discharge = entry.discharge === null ? null : (entry.mechanism ?? null);
    const requiresDate = DATED_OPTIONS.has(option);
    return {
      label: option,
      recommended: option === recommended,
      consequence: discharge
        ? `queues discharge obligation(s) for ${itemIds.join(", ")} due the day of the interview, cleared only when: ${discharge}`
        : "records the decision; queues no checkable follow-on obligation",
      produces: {
        ledger: `decisions/interviews.jsonl record covering ${itemIds.join(", ")}, outcome = the operator's verbatim answer`,
        discharge_obligation: discharge,
        requires_date: requiresDate,
        ...(requiresDate ? { date_effect: "coverage lapses on this date and the item returns to the queue" } : {}),
      },
    };
  });
}

/** Why an answer to this item will or will not clear the gate — stated, so nobody records one expecting it to. */
function gateEffect(item, bucket) {
  if (bucket === "lapsed" && item.kind !== "discharge_obligation") {
    return "LAPSED: coverage does not clear a lapsed item; only discharging it (the store's own mechanism) does. The answer still records the decision and queues its discharge.";
  }
  if (bucket === "flagged_proposed") return "not blocking today; acceptance (adr:accept) requires a standing interview";
  if (bucket === "upcoming") return "not blocking yet; listed for awareness";
  return "blocking: a recorded answer clears it from gate:decision-queue";
}

/**
 * Pure: derive the pack from a decision-queue report. Order is by
 * consequence, as the interview always required — hazards, then lapsed,
 * due-soon, over-age, operator calls, Proposed records, and (opt-in) upcoming.
 */
export function deriveQuestionPack(report, { includeUpcoming = false } = {}) {
  const buckets = [
    ["hazards", report.hazards ?? []],
    ["lapsed", report.lapsed ?? []],
    ["due_soon", report.due_soon ?? []],
    ["over_age", report.over_age ?? []],
    ["operator_calls", report.operator_calls ?? []],
    ["flagged_proposed", report.flagged_proposed ?? []],
    ...(includeUpcoming ? [["upcoming", report.upcoming ?? []]] : []),
  ];
  const questions = [];
  const seen = new Set();
  for (const [bucket, items] of buckets) {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (bucket === "hazards") {
        const options = optionsFor("hazard", [item.id]);
        questions.push({
          id: `q:${item.id}`,
          item_ids: [item.id],
          item_kind: "hazard",
          bucket,
          header: HEADERS.hazard,
          question: `${item.detail}. What should happen to the commitments resting on ${item.cites}?`,
          context: { cites: item.cites, status: item.status, dependents: item.dependents, earliest_due: item.earliest_due },
          gate_effect: "blocking: a recorded answer clears it from gate:decision-queue",
          recommendation_basis: RECOMMENDATIONS.hazard.basis,
          recordable: options.length > 0,
          ...(options.length > 0 ? {} : { not_recordable_reason: 'scripts/lib/discharge-catalog.mjs declares no options for item kind "hazard"' }),
          options,
        });
        continue;
      }
      const options = optionsFor(item.kind, [item.id]);
      questions.push({
        id: `q:${item.id}`,
        item_ids: [item.id],
        item_kind: item.kind,
        bucket,
        header: HEADERS[item.kind] ?? item.kind,
        question: questionText(item),
        context: {
          source: item.source ?? null,
          summary: item.summary ?? null,
          due: item.due ?? null,
          days_remaining: item.days_remaining ?? null,
          age_days: item.age_days ?? null,
        },
        gate_effect: gateEffect(item, bucket),
        recommendation_basis: RECOMMENDATIONS[item.kind]?.basis ?? null,
        recordable: options.length > 0,
        ...(options.length > 0 ? {} : { not_recordable_reason: `scripts/lib/discharge-catalog.mjs declares no options for item kind "${item.kind}"` }),
        options,
      });
    }
  }
  const body = {
    schema_version: QUESTION_PACK_SCHEMA_VERSION,
    kind: QUESTION_PACK_KIND,
    derived_at: report.today,
    source: "scripts/decision-queue.mjs",
    egress_contract:
      "Ask each recordable question through the host's native multiple-choice tool, verbatim, options in order. " +
      "Record answers with `bun run interview:record --pack <pack.json> --answers <answers.json>`. " +
      "If the operator is unreachable, record nothing: a red gate is still true.",
    questions,
  };
  return { ...body, pack_digest: questionPackDigest(body) };
}

/** sha256 over the canonical pack with `pack_digest` removed. */
export function questionPackDigest(pack) {
  const { pack_digest: _ignored, ...rest } = pack ?? {};
  return `sha256:${createHash("sha256").update(canonicalJson(rest)).digest("hex")}`;
}

/** Refuse a pack that is not a pack, or whose content no longer matches its own digest. */
export function verifyQuestionPack(pack) {
  if (!pack || pack.kind !== QUESTION_PACK_KIND || pack.schema_version !== QUESTION_PACK_SCHEMA_VERSION) {
    throw new Error(`not a ${QUESTION_PACK_KIND} v${QUESTION_PACK_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(pack.questions)) throw new Error("question pack has no questions array");
  const recomputed = questionPackDigest(pack);
  if (pack.pack_digest !== recomputed) {
    throw new Error(`question pack was edited after derivation: declares ${pack.pack_digest ?? "(none)"}, content digests to ${recomputed}`);
  }
  return recomputed;
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

export function main(argv = process.argv.slice(2)) {
  const report = deriveDecisionQueue({ repo: resolvePath(argValue(argv, "--repo") ?? REPO_ROOT) });
  const pack = deriveQuestionPack(report, { includeUpcoming: argv.includes("--include-upcoming") });
  const text = `${JSON.stringify(pack, null, 2)}\n`;
  const out = argValue(argv, "--out");
  if (out) {
    writeFileSync(out, text);
    console.error(`wrote ${pack.questions.length} question(s) to ${out} (${pack.pack_digest})`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
