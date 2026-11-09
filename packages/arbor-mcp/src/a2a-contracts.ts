export type A2ATaskState = "submitted" | "working" | "input_required" | "completed" | "canceled" | "failed";
export type A2APartKind = "text" | "evidence_ref";

export const A2A_MAX_NODE_REF_BYTES = 128;
export const A2A_MAX_TEXT_PART_BYTES = 4096;
export const A2A_MAX_PARTS = 32;
export const A2A_MAX_RECIPIENTS = 16;

const VALID_TASK_STATES = new Set<string>(["submitted", "working", "input_required", "completed", "canceled", "failed"]);
const VALID_PART_KINDS = new Set<string>(["text", "evidence_ref"]);

export interface A2ATask {
  readonly id: string;
  readonly state: A2ATaskState;
  readonly node_ref: string;
}

export interface A2APart {
  readonly kind: A2APartKind;
  readonly text?: string;
  readonly evidence_ref?: string;
}

export interface A2AMessage {
  readonly id: string;
  readonly task_id: string;
  readonly author_node_ref: string;
  readonly recipient_node_refs: readonly string[];
  readonly parts: readonly A2APart[];
  readonly as_of: string;
  /**
   * The task's lifecycle snapshot as *derived from ledger-witnessed
   * NodeCommunication records at the moment this message was projected* —
   * never a value supplied by the sender and echoed back. Optional so
   * every pre-existing caller/assertion that predates task-lifecycle
   * bridging (4D.6) keeps compiling and passing unmodified.
   */
  readonly task?: A2ATask;
}

export interface A2AArtifact {
  readonly id: string;
  readonly task_id: string;
  readonly evidence_ref: string;
  readonly description: string;
}

export interface A2AAgentCard {
  readonly node_ref: string;
  readonly role: string;
  readonly skills: readonly string[];
  readonly tier: string;
  readonly signature: string;
}

function assertNonEmpty(value: string | undefined, label: string): void {
  if (value === undefined || value.length === 0) throw new Error(`${label} must be non-empty`);
}

export function validateA2AMessage(message: A2AMessage): string[] {
  const failures: string[] = [];
  if (!message.id?.trim()) failures.push("id must be non-empty");
  if (!message.task_id?.trim()) failures.push("task_id must be non-empty");
  if (!message.author_node_ref?.trim()) failures.push("author_node_ref must be non-empty");
  if ([...(message.id ?? "")].length > A2A_MAX_NODE_REF_BYTES) failures.push(`id exceeds ${A2A_MAX_NODE_REF_BYTES} bytes`);
  if ([...(message.task_id ?? "")].length > A2A_MAX_NODE_REF_BYTES) failures.push(`task_id exceeds ${A2A_MAX_NODE_REF_BYTES} bytes`);
  if ([...(message.author_node_ref ?? "")].length > A2A_MAX_NODE_REF_BYTES) failures.push(`author_node_ref exceeds ${A2A_MAX_NODE_REF_BYTES} bytes`);
  if (!Array.isArray(message.recipient_node_refs)) failures.push("recipient_node_refs must be an array");
  else {
    if (message.recipient_node_refs.length > A2A_MAX_RECIPIENTS) failures.push(`recipient_node_refs exceeds ${A2A_MAX_RECIPIENTS}`);
    if (message.recipient_node_refs.some((r) => !r?.trim() || [...r].length > A2A_MAX_NODE_REF_BYTES)) failures.push("each recipient_node_ref must be non-empty and ≤128 bytes");
  }
  if (!Array.isArray(message.parts)) failures.push("parts must be an array");
  else {
    if (message.parts.length > A2A_MAX_PARTS) failures.push(`parts exceeds ${A2A_MAX_PARTS}`);
    for (const [i, part] of message.parts.entries()) {
      if (!part || !VALID_PART_KINDS.has(part.kind)) failures.push(`part[${i}].kind must be text or evidence_ref`);
      if (part.kind === "text") {
        assertNonEmpty(part.text, `part[${i}].text`);
        if (part.text !== undefined && [...part.text].length > A2A_MAX_TEXT_PART_BYTES) failures.push(`part[${i}].text exceeds ${A2A_MAX_TEXT_PART_BYTES} bytes`);
      }
      if (part.kind === "evidence_ref") assertNonEmpty(part.evidence_ref, `part[${i}].evidence_ref`);
    }
  }
  if (!message.as_of?.trim()) failures.push("as_of must be non-empty");
  return failures;
}

export function validateA2ATask(task: A2ATask): string[] {
  const failures: string[] = [];
  if (!task.id?.trim()) failures.push("id must be non-empty");
  if (!VALID_TASK_STATES.has(task.state)) failures.push(`state must be one of: ${[...VALID_TASK_STATES].join(", ")}`);
  if (!task.node_ref?.trim()) failures.push("node_ref must be non-empty");
  if ([...(task.id ?? "")].length > A2A_MAX_NODE_REF_BYTES) failures.push(`id exceeds ${A2A_MAX_NODE_REF_BYTES} bytes`);
  if ([...(task.node_ref ?? "")].length > A2A_MAX_NODE_REF_BYTES) failures.push(`node_ref exceeds ${A2A_MAX_NODE_REF_BYTES} bytes`);
  return failures;
}

export function isA2AMessage(value: unknown): value is A2AMessage {
  if (value === null || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return typeof m.id === "string" && typeof m.task_id === "string" && typeof m.author_node_ref === "string" && Array.isArray(m.recipient_node_refs) && Array.isArray(m.parts) && typeof m.as_of === "string";
}
