import { createHash } from "node:crypto";
import type { Provenance, RuntimeEventEnvelope } from "@arbor/core";
import type { ArborRuntime } from "./runtime.js";
import type { TaskComposerDraft } from "./task-composer-contracts.js";

/**
 * Bounded ACP-facing view of a task-composer draft.  This intentionally
 * carries canonical IDs/revisions rather than becoming an alternate task or
 * campaign state store.
 */
export interface AcpIdeDraft {
  readonly draft_id: string;
  readonly revision: number;
  readonly status: TaskComposerDraft["status"];
  readonly campaign_id: string | null;
  readonly job_id: string | null;
  readonly questions: readonly AcpIdeQuestion[];
}

export interface AcpIdeQuestion {
  readonly question_id: string;
  readonly question: string;
  readonly revision: number;
  /** The answer has to return through the same governed authority that asked it. */
  readonly authority: "taskcomposer" | "campaign";
  /** A campaign question is addressed by its durable user-input ledger id. */
  readonly record_id?: string;
  /** Offered choices from the durable user-input record, when this is a campaign question. */
  readonly options?: readonly { readonly id: string; readonly text: string; readonly is_other: boolean }[];
}

export interface AcpIdeVerifiedResult {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly summary: string;
  readonly files: readonly string[];
  /** Only `!verified` results are eligible to leave the governed runtime. */
  readonly provenance: Extract<Provenance, { readonly tag: "verified" }>;
}

export type AcpIdeRequest =
  | { readonly method: "initialize"; readonly protocol_version: 1; readonly client_name: string }
  | { readonly method: "session/new"; readonly session_id: string }
  | { readonly method: "session/prompt"; readonly session_id: string; readonly prompt: string; readonly idempotency_key: string; readonly auto_confirm?: boolean }
  | { readonly method: "session/question/answer"; readonly session_id: string; readonly question_id: string; readonly answer: string; readonly expected_revision: number; readonly record_id?: string }
  | { readonly method: "session/cancel"; readonly session_id: string; readonly reason: string }
  | { readonly method: "session/events"; readonly session_id: string; readonly limit?: number }
  | { readonly method: "session/result"; readonly session_id: string };

export type AcpIdeNotification =
  | { readonly method: "session/update"; readonly session_id: string; readonly update: { readonly kind: "progress"; readonly status: AcpIdeDraft["status"]; readonly draft_id: string; readonly campaign_id: string | null; readonly event?: RuntimeEventEnvelope } }
  | { readonly method: "session/request_permission"; readonly session_id: string; readonly question: AcpIdeQuestion }
  | { readonly method: "session/result"; readonly session_id: string; readonly result: AcpIdeVerifiedResult };

export type AcpIdeResponse =
  | { readonly ok: true; readonly result: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: { readonly code: "invalid_request" | "not_initialized" | "not_found" | "conflict" | "governance" | "internal"; readonly message: string } };

/**
 * This is deliberately the narrow composition boundary for the ACP journey.
 * Its methods must be bound to the existing TaskComposer, ArborRuntime
 * interrupt path, manager user-input ledger, result verifier, and canonical
 * RuntimeEventStream. It has no runner, worktree, model, or approval method.
 */
export interface AcpIdeRuntimePort {
  submitIdeTask(input: { readonly task: string; readonly idempotency_key: string; readonly auto_confirm: boolean }): Promise<AcpIdeDraft>;
  answerTaskComposerQuestion(input: { readonly draft_id: string; readonly expected_revision: number; readonly question_id: string; readonly answer: string }): Promise<AcpIdeDraft>;
  answerCampaignQuestion(input: { readonly record_id: string; readonly answer: string }): Promise<void>;
  cancelPlanning(input: { readonly draft_id: string; readonly expected_revision: number; readonly reason: string }): Promise<AcpIdeDraft>;
  /** Must call ArborRuntime.interrupt (or the catalog's identical governed cancellation authority). */
  cancelCampaign(input: { readonly campaign_id: string; readonly reason: string; readonly idempotency_key: string }): Promise<void>;
  subscribeRuntimeEvents(sink: (event: RuntimeEventEnvelope) => void): () => void;
  pendingCampaignQuestions(campaign_id: string): readonly AcpIdeQuestion[];
  verifiedResults(campaign_id: string): readonly AcpIdeVerifiedResult[];
}

const MAX_TEXT = 16_384;
const MAX_EVENTS = 128;

/**
 * Bind ACP to the existing runtime authority. No campaign loop, capability,
 * evidence, or approval path is recreated here. A host need only start the
 * supplied stdio transport with this port and its already-composed runtime.
 */
export function createAcpIdeRuntimePort(runtime: ArborRuntime): AcpIdeRuntimePort {
  const campaignQuestions = new Map<string, readonly { readonly id: string; readonly text: string; readonly is_other: boolean }[]>();
  return {
    async submitIdeTask(input) { return projectDraft(await runtime.taskComposer.dispatch({ kind: "taskcomposer.submit", task: input.task, source: "ide", idempotency_key: input.idempotency_key, auto_confirm: input.auto_confirm })); },
    async answerTaskComposerQuestion(input) { return projectDraft(await runtime.taskComposer.dispatch({ kind: "taskcomposer.answer", ...input })); },
    async answerCampaignQuestion(input) {
      const options = campaignQuestions.get(input.record_id);
      if (options === undefined) throw new Error("campaign question was not obtained through the governed ACP question feed");
      const selected = options.find((option) => option.id === input.answer || option.text.trim() === input.answer.trim());
      const allowOther = options.some((option) => option.is_other);
      if (selected === undefined && !allowOther) throw new Error("answer does not select an offered option and this governed question has no Other choice");
      runtime.manager.answerUserInput(input.record_id, { option_id: selected?.id ?? null, custom_text: selected === undefined ? input.answer : "", answered_by: "acp-ide-operator", answered_at: new Date().toISOString() });
    },
    async cancelPlanning(input) { return projectDraft(await runtime.taskComposer.dispatch({ kind: "taskcomposer.cancel", ...input })); },
    async cancelCampaign(input) {
      const nodeId = runtime.manager.getActiveExpandingNode(input.campaign_id);
      if (nodeId === null) throw new Error("campaign has no active node that can be interrupted");
      const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      runtime.interrupt({ campaign_id: input.campaign_id, node_id: nodeId, operation_id: input.idempotency_key, scope: "subtree", reason: input.reason, expected_version: runtime.manager.getCampaignVersion(input.campaign_id), partial_evidence_ids: [], provenance: { tag: "generated", generator: "acp-ide", input_hash: `sha256:${digest}` } });
    },
    subscribeRuntimeEvents(sink) {
      const subscription = runtime.eventStream.subscribe({ max_pending: MAX_EVENTS });
      const timer = setInterval(() => subscription.poll(MAX_EVENTS).forEach(sink), 25);
      timer.unref?.();
      return () => { clearInterval(timer); subscription.close(); };
    },
    pendingCampaignQuestions(campaignId) {
      const answered = new Set(runtime.manager.answeredUserInputIds(campaignId));
      return runtime.manager.getUserInputs(campaignId, undefined, { limit: 100 })
        .filter((record) => !answered.has(record.id))
        .map((record) => {
          const options = record.question.options.map((option) => ({ id: option.id, text: option.text, is_other: option.is_other }));
          campaignQuestions.set(record.id, options);
          return { question_id: record.id, question: record.question.question, revision: 1, authority: "campaign" as const, record_id: record.id, options };
        });
    },
    verifiedResults(campaignId) {
      return runtime.resultVerification.list(campaignId)
        .flatMap((record) => record.confidence === "verified" && record.provenance.tag === "verified"
          ? [{ campaign_id: record.campaign_id, node_id: record.node_id, summary: `Verified result for ${record.node_id}`, files: record.files, provenance: record.provenance }]
          : []);
    },
  };
}

/**
 * A transport-neutral, bounded ACP session adapter.  It translates IDE
 * protocol messages into the canonical ports above; notably, it cannot make
 * an unverified result look complete and it cannot manufacture a campaign
 * loop or a capability bypass.
 */
export class AcpIdeJourney {
  private readonly sessions = new Map<string, AcpIdeSession>();
  private initialized = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly runtime: AcpIdeRuntimePort) {
    this.unsubscribe = runtime.subscribeRuntimeEvents((event) => this.observeRuntimeEvent(event));
  }

  close(): void { this.unsubscribe(); this.sessions.clear(); }

  async dispatch(value: unknown): Promise<AcpIdeResponse> {
    const request = parseRequest(value);
    if (request === null) return failure("invalid_request", "ACP request is malformed or exceeds its bounded shape");
    if (request.method === "initialize") { this.initialized = true; return success({ protocol_version: 1, server_name: "revoy", capabilities: ["session/prompt", "session/events", "session/question/answer", "session/cancel", "session/result"] }); }
    if (!this.initialized) return failure("not_initialized", "initialize must complete before an ACP session request");
    if (request.method === "session/new") {
      if (this.sessions.has(request.session_id)) return failure("conflict", `ACP session ${request.session_id} already exists`);
      this.sessions.set(request.session_id, { id: request.session_id, draft: null, events: [] });
      return success({ session_id: request.session_id });
    }
    const session = this.sessions.get(request.session_id);
    if (session === undefined) return failure("not_found", `unknown ACP session ${request.session_id}`);
    try {
      switch (request.method) {
        case "session/prompt": return this.prompt(session, request);
        case "session/question/answer": return this.answer(session, request);
        case "session/cancel": return this.cancel(session, request);
        case "session/events": return success({ events: session.events.splice(0, request.limit ?? MAX_EVENTS) });
        case "session/result": return this.result(session);
      }
    } catch (error) {
      return failure("internal", boundedError(error));
    }
  }

  private async prompt(session: AcpIdeSession, request: Extract<AcpIdeRequest, { readonly method: "session/prompt" }>): Promise<AcpIdeResponse> {
    if (session.draft !== null) return failure("conflict", "an ACP session accepts one task submission");
    const draft = await this.runtime.submitIdeTask({ task: request.prompt, idempotency_key: request.idempotency_key, auto_confirm: request.auto_confirm ?? true });
    session.draft = draft;
    this.enqueueDraft(session, draft);
    return success({ draft_id: draft.draft_id, revision: draft.revision, status: draft.status, campaign_id: draft.campaign_id, job_id: draft.job_id });
  }

  private async answer(session: AcpIdeSession, request: Extract<AcpIdeRequest, { readonly method: "session/question/answer" }>): Promise<AcpIdeResponse> {
    const draft = session.draft;
    if (draft === null) return failure("conflict", "a question cannot be answered before task submission");
    const question = draft.questions.find((item) => item.question_id === request.question_id && item.revision === request.expected_revision && (request.record_id === undefined || item.record_id === request.record_id));
    if (question === undefined) return failure("governance", "answer does not match a currently displayed governed question and revision");
    if (question.authority === "campaign") {
      if (question.record_id === undefined) return failure("internal", "campaign question lacks its durable ledger record id");
      await this.runtime.answerCampaignQuestion({ record_id: question.record_id, answer: request.answer });
      session.draft = { ...draft, questions: draft.questions.filter((item) => item !== question) };
    } else {
      const next = await this.runtime.answerTaskComposerQuestion({ draft_id: draft.draft_id, expected_revision: request.expected_revision, question_id: question.question_id, answer: request.answer });
      session.draft = next;
      this.enqueueDraft(session, next);
    }
    return success({ accepted: true });
  }

  private async cancel(session: AcpIdeSession, request: Extract<AcpIdeRequest, { readonly method: "session/cancel" }>): Promise<AcpIdeResponse> {
    const draft = session.draft;
    if (draft === null) return failure("conflict", "a session without a task has nothing to cancel");
    if (draft.campaign_id === null) {
      const next = await this.runtime.cancelPlanning({ draft_id: draft.draft_id, expected_revision: draft.revision, reason: request.reason });
      session.draft = next; this.enqueueDraft(session, next);
    } else {
      await this.runtime.cancelCampaign({ campaign_id: draft.campaign_id, reason: request.reason, idempotency_key: `acp-cancel:${session.id}:${draft.campaign_id}` });
    }
    return success({ cancelled: true });
  }

  private result(session: AcpIdeSession): AcpIdeResponse {
    const campaignId = session.draft?.campaign_id;
    if (campaignId === null || campaignId === undefined) return failure("not_found", "the ACP session has no admitted campaign result");
    const result = this.runtime.verifiedResults(campaignId)[0];
    if (result === undefined) return failure("governance", "no verified result is available for this campaign");
    this.enqueue(session, { method: "session/result", session_id: session.id, result });
    return success({ result });
  }

  private observeRuntimeEvent(event: RuntimeEventEnvelope): void {
    for (const session of this.sessions.values()) {
      const draft = session.draft;
      if (draft === null || draft.campaign_id === null || campaignIdFor(event) !== draft.campaign_id) continue;
      this.enqueue(session, { method: "session/update", session_id: session.id, update: { kind: "progress", status: draft.status, draft_id: draft.draft_id, campaign_id: draft.campaign_id, event } });
      const questions = this.runtime.pendingCampaignQuestions(draft.campaign_id);
      if (questions.length > 0) {
        session.draft = { ...draft, questions };
        for (const question of questions) this.enqueue(session, { method: "session/request_permission", session_id: session.id, question });
      }
      for (const result of this.runtime.verifiedResults(draft.campaign_id)) this.enqueue(session, { method: "session/result", session_id: session.id, result });
    }
  }

  private enqueueDraft(session: AcpIdeSession, draft: AcpIdeDraft): void {
    this.enqueue(session, { method: "session/update", session_id: session.id, update: { kind: "progress", status: draft.status, draft_id: draft.draft_id, campaign_id: draft.campaign_id } });
    for (const question of draft.questions) this.enqueue(session, { method: "session/request_permission", session_id: session.id, question });
  }

  private enqueue(session: AcpIdeSession, notification: AcpIdeNotification): void {
    if (session.events.length >= MAX_EVENTS) session.events.shift();
    session.events.push(notification);
  }
}

interface AcpIdeSession { readonly id: string; draft: AcpIdeDraft | null; events: AcpIdeNotification[]; }

function success(result: Readonly<Record<string, unknown>>): AcpIdeResponse { return { ok: true, result }; }
function failure(code: Extract<AcpIdeResponse, { readonly ok: false }> ["error"]["code"], message: string): AcpIdeResponse { return { ok: false, error: { code, message } }; }
function boundedError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 512) : "ACP runtime operation failed"; }

function parseRequest(value: unknown): AcpIdeRequest | null {
  if (!record(value) || !text(value.method, 64)) return null;
  if (value.method === "initialize") return value.protocol_version === 1 && text(value.client_name, 256) ? { method: value.method, protocol_version: 1, client_name: value.client_name } : null;
  if (value.method === "session/new") return id(value.session_id) ? { method: value.method, session_id: value.session_id } : null;
  if (value.method === "session/prompt") return id(value.session_id) && text(value.prompt, MAX_TEXT) && id(value.idempotency_key) && (value.auto_confirm === undefined || typeof value.auto_confirm === "boolean") ? { method: value.method, session_id: value.session_id, prompt: value.prompt, idempotency_key: value.idempotency_key, ...(value.auto_confirm === undefined ? {} : { auto_confirm: value.auto_confirm }) } : null;
  if (value.method === "session/question/answer") return id(value.session_id) && id(value.question_id) && text(value.answer, MAX_TEXT) && revision(value.expected_revision) && (value.record_id === undefined || id(value.record_id)) ? { method: value.method, session_id: value.session_id, question_id: value.question_id, answer: value.answer, expected_revision: value.expected_revision, ...(value.record_id === undefined ? {} : { record_id: value.record_id }) } : null;
  if (value.method === "session/cancel") return id(value.session_id) && text(value.reason, 2_048) ? { method: value.method, session_id: value.session_id, reason: value.reason } : null;
  if (value.method === "session/events") {
    const limit = value.limit;
    return id(value.session_id) && (limit === undefined || (typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_EVENTS))
      ? { method: value.method, session_id: value.session_id, ...(limit === undefined ? {} : { limit }) } : null;
  }
  if (value.method === "session/result") return id(value.session_id) ? { method: value.method, session_id: value.session_id } : null;
  return null;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function id(value: unknown): value is string { return text(value, 256) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value); }
function revision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function campaignIdFor(event: RuntimeEventEnvelope): string | null {
  const candidate: unknown = "campaign_id" in event.event ? event.event.campaign_id : null;
  return typeof candidate === "string" ? candidate : null;
}
function projectDraft(draft: TaskComposerDraft): AcpIdeDraft {
  return {
    draft_id: draft.id, revision: draft.revision, status: draft.status, campaign_id: draft.campaign_id, job_id: draft.job_id,
    questions: (draft.proposal?.questions ?? []).filter((question) => question.answer === null)
      .map((question) => ({ question_id: question.id, question: question.question, revision: draft.revision, authority: "taskcomposer" as const })),
  };
}
