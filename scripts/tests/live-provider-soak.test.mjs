import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySoakOutcome, readProviderEvidence } from "../live-provider-soak.mjs";

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
function fixture({ model = "openrouter/example/model", usage = { input_tokens: 7, output_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" } } = {}) {
  root = mkdtempSync(join(tmpdir(), "provider-soak-"));
  mkdirSync(join(root, "audit")); mkdirSync(join(root, "tree"));
  writeFileSync(join(root, "audit", "campaign-a.jsonl"), `${JSON.stringify({ kind: "telemetry_observation", campaign_id: "campaign-a", node_id: "node-a", observation: { type: "role_model_identity", role: "specialist", phase: "expand", outcome: "success", model_id: model } })}\n`);
  writeFileSync(join(root, "tree", "campaign-a.json"), JSON.stringify({ id: "campaign-a", nodes: [{ candidate: { token_usage: usage } }] }));
  return root;
}

describe("live provider soak evidence oracle", () => {
  it("keeps the executable entry point repository-relative for Bun resolution", () => {
    const source = readFileSync(new URL("../live-provider-soak.mjs", import.meta.url), "utf8");
    expect(source).toContain('"packages", "arbor-mcp", "bin", "arbor-mcp.mjs"');
    expect(source).not.toContain('"packages/arbor-mcp/src/bin.ts"');
  });
  it("requires model identity and positive provider-counter usage for the same campaign", () => {
    const evidence = readProviderEvidence(fixture());
    expect(evidence).toMatchObject({ proven: true, campaign_ids: ["campaign-a"], model_identities: ["openrouter/example/model"], provider_usage: { input_tokens: 7, output_tokens: 3, counter_source: "provider_counter" } });
    expect(evidence.evidence_files).toHaveLength(2);
  });
  it("rejects placeholder identity and non-provider counters", () => {
    expect(readProviderEvidence(fixture({ model: "default" })).proven).toBe(false);
    rmSync(root, { recursive: true, force: true }); root = undefined;
    expect(readProviderEvidence(fixture({ usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "estimate" } })).proven).toBe(false);
  });
  it("does not turn a zero process exit into provider success", () => {
    root = mkdtempSync(join(tmpdir(), "provider-soak-empty-"));
    const evidence = readProviderEvidence(root);
    expect(classifySoakOutcome({ evidence, timedOut: false, spawnError: null, exitCode: 0, signal: null, proofDrivenStop: false })).toMatchObject({ status: "failed" });
  });
  it("reports proof-driven termination as success and timeout as failure", () => {
    const evidence = readProviderEvidence(fixture());
    expect(classifySoakOutcome({ evidence, timedOut: false, spawnError: null, exitCode: 0, signal: null, proofDrivenStop: true })).toMatchObject({ status: "passed" });
    expect(classifySoakOutcome({ evidence, timedOut: true, spawnError: null, exitCode: 0, signal: null, proofDrivenStop: false })).toMatchObject({ status: "failed" });
  });
});
