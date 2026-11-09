import type { FoldedWaiverOutcome, OutputListEntry } from "@arbor/audit";
import type { ApprovalRecord } from "./approval-service.js";
import type { ArborRuntime } from "./runtime.js";
import type { ParentChildThreadProjection } from "./conversation-bus.js";
import { defaultGateRemediation, projectGateRecord, type GateRefusalProjection } from "./gate-refusal-projection.js";
import type { HarnessSessionFailureChronology } from "./harness-session-journal.js";

/** E-8: waiver-outcome rollup surfaced on the run report — see `formatRunReportSummary`'s one-line rendering. */
export interface WaiverOutcomeSummary {
  readonly entries: readonly FoldedWaiverOutcome[];
  /** Count where `adopted === true`. */
  readonly adopted: number;
  /** Count where `later_failed === null` — no determination has been recorded yet, adopted or not. */
  readonly unadjudicated: number;
}

/**
 * A failed native session's ordered retry chronology and canonical redacted
 * reason. Read from the same session projection `harness.session.inspect`
 * serves, so after a restart it is rehydrated from the durable journal only.
 */
export interface RunReportSessionFailure {
  readonly session_id: string;
  readonly node_id: string;
  readonly operation: "specialize" | "review";
  readonly failure: HarnessSessionFailureChronology;
}

export interface RunReportOptions {
  readonly as_of?: string;
  readonly max_ledger_records?: number;
  readonly max_thread_messages?: number;
  readonly max_evidence_records?: number;
}

export interface RunReport {
  readonly schema: "arbor.run-report/v1";
  readonly campaign_id: string;
  readonly as_of: string;
  /** Canonical durable tree/campaign snapshot, never a reconstructed model claim. */
  readonly campaign: NonNullable<ReturnType<ArborRuntime["manager"]["getCampaignSnapshot"]>>;
  /** Canonical typed blocker, when any gate failed or was bypassed. */
  readonly gate_refusal: GateRefusalProjection | null;
  readonly ledger: {
    readonly total_records: number;
    readonly included_records: number;
    readonly truncated: boolean;
    readonly records: readonly ReturnType<ArborRuntime["manager"]["getAuditRecords"]>[number][];
  };
  /** Direct-edge histories are bounded projections over the same ledger records. */
  readonly threads: readonly ParentChildThreadProjection[];
  /** Approval records explicitly scoped to this campaign's resource id. */
  readonly approvals: readonly ApprovalRecord[];
  /** Descriptor-only evidence records; no raw artifact bytes are exported. */
  readonly evidence: readonly OutputListEntry[];
  /** E-8: direct-tier (review-waived) outcome rollup for this campaign. */
  readonly waiver_outcomes: WaiverOutcomeSummary;
  /** Failed native sessions ordered by session id; empty when no session failed or no journal exists. */
  readonly session_failures: readonly RunReportSessionFailure[];
}

export type RunReportResult =
  | { readonly ok: true; readonly value: RunReport }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "validation" | "unavailable"; readonly summary: string } };

/**
 * Read-only, bounded report built exclusively from canonical projections. It
 * does not start a runtime transport, mutate state, or use an agent assertion
 * as evidence. Consumers can archive this JSON locally beside a campaign.
 */
export function buildRunReport(runtime: ArborRuntime, campaignId: string, options: RunReportOptions = {}): RunReportResult {
  if (!text(campaignId)) return { ok: false, error: { code: "validation", summary: "campaign_id is required" } };
  const limits = resolveLimits(options);
  if (!limits.ok) return limits;
  const campaign = runtime.manager.getCampaignSnapshot(campaignId);
  if (!campaign) return { ok: false, error: { code: "not_found", summary: `campaign ${campaignId} was not found` } };
  const as_of = options.as_of ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(as_of))) return { ok: false, error: { code: "validation", summary: "as_of must be an ISO timestamp" } };

  let records: ReturnType<ArborRuntime["manager"]["getAuditRecords"]>;
  try { records = runtime.manager.getAuditRecords(campaignId); }
  catch (error) { return { ok: false, error: { code: "unavailable", summary: error instanceof Error ? error.message : "campaign ledger is unavailable" } }; }
  const included = records.slice(Math.max(0, records.length - limits.ledger));
  const threads = campaign.nodes
    .filter((node) => node.parent_id !== null)
    .slice(0, limits.threads)
    .map((node) => runtime.manager.getParentChildThread(campaignId, node.parent_id!, node.id, { as_of, limit: limits.threadMessages, tier: "orchestrator" }));
  const approvals = runtime.approvals.list({ limit: 1_000 }).filter((record) => record.resource_id === campaignId);
  const evidence = runtime.outputEvidence === null
    ? []
    : runtime.outputEvidence.list({ limit: limits.evidence }).filter((entry) => entry.status === "corrupt" || entry.record.campaign_id === campaignId);

  const waiverEntries = runtime.manager.getWaiverOutcomes(campaignId);
  const waiverOutcomes: WaiverOutcomeSummary = {
    entries: waiverEntries,
    adopted: waiverEntries.filter((entry) => entry.adopted).length,
    unadjudicated: waiverEntries.filter((entry) => entry.later_failed === null).length,
  };

  return {
    ok: true,
    value: {
      schema: "arbor.run-report/v1",
      campaign_id: campaignId,
      as_of,
      campaign,
      gate_refusal: latestGateRefusal(campaign),
      ledger: { total_records: records.length, included_records: included.length, truncated: included.length !== records.length, records: included },
      threads,
      approvals,
      evidence,
      waiver_outcomes: waiverOutcomes,
      session_failures: sessionFailures(runtime, campaignId),
    },
  };
}

function sessionFailures(runtime: ArborRuntime, campaignId: string): readonly RunReportSessionFailure[] {
  return (runtime.listHarnessSessions(campaignId, 200) ?? [])
    .filter((session) => session.failure !== undefined)
    .map((session) => ({ session_id: session.session_id, node_id: session.node_id, operation: session.operation, failure: session.failure! }))
    .sort((left, right) => left.session_id.localeCompare(right.session_id));
}

function latestGateRefusal(campaign: RunReport["campaign"]): GateRefusalProjection | null {
  const latest = [...campaign.nodes.flatMap((node) => node.gate_records)].reverse().find((record) => record.result !== "pass");
  return latest === undefined ? null : projectGateRecord(latest, defaultGateRemediation(latest.gate));
}

/** Stable local serialization for `arbor-mcp report --campaign <id> --json`. */
export function formatRunReport(result: RunReportResult): string { return JSON.stringify(result, null, 2); }

function resolveLimits(options: RunReportOptions): { ok: true; ledger: number; threads: number; threadMessages: number; evidence: number } | Extract<RunReportResult, { ok: false }> {
  const ledger = options.max_ledger_records ?? 1_000;
  const threadMessages = options.max_thread_messages ?? 200;
  const evidence = options.max_evidence_records ?? 200;
  if (![ledger, threadMessages, evidence].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 2_000)) {
    return { ok: false, error: { code: "validation", summary: "report limits must be integers from 1 through 2000" } };
  }
  return { ok: true, ledger, threads: 2_000, threadMessages, evidence };
}

function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
