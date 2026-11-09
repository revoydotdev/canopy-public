/**
 * Directional C2 authority (operator decision 3, 2026-10-07): a command is
 * issued by the target's DIRECT PARENT AT ORCHESTRATOR TIER, or by the
 * operator. Specialists and planners never issue; critics are outside the
 * chain and are never a target, not even of the operator (the operator halts
 * a critic through `harness.session.interrupt`, not through C2).
 *
 * Crown's deterministic host loop dispatches every node, so it holds the
 * parent's command edge for each node whose direct parent is NOT an
 * orchestrator-tier node. Where a live orchestrator (Cambium) is the direct
 * parent, that orchestrator holds the edge and the host loop is displaced:
 * every target has at most one non-operator commander.
 *
 * Authority is the same for all five command kinds. Whether a
 * `clarification.answer` answers an open `clarify` is a correlation check
 * (`answerSatisfiesClarify`), not an authority one.
 *
 * Every refusal is an ADR-179 v2 remedy under the `capability` authority.
 */
import type { RuntimeGateRefusalV2 } from "../runtime-contracts.js";
import type { C2ReplyKind } from "./c2.js";
import { isTerminalC2Reply } from "./c2.js";
import { isC2IssuerAgent, isC2TargetAgent, type CommsAgentPrincipal, type CommsPrincipal, type CommsTreeView } from "./roles.js";

export const C2_REFUSAL_CODES = Object.freeze([
  "c2.target_unknown",
  "c2.target_is_critic",
  "c2.issuer_unknown",
  "c2.self_command",
  "c2.issuer_tier",
  "c2.not_direct_parent",
  "c2.host_loop_displaced",
  "c2.reply_not_target",
  "c2.reply_wrong_command",
  "c2.command_closed",
] as const);
export type C2RefusalCode = (typeof C2_REFUSAL_CODES)[number];

export type C2AuthorityBasis = "operator" | "host_loop" | "direct_parent";

export type C2AuthorityDecision =
  | { ok: true; basis: C2AuthorityBasis }
  | { ok: false; code: C2RefusalCode; refusal: RuntimeGateRefusalV2 };

export type C2ReplyDecision =
  | { ok: true }
  | { ok: false; code: C2RefusalCode; refusal: RuntimeGateRefusalV2 };

const ISSUE_REMEDIATION = "Issue the command from the target's direct orchestrator-tier parent, from the host loop where it holds that edge, or as the operator. C2 authority is never granted over C2.";
const REPLY_REMEDIATION = "Only the command's target may reply, only while the command is open, and only from the closed reply palette.";

function refuse(code: C2RefusalCode, summary: string, remediation: string): { ok: false; code: C2RefusalCode; refusal: RuntimeGateRefusalV2 } {
  return {
    ok: false,
    code,
    refusal: {
      schema_version: 2,
      kind: "gate.refusal",
      state: "refused",
      gate: "capability",
      correcting_actor: "operator",
      corrective_action: "grant_capability",
      code,
      summary,
      evidence_deficit: null,
      remediation,
    },
  };
}

function resolves(principal: CommsAgentPrincipal, tree: CommsTreeView): boolean {
  const node = Object.prototype.hasOwnProperty.call(tree.nodes, principal.node_id) ? tree.nodes[principal.node_id] : undefined;
  return node !== undefined && node.agent === principal.agent;
}

/**
 * Decide whether `issuer` may send a C2 command to `target`. Identities must
 * resolve against the tree exactly (node present, occupying agent equal);
 * an unresolved identity is refused rather than trusted.
 */
export function authorizeC2Issue(issuer: CommsPrincipal, target: CommsAgentPrincipal, tree: CommsTreeView): C2AuthorityDecision {
  if (!resolves(target, tree)) return refuse("c2.target_unknown", `target ${target.agent}@${target.node_id} does not resolve in the campaign tree`, ISSUE_REMEDIATION);
  if (!isC2TargetAgent(target.agent)) return refuse("c2.target_is_critic", `${target.agent} is a critic and outside the command chain`, "Critics receive no commands; their verdicts stay on the verdict path. Use harness.session.interrupt to stop a critic session.");
  if (issuer.kind === "operator") return { ok: true, basis: "operator" };
  const parentId = tree.nodes[target.node_id].parent_id;
  const parent = parentId !== null && Object.prototype.hasOwnProperty.call(tree.nodes, parentId) ? tree.nodes[parentId] : undefined;
  if (issuer.kind === "host_loop") {
    if (parent !== undefined && isC2IssuerAgent(parent.agent)) {
      return refuse("c2.host_loop_displaced", `${parent.agent}@${parentId} is ${target.node_id}'s orchestrator-tier parent and holds its command edge`, ISSUE_REMEDIATION);
    }
    return { ok: true, basis: "host_loop" };
  }
  if (!resolves(issuer, tree)) return refuse("c2.issuer_unknown", `issuer ${issuer.agent}@${issuer.node_id} does not resolve in the campaign tree`, ISSUE_REMEDIATION);
  if (issuer.node_id === target.node_id) return refuse("c2.self_command", "a node may not command itself", ISSUE_REMEDIATION);
  if (!isC2IssuerAgent(issuer.agent)) return refuse("c2.issuer_tier", `${issuer.agent} is not orchestrator tier and never issues commands`, ISSUE_REMEDIATION);
  if (parentId !== issuer.node_id) return refuse("c2.not_direct_parent", `${issuer.node_id} is not ${target.node_id}'s direct parent`, ISSUE_REMEDIATION);
  return { ok: true, basis: "direct_parent" };
}

/** Boolean form of `authorizeC2Issue`. */
export function canIssueC2(issuer: CommsPrincipal, target: CommsAgentPrincipal, tree: CommsTreeView): boolean {
  return authorizeC2Issue(issuer, target, tree).ok;
}

/** The open/closed state of an issued command, as projected by the caller from the ledger. */
export interface C2CommandState {
  readonly command_id: string;
  readonly target_node_id: string;
  readonly closed: boolean;
}

/**
 * Decide whether `replier` may send `reply` to `command`. Only the target
 * replies, only to the command it names, only while it is open. A terminal
 * reply (decline, done, failed) closes the command; the caller records that.
 */
export function authorizeC2Reply(replier: CommsPrincipal, command: C2CommandState, reply: { readonly kind: C2ReplyKind; readonly command_id: string }): C2ReplyDecision {
  if (replier.kind !== "agent" || replier.node_id !== command.target_node_id) return refuse("c2.reply_not_target", "only the command's target may reply", REPLY_REMEDIATION);
  if (reply.command_id !== command.command_id) return refuse("c2.reply_wrong_command", `reply names ${reply.command_id}, not ${command.command_id}`, REPLY_REMEDIATION);
  if (command.closed) return refuse("c2.command_closed", `${command.command_id} already received a terminal reply`, REPLY_REMEDIATION);
  return { ok: true };
}

/** The command state after `reply` is accepted. */
export function applyC2Reply(command: C2CommandState, reply: { readonly kind: C2ReplyKind }): C2CommandState {
  return isTerminalC2Reply(reply.kind) ? { ...command, closed: true } : command;
}
