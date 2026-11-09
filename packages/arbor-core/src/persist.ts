import { mkdirSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Action, CampaignConfig, CampaignState, DeferredAction, TreeNode } from "./types.js";
import { NODE_ERROR_KINDS, OUTCOME_KINDS, isHaltReason, isVerificationCheck } from "./types.js";
import { assertValidCampaignId, isSafeRelativePath } from "./campaign-id.js";
import { isRuntimeGateRefusal } from "./runtime-contracts.js";

export type PersistenceArtifact = "campaign_snapshot" | "boulder" | "knowledge_base" | "audit_ledger" | "temporary_file";
export type PersistenceDiagnosticCode = "invalid_json" | "invalid_shape" | "identity_mismatch" | "integrity_failure" | "quarantine_failed";

/** A machine-readable explanation for persistence which could not be trusted. */
export interface PersistenceDiagnostic {
  artifact: PersistenceArtifact;
  code: PersistenceDiagnosticCode;
  path: string;
  message: string;
  quarantined_path?: string;
}

export interface PersistenceLoadResult<T> {
  value: T | null;
  diagnostics: PersistenceDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function quarantinePersistenceFile(path: string, dir: string, artifact: PersistenceArtifact, code: PersistenceDiagnosticCode, message: string): PersistenceDiagnostic {
  const quarantineDir = join(dir, "quarantine");
  let diagnostic: PersistenceDiagnostic = { artifact, code, path, message };
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
    const detail = error instanceof Error ? error.message : String(error);
    diagnostic = {
      artifact,
      code: "quarantine_failed",
      path,
      message: `${message}; quarantine failed: ${detail}`,
    };
  }
  return diagnostic;
}

/** Validate decoded campaign data without persistence side effects. */
export function validateCampaignSnapshot(value: unknown, campaignId: string): CampaignState {
  assertValidCampaignId(campaignId);
  if (!isRecord(value)) throw new Error("snapshot must be a JSON object");
  if (value.id !== campaignId) throw new Error(`snapshot id ${JSON.stringify(value.id)} does not match requested campaign ${JSON.stringify(campaignId)}`);
  if (typeof value.plan_path !== "string" || typeof value.root_id !== "string" || typeof value.started_at !== "string") {
    throw new Error("snapshot is missing required string campaign fields");
  }
  if (!isRecord(value.config) || !finiteNumber(value.config.max_seconds) || !finiteNumber(value.config.min_score)
    || !finiteNumber(value.config.convergence_iterations) || !isRecord(value.config.score_config)
    || !finiteNumber(value.config.score_config.exploration_constant)) {
    throw new Error("snapshot has an invalid campaign config");
  }
  if (!Array.isArray(value.nodes) || !finiteNumber(value.iterations_completed)
    || !finiteNumber(value.iterations_without_kb_entry) || !finiteNumber(value.best_score)
    || typeof value.halted !== "boolean") {
    throw new Error("snapshot is missing required campaign state fields");
  }
  const haltReason = value.halt_reason;
  if (!isHaltReason(haltReason)) {
    throw new Error("snapshot has an invalid halt reason");
  }

  const tree = new Map<string, TreeNode>();
  for (const node of value.nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || node.id.length === 0) {
      throw new Error("snapshot contains a node without a non-empty string id");
    }
    if (tree.has(node.id)) throw new Error(`snapshot contains duplicate node id ${JSON.stringify(node.id)}`);
    if (!isAction(node.action)) throw new Error(`snapshot node ${JSON.stringify(node.id)} has an invalid action`);
    const hasMode = Object.prototype.hasOwnProperty.call(node, "memory_mode");
    const hasModeVersion = Object.prototype.hasOwnProperty.call(node, "memory_mode_version");
    if (!hasMode && !hasModeVersion) {
      // Deterministic migration for snapshots written before ADR-014.
      node.memory_mode = "accumulate";
      node.memory_mode_version = 1;
    } else if (!hasMode || !hasModeVersion) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has a partial memory mode`);
    } else if (node.memory_mode !== "accumulate" && node.memory_mode !== "consolidate") {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has an invalid memory mode`);
    } else if (!Number.isSafeInteger(node.memory_mode_version) || (node.memory_mode_version as number) < 1) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has an invalid memory mode version`);
    }
    // ADR-106: edge_visit_count/value_estimate — deterministic migration for
    // snapshots written before backpropagation existed, matching the
    // memory_mode migration above. A present-but-invalid value (NaN,
    // negative count, non-finite estimate) fails validation rather than
    // silently round-tripping a corrupt number.
    if (!Object.prototype.hasOwnProperty.call(node, "edge_visit_count")) node.edge_visit_count = 0;
    if (!Object.prototype.hasOwnProperty.call(node, "value_estimate")) node.value_estimate = 0;
    if (!Number.isSafeInteger(node.edge_visit_count) || (node.edge_visit_count as number) < 0) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has an invalid edge_visit_count`);
    }
    if (typeof node.value_estimate !== "number" || !Number.isFinite(node.value_estimate)) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has an invalid value_estimate`);
    }
    if (!isNodeState(node.state)) throw new Error(`snapshot node ${JSON.stringify(node.id)} has an invalid state`);
    if (node.outcome !== undefined && !isNodeOutcome(node.outcome)) throw new Error(`snapshot node ${JSON.stringify(node.id)} has an invalid outcome`);
    if (node.state === "interrupted" && (!isRecord(node.outcome) || node.outcome.kind !== "interrupted")) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} is interrupted without an interrupted outcome`);
    }
    if (node.state !== "interrupted" && isRecord(node.outcome) && node.outcome.kind === "interrupted") {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} retains an interrupted outcome in state ${JSON.stringify(node.state)}`);
    }
    // TreeNode.provenance is Provenance | null (never optional) — a disk-loaded
    // node claiming `verified` provenance without a stdout_hash must not pass
    // validation and then be trusted as fully typed (G-26).
    if (node.provenance !== null && !isProvenance(node.provenance)) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has invalid provenance`);
    }
    if (node.critic_verdict !== undefined && !isCriticVerdict(node.critic_verdict)) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has invalid critic verdict`);
    }
    if (node.reward !== undefined && !isBackedUpReward(node.reward)) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has an invalid reward record`);
    }
    if (node.candidate !== undefined && !isCandidateArtifact(node.candidate)) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has an invalid candidate artifact`);
    }
    if (node.bound_scope_intents !== undefined && !isBoundScopeIntentList(node.bound_scope_intents)) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has invalid bound scope intents`);
    }
    // TreeNode.gate_records is a required GateRecord[] — downstream readers
    // (e.g. manager.ts's campaign snapshot projection) spread it unguarded
    // (`[...n.gate_records]`), so an absent or malformed array here is not a
    // cosmetic gap: it is a live crash waiting one read away.
    if (!Array.isArray(node.gate_records) || !node.gate_records.every(isGateRecord)) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has invalid gate_records`);
    }
    tree.set(node.id, node as unknown as TreeNode);
  }
  if (!tree.has(value.root_id)) throw new Error("snapshot root_id does not identify a node");
  const root = tree.get(value.root_id)!;
  if (root.parent_id !== null) throw new Error("snapshot root node must not have a parent");
  for (const node of tree.values()) {
    if (!Array.isArray(node.children_ids) || new Set(node.children_ids).size !== node.children_ids.length) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has invalid child links`);
    }
    if (node.state === "verified" && node.provenance?.tag !== "verified") {
      throw new Error(`snapshot verified node ${JSON.stringify(node.id)} lacks !verified provenance`);
    }
    for (const childId of node.children_ids) {
      const child = tree.get(childId);
      if (!child || child.parent_id !== node.id) {
        throw new Error(`snapshot node ${JSON.stringify(node.id)} has an inconsistent child link`);
      }
    }
    if (node.id === value.root_id) continue;
    if (typeof node.parent_id !== "string" || !tree.has(node.parent_id)) {
      throw new Error(`snapshot node ${JSON.stringify(node.id)} has a missing parent`);
    }
    const parent = tree.get(node.parent_id)!;
    if (parent.children_ids.filter((id) => id === node.id).length !== 1) {
      throw new Error(`snapshot parent ${JSON.stringify(parent.id)} does not reference child ${JSON.stringify(node.id)} exactly once`);
    }
  }
  for (const node of tree.values()) {
    const visited = new Set<string>();
    let current: TreeNode | undefined = node;
    while (current) {
      if (visited.has(current.id)) throw new Error(`snapshot contains a parent cycle at ${JSON.stringify(current.id)}`);
      visited.add(current.id);
      current = current.parent_id === null ? undefined : tree.get(current.parent_id);
    }
    if (!visited.has(value.root_id)) throw new Error(`snapshot node ${JSON.stringify(node.id)} is disconnected from its root`);
  }

  const deferredActions = value.deferred_actions === undefined ? undefined : validateDeferredActions(value.deferred_actions, tree);
  if (value.run_diagnostic !== undefined && !isRunDiagnostic(value.run_diagnostic)) {
    throw new Error("snapshot has an invalid run_diagnostic");
  }
  if (value.governance !== undefined && !isArbiterDecision(value.governance)) {
    throw new Error("snapshot has an invalid governance decision");
  }

  return {
    id: value.id,
    plan_path: value.plan_path,
    config: value.config as unknown as CampaignConfig,
    tree,
    root_id: value.root_id,
    started_at: value.started_at,
    iterations_completed: value.iterations_completed,
    iterations_without_kb_entry: value.iterations_without_kb_entry,
    best_score: value.best_score,
    halted: value.halted,
    halt_reason: haltReason,
    ...(deferredActions !== undefined ? { deferredActions } : {}),
    ...(value.run_diagnostic !== undefined ? { run_diagnostic: value.run_diagnostic as CampaignState["run_diagnostic"] } : {}),
    ...(value.governance !== undefined ? { governance: value.governance as CampaignState["governance"] } : {}),
  };
}

/** ADR-062: a persisted governance decision must carry a well-formed closed tier, rationale, and blast radius. */
function isArbiterDecision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.tier !== "direct" && value.tier !== "reviewed" && value.tier !== "governed") return false;
  if (typeof value.rationale !== "string" || value.rationale.length === 0) return false;
  if (value.source !== "arbiter" && value.source !== "operator_forced") return false;
  if (typeof value.decided_at !== "string") return false;
  const blast = value.blast_radius;
  if (!isRecord(blast)) return false;
  if (blast.reversibility !== "reversible" && blast.reversibility !== "irreversible" && blast.reversibility !== "unknown") return false;
  if (blast.write_paths !== undefined && (!Array.isArray(blast.write_paths) || !blast.write_paths.every((p) => typeof p === "string"))) return false;
  if (blast.command_argv !== undefined && (!Array.isArray(blast.command_argv) || !blast.command_argv.every((argv) => Array.isArray(argv) && argv.every((part) => typeof part === "string")))) return false;
  // E-2: additive, optional turn-budget estimate.
  if (value.turn_budget_estimate !== undefined && (!Number.isSafeInteger(value.turn_budget_estimate) || (value.turn_budget_estimate as number) <= 0)) return false;
  return true;
}

/**
 * `deferred_actions` is schema version 2 (see `DeferredAction`'s doc); absent
 * is a legacy (version 1) snapshot and must load unchanged, never coerced
 * into an empty version-2 list. Every present entry must fail closed: a
 * malformed action/dependency shape, a description that duplicates or
 * dangles against the rest of the plan, an unresolved dependency reference,
 * or overlap with an already-admitted tree node all reject the whole
 * snapshot rather than silently dropping the offending entry.
 */
function validateDeferredActions(value: unknown, tree: Map<string, TreeNode>): readonly DeferredAction[] {
  if (!Array.isArray(value)) throw new Error("snapshot has an invalid deferred actions list");

  const admittedDescriptions = new Set<string>();
  for (const node of tree.values()) admittedDescriptions.add(node.action.description);

  const deferredDescriptions = new Set<string>();
  const parsed: DeferredAction[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isAction(entry.action) || !Array.isArray(entry.depends_on)
      || entry.depends_on.length === 0 || !entry.depends_on.every(nonEmpty)) {
      throw new Error("snapshot contains a malformed deferred action entry");
    }
    const action = entry.action as unknown as Action;
    const description = action.description;
    if (admittedDescriptions.has(description)) {
      throw new Error(`snapshot deferred action ${JSON.stringify(description)} is inconsistent with an already-admitted tree node of the same description`);
    }
    if (deferredDescriptions.has(description)) {
      throw new Error(`snapshot contains a duplicate deferred action description ${JSON.stringify(description)}`);
    }
    deferredDescriptions.add(description);
    parsed.push({ action, depends_on: entry.depends_on as string[] });
  }

  const knownDescriptions = new Set([...admittedDescriptions, ...deferredDescriptions]);
  for (const entry of parsed) {
    for (const dependency of entry.depends_on) {
      if (!knownDescriptions.has(dependency)) {
        throw new Error(`snapshot deferred action ${JSON.stringify(entry.action.description)} depends on an unknown or dangling description ${JSON.stringify(dependency)}`);
      }
    }
  }

  return parsed;
}

function isNodeState(value: unknown): boolean {
  return typeof value === "string" && ["pending", "expanding", "verified", "claimed", "failed", "pruned", "interrupted", "abandoned", "awaiting_review"].includes(value);
}

/** Durable action validation mirrors the runtime command boundary. */
function isAction(value: unknown): boolean {
  if (!isRecord(value) || !nonEmpty(value.description) || !finiteNumber(value.estimated_gain)
    || !finiteNumber(value.estimated_cost) || value.estimated_cost < 0
    || !nonEmpty(value.category) || !nonEmpty(value.delegate_to)) return false;
  if (value.constraints !== undefined && (!Array.isArray(value.constraints) || !value.constraints.every(nonEmpty))) return false;
  if (value.acceptance_checks !== undefined && (!Array.isArray(value.acceptance_checks) || value.acceptance_checks.length > 32 || !value.acceptance_checks.every((check) => nonEmpty(check) && check.length <= 4_096) || new Set(value.acceptance_checks).size !== value.acceptance_checks.length)) return false;
  if (value.execution_role !== undefined && value.execution_role !== "architect" && value.execution_role !== "documentation-writer") return false;
  if (!validSkillSelection(value.skill_id, value.skill_version)) return false;
  if (!validSkillInputsClaim(value.skill_inputs, value.skill_inputs_provenance)) return false;
  if (value.high_risk_tool_scope !== undefined && !validHighRiskToolScope(value.high_risk_tool_scope)) return false;
  const depth = value.decomposition_depth;
  return depth === undefined || (typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0);
}

function validSkillInputsClaim(inputs: unknown, provenance: unknown): boolean {
  if (inputs === undefined && provenance === undefined) return true;
  if (!isRecord(inputs) || !isRecord(provenance) || Object.keys(inputs).length === 0 || Object.keys(inputs).length > 16 || Object.keys(provenance).length !== 5) return false;
  if (!Object.keys(provenance).every((key) => ["tag", "claimant", "command_name", "command_descriptor_hash", "input_hash"].includes(key))) return false;
  return Object.entries(inputs).every(([name, value]) => /^[a-z][a-z0-9_]{0,31}$/.test(name) && typeof value === "string" && Buffer.byteLength(value, "utf8") <= 8 * 1024)
    && provenance.tag === "claimed" && provenance.claimant === "cli-command" && typeof provenance.command_name === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(provenance.command_name)
    && typeof provenance.command_descriptor_hash === "string" && /^sha256:[a-f0-9]{64}$/.test(provenance.command_descriptor_hash)
    && typeof provenance.input_hash === "string" && /^sha256:[a-f0-9]{64}$/.test(provenance.input_hash);
}

function validSkillSelection(skillId: unknown, version: unknown): boolean {
  if (skillId === undefined || version === undefined) return skillId === undefined && version === undefined;
  return typeof skillId === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(skillId) && typeof version === "string" && version.length <= 128 && SEMVER.test(version);
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function validHighRiskToolScope(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.write_paths) || !Array.isArray(value.command_argv)) return false;
  return value.write_paths.every((path) => isSafeRelativePath(path))
    && value.command_argv.every((entry) => isCommandArgvEntry(entry));
}

/** One argv token: non-empty, bounded, and free of the NUL a shell layer could truncate on. */
function isArgvToken(part: unknown): boolean {
  return typeof part === "string" && part.length > 0 && part.length <= 4_096 && !part.includes("\u0000");
}

/** ADR-119: a `command_argv` entry is either a literal argv array or an intent (`argv_prefix`/`purpose`) entry. */
function isCommandArgvEntry(entry: unknown): boolean {
  if (Array.isArray(entry)) {
    return entry.length > 0 && entry.length <= 32 && entry.every((part) => typeof part === "string" && part.length > 0 && part.length <= 4_096 && !part.includes("\u0000"));
  }
  if (!isRecord(entry)) return false;
  return Array.isArray(entry.argv_prefix) && entry.argv_prefix.length > 0 && entry.argv_prefix.length <= 32
    && entry.argv_prefix.every((part) => typeof part === "string" && part.length > 0 && part.length <= 4_096 && !part.includes("\u0000"))
    && nonEmpty(entry.purpose) && (entry.purpose as string).length <= 4_096;
}

/** ADR-119 O3: a durable per-node record of an intent entry bound to a literal argv. */
function isBoundScopeIntentList(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<number>();
  for (const entry of value) {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.intent_index) || (entry.intent_index as number) < 0 || seen.has(entry.intent_index as number)) return false;
    seen.add(entry.intent_index as number);
    // Token bounds match `isCommandArgvEntry` above deliberately: a bound
    // intent is promoted back into LITERAL command authority by
    // `bindNativeHighRiskScope`, so this load-path validator is the guard for
    // exactly that promotion. A looser check here than on the declaration it
    // came from would let a tampered snapshot widen authority past what the
    // declaration validator would ever have admitted.
    if (!Array.isArray(entry.argv_prefix) || entry.argv_prefix.length === 0 || entry.argv_prefix.length > 32 || !entry.argv_prefix.every(isArgvToken)) return false;
    if (!nonEmpty(entry.purpose) || (entry.purpose as string).length > 4_096) return false;
    if (!Array.isArray(entry.bound_argv) || entry.bound_argv.length === 0 || entry.bound_argv.length > 32 || !entry.bound_argv.every(isArgvToken)) return false;
    if (typeof entry.bound_at !== "string" || Number.isNaN(Date.parse(entry.bound_at))) return false;
    if (!nonEmpty(entry.session_id)) return false;
  }
  return true;
}

function isNodeOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const kind = value.kind;
  if (typeof kind !== "string" || !(OUTCOME_KINDS as readonly string[]).includes(kind)) return false;
  if (kind === "verdict") return typeof value.approved === "boolean" && nonEmpty(value.message) && isProvenance(value.provenance);
  if (kind === "interrupted") return nonEmpty(value.operation_id) && (value.scope === "node" || value.scope === "subtree")
    && nonEmpty(value.message) && isProvenance(value.provenance) && Array.isArray(value.partial_evidence_ids)
    && value.partial_evidence_ids.every(nonEmpty) && new Set(value.partial_evidence_ids).size === value.partial_evidence_ids.length;
  if (kind !== "error" || !isRecord(value.error) || !nonEmpty(value.error.message) || !isProvenance(value.error.provenance)) return false;
  const error = value.error;
  const errorKind = error.kind;
  if (typeof errorKind !== "string" || !(NODE_ERROR_KINDS as readonly string[]).includes(errorKind)) return false;
  if (errorKind === "quota_exceeded") return true;
  // "timeout" carries its own required fields beyond the shared
  // provenance/message envelope — elapsed_ms, partial_output, and usage were
  // previously never checked, so a truncated or hand-tampered timeout record
  // passed replay and was then trusted as a fully-typed NodeError.
  if (errorKind === "timeout") {
    return finiteNumber(error.elapsed_ms) && (error.elapsed_ms as number) >= 0
      && (error.partial_output === null || typeof error.partial_output === "string")
      && isTokenUsageResult(error.usage);
  }
  // A carried remedy must be a complete v2 remedy; a tampered one is rejected, never trusted.
  if (error.remedy !== undefined && (errorKind !== "internal_error" && errorKind !== "policy_refused" || !isRuntimeGateRefusal(error.remedy) || error.remedy.schema_version !== 2)) return false;
  if (errorKind === "transport_error" || errorKind === "internal_error") return typeof error.recoverable === "boolean";
  // ADR-120: the typed refusal code is the payload that survives routing, so it must
  // survive persistence too — without this branch a valid policy_refused outcome falls
  // through to the context_window_exceeded return below and is rejected on save/reload.
  if (errorKind === "policy_refused") return nonEmpty(error.code) && typeof error.recoverable === "boolean";
  return errorKind === "context_window_exceeded" && isRecord(error.signal) && error.signal.kind === "context_overflow"
    && Number.isSafeInteger(error.signal.observed_tokens) && (error.signal.observed_tokens as number) >= 0
    && Number.isSafeInteger(error.signal.context_limit) && (error.signal.context_limit as number) >= 0 && nonEmpty(error.signal.message);
}

/** TokenUsageResult = TokenUsage | { kind: "unavailable"; reason: string } (token-economy.ts). */
function isTokenUsageResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "unavailable") return nonEmpty(value.reason);
  if (value.kind !== undefined) return false;
  return finiteNumber(value.input_tokens) && (value.input_tokens as number) >= 0
    && finiteNumber(value.output_tokens) && (value.output_tokens as number) >= 0
    && finiteNumber(value.cached_input_tokens) && (value.cached_input_tokens as number) >= 0
    && finiteNumber(value.cache_write_input_tokens) && (value.cache_write_input_tokens as number) >= 0
    && (value.counter_source === "provider_counter" || value.counter_source === "character_fallback");
}

function isProvenance(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.tag === "verified") return nonEmpty(value.cmd) && value.exit === 0 && nonEmpty(value.stdout_hash)
    && (value.check === undefined || isVerificationCheck(value.check))
    // E-4: additive, optional verification-strength typing.
    && (value.strength === undefined || value.strength === "command_executed" || value.strength === "outputs_check");
  if (value.tag === "claimed") return nonEmpty(value.claimant);
  if (value.tag === "critic_approved") return nonEmpty(value.critic) && nonEmpty(value.rationale);
  return value.tag === "generated" && nonEmpty(value.generator) && nonEmpty(value.input_hash);
}

/** A persisted verdict is complete evidence, not a UI-shaped partial summary. */
const REWARD_SOURCES = new Set(["verified_terminal", "measured_partial", "calibrated_estimate", "unmeasured"]);
const REWARD_CHANNELS = new Set(["terminal", "graded", "estimate"]);
const REWARD_COMPONENT_SOURCES = new Set(["verified_terminal", "verification_stage_fraction", "critic_confidence"]);
const PROVENANCE_TAGS = new Set(["verified", "claimed", "critic_approved", "generated"]);

function unitNumber(value: unknown): value is number {
  return finiteNumber(value) && value >= 0 && value <= 1;
}

/** Shape check for a persisted ADR-185 `BackedUpReward`; a corrupt record fails the load rather than being trusted by replay. */
function isBackedUpReward(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!unitNumber(value.value) || typeof value.measured !== "boolean") return false;
  if (typeof value.source !== "string" || !REWARD_SOURCES.has(value.source)) return false;
  if (value.provenance_tag !== null && (typeof value.provenance_tag !== "string" || !PROVENANCE_TAGS.has(value.provenance_tag))) return false;
  if (!Array.isArray(value.components)) return false;
  return value.components.every((component) =>
    isRecord(component)
    && typeof component.channel === "string" && REWARD_CHANNELS.has(component.channel)
    && typeof component.source === "string" && REWARD_COMPONENT_SOURCES.has(component.source)
    && unitNumber(component.raw) && unitNumber(component.weight) && unitNumber(component.contribution)
    && typeof component.provenance_tag === "string" && PROVENANCE_TAGS.has(component.provenance_tag)
    && (component.calibration_id === null || typeof component.calibration_id === "string"));
}

function isCriticVerdict(value: unknown): boolean {
  if (!isRecord(value) || typeof value.approved !== "boolean" || !nonEmpty(value.critic) || !nonEmpty(value.rationale)
    || typeof value.measurement_validated !== "boolean" || typeof value.guardrails_enforced !== "boolean"
    || typeof value.introspection_passed !== "boolean" || typeof value.stability_ok !== "boolean" || !Array.isArray(value.checks)
    // X-2: the five-point mandate is always present; `completeness` is an
    // optional sixth check a critic may additionally report (see
    // `CriticCheck` in types.ts and `manager.ts`'s `assertCriticVerdict`,
    // which admits the identical 5-or-6 range at the write boundary this
    // validator must accept back on read).
    || value.checks.length < 5 || value.checks.length > 6) return false;
  if (value.approved === false && !nonEmpty(value.root_cause)) return false;
  if (value.root_cause !== undefined && typeof value.root_cause !== "string") return false;
  // E-3: additive, optional confidence + its source. A malformed or
  // out-of-range confidence fails the whole verdict closed here (persistence
  // is a stricter boundary than the live parser's graceful-drop tolerance,
  // since a corrupt-on-disk value is otherwise indistinguishable from a
  // deliberately recorded one).
  if (value.confidence !== undefined && (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)) return false;
  if (value.confidence_source !== undefined && value.confidence_source !== "logprobs" && value.confidence_source !== "self_report") return false;
  if ((value.confidence === undefined) !== (value.confidence_source === undefined)) return false;
  const required = new Set(["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"]);
  const allowed = new Set([...required, "completeness"]);
  const seen = new Set<string>();
  for (const rawCheck of value.checks) {
    if (!isRecord(rawCheck) || typeof rawCheck.name !== "string" || !allowed.has(rawCheck.name) || seen.has(rawCheck.name)
      || typeof rawCheck.passed !== "boolean" || !nonEmpty(rawCheck.detail)) return false;
    seen.add(rawCheck.name);
  }
  return [...required].every((name) => seen.has(name));
}

/** A captured pre-critic-dispatch candidate; see `CandidateArtifact`. */
function isCandidateArtifact(value: unknown): boolean {
  if (!isRecord(value) || !nonEmpty(value.specialist_output) || !nonEmpty(value.specialist_agent)
    || !nonEmpty(value.captured_at) || !isProvenance(value.provenance)) return false;
  if (typeof value.review_status !== "string"
    || !["not_dispatched", "dispatched", "awaiting_review", "resolved"].includes(value.review_status)) return false;
  // Q4: token_usage is optional (absent on candidates captured before it
  // existed) but when present is itself a closed union (TokenUsageResult)
  // that was previously never checked.
  return value.token_usage === undefined || isTokenUsageResult(value.token_usage);
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

/** GateRecord's `gate`/`result` are closed discriminants; see types.ts's GateType. */
function isGateRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.gate !== "admission" && value.gate !== "isolation" && value.gate !== "evidence" && value.gate !== "audit") return false;
  if (value.result !== "pass" && value.result !== "fail" && value.result !== "bypass") return false;
  if (!nonEmpty(value.checked_at) || typeof value.detail !== "string") return false;
  return value.bypass_evidence_deficit === undefined || typeof value.bypass_evidence_deficit === "string";
}

/** B2 (item 3): a durable `campaign.run` job-failure diagnostic; see `CampaignState.run_diagnostic`. */
function isRunDiagnostic(value: unknown): boolean {
  if (!isRecord(value) || !nonEmpty(value.message) || !nonEmpty(value.recorded_at)) return false;
  return value.stack_head === undefined || typeof value.stack_head === "string";
}

/** Move abandoned write temps aside without deleting potentially useful evidence. */
export function reconcileCampaignTemporaryFiles(dir: string, campaignId: string): PersistenceDiagnostic[] {
  assertValidCampaignId(campaignId);
  const treeDir = join(dir, "tree");
  if (!existsSync(treeDir)) return [];
  const prefix = `.${campaignId}.`;
  return readdirSync(treeDir)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".tmp"))
    .map((file) => quarantinePersistenceFile(join(treeDir, file), dir, "temporary_file", "invalid_shape", "abandoned campaign write temporary file"));
}

/**
 * WA-38: write+fsync a temp file, rename it onto `path`, then fsync the
 * parent directory — the same crash-safe recipe as the canonical primitive
 * in `packages/arbor-audit/src/atomic-write.ts` (`atomicOverwriteFile`).
 * Duplicated here (~15 lines) rather than imported: `@arbor/audit` already
 * depends on `@arbor/core` (see arbor-audit/package.json), so importing it
 * back from here would invert that dependency direction. If the recipe ever
 * changes, update both call sites — atomic-write.ts's own header comment
 * explains the write-temp/fsync/rename/fsync-dir reasoning in full.
 *
 * Windows exception (matches arbor-kb/src/persist.ts's `atomicWrite`,
 * documented there in full): Node's fsync on a directory handle rejects
 * with EPERM on Windows, which does not expose directory handles the same
 * way POSIX does. The temp file is already fsynced before the rename, and
 * `renameSync` is the atomic publication boundary there, so the directory
 * fsync is skipped rather than made a hard failure on that platform only.
 */
function atomicWriteWithFsync(path: string, temporary: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  writeFileSync(temporary, contents);
  const fileDescriptor = openSync(temporary, "r+");
  try {
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  renameSync(temporary, path);
  if (process.platform !== "win32") {
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}

export function saveCampaign(state: CampaignState, dir: string): void {
  assertValidCampaignId(state.id);
  const treeDir = join(dir, "tree");
  mkdirSync(treeDir, { recursive: true });

  const serializable: Record<string, unknown> = {
    id: state.id,
    plan_path: state.plan_path,
    config: state.config,
    root_id: state.root_id,
    started_at: state.started_at,
    iterations_completed: state.iterations_completed,
    iterations_without_kb_entry: state.iterations_without_kb_entry,
    best_score: state.best_score,
    halted: state.halted,
    halt_reason: state.halt_reason,
    nodes: Array.from(state.tree.values()) as TreeNode[],
  };
  // Omitted (not an empty array) when there is nothing deferred, so a
  // campaign that never used depends_on round-trips as a legacy (version 1)
  // snapshot rather than gaining a spurious version-2 field.
  if (state.deferredActions && state.deferredActions.length > 0) {
    serializable.deferred_actions = state.deferredActions.map((entry) => ({ action: entry.action, depends_on: entry.depends_on }));
  }
  // B2 (item 3): omitted entirely when there has never been a failed run, so
  // a campaign that never failed round-trips with no spurious field either.
  if (state.run_diagnostic !== undefined) {
    serializable.run_diagnostic = state.run_diagnostic;
  }
  // ADR-062: the governance decision (including this tranche's E-2
  // `turn_budget_estimate`) was validated on LOAD but never actually
  // written here -- a pre-existing gap this additive fix closes so a
  // campaign's governance tier survives a process restart instead of
  // silently vanishing on the very first save.
  if (state.governance !== undefined) {
    serializable.governance = state.governance;
  }
  const target = join(treeDir, `${state.id}.json`);
  // The dot-prefixed `.${id}.${pid}.tmp` name matches
  // `reconcileCampaignTemporaryFiles`'s abandoned-write-temp scan above —
  // changing this shape would make an interrupted save invisible to it.
  const temporary = join(treeDir, `.${state.id}.${process.pid}.tmp`);
  // WA-38: fsync the temp file before rename and the parent directory after
  // (atomicWriteWithFsync above) so the write is durable across a crash, not
  // just atomic with respect to concurrent readers.
  atomicWriteWithFsync(target, temporary, JSON.stringify(serializable, null, 2));
}

/** Load a campaign without treating corrupt data as a missing campaign. */
export function loadCampaignResult(campaignId: string, dir: string): PersistenceLoadResult<CampaignState> {
  assertValidCampaignId(campaignId);
  const filePath = join(dir, "tree", `${campaignId}.json`);
  const diagnostics = reconcileCampaignTemporaryFiles(dir, campaignId);
  if (!existsSync(filePath)) return { value: null, diagnostics };
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return { value: validateCampaignSnapshot(raw, campaignId), diagnostics };
  } catch (error) {
    const message = error instanceof SyntaxError ? "campaign snapshot is not valid JSON" : `campaign snapshot failed validation: ${error instanceof Error ? error.message : String(error)}`;
    const code: PersistenceDiagnosticCode = error instanceof SyntaxError ? "invalid_json" : error instanceof Error && error.message.startsWith("snapshot id") ? "identity_mismatch" : "invalid_shape";
    diagnostics.push(quarantinePersistenceFile(filePath, dir, "campaign_snapshot", code, message));
    return { value: null, diagnostics };
  }
}

export function listCampaigns(dir: string): string[] {
  const treeDir = join(dir, "tree");
  if (!existsSync(treeDir)) return [];
  return readdirSync(treeDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}
