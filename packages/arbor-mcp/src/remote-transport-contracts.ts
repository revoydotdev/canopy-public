import type { OperationMetadata } from "@arbor/core";

/**
 * Prospective, transport-neutral protocol identifier. Its declaration does
 * not create a listener or assert compatibility with a third-party protocol.
 */
export const REMOTE_TRANSPORT_PROTOCOL = "revoy2.remote.transport.v1" as const;

/** The sole signing serialization permitted for a cross-language host. */
export const REMOTE_TRANSPORT_CANONICALIZATION = "RFC8785-JCS" as const;

/** A URL-safe nonce must encode at least 128 bits of cryptographic entropy. */
export const REMOTE_TRANSPORT_MIN_NONCE_BYTES = 16;
export const REMOTE_TRANSPORT_MIN_NONCE_CHARACTERS = 22;

export const REMOTE_TRANSPORT_COMMAND_KINDS = [
  "bus.thread.send",
  "bus.thread.ack",
  "approval.request",
  "approval.approve",
  "approval.reject",
] as const;

export type RemoteTransportCommandKind = (typeof REMOTE_TRANSPORT_COMMAND_KINDS)[number];

/**
 * The proof shape is deliberately transport-neutral. The signature is over
 * `RemoteTransportSigningEnvelope`, never over a JSON rendering chosen by a
 * particular host runtime.
 */
export interface RemoteTransportProof {
  readonly protocol: "revoy2.remote.v1";
  readonly session_id: string;
  readonly actor_id: string;
  readonly key_id: string;
  readonly certificate_id: string;
  readonly issued_at: string;
  readonly nonce: string;
  readonly signature: string;
}

export type RemoteTransportCommandMetadata = Omit<OperationMetadata, "remote_session">;

export interface RemoteTransportCommand {
  readonly kind: RemoteTransportCommandKind;
  /** Command-specific fields, excluding its discriminating kind. */
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Exact signature preimage. Serialize this value as RFC 8785 JCS UTF-8 bytes.
 * `proof.signature` is intentionally absent to make the signed set closed.
 */
export interface RemoteTransportSigningEnvelope {
  readonly protocol: typeof REMOTE_TRANSPORT_PROTOCOL;
  readonly canonicalization: typeof REMOTE_TRANSPORT_CANONICALIZATION;
  readonly proof: Omit<RemoteTransportProof, "signature">;
  readonly metadata: RemoteTransportCommandMetadata;
  readonly command: RemoteTransportCommand;
}

/**
 * Complete prospective wire envelope. Transport headers/certificates are
 * deliberately not members: they are authenticated by the host channel and
 * must not leak into durable command evidence.
 */
export interface RemoteTransportEnvelope extends RemoteTransportSigningEnvelope {
  readonly proof: RemoteTransportProof;
}

/** Durable, non-secret verification attribution. */
export interface RemoteTransportAuditAttribution {
  readonly integrity: "ed25519";
  /** `sha256:` plus lowercase hexadecimal SHA-256 of JCS signing bytes. */
  readonly proof_digest: `sha256:${string}`;
  readonly session_id: string;
  readonly actor_id: string;
  readonly key_id: string;
  readonly certificate_id: string;
  readonly verified_at: string;
}

export type RemoteTransportErrorCode =
  | "malformed_envelope"
  | "authentication_failed"
  | "authorization_denied"
  | "replay_detected"
  | "replay_store_unavailable"
  | "replay_store_exhausted"
  | "idempotency_conflict"
  | "request_too_large"
  | "response_too_large"
  | "rate_limited"
  | "transport_unavailable"
  | "internal_error";
export type RemoteTransportErrorCategory = "input" | "authentication" | "authorization" | "replay" | "idempotency" | "capacity" | "availability" | "internal";

export interface RemoteTransportError {
  readonly code: RemoteTransportErrorCode;
  readonly category: RemoteTransportErrorCategory;
  readonly retryable: boolean;
  /** Safe, credential-free detail suitable for a caller and audit projection. */
  readonly summary: string;
}

const errorPolicies: Readonly<Record<RemoteTransportErrorCode, Pick<RemoteTransportError, "category" | "retryable">>> = {
  malformed_envelope: { category: "input", retryable: false },
  authentication_failed: { category: "authentication", retryable: false },
  authorization_denied: { category: "authorization", retryable: false },
  replay_detected: { category: "replay", retryable: false },
  replay_store_unavailable: { category: "availability", retryable: true },
  replay_store_exhausted: { category: "capacity", retryable: true },
  idempotency_conflict: { category: "idempotency", retryable: false },
  request_too_large: { category: "input", retryable: false },
  response_too_large: { category: "capacity", retryable: false },
  rate_limited: { category: "capacity", retryable: true },
  transport_unavailable: { category: "availability", retryable: true },
  internal_error: { category: "internal", retryable: true },
};

export function remoteTransportError(code: RemoteTransportErrorCode, summary: string): RemoteTransportError {
  return { code, ...errorPolicies[code], summary };
}

/** Returns the exact object a future host must pass to its RFC 8785 encoder. */
export function remoteTransportSigningEnvelope(envelope: RemoteTransportEnvelope): RemoteTransportSigningEnvelope {
  const { signature: _signature, ...proof } = envelope.proof;
  return {
    protocol: envelope.protocol,
    canonicalization: envelope.canonicalization,
    proof,
    metadata: envelope.metadata,
    command: envelope.command,
  };
}

/**
 * RFC 8785's ECMAScript serialization profile, restricted to I-JSON values.
 * The returned bytes—not `JSON.stringify` on a host-selected object—are the
 * exact signature/digest input for the local ADR-041 host. A future non-JS
 * host must prove the same vectors before it is composed.
 */
export function canonicalizeRemoteTransportSigningEnvelope(envelope: RemoteTransportSigningEnvelope): Uint8Array {
  return canonicalizeJcs(envelope);
}

/**
 * Generic RFC 8785 JCS encoder used by shared conformance vectors. It accepts
 * only I-JSON values; the byte boundary must use `parseIJson` below so JSON
 * duplicate member names cannot be erased by a host parser first.
 */
export function canonicalizeJcs(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value, new Set<object>()), "utf8");
}

/**
 * Strict local byte-boundary parser. JSON.parse alone silently accepts a
 * duplicate member and maps `1e400` to Infinity, either of which makes a
 * signed representation ambiguous or non-I-JSON. This parser rejects both
 * before envelope validation or cryptographic work.
 */
export function parseIJson(input: string | Uint8Array): unknown {
  const source = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  return new IJsonReader(source).read();
}

/**
 * Structural validation only. It intentionally performs neither JCS encoding,
 * cryptographic verification, nonce consumption, nor network authentication.
 */
export function validateRemoteTransportEnvelope(input: unknown): string[] {
  if (!record(input)) return ["remote transport envelope must be an object"];
  const failures: string[] = [];
  if (input.protocol !== REMOTE_TRANSPORT_PROTOCOL) failures.push(`protocol must be ${REMOTE_TRANSPORT_PROTOCOL}`);
  if (input.canonicalization !== REMOTE_TRANSPORT_CANONICALIZATION) failures.push(`canonicalization must be ${REMOTE_TRANSPORT_CANONICALIZATION}`);
  if (!record(input.proof)) failures.push("proof is required");
  else {
    const proof = input.proof;
    if (proof.protocol !== "revoy2.remote.v1") failures.push("proof protocol must be revoy2.remote.v1");
    for (const key of ["session_id", "actor_id", "key_id", "certificate_id", "issued_at", "signature"] as const) if (!text(proof[key])) failures.push(`proof ${key} is required`);
    if (!text(proof.nonce) || !BASE64URL.test(proof.nonce) || proof.nonce.length < REMOTE_TRANSPORT_MIN_NONCE_CHARACTERS) failures.push(`proof nonce must be base64url and encode at least ${REMOTE_TRANSPORT_MIN_NONCE_BYTES} bytes`);
    if (text(proof.issued_at) && !Number.isFinite(Date.parse(proof.issued_at))) failures.push("proof issued_at must be an ISO timestamp");
  }
  if (!record(input.metadata)) failures.push("metadata is required");
  else for (const key of ["operation_id", "idempotency_key", "correlation_id", "actor_id", "requested_at"] as const) if (!text(input.metadata[key])) failures.push(`metadata ${key} is required`);
  if (!record(input.command)) failures.push("command is required");
  else {
    if (!REMOTE_TRANSPORT_COMMAND_KINDS.includes(input.command.kind as RemoteTransportCommandKind)) failures.push("command kind is not permitted for remote transport");
    if (!record(input.command.params)) failures.push("command params are required");
  }
  return failures;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

function canonicalJson(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      if (hasLoneSurrogate(value)) throw new Error("RFC8785-JCS input contains a lone surrogate");
      return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("RFC8785-JCS input contains a non-finite number");
      return JSON.stringify(value);
    case "object": break;
    default: throw new Error("RFC8785-JCS input must contain JSON values only");
  }
  if (stack.has(value)) throw new Error("RFC8785-JCS input must not be cyclic");
  stack.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, stack)).join(",")}]`;
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => {
      if (hasLoneSurrogate(key)) throw new Error("RFC8785-JCS input contains a lone surrogate");
      return `${JSON.stringify(key)}:${canonicalJson(object[key], stack)}`;
    }).join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

class IJsonReader {
  private position = 0;
  constructor(private readonly source: string) {}

  read(): unknown {
    this.space();
    const value = this.value();
    this.space();
    if (this.position !== this.source.length) throw new Error("I-JSON has trailing data");
    return value;
  }

  private value(): unknown {
    this.space();
    const current = this.source[this.position];
    if (current === "{") return this.object();
    if (current === "[") return this.array();
    if (current === "\"") return this.string();
    if (current === "t") return this.literal("true", true);
    if (current === "f") return this.literal("false", false);
    if (current === "n") return this.literal("null", null);
    if (current === "-" || (current !== undefined && current >= "0" && current <= "9")) return this.number();
    throw new Error("I-JSON has an invalid value");
  }

  private object(): Record<string, unknown> {
    this.position += 1;
    this.space();
    const object = Object.create(null) as Record<string, unknown>;
    const names = new Set<string>();
    if (this.take("}")) return object;
    while (true) {
      this.space();
      if (this.source[this.position] !== "\"") throw new Error("I-JSON object member name is required");
      const name = this.string();
      if (names.has(name)) throw new Error(`I-JSON object has duplicate member ${JSON.stringify(name)}`);
      names.add(name);
      this.space(); this.required(":");
      object[name] = this.value();
      this.space();
      if (this.take("}")) return object;
      this.required(",");
    }
  }

  private array(): unknown[] {
    this.position += 1;
    this.space();
    const values: unknown[] = [];
    if (this.take("]")) return values;
    while (true) {
      values.push(this.value());
      this.space();
      if (this.take("]")) return values;
      this.required(",");
    }
  }

  private string(): string {
    const start = this.position;
    this.position += 1;
    let escaped = false;
    while (this.position < this.source.length) {
      const code = this.source.charCodeAt(this.position);
      const current = this.source[this.position++];
      if (!escaped && current === "\"") {
        const raw = this.source.slice(start, this.position);
        let value: string;
        try { value = JSON.parse(raw) as string; } catch { throw new Error("I-JSON contains an invalid string"); }
        if (hasLoneSurrogate(value)) throw new Error("I-JSON contains a lone surrogate");
        return value;
      }
      if (!escaped && code < 0x20) throw new Error("I-JSON string contains an unescaped control character");
      if (!escaped && current === "\\") { escaped = true; continue; }
      escaped = false;
    }
    throw new Error("I-JSON contains an unterminated string");
  }

  private number(): number {
    const rest = this.source.slice(this.position);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (!match) throw new Error("I-JSON contains an invalid number");
    const raw = match[0]!;
    this.position += raw.length;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error("I-JSON contains a non-finite number");
    return value;
  }

  private literal<T>(literal: string, value: T): T { this.required(literal); return value; }
  private space(): void { while (/\s/.test(this.source[this.position] ?? "")) this.position += 1; }
  private take(value: string): boolean { if (this.source.startsWith(value, this.position)) { this.position += value.length; return true; } return false; }
  private required(value: string): void { if (!this.take(value)) throw new Error(`I-JSON expected ${value}`); }
}
