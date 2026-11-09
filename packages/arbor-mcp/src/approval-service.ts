import { compareCodeUnits } from "@arbor/core";
import { canonicalizeForHash } from "@arbor/core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/**
 * Approval/policy backend (roadmap 4C, item 22).
 *
 * Durable approval workflow with checks-and-balances (handoff §2 IV): NO
 * agent both proposes and approves. A request records its proposer; an
 * approve/reject by the same actor is self-approval and is structurally
 * rejected (fail-closed). Requests carry durable ids, idempotency via
 * request_id (replay same payload → same result; different payload with the
 * same id → conflict), and a bounded TTL after which the request expires.
 *
 * This is the canonical capability a later TUI approval screen projects.
 * It never blesses an action itself — it only records the durable approval
 * decision for an orchestration layer to act on.
 */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalMemoryScope = "once" | "session" | "persistent";

export type ApprovalAction = "campaign.halt" | "recovery.abandon" | "output.raw" | "permission.grant";

const APPROVAL_ACTIONS = new Set<string>(["campaign.halt", "recovery.abandon", "output.raw", "permission.grant"]);

export interface ApprovalRequestInput {
  request_id: string;
  idempotency_key: string;
  action: ApprovalAction;
  subject: string;
  resource_id: string;
  proposer: string;
  rationale: string;
  expires_at: string;
  lease_scope?: ApprovalLeaseScope;
}

export interface ApprovalLeaseScope {
  operation: ApprovalAction;
  capability: string;
  target: string;
  reversible: boolean;
  systems_touched: string[];
  policy_version: string;
  actor: string;
  session_id: string | null;
}

export interface ApprovalRecord {
  request_id: string;
  idempotency_key: string;
  action: ApprovalAction;
  subject: string;
  resource_id: string;
  proposer: string;
  rationale: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string;
  action_fingerprint: string;
  lease_scope: ApprovalLeaseScope;
  decision_scope: ApprovalMemoryScope | null;
  remembered_from: string | null;
}

export interface ApprovalDecisionInput {
  request_id: string;
  actor: string;
  clock: string;
  memory_scope?: ApprovalMemoryScope;
}

export interface ApprovalMemoryRule {
  action_fingerprint: string;
  decided_by: string;
  scope: "session" | "persistent";
  source_request_id: string;
  expires_at: string;
}

export interface ApprovalServiceOptions {
  clock?: () => string;
  /** Bound the number of pending/terminal records retained. */
  max_records?: number;
  /** Optional durable record store; mutations are atomically checkpointed. */
  persistence_dir?: string;
}

/**
 * Verify that a durable approval record can authorize one concrete resource.
 * This is deliberately shared by campaign halt and raw-output disclosure so
 * neither command grows a weaker, caller-text based authorization path.
 */
export function verifyApprovedAuthority(
  record: ApprovalRecord | null,
  expected: { readonly action: ApprovalAction; readonly resource_id: string; readonly policy_version?: string; readonly actor?: string; readonly session_id?: string | null },
  now: string,
): { readonly ok: true; readonly record: ApprovalRecord & { readonly decided_by: string } } | { readonly ok: false; readonly error: string } {
  if (record === null) return { ok: false, error: "approval record was not found" };
  if (record.action !== expected.action) return { ok: false, error: `approval ${record.request_id} is for ${record.action}, not ${expected.action}` };
  if (record.resource_id !== expected.resource_id) return { ok: false, error: `approval ${record.request_id} is for a different resource` };
  if (expected.policy_version !== undefined && record.lease_scope.policy_version !== expected.policy_version) return { ok: false, error: `approval ${record.request_id} is for a different policy version` };
  if (expected.actor !== undefined && record.lease_scope.actor !== expected.actor) return { ok: false, error: `approval ${record.request_id} is for a different actor` };
  if (expected.session_id !== undefined && record.lease_scope.session_id !== expected.session_id) return { ok: false, error: `approval ${record.request_id} is for a different session` };
  if (record.status !== "approved") return { ok: false, error: `approval ${record.request_id} is ${record.status}, not approved` };
  if (record.decided_by === null || !record.decided_by.trim()) return { ok: false, error: `approval ${record.request_id} has no durable decider` };
  if (record.proposer === record.decided_by) return { ok: false, error: `approval ${record.request_id} is self-approved` };
  if (!Number.isFinite(Date.parse(record.expires_at)) || Date.parse(now) > Date.parse(record.expires_at)) return { ok: false, error: `approval ${record.request_id} is expired` };
  return { ok: true, record: record as ApprovalRecord & { readonly decided_by: string } };
}

const DEFAULT_MAX_RECORDS = 1_000;
const APPROVAL_ACTIONS_SET = APPROVAL_ACTIONS;

export function isApprovalAction(value: string): value is ApprovalAction {
  return APPROVAL_ACTIONS_SET.has(value);
}

export class ApprovalService {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly idempotency = new Map<string, { fingerprint: string; record_id: string }>();
  private readonly order: string[] = [];
  private readonly clock: () => string;
  private readonly maxRecords: number;
  private readonly persistenceDir: string | null;
  private readonly sessionRules = new Map<string, ApprovalMemoryRule>();
  private readonly persistentRules = new Map<string, ApprovalMemoryRule>();

  constructor(options: ApprovalServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxRecords = options.max_records ?? DEFAULT_MAX_RECORDS;
    this.persistenceDir = options.persistence_dir ?? null;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 100_000) throw new Error("max_records must be an integer from 1 through 100000");
    this.restore();
  }

  /** The current injected wall clock (deterministic when a fake clock is provided). */
  now(): string { return this.clock(); }

  request(input: ApprovalRequestInput): { ok: true; record: ApprovalRecord } | { ok: false; error: string } {
    const invalid = validateRequest(input);
    if (invalid.length) return { ok: false, error: invalid.join("; ") };
    if (!isApprovalAction(input.action)) return { ok: false, error: `action ${input.action} is not an approvable action` };
    if (Date.parse(input.expires_at) <= Date.parse(this.clock())) return { ok: false, error: "expires_at must be in the future" };
    const prior = this.idempotency.get(input.idempotency_key);
    if (prior) {
      const existing = this.records.get(prior.record_id);
      if (existing && fingerprint(input) === prior.fingerprint) return { ok: true, record: existing };
      return { ok: false, error: `idempotency key ${input.idempotency_key} names a different approval request` };
    }
    const existingRequest = this.records.get(input.request_id);
    if (existingRequest) {
      return fingerprint(input) === fingerprintFromRecord(existingRequest)
        ? { ok: true, record: existingRequest }
        : { ok: false, error: `request_id ${input.request_id} conflicts with a different approval request` };
    }
    const record: ApprovalRecord = {
      request_id: input.request_id,
      idempotency_key: input.idempotency_key,
      action: input.action,
      subject: input.subject,
      resource_id: input.resource_id,
      proposer: input.proposer,
      rationale: input.rationale,
      status: "pending",
      decided_by: null,
      decided_at: null,
      expires_at: input.expires_at,
      action_fingerprint: fingerprint(input),
      lease_scope: scope(input),
      decision_scope: null,
      remembered_from: null,
    };
    const remembered = this.findMemoryRule(record.action_fingerprint, input.proposer);
    const resolved = remembered === null ? record : {
      ...record, status: "approved" as const, decided_by: remembered.decided_by, decided_at: this.clock(),
      decision_scope: remembered.scope, remembered_from: remembered.source_request_id,
    };
    this.records.set(input.request_id, resolved);
    this.idempotency.set(input.idempotency_key, { fingerprint: fingerprint(input), record_id: input.request_id });
    this.order.push(input.request_id);
    if (this.order.length > this.maxRecords) {
      const evictedId = this.order.shift()!;
      const evicted = this.records.get(evictedId);
      this.records.delete(evictedId);
      if (evicted) this.idempotency.delete(evicted.idempotency_key);
    }
    this.persist();
    return { ok: true, record: resolved };
  }

  approve(input: ApprovalDecisionInput): { ok: true; record: ApprovalRecord } | { ok: false; error: string; code: "permission" | "conflict" | "not_found" | "validation" } {
    return this.decide(input, "approved");
  }

  reject(input: ApprovalDecisionInput): { ok: true; record: ApprovalRecord } | { ok: false; error: string; code: "permission" | "conflict" | "not_found" | "validation" } {
    return this.decide(input, "rejected");
  }

  expire(requestId: string, at = this.clock()): { ok: true; record: ApprovalRecord } | { ok: false; error: string } {
    const record = this.records.get(requestId);
    if (!record) return { ok: false, error: `approval ${requestId} was not found` };
    if (record.status !== "pending") return { ok: false, error: `approval ${requestId} is ${record.status}, not pending` };
    const expired: ApprovalRecord = { ...record, status: "expired", decided_by: null, decided_at: at };
    this.records.set(requestId, expired);
    this.persist();
    return { ok: true, record: expired };
  }

  get(requestId: string): ApprovalRecord | null {
    return this.records.get(requestId) ?? null;
  }

  list(details: { status?: ApprovalStatus; limit?: number } = {}): ApprovalRecord[] {
    const limit = details.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit must be an integer from 1 through 1000");
    let out = [...this.records.values()];
    if (details.status !== undefined) out = out.filter((record) => record.status === details.status);
    return out.sort((left, right) => compareCodeUnits(right.expires_at, left.expires_at)).slice(0, limit);
  }

  private decide(input: ApprovalDecisionInput, status: "approved" | "rejected"): { ok: true; record: ApprovalRecord } | { ok: false; error: string; code: "permission" | "conflict" | "not_found" | "validation" } {
    if (!text(input.request_id) || !text(input.actor)) return { ok: false, error: "request_id and actor are required", code: "validation" };
    if (!isTime(input.clock)) return { ok: false, error: "decision clock must be a valid timestamp", code: "validation" };
    const record = this.records.get(input.request_id);
    if (!record) return { ok: false, error: `approval ${input.request_id} was not found`, code: "not_found" };
    // Checks-and-balances: the proposer cannot approve/reject their own request.
    if (input.actor === record.proposer) return { ok: false, error: `self-approval is forbidden: ${record.proposer} proposed ${record.request_id}`, code: "permission" };
    if (record.status !== "pending") return { ok: false, error: `approval ${record.request_id} is ${record.status}, not pending`, code: "conflict" };
    const decidedAt = this.clock();
    if (Date.parse(decidedAt) > Date.parse(record.expires_at)) {
      const expired: ApprovalRecord = { ...record, status: "expired", decided_by: null, decided_at: decidedAt };
      this.records.set(record.request_id, expired);
      this.persist();
      return { ok: false, error: `approval ${record.request_id} expired at ${record.expires_at}`, code: "conflict" };
    }
    const memoryScope = input.memory_scope ?? "once";
    if (!(["once", "session", "persistent"] as const).includes(memoryScope)) return { ok: false, error: "approval memory_scope must be once, session, or persistent", code: "validation" };
    if (status === "rejected" && memoryScope !== "once") return { ok: false, error: "rejection memory is not supported; rejection is target-only", code: "validation" };
    if (memoryScope === "persistent" && (!isCanonicalFingerprint(record.action_fingerprint) || this.persistenceDir === null)) {
      return { ok: false, error: "persistent approval memory requires a canonical action fingerprint and durable persistence", code: "conflict" };
    }
    const decided: ApprovalRecord = { ...record, status, decided_by: input.actor, decided_at: decidedAt, decision_scope: memoryScope, remembered_from: null };
    this.records.set(record.request_id, decided);
    if (status === "approved" && memoryScope !== "once") {
      const rule: ApprovalMemoryRule = { action_fingerprint: record.action_fingerprint, decided_by: input.actor, scope: memoryScope, source_request_id: record.request_id, expires_at: record.expires_at };
      (memoryScope === "session" ? this.sessionRules : this.persistentRules).set(record.action_fingerprint, rule);
    }
    this.persist();
    return { ok: true, record: decided };
  }

  private snapshotPath(): string { return join(this.persistenceDir!, "approvals", "records.json"); }

  private persist(): void {
    if (this.persistenceDir === null) return;
    const directory = join(this.persistenceDir, "approvals");
    mkdirSync(directory, { recursive: true });
    const path = this.snapshotPath(); const temporary = join(directory, `.records.${process.pid}.tmp`);
    writeFileSync(temporary, JSON.stringify({ schema_version: 2, records: this.order.map((id) => this.records.get(id)).filter((record): record is ApprovalRecord => record !== undefined), persistent_rules: [...this.persistentRules.values()] }));
    renameSync(temporary, path);
  }

  private restore(): void {
    if (this.persistenceDir === null) return;
    const path = this.snapshotPath();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { schema_version?: unknown; records?: unknown; persistent_rules?: unknown };
    if ((parsed.schema_version !== 1 && parsed.schema_version !== 2) || !Array.isArray(parsed.records)) throw new Error("approval persistence snapshot is invalid");
    for (const raw of parsed.records) {
      if (!isRecord(raw) || !isApprovalAction(String(raw.action)) || !text(raw.request_id) || !text(raw.idempotency_key)
        || !text(raw.subject) || !text(raw.resource_id) || !text(raw.proposer) || !text(raw.rationale)
        || !["pending", "approved", "rejected", "expired"].includes(String(raw.status)) || !isTime(String(raw.expires_at))
        || (raw.decided_by !== null && !text(raw.decided_by)) || (raw.decided_at !== null && !isTime(String(raw.decided_at)))) throw new Error("approval persistence record is invalid");
      const legacyInput: ApprovalRequestInput = { request_id: String(raw.request_id), idempotency_key: String(raw.idempotency_key), action: raw.action as ApprovalAction, subject: String(raw.subject), resource_id: String(raw.resource_id), proposer: String(raw.proposer), rationale: String(raw.rationale), expires_at: String(raw.expires_at) };
      const restoredScope = validScope(raw.lease_scope) ? raw.lease_scope : scope(legacyInput);
      const record: ApprovalRecord = { ...legacyInput, status: raw.status as ApprovalStatus, decided_by: raw.decided_by === null ? null : String(raw.decided_by), decided_at: raw.decided_at === null ? null : String(raw.decided_at), action_fingerprint: typeof raw.action_fingerprint === "string" ? raw.action_fingerprint : hashScope(restoredScope), lease_scope: restoredScope, decision_scope: isMemoryScope(raw.decision_scope) ? raw.decision_scope : null, remembered_from: typeof raw.remembered_from === "string" ? raw.remembered_from : null };
      if (this.records.has(record.request_id) || this.idempotency.has(record.idempotency_key)) throw new Error("approval persistence contains duplicate identity");
      this.records.set(record.request_id, record); this.idempotency.set(record.idempotency_key, { fingerprint: fingerprintFromRecord(record), record_id: record.request_id }); this.order.push(record.request_id);
    }
    if (parsed.schema_version === 2 && Array.isArray(parsed.persistent_rules)) for (const raw of parsed.persistent_rules) {
      if (!isMemoryRule(raw) || raw.scope !== "persistent") throw new Error("approval persistence memory rule is invalid");
      this.persistentRules.set(raw.action_fingerprint, raw);
    }
  }

  private findMemoryRule(actionFingerprint: string, proposer: string): ApprovalMemoryRule | null {
    const now = Date.parse(this.clock());
    for (const rules of [this.sessionRules, this.persistentRules]) {
      const rule = rules.get(actionFingerprint);
      if (!rule) continue;
      if (Date.parse(rule.expires_at) <= now) { rules.delete(actionFingerprint); continue; }
      if (rule.decided_by !== proposer) return rule;
    }
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function fingerprint(input: ApprovalRequestInput): string {
  return hashScope(scope(input));
}

function fingerprintFromRecord(record: ApprovalRecord): string {
  return record.action_fingerprint;
}

function scope(input: ApprovalRequestInput): ApprovalLeaseScope {
  return input.lease_scope ?? {
    operation: input.action,
    capability: `approval:${input.action}`,
    target: input.resource_id,
    reversible: input.action !== "recovery.abandon",
    systems_touched: [input.resource_id],
    policy_version: "approval-policy/v1",
    actor: input.proposer,
    session_id: null,
  };
}

function hashScope(value: ApprovalLeaseScope): string {
  return `sha256:${createHash("sha256").update(canonicalizeForHash(value)).digest("hex")}`;
}

function validScope(value: unknown): value is ApprovalLeaseScope {
  if (!isRecord(value)) return false;
  return isApprovalAction(String(value.operation)) && text(value.capability) && text(value.target)
    && typeof value.reversible === "boolean" && Array.isArray(value.systems_touched) && value.systems_touched.every(text)
    && text(value.policy_version) && text(value.actor) && (value.session_id === null || text(value.session_id));
}

function validateRequest(input: ApprovalRequestInput): string[] {
  const failures: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    if (name === "expires_at" || name === "rationale") continue;
    if (typeof value === "string" && !value.trim()) failures.push(`${name} must be non-empty`);
  }
  if (!isTime(input.expires_at)) failures.push("expires_at must be a valid timestamp");
  if (input.lease_scope !== undefined && !validScope(input.lease_scope)) failures.push("lease_scope must bind operation, capability, target, reversibility, systems, policy, actor, and session");
  return failures;
}

function isTime(value: string): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalFingerprint(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function isMemoryScope(value: unknown): value is ApprovalMemoryScope { return value === "once" || value === "session" || value === "persistent"; }
function isMemoryRule(value: unknown): value is ApprovalMemoryRule {
  return isRecord(value) && isCanonicalFingerprint(value.action_fingerprint) && text(value.decided_by)
    && (value.scope === "session" || value.scope === "persistent") && text(value.source_request_id) && isTime(String(value.expires_at));
}
