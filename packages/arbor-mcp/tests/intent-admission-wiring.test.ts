import { describe, expect, it } from "vitest";
import type { TokenUsageResult } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { TaskComposer } from "../src/task-composer.js";

/**
 * Real-surface wiring tests for ADR-062's `intent-admission.ts`/
 * `intent-lifecycle.ts` (built, previously reached by no production
 * caller). Every case here drives `TaskComposer`'s actual command surface
 * (`submit`/`confirm`/`cancel`/`retry` — the same entry points
 * `RuntimeCatalogRouter`'s MCP tool dispatch uses), never the pure
 * `intent-admission-bridge.ts`/`@arbor/core` functions directly, and reads
 * the outcome back through `TaskComposer.getIntentLedger`, the one real
 * read surface this wiring adds.
 */

const governedProposal = JSON.stringify({
  summary: "implement the requested change", assumptions: [], questions: [],
  root_action: { description: "deliver the task", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
  actions: [{ description: "implement and verify", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }],
  acceptance_checks: ["tests pass"], acceptance_mapping: [{ criterion: "tests pass", action_descriptions: ["implement and verify"] }], risk_notes: [],
});
function usage(inputTokens: number, outputTokens: number): TokenUsageResult {
  return { input_tokens: inputTokens, output_tokens: outputTokens, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" };
}
const governedPlanner = { plan: async () => ({ raw_proposal: governedProposal, session_id: "plan-session", model_identity: "native-test", usage: usage(10, 5) }) };

describe("intent-admission wiring: real TaskComposer surface", () => {
  it("a direct-tier submission (no planner round trip) opens a durable ledger and dispatches it on confirm", async () => {
    const composer = new TaskComposer({ manager: new CampaignManager(), admission: { admit: async ({ campaign_id }) => ({ campaign_id, job_id: "job-direct-1" }) } });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "fix a small bug in src/foo.ts", source: "cli", idempotency_key: "wiring-direct-1", tier_override: "direct" });
    expect(draft.status).toBe("proposed");

    const ledgerAfterProposal = composer.getIntentLedger(draft.id);
    expect(ledgerAfterProposal?.records.map((record) => record.kind)).toEqual(["intent.decided", "intent.reviewed"]);

    const confirmed = await composer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "wiring-direct-1-confirm" });
    expect(confirmed.status).toBe("admitted");

    const ledger = composer.getIntentLedger(draft.id);
    expect(ledger).not.toBeNull();
    expect(ledger!.intent_id).toBe(`${draft.id}:1`);
    expect(ledger!.records.map((record) => record.kind)).toEqual(["intent.decided", "intent.reviewed", "intent.dispatched"]);
    const dispatched = ledger!.records.at(-1);
    expect(dispatched).toMatchObject({ kind: "intent.dispatched", operation_id: "job-direct-1", agent_id: "seed" });
    const decided = ledger!.records[0];
    expect(decided).toMatchObject({ kind: "intent.decided", sequence: 0 });
    if (decided?.kind === "intent.decided") {
      expect(decided.decision.classification).toBe("change"); // "fix" -> the change verb
      expect(decided.decision.confidence).toBe("high"); // direct tier
      expect(decided.decision.disposition).toBe("admit");
    }
  });

  it("a governed submission that requires the full planner round trip records a plan record before review/dispatch", async () => {
    const composer = new TaskComposer({ manager: new CampaignManager(), planner: governedPlanner, admission: { admit: async ({ campaign_id }) => ({ campaign_id, job_id: "job-governed-1" }) } });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "ship", source: "cli", idempotency_key: "wiring-governed-1" });
    expect(draft.status).toBe("proposed"); // no arbiter configured -> defaults to governed (classifyGovernanceTier's own safe fallback)
    expect(draft.arbiter_decision?.tier).toBe("governed");

    const confirmed = await composer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "wiring-governed-1-confirm" });
    expect(confirmed.status).toBe("admitted");

    const ledger = composer.getIntentLedger(draft.id);
    expect(ledger!.records.map((record) => record.kind)).toEqual(["intent.decided", "intent.planned", "intent.reviewed", "intent.dispatched"]);
    const planned = ledger!.records[1];
    expect(planned).toMatchObject({ kind: "intent.planned", plan_id: draft.id });
  });

  it("a request with no explicit admission verb is admitted (unchanged composer behavior) but the refusal reason is surfaced, not silently dropped", async () => {
    // "ship" contains no verb from intent-admission.ts's build/change/research/
    // explain/review/operate vocabulary. A hard block here would refuse a
    // large fraction of today's valid free-text submissions (see
    // task-composer.ts's `admitIntent` doc comment), so the composer's own
    // status is untouched -- but the operator-visible rationale records
    // exactly why intent-admission itself would ask for clarification.
    const composer = new TaskComposer({ manager: new CampaignManager(), admission: { admit: async ({ campaign_id }) => ({ campaign_id, job_id: "job-ambiguous-1" }) } });
    const draft = await composer.submit({ kind: "taskcomposer.submit", task: "ship", source: "cli", idempotency_key: "wiring-ambiguous-1", tier_override: "direct" });
    expect(draft.status).toBe("proposed");
    expect(draft.arbiter_decision?.rationale).toMatch(/intent-admission requests clarification/);
    expect(draft.arbiter_decision?.rationale).toMatch(/ambiguous/);
  });

  it("cancelling a still-planning draft closes its intent ledger with a typed, operator-visible refusal", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let settlePlanner!: (value: { raw_proposal: string; session_id: string | null; model_identity: string | null; usage: TokenUsageResult }) => void;
    let planningDraftId = "";
    const composer = new TaskComposer({
      manager: new CampaignManager(),
      planner: {
        plan: async (input) => {
          planningDraftId = input.draft_id;
          started();
          return new Promise((resolve) => { settlePlanner = resolve; });
        },
      },
    });
    const submission = composer.submit({ kind: "taskcomposer.submit", task: "research and describe the legacy pipeline", source: "tui", idempotency_key: "wiring-cancel-1" });
    await startedPromise;
    expect(planningDraftId).toMatch(/^draft-/);

    const cancelled = await composer.cancel({ kind: "taskcomposer.cancel", draft_id: planningDraftId, expected_revision: 1, reason: "operator stopped planning" });
    expect(cancelled.status).toBe("cancelled");

    const ledger = composer.getIntentLedger(planningDraftId);
    expect(ledger!.records.map((record) => record.kind)).toEqual(["intent.decided", "intent.refused"]);
    const refused = ledger!.records.at(-1);
    expect(refused).toMatchObject({ kind: "intent.refused", from_phase: "intent", refusal: { reason: "operator stopped planning", retryable: true } });

    settlePlanner({ raw_proposal: governedProposal, session_id: "late", model_identity: "native-test", usage: usage(1, 1) });
    await submission;
  });

  it("retrying a failed draft opens a fresh intent (resetIntentTurn), not a reopened terminal ledger", async () => {
    let available = false;
    const composer = new TaskComposer({ manager: new CampaignManager(), planner: { plan: async () => {
      if (!available) throw new Error("temporary provider outage");
      return { raw_proposal: governedProposal, session_id: "retry-session", model_identity: "native-test", usage: usage(2, 1) };
    } } });
    const failed = await composer.submit({ kind: "taskcomposer.submit", task: "Build the requested feature", source: "web", idempotency_key: "wiring-retry-submit" });
    expect(failed.status).toBe("failed");

    const firstLedger = composer.getIntentLedger(failed.id);
    expect(firstLedger!.intent_id).toBe(`${failed.id}:1`);
    expect(firstLedger!.records.at(-1)?.kind).toBe("intent.refused");

    available = true;
    const retried = await composer.retry({ kind: "taskcomposer.retry", draft_id: failed.id, expected_revision: failed.revision, idempotency_key: "wiring-retry-operation" });
    expect(retried.status).toBe("proposed");

    const secondLedger = composer.getIntentLedger(failed.id);
    expect(secondLedger!.intent_id).not.toBe(firstLedger!.intent_id);
    expect(secondLedger!.records.map((record) => record.kind)).toEqual(["intent.decided", "intent.planned", "intent.reviewed"]);
  });

  it("persists the ledger to disk under persistence_dir and reloads it via parseIntentLedger on restore", async () => {
    const { mkdtempSync, rmSync, readdirSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "intent-ledger-wiring-"));
    try {
      const composer = new TaskComposer({ manager: new CampaignManager(), persistence_dir: dir, admission: { admit: async ({ campaign_id }) => ({ campaign_id, job_id: "job-disk-1" }) } });
      const draft = await composer.submit({ kind: "taskcomposer.submit", task: "fix the typo in src/typo.ts", source: "cli", idempotency_key: "wiring-disk-1", tier_override: "direct" });
      await composer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "wiring-disk-1-confirm" });

      const ledgerFiles = readdirSync(join(dir, "intent-ledger"));
      const snapshotFile = ledgerFiles.find((name) => name.endsWith(".json"));
      const jsonlFile = ledgerFiles.find((name) => name.endsWith(".jsonl"));
      expect(snapshotFile).toBeDefined();
      expect(jsonlFile).toBeDefined();

      // A fresh TaskComposer over the same directory has no in-process
      // admission state for this draft -- getIntentLedger only answers for
      // an intent this process actually ran admission for -- so this reads
      // the snapshot file directly through the same `parseIntentLedger`
      // the store's restore path uses, proving the on-disk artifact is a
      // real, replayable ledger and not just a write-only log.
      const { parseIntentLedger } = await import("@arbor/core");
      const snapshot = JSON.parse(readFileSync(join(dir, "intent-ledger", snapshotFile!), "utf8"));
      const replayed = parseIntentLedger(snapshot);
      expect(replayed).not.toBeNull();
      expect(replayed!.records.map((record) => record.kind)).toEqual(["intent.decided", "intent.reviewed", "intent.dispatched"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
