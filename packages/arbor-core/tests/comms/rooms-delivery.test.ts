import { describe, expect, it } from "vitest";
import type { ArborAgentName } from "../../src/agent-taxonomy.js";
import { deliveryModeFor, injectionLabel } from "../../src/comms/delivery.js";
import { payloadCarriesFreeText, type CommsEnvelope, type CommsPayload } from "../../src/comms/envelope.js";
import { COMMS_ROLE_TIER, type CommsPrincipal } from "../../src/comms/roles.js";
import { COMMS_ROOM_TIERS, canBeRoomMember, canOpenRoom, canPostToRoom, canReadRoom, mentionsAreMembers, roomMembershipViolations, type CommsRoom } from "../../src/comms/rooms.js";
import { ALL_AGENTS, COMMANDS, REPLIES } from "./fixtures.js";

const agent = (name: ArborAgentName, node_id = `n-${name}`): CommsPrincipal => ({ kind: "agent", agent: name, node_id });

describe("room membership and visibility", () => {
  it("matches the decided matrix for every agent and room tier", () => {
    for (const name of ALL_AGENTS) {
      const tier = COMMS_ROLE_TIER[name];
      for (const roomTier of COMMS_ROOM_TIERS) {
        const asMember: CommsRoom = { room_id: "r", tier: roomTier, members: [`n-${name}`] };
        const asOutsider: CommsRoom = { room_id: "r", tier: roomTier, members: ["n-other"] };
        const memberAllowed = roomTier === "critic" ? tier === "critic" : tier !== "critic";
        expect(canBeRoomMember(name, roomTier)).toBe(memberAllowed);
        expect(canPostToRoom(agent(name), asMember)).toBe(memberAllowed);
        expect(canPostToRoom(agent(name), asOutsider)).toBe(false);
        const readsAsOutsider = tier === "orchestrator" || (tier === "critic" && roomTier === "specialist");
        expect({ name, roomTier, read: canReadRoom(agent(name), asOutsider) }).toEqual({ name, roomTier, read: readsAsOutsider });
        const readsAsMember = tier === "orchestrator" || tier === "critic" || roomTier === "specialist";
        expect({ name, roomTier, read: canReadRoom(agent(name), asMember) }).toEqual({ name, roomTier, read: readsAsMember });
      }
    }
  });

  it("lets critics read every specialist-tier room but post only in critic-tier rooms", () => {
    for (const critic of ["lenticel", "burl", "xylem"] as const) {
      const specialistRoom: CommsRoom = { room_id: "s", tier: "specialist", members: ["n-heartwood", `n-${critic}`] };
      expect(canReadRoom(agent(critic), specialistRoom)).toBe(true);
      expect(canPostToRoom(agent(critic), specialistRoom)).toBe(false);
      expect(canPostToRoom(agent(critic), { room_id: "c", tier: "critic", members: [`n-${critic}`] })).toBe(true);
    }
  });

  it("never lets a specialist or planner read a critic-tier room", () => {
    for (const name of ALL_AGENTS.filter((entry) => COMMS_ROLE_TIER[entry] === "specialist" || COMMS_ROLE_TIER[entry] === "planner")) {
      expect(canReadRoom(agent(name), { room_id: "c", tier: "critic", members: [`n-${name}`, "n-lenticel"] })).toBe(false);
    }
  });

  it("lets only the operator, host loop and orchestrator tier open rooms", () => {
    expect(canOpenRoom({ kind: "operator" })).toBe(true);
    expect(canOpenRoom({ kind: "host_loop" })).toBe(true);
    for (const name of ALL_AGENTS) expect(canOpenRoom(agent(name))).toBe(COMMS_ROLE_TIER[name] === "orchestrator");
  });

  it("reports unresolved and tier-barred members against the tree", () => {
    const tree = { nodes: { a: { parent_id: null, agent: "heartwood" as const }, b: { parent_id: "a", agent: "lenticel" as const } } };
    expect(roomMembershipViolations({ room_id: "r", tier: "specialist", members: ["a"] }, tree)).toEqual([]);
    expect(roomMembershipViolations({ room_id: "r", tier: "specialist", members: ["a", "b", "zz", "a"] }, tree)).toHaveLength(3);
    expect(roomMembershipViolations({ room_id: "r", tier: "critic", members: ["a"] }, tree)).toHaveLength(1);
    expect(mentionsAreMembers(["a"], { room_id: "r", tier: "specialist", members: ["a"] })).toBe(true);
    expect(mentionsAreMembers(["b"], { room_id: "r", tier: "specialist", members: ["a"] })).toBe(false);
  });
});

function env(channel: CommsEnvelope["channel"], payload: CommsPayload, sender: CommsPrincipal, recipients: string[], mentions: string[] = []): CommsEnvelope {
  return {
    schema_version: 1,
    channel,
    conversation_id: channel === "commons" ? "room-1" : "thread-1",
    sender,
    recipients,
    mentions,
    provenance: sender.kind === "host_loop" ? { tag: "generated", generator: "crown-loop", input_hash: "h" } : { tag: "claimed", claimant: sender.kind === "agent" ? sender.node_id : "operator" },
    redaction_required: payloadCarriesFreeText(payload),
    payload,
  };
}

describe("delivery policy", () => {
  const room: CommsRoom = { room_id: "room-1", tier: "specialist", members: ["a", "b", "c"] };

  it("injects C2 commands and replies to their addressee only", () => {
    const command = env("c2", { type: "command", command: COMMANDS["task.amend"] }, agent("cambium", "p"), ["a"]);
    expect(deliveryModeFor(command, "a")).toBe("inject");
    expect(deliveryModeFor(command, "b")).toBe("none");
    const reply = env("c2", { type: "reply", reply: REPLIES.progress }, agent("seed", "a"), ["p"]);
    expect(deliveryModeFor(reply, "p")).toBe("inject");
    expect(deliveryModeFor(reply, "a")).toBe("none");
  });

  it("injects commons @mentions, leaves the rest of the room pull-only, and reaches no outsider", () => {
    const post = env("commons", { type: "post", text: "@b can you check?" }, agent("heartwood", "a"), [], ["b"]);
    expect(deliveryModeFor(post, "b", room)).toBe("inject");
    expect(deliveryModeFor(post, "c", room)).toBe("pull");
    expect(deliveryModeFor(post, "a", room)).toBe("none");
    expect(deliveryModeFor(post, "z", room)).toBe("none");
    expect(deliveryModeFor(post, "b")).toBe("none");
    expect(deliveryModeFor(post, "b", { ...room, room_id: "other" })).toBe("none");
  });

  it("keeps thread messages pull-only", () => {
    const message = env("thread", { type: "text", text: "fyi" }, agent("cambium", "p"), ["a"]);
    expect(deliveryModeFor(message, "a")).toBe("pull");
    expect(deliveryModeFor(message, "b")).toBe("none");
  });

  it("labels injected text by source and never frames an agent or the host loop as the operator", () => {
    for (const name of ALL_AGENTS) {
      const label = injectionLabel(env("c2", { type: "reply", reply: REPLIES.ack }, agent(name, "n1"), ["p"]));
      expect(label).toContain(`agent ${name} at node n1`);
      expect(label.toLowerCase()).not.toContain("operator");
    }
    expect(injectionLabel(env("c2", { type: "command", command: COMMANDS["task.halt"] }, { kind: "host_loop" }, ["a"]))).not.toMatch(/operator/i);
    expect(injectionLabel(env("c2", { type: "command", command: COMMANDS["task.halt"] }, { kind: "operator" }, ["a"]))).toContain("from operator");
  });
});
