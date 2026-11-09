/**
 * Durable snapshots for the runtime task supervisor.
 *
 * This adapter deliberately returns restored records instead of constructing a
 * live TaskSupervisor: a persisted `started` task is evidence of interrupted
 * work, not evidence that a worker still exists in this process.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { validateSupervisorTask, type SupervisorTask } from "@arbor/core";

export const SUPERVISOR_SNAPSHOT_VERSION = 1 as const;

export interface SupervisorSnapshot {
  schema_version: typeof SUPERVISOR_SNAPSHOT_VERSION;
  saved_at: string;
  tasks: SupervisorTask[];
}

export type SupervisorPersistenceDiagnosticCode = "invalid_json" | "invalid_shape" | "unsupported_version" | "quarantine_failed" | "writer_active";

export interface SupervisorPersistenceDiagnostic {
  artifact: "supervisor_snapshot" | "temporary_file";
  code: SupervisorPersistenceDiagnosticCode;
  path: string;
  message: string;
  quarantined_path?: string;
}

export interface SupervisorPersistenceLoadResult {
  value: SupervisorSnapshot | null;
  diagnostics: SupervisorPersistenceDiagnostic[];
  /** Active records require runtime reconciliation before a worker can exist. */
  reconciliation: SupervisorTask[];
}

const ACTIVE_STATES = new Set<SupervisorTask["state"]>(["accepted", "started", "retrying", "cancel_requested"]);

function snapshotPath(dir: string): string { return join(dir, "supervisor", "tasks.json"); }

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function quarantine(
  path: string,
  dir: string,
  artifact: SupervisorPersistenceDiagnostic["artifact"],
  code: SupervisorPersistenceDiagnosticCode,
  message: string,
): SupervisorPersistenceDiagnostic {
  const quarantineDir = join(dir, "quarantine");
  let diagnostic: SupervisorPersistenceDiagnostic = { artifact, code, path, message };
  try {
    mkdirSync(quarantineDir, { recursive: true });
    const stem = `${basename(path)}.${new Date().toISOString().replace(/[:.]/g, "-")}.${process.pid}`;
    let destination = join(quarantineDir, `${stem}.corrupt`);
    let suffix = 1;
    while (existsSync(destination)) destination = join(quarantineDir, `${stem}.${suffix++}.corrupt`);
    renameSync(path, destination);
    diagnostic = { ...diagnostic, quarantined_path: destination };
  } catch (error) {
    diagnostic = {
      artifact,
      code: "quarantine_failed",
      path,
      message: `${message}; quarantine failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return diagnostic;
}

/** Preserve abandoned atomic-write temps as forensic evidence. */
export function reconcileSupervisorTemporaryFiles(
  dir: string,
  isWriterAlive: (pid: number) => boolean = processAlive,
): SupervisorPersistenceDiagnostic[] {
  const supervisorDir = join(dir, "supervisor");
  if (!existsSync(supervisorDir)) return [];
  const diagnostics: SupervisorPersistenceDiagnostic[] = [];
  for (const file of readdirSync(supervisorDir).filter((name) => name.startsWith(".tasks.") && name.endsWith(".tmp"))) {
    const path = join(supervisorDir, file);
    const match = /^\.tasks\.(\d+)\.tmp$/u.exec(file);
    const pid = match === null ? null : Number(match[1]);
    if (pid !== null && isWriterAlive(pid)) {
      diagnostics.push({ artifact: "temporary_file", code: "writer_active", path, message: `supervisor snapshot temporary file is still owned by live process ${pid}` });
      continue;
    }
    diagnostics.push(quarantine(path, dir, "temporary_file", "invalid_shape", "abandoned supervisor write temporary file"));
  }
  return diagnostics;
}

/** Atomically replace the complete versioned task projection. */
export function saveSupervisorSnapshot(tasks: readonly SupervisorTask[], dir: string, savedAt = new Date().toISOString()): void {
  const supervisorDir = join(dir, "supervisor");
  mkdirSync(supervisorDir, { recursive: true });
  const value: SupervisorSnapshot = {
    schema_version: SUPERVISOR_SNAPSHOT_VERSION,
    saved_at: savedAt,
    tasks: [...tasks].map((task) => structuredClone(task)),
  };
  validateSnapshot(value);
  const target = snapshotPath(dir);
  const temporary = join(supervisorDir, `.tasks.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  syncFile(temporary);
  renameSync(temporary, target);
  // fsync the directory where supported, so rename durability is not assumed.
  try { syncFile(supervisorDir); } catch { /* directory fsync is not portable */ }
}

/**
 * Load a supervisor snapshot without hydrating it into live runtime state.
 * Active records are returned for reconciliation and must not be dispatched
 * until the runtime has re-established ownership, lease, and cancellation.
 */
export function loadSupervisorSnapshot(
  dir: string,
  options: { readonly process_alive?: (pid: number) => boolean } = {},
): SupervisorPersistenceLoadResult {
  const filePath = snapshotPath(dir);
  const diagnostics = reconcileSupervisorTemporaryFiles(dir, options.process_alive ?? processAlive);
  if (!existsSync(filePath)) return { value: null, diagnostics, reconciliation: [] };
  try {
    const value = validateSnapshot(JSON.parse(readFileSync(filePath, "utf-8")) as unknown);
    return {
      value,
      diagnostics,
      reconciliation: value.tasks.filter((task) => ACTIVE_STATES.has(task.state)).map((task) => structuredClone(task)),
    };
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    diagnostics.push(quarantine(
      filePath,
      dir,
      "supervisor_snapshot",
      syntax ? "invalid_json" : error instanceof UnsupportedSnapshotVersionError ? "unsupported_version" : "invalid_shape",
      syntax ? "supervisor snapshot is not valid JSON" : `supervisor snapshot failed validation: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return { value: null, diagnostics, reconciliation: [] };
  }
}

class UnsupportedSnapshotVersionError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSnapshot(value: unknown): SupervisorSnapshot {
  if (!isRecord(value)) throw new Error("snapshot must be a JSON object");
  if (value.schema_version !== SUPERVISOR_SNAPSHOT_VERSION) {
    throw new UnsupportedSnapshotVersionError(`unsupported schema version ${JSON.stringify(value.schema_version)}`);
  }
  if (typeof value.saved_at !== "string" || Number.isNaN(Date.parse(value.saved_at)) || !Array.isArray(value.tasks)) {
    throw new Error("snapshot must contain an ISO saved_at and tasks array");
  }
  const tasks = value.tasks as unknown[];
  const ids = new Set<string>();
  const operations = new Set<string>();
  const taskById = new Map<string, SupervisorTask>();
  for (const task of tasks) {
    const validation = validateSupervisorTask(task);
    if (!validation.ok) throw new Error(`invalid task: ${validation.violations.map((entry) => `${entry.path} ${entry.message}`).join(", ")}`);
    const valid = validation.value;
    if (ids.has(valid.id)) throw new Error(`duplicate task id ${JSON.stringify(valid.id)}`);
    if (operations.has(valid.operation_id)) throw new Error(`duplicate operation id ${JSON.stringify(valid.operation_id)}`);
    ids.add(valid.id);
    operations.add(valid.operation_id);
    taskById.set(valid.id, structuredClone(valid));
  }
  for (const task of taskById.values()) {
    if (task.parent_id === null) continue;
    const parent = taskById.get(task.parent_id);
    if (!parent) throw new Error(`task ${JSON.stringify(task.id)} has an unknown parent`);
    if (parent.owner_scope_id !== task.owner_scope_id) throw new Error(`task ${JSON.stringify(task.id)} has a parent in another owner scope`);
  }
  for (const task of taskById.values()) {
    const seen = new Set<string>();
    let current: SupervisorTask | undefined = task;
    while (current !== undefined && current.parent_id !== null) {
      if (seen.has(current.id)) throw new Error(`task parent cycle includes ${JSON.stringify(current.id)}`);
      seen.add(current.id);
      current = taskById.get(current.parent_id);
    }
  }
  return { schema_version: SUPERVISOR_SNAPSHOT_VERSION, saved_at: value.saved_at, tasks: [...taskById.values()] };
}
