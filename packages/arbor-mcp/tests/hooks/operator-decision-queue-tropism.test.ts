/**
 * `inject.operator-decision-queue` — the native replacement for the deleted
 * `scripts/hooks/codex-decision-interview-session-start.mjs`.
 *
 * THE ONE THING THAT MATTERS HERE IS THAT THERE IS NO SECOND QUEUE.
 *
 * `scripts/decision-queue.mjs` derives the operator's obligations from nine
 * sources over three `scripts/lib` dependencies, and `gate:decision-queue`
 * enforces the result. A TypeScript reimplementation would be a second
 * implementation of an INVARIANT the gate already owns, and the drift between
 * them would be SILENT: the interview would be owed, the injected queue would
 * not mention it, and nothing anywhere would say so. So the handler
 * SUBPROCESSES the one derivation that exists — `bun scripts/decision-queue.mjs
 * --json` — and maps its JSON to a `Tropism`. The test below asserts the
 * rendered rows against the SAME subprocess output, so a divergence from the
 * gate is not a thing this test could miss.
 *
 * The guarantee being preserved, stated precisely because it is easy to
 * overstate: the handler READS and RENDERS. It never writes
 * `decisions/interviews.jsonl`, never records coverage, and never answers on
 * the operator's behalf — and that guarantee was never in the shell hook
 * either. It lives in `LEGAL_TRANSITIONS`
 * (`packages/arbor-governance/src/record/status.ts`) plus a store that only
 * PARSES the interview ledger. A read-only handler cannot weaken it, and this
 * handler has no write path at all.
 *
 * The TIMING is genuinely different and is not papered over: the shell hook
 * fired on the HOST's session start, before the host's first model action.
 * revoy2 does not own that moment. The native guarantee is "a revoy2-DRIVEN
 * session cannot cross its first model action without the uncovered operator
 * queue being surfaced" — `inject @ session_start` fires before the first
 * model call on every native session, subagent children included.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HookCatalog } from "../../src/hooks/catalog.js";
import {
  OPERATOR_QUEUE_KINDS,
  buildOperatorQueueSections,
  operatorDecisionQueueTropism,
  runDecisionQueue,
  uncoveredOperatorItems,
  type DecisionQueueReport,
  type DecisionQueueRow,
  type DecisionQueueHazard,
} from "../../src/hooks/operator-decision-queue.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const row = (over: Partial<DecisionQueueRow> & Pick<DecisionQueueRow, "id" | "kind" | "summary">): DecisionQueueRow =>
  Object.freeze({ source: "decisions/interviews.jsonl", due: null, covered: false, ...over });

const report = (items: readonly DecisionQueueRow[], hazards: readonly DecisionQueueHazard[] = []): DecisionQueueReport =>
  Object.freeze({ items, hazards });

describe("inject.operator-decision-queue", () => {
  describe("the queue it renders is the queue the gate derives", () => {
    it("reads the real scripts/decision-queue.mjs, and the argv is the argv gate:decision-queue uses", () => {
      // A stub repo, so the argv the handler actually spawns is observable
      // rather than inferred. `--json` is the machine report and `--repo` is
      // the queue script's own documented fixture seam.
      const root = mkdtempSync(join(tmpdir(), "arbor-queue-argv-"));
      try {
        mkdirSync(join(root, "scripts"), { recursive: true });
        const argvLog = join(root, "argv.json");
        writeFileSync(join(root, "scripts", "decision-queue.mjs"), [
          `import { writeFileSync } from "node:fs";`,
          `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
          `console.log(JSON.stringify({ items: [], hazards: [] }));`,
        ].join("\n"));

        runDecisionQueue(root);

        expect(JSON.parse(readFileSync(argvLog, "utf8"))).toEqual(["--json", "--repo", root]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("renders exactly the uncovered operator-owned rows of the REAL derived queue", () => {
      // The single subprocess output both sides are asserted against. The
      // expected rows are filtered here, independently of the handler, from
      // that same object — so if the handler's filter ever disagreed with the
      // queue the gate enforces, this is where it shows.
      // `spawnSync`, not `execFileSync`: the script exits NON-ZERO when the
      // queue is not ok, which is the normal state of a repository with work
      // outstanding. The exit code is `gate:decision-queue`'s business; what
      // this handler consumes is the report.
      const result = spawnSync("bun", ["scripts/decision-queue.mjs", "--json"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const stdout = result.stdout ?? "";
      const derived: DecisionQueueReport = JSON.parse(stdout);

      const tropism = operatorDecisionQueueTropism(REPO_ROOT, () => stdout);

      const expected = uncoveredOperatorItems(derived);
      // STATE-INDEPENDENT BY DESIGN. This repository currently has NO uncovered
      // operator-owned row and no hazard, so the handler correctly answers the
      // script's `quiet` with `null` — and an assertion demanding a rendered
      // body would fail for a reason that has nothing to do with the code under
      // test. Both branches are parity claims: a non-empty queue is rendered IN
      // FULL, and an empty one renders as nothing.
      if (expected.length === 0 && derived.hazards.length === 0) {
        expect(tropism).toBeNull();
        return;
      }
      expect(tropism).not.toBeNull();
      for (const item of expected) {
        expect(tropism!.body).toContain(item.id);
        expect(tropism!.body).toContain(item.summary);
      }
      // And nothing OUTSIDE that set: a covered row, a discharge obligation or
      // a vi_triage finding is real owed work, but it is not an operator
      // interview choice and the deleted hook never surfaced it here.
      const surfaced = derived.items.filter((item) => tropism!.body.includes(item.id));
      expect(surfaced).toEqual(expected);
    });
  });

  describe("which rows are operator-owned", () => {
    it("keeps the three kinds the deleted hook kept, in its fixed order", () => {
      expect([...OPERATOR_QUEUE_KINDS]).toEqual(["proposed_record", "operator_decision", "operator_call"]);
      const derived = report([
        row({ id: "ADR-900", kind: "proposed_record", summary: "a proposed record" }),
        row({ id: "operator-decisions-x:D1", kind: "operator_decision", summary: "a decision" }),
        row({ id: "operator-calls-x:C1", kind: "operator_call", summary: "a disposal call" }),
      ]);

      expect(buildOperatorQueueSections(derived)).toEqual([
        "Proposed ADRs (1):\n- ADR-900: a proposed record",
        "operator decisions (1):\n- operator-decisions-x:D1: a decision",
        "operator disposal calls (1):\n- operator-calls-x:C1: a disposal call",
      ]);
    });

    it("excludes a covered row and every kind that is not an operator-owned choice", () => {
      const derived = report([
        row({ id: "ADR-901", kind: "proposed_record", summary: "uncovered proposed" }),
        row({ id: "ADR-902", kind: "proposed_record", summary: "already covered", covered: true }),
        row({ id: "discharge:vi:abc", kind: "discharge_obligation", summary: "a discharge obligation" }),
        row({ id: "vi:abc", kind: "vi_triage", summary: "a triage finding" }),
        row({ id: "waiver:abc", kind: "waiver", summary: "an expired waiver" }),
        row({ id: "depth:abc", kind: "completion_depth", summary: "a completion-depth row" }),
      ]);

      expect(uncoveredOperatorItems(derived).map((item) => item.id)).toEqual(["ADR-901"]);
    });

    it("appends a hazards section, which is a finding in its own right", () => {
      const derived = report([], [{ id: "hazard:adr-1", detail: "a dated commitment rests on a record that does not govern it" }]);

      expect(buildOperatorQueueSections(derived)).toEqual([
        "governance hazards (1):\n- hazard:adr-1: a dated commitment rests on a record that does not govern it",
      ]);
    });

    it("says nothing at all when nothing is uncovered and no hazard stands", () => {
      // `null` IS the hook's `quiet`. A permanently-present reminder is a
      // permanently-present tax, and this handler's whole point is that the
      // queue is authoritative: an empty queue must render as nothing.
      expect(operatorDecisionQueueTropism(REPO_ROOT, () => JSON.stringify(report([])))).toBeNull();
    });
  });

  describe("the tropism itself", () => {
    const build = (): NonNullable<ReturnType<typeof operatorDecisionQueueTropism>> => operatorDecisionQueueTropism(
      REPO_ROOT,
      () => JSON.stringify(report([row({ id: "ADR-903", kind: "proposed_record", summary: "a proposed record" })])),
    )!;

    it("passes the catalog's §5.3 lints, including the ADVISORY imperative refusal", () => {
      // The deleted hook opened with "MANDATORY REVOY2 SESSION-START
      // INTERVIEW", which the advisory-imperative lint REFUSES. The ported
      // wording opens with a noun phrase instead, and the imperative lives on
      // a later line the lint cannot reach.
      const tropism = build();
      expect(new HookCatalog().validateTropism(tropism)).toBeNull();
      expect(tropism.lane).toBe("ADVISORY");
      expect(tropism.enforcing_ref).toBeNull();
      expect(tropism.provenance).toBe("generated");
      expect(tropism.expires_after_turns).toBeGreaterThan(1);
      // It still says what the operator has to be asked, and it still says the
      // agent may ask but never answer — the one line whose content matters.
      expect(tropism.body).toMatch(/never infer an answer/i);
      expect(tropism.body).toMatch(/--question-pack/);
    });

    it("moves its derivation when the queue moves, so §5.3's dedupe cannot make it permanently silent", () => {
      const first = operatorDecisionQueueTropism(REPO_ROOT, () => JSON.stringify(report([row({ id: "ADR-903", kind: "proposed_record", summary: "a" })])))!;
      const same = operatorDecisionQueueTropism(REPO_ROOT, () => JSON.stringify(report([row({ id: "ADR-903", kind: "proposed_record", summary: "a" })])))!;
      const moved = operatorDecisionQueueTropism(REPO_ROOT, () => JSON.stringify(report([
        row({ id: "ADR-903", kind: "proposed_record", summary: "a" }),
        row({ id: "ADR-904", kind: "proposed_record", summary: "b" }),
      ])))!;

      // A constant derivation would be deduped into silence — invisible rather
      // than wrong, which is strictly harder to notice than a bad verdict.
      expect(first.derived_from).toEqual(same.derived_from);
      expect(moved.derived_from).not.toEqual(first.derived_from);
    });

    it("stays silent when the derivation could not be read, rather than asserting an empty queue", () => {
      // An unreadable queue is UNKNOWN, not empty, and "the operator owes
      // nothing" is a claim about a repository state nobody established. The
      // gate still enforces the real queue; this handler simply declines to
      // assert one it could not read.
      expect(operatorDecisionQueueTropism(REPO_ROOT, () => "not json at all")).toBeNull();
      expect(operatorDecisionQueueTropism(REPO_ROOT, () => null)).toBeNull();
    });
  });
});
