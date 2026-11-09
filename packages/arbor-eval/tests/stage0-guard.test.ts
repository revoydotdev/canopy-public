// Stage 0 run guard: hard caps and the provider-fatal stop. No live calls.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyAttempt } from "../src/stage0/attempt.js";
import {
  cohortEgressGrants,
  connectorIdsInTarget,
  isProviderFatal,
  providerErrorsIn,
  providerErrorsInTarget,
  STAGE0_REV2_PILOT_CAPS,
  Stage0RunGuard,
  validateRunPlan,
} from "../src/stage0/guard.js";
import type { GuardedAttemptOutcome, ProviderError } from "../src/stage0/guard.js";
import { runStreamed } from "../src/stage0/proc.js";
import { runUnits } from "../src/stage0/scheduler.js";
import type { Stage0AttemptRecord } from "../src/stage0/types.js";
import { attempt } from "./stage0-fixtures.js";

// The exact shape the 2026-10-07 full run's audit logs recorded for credit exhaustion.
const AUDIT_402 = String.raw`{"specialist_output":"model port failed: OpenAICompatibleAdapterError (http): OpenAI-compatible provider returned HTTP 402: Insufficient credits. Add more using https://openrouter.ai/settings/credits","critic_verdict_approved":false}`;
const AUDIT_429 = String.raw`{"specialist_output":"model port failed: OpenAICompatibleAdapterError (http): OpenAI-compatible provider returned HTTP 429: rate limited"}`;
const AUDIT_503 = String.raw`{"specialist_output":"model port failed: OpenAICompatibleAdapterError (http): OpenAI-compatible provider returned HTTP 503: upstream unavailable"}`;

const err = (text: string): ProviderError[] => providerErrorsIn(text);

const nativeConfig = {
  max_turns: 32,
  max_session_wall_clock_ms: 600_000,
  pricing: { input_minor_units_per_million_tokens: 90_000, output_minor_units_per_million_tokens: 180_000 },
  usage_budget: { max_campaign_cost: { currency: "USD", minor_units: 500_000, minor_unit_exponent: 6 } },
};
const fiveTasks = ["a", "b", "c", "d", "e"].map((task_id) => ({ task_id, seed: 0 }));

function outcome(fields: Partial<GuardedAttemptOutcome> & { key: string }): GuardedAttemptOutcome {
  return { cost_usd: 0.01, provider_errors: [], connector_ids: ["revoy-native"], campaign_id: "c", ...fields };
}

function guard(overrides: Partial<typeof STAGE0_REV2_PILOT_CAPS> = {}, reserve = 0.5) {
  const stops: string[] = [];
  const g = new Stage0RunGuard({ caps: { ...STAGE0_REV2_PILOT_CAPS, ...overrides }, per_attempt_reserve_usd: reserve, onStop: (reason) => stops.push(reason) });
  return { g, stops };
}

describe("provider error detection", () => {
  it("reads HTTP 402 from an audit-log line and treats it as fatal", () => {
    const [e] = err(AUDIT_402);
    expect(e.kind).toBe("http");
    expect(e.status).toBe(402);
    expect(isProviderFatal(e)).toBe(true);
    expect(e.signature).toMatch(/^http:OpenAI-compatible provider returned HTTP 402: Insufficient credits/);
  });

  it("treats auth and credential failures as fatal, rate limits and 5xx as not", () => {
    expect(isProviderFatal({ kind: "http", status: 401, signature: "x" })).toBe(true);
    expect(isProviderFatal({ kind: "http", status: 403, signature: "x" })).toBe(true);
    expect(isProviderFatal({ kind: "credential", status: null, signature: "x" })).toBe(true);
    expect(isProviderFatal(err(AUDIT_429)[0])).toBe(false);
    expect(isProviderFatal(err(AUDIT_503)[0])).toBe(false);
  });

  it("de-duplicates repeated errors and finds them in a target's preserved logs", () => {
    expect(err(`${AUDIT_402}\n${AUDIT_402}\n${AUDIT_429}`)).toHaveLength(2);
    const target = mkdtempSync(join(tmpdir(), "stage0-guard-target-"));
    mkdirSync(join(target, ".arbor", "audit"), { recursive: true });
    writeFileSync(join(target, ".arbor", "audit", "composer-x.jsonl"), `${AUDIT_402}\n`);
    writeFileSync(join(target, ".arbor", "harness-sessions.ndjson"), `{"kind":"session","connector_id":"revoy-native"}\n{"connector_id":"revoy-native"}\n`);
    expect(providerErrorsInTarget(target).map((e) => e.status)).toEqual([402]);
    expect(connectorIdsInTarget(target)).toEqual(["revoy-native"]);
    expect(providerErrorsInTarget(join(target, "missing"))).toEqual([]);
  });

  it("classifies an attempt with a recorded provider error as provider, not model", () => {
    const failed = { setup_failed: null, task_exit: 3, timed_out: false, campaign_id: "c", harness_verified: false, adopted: false, adopt_output: "", independent_exit: null, protected_intact: true, stderr: "", refusals: {} };
    expect(classifyAttempt(failed).failure_class).toBe("model");
    expect(classifyAttempt({ ...failed, provider_errors: err(AUDIT_402) })).toEqual({ failure_class: "provider", detail: expect.stringContaining("HTTP 402") });
    expect(classifyAttempt({ ...failed, aborted_by: "spend_cap" }).failure_class).toBe("aborted");
  });
});

describe("validateRunPlan", () => {
  const plan = { units: fiveTasks, max_attempts_per_unit: 4, native_config: nativeConfig, attempt_timeout_ms: 12 * 60_000, max_in_flight: 2 };

  it("accepts the Revision 2 pilot plan", () => {
    expect(validateRunPlan(plan, STAGE0_REV2_PILOT_CAPS)).toEqual([]);
  });

  it("refuses every exceeded cap before any live call", () => {
    const errors = validateRunPlan({
      units: [...fiveTasks, { task_id: "f", seed: 0 }, { task_id: "a", seed: 1 }],
      max_attempts_per_unit: 8,
      native_config: { ...nativeConfig, max_turns: 64, max_session_wall_clock_ms: undefined, usage_budget: { max_campaign_cost: { minor_units: 5_000_000, minor_unit_exponent: 6 } } },
      attempt_timeout_ms: 40 * 60_000,
      max_in_flight: 4,
    }, STAGE0_REV2_PILOT_CAPS);
    expect(errors.join("\n")).toMatch(/6 tasks/);
    expect(errors.join("\n")).toMatch(/2 seeds/);
    expect(errors.join("\n")).toMatch(/56 planned attempts/);
    expect(errors.join("\n")).toMatch(/max_turns/);
    expect(errors.join("\n")).toMatch(/max_session_wall_clock_ms/);
    expect(errors.join("\n")).toMatch(/attempt timeout/);
    expect(errors.join("\n")).toMatch(/in flight/);
    expect(errors.join("\n")).toMatch(/max_campaign_cost/);
  });
});

describe("Stage0RunGuard", () => {
  it("stops the run outright on the first provider-fatal error and aborts in-flight attempts", () => {
    const { g, stops } = guard();
    expect(g.admit("t#0/a0")).toBe(true);
    expect(g.admit("t#0/a1")).toBe(true);
    g.finish(outcome({ key: "t#0/a0", provider_errors: err(AUDIT_402), cost_usd: 0 }));
    expect(g.stopped?.reason).toBe("provider_fatal");
    expect(g.signal.aborted).toBe(true);
    expect(g.admit("t#0/a2")).toBe(false);
    expect(stops).toEqual(["provider_fatal"]);
  });

  it("stops on a provider-fatal error seen live, before the attempt ends", () => {
    const { g } = guard();
    g.admit("t#0/a0");
    g.progress("t#0/a0", 0.001, err(AUDIT_402));
    expect(g.stopped?.reason).toBe("provider_fatal");
    expect(g.signal.aborted).toBe(true);
  });

  it("stops when the same provider error repeats across two consecutive attempts, not when it does not", () => {
    const { g } = guard();
    for (const key of ["a0", "a1", "a2", "a3"]) g.admit(key);
    g.finish(outcome({ key: "a0", provider_errors: err(AUDIT_429) }));
    g.finish(outcome({ key: "a1", provider_errors: err(AUDIT_503) }));
    g.finish(outcome({ key: "a2", provider_errors: [] }));
    expect(g.stopped).toBeNull();
    g.finish(outcome({ key: "a3", provider_errors: [] }));
    const second = guard().g;
    second.admit("b0");
    second.admit("b1");
    second.finish(outcome({ key: "b0", provider_errors: err(AUDIT_503) }));
    second.finish(outcome({ key: "b1", provider_errors: err(AUDIT_503) }));
    expect(second.stopped?.reason).toBe("provider_repeated");
    expect(second.signal.aborted).toBe(true);
  });

  it("stops new starts at the attempt cap without aborting in-flight attempts", () => {
    const { g } = guard({ max_attempts: 2 });
    expect(g.admit("a0")).toBe(true);
    expect(g.admit("a1")).toBe(true);
    expect(g.admit("a2")).toBe(false);
    expect(g.stopped?.reason).toBe("attempt_cap");
    expect(g.signal.aborted).toBe(false);
  });

  it("refuses a start once projected spend reaches the kill switch, and aborts once spend exceeds it", () => {
    const { g } = guard({ usd_kill_switch: 3 }, 1);
    expect(g.admit("a0")).toBe(true); // projected: one new attempt at the $1 reserve
    expect(g.admit("a1")).toBe(true); // a0 in flight at the reserve + one new = $2 < $3
    expect(g.admit("a2")).toBe(false); // $1 + $1 + $1 = $3 ≥ $3
    expect(g.stopped?.reason).toBe("spend_cap");
    expect(g.signal.aborted).toBe(false);
    const live = guard({ usd_kill_switch: 3 }, 0.1).g;
    live.admit("a0");
    live.progress("a0", 3.01);
    expect(live.stopped?.reason).toBe("spend_cap");
    expect(live.signal.aborted).toBe(true);
  });

  it("aborts when an attempt ran on a connector other than revoy-native, or a campaign recorded none before one was verified", () => {
    const { g } = guard();
    g.admit("a0");
    g.finish(outcome({ key: "a0", connector_ids: ["opencode"] }));
    expect(g.stopped?.reason).toBe("connector_mismatch");
    const unverified = guard().g;
    unverified.admit("a0");
    unverified.finish(outcome({ key: "a0", connector_ids: [] }));
    expect(unverified.stopped?.reason).toBe("connector_mismatch");
    const setupFailure = guard().g;
    setupFailure.admit("a0");
    setupFailure.finish(outcome({ key: "a0", connector_ids: [], campaign_id: null }));
    expect(setupFailure.stopped).toBeNull();
  });

  it("aborts at the total wall-clock cap", () => {
    let clock = 0;
    const g = new Stage0RunGuard({ caps: { ...STAGE0_REV2_PILOT_CAPS, max_total_wall_ms: 100 }, per_attempt_reserve_usd: 0.1, now: () => clock });
    expect(g.admit("a0")).toBe(true);
    clock = 100;
    expect(g.admit("a1")).toBe(false);
    expect(g.stopped?.reason).toBe("wall_cap");
    expect(g.signal.aborted).toBe(true);
  });
});

describe("scheduler under the guard", () => {
  const tick = () => new Promise<void>((done) => setTimeout(done, 1));

  it("launches nothing after an HTTP 402, aborts the sibling, and never exceeds two in flight", async () => {
    const { g } = guard();
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    let siblingAborted = false;
    const result = await runUnits({
      experiment: "pilot",
      units: fiveTasks,
      k: 4,
      max_budget: 4,
      usd_unit: 1000,
      unit_concurrency: 2,
      deadline_ms: Number.POSITIVE_INFINITY,
      usd_ceiling: Number.POSITIVE_INFINITY,
      existing: [],
      guard: g,
      max_in_flight: 2,
      runAttempt: async (unit, index, wave, signal) => {
        started.push(`${unit.task_id}/a${index}`);
        inFlight++;
        peak = Math.max(peak, inFlight);
        if (unit.task_id === "a" && index === 0) {
          await tick();
          inFlight--;
          return { ...attempt({ task_id: unit.task_id, seed: 0, attempt_index: index, cost_usd: 0 }), wave, provider_errors: err(AUDIT_402), connector_ids: ["revoy-native"] };
        }
        // The sibling runs until the guard aborts it.
        await new Promise<void>((done) => {
          if (signal?.aborted === true) done();
          signal?.addEventListener("abort", () => done(), { once: true });
        });
        siblingAborted = signal?.aborted === true;
        inFlight--;
        return { ...attempt({ task_id: unit.task_id, seed: 0, attempt_index: index }), wave, aborted_by: "provider_fatal", connector_ids: ["revoy-native"] };
      },
      append: () => undefined,
      event: () => undefined,
    });
    expect(result.stop_reason).toBe("provider_fatal");
    expect(started).toHaveLength(2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(siblingAborted).toBe(true);
    expect(result.completed_units).toBe(0);
    expect(result.skipped_units).toBeGreaterThanOrEqual(3);
  });

  it("never starts more than the attempt cap even when the plan asks for more", async () => {
    const { g } = guard({ max_attempts: 6 });
    const appended: unknown[] = [];
    let ran = 0;
    const result = await runUnits({
      experiment: "pilot",
      units: fiveTasks,
      k: 4,
      max_budget: 4,
      usd_unit: 1000,
      unit_concurrency: 1,
      deadline_ms: Number.POSITIVE_INFINITY,
      usd_ceiling: Number.POSITIVE_INFINITY,
      existing: [],
      guard: g,
      max_in_flight: 2,
      runAttempt: async (unit, index, wave): Promise<Stage0AttemptRecord> => {
        ran++;
        return { ...attempt({ task_id: unit.task_id, seed: 0, attempt_index: index }), wave, connector_ids: ["revoy-native"] };
      },
      append: (entry) => appended.push(entry),
      event: () => undefined,
    });
    expect(ran).toBe(6);
    expect(result.stop_reason).toBe("attempt_cap");
    expect(result.completed_units).toBe(1);
    expect(result.incomplete_units).toBe(1);
    const waves = appended.filter((e) => (e as { schema: string }).schema === "revoy2.stage0.wave.v1") as Array<{ attempt_indices: number[] }>;
    expect(waves.map((w) => w.attempt_indices)).toEqual([[0, 1, 2, 3], [0, 1]]);
  });
});

describe("runStreamed abort", () => {
  it("ends the child process when the run guard aborts", async () => {
    const logs = mkdtempSync(join(tmpdir(), "stage0-abort-"));
    const controller = new AbortController();
    const pending = runStreamed(logs, "sleep", ["sleep", "30"], logs, 60_000, process.env, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timed_out).toBe(false);
    expect(result.ms).toBeLessThan(10_000);
  });
});

describe("cohortEgressGrants", () => {
  it("grants exactly the semver acceptance argv from the pinned cohort (ADR-191 decision 5)", () => {
    const cohort = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/release-acceptance-1.0.0/external-cohort.json"), "utf8")) as Parameters<typeof cohortEgressGrants>[0];
    const grants = cohortEgressGrants(cohort);
    expect(Object.keys(grants)).toEqual(["semver"]);
    expect(grants.semver[0].argv).toEqual(["cargo", "test", "--quiet"]);
    expect(grants.semver[0].reason.length).toBeGreaterThan(0);
  });
});
