/**
 * Production composition for governed harness controlled A/B evaluation.
 *
 * This module is intentionally in @arbor/mcp rather than @arbor/eval: the
 * evaluator package depends on mcp, while this composition root must be
 * reachable from the CLI without creating that dependency cycle.  It owns no
 * provider, tool, or scenario fixture.  A configured native executor is
 * supplied lazily and the campaign ledger supplies durable replay/holdout
 * inputs.  Missing either is an explicit unmeasured outcome.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendGovernedOverlay, DEFAULT_LOOP_CONFIG } from "@arbor/opencode";
import { redactNativeText, type NativeUsageAndCost, type SessionEvent } from "@arbor/harness";
import type { RevisionEvaluation } from "@arbor/core";
import type { HarnessEvaluationPort } from "./harness-evaluation-port.js";
import type { GovernedContextService } from "./governed-context-service.js";
import type { NativeAgentExecutor, NativeReadOnlyEvaluationResult } from "./native-agent-executor.js";

const EVALUATOR_ID = "revoy-native-controlled-overlay-v1";
const MAX_SOURCE_BYTES = 8_192;
const MAX_SCENARIO_WALL_CLOCK_MS = 60_000;

interface DurableScenario {
  readonly id: string;
  readonly partition: "replay" | "holdout";
  readonly prompt: string;
  /** SHA-256 of the redacted expected final response, independently persisted in campaign evidence. */
  readonly expected_final_sha256: string;
}

interface ObservedArm {
  readonly accepted: boolean;
  readonly state_hash: string;
  readonly model_turns: number;
  readonly tool_calls: number;
  readonly events: number;
  readonly measured_tokens: number;
  readonly latency_ms: number;
  /** Response-bound provider/model/revision identity; never a model-name-only surrogate. */
  readonly model_identity: Readonly<{ provider_id: string; model_id: string; revision: string }>;
  readonly summary: string;
}

/** CLI/runtime default. It is real even when provider configuration is absent. */
export class ProductionHarnessEvaluator implements HarnessEvaluationPort {
  readonly evaluator_id = EVALUATOR_ID;

  constructor(private readonly options: {
    readonly context: () => GovernedContextService;
    readonly audit_records: (campaign_id: string) => readonly unknown[];
    /** Lazy so CLI startup never reads credentials or opens a provider transport. */
    readonly native_executor: () => NativeAgentExecutor | null;
    readonly now?: () => number;
  }) {}

  async evaluate(input: { readonly revision_id: string; readonly run_id: string; readonly signal?: AbortSignal }): Promise<
    | { kind: "measured"; evaluation: RevisionEvaluation; evidence_ids: readonly string[]; detail: readonly Record<string, unknown>[] }
    | { kind: "unmeasured"; reason: string }
  > {
    const context = this.options.context();
    const revision = context.getRevision(input.revision_id);
    if (revision === null) return { kind: "unmeasured", reason: "harness revision was not found" };
    if (revision.status !== "active" || !revision.approved_by || revision.approved_by === revision.proposed_by) {
      return { kind: "unmeasured", reason: "evaluation requires an independently approved active harness revision" };
    }
    const sources = this.scenarios(revision.campaign_id, revision.source_event_ids);
    if (sources.kind === "unmeasured") return sources;
    let native: NativeAgentExecutor | null;
    try { native = this.options.native_executor(); } catch { return { kind: "unmeasured", reason: "configured native evaluator provider is unavailable" }; }
    if (native === null) return { kind: "unmeasured", reason: "configured native evaluator provider is unavailable" };

    const prepared: Array<{ source: DurableScenario; control_prompt: string; candidate_prompt: string }> = [];
    for (const source of sources.value) {
      const checkpointAt = new Date(this.now()).toISOString();
      const controlCheckpoint = context.checkpoint({ campaign_id: revision.campaign_id, node_id: `evaluation:${source.id}`, as_of: checkpointAt, exclude_revision_ids: [revision.id] });
      const candidateCheckpoint = context.checkpoint({ campaign_id: revision.campaign_id, node_id: `evaluation:${source.id}`, as_of: checkpointAt });
      if (!candidateCheckpoint.applied_overlay_ids.includes(revision.id)) {
        return { kind: "unmeasured", reason: `selected revision ${revision.id} is not enactable by the production governed checkpoint` };
      }
      if (controlCheckpoint.applied_overlay_ids.includes(revision.id)) {
        return { kind: "unmeasured", reason: "control checkpoint retained the selected candidate revision" };
      }
      const base = `${DEFAULT_LOOP_CONFIG.specialist_base_prompt}\n\nEvaluation scenario evidence (${source.partition}):\n${source.prompt}\n\nTask: assess the bounded durable evidence. Return a concise final result; do not request tools or human input.`;
      // The exact loop overlay renderer is shared with production dispatch.
      const controlPrompt = appendGovernedOverlay(base, controlCheckpoint, "specialist");
      const candidatePrompt = appendGovernedOverlay(base, candidateCheckpoint, "specialist");
      prepared.push({ source, control_prompt: controlPrompt, candidate_prompt: candidatePrompt });
    }
    if (input.signal?.aborted) return { kind: "unmeasured", reason: "controlled evaluation was cancelled" };
    const reservation = native.reserveReadOnlyEvaluationPair({ campaign_id: revision.campaign_id, reservation_id: `controlled-evaluation:${input.run_id}`, prompts: prepared.flatMap((item) => [item.control_prompt, item.candidate_prompt]) });
    if (reservation.kind === "denied") return { kind: "unmeasured", reason: reservation.reason };
    const observations: Array<NativeUsageAndCost | null> = [];
    const episodes: Array<{ partition: "replay" | "holdout"; scenario_id: string; control: ObservedArm; candidate: ObservedArm; candidate_better: boolean; candidate_regressed: boolean; evidence_id: string }> = [];
    try {
      for (const { source, control_prompt, candidate_prompt } of prepared) {
        const result = await this.executePair(native, { campaign_id: revision.campaign_id, revision_id: revision.id, scenario_id: source.id, expected_final_sha256: source.expected_final_sha256, control_prompt, candidate_prompt, signal: input.signal });
        if (result.kind === "unmeasured") return result;
        observations.push(...result.observations);
        const stateDiverged = result.candidate.state_hash !== result.control.state_hash;
        const candidate_better = result.candidate.accepted && !result.control.accepted && !stateDiverged;
        const candidate_regressed = (!result.candidate.accepted && result.control.accepted) || stateDiverged;
        const evidence = JSON.stringify({ schema_version: 1, evaluation_run_id: input.run_id, revision_id: revision.id, scenario_id: source.id, partition: source.partition, execution: { filesystem: "read_only", tools: 0, network: false, human_input: false, ceiling: native.readOnlyEvaluationCeiling() }, control: redactArm(result.control), candidate: redactArm(result.candidate) });
        const artifact = context.captureArtifact({ campaign_id: revision.campaign_id, media_type: "application/vnd.arbor.overlay-evaluation+json", producer: EVALUATOR_ID, visibility: "critic_only", provenance: { tag: "generated", generator: EVALUATOR_ID, input_hash: `sha256:${hash(evidence)}` }, content: evidence });
        episodes.push({ partition: source.partition, scenario_id: source.id, control: result.control, candidate: result.candidate, candidate_better, candidate_regressed, evidence_id: artifact.id });
      }
    } finally {
      if (reservation.kind === "reserved") native.settleReadOnlyEvaluationPair({ campaign_id: revision.campaign_id, reservation_id: reservation.reservation_id, observations });
    }

    const regression_detected = episodes.some((episode) => episode.candidate_regressed);
    const improved = episodes.some((episode) => episode.candidate_better) && !regression_detected;
    const evaluation: RevisionEvaluation = {
      outcome: regression_detected ? "regressed" : improved ? "improved" : "unchanged",
      fidelity_ratio: episodes.filter((episode) => episode.candidate.accepted === episode.control.accepted || episode.candidate_better).length / episodes.length,
      main_model_tokens: sum(episodes.map((episode) => episode.control.measured_tokens)),
      child_model_tokens: sum(episodes.map((episode) => episode.candidate.measured_tokens)),
      latency_ms: sum(episodes.map((episode) => episode.candidate.latency_ms)),
      regression_detected,
      rollback_count: 0,
      replay_evidence_ids: episodes.filter((episode) => episode.partition === "replay").map((episode) => episode.evidence_id),
      holdout_evidence_ids: episodes.filter((episode) => episode.partition === "holdout").map((episode) => episode.evidence_id),
    };
    return {
      kind: "measured",
      evaluation,
      evidence_ids: episodes.map((episode) => episode.evidence_id),
      detail: episodes.map((episode) => ({ scenario_id: episode.scenario_id, partition: episode.partition, control: episode.control.summary, candidate: episode.candidate.summary, candidate_better: episode.candidate_better, candidate_regressed: episode.candidate_regressed })),
    };
  }

  private scenarios(campaignId: string, sourceIds: readonly string[]): { kind: "measured"; value: readonly DurableScenario[] } | { kind: "unmeasured"; reason: string } {
    const byId = new Map<string, DurableScenario>();
    for (const record of this.options.audit_records(campaignId)) {
      const parsed = durableScenario(record, campaignId);
      if (parsed !== null) byId.set(parsed.id, parsed);
    }
    const unique = [...new Set(sourceIds)].map((id) => byId.get(id)).filter((row): row is DurableScenario => row !== undefined);
    const replay = unique.filter((row) => row.partition === "replay");
    const holdout = unique.filter((row) => row.partition === "holdout");
    if (unique.length !== sourceIds.length || replay.length !== 1 || holdout.length !== 1 || replay[0]!.id === holdout[0]!.id) {
      return { kind: "unmeasured", reason: "evaluation requires exactly one independently durable replay and holdout scenario corpus record referenced by the revision" };
    }
    return { kind: "measured", value: [replay[0]!, holdout[0]!] };
  }

  private async executePair(native: NativeAgentExecutor, input: { campaign_id: string; revision_id: string; scenario_id: string; expected_final_sha256: string; control_prompt: string; candidate_prompt: string; signal?: AbortSignal }): Promise<{ kind: "measured"; control: ObservedArm; candidate: ObservedArm; observations: readonly (NativeUsageAndCost | null)[] } | { kind: "unmeasured"; reason: string }> {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort("controlled evaluation was cancelled");
    if (input.signal?.aborted) forwardAbort(); else input.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort("controlled evaluator wall-clock limit"), MAX_SCENARIO_WALL_CLOCK_MS);
    const suffix = `${input.revision_id}:${input.scenario_id}:${randomUUID()}`;
    try {
      const arm = async (arm: "control" | "candidate", prompt: string) => {
        const started = this.now();
        const result = await native.evaluateReadOnly({ campaign_id: input.campaign_id, node_id: `evaluation-${arm}:${input.scenario_id}`, prompt, session_id: `evaluation:${arm}:${suffix}`, signal: controller.signal });
        return { result, latency_ms: Math.max(0, this.now() - started) };
      };
      const [control, candidate] = await Promise.all([arm("control", input.control_prompt), arm("candidate", input.candidate_prompt)]);
      const observedControl = observe(control.result, input.expected_final_sha256, control.latency_ms);
      const observedCandidate = observe(candidate.result, input.expected_final_sha256, candidate.latency_ms);
      if (observedControl.kind === "unmeasured") return observedControl;
      if (observedCandidate.kind === "unmeasured") return observedCandidate;
      if (!sameModelIdentity(observedControl.value.model_identity, observedCandidate.value.model_identity)) {
        return { kind: "unmeasured", reason: "control and candidate did not use the same provider/model/revision identity" };
      }
      if (controller.signal.aborted) return { kind: "unmeasured", reason: "controlled evaluator exceeded its bounded wall-clock limit" };
      return { kind: "measured", control: observedControl.value, candidate: observedCandidate.value, observations: [control.result.usage_and_cost, candidate.result.usage_and_cost] };
    } catch {
      return { kind: "unmeasured", reason: controller.signal.aborted ? "controlled evaluator aborted at its bounded wall-clock limit" : "native evaluator did not produce both bounded outcomes" };
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", forwardAbort); }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}

function observe(result: NativeReadOnlyEvaluationResult, expectedFinalSha256: string, latencyMs: number): { kind: "measured"; value: ObservedArm } | { kind: "unmeasured"; reason: string } {
  const policy = result.inspection.policy;
  const toolCalls = result.events.filter((event) => event.kind === "tool_intent").length;
  if (policy.filesystem !== "read_only" || policy.network_allowed || policy.tool_allow.length !== 0 || toolCalls !== 0) return { kind: "unmeasured", reason: "native evaluator arm violated fixed no-tools/read-only policy" };
  if (result.inspection.ephemeral !== true || result.inspection.lineage.kind !== "new") return { kind: "unmeasured", reason: "native evaluator arm was not a fresh ephemeral session" };
  if (result.events.length > policy.max_events || result.inspection.terminal === null) return { kind: "unmeasured", reason: "native evaluator arm exceeded or lacked bounded event evidence" };
  const measured = measuredTokens(result.events);
  if (measured === null) return { kind: "unmeasured", reason: "native evaluator provider did not report measured token usage" };
  const identity = result.model_identity;
  if (identity === null || !identity.provider_id.trim() || !identity.model_id.trim()) return { kind: "unmeasured", reason: "native evaluator model identity is unavailable" };
  // Model names can be moving aliases. A controlled live comparison is not
  // measured unless both arms can later be joined on a response-observed
  // revision. A configured adapter pin fails even earlier if it is absent or
  // mismatched; this check also keeps unpinned rolling aliases unmeasured.
  if (identity.revision === null || identity.revision.trim().length === 0) {
    return { kind: "unmeasured", reason: "native evaluator model revision is unavailable; configure a supporting observed response revision pin" };
  }
  const terminal = result.inspection.terminal;
  const finalHash = hash(redactNativeText(terminal.message));
  // Completion alone is not task quality. The corpus's independently
  // persisted oracle defines the observed semantic state for each arm.
  const accepted = result.inspection.state === "completed" && (terminal.result === "claimed" || terminal.result === "verified") && finalHash === expectedFinalSha256;
  // `state_hash` is reserved for externally observable side effects. These
  // arms are fixed no-tools/read-only sessions, so the only observable state
  // is their common execution policy.  Do not fold correctness/oracle output
  // into this hash: doing so would turn every genuine candidate improvement
  // into a false "state divergence" regression.
  const state = JSON.stringify({ filesystem: policy.filesystem, network: policy.network_allowed, tools: policy.tool_allow.length, inherited_credentials: policy.inherited_credentials_allowed });
  return { kind: "measured", value: {
    accepted,
    state_hash: `sha256:${hash(state)}`,
    model_turns: result.events.filter((event) => event.kind === "usage").length,
    tool_calls: toolCalls,
    events: result.events.length,
    measured_tokens: measured,
    latency_ms: latencyMs,
    model_identity: Object.freeze({ provider_id: identity.provider_id, model_id: identity.model_id, revision: identity.revision }),
    summary: `state ${result.inspection.state}; cause ${terminal.cause}; events ${result.events.length}`,
  } };
}

function sameModelIdentity(left: ObservedArm["model_identity"], right: ObservedArm["model_identity"]): boolean {
  return left.provider_id === right.provider_id && left.model_id === right.model_id && left.revision === right.revision;
}

function measuredTokens(events: readonly SessionEvent[]): number | null {
  const usage = events.filter((event): event is Extract<SessionEvent, { kind: "usage" }> => event.kind === "usage");
  if (usage.length === 0 || usage.some((event) => event.payload.input_tokens === null || event.payload.output_tokens === null)) return null;
  const tokens = sum(usage.map((event) => event.payload.input_tokens! + event.payload.output_tokens!));
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

function durableScenario(value: unknown, campaignId: string): DurableScenario | null {
  if (!isRecord(value) || value.kind !== "node_communication" || value.campaign_id !== campaignId || typeof value.id !== "string" || !isRecord(value.communication) || !isRecord(value.communication.payload) || typeof value.communication.payload.content !== "string") return null;
  try {
    const corpus: unknown = JSON.parse(value.communication.payload.content);
    if (!isRecord(corpus) || corpus.schema_version !== 1 || corpus.kind !== "harness_evaluation_scenario" || (corpus.partition !== "replay" && corpus.partition !== "holdout") || typeof corpus.prompt !== "string" || typeof corpus.expected_final_sha256 !== "string") return null;
    const prompt = redactNativeText(corpus.prompt).slice(0, MAX_SOURCE_BYTES).trim();
    if (!value.id.trim() || !prompt || !/^sha256:[a-f0-9]{64}$/.test(corpus.expected_final_sha256)) return null;
    return { id: value.id, partition: corpus.partition, prompt, expected_final_sha256: corpus.expected_final_sha256.slice("sha256:".length) };
  } catch { return null; }
}
function redactArm(value: ObservedArm) { return { accepted: value.accepted, state_hash: value.state_hash, model_turns: value.model_turns, tool_calls: value.tool_calls, events: value.events, measured_tokens: value.measured_tokens, latency_ms: value.latency_ms, model_identity: value.model_identity, summary: value.summary }; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
