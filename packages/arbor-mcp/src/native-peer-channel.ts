import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { CampaignManager } from "./manager.js";
import type { NativePeerCapability, NativePeerCapabilityTier, NativePeerGrantCommand, NativePeerHistoryQuery, NativePeerQueryCommand, NativePeerReplyCommand, NativePeerTrustedCaller } from "./native-peer-channel-contracts.js";

export interface NativePeerRelationshipGrant {
  readonly schema_version: 1; readonly grant_id: string; readonly campaign_id: string; readonly parent_node_id: string;
  readonly left_node_id: string; readonly right_node_id: string; readonly capabilities: readonly NativePeerCapability[];
  readonly capability_tier: NativePeerCapabilityTier; readonly max_disclosure_bytes: number; readonly expires_at: string;
  readonly granted_at: string; readonly provenance: NativePeerGrantCommand["provenance"];
}
export type NativePeerMutationResult = { readonly accepted: true; readonly message_id?: string; readonly grant?: NativePeerRelationshipGrant; readonly escalation_id?: string }
  | { readonly accepted: false; readonly code: "grant_denied" | "scope_denied" | "capability_denied" | "expired" | "version_conflict" | "cycle_detected" | "not_found"; readonly reason: string; readonly escalation_id?: string };

/** An expired grant stays listed (and its conversation readable) this long, then is pruned on the next persist. */
const PEER_GRANT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Corruption guard only; real growth is bounded by pruning, never by refusing to load. */
const PEER_GRANT_STORE_SANITY_LIMIT = 100_000;
const RANK: Readonly<Record<NativePeerCapabilityTier, number>> = { specialist: 0, critic: 1, auditor: 2, orchestrator: 3 };

export class NativePeerChannelService {
  private readonly grants = new Map<string, NativePeerRelationshipGrant>();
  private readonly file: string | null;
  constructor(private readonly manager: CampaignManager, options: { readonly persistence_dir?: string; readonly now?: () => Date } = {}) {
    this.file = options.persistence_dir ? join(options.persistence_dir, "native-peer-grants.json") : null;
    this.now = options.now ?? (() => new Date()); this.restore();
  }
  private readonly now: () => Date;
  list(campaignId?: string): readonly NativePeerRelationshipGrant[] { return Object.freeze([...this.grants.values()].filter((grant) => campaignId === undefined || grant.campaign_id === campaignId).sort((a, b) => a.grant_id.localeCompare(b.grant_id))); }

  /**
   * Host-owned provisioning for a real specialist dispatch. The caller can
   * name only the persisted campaign/node; every authority-bearing field is
   * fixed here and sibling/parent identities come from the manager graph.
   */
  provisionFromParentAuthority(campaignId: string, nodeId: string): readonly NativePeerRelationshipGrant[] {
    const snapshot = this.manager.getCampaignSnapshot(campaignId); const node = snapshot?.nodes.find((item) => item.id === nodeId); if (!snapshot || !node?.parent_id) return Object.freeze([]);
    const siblings = snapshot.nodes.filter((item) => item.parent_id === node.parent_id && item.id !== nodeId).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 16); const bucket = this.now().toISOString().slice(0, 10).replaceAll("-", ""); const expires = new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString(); const provisioned: NativePeerRelationshipGrant[] = [];
    for (const sibling of siblings) { const [left, right] = [nodeId, sibling.id].sort(); const grantId = `peer-auto-${createHash("sha256").update(`${campaignId}\0${node.parent_id}\0${left}\0${right}\0${bucket}`).digest("hex").slice(0, 24)}`; const existing = this.grants.get(grantId); if (existing) { provisioned.push(existing); continue; } const result = this.grant({ kind: "peer.grant", grant_id: grantId, campaign_id: campaignId, parent_node_id: node.parent_id, left_node_id: left!, right_node_id: right!, capabilities: ["query", "reply"], capability_tier: "specialist", max_disclosure_bytes: 4096, expires_at: expires, provenance: { tag: "generated", generator: "native-parent-peer-provisioner-v1", input_hash: `sha256:${createHash("sha256").update(`${campaignId}\0${node.parent_id}\0${left}\0${right}\0${bucket}`).digest("hex")}` } }, { kind: "parent", actor_id: "native-parent-peer-provisioner-v1", campaign_id: campaignId, node_id: node.parent_id, capability_tier: "orchestrator" }); if (result.accepted && result.grant) provisioned.push(result.grant); }
    return Object.freeze(provisioned);
  }

  grant(command: NativePeerGrantCommand, caller: NativePeerTrustedCaller): NativePeerMutationResult {
    if (caller.kind !== "parent" || caller.campaign_id !== command.campaign_id || caller.node_id !== command.parent_node_id) return { accepted: false, code: "grant_denied", reason: "peer relationship grants require the authenticated campaign parent" };
    const existing = this.grants.get(command.grant_id);
    if (existing) return JSON.stringify(projectGrantCommand(existing)) === JSON.stringify(command) ? { accepted: true, grant: existing } : { accepted: false, code: "grant_denied", reason: "grant identity conflicts with an existing relationship" };
    const snapshot = this.manager.getCampaignSnapshot(command.campaign_id);
    const left = snapshot?.nodes.find((node) => node.id === command.left_node_id); const right = snapshot?.nodes.find((node) => node.id === command.right_node_id);
    if (!left || !right || left.parent_id !== command.parent_node_id || right.parent_id !== command.parent_node_id) return { accepted: false, code: "grant_denied", reason: "grant endpoints must be existing siblings under the declared parent" };
    if (Date.parse(command.expires_at) <= this.now().getTime()) return { accepted: false, code: "expired", reason: "grant expiry must be in the future" };
    const grant = Object.freeze({ schema_version: 1 as const, ...command, kind: undefined, capabilities: Object.freeze([...command.capabilities]), granted_at: this.now().toISOString() });
    const { kind: _kind, ...stored } = grant as typeof grant & { kind?: undefined }; const normalized = Object.freeze(stored) as NativePeerRelationshipGrant;
    this.grants.set(normalized.grant_id, normalized); this.persist(); return { accepted: true, grant: normalized };
  }

  query(command: NativePeerQueryCommand, idempotencyKey: string, at: string, caller: NativePeerTrustedCaller): NativePeerMutationResult {
    const checked = this.check(command.grant_id, command.from_node_id, command.to_node_id, "query", command.content, caller); if (!checked.ok) return checked.result;
    const version = this.version(checked.grant); if (command.expected_version !== version) return { accepted: false, code: "version_conflict", reason: `expected ${command.expected_version}, current ${version}` };
    if (this.createsWaitCycle(checked.grant.campaign_id, command.from_node_id, command.to_node_id)) {
      const escalation_id = this.escalate(checked.grant, command.from_node_id, "Peer query cycle detected and refused", `peer-cycle:${command.query_id}`, at);
      return { accepted: false, code: "cycle_detected", reason: "query would create a peer wait cycle", escalation_id };
    }
    const message_id = this.manager.recordBusMessage({
      campaign_id: checked.grant.campaign_id, node_id: command.from_node_id, author_node_id: command.from_node_id, recipient_node_id: command.to_node_id, other_recipient_node_ids: [],
      kind: "clarify", payload: { content: command.content, provenance: { tag: "claimed", claimant: command.from_node_id } }, capability_tier: checked.grant.capability_tier,
      trigger_turn: true, as_of: at, correlation_id: `peer-query:${command.query_id}`, idempotency_key: idempotencyKey,
      acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: conversation(checked.grant.grant_id), parent_communication_id: null,
      intent: "request", reply_to_communication_id: null, ack_required: true, deadline_at: null,
    });
    return { accepted: true, message_id };
  }

  reply(command: NativePeerReplyCommand, idempotencyKey: string, at: string, caller: NativePeerTrustedCaller): NativePeerMutationResult {
    const checked = this.check(command.grant_id, command.from_node_id, command.to_node_id, "reply", command.content, caller); if (!checked.ok) return checked.result;
    const version = this.version(checked.grant); if (command.expected_version !== version) return { accepted: false, code: "version_conflict", reason: `expected ${command.expected_version}, current ${version}` };
    const source = this.messages(checked.grant).find((message) => message.id === command.query_message_id);
    if (!source || source.kind !== "clarify" || source.author_node_id !== command.to_node_id || !source.recipient_node_ids.includes(command.from_node_id)) return { accepted: false, code: "not_found", reason: "query_message_id is not an open query addressed to this peer" };
    const message_id = this.manager.recordBusMessage({
      campaign_id: checked.grant.campaign_id, node_id: command.from_node_id, author_node_id: command.from_node_id, recipient_node_id: command.to_node_id, other_recipient_node_ids: [],
      kind: "reply", payload: { content: command.content, provenance: { tag: "claimed", claimant: command.from_node_id } }, capability_tier: checked.grant.capability_tier,
      trigger_turn: true, as_of: at, correlation_id: source.correlation_id ?? `peer:${checked.grant.grant_id}`, idempotency_key: idempotencyKey,
      acknowledges_communication_id: command.query_message_id, retracts_communication_id: null, conversation_id: conversation(checked.grant.grant_id), parent_communication_id: command.query_message_id,
      intent: "response", reply_to_communication_id: command.query_message_id, ack_required: false, deadline_at: null,
    });
    const escalation_id = command.agrees ? undefined : this.escalate(checked.grant, command.from_node_id, "Peer disagreement requires parent resolution", `peer-disagreement:${command.query_message_id}`, at);
    return { accepted: true, message_id, ...(escalation_id === undefined ? {} : { escalation_id }) };
  }

  history(query: NativePeerHistoryQuery, caller: NativePeerTrustedCaller): { readonly grant: NativePeerRelationshipGrant; readonly version: string; readonly messages: readonly unknown[]; readonly unresolved_queries: number } | null {
    const grant = this.grants.get(query.grant_id); if (!grant || caller.campaign_id !== grant.campaign_id || !endpoints(grant).has(caller.node_id) && caller.node_id !== grant.parent_node_id) return null;
    const tier = caller.kind === "parent" ? "orchestrator" : RANK[caller.capability_tier] > RANK[grant.capability_tier] ? grant.capability_tier : caller.capability_tier;
    const bus = this.manager.getConversationBus(grant.campaign_id, { conversation_id: conversation(grant.grant_id), tier, limit: query.limit ?? 100 });
    const messages = bus.conversations.get(conversation(grant.grant_id)) ?? [];
    return Object.freeze({ grant, version: messages.at(-1)?.id ?? "origin", messages: Object.freeze([...messages]), unresolved_queries: this.outstanding(grant).length });
  }

  private check(grantId: string, from: string, to: string, capability: NativePeerCapability, content: string, caller: NativePeerTrustedCaller): { ok: true; grant: NativePeerRelationshipGrant } | { ok: false; result: NativePeerMutationResult } {
    const grant = this.grants.get(grantId); if (!grant) return { ok: false, result: { accepted: false, code: "not_found", reason: "peer relationship grant was not found" } };
    if (caller.kind !== "peer" || caller.campaign_id !== grant.campaign_id || caller.node_id !== from) return { ok: false, result: { accepted: false, code: "scope_denied", reason: "peer command is outside the authenticated caller scope" } };
    if (Date.parse(grant.expires_at) <= this.now().getTime()) return { ok: false, result: { accepted: false, code: "expired", reason: "peer relationship grant expired" } };
    if (!endpoints(grant).has(from) || !endpoints(grant).has(to) || from === to) return { ok: false, result: { accepted: false, code: "scope_denied", reason: "message endpoints exceed the granted sibling relationship" } };
    if (!grant.capabilities.includes(capability)) return { ok: false, result: { accepted: false, code: "capability_denied", reason: `${capability} is not granted` } };
    if (Buffer.byteLength(content, "utf8") > grant.max_disclosure_bytes) return { ok: false, result: { accepted: false, code: "capability_denied", reason: "message exceeds the grant disclosure bound" } };
    return { ok: true, grant };
  }
  private messages(grant: NativePeerRelationshipGrant): readonly any[] { return this.manager.getConversationBus(grant.campaign_id, { conversation_id: conversation(grant.grant_id), tier: "orchestrator", limit: 500 }).conversations.get(conversation(grant.grant_id)) ?? []; }
  private version(grant: NativePeerRelationshipGrant): string { return this.messages(grant).at(-1)?.id ?? "origin"; }
  private outstanding(grant: NativePeerRelationshipGrant): Array<{ id: string; from: string; to: string }> {
    const messages = this.messages(grant); const closed = new Set(messages.filter((message) => message.kind === "reply").map((message) => message.reply_to_communication_id ?? message.acknowledges_communication_id).filter(Boolean));
    return messages.filter((message) => message.kind === "clarify" && !closed.has(message.id)).map((message) => ({ id: message.id, from: message.author_node_id, to: message.recipient_node_ids[0] ?? "" }));
  }
  private createsWaitCycle(campaignId: string, from: string, to: string): boolean {
    const graph = new Map<string, Set<string>>();
    for (const grant of this.list(campaignId)) for (const edge of this.outstanding(grant)) {
      const next = graph.get(edge.from) ?? new Set<string>(); next.add(edge.to); graph.set(edge.from, next);
    }
    const pending = [to]; const visited = new Set<string>();
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (node === from) return true;
      if (visited.has(node)) continue;
      visited.add(node); for (const next of graph.get(node) ?? []) pending.push(next);
    }
    return false;
  }
  private escalate(grant: NativePeerRelationshipGrant, author: string, content: string, key: string, at: string): string {
    return this.manager.recordBusMessage({ campaign_id: grant.campaign_id, node_id: author, author_node_id: author, recipient_node_id: grant.parent_node_id, other_recipient_node_ids: [], kind: "report", payload: { content, provenance: { tag: "generated", generator: "native-peer-channel", input_hash: key } }, capability_tier: "orchestrator", trigger_turn: true, as_of: at, correlation_id: `peer-escalation:${grant.grant_id}`, idempotency_key: key, acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: conversation(grant.grant_id), parent_communication_id: null, intent: "needs_attention", reply_to_communication_id: null, ack_required: true, deadline_at: null });
  }
  /**
   * Load the persisted grants. Expired grants past the retention window are
   * dropped (and the store rewritten) instead of counting against a size cap:
   * grants are auto-provisioned per node per day and were never pruned, so the
   * former hard `> 256` refusal turned ordinary accumulation into a boot
   * failure of the whole runtime. Only a structurally invalid store throws.
   */
  private restore(): void {
    if (!this.file || !existsSync(this.file)) return;
    const value = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
    if (!Array.isArray(value) || value.length > PEER_GRANT_STORE_SANITY_LIMIT) throw new Error("native peer grant store is malformed");
    const cutoff = this.now().getTime() - PEER_GRANT_RETENTION_MS;
    let pruned = false;
    for (const item of value as NativePeerRelationshipGrant[]) {
      if (item.schema_version !== 1 || this.grants.has(item.grant_id)) throw new Error("native peer grant store is malformed");
      if (Date.parse(item.expires_at) <= cutoff) { pruned = true; continue; }
      this.grants.set(item.grant_id, Object.freeze({ ...item, capabilities: Object.freeze([...item.capabilities]) }));
    }
    if (pruned) this.persist();
  }
  /** Drop grants that expired longer ago than the retention window (history stays readable for a day after expiry). */
  private pruneExpired(): void {
    const cutoff = this.now().getTime() - PEER_GRANT_RETENTION_MS;
    for (const [id, grant] of this.grants) if (Date.parse(grant.expires_at) <= cutoff) this.grants.delete(id);
  }
  private persist(): void { this.pruneExpired(); if (!this.file) return; mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); const temporary = `${this.file}.tmp`; writeFileSync(temporary, `${JSON.stringify(this.list(), null, 2)}\n`, { mode: 0o600 }); renameSync(temporary, this.file); }
}
function endpoints(grant: NativePeerRelationshipGrant): Set<string> { return new Set([grant.left_node_id, grant.right_node_id]); }
function conversation(grantId: string): string { return `native-peer:${grantId}`; }
function projectGrantCommand(grant: NativePeerRelationshipGrant): Omit<NativePeerGrantCommand, "kind"> & { kind: "peer.grant" } { const { granted_at: _at, schema_version: _schema, ...rest } = grant; return { kind: "peer.grant", ...rest }; }
