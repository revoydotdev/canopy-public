/**
 * transitions.ts — POL-05: enforce the decision-status lifecycle against a
 * baseline, so an ADR cannot gain authority by being edited.
 *
 * WHY THIS EXISTS. `validateTransition` (status.ts) encodes the legal
 * lifecycle — `draft->proposed`, `proposed->accepted`, `accepted->superseded`,
 * and notably NOT `draft->accepted`. It was implemented, unit-tested with 14
 * cases, and called by nothing. An independent audit found it: the one
 * mechanism that would stop an ADR silently acquiring unratified authority did
 * not run, so any `**Status:**` line could be hand-edited from Draft straight
 * to Accepted and no gate, test or hook would notice.
 *
 * That is precisely the risk ADR-027's own Draft banner names, and this
 * repository's stated rule that no agent both proposes and approves. A rule
 * nobody enforces is a claim, not a control.
 *
 * WHAT A BASELINE IS. The lifecycle is only meaningful across time, and a
 * single snapshot of the corpus cannot show a transition. The baseline is the
 * corpus as it stands on the integration branch; the current state is the
 * working tree. Reading the baseline is IO and belongs to the caller — this
 * module is pure so its judgements are testable without a git repository.
 *
 * TWO RULES, and the second is the one that matters most here:
 *
 *   1. A record present in both is judged by `validateTransition`. An illegal
 *      transition is a blocker.
 *   2. A record ABSENT from the baseline and already `accepted` is a blocker.
 *      A new ADR that arrives on a feature branch already accepted has skipped
 *      the lifecycle entirely rather than traversing it illegally — the same
 *      self-approval, arriving by a different door. `draft`, `proposed` and
 *      `rejected` are all legitimate initial states.
 *
 * WHAT THIS CANNOT DO. It cannot tell whether a *legal* `proposed->accepted`
 * transition was ratified by a human — nothing in the file records who approved
 * it. It detects lifecycle violations, not unauthorised-but-well-formed ones.
 * Stated so the gap is witnessed rather than assumed closed.
 */

import type { DecisionStatus, PolicyFinding, RecordId } from "../contracts.js";
import type { LegacyReadResult } from "./legacy.js";
import { validateTransition } from "./status.js";

/** Rule id for every finding this module emits. */
export const POL_STATUS_TRANSITION = "POL-05";

/**
 * The integration branch's decision statuses, keyed by `RecordId`.
 * Built by the caller (git IO); absent keys mean "new since the baseline".
 */
export type StatusBaseline = ReadonlyMap<RecordId, DecisionStatus>;

function finding(
  recordId: RecordId,
  sourcePath: string,
  detail: string,
  remediation: string,
  at: string,
): PolicyFinding {
  return {
    rule_id: POL_STATUS_TRANSITION,
    severity: "blocker",
    subject: { record_id: recordId },
    detail,
    remediation,
    evidence: [{
      kind: "code_location",
      ref: sourcePath,
      producer: "@arbor/governance/record/transitions@1",
      at,
    }],
    waiver_eligible: false,
    is_legacy_debt: false,
  };
}

/**
 * Judge every record's decision status against the baseline.
 *
 * Deterministic: findings are ordered by record id using code-unit comparison,
 * never a locale-sensitive one, so two machines produce identical output.
 */
export function checkStatusTransitions(
  baseline: StatusBaseline,
  current: readonly LegacyReadResult[],
  options: { readonly at: string },
): readonly PolicyFinding[] {
  const findings: PolicyFinding[] = [];

  for (const result of current) {
    const record = result.record;
    // An unparseable record has no status to judge. It is already reported by
    // the corpus scan's own classification; double-reporting it here would
    // inflate the blocker count without adding information.
    if (!record) continue;

    const to = record.status.decision;
    const from = baseline.get(record.id);

    if (from === undefined) {
      if (to === "accepted") {
        findings.push(finding(
          record.id,
          result.source_path,
          `new record arrives already "accepted" — it never traversed the lifecycle, `
          + `so no proposed->accepted transition was ever reviewable`,
          `Land it as "draft" or "proposed" and let it be accepted by whoever holds that authority. `
          + `No agent both proposes and approves.`,
          options.at,
        ));
      }
      continue;
    }

    if (from === to) continue;

    const verdict = validateTransition(from, to);
    if (!verdict.ok) {
      findings.push(finding(
        record.id,
        result.source_path,
        `${verdict.error.message} (baseline "${from}", working tree "${to}")`,
        from === "draft" && to === "accepted"
          ? `A draft cannot become accepted directly — it must be proposed first, so there is a `
            + `reviewable moment between authoring and authority.`
          : `Restore the baseline status, or make the intermediate transition explicitly.`,
        options.at,
      ));
    }
  }

  findings.sort((left, right) => {
    const a = "record_id" in left.subject ? left.subject.record_id : "";
    const b = "record_id" in right.subject ? right.subject.record_id : "";
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
  return findings;
}
