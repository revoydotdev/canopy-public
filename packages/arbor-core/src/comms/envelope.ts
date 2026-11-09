/**
 * The channel envelope: one shape for every message on the communication
 * ledger (operator decision 1, 2026-10-07). It is a projection of the
 * existing NodeCommunication record plus a `channel` and a schema-validated
 * payload — not a second store.
 *
 * Provenance is a type here too. A message is at most a claim: `verified`
 * and `critic_approved` never travel on a channel, because only the
 * critic/verifier path establishes them. An agent's message is `claimed` by
 * the node that sent it; the host loop's is `generated`; the operator's is
 * `claimed`.
 */
import type { Provenance } from "../types.js";
import type { RuntimeValidationResult } from "../runtime-contracts.js";
import { validateC2Command, validateC2Reply, type C2Command, type C2Reply } from "./c2.js";
import { COMMS_ROLE_TIER, isArborAgentName, type CommsPrincipal } from "./roles.js";
import { checkEnum, checkId, checkIdList, checkKeys, checkText, isRecord, result, type Violations } from "./validate.js";

export const COMMS_CHANNELS = Object.freeze(["thread", "commons", "c2"] as const);
export type CommsChannel = (typeof COMMS_CHANNELS)[number];

export const COMMS_ENVELOPE_SCHEMA_VERSION = 1 as const;

/** Thread and commons text bound, in UTF-8 bytes (matches the existing 8 KiB bus cap). */
export const COMMS_TEXT_MAX_BYTES = 8192;
/** Most direct recipients or @mentions one envelope may carry. */
export const COMMS_MAX_ADDRESSEES = 32;

export type CommsPayload =
  | { type: "text"; text: string }
  | { type: "post"; text: string; reply_to?: string }
  | { type: "command"; command: C2Command }
  | { type: "reply"; reply: C2Reply };

export interface CommsEnvelope {
  schema_version: typeof COMMS_ENVELOPE_SCHEMA_VERSION;
  channel: CommsChannel;
  /** Thread id for `thread` and `c2`; room id for `commons`. */
  conversation_id: string;
  /** Host-resolved from the session; never taken from model input. */
  sender: CommsPrincipal;
  /** Node ids addressed directly. Empty on commons (the room is the address). */
  recipients: readonly string[];
  /** @mentioned node ids. Commons only; each must be a room member (`mentionsAreMembers`). */
  mentions: readonly string[];
  provenance: Provenance;
  /**
   * True when the payload carries free text that must pass the host's
   * redaction before it is appended (redaction on write). It must equal
   * `payloadCarriesFreeText(payload)`; understating it is refused.
   */
  redaction_required: boolean;
  payload: CommsPayload;
}

/** True when any field of the payload is author-written free text. */
export function payloadCarriesFreeText(payload: CommsPayload): boolean {
  switch (payload.type) {
    case "text":
    case "post":
      return true;
    case "command": {
      const command = payload.command;
      switch (command.kind) {
        case "task.assign":
        case "task.amend":
          return true;
        case "task.halt":
          return command.note !== undefined;
        case "status.request":
          return false;
        case "clarification.answer":
          return command.content !== undefined && Object.values(command.content).some((value) => typeof value === "string");
      }
      break;
    }
    case "reply": {
      const reply = payload.reply;
      if (reply.kind === "ack") return false;
      if (reply.kind === "progress") return reply.note !== undefined;
      return true;
    }
  }
  return true;
}

function checkSender(value: unknown, path: string, out: Violations): void {
  if (!isRecord(value)) { out.push({ path, message: "must be an object" }); return; }
  checkEnum(value.kind, ["operator", "host_loop", "agent"], `${path}.kind`, out);
  if (value.kind === "agent") {
    checkKeys(value, ["kind", "agent", "node_id"], [], path, out);
    if (!isArborAgentName(value.agent)) out.push({ path: `${path}.agent`, message: "must be a botanical agent name" });
    checkId(value.node_id, `${path}.node_id`, out);
  } else checkKeys(value, ["kind"], [], path, out);
}

function checkProvenance(sender: CommsPrincipal, provenance: unknown, path: string, out: Violations): void {
  if (!isRecord(provenance)) { out.push({ path, message: "must be a provenance object" }); return; }
  if (provenance.tag === "verified" || provenance.tag === "critic_approved") {
    out.push({ path, message: `${String(provenance.tag)} provenance never travels on a channel; only the critic/verifier path establishes it` });
    return;
  }
  if (sender.kind === "host_loop") {
    if (provenance.tag !== "generated" || typeof provenance.generator !== "string" || provenance.generator.length === 0 || typeof provenance.input_hash !== "string") {
      out.push({ path, message: "a host-loop message must be generated provenance" });
    }
    return;
  }
  if (provenance.tag !== "claimed" || typeof provenance.claimant !== "string" || provenance.claimant.trim().length === 0) {
    out.push({ path, message: "an agent or operator message must be claimed provenance" });
    return;
  }
  if (sender.kind === "agent" && provenance.claimant !== sender.node_id) out.push({ path: `${path}.claimant`, message: "must be the sending node" });
}

function checkPayload(channel: CommsChannel, value: unknown, path: string, out: Violations): CommsPayload | null {
  if (!isRecord(value)) { out.push({ path, message: "must be an object" }); return null; }
  const expected = channel === "thread" ? ["text"] : channel === "commons" ? ["post"] : ["command", "reply"];
  checkEnum(value.type, expected, `${path}.type`, out);
  switch (value.type) {
    case "text":
      checkKeys(value, ["type", "text"], [], path, out);
      checkText(value.text, `${path}.text`, COMMS_TEXT_MAX_BYTES, out);
      break;
    case "post":
      checkKeys(value, ["type", "text"], ["reply_to"], path, out);
      checkText(value.text, `${path}.text`, COMMS_TEXT_MAX_BYTES, out);
      if (value.reply_to !== undefined) checkId(value.reply_to, `${path}.reply_to`, out);
      break;
    case "command": {
      checkKeys(value, ["type", "command"], [], path, out);
      const command = validateC2Command(value.command);
      if (!command.ok) out.push(...command.violations.map((violation) => ({ path: `${path}.${violation.path}`, message: violation.message })));
      break;
    }
    case "reply": {
      checkKeys(value, ["type", "reply"], [], path, out);
      const reply = validateC2Reply(value.reply);
      if (!reply.ok) out.push(...reply.violations.map((violation) => ({ path: `${path}.${violation.path}`, message: violation.message })));
      break;
    }
    default:
      return null;
  }
  return value as unknown as CommsPayload;
}

/**
 * Validate a channel envelope. Closed at every level: unknown fields, an
 * unknown channel, a payload that does not belong to its channel, or a
 * provenance stronger than a claim are all refused.
 *
 * Shape rules per channel:
 * - `thread`: a `text` payload to exactly one recipient; no mentions.
 * - `commons`: a `post` payload addressed to the room (no recipients); mentions allowed.
 * - `c2` command: exactly one recipient (the target); no mentions. A critic
 *   or a specialist sender is refused here already, before any edge check.
 * - `c2` reply: sent by an agent (the target) to at most one node (the
 *   issuer; none when the issuer is the operator or host loop); no mentions.
 *   A `done` reply's claimant must be the sending node.
 */
export function validateCommsEnvelope(value: unknown): RuntimeValidationResult<CommsEnvelope> {
  const out: Violations = [];
  const path = "envelope";
  if (!isRecord(value)) return result<CommsEnvelope>(value, [{ path, message: "must be an object" }]);
  checkKeys(value, ["schema_version", "channel", "conversation_id", "sender", "recipients", "mentions", "provenance", "redaction_required", "payload"], [], path, out);
  if (value.schema_version !== COMMS_ENVELOPE_SCHEMA_VERSION) out.push({ path: `${path}.schema_version`, message: `must be ${COMMS_ENVELOPE_SCHEMA_VERSION}` });
  checkEnum(value.channel, COMMS_CHANNELS, `${path}.channel`, out);
  checkId(value.conversation_id, `${path}.conversation_id`, out);
  checkSender(value.sender, `${path}.sender`, out);
  checkIdList(value.recipients, `${path}.recipients`, COMMS_MAX_ADDRESSEES, out);
  checkIdList(value.mentions, `${path}.mentions`, COMMS_MAX_ADDRESSEES, out);
  if (typeof value.redaction_required !== "boolean") out.push({ path: `${path}.redaction_required`, message: "must be a boolean" });
  if (out.length > 0) return result<CommsEnvelope>(value, out);

  const channel = value.channel as CommsChannel;
  const sender = value.sender as CommsPrincipal;
  const recipients = value.recipients as string[];
  const mentions = value.mentions as string[];
  checkProvenance(sender, value.provenance, `${path}.provenance`, out);
  const payload = checkPayload(channel, value.payload, `${path}.payload`, out);
  if (out.length > 0 || payload === null) return result<CommsEnvelope>(value, out);

  if (channel !== "commons" && mentions.length > 0) out.push({ path: `${path}.mentions`, message: "are allowed only on commons" });
  if (sender.kind === "agent" && recipients.includes(sender.node_id)) out.push({ path: `${path}.recipients`, message: "must not address the sender" });
  switch (payload.type) {
    case "text":
      if (recipients.length !== 1) out.push({ path: `${path}.recipients`, message: "a thread message has exactly one recipient" });
      break;
    case "post":
      if (recipients.length !== 0) out.push({ path: `${path}.recipients`, message: "a commons post is addressed to its room, not to recipients" });
      break;
    case "command":
      if (recipients.length !== 1) out.push({ path: `${path}.recipients`, message: "a command has exactly one target" });
      if (sender.kind === "agent" && COMMS_ROLE_TIER[sender.agent] !== "orchestrator") out.push({ path: `${path}.sender`, message: `${sender.agent} never issues commands` });
      break;
    case "reply":
      if (sender.kind !== "agent") out.push({ path: `${path}.sender`, message: "a reply is sent by the command's target node" });
      if (recipients.length > 1) out.push({ path: `${path}.recipients`, message: "a reply goes to at most the issuing node" });
      if (sender.kind === "agent" && payload.reply.kind === "done" && payload.reply.provenance.claimant !== sender.node_id) {
        out.push({ path: `${path}.payload.reply.provenance.claimant`, message: "must be the sending node" });
      }
      break;
  }
  if (value.redaction_required !== payloadCarriesFreeText(payload)) {
    out.push({ path: `${path}.redaction_required`, message: `must be ${payloadCarriesFreeText(payload)} for this payload` });
  }
  return result<CommsEnvelope>(value, out);
}
