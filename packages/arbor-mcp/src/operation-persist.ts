/**
 * Durable operation-registry projection. This intentionally persists plain
 * records around the canonical core OperationRegistry. Active records are
 * reconciliation evidence, never live execution.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { OperationRegistry, validateRuntimeError, type OperationRecord } from "@arbor/core";

export const OPERATION_SNAPSHOT_VERSION = 1 as const;

export type { OperationRecord } from "@arbor/core";

export interface OperationSnapshot {
  schema_version: typeof OPERATION_SNAPSHOT_VERSION;
  saved_at: string;
  operations: OperationRecord[];
}

export type OperationPersistenceDiagnosticCode = "invalid_json" | "invalid_shape" | "unsupported_version" | "quarantine_failed";
export interface OperationPersistenceDiagnostic {
  artifact: "operation_snapshot" | "temporary_file";
  code: OperationPersistenceDiagnosticCode;
  path: string;
  message: string;
  quarantined_path?: string;
}
export interface OperationPersistenceLoadResult {
  value: OperationSnapshot | null;
  diagnostics: OperationPersistenceDiagnostic[];
  /** Non-terminal records which a future registry must reconcile, never run. */
  reconciliation: OperationRecord[];
}

const ACTIVE = new Set<OperationRecord["state"]>(["accepted", "running"]);

function snapshotPath(dir: string): string { return join(dir, "operations", "registry.json"); }
function syncFile(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }

function quarantine(path: string, dir: string, artifact: OperationPersistenceDiagnostic["artifact"], code: OperationPersistenceDiagnosticCode, message: string): OperationPersistenceDiagnostic {
  const quarantineDir = join(dir, "quarantine");
  let diagnostic: OperationPersistenceDiagnostic = { artifact, code, path, message };
  try {
    mkdirSync(quarantineDir, { recursive: true });
    const stem = `${basename(path)}.${new Date().toISOString().replace(/[:.]/g, "-")}.${process.pid}`;
    let destination = join(quarantineDir, `${stem}.corrupt`);
    let suffix = 1;
    while (existsSync(destination)) destination = join(quarantineDir, `${stem}.${suffix++}.corrupt`);
    renameSync(path, destination);
    diagnostic = { ...diagnostic, quarantined_path: destination };
  } catch (error) {
    diagnostic = { artifact, code: "quarantine_failed", path, message: `${message}; quarantine failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return diagnostic;
}

/** Preserve incomplete atomic writes as evidence instead of deleting them. */
export function reconcileOperationTemporaryFiles(dir: string): OperationPersistenceDiagnostic[] {
  const operationDir = join(dir, "operations");
  if (!existsSync(operationDir)) return [];
  return readdirSync(operationDir)
    .filter((file) => file.startsWith(".registry.") && file.endsWith(".tmp"))
    .map((file) => quarantine(join(operationDir, file), dir, "temporary_file", "invalid_shape", "abandoned operation registry write temporary file"));
}

export function saveOperationSnapshot(operations: readonly OperationRecord[], dir: string, savedAt = new Date().toISOString()): void {
  const operationDir = join(dir, "operations");
  mkdirSync(operationDir, { recursive: true });
  const snapshot: OperationSnapshot = { schema_version: OPERATION_SNAPSHOT_VERSION, saved_at: savedAt, operations: operations.map((operation) => structuredClone(operation)) };
  validateSnapshot(snapshot);
  const temporary = join(operationDir, `.registry.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(snapshot, null, 2));
  syncFile(temporary);
  renameSync(temporary, snapshotPath(dir));
  try { syncFile(operationDir); } catch { /* directory fsync is platform-dependent */ }
}

export function loadOperationSnapshot(dir: string): OperationPersistenceLoadResult {
  const filePath = snapshotPath(dir);
  const diagnostics = reconcileOperationTemporaryFiles(dir);
  if (!existsSync(filePath)) return { value: null, diagnostics, reconciliation: [] };
  try {
    const value = validateSnapshot(JSON.parse(readFileSync(filePath, "utf-8")) as unknown);
    return { value, diagnostics, reconciliation: value.operations.filter((operation) => ACTIVE.has(operation.state)).map((operation) => structuredClone(operation)) };
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    diagnostics.push(quarantine(filePath, dir, "operation_snapshot", syntax ? "invalid_json" : error instanceof UnsupportedVersionError ? "unsupported_version" : "invalid_shape", syntax ? "operation snapshot is not valid JSON" : `operation snapshot failed validation: ${error instanceof Error ? error.message : String(error)}`));
    return { value: null, diagnostics, reconciliation: [] };
  }
}

class UnsupportedVersionError extends Error {}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validTimestamp(value: unknown): value is string { return nonEmpty(value) && !Number.isNaN(Date.parse(value)); }
function isOperationState(value: unknown): value is OperationRecord["state"] {
  return typeof value === "string" && (["accepted", "running", "completed", "rejected", "failed", "cancelled"] as const).includes(value as OperationRecord["state"]);
}

function validateSnapshot(raw: unknown): OperationSnapshot {
  if (!isRecord(raw)) throw new Error("snapshot must be a JSON object");
  if (raw.schema_version !== OPERATION_SNAPSHOT_VERSION) throw new UnsupportedVersionError(`unsupported schema version ${JSON.stringify(raw.schema_version)}`);
  if (!validTimestamp(raw.saved_at) || !Array.isArray(raw.operations)) throw new Error("snapshot must contain an ISO saved_at and operations array");
  const operationIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const operations: OperationRecord[] = [];
  for (const value of raw.operations) {
    if (!isRecord(value) || !nonEmpty(value.operation_id) || !nonEmpty(value.idempotency_key) || !nonEmpty(value.fingerprint)
      || !nonEmpty(value.capability) || !nonEmpty(value.actor_id) || !nonEmpty(value.correlation_id)
      || !validTimestamp(value.accepted_at) || !isOperationState(value.state)
      || (value.task_id !== null && !nonEmpty(value.task_id)) || (value.result_summary !== null && !nonEmpty(value.result_summary))
      || (value.completed_at !== null && !validTimestamp(value.completed_at))) {
      throw new Error("snapshot contains an invalid operation record");
    }
    const error = value.error === null ? null : validateRuntimeError(value.error);
    if (error !== null && !error.ok) throw new Error("snapshot operation contains an invalid runtime error");
    if (ACTIVE.has(value.state) && value.completed_at !== null) throw new Error("active operation cannot have completed_at");
    if (!ACTIVE.has(value.state) && value.completed_at === null) throw new Error("terminal operation requires completed_at");
    if (operationIds.has(value.operation_id) || idempotencyKeys.has(value.idempotency_key)) throw new Error("snapshot contains duplicate operation or idempotency identity");
    operationIds.add(value.operation_id); idempotencyKeys.add(value.idempotency_key);
    operations.push({
      operation_id: value.operation_id,
      idempotency_key: value.idempotency_key,
      fingerprint: value.fingerprint,
      correlation_id: value.correlation_id,
      actor_id: value.actor_id,
      capability: value.capability,
      state: value.state,
      task_id: value.task_id,
      result_summary: value.result_summary,
      error: error === null ? null : error.value,
      accepted_at: value.accepted_at,
      completed_at: value.completed_at,
    });
  }
  // Keep adapter validation aligned with core registry invariants and future
  // registry extensions; this only constructs inert reconciliation state.
  new OperationRegistry({ restored_records: operations });
  return { schema_version: OPERATION_SNAPSHOT_VERSION, saved_at: raw.saved_at, operations };
}
