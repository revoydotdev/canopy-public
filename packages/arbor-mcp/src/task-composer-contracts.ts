import { createHash } from "node:crypto";
import type { AcceptanceCheckAssignment, Action, ArbiterDecision, GovernanceTier, TokenUsageResult } from "@arbor/core";
import { NATIVE_ROLE_PROFILES, type NativeRoleProfileId } from "@arbor/prompts";

/** Closed, transport-neutral authority surface for pre-campaign task composition. */
export type TaskComposerSource = "cli" | "tui" | "web" | "ide";
export type TaskComposerStatus = "planning" | "awaiting_clarification" | "proposed" | "rejected" | "cancelled" | "admitted" | "failed" | "answered";
export type TaskComposerMode = "execute" | "answer";
export interface TaskComposerReferenceAnswer {
  readonly text: string;
  readonly provenance: { readonly tag: "claimed"; readonly claimant: "native-reference-answer" };
}

export interface TaskAttachmentUpload { readonly display_name: string; readonly content_base64: string; }
export interface TaskAttachmentRef {
  readonly attachment_id: string;
  readonly sha256: string;
  readonly media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "text/plain" | "text/markdown" | "application/json";
  readonly byte_length: number;
  readonly display_name: string;
  readonly provenance: { readonly tag: "claimed"; readonly claimant: string };
}

/**
 * WA-32/J3-20: the structured command handoff a governed `arbor command
 * <name>` invocation hands to `taskcomposer.submit`, replacing the prior
 * free-text `[governed-command:...]` prefix nothing parsed
 * (`command-catalog.ts`'s `UserCommand`/`invokeUserCommand` remain the
 * source of truth for these fields; this is their typed transport). `null`
 * only for a submission with no invoking command (the ordinary operator
 * task path).
 */
export interface TaskComposerCommandBinding {
  readonly name: string;
  readonly execution_role: NativeRoleProfileId;
  readonly allowed_tools: readonly string[];
  readonly skill_id: string | null;
  readonly skill_version?: string;
  readonly skill_inputs?: Readonly<Record<string, string>>;
  readonly skill_inputs_hash?: string;
  readonly descriptor_hash?: string;
}

export interface TaskComposerQuestion { readonly id: string; readonly question: string; readonly answer: string | null; }
/** Immutable operator answer retained independently of a planner's next proposal shape. */
export interface TaskComposerAnsweredQuestion {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly answered_by: "operator";
  readonly answered_at: string;
}
export interface TaskComposerProposal {
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly questions: readonly TaskComposerQuestion[];
  readonly root_action: Action;
  readonly actions: readonly Action[];
  readonly acceptance_checks: readonly string[];
  /** Omitted only by a legacy proposal with no acceptance criteria to materialize. */
  readonly acceptance_mapping?: readonly AcceptanceCheckAssignment[];
  readonly risk_notes: readonly string[];
}
export interface TaskComposerPlannerProjection {
  readonly kind: "native" | "unavailable" | "cancelled" | "failed";
  readonly session_id: string | null;
  readonly model_identity: string | null;
  readonly error: string | null;
  /** Token cost of every planner call issued for this draft so far, accumulated across attempts. */
  readonly usage: TokenUsageResult;
}
export interface TaskComposerGuidance {
  readonly kind: "working" | "question" | "ready" | "started" | "stopped" | "recovery";
  readonly headline: string;
  readonly detail: string;
  readonly recommendation: string;
  readonly retryable: boolean;
}
export interface TaskComposerDraft {
  /** Absent only on legacy execution drafts. Immutable across retries. */
  readonly mode?: TaskComposerMode;
  readonly reference_answer?: TaskComposerReferenceAnswer | null;
  readonly id: string;
  readonly revision: number;
  readonly status: TaskComposerStatus;
  readonly task: string;
  readonly source: TaskComposerSource;
  readonly parent_campaign_id: string | null;
  readonly evidence_ids: readonly string[];
  /** Immutable media captured before planning. Optional only for pre-feature persisted drafts. */
  readonly attachments?: readonly TaskAttachmentRef[];
  /** WA-32/J3-20: the invoking `arbor command`'s structured role/tools/skill request, when this submission came from one. */
  readonly command?: TaskComposerCommandBinding;
  readonly proposal: TaskComposerProposal | null;
  /** Durable interview history; optional only for stores written before this field existed. */
  readonly answered_questions?: readonly TaskComposerAnsweredQuestion[];
  readonly planner: TaskComposerPlannerProjection;
  /**
   * ADR-062: the governance-tier decision made at submit time — the
   * arbiter's own cheap classification, or an operator `--tier` override.
   * Null only for a draft persisted before ADR-062 existed, or one whose
   * `submit` never reached classification (e.g. idempotent replay of a
   * pre-ADR-062 record).
   */
  readonly arbiter_decision: ArbiterDecision | null;
  readonly campaign_id: string | null;
  readonly job_id: string | null;
  readonly rejection_reason: string | null;
  /** True when the operator's plain-language request authorizes admission as soon as its governed plan is ready. */
  readonly auto_confirm?: boolean;
  /** Human-facing narration derived from canonical state; never execution authority. */
  readonly guidance?: TaskComposerGuidance;
  readonly created_at: string;
  readonly updated_at: string;
}

export type TaskComposerCommand =
  | { readonly kind: "taskcomposer.submit"; readonly task: string; readonly source: TaskComposerSource; readonly idempotency_key: string; readonly mode?: TaskComposerMode; readonly parent_campaign_id?: string; readonly evidence_ids?: readonly string[]; readonly attachment_uploads?: readonly TaskAttachmentUpload[]; readonly tier_override?: GovernanceTier; readonly auto_confirm?: boolean; readonly command?: TaskComposerCommandBinding }
  | { readonly kind: "taskcomposer.answer"; readonly draft_id: string; readonly expected_revision: number; readonly question_id: string; readonly answer: string }
  | { readonly kind: "taskcomposer.confirm"; readonly draft_id: string; readonly expected_revision: number; readonly idempotency_key: string }
  | { readonly kind: "taskcomposer.cancel"; readonly draft_id: string; readonly expected_revision: number; readonly reason: string }
  | { readonly kind: "taskcomposer.retry"; readonly draft_id: string; readonly expected_revision: number; readonly idempotency_key: string }
  | { readonly kind: "taskcomposer.reject"; readonly draft_id: string; readonly expected_revision: number; readonly reason: string };

export type TaskComposerQuery =
  | { readonly kind: "taskcomposer.get"; readonly draft_id: string }
  | { readonly kind: "taskcomposer.list"; readonly limit: number; readonly cursor?: string; readonly parent_campaign_id?: string };

export interface TaskComposerCommandEnvelope { readonly command_id: string; readonly command: TaskComposerCommand; }
export interface TaskComposerQueryEnvelope { readonly query_id: string; readonly query: TaskComposerQuery; }

export type TaskComposerValidation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const SOURCES = new Set<TaskComposerSource>(["cli", "tui", "web", "ide"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TEXT = 16_384;

export function validateTaskComposerCommand(value: unknown): TaskComposerValidation<TaskComposerCommand> {
  if (!record(value) || !text(value.kind)) return invalid("command must be an object with kind");
  switch (value.kind) {
    case "taskcomposer.submit": {
      if (value.mode !== undefined && value.mode !== "execute" && value.mode !== "answer") return invalid("submit mode must be execute or answer");
      if (value.mode === "answer" && (value.command !== undefined || value.tier_override !== undefined)) return invalid("reference answers cannot carry execution commands or governance-tier overrides");
      if (!(text(value.task) && value.task.length <= MAX_TEXT && SOURCES.has(value.source as TaskComposerSource) && id(value.idempotency_key)
        && optionalId(value.parent_campaign_id) && stringList(value.evidence_ids, 64, 256) && attachmentUploads(value.attachment_uploads) && optionalTier(value.tier_override) && (value.auto_confirm === undefined || typeof value.auto_confirm === "boolean")))
        return invalid("submit requires bounded task, source, idempotency_key, valid optional linkage, and a valid optional tier_override");
      const command = validateCommandBinding(value.command);
      if (!command.ok) return command;
      return valid({ kind: value.kind, task: value.task, source: value.source as TaskComposerSource, idempotency_key: value.idempotency_key, ...(value.mode === undefined ? {} : { mode: value.mode }), ...(value.parent_campaign_id === undefined ? {} : { parent_campaign_id: value.parent_campaign_id }), ...(value.evidence_ids === undefined ? {} : { evidence_ids: [...value.evidence_ids] }), ...(value.attachment_uploads === undefined ? {} : { attachment_uploads: value.attachment_uploads.map((item) => ({ display_name: item.display_name, content_base64: item.content_base64 })) }), ...(value.tier_override === undefined ? {} : { tier_override: value.tier_override as GovernanceTier }), ...(value.auto_confirm === undefined ? {} : { auto_confirm: value.auto_confirm }), ...(command.value === undefined ? {} : { command: command.value }) });
    }
    case "taskcomposer.answer":
      return id(value.draft_id) && revision(value.expected_revision) && id(value.question_id) && text(value.answer) && value.answer.length <= MAX_TEXT
        ? valid({ kind: value.kind, draft_id: value.draft_id, expected_revision: value.expected_revision, question_id: value.question_id, answer: value.answer }) : invalid("answer requires draft_id, revision, question_id, and bounded answer");
    case "taskcomposer.confirm":
      return id(value.draft_id) && revision(value.expected_revision) && id(value.idempotency_key)
        ? valid({ kind: value.kind, draft_id: value.draft_id, expected_revision: value.expected_revision, idempotency_key: value.idempotency_key }) : invalid("confirm requires draft_id, revision, and idempotency_key");
    case "taskcomposer.cancel":
      return id(value.draft_id) && revision(value.expected_revision) && text(value.reason) && value.reason.length <= MAX_TEXT
        ? valid({ kind: value.kind, draft_id: value.draft_id, expected_revision: value.expected_revision, reason: value.reason }) : invalid("cancel requires draft_id, revision, and bounded reason");
    case "taskcomposer.retry":
      return id(value.draft_id) && revision(value.expected_revision) && id(value.idempotency_key)
        ? valid({ kind: value.kind, draft_id: value.draft_id, expected_revision: value.expected_revision, idempotency_key: value.idempotency_key }) : invalid("retry requires draft_id, revision, and idempotency_key");
    case "taskcomposer.reject":
      return id(value.draft_id) && revision(value.expected_revision) && text(value.reason) && value.reason.length <= 4_096
        ? valid({ kind: value.kind, draft_id: value.draft_id, expected_revision: value.expected_revision, reason: value.reason }) : invalid("reject requires draft_id, revision, and bounded reason");
    default: return invalid(`unsupported task composer command ${JSON.stringify(value.kind)}`);
  }
}

export function validateTaskComposerQuery(value: unknown): TaskComposerValidation<TaskComposerQuery> {
  if (!record(value) || !text(value.kind)) return invalid("query must be an object with kind");
  if (value.kind === "taskcomposer.get") return id(value.draft_id) ? valid({ kind: value.kind, draft_id: value.draft_id }) : invalid("get requires draft_id");
  if (value.kind === "taskcomposer.list") return Number.isSafeInteger(value.limit) && value.limit > 0 && value.limit <= 100 && (value.cursor === undefined || id(value.cursor)) && optionalId(value.parent_campaign_id)
    ? valid({ kind: value.kind, limit: value.limit, ...(value.cursor === undefined ? {} : { cursor: value.cursor }), ...(value.parent_campaign_id === undefined ? {} : { parent_campaign_id: value.parent_campaign_id }) }) : invalid("list requires limit 1..100 and valid optional cursor/linkage");
  return invalid(`unsupported task composer query ${JSON.stringify(value.kind)}`);
}

/** Parse one unambiguous JSON object, tolerating provider fences or bounded prose. */
export function parseTaskComposerProposal(raw: string): TaskComposerValidation<TaskComposerProposal> {
  let value: unknown;
  try { value = JSON.parse(raw.trim()); }
  catch {
    const objects = balancedJsonObjects(raw);
    if (objects.length !== 1) return invalid("planner output does not contain exactly one JSON object");
    try { value = JSON.parse(objects[0]!); } catch { return invalid("planner output does not contain exactly one JSON object"); }
  }
  return validateTaskComposerProposal(value);
}

function balancedJsonObjects(raw: string): string[] {
  const objects: string[] = [];
  let start = -1; let depth = 0; let quoted = false; let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"' && depth > 0) { quoted = true; continue; }
    if (char === "{") { if (depth === 0) start = index; depth += 1; continue; }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) { objects.push(raw.slice(start, index + 1)); start = -1; }
    }
  }
  return depth === 0 && !quoted ? objects : [];
}

export function validateTaskComposerProposal(value: unknown): TaskComposerValidation<TaskComposerProposal> {
  const required = ["summary", "assumptions", "questions", "root_action", "actions", "acceptance_checks", "risk_notes"];
  const allowed = [...required, "acceptance_mapping"];
  if (!record(value) || !Object.keys(value).every((key) => allowed.includes(key)) || !required.every((key) => key in value)) return invalid("proposal has unsupported or missing fields");
  if (!boundedText(value.summary, 4_096) || !stringList(value.assumptions, 32, 4_096) || !stringList(value.acceptance_checks, 32, 4_096) || !stringList(value.risk_notes, 32, 4_096)) return invalid("proposal text fields are invalid");
  const acceptanceChecks = value.acceptance_checks as string[];
  if (new Set(acceptanceChecks).size !== acceptanceChecks.length) return invalid("acceptance checks must be unique");
  const questions = validateQuestions(value.questions); if (!questions.ok) return questions;
  const root = validateAction(value.root_action); if (!root.ok) return root;
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 32) return invalid("proposal requires 1 through 32 actions");
  const actions: Action[] = [];
  for (const action of value.actions) { const parsed = validateAction(action); if (!parsed.ok) return parsed; actions.push(parsed.value); }
  const mapping = validateAcceptanceMapping(value.acceptance_mapping, acceptanceChecks, actions); if (!mapping.ok) return mapping;
  return valid(Object.freeze({ summary: value.summary, assumptions: [...(value.assumptions ?? [])], questions: questions.value, root_action: root.value, actions, acceptance_checks: [...acceptanceChecks], ...(mapping.value === undefined ? {} : { acceptance_mapping: mapping.value }), risk_notes: [...(value.risk_notes ?? [])] }));
}

function validateAcceptanceMapping(value: unknown, checks: readonly string[], actions: readonly Action[]): TaskComposerValidation<readonly AcceptanceCheckAssignment[] | undefined> {
  // Older persisted proposals had no mapping field. They remain readable only
  // when there is no stated criterion that could be silently dropped; admission
  // rejects a non-empty unmapped set before it can create a campaign.
  if (value === undefined) return valid(undefined);
  if (!Array.isArray(value) || value.length !== checks.length) return invalid("acceptance mapping must contain exactly one assignment for every acceptance check");
  const actionDescriptions = new Set(actions.map((action) => action.description));
  if (actionDescriptions.size !== actions.length) return invalid("acceptance mapping requires unique action descriptions");
  const expected = new Set(checks); const seen = new Set<string>(); const mappings: AcceptanceCheckAssignment[] = [];
  for (const item of value) {
    if (!record(item) || !closedKeys(item, ["criterion", "action_descriptions"]) || !boundedText(item.criterion, 4_096)
      || !Array.isArray(item.action_descriptions) || item.action_descriptions.length === 0 || item.action_descriptions.length > 32
      || !item.action_descriptions.every((description) => boundedText(description, 4_096))
      || new Set(item.action_descriptions).size !== item.action_descriptions.length
      || !expected.has(item.criterion) || seen.has(item.criterion)
      || !item.action_descriptions.every((description) => actionDescriptions.has(description))) return invalid("acceptance mapping must assign each known criterion to one or more exact action descriptions");
    seen.add(item.criterion);
    mappings.push(Object.freeze({ criterion: item.criterion, action_descriptions: Object.freeze([...item.action_descriptions]) }));
  }
  return seen.size === expected.size ? valid(Object.freeze(mappings)) : invalid("acceptance mapping omits a stated acceptance check");
}

function validateQuestions(value: unknown): TaskComposerValidation<readonly TaskComposerQuestion[]> {
  if (!Array.isArray(value) || value.length > 8) return invalid("questions must contain at most 8 items");
  const seen = new Set<string>(); const questions: TaskComposerQuestion[] = [];
  for (const item of value) {
    if (!record(item) || !closedKeys(item, ["id", "question"]) || !id(item.id) || !boundedText(item.question, 2_048) || seen.has(item.id)) return invalid("questions require unique IDs and bounded text");
    seen.add(item.id); questions.push(Object.freeze({ id: item.id, question: item.question, answer: null }));
  }
  return valid(Object.freeze(questions));
}
function validateAction(value: unknown): TaskComposerValidation<Action> {
  if (!record(value) || !Object.keys(value).every((key) => ["description", "estimated_gain", "estimated_cost", "category", "delegate_to", "constraints", "execution_role", "skill_id", "skill_version", "high_risk_tool_scope", "decomposition_depth", "depends_on"].includes(key)) || !["description", "estimated_gain", "estimated_cost", "category", "delegate_to"].every((key) => key in value)) return invalid("action has unsupported or missing fields");
  if (!boundedText(value.description, 4_096) || !finiteNonNegative(value.estimated_gain) || !finiteNonNegative(value.estimated_cost) || !boundedText(value.category, 256) || !boundedText(value.delegate_to, 128)) return invalid("action requires bounded description/category/delegate and non-negative estimates");
  if (value.constraints !== undefined && !stringList(value.constraints, 32, 1_024)) return invalid("action constraints are invalid");
  if (value.execution_role !== undefined && value.execution_role !== "architect" && value.execution_role !== "documentation-writer") return invalid("action execution role is invalid");
  if (!validSkillSelection(value.skill_id, value.skill_version)) return invalid("action skill identity is invalid or incomplete");
  if (value.decomposition_depth !== undefined && (!Number.isSafeInteger(value.decomposition_depth) || value.decomposition_depth < 0 || value.decomposition_depth > 8)) return invalid("action decomposition depth is invalid");
  if (value.high_risk_tool_scope !== undefined && !validHighRiskScope(value.high_risk_tool_scope)) return invalid("action high risk scope is invalid");
  if (value.depends_on !== undefined && !stringList(value.depends_on, 32, 4_096)) return invalid("action depends_on is invalid");
  return valid(Object.freeze({ description: value.description, estimated_gain: value.estimated_gain, estimated_cost: value.estimated_cost, category: value.category, delegate_to: value.delegate_to, ...(value.constraints === undefined ? {} : { constraints: [...value.constraints] }), ...(value.execution_role === undefined ? {} : { execution_role: value.execution_role }), ...(value.skill_id === undefined ? {} : { skill_id: value.skill_id, skill_version: value.skill_version }), ...(value.high_risk_tool_scope === undefined ? {} : { high_risk_tool_scope: { write_paths: [...value.high_risk_tool_scope.write_paths], command_argv: value.high_risk_tool_scope.command_argv.map((entry: string[] | { argv_prefix: string[]; purpose: string }) => Array.isArray(entry) ? [...entry] : { argv_prefix: [...entry.argv_prefix], purpose: entry.purpose }) } }), ...(value.decomposition_depth === undefined ? {} : { decomposition_depth: value.decomposition_depth }), ...(value.depends_on === undefined ? {} : { depends_on: [...value.depends_on] }) }));
}
function validSkillSelection(skillId: unknown, version: unknown): boolean { if (skillId === undefined || version === undefined) return skillId === undefined && version === undefined; return typeof skillId === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(skillId) && typeof version === "string" && version.length <= 128 && SEMVER.test(version); }
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function validHighRiskScope(value: unknown): value is { write_paths: string[]; command_argv: (string[] | { argv_prefix: string[]; purpose: string })[] } {
  return record(value) && closedKeys(value, ["write_paths", "command_argv"]) && stringList(value.write_paths, 32, 512) && Array.isArray(value.command_argv) && value.command_argv.length <= 32 && value.command_argv.every((entry) => validCommandArgvEntry(entry));
}
/** ADR-119: a `command_argv` entry is either a literal argv array, or an intent (`argv_prefix`+`purpose`) entry available only at direct/reviewed tier -- tier enforcement happens at derivation time (`CampaignManager.deriveNativeHighRiskToolScope`), not here. */
function validCommandArgvEntry(entry: unknown): entry is string[] | { argv_prefix: string[]; purpose: string } {
  if (Array.isArray(entry)) return entry.length > 0 && entry.length <= 32 && entry.every((part) => boundedText(part, 512));
  return record(entry) && closedKeys(entry, ["argv_prefix", "purpose"]) && stringList(entry.argv_prefix, 32, 512) && Array.isArray(entry.argv_prefix) && entry.argv_prefix.length > 0 && boundedText(entry.purpose, 4_096);
}
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function closedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.every((key) => keys.includes(key)) && keys.every((key) => key in value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function boundedText(value: unknown, max: number): value is string { return text(value) && value.length <= max; }
function id(value: unknown): value is string { return typeof value === "string" && SAFE_ID.test(value); }
function optionalId(value: unknown): boolean { return value === undefined || id(value); }
function optionalTier(value: unknown): boolean { return value === undefined || value === "direct" || value === "reviewed" || value === "governed"; }
/** WA-32/J3-20: validates the optional structured `command` handoff on `taskcomposer.submit`. */
function validateCommandBinding(value: unknown): TaskComposerValidation<TaskComposerCommandBinding | undefined> {
  if (value === undefined) return valid(undefined);
  if (!record(value) || !Object.keys(value).every((key) => ["name", "execution_role", "allowed_tools", "skill_id", "skill_version", "skill_inputs", "skill_inputs_hash", "descriptor_hash"].includes(key)) || !["name", "execution_role", "allowed_tools", "skill_id"].every((key) => key in value)) return invalid("command binding has unsupported or missing fields");
  if (!id(value.name)) return invalid("command binding name is invalid");
  if (typeof value.execution_role !== "string" || !Object.prototype.hasOwnProperty.call(NATIVE_ROLE_PROFILES, value.execution_role)) return invalid("command binding execution_role is unknown");
  if (!stringList(value.allowed_tools, 64, 128) || value.allowed_tools === undefined) return invalid("command binding allowed_tools is invalid");
  if (value.skill_id !== null && !id(value.skill_id)) return invalid("command binding skill_id must be null or a valid identifier");
  if (value.skill_version !== undefined && (typeof value.skill_version !== "string" || !SEMVER.test(value.skill_version))) return invalid("command binding skill_version must be exact SemVer");
  if ((value.skill_version !== undefined) !== (value.skill_id !== null)) return invalid("command binding skill id and version must be paired");
  if (value.skill_inputs !== undefined && (!record(value.skill_inputs) || Object.keys(value.skill_inputs).length === 0 || Object.keys(value.skill_inputs).length > 16 || Object.entries(value.skill_inputs).some(([name, item]) => !/^[a-z][a-z0-9_]{0,31}$/.test(name) || typeof item !== "string" || Buffer.byteLength(item, "utf8") > 8 * 1024))) return invalid("command binding skill_inputs are invalid or oversized");
  if (value.skill_inputs !== undefined && (value.skill_id === null || value.skill_version === undefined || typeof value.skill_inputs_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.skill_inputs_hash) || typeof value.descriptor_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.descriptor_hash))) return invalid("command input values require an exact skill and descriptor/input hashes");
  if (value.skill_inputs !== undefined) {
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(value.skill_inputs as Record<string, string>).sort(([left], [right]) => left.localeCompare(right))));
    if (`sha256:${createHash("sha256").update(canonical).digest("hex")}` !== value.skill_inputs_hash) return invalid("command binding input hash does not match supplied values");
  }
  if (value.skill_inputs === undefined && (value.skill_inputs_hash !== undefined || value.descriptor_hash !== undefined)) return invalid("command binding hashes require skill inputs");
  return valid(Object.freeze({ name: value.name, execution_role: value.execution_role as NativeRoleProfileId, allowed_tools: Object.freeze([...(value.allowed_tools as string[])]), skill_id: value.skill_id === null ? null : (value.skill_id as string), ...(value.skill_version === undefined ? {} : { skill_version: value.skill_version as string }), ...(value.skill_inputs === undefined ? {} : { skill_inputs: Object.freeze({ ...(value.skill_inputs as Record<string, string>) }), skill_inputs_hash: value.skill_inputs_hash as string, descriptor_hash: value.descriptor_hash as string }) }));
}
function revision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function finiteNonNegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function stringList(value: unknown, count: number, length: number): value is string[] | undefined { return value === undefined || (Array.isArray(value) && value.length <= count && value.every((item) => boundedText(item, length))); }
function attachmentUploads(value: unknown): value is TaskAttachmentUpload[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length <= 4 && value.every((item) => record(item)
    && closedKeys(item, ["display_name", "content_base64"])
    && safeDisplayName(item.display_name)
    && boundedText(item.content_base64, 6_990_512)));
}
function safeDisplayName(value: unknown): value is string { return boundedText(value, 255) && !value.includes("/") && !value.includes("\\") && [...value].every((character) => character.charCodeAt(0) >= 32); }
function valid<T>(value: T): TaskComposerValidation<T> { return { ok: true, value }; }
function invalid(error: string): TaskComposerValidation<never> { return { ok: false, error }; }
