/**
 * scripts/lib/discharge-catalog.mjs — what each interview answer implies,
 * declared with the QUESTION, not invented at the moment of recording.
 *
 * ADR-137 ("An Interview Answer Queues Its Own Discharge") Decision §1: an
 * interview question may declare, per answer option, a machine-checkable
 * discharge — a predicate over repository state that must become true, and
 * the mechanism that makes it true. This module is that declaration, keyed
 * by `[item_kind][option]`, and it is also the option set the question pack
 * (scripts/interview-pack.mjs) offers through the host's native question tool
 * (ADR-178) — so a recordable option and an offered option cannot diverge
 * (proposed_record: accept/reject/keep Proposed with a review date/
 * supersede; waiver: renew with a new expiry/act on it now/delete the
 * exemption; vi_triage & completion_depth: re-attest/fix/change the verdict;
 * operator_decision: do it now/schedule it/drop it and say why;
 * operator_call: do the disposal now/retain deliberately, with the reason/
 * defer with a date; hazard: re-ground the commitments/accept the cited
 * record/defer with a date).
 *
 * SHAPE. Each entry is either:
 *   - `{ discharge: null }` — Decision §4: this option genuinely implies no
 *     checkable follow-on work. Declared, not omitted, so a missing
 *     declaration and a declared absence never look alike.
 *   - `{ mechanism, predicate }` — `mechanism` is the human-readable command
 *     that satisfies the obligation; `predicate(repo, { itemId,
 *     interviewDate }) => boolean` checks whether it already has, evaluated
 *     LIVE against repository state every time the queue derives (never a
 *     stored "done" flag an agent could set without doing the work).
 *
 * WHAT THIS DOES NOT COVER. Decision §5 is explicit that a discharge
 * predicate proves an artifact was produced, never that the thinking behind
 * it was sound — a triage row can be written without re-examining the
 * finding, and this module cannot and does not close that hole. It closes
 * the narrower one: the artifact never being produced at all, which is the
 * failure ADR-137 was written against (seven "re-attest" answers, zero
 * `--triage` writes, `gate:decision-queue` green).
 *
 * An `item_kind`/`option` pair with no entry here is a question-authoring
 * defect: `recordInterviewAnswer` (scripts/lib/discharge-store.mjs) refuses
 * to record an answer whose option was never declared, rather than silently
 * treating an unregistered option as `discharge: null`.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWaiverFile } from "./waiver-store.mjs";
import { findingNeedsTriageDecision } from "../vi-findings.mjs";
// WAIVER_SOURCES and operatorCalls are the single owners of "what a waiver
// commitment id is" and "what an operator call id is" — importing them keeps
// this module from re-deriving those ids and silently drifting from the
// queue's own idea of them. decision-queue.mjs imports discharge-store.mjs,
// which imports this module, so this is a circular import; it is safe here
// because both bindings are only read inside function bodies below, never at
// this module's top level, so by the time either runs the graph has finished
// initializing.
import { WAIVER_SOURCES, datedCommitmentsCiting, operatorCalls } from "../decision-queue.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A malformed row is a finding for the owning store's gate, not this
      // predicate's job — skip it rather than let it throw the obligation
      // into a false "discharged" state via an uncaught exception.
    }
  }
  return rows;
}

/** The Status: line of the decisions/ record whose filename starts with `id-`, numbered or ADR-PENDING alike. */
function recordStatus(repo, id) {
  const dir = join(repo, "decisions");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const fileName = entries.find((entry) => entry === `${id}.md` || entry.startsWith(`${id}-`));
  if (!fileName) return null;
  const text = readFileSync(join(dir, fileName), "utf8");
  return /^\*\*Status:\*\*\s*(.+)$/m.exec(text)?.[1]?.trim().toLowerCase().split(/[\s.,]/)[0] ?? null;
}

/**
 * Every DATED waiver entry whose commitment id is `itemId`. A waiver label is
 * not unique (anti-stub keys on `rule @ file`, and one file can carry several
 * entries for one rule, most of them undated permanent verdicts), so this
 * applies `waiverCommitments`' own filter: only a dated entry ever became a
 * commitment, so only a dated entry can discharge one. Returning the first
 * label match instead picked an undated sibling and left a real renewal
 * permanently undischarged.
 */
function findDatedWaiverEntriesById(repo, itemId) {
  const matches = [];
  for (const source of WAIVER_SOURCES) {
    const { entries } = loadWaiverFile(join(repo, source.path));
    for (const entry of entries) {
      if (!entry?.expires || !DATE_RE.test(entry.expires)) continue;
      if (`${source.schema}:${source.label(entry)}` === itemId) matches.push(entry);
    }
  }
  return matches;
}

/** A `finding_id`/`id`-keyed triage row whose `triage_expires` was set AFTER the interview that answered it — proof the mechanism actually ran, not merely that a row already existed. */
function triageRenewedSince(repo, storePath, idField, itemId, interviewDate) {
  const row = readJsonl(join(repo, storePath)).find((r) => r[idField] === itemId);
  return !!(row?.triage_expires && DATE_RE.test(row.triage_expires) && row.triage_expires > interviewDate);
}

function findingClosed(repo, storePath, idField, itemId) {
  return !readJsonl(join(repo, storePath)).some((r) => r[idField] === itemId);
}

/**
 * Absence as proof of closure, but only against a populated store: a missing
 * or empty findings file is indistinguishable from "unreadable", and treating
 * that as "every finding closed" would discharge every obligation at once.
 */
function findingClosedInPopulatedStore(repo, storePath, idField, itemId) {
  const rows = readJsonl(join(repo, storePath));
  return rows.length > 0 && !rows.some((r) => r[idField] === itemId);
}

/** `hazard:ADR-041` → `ADR-041`, the record the hazard's commitments cite. */
function hazardRecordId(itemId) {
  return String(itemId).replace(/^hazard:/, "");
}

export const DISCHARGE_CATALOG = {
  proposed_record: {
    accept: {
      mechanism: "bun run adr:accept <number>",
      predicate: (repo, { itemId }) => recordStatus(repo, itemId) === "accepted",
    },
    reject: {
      mechanism: "bun run adr:accept <number> --reject",
      predicate: (repo, { itemId }) => ["rejected", "redlined"].includes(recordStatus(repo, itemId)),
    },
    "keep proposed with a review date": { discharge: null },
    supersede: {
      mechanism: "bun run adr:accept <number> (a superseding decision must itself be accepted before it can supersede this one)",
      predicate: (repo, { itemId }) => recordStatus(repo, itemId) === "superseded",
    },
  },

  waiver: {
    "renew with a new expiry": {
      mechanism: "extend the waiver's `expires` field via its store's CRUD (scripts/lib/waiver-store.mjs)",
      predicate: (repo, { itemId, interviewDate }) => {
        const entries = findDatedWaiverEntriesById(repo, itemId);
        return entries.length > 0 && entries.every((entry) => entry.expires > interviewDate);
      },
    },
    "act on it now": { discharge: null },
    "delete the exemption": {
      mechanism: "remove the waiver entry from its store",
      predicate: (repo, { itemId }) => findDatedWaiverEntriesById(repo, itemId).length === 0,
    },
  },

  vi_triage: {
    "re-attest": {
      mechanism: 'bun scripts/vi-findings.mjs --triage <finding_id> --verdict <v> --reason "..." [--expires <ISO>]',
      // A finding that has since closed leaves nothing to attest: its triage
      // row is pruned with it, so "renewed since the interview" could never
      // become true. Absence from a populated store discharges; a present
      // finding still needs the row, and an empty store fails closed.
      predicate: (repo, { itemId, interviewDate }) =>
        findingClosedInPopulatedStore(repo, ".visual-intelligence/findings/findings.jsonl", "id", itemId)
        || triageRenewedSince(repo, ".visual-intelligence/findings/triage.jsonl", "finding_id", itemId, interviewDate),
    },
    fix: {
      mechanism: "fix the underlying finding, then re-run gate:vi-findings to confirm it closed",
      // "Fix" means the finding no longer needs a triage decision — never
      // narrower than that. A VI finding is a multi-symbol set: the fix may
      // have addressed only the newly-affected symbols the operator was
      // actually asked about, leaving the finding legitimately open for its
      // other, already-triaged symbols under a still-valid recorded verdict.
      // Requiring the WHOLE finding id to vanish from findings.jsonl (the
      // prior rule) could never discharge such a finding at all — confirmed
      // live against vi:09a11e41a63c075b (4 targeted files left the set, 96
      // others remain false_positive) and vi:73b536233ef07008
      // (latestGateRefusal left, 11 others remain false_positive). So this
      // discharges on EITHER of the two ways a finding can stop needing a
      // decision: it is gone outright, or gate:vi-findings' own per-finding
      // evaluation (findingNeedsTriageDecision, imported rather than
      // re-derived) says every current affected symbol is already covered by
      // a non-expired recorded verdict whose content hash matches — exactly
      // the gate's own pass condition for that finding, nothing narrower.
      predicate: (repo, { itemId }) =>
        findingClosed(repo, ".visual-intelligence/findings/findings.jsonl", "id", itemId) ||
        !findingNeedsTriageDecision(repo, itemId),
    },
    "change the verdict": { discharge: null },
  },

  completion_depth: {
    "re-attest": {
      mechanism: 'bun scripts/completion-depth.mjs --triage <finding_id> --verdict <v> --reason "..." [--expires <ISO>]',
      predicate: (repo, { itemId, interviewDate }) =>
        triageRenewedSince(repo, ".completion-depth/findings.jsonl", "id", itemId, interviewDate),
    },
    fix: {
      mechanism: "fix the underlying finding, then re-run gate:completion-depth to confirm it closed",
      // Deliberately NOT given the same multi-symbol treatment as
      // vi_triage.fix above: a completion-depth finding is 1:1 with one
      // guard site (one gating_key), carries its verdict inside the SAME row
      // as the finding rather than a separate triage store, and that verdict
      // survives every `--refresh` regardless of content-hash drift (see
      // completion-depth.mjs main(): "was?.verdict && was.verdict !==
      // 'untriaged'" carries forward unconditionally — there is no
      // reopen-on-content-change rule here at all). There is no set of
      // symbols to partially fix, so "the row disappeared" already IS
      // gate:completion-depth's own pass condition for that finding, not a
      // narrower stand-in for it.
      predicate: (repo, { itemId }) => findingClosed(repo, ".completion-depth/findings.jsonl", "id", itemId),
    },
    "change the verdict": { discharge: null },
  },

  operator_decision: {
    "do it now": { discharge: null },
    "schedule it": { discharge: null },
    "drop it and say why": { discharge: null },
  },

  operator_call: {
    "do the disposal now": {
      mechanism: "run the disposal command named in the operator call's own summary",
      predicate: (repo, { itemId }) => !operatorCalls(repo).some((call) => call.id === itemId),
    },
    "retain deliberately, with the reason": { discharge: null },
    "defer with a date": { discharge: null },
  },

  // A hazard is `hazard:<record>`: dated commitments resting on a record that
  // does not govern (decision-queue.mjs groups them by the record they cite).
  // It is one decision about the RECORD'S DEPENDENTS, not about the record —
  // the record's own fate is its proposed_record question. So the checkable
  // answers are the two ways the hazard stops deriving: the dependents stop
  // citing it, or it starts governing. Both predicates re-derive the hazard's
  // condition live; neither trusts the answer.
  hazard: {
    "re-ground the commitments": {
      mechanism: "rewrite each dependent commitment's justification to cite a record that governs, or retire the commitment, through its own store (waiver store / vi-findings --triage / completion-depth --triage)",
      predicate: (repo, { itemId }) => {
        const cited = hazardRecordId(itemId);
        return recordStatus(repo, cited) === "accepted" || datedCommitmentsCiting(repo, cited).length === 0;
      },
    },
    "accept the cited record": {
      mechanism: "bun run adr:accept <number> for the cited record (it needs its own standing interview)",
      predicate: (repo, { itemId }) => recordStatus(repo, hazardRecordId(itemId)) === "accepted",
    },
    // Covers the hazard until the date, then the queue's shelf-life rule
    // returns it — the considered "not yet" the hazard class most needs.
    "defer with a date": { discharge: null },
  },

  // An undischarged obligation from an earlier answer is itself queued, under
  // `discharge:<item>`. The operator can postpone it; that answer covers the
  // `discharge:<item>` id until `deferred_to`, after which the queue's own
  // shelf-life rule returns it. Re-answering the underlying item instead would
  // mint a fresh obligation due on the new interview's date, which is not a
  // postponement at all.
  discharge_obligation: {
    "defer with a date": { discharge: null },
  },
};
