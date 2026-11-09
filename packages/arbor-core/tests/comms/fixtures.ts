import type { ArborAgentName } from "../../src/agent-taxonomy.js";
import type { C2Command, C2Reply } from "../../src/comms/c2.js";
import type { RuntimeGateRefusalV2 } from "../../src/runtime-contracts.js";

export const REFUSAL: RuntimeGateRefusalV2 = {
  schema_version: 2,
  kind: "gate.refusal",
  state: "refused",
  gate: "capability",
  correcting_actor: "operator",
  corrective_action: "grant_capability",
  code: "scope.outside_worktree",
  summary: "the amendment asks for a write outside my worktree",
  evidence_deficit: null,
  remediation: "re-scope the amendment to the node's worktree",
};

/** One valid command per kind. */
export const COMMANDS: Record<C2Command["kind"], C2Command> = {
  "task.assign": { kind: "task.assign", command_id: "cmd-1", objective: "Add the retry bound", acceptance: ["bun run build passes"], output_contract: "patch" },
  "task.amend": { kind: "task.amend", command_id: "cmd-2", instruction: "Also cover the zero case" },
  "task.halt": { kind: "task.halt", command_id: "cmd-3", mode: "graceful", reason_code: "superseded" },
  "status.request": { kind: "status.request", command_id: "cmd-4" },
  "clarification.answer": { kind: "clarification.answer", command_id: "cmd-5", clarification_id: "q-1", action: "accept", content: { target: "main", retries: 3, dry_run: false } },
};

/** One valid reply per palette member. */
export const REPLIES: Record<C2Reply["kind"], C2Reply> = {
  ack: { kind: "ack", command_id: "cmd-1" },
  decline: { kind: "decline", command_id: "cmd-1", remedy: REFUSAL },
  blocked: { kind: "blocked", command_id: "cmd-1", needs: "dependency", detail: "waiting on node n-4" },
  clarify: { kind: "clarify", command_id: "cmd-1", clarification_id: "q-1", question: "Which branch?", schema: { fields: { target: { type: "enum", values: ["main", "next"] }, retries: { type: "number" }, dry_run: { type: "boolean" } }, required: ["target"] } },
  progress: { kind: "progress", command_id: "cmd-1", phase: "editing", note: "two of three files done" },
  done: { kind: "done", command_id: "cmd-1", result_summary: "Added the bound", evidence_refs: ["ev-1"], provenance: { tag: "claimed", claimant: "n-child" } },
  failed: { kind: "failed", command_id: "cmd-1", failure_class: "tool_error", error: "shell exited 2", evidence_refs: [] },
};

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const ALL_AGENTS: readonly ArborAgentName[] = ["crown", "cambium", "taproot", "heartwood", "seed", "lenticel", "burl", "xylem", "rhizome", "mycelium", "stoma"];
