import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicOverwriteFile } from "@arbor/audit";

export type RemoteOperationCapability = "command.dispatch" | "result.submit";
export type RemoteGrantState = "issued" | "consent_required" | "ready" | "consumed" | "expired" | "revoked";
export interface RemoteOperationScope { session_id: string; campaign_id: string; operation_id: string; capabilities: readonly RemoteOperationCapability[]; sensitive: boolean }
export interface RemoteGrantProjection extends RemoteOperationScope { grant_id: string; issued_at: string; expires_at: string; state: RemoteGrantState; consumed_at: string | null; consented_at: string | null; revoked_at: string | null; revoked_reason: string | null }
type StoredGrant = RemoteGrantProjection & { token_hash: string };

/** Durable JIT grant registry. Only a SHA-256 token digest is persisted. */
export class RemoteOperationTokenAuthority {
  private readonly grants = new Map<string, StoredGrant>();
  private readonly path: string | null;
  constructor(private readonly options: { persistence_dir?: string; now?: () => Date; min_ttl_ms?: number; max_ttl_ms?: number } = {}) {
    this.path = options.persistence_dir ? join(options.persistence_dir, "remote-operation-grants.json") : null;
    if (this.path && existsSync(this.path)) this.load();
  }
  issue(scope: RemoteOperationScope, ttlMs = 60_000): { token: string; grant: RemoteGrantProjection } {
    validateScope(scope); const min = this.options.min_ttl_ms ?? 30_000; const max = this.options.max_ttl_ms ?? 300_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < min || ttlMs > max) throw new Error(`remote grant ttl must be from ${min} through ${max} ms`);
    const token = randomBytes(32).toString("base64url"); const issued = this.now();
    const grant: StoredGrant = { ...scope, capabilities: [...new Set(scope.capabilities)].sort(), grant_id: `remote-grant:${randomBytes(12).toString("hex")}`,
      token_hash: digest(token), issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + ttlMs).toISOString(),
      state: scope.sensitive ? "consent_required" : "ready", consumed_at: null, consented_at: null, revoked_at: null, revoked_reason: null };
    this.grants.set(grant.grant_id, grant); this.save(); return { token, grant: project(grant, issued) };
  }
  consent(grantId: string): RemoteGrantProjection {
    const grant = this.required(grantId); if (project(grant, this.now()).state !== "consent_required") throw new Error("remote grant is not awaiting consent");
    grant.state = "ready"; grant.consented_at = this.now().toISOString(); this.save(); return project(grant, this.now());
  }
  /** WA-45: revoke an outstanding grant before its TTL. Consumed grants cannot be revoked (the operation already ran); revoking twice is a no-op. */
  revoke(grantId: string, reason: string): RemoteGrantProjection {
    if (!reason.trim()) throw new Error("remote grant revocation requires a reason");
    const grant = this.required(grantId); const current = project(grant, this.now());
    if (current.state === "consumed") throw new Error("remote grant was already consumed and cannot be revoked");
    if (current.state === "revoked") return current;
    grant.state = "revoked"; grant.revoked_at = this.now().toISOString(); grant.revoked_reason = reason.trim().slice(0, 512); this.save(); return project(grant, this.now());
  }
  verifyAndConsume(token: string, expected: Omit<RemoteOperationScope, "capabilities" | "sensitive"> & { capability: RemoteOperationCapability }): RemoteGrantProjection {
    const hash = digest(token); const grant = [...this.grants.values()].find((item) => item.token_hash === hash);
    if (!grant) throw new RemoteGrantError("authentication_failed", "remote operation token is unknown");
    const current = project(grant, this.now());
    if (current.state === "revoked") throw new RemoteGrantError("authentication_failed", `remote operation token was revoked: ${current.revoked_reason ?? "no reason recorded"}`);
    if (current.state === "expired") throw new RemoteGrantError("authentication_failed", "remote operation token is expired");
    if (current.state === "consent_required") throw new RemoteGrantError("consent_required", "affirmative operator consent is required");
    if (current.state === "consumed") throw new RemoteGrantError("authentication_failed", "remote operation token was already consumed");
    if (grant.session_id !== expected.session_id || grant.campaign_id !== expected.campaign_id || grant.operation_id !== expected.operation_id || !grant.capabilities.includes(expected.capability)) throw new RemoteGrantError("authorization_denied", "remote operation token scope does not authorize this invocation");
    grant.state = "consumed"; grant.consumed_at = this.now().toISOString(); this.save(); return project(grant, this.now());
  }
  inspect(grantId: string): RemoteGrantProjection { return project(this.required(grantId), this.now()); }
  private required(id: string): StoredGrant { const value = this.grants.get(id); if (!value) throw new Error("remote grant does not exist"); return value; }
  private now(): Date { return (this.options.now ?? (() => new Date()))(); }
  private save(): void { if (this.path) atomicOverwriteFile(this.path, `${JSON.stringify({ version: 1, grants: [...this.grants.values()] })}\n`); }
  private load(): void { const parsed = JSON.parse(readFileSync(this.path!, "utf8")) as { version: number; grants: Array<Omit<StoredGrant, "revoked_at" | "revoked_reason"> & Partial<Pick<StoredGrant, "revoked_at" | "revoked_reason">>> }; if (parsed.version !== 1 || !Array.isArray(parsed.grants)) throw new Error("remote operation grant store is invalid"); for (const grant of parsed.grants) this.grants.set(grant.grant_id, { revoked_at: null, revoked_reason: null, ...grant }); }
}
export class RemoteGrantError extends Error { constructor(readonly code: "authentication_failed" | "authorization_denied" | "consent_required", message: string) { super(message); } }
function digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function project(grant: StoredGrant, now: Date): RemoteGrantProjection { const state = grant.state !== "consumed" && grant.state !== "revoked" && now.getTime() > Date.parse(grant.expires_at) ? "expired" : grant.state; const { token_hash: _token, ...value } = grant; return structuredClone({ ...value, state }); }
function validateScope(scope: RemoteOperationScope): void { if (![scope.session_id, scope.campaign_id, scope.operation_id].every((v) => typeof v === "string" && v.trim()) || scope.capabilities.length === 0 || scope.capabilities.some((v) => v !== "command.dispatch" && v !== "result.submit")) throw new Error("remote operation scope is invalid"); }
