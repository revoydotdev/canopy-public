/**
 * Command-and-control (C2) contracts: typed commands down, a closed reply
 * palette up (operator decision 7, 2026-10-07).
 *
 * Commands carry a typed envelope per kind plus at most one bounded free-text
 * field. Replies come from a closed union; there is no reply that grants,
 * approves, promotes or verifies anything. The A2A task-state and MCP
 * elicitation shapes are VOCABULARY ONLY (operator decision 1) — nothing here
 * speaks either protocol.
 */
import { isRuntimeGateRefusal, type RuntimeGateRefusalV2, type RuntimeValidationResult } from "../runtime-contracts.js";
import { checkEnum, checkId, checkIdList, checkKeys, checkText, checkTimestamp, isRecord, result, utf8Bytes, type Violations } from "./validate.js";

/**
 * Free-text bounds, in UTF-8 bytes. `task.assign.objective` is the one large
 * semantic field (4 KiB); every other free text is smaller. A command never
 * carries more than one free-text field, so its semantic payload is bounded
 * by the largest of these.
 */
export const C2_TEXT_BOUNDS = Object.freeze({
  objective: 4096,
  acceptance_item: 512,
  instruction: 2048,
  halt_note: 512,
  answer_value: 1024,
  question: 2048,
  blocked_detail: 1024,
  progress_note: 512,
  result_summary: 4096,
  failure_error: 1024,
} as const);

/** Count bounds shared by commands and replies. */
export const C2_COUNT_BOUNDS = Object.freeze({
  acceptance: 16,
  evidence_refs: 32,
  clarify_fields: 8,
  enum_values: 16,
} as const);

export const C2_COMMAND_KINDS = Object.freeze(["task.assign", "task.amend", "task.halt", "status.request", "clarification.answer"] as const);
export type C2CommandKind = (typeof C2_COMMAND_KINDS)[number];

export const C2_HALT_REASONS = Object.freeze(["operator_request", "superseded", "budget", "deadline", "scope"] as const);
export type C2HaltReason = (typeof C2_HALT_REASONS)[number];

/** MCP elicitation's closed response actions, reused as vocabulary. */
export const C2_ANSWER_ACTIONS = Object.freeze(["accept", "decline", "cancel"] as const);
export type C2AnswerAction = (typeof C2_ANSWER_ACTIONS)[number];

export type C2AnswerValue = string | number | boolean;

export type C2Command =
  | { kind: "task.assign"; command_id: string; objective: string; acceptance: readonly string[]; output_contract: "summary" | "patch" | "evidence_refs"; deadline_at?: string }
  | { kind: "task.amend"; command_id: string; instruction: string; supersedes_command_id?: string; deadline_at?: string }
  | { kind: "task.halt"; command_id: string; mode: "graceful" | "immediate"; reason_code: C2HaltReason; note?: string }
  | { kind: "status.request"; command_id: string; deadline_at?: string }
  | { kind: "clarification.answer"; command_id: string; clarification_id: string; action: C2AnswerAction; content?: Readonly<Record<string, C2AnswerValue>> };

export const C2_REPLY_KINDS = Object.freeze(["ack", "decline", "blocked", "clarify", "progress", "done", "failed"] as const);
export type C2ReplyKind = (typeof C2_REPLY_KINDS)[number];

/** A reply after which the command accepts no further reply. */
export const C2_TERMINAL_REPLY_KINDS: ReadonlySet<C2ReplyKind> = new Set<C2ReplyKind>(["decline", "done", "failed"]);

export const C2_BLOCKED_NEEDS = Object.freeze(["input", "authority", "resource", "dependency"] as const);
export const C2_PROGRESS_PHASES = Object.freeze(["investigating", "editing", "verifying"] as const);
export const C2_FAILURE_CLASSES = Object.freeze(["tool_error", "verification_failed", "out_of_scope", "budget_exhausted", "deadline_exceeded", "internal"] as const);

/**
 * The MCP-elicitation subset a `clarify` may ask for: a flat object of
 * primitive or enum fields. No nesting, no arrays.
 */
export type C2ClarifyField =
  | { type: "string"; description?: string }
  | { type: "number"; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "enum"; values: readonly string[]; description?: string };

export interface C2ClarifySchema {
  fields: Readonly<Record<string, C2ClarifyField>>;
  required: readonly string[];
}

export type C2Reply =
  | { kind: "ack"; command_id: string }
  | { kind: "decline"; command_id: string; remedy: RuntimeGateRefusalV2 }
  | { kind: "blocked"; command_id: string; needs: (typeof C2_BLOCKED_NEEDS)[number]; detail: string }
  | { kind: "clarify"; command_id: string; clarification_id: string; question: string; schema: C2ClarifySchema }
  | { kind: "progress"; command_id: string; phase: (typeof C2_PROGRESS_PHASES)[number]; note?: string }
  | { kind: "done"; command_id: string; result_summary: string; evidence_refs: readonly string[]; provenance: { tag: "claimed"; claimant: string } }
  | { kind: "failed"; command_id: string; failure_class: (typeof C2_FAILURE_CLASSES)[number]; error: string; evidence_refs: readonly string[] };

/**
 * A2A v1.0.0 task-state names for each reply, as vocabulary for export and
 * operator display only. `done` maps to COMPLETED but stays `!claimed`: a
 * completed task is not a verified node.
 */
export const C2_REPLY_A2A_STATE: Readonly<Record<C2ReplyKind, string>> = Object.freeze({
  ack: "TASK_STATE_WORKING",
  decline: "TASK_STATE_REJECTED",
  blocked: "TASK_STATE_INPUT_REQUIRED",
  clarify: "TASK_STATE_INPUT_REQUIRED",
  progress: "TASK_STATE_WORKING",
  done: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
});

export function isTerminalC2Reply(kind: C2ReplyKind): boolean {
  return C2_TERMINAL_REPLY_KINDS.has(kind);
}

function checkOptionalDeadline(value: Record<string, unknown>, path: string, out: Violations): void {
  if (value.deadline_at !== undefined) checkTimestamp(value.deadline_at, `${path}.deadline_at`, out);
}

function checkAnswerContent(value: unknown, path: string, out: Violations): void {
  if (!isRecord(value)) {
    out.push({ path, message: "must be a flat object of string, number or boolean values" });
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > C2_COUNT_BOUNDS.clarify_fields) out.push({ path, message: `must have at most ${C2_COUNT_BOUNDS.clarify_fields} fields` });
  for (const [key, entry] of entries) {
    if (utf8Bytes(key) > 64 || key.length === 0) out.push({ path: `${path}.${key}`, message: "field names must be 1-64 bytes" });
    if (typeof entry === "string") checkText(entry, `${path}.${key}`, C2_TEXT_BOUNDS.answer_value, out, { allowEmpty: true });
    else if (typeof entry === "number") { if (!Number.isFinite(entry)) out.push({ path: `${path}.${key}`, message: "must be a finite number" }); }
    else if (typeof entry !== "boolean") out.push({ path: `${path}.${key}`, message: "must be a string, number or boolean" });
  }
}

/** Validate one C2 command against its kind's closed schema. Unknown kinds and unknown fields are refused. */
export function validateC2Command(value: unknown): RuntimeValidationResult<C2Command> {
  const out: Violations = [];
  const path = "command";
  if (!isRecord(value)) return result<C2Command>(value, [{ path, message: "must be an object" }]);
  checkEnum(value.kind, C2_COMMAND_KINDS, `${path}.kind`, out);
  if (out.length > 0) return result<C2Command>(value, out);
  checkId(value.command_id, `${path}.command_id`, out);
  switch (value.kind as C2CommandKind) {
    case "task.assign":
      checkKeys(value, ["kind", "command_id", "objective", "acceptance", "output_contract"], ["deadline_at"], path, out);
      checkText(value.objective, `${path}.objective`, C2_TEXT_BOUNDS.objective, out);
      if (!Array.isArray(value.acceptance) || value.acceptance.length === 0 || value.acceptance.length > C2_COUNT_BOUNDS.acceptance) {
        out.push({ path: `${path}.acceptance`, message: `must list 1-${C2_COUNT_BOUNDS.acceptance} criteria` });
      } else value.acceptance.forEach((item, index) => checkText(item, `${path}.acceptance[${index}]`, C2_TEXT_BOUNDS.acceptance_item, out));
      checkEnum(value.output_contract, ["summary", "patch", "evidence_refs"], `${path}.output_contract`, out);
      checkOptionalDeadline(value, path, out);
      break;
    case "task.amend":
      checkKeys(value, ["kind", "command_id", "instruction"], ["supersedes_command_id", "deadline_at"], path, out);
      checkText(value.instruction, `${path}.instruction`, C2_TEXT_BOUNDS.instruction, out);
      if (value.supersedes_command_id !== undefined) checkId(value.supersedes_command_id, `${path}.supersedes_command_id`, out);
      checkOptionalDeadline(value, path, out);
      break;
    case "task.halt":
      checkKeys(value, ["kind", "command_id", "mode", "reason_code"], ["note"], path, out);
      checkEnum(value.mode, ["graceful", "immediate"], `${path}.mode`, out);
      checkEnum(value.reason_code, C2_HALT_REASONS, `${path}.reason_code`, out);
      if (value.note !== undefined) checkText(value.note, `${path}.note`, C2_TEXT_BOUNDS.halt_note, out);
      break;
    case "status.request":
      checkKeys(value, ["kind", "command_id"], ["deadline_at"], path, out);
      checkOptionalDeadline(value, path, out);
      break;
    case "clarification.answer":
      checkKeys(value, ["kind", "command_id", "clarification_id", "action"], ["content"], path, out);
      checkId(value.clarification_id, `${path}.clarification_id`, out);
      checkEnum(value.action, C2_ANSWER_ACTIONS, `${path}.action`, out);
      // MCP elicitation: content accompanies `accept` and only `accept`.
      if (value.action === "accept") checkAnswerContent(value.content, `${path}.content`, out);
      else if (value.content !== undefined) out.push({ path: `${path}.content`, message: "is allowed only when action is accept" });
      break;
  }
  return result<C2Command>(value, out);
}

function checkClarifySchema(value: unknown, path: string, out: Violations): void {
  if (!isRecord(value)) {
    out.push({ path, message: "must be an object" });
    return;
  }
  checkKeys(value, ["fields", "required"], [], path, out);
  if (!isRecord(value.fields)) {
    out.push({ path: `${path}.fields`, message: "must be an object" });
    return;
  }
  const names = Object.keys(value.fields);
  if (names.length === 0 || names.length > C2_COUNT_BOUNDS.clarify_fields) out.push({ path: `${path}.fields`, message: `must declare 1-${C2_COUNT_BOUNDS.clarify_fields} fields` });
  for (const name of names) {
    const fieldPath = `${path}.fields.${name}`;
    const field = value.fields[name];
    if (utf8Bytes(name) > 64 || name.length === 0) out.push({ path: fieldPath, message: "field names must be 1-64 bytes" });
    if (!isRecord(field)) { out.push({ path: fieldPath, message: "must be an object" }); continue; }
    checkEnum(field.type, ["string", "number", "boolean", "enum"], `${fieldPath}.type`, out);
    if (field.type === "enum") {
      checkKeys(field, ["type", "values"], ["description"], fieldPath, out);
      if (!Array.isArray(field.values) || field.values.length === 0 || field.values.length > C2_COUNT_BOUNDS.enum_values
        || !field.values.every((entry) => typeof entry === "string" && entry.length > 0 && utf8Bytes(entry) <= 256)
        || new Set(field.values).size !== field.values.length) {
        out.push({ path: `${fieldPath}.values`, message: `must list 1-${C2_COUNT_BOUNDS.enum_values} distinct non-empty strings` });
      }
    } else checkKeys(field, ["type"], ["description"], fieldPath, out);
    if (field.description !== undefined) checkText(field.description, `${fieldPath}.description`, 256, out);
  }
  if (!Array.isArray(value.required) || !value.required.every((entry) => typeof entry === "string" && names.includes(entry))) {
    out.push({ path: `${path}.required`, message: "must list only declared field names" });
  }
}

function checkRemedy(value: unknown, path: string, out: Violations): void {
  // ADR-179 v2 only, and only `refused`: a subordinate declining a command is
  // refusing it, not reporting a missing authority composition.
  if (!isRecord(value) || value.schema_version !== 2 || value.state !== "refused" || !isRuntimeGateRefusal(value)) {
    out.push({ path, message: "must be an ADR-179 v2 refused remedy with an authorized actor/action pair" });
    return;
  }
  checkKeys(value, ["schema_version", "kind", "state", "gate", "correcting_actor", "corrective_action", "code", "summary", "evidence_deficit", "remediation"], [], path, out);
}

/** Validate one reply against the closed palette. Anything outside it is refused. */
export function validateC2Reply(value: unknown): RuntimeValidationResult<C2Reply> {
  const out: Violations = [];
  const path = "reply";
  if (!isRecord(value)) return result<C2Reply>(value, [{ path, message: "must be an object" }]);
  checkEnum(value.kind, C2_REPLY_KINDS, `${path}.kind`, out);
  if (out.length > 0) return result<C2Reply>(value, out);
  checkId(value.command_id, `${path}.command_id`, out);
  switch (value.kind as C2ReplyKind) {
    case "ack":
      checkKeys(value, ["kind", "command_id"], [], path, out);
      break;
    case "decline":
      checkKeys(value, ["kind", "command_id", "remedy"], [], path, out);
      checkRemedy(value.remedy, `${path}.remedy`, out);
      break;
    case "blocked":
      checkKeys(value, ["kind", "command_id", "needs", "detail"], [], path, out);
      checkEnum(value.needs, C2_BLOCKED_NEEDS, `${path}.needs`, out);
      checkText(value.detail, `${path}.detail`, C2_TEXT_BOUNDS.blocked_detail, out);
      break;
    case "clarify":
      checkKeys(value, ["kind", "command_id", "clarification_id", "question", "schema"], [], path, out);
      checkId(value.clarification_id, `${path}.clarification_id`, out);
      checkText(value.question, `${path}.question`, C2_TEXT_BOUNDS.question, out);
      checkClarifySchema(value.schema, `${path}.schema`, out);
      break;
    case "progress":
      checkKeys(value, ["kind", "command_id", "phase"], ["note"], path, out);
      checkEnum(value.phase, C2_PROGRESS_PHASES, `${path}.phase`, out);
      if (value.note !== undefined) checkText(value.note, `${path}.note`, C2_TEXT_BOUNDS.progress_note, out);
      break;
    case "done": {
      checkKeys(value, ["kind", "command_id", "result_summary", "evidence_refs", "provenance"], [], path, out);
      checkText(value.result_summary, `${path}.result_summary`, C2_TEXT_BOUNDS.result_summary, out);
      checkIdList(value.evidence_refs, `${path}.evidence_refs`, C2_COUNT_BOUNDS.evidence_refs, out);
      // A `done` is the subordinate's claim. Only the critic/verifier path
      // verifies a node, so any other provenance tag is refused here.
      const provenance = value.provenance;
      if (!isRecord(provenance) || provenance.tag !== "claimed" || Object.keys(provenance).length !== 2 || typeof provenance.claimant !== "string" || provenance.claimant.trim().length === 0) {
        out.push({ path: `${path}.provenance`, message: "must be exactly { tag: \"claimed\", claimant } — a done reply is never verified" });
      }
      break;
    }
    case "failed":
      checkKeys(value, ["kind", "command_id", "failure_class", "error", "evidence_refs"], [], path, out);
      checkEnum(value.failure_class, C2_FAILURE_CLASSES, `${path}.failure_class`, out);
      checkText(value.error, `${path}.error`, C2_TEXT_BOUNDS.failure_error, out);
      checkIdList(value.evidence_refs, `${path}.evidence_refs`, C2_COUNT_BOUNDS.evidence_refs, out);
      break;
  }
  return result<C2Reply>(value, out);
}

/**
 * True when a `clarification.answer` satisfies the `clarify` it answers:
 * same clarification id; `decline`/`cancel` carry nothing; `accept` supplies
 * every required field, no undeclared field, and each value of its declared type.
 */
export function answerSatisfiesClarify(clarify: Extract<C2Reply, { kind: "clarify" }>, answer: Extract<C2Command, { kind: "clarification.answer" }>): boolean {
  if (answer.clarification_id !== clarify.clarification_id) return false;
  if (answer.action !== "accept") return answer.content === undefined;
  const content = answer.content;
  if (content === undefined) return false;
  const fields = clarify.schema.fields;
  if (!clarify.schema.required.every((name) => Object.prototype.hasOwnProperty.call(content, name))) return false;
  return Object.entries(content).every(([name, entry]) => {
    if (!Object.prototype.hasOwnProperty.call(fields, name)) return false;
    const field = fields[name];
    switch (field.type) {
      case "string": return typeof entry === "string";
      case "number": return typeof entry === "number" && Number.isFinite(entry);
      case "boolean": return typeof entry === "boolean";
      case "enum": return typeof entry === "string" && field.values.includes(entry);
    }
  });
}
