import type { ScreenId } from "./screens/screen.js";
import type { UiAction } from "./input-catalog.js";

export type PilotWorkflowCategory = "project" | "plan" | "supervise" | "intervene" | "recover" | "delegate" | "govern" | "integrate" | "finish";
export interface PilotWorkflow {
  readonly id: string;
  readonly category: PilotWorkflowCategory;
  readonly title: string;
  readonly outcome: string;
  readonly route: { readonly kind: "screen"; readonly screen: ScreenId } | { readonly kind: "action"; readonly action_id: string } | { readonly kind: "cli"; readonly command: string };
  readonly requires?: string;
}

/**
 * Operator-facing inventory of complete pilot journeys. This is deliberately
 * outcome-oriented: implementation-level runtime commands remain discoverable
 * in the palette, while this catalog answers “what do I do next?”.
 */
export const PILOT_WORKFLOWS: readonly PilotWorkflow[] = Object.freeze([
  { id: "project.inspect", category: "project", title: "Inspect enrollment", outcome: "Check overlay, policy, command/skill roots, and local storage agreement", route: { kind: "cli", command: "arbor project status ." } },
  { id: "project.enroll", category: "project", title: "Enroll existing project", outcome: "Add the non-secret revoy2 overlay without replacing project files", route: { kind: "cli", command: "arbor project enroll . --dry-run" } },
  { id: "project.create", category: "project", title: "Create and enroll project", outcome: "Create a new project root and its minimal revoy2 overlay", route: { kind: "cli", command: "arbor project enroll <path> --new --dry-run" } },
  { id: "project.backfill", category: "project", title: "Backfill overlay", outcome: "Add missing overlay structure to a partially adopted project", route: { kind: "cli", command: "arbor project enroll . --backfill --dry-run" } },
  { id: "project.repair", category: "project", title: "Repair out-of-sync project", outcome: "Preview missing paths or a moved-root mismatch, then apply explicitly", route: { kind: "cli", command: "arbor project repair ." } },
  { id: "plan.new", category: "plan", title: "Plan new work", outcome: "Draft, clarify, review, and confirm a governed task", route: { kind: "action", action_id: "cmd:taskcomposer.new" } },
  { id: "plan.followup", category: "plan", title: "Continue a project", outcome: "Create a lineage-linked follow-up from an admitted campaign", route: { kind: "action", action_id: "cmd:taskcomposer.followup" }, requires: "selected admitted draft" },
  { id: "plan.roadmap", category: "plan", title: "Dispatch next roadmap item", outcome: "Select the next governance-backed obligation and propose execution", route: { kind: "action", action_id: "cmd:taskcomposer.roadmap" } },
  { id: "plan.maintenance", category: "plan", title: "Run maintenance pass", outcome: "Propose a correctness, reliability, performance, and maintainability pass", route: { kind: "action", action_id: "cmd:taskcomposer.maintenance" } },
  { id: "supervise.portfolio", category: "supervise", title: "Review campaigns", outcome: "Inspect current and terminal campaign state", route: { kind: "screen", screen: "campaigns" } },
  { id: "supervise.tree", category: "supervise", title: "Inspect search tree", outcome: "Follow selection, expansion, verification, failure, and backtracking", route: { kind: "screen", screen: "tree" } },
  { id: "supervise.work", category: "supervise", title: "Inspect tasks, jobs, and operations", outcome: "Trace scheduled work through runtime operations", route: { kind: "screen", screen: "jobs" } },
  { id: "supervise.sessions", category: "supervise", title: "Inspect native sessions", outcome: "Review bounded session state and redacted event streams", route: { kind: "screen", screen: "harness-sessions" } },
  { id: "supervise.live-session", category: "supervise", title: "Attach a live session", outcome: "Steer or interrupt a running interactive session turn-by-turn", route: { kind: "screen", screen: "live-session" } },
  { id: "intervene.interrupt", category: "intervene", title: "Interrupt active work", outcome: "Stop the expanding node through the governed interrupt path", route: { kind: "action", action_id: "cmd:tree.interrupt" }, requires: "active campaign" },
  { id: "intervene.tree", category: "intervene", title: "Branch or prune", outcome: "Steer tree search while preserving confirmation and evidence", route: { kind: "screen", screen: "tree" } },
  { id: "intervene.approval", category: "intervene", title: "Resolve approvals", outcome: "Approve once/session/persistently, reject, or expire requests", route: { kind: "screen", screen: "approvals" } },
  { id: "intervene.interview", category: "intervene", title: "Answer agent questions", outcome: "Resolve blocking governed interviews", route: { kind: "screen", screen: "interviews" } },
  { id: "intervene.message", category: "intervene", title: "Message or steer agents", outcome: "Use direct parent/child threads with versioned acknowledgement", route: { kind: "screen", screen: "threads" }, requires: "selected non-root tree node" },
  { id: "recover.pending", category: "recover", title: "Recover interrupted work", outcome: "Retry or explicitly abandon durable recovery targets", route: { kind: "screen", screen: "recovery" } },
  { id: "recover.diagnose", category: "recover", title: "Diagnose runtime health", outcome: "Inspect configuration, readiness, reachability, and durable consistency", route: { kind: "screen", screen: "diagnostics" } },
  { id: "recover.ledger", category: "recover", title: "Verify or repair ledger", outcome: "Run explicit evidence-chain verification or repair", route: { kind: "cli", command: "arbor ledger verify --help" } },
  { id: "delegate.agents", category: "delegate", title: "Choose an agent role", outcome: "Review botanical roles, capabilities, liveness, and assignments", route: { kind: "screen", screen: "agents" } },
  { id: "delegate.skills", category: "delegate", title: "Run a skill or project command", outcome: "Search /commands and bounded skill-backed actions in the palette", route: { kind: "action", action_id: "help" } },
  { id: "delegate.subagent", category: "delegate", title: "Summon declarative subagent", outcome: "Execute an admitted descriptor as an isolated native child", route: { kind: "screen", screen: "overlays" }, requires: "active descriptor and parent node" },
  { id: "delegate.communicate", category: "delegate", title: "Inspect agent communications", outcome: "Review selection-scoped messages and sibling topology", route: { kind: "screen", screen: "communications" } },
  { id: "govern.policy", category: "govern", title: "Review governance", outcome: "Inspect ADR obligations, findings, and backlog", route: { kind: "screen", screen: "governance" } },
  { id: "govern.evidence", category: "govern", title: "Audit evidence", outcome: "Trace provenance-typed evidence and captured outputs", route: { kind: "screen", screen: "audit" } },
  { id: "govern.knowledge", category: "govern", title: "Inspect learned knowledge", outcome: "Review capability-filtered prior failures and verified knowledge", route: { kind: "screen", screen: "kb" } },
  { id: "govern.context", category: "govern", title: "Manage context overlays", outcome: "Inspect and roll back governed folds/harness overlays", route: { kind: "screen", screen: "overlays" } },
  { id: "integrate.config", category: "integrate", title: "Configure providers and models", outcome: "Inspect resolved non-secret policy and source provenance", route: { kind: "screen", screen: "config" } },
  { id: "integrate.readiness", category: "integrate", title: "Resolve execution readiness", outcome: "See credential presence, route selection, and exact remediation", route: { kind: "screen", screen: "harness-readiness" } },
  { id: "integrate.connectors", category: "integrate", title: "Inspect connectors", outcome: "Review native and external integration capabilities", route: { kind: "screen", screen: "harness-connectors" } },
  { id: "integrate.trust", category: "integrate", title: "Manage remote trust", outcome: "Review enrollment, rotation, and revocation availability", route: { kind: "screen", screen: "trust" } },
  { id: "finish.output", category: "finish", title: "Review result", outcome: "Inspect evidence descriptors and approved raw output", route: { kind: "screen", screen: "output" } },
  { id: "finish.report", category: "finish", title: "Produce run report", outcome: "Summarize a completed or interrupted campaign", route: { kind: "cli", command: "arbor report --campaign <id>" } },
  { id: "finish.adopt", category: "finish", title: "Adopt verified changes", outcome: "Preview and apply the best captured verified result", route: { kind: "cli", command: "arbor adopt --campaign <id>" } },
  { id: "finish.evaluate", category: "finish", title: "Evaluate harness revision", outcome: "Compare, promote, or quarantine measured revisions", route: { kind: "screen", screen: "harness-evaluations" } },
]);

/** Outcome-oriented aliases for the command palette; CLI-only journeys stay textual. */
export function workflowPaletteActions(): readonly UiAction[] {
  return PILOT_WORKFLOWS.filter((workflow) => workflow.route.kind !== "cli").map((workflow) => Object.freeze({
    id: `workflow:${workflow.id}`,
    title: workflow.title,
    description: `${workflow.outcome}${workflow.requires ? ` · requires ${workflow.requires}` : ""}`,
    source: "builtin" as const,
    bindings: Object.freeze([]),
  }));
}

export function workflowForAction(actionId: string): PilotWorkflow | null {
  if (!actionId.startsWith("workflow:")) return null;
  return PILOT_WORKFLOWS.find((workflow) => `workflow:${workflow.id}` === actionId) ?? null;
}
