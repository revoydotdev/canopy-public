import { join } from "node:path";
import type { Provenance } from "@arbor/core";
import { readUxStore, uxClone, uxHash, uxId, uxText, writeUxStore } from "./durable-ux-store.js";

export type VerificationConfidence = "verified" | "claimed" | "unavailable";
export interface VerificationCheck { readonly command: readonly string[]; readonly exit_status: number | null; readonly duration_ms: number | null; readonly summary: string; readonly provenance: Provenance; }
export interface ResultVerificationRecord { readonly campaign_id: string; readonly node_id: string; readonly checks: readonly VerificationCheck[]; readonly files: readonly string[]; readonly diffstat: { readonly additions: number | null; readonly deletions: number | null; readonly files_changed: number | null }; readonly confidence: VerificationConfidence; readonly absence_reason: string | null; readonly provenance: Provenance; readonly captured_at: string; }
type Store = { schema_version: 1; records: ResultVerificationRecord[]; idempotency: Array<[string, { fingerprint: string; key: string }]> };

export class ResultVerificationService {
  private readonly records = new Map<string, ResultVerificationRecord>(); private readonly idempotency = new Map<string, { fingerprint: string; key: string }>(); private readonly path: string | null; private readonly clock: () => string;
  constructor(options: { readonly persistence_dir?: string; readonly clock?: () => string } = {}) { this.path = options.persistence_dir === undefined ? null : join(options.persistence_dir, "result-verification", "records.json"); this.clock = options.clock ?? (() => new Date().toISOString()); this.restore(); }
  record(input: Omit<ResultVerificationRecord, "captured_at"> & { readonly idempotency_key: string; readonly captured_at?: string }): ResultVerificationRecord {
    if (!uxId(input.campaign_id) || !uxId(input.node_id) || !uxText(input.idempotency_key, 256) || !validProvenance(input.provenance) || input.checks.length > 32 || input.files.length > 500) throw new Error("invalid verification record identity, bounds, or provenance");
    if (!validConfidence(input.confidence, input.absence_reason) || !input.files.every((file) => uxText(file, 512) && !file.startsWith("/") && !file.includes("..")) || !input.checks.every(validCheck) || !validDiffstat(input.diffstat)) throw new Error("invalid verification record content");
    const fingerprint = uxHash(input); const replay = this.idempotency.get(input.idempotency_key); if (replay) { if (replay.fingerprint !== fingerprint) throw new Error("idempotency key names a different verification record"); const prior = this.records.get(replay.key); if (!prior) throw new Error("verification idempotency record is corrupt"); return uxClone(prior); }
    const key = `${input.campaign_id}:${input.node_id}`;
    const existing = this.records.get(key);
    if (existing !== undefined && confidenceRank(input.confidence) < confidenceRank(existing.confidence)) {
      this.idempotency.set(input.idempotency_key, { fingerprint, key }); this.persist(); return uxClone(existing);
    }
    const record: ResultVerificationRecord = { campaign_id: input.campaign_id, node_id: input.node_id, checks: input.checks.map((check) => ({ ...check, command: [...check.command], summary: check.summary.trim() })), files: [...input.files], diffstat: { ...input.diffstat }, confidence: input.confidence, absence_reason: input.absence_reason, provenance: input.provenance, captured_at: input.captured_at ?? this.clock() };
    this.records.set(key, record); this.idempotency.set(input.idempotency_key, { fingerprint, key }); this.persist(); return uxClone(record);
  }
  get(campaignId: string, nodeId: string): ResultVerificationRecord | null { const found = this.records.get(`${campaignId}:${nodeId}`); return found === undefined ? null : uxClone(found); }
  list(campaignId: string, limit = 100): readonly ResultVerificationRecord[] { if (!uxId(campaignId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid verification list"); return [...this.records.values()].filter((record) => record.campaign_id === campaignId).sort((a, b) => b.captured_at.localeCompare(a.captured_at) || a.node_id.localeCompare(b.node_id)).slice(0, limit).map(uxClone); }
  private restore(): void { const store = readUxStore<Store>(this.path, { schema_version: 1, records: [], idempotency: [] }, validStore); for (const record of store.records) this.records.set(`${record.campaign_id}:${record.node_id}`, record); for (const entry of store.idempotency) this.idempotency.set(entry[0], entry[1]); }
  private persist(): void { writeUxStore(this.path, { schema_version: 1, records: [...this.records.values()], idempotency: [...this.idempotency.entries()] } satisfies Store); }
}
function validCheck(value: VerificationCheck): boolean { return value.command.length > 0 && value.command.length <= 32 && value.command.every((part) => uxText(part, 512)) && (value.exit_status === null || (Number.isSafeInteger(value.exit_status) && value.exit_status >= 0 && value.exit_status <= 255)) && (value.duration_ms === null || (Number.isSafeInteger(value.duration_ms) && value.duration_ms >= 0 && value.duration_ms <= 86_400_000)) && uxText(value.summary, 2_048) && validProvenance(value.provenance); }
function validDiffstat(value: ResultVerificationRecord["diffstat"]): boolean { return [value.additions, value.deletions, value.files_changed].every((number) => number === null || (Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000)); }
function validConfidence(confidence: VerificationConfidence, absence: string | null): boolean { return (confidence === "unavailable") === (absence !== null && uxText(absence, 512)); }
function confidenceRank(confidence: VerificationConfidence): number { return confidence === "verified" ? 2 : confidence === "claimed" ? 1 : 0; }
function validProvenance(value: unknown): value is Provenance { return typeof value === "object" && value !== null && typeof (value as { tag?: unknown }).tag === "string"; }
function validStore(value: unknown): value is Store { return typeof value === "object" && value !== null && (value as { schema_version?: unknown }).schema_version === 1 && Array.isArray((value as { records?: unknown }).records) && Array.isArray((value as { idempotency?: unknown }).idempotency); }
