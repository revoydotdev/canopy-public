import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireWriterLock, type WriterLockHandle } from "@arbor/core";
import {
  createRepoFlightSessionManifest,
  projectRepoFlightSession,
  reconcileRepoFlightSession,
  transitionRepoFlightSession,
  validateRepoFlightSessionManifest,
  validateRepoFlightSessionRecord,
  type RepoFlightControlChannelState,
  type RepoFlightProcessObservation,
  type RepoFlightSessionManifest,
  type RepoFlightSessionManifestInput,
  type RepoFlightSessionProjection,
  type RepoFlightSessionRecord,
} from "./repo-flight-session.js";

interface RepoFlightEnrollmentState { readonly schema_version: 1; readonly records: readonly RepoFlightSessionRecord[] }
export interface RepoFlightEnrollmentOptions { readonly persistence_dir: string; readonly now?: () => Date; readonly max_sessions?: number }
export interface RepoFlightHeartbeat {
  readonly instance_id: string;
  readonly process_start_token: string;
  readonly host_boot_id: string;
  readonly control_channel: RepoFlightControlChannelState;
  readonly observed_at?: string;
}

/**
 * Durable repo-local enrollment registry. It identifies processes; it does not
 * grant authority. A separate clearance layer must consult `fenced` before any
 * protected effect.
 */
export class RepoFlightEnrollmentRegistry {
  private readonly statePath: string;
  private readonly lock: WriterLockHandle;
  private readonly now: () => Date;
  private readonly maxSessions: number;
  private state: RepoFlightEnrollmentState;

  constructor(options: RepoFlightEnrollmentOptions) {
    if (typeof options.persistence_dir !== "string" || options.persistence_dir.length === 0 || options.persistence_dir.length > 4096) throw new Error("enrollment persistence_dir is malformed");
    this.maxSessions = options.max_sessions ?? 10_000;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 100_000) throw new Error("max_sessions is outside the supported range");
    this.now = options.now ?? (() => new Date());
    mkdirSync(options.persistence_dir, { recursive: true });
    const acquired = acquireWriterLock(options.persistence_dir, { holder: "repo-flight-enrollment" });
    if (!acquired.ok) throw new Error(acquired.detail);
    this.lock = acquired.lock;
    this.statePath = join(options.persistence_dir, "repo-flight-enrollment.json");
    try { this.state = this.restore(); }
    catch (error) { this.lock.release(); throw error; }
  }

  close(): void { this.lock.release(); }

  enroll(input: RepoFlightSessionManifestInput | RepoFlightSessionManifest): RepoFlightSessionRecord {
    const manifest = "schema_version" in input ? validateRepoFlightSessionManifest(input) : createRepoFlightSessionManifest(input);
    const existing = this.state.records.find((record) => record.manifest.instance_id === manifest.instance_id);
    if (existing) {
      if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) throw new Error("instance identity collided with different manifest content");
      return existing;
    }
    if (this.state.records.length >= this.maxSessions) throw new Error("session enrollment capacity is exhausted");
    const now = canonicalNow(this.now());
    const records = this.state.records.map((record) => {
      if (record.manifest.repository.repository_id !== manifest.repository.repository_id || record.manifest.pid !== manifest.pid || record.state === "dead_confirmed") return record;
      return Object.freeze({ ...record, state: "ambiguous" as const, fenced: true, revision: record.revision + 1, disposition_reason: "a new enrollment superseded this PID-bound agent identity" });
    });
    const created: RepoFlightSessionRecord = Object.freeze({ manifest, state: "live", fenced: false, enrolled_at: now, heartbeat_at: now, control_channel: "connected", revision: 1, disposition_reason: null });
    this.state = Object.freeze({ schema_version: 1, records: Object.freeze([...records, created].sort(byInstanceId)) });
    this.persist();
    return created;
  }

  heartbeat(input: RepoFlightHeartbeat): RepoFlightSessionRecord {
    const current = this.required(input.instance_id);
    const observedAt = input.observed_at ?? canonicalNow(this.now());
    const observation: RepoFlightProcessObservation = {
      observed_at: observedAt,
      pid_exists: true,
      process_start_token: input.process_start_token,
      host_boot_id: input.host_boot_id,
      control_channel: input.control_channel,
    };
    const next = reconcileRepoFlightSession(current, observation);
    this.replace(next);
    return next;
  }

  observe(instanceId: string, observation: RepoFlightProcessObservation): RepoFlightSessionRecord {
    const next = reconcileRepoFlightSession(this.required(instanceId), observation);
    this.replace(next);
    return next;
  }

  transition(instanceId: string, requested: "draining" | "quiesced"): RepoFlightSessionRecord {
    const next = transitionRepoFlightSession(this.required(instanceId), requested);
    this.replace(next);
    return next;
  }

  record(instanceId: string): RepoFlightSessionRecord | null { return this.state.records.find((record) => record.manifest.instance_id === instanceId) ?? null; }
  projection(instanceId: string): RepoFlightSessionProjection | null { const record = this.record(instanceId); return record ? projectRepoFlightSession(record) : null; }
  projections(): readonly RepoFlightSessionProjection[] { return Object.freeze(this.state.records.map(projectRepoFlightSession).sort((a, b) => a.instance_id.localeCompare(b.instance_id))); }

  private required(instanceId: string): RepoFlightSessionRecord {
    if (typeof instanceId !== "string" || !/^agent:v1:[a-f0-9]{64}$/.test(instanceId)) throw new Error("instance_id is malformed");
    const record = this.record(instanceId);
    if (!record) throw new Error("session is not enrolled");
    return record;
  }

  private replace(next: RepoFlightSessionRecord): void {
    this.state = Object.freeze({ schema_version: 1, records: Object.freeze(this.state.records.map((record) => record.manifest.instance_id === next.manifest.instance_id ? next : record).sort(byInstanceId)) });
    this.persist();
  }

  private restore(): RepoFlightEnrollmentState {
    if (!existsSync(this.statePath)) return Object.freeze({ schema_version: 1, records: Object.freeze([]) });
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.statePath, "utf8")); } catch { throw new Error("repo flight enrollment state is unreadable"); }
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).sort().join(",") !== "records,schema_version") throw new Error("repo flight enrollment state uses an unknown schema");
    const raw = value as Record<string, unknown>;
    if (raw.schema_version !== 1 || !Array.isArray(raw.records) || raw.records.length > this.maxSessions) throw new Error("repo flight enrollment state is malformed or oversized");
    const records = raw.records.map(validateRepoFlightSessionRecord).sort(byInstanceId);
    if (new Set(records.map((record) => record.manifest.instance_id)).size !== records.length) throw new Error("repo flight enrollment state contains duplicate instance identities");
    return Object.freeze({ schema_version: 1, records: Object.freeze(records) });
  }

  private persist(): void {
    const temporary = `${this.statePath}.tmp`;
    const bytes = `${JSON.stringify(this.state)}\n`;
    writeFileSync(temporary, bytes, { encoding: "utf8", mode: 0o600 });
    const file = openSync(temporary, "r");
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, this.statePath);
    const directory = openSync(dirname(this.statePath), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

function byInstanceId(a: RepoFlightSessionRecord, b: RepoFlightSessionRecord): number { return a.manifest.instance_id.localeCompare(b.manifest.instance_id); }
function canonicalNow(value: Date): string { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("clock returned an invalid instant"); return value.toISOString(); }
