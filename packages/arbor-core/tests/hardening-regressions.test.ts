import { describe, expect, it } from "vitest";
import { canonicalizeForHash, isSafeRelativePath, isValidCampaignId, validateRuntimeCommand } from "../src/index.js";

const action = {
  description: "root",
  estimated_gain: 1,
  estimated_cost: 1,
  category: "implementation",
  delegate_to: "seed",
};

const command = (campaign_id: string, writePath = "src/file.ts") => ({
  schema_version: 1,
  metadata: {
    operation_id: "op", idempotency_key: "key", correlation_id: "correlation", actor_id: "actor",
    requested_at: "2026-01-01T00:00:00.000Z",
  },
  command: {
    kind: "campaign.start", campaign_id, plan_path: "plan.md",
    root_action: { ...action, high_risk_tool_scope: { write_paths: [writePath], command_argv: [["touch", "src/file.ts"]] } },
  },
});

describe("hardening regressions", () => {
  it("rejects traversal campaign IDs and Windows rooted capability paths", () => {
    expect(isValidCampaignId("../outside")).toBe(false);
    expect(isSafeRelativePath("C:\\outside\\file")).toBe(false);
    expect(validateRuntimeCommand(command("../outside"))).toMatchObject({ ok: false });
    expect(validateRuntimeCommand(command("campaign", "C:\\outside\\file"))).toMatchObject({ ok: false });
  });

  it("preserves a validated remote-session attestation in the normalized command", () => {
    const input: any = command("campaign");
    input.metadata.remote_session = {
      session_id: "session", key_id: "key", certificate_id: "certificate", nonce: "nonce",
      issued_at: "2026-01-01T00:00:00.000Z", integrity: "ed25519",
      proof_digest: `sha256:${"a".repeat(64)}`,
    };
    const result = validateRuntimeCommand(input);
    expect(result).toMatchObject({ ok: true, value: { metadata: { remote_session: input.metadata.remote_session } } });
  });

  it("does not execute accessors or permit NFC-key collisions while canonicalizing", () => {
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => "side effect" });
    expect(() => canonicalizeForHash(accessor)).toThrow(/accessor/i);
    expect(() => canonicalizeForHash({ "e\u0301": 1, "é": 2 })).toThrow(/collide/i);
  });
});
