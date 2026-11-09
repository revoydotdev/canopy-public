/**
 * scope-decision.test.ts — Y (ADR-070, PM-3): signed scope-decision hops.
 *
 * Covers `EvidenceLedger.recordScopeDecision`/`getScopeDecisions`,
 * `scopeDecisionSigningPayload`/`verifyScopeDecisionSignature`, and the
 * `verifyIntegrity` dispatch for `scope_decision` records.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalizeForHash } from "@arbor/core";
import {
  EvidenceLedger,
  scopeDecisionSigningPayload,
  validateScopeDecision,
  verifyScopeDecisionSignature,
  type ScopeDecisionInput,
  type ScopeDecisionKind,
  type ScopeDecisionRecord,
} from "../src/audit.js";

const CAMPAIGN = "camp1";

/** A signer holding one Ed25519 keypair, mirroring `manager.ts`'s campaign-local signer. */
function makeSigner() {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyBase64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return {
    publicKeyBase64,
    sign(payload: object): string {
      return sign(null, Buffer.from(canonicalizeForHash(payload), "utf8"), keys.privateKey).toString("base64");
    },
  };
}

function hop(
  ledger: EvidenceLedger,
  signer: ReturnType<typeof makeSigner>,
  overrides: Partial<{ node_id: string; paths: readonly string[]; decision: ScopeDecisionKind; decided_by: string; parent_decision_id: string | null; idempotency_key: string }> = {},
): ScopeDecisionInput {
  const nodeId = overrides.node_id ?? "node-a";
  const paths = overrides.paths ?? ["lib/a.js"];
  const decision = overrides.decision ?? "approved_widening";
  const parentDecisionId = overrides.parent_decision_id ?? null;
  const previousRecordContentHash = ledger.getLedgerTip(CAMPAIGN);
  const payload = scopeDecisionSigningPayload({
    campaign_id: CAMPAIGN, node_id: nodeId, paths, decision,
    parent_decision_id: parentDecisionId, previous_record_content_hash: previousRecordContentHash,
  });
  return {
    campaign_id: CAMPAIGN, node_id: nodeId, paths, decision,
    decided_by: overrides.decided_by ?? "operator",
    parent_decision_id: parentDecisionId,
    public_key: signer.publicKeyBase64,
    signature: signer.sign(payload),
    idempotency_key: overrides.idempotency_key ?? `hop:${nodeId}:${decision}`,
    previous_record_content_hash: previousRecordContentHash,
  };
}

describe("EvidenceLedger scope decisions (Y, ADR-070)", () => {
  it("sign/verify roundtrip: records a genesis hop, verifies, and is idempotent on idempotency_key", () => {
    const ledger = new EvidenceLedger();
    const signer = makeSigner();
    const input = hop(ledger, signer);
    const id = ledger.recordScopeDecision(input);
    expect(id).toMatch(/^scopedec_/);
    expect(ledger.recordScopeDecision(input)).toBe(id);
    const [record] = ledger.getScopeDecisions(CAMPAIGN);
    expect(record!.decision.public_key).toBe(signer.publicKeyBase64);
    expect(verifyScopeDecisionSignature(record!)).toBe(true);
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it("chains a second hop onto the first (same generation, real parent linkage)", () => {
    const ledger = new EvidenceLedger();
    const signer = makeSigner();
    const first = ledger.recordScopeDecision(hop(ledger, signer));
    const second = ledger.recordScopeDecision(hop(ledger, signer, { decision: "revoked", parent_decision_id: first, idempotency_key: "hop:revoke" }));
    expect(second).not.toBe(first);
    const [firstRecord, secondRecord] = ledger.getScopeDecisions(CAMPAIGN);
    expect(secondRecord!.decision.parent_decision_id).toBe(first);
    expect(secondRecord!.previous_hash).toBe(firstRecord!.content_hash);
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it("a retried idempotency_key with conflicting content is a loud conflict, not a silent overwrite", () => {
    const ledger = new EvidenceLedger();
    const signer = makeSigner();
    const input = hop(ledger, signer, { idempotency_key: "same-key" });
    ledger.recordScopeDecision(input);
    const conflicting = hop(ledger, signer, { idempotency_key: "same-key", paths: ["lib/b.js"] });
    expect(() => ledger.recordScopeDecision(conflicting)).toThrow(/conflicting scope decision/);
  });

  it("an idempotent retry with the same paths in a different order is not a false conflict", () => {
    // scopeDecisionSigningPayload sorts paths so signing/verification is
    // order-independent (see the describe block below) -- a caller retrying
    // the exact same signed call (same signature, same previous tip) with
    // its `paths` array literal built in a different order is still a
    // byte-identical retry, and the idempotency conflict check must
    // recognize it as one rather than police array element order.
    const ledger = new EvidenceLedger();
    const signer = makeSigner();
    const input = hop(ledger, signer, { paths: ["lib/a.js", "lib/b.js"], idempotency_key: "same-key-reordered" });
    const id = ledger.recordScopeDecision(input);
    const reordered: ScopeDecisionInput = { ...input, paths: ["lib/b.js", "lib/a.js"] };
    expect(ledger.recordScopeDecision(reordered)).toBe(id);
  });

  it("refuses a tampered payload (signature does not match the recorded fields)", () => {
    const ledger = new EvidenceLedger();
    const signer = makeSigner();
    const input = hop(ledger, signer);
    const tampered: ScopeDecisionInput = { ...input, paths: ["lib/tampered.js"] };
    expect(() => ledger.recordScopeDecision(tampered)).toThrow(/signature is invalid/);
  });

  it("refuses a signature signed against a stale ledger tip (the race guard)", () => {
    const ledger = new EvidenceLedger();
    const signer = makeSigner();
    const input = hop(ledger, signer);
    // Append an unrelated record to move the tip out from under the pre-signed input.
    ledger.record({
      campaign_id: CAMPAIGN, node_id: "node-a", timestamp: new Date().toISOString(), action_description: "x", action_category: "test",
      specialist_agent: "s", critic_agent: null, node_state_before: "expanding", node_state_after: "expanding",
      provenance: null, specialist_output: null, critic_verdict_approved: null, critic_root_cause: null,
      score_before: 0, score_after: 0, gates: [], kb_entries_written: [],
    });
    expect(() => ledger.recordScopeDecision(input)).toThrow(/stale ledger tip/);
  });

  it("refuses a parent_decision_id that does not resolve in the campaign", () => {
    const ledger = new EvidenceLedger();
    const signer = makeSigner();
    expect(() => ledger.recordScopeDecision(hop(ledger, signer, { parent_decision_id: "scopedec_nonexistent" })))
      .toThrow(/does not resolve/);
  });

  it("refuses a non-genesis hop whose public_key does not match its parent's generation key", () => {
    const ledger = new EvidenceLedger();
    const signer = makeSigner();
    const other = makeSigner();
    const first = ledger.recordScopeDecision(hop(ledger, signer));
    const secondInput = hop(ledger, other, { decision: "revoked", parent_decision_id: first, idempotency_key: "hop:cross-gen" });
    expect(() => ledger.recordScopeDecision(secondInput)).toThrow(/does not match its parent hop's generation key/);
  });

  it("validateScopeDecision enforces path bounds", () => {
    const ledger = new EvidenceLedger();
    const signer = makeSigner();
    const tooMany = Array.from({ length: 33 }, (_, i) => `p${i}`);
    expect(() => validateScopeDecision(hop(ledger, signer, { paths: tooMany }))).toThrow(/exceed 32 entries/);
    expect(() => validateScopeDecision(hop(ledger, signer, { paths: ["x".repeat(5000)] }))).toThrow(/exceeds 4096 UTF-8 bytes/);
  });

  it("verifyIntegrity rejects a hand-forged scope_decision (bad signature) surviving a reload", () => {
    const ledger = new EvidenceLedger();
    const signer = makeSigner();
    ledger.recordScopeDecision(hop(ledger, signer));
    const lines = ledger.toJSONL().split("\n").filter(Boolean);
    const record = JSON.parse(lines[0]!) as ScopeDecisionRecord;
    record.decision.signature = Buffer.from("forged").toString("base64");
    const reloaded = new EvidenceLedger();
    reloaded.fromJSONL([JSON.stringify(record)].join("\n"));
    const result = reloaded.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid scope decision signature/);
  });

  it("mints a fresh id after a reload (id-prefix coverage)", () => {
    const ledger = new EvidenceLedger();
    const signer = makeSigner();
    const firstId = ledger.recordScopeDecision(hop(ledger, signer));
    const reloaded = new EvidenceLedger();
    reloaded.fromJSONL(ledger.toJSONL());
    const secondId = reloaded.recordScopeDecision(hop(reloaded, signer, { decision: "revoked", parent_decision_id: firstId, idempotency_key: "hop:reload" }));
    expect(secondId).not.toBe(firstId);
  });
});

describe("scopeDecisionSigningPayload", () => {
  it("sorts paths so signing is order-independent", () => {
    const a = scopeDecisionSigningPayload({
      campaign_id: "c", node_id: "n", paths: ["b", "a"], decision: "approved_widening",
      parent_decision_id: null, previous_record_content_hash: null,
    });
    const b = scopeDecisionSigningPayload({
      campaign_id: "c", node_id: "n", paths: ["a", "b"], decision: "approved_widening",
      parent_decision_id: null, previous_record_content_hash: null,
    });
    expect(canonicalizeForHash(a)).toBe(canonicalizeForHash(b));
  });
});
