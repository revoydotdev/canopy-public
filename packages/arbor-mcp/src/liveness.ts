/**
 * liveness.ts — continuous liveness attestation over the derived seam catalog.
 *
 * WHAT THIS IS FOR, stated before the mechanism, because the mechanism is
 * uninteresting without it.
 *
 * This repository already answers "does this symbol exist" (`tsc`), "is it
 * reachable from an entry point" (`gate:reachability`, a static TS-checker
 * walk), "does a test naming it exist" (`gate:obligations`' `roundtrip=`, and
 * 6.3's roundtrip manifest), and "does a document's claim about it resolve"
 * (`gate:docs-truth`). Every one of those is a *static* question, and the
 * repository's own graph model says so out loud: `.visual-intelligence`'s
 * views carry the line "Hollow defects — reachable code short-circuited by a
 * guard on an unset value — are not structurally detectable and are NOT
 * shown. Their absence from this view is not evidence of absence."
 *
 * That absence has been expensive. Every one of these was a real defect that
 * passed every static gate in the repository:
 *
 *   - `diagnostics` issued `event.resume` with `cursor: 0` where
 *     `RuntimeCursor` is `{stream_id, sequence}`. The call site existed and
 *     was reachable, so no graph could see it — but validation rejected it on
 *     *every* dispatch and the screen never rendered a real event on any run.
 *   - `modelCapabilityTokenBridge` never forwarded its `modelId`, so a real,
 *     tested, wired provider adapter was permanently dark (G-34).
 *   - `RecoveryService.execute` had a live call site guarded on an option
 *     nothing ever set, so recovery always rejected (G-03).
 *   - `a2a.send`/`a2a.receive` were injected in all three composition roots
 *     with no evidence any of them produced a working router (G-29).
 *
 * The common shape: **the code is present and reachable, and does not work.**
 * Only invocation can tell you that.
 *
 * TWO FAMILIES, because "callable" and "called correctly" are different
 * claims and conflating them is how the diagnostics bug survived:
 *
 *   1. CATALOG liveness — for each declared seam, does it answer when invoked
 *      correctly through a real composition root? Catches: advertised-but-
 *      unsupported, reachable-but-unconfigured, handlers that throw.
 *      **Does not** catch a consumer that calls a healthy seam wrongly.
 *   2. CONSUMER attestation — for each declared consumer, does *its own*
 *      dispatch produce a real result? This is the family that catches the
 *      diagnostics class, because the malformed payload is the consumer's.
 *
 * FOUR OUTCOMES, NOT TWO. A binary green/red would have scored `a2a.send`
 * (correctly refusing without a configured secret) and `diagnostics` (broken)
 * identically, and the interesting defects all live between the poles. The
 * fourth value is the one that keeps this honest: `indeterminate` means the
 * probe could not form a well-posed question, so **nothing is known** — never
 * silently folded into a pass. That is this repository's governing rule
 * applied to its own instrumentation: absence is a value, not a default.
 *
 * ATTESTATION IS A BYPRODUCT, NEVER A CLAIM. Nothing here asks a component
 * whether it is healthy. Every record in a report is produced by this module
 * actually calling the thing and observing what came back. That distinction is
 * not pedantic: G-22 and G-25 were both components asserting `verified`
 * provenance with a fabricated `stdout_hash` for a command that never ran. A
 * self-attesting component under an LLM that writes both the component and its
 * attestation is that defect with extra steps.
 */

import type { RuntimeError, RuntimeErrorCode } from "@arbor/core";
import {
  RUNTIME_CATALOG,
  catalogActionClass,
  type RuntimeCatalogEntry,
  type RuntimeCatalogKind,
  type RuntimeCatalogRouter,
} from "./runtime-catalog.js";

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * What one probe learned. Deliberately four-valued — see the module header for
 * why a binary result hides exactly the defects this exists to find.
 */
export type LivenessOutcome =
  /** The handler was reached and produced a real result. */
  | "answered"
  /**
   * The handler was reached and declined, in a way the system intends: not
   * configured, not permitted, or in conflict with current state. A refusal is
   * a *working* seam reporting a typed absence, and must never be counted as a
   * failure — `a2a.send` without `ARBOR_A2A_SIGNING_SECRET` is correct.
   */
  | "refused"
  /**
   * A well-posed request did not reach a working handler: the dispatch threw,
   * or returned an internal/transport/corrupt-data error. This is the finding.
   */
  | "unreachable"
  /**
   * Nothing is known. No probe was declared for this seam, or the probe's own
   * request failed validation — in which case the fault may be the probe's, and
   * claiming either health or failure would be inventing a result.
   */
  | "indeterminate";

/** Error codes that mean "the seam worked and said no", not "the seam is broken". */
const REFUSAL_CODES: ReadonlySet<RuntimeErrorCode> = new Set([
  "permission",
  "unavailable",
  "conflict",
  "cancellation",
]);

/** Error codes that mean the request never reached a working handler. */
const UNREACHABLE_CODES: ReadonlySet<RuntimeErrorCode> = new Set([
  "internal",
  "transport",
  "timeout",
  "corrupt_data",
]);

/**
 * Classify a `RuntimeError` into an outcome.
 *
 * `validation` maps to `indeterminate`, never `unreachable`, and the reason is
 * epistemic rather than charitable: from inside the prober, a validation
 * failure is indistinguishable between "the seam rejects well-formed input"
 * and "this probe's payload is wrong". Reporting it as a defect would produce
 * false findings the moment a contract legitimately changes; reporting it as
 * healthy would hide real ones. Reporting that nothing is known is the only
 * honest option, and the gate counts those so drift stays visible instead of
 * quietly eroding coverage.
 */
export function classifyRuntimeError(
  error: RuntimeError,
  /**
   * Who authored the request. This changes what a `validation` failure means,
   * and it is the single most important distinction in this module.
   *
   * For a `prober` request, validation is genuinely ambiguous: the probe's own
   * payload is a fixture and may simply be wrong, so the honest answer is that
   * nothing is known.
   *
   * For a `consumer` request it is not ambiguous at all — the consumer's own
   * request shape is the thing under test. "The request this screen actually
   * sends does not validate" is the finding, not a caveat about it. Collapsing
   * the two would have downgraded the diagnostics defect to `indeterminate`
   * and let it pass a gate, which is how it survived in the first place.
   */
  author: "prober" | "consumer" = "prober",
): LivenessOutcome {
  if (error.code === "validation") return author === "consumer" ? "unreachable" : "indeterminate";
  if (REFUSAL_CODES.has(error.code)) return "refused";
  if (UNREACHABLE_CODES.has(error.code)) return "unreachable";
  return "unreachable";
}

// ---------------------------------------------------------------------------
// Probe records
// ---------------------------------------------------------------------------

export interface CatalogLivenessProbe {
  readonly kind: RuntimeCatalogKind;
  readonly direction: RuntimeCatalogEntry["direction"];
  readonly capability: string;
  /** ADR-028's action class, derived from the catalog rather than restated. */
  readonly action_class: ReturnType<typeof catalogActionClass>;
  /** What the catalog declares, so an advertised-but-dead seam is visible as such. */
  readonly declared_supported: boolean;
  readonly outcome: LivenessOutcome;
  /** The observed reason, verbatim where the runtime gave one. Never synthesised. */
  readonly detail: string;
  /** Present only when the dispatch produced a typed error. */
  readonly error_code: RuntimeErrorCode | null;
}

export interface ConsumerLivenessProbe {
  /** The consumer being attested, e.g. a TUI screen id. */
  readonly consumer: string;
  /** The catalog kind this consumer's own dispatch targets. */
  readonly kind: RuntimeCatalogKind;
  readonly outcome: LivenessOutcome;
  readonly detail: string;
  readonly error_code: RuntimeErrorCode | null;
}

export interface LivenessReport {
  readonly at: string;
  readonly catalog: readonly CatalogLivenessProbe[];
  readonly consumers: readonly ConsumerLivenessProbe[];
  /**
   * Screens that dispatch a query with no declared consumer attesting to it —
   * i.e. real request shapes nothing checks. `null` means the check could not
   * run (the source it scans was not found), which is a typed absence, not an
   * empty result meaning "all clear".
   */
  readonly consumer_drift: readonly string[] | null;
  readonly summary: LivenessSummary;
}

export interface LivenessSummary {
  readonly catalog_total: number;
  readonly catalog_answered: number;
  readonly catalog_refused: number;
  readonly catalog_unreachable: number;
  readonly catalog_indeterminate: number;
  readonly consumers_total: number;
  readonly consumers_answered: number;
  readonly consumers_refused: number;
  readonly consumers_unreachable: number;
  readonly consumers_indeterminate: number;
}

// ---------------------------------------------------------------------------
// Probe payloads
// ---------------------------------------------------------------------------

/**
 * The request body a probe sends for a given kind, minus the envelope metadata
 * the prober supplies.
 *
 * These are fixtures, not a second source of truth about the contracts. The
 * validators in `*-contracts.ts` remain authoritative, and a fixture that
 * drifts away from one does not produce a false green — it fails validation
 * and surfaces as `indeterminate`, which the gate counts and reports. That
 * self-correcting property is why a payload table is acceptable here where a
 * hand-maintained mirror of the catalog itself would not be: this table can
 * only ever *lose* information, never fabricate it.
 */
export type ProbePayload = Record<string, unknown>;

export interface LivenessProbeContext {
  /** A campaign the prober seeded, so domain-state-dependent kinds are answerable. */
  readonly campaign_id: string;
  /** The root node of that campaign. */
  readonly node_id: string;
  /** A real direct child of `node_id`, seeded for relationship-scoped thread probes. */
  readonly child_node_id: string;
  /** The live event stream's id, for cursor-shaped queries. */
  readonly stream_id: string;
  /** A real operation registered by the disposable composition root. */
  readonly operation_id?: string;
  /** A real, descriptor-only output artifact owned by the disposable root. */
  readonly output_evidence_id?: string;
  /** A bounded campaign-visible artifact owned by the disposable root. */
  readonly context_artifact_id?: string;
  /** A real, non-secret remote-session record seeded for trust read probes. */
  readonly remote_session_id?: string;
  /** A settled redacted hermetic evaluation run seeded for the detail probe. */
  readonly evaluation_run_id?: string;
  /** Read-only copy of the tracked governance corpus inside the disposable root. */
  readonly governance_repo_root?: string;
}

/**
 * Probe payloads keyed by catalog kind. A kind absent from this table probes as
 * `indeterminate` with "no probe payload declared" — visible, counted, and
 * never mistaken for health.
 */
export function probePayloads(ctx: LivenessProbeContext): Partial<Record<RuntimeCatalogKind, ProbePayload>> {
  const { campaign_id, node_id, child_node_id, stream_id, operation_id, output_evidence_id, context_artifact_id, remote_session_id, evaluation_run_id, governance_repo_root } = ctx;
  return {
    // ---- queries (read class: safe to invoke for real) ----
    "campaign.list": { limit: 10 },
    "campaign.snapshot": { campaign_id },
    "campaign.tree": { campaign_id, limit: 50 },
    "control.status": {},
    "control.discover": { limit: 10 },
    "control.inbox": { limit: 10 },
    // Recent catalog additions now have explicit, well-formed probes. Git
    // workspace commands are exercised by the disposable trajectory below;
    // their current composition is expected to return a typed unavailable
    // refusal because this liveness root deliberately does not grant a host
    // worktree manager.
    "git.workspace": {},
    "inspect.action": { action_id: operation_id ?? "liveness-detail-operation" },
    "governance.record.search": { ...(governance_repo_root === undefined ? {} : { repo_root: governance_repo_root }), query: "ADR-001", limit: 5 },
    "governance.record.read": { ...(governance_repo_root === undefined ? {} : { repo_root: governance_repo_root }), id: "revoy2:ADR-001" },
    // Pre-campaign composition is durable runtime state but deliberately has
    // no raw planner transcript/evidence projection. A page of redacted draft
    // metadata is the liveness seam we can truthfully exercise.
    "taskcomposer.list": { limit: 10 },
    "taskcomposer.get": { draft_id: "liveness-absent-draft" },
    "migration.preview": { source_path: "liveness-absent.json" },
    "operation.list": { include_terminal: false },
    // These identities are seeded directly into the disposable composition
    // root. The probe itself remains read-only and observes the same
    // per-record paths an operator uses after selecting a list row.
    ...(operation_id === undefined ? {} : { "operation.get": { operation_id } }),
    "recovery.pending": { campaign_id, limit: 50 },
    "task.list": { limit: 10 },
    "event.resume": { cursor: { stream_id, sequence: 0 } },
    "communication.selection": { campaign_id, node_id, limit: 10 },
    "communication.history": { campaign_id, node_id, limit: 10 },
    "output.list": {},
    ...(output_evidence_id === undefined ? {} : {
      "output.descriptor": { evidence_id: output_evidence_id },
    // This deliberately has no approval. It reaches the real raw-output
    // authorization boundary and must refuse before any bytes are disclosed.
      "output.raw": { evidence_id: output_evidence_id, approval_id: "liveness-no-approval" },
    }),
    "surveillance.findings": { campaign_id, limit: 10 },
    "capability.introspect": {},
    "config.get": {},
    "harness.connector.inventory": {},
    "harness.native.readiness": {},
    "native.budget.get": { campaign_id },
    "agent.list": {},
    "job.list": {},
    "approval.list": { status: "pending", limit: 10 },
    "trust.session.list": { limit: 10 },
    ...(remote_session_id === undefined ? {} : { "trust.session.status": { session_id: remote_session_id } }),
    "compaction.list": { campaign_id },
    "compaction.guard": { campaign_id, node_id },
    "userinput.list": { campaign_id, limit: 10 },
    "userinput.awaiting": { campaign_id },
    "bus.history": { campaign_id, limit: 10 },
    "bus.thread.history": { campaign_id, parent_node_id: node_id, child_node_id, limit: 10 },
    "context.overlays": { campaign_id },
    "subagent.executions": { campaign_id },
    "harness.evaluation.candidates": { campaign_id },
    "harness.evaluation.runs": { campaign_id },
    ...(evaluation_run_id === undefined ? {} : { "harness.evaluation.detail": { run_id: evaluation_run_id } }),
    ...(context_artifact_id === undefined ? {} : {
      "context.workspace": { artifact_id: context_artifact_id, offset: 0, max_bytes: 128, visibility: "campaign" },
    }),
    "context.governance": { campaign_id },
    "sibling.status": { campaign_id, node_id },
    "governance.snapshot": {},
    "governance.backlog": {},
    "kb.list": { campaign_id, limit: 10 },
    "audit.list": { campaign_id, limit: 10 },
    "harness.session.list": { limit: 10 },
    "harness.session.inspect": { session_id: "liveness-absent-session" },
    "harness.session.events": { session_id: "liveness-absent-session", limit: 10 },
    "harness.session.attach": { session_id: "liveness-absent-session", after_sequence: 0, limit: 10 },
    "harness.session.availability": { session_id: "liveness-absent-session" },
    "doctor.get": {},
    "migration.inspect": {},
    "integration.list": {},
    "integration.inspect": { integration_id: "browser.uncomposed" },
    "integration.admit": { integration_id: "browser.uncomposed", capabilities: [] },
    "remote.inspect": {},
    "scheduler.inspect": {},
    "remote.control": {},
    "scheduler.control": {},
    "result.list": { campaign_id, limit: 10 },
    "result.inspect": { campaign_id, node_id },
    "result.review.workspace": { campaign_id, node_id },
    "session.identity.get": { session_id: "liveness-absent-session" },
    "session.identity.search": { query: "liveness", limit: 10 },
    "result.verification.get": { campaign_id, node_id },
    "result.verification.list": { campaign_id, limit: 10 },
    "notification.list": { limit: 10 },
    "followup.list": { parent_campaign_id: campaign_id, limit: 10 },
    "phase_message.list": { campaign_id, limit: 10 },
    "peer.history": { grant_id: "liveness-absent-grant", limit: 10 },
    "peer.grants": { campaign_id },
    "project.registry.list": {},
    "project.manage": {},

    // G-29 live projections: foreground/nodecard must receive node identity.
    // A2A remains correctly refused when the composition root has no secret.
    "foreground.derive": { campaign_id, node_id },
    "nodecard.resolve": { campaign_id, node_id },
    "a2a.cards": { campaign_id },
  };
}

// ---------------------------------------------------------------------------
// The catalog prober
// ---------------------------------------------------------------------------

function probeMetadata(kind: string): Record<string, string> {
  return {
    operation_id: `liveness-${kind}`,
    idempotency_key: `liveness-${kind}`,
    correlation_id: `liveness-${kind}`,
    actor_id: "liveness-prober",
    requested_at: "2026-01-01T00:00:00.000Z",
  };
}

/** Narrow the router result shapes without importing their private unions. */
interface ProbeResultShape {
  ok?: boolean;
  error?: RuntimeError;
  value?: { accepted?: boolean; error?: RuntimeError } | unknown;
}

function classifyResult(
  result: unknown,
  author: "prober" | "consumer" = "prober",
): { outcome: LivenessOutcome; detail: string; error_code: RuntimeErrorCode | null } {
  const shaped = result as ProbeResultShape;

  if (shaped.ok === false) {
    const error = shaped.error;
    if (!error) return { outcome: "unreachable", detail: "dispatch failed with no typed error", error_code: null };
    return { outcome: classifyRuntimeError(error, author), detail: error.summary, error_code: error.code };
  }

  // A command path reports a refusal as an accepted:false acknowledgement
  // rather than ok:false, so both shapes must be read or every command refusal
  // would be miscounted as an answer.
  const value = shaped.value as { accepted?: boolean; error?: RuntimeError } | undefined;
  if (value && value.accepted === false) {
    const error = value.error;
    if (!error) return { outcome: "unreachable", detail: "rejected with no typed error", error_code: null };
    return { outcome: classifyRuntimeError(error, author), detail: error.summary, error_code: error.code };
  }

  return { outcome: "answered", detail: "handler produced a result", error_code: null };
}

export interface ProbeCatalogOptions {
  readonly router: RuntimeCatalogRouter;
  readonly context: LivenessProbeContext;
  /**
   * Probe mutating kinds too. Off by default: `preview-confirm` kinds have real
   * effects (`campaign.halt` halts a campaign), so invoking them for liveness
   * requires a disposable runtime the caller owns. When off they report as
   * `indeterminate` with an explicit reason, never as healthy.
   */
  readonly includeMutating?: boolean;
  /**
   * Real disposable-runtime trajectories for commands. A trajectory must
   * dispatch the command and assert its persisted consequence before returning
   * the observed router result; a payload table alone is not evidence here.
   */
  readonly mutatingProbes?: Partial<Record<RuntimeCatalogKind, () => unknown | Promise<unknown>>>;
}

/**
 * Invoke every declared catalog seam and report what came back.
 *
 * Unsupported kinds are probed too rather than skipped: a kind declared
 * `supported: false` should *refuse* with its `unavailable_reason`, and one
 * that instead answers or throws is a catalog lying about itself in one
 * direction or the other. G-29 was exactly this — eight kinds advertised
 * `supported: true` and rejected before dispatch.
 */
export async function probeCatalog(options: ProbeCatalogOptions): Promise<CatalogLivenessProbe[]> {
  const { router, context } = options;
  const payloads = probePayloads(context);
  const probes: CatalogLivenessProbe[] = [];

  for (const entry of RUNTIME_CATALOG) {
    const actionClass = catalogActionClass(entry);
    const base = {
      kind: entry.kind,
      direction: entry.direction,
      capability: entry.capability,
      action_class: actionClass,
      declared_supported: entry.supported,
    } as const;

    if (!entry.supported) {
      const envelope = entry.direction === "query"
        ? { schema_version: 1, query_id: `liveness-${entry.kind}`, metadata: probeMetadata(entry.kind), query: { kind: entry.kind } }
        : { schema_version: 1, metadata: probeMetadata(entry.kind), command: { kind: entry.kind } };
      try {
        const result = entry.direction === "query"
          ? router.executeQuery(envelope)
          : await router.dispatchCommand(envelope);
        probes.push({ ...base, ...classifyResult(result) });
      } catch (error) {
        probes.push({ ...base, outcome: "unreachable", detail: `unsupported seam threw: ${error instanceof Error ? error.message : String(error)}`, error_code: null });
      }
      continue;
    }

    if (entry.direction === "command" && options.includeMutating !== true) {
      probes.push({
        ...base,
        outcome: "indeterminate",
        detail: "mutating kind not probed (preview-confirm class; pass includeMutating with a disposable runtime)",
        error_code: null,
      });
      continue;
    }

    if (entry.direction === "command") {
      const trajectory = options.mutatingProbes?.[entry.kind];
      if (trajectory === undefined) {
        probes.push({ ...base, outcome: "indeterminate", detail: "no disposable mutating trajectory declared", error_code: null });
        continue;
      }
      try { probes.push({ ...base, ...classifyResult(await trajectory()) }); }
      catch (error) { probes.push({ ...base, outcome: "unreachable", detail: `trajectory threw: ${error instanceof Error ? error.message : String(error)}`, error_code: null }); }
      continue;
    }

    const payload = payloads[entry.kind];
    if (payload === undefined) {
      probes.push({ ...base, outcome: "indeterminate", detail: "no probe payload declared", error_code: null });
      continue;
    }

    const envelope = { schema_version: 1, query_id: `liveness-${entry.kind}`, metadata: probeMetadata(entry.kind), query: { kind: entry.kind, ...payload } };

    try {
      const result = router.executeQuery(envelope);
      const classified = classifyResult(result);
      probes.push({ ...base, ...classified });
    } catch (error) {
      // A throw is the strongest possible signal: the seam is declared and the
      // dispatch path could not survive being called at all.
      probes.push({
        ...base,
        outcome: "unreachable",
        detail: `dispatch threw: ${error instanceof Error ? error.message : String(error)}`,
        error_code: null,
      });
    }
  }

  return probes;
}

// ---------------------------------------------------------------------------
// The consumer prober
// ---------------------------------------------------------------------------

/**
 * A declared consumer of a catalog seam: something in the product that issues
 * this exact request on a real run.
 *
 * The payload here is the CONSUMER'S, not the prober's. That is the entire
 * point of this family: `diagnostics` sent `cursor: 0` where the contract
 * requires `{stream_id, sequence}`, and no static analysis could see it because
 * the call site existed and was reachable. A catalog probe would have reported
 * `event.resume` healthy, because the *prober's* payload was correct. Only
 * replaying the consumer's own request finds it.
 */
export interface DeclaredConsumer {
  readonly consumer: string;
  readonly kind: RuntimeCatalogKind;
  /** Built the way the consumer builds it, from the same context it has. */
  readonly request: (ctx: LivenessProbeContext) => ProbePayload;
}

export interface ProbeConsumersOptions {
  readonly router: RuntimeCatalogRouter;
  readonly context: LivenessProbeContext;
  readonly consumers: readonly DeclaredConsumer[];
}

export function probeConsumers(options: ProbeConsumersOptions): ConsumerLivenessProbe[] {
  const { router, context, consumers } = options;
  const probes: ConsumerLivenessProbe[] = [];

  for (const consumer of consumers) {
    const entry = RUNTIME_CATALOG.find((candidate) => candidate.kind === consumer.kind && candidate.direction === "query");
    if (!entry) {
      probes.push({
        consumer: consumer.consumer,
        kind: consumer.kind,
        outcome: "indeterminate",
        detail: `no query catalog entry for ${consumer.kind}`,
        error_code: null,
      });
      continue;
    }

    try {
      const payload = consumer.request(context);
      const result = router.executeQuery({
        schema_version: 1,
        query_id: `liveness-consumer-${consumer.consumer}`,
        metadata: probeMetadata(consumer.kind),
        query: { kind: consumer.kind, ...payload },
      });
      const classified = classifyResult(result, "consumer");
      probes.push({ consumer: consumer.consumer, kind: consumer.kind, ...classified });
    } catch (error) {
      probes.push({
        consumer: consumer.consumer,
        kind: consumer.kind,
        outcome: "unreachable",
        detail: `consumer dispatch threw: ${error instanceof Error ? error.message : String(error)}`,
        error_code: null,
      });
    }
  }

  return probes;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function count(probes: readonly { outcome: LivenessOutcome }[], outcome: LivenessOutcome): number {
  return probes.filter((probe) => probe.outcome === outcome).length;
}

export function summarize(
  catalog: readonly CatalogLivenessProbe[],
  consumers: readonly ConsumerLivenessProbe[],
): LivenessSummary {
  return {
    catalog_total: catalog.length,
    catalog_answered: count(catalog, "answered"),
    catalog_refused: count(catalog, "refused"),
    catalog_unreachable: count(catalog, "unreachable"),
    catalog_indeterminate: count(catalog, "indeterminate"),
    consumers_total: consumers.length,
    consumers_answered: count(consumers, "answered"),
    consumers_refused: count(consumers, "refused"),
    consumers_unreachable: count(consumers, "unreachable"),
    consumers_indeterminate: count(consumers, "indeterminate"),
  };
}

export interface BuildLivenessReportOptions extends ProbeCatalogOptions {
  readonly at: string;
  readonly consumers?: readonly DeclaredConsumer[];
  /** Screens dispatching with no declared consumer; `null` when undeterminable. */
  readonly consumerDrift?: readonly string[] | null;
}

/** Probe everything and assemble the report. Deterministic given the same runtime. */
export async function buildLivenessReport(options: BuildLivenessReportOptions): Promise<LivenessReport> {
  const catalog = await probeCatalog(options);
  const consumers = options.consumers === undefined
    ? []
    : probeConsumers({ router: options.router, context: options.context, consumers: options.consumers });
  return {
    at: options.at,
    catalog,
    consumers,
    consumer_drift: options.consumerDrift ?? null,
    summary: summarize(catalog, consumers),
  };
}
