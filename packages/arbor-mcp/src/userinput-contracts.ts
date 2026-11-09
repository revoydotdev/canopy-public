import type { RequestUserInput, RequestUserInputRecord, UserInputAnswer } from "@arbor/audit";
import type { OperationMetadata } from "@arbor/core";

export type UserInputCommand = {
  kind: "userinput.ask";
  campaign_id: string;
  node_id: string;
  question: RequestUserInput;
} | {
  kind: "userinput.answer";
  record_id: string;
  answer: UserInputAnswer;
};

export type UserInputQuery = {
  kind: "userinput.list" | "userinput.awaiting";
  /**
   * Optional for `userinput.awaiting` only: omitted, the query aggregates
   * pending (unanswered) requests across every campaign — the shape the
   * dashboard attention feed needs. The 2026-08-23 outcome-aware observation
   * gate caught the TUI issuing this query bare and failing validation on
   * every refresh, so "Response needed" attention rows could never render.
   */
  campaign_id?: string;
  node_id?: string;
  limit?: number;
};

export interface UserInputCommandEnvelope {
  schema_version: 1;
  metadata: OperationMetadata;
  command: UserInputCommand;
}

export interface UserInputQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: UserInputQuery;
}

export interface UserInputListProjection {
  campaign_id: string;
  node_id?: string;
  records: RequestUserInputRecord[];
  /**
   * Which of `records` have been answered.
   *
   * Carried alongside the records rather than folded into them: a record's own
   * `status`/`answer` are covered by its content hash and are frozen at
   * creation by ADR-019's append-only answer design, so rewriting them in a
   * projection would make the projection disagree with the bytes the ledger
   * actually hashed. Without this field every consumer sees `status:
   * "awaiting"` on every question forever, answered or not.
   */
  answered_record_ids: string[];
}

export interface UserInputAwaitingProjection {
  campaign_id?: string;
  node_id?: string;
  awaiting: boolean;
  /** Cross-campaign aggregate (campaign_id omitted): every pending request. */
  requests?: readonly { campaign_id: string; node_id: string; record_id: string; question: string }[];
}

export function isUserInputCommandEnvelope(input: unknown): input is UserInputCommandEnvelope {
  if (!record(input) || input.schema_version !== 1 || !record(input.metadata) || !record(input.command)) return false;
  return input.command.kind === "userinput.ask" || input.command.kind === "userinput.answer";
}

export function isUserInputQueryEnvelope(input: unknown): input is UserInputQueryEnvelope {
  if (!record(input) || input.schema_version !== 1 || typeof input.query_id !== "string" || !record(input.query)) return false;
  return input.query.kind === "userinput.list" || input.query.kind === "userinput.awaiting";
}

export function validateUserInputCommand(envelope: UserInputCommandEnvelope): string[] {
  const failures: string[] = [];
  if (!text(envelope.metadata.operation_id) || !text(envelope.metadata.idempotency_key)
    || !text(envelope.metadata.correlation_id) || !text(envelope.metadata.actor_id)) {
    failures.push("metadata identity fields are required");
  }
  if (envelope.command.kind === "userinput.ask") {
    if (!text(envelope.command.campaign_id) || !text(envelope.command.node_id) || !record(envelope.command.question)) {
      failures.push("campaign, node, and question are required");
    } else {
      // Validate the question's INNER shape, not merely that it is a record.
      //
      // Checking `record(question)` alone accepted a malformed governed
      // question and returned `ok`: `options` as bare strings, `blocking` as a
      // boolean, `as_of` as an ISO timestamp. The command was logged as an
      // operation and never became a queryable interview, so a BLOCKING
      // question -- the mechanism by which work halts pending a human answer --
      // was acknowledged while no human could ever see it. Every sibling
      // validator here already checks fields and enums to this depth
      // (`validateParentChildThreadSend` reports "message_kind is invalid" /
      // "capability_tier is invalid"); this one stopped at the outer type.
      //
      // Exemplars agree that malformed input is REJECTED, never accepted and
      // logged: OpenCode declares every command as an `effect/Schema.Struct`
      // (`packages/schema/src/command.ts`) so parsing IS acceptance, and
      // Claude Code carries `InputValidationError` / "Invalid arguments for
      // tool" rejection vocabulary. EC-013b.
      const question = envelope.command.question as Record<string, unknown>;
      for (const field of ["operation_id", "question", "requester_role", "idempotency_key", "as_of"]) {
        if (!text(question[field])) failures.push(`question.${field} must be a non-empty string`);
      }
      if (!Array.isArray(question.options) || question.options.length === 0) {
        failures.push("question.options must be a non-empty array");
      } else if (question.options.some((option) => !record(option) || !text((option as Record<string, unknown>).id) || !text((option as Record<string, unknown>).text))) {
        failures.push("question.options entries require a non-empty id and text");
      }
      if (question.authority !== "lead" && question.authority !== "delegated_needs_input") {
        failures.push("question.authority must be \"lead\" or \"delegated_needs_input\"");
      }
      if (question.blocking !== "blocking" && question.blocking !== "async") {
        failures.push("question.blocking must be \"blocking\" or \"async\"");
      }
    }
  } else if (envelope.command.kind === "userinput.answer") {
    if (!text(envelope.command.record_id) || !record(envelope.command.answer)) {
      failures.push("record_id and answer are required");
    }
  }
  return failures;
}

export function validateUserInputQuery(envelope: UserInputQueryEnvelope): string[] {
  const query = envelope.query;
  const failures: string[] = [];
  if (query.kind === "userinput.awaiting" && query.campaign_id === undefined) {
    // Aggregate form: node_id is meaningless without a campaign.
    if (query.node_id !== undefined) failures.push("node_id requires campaign_id");
  } else if (!text(query.campaign_id)) failures.push("campaign_id is required");
  if (query.node_id !== undefined && !text(query.node_id)) failures.push("node_id must be non-empty when present");
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) failures.push("limit must be a positive integer when present");
  return failures;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
