import { describe, expect, it, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveDecisionQueue,
  coverageIndex,
  canonicalCoverageId,
  operatorCalls,
  proposedRecords,
  recordStatuses,
  DEFAULT_MAX_PROPOSED_AGE_DAYS,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_DUE_SOON_DAYS,
} from "../decision-queue.mjs";
import { recordInterviewAnswer, readDischargeObligations, DISCHARGE_STORE_PATH } from "../lib/discharge-store.mjs";
import { findingContentHash } from "../vi-finding-id.mjs";

/**
 * scripts/tests/decision-queue.test.mjs — the queue must be impossible to
 * empty by waiting.
 *
 * These tests drive `deriveDecisionQueue` against throwaway fixture repos
 * rather than the live checkout, per ADR-078: the real repo's commitment set
 * changes every time anyone triages anything, so asserting against it would
 * make this suite a function of whatever else happened today.
 *
 * The properties worth protecting, in order of how badly their absence would
 * hurt:
 *   1. A lapsed promise blocks. If this fails, the whole mechanism is
 *      decorative.
 *   2. An interview COVERS an item, and a deferral inside that interview
 *      expires — otherwise "interviewed once" would silence an item forever,
 *      which is the backlog this exists to prevent, wearing a hat.
 *   3. Orphaned VI triage rows are excluded. Counting them inflated live
 *      exposure ~2x on the day this was written, and an inflated queue
 *      teaches its reader to skim.
 */

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function fixture({
  adrs = [],
  pendingAdrs = [],
  viFindings = [],
  viTriage = [],
  interviews = [],
  waivers = null,
  operatorDecisions = [],
  completionDepth = [],
  dischargeObligations = [],
  omitDischargeStore = false,
  interviewBaseline = "2026-08-31",
  omitInterviewBaseline = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "decision-queue-"));
  dirs.push(dir);
  // ADR-158: recordInterviewAnswer mints its receipt into the git COMMON dir,
  // so a fixture that exercises it must be a real repository. A plain temp dir
  // makes the recorder refuse, which is the intended fail-closed behaviour.
  execFileSync("git", ["init", "-q"], { cwd: dir });

  for (const doc of operatorDecisions) {
    mkdirSync(join(dir, "docs/proposals"), { recursive: true });
    writeFileSync(
      join(dir, "docs/proposals", `operator-decisions-${doc.date}.md`),
      [`# Operator decisions — ${doc.date}`, "", ...doc.ids.map((id) => `## ${id} — Fixture decision\n\nFixture-only.\n`)].join("\n"),
    );
  }

  mkdirSync(join(dir, "decisions"), { recursive: true });
  for (const adr of adrs) {
    writeFileSync(
      join(dir, "decisions", `ADR-${adr.num}-${adr.slug ?? "fixture"}.md`),
      [`# ADR-${adr.num}: ${adr.title ?? "Fixture"}`, "", `**Status:** ${adr.status}`, `**Date:** ${adr.date}`, "",
       "## Context", "", "Fixture-only.", ""].join("\n"),
    );
  }
  for (const pending of pendingAdrs) {
    writeFileSync(
      join(dir, "decisions", `ADR-PENDING-${pending.slug}.md`),
      [`# ADR-PENDING: ${pending.title ?? "Fixture pending"}`, "", `**Status:** ${pending.status ?? "Proposed"}`, `**Date:** ${pending.date}`, "",
       "## Context", "", "Fixture-only.", ""].join("\n"),
    );
  }
  if (interviews.length) {
    writeFileSync(join(dir, "decisions", "interviews.jsonl"), interviews.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  // The discharge store is written UNCONDITIONALLY — empty when no obligations are
  // supplied, which is the real repository's steady state and the state the gate
  // now requires. It used to be written only `if (dischargeObligations.length)`,
  // which made an ABSENT store this suite's default: the one state P-6 is about was
  // the one state no test could construct on purpose, so the whole suite was green
  // on the absent path by construction. Absence is now something a test has to ask
  // for, so asking for it is a deliberate act.
  if (!omitDischargeStore) {
    writeFileSync(join(dir, DISCHARGE_STORE_PATH), dischargeObligations.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  // ADR-158's baseline declaration, which is also the cutoff the discharge-absence
  // check reads — it dates the point before which interview history is not required
  // to have come from the recorder, and therefore the point before which an absent
  // discharge store is explained rather than suspicious.
  if (!omitInterviewBaseline) {
    mkdirSync(join(dir, "scripts/interview"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/interview/baseline.json"),
      `${JSON.stringify({ schema_version: 1, records_historical_through: interviewBaseline, adr: 158 }, null, 2)}\n`,
    );
  }

  mkdirSync(join(dir, ".visual-intelligence/findings"), { recursive: true });
  writeFileSync(join(dir, ".visual-intelligence/findings/findings.jsonl"), viFindings.map((f) => JSON.stringify(f)).join("\n"));
  writeFileSync(join(dir, ".visual-intelligence/findings/triage.jsonl"), viTriage.map((r) => JSON.stringify(r)).join("\n"));

  if (completionDepth.length) {
    mkdirSync(join(dir, ".completion-depth"), { recursive: true });
    writeFileSync(join(dir, ".completion-depth/findings.jsonl"), completionDepth.map((r) => JSON.stringify(r)).join("\n"));
  }

  if (waivers) {
    mkdirSync(join(dir, "scripts/reachability"), { recursive: true });
    writeFileSync(join(dir, "scripts/reachability/allowlist.json"), JSON.stringify({ version: 1, entries: waivers }, null, 2));
  }
  return dir;
}

const TODAY = "2026-08-18";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the thresholds are pinned against quiet widening", () => {
  // The skill forbids widening the horizon "to make the queue look shorter",
  // and prose does not enforce itself. Pinning the values means raising one is
  // a visible edit to a named constant AND to this test — reviewable, rather
  // than a flag an agent quietly passes when the queue is inconvenient.
  //
  // These assertions are not claims that 7 and 14 are the right numbers. They
  // are claims that changing them is a deliberate act.
  it("the maximum Proposed age is 7 days", () => {
    expect(DEFAULT_MAX_PROPOSED_AGE_DAYS).toBe(7);
  });

  it("the upcoming lookahead is 14 days", () => {
    expect(DEFAULT_HORIZON_DAYS).toBe(14);
  });

  it("the due-soon (blocking) window is 3 days", () => {
    expect(DEFAULT_DUE_SOON_DAYS).toBe(3);
  });

  it("an OPERATOR DECISION ages on the same clock as a Proposed record", () => {
    // Both are undated commitments. Twelve operator decisions sat unblocking
    // at the old threshold because nothing forced them; the age check covers
    // both kinds, and this asserts it rather than assuming it.
    const repo = fixture({ operatorDecisions: [{ date: "2026-08-01", ids: ["D1"] }] });
    const report = deriveDecisionQueue({ repo, today: TODAY, maxProposedAgeDays: 7 });
    expect(report.ok).toBe(false);
    expect(report.over_age.some((i) => i.kind === "operator_decision")).toBe(true);
  });
});

describe("a lapsed commitment blocks", () => {
  it("FAILS when a waiver's expiry has already passed", () => {
    const repo = fixture({
      waivers: [{ symbol: "x", file: "a.ts", reason: "deliberate", expires: "2026-08-01" }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(false);
    expect(report.lapsed).toHaveLength(1);
    expect(report.lapsed[0].due).toBe("2026-08-01");
  });

  it("PASSES when the same waiver is still in date and outside the horizon", () => {
    const repo = fixture({
      waivers: [{ symbol: "x", file: "a.ts", reason: "deliberate", expires: "2026-12-01" }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(true);
    expect(report.lapsed).toHaveLength(0);
    expect(report.due_soon).toHaveLength(0);
  });

  it("a waiver with 7+ days left does not block, and is listed as upcoming, not due-soon", () => {
    // The exact trip: a correctly-filed, far-dated waiver went red on the
    // same gate as one with two days of runway. 7 days out is well past the
    // 3-day due-soon window but inside the 14-day upcoming lookahead.
    const repo = fixture({
      waivers: [{ symbol: "x", file: "a.ts", reason: "deliberate", expires: "2026-08-25" }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(true);
    expect(report.due_soon).toHaveLength(0);
    expect(report.upcoming).toHaveLength(1);
    expect(report.upcoming[0].id).toBe("reachability:x (a.ts)");
  });
});

describe("an interview covers an item, and a deferral inside it expires", () => {
  // TODAY is 2026-08-18; 2026-08-20 is 2 days out — inside the 3-day due-soon
  // window, so it must still block.
  const dueSoonWaiver = [{ symbol: "x", file: "a.ts", reason: "deliberate", expires: "2026-08-20" }];

  it("an uninterviewed item inside the due-soon window FAILS", () => {
    const repo = fixture({ waivers: dueSoonWaiver });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(false);
    expect(report.due_soon).toHaveLength(1);
  });

  it("recording an interview that covers it PASSES", () => {
    const repo = fixture({
      waivers: dueSoonWaiver,
      interviews: [{ held_at: TODAY, covered: ["reachability:x (a.ts)"], outcomes: { "reachability:x (a.ts)": "keep" } }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(true);
  });

  it("TEETH: a deferral that has itself expired stops covering the item", () => {
    // Without this, one interview would silence an item permanently — the
    // exact backlog this mechanism exists to prevent, just relocated.
    const repo = fixture({
      waivers: dueSoonWaiver,
      interviews: [{
        held_at: "2026-07-01",
        covered: ["reachability:x (a.ts)"],
        deferred_to: { "reachability:x (a.ts)": "2026-08-10" },
      }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(false);
    expect(report.due_soon).toHaveLength(1);
  });
});

describe("a Proposed ADR is flagged from day zero but never blocks (ADR-085)", () => {
  it("routes a Proposed record to flagged_proposed — visible, not blocking — regardless of age", () => {
    const repo = fixture({ adrs: [{ num: "900", status: "Proposed", date: "2026-07-01" }] });
    const report = deriveDecisionQueue({ repo, today: TODAY, maxProposedAgeDays: 21 });
    expect(report.flagged_proposed.map((i) => i.id)).toContain("ADR-900");
    expect(report.over_age.map((i) => i.id)).not.toContain("ADR-900");
    // A proposed ADR alone never fails the queue now — the SessionStart hook is
    // the proactive nudge and gate:adr-decision-followthrough carries the teeth.
    expect(report.ok).toBe(true);
  });

  it("flags a young Proposed record too (grace nullified), and never lists an Accepted one", () => {
    const repo = fixture({
      adrs: [
        { num: "901", status: "Proposed", date: "2026-08-14" },
        { num: "902", status: "Accepted", date: "2020-01-01" },
      ],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY, maxProposedAgeDays: 21 });
    expect(report.flagged_proposed.map((i) => i.id)).toContain("ADR-901");
    expect(report.over_age).toHaveLength(0);
    expect(report.items.map((i) => i.id)).not.toContain("ADR-902");
  });

  it("an interview covering the proposed record clears it from the flagged list", () => {
    const repo = fixture({
      adrs: [{ num: "900", status: "Proposed", date: "2026-07-01" }],
      interviews: [{ held_at: "2026-08-20", covered: ["ADR-900"] }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY, maxProposedAgeDays: 21 });
    expect(report.flagged_proposed.map((i) => i.id)).not.toContain("ADR-900");
  });
});

describe("orphaned VI triage rows are excluded from the queue", () => {
  it("counts only triage rows whose finding is still open", () => {
    const repo = fixture({
      viFindings: [{ id: "vi:live" }],
      viTriage: [
        { finding_id: "vi:live", verdict: "accepted_tradeoff", triage_expires: "2026-12-01", reason: "live one" },
        { finding_id: "vi:gone", verdict: "accepted_tradeoff", triage_expires: "2026-12-01", reason: "orphan" },
      ],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.orphaned_vi_triage_rows).toBe(1);
    expect(report.items.filter((i) => i.kind === "vi_triage").map((i) => i.id)).toEqual(["vi:live"]);
  });

  it("a false_positive verdict is not a commitment — it carries no future work", () => {
    const repo = fixture({
      viFindings: [{ id: "vi:live" }],
      viTriage: [{ finding_id: "vi:live", verdict: "false_positive", triage_expires: "2026-12-01", reason: "wrong at this site" }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.items.filter((i) => i.kind === "vi_triage")).toHaveLength(0);
  });
});

describe("a dated commitment resting on a record that does not govern is a hazard", () => {
  it("TEETH: a REJECTED record is a hazard, not just a Proposed one", () => {
    // The blind spot that shipped first: the check scanned only Proposed
    // records, so REJECTING a record removed it from the set and four waivers
    // went on citing a withdrawn justification with the queue reporting
    // nothing. A rejected citation is the worse case, not the lesser one.
    const repo = fixture({
      adrs: [{ num: "904", status: "Rejected", date: "2026-08-01" }],
      waivers: [{ symbol: "x", file: "a.ts", expires: "2026-12-01", reason: "justified by ADR-904 and nothing else" }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(false);
    expect(report.hazards).toHaveLength(1);
    expect(report.hazards[0].cites).toBe("ADR-904");
    expect(report.hazards[0].status).toBe("rejected");
  });

  it("TEETH: an interview can clear a hazard, keyed by the cited record", () => {
    // Hazards were originally counted unconditionally, so no interview could
    // ever clear one — the deferral valve did not apply to the class most
    // likely to need it. Keyed by the CITED record, because that is the one
    // decision to make however many commitments rest on it.
    const base = {
      adrs: [{ num: "907", status: "Rejected", date: "2026-08-01" }],
      waivers: [{ symbol: "x", file: "a.ts", expires: "2026-12-01", reason: "rests on ADR-907" }],
    };
    expect(deriveDecisionQueue({ repo: fixture(base), today: TODAY }).hazards).toHaveLength(1);

    const interviewed = fixture({
      ...base,
      interviews: [{ held_at: TODAY, covered: ["hazard:ADR-907"], outcomes: { "hazard:ADR-907": "handled by the rewrite landing today" } }],
    });
    const report = deriveDecisionQueue({ repo: interviewed, today: TODAY });
    expect(report.hazards).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it("an ACCEPTED record is not a hazard — it governs, so resting on it is correct", () => {
    const repo = fixture({
      adrs: [{ num: "905", status: "Accepted", date: "2026-08-01" }],
      waivers: [{ symbol: "x", file: "a.ts", expires: "2026-12-01", reason: "justified by ADR-905" }],
    });
    expect(deriveDecisionQueue({ repo, today: TODAY }).hazards).toHaveLength(0);
  });

  it("TEETH: the citation is found past the 160-char summary cap", () => {
    // ADR-041's citation sat beyond the display cap, so scanning the summary
    // found nothing while the justification plainly named the record.
    const buried = "RE-JUSTIFIED. " + "padding text to push the citation past the display cap. ".repeat(6) + "See ADR-906 for the rationale.";
    expect(buried.slice(0, 160)).not.toContain("ADR-906");
    const repo = fixture({
      adrs: [{ num: "906", status: "Proposed", date: "2026-08-01" }],
      waivers: [{ symbol: "x", file: "a.ts", expires: "2026-12-01", reason: buried }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.hazards.map((h) => h.cites)).toContain("ADR-906");
  });

  it("groups by the undated record rather than repeating per dependent", () => {
    const repo = fixture({
      adrs: [{ num: "903", status: "Proposed", date: "2026-08-17" }],
      viFindings: [{ id: "vi:a" }, { id: "vi:b" }],
      viTriage: [
        { finding_id: "vi:a", verdict: "accepted_tradeoff", triage_expires: "2026-12-01", reason: "rests on ADR-903 entirely" },
        { finding_id: "vi:b", verdict: "accepted_tradeoff", triage_expires: "2026-11-01", reason: "also cites ADR-903 here" },
      ],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    // One hazard, not two — one Proposed record is one decision to make.
    expect(report.hazards).toHaveLength(1);
    expect(report.hazards[0].cites).toBe("ADR-903");
    expect(report.hazards[0].dependents).toHaveLength(2);
    expect(report.hazards[0].earliest_due).toBe("2026-11-01");
  });
});

describe("coverageIndex keeps the most recent interview", () => {
  it("a later interview supersedes an earlier one for the same item", () => {
    const covered = coverageIndex([
      { held_at: "2026-01-01", covered: ["x"], deferred_to: { x: "2026-02-01" } },
      { held_at: "2026-08-01", covered: ["x"] },
    ], TODAY);
    // The stale deferral must not delete coverage granted by the later record.
    expect(covered.has("x")).toBe(true);
    expect(covered.get("x").held_at).toBe("2026-08-01");
  });

  it("a same-day re-interview supersedes the earlier one, so a reversed deferral takes effect", () => {
    // The ledger is append-only: two records can share a held_at date when an
    // operator revisits an item later the same day. With a strict `>` date
    // comparison the morning's deferral survived and the afternoon's reversal
    // was silently discarded — the operator's second answer simply vanished.
    const covered = coverageIndex([
      { held_at: "2026-08-26", covered: ["x"], deferred_to: { x: "2026-09-09" } },
      { held_at: "2026-08-26", covered: ["x"], outcomes: { x: "accept" } },
    ], TODAY);
    expect(covered.get("x").deferred_to).toBeNull();
  });

  it("recognizes the source-prefixed operator-decision ids written by early interviews", () => {
    const covered = coverageIndex([{
      held_at: "2026-08-19",
      covered: ["docs/proposals/operator-decisions-2026-08-19:D10"],
      outcomes: {
        "docs/proposals/operator-decisions-2026-08-19:D10": "ratified",
      },
    }], TODAY);

    expect(covered.has("operator-decisions-2026-08-19:D10")).toBe(true);
    expect(covered.has("docs/proposals/operator-decisions-2026-08-19:D10")).toBe(false);
  });
});

describe("operator-call items cannot be outwaited", () => {
  // The class that motivated the change: a gate reported 63 orphaned triage
  // rows on every run for weeks, disposable only by a human, and nothing ever
  // forced the disposition. "Deleting is your call" with no mechanism behind
  // it is how a backlog forms.
  const withOrphans = () => fixture({
    viFindings: [{ id: "vi:live" }],
    viTriage: [
      { finding_id: "vi:live", verdict: "false_positive", reason: "x" },
      { finding_id: "vi:gone-1", verdict: "accepted_tradeoff", triage_expires: "2026-12-01", reason: "orphan" },
      { finding_id: "vi:gone-2", verdict: "false_positive", reason: "orphan" },
    ],
  });

  it("orphaned triage rows become ONE blocking item, not one per row", () => {
    const repo = withOrphans();
    const report = deriveDecisionQueue({ repo, today: TODAY });
    const calls = report.operator_calls.filter((i) => i.id === "operator-call:vi-triage-orphans");
    expect(calls).toHaveLength(1);
    expect(calls[0].count).toBe(2);
    expect(report.ok).toBe(false);
  });

  it("TEETH: it has NO expiry, so time alone never clears it", () => {
    // The whole point. A dated waiver eventually lapses into a louder failure;
    // an operator call would otherwise sit at exactly the same volume forever.
    const repo = withOrphans();
    const soon = deriveDecisionQueue({ repo, today: TODAY });
    const muchLater = deriveDecisionQueue({ repo, today: "2099-01-01" });
    expect(soon.ok).toBe(false);
    expect(muchLater.ok).toBe(false);
    expect(muchLater.operator_calls).toHaveLength(1);
  });

  it("an interview clears it, and a dated deferral re-raises it once the date passes", () => {
    const repo = withOrphans();
    const covered = deriveDecisionQueue({
      repo, today: TODAY,
      // written directly into the fixture's ledger below
    });
    expect(covered.ok).toBe(false);

    const repoWithInterview = fixture({
      viFindings: [{ id: "vi:live" }],
      viTriage: [{ finding_id: "vi:gone-1", verdict: "false_positive", reason: "orphan" }],
      interviews: [{
        held_at: TODAY,
        covered: ["operator-call:vi-triage-orphans"],
        outcomes: { "operator-call:vi-triage-orphans": "retain deliberately" },
        deferred_to: { "operator-call:vi-triage-orphans": "2026-10-01" },
      }],
    });
    expect(deriveDecisionQueue({ repo: repoWithInterview, today: TODAY }).ok).toBe(true);
    // Once the deferral runs out it is owed again — a deferral is a decision
    // with a shelf life, not an exemption.
    const after = deriveDecisionQueue({ repo: repoWithInterview, today: "2026-10-02" });
    expect(after.ok).toBe(false);
    expect(after.operator_calls.map((i) => i.id)).toContain("operator-call:vi-triage-orphans");
  });

  it("does not call a re-identifiable triage row an orphan just because its finding id rotated", () => {
    // A finding id is content-addressed and rotates when its node set shifts;
    // `vi-findings.mjs --rewrite-ids` rekeys the triage row, and the row's
    // recorded symbol_set is what lets it survive the rotation. Counting the
    // row as an orphan on a bare id miss told the operator to run
    // --prune-orphans, which applies the symbol-set rule, correctly finds
    // nothing to prune, and leaves the operator call standing every run
    // forever -- a remedy that cannot clear the item it is named for.
    const repo = fixture({
      viFindings: [{ id: "vi:rotated", affected_nodes: ["sym:a", "sym:b"] }],
      viTriage: [{ finding_id: "vi:stale-id", symbol_set: ["sym:b", "sym:a"], verdict: "false_positive", reason: "x" }],
    });
    expect(operatorCalls(repo).filter((c) => c.id === "operator-call:vi-triage-orphans")).toHaveLength(0);
    expect(deriveDecisionQueue({ repo, today: TODAY }).orphaned_vi_triage_rows).toBe(0);
  });

  it("still calls a row an orphan when its symbol set matches nothing live", () => {
    const repo = fixture({
      viFindings: [{ id: "vi:live", affected_nodes: ["sym:a"] }],
      viTriage: [{ finding_id: "vi:gone", symbol_set: ["sym:vanished"], verdict: "false_positive", reason: "x" }],
    });
    expect(operatorCalls(repo).filter((c) => c.id === "operator-call:vi-triage-orphans")).toHaveLength(1);
  });

  it("reports nothing when there is nothing to dispose of", () => {
    // An operator call that fires on a clean repo would train its reader to
    // dismiss it, which is the failure mode this whole mechanism guards.
    const repo = fixture({ viFindings: [{ id: "vi:live" }], viTriage: [{ finding_id: "vi:live", verdict: "false_positive", reason: "x" }] });
    expect(operatorCalls(repo).filter((c) => c.id === "operator-call:vi-triage-orphans")).toHaveLength(0);
  });
});

describe("ADR-140: an ADR-PENDING record is visible to the queue", () => {
  it("enters the queue as a proposed_record, keyed on its slug, aged from its Date line", () => {
    const repo = fixture({ pendingAdrs: [{ slug: "kb-retrieval-thing", date: "2026-08-10" }] });
    const items = proposedRecords(repo, TODAY);
    const item = items.find((i) => i.id === "ADR-PENDING-kb-retrieval-thing");
    expect(item).toBeDefined();
    expect(item.kind).toBe("proposed_record");
    expect(item.unallocated).toBe(true);
    // TODAY is 2026-08-18; the record is dated 2026-08-10 -> 8 days old.
    expect(item.age_days).toBe(8);
  });

  it("flags via deriveDecisionQueue exactly like a numbered Proposed record, without blocking on its own", () => {
    const repo = fixture({ pendingAdrs: [{ slug: "foo", date: "2026-08-01" }] });
    const report = deriveDecisionQueue({ repo, today: TODAY, maxProposedAgeDays: 21 });
    expect(report.flagged_proposed.map((i) => i.id)).toContain("ADR-PENDING-foo");
    expect(report.ok).toBe(true); // proposed_record never blocks on its own (ADR-085)
  });

  it("recordStatuses excludes an unallocated pending record", () => {
    const repo = fixture({
      pendingAdrs: [{ slug: "foo", date: "2026-08-01" }],
      adrs: [{ num: "950", status: "Proposed", date: "2026-08-01" }],
    });
    const statuses = recordStatuses(repo);
    expect(statuses.has("ADR-950")).toBe(true);
    expect(statuses.has("ADR-PENDING-foo")).toBe(false);
    expect([...statuses.keys()].some((k) => k.includes("PENDING"))).toBe(false);
  });

  it("a slug id and its later allocated number are distinct coverage keys — no equivalence is inferred", () => {
    // ADR-140 Decision §3: covering ADR-PENDING-foo must not silently cover
    // ADR-141 once the slug is allocated that number. canonicalCoverageId
    // performs no slug<->number rebinding (only the historical operator-decisions
    // path-vs-stem compatibility fix), and coverageIndex keys strictly on
    // the id as recorded.
    expect(canonicalCoverageId("ADR-PENDING-foo")).toBe("ADR-PENDING-foo");
    expect(canonicalCoverageId("ADR-141")).toBe("ADR-141");
    const covered = coverageIndex([{ held_at: TODAY, covered: ["ADR-PENDING-foo"] }], TODAY);
    expect(covered.has("ADR-PENDING-foo")).toBe(true);
    expect(covered.has("ADR-141")).toBe(false);
  });
});

describe("ADR-137: an interview answer queues its own discharge", () => {
  const HELD_AT = "2026-08-01"; // well before TODAY (2026-08-18), so an undischarged obligation is LAPSED

  it("recordInterviewAnswer writes both the interview record and a discharge obligation row", () => {
    const repo = fixture({ viFindings: [{ id: "vi:abc" }], viTriage: [] });
    const { interviewRecord, obligations } = recordInterviewAnswer(repo, {
      heldAt: HELD_AT,
      answers: [{ itemId: "vi:abc", itemKind: "vi_triage", option: "re-attest", outcome: "re-attest with the same verdict" }],
    });
    expect(interviewRecord.covered).toEqual(["vi:abc"]);
    const ledgerText = readFileSync(join(repo, "decisions/interviews.jsonl"), "utf8");
    expect(ledgerText).toContain("vi:abc");
    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toMatchObject({ id: "discharge:vi:abc", item_id: "vi:abc", item_kind: "vi_triage", option: "re-attest", due: HELD_AT });
    const stored = readDischargeObligations(repo);
    expect(stored).toHaveLength(1);
  });

  it("refuses to record an answer for an undeclared item_kind/option pair", () => {
    const repo = fixture({});
    expect(() =>
      recordInterviewAnswer(repo, {
        heldAt: HELD_AT,
        answers: [{ itemId: "vi:abc", itemKind: "vi_triage", option: "shrug", outcome: "whatever" }],
      }),
    ).toThrow(/no discharge declared/);
  });

  it("an option declared discharge: null queues no obligation", () => {
    const repo = fixture({ adrs: [{ num: "960", status: "Proposed", date: "2026-08-01" }] });
    const { obligations } = recordInterviewAnswer(repo, {
      heldAt: HELD_AT,
      answers: [{ itemId: "ADR-960", itemKind: "proposed_record", option: "keep proposed with a review date", outcome: "not yet, revisit later" }],
    });
    expect(obligations).toHaveLength(0);
    expect(readDischargeObligations(repo)).toHaveLength(0);
  });

  it("TEETH: an undischarged obligation past its due date blocks the queue (the push boundary per ADR-128)", () => {
    // The exact 2026-08-26 failure this ADR was written against: an interview
    // answered "re-attest", the triage row was never written, and the queue
    // must not report clean.
    const repo = fixture({
      viFindings: [{ id: "vi:abc" }],
      viTriage: [], // the --triage write that should have happened never did
      dischargeObligations: [{
        id: "discharge:vi:abc",
        item_id: "vi:abc",
        item_kind: "vi_triage",
        option: "re-attest",
        due: HELD_AT,
        created_at: HELD_AT,
        interview_held_at: HELD_AT,
        mechanism: "bun scripts/vi-findings.mjs --triage vi:abc --verdict accepted_tradeoff --reason \"...\"",
      }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(false);
    expect(report.lapsed.map((i) => i.id)).toContain("discharge:vi:abc");
  });

  it("an undischarged obligation can be deferred with a date, and returns when the date passes", () => {
    const obligation = {
      id: "discharge:vi:abc",
      item_id: "vi:abc",
      item_kind: "vi_triage",
      option: "fix",
      due: HELD_AT,
      created_at: HELD_AT,
      interview_held_at: HELD_AT,
      mechanism: "fix the underlying finding",
    };
    const repo = fixture({ viFindings: [{ id: "vi:abc" }], viTriage: [], dischargeObligations: [obligation] });
    const { obligations } = recordInterviewAnswer(repo, {
      heldAt: TODAY,
      answers: [{ itemId: "discharge:vi:abc", itemKind: "discharge_obligation", option: "defer with a date", outcome: "not this tranche", deferredTo: "2026-08-25" }],
    });
    expect(obligations).toHaveLength(0);
    const deferred = deriveDecisionQueue({ repo, today: TODAY });
    expect([...deferred.lapsed, ...deferred.due_soon].map((i) => i.id)).not.toContain("discharge:vi:abc");
    const expired = deriveDecisionQueue({ repo, today: "2026-08-26" });
    expect(expired.ok).toBe(false);
    expect(expired.lapsed.map((i) => i.id)).toContain("discharge:vi:abc");
  });

  it("refuses a 'defer with a date' answer with no date, or a date not after the interview", () => {
    const repo = fixture({});
    for (const deferredTo of [undefined, "soon", HELD_AT]) {
      expect(() =>
        recordInterviewAnswer(repo, {
          heldAt: HELD_AT,
          answers: [{ itemId: "discharge:vi:abc", itemKind: "discharge_obligation", option: "defer with a date", outcome: "later", deferredTo }],
        }),
      ).toThrow(/not an ISO date after/);
    }
  });

  it("a re-attest obligation for a finding that has since closed discharges — there is nothing left to attest", () => {
    const repo = fixture({
      viFindings: [{ id: "vi:other" }], // a populated store that no longer lists the finding
      viTriage: [], // pruned together with the finding
      dischargeObligations: [{
        id: "discharge:vi:gone",
        item_id: "vi:gone",
        item_kind: "vi_triage",
        option: "re-attest",
        due: HELD_AT,
        created_at: HELD_AT,
        interview_held_at: HELD_AT,
        mechanism: "bun scripts/vi-findings.mjs --triage vi:gone ...",
      }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.items.map((i) => i.id)).not.toContain("discharge:vi:gone");
  });

  it("the obligation clears itself once the mechanism actually runs — no stored flag, a live predicate", () => {
    const repo = fixture({
      viFindings: [{ id: "vi:abc" }],
      // the mechanism ran AFTER the interview: triage_expires is set past HELD_AT
      viTriage: [{ finding_id: "vi:abc", verdict: "accepted_tradeoff", triage_expires: "2026-09-01", reason: "re-attested" }],
      dischargeObligations: [{
        id: "discharge:vi:abc",
        item_id: "vi:abc",
        item_kind: "vi_triage",
        option: "re-attest",
        due: HELD_AT,
        created_at: HELD_AT,
        interview_held_at: HELD_AT,
        mechanism: "bun scripts/vi-findings.mjs --triage ...",
      }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.lapsed.map((i) => i.id)).not.toContain("discharge:vi:abc");
    // No item at all appears for a satisfied obligation — it is not merely unblocking, it is gone.
    expect(report.items.map((i) => i.id)).not.toContain("discharge:vi:abc");
  });

  it("a predicate that throws (store unreadable) fails CLOSED — still undischarged, still blocks", () => {
    const repo = fixture({
      // No .visual-intelligence directory content beyond the fixture default (empty files),
      // and an obligation citing an item_kind the catalog does declare a predicate for but
      // whose finding_id will simply not be found — the predicate returns false, not throws,
      // for a missing row, which is exactly the fail-closed behavior under test.
      dischargeObligations: [{
        id: "discharge:vi:missing",
        item_id: "vi:missing",
        item_kind: "vi_triage",
        option: "re-attest",
        due: HELD_AT,
        created_at: HELD_AT,
        interview_held_at: HELD_AT,
        mechanism: "bun scripts/vi-findings.mjs --triage vi:missing ...",
      }],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.lapsed.map((i) => i.id)).toContain("discharge:vi:missing");
  });
});

describe("the discharge predicate defect: 'fix' means the gate would not require a decision", () => {
  const HELD_AT = "2026-08-01"; // before TODAY (2026-08-18) — a fix obligation with no matching row is LAPSED

  const fixObligation = (itemId) => ({
    id: `discharge:${itemId}`,
    item_id: itemId,
    item_kind: "vi_triage",
    option: "fix",
    due: HELD_AT,
    created_at: HELD_AT,
    interview_held_at: HELD_AT,
    mechanism: "fix the underlying finding, then re-run gate:vi-findings to confirm it closed",
  });

  it("DISCHARGES a multi-symbol finding whose targeted symbol left the set while its remaining symbols carry a still-valid verdict", () => {
    // The live vi:09a11e41a63c075b / vi:73b536233ef07008 shape: the finding
    // is still present (other symbols keep it alive), but every CURRENT
    // affected symbol is covered by a non-expired, content-hash-matching
    // verdict — gate:vi-findings itself would not flag it.
    const finding = { id: "vi:multi000000000a", category: "hollow_candidate", title: "hollow-candidate: 3 symbol(s) in cli.ts", affected_nodes: ["sym:a", "sym:b", "sym:c"] };
    const repo = fixture({
      viFindings: [finding],
      viTriage: [{
        finding_id: finding.id, verdict: "false_positive", reason: "the remaining symbols were always fine",
        triage_expires: "2099-12-31", content_hash: findingContentHash(finding), symbol_set: ["sym:a", "sym:b", "sym:c"],
      }],
      dischargeObligations: [fixObligation(finding.id)],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(true);
    expect(report.items.map((i) => i.id)).not.toContain(`discharge:${finding.id}`);
  });

  it("does NOT discharge a finding that still needs a triage decision (an untriaged newly-affected symbol)", () => {
    const finding = { id: "vi:multi000000000b", category: "hollow_candidate", title: "hollow-candidate: 2 symbol(s) in cli.ts", affected_nodes: ["sym:a", "sym:b"] };
    const repo = fixture({
      viFindings: [finding],
      // triaged only against sym:a — sym:b is a newly-affected, never-triaged symbol
      viTriage: [{
        finding_id: finding.id, verdict: "false_positive", reason: "x",
        triage_expires: "2099-12-31",
        content_hash: findingContentHash({ ...finding, affected_nodes: ["sym:a"] }),
        symbol_set: ["sym:a"],
      }],
      dischargeObligations: [fixObligation(finding.id)],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(false);
    expect(report.lapsed.map((i) => i.id)).toContain(`discharge:${finding.id}`);
  });

  it("DISCHARGES when the finding is absent outright", () => {
    const repo = fixture({
      viFindings: [],
      viTriage: [],
      dischargeObligations: [fixObligation("vi:goneabsent00000")],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(true);
    expect(report.items.map((i) => i.id)).not.toContain("discharge:vi:goneabsent00000");
  });
});

describe("obligation supersession: the LATEST interview answer for an item id governs", () => {
  const EARLY = "2026-08-01";
  const LATE = "2026-08-10"; // still before TODAY (2026-08-18)

  it("a later 'change the verdict' answer supersedes an earlier 'fix' obligation — no longer owed", () => {
    const itemId = "vi:superseded00000a";
    const finding = { id: itemId, category: "hollow_candidate", title: "hollow-candidate: 1 symbol(s)", affected_nodes: ["sym:a"] };
    const repo = fixture({
      viFindings: [finding],
      viTriage: [], // the fix was never made — if this obligation still applied, it would block
      dischargeObligations: [{
        id: `discharge:${itemId}`, item_id: itemId, item_kind: "vi_triage", option: "fix",
        due: EARLY, created_at: EARLY, interview_held_at: EARLY,
        mechanism: "fix the underlying finding, then re-run gate:vi-findings to confirm it closed",
      }],
      interviews: [
        { held_at: EARLY, covered: [itemId], outcomes: { [itemId]: "fix" } },
        { held_at: LATE, covered: [itemId], outcomes: { [itemId]: "change the verdict instead" } },
      ],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(true);
    expect(report.items.map((i) => i.id)).not.toContain(`discharge:${itemId}`);
  });

  it("TEETH: an earlier interview record never supersedes a LATER obligation for the same item", () => {
    const itemId = "vi:superseded00000b";
    const finding = { id: itemId, category: "hollow_candidate", title: "hollow-candidate: 1 symbol(s)", affected_nodes: ["sym:a"] };
    const repo = fixture({
      viFindings: [finding],
      viTriage: [],
      // The obligation's OWN interview (LATE) is the most recent answer; an
      // earlier record naming the same item (EARLY) must not cancel it out.
      dischargeObligations: [{
        id: `discharge:${itemId}`, item_id: itemId, item_kind: "vi_triage", option: "fix",
        due: LATE, created_at: LATE, interview_held_at: LATE,
        mechanism: "fix the underlying finding, then re-run gate:vi-findings to confirm it closed",
      }],
      interviews: [
        { held_at: EARLY, covered: [itemId], outcomes: { [itemId]: "re-attest" } },
        { held_at: LATE, covered: [itemId], outcomes: { [itemId]: "fix" } },
      ],
    });
    const report = deriveDecisionQueue({ repo, today: TODAY });
    expect(report.ok).toBe(false);
    expect(report.lapsed.map((i) => i.id)).toContain(`discharge:${itemId}`);
  });
});

/**
 * P-6: absence read as compliance. `readJsonl` returned `[]` for a missing file,
 * so deleting `decisions/discharge-obligations.jsonl` removed every discharge
 * obligation from the derived queue and `gate:decision-queue` exited 0 — the live
 * repository going from 140 open commitments (5 LAPSED) to 135 and PASS. The five
 * did not get discharged; they stopped being countable.
 *
 * The fix treats an unexplained absence as blocking. These tests pin BOTH halves
 * of that, because either alone is a defect: a fix that blocks every absence is a
 * blanket `throw` that permanently locks out a repository which never owed
 * anything, and a fix that never blocks is the original bug.
 */
describe("P-6: the discharge store's ABSENCE is a finding, not zero obligations", () => {
  // A `today` after the baseline (2026-08-31), since the whole question is what a
  // repository looks like once recorder-produced history is distinguishable from
  // history that predates the recorder.
  const NOW = "2026-09-26";
  const PRE_BASELINE = "2026-08-01"; // history that may be hand-written; no receipt required
  const POST_BASELINE = "2026-09-23"; // provably recorder-produced, and the real ledger's latest interview
  const INTERVIEW = { held_at: POST_BASELINE, covered: ["ADR-137"], outcomes: { "ADR-137": "Accept ADR-137" } };

  it("TEETH: an absent store BLOCKS when an interview was held after it was required", () => {
    // Pre-fix this reported `ok === true` and `discharge_store_absence === undefined`:
    // nothing else is owed, the interview creates no item of its own, and the missing
    // file derived zero obligations — so the ONLY thing that could turn this red is the
    // absence check itself. That is what makes it a regression test rather than a
    // restatement of the other five lapsed obligations.
    const repo = fixture({ omitDischargeStore: true, interviews: [INTERVIEW] });
    const report = deriveDecisionQueue({ repo, today: NOW });
    expect(report.ok).toBe(false);
    expect(report.discharge_store_absence?.path).toBe(DISCHARGE_STORE_PATH);
    expect(report.discharge_store_absence?.required_from).toBe("2026-08-31");
    expect(report.discharge_store_absence?.latest_interview).toBe(POST_BASELINE);
  });

  it("the absence is a finding of its own, never a commitment item an interview could cover", () => {
    // A synthetic item would carry an id, and `deriveDecisionQueue` silences items
    // whose id is covered — so one interview could have switched the "we cannot know
    // what is owed" signal back off, re-opening the bypass through the gate's own
    // coverage mechanism. `report.items` must not contain it.
    const repo = fixture({ omitDischargeStore: true, interviews: [INTERVIEW] });
    const report = deriveDecisionQueue({ repo, today: NOW });
    expect(report.items.some((i) => DISCHARGE_STORE_PATH.includes(i.kind) || i.source === DISCHARGE_STORE_PATH)).toBe(false);
  });

  it("the same repository with the store PRESENT reports the undischarged obligation instead", () => {
    // The pair that makes the deletion's cost concrete: the store is the only thing
    // that carried this obligation. With it, the obligation is a normal LAPSED item;
    // without it, the state is UNKNOWN. Neither reading is "nothing is owed".
    const obligation = {
      id: "discharge:vi:absent00000001",
      item_id: "vi:absent00000001",
      item_kind: "vi_triage",
      option: "re-attest",
      due: POST_BASELINE,
      created_at: POST_BASELINE,
      interview_held_at: POST_BASELINE,
      mechanism: "bun scripts/vi-findings.mjs --triage ...",
    };
    const withStore = fixture({ viFindings: [{ id: "vi:absent00000001" }], viTriage: [], dischargeObligations: [obligation], interviews: [INTERVIEW] });
    const present = deriveDecisionQueue({ repo: withStore, today: NOW });
    expect(present.discharge_store_absence).toBeNull();
    expect(present.lapsed.map((i) => i.id)).toContain("discharge:vi:absent00000001");
  });

  it("an absent store with NO post-baseline interview does not block — a repository that never owed one is not locked out", () => {
    const repo = fixture({ omitDischargeStore: true, interviews: [] });
    const report = deriveDecisionQueue({ repo, today: NOW });
    expect(report.ok).toBe(true);
    expect(report.discharge_store_absence).toBeNull();
  });

  it("an absent store with only PRE-baseline interviews does not block — the baseline boundary", () => {
    // Interviews from before the store was required cannot have written a row, so
    // their absence is explained. This is the boundary that keeps the fix from being
    // "any absence blocks", and it is the case the whole baseline constant exists for.
    const repo = fixture({
      omitDischargeStore: true,
      interviews: [{ held_at: PRE_BASELINE, covered: ["ADR-004"], outcomes: { "ADR-004": "Accept" } }],
    });
    const report = deriveDecisionQueue({ repo, today: NOW });
    expect(report.ok).toBe(true);
    expect(report.discharge_store_absence).toBeNull();
  });

  it("a PRESENT but EMPTY store with a post-baseline interview does not block — the documented remedy works", () => {
    // This is the remedy the gate prints for a repository that genuinely owes no
    // discharge obligation. If this ever goes red the printed remedy is a lie, and
    // an operator following it exactly would be stuck — which scripts/README rule 2
    // calls out as the failure that teaches people to distrust a gate.
    const repo = fixture({ interviews: [INTERVIEW] }); // no obligations => empty store
    const report = deriveDecisionQueue({ repo, today: NOW });
    expect(report.ok).toBe(true);
    expect(report.discharge_store_absence).toBeNull();
  });

  it("an UNDATED interview record counts as post-baseline, so it cannot excuse an absence", () => {
    // auditInterviewAttestation reports an undatable record rather than waving it
    // through; matching that here keeps the polarity in one direction. An undated
    // record might predate the recorder, but it cannot be shown to, and a gate whose
    // defect is absence-as-compliance resolves that ambiguity by blocking.
    const repo = fixture({ omitDischargeStore: true, interviews: [{ covered: ["ADR-137"], outcomes: { "ADR-137": "Accept" } }] });
    const report = deriveDecisionQueue({ repo, today: NOW });
    expect(report.ok).toBe(false);
    expect(report.discharge_store_absence?.interviews_after_required_from).toBe(1);
  });

  it("an UNREADABLE baseline declaration blocks on any interview at all, rather than excusing the absence", () => {
    // The cutoff is what makes absence explicable, so losing the cutoff removes the
    // only basis for that excuse. The safe reading of "I cannot tell which history
    // predates the recorder" is "assume all of it post-dates it" — never "assume none
    // of it does", which would hand an absent-store bypass to anyone who could delete
    // one small JSON file alongside the ledger.
    const repo = fixture({
      omitDischargeStore: true,
      omitInterviewBaseline: true,
      interviews: [{ held_at: PRE_BASELINE, covered: ["ADR-004"], outcomes: { "ADR-004": "Accept" } }],
    });
    const report = deriveDecisionQueue({ repo, today: NOW });
    expect(report.ok).toBe(false);
    // The sentinel is deliberately not a real date: it asserts the strictest claim
    // because the real one is unavailable.
    expect(report.discharge_store_absence?.required_from).toBe("0000-00-00");
  });
});

describe("a hazard is recordable (discharge-catalog `hazard` kind)", () => {
  const base = {
    adrs: [{ num: "907", status: "Rejected", date: "2026-08-01" }, { num: "908", status: "Accepted", date: "2026-08-01" }],
    waivers: [{ symbol: "x", file: "a.ts", expires: "2026-12-01", reason: "rests on ADR-907" }],
  };

  it("'re-ground the commitments' covers the hazard and queues an obligation that clears only when no dated commitment cites the record", () => {
    const repo = fixture(base);
    const { obligations } = recordInterviewAnswer(repo, {
      heldAt: TODAY,
      answers: [{ itemId: "hazard:ADR-907", itemKind: "hazard", option: "re-ground the commitments", outcome: "re-justify the waiver on ADR-908" }],
    });
    expect(obligations.map((o) => o.id)).toEqual(["discharge:hazard:ADR-907"]);
    expect(deriveDecisionQueue({ repo, today: TODAY }).hazards).toEqual([]);
    // Next day, still citing the rejected record: the obligation has lapsed.
    const lapsed = deriveDecisionQueue({ repo, today: "2026-08-19" });
    expect(lapsed.lapsed.map((i) => i.id)).toContain("discharge:hazard:ADR-907");
    // Re-grounded on a record that governs: discharged, nothing owed.
    writeFileSync(join(repo, "scripts/reachability/allowlist.json"),
      JSON.stringify({ version: 1, entries: [{ symbol: "x", file: "a.ts", expires: "2026-12-01", reason: "rests on ADR-908" }] }));
    const after = deriveDecisionQueue({ repo, today: "2026-08-19" });
    expect(after.lapsed.map((i) => i.id)).not.toContain("discharge:hazard:ADR-907");
    expect(after.hazards).toEqual([]);
  });

  it("'accept the cited record' discharges only when the record is Accepted", () => {
    const repo = fixture(base);
    recordInterviewAnswer(repo, {
      heldAt: TODAY,
      answers: [{ itemId: "hazard:ADR-907", itemKind: "hazard", option: "accept the cited record", outcome: "accept 907 after all" }],
    });
    expect(deriveDecisionQueue({ repo, today: "2026-08-19" }).lapsed.map((i) => i.id)).toContain("discharge:hazard:ADR-907");
    writeFileSync(join(repo, "decisions", "ADR-907-fixture.md"), "# ADR-907: Fixture\n\n**Status:** Accepted\n**Date:** 2026-08-01\n");
    expect(deriveDecisionQueue({ repo, today: "2026-08-19" }).lapsed.map((i) => i.id)).not.toContain("discharge:hazard:ADR-907");
  });

  it("'defer with a date' queues nothing and returns the hazard when the date passes", () => {
    const repo = fixture(base);
    const { obligations } = recordInterviewAnswer(repo, {
      heldAt: TODAY,
      answers: [{ itemId: "hazard:ADR-907", itemKind: "hazard", option: "defer with a date", outcome: "after the rewrite", deferredTo: "2026-08-25" }],
    });
    expect(obligations).toEqual([]);
    expect(deriveDecisionQueue({ repo, today: "2026-08-24" }).hazards).toEqual([]);
    expect(deriveDecisionQueue({ repo, today: "2026-08-26" }).hazards.map((h) => h.id)).toEqual(["hazard:ADR-907"]);
  });
});

describe("ADR-178: a record held after the cutoff must carry a structured witness", () => {
  const AFTER = "2026-10-07";
  const witness = {
    schema_version: 1,
    egress: { channel: "claude-code.AskUserQuestion", session_id: "s-1", asked_at: `${AFTER}T10:00:00Z` },
    pack_digest: `sha256:${"a".repeat(64)}`,
    questions: ["q:operator-decisions-2026-09-01:D1"],
  };
  const owed = { operatorDecisions: [{ date: "2026-09-01", ids: ["D1"] }] };
  const covering = (extra) => ({ held_at: AFTER, covered: ["operator-decisions-2026-09-01:D1"], outcomes: { "operator-decisions-2026-09-01:D1": "schedule it" }, ...extra });

  it("TEETH: an unwitnessed post-cutoff record covers nothing and blocks, with the remedy named", () => {
    const repo = fixture({ ...owed, interviews: [covering({})] });
    const report = deriveDecisionQueue({ repo, today: AFTER });
    expect(report.ok).toBe(false);
    expect(report.witness_violations).toEqual([expect.objectContaining({ line: 1, held_at: AFTER, errors: ["record carries no witness"] })]);
    expect(report.items.find((i) => i.id === "operator-decisions-2026-09-01:D1").covered).toBe(false);
    const cli = spawnSync("bun", [join(ROOT, "scripts/decision-queue.mjs"), "--repo", repo], { encoding: "utf8" });
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("UNWITNESSED");
    expect(cli.stdout).toContain("bun run interview:record --pack pack.json --answers answers.json");
  });

  it("a schema-valid witness covers; a malformed one is reported field by field", () => {
    const good = deriveDecisionQueue({ repo: fixture({ ...owed, interviews: [covering({ witness })] }), today: AFTER });
    expect(good.witness_violations).toEqual([]);
    expect(good.items.find((i) => i.id === "operator-decisions-2026-09-01:D1").covered).toBe(true);

    const bad = { ...witness, egress: { ...witness.egress, channel: "chat.prose" }, pack_digest: "sha256:short", extra: 1 };
    const report = deriveDecisionQueue({ repo: fixture({ ...owed, interviews: [covering({ witness: bad })] }), today: AFTER });
    expect(report.ok).toBe(false);
    const [violation] = report.witness_violations;
    expect(violation.errors.join("\n")).toMatch(/undeclared field "extra"/);
    expect(violation.errors.join("\n")).toMatch(/not a declared native question tool/);
    expect(violation.errors.join("\n")).toMatch(/pack_digest/);
  });

  it("keeps the legacy `witness:v1` note readable, and exempts records held on or before the cutoff", () => {
    const { schema_version: _v, ...binding } = witness;
    const legacy = covering({ note: `witness:v1 ${JSON.stringify({ ...binding, note: "free text" })}` });
    expect(deriveDecisionQueue({ repo: fixture({ ...owed, interviews: [legacy] }), today: AFTER }).witness_violations).toEqual([]);
    const onCutoff = covering({ held_at: "2026-10-06" });
    const report = deriveDecisionQueue({ repo: fixture({ ...owed, interviews: [onCutoff] }), today: AFTER });
    expect(report.witness_violations).toEqual([]);
  });

  it("the writer refuses a post-cutoff interview without a witness, and writes one that carries it", () => {
    const repo = fixture(owed);
    const answers = [{ itemId: "operator-decisions-2026-09-01:D1", itemKind: "operator_decision", option: "schedule it", outcome: "schedule it" }];
    expect(() => recordInterviewAnswer(repo, { heldAt: AFTER, answers })).toThrow(/needs a witness \(ADR-178\)/);
    expect(() => recordInterviewAnswer(repo, { heldAt: AFTER, answers, witness: { ...witness, questions: [] } })).toThrow(/invalid witness/);
    expect(existsSync(join(repo, "decisions/interviews.jsonl"))).toBe(false);
    const { interviewRecord } = recordInterviewAnswer(repo, { heldAt: AFTER, answers, witness });
    expect(interviewRecord.witness).toEqual(witness);
    expect(deriveDecisionQueue({ repo, today: AFTER }).ok).toBe(true);
  });
});
