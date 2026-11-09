import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { ArborMCPServer } from "../src/server.js";
import type { TaskComposerPlannerPort } from "../src/task-composer.js";
import type { TaskComposerDraft } from "../src/task-composer-contracts.js";

/**
 * audit/2026-09-06-remediation/manifest.md, Declared capability gaps / Retry:
 * "Failed task -> operator retry -> distinct bounded attempt -> persisted
 * lineage -> correct outcome."
 *
 * `packages/arbor-mcp/tests/roundtrip/manifest.ts` (capabilities:
 * ["taskcomposer.retry"], gap G-?) records precisely what is missing:
 * "TaskComposer's focused same-draft recovery test proves retry preserves
 * draft identity, but currently invokes the service directly. An outermost
 * RuntimeCatalogRouter retry-to-taskcomposer.get/list projection remains
 * required before this capability can be claimed as a landed roundtrip." That
 * referenced test (`task-composer.test.ts`, "TaskComposer same-draft
 * recovery") calls `composer.retry(...)` on the `TaskComposer` instance
 * directly — never through `RuntimeCatalogRouter`, so it says nothing about
 * whether a real client (`arbor_command`/`arbor_query`, the same surface
 * `cli.ts`'s JSON-RPC methods and `webui.ts`'s HTTP routes use) can actually
 * drive a retry and observe its outcome.
 *
 * This file drives the full trajectory through that real client surface:
 * dispatch `taskcomposer.submit` (fails: the injected planner throws on its
 * first call), dispatch `taskcomposer.retry` (a genuinely distinct attempt:
 * the planner's second call returns a different, successful result), then
 * confirm via `taskcomposer.get`/`taskcomposer.list` — including after a
 * restart — that the SAME draft identity now shows the retried outcome, with
 * a revision number that has strictly advanced (the durable, restart-surviving
 * record of "attempt N+1 supersedes attempt N" for this draft's identity).
 */

const root = "Build the requested feature";

function proposalJson(): string {
  return JSON.stringify({
    summary: "implement the requested change", assumptions: [], questions: [],
    root_action: { description: "deliver the task", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
    actions: [{ description: "implement and verify", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }],
    acceptance_checks: ["tests pass"], acceptance_mapping: [{ criterion: "tests pass", action_descriptions: ["implement and verify"] }], risk_notes: [],
  });
}

/**
 * `TaskComposer.plan()` already retries a throwing/malformed planner call up
 * to `MAX_PLAN_ATTEMPTS` (3) times WITHIN one `submit`/`retry` dispatch — that
 * is provider-transport retry, not the operator-level `taskcomposer.retry`
 * this test targets. To reach a genuine `status: "failed"` draft that needs
 * an OPERATOR retry, this mock must exhaust all 3 in-dispatch attempts during
 * `submit`, then succeed on the first call `retry` makes — a real, distinct
 * second dispatch, not a replay of the failed one.
 */
function flakyThenSucceedsPlanner(): TaskComposerPlannerPort {
  let calls = 0;
  return {
    plan: async () => {
      calls += 1;
      if (calls <= 3) throw new Error("temporary provider outage");
      return {
        raw_proposal: proposalJson(),
        session_id: `session-attempt-${calls}`,
        model_identity: "native-test",
        usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" },
      };
    },
  };
}

function draftOf(value: unknown): TaskComposerDraft {
  return (value as { value: { draft: TaskComposerDraft } }).value.draft;
}

describe("taskcomposer.retry is reachable through RuntimeCatalogRouter and produces a persisted, restart-surviving lineage", () => {
  it("dispatchCommand(taskcomposer.retry) supersedes the failed attempt in place with an advanced revision, projected via taskcomposer.get/list", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-s06-retry-"));
    try {
      const server = new ArborMCPServer(new ArborRuntime({ persistence_dir: persistence, task_composer_planner: flakyThenSucceedsPlanner() }));

      // 1. Failed task: the real client surface submits a task whose only
      // planner attempt throws. `taskcomposer.write` accepts the command
      // (it is a well-formed submission); the FAILURE lives in the projected
      // draft state, exactly like a real provider outage would produce.
      const submitted = draftOf(await server.callTool("arbor_command", {
        kind: "taskcomposer.submit", task: root, source: "cli", idempotency_key: "s06-retry-submit",
      }));
      expect(submitted.status).toBe("failed");
      expect(submitted.planner.error).toContain("temporary provider outage");
      const failedRevision = submitted.revision;

      // Confirm the failure through the query surface too, not just the
      // command's own echoed return value.
      const gotFailed = draftOf(await server.callTool("arbor_query", { kind: "taskcomposer.get", draft_id: submitted.id }));
      expect(gotFailed).toMatchObject({ id: submitted.id, status: "failed", revision: failedRevision });

      // 2. Operator retry -> 3. distinct bounded attempt: the SAME draft
      // identity, a NEW planner call (the mock's second, successful
      // response — not a replay of the first attempt's failure) reached
      // through `RuntimeCatalogRouter.dispatchCommand`, not the service.
      const retried = draftOf(await server.callTool("arbor_command", {
        kind: "taskcomposer.retry", draft_id: submitted.id, expected_revision: failedRevision, idempotency_key: "s06-retry-attempt-1",
      }));
      expect(retried.id).toBe(submitted.id);
      expect(retried.status).toBe("proposed");
      expect(retried.planner).toMatchObject({ kind: "native", session_id: "session-attempt-4" });
      expect(retried.revision).toBeGreaterThan(failedRevision);

      // 4. Correct outcome, projected through taskcomposer.get: the CURRENT
      // state for this draft identity is the retried outcome, not the
      // stale failed one.
      const gotRetried = draftOf(await server.callTool("arbor_query", { kind: "taskcomposer.get", draft_id: submitted.id }));
      expect(gotRetried).toMatchObject({ id: submitted.id, status: "proposed", revision: retried.revision });

      // taskcomposer.list must agree: exactly one draft under this identity,
      // at the retried revision — no orphaned duplicate from the retry.
      const listed = (await server.callTool("arbor_query", { kind: "taskcomposer.list", limit: 50 })) as { value: { items: TaskComposerDraft[] } };
      const matches = listed.value.items.filter((item) => item.id === submitted.id);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ status: "proposed", revision: retried.revision });

      // Persisted lineage: a fresh server (simulating a restart) reconnecting
      // through the identical catalog surface sees the SAME identity at the
      // SAME advanced revision and outcome — the retry relationship (this
      // draft superseded its failed attempt) is durable, not process-local.
      const restarted = new ArborMCPServer(new ArborRuntime({ persistence_dir: persistence, task_composer_planner: flakyThenSucceedsPlanner() }));
      const afterRestart = draftOf(await restarted.callTool("arbor_query", { kind: "taskcomposer.get", draft_id: submitted.id }));
      expect(afterRestart).toMatchObject({ id: submitted.id, status: "proposed", revision: retried.revision });
      expect(afterRestart.planner).toMatchObject({ kind: "native", session_id: "session-attempt-4" });
    } finally {
      rmSync(persistence, { recursive: true, force: true });
    }
  });

  it("rejects a retry of a draft that is not failed/cancelled, closing the accidental-double-retry path", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-s06-retry-guard-"));
    try {
      const server = new ArborMCPServer(new ArborRuntime({ persistence_dir: persistence, task_composer_planner: flakyThenSucceedsPlanner() }));
      const submitted = draftOf(await server.callTool("arbor_command", {
        kind: "taskcomposer.submit", task: root, source: "cli", idempotency_key: "s06-retry-guard-submit",
      }));
      expect(submitted.status).toBe("failed");
      const retried = draftOf(await server.callTool("arbor_command", {
        kind: "taskcomposer.retry", draft_id: submitted.id, expected_revision: submitted.revision, idempotency_key: "s06-retry-guard-1",
      }));
      expect(retried.status).toBe("proposed");

      // A second retry of the now-"proposed" (not failed/cancelled) draft
      // must be refused by TaskComposer's own guard, surfaced through the
      // router as a real command failure — not silently accepted or
      // silently replaying the prior outcome.
      const secondRetry = await server.callTool("arbor_command", {
        kind: "taskcomposer.retry", draft_id: submitted.id, expected_revision: retried.revision, idempotency_key: "s06-retry-guard-2",
      }) as { ok: boolean; value?: { accepted: boolean; error?: { summary?: string } } };
      expect(secondRetry.ok).toBe(true);
      expect(secondRetry.value?.accepted).toBe(false);
      expect(secondRetry.value?.error?.summary).toMatch(/is not retryable/);
    } finally {
      rmSync(persistence, { recursive: true, force: true });
    }
  });
});
