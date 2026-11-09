import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireWriterLock, type WriterLockHandle } from "@arbor/core";
import type { RemoteRuntimeIngress } from "./remote-ingress.js";
import type { RemoteTransportEnvelope } from "./remote-transport-contracts.js";
import { DistributedControlClient, type DistributedControlResult, type DistributedMessageRecord } from "./distributed-control-plane.js";

type RoutedMessage = DistributedMessageRecord;
export type DistributedRemoteResult = { correlation_id: string; sender_host_id: string; result: unknown };
type Receipt = { message: RoutedMessage; phase: "executing" | "executed" | "result_received" | "acknowledged" | "dead_letter"; result: unknown | null; attempts: number; updated_at: string; error: string | null };
type Outbox = { outbox_id: string; source_message_id: string; recipient_host_id: string; correlation_id: string; payload: unknown; sent_at: string | null; attempts: number; last_error: string | null };
type DurableResult = { source_message_id: string; value: DistributedRemoteResult };
type DeadLetter = { message_id: string; kind: string; reason: string; recorded_at: string };
type Journal = { version: 1; consumer_id: string; receipts: Record<string, Receipt>; outbox: Outbox[]; results: DurableResult[]; dead_letters: DeadLetter[]; last_error: string | null; updated_at: string };

/** Crash-convergent bridge between coordinator delivery and signed runtime ingress. */
export class DistributedRemoteBridge {
  private polling: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private readonly interval: number;
  private readonly visibility: number;
  private readonly path: string;
  private readonly lock: WriterLockHandle;
  private journal: Journal;

  constructor(private readonly options: {
    client: DistributedControlClient;
    ingress: Pick<RemoteRuntimeIngress, "dispatchTransport">;
    persistence_dir: string;
    poll_interval_ms?: number;
    visibility_timeout_ms?: number;
    max_local_attempts?: number;
    max_journal_records?: number;
    on_result?: (result: DistributedRemoteResult) => void;
  }) {
    this.interval = options.poll_interval_ms ?? 1_000;
    this.visibility = options.visibility_timeout_ms ?? 30_000;
    if (!Number.isSafeInteger(this.interval) || this.interval < 50 || this.interval > 60_000) throw new Error("distributed remote poll interval must be 50 through 60000 ms");
    if (!Number.isSafeInteger(this.visibility) || this.visibility < 100 || this.visibility > 3_600_000) throw new Error("distributed remote visibility timeout must be 100 through 3600000 ms");
    if (!options.persistence_dir?.trim()) throw new Error("distributed remote bridge requires persistence_dir");
    mkdirSync(options.persistence_dir, { recursive: true });
    const acquired = acquireWriterLock(options.persistence_dir, { holder: `distributed-remote-bridge:${options.client.identity()}` });
    if (!acquired.ok) throw new Error(acquired.detail);
    this.lock = acquired.lock;
    this.path = join(options.persistence_dir, "distributed-remote-bridge.json");
    this.journal = this.restore();
    this.persist();
  }

  async send(recipientHostId: string, envelope: RemoteTransportEnvelope, correlationId = `remote:${randomUUID()}`): Promise<DistributedControlResult<RoutedMessage>> {
    return this.options.client.request("POST", "/v1/messages", { request_id: `send:${correlationId}`, recipient_host_id: recipientHostId, kind: "remote.transport.command", payload: envelope as never, correlation_id: correlationId });
  }

  async drain(): Promise<{ processed: number; failed: number }> {
    if (this.draining) return { processed: 0, failed: 0 };
    this.draining = true; let processed = 0, failed = 0;
    try {
      failed += await this.flushOutbox();
      const inbox = await this.options.client.request<{ messages: RoutedMessage[] }>("POST", "/v1/inbox/claim", { request_id: `claim:${randomUUID()}`, consumer_id: this.journal.consumer_id, after_sequence: 0, limit: 100, visibility_timeout_ms: this.visibility });
      if (!inbox.ok) { this.recordError(inbox.summary); return { processed, failed: failed + 1 }; }
      for (const message of inbox.value.messages) {
        try { await this.process(message); processed++; }
        catch (error) { failed++; await this.failed(message, error instanceof Error ? error.message : "bridge processing failed"); }
      }
      failed += await this.flushOutbox();
      this.compact(); this.persist();
      return { processed, failed };
    } finally { this.draining = false; }
  }

  takeResults(): DistributedRemoteResult[] { const values = this.journal.results.map((item) => structuredClone(item.value)); this.journal.results = []; this.compact(); this.persist(); return values; }
  deadLetters(): readonly DeadLetter[] { return structuredClone(this.journal.dead_letters); }
  health(): { status: "ready" | "degraded"; consumer_id: string; receipts: number; outbox_pending: number; results_pending: number; dead_letters: number; last_error: string | null; draining: boolean } { return { status: this.journal.last_error || this.journal.dead_letters.length ? "degraded" : "ready", consumer_id: this.journal.consumer_id, receipts: Object.keys(this.journal.receipts).length, outbox_pending: this.journal.outbox.filter((item) => item.sent_at === null).length, results_pending: this.journal.results.length, dead_letters: this.journal.dead_letters.length, last_error: this.journal.last_error, draining: this.draining }; }
  start(): void { if (this.polling) return; this.polling = setInterval(() => { void this.drain().catch((error) => this.recordError(error instanceof Error ? error.message : "poll failed")); }, this.interval); this.polling.unref?.(); }
  stop(): void { if (this.polling) clearInterval(this.polling); this.polling = null; }
  close(): void { this.stop(); this.persist(); this.lock.release(); }

  private async process(message: RoutedMessage): Promise<void> {
    const previous = this.journal.receipts[message.message_id];
    if (previous?.phase === "acknowledged") { await this.ack(message); return; }
    if (previous?.phase === "executing") { await this.quarantine(message, "execution outcome is uncertain after process interruption; duplicate dispatch refused"); return; }
    if (message.kind === "remote.transport.command") {
      let receipt = previous;
      if (!receipt) {
        receipt = { message: structuredClone(message), phase: "executing", result: null, attempts: 0, updated_at: new Date().toISOString(), error: null };
        this.journal.receipts[message.message_id] = receipt; this.persist();
        const result = await this.options.ingress.dispatchTransport(message.payload, () => undefined);
        receipt.result = result; receipt.phase = "executed"; receipt.updated_at = new Date().toISOString();
        if (!this.journal.outbox.some((item) => item.source_message_id === message.message_id)) this.journal.outbox.push({ outbox_id: `out:${message.message_id}`, source_message_id: message.message_id, recipient_host_id: message.sender_host_id, correlation_id: message.correlation_id ?? message.message_id, payload: result, sent_at: null, attempts: 0, last_error: null });
        this.persist();
      }
      const outgoing = this.journal.outbox.find((item) => item.source_message_id === message.message_id);
      if (!outgoing || outgoing.sent_at === null) throw new Error("durable response remains queued");
      await this.ack(message); receipt.phase = "acknowledged"; receipt.updated_at = new Date().toISOString(); this.persist(); return;
    }
    if (message.kind === "remote.transport.result") {
      if (!previous) {
        const value = { correlation_id: message.correlation_id ?? message.message_id, sender_host_id: message.sender_host_id, result: structuredClone(message.payload) };
        this.journal.receipts[message.message_id] = { message: structuredClone(message), phase: "result_received", result: value, attempts: 0, updated_at: new Date().toISOString(), error: null };
        if (!this.journal.results.some((item) => item.source_message_id === message.message_id)) this.journal.results.push({ source_message_id: message.message_id, value });
        this.persist();
        try { this.options.on_result?.(structuredClone(value)); } catch (error) { this.recordError(error instanceof Error ? error.message : "result callback failed"); }
      }
      await this.ack(message); this.journal.receipts[message.message_id]!.phase = "acknowledged"; this.journal.receipts[message.message_id]!.updated_at = new Date().toISOString(); this.persist(); return;
    }
    await this.quarantine(message, "unsupported distributed remote message kind");
  }

  private async flushOutbox(): Promise<number> {
    let failed = 0;
    for (const outgoing of this.journal.outbox.filter((item) => item.sent_at === null)) {
      const receipt = this.journal.receipts[outgoing.source_message_id];
      const sent = await this.options.client.request("POST", "/v1/messages", { request_id: `result:${outgoing.source_message_id}`, recipient_host_id: outgoing.recipient_host_id, kind: "remote.transport.result", payload: outgoing.payload as never, correlation_id: outgoing.correlation_id });
      outgoing.attempts++;
      if (sent.ok) { outgoing.sent_at = new Date().toISOString(); outgoing.last_error = null; }
      else { failed++; outgoing.last_error = sent.summary; if (receipt) { receipt.attempts++; receipt.error = sent.summary; } this.recordError(sent.summary, false); }
      this.persist();
    }
    return failed;
  }

  private async ack(message: RoutedMessage): Promise<void> { const ack = await this.options.client.request("POST", "/v1/messages/ack", { request_id: `ack:${message.message_id}`, message_id: message.message_id, claim_id: message.claim_id }); if (!ack.ok) throw new Error(ack.summary); }
  private async failed(message: RoutedMessage, reason: string): Promise<void> { const receipt = this.journal.receipts[message.message_id] ?? { message: structuredClone(message), phase: "executing" as const, result: null, attempts: 0, updated_at: new Date().toISOString(), error: null }; receipt.attempts++; receipt.error = reason.slice(0, 512); receipt.updated_at = new Date().toISOString(); this.journal.receipts[message.message_id] = receipt; this.recordError(reason, false); if (receipt.attempts >= (this.options.max_local_attempts ?? 3)) await this.quarantine(message, reason); else { await this.options.client.request("POST", "/v1/messages/fail", { request_id: `fail:${message.message_id}:${receipt.attempts}`, message_id: message.message_id, claim_id: message.claim_id, error: reason.slice(0, 512) }); this.persist(); } }
  private async quarantine(message: RoutedMessage, reason: string): Promise<void> { const receipt = this.journal.receipts[message.message_id] ?? { message: structuredClone(message), phase: "dead_letter" as const, result: null, attempts: 0, updated_at: new Date().toISOString(), error: null }; receipt.phase = "dead_letter"; receipt.error = reason.slice(0, 512); receipt.updated_at = new Date().toISOString(); this.journal.receipts[message.message_id] = receipt; if (!this.journal.dead_letters.some((item) => item.message_id === message.message_id)) this.journal.dead_letters.push({ message_id: message.message_id, kind: message.kind, reason: reason.slice(0, 512), recorded_at: new Date().toISOString() }); this.recordError(reason, false); await this.options.client.request("POST", "/v1/messages/fail", { request_id: `dead:${message.message_id}`, message_id: message.message_id, claim_id: message.claim_id, error: reason.slice(0, 512) }); this.persist(); }
  /** Annotates the journal with a failure and reports whether the annotation reached disk. Total by contract: a write that cannot land is itself recorded, never thrown, so the poll timer's rejection handler cannot escape as an unhandled rejection. */
  private recordError(reason: string, persist = true): boolean { this.journal.last_error = reason.slice(0, 512); this.journal.updated_at = new Date().toISOString(); if (!persist) return false; try { this.persist(); return true; } catch (error) { this.journal.last_error = `bridge journal write failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512); return false; } }
  private compact(): void { const max = this.options.max_journal_records ?? 10_000; if (!Number.isSafeInteger(max) || max < 100 || max > 1_000_000) throw new Error("max_journal_records is outside the supported range"); const terminal = Object.entries(this.journal.receipts).filter(([, item]) => item.phase === "acknowledged").sort(([, a], [, b]) => a.updated_at < b.updated_at ? -1 : 1); for (const [id] of terminal.slice(0, Math.max(0, terminal.length - max))) delete this.journal.receipts[id]; this.journal.outbox = this.journal.outbox.filter((item) => item.sent_at === null || this.journal.receipts[item.source_message_id] !== undefined).slice(-max); this.journal.dead_letters = this.journal.dead_letters.slice(-max); if (this.journal.results.length > max) { this.journal.results = this.journal.results.slice(-max); this.recordError("durable result quota compacted oldest unconsumed results", false); } }
  private restore(): Journal { if (!existsSync(this.path)) return { version: 1, consumer_id: `bridge:${this.options.client.identity()}:${randomUUID()}`, receipts: {}, outbox: [], results: [], dead_letters: [], last_error: null, updated_at: new Date().toISOString() }; const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8")); if (!validJournal(parsed)) throw new Error("distributed remote bridge journal is malformed"); return parsed; }
  private persist(): void { durableWrite(this.path, `${JSON.stringify(this.journal)}\n`); }
}

function validJournal(value: unknown): value is Journal { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const item = value as Record<string, unknown>; if (item.version !== 1 || typeof item.consumer_id !== "string" || !item.consumer_id || !item.receipts || typeof item.receipts !== "object" || !Array.isArray(item.outbox) || !Array.isArray(item.results) || !Array.isArray(item.dead_letters) || typeof item.updated_at !== "string") return false; for (const receipt of Object.values(item.receipts as Record<string, unknown>)) if (!receipt || typeof receipt !== "object" || !["executing", "executed", "result_received", "acknowledged", "dead_letter"].includes(String((receipt as Record<string, unknown>).phase))) return false; return true; }
// ponytail: mkdir on every write, as acquireWriterLock does. Ceiling: a post-teardown write resurrects the directory without its writer-lock file; re-validate on lock loss if that must be prevented.
function durableWrite(path: string, data: string): void { const temporary = `${path}.${randomUUID()}.tmp`; let fd: number | null = null; try { mkdirSync(dirname(path), { recursive: true }); fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = null; renameSync(temporary, path); const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } } finally { if (fd !== null) closeSync(fd); } }
