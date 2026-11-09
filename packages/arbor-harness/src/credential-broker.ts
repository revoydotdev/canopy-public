/**
 * Opaque, in-memory credential leases.  Secret material is accepted at the
 * registration/injection boundary only; it is never a field of a lease,
 * inspection result, diagnostic, or error.
 */

export interface CredentialClock {
  now(): Date;
}

export const systemCredentialClock: CredentialClock = { now: () => new Date() };

export interface SpendAmount {
  readonly currency: string;
  readonly minor_units: number;
}

export interface CredentialRequirement {
  readonly provider_id: string;
  readonly account_id: string;
  readonly scopes: readonly string[];
  readonly session_id: string;
  readonly expires_at: string;
  readonly spend_ceiling?: SpendAmount;
}

/** Stored internally. This is the only public input shape that contains a secret. */
export interface CredentialRegistration {
  readonly provider_id: string;
  readonly account_id: string;
  readonly scopes: readonly string[];
  readonly secret: string;
}

/** Deliberately excludes secret material. Safe to attach to an event by identity only. */
export interface CredentialLease {
  readonly lease_id: string;
  readonly provider_id: string;
  readonly account_id: string;
  readonly scopes: readonly string[];
  readonly session_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly spend_ceiling: SpendAmount | null;
  readonly spent: SpendAmount | null;
}

export type CredentialAbsence = "not_found" | "expired" | "revoked" | "scope_denied" | "session_mismatch" | "spend_ceiling_exceeded";

export type CredentialLeaseResolution =
  | { readonly available: true; readonly lease: CredentialLease }
  | { readonly available: false; readonly absence: CredentialAbsence; readonly lease_id: string; readonly reason: string };

export type CredentialLeaseIssue =
  | { readonly issued: true; readonly lease: CredentialLease }
  | { readonly issued: false; readonly absence: "not_found" | "scope_denied" | "expired"; readonly reason: string };

export class CredentialBrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialBrokerError";
  }
}

interface StoredCredential {
  readonly provider_id: string;
  readonly account_id: string;
  readonly scopes: ReadonlySet<string>;
  readonly secret: string;
}

interface StoredLease extends CredentialLease {
  readonly revoked_at: string | null;
}

function sourceKey(providerId: string, accountId: string): string {
  return `${providerId}\u0000${accountId}`;
}

function copyAmount(amount: SpendAmount | null): SpendAmount | null {
  return amount === null ? null : { ...amount };
}

function leaseView(lease: StoredLease): CredentialLease {
  return {
    lease_id: lease.lease_id,
    provider_id: lease.provider_id,
    account_id: lease.account_id,
    scopes: [...lease.scopes],
    session_id: lease.session_id,
    issued_at: lease.issued_at,
    expires_at: lease.expires_at,
    spend_ceiling: copyAmount(lease.spend_ceiling),
    spent: copyAmount(lease.spent),
  };
}

function requiredScopesPresent(available: ReadonlySet<string>, requested: readonly string[]): boolean {
  return requested.every((scope) => available.has(scope));
}

function validRequirement(requirement: CredentialRequirement): void {
  if (!requirement.provider_id.trim() || !requirement.account_id.trim() || !requirement.session_id.trim()) throw new CredentialBrokerError("provider_id, account_id, and session_id must be non-empty");
  if (Number.isNaN(Date.parse(requirement.expires_at))) throw new CredentialBrokerError("expires_at must be an ISO timestamp");
  if (requirement.scopes.length === 0 || new Set(requirement.scopes).size !== requirement.scopes.length || requirement.scopes.some((scope) => !scope.trim())) throw new CredentialBrokerError("scopes must be non-empty and unique");
  if (requirement.spend_ceiling && (!requirement.spend_ceiling.currency.trim() || !Number.isSafeInteger(requirement.spend_ceiling.minor_units) || requirement.spend_ceiling.minor_units < 0)) {
    throw new CredentialBrokerError("spend_ceiling must have a currency and non-negative integer minor_units");
  }
}

/**
 * A deterministic, injectable lease authority. It is intentionally neither a
 * keychain nor a secret serializer; production stores can implement the same
 * opaque contract behind a hardened secret boundary.
 */
export class InMemoryCredentialLeaseBroker {
  private readonly credentials = new Map<string, StoredCredential>();
  private readonly leases = new Map<string, StoredLease>();
  private nextLease = 1;

  constructor(private readonly clock: CredentialClock = systemCredentialClock) {}

  register(registration: CredentialRegistration): void {
    if (!registration.provider_id.trim() || !registration.account_id.trim() || !registration.secret) throw new CredentialBrokerError("provider_id, account_id, and secret must be non-empty");
    if (registration.scopes.length === 0 || registration.scopes.some((scope) => !scope.trim()) || new Set(registration.scopes).size !== registration.scopes.length) throw new CredentialBrokerError("credential scopes must be non-empty and unique");
    this.credentials.set(sourceKey(registration.provider_id, registration.account_id), {
      provider_id: registration.provider_id,
      account_id: registration.account_id,
      scopes: new Set(registration.scopes),
      secret: registration.secret,
    });
  }

  issue(requirement: CredentialRequirement): CredentialLeaseIssue {
    validRequirement(requirement);
    const now = this.clock.now();
    const expires = Date.parse(requirement.expires_at);
    if (expires <= now.getTime()) return { issued: false, absence: "expired", reason: "requested credential lease is already expired" };
    const credential = this.credentials.get(sourceKey(requirement.provider_id, requirement.account_id));
    if (!credential) return { issued: false, absence: "not_found", reason: "no credential is registered for provider and account" };
    if (!requiredScopesPresent(credential.scopes, requirement.scopes)) return { issued: false, absence: "scope_denied", reason: "registered credential does not grant every requested scope" };
    const lease: StoredLease = {
      lease_id: `credential-lease-${this.nextLease++}`,
      provider_id: requirement.provider_id,
      account_id: requirement.account_id,
      scopes: [...requirement.scopes],
      session_id: requirement.session_id,
      issued_at: now.toISOString(),
      expires_at: requirement.expires_at,
      spend_ceiling: requirement.spend_ceiling ? { ...requirement.spend_ceiling } : null,
      spent: requirement.spend_ceiling ? { currency: requirement.spend_ceiling.currency, minor_units: 0 } : null,
      revoked_at: null,
    };
    this.leases.set(lease.lease_id, lease);
    return { issued: true, lease: leaseView(lease) };
  }

  inspect(leaseId: string, sessionId?: string): CredentialLeaseResolution {
    const lease = this.leases.get(leaseId);
    if (!lease) return { available: false, absence: "not_found", lease_id: leaseId, reason: "credential lease is not known" };
    if (lease.revoked_at !== null) return { available: false, absence: "revoked", lease_id: leaseId, reason: "credential lease was revoked" };
    if (Date.parse(lease.expires_at) <= this.clock.now().getTime()) return { available: false, absence: "expired", lease_id: leaseId, reason: "credential lease has expired" };
    if (sessionId !== undefined && lease.session_id !== sessionId) return { available: false, absence: "session_mismatch", lease_id: leaseId, reason: "credential lease belongs to a different session" };
    return { available: true, lease: leaseView(lease) };
  }

  revoke(leaseId: string): CredentialLeaseResolution {
    const lease = this.leases.get(leaseId);
    if (!lease) return { available: false, absence: "not_found", lease_id: leaseId, reason: "credential lease is not known" };
    if (lease.revoked_at === null) {
      this.leases.set(leaseId, { ...lease, revoked_at: this.clock.now().toISOString() });
    }
    return { available: false, absence: "revoked", lease_id: leaseId, reason: "credential lease was revoked" };
  }

  /** Adds attributable cost without ever treating a missing price as zero. */
  reserveSpend(leaseId: string, amount: SpendAmount, sessionId?: string): CredentialLeaseResolution {
    if (!amount.currency.trim() || !Number.isSafeInteger(amount.minor_units) || amount.minor_units < 0) throw new CredentialBrokerError("spend amount must have a currency and non-negative integer minor_units");
    const resolved = this.inspect(leaseId, sessionId);
    if (!resolved.available) return resolved;
    const lease = this.leases.get(leaseId)!;
    if (!lease.spend_ceiling || !lease.spent) return resolved;
    if (amount.currency !== lease.spend_ceiling.currency || lease.spent.minor_units + amount.minor_units > lease.spend_ceiling.minor_units) {
      return { available: false, absence: "spend_ceiling_exceeded", lease_id: leaseId, reason: "spend amount exceeds the credential lease ceiling" };
    }
    const next: StoredLease = { ...lease, spent: { currency: lease.spent.currency, minor_units: lease.spent.minor_units + amount.minor_units } };
    this.leases.set(leaseId, next);
    return { available: true, lease: leaseView(next) };
  }

  /**
   * Injects into a caller-provided sink only after all lease checks pass. The
   * secret is not returned, retained in any result, or rendered in failures.
   */
  inject(leaseId: string, sessionId: string, sink: (secret: string) => void): CredentialLeaseResolution {
    const resolved = this.inspect(leaseId, sessionId);
    if (!resolved.available) return resolved;
    const lease = this.leases.get(leaseId)!;
    const credential = this.credentials.get(sourceKey(lease.provider_id, lease.account_id));
    if (!credential || !requiredScopesPresent(credential.scopes, lease.scopes)) {
      return { available: false, absence: "scope_denied", lease_id: leaseId, reason: "credential source no longer grants lease scopes" };
    }
    sink(credential.secret);
    return resolved;
  }
}
