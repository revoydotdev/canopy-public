import { describe, expect, it } from "vitest";
import { LocalSessionAuthority, verifyLocalSessionProof } from "../src/local-session.js";

describe("LocalSessionAuthority", () => {
  it("binds a signed command to a generated local session actor", () => {
    const identity = new LocalSessionAuthority().identity();
    const metadata = { operation_id: "op-1", idempotency_key: "key-1", correlation_id: "c-1", actor_id: identity.actor_id, requested_at: "2026-08-08T00:00:00.000Z" };
    const params = { request_id: "approval-1", actor: identity.actor_id };
    const proof = identity.signCommand({ kind: "approval.approve", metadata, params });
    expect(verifyLocalSessionProof(proof, { type: "command", kind: "approval.approve", metadata, params })).toMatchObject({ ok: true, actor_id: identity.actor_id });
    expect(verifyLocalSessionProof(proof, { type: "command", kind: "approval.approve", metadata, params: { ...params, request_id: "changed" } })).toMatchObject({ ok: false });
  });

  it("rotates to a new actor identity", () => {
    const authority = new LocalSessionAuthority();
    const first = authority.identity(); const second = authority.rotate();
    expect(second.actor_id).not.toBe(first.actor_id);
    expect(second.session_id).not.toBe(first.session_id);
  });
});
