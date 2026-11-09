/**
 * Bounded, derived continuation state for a replacement process/session.
 *
 * This is deliberately a projection, not a new durable store.  Campaign/tree
 * snapshots and direct-thread ledger history remain authority; a receiver can
 * reconstruct this view after a crash and follows the included references
 * rather than treating the summary as an instruction transcript.
 */
import type { ParentChildThreadProjection } from "./conversation-bus.js";

export type ReplanTrigger =
  | "needs_attention"
  | "deadline_expired"
  | "campaign_halted"
  | "convergence_stalled";

export interface HandoffCampaignNode {
  readonly id: string;
  readonly parent_id: string | null;
  readonly state: string;
  readonly action_description: string;
  readonly depth: number;
}

export interface CrossSessionHandoffInput {
  readonly campaign: {
    readonly id: string;
    readonly plan_path: string;
    readonly root_id: string;
    readonly started_at: string;
    readonly iterations_completed: number;
    readonly iterations_without_kb_entry: number;
    readonly halted: boolean;
    readonly halt_reason: string | null;
    readonly nodes: readonly HandoffCampaignNode[];
  };
  readonly threads: readonly ParentChildThreadProjection[];
  /** Opaque immutable references, e.g. fold/playbook/harness revision IDs. */
  readonly active_overlay_ids?: readonly string[];
  readonly as_of: string;
  readonly max_nodes?: number;
  readonly max_threads?: number;
}

export interface CrossSessionHandoffProjection {
  readonly campaign_id: string;
  readonly as_of: string;
  readonly authority: {
    readonly campaign_snapshot: true;
    readonly direct_thread_history: true;
    readonly overlays_are_references: true;
  };
  readonly plan_path: string;
  readonly root_node_id: string;
  readonly active_nodes: readonly Pick<HandoffCampaignNode, "id" | "parent_id" | "state" | "action_description" | "depth">[];
  readonly pending_threads: readonly {
    readonly thread_id: string;
    readonly parent_node_id: string;
    readonly child_node_id: string;
    readonly version: string;
    readonly needs_attention_message_ids: readonly string[];
    readonly timed_out_message_ids: readonly string[];
  }[];
  readonly active_overlay_ids: readonly string[];
  readonly replan_triggers: readonly ReplanTrigger[];
  readonly continuation: "resume_existing_plan" | "replan_required" | "halted";
}

const TERMINAL = new Set(["verified", "failed", "pruned", "abandoned"]);
const DEFAULT_MAX_NODES = 64;
const DEFAULT_MAX_THREADS = 16;

/** Pure, deterministic handoff projection.  It intentionally stores no prose transcript or model-derived claim. */
export function projectCrossSessionHandoff(input: CrossSessionHandoffInput): CrossSessionHandoffProjection {
  const maxNodes = bounded(input.max_nodes, DEFAULT_MAX_NODES, 1, 256);
  const maxThreads = bounded(input.max_threads, DEFAULT_MAX_THREADS, 1, 64);
  const active_nodes = input.campaign.nodes
    .filter((node) => !TERMINAL.has(node.state))
    .sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id))
    .slice(0, maxNodes)
    .map((node) => Object.freeze({ id: node.id, parent_id: node.parent_id, state: node.state, action_description: node.action_description, depth: node.depth }));
  const pending_threads = input.threads
    .map((thread) => ({
      thread_id: thread.thread_id,
      parent_node_id: thread.parent_node_id,
      child_node_id: thread.child_node_id,
      version: thread.version,
      needs_attention_message_ids: thread.needs_attention_message_ids,
      timed_out_message_ids: thread.messages.filter((message) => message.delivery === "timed_out").map((message) => message.id),
    }))
    .filter((thread) => thread.needs_attention_message_ids.length > 0 || thread.timed_out_message_ids.length > 0)
    .sort((left, right) => left.thread_id.localeCompare(right.thread_id))
    .slice(0, maxThreads)
    .map((thread) => Object.freeze({ ...thread, needs_attention_message_ids: Object.freeze([...thread.needs_attention_message_ids]), timed_out_message_ids: Object.freeze([...thread.timed_out_message_ids]) }));
  const triggers: ReplanTrigger[] = [];
  if (input.campaign.halted) triggers.push("campaign_halted");
  if (pending_threads.some((thread) => thread.needs_attention_message_ids.length > 0)) triggers.push("needs_attention");
  if (pending_threads.some((thread) => thread.timed_out_message_ids.length > 0)) triggers.push("deadline_expired");
  if (input.campaign.iterations_without_kb_entry >= 2) triggers.push("convergence_stalled");
  return Object.freeze({
    campaign_id: input.campaign.id,
    as_of: input.as_of,
    authority: Object.freeze({ campaign_snapshot: true, direct_thread_history: true, overlays_are_references: true }),
    plan_path: input.campaign.plan_path,
    root_node_id: input.campaign.root_id,
    active_nodes: Object.freeze(active_nodes),
    pending_threads: Object.freeze(pending_threads),
    active_overlay_ids: Object.freeze([...(input.active_overlay_ids ?? [])].slice(0, 64)),
    replan_triggers: Object.freeze(triggers),
    continuation: input.campaign.halted ? "halted" : triggers.length ? "replan_required" : "resume_existing_plan",
  });
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
