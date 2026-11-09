/**
 * arbor-eval/stage0/audit — re-derive an attempt's measurement fields from its
 * preserved evidence, as append-only corrections.
 *
 * Two capture gaps found during the full run are handled here (the Stage 0
 * report names them H1 and H3):
 *
 * - H1: the runtime quarantined a campaign snapshot as corrupt, so
 *   `arbor report` answered "not found" and the attempt's spend read as 0.
 *   The spend is re-derived from the campaign's audit log, and the attempt is
 *   classified `harness`.
 * - H3: the session was ended by the no-progress breaker after command path
 *   refusals; the attempt is classified `harness`, not `model`.
 *
 * A correction never changes whether an attempt verified or was adopted.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { costOfSpans, quarantinedSnapshots, usageSpansFromAuditLog } from "./attempt.js";
import { campaignIdFromTarget, unrecordedUsage } from "./journal-usage.js";
import type { PriceObservation } from "./attempt.js";
import { STAGE0_CORRECTION_SCHEMA } from "./types.js";
import type { Stage0AttemptRecord, Stage0CorrectionRecord, Stage0Experiment } from "./types.js";

/**
 * Defect H3 (Stage 0 report): the session was ended by the no-progress
 * breaker (`tool_refusal_loop`) and the refusals it counted were path
 * validations (`path_traversal`/`path_invalid`) of a command call. The breaker
 * keys command calls by argv alone, so a call corrected by changing only its
 * cwd is refused as a repeat. Returns the classification detail, or null.
 */
export function refusalLoopPathCause(runDir: string): string | null {
  const reportPath = join(runDir, "logs", "report.stdout.log");
  const attemptPath = join(runDir, "attempt.json");
  if (!existsSync(reportPath) || !existsSync(attemptPath)) return null;
  let report: { value?: { campaign?: { nodes?: Array<{ id: string; outcome?: { error?: { code?: string } } }> } } } | null = null;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
  const looped = (report?.value?.campaign?.nodes ?? []).some((node) => node.outcome?.error?.code === "tool_refusal_loop");
  if (!looped) return null;
  const refusals = (JSON.parse(readFileSync(attemptPath, "utf8")) as { tool_refusals?: Record<string, number> }).tool_refusals ?? {};
  const pathRefusals = Object.entries(refusals).filter(([key]) => /^(shell\.execute|verification\.run):(path_traversal|path_invalid)$/.test(key));
  if (pathRefusals.length === 0) return null;
  return `refusal-loop breaker ended the session after command path refusals (${pathRefusals.map(([k, n]) => `${k}=${n}`).join(", ")}); the breaker keys command calls by argv only (H3)`;
}


/** Every correction the preserved evidence supports, for attempts as currently corrected. */
export function deriveCorrections(attempts: readonly Stage0AttemptRecord[], price: PriceObservation, experiment: Stage0Experiment, at: string): Stage0CorrectionRecord[] {
  const corrections: Stage0CorrectionRecord[] = [];
  for (const attempt of attempts) {
    const target = join(attempt.run_dir, "target");
    const set: Stage0CorrectionRecord["set"] = {};
    const evidence: string[] = [];
    const reasons: string[] = [];
    // D10: an attempt cut off by a cap reported no campaign id; the run dir still names it.
    const recovered = attempt.campaign_id === null ? campaignIdFromTarget(target) : null;
    if (recovered !== null) {
      Object.assign(set, { campaign_id: recovered });
      evidence.push(join(target, ".arbor", "harness-sessions.ndjson"));
      reasons.push("campaign id recovered from the run dir (D10)");
    }
    // D10: a wall-cap cut-off recorded as `harness` is `aborted` (preregistration 11.3).
    if (attempt.arbor_task_timed_out && !attempt.harness_verified && attempt.failure_class === "harness" && /exceeded the attempt timeout/.test(attempt.failure_detail ?? "")) {
      Object.assign(set, { failure_class: "aborted", failure_detail: "arbor task cut off by the attempt wall cap (re-classified from harness, D10)" });
      evidence.push(join(attempt.run_dir, "events.jsonl"));
      reasons.push("wall-cap cut-off classified aborted (D10)");
    }
    const campaignId = attempt.campaign_id ?? recovered;
    if (campaignId === null && !existsSync(join(target, ".arbor", "harness-sessions.ndjson"))) {
      if (Object.keys(set).length === 0) continue;
      corrections.push({ schema: STAGE0_CORRECTION_SCHEMA, experiment, at, task_id: attempt.task_id, seed: attempt.seed, attempt_index: attempt.attempt_index, reason: reasons.join("; "), evidence, set });
      continue;
    }
    const auditPath = join(target, ".arbor", "audit", `${campaignId}.jsonl`);
    const spans = campaignId === null ? [] : usageSpansFromAuditLog(target, campaignId);
    const cost = costOfSpans(spans, price);
    const quarantined = campaignId === null ? [] : quarantinedSnapshots(target, campaignId);
    // D9: usage of sessions that never finished is in the journal, not the audit spans.
    const unrecorded = unrecordedUsage(target, cost.tokens, price);
    const total = cost.priced + cost.unpriced_estimate + (unrecorded?.cost_usd ?? 0);
    if ((spans.length > 0 || unrecorded !== null) && Math.abs(total - attempt.cost_usd) > 1e-9) {
      Object.assign(set, { cost_usd: total, cost_priced_usd: cost.priced, cost_unpriced_estimate_usd: cost.unpriced_estimate, unpriced_spans: cost.unpriced_spans, tokens: cost.tokens, unrecorded_usage: unrecorded });
      evidence.push(auditPath);
      if (unrecorded !== null) evidence.push(join(target, ".arbor", "harness-sessions.ndjson"));
      reasons.push(unrecorded === null ? "spend re-derived from the campaign audit log" : "spend re-derived from the campaign audit log plus unfinished-session usage from the session journal (D9)");
    }
    if (quarantined.length > 0 && !attempt.harness_verified && attempt.failure_class !== "harness") {
      Object.assign(set, { failure_class: "harness", failure_detail: `campaign snapshot quarantined by the runtime (halt ${String(attempt.halt_reason)}); report unavailable (H1)` });
      evidence.push(...quarantined);
      reasons.push("campaign snapshot quarantined (H1)");
    }
    const loop = refusalLoopPathCause(attempt.run_dir);
    if (loop !== null && !attempt.harness_verified && attempt.failure_class === "model" && set.failure_class === undefined) {
      Object.assign(set, { failure_class: "harness", failure_detail: loop });
      evidence.push(join(attempt.run_dir, "logs", "report.stdout.log"), join(attempt.run_dir, "attempt.json"));
      reasons.push("refusal-loop breaker after command path refusals (H3)");
    }
    if (Object.keys(set).length === 0) continue;
    corrections.push({ schema: STAGE0_CORRECTION_SCHEMA, experiment, at, task_id: attempt.task_id, seed: attempt.seed, attempt_index: attempt.attempt_index, reason: reasons.join("; "), evidence, set });
  }
  return corrections;
}
