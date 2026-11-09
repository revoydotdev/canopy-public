/** Protected, host-local replay material for native session continuity. */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { redactNativeText, type NativeConversationCheckpoint, type NativeConversationEntry } from "@arbor/harness";

export type HarnessSessionReplayOperation = "specialize" | "review";
export type HarnessSessionReplayKind = "resume" | "fork" | "respawn";

export interface HarnessSessionReplayCapsule {
  readonly version: 1;
  readonly session_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly operation: HarnessSessionReplayOperation;
  readonly captured_at: string;
  readonly checkpoint: NativeConversationCheckpoint;
  readonly content_hash: string;
}

export interface HarnessSessionReplayAdmission {
  readonly kind: HarnessSessionReplayKind;
  readonly source_session_id: string;
  readonly source_checkpoint: number;
  readonly new_session_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly operation: HarnessSessionReplayOperation;
  readonly prompt: string;
  readonly initial_history: readonly NativeConversationEntry[];
  readonly content_hash: string;
}

interface ReplayFile { readonly version: 1; readonly capsules: readonly HarnessSessionReplayCapsule[] }
export interface HarnessSessionReplayStoreOptions { readonly persistence_dir?: string; readonly clock?: () => string }

export class HarnessSessionReplayStore {
  private readonly file: string | null;
  private readonly clock: () => string;
  private readonly capsules = new Map<string, HarnessSessionReplayCapsule>();
  private readonly errors: string[] = [];

  constructor(options: HarnessSessionReplayStoreOptions = {}) {
    this.file = options.persistence_dir === undefined ? null : join(options.persistence_dir, "protected", "harness-session-replay.json");
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.restore();
  }

  diagnostics(): readonly string[] { return Object.freeze([...this.errors]); }
  isDurable(): boolean { return this.file !== null; }

  record(input: { readonly campaign_id: string; readonly node_id: string; readonly operation: HarnessSessionReplayOperation; readonly checkpoint: NativeConversationCheckpoint }): boolean {
    if (!validId(input.campaign_id) || !validId(input.node_id) || !validCheckpoint(input.checkpoint)) return false;
    const prior = this.capsules.get(input.checkpoint.session_id);
    if (prior !== undefined && prior.checkpoint.next_turn > input.checkpoint.next_turn) return false;
    const checkpoint = protectCheckpoint(input.checkpoint);
    const payload = Object.freeze({ version: 1 as const, session_id: checkpoint.session_id, campaign_id: input.campaign_id, node_id: input.node_id, operation: input.operation, captured_at: this.clock(), checkpoint });
    const capsule = Object.freeze({ ...payload, content_hash: digest(payload) });
    if (prior !== undefined && prior.checkpoint.next_turn === capsule.checkpoint.next_turn && prior.content_hash === capsule.content_hash) return true;
    const next = new Map(this.capsules); next.set(capsule.session_id, capsule);
    if (!this.persist([...next.values()])) return false;
    this.capsules.set(capsule.session_id, capsule);
    return true;
  }

  latest(sessionId: string): HarnessSessionReplayCapsule | null {
    const capsule = this.capsules.get(sessionId);
    return capsule === undefined ? null : structuredClone(capsule);
  }

  admit(input: { readonly kind: HarnessSessionReplayKind; readonly source_session_id: string; readonly new_session_id?: string }): HarnessSessionReplayAdmission | null {
    const source = this.capsules.get(input.source_session_id);
    if (source === undefined || !validId(input.new_session_id ?? "generated")) return null;
    const newSessionId = input.new_session_id ?? `${input.kind}:${source.session_id}:${randomUUID()}`;
    return Object.freeze({
      kind: input.kind, source_session_id: source.session_id, source_checkpoint: source.checkpoint.captured_sequence,
      new_session_id: newSessionId, campaign_id: source.campaign_id, node_id: source.node_id, operation: source.operation,
      // Evidence references name entries in the source context manager. A
      // fresh session must not inherit those identifiers as authority; the
      // replayed text remains useful context while new tool intents must cite
      // facts admitted into the new manager.
      prompt: source.checkpoint.prompt, initial_history: input.kind === "respawn" ? Object.freeze([]) : Object.freeze(source.checkpoint.history.map((entry) => Object.freeze({ kind: entry.kind, text: entry.text, ...(entry.tool === undefined ? {} : { tool: entry.tool }), ...(entry.call_id === undefined ? {} : { call_id: entry.call_id }) }))),
      content_hash: source.content_hash,
    });
  }

  private restore(): void {
    if (this.file === null) return;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.errors.push("protected replay store is unreadable");
      return;
    }
    if (!isReplayFile(parsed)) { this.errors.push("protected replay store is malformed"); return; }
    const restored = new Map<string, HarnessSessionReplayCapsule>();
    for (const capsule of parsed.capsules) {
      const { content_hash, ...payload } = capsule;
      if (!validCapsule(capsule) || digest(payload) !== content_hash) { this.errors.push("protected replay store failed integrity validation"); this.capsules.clear(); return; }
      const prior = restored.get(capsule.session_id);
      if (prior === undefined || prior.checkpoint.next_turn <= capsule.checkpoint.next_turn) restored.set(capsule.session_id, Object.freeze(capsule));
    }
    for (const [id, capsule] of restored) this.capsules.set(id, capsule);
  }

  private persist(capsules: readonly HarnessSessionReplayCapsule[]): boolean {
    if (this.file === null) return true;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); chmodSync(dirname(this.file), 0o700);
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ version: 1, capsules })}\n`, { encoding: "utf8", mode: 0o600 }); chmodSync(temporary, 0o600);
      renameSync(temporary, this.file); chmodSync(this.file, 0o600); return true;
    } catch { this.errors.push("protected replay store could not be persisted"); return false; }
  }
}

function protectCheckpoint(checkpoint: NativeConversationCheckpoint): NativeConversationCheckpoint {
  return Object.freeze({ ...checkpoint, prompt: redactNativeText(checkpoint.prompt), history: Object.freeze(checkpoint.history.map((entry) => Object.freeze({ ...entry, text: redactNativeText(entry.text), ...(entry.evidence === undefined ? {} : { evidence: Object.freeze(entry.evidence.map((ref) => Object.freeze({ entry_id: ref.entry_id, provenance: Object.freeze({ ...ref.provenance }) }))) }) }))) });
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function validId(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 1_024; }
function validCheckpoint(value: unknown): value is NativeConversationCheckpoint {
  return typeof value === "object" && value !== null && (value as NativeConversationCheckpoint).version === 1 && validId((value as NativeConversationCheckpoint).session_id)
    && Number.isSafeInteger((value as NativeConversationCheckpoint).next_turn) && (value as NativeConversationCheckpoint).next_turn >= 1
    && Number.isSafeInteger((value as NativeConversationCheckpoint).captured_sequence) && (value as NativeConversationCheckpoint).captured_sequence >= 1
    && typeof (value as NativeConversationCheckpoint).prompt === "string" && (value as NativeConversationCheckpoint).prompt.trim().length > 0
    && Array.isArray((value as NativeConversationCheckpoint).history);
}
function validCapsule(value: unknown): value is HarnessSessionReplayCapsule {
  if (typeof value !== "object" || value === null) return false;
  const item = value as HarnessSessionReplayCapsule;
  return item.version === 1 && validId(item.session_id) && validId(item.campaign_id) && validId(item.node_id) && (item.operation === "specialize" || item.operation === "review")
    && typeof item.captured_at === "string" && validCheckpoint(item.checkpoint) && item.checkpoint.session_id === item.session_id && /^sha256:[a-f0-9]{64}$/.test(item.content_hash);
}
function isReplayFile(value: unknown): value is ReplayFile {
  return typeof value === "object" && value !== null && (value as ReplayFile).version === 1 && Array.isArray((value as ReplayFile).capsules);
}
