// arbor-gate — Process gates wrapping the tree-search loop
// Clean-room from revoy-spec's process_gate.v1 (ADR-086) concept, independently implemented.
// Gates add trust boundaries: admission, isolation, evidence, audit.

import type { GateType, GateRecord, Provenance, TreeNode, FoldProposal, HarnessRevision, VerificationCheck, VerificationStrength } from "@arbor/core";
import { isAllowedHarnessComponent } from "@arbor/core";

// ============================================================
// GATE CHECKERS — pure functions that evaluate a gate condition
// ============================================================

export interface AdmissionCheck {
  plan_reviewed: boolean; // Lenticel + Burl both approved the plan
  resources_available: boolean; // Worktree, model capacity available
  config_valid: boolean; // max_seconds > 0, min_score >= 0, etc.
}

export interface IsolationCheck {
  worktree_isolated: boolean; // git worktree list shows it
  starting_commit_correct: boolean; // verified_ref matches expected
  lease_acquired: boolean; // No concurrent campaign using this worktree
}

export interface EvidenceCheck {
  provenance_tag: Provenance["tag"] | null;
  // NOTE: this used to also carry `verification_cmd_ran: boolean`. Every
  // caller derived it as `provenance_tag === "verified"`, which is true by
  // construction and proves nothing about whether a command actually ran
  // (A-1). Removed rather than left in place implying a check that doesn't
  // happen; the only real signal this gate can check without access to the
  // command's real invocation is `stdout_hash`'s presence (and, at the MCP
  // boundary, its format — see tools.ts's validateProvenance).
  stdout_hash?: string | null; // For !verified: the content anchor the verification command produced.
  exit_code?: number | null;
  /** Promoted claim and the independently observed text its hash anchors. */
  promoted_claim?: string;
  evidence_text?: string;
  /**
   * ADR-134 §1: mirrors `Provenance`'s own `check`/`strength` fields exactly
   * (rather than inventing a second shape) so a caller that already has a
   * `verified` `Provenance` can pass its scope straight through. Additive —
   * absence is never itself a gate failure (ADR-134 §3).
   */
  check?: VerificationCheck;
  strength?: VerificationStrength;
}

export interface AuditCheck {
  auditor_agrees: boolean; // Independent auditor reviewed the results
  bypasses_recorded: GateRecord[]; // Any gates that couldn't fail closed
}

// ============================================================
// GATE EVALUATOR
// ============================================================

/**
 * Evaluate the admission gate before a campaign starts.
 */
export function checkAdmission(check: AdmissionCheck): GateResult {
  const failures: string[] = [];
  if (!check.plan_reviewed) failures.push("plan not reviewed by dual-critic gate");
  if (!check.resources_available) failures.push("resources not available");
  if (!check.config_valid) failures.push("campaign config invalid");

  return makeResult("admission", failures);
}

/**
 * Evaluate the isolation gate before a Specialist expansion.
 */
export function checkIsolation(check: IsolationCheck): GateResult {
  const failures: string[] = [];
  if (!check.worktree_isolated) failures.push("worktree not isolated");
  if (!check.starting_commit_correct) failures.push("starting commit mismatch");
  if (!check.lease_acquired) failures.push("no active lease on worktree");

  return makeResult("isolation", failures);
}

/**
 * Evaluate the evidence gate after Critic approval, before node verification.
 * Determines whether the node can be 'verified' or only 'claimed'.
 */
export function checkEvidence(check: EvidenceCheck): GateResult {
  const failures: string[] = [];
  const unresolved: string[] = [];

  if (check.provenance_tag === null) {
    unresolved.push("no provenance tag on result");
  } else if (check.provenance_tag === "verified") {
    if (check.exit_code !== undefined && check.exit_code !== 0) failures.push("verified provenance requires exit code 0");
    if (check.stdout_hash === undefined || check.stdout_hash === null || check.stdout_hash === "") {
      failures.push("provenance is !verified but stdout_hash is missing or empty");
    }
    if (check.promoted_claim !== undefined) {
      if (check.evidence_text === undefined) failures.push("promoted claim has no independently observed evidence text");
      else failures.push(...containmentFailures(check.promoted_claim, check.evidence_text));
    }
  }

  const result = makeResult("evidence", failures, unresolved);
  // ADR-134 §1/§3: surface the resolved scope additively, only for a
  // `verified` tag, and only when the caller declared at least one of
  // `check`/`strength` — never fabricate a scope the caller didn't supply.
  // This never affects `failures`/`unresolved`/`result` above; a missing
  // scope stays exactly as unresolved-but-passing as it was before this field
  // existed.
  if (check.provenance_tag === "verified" && (check.check !== undefined || check.strength !== undefined)) {
    result.resolved_scope = {
      ...(check.check === undefined ? {} : { check: check.check }),
      ...(check.strength === undefined ? {} : { strength: check.strength }),
    };
  }
  return result;
}

/** Exact, deliberately narrow containment for machine-checkable claim facts. */
export function containmentFailures(claim: string, evidence: string): string[] {
  const failures: string[] = [];
  const normalizedEvidence = evidence.replaceAll("\\", "/");
  const filePattern = /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|yaml|yml))(?=$|[\s`'"),:;])/g;
  for (const match of claim.replaceAll("\\", "/").matchAll(filePattern)) {
    const path = match[1]!;
    if (!normalizedEvidence.includes(path)) failures.push(`claim file path absent from evidence: ${path}`);
  }
  for (const match of claim.matchAll(/\b(?:exit(?:ed)?(?:\s+code)?\s+)(-?\d+)\b/gi)) {
    const exit = match[1]!;
    if (!new RegExp(`\\b(?:exit(?:ed)?(?:\\s+code)?\\s+)${escapeRegex(exit)}\\b`, "i").test(evidence)) failures.push(`claim exit code absent from evidence: ${exit}`);
  }
  for (const match of claim.matchAll(/\b(\d+)\s+(tests?|passed|failed)\b/gi)) {
    const count = match[1]!;
    if (!new RegExp(`\\b${escapeRegex(count)}\\s+(?:tests?|passed|failed)\\b`, "i").test(evidence)) failures.push(`claim test count absent from evidence: ${count}`);
  }
  return [...new Set(failures)];
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Evaluate the audit gate after campaign halt.
 */
export function checkAudit(check: AuditCheck): GateResult {
  const failures: string[] = [];
  if (!check.auditor_agrees) failures.push("independent auditor disagrees with results");

  return makeResult("audit", failures);
}

/** Context folds must preserve a traceable source and pass a fidelity probe before activation. */
export function checkFoldActivation(input: { proposal: FoldProposal; approver: string; fidelity_ratio: number | null }): GateResult {
  const failures: string[] = [];
  if (input.proposal.proposed_by === input.approver) failures.push("fold proposer may not approve its own fold");
  if (input.proposal.source_event_ids.length === 0) failures.push("fold requires source event evidence");
  if (input.proposal.source_message_ranges.length === 0) failures.push("fold requires durable message-range evidence");
  if (input.proposal.retained_claims.length === 0) failures.push("fold requires retained claims");
  if (input.proposal.omitted_artifacts.some((ref) => !ref.sha256 || !ref.id)) failures.push("fold omitted artifacts must be content-addressed");
  if (input.proposal.measures.expected_token_savings < 0) failures.push("expected token savings must be non-negative");
  if (input.fidelity_ratio === null || input.fidelity_ratio < 1) failures.push("fold fidelity probe did not retain every required claim");
  return makeResult("evidence", failures);
}

/** Harness changes are campaign-local, allowlisted, independently approved, and reversible. */
export function checkHarnessActivation(input: { revision: HarnessRevision; approver: string }): GateResult {
  const failures: string[] = [];
  if (!isAllowedHarnessComponent(input.revision.component)) failures.push(`harness component ${input.revision.component} is forbidden`);
  if (input.revision.proposed_by === input.approver) failures.push("harness proposer may not approve its own revision");
  if (input.revision.source_event_ids.length === 0) failures.push("harness revision requires source trajectory evidence");
  if (!input.revision.expires_at) failures.push("harness revision requires an expiry");
  return makeResult("audit", failures);
}

/** Promotion needs independent replay/holdout evidence and a named human decision. */
export function checkHarnessPromotion(input: { revision: HarnessRevision; human_approver: string }): GateResult {
  const failures: string[] = [];
  if (!isAllowedHarnessComponent(input.revision.component)) failures.push(`harness component ${input.revision.component} is forbidden`);
  if (!input.human_approver.trim()) failures.push("cross-campaign promotion requires human approval");
  if (input.revision.status !== "active" || !input.revision.approved_by) failures.push("promotion requires prior Lenticel activation");
  if (input.human_approver === input.revision.proposed_by) failures.push("human promoter must be distinct from revision proposer");
  if (input.human_approver === input.revision.approved_by) failures.push("human promoter must be distinct from activating critic");
  if (input.revision.evaluation.outcome !== "improved") failures.push("promotion requires measured improvement");
  if (input.revision.evaluation.replay_evidence_ids.length === 0) failures.push("promotion requires replay evidence");
  if (input.revision.evaluation.holdout_evidence_ids.length === 0) failures.push("promotion requires independent holdout evidence");
  if (input.revision.evaluation.regression_detected) failures.push("promotion blocked by regression evidence");
  return makeResult("audit", failures);
}

// ============================================================
// GATE RESULT
// ============================================================

export interface GateResult {
  gate: GateType;
  result: "pass" | "fail" | "bypass";
  checked_at: string;
  detail: string;
  failures: string[];
  unresolved: string[];
  bypass_evidence_deficit?: string;
  /**
   * ADR-134 §1/§3: the scope a `verified` evidence check declared, surfaced
   * additively so a downstream reader can see "verified (single command,
   * outputs-check only)" instead of an undifferentiated "verified". Set only
   * by `checkEvidence` for a `verified` provenance tag; every other gate
   * leaves this undefined. A missing/absent scope here is never itself a
   * reason this gate's `result` is "fail" — see `checkEvidence`.
   */
  resolved_scope?: { check?: VerificationCheck; strength?: VerificationStrength };
}

/**
 * Record a bypass — a gate that couldn't fail closed.
 * The evidence deficit is tracked for later resolution.
 */
export function bypassGate(gate: GateType, reason: string, evidenceDeficit: string): GateResult {
  if (!reason.trim()) throw new Error("gate bypass requires a non-empty reason");
  if (!evidenceDeficit.trim()) throw new Error("gate bypass requires a non-empty evidence deficit");
  return {
    gate,
    result: "bypass",
    checked_at: new Date().toISOString(),
    detail: reason,
    failures: [],
    unresolved: [],
    bypass_evidence_deficit: evidenceDeficit,
  };
}

/**
 * Attach a gate record to a tree node.
 */
export function attachGateRecord(node: TreeNode, gateResult: GateResult): void {
  const record: GateRecord = {
    gate: gateResult.gate,
    result: gateResult.result,
    checked_at: gateResult.checked_at,
    detail: gateResult.detail,
    bypass_evidence_deficit: gateResult.bypass_evidence_deficit,
  };
  node.gate_records.push(record);
}

// --- Internal helpers ---

function makeResult(gate: GateType, failures: string[], unresolved: string[] = []): GateResult {
  const observations = [...failures, ...unresolved];
  return {
    gate,
    // W1a records unavailable evidence separately without changing behavior.
    // A future outcome change must be justified by the measured unresolved rate.
    result: observations.length === 0 ? "pass" : "fail",
    checked_at: new Date().toISOString(),
    detail: observations.length === 0 ? "all checks passed" : observations.join("; "),
    failures,
    unresolved,
  };
}
