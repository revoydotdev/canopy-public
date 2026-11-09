import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalizeForHash } from "@arbor/core";
import {
  ReuseLedgerConflictError, createPrefixReuseLedger, loadPrefixReuseLedgerResult,
  persistPrefixReuseObservation, reconcileReuseLedgerTemporaryFiles, recordPrefixReuseObservation,
  savePrefixReuseLedger, summarizePrefixReuseLedger,
} from "../src/reuse-ledger.js";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function temp(): string { const dir = mkdtempSync(join(tmpdir(), "reuse-ledger-")); temporaryDirectories.push(dir); return dir; }
function observation(operation_id = "op-persist") {
  return {
    operation_id, observed_at: "2026-08-10T00:00:01Z", observation_kind: "materialized" as const,
    prefix: { prefix_text: "provider=beta", prompt_template_id: "agent-uct/demo", tool_contract_id: "tools/v1", model_family: "fixture", context_signature: "stable", token_units: 5, byte_length: 13 },
    target: { cluster_id: "core", item_id: "q1", config_id: "fixture", variant_id: "a" },
    marginal_cost_token_units: 5,
    marginal_cost: { kind: "priced" as const, minor_units: 2, currency: "USD", minor_unit_exponent: 2, price_source_id: "fixture" },
    provenance: { tag: "verified" as const, cmd: "fixture", exit: 0, stdout_hash: "sha256:test" },
  };
}
function reseal(raw: Record<string, any>): void {
  const payload = { schema_version: raw.schema_version, ledger_id: raw.ledger_id, updated_at: raw.updated_at, prefixes: raw.prefixes, targets: raw.targets, observations: raw.observations, operations: raw.operations };
  raw.integrity_hash = `sha256:${createHash("sha256").update(canonicalizeForHash(payload)).digest("hex")}`;
}

describe("reuse-ledger", () => {
  it("deduplicates idempotent operation_ids and rejects no-op replays with different content", () => {
    const ledger = createPrefixReuseLedger("fixture", { now: "2026-08-10T00:00:00Z" });
    const input = {
      operation_id: "op-1",
      observed_at: "2026-08-10T00:00:01Z",
      observation_kind: "materialized" as const,
      prefix: {
        prefix_text: "provider=beta",
        prompt_template_id: "agent-uct/demo",
        token_units: 5,
        byte_length: 13,
      },
      target: {
        cluster_id: "core",
        item_id: "q1",
        config_id: "fixture",
      },
      marginal_cost_token_units: 5,
      marginal_cost: { kind: "unpriced" as const, reason: "logical prefix-cost units" },
      provenance: { tag: "generated" as const, generator: "test", input_hash: "sha256:test" },
    };

    const first = recordPrefixReuseObservation(ledger, input);
    const second = recordPrefixReuseObservation(first, input);

    expect(second).toBe(first);
    expect(second.observations).toHaveLength(1);
    expect(second.operations).toHaveLength(1);
  });

  it("summarizes materializations and reuses across the same prefix-target edge", () => {
    let ledger = createPrefixReuseLedger("fixture", { now: "2026-08-10T00:00:00Z" });
    ledger = recordPrefixReuseObservation(ledger, {
      operation_id: "op-1",
      observed_at: "2026-08-10T00:00:01Z",
      observation_kind: "materialized",
      prefix: {
        prefix_text: "provider=beta",
        prompt_template_id: "agent-uct/demo",
        token_units: 5,
        byte_length: 13,
      },
      target: {
        cluster_id: "core",
        item_id: "q1",
        config_id: "fixture",
      },
      marginal_cost_token_units: 5,
      marginal_cost: { kind: "unpriced", reason: "logical prefix-cost units" },
      provenance: { tag: "generated", generator: "test", input_hash: "sha256:test-1" },
    });
    ledger = recordPrefixReuseObservation(ledger, {
      operation_id: "op-2",
      observed_at: "2026-08-10T00:00:02Z",
      observation_kind: "reused",
      prefix: {
        prefix_text: "provider=beta",
        prompt_template_id: "agent-uct/demo",
        token_units: 5,
        byte_length: 13,
      },
      target: {
        cluster_id: "core",
        item_id: "q1",
        config_id: "fixture",
      },
      marginal_cost_token_units: 0,
      marginal_cost: { kind: "unpriced", reason: "logical prefix-cost units" },
      provenance: { tag: "generated", generator: "test", input_hash: "sha256:test-2" },
    });

    const summary = summarizePrefixReuseLedger(ledger);

    expect(summary.totals.materialization_count).toBe(1);
    expect(summary.totals.reuse_count).toBe(1);
    expect(summary.totals.reuse_ratio).toBe(0.5);
    expect(summary.edges).toHaveLength(1);
    expect(summary.edges[0]).toMatchObject({
      materialization_count: 1,
      reuse_count: 1,
      materialized_token_units: 5,
      reused_token_units: 0,
    });
  });

  it("round-trips sealed ledgers and persists idempotent observations under a writer lock", () => {
    const dir = temp();
    const initial = recordPrefixReuseObservation(createPrefixReuseLedger("roundtrip", { now: "2026-08-10T00:00:00Z" }), observation());
    savePrefixReuseLedger(initial, dir);
    expect(loadPrefixReuseLedgerResult("roundtrip", dir)).toEqual({ value: initial, diagnostics: [] });

    const replay = persistPrefixReuseObservation(dir, "roundtrip", observation(), { holder: "test" });
    expect(replay.changed).toBe(false);
    const appended = persistPrefixReuseObservation(dir, "roundtrip", { ...observation("op-2"), observation_kind: "reused", marginal_cost_token_units: 0 }, { now: "2026-08-10T00:00:02Z" });
    expect(appended.changed).toBe(true);
    expect(summarizePrefixReuseLedger(appended.ledger).totals).toMatchObject({ observation_count: 2, reuse_count: 1 });
    expect(loadPrefixReuseLedgerResult("missing", dir)).toEqual({ value: null, diagnostics: [] });
  });

  it("quarantines abandoned temporaries and corrupt snapshots with typed diagnostics", () => {
    const dir = temp();
    const base = join(dir, "eval-reuse-ledger");
    mkdirSync(base, { recursive: true });
    const abandoned = join(base, ".fixture.1.tmp");
    writeFileSync(abandoned, "partial");
    const temporary = reconcileReuseLedgerTemporaryFiles(dir, "fixture");
    expect(temporary[0]).toMatchObject({ artifact: "temporary_file", code: "invalid_shape" });
    expect(existsSync(abandoned)).toBe(false);

    const file = join(base, "fixture.json");
    writeFileSync(file, "not json");
    expect(loadPrefixReuseLedgerResult("fixture", dir).diagnostics[0]).toMatchObject({ code: "invalid_json", artifact: "eval_reuse_ledger" });

    const valid = recordPrefixReuseObservation(createPrefixReuseLedger("fixture", { now: "2026-08-10T00:00:00Z" }), observation());
    savePrefixReuseLedger(valid, dir);
    const tampered = JSON.parse(readFileSync(file, "utf8"));
    tampered.updated_at = "2026-08-10T00:00:09Z";
    writeFileSync(file, JSON.stringify(tampered));
    expect(loadPrefixReuseLedgerResult("fixture", dir).diagnostics[0]?.code).toBe("integrity_failure");

    savePrefixReuseLedger(valid, dir);
    const wrongIdentity = JSON.parse(readFileSync(file, "utf8"));
    wrongIdentity.ledger_id = "other";
    writeFileSync(file, JSON.stringify(wrongIdentity));
    expect(loadPrefixReuseLedgerResult("fixture", dir).diagnostics[0]?.code).toBe("identity_mismatch");
  });

  it("rejects conflicting operation replay and malformed observation inputs", () => {
    const ledger = recordPrefixReuseObservation(createPrefixReuseLedger("fixture", { now: "2026-08-10T00:00:00Z" }), observation());
    expect(() => recordPrefixReuseObservation(ledger, { ...observation(), marginal_cost_token_units: 9 })).toThrow(ReuseLedgerConflictError);
    for (const invalid of [
      { ...observation(""), operation_id: "" },
      { ...observation("bad-kind"), observation_kind: "other" },
      { ...observation("bad-time"), observed_at: "never" },
      { ...observation("bad-cost"), marginal_cost_token_units: -1 },
      { ...observation("bad-prefix"), prefix: { ...observation().prefix, prefix_text: "" } },
      { ...observation("bad-target"), target: { ...observation().target, item_id: "" } },
      { ...observation("bad-money"), marginal_cost: { kind: "priced", minor_units: 1.5, currency: "USD", minor_unit_exponent: 2, price_source_id: "fixture" } },
      { ...observation("bad-proof"), provenance: { tag: "claimed", claimant: "" } },
    ]) expect(() => recordPrefixReuseObservation(ledger, invalid as never), JSON.stringify(invalid)).toThrow();
    expect(() => createPrefixReuseLedger("", { now: "never" })).toThrow();
  });

  it("rejects structurally sealed corruption throughout every ledger entity", () => {
    const dir = temp();
    const file = join(dir, "eval-reuse-ledger", "fixture.json");
    const valid = recordPrefixReuseObservation(createPrefixReuseLedger("fixture", { now: "2026-08-10T00:00:00Z" }), observation());
    const cases: Array<(raw: Record<string, any>) => void> = [
      (raw) => { raw.schema_version = 2; },
      (raw) => { raw.updated_at = "invalid"; },
      (raw) => { raw.prefixes = null; },
      (raw) => { raw.integrity_hash = ""; },
      (raw) => { raw.prefixes[0].tool_contract_id = ""; },
      (raw) => { raw.prefixes[0].model_family = ""; },
      (raw) => { raw.prefixes[0].context_signature = ""; },
      (raw) => { raw.prefixes[0].prefix_id = "sha256:wrong"; },
      (raw) => { raw.prefixes[0].provenance = { tag: "claimed", claimant: "operator" }; },
      (raw) => { raw.targets[0].variant_id = ""; },
      (raw) => { raw.targets[0].target_id = "sha256:wrong"; },
      (raw) => { raw.observations[0].observation_kind = "unknown"; },
      (raw) => { raw.operations[0].recorded_at = "invalid"; },
      (raw) => { raw.prefixes.push(structuredClone(raw.prefixes[0])); },
      (raw) => { raw.targets.push(structuredClone(raw.targets[0])); },
      (raw) => { raw.observations.push(structuredClone(raw.observations[0])); },
      (raw) => { raw.operations.push(structuredClone(raw.operations[0])); },
      (raw) => { raw.observations[0].prefix_id = "sha256:missing"; },
      (raw) => { raw.observations[0].target_id = "sha256:missing"; },
      (raw) => { raw.observations[0].observation_id = "sha256:wrong"; },
      (raw) => { raw.operations[0].observation_id = "sha256:missing"; },
      (raw) => { raw.operations[0].fingerprint = "sha256:wrong"; },
      (raw) => { raw.operations[0].operation_id = "other"; },
    ];
    for (const mutate of cases) {
      savePrefixReuseLedger(valid, dir);
      const raw = JSON.parse(readFileSync(file, "utf8"));
      mutate(raw);
      if (raw.integrity_hash !== "") reseal(raw);
      writeFileSync(file, JSON.stringify(raw));
      const loaded = loadPrefixReuseLedgerResult("fixture", dir);
      expect(loaded.value).toBeNull();
      expect(loaded.diagnostics[0]?.code).toBe("invalid_shape");
    }
  });
});
