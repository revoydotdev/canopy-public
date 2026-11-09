/**
 * scripts/lib/discharge-store.mjs — the commitment store ADR-137 Decision §2
 * requires: recording an interview answer writes a first-class row here, not
 * prose, and the row is what `deriveDecisionQueue` reads to know an
 * obligation is owed.
 *
 * THE FAILURE THIS CLOSES. On 2026-08-26 the operator answered "re-attest"
 * for seven reopened visual-intelligence findings. `decisions/interviews.jsonl`
 * recorded the answer verbatim, `gate:decision-queue` went green, and the
 * actual `vi-findings.mjs --triage` writes were never made — nothing forced
 * "the agent should now do X" to become "the agent did X, or the push
 * refuses." This module is that force.
 *
 * TWO STORES, ONE RECORDING ACT. `recordInterviewAnswer` is the sole writer
 * of `decisions/interviews.jsonl` this module exposes, and it is also the
 * sole writer of `decisions/discharge-obligations.jsonl`: the two are written
 * together so a recorded answer and its obligation can never diverge (one
 * written, the other forgotten) by construction — not by discipline.
 *
 * WHAT AN OBLIGATION ROW IS. `{ id, item_id, item_kind, option, due,
 * created_at, interview_held_at, mechanism }` — an id, a due date, and a
 * naming of what would satisfy it, per Decision §2's own wording. It carries
 * no stored "done" flag: `dischargeCommitments` re-evaluates the option's
 * declared predicate (scripts/lib/discharge-catalog.mjs) against LIVE
 * repository state every time the queue derives, so a row cannot be marked
 * satisfied without the state actually being true. An option declared
 * `discharge: null` (Decision §4 — genuinely no checkable consequence)
 * produces no row at all.
 *
 * WHERE THIS BLOCKS THE PUSH. Nowhere new. `dischargeCommitments` feeds
 * `deriveDecisionQueue`'s `items` exactly like `waiverCommitments`,
 * `visualIntelligenceCommitments`, and `completionDepthCommitments` already
 * do (scripts/decision-queue.mjs:510) — an item with a past `due` date lands
 * in `lapsed` unconditionally, which is already `gate:decision-queue`'s
 * job, which is already selected by the prepush profile
 * (scripts/execution-profile.json) per ADR-128's push boundary. ADR-137
 * Decision §3 needed no new enforcement mechanism, only a new commitment
 * source feeding the one that already exists.
 *
 * AND THE STORE'S ABSENCE IS A FINDING, NOT ZERO OBLIGATIONS. The ledger this
 * module writes is the only place `item_kind` and `option` are recorded, so a
 * deleted ledger destroys the evidence needed to notice it is missing —
 * `dischargeStoreAbsence` therefore treats an unexplained absence as blocking
 * rather than as an empty, compliant store. See its own docstring, and
 * docs/research/governance/P-6-absence-reads-as-compliance.md for the analysis
 * and the residual it deliberately does not close.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mintInterviewReceipt } from "./interview-receipts.mjs";
import { DISCHARGE_CATALOG } from "./discharge-catalog.mjs";
// decision-queue.mjs imports this module (to feed dischargeCommitments into
// deriveDecisionQueue), and this module imports decision-queue.mjs back for
// its interview-ledger path constant — a circular import, safe for the same
// reason discharge-catalog.mjs's is: INTERVIEW_LEDGER_PATH is a plain string
// constant read only inside function bodies below, never at module-eval time.
import { INTERVIEW_LEDGER_PATH } from "../decision-queue.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const DISCHARGE_STORE_PATH = "decisions/discharge-obligations.jsonl";

// ---------------------------------------------------------------------------
// The interview witness (ADR-178)
// ---------------------------------------------------------------------------

/**
 * The native question tools an answer may have come through. Closed on
 * purpose: a new host is a reviewed edit here, not a free-text string. Owned
 * here, beside the schema that checks it, and re-exported by
 * scripts/interview-record.mjs.
 */
export const EGRESS_CHANNELS = Object.freeze([
  "claude-code.AskUserQuestion",
  "arbor.native.human_input",
  "arbor.native.userinput.ask",
]);

export const WITNESS_SCHEMA_VERSION = 1;

/**
 * Records held strictly AFTER this date must carry a structured `witness`.
 * It is ADR-178's acceptance date: the interview that accepted it was held on
 * 2026-10-06 (decisions/interviews.jsonl), and every record held that day —
 * including that one — predates the structured field, so the cutoff is
 * exclusive. Like ADR-158's baseline, it may move EARLIER, never later.
 */
export const WITNESS_REQUIRED_AFTER = "2026-10-06";

/** The prefix of the pre-structured witness, which rode in the record's `note`. */
export const LEGACY_WITNESS_NOTE_PREFIX = "witness:v1 ";

const PACK_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Every way `witness` fails the v1 schema, as messages; `[]` when it is valid.
 *
 *   { schema_version: 1,
 *     egress: { channel: <EGRESS_CHANNELS>, session_id: <non-empty>, asked_at: <ISO timestamp> },
 *     pack_digest: "sha256:<64 hex>",
 *     questions: [<non-empty, distinct question ids>] }
 *
 * No other keys: a field nothing reads is a field nothing checks, and a free
 * text slot here would let prose stand in for the binding.
 */
export function validateWitness(witness) {
  if (!witness || typeof witness !== "object" || Array.isArray(witness)) return ["witness must be an object"];
  const errors = [];
  const allowed = new Set(["schema_version", "egress", "pack_digest", "questions"]);
  for (const key of Object.keys(witness)) if (!allowed.has(key)) errors.push(`witness has an undeclared field "${key}"`);
  if (witness.schema_version !== WITNESS_SCHEMA_VERSION) errors.push(`witness.schema_version must be ${WITNESS_SCHEMA_VERSION}`);
  const egress = witness.egress;
  if (!egress || typeof egress !== "object") {
    errors.push("witness.egress is required");
  } else {
    if (!EGRESS_CHANNELS.includes(egress.channel)) errors.push(`witness.egress.channel ${JSON.stringify(egress.channel ?? null)} is not a declared native question tool`);
    if (typeof egress.session_id !== "string" || egress.session_id.trim() === "") errors.push("witness.egress.session_id is required");
    if (typeof egress.asked_at !== "string" || Number.isNaN(Date.parse(egress.asked_at))) errors.push("witness.egress.asked_at must be an ISO timestamp");
  }
  if (typeof witness.pack_digest !== "string" || !PACK_DIGEST_RE.test(witness.pack_digest)) errors.push("witness.pack_digest must be sha256:<64 hex>");
  const questions = witness.questions;
  if (!Array.isArray(questions) || questions.length === 0 || !questions.every((q) => typeof q === "string" && q.trim() !== "")) {
    errors.push("witness.questions must be a non-empty array of question ids");
  } else if (new Set(questions).size !== questions.length) {
    errors.push("witness.questions names a question twice");
  }
  return errors;
}

/**
 * The witness a ledger record carries, normalized to the v1 schema, or null.
 *
 * Reads both forms: the structured `witness` field, and the `witness:v1 {...}`
 * line the first native recorder wrote into `note` (held 2026-10-06, before
 * the field existed). The legacy form is read, never rewritten — rewriting a
 * recorded line would change its digest and orphan it from its ADR-158
 * receipt. `legacy: true` marks which form was found.
 */
export function readRecordWitness(record) {
  if (record && Object.prototype.hasOwnProperty.call(record, "witness")) {
    return { witness: record.witness, legacy: false };
  }
  const note = record?.note;
  if (typeof note !== "string" || !note.startsWith(LEGACY_WITNESS_NOTE_PREFIX)) return null;
  let parsed;
  try { parsed = JSON.parse(note.slice(LEGACY_WITNESS_NOTE_PREFIX.length)); } catch { return { witness: null, legacy: true }; }
  const { note: _freeText, ...binding } = parsed ?? {};
  return { witness: { schema_version: WITNESS_SCHEMA_VERSION, ...binding }, legacy: true };
}

/**
 * Pure: which ledger records held after `requiredAfter` carry no valid
 * witness. A record that cannot be dated is reported too — it cannot be placed
 * against the cutoff, the same reading ADR-158's attestation audit gives it.
 */
export function auditInterviewWitnesses(records, { requiredAfter = WITNESS_REQUIRED_AFTER } = {}) {
  const violations = [];
  for (const [index, record] of (records ?? []).entries()) {
    const heldAt = typeof record?.held_at === "string" ? record.held_at : "";
    if (heldAt && heldAt <= requiredAfter) continue;
    const found = readRecordWitness(record);
    const errors = !heldAt
      ? ["record carries no held_at, so it cannot be dated against the witness cutoff"]
      : found === null
        ? ["record carries no witness"]
        : validateWitness(found.witness);
    if (errors.length === 0) continue;
    violations.push({
      line: index + 1,
      held_at: record?.held_at ?? null,
      covered: Array.isArray(record?.covered) ? record.covered : [],
      errors,
    });
  }
  return violations;
}

/**
 * The date before which interview history is not required to have been produced
 * by the sanctioned recorder: ADR-158's `records_historical_through`, read from
 * the same declaration `auditInterviewAttestation` uses.
 *
 * This is the sound cutoff for the check below, and not merely a convenient one.
 * The invariant the check relies on is "a recorder-produced interview appends an
 * obligation row" — which holds only for records the recorder actually wrote,
 * and a receipt is precisely the evidence of that. `baseline.json` accepts
 * records held on or before its date without a receipt because they predate the
 * mechanism, so those records may be hand-written and may legitimately have
 * written no row. Anything later must match a receipt, so anything later is
 * provably recorder-produced.
 *
 * Deliberately NOT the store's own first row (2026-08-28, in commit `ecf82b69`,
 * one day after ADR-137 was accepted). Using that date would be more aggressive
 * and less sound: it would demand rows from interviews in the three days before
 * the recorder can be shown to have existed, inventing false positives to buy
 * strictness this check does not need. On this repository 12 interviews post-date
 * the cutoff, so a deletion is still caught either way.
 *
 * One declaration, read from one place, so the two rules cannot drift apart. Its
 * permitted edit direction is safe for both: `baseline.json` may move earlier and
 * never later, and moving it earlier simultaneously raises the receipt
 * requirement and lowers the bar for "an interview provably went through the
 * recorder" — so this check only ever becomes stricter, never more permissive.
 */
function dischargeStoreRequiredFrom(repo) {
  try {
    const declared = JSON.parse(readFileSync(join(repo, "scripts", "interview", "baseline.json"), "utf8")).records_historical_through;
    if (typeof declared === "string" && DATE_RE.test(declared)) return declared;
  } catch {
    // An unreadable or absent declaration is NOT a licence to treat history as
    // recorder-produced. Fall through to the fail-closed default below.
  }
  // Unknown cutoff: treat every interview as post-baseline. Every date-specific
  // claim this module makes is then unsupported, so it asserts the strictest one.
  return "0000-00-00";
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A malformed row is itself a finding, not this reader's job to police
      // — skip it rather than let one bad line blind the whole store.
    }
  }
  return rows;
}

function appendJsonlLine(path, row) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/** Every obligation ever recorded. Includes discharged ones — the caller filters live via the predicate, never via a stored flag. */
export function readDischargeObligations(repo) {
  return readJsonl(join(repo, DISCHARGE_STORE_PATH));
}

/**
 * The store's ABSENCE, reported as a finding — never as zero obligations.
 * Returns `null` when there is nothing unexplained to report.
 *
 * THE FAILURE THIS CLOSES. `readJsonl` returns `[]` for a missing file
 * (`if (!existsSync(path)) return [];`), so a deleted
 * `decisions/discharge-obligations.jsonl` used to derive an empty obligation
 * set, and `gate:decision-queue` reported PASS. On this repository that was the
 * difference between 140 open commitments (5 of them LAPSED, exit 1) and 135
 * (exit 0) — the five broken promises did not get discharged, they stopped being
 * countable, and nothing recorded the loss.
 *
 * WHY A BASELINE IS NEEDED, AND WHY IT IS NOT A WAY BACK TO PASSING.
 * `recordInterviewAnswer` appends a row only for answers whose catalog entry
 * declares a non-null discharge (`if (entry.discharge === null) continue;`), so
 * a repository whose interviews all declared `discharge: null` legitimately has
 * no file at all. "Untracked because nothing was owed" and "deleted because
 * something was owed" are the same observable state, and the interview ledger
 * cannot break the tie: it keeps only `covered` plus free-text `outcomes`, while
 * the two fields that say an obligation WAS owed — `item_kind` and `option`, and
 * therefore whether the catalog declares a discharge — are written only into the
 * obligation row (`item_kind: itemKind,`), which is the row that went missing.
 * The question is not hard to answer after a deletion; it is unanswerable,
 * because the discriminating information was stored in the deleted file.
 *
 * So this does not try to answer it. It uses the one fact that does survive:
 * every interview held after `dischargeStoreRequiredFrom` was provably recorded
 * through the single sanctioned writer, which appends here for each non-null
 * discharge. No file therefore means an UNEXPLAINED absence, and unexplained
 * means blocking. The residual case — a post-baseline interview whose only
 * answers were `discharge: null`, in a repository holding no rows — is
 * indistinguishable from a deletion, and it resolves fail-closed. That is the
 * only safe direction for a gate whose whole failure mode is absence being read
 * as compliance.
 *
 * THE COST, STATED RATHER THAN HIDDEN: such a repository is blocked until it
 * commits an empty `decisions/discharge-obligations.jsonl` (present-and-empty is
 * a valid tracked state, and from then on the file's existence is enforced), or
 * until the baseline moves earlier. That is one line of work against a silent
 * bypass, and it is the cheaper trade.
 */
export function dischargeStoreAbsence(repo) {
  if (existsSync(join(repo, DISCHARGE_STORE_PATH))) return null;
  const requiredFrom = dischargeStoreRequiredFrom(repo);
  const interviews = readJsonl(join(repo, INTERVIEW_LEDGER_PATH));
  // Strictly after the cutoff, mirroring auditInterviewAttestation's `<=` historical
  // test: a record held ON the baseline is accepted without a receipt, so it is not
  // provably recorder-produced and must not be counted as one. An UNDATED record does
  // count — it cannot be placed against the baseline at all, and that function reports
  // such a record rather than waving it through. Both readings resolve toward blocking.
  const after = interviews.filter((record) => !record?.held_at || record.held_at > requiredFrom);
  if (after.length === 0) return null;
  return {
    path: DISCHARGE_STORE_PATH,
    required_from: requiredFrom,
    interviews_after_required_from: after.length,
    latest_interview: after.map((record) => record.held_at ?? null).sort().at(-1) ?? null,
  };
}

/**
 * The `held_at` of the most recent interview record that named `itemId` in
 * its `covered` array — regardless of whether that particular answer
 * happened to declare a checkable discharge. A `discharge: null` answer (e.g.
 * `vi_triage`'s "change the verdict") writes no obligation row at all, so an
 * obligation created by an EARLIER answer for the same item would otherwise
 * have no way to learn a later, discharge-free answer superseded it — this
 * is why supersession is computed from the interview LEDGER, not from the
 * obligation store alone.
 *
 * Ties on `held_at` (two interviews recorded the same day) resolve to
 * whichever record appears LATER in the append-only ledger, mirroring
 * `coverageIndex`'s own `>=` tie-break for the identical reason: the
 * later-appended record is the more recent decision.
 */
function latestCoveringInterview(interviews, itemId) {
  let latest = null; // { held_at }
  for (const record of interviews) {
    if (!Array.isArray(record?.covered) || !record.covered.includes(itemId)) continue;
    const heldAt = record.held_at ?? "";
    if (!latest || heldAt >= latest.held_at) latest = { held_at: heldAt };
  }
  return latest;
}

/**
 * Commitment items shaped like every other `deriveDecisionQueue` source
 * (`waiverCommitments`, `visualIntelligenceCommitments`,
 * `completionDepthCommitments`): `{ id, kind, source, due, age_days, summary,
 * cites }`. Only UNDISCHARGED, UNSUPERSEDED obligations are returned — an
 * obligation whose predicate now evaluates true simply stops appearing, the
 * same way a VI-triage row stops being a commitment once its verdict is no
 * longer `accepted_tradeoff`; a superseded obligation (a LATER interview
 * answered the same item differently) likewise stops appearing, not because
 * its own predicate was ever satisfied, but because it is no longer the
 * operator's standing decision for that item. The ledger itself is never
 * touched to compute either — both are live re-derivations.
 *
 * A predicate that throws (its own bug, or a store it reads being absent) is
 * treated as UNSATISFIED, not as "unknown, skip it": a discharge check that
 * cannot run must fail closed, or a broken predicate would silently amnesty
 * every obligation that hits it.
 */
export function dischargeCommitments(repo) {
  const interviews = readJsonl(join(repo, INTERVIEW_LEDGER_PATH));
  const out = [];
  for (const row of readDischargeObligations(repo)) {
    const entry = DISCHARGE_CATALOG[row.item_kind]?.[row.option];
    if (!entry || typeof entry.predicate !== "function") continue; // recordInterviewAnswer never persists a discharge:null row

    // Supersession: a strictly later interview answer for the SAME item
    // stands in for this one, whatever that later answer was — including one
    // that declared `discharge: null` and so left no obligation row of its
    // own. Never delete the earlier row; just stop treating it as owed.
    const latest = latestCoveringInterview(interviews, row.item_id);
    if (latest && latest.held_at > (row.interview_held_at ?? "")) continue;

    let satisfied = false;
    try {
      satisfied = !!entry.predicate(repo, { itemId: row.item_id, interviewDate: row.interview_held_at });
    } catch {
      satisfied = false;
    }
    if (satisfied) continue;
    out.push({
      id: row.id,
      kind: "discharge_obligation",
      source: DISCHARGE_STORE_PATH,
      due: row.due,
      age_days: null,
      summary: `interview answer "${row.option}" for ${row.item_id} (${row.item_kind}) is undischarged — ${row.mechanism ?? entry.mechanism}`,
      cites: [],
    });
  }
  return out;
}

/**
 * Records one interview's answers: appends the interview record to
 * `decisions/interviews.jsonl` and, for every answer whose option declares a discharge, a
 * matching obligation row to `decisions/discharge-obligations.jsonl` — in the
 * same call, so the two cannot diverge.
 *
 * `answers`: `[{ itemId, itemKind, option, outcome, deferredTo? }, ...]`.
 * `itemKind`/`option` MUST already be declared in `DISCHARGE_CATALOG`
 * (Decision §4: a silently-omitted declaration is a question-authoring
 * defect this refuses to paper over, not a `discharge: null` this infers).
 *
 * `witness` (ADR-178) is the structured binding scripts/interview-record.mjs
 * builds — egress, session, time, pack digest, question ids — validated by
 * `validateWitness` and required for any interview held after
 * `WITNESS_REQUIRED_AFTER`. It is part of the record, so the ADR-158 receipt
 * digests it: editing it afterwards orphans the record.
 *
 * Returns `{ interviewRecord, obligations }` — never partially writes: all
 * answers are validated against the catalog before anything is appended.
 */
export function recordInterviewAnswer(repo, { heldAt, answers, note, witness } = {}) {
  if (!DATE_RE.test(heldAt ?? "")) {
    throw new Error('recordInterviewAnswer: "heldAt" must be an ISO date ("YYYY-MM-DD")');
  }
  // ADR-178: the witness is checked here, by the sole writer, so no entry point
  // can write a record the queue would then refuse to count.
  if (witness !== undefined && witness !== null) {
    const errors = validateWitness(witness);
    if (errors.length) throw new Error(`recordInterviewAnswer: invalid witness — ${errors.join("; ")}`);
  } else if (heldAt > WITNESS_REQUIRED_AFTER) {
    throw new Error(
      `recordInterviewAnswer: an interview held after ${WITNESS_REQUIRED_AFTER} needs a witness (ADR-178) — ` +
        "ask through the host's native question tool and record with `bun run interview:record --pack <pack.json> --answers <answers.json>`",
    );
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error('recordInterviewAnswer: "answers" must be a non-empty array');
  }

  const covered = [];
  const outcomes = {};
  const deferredTo = {};
  const obligations = [];

  for (const answer of answers) {
    const { itemId, itemKind, option, outcome, deferredTo: itemDeferredTo } = answer ?? {};
    if (!itemId || !itemKind || !option || !outcome) {
      throw new Error(
        `recordInterviewAnswer: each answer needs itemId, itemKind, option, and outcome (got ${JSON.stringify(answer)})`,
      );
    }
    const kindCatalog = DISCHARGE_CATALOG[itemKind];
    if (!kindCatalog || !Object.prototype.hasOwnProperty.call(kindCatalog, option)) {
      throw new Error(
        `recordInterviewAnswer: no discharge declared for ${itemKind} option "${option}" — register it in ` +
          "scripts/lib/discharge-catalog.mjs (use `{ discharge: null }` if it truly implies no checkable work) " +
          "before it can be recorded as answered (ADR-137 Decision §4).",
      );
    }

    if (option === "defer with a date" && !(DATE_RE.test(itemDeferredTo ?? "") && itemDeferredTo > heldAt)) {
      throw new Error(
        `recordInterviewAnswer: "${itemId}" was answered "defer with a date" but its deferredTo ` +
          `(${JSON.stringify(itemDeferredTo ?? null)}) is not an ISO date after ${heldAt} — an undated deferral is the untracked promise the queue exists to surface.`,
      );
    }
    covered.push(itemId);
    outcomes[itemId] = outcome;
    if (itemDeferredTo) deferredTo[itemId] = itemDeferredTo;

    const entry = kindCatalog[option];
    if (entry.discharge === null) continue;
    if (typeof entry.predicate !== "function") {
      throw new Error(
        `recordInterviewAnswer: ${itemKind} option "${option}" declares neither a predicate nor \`discharge: null\` — ` +
          "scripts/lib/discharge-catalog.mjs entry is malformed.",
      );
    }
    obligations.push({
      id: `discharge:${itemId}`,
      item_id: itemId,
      item_kind: itemKind,
      option,
      due: heldAt,
      created_at: heldAt,
      interview_held_at: heldAt,
      mechanism: entry.mechanism ?? null,
    });
  }

  const interviewRecord = {
    held_at: heldAt,
    covered,
    outcomes,
    ...(Object.keys(deferredTo).length ? { deferred_to: deferredTo } : {}),
    ...(note ? { note } : {}),
    ...(witness ? { witness } : {}),
  };

  // Mint the receipt BEFORE writing the ledger line, so a crash between the two
  // leaves an unmatched receipt (harmless, and visible) rather than an
  // unattested ledger record (indistinguishable from a hand-written one).
  // ADR-158: the receipt is what separates a recorded answer from an invented
  // one, and it is minted here because this is the only sanctioned writer.
  interviewRecord.receipt_id = mintInterviewReceipt(repo, interviewRecord);

  appendJsonlLine(join(repo, INTERVIEW_LEDGER_PATH), interviewRecord);
  for (const obligation of obligations) appendJsonlLine(join(repo, DISCHARGE_STORE_PATH), obligation);

  return { interviewRecord, obligations };
}
