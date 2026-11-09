import { describe, expect, it } from "vitest";
import { createSeededRng, hashSeed, replaySearchStep, SearchContractError } from "@arbor/core";
import type { SearchConfig, SearchLedgerEvent, SearchPolicyConfig, SearchRewardInput } from "@arbor/core";
import { runSearchStep } from "../src/index.js";
import type { SearchAttemptDispatcher, SearchAttemptRequest, SearchLedgerSink } from "../src/index.js";

const VERIFIED = { tag: "verified", cmd: "bun run test", exit: 0, stdout_hash: "sha256:fixture" } as const;

const POLICIES: readonly SearchPolicyConfig[] = [
  { kind: "abmcts_beta", prior: { alpha: 1, beta: 1 }, virtual_loss: 1 },
  { kind: "puct", c_puct: 1, q_init: 0.5, gen_prior_weight: 1 },
  { kind: "arbor_eq1", score_context: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0 }, score_config: { exploration_constant: Math.SQRT2 } },
  { kind: "best_of_n" },
  { kind: "refine_chain" },
];

function config(policy: SearchPolicyConfig, maxAttempts = 10): SearchConfig {
  return {
    policy,
    seed: "runtime",
    budget: { max_usd: 100, max_attempts: maxAttempts },
    max_refine_depth: 3,
    max_width: null,
    step_prior: { estimated_gain: 1, estimated_cost: 1, category: "fix" },
  };
}

function memoryLedger(): SearchLedgerSink & { readonly events: SearchLedgerEvent[] } {
  const events: SearchLedgerEvent[] = [];
  return { events, append: async (event) => { events.push(structuredClone(event)); } };
}

/** Async dispatcher whose outcomes come from a seeded stream; verifies with probability p. */
function seededDispatcher(seed: string, p: number, ledger: { readonly events: SearchLedgerEvent[] }): SearchAttemptDispatcher & { readonly requests: SearchAttemptRequest[] } {
  const rng = createSeededRng(hashSeed(seed));
  const requests: SearchAttemptRequest[] = [];
  return {
    requests,
    dispatch: async (request) => {
      // Write-ahead: the decision is durable before the attempt starts.
      const last = ledger.events[ledger.events.length - 1];
      expect(last).toEqual({ kind: "decision", record: request.decision });
      requests.push(request);
      await Promise.resolve();
      const verified = rng.nextUniform() < p;
      return { attempt_id: request.attempt_id, reward: verified ? 1 : 0.8 * rng.nextUniform(), verification: verified ? VERIFIED : null, cost_usd: 0.02 };
    },
  };
}

describe("runSearchStep", () => {
  it("drives every policy to a stop and leaves a ledger that replays exactly", async () => {
    for (const policy of POLICIES) {
      for (const seed of ["s1", "s2", "s3", "s4"]) {
        const ledger = memoryLedger();
        const dispatcher = seededDispatcher(`${policy.kind}:${seed}`, 0.15, ledger);
        const result = await runSearchStep({ step_id: `step-${seed}`, config: config(policy), dispatcher, ledger });
        expect(["verified", "attempt_cap"]).toContain(result.stop_reason);
        expect(ledger.events).toHaveLength(2 * result.state.attempts.length);
        expect(dispatcher.requests.map((request) => request.action)).toEqual(
          ledger.events.flatMap((event) => event.kind === "decision" ? [event.record.action] : []),
        );
        const replay = replaySearchStep(`step-${seed}`, config(policy), ledger.events);
        expect(replay.ok).toBe(true);
        if (replay.ok) {
          expect(replay.state).toEqual(result.state);
          expect(replay.next).toEqual({ kind: "stop", reason: result.stop_reason });
        }
      }
    }
  });

  it("stops at the first verified attempt", async () => {
    const ledger = memoryLedger();
    const result = await runSearchStep({ step_id: "step", config: config(POLICIES[3]), dispatcher: seededDispatcher("always", 1, ledger), ledger });
    expect(result.stop_reason).toBe("verified");
    expect(result.state.attempts).toHaveLength(1);
    expect(result.state.spent_usd).toBe(0.02);
  });

  it("refuses an answer for the wrong attempt and an invalid reward, leaving the attempt in flight", async () => {
    for (const answer of [
      (request: SearchAttemptRequest): SearchRewardInput => ({ attempt_id: `${request.attempt_id}x`, reward: 0, verification: null, cost_usd: 0 }),
      (request: SearchAttemptRequest): SearchRewardInput => ({ attempt_id: request.attempt_id, reward: 2, verification: null, cost_usd: 0 }),
    ]) {
      const ledger = memoryLedger();
      const dispatcher: SearchAttemptDispatcher = { dispatch: async (request) => answer(request) };
      await expect(runSearchStep({ step_id: "step", config: config(POLICIES[0]), dispatcher, ledger })).rejects.toThrow(SearchContractError);
      expect(ledger.events.map((event) => event.kind)).toEqual(["decision"]);
      const replay = replaySearchStep("step", config(POLICIES[0]), ledger.events);
      expect(replay.ok && replay.state.attempts[0].status).toBe("in_flight");
    }
  });
});
