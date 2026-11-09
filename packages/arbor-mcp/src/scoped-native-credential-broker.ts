/**
 * Production composition for opaque model credentials.
 *
 * Secret material crosses this module only at construction and only reaches a
 * model adapter through `NativeCredentialLeasePort.inject`. Leases expose an
 * opaque identity, expire quickly, and are scoped to one native session.
 */
import {
  InMemoryCredentialLeaseBroker,
  redactNativeText,
  type CredentialClock,
  type CredentialLeaseIssue,
  type NativeContextRedactorPort,
} from "@arbor/harness";
import type { NativeCredentialLeasePort } from "@arbor/harness";

export interface ScopedNativeCredentialBrokerOptions {
  readonly provider_id: string;
  readonly account_id: string;
  /** Secret ingress only; its return value never becomes an exposed field, record, or event. */
  readonly read_secret: () => string;
  /** Optional source-side expiry/revocation check, re-evaluated before every lease injection. */
  readonly credential_available?: () => boolean;
  readonly scopes?: readonly string[];
  readonly lease_ttl_ms?: number;
  readonly clock?: CredentialClock;
}

export interface NativeCredentialSessionScope {
  readonly session_id: string;
  readonly operation: "specialize" | "review";
  readonly campaign_id: string;
  readonly node_id: string;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 60 * 60_000;
const DEFAULT_SCOPES = ["model.invoke"] as const;

/**
 * Owns a single model-only credential source. There is intentionally no tool
 * lease factory here: model credentials must never be forwarded to tools.
 */
export class ScopedNativeCredentialBroker {
  private readonly broker: InMemoryCredentialLeaseBroker;
  private readonly ttlMs: number;
  private readonly scopes: readonly string[];
  private readonly clock: CredentialClock;
  private readonly identity: { readonly provider_id: string; readonly account_id: string };
  private readonly credentialAvailable: () => boolean;
  /** Capability only; a context manager never receives the API-key value. */
  readonly context_redactor: NativeContextRedactorPort;

  constructor(options: ScopedNativeCredentialBrokerOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.credentialAvailable = options.credential_available ?? (() => true);
    this.ttlMs = boundedTtl(options.lease_ttl_ms ?? DEFAULT_TTL_MS);
    this.scopes = Object.freeze([...(options.scopes ?? DEFAULT_SCOPES)]);
    validateText(options.provider_id, "provider_id");
    validateText(options.account_id, "account_id");
    const secret = options.read_secret();
    validateText(secret, "credential source");
    if (this.scopes.length === 0 || this.scopes.some((scope) => !scope.trim()) || new Set(this.scopes).size !== this.scopes.length) throw new Error("credential scopes must be non-empty and unique");
    this.broker = new InMemoryCredentialLeaseBroker(this.clock);
    this.broker.register({ provider_id: options.provider_id, account_id: options.account_id, scopes: this.scopes, secret });
    this.context_redactor = Object.freeze({ redact: (value: string) => redactNativeText(value, { secrets: [secret] }) });
    this.identity = Object.freeze({ provider_id: options.provider_id, account_id: options.account_id });
  }

  /** Returns `undefined` only if issuance cannot prove a valid scoped lease. */
  modelCredentialForSession(scope: NativeCredentialSessionScope): NativeCredentialLeasePort | undefined {
    validateScope(scope);
    const issued = this.broker.issue({
      provider_id: this.providerId(),
      account_id: this.accountId(),
      scopes: this.scopes,
      session_id: scope.session_id,
      expires_at: new Date(this.clock.now().getTime() + this.ttlMs).toISOString(),
    });
    if (!issued.issued) return undefined;
    return this.asNativeLease(issued, scope.session_id);
  }

  private providerId(): string { return this.identity.provider_id; }
  private accountId(): string { return this.identity.account_id; }

  private asNativeLease(issued: Extract<CredentialLeaseIssue, { readonly issued: true }>, sessionId: string): NativeCredentialLeasePort {
    const leaseId = issued.lease.lease_id;
    return Object.freeze({
      lease_id: leaseId,
      inject: async <T>(recipient: (secret: string) => Promise<T>): Promise<T> => {
        if (!this.credentialAvailable()) throw new ScopedCredentialLeaseError("credential source is expired or unavailable at dispatch");
        let invoked: Promise<T> | undefined;
        const resolution = this.broker.inject(leaseId, sessionId, (secret) => { invoked = recipient(secret); });
        if (!resolution.available || invoked === undefined) throw new ScopedCredentialLeaseError(resolution.available ? "credential recipient was not invoked" : `credential lease unavailable: ${resolution.absence}`);
        return invoked;
      },
    });
  }
}

export class ScopedCredentialLeaseError extends Error {
  constructor(message: string) { super(message); this.name = "ScopedCredentialLeaseError"; }
}

function boundedTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TTL_MS) throw new Error(`lease_ttl_ms must be a positive safe integer no greater than ${MAX_TTL_MS}`);
  return value;
}
function validateText(value: string, name: string): void { if (!value.trim()) throw new Error(`${name} must be non-empty`); }
function validateScope(scope: NativeCredentialSessionScope): void {
  validateText(scope.session_id, "session_id"); validateText(scope.campaign_id, "campaign_id"); validateText(scope.node_id, "node_id");
  if (scope.operation !== "specialize" && scope.operation !== "review") throw new Error("operation is invalid");
}
