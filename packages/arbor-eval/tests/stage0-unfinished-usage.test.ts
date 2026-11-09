// D9 (usage of sessions that never finish) and D10 (wall-cap cut-off class, campaign id). Fixture run dirs only; no live calls.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveCorrections } from "../src/stage0/audit.js";
import { classifyAttempt, liveAttemptSpend } from "../src/stage0/attempt.js";
import { STAGE0_CAPS_PRESETS, STAGE0_REV2_PILOT_25MIN_CAPS, STAGE0_REV2_PILOT_CAPS, Stage0RunGuard } from "../src/stage0/guard.js";
import { campaignIdFromTarget, journalUsage, unrecordedUsage } from "../src/stage0/journal-usage.js";
import { parseLedger } from "../src/stage0/ledger.js";
import { attempt } from "./stage0-fixtures.js";

// $1 per million input tokens, $2 per million output tokens.
const price = {
  input_minor_units_per_million_tokens: 1_000_000,
  output_minor_units_per_million_tokens: 2_000_000,
  cache_read_minor_units_per_million_tokens: 0,
  cache_write_minor_units_per_million_tokens: 0,
  minor_unit_exponent: 6,
};

const CAMPAIGN = "composer-draft-killed";

function usageEvent(session: string, sequence: number, payload: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, kind: "event", event: { session_id: session, sequence, occurred_at: "2026-10-07T00:00:00Z", kind: "usage", payload } });
}

/**
 * A run dir of a killed attempt. Session A finished (its usage is in the audit
 * span: 100k in / 10k out). Session B was killed before its node completed
 * (200k in / 40k out in the journal only), and one of its turns was aborted
 * mid-stream with no provider report (bound: 5000 output tokens).
 */
function killedRunDir(options: { audit?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "stage0-killed-"));
  const arbor = join(dir, "target", ".arbor");
  mkdirSync(join(arbor, "audit"), { recursive: true });
  const lines = [
    JSON.stringify({ version: 1, kind: "started", summary: { session_id: "A", campaign_id: CAMPAIGN, node_id: "n1", operation: "specialize" } }),
    usageEvent("A", 1, { input_tokens: 60_000, output_tokens: 6_000 }),
    usageEvent("A", 2, { input_tokens: 40_000, output_tokens: 4_000 }),
    JSON.stringify({ version: 1, kind: "started", summary: { session_id: "B", campaign_id: CAMPAIGN, node_id: "n2", operation: "specialize" } }),
    usageEvent("B", 1, { input_tokens: 120_000, output_tokens: 25_000 }),
    usageEvent("B", 1, { input_tokens: 120_000, output_tokens: 25_000 }), // replayed line: counted once
    usageEvent("B", 2, { input_tokens: 80_000, output_tokens: 15_000 }),
    usageEvent("B", 3, { input_tokens: null, output_tokens: null, unavailable_reason: "stream aborted; unpriced_estimate: at most 5000 output tokens were streamed (9000 UTF-8 bytes); the billed input tokens are unknown" }),
    "{ torn line",
  ];
  writeFileSync(join(arbor, "harness-sessions.ndjson"), `${lines.join("\n")}\n`);
  if (options.audit !== false) {
    const span = { observation: { type: "usage_cost", idempotency_key: "cost:a", input_tokens: 100_000, output_tokens: 10_000, cache_read_tokens: 0, cache_write_tokens: 0, cost: { kind: "priced", minor_units: 120_000, minor_unit_exponent: 6 } } };
    writeFileSync(join(arbor, "audit", `${CAMPAIGN}.jsonl`), `${JSON.stringify(span)}\n`);
  }
  return dir;
}

describe("unfinished-session usage (D9)", () => {
  it("reads journal usage once per event, ignoring torn lines, and bounds the aborted turn", () => {
    const j = journalUsage(join(killedRunDir(), "target"));
    expect(j.input).toBe(300_000);
    expect(j.output).toBe(50_000);
    expect(j.estimate_turns).toBe(1);
    expect(j.estimate_output_bound).toBe(5_000);
    expect(j.unbounded_estimates).toBe(0);
  });

  it("prices only what the audit spans lack, plus the aborted-turn output bound, labelled as an estimate", () => {
    const target = join(killedRunDir(), "target");
    const u = unrecordedUsage(target, { input: 100_000, output: 10_000 }, price);
    expect(u).not.toBeNull();
    expect(u?.input_tokens).toBe(200_000);
    expect(u?.output_tokens).toBe(40_000);
    expect(u?.aborted_turn_output_upper_bound).toBe(5_000);
    // 200k * $1/M + (40k + 5k) * $2/M
    expect(u?.cost_usd).toBeCloseTo(0.2 + 0.09, 9);
    expect(u?.basis).toMatch(/^estimate/);
    // Everything already in the audit spans: nothing unrecorded.
    expect(unrecordedUsage(join(killedRunDir(), "target"), { input: 300_000, output: 50_000 }, price)?.cost_usd).toBeCloseTo(0.01, 9);
  });

  it("counts an estimate that names no bound without pricing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage0-unbounded-"));
    mkdirSync(join(dir, ".arbor"), { recursive: true });
    writeFileSync(join(dir, ".arbor", "harness-sessions.ndjson"), `${usageEvent("S", 1, { input_tokens: null, output_tokens: null, unavailable_reason: "no bound" })}\n`);
    const u = unrecordedUsage(dir, { input: 0, output: 0 }, price);
    expect(u?.aborted_turn_estimates).toBe(1);
    expect(u?.unbounded_estimates).toBe(1);
    expect(u?.cost_usd).toBe(0);
  });

  it("live spend includes the killed session, so the guard's kill switch sees it", () => {
    const target = join(killedRunDir(), "target");
    const live = liveAttemptSpend(target, price);
    // audit span priced 0.12 + unrecorded 0.29
    expect(live.cost_usd).toBeCloseTo(0.41, 9);
    expect(live.cost_usd).toBeGreaterThan(0.12);
    const g = new Stage0RunGuard({ caps: { ...STAGE0_REV2_PILOT_CAPS, usd_kill_switch: 0.3 }, per_attempt_reserve_usd: 0.05 });
    g.admit("t#0/a0");
    g.progress("t#0/a0", 0.12); // the audit log alone is under the switch
    expect(g.stopped).toBeNull();
    g.progress("t#0/a0", live.cost_usd);
    expect(g.stopped?.reason).toBe("spend_cap");
    expect(g.signal.aborted).toBe(true);
  });

  it("counts a campaign whose audit log is empty (session killed before any node completed)", () => {
    const target = join(killedRunDir({ audit: false }), "target");
    expect(liveAttemptSpend(target, price).cost_usd).toBeCloseTo(0.3 + 0.1 + 0.01, 9);
  });

  it("re-derives a killed attempt's ledger spend as an append-only correction", () => {
    const dir = killedRunDir();
    const recorded = attempt({ task_id: "t", seed: 0, attempt_index: 1, campaign_id: CAMPAIGN, cost_usd: 0.12, cost_priced_usd: 0.12, run_dir: dir });
    const [correction] = deriveCorrections([recorded], price, "full", "now");
    expect(correction.set.cost_usd).toBeCloseTo(0.41, 9);
    expect(correction.set.cost_priced_usd).toBeCloseTo(0.12, 9);
    expect(correction.set.unrecorded_usage?.cost_usd).toBeCloseTo(0.29, 9);
    expect(correction.reason).toMatch(/D9/);
    // Applied through the ledger reader, then idempotent.
    const parsed = parseLedger([JSON.stringify(recorded), JSON.stringify(correction)].join("\n"), "full");
    expect(parsed.attempts[0].cost_usd).toBeCloseTo(0.41, 9);
    expect(deriveCorrections(parsed.attempts, price, "full", "later")).toEqual([]);
  });
});

describe("wall-cap cut-off (D10)", () => {
  const base = {
    setup_failed: null, task_exit: null, timed_out: true, campaign_id: null, harness_verified: false, adopted: false, adopt_output: "",
    independent_exit: null, protected_intact: true, stderr: "", refusals: {},
  };

  it("classifies a timed-out attempt aborted and names the cap", () => {
    const result = classifyAttempt({ ...base, timeout_cap: "per-attempt wall cap (25 min total, 22 min left for arbor task)" });
    expect(result.failure_class).toBe("aborted");
    expect(result.detail).toMatch(/per-attempt wall cap \(25 min/);
    expect(classifyAttempt(base).failure_class).toBe("aborted");
  });

  it("a recorded provider error still outranks the cut-off", () => {
    const provider = [{ kind: "http", status: 402, signature: "http:HTTP 402" }];
    expect(classifyAttempt({ ...base, provider_errors: provider }).failure_class).toBe("provider");
  });

  it("recovers the campaign id from the journal, else a single audit log, else null", () => {
    expect(campaignIdFromTarget(join(killedRunDir(), "target"))).toBe(CAMPAIGN);
    const auditOnly = mkdtempSync(join(tmpdir(), "stage0-audit-only-"));
    mkdirSync(join(auditOnly, ".arbor", "audit"), { recursive: true });
    writeFileSync(join(auditOnly, ".arbor", "audit", "c-only.jsonl"), "");
    expect(campaignIdFromTarget(auditOnly)).toBe("c-only");
    writeFileSync(join(auditOnly, ".arbor", "audit", "c-two.jsonl"), "");
    expect(campaignIdFromTarget(auditOnly)).toBeNull();
    expect(campaignIdFromTarget(mkdtempSync(join(tmpdir(), "stage0-empty-")))).toBeNull();
  });

  it("corrects an earlier ledger entry: harness to aborted, null campaign id recovered", () => {
    const dir = killedRunDir();
    const cutOff = attempt({
      task_id: "t", seed: 0, attempt_index: 1, campaign_id: null, arbor_task_timed_out: true, arbor_task_exit: null,
      failure_class: "harness", failure_detail: "arbor task exceeded the attempt timeout", cost_usd: 0.41, cost_priced_usd: 0.12, run_dir: dir,
    });
    const [correction] = deriveCorrections([cutOff], price, "full", "now");
    expect(correction.set.campaign_id).toBe(CAMPAIGN);
    expect(correction.set.failure_class).toBe("aborted");
    expect(correction.set.failure_detail).toMatch(/wall cap/);
    const parsed = parseLedger([JSON.stringify(cutOff), JSON.stringify(correction)].join("\n"), "full");
    expect(parsed.attempts[0].campaign_id).toBe(CAMPAIGN);
    expect(parsed.attempts[0].failure_class).toBe("aborted");
  });
});

describe("25-minute attempt cap preset", () => {
  it("raises only the per-attempt wall cap and leaves the 15-minute preset intact", () => {
    expect(STAGE0_REV2_PILOT_25MIN_CAPS.max_attempt_wall_ms).toBe(25 * 60_000);
    expect(STAGE0_REV2_PILOT_CAPS.max_attempt_wall_ms).toBe(15 * 60_000);
    expect({ ...STAGE0_REV2_PILOT_25MIN_CAPS, max_attempt_wall_ms: 0 }).toEqual({ ...STAGE0_REV2_PILOT_CAPS, max_attempt_wall_ms: 0 });
    expect(STAGE0_CAPS_PRESETS["rev2-pilot-25min"]).toBe(STAGE0_REV2_PILOT_25MIN_CAPS);
    expect(STAGE0_CAPS_PRESETS["rev2-pilot"]).toBe(STAGE0_REV2_PILOT_CAPS);
  });
});
