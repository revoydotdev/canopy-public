import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveCorrections, refusalLoopPathCause } from "../src/stage0/audit.js";
import { attempt } from "./stage0-fixtures.js";

const price = {
  input_minor_units_per_million_tokens: 1_000_000,
  output_minor_units_per_million_tokens: 0,
  cache_read_minor_units_per_million_tokens: 0,
  cache_write_minor_units_per_million_tokens: 0,
  minor_unit_exponent: 6,
};

function runDir(options: { campaign: string; quarantine?: boolean; usage?: boolean; loop?: string | null; refusals?: Record<string, number> }): string {
  const dir = mkdtempSync(join(tmpdir(), "stage0-audit-"));
  const arbor = join(dir, "target", ".arbor");
  mkdirSync(join(arbor, "audit"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  if (options.usage !== false) {
    const record = { observation: { type: "usage_cost", idempotency_key: "k", input_tokens: 500_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost: { kind: "priced", minor_units: 500_000, minor_unit_exponent: 6 } } };
    writeFileSync(join(arbor, "audit", `${options.campaign}.jsonl`), `${JSON.stringify(record)}\n`);
  }
  if (options.quarantine === true) {
    mkdirSync(join(arbor, "quarantine"), { recursive: true });
    writeFileSync(join(arbor, "quarantine", `${options.campaign}.json.2026-10-07T00-00-00-000Z.1.corrupt`), "{}");
  }
  const nodes = [{ id: "root" }, { id: "n1", outcome: options.loop === undefined || options.loop === null ? null : { kind: "error", error: { code: options.loop } } }];
  writeFileSync(join(dir, "logs", "report.stdout.log"), JSON.stringify({ ok: true, value: { campaign: { nodes } } }));
  writeFileSync(join(dir, "attempt.json"), JSON.stringify({ tool_refusals: options.refusals ?? {} }));
  return dir;
}

describe("Stage 0 evidence audit", () => {
  it("recovers spend from the audit log and classifies a quarantined snapshot as harness (H1)", () => {
    const dir = runDir({ campaign: "c1", quarantine: true });
    const [correction] = deriveCorrections([attempt({ task_id: "t", seed: 0, attempt_index: 0, campaign_id: "c1", cost_usd: 0, run_dir: dir })], price, "full", "now");
    expect(correction.set.cost_usd).toBeCloseTo(0.5, 9);
    expect(correction.set.failure_class).toBe("harness");
    expect(correction.reason).toMatch(/H1/);
  });

  it("classifies a breaker stop after command path refusals as harness (H3), and nothing else", () => {
    const looped = runDir({ campaign: "c2", usage: false, loop: "tool_refusal_loop", refusals: { "verification.run:path_traversal": 3 } });
    expect(refusalLoopPathCause(looped)).toMatch(/argv only/);
    const [correction] = deriveCorrections([attempt({ task_id: "t", seed: 0, attempt_index: 0, campaign_id: "c2", run_dir: looped })], price, "full", "now");
    expect(correction.set.failure_class).toBe("harness");

    const otherRefusal = runDir({ campaign: "c3", usage: false, loop: "tool_refusal_loop", refusals: { "verification.run:command_not_allowlisted": 3 } });
    expect(refusalLoopPathCause(otherRefusal)).toBeNull();
    const noLoop = runDir({ campaign: "c4", usage: false, loop: null, refusals: { "verification.run:path_traversal": 3 } });
    expect(refusalLoopPathCause(noLoop)).toBeNull();
  });

  it("emits nothing when the captured values already match the evidence", () => {
    const dir = runDir({ campaign: "c5" });
    expect(deriveCorrections([attempt({ task_id: "t", seed: 0, attempt_index: 0, campaign_id: "c5", cost_usd: 0.5, run_dir: dir })], price, "full", "now")).toEqual([]);
  });
});
