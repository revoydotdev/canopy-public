import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REMOTE_TRANSPORT_CANONICALIZATION,
  REMOTE_TRANSPORT_PROTOCOL,
  canonicalizeRemoteTransportSigningEnvelope,
  type RemoteTransportCommand,
  type RemoteTransportCommandMetadata,
  type RemoteTransportEnvelope,
  type RemoteTransportSigningEnvelope,
} from "./remote-transport-contracts.js";

/** Exact parent↔child edge a remote agent may address. */
export interface RemoteThreadAudience {
  readonly campaign_id: string;
  readonly parent_node_id: string;
  readonly child_node_id: string;
  /** The endpoint this session may author as; the other endpoint is recipient-only. */
  readonly author_node_id: string;
}

export interface RemoteSessionRegistration {
  readonly session_id: string;
  readonly actor_id: string;
  readonly key_id: string;
  readonly public_key_pem: string;
  /** Host-enrolment certificate binding this exact session/key/actor tuple. */
  readonly certificate_id: string;
  readonly expires_at: string;
  readonly thread_audiences: readonly RemoteThreadAudience[];
  /** Explicitly permits approval propose/decide envelopes; absent means denied. */
  readonly approval_authority?: boolean;
}

export interface RemoteSessionProof {
  readonly protocol: "revoy2.remote.v1";
  readonly session_id: string;
  readonly actor_id: string;
  readonly key_id: string;
  readonly certificate_id: string;
  readonly issued_at: string;
  readonly nonce: string;
  readonly signature: string;
}

export interface RemoteSessionIdentity {
  readonly registration: RemoteSessionRegistration;
  sign(input: { kind: string; metadata: Record<string, unknown>; params: Record<string, unknown>; nonce?: string; issued_at?: string }): RemoteSessionProof;
  /** Signs ADR-041's exact JCS preimage for an explicitly composed local host. */
  signTransport(input: { metadata: RemoteTransportCommandMetadata; command: RemoteTransportCommand; nonce?: string; issued_at?: string }): RemoteTransportEnvelope;
}

/** Public, non-secret lifecycle projection for an enrolled remote session. */
export interface RemoteSessionStatus {
  readonly session_id: string;
  readonly actor_id: string;
  readonly key_id: string;
  readonly certificate_id: string;
  readonly expires_at: string;
  readonly state: "active" | "expired" | "revoked";
  readonly revoked_at: string | null;
  /** Prior key ids invalidated by key rotation; the active public key is never projected. */
  readonly revoked_key_ids: readonly string[];
  /** Exact parent/child edges this session is permitted to author. */
  readonly thread_audiences: readonly RemoteThreadAudience[];
  /** Explicit approval authority; false means approval commands are denied. */
  readonly approval_authority: boolean;
}

type PersistedState = {
  version: 1;
  sessions: Array<RemoteSessionRegistration & { revoked_at: string | null; revoked_key_ids: string[] }>;
  consumed: Array<{ session_id: string; nonce: string; consumed_at: string }>;
};
type StoredSession = {
  session_id: string; actor_id: string; key_id: string; public_key_pem: string; certificate_id: string; expires_at: string;
  thread_audiences: readonly RemoteThreadAudience[]; approval_authority?: boolean;
  revoked_at: string | null; revoked_key_ids: Set<string>;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function sameAudience(a: RemoteThreadAudience, b: RemoteThreadAudience): boolean {
  return a.campaign_id === b.campaign_id && a.parent_node_id === b.parent_node_id && a.child_node_id === b.child_node_id && a.author_node_id === b.author_node_id;
}

/**
 * Creates an Ed25519 identity for a remote process. The host must separately
 * register `identity.registration`; generating a key is not enrolment.
 */
export function createRemoteSessionIdentity(input: Omit<RemoteSessionRegistration, "key_id" | "public_key_pem" | "certificate_id"> & { key_id?: string; certificate_id?: string }): RemoteSessionIdentity {
  const keys = generateKeyPairSync("ed25519");
  const public_key_pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const key_id = input.key_id ?? `remote-key:${createHash("sha256").update(public_key_pem).digest("hex").slice(0, 24)}`;
  const certificate_id = input.certificate_id ?? certificateId(input.session_id, input.actor_id, key_id, public_key_pem);
  const registration: RemoteSessionRegistration = { ...input, key_id, public_key_pem, certificate_id };
  return {
    registration,
    sign: ({ kind, metadata, params, nonce = randomUUID(), issued_at = new Date().toISOString() }) => ({
      protocol: "revoy2.remote.v1",
      session_id: registration.session_id,
      actor_id: registration.actor_id,
      key_id: registration.key_id,
      certificate_id: registration.certificate_id,
      issued_at,
      nonce,
      signature: sign(null, Buffer.from(canonical({ protocol: "revoy2.remote.v1", session_id: registration.session_id, actor_id: registration.actor_id, key_id: registration.key_id, certificate_id: registration.certificate_id, issued_at, nonce, kind, metadata, params })), keys.privateKey).toString("base64"),
    }),
    signTransport: ({ metadata, command, nonce = randomUUID(), issued_at = new Date().toISOString() }) => {
      const proof = {
        protocol: "revoy2.remote.v1" as const,
        session_id: registration.session_id,
        actor_id: registration.actor_id,
        key_id: registration.key_id,
        certificate_id: registration.certificate_id,
        issued_at,
        nonce,
      };
      const signing: RemoteTransportSigningEnvelope = {
        protocol: REMOTE_TRANSPORT_PROTOCOL,
        canonicalization: REMOTE_TRANSPORT_CANONICALIZATION,
        proof,
        metadata,
        command,
      };
      return {
        ...signing,
        proof: { ...proof, signature: sign(null, canonicalizeRemoteTransportSigningEnvelope(signing), keys.privateKey).toString("base64") },
      };
    },
  };
}

export type RemoteSessionVerification =
  | { ok: true; actor_id: string; session_id: string; key_id: string; certificate_id: string; nonce: string; issued_at: string }
  | { ok: false; error: string };

/**
 * Host-owned trust registry for an explicitly opted-in remote transport. It
 * persists registrations, revocations, key rotations and consumed nonces when
 * a persistence directory is supplied. It is not a network listener and does
 * not claim A2A/SSE compatibility.
 */
export class RemoteSessionAuthority {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly consumed = new Set<string>();
  private readonly statePath: string | null;
  private readonly now: () => Date;
  private readonly maxConsumedNonces: number;

  constructor(options: { persistence_dir?: string; now?: () => Date; max_consumed_nonces?: number } = {}) {
    this.statePath = options.persistence_dir === undefined ? null : join(options.persistence_dir, "remote-session-authority.json");
    this.now = options.now ?? (() => new Date());
    this.maxConsumedNonces = options.max_consumed_nonces ?? 10_000;
    if (!Number.isSafeInteger(this.maxConsumedNonces) || this.maxConsumedNonces < 1 || this.maxConsumedNonces > 1_000_000) throw new Error("max_consumed_nonces must be an integer from 1 through 1000000");
    this.restore();
  }

  register(input: RemoteSessionRegistration): void {
    this.validateRegistration(input);
    if (this.sessions.has(input.session_id)) throw new Error(`remote session ${input.session_id} is already registered`);
    this.sessions.set(input.session_id, { ...structuredClone(input), revoked_at: null, revoked_key_ids: new Set() });
    this.persist();
  }

  /** Key rotation atomically revokes the prior active key for this session. */
  rotateKey(input: { session_id: string; key_id: string; public_key_pem: string; certificate_id: string }): void {
    if (!text(input.key_id) || !text(input.public_key_pem) || !text(input.certificate_id)) throw new Error("remote key rotation requires key_id, public_key_pem and certificate_id");
    this.validatePublicKey(input.public_key_pem);
    const session = this.sessions.get(input.session_id);
    if (!session || session.revoked_at !== null) throw new Error("remote session is not active");
    if (session.key_id === input.key_id) throw new Error("remote key rotation must use a new key_id");
    session.revoked_key_ids.add(session.key_id);
    if (input.certificate_id !== certificateId(session.session_id, session.actor_id, input.key_id, input.public_key_pem)) throw new Error("remote key rotation certificate does not bind the proposed key");
    session.key_id = input.key_id;
    session.public_key_pem = input.public_key_pem;
    session.certificate_id = input.certificate_id;
    this.persist();
  }

  revokeSession(session_id: string): void {
    const session = this.sessions.get(session_id);
    if (!session) throw new Error("remote session is not registered");
    session.revoked_at = this.now().toISOString();
    this.persist();
  }

  /**
   * Lists only review-safe lifecycle data. In particular, it intentionally
   * never returns enrolled public-key material.
   */
  list(): readonly RemoteSessionStatus[] {
    return [...this.sessions.values()]
      .map((session) => this.statusFor(session))
      .sort((a, b) => a.session_id.localeCompare(b.session_id));
  }

  /** Returns the same review-safe projection for one registered session. */
  status(session_id: string): RemoteSessionStatus | null {
    const session = this.sessions.get(session_id);
    return session ? this.statusFor(session) : null;
  }

  verifyThread(proof: unknown, input: { kind: "bus.thread.send" | "bus.thread.ack"; metadata: Record<string, unknown>; params: Record<string, unknown>; audience: RemoteThreadAudience }): RemoteSessionVerification {
    return this.verify(proof, input, "thread");
  }

  verifyApproval(proof: unknown, input: { kind: "approval.request" | "approval.approve" | "approval.reject"; metadata: Record<string, unknown>; params: Record<string, unknown> }): RemoteSessionVerification {
    return this.verify(proof, input, "approval");
  }

  /** Verifies an ADR-041 JCS envelope before a local host reaches the router. */
  verifyTransportThread(proof: unknown, input: { signing_envelope: RemoteTransportSigningEnvelope; audience: RemoteThreadAudience }): RemoteSessionVerification {
    const signed = input.signing_envelope;
    return this.verify(proof, {
      kind: signed.command.kind as "bus.thread.send" | "bus.thread.ack",
      metadata: signed.metadata as Record<string, unknown>,
      params: signed.command.params as Record<string, unknown>,
      audience: input.audience,
      signed_payload: signed,
    }, "thread");
  }

  /** Verifies an ADR-041 JCS approval envelope before a local host reaches the router. */
  verifyTransportApproval(proof: unknown, input: { signing_envelope: RemoteTransportSigningEnvelope }): RemoteSessionVerification {
    const signed = input.signing_envelope;
    return this.verify(proof, {
      kind: signed.command.kind as "approval.request" | "approval.approve" | "approval.reject",
      metadata: signed.metadata as Record<string, unknown>,
      params: signed.command.params as Record<string, unknown>,
      signed_payload: signed,
    }, "approval");
  }

  private verify(proof: unknown, input: { kind: string; metadata: Record<string, unknown>; params: Record<string, unknown>; audience?: RemoteThreadAudience; signed_payload?: RemoteTransportSigningEnvelope }, scope: "thread" | "approval"): RemoteSessionVerification {
    // The local host is explicitly single-writer. Reloading the atomically
    // replaced authority file before every consumption prevents a stale
    // replacement instance from accepting a nonce already consumed by the
    // prior instance after restart/handoff. Multi-writer/distributed replay is
    // deliberately still a public-transport prerequisite, not implied here.
    if (this.statePath !== null) this.restore(true);
    if (typeof proof !== "object" || proof === null) return { ok: false, error: "remote session proof is required" };
    const p = proof as Partial<RemoteSessionProof>;
    if (p.protocol !== "revoy2.remote.v1" || !text(p.session_id) || !text(p.actor_id) || !text(p.key_id) || !text(p.certificate_id) || !text(p.issued_at) || !text(p.nonce) || !text(p.signature) || !Number.isFinite(Date.parse(p.issued_at))) return { ok: false, error: "remote session proof is malformed" };
    const session = this.sessions.get(p.session_id);
    if (!session || session.revoked_at !== null) return { ok: false, error: "remote session is not active" };
    if (session.actor_id !== p.actor_id || session.key_id !== p.key_id || session.certificate_id !== p.certificate_id || session.revoked_key_ids.has(p.key_id)) return { ok: false, error: "remote session identity, certificate or key is not active" };
    const now = this.now().getTime(); const issued = Date.parse(p.issued_at); const expires = Date.parse(session.expires_at);
    if (!Number.isFinite(expires) || issued > now + 60_000 || issued < now - 5 * 60_000 || now > expires) return { ok: false, error: "remote session proof is expired or outside the accepted clock window" };
    if (scope === "thread") {
      if (input.audience === undefined || !session.thread_audiences.some((audience) => sameAudience(audience, input.audience!))) return { ok: false, error: "remote session is not authorized for this direct parent-child edge" };
    } else if (session.approval_authority !== true) return { ok: false, error: "remote session is not authorized for approval decisions" };
    if (input.signed_payload !== undefined && !sameTransportProof(p, input.signed_payload.proof)) return { ok: false, error: "remote transport signing envelope does not bind the submitted proof" };
    try {
      const signedBytes = input.signed_payload === undefined
        ? Buffer.from(canonical({ protocol: p.protocol, session_id: p.session_id, actor_id: p.actor_id, key_id: p.key_id, certificate_id: p.certificate_id, issued_at: p.issued_at, nonce: p.nonce, kind: input.kind, metadata: input.metadata, params: input.params }))
        : canonicalizeRemoteTransportSigningEnvelope(input.signed_payload);
      const valid = verify(null, signedBytes, session.public_key_pem, Buffer.from(p.signature, "base64"));
      if (!valid) return { ok: false, error: "remote session signature did not verify" };
    } catch { return { ok: false, error: "remote session public key is invalid" }; }
    const replay = `${p.session_id}\u0000${p.nonce}`;
    if (this.consumed.has(replay)) return { ok: false, error: "remote session nonce was already consumed" };
    // Never evict a replay marker: eviction would turn an old signed request
    // into an accepted replay. Capacity exhaustion is an explicit fail-closed
    // operational condition that a host must resolve by rotating/replacing its
    // remote authority state.
    if (this.consumed.size >= this.maxConsumedNonces) return { ok: false, error: "remote session nonce replay store capacity is exhausted" };
    this.consumed.add(replay); this.persist();
    return { ok: true, actor_id: p.actor_id, session_id: p.session_id, key_id: p.key_id, certificate_id: p.certificate_id, nonce: p.nonce, issued_at: p.issued_at };
  }

  private validateRegistration(input: RemoteSessionRegistration): void {
    if (!text(input.session_id) || !text(input.actor_id) || !text(input.key_id) || !text(input.public_key_pem) || !text(input.certificate_id) || !text(input.expires_at) || !Number.isFinite(Date.parse(input.expires_at))) throw new Error("remote session registration is malformed");
    if (input.certificate_id !== certificateId(input.session_id, input.actor_id, input.key_id, input.public_key_pem)) throw new Error("remote session certificate does not bind its key and identity");
    this.validatePublicKey(input.public_key_pem);
    if (input.thread_audiences.some((a) => !text(a.campaign_id) || !text(a.parent_node_id) || !text(a.child_node_id) || !text(a.author_node_id) || a.parent_node_id === a.child_node_id || (a.author_node_id !== a.parent_node_id && a.author_node_id !== a.child_node_id))) throw new Error("remote session registration has an invalid thread audience");
  }

  private validatePublicKey(publicKeyPem: string): void {
    try {
      if (createPublicKey(publicKeyPem).asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
    } catch {
      throw new Error("remote session public key must be a valid Ed25519 public key");
    }
  }

  private statusFor(session: StoredSession): RemoteSessionStatus {
    const state: RemoteSessionStatus["state"] = session.revoked_at !== null
      ? "revoked"
      : this.now().getTime() > Date.parse(session.expires_at) ? "expired"
        : "active";
    return {
      session_id: session.session_id,
      actor_id: session.actor_id,
      key_id: session.key_id,
      certificate_id: session.certificate_id,
      expires_at: session.expires_at,
      state,
      revoked_at: session.revoked_at,
      revoked_key_ids: [...session.revoked_key_ids].sort((a, b) => a.localeCompare(b)),
      thread_audiences: structuredClone(session.thread_audiences),
      approval_authority: session.approval_authority === true,
    };
  }

  private restore(replace = false): void {
    if (this.statePath === null || !existsSync(this.statePath)) return;
    const state = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedState;
    if (state.version !== 1 || !Array.isArray(state.sessions) || !Array.isArray(state.consumed)) throw new Error("remote session authority state is malformed");
    if (replace) { this.sessions.clear(); this.consumed.clear(); }
    for (const raw of state.sessions) { this.validateRegistration(raw); this.sessions.set(raw.session_id, { ...raw, revoked_key_ids: new Set(raw.revoked_key_ids) }); }
    for (const item of state.consumed) { if (text(item.session_id) && text(item.nonce)) this.consumed.add(`${item.session_id}\u0000${item.nonce}`); }
    if (this.consumed.size > this.maxConsumedNonces) throw new Error("remote session authority replay store exceeds configured capacity");
  }

  private persist(): void {
    if (this.statePath === null) return;
    const state: PersistedState = { version: 1, sessions: [...this.sessions.values()].map((session) => ({ ...session, thread_audiences: [...session.thread_audiences], revoked_key_ids: [...session.revoked_key_ids] })), consumed: [...this.consumed].map((key) => { const [session_id, nonce] = key.split("\u0000"); return { session_id: session_id!, nonce: nonce!, consumed_at: this.now().toISOString() }; }) };
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 }); renameSync(temporary, this.statePath);
  }
}

function sameTransportProof(proof: Partial<RemoteSessionProof>, signingProof: Omit<RemoteTransportEnvelope["proof"], "signature">): boolean {
  return proof.protocol === signingProof.protocol && proof.session_id === signingProof.session_id
    && proof.actor_id === signingProof.actor_id && proof.key_id === signingProof.key_id
    && proof.certificate_id === signingProof.certificate_id && proof.issued_at === signingProof.issued_at
    && proof.nonce === signingProof.nonce;
}

/** Certificate ids are host-trusted enrolment bindings, not a public PKI claim. */
function certificateId(sessionId: string, actorId: string, keyId: string, publicKeyPem: string): string {
  return `remote-cert:${createHash("sha256").update(canonical({ session_id: sessionId, actor_id: actorId, key_id: keyId, public_key_pem: publicKeyPem })).digest("hex").slice(0, 32)}`;
}
