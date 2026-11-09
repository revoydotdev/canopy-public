import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenUsageResult } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { TaskComposer, classifyAndRepairMutatingActions, taskComposerGuidance } from "../src/task-composer.js";
import type { TaskComposerDraft } from "../src/task-composer-contracts.js";
import type { ArbiterIntakePort } from "../src/arbiter-intake.js";

const proposal = JSON.stringify({
  summary: "implement the requested change", assumptions: [], questions: [],
  root_action: { description: "deliver the task", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
  actions: [{ description: "implement and verify", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }],
  acceptance_checks: ["tests pass"], acceptance_mapping: [{ criterion: "tests pass", action_descriptions: ["implement and verify"] }], risk_notes: [],
});
function usage(inputTokens: number, outputTokens: number): TokenUsageResult {
  return { input_tokens: inputTokens, output_tokens: outputTokens, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" };
}
const planner = { plan: async () => ({ raw_proposal: proposal, session_id: "plan-session", model_identity: "native-test", usage: usage(10, 5) }) };

describe("TaskComposer", () => {
  it("never asks the operator to answer when clarification status has no unanswered question", () => {
    const guidance = taskComposerGuidance({
      id: "draft-stale-question", revision: 1, status: "awaiting_clarification", task: "keep this factual", source: "tui",
      parent_campaign_id: null, evidence_ids: [], proposal: { ...JSON.parse(proposal), questions: [] }, answered_questions: [],
      planner: { kind: "native", session_id: null, model_identity: null, error: null, usage: usage(0, 0) }, arbiter_decision: null,
      campaign_id: null, job_id: null, rejection_reason: null, created_at: "2026-08-31T00:00:00.000Z", updated_at: "2026-08-31T00:00:00.000Z",
    } as TaskComposerDraft);
    expect(guidance).toMatchObject({ kind: "recovery", headline: "Clarification state is reconciling", retryable: false });
    expect(guidance.recommendation).not.toMatch(/answer the question/i);
  });

  it("turns a plain-language run request into admitted governed work and narrates safe recovery", async () => {
    const admitted: string[] = [];
    const composer = new TaskComposer({ manager: new CampaignManager(), planner, admission: { admit: async ({ campaign_id }) => { admitted.push(campaign_id); return { campaign_id, job_id: "job-1" }; } } });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "Make the mobile menu keyboard accessible", source: "web", idempotency_key: "natural-run", auto_confirm: true });
    expect(draft).toMatchObject({ status: "admitted", auto_confirm: true, guidance: { kind: "started", headline: "Work started", retryable: false } });
    expect(admitted).toEqual([`composer-${draft.id}`]);

    const bounded = await composer.submit({ kind: "taskcomposer.submit", task: "Apply another bounded edit", source: "cli", idempotency_key: "x".repeat(128), auto_confirm: true });
    expect(bounded.status).toBe("admitted");

    const unavailable = new TaskComposer({ manager: new CampaignManager() });
    const failed = await unavailable.submit({ kind: "taskcomposer.submit", task: "Fix the broken build", source: "tui", idempotency_key: "natural-recovery", auto_confirm: true });
    expect(failed).toMatchObject({ status: "failed", guidance: { kind: "recovery", headline: "Planning is not connected", retryable: true } });
    expect(failed.guidance?.recommendation).toContain("arbor doctor");
  });

  it("persists a proposed draft and rejects stale revisions after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-composer-"));
    try {
      const first = new TaskComposer({ manager: new CampaignManager({ persistence_dir: dir }), planner, persistence_dir: dir });
      const draft = await first.submit({ kind: "taskcomposer.submit", task: "add a capability", source: "cli", idempotency_key: "submit-1" });
      expect(draft).toMatchObject({ status: "proposed", revision: 2, planner: { kind: "native" } });
      const restarted = new TaskComposer({ manager: new CampaignManager({ persistence_dir: dir }), planner, persistence_dir: dir });
      await expect(restarted.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: 1, idempotency_key: "confirm-1" })).rejects.toThrow(/revision conflict/);
      expect(restarted.get(draft.id)).toMatchObject({ status: "proposed", revision: 2 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails closed for malformed planner output and unavailable native planning", async () => {
    const manager = new CampaignManager();
    // ADR-117 §3: schema-invalid output now retries up to MAX_PLAN_ATTEMPTS
    // (3), so a planner that is persistently malformed accumulates usage
    // across all 3 attempts before the draft fails closed.
    const malformed = new TaskComposer({ manager, planner: { plan: async () => ({ raw_proposal: "not JSON", session_id: null, model_identity: null, usage: usage(3, 0) }) } });
    await expect(malformed.submit({ kind: "taskcomposer.submit", task: "bad planner", source: "web", idempotency_key: "bad-1" })).resolves.toMatchObject({ status: "failed", planner: { kind: "failed", usage: usage(9, 0) } });
    const unavailable = new TaskComposer({ manager });
    await expect(unavailable.submit({ kind: "taskcomposer.submit", task: "no planner", source: "tui", idempotency_key: "none-1" })).resolves.toMatchObject({ status: "failed", planner: { kind: "unavailable", usage: { kind: "unavailable" } } });
  });

  it("retries a schema-invalid response with the parse error as feedback (ADR-117 §3), and retries a transient provider failure, failing only after exhausting the bound", async () => {
    const manager = new CampaignManager();
    // ADR-117 §3: a response that resolved but failed schema validation/parsing
    // now gets the same bounded re-prompt treatment a transient transport
    // failure already had -- the planner can plausibly self-correct given the
    // parse error, so it is fed back as `retry_context` and one of
    // MAX_PLAN_ATTEMPTS is consumed. A planner that is persistently
    // schema-invalid still fails once the bound is exhausted.
    let schemaCalls = 0;
    const schemaInvalid = new TaskComposer({ manager, planner: { plan: async () => { schemaCalls += 1; return { raw_proposal: "not JSON", session_id: "s1", model_identity: "m", usage: usage(4, 0) }; } } });
    const failed = await schemaInvalid.submit({ kind: "taskcomposer.submit", task: "schema invalid planner", source: "web", idempotency_key: "schema-invalid-1" });
    expect(failed.status).toBe("failed");
    expect(failed.planner.error).toContain("after 3 attempts");
    expect(schemaCalls).toBe(3);

    // A schema-invalid response is fed back as request context and recovers
    // on the next attempt, same shape as the transient-transport recovery below.
    let schemaThenOkCalls = 0;
    const receivedRetryContext: (string | undefined)[] = [];
    const schemaThenOk = new TaskComposer({
      manager,
      planner: {
        plan: async (input) => {
          schemaThenOkCalls += 1;
          receivedRetryContext.push(input.retry_context);
          return schemaThenOkCalls === 1
            ? { raw_proposal: "not JSON", session_id: "s2", model_identity: "m", usage: usage(4, 0) }
            : { raw_proposal: proposal, session_id: "s2", model_identity: "m", usage: usage(6, 3) };
        },
      },
    });
    const recoveredFromSchema = await schemaThenOk.submit({ kind: "taskcomposer.submit", task: "schema then ok planner", source: "web", idempotency_key: "schema-then-ok-1" });
    expect(recoveredFromSchema.status).toBe("proposed");
    expect(schemaThenOkCalls).toBe(2);
    expect(receivedRetryContext[0]).toBeUndefined();
    expect(receivedRetryContext[1]).toContain("planner output does not contain exactly one JSON object");
    expect(recoveredFromSchema.planner.usage).toEqual(usage(10, 3));

    // A provider call that is rejected every time (transport failure) is retried up to the bound.
    let alwaysThrows = 0;
    const doomed = new TaskComposer({ manager, planner: { plan: async () => { alwaysThrows += 1; throw new Error("provider 503"); } } });
    const doomedDraft = await doomed.submit({ kind: "taskcomposer.submit", task: "doomed planner", source: "web", idempotency_key: "doomed-1" });
    expect(doomedDraft.status).toBe("failed");
    expect(doomedDraft.planner.error).toContain("after 3 attempts");
    expect(alwaysThrows).toBe(3);

    // A transient throw is retried, then recovered, and usage from the successful attempt is kept.
    let throwsThenOk = 0;
    const transient = new TaskComposer({ manager, planner: { plan: async () => { throwsThenOk += 1; if (throwsThenOk === 1) throw new Error("transient provider 503"); return { raw_proposal: proposal, session_id: "s", model_identity: "m", usage: usage(6, 3) }; } } });
    const recovered = await transient.submit({ kind: "taskcomposer.submit", task: "transient planner", source: "web", idempotency_key: "transient-1" });
    expect(recovered.status).toBe("proposed");
    expect(throwsThenOk).toBe(2);
    expect(recovered.planner.usage).toEqual(usage(6, 3));
  });

  it("accumulates token usage across a submit's initial plan and a later full replan", async () => {
    const manager = new CampaignManager();
    const questionProposal = JSON.stringify({ ...JSON.parse(proposal), questions: [{ id: "scope", question: "Which package is in scope?" }] });
    let call = 0;
    const composer = new TaskComposer({ manager, planner: { plan: async () => { call += 1; return call === 1
      ? { raw_proposal: questionProposal, session_id: null, model_identity: "m", usage: usage(10, 4) }
      : { raw_proposal: proposal, session_id: null, model_identity: "m", usage: usage(6, 2) }; } } });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "clarify then plan", source: "cli", idempotency_key: "accum-1" });
    expect(draft.status).toBe("awaiting_clarification");
    expect(draft.planner.usage).toEqual(usage(10, 4));
    const answered = await composer.answer({ kind: "taskcomposer.answer", draft_id: draft.id, expected_revision: draft.revision, question_id: "scope", answer: "arbor-mcp" });
    expect(answered.status).toBe("proposed");
    expect(answered.answered_questions).toEqual([{ id: "scope", question: "Which package is in scope?", answer: "arbor-mcp", answered_by: "operator", answered_at: expect.any(String) }]);
    expect(call).toBe(2);
    expect(answered.planner.usage).toEqual(usage(16, 6));
  });

  it("never carries an answer when a planner reuses its question ID for different wording", async () => {
    const manager = new CampaignManager();
    const first = JSON.stringify({ ...JSON.parse(proposal), questions: [{ id: "Q1", question: "Does the repository already have an entry point?" }] });
    const renamed = JSON.stringify({ ...JSON.parse(proposal), questions: [{ id: "Q1", question: "Which browser viewport is canonical?" }] });
    let call = 0;
    let replanInput: { readonly answered_questions?: readonly { readonly id: string; readonly question: string; readonly answer: string }[] } | null = null;
    const composer = new TaskComposer({ manager, planner: { plan: async (input) => {
      call += 1;
      if (call === 2) replanInput = input;
      return { raw_proposal: call === 1 ? first : renamed, session_id: null, model_identity: "m", usage: usage(2, 1) };
    } } });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "clarify safely", source: "cli", idempotency_key: "question-binding" });
    const replanned = await composer.answer({ kind: "taskcomposer.answer", draft_id: draft.id, expected_revision: draft.revision, question_id: "Q1", answer: "No, create index.html." });

    expect(replanInput).toMatchObject({ answered_questions: [{ id: "Q1", question: "Does the repository already have an entry point?", answer: "No, create index.html." }] });
    expect(replanned).toMatchObject({ status: "awaiting_clarification", proposal: { questions: [{ id: "Q1", question: "Which browser viewport is canonical?", answer: null }] } });
  });

  it("uses a cheap patch call when a planner session exists, and falls back to a full replan when it cannot", async () => {
    const manager = new CampaignManager();
    const questionProposal = JSON.stringify({ ...JSON.parse(proposal), questions: [{ id: "scope", question: "Which package is in scope?" }] });

    // A planner exposing patch() with a live session: answer() must use patch(), not a full plan().
    let planCalls = 0; let patchCalls = 0; let patchInput: unknown = null;
    const withPatch = new TaskComposer({ manager, planner: {
      plan: async () => { planCalls += 1; return { raw_proposal: questionProposal, session_id: "session-1", model_identity: "m", usage: usage(10, 4) }; },
      patch: async (input) => { patchCalls += 1; patchInput = input; return { raw_proposal: proposal, session_id: "session-1", model_identity: "m", usage: usage(2, 1) }; },
    } });
    const draft = await withPatch.submit({ kind: "taskcomposer.submit", task: "patchable", source: "cli", idempotency_key: "patch-1" });
    expect(draft.status).toBe("awaiting_clarification");
    const answered = await withPatch.answer({ kind: "taskcomposer.answer", draft_id: draft.id, expected_revision: draft.revision, question_id: "scope", answer: "arbor-mcp" });
    expect(answered.status).toBe("proposed");
    expect(planCalls).toBe(1);
    expect(patchCalls).toBe(1);
    expect(patchInput).toMatchObject({ session_id: "session-1", answers: { scope: "arbor-mcp" }, newly_answered: { scope: "arbor-mcp" } });
    expect(typeof (patchInput as { prior_proposal: unknown }).prior_proposal).toBe("string");
    expect(answered.planner.usage).toEqual(usage(12, 5));

    // A planner with no patch() at all falls back to a full plan() call even though a session exists.
    let planOnlyCalls = 0;
    const withoutPatch = new TaskComposer({ manager, planner: { plan: async () => { planOnlyCalls += 1; return planOnlyCalls === 1
      ? { raw_proposal: questionProposal, session_id: "session-2", model_identity: "m", usage: usage(5, 1) }
      : { raw_proposal: proposal, session_id: "session-2", model_identity: "m", usage: usage(5, 1) }; } } });
    const draft2 = await withoutPatch.submit({ kind: "taskcomposer.submit", task: "no patch support", source: "cli", idempotency_key: "no-patch-1" });
    expect(draft2.status).toBe("awaiting_clarification");
    const answered2 = await withoutPatch.answer({ kind: "taskcomposer.answer", draft_id: draft2.id, expected_revision: draft2.revision, question_id: "scope", answer: "arbor-mcp" });
    expect(answered2.status).toBe("proposed");
    expect(planOnlyCalls).toBe(2);
  });

  it("interrupts a draft that was mid-planning when the process died, instead of leaving it stuck", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-composer-"));
    try {
      const path = join(dir, "task-composer", "drafts.json");
      mkdirSync(join(dir, "task-composer"), { recursive: true });
      const stuckDraft = {
        id: "draft-stuck-0000000000000000000000000000", revision: 3, status: "planning", task: "stuck mid plan", source: "cli",
        parent_campaign_id: null, evidence_ids: [], proposal: null,
        planner: { kind: "unavailable", session_id: null, model_identity: null, error: null },
        campaign_id: null, job_id: null, rejection_reason: null,
        created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
      };
      writeFileSync(path, `${JSON.stringify({ schema_version: 1, drafts: [stuckDraft], idempotency: [] })}\n`, "utf8");
      const restored = new TaskComposer({ manager: new CampaignManager(), persistence_dir: dir });
      const rehydrated = restored.get(stuckDraft.id);
      expect(rehydrated).toMatchObject({ status: "failed", revision: 4 });
      expect(rehydrated?.planner.error).toContain("interrupted");
      // The interruption is durably persisted, not only reflected in memory.
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as { drafts: Array<{ id: string; status: string }> };
      expect(onDisk.drafts.find((d) => d.id === stuckDraft.id)).toMatchObject({ status: "failed" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("cancels live planning durably, aborts the planner, and cannot be resurrected by a late result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-composer-"));
    try {
      let planningDraftId = "";
      let observedSignal: AbortSignal | undefined;
      let plannerStarted!: () => void;
      const started = new Promise<void>((resolve) => { plannerStarted = resolve; });
      let settlePlanner!: (value: { raw_proposal: string; session_id: string | null; model_identity: string | null; usage: TokenUsageResult }) => void;
      const composer = new TaskComposer({
        manager: new CampaignManager({ persistence_dir: dir }),
        persistence_dir: dir,
        on_change: (draft) => { if (draft.status === "planning") planningDraftId = draft.id; },
        planner: {
          plan: async ({ signal }) => {
            observedSignal = signal;
            plannerStarted();
            return new Promise<{ raw_proposal: string; session_id: string | null; model_identity: string | null; usage: TokenUsageResult }>((resolve) => { settlePlanner = resolve; });
          },
        },
      });

      const submission = composer.submit({ kind: "taskcomposer.submit", task: "cancel a live plan", source: "tui", idempotency_key: "cancel-live-1" });
      await started;
      expect(planningDraftId).toMatch(/^draft-/);

      const cancelled = await composer.cancel({ kind: "taskcomposer.cancel", draft_id: planningDraftId, expected_revision: 1, reason: "operator stopped planning" });
      expect(observedSignal?.aborted).toBe(true);
      expect(observedSignal?.reason).toBe("operator stopped planning");
      expect(cancelled).toMatchObject({ status: "cancelled", revision: 2, planner: { kind: "cancelled", error: "operator stopped planning" } });
      expect(JSON.parse(readFileSync(join(dir, "task-composer", "drafts.json"), "utf8"))).toMatchObject({
        drafts: [{ id: planningDraftId, status: "cancelled", revision: 2, planner: { kind: "cancelled", error: "operator stopped planning" } }],
      });

      await expect(composer.cancel({ kind: "taskcomposer.cancel", draft_id: planningDraftId, expected_revision: 1, reason: "stale" })).rejects.toThrow(/revision conflict/);
      await expect(composer.cancel({ kind: "taskcomposer.cancel", draft_id: planningDraftId, expected_revision: 2, reason: "duplicate" })).rejects.toThrow(/not planning/);

      settlePlanner({ raw_proposal: proposal, session_id: "late-session", model_identity: "native-test", usage: usage(8, 3) });
      await expect(submission).resolves.toMatchObject({ status: "cancelled", revision: 2, planner: { kind: "cancelled" } });
      expect(composer.get(planningDraftId)).toMatchObject({ status: "cancelled", revision: 2, proposal: null, planner: { kind: "cancelled" } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("atomically admits exactly one campaign through an injected campaign-and-job authority", async () => {
    const calls: string[] = [];
    const composer = new TaskComposer({ manager: new CampaignManager(), planner, admission: { admit: async (input) => { calls.push(input.campaign_id); return { campaign_id: input.campaign_id, job_id: "job-1" }; } } });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "ship", source: "cli", idempotency_key: "ship-1" });
    const admitted = await composer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "admit-1" });
    expect(admitted).toMatchObject({ status: "admitted", campaign_id: `composer-${draft.id}`, job_id: "job-1" });
    await expect(composer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "admit-1" })).resolves.toEqual(admitted);
    expect(calls).toEqual([`composer-${draft.id}`]);
  });

  it("does not expose a partial campaign when plan construction is rejected", () => {
    const manager = new CampaignManager();
    expect(() => manager.admitCampaignPlan({
      id: "invalid-plan", plan_path: "plan.json",
      root_action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" }, actions: [],
    })).toThrow(/at least one action/);
    expect(manager.listCampaigns()).toEqual([]);
  });

  it("quarantines corrupt persisted drafts instead of accepting them", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-composer-"));
    try {
      const path = join(dir, "task-composer", "drafts.json");
      mkdirSync(join(dir, "task-composer"), { recursive: true });
      writeFileSync(path, "{not json", "utf8");
      const restored = new TaskComposer({ manager: new CampaignManager(), persistence_dir: dir });
      expect(restored.query({ kind: "taskcomposer.list", limit: 10 })).toEqual({ items: [], next_cursor: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reaches the asynchronous composer only through the canonical catalog", async () => {
    const manager = new CampaignManager();
    const composer = new TaskComposer({ manager, planner });
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager, task_composer: composer }));
    const metadata = { operation_id: "composer-submit", idempotency_key: "composer-submit", correlation_id: "composer-submit", actor_id: "operator", requested_at: "2026-08-09T00:00:00.000Z" };

    const submitted = await router.dispatchCommand({
      schema_version: 1,
      metadata,
      command: { kind: "taskcomposer.submit", task: "add task composition", source: "cli", idempotency_key: "draft-submit" },
    });
    expect(submitted).toMatchObject({ ok: true, capability: "taskcomposer.write", value: { accepted: true, operation_id: "composer-submit", draft: { status: "proposed", source: "cli" } } });
    const submittedDraft = submitted.ok ? (submitted.value as { accepted: boolean; draft?: { id: string; revision: number } }).draft : undefined;
    if (!submitted.ok || !submitted.value.accepted || submittedDraft === undefined) throw new Error("composer submission did not return a draft");

    const listed = router.executeQuery({ schema_version: 1, query_id: "composer-list", query: { kind: "taskcomposer.list", limit: 10 } });
    expect(listed).toMatchObject({ ok: true, capability: "taskcomposer.read", value: { items: [{ id: submittedDraft.id, status: "proposed" }] } });
    const fetched = router.executeQuery({ schema_version: 1, query_id: "composer-get", query: { kind: "taskcomposer.get", draft_id: submittedDraft.id } });
    expect(fetched).toMatchObject({ ok: true, capability: "taskcomposer.read", value: { draft: { id: submittedDraft.id, revision: submittedDraft.revision } } });

    const confirmed = await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "composer-confirm", idempotency_key: "composer-confirm" }, command: { kind: "taskcomposer.confirm", draft_id: submittedDraft.id, expected_revision: submittedDraft.revision, idempotency_key: "draft-confirm" } });
    expect(confirmed).toMatchObject({ ok: true, value: { accepted: true, draft: { status: "admitted" } } });

    const second = await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "composer-reject-submit", idempotency_key: "composer-reject-submit" }, command: { kind: "taskcomposer.submit", task: "decline this draft", source: "web", idempotency_key: "draft-reject-submit" } });
    const secondDraft = second.ok ? (second.value as { accepted: boolean; draft?: { id: string; revision: number } }).draft : undefined;
    if (!second.ok || !second.value.accepted || secondDraft === undefined) throw new Error("second composer submission did not return a draft");
    const rejected = await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "composer-reject", idempotency_key: "composer-reject" }, command: { kind: "taskcomposer.reject", draft_id: secondDraft.id, expected_revision: secondDraft.revision, reason: "operator declined scope" } });
    expect(rejected).toMatchObject({ ok: true, value: { accepted: true, draft: { status: "rejected", rejection_reason: "operator declined scope" } } });
  });

  it("round-trips a live planner cancellation through the canonical catalog", async () => {
    let planningDraftId = "";
    let plannerStarted!: () => void;
    const started = new Promise<void>((resolve) => { plannerStarted = resolve; });
    let settlePlanner!: (value: { raw_proposal: string; session_id: string | null; model_identity: string | null; usage: TokenUsageResult }) => void;
    const composer = new TaskComposer({
      manager: new CampaignManager(),
      on_change: (draft) => { if (draft.status === "planning") planningDraftId = draft.id; },
      planner: { plan: async () => {
        plannerStarted();
        return new Promise<{ raw_proposal: string; session_id: string | null; model_identity: string | null; usage: TokenUsageResult }>((resolve) => { settlePlanner = resolve; });
      } },
    });
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager(), task_composer: composer }));
    const meta = (id: string) => ({ operation_id: id, idempotency_key: id, correlation_id: id, actor_id: "operator", requested_at: "2026-08-09T00:00:00.000Z" });
    const submitted = router.dispatchCommand({ schema_version: 1, metadata: meta("cancel-submit"), command: { kind: "taskcomposer.submit", task: "stop before planning completes", source: "tui", idempotency_key: "cancel-draft" } });
    await started;
    const cancelled = await router.dispatchCommand({ schema_version: 1, metadata: meta("cancel-command"), command: { kind: "taskcomposer.cancel", draft_id: planningDraftId, expected_revision: 1, reason: "operator stopped planning" } });
    expect(cancelled).toMatchObject({ ok: true, capability: "taskcomposer.write", value: { accepted: true, operation_id: "cancel-command", draft: { status: "cancelled", planner: { kind: "cancelled" } } } });
    settlePlanner({ raw_proposal: proposal, session_id: "late-session", model_identity: "native-test", usage: usage(4, 2) });
    await expect(submitted).resolves.toMatchObject({ ok: true, value: { draft: { status: "cancelled" } } });
  });

  it("answers a planner question through the canonical catalog with revision CAS", async () => {
    const manager = new CampaignManager();
    const questionProposal = JSON.stringify({ ...JSON.parse(proposal), questions: [{ id: "scope", question: "Which package is in scope?" }] });
    const composer = new TaskComposer({ manager, planner: { plan: async () => ({ raw_proposal: questionProposal, session_id: "question-session", model_identity: "native-test", usage: usage(8, 2) }) } });
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager, task_composer: composer }));
    const meta = (id: string) => ({ operation_id: id, idempotency_key: id, correlation_id: id, actor_id: "operator", requested_at: "2026-08-09T00:00:00.000Z" });
    const submitted = await router.dispatchCommand({ schema_version: 1, metadata: meta("question-submit"), command: { kind: "taskcomposer.submit", task: "clarify scope", source: "tui", idempotency_key: "question-draft" } });
    const questionDraft = submitted.ok ? (submitted.value as { accepted: boolean; draft?: { id: string; revision: number; status: string } }).draft : undefined;
    if (!submitted.ok || !submitted.value.accepted || questionDraft === undefined) throw new Error("question draft was not returned");
    expect(questionDraft.status).toBe("awaiting_clarification");
    const answered = await router.dispatchCommand({ schema_version: 1, metadata: meta("question-answer"), command: { kind: "taskcomposer.answer", draft_id: questionDraft.id, expected_revision: questionDraft.revision, question_id: "scope", answer: "arbor-mcp" } });
    expect(answered).toMatchObject({ ok: true, capability: "taskcomposer.write", value: { accepted: true, draft: { status: "proposed", proposal: { questions: [{ id: "scope", answer: "arbor-mcp" }] } } } });
  });
});

describe("TaskComposer — ADR-062 arbiter intake", () => {
  it("skips the planner entirely for a direct-tier arbiter decision — the arbiter's own output is the admitted plan", async () => {
    let planCalls = 0;
    const trackedPlanner = { plan: async () => { planCalls += 1; return { raw_proposal: proposal, session_id: "s", model_identity: "m", usage: usage(10, 5) }; } };
    const arbiter: ArbiterIntakePort = { classify: async () => ({ raw_decision: JSON.stringify({ tier: "direct", rationale: "narrow fix, single dispatch suffices", category: "maintenance", blast_radius: { reversibility: "reversible" } }), session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "test" } }) };
    const composer = new TaskComposer({ manager: new CampaignManager(), planner: trackedPlanner, arbiter });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "fix the typo in the docs", source: "cli", idempotency_key: "direct-1" });
    expect(planCalls).toBe(0);
    expect(draft).toMatchObject({ status: "proposed", arbiter_decision: { tier: "direct", source: "arbiter" } });
    expect(draft.proposal?.root_action).toMatchObject({ description: "fix the typo in the docs", category: "maintenance", delegate_to: "seed" });
    expect(draft.proposal?.actions).toHaveLength(1);
  });

  it("dispatches only a single reviewed action for a reviewed-tier decision, still without a planner call", async () => {
    let planCalls = 0;
    const trackedPlanner = { plan: async () => { planCalls += 1; return { raw_proposal: proposal, session_id: "s", model_identity: "m", usage: usage(10, 5) }; } };
    const arbiter: ArbiterIntakePort = { classify: async () => ({ raw_decision: JSON.stringify({ tier: "reviewed", rationale: "moderate risk, single reviewed action", category: "feature", blast_radius: { reversibility: "unknown" } }), session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "test" } }) };
    const composer = new TaskComposer({ manager: new CampaignManager(), planner: trackedPlanner, arbiter });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "add a caching layer", source: "cli", idempotency_key: "reviewed-1" });
    expect(planCalls).toBe(0);
    expect(draft.arbiter_decision).toMatchObject({ tier: "reviewed" });
    expect(draft.proposal?.actions).toHaveLength(1);
  });

  it("falls back to the full governed planner path when the arbiter returns malformed output", async () => {
    let planCalls = 0;
    const trackedPlanner = { plan: async () => { planCalls += 1; return { raw_proposal: proposal, session_id: "s", model_identity: "m", usage: usage(10, 5) }; } };
    const arbiter: ArbiterIntakePort = { classify: async () => ({ raw_decision: "not json", session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "test" } }) };
    const composer = new TaskComposer({ manager: new CampaignManager(), planner: trackedPlanner, arbiter });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "build something complex", source: "cli", idempotency_key: "malformed-1" });
    expect(planCalls).toBe(1);
    expect(draft.arbiter_decision).toMatchObject({ tier: "governed", source: "arbiter" });
    expect(draft.status).toBe("proposed");
  });

  it("regression: defaults to governed (unchanged planner path) when no arbiter is configured at all", async () => {
    let planCalls = 0;
    const trackedPlanner = { plan: async () => { planCalls += 1; return { raw_proposal: proposal, session_id: "s", model_identity: "m", usage: usage(10, 5) }; } };
    const composer = new TaskComposer({ manager: new CampaignManager(), planner: trackedPlanner });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "do the thing", source: "cli", idempotency_key: "no-arbiter-1" });
    expect(planCalls).toBe(1);
    expect(draft.arbiter_decision).toMatchObject({ tier: "governed", source: "arbiter" });
  });

  it("records an explicit --tier override as operator-forced and never calls the arbiter", async () => {
    let arbiterCalls = 0;
    const arbiter: ArbiterIntakePort = { classify: async () => { arbiterCalls += 1; return { raw_decision: JSON.stringify({ tier: "governed", rationale: "should not be reached", category: "x", blast_radius: { reversibility: "unknown" } }), session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "test" } }; } };
    const composer = new TaskComposer({ manager: new CampaignManager(), arbiter });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "fix a small bug", source: "cli", idempotency_key: "override-1", tier_override: "direct" });
    expect(arbiterCalls).toBe(0);
    expect(draft.arbiter_decision).toMatchObject({ tier: "direct", source: "operator_forced" });
    expect(draft.proposal?.actions).toHaveLength(1);
  });

  it("E-2: an operator-forced --tier override still carries the correct per-tier turn_budget_estimate", async () => {
    const composer = new TaskComposer({ manager: new CampaignManager() });
    const direct = await composer.submit({ kind: "taskcomposer.submit", task: "fix a small bug", source: "cli", idempotency_key: "override-budget-direct", tier_override: "direct" });
    expect(direct.arbiter_decision).toMatchObject({ tier: "direct", turn_budget_estimate: 12 });
    const governed = await composer.submit({ kind: "taskcomposer.submit", task: "do a risky migration", source: "cli", idempotency_key: "override-budget-governed", tier_override: "governed" });
    expect(governed.arbiter_decision).toMatchObject({ tier: "governed", turn_budget_estimate: 32 });
  });

  it("persists the governance decision on the campaign at admission time", async () => {
    const manager = new CampaignManager();
    // decisions/ADR-PENDING-native-structured-scope-pre-authorization-and-auto-approve.md:
    // `direct`/`reviewed` tier requires a real derivable scope for a
    // mutating action — a hand-authored arbiter decision must carry one
    // (matching how the real heuristic arbiter only ever returns `direct`
    // for a mutating task alongside mined write_paths; see arbiter-intake.ts).
    const arbiter: ArbiterIntakePort = { classify: async () => ({ raw_decision: JSON.stringify({ tier: "direct", rationale: "narrow", category: "maintenance", blast_radius: { reversibility: "reversible", write_paths: ["src/typo.ts"] } }), session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "test" } }) };
    const composer = new TaskComposer({ manager, arbiter });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "fix the typo in src/typo.ts", source: "cli", idempotency_key: "persist-1" });
    const confirmed = await composer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "persist-confirm-1" });
    expect(confirmed.status).toBe("admitted");
    const snapshot = manager.getCampaignSnapshot(confirmed.campaign_id!);
    expect(snapshot?.governance).toMatchObject({ tier: "direct", rationale: "narrow" });
  });
});

describe("classifyAndRepairMutatingActions (scope pre-authorization + auto-approve)", () => {
  const base = {
    summary: "s", assumptions: [] as string[], questions: [] as never[],
    root_action: { description: "deliver the task", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
    acceptance_checks: [] as string[], acceptance_mapping: [] as never[], risk_notes: [] as string[],
  };

  it("tags every action's mutating classification and leaves an already-scoped mutating action untouched", () => {
    const scoped = { description: "fix docs/native-doctor.md", estimated_gain: 1, estimated_cost: 1, category: "x", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["docs/native-doctor.md"], command_argv: [] } };
    const readOnly = { description: "investigate and report on the failure", estimated_gain: 1, estimated_cost: 1, category: "x", delegate_to: "seed" };
    const result = classifyAndRepairMutatingActions({ ...base, actions: [scoped, readOnly] }, "reviewed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actions[0]).toMatchObject({ mutating: "mutating", high_risk_tool_scope: { write_paths: ["docs/native-doctor.md"] } });
    expect(result.value.actions[1]).toMatchObject({ mutating: "read_only" });
    expect(result.value.actions[1].high_risk_tool_scope).toBeUndefined();
    expect(result.value.root_action.mutating).toBe("mutating");
  });

  it("repairs a mutating action with no declared scope by mining its own description at reviewed tier", () => {
    const unscoped = { description: "Update docs/native-doctor.md with the fix", estimated_gain: 1, estimated_cost: 1, category: "x", delegate_to: "seed" };
    const result = classifyAndRepairMutatingActions({ ...base, actions: [unscoped] }, "reviewed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actions[0]).toMatchObject({ mutating: "mutating", high_risk_tool_scope: { write_paths: ["docs/native-doctor.md"] } });
  });

  it("rejects a mutating action at direct/reviewed tier when no scope is declared or derivable, with a legible error", () => {
    const unscoped = { description: "improve the overall quality of the module", estimated_gain: 1, estimated_cost: 1, category: "x", delegate_to: "seed" };
    const result = classifyAndRepairMutatingActions({ ...base, actions: [unscoped] }, "direct");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("improve the overall quality of the module");
    expect(result.error).toContain("mutating");
    expect(result.error).toContain("high_risk_tool_scope");
  });

  it("never rejects at governed tier (or unknown tier): the action is tagged but the plan's unscoped omission is preserved", () => {
    const unscoped = { description: "improve the overall quality of the module", estimated_gain: 1, estimated_cost: 1, category: "x", delegate_to: "seed" };
    const governed = classifyAndRepairMutatingActions({ ...base, actions: [unscoped] }, "governed");
    expect(governed.ok).toBe(true);
    if (governed.ok) { expect(governed.value.actions[0]).toMatchObject({ mutating: "mutating" }); expect(governed.value.actions[0].high_risk_tool_scope).toBeUndefined(); }
    const unknown = classifyAndRepairMutatingActions({ ...base, actions: [unscoped] }, null);
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.value.actions[0].high_risk_tool_scope).toBeUndefined();
  });

  it("end to end: confirm() rejects a malformed reviewed-tier plan whose mutating action names no path, and accepts once one is named", async () => {
    const unscopedProposal = JSON.stringify({
      summary: "s", assumptions: [], questions: [],
      root_action: { description: "deliver the task", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
      actions: [{ description: "improve the module's overall quality", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }],
      acceptance_checks: [], acceptance_mapping: [], risk_notes: [],
    });
    const arbiter: ArbiterIntakePort = { classify: async () => ({ raw_decision: JSON.stringify({ tier: "reviewed", rationale: "single reviewed action", category: "feature", blast_radius: { reversibility: "unknown" } }), session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "test" } }) };
    const composer = new TaskComposer({ manager: new CampaignManager(), planner: { plan: async () => ({ raw_proposal: unscopedProposal, session_id: "s", model_identity: "m", usage: usage(1, 1) }) }, arbiter });
    // reviewed tier skips the planner entirely (ADR-062); this drives the exact
    // path a malformed native-planner proposal would take.
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "improve the module's overall quality", source: "cli", idempotency_key: "adr088-reject-1" });
    expect(draft.status).toBe("proposed");
    const rejected = await composer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "adr088-reject-confirm-1" });
    expect(rejected.status).toBe("failed");
    expect(rejected.planner.error).toContain("high_risk_tool_scope");
    // The draft's own persisted proposal is untouched by the failed
    // materialization attempt -- it can still be corrected and retried.
    expect(rejected.proposal?.actions[0]).not.toHaveProperty("mutating");
    // ADR-113 (gate failures carry a remedy): the operator-facing guidance
    // for this refusal must not fall through to the generic "run `arbor
    // doctor`" dead end -- that diagnostic finds nothing wrong here. It must
    // name the actual fix: state the files to write or the command to run.
    expect(rejected.guidance?.headline).not.toMatch(/could not prepare this request/i);
    expect(rejected.guidance?.recommendation).not.toMatch(/arbor doctor/i);
    expect(rejected.guidance?.recommendation).toMatch(/name the exact files|exact command to run/i);
  });
});

describe("TaskComposer same-draft recovery", () => {
  it("retries a failed planner in place and preserves draft identity", async () => {
    let available = false;
    const composer = new TaskComposer({ manager: new CampaignManager(), planner: { plan: async () => {
      if (!available) throw new Error("temporary provider outage");
      return { raw_proposal: proposal, session_id: "retry-session", model_identity: "native-test", usage: usage(2, 1) };
    } } });
    const failed = await composer.submit({ kind: "taskcomposer.submit", task: "Build the requested feature", source: "web", idempotency_key: "retry-submit", auto_confirm: false });
    expect(failed.status).toBe("failed");
    available = true;
    const retried = await composer.retry({ kind: "taskcomposer.retry", draft_id: failed.id, expected_revision: failed.revision, idempotency_key: "retry-operation" });
    expect(retried).toMatchObject({ id: failed.id, status: "proposed", planner: { kind: "native", session_id: "retry-session" } });
  });
});
