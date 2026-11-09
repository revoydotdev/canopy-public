import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignManager } from "../src/manager.js";
import { TaskComposer, type TaskComposerOptions, type TaskComposerPlannerPort } from "../src/task-composer.js";
import { validateTaskComposerCommand, type TaskComposerDraft } from "../src/task-composer-contracts.js";

const usage = { input_tokens: 7, output_tokens: 11, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" as const };
const response = { text: "The reference describes a disposable project. I have not independently inspected it.", error: null, session_id: "reference-session", model_identity: "test-native", usage };
const submit = { kind: "taskcomposer.submit" as const, mode: "answer" as const, task: "Explain this reference; do not change the repository.", source: "tui" as const, idempotency_key: "reference-query", auto_confirm: true };
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), "revoy-reference-answer-")); temporary.push(path); return path; }
function setup(options: Partial<TaskComposerOptions> = {}) {
  const plan = vi.fn(async () => { throw new Error("Answer request reached campaign planning"); });
  const answer_reference = vi.fn(async () => response);
  const admit = vi.fn(async () => { throw new Error("Answer request reached campaign admission"); });
  const composer = new TaskComposer({ manager: new CampaignManager(), planner: { plan, answer_reference }, admission: { admit }, ...options });
  return { composer, plan, answer_reference, admit };
}

describe("read-only reference answer lifecycle", () => {
  it("preserves explicit answer mode through validation and rejects mixed execution authority", () => {
    expect(validateTaskComposerCommand(submit)).toMatchObject({ ok: true, value: { mode: "answer" } });
    expect(validateTaskComposerCommand({ ...submit, mode: "anything" }).ok).toBe(false);
    expect(validateTaskComposerCommand({ ...submit, tier_override: "direct" }).ok).toBe(false);
    expect(validateTaskComposerCommand({ ...submit, command: { name: "write", execution_role: "architect", allowed_tools: [], skill_id: null } }).ok).toBe(false);
  });

  it("returns a claimed answer without a proposal, classification, or campaign, even with auto-confirm requested", async () => {
    const { composer, plan, answer_reference, admit } = setup();
    const draft = await composer.dispatch(submit);
    expect(draft).toMatchObject({ mode: "answer", status: "answered", auto_confirm: false, proposal: null, arbiter_decision: null, campaign_id: null, job_id: null,
      reference_answer: { text: response.text, provenance: { tag: "claimed", claimant: "native-reference-answer" } },
      planner: { session_id: response.session_id, usage }, guidance: { headline: "Reference answer", retryable: false } });
    expect(answer_reference).toHaveBeenCalledOnce();
    expect(answer_reference.mock.calls[0]).toBeDefined();
    expect(plan).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    await expect(composer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "force-confirm" })).rejects.toThrow(/cannot be confirmed/);
    await expect(composer.answer({ kind: "taskcomposer.answer", draft_id: draft.id, expected_revision: draft.revision, question_id: "injected", answer: "approve" })).rejects.toThrow(/cannot enter campaign clarification/);
    await expect(composer.reject({ kind: "taskcomposer.reject", draft_id: draft.id, expected_revision: draft.revision, reason: "not a plan" })).rejects.toThrow(/no campaign proposal/);
  });

  it("binds mode into idempotency and never calls the provider twice on replay", async () => {
    const { composer, answer_reference, admit } = setup();
    const draft = await composer.submit(submit);
    expect(await composer.submit(submit)).toEqual(draft);
    await expect(composer.submit({ ...submit, mode: "execute" })).rejects.toThrow(/idempotency/);
    expect(answer_reference).toHaveBeenCalledOnce();
    expect(admit).not.toHaveBeenCalled();
  });

  it("fails closed without a native answer port, rather than falling back to a planner", async () => {
    const plan = vi.fn(async () => { throw new Error("unexpected planner"); });
    const { composer, admit } = setup({ planner: { plan } });
    expect(await composer.submit(submit)).toMatchObject({ status: "failed", mode: "answer", proposal: null, campaign_id: null, planner: { kind: "unavailable", error: expect.stringContaining("no enforced read-only answer port") } });
    expect(plan).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("aborts cancellation and ignores a provider that returns a late answer", async () => {
    let finish!: (value: typeof response) => void;
    let signal: AbortSignal | undefined;
    const changes: TaskComposerDraft[] = [];
    const answer_reference: NonNullable<TaskComposerPlannerPort["answer_reference"]> = async input => {
      signal = input.signal;
      return new Promise(resolve => { finish = resolve; });
    };
    const { composer, admit } = setup({ planner: { plan: async () => { throw new Error("unexpected plan"); }, answer_reference }, on_change: draft => { changes.push(draft); } });
    const pending = composer.submit(submit);
    const working = changes[0]!;
    const cancelled = await composer.cancel({ kind: "taskcomposer.cancel", draft_id: working.id, expected_revision: working.revision, reason: "operator stopped answer" });
    expect(signal?.aborted).toBe(true);
    finish(response);
    expect(await pending).toEqual(cancelled);
    expect(composer.get(working.id)).toMatchObject({ status: "cancelled", mode: "answer", reference_answer: null, campaign_id: null });
    expect(admit).not.toHaveBeenCalled();
  });

  it("retains failure usage and retries only the answer port", async () => {
    const answer_reference = vi.fn<NonNullable<TaskComposerPlannerPort["answer_reference"]>>()
      .mockResolvedValueOnce({ ...response, text: null, error: "provider deadline" })
      .mockResolvedValueOnce(response);
    const plan = vi.fn(async () => { throw new Error("unexpected plan"); });
    const { composer, admit } = setup({ planner: { plan, answer_reference } });
    const failed = await composer.submit(submit);
    expect(failed).toMatchObject({ status: "failed", planner: { usage, session_id: response.session_id } });
    const command = { kind: "taskcomposer.retry" as const, draft_id: failed.id, expected_revision: failed.revision, idempotency_key: "retry-reference" };
    const answered = await composer.retry(command);
    expect(answered).toMatchObject({ id: failed.id, status: "answered", mode: "answer", auto_confirm: false, campaign_id: null, planner: { usage: { input_tokens: 14, output_tokens: 22 } } });
    expect(await composer.retry(command)).toEqual(answered);
    expect(answer_reference).toHaveBeenCalledTimes(2);
    expect(plan).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it.each(["", "x".repeat(65_537)])("rejects an empty or oversized provider answer", async text => {
    const { composer } = setup({ planner: { plan: async () => { throw new Error("unexpected plan"); }, answer_reference: async () => ({ ...response, text }) } });
    expect(await composer.submit(submit)).toMatchObject({ status: "failed", reference_answer: null, planner: { usage, error: expect.stringContaining("no bounded answer") } });
  });

  it("restores answered drafts without replaying them or making them confirmable", async () => {
    const path = directory();
    const first = setup({ persistence_dir: path });
    const draft = await first.composer.submit(submit);
    const restored = setup({ persistence_dir: path });
    expect(restored.composer.get(draft.id)).toEqual(draft);
    expect(await restored.composer.submit(submit)).toEqual(draft);
    expect(restored.answer_reference).not.toHaveBeenCalled();
    await expect(restored.composer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "restore-confirm" })).rejects.toThrow(/cannot be confirmed/);
  });

  it("restores interrupted answers as failed and preserves their mode on explicit retry", async () => {
    const path = directory();
    const changes: TaskComposerDraft[] = [];
    let finish!: (value: typeof response) => void;
    const first = setup({ persistence_dir: path, planner: { plan: async () => { throw new Error("unexpected plan"); }, answer_reference: () => new Promise(resolve => { finish = resolve; }) }, on_change: draft => { changes.push(draft); } });
    const pending = first.composer.submit(submit);
    const restored = setup({ persistence_dir: path });
    const interrupted = restored.composer.get(changes[0]!.id)!;
    expect(interrupted).toMatchObject({ status: "failed", mode: "answer", auto_confirm: false, reference_answer: null });
    // Stop the original in-memory worker before writing through the restored owner.
    await first.composer.cancel({ kind: "taskcomposer.cancel", draft_id: changes[0]!.id, expected_revision: 1, reason: "test process stopped" });
    finish(response);
    await pending;
    const answered = await restored.composer.retry({ kind: "taskcomposer.retry", draft_id: interrupted.id, expected_revision: interrupted.revision, idempotency_key: "restore-retry" });
    expect(answered).toMatchObject({ status: "answered", mode: "answer", campaign_id: null });
    expect(restored.plan).not.toHaveBeenCalled();
  });

  it.each(["mode", "auto_confirm", "provenance"])("quarantines corrupt persisted answer authority: %s", async field => {
    const path = directory();
    const first = setup({ persistence_dir: path });
    const draft = await first.composer.submit(submit);
    const storePath = join(path, "task-composer", "drafts.json");
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    if (field === "mode") delete store.drafts[0].mode;
    if (field === "auto_confirm") store.drafts[0].auto_confirm = true;
    if (field === "provenance") store.drafts[0].reference_answer.provenance.tag = "verified";
    writeFileSync(storePath, JSON.stringify(store));
    const restored = setup({ persistence_dir: path });
    expect(restored.composer.get(draft.id)).toBeNull();
    expect(restored.plan).not.toHaveBeenCalled();
    expect(restored.admit).not.toHaveBeenCalled();
  });
});
