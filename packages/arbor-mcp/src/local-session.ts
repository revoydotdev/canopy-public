import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

/**
 * A locally-generated, signed operator session.  It proves continuity of one
 * process-held key, not a human's real-world identity; transports that need
 * personhood must authenticate the session before constructing this object.
 */
export interface LocalSessionProof {
  readonly session_id: string;
  readonly actor_id: string;
  readonly public_key_pem: string;
  readonly issued_at: string;
  readonly signature: string;
}

export interface LocalSessionIdentity {
  readonly session_id: string;
  readonly actor_id: string;
  signCommand(input: { kind: string; metadata: Record<string, unknown>; params: Record<string, unknown> }): LocalSessionProof;
  signQuery(input: { kind: string; query_id: string; params: Record<string, unknown> }): LocalSessionProof;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "session")
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function createIdentity(): LocalSessionIdentity {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const sessionId = createHash("sha256").update(publicKey).digest("hex").slice(0, 24);
  const actorId = `local-session:${sessionId}`;
  const proof = (payload: Record<string, unknown>): LocalSessionProof => {
    const issued_at = new Date().toISOString();
    const signature = sign(null, Buffer.from(canonical({ ...payload, actor_id: actorId, session_id: sessionId, issued_at })), keys.privateKey).toString("base64");
    return { session_id: sessionId, actor_id: actorId, public_key_pem: publicKey, issued_at, signature };
  };
  return {
    session_id: sessionId,
    actor_id: actorId,
    signCommand: ({ kind, metadata, params }) => proof({ type: "command", kind, metadata, params }),
    signQuery: ({ kind, query_id, params }) => proof({ type: "query", kind, query_id, params }),
  };
}

/** Rotating a session creates a fresh key/actor and leaves the old key unable to sign future requests. */
export class LocalSessionAuthority {
  private current = createIdentity();
  identity(): LocalSessionIdentity { return this.current; }
  rotate(): LocalSessionIdentity { this.current = createIdentity(); return this.current; }
}

export function verifyLocalSessionProof(
  proof: unknown,
  payload: Record<string, unknown>,
): { ok: true; actor_id: string; session_id: string } | { ok: false; error: string } {
  if (typeof proof !== "object" || proof === null) return { ok: false, error: "signed local session proof is required" };
  const p = proof as Record<string, unknown>;
  if (typeof p.session_id !== "string" || typeof p.actor_id !== "string" || typeof p.public_key_pem !== "string"
    || typeof p.issued_at !== "string" || typeof p.signature !== "string" || !Number.isFinite(Date.parse(p.issued_at))) return { ok: false, error: "local session proof is malformed" };
  const expectedSession = createHash("sha256").update(p.public_key_pem).digest("hex").slice(0, 24);
  if (p.session_id !== expectedSession || p.actor_id !== `local-session:${expectedSession}`) return { ok: false, error: "local session proof identity does not match its key" };
  try {
    const valid = verify(null, Buffer.from(canonical({ ...payload, actor_id: p.actor_id, session_id: p.session_id, issued_at: p.issued_at })), p.public_key_pem, Buffer.from(p.signature, "base64"));
    return valid ? { ok: true, actor_id: p.actor_id, session_id: p.session_id } : { ok: false, error: "local session signature did not verify" };
  } catch { return { ok: false, error: "local session public key is invalid" }; }
}
