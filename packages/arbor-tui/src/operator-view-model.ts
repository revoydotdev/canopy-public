/**
 * Pure, bounded projection for the operator-facing session document.
 *
 * This module owns no transport, subscription, lifecycle, task, or command
 * state. It accepts structural views from the composition layer and preserves
 * their source/truth identity so a renderer cannot make an ephemeral
 * diagnostic tail look like canonical session evidence.
 */

import { canonicalizeForHash } from "@arbor/core";
import { lifecycleNarration } from "./narration.js";

export type OperatorEventSource = "canonical_session" | "devtools" | "userinput" | "taskcomposer" | "task" | "job" | "approval" | "agent" | "notification";
export type OperatorTruth = "canonical" | "supplemental" | "unavailable";
export type OperatorEventKind =
  | "agent_narrative"
  | "final_answer"
  | "tool"
  | "tool_result"
  | "permission_gate"
  | "cancellation"
  | "diagnostic"
  | "terminal"
  | "artifact"
  | "test"
  | "operator"
  | "work"
  | "status";
export type OperatorLifecycle = "pending" | "active" | "completed" | "failed" | "interrupted" | "observed" | "unknown";
export type OperatorImportance = "primary" | "attention" | "ordinary" | "supporting";
export type OperatorVisualFamily = "agent" | "tool" | "operator" | "attention" | "artifact" | "system";
export type OperatorVisualEmphasis = "primary" | "active" | "ordinary" | "muted" | "attention";
/**
 * A semantic silhouette is emitted only from a producer-owned discriminant.
 * `generic` deliberately remains the result for unrecognised tool names.
 */
export type OperatorEventForm = "generic" | "retry" | "file_read" | "file_write" | "patch_diff" | "search_results" | "shell_command" | "verification_result" | "session_notification";

export interface OperatorProjectionLimits {
  /** Maximum rows retained in the bounded document. */
  readonly max_rows: number;
  /** Maximum UTF-16 code units retained per externally supplied detail. */
  readonly max_detail_chars: number;
  /** Maximum attention rows exposed in the derived attention slice. */
  readonly max_attention: number;
  /** Maximum authoritative output-list records inspected for descriptor actions. */
  readonly max_output_records?: number;
}

export const DEFAULT_OPERATOR_PROJECTION_LIMITS: OperatorProjectionLimits = Object.freeze({
  max_rows: 2_000,
  max_detail_chars: 4_000,
  max_attention: 100,
  max_output_records: 200,
});

/** The one bounded policy for Console rendering and reducer live-edge state. */
export const CONSOLE_OPERATOR_PROJECTION_LIMITS: OperatorProjectionLimits = Object.freeze({
  max_rows: 200,
  // A final response is the operator's deliverable, not log detail. Keep a
  // firm memory bound, but make it large enough for a normal implementation
  // report or review instead of silently reducing every answer to 4 KB.
  max_detail_chars: 64_000,
  max_attention: 100,
  max_output_records: 200,
});

export interface OperatorProjectionInput {
  /** Canonical campaign tree used only for an exact root objective projection. */
  readonly campaign_tree?: unknown;
  readonly session_attach?: unknown;
  readonly session_list?: unknown;
  readonly selected_session_id?: string | null;
  /** Descriptor-only output.list projection; raw output stays outside this model. */
  readonly output_list?: unknown;
  readonly devtools_stream?: unknown;
  /** Durable user-input records; canonical, but independent from the session journal. */
  readonly userinput_projection?: unknown;
  /** Durable governed task-intake records; canonical, but independent from the session journal. */
  readonly taskcomposer_projection?: unknown;
  /** Canonical supervisor task cursor page, never a presentation-owned task store. */
  readonly task_projection?: unknown;
  /** Canonical scheduler queue projection; task state remains owned by the supervisor. */
  readonly job_projection?: unknown;
  /** Durable governed approval records. */
  readonly approval_projection?: unknown;
  /** Durable notification inbox records; not transient AppModel notices. */
  readonly notification_projection?: unknown;
  readonly viewport: { readonly columns: number; readonly rows: number };
  /** Injected by the composition layer; this pure function never reads a clock. */
  readonly now_ms: number;
  readonly limits?: OperatorProjectionLimits;
}

export interface EventCorrelation {
  readonly session_id: string | null;
  readonly campaign_id: string | null;
  readonly node_id: string | null;
  readonly operation_id: string | null;
  /**
   * A producer-supplied logical command group. This is correlation metadata,
   * not a UI-created task or lifecycle owner.
   */
  readonly command_group_id: string | null;
}

export interface EventAction {
  readonly id: string;
  readonly label: string;
  /** The view model can describe eligibility but never confers authority. */
  readonly enabled: boolean;
}

export interface EventVisualTreatment {
  readonly family: OperatorVisualFamily;
  readonly marker: string;
  readonly label: string;
  readonly emphasis: OperatorVisualEmphasis;
}

export interface RetryLinkView {
  /** Exact producer-supplied prior attempt identity; never inferred by sequence. */
  readonly previous_operation_id: string;
  /** Producer-supplied attempt number when available. */
  readonly attempt: number | null;
}

/**
 * Producer-backed failure facts. Nulls are intentional: the native session
 * protocol does not currently assert retry safety or whether later work will
 * continue after an individual operation failure.
 */
export interface FailurePresentation {
  readonly level: "operation" | "session";
  readonly classification: string;
  readonly stage: string | null;
  readonly effect: string | null;
  readonly retry_safe: boolean | null;
  readonly wider_task_running: boolean | null;
}

export interface CommandOutputView {
  /** Channel identity is retained when the canonical result exposes it. */
  readonly channel: "stdout" | "stderr" | "combined" | "unavailable";
  /** Number of bounded result-summary lines represented below. */
  readonly line_count: number;
  /**
   * Bounded lines from the canonical result summary. This is never a raw
   * output fetch; full output remains behind the descriptor action.
   */
  readonly lines: readonly string[];
}

export interface CommandPresentation {
  readonly role: "invocation" | "result";
  /** Exact producer identity; a missing ID is deliberately never inferred. */
  readonly canonical_operation_id: string | null;
  readonly group_id: string | null;
  readonly ordinal: number | null;
  readonly group_size: number | null;
  /** The opposite canonical row only when an exact operation ID matched. */
  readonly paired_event_id: string | null;
  readonly output: CommandOutputView | null;
}

export interface CommandGroupView {
  readonly id: string;
  readonly source: OperatorEventSource;
  readonly source_id: string;
  readonly command_count: number;
  readonly paired_count: number;
  readonly unpaired_count: number;
  readonly completed_count: number;
  readonly failed_count: number;
}

export interface EventView {
  readonly id: string;
  readonly kind: OperatorEventKind;
  /** Semantic form backed by an exact producer discriminant. */
  readonly form: OperatorEventForm;
  readonly event_kind: string;
  readonly actor: string;
  readonly parent_id: string | null;
  readonly correlation: EventCorrelation;
  readonly source: OperatorEventSource;
  /** Stable identity of the input feed, never a renderer-generated authority. */
  readonly source_id: string;
  readonly sequence: number | null;
  readonly occurred_at: string | null;
  readonly importance: OperatorImportance;
  readonly summary: string;
  readonly detail: string | null;
  /** Presentation-only command linkage derived from canonical identities. */
  readonly command: CommandPresentation | null;
  readonly retry: RetryLinkView | null;
  readonly failure: FailurePresentation | null;
  readonly actions: readonly EventAction[];
  readonly truth: OperatorTruth;
  readonly lifecycle: OperatorLifecycle;
  /** A later same-subject canonical advance makes this failure historical, never hidden. */
  readonly stale: boolean;
  readonly visual: EventVisualTreatment;
}

export interface ProjectionBounds {
  readonly input_rows: number;
  readonly retained_rows: number;
  readonly elided_rows: number;
  /** Exact canonical replay rows removed by stable session/sequence identity. */
  readonly deduplicated_rows: number;
  readonly input_detail_chars: number;
  readonly retained_detail_chars: number;
  readonly elided_detail_chars: number;
}

export interface FreshnessView {
  readonly evaluated_at_ms: number;
  /** Cross-source display is source-grouped, never claimed as one durable order. */
  readonly cross_source_order: "source_grouped";
  readonly canonical_rows: number;
  readonly supplemental_rows: number;
  readonly canonical_terminal_sessions: readonly string[];
}

export interface ObjectiveView {
  readonly summary: string;
  readonly correlation: EventCorrelation;
}

export interface OperationView {
  readonly event_id: string;
  readonly lifecycle: OperatorLifecycle;
  readonly correlation: EventCorrelation;
}

export interface SupervisedWorkView {
  /** Which canonical source is supervising this work. */
  readonly source: "session" | "task" | "job";
  /** Stable source-local identity; never a renderer-created task id. */
  readonly id: string;
  readonly session_id: string | null;
  readonly campaign_id: string | null;
  readonly node_id: string | null;
  readonly parent_id: string | null;
  readonly operation_id: string | null;
  readonly owner: string | null;
  readonly state: string;
  readonly lifecycle: OperatorLifecycle;
  readonly pending_steering: number;
}

export interface AttentionView {
  readonly event_id: string;
  readonly summary: string;
  readonly lifecycle: OperatorLifecycle;
}

export interface InspectorView {
  readonly event_id: string;
  readonly title: string;
  readonly lifecycle: OperatorLifecycle;
  readonly actor: string;
  readonly source: OperatorEventSource;
  readonly source_id: string;
  readonly correlation: EventCorrelation;
  readonly detail: string | null;
  readonly failure: FailurePresentation | null;
}

export interface OperatorViewModel {
  readonly objective: ObjectiveView | null;
  readonly foreground: OperationView | null;
  readonly background: readonly SupervisedWorkView[];
  readonly document: readonly EventView[];
  /** Bounded collation receipts; never a command or lifecycle authority. */
  readonly command_groups: readonly CommandGroupView[];
  readonly attention: readonly AttentionView[];
  /** Highest-precedence actionable attention fact, never a generated lifecycle. */
  readonly selected_attention: AttentionView | null;
  readonly inspector: InspectorView | null;
  readonly bounds: ProjectionBounds;
  readonly freshness: FreshnessView;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

interface DetailValue {
  readonly value: string | null;
  readonly input_chars: number;
  readonly retained_chars: number;
  readonly elided_chars: number;
}

interface ParseState {
  readonly limits: ValidatedOperatorProjectionLimits;
  /** Per-row detail receipts let the final bounded document report only visible detail as retained. */
  readonly detail_by_event_id: Map<string, DetailValue>;
  readonly terminal_by_session: Map<string, OperatorLifecycle>;
  deduplicated_rows: number;
}

interface ValidatedOperatorProjectionLimits {
  readonly max_rows: number;
  readonly max_detail_chars: number;
  readonly max_attention: number;
  readonly max_output_records: number;
}

interface OutputDescriptorCandidate {
  readonly evidence_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly operation_id: string;
  /** Only compared when the producer actually exposes a session identity. */
  readonly session_id: string | null;
}

const OUTPUT_DESCRIPTOR_ID = /^out_[a-f0-9]{64}$/;
const MAX_OUTPUT_DESCRIPTOR_ACTIONS_PER_EVENT = 8;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the exact Console document input from its RuntimePort-owned composite.
 * Rendering and reducer live-edge state share this construction so a durable
 * row cannot be visible while being absent from its anchor/unseen accounting.
 */
export function consoleOperatorProjectionInput(
  surface: unknown,
  context: Pick<OperatorProjectionInput, "viewport" | "now_ms">,
): OperatorProjectionInput | null {
  if (!record(surface)) return null;
  const selected = surface.selected_session_id;
  return Object.freeze({
    campaign_tree: surface.tree,
    session_attach: surface.session_attach,
    session_list: surface.sessions,
    selected_session_id: typeof selected === "string" || selected === null ? selected : undefined,
    output_list: surface.output_list,
    devtools_stream: surface.devtools,
    userinput_projection: surface.operator_interviews,
    taskcomposer_projection: surface.drafts,
    task_projection: surface.tasks,
    job_projection: surface.jobs,
    approval_projection: surface.approvals,
    notification_projection: record(surface.product_operations) ? surface.product_operations.notifications : undefined,
    viewport: context.viewport,
    now_ms: context.now_ms,
    limits: CONSOLE_OPERATOR_PROJECTION_LIMITS,
  });
}

function objectiveFromTree(value: unknown): ObjectiveView | null {
  if (!record(value) || !Array.isArray(value.nodes)) return null;
  const root = value.nodes.find((candidate) => record(candidate) && candidate.parent_id === null);
  if (!record(root)) return null;
  const nodeId = nonEmpty(root.id);
  const objective = nonEmpty(root.action_description) ?? nonEmpty(root.label);
  if (nodeId === null || objective === null) return null;
  return Object.freeze({
    summary: objective,
    correlation: Object.freeze({
      session_id: null,
      campaign_id: nonEmpty(root.campaign_id) ?? nonEmpty(value.campaign_id),
      node_id: nodeId,
      operation_id: nonEmpty(root.operation_id),
      command_group_id: null,
    }),
  });
}

function inspectableEvent(document: readonly EventView[], selectedAttention: AttentionView | null, foreground: EventView | null): InspectorView | null {
  const selected = selectedAttention === null ? null : document.find((row) => row.id === selectedAttention.event_id) ?? null;
  const row = selected ?? foreground ?? [...document].reverse().find((candidate) => candidate.truth === "canonical") ?? null;
  return row === null ? null : Object.freeze({
    event_id: row.id,
    // Diagnostics conventionally carry a terse machine code in `summary`
    // and the operator-facing explanation in `detail`. The inspector leads
    // with the explanation while retaining the exact code on the event row.
    title: row.kind === "diagnostic" && row.detail !== null ? row.detail : row.summary,
    lifecycle: row.lifecycle,
    actor: row.actor,
    source: row.source,
    source_id: row.source_id,
    correlation: row.correlation,
    detail: row.detail,
    failure: row.failure,
  });
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedText(value: unknown, maximum: number): DetailValue {
  const text = typeof value === "string" ? value : null;
  if (text === null || text.length === 0) return { value: null, input_chars: 0, retained_chars: 0, elided_chars: 0 };
  if (text.length <= maximum) return { value: text, input_chars: text.length, retained_chars: text.length, elided_chars: 0 };
  const retained = maximum === 1 ? "…" : `${text.slice(0, maximum - 1)}…`;
  return { value: retained, input_chars: text.length, retained_chars: retained.length, elided_chars: text.length - retained.length };
}

function detail(state: ParseState, value: unknown): DetailValue {
  return boundedText(value, state.limits.max_detail_chars);
}

function summary(state: ParseState, value: unknown, fallback: string): string {
  return boundedText(value, state.limits.max_detail_chars).value ?? fallback;
}

function valueAt(recordValue: UnknownRecord, payload: UnknownRecord | null, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const direct = nonEmpty(recordValue[key]);
    if (direct !== null) return direct;
    const nested = payload === null ? null : nonEmpty(payload[key]);
    if (nested !== null) return nested;
  }
  return null;
}

function correlation(event: UnknownRecord, payload: UnknownRecord | null, attached: UnknownRecord | null): EventCorrelation {
  return Object.freeze({
    session_id: valueAt(event, payload, "session_id") ?? (attached === null ? null : nonEmpty(attached.session_id)),
    campaign_id: valueAt(event, payload, "campaign_id") ?? (attached === null ? null : nonEmpty(attached.campaign_id)),
    node_id: valueAt(event, payload, "node_id") ?? (attached === null ? null : nonEmpty(attached.node_id)),
    operation_id: valueAt(event, payload, "operation_id") ?? (attached === null ? null : nonEmpty(attached.operation_id)),
    command_group_id: valueAt(event, payload, "command_group_id"),
  });
}

function visual(kind: OperatorEventKind, lifecycle: OperatorLifecycle): EventVisualTreatment {
  const attention = lifecycle === "failed" || lifecycle === "interrupted" || kind === "permission_gate" || kind === "diagnostic";
  const family: OperatorVisualFamily = kind === "agent_narrative" || kind === "final_answer"
    ? "agent"
    : kind === "tool" || kind === "tool_result" || kind === "test"
      ? "tool"
    : kind === "permission_gate" || kind === "cancellation" || kind === "operator"
        ? "operator"
        : kind === "artifact"
          ? "artifact"
          : attention ? "attention" : "system";
  const marker = lifecycle === "failed" ? "!" : lifecycle === "interrupted" ? "×" : lifecycle === "completed" ? "✓" : lifecycle === "active" ? "•" : kind === "permission_gate" ? "?" : "·";
  const label = lifecycle === "failed" ? "failed" : lifecycle === "interrupted" ? "interrupted" : lifecycle === "completed" ? "completed" : lifecycle === "active" ? "active" : kind.replaceAll("_", " ");
  const emphasis: OperatorVisualEmphasis = lifecycle === "active" ? "active" : attention ? "attention" : kind === "final_answer" ? "primary" : "ordinary";
  return Object.freeze({ family, marker, label, emphasis });
}

function eventView(input: Omit<EventView, "actions" | "visual" | "command" | "retry" | "failure" | "stale" | "form"> & { readonly form?: OperatorEventForm; readonly failure?: FailurePresentation | null }): EventView {
  return Object.freeze({ ...input, form: input.form ?? "generic", command: null, retry: null, failure: input.failure ?? null, actions: Object.freeze([]), stale: false, visual: visual(input.kind, input.lifecycle) });
}

function outputCorrelationKey(campaignId: string, nodeId: string, operationId: string): string {
  // JSON keeps the tuple unambiguous even when an externally supplied ID
  // contains delimiter-like characters.
  return JSON.stringify([campaignId, nodeId, operationId]);
}

/**
 * Read only the bounded descriptor metadata that `output.list` exposes. This
 * deliberately rejects corrupt/unknown rows and never reads preview/content
 * fields, so a projection action cannot turn raw output into transcript data.
 */
function outputDescriptorCandidates(input: unknown, maximum: number): ReadonlyMap<string, readonly OutputDescriptorCandidate[]> {
  if (!Array.isArray(input)) return new Map();
  const byCorrelation = new Map<string, OutputDescriptorCandidate[]>();
  for (const raw of input.slice(0, maximum)) {
    if (!record(raw) || (raw.status !== "ok" && raw.status !== "in_progress") || !record(raw.record)) continue;
    const source = raw.record;
    const evidenceId = nonEmpty(source.id);
    const campaignId = nonEmpty(source.campaign_id);
    const nodeId = nonEmpty(source.node_id);
    const operationId = nonEmpty(source.operation_id);
    if (evidenceId === null || !OUTPUT_DESCRIPTOR_ID.test(evidenceId) || campaignId === null || nodeId === null || operationId === null) continue;
    const candidate: OutputDescriptorCandidate = Object.freeze({
      evidence_id: evidenceId,
      campaign_id: campaignId,
      node_id: nodeId,
      operation_id: operationId,
      session_id: valueAt(raw, source, "session_id"),
    });
    const key = outputCorrelationKey(campaignId, nodeId, operationId);
    const existing = byCorrelation.get(key);
    if (existing === undefined) byCorrelation.set(key, [candidate]);
    else existing.push(candidate);
  }
  return byCorrelation;
}

function outputDescriptorActions(
  row: EventView,
  candidates: ReadonlyMap<string, readonly OutputDescriptorCandidate[]>,
): readonly EventAction[] {
  const { campaign_id: campaignId, node_id: nodeId, operation_id: operationId, session_id: sessionId } = row.correlation;
  if (campaignId === null || nodeId === null || operationId === null) return Object.freeze([]);
  const matched = candidates.get(outputCorrelationKey(campaignId, nodeId, operationId));
  if (matched === undefined) return Object.freeze([]);
  const actions: EventAction[] = [];
  const seen = new Set<string>();
  for (const candidate of matched) {
    // A session identity is not present on persisted descriptors. When it is
    // present (for a future/alternate producer), require it exactly rather
    // than letting a campaign/node/operation match cross a session boundary.
    if (candidate.session_id !== null && candidate.session_id !== sessionId) continue;
    if (seen.has(candidate.evidence_id)) continue;
    seen.add(candidate.evidence_id);
    actions.push(Object.freeze({
      id: `output.descriptor:${candidate.evidence_id}`,
      label: "Inspect output descriptor",
      enabled: true,
    }));
    if (actions.length === MAX_OUTPUT_DESCRIPTOR_ACTIONS_PER_EVENT) break;
  }
  return Object.freeze(actions);
}

function withOutputDescriptorActions(
  rows: readonly EventView[],
  candidates: ReadonlyMap<string, readonly OutputDescriptorCandidate[]>,
): EventView[] {
  return rows.map((row) => {
    const actions = outputDescriptorActions(row, candidates);
    return actions.length === 0 ? row : Object.freeze({ ...row, actions });
  });
}

function diagnostic(
  state: ParseState,
  source: OperatorEventSource,
  sourceId: string,
  id: string,
  message: string,
  correlationValue: EventCorrelation = EMPTY_CORRELATION,
  sequence: number | null = null,
): EventView {
  return eventView({
    id,
    kind: "diagnostic",
    event_kind: "malformed_projection",
    actor: "system",
    parent_id: null,
    correlation: correlationValue,
    source,
    source_id: sourceId,
    sequence,
    occurred_at: null,
    importance: "attention",
    summary: summary(state, message, "malformed projection"),
    detail: null,
    truth: "unavailable",
    lifecycle: "unknown",
  });
}

const EMPTY_CORRELATION: EventCorrelation = Object.freeze({ session_id: null, campaign_id: null, node_id: null, operation_id: null, command_group_id: null });

function canonicalKind(eventKind: string, payload: UnknownRecord | null): OperatorEventKind {
  if (eventKind === "model_text") return nonEmpty(payload?.phase) === "final" ? "final_answer" : "agent_narrative";
  if (eventKind === "tool_intent") return "tool";
  if (eventKind === "tool_result") return "tool_result";
  if (eventKind === "approval_requested" || eventKind === "approval_resolved") return "permission_gate";
  if (eventKind === "interview_question" || eventKind === "userinput.question" || eventKind === "human_input_question") return "permission_gate";
  if (eventKind === "interview_answer" || eventKind === "userinput.answer" || eventKind === "human_input_answer") return "operator";
  if (eventKind === "interrupt_requested") return "cancellation";
  if (eventKind === "diagnostic") return "diagnostic";
  if (eventKind === "terminal") return "terminal";
  if (eventKind === "artifact") return "artifact";
  return "status";
}

function terminalLifecycle(payload: UnknownRecord | null): OperatorLifecycle | null {
  const state = nonEmpty(payload?.state);
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  if (state === "interrupted") return "interrupted";
  return null;
}

function outputChannel(payload: UnknownRecord | null): "stdout" | "stderr" | null {
  const channel = nonEmpty(payload?.channel);
  return channel === "stdout" || channel === "stderr" ? channel : null;
}

/** Maps only exact native tool identifiers; descriptions and free text are not classification input. */
function toolForm(payload: UnknownRecord | null): OperatorEventForm {
  switch (nonEmpty(payload?.tool)) {
    case "file.read": return "file_read";
    case "file.write": return "file_write";
    case "file.patch":
    case "git.diff": return "patch_diff";
    case "repository.search": return "search_results";
    case "shell.execute":
    case "shell.poll":
    case "shell.stop": return "shell_command";
    default: return "generic";
  }
}

function canonicalForm(eventKind: string, payload: UnknownRecord): OperatorEventForm {
  if (eventKind === "tool_intent" || eventKind === "tool_result") {
    if (nonEmpty(payload.retry_of) !== null) return "retry";
    if (nonEmpty(payload.tool) === "verification.run") return eventKind === "tool_result" ? "verification_result" : "shell_command";
    return toolForm(payload);
  }
  return "generic";
}

function eventSummary(state: ParseState, kind: string, payload: UnknownRecord | null): string {
  if (kind === "model_text") return summary(state, payload?.text, "assistant response");
  if (kind === "tool_intent") {
    const attempt = safeInteger(payload?.attempt);
    return `${nonEmpty(payload?.retry_of) === null ? "tool" : "retry"}: ${summary(state, payload?.tool, "unknown")}${attempt === null ? "" : ` (attempt ${attempt})`}`;
  }
  if (kind === "tool_result") return `${outputChannel(payload) ?? "tool result"}: ${summary(state, payload?.tool, "unknown")}`;
  if (kind === "approval_requested") return "approval requested";
  if (kind === "approval_resolved") return payload?.approved === true ? "approval granted" : payload?.approved === false ? "approval denied" : "approval resolved";
  if (kind === "interview_question" || kind === "userinput.question" || kind === "human_input_question") return summary(state, payload?.question ?? payload?.text, "operator input requested");
  if (kind === "interview_answer" || kind === "userinput.answer" || kind === "human_input_answer") return summary(state, payload?.answer ?? payload?.text ?? payload?.response, "answer recorded");
  if (kind === "interrupt_requested") return "interrupt requested";
  if (kind === "terminal") return `session ${summary(state, payload?.state, "ended")}`;
  if (kind === "artifact") return `artifact: ${summary(state, payload?.artifact_id, "recorded")}`;
  if (kind === "model_route") return `model route: ${summary(state, payload?.route, "unavailable")}`;
  if (kind === "diagnostic") return summary(state, payload?.code, "diagnostic");
  if (kind === "lifecycle") return `session ${summary(state, payload?.state, "updated")}`;
  return kind;
}

function eventDetail(state: ParseState, kind: string, payload: UnknownRecord | null): DetailValue {
  if (kind === "diagnostic" && payload?.code === "model_retry" && record(payload.retry)) {
    const r = payload.retry;
    if (typeof r.attempt === "number" && Number.isSafeInteger(r.attempt) && r.attempt > 0
      && typeof r.max_attempts === "number" && Number.isSafeInteger(r.max_attempts) && r.max_attempts > r.attempt
      && typeof r.delay_ms === "number" && Number.isSafeInteger(r.delay_ms) && r.delay_ms >= 0
      && typeof r.failure_kind === "string" && ["timeout", "transport", "http", "protocol", "credential", "unknown"].includes(r.failure_kind)) {
      return detail(state, `Attempt ${r.attempt}/${r.max_attempts} failed (${r.failure_kind}); retrying in ${r.delay_ms} ms.`);
    }
  }
  // The journal's typed, already-redacted terminal provider reason; the
  // raw diagnostic message never reaches this projection.
  if (kind === "diagnostic" && record(payload?.provider_failure)) {
    const p = payload.provider_failure;
    const errorClass = nonEmpty(p.error_class);
    const failureKind = nonEmpty(p.failure_kind);
    if (errorClass !== null && failureKind !== null) {
      const status = typeof p.http_status === "number" && Number.isSafeInteger(p.http_status) ? ` HTTP ${p.http_status}` : "";
      const code = nonEmpty(p.provider_code);
      const message = nonEmpty(p.message);
      return detail(state, `${errorClass} (${failureKind})${status}${code === null ? "" : ` ${code}`}${message === null ? "" : `: ${message}`}`);
    }
  }
  if (kind === "model_text") return detail(state, payload?.phase);
  if (kind === "tool_intent") {
    const input = nonEmpty(payload?.input_summary);
    const retryOf = nonEmpty(payload?.retry_of);
    return detail(state, [input, retryOf === null ? null : `retry of ${retryOf}`].filter((part): part is string => part !== null).join(" · "));
  }
  if (kind === "tool_result") return detail(state, payload?.result_summary);
  if (kind === "approval_requested") return detail(state, payload?.subject);
  if (kind === "approval_resolved") return detail(state, payload?.rationale);
  if (kind === "interview_question" || kind === "userinput.question" || kind === "human_input_question") return detail(state, payload?.reason);
  if (kind === "interview_answer" || kind === "userinput.answer" || kind === "human_input_answer") return detail(state, payload?.answered_by);
  if (kind === "model_route") {
    const provider = nonEmpty(payload?.provider_id);
    const model = nonEmpty(payload?.model_id);
    return detail(state, provider === null && model === null ? null : `${provider ?? "unknown"}/${model ?? "unknown"}`);
  }
  if (kind === "interrupt_requested" || kind === "terminal" || kind === "diagnostic") return detail(state, payload?.message ?? payload?.reason);
  return { value: null, input_chars: 0, retained_chars: 0, elided_chars: 0 };
}

function canonicalLifecycle(eventKind: string, payload: UnknownRecord, terminal: OperatorLifecycle | null): OperatorLifecycle {
  if (terminal !== null) return terminal;
  if (eventKind === "lifecycle" && nonEmpty(payload.state) === "started") return "active";
  if (eventKind === "tool_intent" || eventKind === "approval_requested" || eventKind === "interrupt_requested") return eventKind === "tool_intent" ? "active" : "pending";
  if (eventKind === "tool_result") return payload.ok === false || payload.success === false || nonEmpty(payload.error) !== null ? "failed" : "completed";
  if (eventKind === "approval_resolved") return "completed";
  if (eventKind === "interview_question" || eventKind === "userinput.question" || eventKind === "human_input_question") return "pending";
  if (eventKind === "interview_answer" || eventKind === "userinput.answer" || eventKind === "human_input_answer") return "completed";
  return "observed";
}

function canonicalFailure(eventKind: string, payload: UnknownRecord, lifecycle: OperatorLifecycle): FailurePresentation | null {
  if (eventKind === "terminal" && (lifecycle === "failed" || lifecycle === "interrupted")) {
    return Object.freeze({
      level: "session",
      classification: nonEmpty(payload.cause) ?? lifecycle,
      stage: "terminal",
      effect: null,
      retry_safe: null,
      wider_task_running: false,
    });
  }
  if (eventKind !== "tool_result" || lifecycle !== "failed") return null;
  const evidence = record(payload.evidence) ? payload.evidence : null;
  return Object.freeze({
    level: "operation",
    classification: nonEmpty(evidence?.code) ?? nonEmpty(payload.error) ?? "tool_failed",
    stage: nonEmpty(evidence?.stage),
    effect: nonEmpty(evidence?.effect),
    retry_safe: null,
    wider_task_running: null,
  });
}

function canonicalRows(input: unknown, state: ParseState): EventView[] {
  // No selected/attached session is an ordinary Console state (fresh launch,
  // planning before the first worker, or a completed campaign returned to
  // new-task intake).  Only a present malformed value is diagnostic.
  if (input === undefined || input === null) return [];
  if (!record(input)) return [diagnostic(state, "canonical_session", "unknown", "canonical:attach", "session_attach is not an object")];
  const attached = record(input.session) ? input.session : null;
  const sourceId = nonEmpty(attached?.session_id) ?? "unknown";
  if (!Array.isArray(input.events)) return [diagnostic(state, "canonical_session", sourceId, `canonical:${sourceId}:attach`, "session_attach.events is not an array")];

  // Fold lifecycle only after the source's stable sequence order is known.
  // An arrival-order fold would let an out-of-order terminal corrupt an earlier
  // canonical event into a false "after terminal" diagnostic.
  const ordered = input.events
    .map((raw, index) => ({ raw, index, sequence: record(raw) ? safeInteger(raw.sequence) : null }))
    .sort((left, right) => (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) || left.index - right.index);
  const parsed: Array<{ readonly row: EventView; readonly index: number }> = [];
  const seenSequences = new Map<string, string>();
  for (const { raw, index } of ordered) {
    if (!record(raw)) {
      parsed.push({ row: diagnostic(state, "canonical_session", sourceId, `canonical:${sourceId}:malformed:${index}`, "session event is not an object"), index });
      continue;
    }
    const eventKind = nonEmpty(raw.kind);
    const payload = record(raw.payload) ? raw.payload : null;
    const correlationValue = correlation(raw, payload, attached);
    const eventSourceId = correlationValue.session_id ?? sourceId;
    const sequence = safeInteger(raw.sequence);
    if (eventKind === null || payload === null) {
      parsed.push({
        row: diagnostic(state, "canonical_session", eventSourceId, `canonical:${eventSourceId}:malformed:${index}`, eventKind === null ? "session event kind is missing" : "session event payload is not an object", correlationValue, sequence),
        index,
      });
      continue;
    }
    if (sequence !== null) {
      const replayKey = `${eventSourceId}\u0000${sequence}`;
      const canonicalRaw = canonicalizeForHash(raw);
      const previous = seenSequences.get(replayKey);
      if (previous === canonicalRaw) {
        state.deduplicated_rows += 1;
        continue;
      }
      if (previous !== undefined) {
        parsed.push({
          row: diagnostic(state, "canonical_session", eventSourceId, `canonical:${eventSourceId}:replay-conflict:${index}`, `conflicting replay for canonical sequence ${sequence}`, correlationValue, sequence),
          index,
        });
        continue;
      }
      seenSequences.set(replayKey, canonicalRaw);
    }
    const knownTerminal = correlationValue.session_id === null ? undefined : state.terminal_by_session.get(correlationValue.session_id);
    const isTerminal = eventKind === "terminal";
    const terminal = isTerminal ? terminalLifecycle(payload) : null;
    if (knownTerminal !== undefined) {
      parsed.push({
        row: diagnostic(state, "canonical_session", eventSourceId, `canonical:${eventSourceId}:after-terminal:${index}`, "event received after canonical terminal state", correlationValue, sequence),
        index,
      });
      continue;
    }
    if (isTerminal && terminal === null) {
      parsed.push({
        row: diagnostic(state, "canonical_session", eventSourceId, `canonical:${eventSourceId}:malformed-terminal:${index}`, "terminal event has no recognized terminal state", correlationValue, sequence),
        index,
      });
      continue;
    }
    const lifecycle = canonicalLifecycle(eventKind, payload, terminal);
    if (terminal !== null && correlationValue.session_id !== null) state.terminal_by_session.set(correlationValue.session_id, terminal);
    const kind = canonicalKind(eventKind, payload);
    const actor = valueAt(raw, payload, "actor", "agent", "producer") ?? (kind === "agent_narrative" || kind === "final_answer" ? "assistant" : kind === "tool" || kind === "tool_result" ? `tool:${nonEmpty(payload.tool) ?? "unknown"}` : "system");
    const importance: OperatorImportance = lifecycle === "failed" || lifecycle === "interrupted" || kind === "permission_gate" || kind === "diagnostic" ? "attention" : kind === "final_answer" ? "primary" : "ordinary";
    const detailValue = eventDetail(state, eventKind, payload);
    let row = eventView({
        id: `canonical:${eventSourceId}:${sequence ?? index}`,
        kind,
        form: canonicalForm(eventKind, payload),
        event_kind: eventKind,
        actor,
        parent_id: valueAt(raw, payload, "parent_id", "parent_operation_id", "parent_event_id"),
        correlation: correlationValue,
        source: "canonical_session",
        source_id: eventSourceId,
        sequence,
        occurred_at: nonEmpty(raw.occurred_at),
        importance,
        summary: eventSummary(state, eventKind, payload),
        detail: detailValue.value,
        truth: "canonical",
        lifecycle,
        failure: canonicalFailure(eventKind, payload, lifecycle),
      });
    const retryOf = nonEmpty(payload.retry_of);
    if (retryOf !== null) {
      row = Object.freeze({ ...row, retry: Object.freeze({ previous_operation_id: retryOf, attempt: safeInteger(payload.attempt) }) });
    }
    state.detail_by_event_id.set(row.id, detailValue);
    parsed.push({ row, index });
  }
  return parsed.sort((left, right) => (left.row.sequence ?? Number.MAX_SAFE_INTEGER) - (right.row.sequence ?? Number.MAX_SAFE_INTEGER) || left.index - right.index).map((item) => item.row);
}

function commandName(row: EventView): string {
  return row.actor.startsWith("tool:") ? row.actor.slice("tool:".length) : row.actor;
}

function outputView(row: EventView): CommandOutputView | null {
  if (row.kind !== "tool_result" || row.detail === null) return null;
  const lines = row.detail.split("\n");
  const channel = row.summary.startsWith("stdout:") ? "stdout"
    : row.summary.startsWith("stderr:") ? "stderr"
      : "combined";
  return Object.freeze({ channel, line_count: lines.length, lines: Object.freeze([...lines]) });
}

interface CommandPair {
  readonly invocation: EventView | null;
  readonly result: EventView | null;
  readonly invocation_count: number;
  readonly result_count: number;
}

/**
 * Derive display linkage solely from an exact canonical operation identity.
 * Sequence adjacency, matching tool names, and timing are intentionally not
 * sufficient: those heuristics would turn the frontend into a lifecycle
 * authority and could falsely join concurrent commands.
 */
function collateCanonicalCommands(rows: readonly EventView[]): readonly EventView[] {
  const pairs = new Map<string, { invocation: EventView | null; result: EventView | null; invocation_count: number; result_count: number }>();
  for (const row of rows) {
    if (row.source !== "canonical_session" || (row.kind !== "tool" && row.kind !== "tool_result")) continue;
    const operationId = row.correlation.operation_id;
    if (operationId === null) continue;
    const pairKey = `${row.source_id}\u0000${operationId}`;
    const existing = pairs.get(pairKey) ?? { invocation: null, result: null, invocation_count: 0, result_count: 0 };
    // Multiple results/invocations for one identity are ambiguous. Preserve
    // all source rows but refuse a pairing rather than selecting one by order.
    if (row.kind === "tool") {
      existing.invocation_count += 1;
      if (existing.invocation_count === 1) existing.invocation = row;
    } else {
      existing.result_count += 1;
      if (existing.result_count === 1) existing.result = row;
    }
    pairs.set(pairKey, existing);
  }

  const groups = new Map<string, EventView[]>();
  for (const row of rows) {
    if (row.source !== "canonical_session" || (row.kind !== "tool" && row.kind !== "tool_result")) continue;
    const groupId = row.correlation.command_group_id;
    if (groupId === null) continue;
    const groupKey = `${row.source_id}\u0000${groupId}`;
    const existing = groups.get(groupKey);
    if (existing === undefined) groups.set(groupKey, [row]);
    else existing.push(row);
  }
  const groupOrders = new Map<string, readonly string[]>();
  for (const [groupKey, groupRows] of groups) {
    const operationIds = [...new Set(groupRows
      .filter((row) => row.kind === "tool")
      .map((row) => row.correlation.operation_id)
      .filter((value): value is string => value !== null))];
    groupOrders.set(groupKey, Object.freeze(operationIds));
  }

  return rows.map((row) => {
    if (row.source !== "canonical_session" || (row.kind !== "tool" && row.kind !== "tool_result")) return row;
    const operationId = row.correlation.operation_id;
    const pair: CommandPair | null = operationId === null ? null : pairs.get(`${row.source_id}\u0000${operationId}`) ?? null;
    const paired = pair !== null && pair.invocation !== null && pair.result !== null
      && pair.invocation_count === 1 && pair.result_count === 1;
    const groupId = row.correlation.command_group_id;
    const groupOrder = groupId === null ? undefined : groupOrders.get(`${row.source_id}\u0000${groupId}`);
    const ordinal = operationId === null || groupOrder === undefined ? null : groupOrder.indexOf(operationId) + 1;
    const groupSize = groupOrder?.length ?? null;
    const command: CommandPresentation = Object.freeze({
      role: row.kind === "tool" ? "invocation" : "result",
      canonical_operation_id: operationId,
      group_id: groupId,
      ordinal: ordinal === 0 ? null : ordinal,
      group_size: groupSize,
      paired_event_id: !paired ? null : row.kind === "tool" ? pair!.result!.id : pair!.invocation!.id,
      output: row.kind === "tool_result" ? outputView(row) : null,
    });
    let summary = row.summary;
    if (row.kind === "tool_result" && command.output !== null && command.output.line_count > 1) {
      // Put the output cardinality first: the current table renderer has a
      // deliberately narrow summary column, so the operator can still see
      // that this is a multiline result before opening its bounded detail.
      summary = `${command.output.line_count} lines · ${command.output.channel} · result: ${commandName(row)}`;
    }
    if (ordinal !== null && groupSize !== null) {
      summary = row.kind === "tool"
        ? `${ordinal}/${groupSize} command: ${commandName(row)}`
        : `${ordinal}/${groupSize} done: ${commandName(row)}`;
    }
    return Object.freeze({ ...row, summary, command });
  });
}

function commandGroups(rows: readonly EventView[]): readonly CommandGroupView[] {
  const grouped = new Map<string, EventView[]>();
  for (const row of rows) {
    const command = row.command;
    if (command?.group_id === null || command === null || row.source !== "canonical_session") continue;
    const groupKey = `${row.source_id}\u0000${command.group_id}`;
    const existing = grouped.get(groupKey);
    if (existing === undefined) grouped.set(groupKey, [row]);
    else existing.push(row);
  }
  return Object.freeze([...grouped.values()].map((groupRows) => {
    const invocations = groupRows.filter((row) => row.command?.role === "invocation");
    const results = groupRows.filter((row) => row.command?.role === "result");
    const paired = invocations.filter((row) => row.command?.paired_event_id !== null);
    return Object.freeze({
      id: groupRows[0]!.command!.group_id!,
      source: "canonical_session" as const,
      source_id: groupRows[0]!.source_id,
      command_count: invocations.length,
      paired_count: paired.length,
      unpaired_count: invocations.length - paired.length + results.filter((row) => row.command?.paired_event_id === null).length,
      completed_count: results.filter((row) => row.lifecycle === "completed").length,
      failed_count: results.filter((row) => row.lifecycle === "failed").length,
    });
  }));
}

function durableCorrelation(value: UnknownRecord, projection: UnknownRecord, sessionId: string | null = null): EventCorrelation {
  return Object.freeze({
    session_id: sessionId,
    campaign_id: nonEmpty(value.campaign_id) ?? nonEmpty(projection.campaign_id),
    node_id: nonEmpty(value.node_id) ?? nonEmpty(projection.node_id),
    operation_id: nonEmpty(value.operation_id),
    command_group_id: null,
  });
}

/**
 * Shared presentation mapping for supervisor/scheduler state.  It only
 * classifies the exact producer state; it never turns a progress value or an
 * elapsed clock into a lifecycle transition.
 */
export function operatorWorkLifecycle(state: unknown): OperatorLifecycle {
  switch (nonEmpty(state)) {
    case "accepted":
    case "queued":
    case "awaiting_clarification":
    case "proposed":
    case "pending":
    case "blocked":
      return "pending";
    case "started":
    case "running":
    case "active":
    case "retrying":
    case "planning":
    case "cancel_requested":
      return "active";
    case "completed":
    case "admitted":
    case "approved":
      return "completed";
    case "cancelled":
    case "interrupted":
    case "expired":
      return "interrupted";
    case "failed":
    case "timed_out":
    case "rejected":
      return "failed";
    default:
      return "observed";
  }
}

/** Exact state text is kept visible; this only removes implementation punctuation. */
export function operatorStateLabel(state: unknown, fallback = "state unavailable"): string {
  return (nonEmpty(state) ?? fallback).replaceAll("_", " ");
}

function workImportance(lifecycle: OperatorLifecycle): OperatorImportance {
  return lifecycle === "failed" || lifecycle === "interrupted" || lifecycle === "pending" ? "attention" : lifecycle === "active" ? "primary" : "supporting";
}

function taskRows(input: unknown, state: ParseState): EventView[] {
  if (input === undefined) return [];
  if (!record(input)) return [diagnostic(state, "task", "runtime:task.list", "task:projection", "task projection is not an object")];
  const items = Array.isArray(input.items) ? input.items : Array.isArray(input.tasks) ? input.tasks : [];
  const rows: EventView[] = [];
  for (const [index, raw] of items.entries()) {
    if (!record(raw)) continue;
    const taskId = nonEmpty(raw.id);
    if (taskId === null) continue;
    const lifecycle = operatorWorkLifecycle(raw.state);
    const owner = nonEmpty(raw.owner_scope_id) ?? "owner unavailable";
    const operationId = nonEmpty(raw.operation_id);
    const parentId = nonEmpty(raw.parent_id);
    const retry = safeInteger(raw.retry_attempt);
    const cleanup = nonEmpty(raw.cleanup);
    const progress = typeof raw.progress === "number" && Number.isFinite(raw.progress) ? `${Math.round(raw.progress * 100)}%` : null;
    const detailValue = detail(state, [
      `owner ${owner}`,
      operationId === null ? null : `operation ${operationId}`,
      parentId === null ? null : `parent ${parentId}`,
      retry === null || retry === 0 ? null : `retry attempt ${retry}`,
      progress === null ? null : `progress ${progress}`,
      cleanup === null ? null : `cleanup ${operatorStateLabel(cleanup)}`,
      "plan dependencies unavailable from task.list",
    ].filter((value): value is string => value !== null).join(" · "));
    const row = eventView({
      id: `task:${taskId}:${index}`, kind: "work", event_kind: "task.lifecycle", actor: owner, parent_id: parentId,
      correlation: Object.freeze({ session_id: null, campaign_id: nonEmpty(raw.campaign_id) ?? nonEmpty(input.campaign_id), node_id: nonEmpty(raw.node_id) ?? nonEmpty(input.node_id), operation_id: operationId, command_group_id: null }),
      source: "task", source_id: taskId, sequence: null, occurred_at: nonEmpty(raw.started_at), importance: workImportance(lifecycle),
      summary: `task ${operatorStateLabel(raw.state)}: ${nonEmpty(raw.kind) ?? taskId}`, detail: detailValue.value, truth: "canonical", lifecycle,
    });
    state.detail_by_event_id.set(row.id, detailValue);
    rows.push(row);
  }
  return rows;
}

function jobRows(input: unknown, state: ParseState): EventView[] {
  if (input === undefined) return [];
  if (!record(input)) return [diagnostic(state, "job", "runtime:job.list", "job:projection", "job projection is not an object")];
  if (!Array.isArray(input.jobs)) return [];
  const rows: EventView[] = [];
  for (const [index, raw] of input.jobs.entries()) {
    if (!record(raw)) continue;
    const jobId = nonEmpty(raw.id);
    if (jobId === null) continue;
    const lifecycle = operatorWorkLifecycle(raw.state);
    const owner = nonEmpty(raw.owner_scope_id) ?? "owner unavailable";
    const operationId = nonEmpty(raw.operation_id);
    const progress = typeof raw.progress === "number" && Number.isFinite(raw.progress) ? `${Math.round(raw.progress * 100)}%` : null;
    const detailValue = detail(state, [`owner ${owner}`, operationId === null ? null : `operation ${operationId}`, progress === null ? null : `progress ${progress}`].filter((value): value is string => value !== null).join(" · "));
    const row = eventView({
      id: `job:${jobId}:${index}`, kind: "work", event_kind: "job.lifecycle", actor: owner, parent_id: operationId,
      correlation: Object.freeze({ session_id: null, campaign_id: nonEmpty(raw.campaign_id) ?? nonEmpty(input.campaign_id), node_id: nonEmpty(raw.node_id) ?? nonEmpty(input.node_id), operation_id: operationId, command_group_id: null }),
      source: "job", source_id: jobId, sequence: null, occurred_at: null, importance: workImportance(lifecycle),
      summary: `job ${operatorStateLabel(raw.state)}: ${nonEmpty(raw.kind) ?? jobId}`, detail: detailValue.value, truth: "canonical", lifecycle,
    });
    state.detail_by_event_id.set(row.id, detailValue);
    rows.push(row);
  }
  return rows;
}

function approvalRows(input: unknown, state: ParseState): EventView[] {
  if (input === undefined) return [];
  if (!record(input)) return [diagnostic(state, "approval", "ledger:approval.list", "approval:projection", "approval projection is not an object")];
  if (!Array.isArray(input.records)) return [];
  const rows: EventView[] = [];
  for (const [index, raw] of input.records.entries()) {
    if (!record(raw)) continue;
    const requestId = nonEmpty(raw.request_id);
    if (requestId === null) continue;
    const status = nonEmpty(raw.status) ?? "unknown";
    const lifecycle = operatorWorkLifecycle(status);
    const subject = nonEmpty(raw.subject) ?? requestId;
    const resourceId = nonEmpty(raw.resource_id);
    const proposer = nonEmpty(raw.proposer) ?? "proposer unavailable";
    const detailValue = detail(state, [
      `requested by ${proposer}`,
      resourceId === null ? null : `resource ${resourceId}`,
      nonEmpty(raw.decided_by) === null ? null : `decided by ${nonEmpty(raw.decided_by)}`,
      nonEmpty(raw.expires_at) === null ? null : `expires ${nonEmpty(raw.expires_at)}`,
    ].filter((value): value is string => value !== null).join(" · "));
    const row = eventView({
      id: `approval:${requestId}:${index}`, kind: "permission_gate", event_kind: "approval.lifecycle", actor: proposer, parent_id: resourceId,
      correlation: durableCorrelation(raw, input), source: "approval", source_id: requestId, sequence: null, occurred_at: nonEmpty(raw.decided_at) ?? nonEmpty(raw.expires_at), importance: workImportance(lifecycle),
      summary: `approval ${operatorStateLabel(status)}: ${nonEmpty(raw.action) ?? "governed action"} · ${subject}`, detail: detailValue.value, truth: "canonical", lifecycle,
    });
    state.detail_by_event_id.set(row.id, detailValue);
    rows.push(row);
  }
  return rows;
}

/**
 * Durable inbox records are the only notification source admitted to the
 * document. Transient AppModel notices intentionally remain outside this
 * grammar because they have no durable producer identity or read state.
 */
function notificationRows(input: unknown, state: ParseState): EventView[] {
  if (input === undefined) return [];
  if (!record(input)) return [diagnostic(state, "notification", "runtime:notification.list", "notification:projection", "notification projection is not an object")];
  if (!Array.isArray(input.notifications)) return [];
  const rows: EventView[] = [];
  for (const [index, raw] of input.notifications.entries()) {
    if (!record(raw)) continue;
    const notificationId = nonEmpty(raw.id);
    const severity = nonEmpty(raw.severity);
    if (notificationId === null || (severity !== "info" && severity !== "warning" && severity !== "error")) continue;
    const readAt = nonEmpty(raw.read_at);
    const detailValue = detail(state, [
      nonEmpty(raw.body),
      safeInteger(raw.occurrences) === null ? null : `occurrences ${safeInteger(raw.occurrences)}`,
      readAt === null ? "unread" : `read ${readAt}`,
    ].filter((value): value is string => value !== null).join(" · "));
    let row = eventView({
      id: `notification:${notificationId}:${index}`, kind: "status", form: "session_notification", event_kind: "notification.inbox", actor: "system", parent_id: null,
      correlation: Object.freeze({ session_id: null, campaign_id: nonEmpty(raw.project_id), node_id: null, operation_id: null, command_group_id: null }),
      source: "notification", source_id: notificationId, sequence: null, occurred_at: nonEmpty(raw.updated_at) ?? nonEmpty(raw.created_at),
      importance: severity === "error" || severity === "warning" ? "attention" : "supporting", summary: nonEmpty(raw.title) ?? "session notification",
      detail: detailValue.value, truth: "canonical", lifecycle: "observed",
    });
    if (readAt === null) row = Object.freeze({ ...row, actions: Object.freeze([{ id: `notification.read:${notificationId}`, label: "Mark notification read", enabled: true }]) });
    state.detail_by_event_id.set(row.id, detailValue);
    rows.push(row);
  }
  return rows;
}

/**
 * User-input records are durable canonical facts, not a Console-only
 * transcript dialect.  Preserve withheld answers as the smaller fact that an
 * answer was recorded; do not derive answer content from its question.
 */
function userinputRows(input: unknown, state: ParseState): EventView[] {
  if (input === undefined) return [];
  if (!record(input)) return [diagnostic(state, "userinput", "ledger", "userinput:projection", "userinput projection is not an object")];
  const rows: EventView[] = [];
  const answered = new Set(Array.isArray(input.answered_record_ids)
    ? input.answered_record_ids.filter((value): value is string => typeof value === "string" && value.length > 0)
    : []);
  const add = (row: EventView, detailValue: DetailValue): void => {
    state.detail_by_event_id.set(row.id, detailValue);
    rows.push(row);
  };
  if (Array.isArray(input.records)) {
    for (const [index, raw] of input.records.entries()) {
      if (!record(raw)) continue;
      const question = record(raw.question) ? raw.question : null;
      const recordId = nonEmpty(raw.id) ?? nonEmpty(question?.operation_id);
      if (recordId === null) continue;
      const correlationValue = durableCorrelation(raw, input, nonEmpty(question?.origin_session_id));
      const explicitAnswer = nonEmpty(raw.kind) === "user_input_answer";
      const answer = record(raw.answer) ? raw.answer : null;
      if (explicitAnswer) {
        if (nonEmpty(raw.question_record_id) === null || answer === null) continue;
        const detailValue = detail(state, answer.answered_by);
        add(eventView({
          id: `userinput:${recordId}:answer:${index}`, kind: "operator", event_kind: "user_input_answer", actor: "operator", parent_id: nonEmpty(raw.question_record_id),
          correlation: correlationValue, source: "userinput", source_id: recordId, sequence: null, occurred_at: nonEmpty(raw.timestamp), importance: "ordinary",
          summary: summary(state, answer.custom_text ?? answer.option_id, "answer recorded"), detail: detailValue.value, truth: "canonical", lifecycle: "completed",
        }), detailValue);
        continue;
      }
      const resolved = answer !== null || answered.has(recordId);
      const questionDetail = detail(state, question?.reason ?? question?.requester_role);
      add(eventView({
        id: `userinput:${recordId}:question:${index}`, kind: "permission_gate", event_kind: "request_user_input", actor: "operator", parent_id: null,
        correlation: correlationValue, source: "userinput", source_id: recordId, sequence: null, occurred_at: nonEmpty(raw.timestamp), importance: resolved ? "supporting" : "attention",
        summary: summary(state, question?.question, "operator input requested"), detail: questionDetail.value, truth: "canonical", lifecycle: resolved ? "completed" : "pending",
      }), questionDetail);
      if (resolved) {
        const detailValue = detail(state, answer?.answered_by);
        add(eventView({
          id: `userinput:${recordId}:answer:${index}`, kind: "operator", event_kind: "user_input_answer", actor: "operator", parent_id: recordId,
          correlation: correlationValue, source: "userinput", source_id: recordId, sequence: null, occurred_at: nonEmpty(answer?.answered_at), importance: "ordinary",
          summary: summary(state, answer?.custom_text ?? answer?.option_id, "answer recorded"), detail: detailValue.value, truth: "canonical", lifecycle: "completed",
        }), detailValue);
      }
    }
    return rows;
  }
  if (!Array.isArray(input.requests)) return rows;
  for (const [index, raw] of input.requests.entries()) {
    if (!record(raw)) continue;
    const recordId = nonEmpty(raw.record_id);
    if (recordId === null) continue;
    add(eventView({
      id: `userinput:${recordId}:awaiting:${index}`, kind: "permission_gate", event_kind: "request_user_input", actor: "operator", parent_id: null,
      correlation: durableCorrelation(raw, input), source: "userinput", source_id: recordId, sequence: null, occurred_at: null, importance: "attention",
      summary: summary(state, raw.question, "operator input requested"), detail: null, truth: "canonical", lifecycle: "pending",
    }), { value: null, input_chars: 0, retained_chars: 0, elided_chars: 0 });
  }
  return rows;
}

/** Governed task intake is a durable source and shares the canonical grammar. */
function taskcomposerRows(input: unknown, state: ParseState): EventView[] {
  if (input === undefined) return [];
  if (!record(input)) return [diagnostic(state, "taskcomposer", "ledger", "taskcomposer:projection", "taskcomposer projection is not an object")];
  if (!Array.isArray(input.items)) return [];
  const rows: EventView[] = [];
  for (const [index, raw] of input.items.entries()) {
    if (!record(raw)) continue;
    const draftId = nonEmpty(raw.id);
    if (draftId === null) continue;
    const correlationValue = durableCorrelation(raw, input);
    const task = detail(state, raw.task);
    if (task.value !== null) {
      const intentDetail = detail(state, raw.mode === "answer" ? "read-only reference question" : "governed task intake");
      const row = eventView({
        id: `taskcomposer:${draftId}:intent:${index}`, kind: "operator", event_kind: "taskcomposer.intent", actor: "operator", parent_id: null,
        correlation: correlationValue, source: "taskcomposer", source_id: draftId, sequence: null, occurred_at: nonEmpty(raw.created_at), importance: "ordinary",
        summary: task.value, detail: intentDetail.value, truth: "canonical", lifecycle: "observed",
      });
      state.detail_by_event_id.set(row.id, intentDetail);
      rows.push(row);
    }
    const status = nonEmpty(raw.status) ?? "unknown";
    const guidance = record(raw.guidance) ? raw.guidance : null;
    const planner = record(raw.planner) ? raw.planner : null;
    const failed = status === "failed";
    const detailValue = detail(state, guidance?.recommendation ?? guidance?.detail ?? planner?.error);
    const statusTitle = failed
      ? summary(state, guidance?.headline, "task intake failed")
      : status === "admitted" ? "campaign admitted"
        : status === "planning" ? raw.mode === "answer" ? "reading reference" : "planning task"
          : status === "answered" ? "reference answered (claimed)"
          : `task ${status.replaceAll("_", " ")}`;
    const lifecycle: OperatorLifecycle = failed ? "failed" : status === "admitted" || status === "answered" ? "completed" : status === "planning" || status === "awaiting_clarification" ? "pending" : "observed";
    const row = eventView({
      id: `taskcomposer:${draftId}:status:${index}`, kind: failed ? "diagnostic" : "status", event_kind: "taskcomposer.status", actor: "operator", parent_id: draftId,
      correlation: correlationValue, source: "taskcomposer", source_id: draftId, sequence: null, occurred_at: nonEmpty(raw.updated_at) ?? nonEmpty(raw.created_at),
      importance: failed ? "attention" : "supporting", summary: statusTitle, detail: detailValue.value, truth: "canonical", lifecycle,
    });
    state.detail_by_event_id.set(row.id, detailValue);
    rows.push(row);
    if (record(raw.proposal) && Array.isArray(raw.proposal.questions)) {
      for (const [questionIndex, candidate] of raw.proposal.questions.entries()) {
        if (!record(candidate)) continue;
        const questionText = nonEmpty(candidate.question);
        if (questionText === null) continue;
        const questionId = nonEmpty(candidate.id) ?? `${draftId}:${questionIndex}`;
        const questionDetail = detail(state, candidate.reason ?? candidate.context);
        const questionRow = eventView({
          id: `taskcomposer:${draftId}:question:${questionId}`,
          kind: "permission_gate",
          event_kind: "taskcomposer.question",
          actor: "operator",
          parent_id: draftId,
          correlation: correlationValue,
          source: "taskcomposer",
          source_id: draftId,
          sequence: null,
          occurred_at: nonEmpty(raw.updated_at) ?? nonEmpty(raw.created_at),
          importance: "attention",
          summary: questionText,
          detail: questionDetail.value,
          truth: "canonical",
          lifecycle: "pending",
        });
        state.detail_by_event_id.set(questionRow.id, questionDetail);
        rows.push(questionRow);
      }
    }
  }
  return rows;
}

const TEST_COMMAND = /(?:^|(?:&&|\|\||[;|])\s*)(?:bun\s+(?:run\s+)?test(?:[:\w-]*)?|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|(?:[\w.~/-]+\/)?(?:vitest|jest|pytest|rspec|phpunit)(?:\s|$)|go\s+test|cargo\s+test)/iu;

/**
 * Keep process channels distinct even in the bounded supplemental grammar.
 * DevTools is never upgraded to canonical truth here; labelled channel text
 * only prevents stderr from being silently discarded by command surfaces.
 */
function toolCallDetail(payload: UnknownRecord | null): string | null {
  if (payload === null) return null;
  const stdout = typeof payload.stdout === "string" && payload.stdout.length > 0 ? payload.stdout : null;
  const stderr = typeof payload.stderr === "string" && payload.stderr.length > 0 ? payload.stderr : null;
  const metadata = [
    payload.ok === true ? "result ok" : payload.ok === false ? "result failed" : null,
    typeof payload.exit === "number" ? `exit ${payload.exit}` : null,
    typeof payload.duration_ms === "number" ? `${payload.duration_ms}ms` : null,
  ].filter((value): value is string => value !== null);
  const channels = [
    ...(stdout === null ? [] : [`[stdout]\n${stdout}`]),
    ...(stderr === null ? [] : [`[stderr]\n${stderr}`]),
  ];
  return [...metadata, ...channels].join(channels.length > 0 && metadata.length > 0 ? "\n" : "") || null;
}

function devtoolsRows(input: unknown, state: ParseState): EventView[] {
  if (input === undefined) return [];
  if (!record(input)) return [diagnostic(state, "devtools", "unknown", "devtools:stream", "devtools_stream is not an object")];
  const sourceId = nonEmpty(input.campaign_id) ?? "process-local";
  if (!Array.isArray(input.lines)) return [diagnostic(state, "devtools", sourceId, `devtools:${sourceId}:stream`, "devtools_stream.lines is not an array")];
  const parsed: Array<{ readonly row: EventView; readonly index: number }> = [];
  for (const [index, raw] of input.lines.entries()) {
    if (!record(raw)) {
      parsed.push({ row: diagnostic(state, "devtools", sourceId, `devtools:${sourceId}:malformed:${index}`, "devtools line is not an object"), index });
      continue;
    }
    const eventKind = nonEmpty(raw.event_kind);
    const sequence = safeInteger(raw.seq);
    if (eventKind === null) {
      parsed.push({ row: diagnostic(state, "devtools", sourceId, `devtools:${sourceId}:malformed:${index}`, "devtools event_kind is missing", EMPTY_CORRELATION, sequence), index });
      continue;
    }
    const payload = record(raw.loop_event) ? raw.loop_event : null;
    const correlationValue = Object.freeze({
      session_id: null,
      campaign_id: nonEmpty(raw.campaign_id),
      node_id: nonEmpty(raw.node_id),
      operation_id: valueAt(raw, payload, "operation_id"),
      command_group_id: valueAt(raw, payload, "command_group_id"),
    });
    const command = nonEmpty(payload?.command) ?? nonEmpty(payload?.args) ?? nonEmpty(payload?.tool) ?? "command";
    const tool = nonEmpty(payload?.tool);
    const isTest = eventKind === "loop.tool_call" && TEST_COMMAND.test(command.trim());
    const narration = lifecycleNarration(eventKind, payload, correlationValue.node_id);
    if (eventKind !== "loop.tool_call" && eventKind !== "loop.diff" && narration === null) continue;
    const additions = safeInteger(payload?.additions);
    const deletions = safeInteger(payload?.deletions);
    const detailValue = eventKind === "loop.diff"
      ? detail(state, `+${additions ?? "?"} / -${deletions ?? "?"}`)
      : eventKind === "loop.tool_call"
        ? detail(state, toolCallDetail(payload) ?? payload?.result_summary ?? payload?.message)
        : detail(state, narration?.detail);
    const toolOutcome = payload?.ok === true ? "passed" : payload?.ok === false ? "failed" : "ran";
    const lifecycle: OperatorLifecycle = eventKind === "loop.tool_call"
      ? payload?.ok === false ? "failed" : payload?.ok === true ? "completed" : "observed"
      : eventKind === "loop.node_failed" || eventKind === "gate.recorded" && nonEmpty(payload?.result) === "fail"
        ? "failed"
        : "observed";
    const kind: OperatorEventKind = eventKind === "loop.tool_call"
      ? isTest ? "test" : "tool"
      : eventKind === "loop.diff"
        ? "artifact"
        : eventKind === "stream.truncated" || lifecycle === "failed"
          ? "diagnostic"
          : "status";
    const row = eventView({
        id: `devtools:${sourceId}:${sequence ?? index}`,
        kind,
        form: eventKind === "loop.diff" ? "patch_diff" : "generic",
        event_kind: eventKind,
        actor: valueAt(raw, payload, "actor", "agent") ?? "runtime",
        parent_id: valueAt(raw, payload, "parent_id", "parent_operation_id"),
        correlation: correlationValue,
        source: "devtools",
        source_id: sourceId,
        sequence,
        occurred_at: nonEmpty(raw.ts),
        importance: kind === "diagnostic" || lifecycle === "failed" ? "attention" : "supporting",
        summary: eventKind === "loop.tool_call"
          ? isTest ? `tests ${toolOutcome}: ${command}` : `$ ${command}${tool === null || tool === command ? "" : ` · ${tool}`}`
          : eventKind === "loop.diff"
            ? `diff captured${nonEmpty(payload?.path) === null ? "" : `: ${nonEmpty(payload?.path)}`}`
            : narration!.title,
        detail: detailValue.value,
        truth: "supplemental",
        lifecycle,
      });
    state.detail_by_event_id.set(row.id, detailValue);
    parsed.push({ row, index });
  }
  return parsed.sort((left, right) => (left.row.sequence ?? Number.MAX_SAFE_INTEGER) - (right.row.sequence ?? Number.MAX_SAFE_INTEGER) || left.index - right.index).map((item) => item.row);
}

function subjectKey(row: EventView): string {
  return row.correlation.node_id === null
    ? `${row.correlation.campaign_id ?? ""}\u0000source\u0000${row.source}\u0000${row.source_id}`
    : `${row.correlation.campaign_id ?? ""}\u0000node\u0000${row.correlation.node_id}`;
}

function advancesSubject(row: EventView): boolean {
  return row.lifecycle === "active" || row.lifecycle === "completed"
    || row.event_kind === "loop.node_claimed" || row.event_kind === "loop.node_verified" || row.event_kind === "loop.critic_dispatched";
}

/** A subsequent exact-subject advance quiets a past failure without removing it. */
function markStaleFailures(rows: readonly EventView[]): readonly EventView[] {
  const latestAdvance = new Map<string, number>();
  for (const row of rows) {
    const at = row.occurred_at === null ? Number.NaN : Date.parse(row.occurred_at);
    if (advancesSubject(row) && Number.isFinite(at)) {
      latestAdvance.set(subjectKey(row), Math.max(latestAdvance.get(subjectKey(row)) ?? Number.NEGATIVE_INFINITY, at));
    }
  }
  return rows.map((row) => {
    if (row.lifecycle !== "failed") return row;
    const at = row.occurred_at === null ? Number.NaN : Date.parse(row.occurred_at);
    const advancedAt = latestAdvance.get(subjectKey(row));
    if (!Number.isFinite(at) || advancedAt === undefined || advancedAt <= at) return row;
    return Object.freeze({ ...row, stale: true, visual: Object.freeze({ ...row.visual, emphasis: "muted" as const }) });
  });
}

function attentionPrecedence(row: EventView): number {
  if (row.stale) return 0;
  if (row.kind === "permission_gate" && row.lifecycle === "pending") return 4;
  if (row.lifecycle === "failed" || row.lifecycle === "interrupted") return 3;
  if (row.lifecycle === "active" || row.lifecycle === "pending") return 2;
  return 0;
}

/** Selects by semantic urgency; equal urgency stays source-group deterministic. */
export function selectOperatorAttention(rows: readonly EventView[]): AttentionView | null {
  let selected: EventView | null = null;
  let precedence = 0;
  for (const row of rows) {
    const candidate = attentionPrecedence(row);
    if (candidate >= precedence && candidate > 0) {
      selected = row;
      precedence = candidate;
    }
  }
  return selected === null ? null : Object.freeze({ event_id: selected.id, summary: selected.summary, lifecycle: selected.lifecycle });
}

function validateLimits(input: OperatorProjectionLimits | undefined): ValidatedOperatorProjectionLimits {
  const limits: ValidatedOperatorProjectionLimits = {
    max_rows: input?.max_rows ?? DEFAULT_OPERATOR_PROJECTION_LIMITS.max_rows,
    max_detail_chars: input?.max_detail_chars ?? DEFAULT_OPERATOR_PROJECTION_LIMITS.max_detail_chars,
    max_attention: input?.max_attention ?? DEFAULT_OPERATOR_PROJECTION_LIMITS.max_attention,
    max_output_records: input?.max_output_records ?? DEFAULT_OPERATOR_PROJECTION_LIMITS.max_output_records ?? 200,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`operator projection limit ${name} must be a positive safe integer`);
  }
  return Object.freeze({ ...limits });
}

function supervisedWork(
  sessionInput: unknown,
  taskInput: unknown,
  jobInput: unknown,
  selectedSessionId: string | null | undefined,
): readonly SupervisedWorkView[] {
  const rows: SupervisedWorkView[] = [];
  if (record(sessionInput)) {
    const candidates = Array.isArray(sessionInput.sessions) ? sessionInput.sessions : Array.isArray(sessionInput.items) ? sessionInput.items : [];
    for (const candidate of candidates) {
      if (!record(candidate)) continue;
      const sessionId = nonEmpty(candidate.session_id);
      if (sessionId === null || sessionId === selectedSessionId || candidate.terminal !== null && candidate.terminal !== undefined) continue;
      const state = nonEmpty(candidate.state) ?? "unknown";
      const lifecycle = operatorWorkLifecycle(state);
      if (lifecycle !== "active" && lifecycle !== "pending") continue;
      rows.push(Object.freeze({
        source: "session",
        id: sessionId,
        session_id: sessionId,
        campaign_id: nonEmpty(candidate.campaign_id),
        node_id: nonEmpty(candidate.node_id),
        parent_id: null,
        operation_id: nonEmpty(candidate.operation_id),
        owner: nonEmpty(candidate.operation),
        state,
        lifecycle,
        pending_steering: safeInteger(candidate.pending_steering) ?? 0,
      }));
    }
  }
  const taskOperationIds = new Set<string>();
  if (record(taskInput)) {
    const candidates = Array.isArray(taskInput.items) ? taskInput.items : Array.isArray(taskInput.tasks) ? taskInput.tasks : [];
    for (const candidate of candidates) {
      if (!record(candidate)) continue;
      const id = nonEmpty(candidate.id);
      if (id === null) continue;
      const state = nonEmpty(candidate.state) ?? "unknown";
      const lifecycle = operatorWorkLifecycle(state);
      if (lifecycle !== "active" && lifecycle !== "pending") continue;
      const operationId = nonEmpty(candidate.operation_id);
      if (operationId !== null) taskOperationIds.add(operationId);
      rows.push(Object.freeze({
        source: "task", id, session_id: null, campaign_id: nonEmpty(candidate.campaign_id) ?? (record(taskInput) ? nonEmpty(taskInput.campaign_id) : null), node_id: nonEmpty(candidate.node_id),
        parent_id: nonEmpty(candidate.parent_id), operation_id: operationId, owner: nonEmpty(candidate.owner_scope_id), state, lifecycle, pending_steering: 0,
      }));
    }
  }
  // A scheduler job is a projection over a supervisor task only when the two
  // producers expose the same canonical operation id.  Job/task ids are
  // independently allocated API fields, so matching their spelling would be
  // a presentation-side inference and could hide real concurrent work.
  if (record(jobInput) && Array.isArray(jobInput.jobs)) {
    for (const candidate of jobInput.jobs) {
      if (!record(candidate)) continue;
      const id = nonEmpty(candidate.id);
      const operationId = nonEmpty(candidate.operation_id);
      if (id === null || (operationId !== null && taskOperationIds.has(operationId))) continue;
      const state = nonEmpty(candidate.state) ?? "unknown";
      const lifecycle = operatorWorkLifecycle(state);
      if (lifecycle !== "active" && lifecycle !== "pending") continue;
      rows.push(Object.freeze({
        source: "job", id, session_id: null, campaign_id: nonEmpty(candidate.campaign_id) ?? (record(jobInput) ? nonEmpty(jobInput.campaign_id) : null), node_id: nonEmpty(candidate.node_id),
        parent_id: null, operation_id: operationId, owner: nonEmpty(candidate.owner_scope_id), state, lifecycle, pending_steering: 0,
      }));
    }
  }
  return Object.freeze(rows.slice(0, 200));
}

/** Build an immutable, source-honest document without mutating input projections. */
export function buildOperatorViewModel(input: OperatorProjectionInput): OperatorViewModel {
  const limits = validateLimits(input.limits);
  if (!Number.isSafeInteger(input.now_ms)) throw new Error("operator projection now_ms must be a safe integer");
  if (!Number.isSafeInteger(input.viewport.columns) || input.viewport.columns < 1 || !Number.isSafeInteger(input.viewport.rows) || input.viewport.rows < 1) {
    throw new Error("operator projection viewport must contain positive safe integers");
  }
  const state: ParseState = { limits, detail_by_event_id: new Map(), terminal_by_session: new Map(), deduplicated_rows: 0 };
  const sessionCanonical = withOutputDescriptorActions(
    collateCanonicalCommands(canonicalRows(input.session_attach, state)),
    outputDescriptorCandidates(input.output_list, limits.max_output_records),
  );
  const durableCanonical = [
    ...userinputRows(input.userinput_projection, state),
    ...taskcomposerRows(input.taskcomposer_projection, state),
    ...taskRows(input.task_projection, state),
    ...jobRows(input.job_projection, state),
    ...approvalRows(input.approval_projection, state),
    ...notificationRows(input.notification_projection, state),
  ];
  const canonical = [...sessionCanonical, ...durableCanonical];
  const supplemental = devtoolsRows(input.devtools_stream, state);
  // Canonical and supplemental sources intentionally remain separate groups.
  // Timestamp coincidence cannot establish a shared durable ordering.
  const allRows = [...canonical, ...supplemental];
  // Canonical evidence has retention priority. A large process-local devtools
  // tail must never evict every canonical row, particularly a terminal fact.
  const retainedCanonical = canonical.length > limits.max_rows ? canonical.slice(canonical.length - limits.max_rows) : canonical;
  const supplementalCapacity = Math.max(0, limits.max_rows - retainedCanonical.length);
  const retainedSupplemental = supplementalCapacity === 0 ? [] : supplemental.slice(supplemental.length - supplementalCapacity);
  const document = markStaleFailures([...retainedCanonical, ...retainedSupplemental]);
  // Attention prefers canonical truth, then takes the newest entries within
  // each source group. The returned slice remains source grouped and ordered.
  const canonicalAttention = retainedCanonical.filter((row) => row.importance === "attention");
  const retainedCanonicalAttention = canonicalAttention.slice(Math.max(0, canonicalAttention.length - limits.max_attention));
  const supplementalAttentionCapacity = Math.max(0, limits.max_attention - retainedCanonicalAttention.length);
  const supplementalAttention = retainedSupplemental.filter((row) => row.importance === "attention");
  const attention = [...retainedCanonicalAttention, ...supplementalAttention.slice(Math.max(0, supplementalAttention.length - supplementalAttentionCapacity))]
    .map((row) => Object.freeze({ event_id: row.id, summary: row.summary, lifecycle: row.lifecycle }));
  const terminalSessionSet = new Set([...state.terminal_by_session.entries()]
    .filter(([, lifecycle]) => lifecycle === "completed" || lifecycle === "failed" || lifecycle === "interrupted")
    .map(([sessionId]) => sessionId));
  const foregroundRow = [...document].reverse().find((row) => row.truth === "canonical"
    && (row.lifecycle === "active" || row.lifecycle === "pending")
    && (row.correlation.session_id === null || !terminalSessionSet.has(row.correlation.session_id))) ?? null;
  const inputDetailChars = [...state.detail_by_event_id.values()].reduce((total, value) => total + value.input_chars, 0);
  const retainedDetailChars = document.reduce((total, row) => total + (state.detail_by_event_id.get(row.id)?.retained_chars ?? 0), 0);
  const terminalSessions = Object.freeze([...state.terminal_by_session.entries()].filter(([, lifecycle]) => lifecycle === "completed" || lifecycle === "failed" || lifecycle === "interrupted").map(([sessionId]) => sessionId).sort());
  const background = supervisedWork(input.session_list, input.task_projection, input.job_projection, input.selected_session_id);
  const selectedAttention = selectOperatorAttention(document);
  return Object.freeze({
    objective: objectiveFromTree(input.campaign_tree),
    foreground: foregroundRow === null ? null : Object.freeze({ event_id: foregroundRow.id, lifecycle: foregroundRow.lifecycle, correlation: foregroundRow.correlation }),
    background,
    document: Object.freeze(document),
    command_groups: commandGroups(document),
    attention: Object.freeze(attention),
    selected_attention: selectedAttention,
    inspector: inspectableEvent(document, selectedAttention, foregroundRow),
    bounds: Object.freeze({
      input_rows: allRows.length + state.deduplicated_rows,
      retained_rows: document.length,
      elided_rows: allRows.length + state.deduplicated_rows - document.length,
      deduplicated_rows: state.deduplicated_rows,
      input_detail_chars: inputDetailChars,
      retained_detail_chars: retainedDetailChars,
      elided_detail_chars: inputDetailChars - retainedDetailChars,
    }),
    freshness: Object.freeze({
      evaluated_at_ms: input.now_ms,
      cross_source_order: "source_grouped" as const,
      canonical_rows: canonical.length,
      supplemental_rows: supplemental.length,
      canonical_terminal_sessions: terminalSessions,
    }),
  });
}
