import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EffectiveConfigView } from "./config-inspection.js";
import type { NativeHarnessReadinessProjection } from "./native-harness-readiness.js";
import { inspectOperatorEnvironment, type HarnessIntegrationDoctorReport, type OperatorDoctorReport } from "./doctor.js";

export const OPERATOR_DOCTOR_SCHEMA_VERSION = 2 as const;
export const MIGRATION_SCHEMA_VERSION = 1 as const;

export interface DoctorAction { readonly code: string; readonly action: string; }
export type DoctorOperationalStatus = "ready" | "attention" | "unavailable" | "unobserved";
export interface DoctorIntegrationSummary {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly health: DoctorOperationalStatus;
  readonly detail: string;
  readonly permissions: readonly string[];
  readonly dependencies: readonly string[];
  readonly handoff: { readonly kind: string; readonly value: string | null };
}
export interface DoctorOperationalInputs {
  readonly integrations?: readonly DoctorIntegrationSummary[];
  readonly remote?: { readonly composed: boolean; readonly registered_sessions: number; readonly detail: string };
  readonly scheduler?: { readonly composed: boolean; readonly schedules: number; readonly active: number; readonly human_required: number; readonly runs: number; readonly detail: string };
  readonly sessions?: { readonly source_available: boolean; readonly known: number; readonly live: number; readonly detail: string };
}
export interface UnifiedDoctorProjection {
  readonly schema_version: typeof OPERATOR_DOCTOR_SCHEMA_VERSION;
  /** Legacy readiness projection retained for CLI/API compatibility. */
  readonly execution: NativeHarnessReadinessProjection["execution"] | null;
  /** Legacy remediation list retained alongside richer `next_actions`. */
  readonly missing_requirements: NativeHarnessReadinessProjection["missing_requirements"];
  readonly probe_scope: { readonly local_only: true; readonly network: "not_run"; readonly credential_values: "never_read" };
  readonly configured: { readonly models: readonly { readonly provider_id: string | null; readonly model_id: string | null; readonly revision: string | null; readonly source: string; readonly image_input: { readonly configured: boolean; readonly actionable: boolean; readonly source: string | null } }[]; readonly config_sources: EffectiveConfigView["sources"]; };
  readonly credentials: { readonly native: { readonly required: boolean; readonly present: boolean; readonly source: string | null; readonly env_var: string | null; readonly file_path: string | null; readonly mechanism: string | null; readonly state: string | null } };
  readonly tools_and_connectors: readonly { readonly connector_id: string; readonly status: "ready" | "unavailable"; readonly capabilities: readonly string[]; readonly detail: string }[];
  readonly integration: HarnessIntegrationDoctorReport;
  readonly persistence: OperatorDoctorReport["store"];
  readonly migration: MigrationInspection;
  /**
   * Parity gap #5: native is selected by `native.mode` in `arbor.jsonc`;
   * every subprocess connector is selected by `ARBOR_HARNESS_INTEGRATION`.
   * A misconfigured "native" run (e.g. `native.mode: "native"` with no
   * credential) silently falls back to whichever connector
   * `ARBOR_HARNESS_INTEGRATION` names (`opencode` by default) with no signal
   * that a fallback happened. This field states the outcome and the "why" in
   * one place — the env var value actually in force (via `integration_id`,
   * already resolved from it), the configured `native.mode`, and the
   * concrete reason (including `credential_absent` when that is why).
   */
  readonly mode_selection: {
    readonly active_lane: "native" | "connector";
    readonly connector_id: string;
    readonly native_mode: NativeHarnessReadinessProjection["selection"]["mode"];
    readonly reason: string;
  };
  readonly operational: {
    readonly extensions: { readonly status: DoctorOperationalStatus; readonly total: number; readonly enabled: number; readonly unhealthy: number; readonly detail: string };
    readonly remote: { readonly status: DoctorOperationalStatus; readonly registered_sessions: number; readonly detail: string };
    readonly scheduler: { readonly status: DoctorOperationalStatus; readonly schedules: number; readonly active: number; readonly human_required: number; readonly runs: number; readonly detail: string };
    readonly sessions: { readonly status: DoctorOperationalStatus; readonly known: number; readonly live: number; readonly detail: string };
    readonly integrations: readonly DoctorIntegrationSummary[];
  };
  readonly next_actions: readonly DoctorAction[];
}

export interface UnifiedDoctorInputs {
  readonly cwd: string;
  readonly persistence_dir: string;
  readonly config: EffectiveConfigView;
  readonly readiness: NativeHarnessReadinessProjection | null;
  readonly integration: HarnessIntegrationDoctorReport;
  readonly connectors: readonly { readonly connector_id: string; readonly status: "ready" | "unavailable"; readonly capabilities: readonly string[]; readonly detail: string }[];
  readonly operational?: DoctorOperationalInputs;
  readonly streams?: { readonly stdin: boolean; readonly stdout: boolean; readonly stderr: boolean };
}

/** Versioned, secret-free shared diagnosis. It performs no network probe or mutation. */
export function buildUnifiedDoctor(inputs: UnifiedDoctorInputs): UnifiedDoctorProjection {
  const operator = inspectOperatorEnvironment({
    cwd: inputs.cwd, persistence_dir: inputs.persistence_dir, streams: inputs.streams ?? { stdin: false, stdout: false, stderr: false },
    native_credential_present: inputs.readiness?.credential.present ?? false, harness_integration: inputs.integration,
  });
  const readiness = inputs.readiness;
  const imageInputLeaf = inputs.config.leaves.find((leaf) => leaf.path === "native.capabilities.image_input");
  // Never infer image input from a model name: only an explicit config capability is actionable.
  const imageInputConfigured = imageInputLeaf?.value === true && !imageInputLeaf.redacted;
  const actions: DoctorAction[] = [];
  for (const requirement of readiness?.missing_requirements ?? []) actions.push({ code: requirement.code, action: requirement.action });
  if (!inputs.integration.executable_present || inputs.integration.authenticated === false) actions.push({ code: "integration_unready", action: inputs.integration.detail });
  if (!operator.store.inventory_agrees) actions.push({ code: "persistence_reconcile", action: "Run `arbor doctor reconcile` to preview the orphaned snapshots and ledgers, then `arbor doctor reconcile --apply` to move them into .arbor/quarantine/ with a receipt; nothing is deleted." });
  if (!imageInputConfigured) actions.push({ code: "image_input_not_configured", action: "Set the explicit `native.capabilities.image_input` capability only after the selected adapter/provider has been verified to support it; model-name inference is intentionally disabled." });
  const migration = inspectMigration(inputs.cwd);
  if (migration.compatibility.status !== "compatible") actions.push({ code: "migration_review", action: "Run `arbor migrate inspect --json`, then `arbor migrate preview --from <source>` before any apply." });
  const modeSelection = ((): UnifiedDoctorProjection["mode_selection"] => {
    const nativeMode = readiness?.selection.mode ?? null;
    if (readiness === null) {
      return { active_lane: "connector", connector_id: inputs.integration.integration_id, native_mode: null, reason: "native readiness was not composed for this doctor call; the configured connector is authoritative" };
    }
    if (readiness.execution.kind === "direct_native") {
      return { active_lane: "native", connector_id: inputs.integration.integration_id, native_mode: nativeMode, reason: `native.mode=${nativeMode} selected native execution (${readiness.execution.selected_by === "native" ? "explicit native.mode=native" : "auto with a ready adapter and credential"}); ARBOR_HARNESS_INTEGRATION is not consulted while native is selected` };
    }
    if (readiness.execution.kind === "connector_fallback") {
      return { active_lane: "connector", connector_id: inputs.integration.integration_id, native_mode: nativeMode, reason: `native.mode=${nativeMode} fell back to the "${inputs.integration.integration_id}" connector (from ARBOR_HARNESS_INTEGRATION, a deprecated lane admitted only by connectors.allow_deprecated): ${readiness.execution.reason}` };
    }
    return { active_lane: "connector", connector_id: inputs.integration.integration_id, native_mode: nativeMode, reason: `native.mode=${nativeMode} is unavailable (${readiness.execution.reason}); campaign execution depends on the "${inputs.integration.integration_id}" connector (from ARBOR_HARNESS_INTEGRATION, a deprecated lane admitted only by connectors.allow_deprecated) instead` };
  })();
  const integrations = Object.freeze([...(inputs.operational?.integrations ?? [])].map((item) => Object.freeze({ ...item, permissions: Object.freeze([...item.permissions]), dependencies: Object.freeze([...item.dependencies]), handoff: Object.freeze({ ...item.handoff }) })).sort((a, b) => a.id.localeCompare(b.id)));
  const extensions = integrations.filter((item) => item.kind === "extension");
  const extensionUnhealthy = extensions.filter((item) => item.health !== "ready").length;
  const remote = inputs.operational?.remote;
  const scheduler = inputs.operational?.scheduler;
  const sessions = inputs.operational?.sessions;
  return Object.freeze({
    schema_version: OPERATOR_DOCTOR_SCHEMA_VERSION,
    execution: readiness?.execution ?? null,
    missing_requirements: Object.freeze([...(readiness?.missing_requirements ?? [])]),
    probe_scope: Object.freeze({ local_only: true, network: "not_run", credential_values: "never_read" }),
    configured: Object.freeze({ models: Object.freeze([{ provider_id: readiness?.selection.provider_id ?? null, model_id: readiness?.selection.model_id ?? null, revision: readiness?.model_revision.configured ?? null, source: readiness?.selection.provider_id === null || readiness === null ? "unconfigured" : "effective_config", image_input: Object.freeze({ configured: imageInputConfigured, actionable: imageInputConfigured && readiness?.adapter.availability === "available", source: imageInputLeaf?.source ?? null }) }]), config_sources: inputs.config.sources }),
    credentials: Object.freeze({ native: Object.freeze({
      required: readiness?.credential.required ?? false, present: readiness?.credential.present ?? false, source: readiness?.credential.source ?? null, env_var: readiness?.credential.env_var ?? null,
      file_path: readiness?.credential.file_path ?? null, mechanism: readiness?.credential.mechanism ?? null, state: readiness?.credential.state ?? null,
    }) }),
    tools_and_connectors: Object.freeze(inputs.connectors.map((connector) => Object.freeze({ ...connector, capabilities: Object.freeze([...connector.capabilities]) })).sort((a, b) => a.connector_id.localeCompare(b.connector_id))),
    integration: inputs.integration, persistence: operator.store, migration, mode_selection: modeSelection,
    operational: Object.freeze({
      extensions: Object.freeze({ status: extensions.length === 0 ? "unobserved" : extensionUnhealthy > 0 ? "attention" : "ready", total: extensions.length, enabled: extensions.filter((item) => item.state === "enabled").length, unhealthy: extensionUnhealthy, detail: extensions.length === 0 ? "no extension inventory was observed in this composition" : `${extensions.length} extension integration(s) observed` }),
      remote: Object.freeze({ status: remote === undefined ? "unobserved" : remote.composed ? "ready" : "unavailable", registered_sessions: remote?.registered_sessions ?? 0, detail: remote?.detail ?? "remote authority was not inspected by this composition" }),
      scheduler: Object.freeze({ status: scheduler === undefined ? "unobserved" : scheduler.composed ? (scheduler.human_required > 0 ? "attention" : "ready") : "unavailable", schedules: scheduler?.schedules ?? 0, active: scheduler?.active ?? 0, human_required: scheduler?.human_required ?? 0, runs: scheduler?.runs ?? 0, detail: scheduler?.detail ?? "scheduler was not inspected by this composition" }),
      sessions: Object.freeze({ status: sessions === undefined ? "unobserved" : sessions.source_available ? "ready" : "unavailable", known: sessions?.known ?? 0, live: sessions?.live ?? 0, detail: sessions?.detail ?? "session continuity was not inspected by this composition" }),
      integrations,
    }),
    next_actions: Object.freeze(actions),
  });
}

export function formatUnifiedDoctor(report: UnifiedDoctorProjection): string {
  return [
    `Doctor v${report.schema_version} (local-only; credentials never read)`,
    `Model: ${report.configured.models[0]?.provider_id ?? "unconfigured"} / ${report.configured.models[0]?.model_id ?? "unconfigured"}; image input ${report.configured.models[0]?.image_input.actionable ? "explicitly actionable" : "not actionable"}`,
    `Native credential: ${report.credentials.native.present ? "present" : "absent"}${report.credentials.native.env_var ? ` (${report.credentials.native.env_var})` : ""}`,
    `Integration: ${report.integration.integration_id} (${report.integration.detail})`,
    `Mode selection: ${report.mode_selection.active_lane} — ${report.mode_selection.reason}`,
    `Persistence: ${report.persistence.inventory_agrees ? "consistent" : "needs reconciliation"}`,
    `Migration: ${report.migration.compatibility.status} (${report.migration.compatibility.detail})`,
    `Extensions: ${report.operational.extensions.status} (${report.operational.extensions.enabled}/${report.operational.extensions.total} enabled)`,
    `Remote: ${report.operational.remote.status} (${report.operational.remote.registered_sessions} registered sessions)`,
    `Scheduler: ${report.operational.scheduler.status} (${report.operational.scheduler.active}/${report.operational.scheduler.schedules} active; ${report.operational.scheduler.runs} runs)`,
    `Session continuity: ${report.operational.sessions.status} (${report.operational.sessions.live}/${report.operational.sessions.known} live)`,
    "Next actions:", ...(report.next_actions.length ? report.next_actions.map((item) => `  [${item.code}] ${item.action}`) : ["  none"]),
  ].join("\n");
}

export interface MigrationInspection {
  readonly schema_version: typeof MIGRATION_SCHEMA_VERSION;
  readonly root: string;
  readonly target: { readonly path: string; readonly present: boolean; readonly sha256: string | null };
  readonly compatibility: { readonly status: "compatible" | "migration_available" | "unsupported"; readonly detail: string };
  readonly supported_sources: readonly string[];
}
export interface MigrationPreview {
  readonly schema_version: typeof MIGRATION_SCHEMA_VERSION;
  readonly source: { readonly path: string; readonly sha256: string; readonly kind: "arbor-v1" | "opencode" };
  readonly target: { readonly path: string; readonly exists: boolean; readonly overwrite_required: boolean; readonly rendered_sha256: string };
  readonly compatibility: { readonly status: "compatible"; readonly detail: string };
  readonly writes: readonly string[];
  readonly rollback: { readonly available: true; readonly detail: string };
}
export interface MigrationReceipt {
  readonly schema_version: typeof MIGRATION_SCHEMA_VERSION;
  readonly receipt_id: string;
  readonly target_path: string;
  readonly target_before_sha256: string | null;
  readonly target_after_sha256: string;
  readonly backup_path: string | null;
  readonly source_sha256: string;
  readonly applied_at: string;
}

export function inspectMigration(cwd: string): MigrationInspection {
  const root = resolve(cwd); const target = join(root, "arbor.jsonc"); const present = safeFile(target); const digest = present ? sha256(readFileSync(target)) : null;
  return Object.freeze({ schema_version: MIGRATION_SCHEMA_VERSION, root, target: Object.freeze({ path: target, present, sha256: digest }), compatibility: Object.freeze({ status: present ? "compatible" : "migration_available", detail: present ? "existing Arbor configuration is supported; imports require explicit overwrite" : "no Arbor configuration exists; a compatible import may create one" }), supported_sources: Object.freeze(["Arbor schema_version 1 JSON", "OpenCode JSON with a model/provider selection"]) });
}

export function previewMigration(input: { readonly cwd: string; readonly source_path: string }): MigrationPreview {
  const sourcePath = confinedFile(input.cwd, input.source_path); const bytes = readFileSync(sourcePath); const parsed = parseImport(bytes); const target = join(resolve(input.cwd), "arbor.jsonc"); const rendered = Buffer.from(`${JSON.stringify(parsed.target, null, 2)}\n`, "utf8"); const exists = safeFile(target);
  return Object.freeze({ schema_version: MIGRATION_SCHEMA_VERSION, source: Object.freeze({ path: sourcePath, sha256: sha256(bytes), kind: parsed.kind }), target: Object.freeze({ path: target, exists, overwrite_required: exists, rendered_sha256: sha256(rendered) }), compatibility: Object.freeze({ status: "compatible", detail: "source maps only provider/model selection; credentials and network settings are never imported" }), writes: Object.freeze([target]), rollback: Object.freeze({ available: true, detail: "apply creates a private backup and receipt before replacing an existing target" }) });
}

/** Explicit writer. Source hash and overwrite consent prevent TOCTOU and accidental replacement. */
export function applyMigration(input: { readonly cwd: string; readonly source_path: string; readonly expected_source_sha256: string; readonly overwrite: boolean; readonly now?: () => Date }): MigrationReceipt {
  const preview = previewMigration(input); if (preview.source.sha256 !== input.expected_source_sha256) throw new Error("migration source changed since preview");
  if (preview.target.exists && !input.overwrite) throw new Error("existing arbor.jsonc requires explicit overwrite");
  const target = preview.target.path; const before = preview.target.exists ? readFileSync(target) : null; const migrationDir = join(resolve(input.cwd), ".arbor", "migrations"); ensurePrivateDirectory(migrationDir);
  const receiptId = `migration-${Date.now().toString(36)}-${preview.source.sha256.slice(7, 19)}`; const backup = before === null ? null : join(migrationDir, `${receiptId}.before`);
  if (backup !== null && before !== null) atomicWrite(backup, before);
  const source = parseImport(readFileSync(preview.source.path)); const rendered = Buffer.from(`${JSON.stringify(source.target, null, 2)}\n`, "utf8"); atomicWrite(target, rendered);
  const receipt: MigrationReceipt = Object.freeze({ schema_version: MIGRATION_SCHEMA_VERSION, receipt_id: receiptId, target_path: target, target_before_sha256: before === null ? null : sha256(before), target_after_sha256: sha256(rendered), backup_path: backup, source_sha256: preview.source.sha256, applied_at: (input.now ?? (() => new Date()))().toISOString() });
  atomicWrite(join(migrationDir, `${receiptId}.json`), Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8")); return receipt;
}

/** Receipt-bound rollback refuses if a later actor changed the migrated target. */
export function rollbackMigration(input: { readonly cwd: string; readonly receipt_id: string }): MigrationReceipt {
  if (!/^migration-[a-z0-9-]+$/.test(input.receipt_id)) throw new Error("invalid migration receipt id");
  const receiptPath = join(resolve(input.cwd), ".arbor", "migrations", `${input.receipt_id}.json`); if (!safeFile(receiptPath)) throw new Error("migration receipt was not found");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as MigrationReceipt;
  if (receipt.schema_version !== MIGRATION_SCHEMA_VERSION || !receipt.target_path || !receipt.target_after_sha256) throw new Error("migration receipt is incompatible");
  if (!safeFile(receipt.target_path) || sha256(readFileSync(receipt.target_path)) !== receipt.target_after_sha256) throw new Error("target changed after migration; rollback is refused");
  if (receipt.backup_path === null) { try { unlinkSync(receipt.target_path); } catch { throw new Error("cannot roll back a created target safely"); } }
  else { if (!safeFile(receipt.backup_path) || receipt.target_before_sha256 === null || sha256(readFileSync(receipt.backup_path)) !== receipt.target_before_sha256) throw new Error("migration backup is unavailable or invalid"); atomicWrite(receipt.target_path, readFileSync(receipt.backup_path)); }
  return receipt;
}

function parseImport(bytes: Buffer): { readonly kind: "arbor-v1" | "opencode"; readonly target: Record<string, unknown> } {
  let value: unknown; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("migration source must be UTF-8 JSON"); }
  if (!record(value)) throw new Error("migration source must be a JSON object");
  if (value.schema_version === 1 && record(value.native) && typeof value.native.provider_id === "string" && typeof value.native.model === "string") return { kind: "arbor-v1", target: { schema_version: 1, native: { mode: typeof value.native.mode === "string" ? value.native.mode : "auto", adapter_id: typeof value.native.adapter_id === "string" ? value.native.adapter_id : "openai-compatible", provider_id: value.native.provider_id, model: value.native.model } } };
  const provider = typeof value.provider === "string" ? value.provider : typeof value.provider_id === "string" ? value.provider_id : null;
  const model = typeof value.model === "string" ? value.model : null;
  if (provider && model) return { kind: "opencode", target: { schema_version: 1, native: { mode: "auto", adapter_id: "openai-compatible", provider_id: provider, model } } };
  throw new Error("unsupported migration source; expected Arbor v1 or OpenCode provider/model JSON");
}
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sha256(value: Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function safeFile(path: string): boolean { try { return existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(); } catch { return false; } }
function confinedFile(root: string, candidate: string): string { const absolute = resolve(root, candidate); if (!absolute.startsWith(`${resolve(root)}/`) && absolute !== resolve(root)) throw new Error("migration source escapes workspace"); if (!safeFile(absolute)) throw new Error("migration source must be a regular file"); return absolute; }
function ensurePrivateDirectory(path: string): void { if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error("migration directory is unsafe"); mkdirSync(path, { recursive: true, mode: 0o700 }); }
// WA-38: fsync the temp file before rename and the parent directory after —
// the same crash-safe recipe as packages/arbor-audit/src/atomic-write.ts's
// canonical `atomicOverwriteFile` (that file's header comment explains the
// write-temp/fsync/rename/fsync-dir reasoning in full). A migration backup
// or receipt written without this could be silently lost to a crash between
// the rename and the next unrelated fsync of this directory. Windows
// exception matches arbor-kb/src/persist.ts's `atomicWrite`: fsyncSync on a
// directory handle rejects with EPERM there, so the directory fsync is
// skipped on that platform only — the temp file is already fsynced and
// renameSync is the atomic publication boundary.
function atomicWrite(path: string, content: Buffer): void {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  if (process.platform !== "win32") {
    const directory = dirname(path);
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}
