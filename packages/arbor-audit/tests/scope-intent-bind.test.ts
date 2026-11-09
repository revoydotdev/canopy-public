import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  type ScopeIntentBindInput,
  SCOPE_INTENT_BIND_MAX_ARGV_ENTRIES,
  SCOPE_INTENT_BIND_MAX_ARGV_BYTES,
  SCOPE_INTENT_BIND_MAX_PURPOSE_BYTES,
  validateScopeIntentBind,
} from "../src/audit.js";

function bind(overrides: Partial<ScopeIntentBindInput> = {}): ScopeIntentBindInput {
  return {
    campaign_id: "campaign",
    node_id: "node-a",
    session_id: "session-1",
    intent_index: 0,
    argv_prefix: ["npm", "create"],
    purpose: "scaffold a project whose exact name is only known at runtime",
    bound_argv: ["npm", "create", "astro@latest", "generated-site-42"],
    idempotency_key: "scope-intent-bind:campaign:node-a:0",
    ...overrides,
  };
}

describe("ScopeIntentBind audit evidence (ADR-119 O3 provenance closure)", () => {
  it("recordScopeIntentBind appends a hash-chained record and is idempotent on the same idempotency_key", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordScopeIntentBind(bind());
    expect(id).toMatch(/^scopeintentbind_/);
    expect(ledger.recordScopeIntentBind(bind())).toBe(id);
    expect(() => ledger.recordScopeIntentBind(bind({ bound_argv: ["npm", "create", "astro@latest", "different-name"] })))
      .toThrow(/conflicting scope intent bind/);
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it("getScopeIntentBinds returns only records for the requested campaign, optionally filtered by node", () => {
    const ledger = new EvidenceLedger();
    ledger.recordScopeIntentBind(bind({ campaign_id: "a", node_id: "n1", idempotency_key: "k1" }));
    ledger.recordScopeIntentBind(bind({ campaign_id: "a", node_id: "n2", idempotency_key: "k2" }));
    ledger.recordScopeIntentBind(bind({ campaign_id: "b", node_id: "n1", idempotency_key: "k3" }));
    expect(ledger.getScopeIntentBinds("a")).toHaveLength(2);
    expect(ledger.getScopeIntentBinds("a", "n1")).toHaveLength(1);
    expect(ledger.getScopeIntentBinds("a", "n1")[0]!.bind.idempotency_key).toBe("k1");
  });

  it("proves the hash chain: a second bind for a different node links previous_hash to the first record's content_hash", () => {
    const ledger = new EvidenceLedger();
    ledger.recordScopeIntentBind(bind({ node_id: "n1", idempotency_key: "k1" }));
    ledger.recordScopeIntentBind(bind({ node_id: "n2", idempotency_key: "k2" }));
    const [first, second] = ledger.getScopeIntentBinds("campaign").sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    expect(first.previous_hash).toBeNull();
    expect(second.previous_hash).toBe(first.content_hash);
    expect(second.content_hash).not.toBe(first.content_hash);
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it("detects a tampered bound_argv after JSONL import -- exactly the tamper-evidence the ADR-119 operator acceptance rested on", () => {
    const source = new EvidenceLedger();
    source.recordScopeIntentBind(bind({ node_id: "n1", idempotency_key: "k1" }));
    source.recordScopeIntentBind(bind({ node_id: "n2", idempotency_key: "k2", bound_argv: ["npm", "create", "astro@latest", "site-9"] }));
    const rows = source.toJSONL().split("\n");
    const altered = JSON.parse(rows[0]) as { bind: { bound_argv: string[] } };
    altered.bind.bound_argv = ["npm", "create", "astro@latest", "SILENTLY-SWAPPED"];
    rows[0] = JSON.stringify(altered);

    const imported = new EvidenceLedger();
    imported.fromJSONL(rows.join("\n"));
    const result = imported.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.error).toContain("content hash does not match");
  });

  it("survives a JSONL round trip and keeps minting fresh ids after reload", () => {
    const first = new EvidenceLedger();
    const firstId = first.recordScopeIntentBind(bind({ idempotency_key: "k1" }));
    const reloaded = new EvidenceLedger();
    reloaded.fromJSONL(first.toJSONL());
    const secondId = reloaded.recordScopeIntentBind(bind({ idempotency_key: "k2", node_id: "node-b", intent_index: 1 }));
    expect(secondId).not.toBe(firstId);
    expect(reloaded.verifyIntegrity().valid).toBe(true);
  });

  it("validateScopeIntentBind requires bound_argv to be a positional extension of argv_prefix", () => {
    expect(() => validateScopeIntentBind(bind({ bound_argv: ["npm", "install"] })))
      .toThrow(/positional extension/);
  });

  it("validateScopeIntentBind bounds argv entry counts and byte sizes, and requires a non-empty purpose", () => {
    expect(() => validateScopeIntentBind(bind({
      argv_prefix: ["npm"], bound_argv: ["npm", ...Array.from({ length: SCOPE_INTENT_BIND_MAX_ARGV_ENTRIES }, () => "x")],
    }))).toThrow(/exceed/);
    expect(() => validateScopeIntentBind(bind({ bound_argv: ["x".repeat(SCOPE_INTENT_BIND_MAX_ARGV_BYTES + 1)] })))
      .toThrow(/exceeds/);
    expect(() => validateScopeIntentBind(bind({ purpose: "x".repeat(SCOPE_INTENT_BIND_MAX_PURPOSE_BYTES + 1) })))
      .toThrow(/purpose exceeds/);
    expect(() => validateScopeIntentBind(bind({ purpose: "" })))
      .toThrow(/requires campaign, node, session, purpose/);
  });

  it("validateScopeIntentBind requires a non-negative integer intent_index", () => {
    expect(() => validateScopeIntentBind(bind({ intent_index: -1 }))).toThrow(/non-negative integer/);
    expect(() => validateScopeIntentBind(bind({ intent_index: 1.5 }))).toThrow(/non-negative integer/);
  });

  it("rejects the reserved 'governance' campaign id like every other record kind", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordScopeIntentBind(bind({ campaign_id: "governance" }))).toThrow(/reserved/);
  });
});
