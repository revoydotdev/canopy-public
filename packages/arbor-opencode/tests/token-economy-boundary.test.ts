import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenEpochService } from "@arbor/mcp";
import { prepareTokenDispatch, type TokenEconomyConfig } from "@arbor/campaign-support";

const fallback = { provider_id: "configured", model_id: "fallback", context_capacity: 100, max_output_tokens: 20, source: "configured" as const };
function temp(run: (directory: string) => Promise<void>): Promise<void> { const directory = mkdtempSync(join(tmpdir(), "arbor-boundary-")); return run(directory).finally(() => rmSync(directory, { recursive: true, force: true })); }
function config(directory: string, overrides: Partial<TokenEconomyConfig> = {}): TokenEconomyConfig {
  return {
    epochs: new TokenEpochService(directory),
    provider: { capability: () => fallback },
    fallback_capability: fallback,
    reserved_output_tokens: 20,
    requested_output_tokens: 30,
    expansion_id: () => "operation-1",
    ...overrides,
  };
}

describe("token economy dispatch boundary", () => {
  it("uses an explicitly tagged fallback and clamps output capability", () => temp(async (directory) => {
    const result = await prepareTokenDispatch({ campaign_id: "c", node_id: "n", prompt: "small", capability: "specialist", phase: "specialist", config: config(directory) });
    expect(result.status).toBe("ready");
    expect(result.counted.source).toBe("character_fallback");
    expect(result.epoch.applied_output_tokens).toBe(20);
    expect(result.epoch.output_limit_source).toBe("provider_capability");
  }));

  it("uses provider counters and suppresses eligible-context overflow before dispatch", () => temp(async (directory) => {
    const result = await prepareTokenDispatch({
      campaign_id: "c", node_id: "n", prompt: "oversized", capability: "specialist", phase: "specialist",
      config: config(directory, { provider: { counter_id: "tok-v1", capability: () => fallback, count: () => 81 } }),
    });
    expect(result).toMatchObject({ status: "suppressed_overflow", overflow_tokens: 1, warning: "claimed", management: "claimed" });
    expect(result.counted).toEqual({ tokens: 81, source: "provider_counter", counter_id: "tok-v1" });
  }));

  it("claims one durable recovery attempt, recounts the reduced prompt, and refuses another overflow retry", () => temp(async (directory) => {
    let recoveries = 0;
    const base = config(directory, {
      provider: { counter_id: "tok", capability: () => fallback, count: (text) => text.length },
      overflow_recovery: ({ prompt }) => { recoveries += 1; return prompt.slice(0, 70); },
    });
    const recovered = await prepareTokenDispatch({ campaign_id: "c", node_id: "n", prompt: "x".repeat(81), capability: "specialist", phase: "specialist", config: base });
    expect(recovered).toMatchObject({ status: "ready", overflow_retry: "recovered", recovered_from_overflow_tokens: 1, counted: { tokens: 70 }, epoch: { prefill: { tokens: 70 } } });
    const second = await prepareTokenDispatch({ campaign_id: "c", node_id: "n", prompt: "x".repeat(81), capability: "specialist", phase: "specialist", config: { ...base, epochs: new TokenEpochService(directory) } });
    expect(second).toMatchObject({ status: "suppressed_overflow", overflow_retry: "exhausted" });
    expect(recoveries).toBe(1);
  }));

  it("folds capability-filtered structural context and replays one management claim", () => temp(async (directory) => {
    const base = config(directory, {
      provider: { counter_id: "tok", capability: () => fallback, count: () => 70 },
      warning_threshold_tokens: 60,
      structural_context: { entries: () => [
        { identity: "public", content_hash: "h1", evidence_pointer: "e1", provenance: { tag: "claimed", claimant: "seed" }, visibility: "specialist", content: "tail" },
        { identity: "secret", content_hash: "h2", evidence_pointer: "e2", provenance: { tag: "claimed", claimant: "critic" }, visibility: "critic", content: "do-not-leak" },
      ] },
    });
    const first = await prepareTokenDispatch({ campaign_id: "c", node_id: "n", prompt: "prompt", capability: "specialist", phase: "specialist", config: base });
    const replay = await prepareTokenDispatch({ campaign_id: "c", node_id: "n", prompt: "prompt", capability: "specialist", phase: "specialist", config: { ...base, epochs: new TokenEpochService(directory) } });
    expect(first.prompt).toContain("public");
    expect(first.prompt).not.toContain("secret");
    expect(first.management).toBe("claimed");
    expect(replay.management).toBe("idempotent");
  }));
});
