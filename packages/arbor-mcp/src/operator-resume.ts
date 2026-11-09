import { createHash } from "node:crypto";

export interface OperatorResumeSession {
  readonly session_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly state: string;
  readonly latest_sequence: number;
  readonly recovery: { readonly kind: string; readonly checkpoint?: { readonly state: string; readonly latest_sequence: number } };
  readonly lineage: { readonly kind: string; readonly source_session_id?: string };
}

export interface OperatorResumeRuntime {
  listHarnessSessions(campaignId?: string): readonly OperatorResumeSession[] | null;
  sessionContinuationAvailability(sessionId: string): { readonly resume: boolean; readonly reason: string };
  reconcileHarnessSessionCrash(sessionId: string, apply: boolean): { readonly ok: boolean; readonly applied: boolean; readonly reason: string };
  sessionContinuationRequirements(sessionId: string): readonly OperatorResumeRequirement[];
  awaitCampaignRun(campaignId: string): Promise<{ readonly task_state: string | null }>;
}

export interface OperatorResumeDispatchResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: unknown;
}

export type OperatorResumeResult =
  | { readonly status: "idle"; readonly message: string }
  | { readonly status: "ambiguous"; readonly message: string; readonly candidates: readonly OperatorResumeCandidate[] }
  | { readonly status: "unavailable"; readonly message: string; readonly candidate: OperatorResumeCandidate | null }
  | { readonly status: "preview"; readonly message: string; readonly candidate: OperatorResumeCandidate; readonly required_dispositions: readonly OperatorResumeRequirement[] }
  | { readonly status: "rejected"; readonly message: string; readonly candidate: OperatorResumeCandidate; readonly code: string | null }
  | { readonly status: "continued"; readonly message: string; readonly candidate: OperatorResumeCandidate; readonly operation_id: string; readonly continuation_session_id: string | null; readonly task_state: string | null };

export interface OperatorResumeCandidate {
  readonly session_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly checkpoint: number;
  readonly checkpoint_state: string;
}
export interface OperatorResumeRequirement { readonly operation_id: string; readonly classification: string; readonly reason: string }

export async function resumeInterruptedWork(input: {
  readonly runtime: OperatorResumeRuntime;
  readonly dispatch: (envelope: unknown) => Promise<OperatorResumeDispatchResult>;
  readonly requested_session_id?: string;
  readonly actor_id?: string;
  readonly reason?: string;
  readonly preview?: boolean;
  readonly dispositions?: readonly { readonly operation_id: string; readonly decision: "retry" | "accept_observed" | "compensate" | "abandon"; readonly reason: string }[];
  readonly now?: () => string;
}): Promise<OperatorResumeResult> {
  const sessions = input.runtime.listHarnessSessions() ?? [];
  const recoverable = sessions
    .filter((session) => input.runtime.sessionContinuationAvailability(session.session_id).resume
      || (session.recovery.kind === "recovery_required" && input.runtime.reconcileHarnessSessionCrash(session.session_id, false).ok))
    .map(toCandidate)
    .sort((left, right) => left.session_id.localeCompare(right.session_id));
  const stranded = sessions.filter((session) => session.recovery.kind === "recovery_required");
  const requested = input.requested_session_id?.trim();
  const candidate = requested === undefined
    ? recoverable.length === 1 ? recoverable[0]! : null
    : recoverable.find((item) => item.session_id === requested) ?? null;

  if (requested === undefined && recoverable.length === 0 && stranded.length === 0) return { status: "idle", message: "No interrupted governed work is waiting in this repository." };
  if (requested === undefined && recoverable.length === 0) {
    const blocked = stranded[0]!;
    return { status: "unavailable", message: input.runtime.sessionContinuationAvailability(blocked.session_id).reason, candidate: toCandidate(blocked) };
  }
  if (requested === undefined && recoverable.length > 1) return {
    status: "ambiguous",
    message: "More than one interrupted session is recoverable. Choose one explicitly; revoy2 will not guess across branches.",
    candidates: recoverable,
  };
  if (candidate === null) {
    const known = requested === undefined ? null : sessions.find((item) => item.session_id === requested) ?? null;
    return { status: "unavailable", message: known === null ? `Session ${requested ?? "(missing)"} was not found in this repository.` : input.runtime.sessionContinuationAvailability(known.session_id).reason, candidate: known === null ? null : toCandidate(known) };
  }

  if (input.preview === true) return {
    status: "preview",
    message: `Ready to continue ${candidate.session_id} from checkpoint ${candidate.checkpoint}${candidate.checkpoint_state === "interrupted" ? "" : "; hard-crash state will first be durably reconciled"}.`,
    candidate,
    required_dispositions: input.runtime.sessionContinuationRequirements(candidate.session_id),
  };
  let availability = input.runtime.sessionContinuationAvailability(candidate.session_id);
  if (!availability.resume) {
    const reconciled = input.runtime.reconcileHarnessSessionCrash(candidate.session_id, true);
    if (!reconciled.ok) return { status: "unavailable", message: reconciled.reason, candidate };
    availability = input.runtime.sessionContinuationAvailability(candidate.session_id);
  }
  if (!availability.resume) return { status: "unavailable", message: availability.reason, candidate };

  const identity = createHash("sha256").update(`${candidate.session_id}:${candidate.campaign_id}:${candidate.node_id}:${candidate.checkpoint}`).digest("hex").slice(0, 32);
  const operationId = `cli-resume-${identity}`;
  const dispatched = await input.dispatch({
    schema_version: 1,
    metadata: {
      operation_id: operationId,
      idempotency_key: operationId,
      correlation_id: operationId,
      actor_id: input.actor_id ?? "cli-operator",
      requested_at: (input.now ?? (() => new Date().toISOString()))(),
      session: {},
    },
    command: {
      kind: "harness.session.resume",
      session_id: candidate.session_id,
      reason: input.reason ?? "operator resumed interrupted repository work",
      dispositions: input.dispositions ?? [],
      provenance: { tag: "claimed", claimant: input.actor_id ?? "cli-operator" },
    },
  });
  const acknowledgement = record(dispatched.value);
  if (!dispatched.ok || acknowledgement?.accepted !== true) {
    const error = record(dispatched.error) ?? record(acknowledgement?.error);
    const message = [error?.message, error?.summary, error?.detail].find((item) => typeof item === "string" && item.trim().length > 0);
    return { status: "rejected", message: typeof message === "string" ? message : "Governed continuation was rejected.", candidate, code: typeof error?.code === "string" ? error.code : null };
  }

  const settlement = await input.runtime.awaitCampaignRun(candidate.campaign_id);
  const continuation = (input.runtime.listHarnessSessions(candidate.campaign_id) ?? [])
    .filter((session) => session.lineage.kind === "continuation" && session.lineage.source_session_id === candidate.session_id)
    .sort((left, right) => right.session_id.localeCompare(left.session_id))[0];
  return {
    status: "continued",
    message: settlement.task_state === null
      ? "Continuation was dispatched; no terminal campaign settlement was available in this process."
      : `Interrupted work continued and settled as ${settlement.task_state}.`,
    candidate,
    operation_id: typeof acknowledgement.operation_id === "string" ? acknowledgement.operation_id : operationId,
    continuation_session_id: continuation?.session_id ?? null,
    task_state: settlement.task_state,
  };
}

export function formatOperatorResume(result: OperatorResumeResult): string {
  if (result.status === "idle") return result.message;
  if (result.status === "ambiguous") return `${result.message}\n${result.candidates.map((candidate) => `  ${candidate.session_id}  campaign ${candidate.campaign_id}  node ${candidate.node_id}  checkpoint ${candidate.checkpoint}`).join("\n")}\nRun: arbor resume <session-id>`;
  if (result.status === "unavailable" || result.status === "rejected") return `Resume refused: ${result.message}`;
  if (result.status === "preview") {
    const decisions = result.required_dispositions.length === 0 ? "" : `\nExplicit decisions required:\n${result.required_dispositions.map((item) => `  --disposition ${item.operation_id}=retry  # ${item.classification}: ${item.reason}`).join("\n")}`;
    return `${result.message}${decisions}\nRun without --preview to authorize a fresh governed continuation.`;
  }
  return `${result.message}\nSource: ${result.candidate.session_id}\nContinuation: ${result.continuation_session_id ?? "pending"}\nCampaign: ${result.candidate.campaign_id}`;
}

function toCandidate(session: OperatorResumeSession): OperatorResumeCandidate {
  return Object.freeze({
    session_id: session.session_id,
    campaign_id: session.campaign_id,
    node_id: session.node_id,
    checkpoint: session.recovery.checkpoint?.latest_sequence ?? session.latest_sequence,
    checkpoint_state: session.recovery.checkpoint?.state ?? session.state,
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
