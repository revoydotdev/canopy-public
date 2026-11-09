import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve } from "node:path";
import { acquireWriterLock, canonicalizeForHash, isVerificationCheck, type Cost, type PersistenceLoadResult, type Provenance } from "@arbor/core";
import type {
  EvalBenchmarkTargetInput,
  EvalPrefixDescriptorInput,
  EvalPrefixObservationInput,
  EvalPrefixObservationRecord,
  EvalPrefixReuseEdgeSummary,
  EvalPrefixReuseLedger,
  EvalPrefixReuseSummary,
  EvalReuseLedgerOperationReceipt,
} from "./types.js";

export type EvalReuseLedgerPersistenceArtifact = "eval_reuse_ledger" | "temporary_file";
export type EvalReuseLedgerPersistenceDiagnosticCode =
  | "invalid_json"
  | "invalid_shape"
  | "identity_mismatch"
  | "integrity_failure"
  | "quarantine_failed";

export interface EvalReuseLedgerPersistenceDiagnostic {
  artifact: EvalReuseLedgerPersistenceArtifact;
  code: EvalReuseLedgerPersistenceDiagnosticCode;
  path: string;
  message: string;
  quarantined_path?: string;
}

export interface EvalReuseLedgerLoadResult<T> {
  value: T | null;
  diagnostics: EvalReuseLedgerPersistenceDiagnostic[];
}

export interface PersistedPrefixObservationResult {
  ledger: EvalPrefixReuseLedger;
  changed: boolean;
  diagnostics: EvalReuseLedgerPersistenceDiagnostic[];
}

export class ReuseLedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReuseLedgerConflictError";
  }
}

const REUSE_LEDGER_SCHEMA_VERSION = 1;
const REUSE_LEDGER_DIRNAME = "eval-reuse-ledger";
const PREFIX_GENERATOR = "arbor-eval/reuse-ledger";
const SAFE_LEDGER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeForHash(value)).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return finiteInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function isProvenance(value: unknown): value is Provenance {
  if (!isRecord(value) || !nonEmpty(value.tag)) return false;
  if (value.tag === "verified") return nonEmpty(value.cmd) && value.exit === 0 && nonEmpty(value.stdout_hash)
    && (value.check === undefined || isVerificationCheck(value.check));
  if (value.tag === "claimed") return nonEmpty(value.claimant);
  if (value.tag === "critic_approved") return nonEmpty(value.critic) && nonEmpty(value.rationale);
  return value.tag === "generated" && nonEmpty(value.generator) && nonEmpty(value.input_hash);
}

function isCost(value: unknown): value is Cost {
  if (!isRecord(value) || !nonEmpty(value.kind)) return false;
  if (value.kind === "priced") {
    return finiteInteger(value.minor_units)
      && nonEmpty(value.currency)
      && nonNegativeInteger(value.minor_unit_exponent)
      && nonEmpty(value.price_source_id);
  }
  return value.kind === "unpriced" && nonEmpty(value.reason);
}

function ledgerDir(dir: string): string {
  return join(dir, REUSE_LEDGER_DIRNAME);
}

function assertSafeLedgerId(ledgerId: unknown): asserts ledgerId is string {
  if (typeof ledgerId !== "string" || !SAFE_LEDGER_ID.test(ledgerId)) {
    throw new Error("ledger_id must contain only letters, digits, '.', '_', or '-' and cannot begin with punctuation");
  }
}

function ledgerPath(dir: string, ledgerId: string): string {
  assertSafeLedgerId(ledgerId);
  const base = resolve(ledgerDir(dir));
  const path = resolve(base, `${ledgerId}.json`);
  if (relative(base, path).startsWith("..")) throw new Error("ledger_id resolves outside the ledger directory");
  return path;
}

function quarantineReuseLedgerFile(
  path: string,
  dir: string,
  artifact: EvalReuseLedgerPersistenceArtifact,
  code: EvalReuseLedgerPersistenceDiagnosticCode,
  message: string,
): EvalReuseLedgerPersistenceDiagnostic {
  const quarantineDir = join(dir, "quarantine");
  let diagnostic: EvalReuseLedgerPersistenceDiagnostic = { artifact, code, path, message };
  try {
    mkdirSync(quarantineDir, { recursive: true });
    const stem = `${basename(path)}.${new Date().toISOString().replace(/[:.]/g, "-")}.${process.pid}`;
    let destination = join(quarantineDir, `${stem}.corrupt`);
    let suffix = 1;
    while (existsSync(destination)) {
      destination = join(quarantineDir, `${stem}.${suffix++}.corrupt`);
    }
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

export function reconcileReuseLedgerTemporaryFiles(dir: string, ledgerId: string): EvalReuseLedgerPersistenceDiagnostic[] {
  ledgerPath(dir, ledgerId);
  const base = ledgerDir(dir);
  if (!existsSync(base)) return [];
  const prefix = `.${ledgerId}.`;
  return readdirSync(base)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".tmp"))
    .map((file) => quarantineReuseLedgerFile(join(base, file), dir, "temporary_file", "invalid_shape", "abandoned eval reuse-ledger temporary file"));
}

function normalizePrefixDescriptor(input: EvalPrefixDescriptorInput) {
  if (!nonEmpty(input.prefix_text)) throw new Error("prefix_text must be a non-empty string");
  if (!nonEmpty(input.prompt_template_id)) throw new Error("prompt_template_id must be a non-empty string");
  if (!nonNegativeInteger(input.token_units)) throw new Error("token_units must be a non-negative safe integer");
  if (!nonNegativeInteger(input.byte_length)) throw new Error("byte_length must be a non-negative safe integer");
  if (input.tool_contract_id !== undefined && !nonEmpty(input.tool_contract_id)) throw new Error("tool_contract_id, when present, must be non-empty");
  if (input.model_family !== undefined && !nonEmpty(input.model_family)) throw new Error("model_family, when present, must be non-empty");
  if (input.context_signature !== undefined && !nonEmpty(input.context_signature)) throw new Error("context_signature, when present, must be non-empty");
  return {
    prefix_text: input.prefix_text,
    prompt_template_id: input.prompt_template_id,
    ...(input.tool_contract_id === undefined ? {} : { tool_contract_id: input.tool_contract_id }),
    ...(input.model_family === undefined ? {} : { model_family: input.model_family }),
    ...(input.context_signature === undefined ? {} : { context_signature: input.context_signature }),
    token_units: input.token_units,
    byte_length: input.byte_length,
  } as const;
}

function normalizeTarget(input: EvalBenchmarkTargetInput) {
  if (!nonEmpty(input.cluster_id)) throw new Error("cluster_id must be a non-empty string");
  if (!nonEmpty(input.item_id)) throw new Error("item_id must be a non-empty string");
  if (!nonEmpty(input.config_id)) throw new Error("config_id must be a non-empty string");
  if (input.variant_id !== undefined && !nonEmpty(input.variant_id)) throw new Error("variant_id, when present, must be non-empty");
  return {
    cluster_id: input.cluster_id,
    item_id: input.item_id,
    config_id: input.config_id,
    ...(input.variant_id === undefined ? {} : { variant_id: input.variant_id }),
  } as const;
}

function prefixIdFor(input: EvalPrefixDescriptorInput): string {
  const normalized = normalizePrefixDescriptor(input);
  return hashCanonical({
    prefix_text: normalized.prefix_text,
    prompt_template_id: normalized.prompt_template_id,
    ...(normalized.tool_contract_id === undefined ? {} : { tool_contract_id: normalized.tool_contract_id }),
    ...(normalized.model_family === undefined ? {} : { model_family: normalized.model_family }),
    ...(normalized.context_signature === undefined ? {} : { context_signature: normalized.context_signature }),
  });
}

function targetIdFor(input: EvalBenchmarkTargetInput): string {
  return hashCanonical(normalizeTarget(input));
}

function observationFingerprint(input: EvalPrefixObservationInput): string {
  const normalized = {
    operation_id: input.operation_id,
    observed_at: input.observed_at,
    observation_kind: input.observation_kind,
    prefix_id: prefixIdFor(input.prefix),
    target_id: targetIdFor(input.target),
    marginal_cost_token_units: input.marginal_cost_token_units,
    marginal_cost: input.marginal_cost,
    provenance: input.provenance,
  };
  return hashCanonical(normalized);
}

function observationIdFor(input: EvalPrefixObservationInput): string {
  return hashCanonical({
    operation_id: input.operation_id,
    fingerprint: observationFingerprint(input),
  });
}

function assertObservationInput(input: EvalPrefixObservationInput): void {
  if (!nonEmpty(input.operation_id)) throw new Error("operation_id must be a non-empty string");
  if (input.observation_kind !== "materialized" && input.observation_kind !== "reused") {
    throw new Error("observation_kind must be materialized or reused");
  }
  if (!isIsoTimestamp(input.observed_at)) throw new Error("observed_at must be an ISO timestamp");
  if (!nonNegativeInteger(input.marginal_cost_token_units)) throw new Error("marginal_cost_token_units must be a non-negative safe integer");
  normalizePrefixDescriptor(input.prefix);
  normalizeTarget(input.target);
  if (!isCost(input.marginal_cost)) throw new Error("marginal_cost must be a valid Cost");
  if (!isProvenance(input.provenance)) throw new Error("provenance must be a valid Provenance");
}

function buildLedgerPayload(ledger: Omit<EvalPrefixReuseLedger, "integrity_hash">) {
  return {
    schema_version: ledger.schema_version,
    ledger_id: ledger.ledger_id,
    updated_at: ledger.updated_at,
    prefixes: [...ledger.prefixes],
    targets: [...ledger.targets],
    observations: [...ledger.observations],
    operations: [...ledger.operations],
  };
}

function sealLedger(ledger: Omit<EvalPrefixReuseLedger, "integrity_hash">): EvalPrefixReuseLedger {
  return Object.freeze({
    ...ledger,
    integrity_hash: hashCanonical(buildLedgerPayload(ledger)),
  });
}

export function createPrefixReuseLedger(
  ledgerId: string,
  options: { now?: string } = {},
): EvalPrefixReuseLedger {
  assertSafeLedgerId(ledgerId);
  const now = options.now ?? new Date().toISOString();
  if (!isIsoTimestamp(now)) throw new Error("now must be an ISO timestamp");
  return sealLedger({
    schema_version: REUSE_LEDGER_SCHEMA_VERSION,
    ledger_id: ledgerId,
    updated_at: now,
    prefixes: [],
    targets: [],
    observations: [],
    operations: [],
  });
}

function validatePrefixEntity(value: unknown): asserts value is EvalPrefixReuseLedger["prefixes"][number] {
  if (!isRecord(value) || !nonEmpty(value.prefix_id) || !nonEmpty(value.prefix_text) || !nonEmpty(value.prompt_template_id)
    || !nonNegativeInteger(value.token_units) || !nonNegativeInteger(value.byte_length) || !isProvenance(value.provenance)) {
    throw new Error("ledger contains an invalid prefix entity");
  }
  const candidate = value as unknown as EvalPrefixReuseLedger["prefixes"][number];
  if (candidate.tool_contract_id !== undefined && !nonEmpty(candidate.tool_contract_id)) throw new Error("ledger contains an invalid prefix tool_contract_id");
  if (candidate.model_family !== undefined && !nonEmpty(candidate.model_family)) throw new Error("ledger contains an invalid prefix model_family");
  if (candidate.context_signature !== undefined && !nonEmpty(candidate.context_signature)) throw new Error("ledger contains an invalid prefix context_signature");
  const expectedId = prefixIdFor(candidate);
  if (candidate.prefix_id !== expectedId) throw new Error(`prefix identity mismatch for ${JSON.stringify(candidate.prefix_id)}`);
  if (candidate.provenance.tag !== "generated" || candidate.provenance.generator !== PREFIX_GENERATOR || candidate.provenance.input_hash !== candidate.prefix_id) {
    throw new Error(`prefix ${JSON.stringify(candidate.prefix_id)} does not carry the expected generated provenance`);
  }
}

function validateTargetEntity(value: unknown): asserts value is EvalPrefixReuseLedger["targets"][number] {
  if (!isRecord(value) || !nonEmpty(value.target_id) || !nonEmpty(value.cluster_id) || !nonEmpty(value.item_id) || !nonEmpty(value.config_id)) {
    throw new Error("ledger contains an invalid benchmark target");
  }
  const candidate = value as unknown as EvalPrefixReuseLedger["targets"][number];
  if (candidate.variant_id !== undefined && !nonEmpty(candidate.variant_id)) throw new Error("ledger contains an invalid benchmark target variant_id");
  const expectedId = targetIdFor(candidate);
  if (candidate.target_id !== expectedId) throw new Error(`target identity mismatch for ${JSON.stringify(candidate.target_id)}`);
}

function validateObservationRecord(value: unknown): asserts value is EvalPrefixObservationRecord {
  if (!isRecord(value) || !nonEmpty(value.observation_id) || !nonEmpty(value.operation_id) || !nonEmpty(value.prefix_id)
    || !nonEmpty(value.target_id) || !isIsoTimestamp(value.observed_at) || !nonNegativeInteger(value.marginal_cost_token_units)
    || !isCost(value.marginal_cost) || !isProvenance(value.provenance)) {
    throw new Error("ledger contains an invalid observation");
  }
  if (value.observation_kind !== "materialized" && value.observation_kind !== "reused") {
    throw new Error("ledger contains an observation with an invalid kind");
  }
}

function validateOperationReceipt(value: unknown): asserts value is EvalReuseLedgerOperationReceipt {
  if (!isRecord(value) || !nonEmpty(value.operation_id) || !nonEmpty(value.fingerprint) || !nonEmpty(value.observation_id) || !isIsoTimestamp(value.recorded_at)) {
    throw new Error("ledger contains an invalid operation receipt");
  }
}

function validateReuseLedger(raw: unknown, ledgerId: string): EvalPrefixReuseLedger {
  if (!isRecord(raw)) throw new Error("ledger snapshot must be a JSON object");
  if (raw.schema_version !== REUSE_LEDGER_SCHEMA_VERSION) throw new Error("ledger has an unsupported schema_version");
  if (raw.ledger_id !== ledgerId) throw new Error(`ledger id ${JSON.stringify(raw.ledger_id)} does not match requested ledger ${JSON.stringify(ledgerId)}`);
  if (!isIsoTimestamp(raw.updated_at)) throw new Error("ledger updated_at must be an ISO timestamp");
  if (!Array.isArray(raw.prefixes) || !Array.isArray(raw.targets) || !Array.isArray(raw.observations) || !Array.isArray(raw.operations)) {
    throw new Error("ledger arrays are missing");
  }
  if (!nonEmpty(raw.integrity_hash)) throw new Error("ledger integrity_hash is missing");

  const payload = {
    schema_version: raw.schema_version,
    ledger_id: raw.ledger_id,
    updated_at: raw.updated_at,
    prefixes: raw.prefixes,
    targets: raw.targets,
    observations: raw.observations,
    operations: raw.operations,
  };
  const expectedHash = hashCanonical(payload);
  if (raw.integrity_hash !== expectedHash) throw new Error(`ledger integrity mismatch: expected ${expectedHash} but found ${raw.integrity_hash}`);

  for (const prefix of raw.prefixes) validatePrefixEntity(prefix);
  for (const target of raw.targets) validateTargetEntity(target);
  for (const observation of raw.observations) validateObservationRecord(observation);
  for (const receipt of raw.operations) validateOperationReceipt(receipt);

  const prefixIds = new Set<string>();
  for (const prefix of raw.prefixes) {
    if (prefixIds.has(prefix.prefix_id)) throw new Error(`duplicate prefix_id ${JSON.stringify(prefix.prefix_id)}`);
    prefixIds.add(prefix.prefix_id);
  }

  const targetIds = new Set<string>();
  for (const target of raw.targets) {
    if (targetIds.has(target.target_id)) throw new Error(`duplicate target_id ${JSON.stringify(target.target_id)}`);
    targetIds.add(target.target_id);
  }

  const observationIds = new Set<string>();
  const prefixesById = new Map<string, EvalPrefixReuseLedger["prefixes"][number]>();
  for (const prefix of raw.prefixes) prefixesById.set(prefix.prefix_id, prefix);
  const targetsById = new Map<string, EvalPrefixReuseLedger["targets"][number]>();
  for (const target of raw.targets) targetsById.set(target.target_id, target);
  for (const observation of raw.observations) {
    if (!prefixIds.has(observation.prefix_id)) throw new Error(`observation ${JSON.stringify(observation.observation_id)} references missing prefix ${JSON.stringify(observation.prefix_id)}`);
    if (!targetIds.has(observation.target_id)) throw new Error(`observation ${JSON.stringify(observation.observation_id)} references missing target ${JSON.stringify(observation.target_id)}`);
    if (observationIds.has(observation.observation_id)) throw new Error(`duplicate observation_id ${JSON.stringify(observation.observation_id)}`);
    const expectedObservationId = observationIdFor({
      operation_id: observation.operation_id,
      observed_at: observation.observed_at,
      observation_kind: observation.observation_kind,
      prefix: prefixesById.get(observation.prefix_id)!,
      target: targetsById.get(observation.target_id)!,
      marginal_cost_token_units: observation.marginal_cost_token_units,
      marginal_cost: observation.marginal_cost,
      provenance: observation.provenance,
    });
    if (observation.observation_id !== expectedObservationId) {
      throw new Error(`observation identity mismatch for ${JSON.stringify(observation.observation_id)}`);
    }
    observationIds.add(observation.observation_id);
  }

  const operationIds = new Set<string>();
  for (const receipt of raw.operations) {
    if (operationIds.has(receipt.operation_id)) throw new Error(`duplicate operation_id ${JSON.stringify(receipt.operation_id)}`);
    if (!observationIds.has(receipt.observation_id)) throw new Error(`operation ${JSON.stringify(receipt.operation_id)} references missing observation ${JSON.stringify(receipt.observation_id)}`);
    const observation = raw.observations.find((entry) => entry.observation_id === receipt.observation_id)!;
    const expectedFingerprint = observationFingerprint({
      operation_id: observation.operation_id,
      observed_at: observation.observed_at,
      observation_kind: observation.observation_kind,
      prefix: prefixesById.get(observation.prefix_id)!,
      target: targetsById.get(observation.target_id)!,
      marginal_cost_token_units: observation.marginal_cost_token_units,
      marginal_cost: observation.marginal_cost,
      provenance: observation.provenance,
    });
    if (receipt.fingerprint !== expectedFingerprint) {
      throw new Error(`operation fingerprint mismatch for ${JSON.stringify(receipt.operation_id)}`);
    }
    if (receipt.operation_id !== observation.operation_id) {
      throw new Error(`operation ${JSON.stringify(receipt.operation_id)} points at observation ${JSON.stringify(observation.observation_id)} with mismatched operation_id`);
    }
    operationIds.add(receipt.operation_id);
  }

  return Object.freeze(raw as unknown as EvalPrefixReuseLedger);
}

export function savePrefixReuseLedger(ledger: EvalPrefixReuseLedger, dir: string): void {
  const base = ledgerDir(dir);
  mkdirSync(base, { recursive: true });
  const target = ledgerPath(dir, ledger.ledger_id);
  const temporary = join(base, `.${ledger.ledger_id}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(ledger, null, 2));
  renameSync(temporary, target);
}

export function loadPrefixReuseLedgerResult(
  ledgerId: string,
  dir: string,
): EvalReuseLedgerLoadResult<EvalPrefixReuseLedger> {
  const filePath = ledgerPath(dir, ledgerId);
  const diagnostics = reconcileReuseLedgerTemporaryFiles(dir, ledgerId);
  if (!existsSync(filePath)) return { value: null, diagnostics };
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return { value: validateReuseLedger(raw, ledgerId), diagnostics };
  } catch (error) {
    const message = error instanceof SyntaxError
      ? "eval reuse-ledger is not valid JSON"
      : `eval reuse-ledger failed validation: ${error instanceof Error ? error.message : String(error)}`;
    const errorText = error instanceof Error ? error.message : String(error);
    const code: EvalReuseLedgerPersistenceDiagnosticCode = error instanceof SyntaxError
      ? "invalid_json"
      : errorText.startsWith("ledger id")
        ? "identity_mismatch"
        : errorText.startsWith("ledger integrity mismatch")
          ? "integrity_failure"
          : "invalid_shape";
    diagnostics.push(quarantineReuseLedgerFile(filePath, dir, "eval_reuse_ledger", code, message));
    return { value: null, diagnostics };
  }
}

export function recordPrefixReuseObservation(
  ledger: EvalPrefixReuseLedger,
  input: EvalPrefixObservationInput,
  options: { now?: string } = {},
): EvalPrefixReuseLedger {
  assertObservationInput(input);
  const fingerprint = observationFingerprint(input);
  const existingReceipt = ledger.operations.find((receipt) => receipt.operation_id === input.operation_id);
  if (existingReceipt) {
    if (existingReceipt.fingerprint !== fingerprint) {
      throw new ReuseLedgerConflictError(`operation_id ${JSON.stringify(input.operation_id)} was already recorded with different content`);
    }
    return ledger;
  }

  const prefix = normalizePrefixDescriptor(input.prefix);
  const prefixId = prefixIdFor(prefix);
  const target = normalizeTarget(input.target);
  const targetId = targetIdFor(target);
  const observationId = observationIdFor(input);
  const now = options.now ?? input.observed_at;
  if (!isIsoTimestamp(now)) throw new Error("now must be an ISO timestamp");

  return sealLedger({
    schema_version: ledger.schema_version,
    ledger_id: ledger.ledger_id,
    updated_at: now,
    prefixes: ledger.prefixes.some((entry) => entry.prefix_id === prefixId)
      ? ledger.prefixes
      : [
          ...ledger.prefixes,
          Object.freeze({
            prefix_id: prefixId,
            ...prefix,
            provenance: Object.freeze({ tag: "generated", generator: PREFIX_GENERATOR, input_hash: prefixId } as const),
          }),
        ],
    targets: ledger.targets.some((entry) => entry.target_id === targetId)
      ? ledger.targets
      : [
          ...ledger.targets,
          Object.freeze({ target_id: targetId, ...target }),
        ],
    observations: [
      ...ledger.observations,
      Object.freeze({
        observation_id: observationId,
        operation_id: input.operation_id,
        prefix_id: prefixId,
        target_id: targetId,
        observation_kind: input.observation_kind,
        observed_at: input.observed_at,
        marginal_cost_token_units: input.marginal_cost_token_units,
        marginal_cost: input.marginal_cost,
        provenance: input.provenance,
      }),
    ],
    operations: [
      ...ledger.operations,
      Object.freeze({
        operation_id: input.operation_id,
        fingerprint,
        observation_id: observationId,
        recorded_at: now,
      }),
    ],
  });
}

export function persistPrefixReuseObservation(
  dir: string,
  ledgerId: string,
  input: EvalPrefixObservationInput,
  options: { now?: string; holder?: string } = {},
): PersistedPrefixObservationResult {
  assertSafeLedgerId(ledgerId);
  const lock = acquireWriterLock(ledgerDir(dir), { holder: options.holder ?? "arbor-eval/reuse-ledger" });
  if (!lock.ok) {
    throw new Error(lock.detail);
  }
  try {
    const loaded = loadPrefixReuseLedgerResult(ledgerId, dir);
    const current = loaded.value ?? createPrefixReuseLedger(ledgerId, { now: options.now ?? input.observed_at });
    const next = recordPrefixReuseObservation(current, input, { now: options.now ?? input.observed_at });
    if (next !== current) savePrefixReuseLedger(next, dir);
    return { ledger: next, changed: next !== current, diagnostics: loaded.diagnostics };
  } finally {
    lock.lock.release();
  }
}

export function summarizePrefixReuseLedger(ledger: EvalPrefixReuseLedger): EvalPrefixReuseSummary {
  const prefixesById = new Map(ledger.prefixes.map((prefix) => [prefix.prefix_id, prefix] as const));
  const targetsById = new Map(ledger.targets.map((target) => [target.target_id, target] as const));
  const edges = new Map<string, EvalPrefixReuseEdgeSummary>();

  for (const observation of ledger.observations) {
    const edgeKey = `${observation.prefix_id}::${observation.target_id}`;
    const existing = edges.get(edgeKey);
    const nextCostTotals = new Map(existing?.provider_cost_totals.map((entry) => [entry.currency_exponent_key, entry]) ?? []);
    if (observation.marginal_cost.kind === "priced") {
      const pricedKey = `${observation.marginal_cost.currency}:${observation.marginal_cost.minor_unit_exponent}`;
      const current = nextCostTotals.get(pricedKey);
      nextCostTotals.set(pricedKey, {
        currency_exponent_key: pricedKey,
        currency: observation.marginal_cost.currency,
        minor_unit_exponent: observation.marginal_cost.minor_unit_exponent,
        total_minor_units: (current?.total_minor_units ?? 0) + observation.marginal_cost.minor_units,
      });
    }

    edges.set(edgeKey, Object.freeze({
      prefix_id: observation.prefix_id,
      target_id: observation.target_id,
      materialization_count: (existing?.materialization_count ?? 0) + (observation.observation_kind === "materialized" ? 1 : 0),
      reuse_count: (existing?.reuse_count ?? 0) + (observation.observation_kind === "reused" ? 1 : 0),
      materialized_token_units: (existing?.materialized_token_units ?? 0) + (observation.observation_kind === "materialized" ? observation.marginal_cost_token_units : 0),
      reused_token_units: (existing?.reused_token_units ?? 0) + (observation.observation_kind === "reused" ? observation.marginal_cost_token_units : 0),
      priced_observation_count: (existing?.priced_observation_count ?? 0) + (observation.marginal_cost.kind === "priced" ? 1 : 0),
      unpriced_observation_count: (existing?.unpriced_observation_count ?? 0) + (observation.marginal_cost.kind === "unpriced" ? 1 : 0),
      first_observed_at: existing === undefined || observation.observed_at < existing.first_observed_at
        ? observation.observed_at
        : existing.first_observed_at,
      last_observed_at: existing === undefined || observation.observed_at > existing.last_observed_at
        ? observation.observed_at
        : existing.last_observed_at,
      provider_cost_totals: [...nextCostTotals.values()].sort((a, b) => a.currency_exponent_key.localeCompare(b.currency_exponent_key)),
    }));
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.prefix_id.localeCompare(b.prefix_id) || a.target_id.localeCompare(b.target_id));
  const materializationCount = ledger.observations.filter((entry) => entry.observation_kind === "materialized").length;
  const reuseCount = ledger.observations.length - materializationCount;
  const totalMaterializedTokenUnits = ledger.observations
    .filter((entry) => entry.observation_kind === "materialized")
    .reduce((sum, entry) => sum + entry.marginal_cost_token_units, 0);
  const totalReusedTokenUnits = ledger.observations
    .filter((entry) => entry.observation_kind === "reused")
    .reduce((sum, entry) => sum + entry.marginal_cost_token_units, 0);

  return Object.freeze({
    ledger_id: ledger.ledger_id,
    prefixes: ledger.prefixes.map((prefix) => Object.freeze({
      ...prefix,
      attached_target_count: sortedEdges.filter((edge) => edge.prefix_id === prefix.prefix_id).length,
    })),
    targets: ledger.targets.map((target) => Object.freeze({
      ...target,
      attached_prefix_count: sortedEdges.filter((edge) => edge.target_id === target.target_id).length,
    })),
    edges: sortedEdges,
    totals: Object.freeze({
      observation_count: ledger.observations.length,
      materialization_count: materializationCount,
      reuse_count: reuseCount,
      total_materialized_token_units: totalMaterializedTokenUnits,
      total_reused_token_units: totalReusedTokenUnits,
      reuse_ratio: ledger.observations.length === 0 ? 0 : reuseCount / ledger.observations.length,
    }),
    observations: ledger.observations.map((observation) => Object.freeze({
      ...observation,
      prefix: prefixesById.get(observation.prefix_id)!,
      target: targetsById.get(observation.target_id)!,
    })),
  });
}

export type { PersistenceLoadResult };
