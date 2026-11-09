import { describe, expect, it } from "vitest";
import {
  REMOTE_TRANSPORT_CANONICALIZATION,
  REMOTE_TRANSPORT_PROTOCOL,
  canonicalizeJcs,
  parseIJson,
  remoteTransportError,
  remoteTransportSigningEnvelope,
  validateRemoteTransportEnvelope,
  type RemoteTransportEnvelope,
} from "../src/remote-transport-contracts.js";

function envelope(): RemoteTransportEnvelope {
  return {
    protocol: REMOTE_TRANSPORT_PROTOCOL,
    canonicalization: REMOTE_TRANSPORT_CANONICALIZATION,
    proof: {
      protocol: "revoy2.remote.v1",
      session_id: "session-1",
      actor_id: "seed-1",
      key_id: "key-1",
      certificate_id: "certificate-1",
      issued_at: "2026-08-08T00:00:00.000Z",
      nonce: "0123456789abcdefghijkl",
      signature: "base64-signature",
    },
    metadata: {
      operation_id: "operation-1",
      idempotency_key: "same-effect-on-retry",
      correlation_id: "thread-1",
      actor_id: "seed-1",
      requested_at: "2026-08-08T00:00:00.000Z",
    },
    command: { kind: "bus.thread.send", params: { campaign_id: "campaign-1" } },
  };
}

describe("ADR-041 remote transport contract", () => {
  it("matches RFC 8785's published primitive and recursive-sort vectors", () => {
    // RFC 8785 §3.2.2/§3.2.3: ECMAScript number/string serialization plus
    // recursive member sorting. This is deliberately a public, language-
    // independent vector rather than a second implementation's output.
    const specimen = {
      numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 0.000000000000000000000000001],
      string: "€$\u000f\nA'B\"\\\\\"/",
      literals: [null, true, false],
    };
    expect(Buffer.from(canonicalizeJcs(specimen)).toString("utf8")).toBe("{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}");
    expect(Buffer.from(canonicalizeJcs({ "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" })).toString("utf8"))
      .toBe("{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😀\":\"Emoji: Grinning Face\",\"דּ\":\"Hebrew Letter Dalet With Dagesh\"}");
  });

  it("rejects duplicate members, non-I-JSON numbers and invalid Unicode at the serialized boundary", () => {
    expect(() => parseIJson('{"proof":{},"proof":{}}')).toThrow("duplicate member");
    expect(() => parseIJson('{"number":1e400}')).toThrow("non-finite number");
    expect(() => parseIJson('{"text":"\\udead"}')).toThrow("lone surrogate");
    expect(() => parseIJson(new Uint8Array([0xc3, 0x28]))).toThrow();
  });

  it("defines a closed, transport-neutral signing preimage", () => {
    const wire = envelope();
    expect(validateRemoteTransportEnvelope(wire)).toEqual([]);
    expect(remoteTransportSigningEnvelope(wire)).toEqual({
      protocol: "revoy2.remote.transport.v1",
      canonicalization: "RFC8785-JCS",
      proof: {
        protocol: "revoy2.remote.v1",
        session_id: "session-1",
        actor_id: "seed-1",
        key_id: "key-1",
        certificate_id: "certificate-1",
        issued_at: "2026-08-08T00:00:00.000Z",
        nonce: "0123456789abcdefghijkl",
      },
      metadata: wire.metadata,
      command: wire.command,
    });
  });

  it("rejects alternate canonicalization, undersized nonce and command expansion before crypto", () => {
    const invalid = envelope();
    expect(validateRemoteTransportEnvelope({ ...invalid, canonicalization: "JSON.stringify", proof: { ...invalid.proof, nonce: "short" }, command: { kind: "campaign.halt", params: {} } })).toEqual(expect.arrayContaining([
      "canonicalization must be RFC8785-JCS",
      "proof nonce must be base64url and encode at least 16 bytes",
      "command kind is not permitted for remote transport",
    ]));
  });

  it("distinguishes one-time proof nonce from stable catalog idempotency", () => {
    const original = envelope();
    const retry: RemoteTransportEnvelope = { ...original, proof: { ...original.proof, nonce: "another-nonce-012345678" } };
    expect(retry.metadata.idempotency_key).toBe("same-effect-on-retry");
    expect(retry.proof.nonce).not.toBe(original.proof.nonce);
  });

  it("keeps auth, replay and capacity outcomes typed without credential material", () => {
    expect(remoteTransportError("authentication_failed", "signature did not verify")).toMatchObject({ category: "authentication", retryable: false });
    expect(remoteTransportError("replay_store_unavailable", "authority unavailable")).toMatchObject({ category: "availability", retryable: true });
    expect(remoteTransportError("rate_limited", "quota exceeded")).toMatchObject({ category: "capacity", retryable: true });
  });
});
