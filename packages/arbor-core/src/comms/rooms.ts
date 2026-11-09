/**
 * Commons rooms: the permissive multi-party channel (operator decisions 5
 * and 6, 2026-10-07). Pure membership and visibility predicates; the room
 * store itself lands with the rooms stage.
 *
 * A room has a tier. Specialist-tier rooms hold working agents; critic-tier
 * rooms hold critics only. Critics READ every specialist-tier room as
 * observers but POST only in critic-tier rooms, so a critic never steers the
 * work it will judge. No specialist or planner can read a critic-tier room
 * (critic isolation). Orchestrators read every room to supervise, and post
 * only where they are members. A sibling peer grant is a two-member
 * specialist-tier room.
 */
import type { ArborAgentName } from "../agent-taxonomy.js";
import { COMMS_ROLE_TIER, type CommsPrincipal, type CommsTreeView } from "./roles.js";

export const COMMS_ROOM_TIERS = Object.freeze(["specialist", "critic"] as const);
export type CommsRoomTier = (typeof COMMS_ROOM_TIERS)[number];

export interface CommsRoom {
  readonly room_id: string;
  readonly tier: CommsRoomTier;
  /** Member node ids. */
  readonly members: readonly string[];
}

/** Rooms are opened (and their membership set) by the operator, the host loop, or an orchestrator-tier agent. */
export function canOpenRoom(opener: CommsPrincipal): boolean {
  return opener.kind !== "agent" || COMMS_ROLE_TIER[opener.agent] === "orchestrator";
}

/** Which agents may be members of a room of this tier. */
export function canBeRoomMember(agent: ArborAgentName, tier: CommsRoomTier): boolean {
  const role = COMMS_ROLE_TIER[agent];
  return tier === "critic" ? role === "critic" : role !== "critic";
}

/** Membership problems for a room against the tree: unresolved members and members barred by tier. */
export function roomMembershipViolations(room: CommsRoom, tree: CommsTreeView): string[] {
  const problems: string[] = [];
  if (new Set(room.members).size !== room.members.length) problems.push("members repeat a node");
  for (const member of room.members) {
    const node = Object.prototype.hasOwnProperty.call(tree.nodes, member) ? tree.nodes[member] : undefined;
    if (node === undefined) problems.push(`${member} does not resolve in the campaign tree`);
    else if (!canBeRoomMember(node.agent, room.tier)) problems.push(`${node.agent}@${member} may not be a member of a ${room.tier}-tier room`);
  }
  return problems;
}

function isMember(principal: CommsPrincipal, room: CommsRoom): boolean {
  return principal.kind === "agent" && room.members.includes(principal.node_id);
}

/** True when `reader` may read the room's posts (pull). */
export function canReadRoom(reader: CommsPrincipal, room: CommsRoom): boolean {
  if (reader.kind !== "agent") return true;
  switch (COMMS_ROLE_TIER[reader.agent]) {
    case "orchestrator": return true;
    case "critic": return room.tier === "specialist" || isMember(reader, room);
    case "planner":
    case "specialist": return room.tier === "specialist" && isMember(reader, room);
  }
}

/** True when `sender` may post in the room. Operator and host loop always may; an agent only as an eligible member. */
export function canPostToRoom(sender: CommsPrincipal, room: CommsRoom): boolean {
  if (sender.kind !== "agent") return true;
  return isMember(sender, room) && canBeRoomMember(sender.agent, room.tier);
}

/** True when every @mention names a member of the room. */
export function mentionsAreMembers(mentions: readonly string[], room: CommsRoom): boolean {
  return mentions.every((mention) => room.members.includes(mention));
}
