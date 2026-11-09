import { describe, expect, it } from "vitest";
import { C2_COMMAND_KINDS, C2_REPLY_KINDS } from "../../src/comms/c2.js";
import { COMMS_TEXT_MAX_BYTES, payloadCarriesFreeText, validateCommsEnvelope, type CommsEnvelope, type CommsPayload } from "../../src/comms/envelope.js";
import type { CommsPrincipal } from "../../src/comms/roles.js";
import { ALL_AGENTS, COMMANDS, REPLIES, clone } from "./fixtures.js";

const CHILD: CommsPrincipal = { kind: "agent", agent: "seed", node_id: "n-child" };
const PARENT: CommsPrincipal = { kind: "agent", agent: "cambium", node_id: "n-parent" };
const claimedBy = (claimant: string) => ({ tag: "claimed" as const, claimant });

function envelope(overrides: Partial<CommsEnvelope> & { payload: CommsPayload }): CommsEnvelope {
  const base: CommsEnvelope = {
    schema_version: 1,
    channel: "thread",
    conversation_id: "thread:n-parent:n-child",
    sender: CHILD,
    recipients: ["n-parent"],
    mentions: [],
    provenance: claimedBy("n-child"),
    redaction_required: payloadCarriesFreeText(overrides.payload),
    payload: overrides.payload,
  };
  return { ...base, ...overrides };
}

const commandEnvelope = (kind: (typeof C2_COMMAND_KINDS)[number], sender: CommsPrincipal = PARENT) => {
  const payload: CommsPayload = { type: "command", command: COMMANDS[kind] };
  return envelope({ channel: "c2", sender, recipients: ["n-child"], provenance: sender.kind === "host_loop" ? { tag: "generated", generator: "crown-loop", input_hash: "h" } : claimedBy(sender.kind === "agent" ? sender.node_id : "operator"), payload });
};
const replyEnvelope = (kind: (typeof C2_REPLY_KINDS)[number]) => envelope({ channel: "c2", payload: { type: "reply", reply: REPLIES[kind] } });

describe("validateCommsEnvelope", () => {
  it("accepts a well-formed envelope on each channel", () => {
    expect(validateCommsEnvelope(envelope({ payload: { type: "text", text: "halfway there" } })).ok).toBe(true);
    expect(validateCommsEnvelope(envelope({ channel: "commons", conversation_id: "room:c1:r1", recipients: [], mentions: ["n-other"], payload: { type: "post", text: "anyone seen this flake?" } })).ok).toBe(true);
    for (const kind of C2_COMMAND_KINDS) {
      expect(validateCommsEnvelope(commandEnvelope(kind))).toMatchObject({ ok: true });
      expect(validateCommsEnvelope(commandEnvelope(kind, { kind: "operator" }))).toMatchObject({ ok: true });
      expect(validateCommsEnvelope(commandEnvelope(kind, { kind: "host_loop" }))).toMatchObject({ ok: true });
    }
    for (const kind of C2_REPLY_KINDS) expect(validateCommsEnvelope(replyEnvelope(kind))).toMatchObject({ ok: true });
  });

  it("never carries verified or critic-approved provenance, on any channel or payload", () => {
    const strong = [
      { tag: "verified", cmd: "bun run build", exit: 0, stdout_hash: "abc" },
      { tag: "critic_approved", critic: "lenticel", rationale: "ok" },
    ];
    const all = [envelope({ payload: { type: "text", text: "t" } }), ...C2_COMMAND_KINDS.map((kind) => commandEnvelope(kind)), ...C2_REPLY_KINDS.map(replyEnvelope)];
    for (const base of all) for (const provenance of strong) expect(validateCommsEnvelope({ ...base, provenance }).ok).toBe(false);
  });

  it("keeps a done reply claimed by the node that sent it", () => {
    const done = replyEnvelope("done");
    expect(validateCommsEnvelope({ ...done, provenance: claimedBy("n-parent") }).ok).toBe(false);
    const foreign = clone(done) as CommsEnvelope & { payload: { type: "reply"; reply: { provenance: { claimant: string } } } };
    foreign.payload.reply.provenance.claimant = "n-parent";
    expect(validateCommsEnvelope(foreign).ok).toBe(false);
    expect(validateCommsEnvelope({ ...done, sender: { kind: "operator" }, provenance: claimedBy("operator") }).ok).toBe(false);
  });

  it("refuses a command from any non-orchestrator agent, before any edge check", () => {
    for (const agent of ALL_AGENTS) {
      const sender: CommsPrincipal = { kind: "agent", agent, node_id: "n-sender" };
      const ok = validateCommsEnvelope(commandEnvelope("task.amend", sender)).ok;
      expect({ agent, ok }).toEqual({ agent, ok: agent === "crown" || agent === "cambium" });
    }
  });

  it("binds provenance to the sender: host loop generated, operator and agents claimed", () => {
    expect(validateCommsEnvelope({ ...commandEnvelope("status.request", { kind: "host_loop" }), provenance: claimedBy("crown") }).ok).toBe(false);
    expect(validateCommsEnvelope({ ...commandEnvelope("status.request", { kind: "operator" }), provenance: { tag: "generated", generator: "x", input_hash: "h" } }).ok).toBe(false);
    expect(validateCommsEnvelope({ ...envelope({ payload: { type: "text", text: "t" } }), provenance: claimedBy("someone-else") }).ok).toBe(false);
  });

  it("requires the redaction marker to match the payload and refuses understating it", () => {
    for (const base of [envelope({ payload: { type: "text", text: "t" } }), ...C2_COMMAND_KINDS.map((kind) => commandEnvelope(kind)), ...C2_REPLY_KINDS.map(replyEnvelope)]) {
      expect(validateCommsEnvelope({ ...base, redaction_required: !base.redaction_required }).ok).toBe(false);
    }
    expect(payloadCarriesFreeText({ type: "reply", reply: REPLIES.ack })).toBe(false);
    expect(payloadCarriesFreeText({ type: "command", command: COMMANDS["status.request"] })).toBe(false);
    expect(payloadCarriesFreeText({ type: "command", command: COMMANDS["task.assign"] })).toBe(true);
  });

  it("enforces per-channel addressing and payload type", () => {
    const text: CommsPayload = { type: "text", text: "t" };
    expect(validateCommsEnvelope(envelope({ payload: text, recipients: [] })).ok).toBe(false);
    expect(validateCommsEnvelope(envelope({ payload: text, recipients: ["a", "b"] })).ok).toBe(false);
    expect(validateCommsEnvelope(envelope({ payload: text, mentions: ["n-parent"] })).ok).toBe(false);
    expect(validateCommsEnvelope(envelope({ payload: text, recipients: ["n-child"] })).ok).toBe(false);
    expect(validateCommsEnvelope(envelope({ channel: "commons", payload: { type: "post", text: "t" } })).ok).toBe(false);
    expect(validateCommsEnvelope(envelope({ channel: "c2", payload: text })).ok).toBe(false);
    expect(validateCommsEnvelope(envelope({ channel: "thread", payload: { type: "command", command: COMMANDS["status.request"] } })).ok).toBe(false);
    expect(validateCommsEnvelope({ ...commandEnvelope("task.halt"), recipients: ["n-child", "n-other"] }).ok).toBe(false);
    expect(validateCommsEnvelope({ ...replyEnvelope("ack"), recipients: ["a", "b"] }).ok).toBe(false);
    expect(validateCommsEnvelope(envelope({ payload: { type: "text", text: "x".repeat(COMMS_TEXT_MAX_BYTES + 1) } })).ok).toBe(false);
  });

  it("refuses unknown fields at the envelope, sender and payload levels, and unknown channels", () => {
    const base = envelope({ payload: { type: "text", text: "t" } });
    expect(validateCommsEnvelope({ ...base, priority: "high" }).ok).toBe(false);
    expect(validateCommsEnvelope({ ...base, sender: { ...CHILD, tier: "orchestrator" } }).ok).toBe(false);
    expect(validateCommsEnvelope({ ...base, sender: { kind: "operator", node_id: "n" } }).ok).toBe(false);
    expect(validateCommsEnvelope({ ...base, payload: { type: "text", text: "t", as_operator: true } }).ok).toBe(false);
    expect(validateCommsEnvelope({ ...base, channel: "broadcast" }).ok).toBe(false);
    expect(validateCommsEnvelope({ ...base, schema_version: 2 }).ok).toBe(false);
    expect(validateCommsEnvelope({ ...base, sender: { kind: "agent", agent: "oak", node_id: "n-child" } }).ok).toBe(false);
  });
});
