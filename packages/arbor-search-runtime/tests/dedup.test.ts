import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applySearchObservation, createSearchStep, decideSearchStep, replaySearchStep, SearchContractError } from "@arbor/core";
import type { SearchConfig, SearchLedgerEvent, SearchPolicyConfig, SearchRewardInput } from "@arbor/core";
import { createDedupingDispatcher, createGitTreeDigestPort, runSearchStep } from "../src/index.js";
import type { AttemptDigestPort, SearchLedgerSink, TwoPhaseAttemptRunner } from "../src/index.js";

const VERIFIED = { tag: "verified", cmd: "bun run test", exit: 0, stdout_hash: "sha256:fixture" } as const;
const root = mkdtempSync(join(tmpdir(), "arbor-dedup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** A fresh repo (no commit needed: write-tree depends only on staged content) holding `files`. */
function worktreeWith(files: Record<string, string>): string {
  const dir = join(root, `wt${counter++}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const ABMCTS: SearchPolicyConfig = { kind: "abmcts_beta", prior: { alpha: 1, beta: 1 }, virtual_loss: 1 };

function config(policy: SearchPolicyConfig, maxAttempts: number): SearchConfig {
  return {
    policy,
    seed: "dedup",
    budget: { max_usd: 100, max_attempts: maxAttempts },
    max_refine_depth: 0,
    max_width: null,
    step_prior: { estimated_gain: 1, estimated_cost: 1, category: "fix" },
  };
}

function memoryLedger(): SearchLedgerSink & { readonly events: SearchLedgerEvent[] } {
  const events: SearchLedgerEvent[] = [];
  return { events, append: async (event) => { events.push(structuredClone(event)); } };
}

/** Attempt n writes `contents[n]`; the last attempt verifies when `verifyLast`. Counts verify calls. */
function runnerFor(contents: readonly string[], verifyLast: boolean): TwoPhaseAttemptRunner & { verified: string[] } {
  const verified: string[] = [];
  return {
    verified,
    produce: async (request) => ({
      worktree_path: worktreeWith({ "src/a.ts": contents[Number(request.attempt_id.split("/a")[1])] }),
      cost_usd: 0.01,
    }),
    verify: async (request) => {
      verified.push(request.attempt_id);
      const last = Number(request.attempt_id.split("/a")[1]) === contents.length - 1;
      const ok = verifyLast && last;
      return { attempt_id: request.attempt_id, reward: ok ? 1 : 0.2, verification: ok ? VERIFIED : null, cost_usd: 0.05 };
    },
  };
}

describe("createGitTreeDigestPort", () => {
  const port = createGitTreeDigestPort();

  it("gives identical content the same OID and a whitespace-only difference another", async () => {
    const a = await port.digest(worktreeWith({ "x.ts": "const a = 1;\n", "d/y.ts": "y\n" }));
    const b = await port.digest(worktreeWith({ "d/y.ts": "y\n", "x.ts": "const a = 1;\n" }));
    const spaced = await port.digest(worktreeWith({ "x.ts": "const a = 1; \n", "d/y.ts": "y\n" }));
    const crlf = await port.digest(worktreeWith({ "x.ts": "const a = 1;\r\n", "d/y.ts": "y\n" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40,64}$/);
    expect(spaced).not.toBe(a);
    expect(crlf).not.toBe(a);
  });

  it("leaves excluded operational paths out of the digest", async () => {
    const excluding = createGitTreeDigestPort({ exclude: [".arbor"] });
    const plain = await excluding.digest(worktreeWith({ "x.ts": "1\n" }));
    const withNoise = await excluding.digest(worktreeWith({ "x.ts": "1\n", ".arbor/run.log": "noise\n" }));
    expect(withNoise).toBe(plain);
  });

  it("rejects a directory that is not a repository", async () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    await expect(port.digest(dir)).rejects.toThrow(/git add/);
  });
});

describe("createDedupingDispatcher", () => {
  const BEST_OF_N: SearchPolicyConfig = { kind: "best_of_n" };

  it("verifies identical trees once and links the duplicate to the original", async () => {
    const runner = runnerFor(["same\n", "same\n", "same\n", "other\n"], true);
    const ledger = memoryLedger();
    const result = await runSearchStep({
      step_id: "s",
      config: config(BEST_OF_N, 10),
      dispatcher: createDedupingDispatcher({ runner, digests: createGitTreeDigestPort() }),
      ledger,
    });
    expect(runner.verified).toEqual(["s/a0", "s/a3"]);
    expect(result.stop_reason).toBe("verified");
    const observations = ledger.events.flatMap((event) => event.kind === "observation" ? [event.observation] : []);
    const links = observations.map((o) => o.duplicate_of?.attempt_id ?? null);
    expect(links).toEqual([null, "s/a0", "s/a0", null]);
    // Linked, not copied: own attempt id and own (generation-only) cost; no verification of its own.
    expect(observations[1]).toMatchObject({ attempt_id: "s/a1", verification: null, cost_usd: 0.01, reward: 0.2 });
    expect(observations[1].duplicate_of?.digest).toBe(observations[2].duplicate_of?.digest);
    expect(observations[3].verification).toEqual(VERIFIED);
    expect(result.state.spent_usd).toBeCloseTo(0.05 + 0.01 + 0.01 + 0.05, 10);
    expect(result.state.attempts.filter((a) => a.duplicate_of !== undefined).map((a) => a.id)).toEqual(["s/a1", "s/a2"]);
  });

  it("treats whitespace-only differences as distinct candidates", async () => {
    const runner = runnerFor(["x = 1\n", "x = 1 \n", "x  = 1\n", "x = 1\r\n"], false);
    const ledger = memoryLedger();
    await runSearchStep({
      step_id: "s",
      config: config(BEST_OF_N, 4),
      dispatcher: createDedupingDispatcher({ runner, digests: createGitTreeDigestPort() }),
      ledger,
    });
    expect(runner.verified).toHaveLength(4);
    expect(ledger.events.some((e) => e.kind === "observation" && e.observation.duplicate_of !== undefined)).toBe(false);
  });

  it("does not count a duplicate as a second posterior observation", async () => {
    const runner = runnerFor(["same\n", "same\n", "same\n"], false);
    const ledger = memoryLedger();
    await runSearchStep({
      step_id: "s",
      config: config(ABMCTS, 3),
      dispatcher: createDedupingDispatcher({ runner, digests: createGitTreeDigestPort() }),
      ledger,
    });
    const decisions = ledger.events.flatMap((e) => e.kind === "decision" ? [e.record] : []);
    // One real observation (reward 0.2) and, later, two links: the GEN arm still shows one visit and alpha = 1 + 0.2.
    for (const record of decisions.slice(1)) {
      const gen = record.levels[0].arms.find((arm) => arm.arm === "gen");
      expect(gen?.visits).toBe(1);
      expect(gen?.stats).toMatchObject({ kind: "beta", alpha: 1.2, beta: 1.8 });
    }
  });

  it("does not transpose across steps", async () => {
    const dispatcher = createDedupingDispatcher({ runner: runnerFor(["same\n", "same\n"], false), digests: createGitTreeDigestPort() });
    const outcomes: SearchRewardInput[] = [];
    for (const step of ["one", "two"]) {
      const ledger = memoryLedger();
      await runSearchStep({ step_id: step, config: config(BEST_OF_N, 1), dispatcher: { dispatch: async (r) => { const o = await dispatcher.dispatch({ ...r, attempt_id: r.attempt_id }); outcomes.push(o); return o; } }, ledger });
    }
    expect(outcomes.every((o) => o.duplicate_of === undefined)).toBe(true);
  });

  it("replays deterministically with dedup, showing the decision in the ledger", async () => {
    const digests: AttemptDigestPort = createGitTreeDigestPort();
    const run = async () => {
      const ledger = memoryLedger();
      const cfg = config(ABMCTS, 6);
      const result = await runSearchStep({
        step_id: "s",
        config: cfg,
        dispatcher: createDedupingDispatcher({ runner: runnerFor(["a\n", "a\n", "b\n", "a\n", "b\n", "c\n"], false), digests }),
        ledger,
      });
      return { ledger, result, cfg };
    };
    const first = await run();
    const second = await run();
    expect(second.ledger.events).toEqual(first.ledger.events);
    const replay = replaySearchStep("s", first.cfg, first.ledger.events);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.state).toEqual(first.result.state);
    expect(first.ledger.events.filter((e) => e.kind === "observation" && e.observation.duplicate_of !== undefined)).toHaveLength(3);
  });
});

describe("duplicate_of contract (core)", () => {
  const cfg = config({ kind: "best_of_n" }, 5);
  function twoDispatched() {
    let state = createSearchStep("s");
    for (let i = 0; i < 2; i++) {
      const decision = decideSearchStep(state, cfg);
      if (decision.kind !== "dispatch") throw new Error("expected dispatch");
      state = decision.state;
      if (i === 0) state = applySearchObservation(state, { attempt_id: "s/a0", reward: 0.3, verification: null, cost_usd: 0.1 });
    }
    return state;
  }
  const link = { attempt_id: "s/a0", digest: "abc" };

  it("accepts a link to an observed original and rejects every violation", () => {
    const state = twoDispatched();
    const ok = applySearchObservation(state, { attempt_id: "s/a1", reward: 0.3, verification: null, cost_usd: 0.01, duplicate_of: link });
    expect(ok.attempts[1]).toMatchObject({ status: "observed", duplicate_of: "s/a0", verified: false });
    const bad = (observation: Partial<SearchRewardInput>) => () =>
      applySearchObservation(state, { attempt_id: "s/a1", reward: 0.3, verification: null, cost_usd: 0.01, duplicate_of: link, ...observation });
    expect(bad({ reward: 0.4 })).toThrow(SearchContractError);
    expect(bad({ duplicate_of: { attempt_id: "s/zz", digest: "abc" } })).toThrow(SearchContractError);
    expect(bad({ duplicate_of: { attempt_id: "s/a1", digest: "abc" } })).toThrow(SearchContractError);
    expect(bad({ duplicate_of: { attempt_id: "s/a0", digest: "" } })).toThrow(SearchContractError);
    expect(bad({ reward: 1, verification: VERIFIED })).toThrow(SearchContractError);
  });
});
