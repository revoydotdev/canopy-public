import { join } from "node:path";
import type { Provenance } from "@arbor/core";
import { readUxStore, uxClone, uxHash, uxId, uxText, writeUxStore } from "./durable-ux-store.js";

const MAX_TAGS = 12;
const MAX_NAME = 96;
export interface SessionIdentity { readonly session_id: string; readonly display_name: string | null; readonly tags: readonly string[]; readonly revision: number; readonly created_at: string; readonly updated_at: string; readonly provenance: Provenance; }
export interface SessionIdentityMutation { readonly session_id: string; readonly display_name?: string | null; readonly tags?: readonly string[]; readonly idempotency_key: string; readonly provenance: Provenance; }
type Store = { schema_version: 1; items: SessionIdentity[]; idempotency: Array<[string, { fingerprint: string; session_id: string }]> };

export class SessionIdentityService {
  private readonly items = new Map<string, SessionIdentity>();
  private readonly idempotency = new Map<string, { fingerprint: string; session_id: string }>();
  private readonly path: string | null;
  private readonly clock: () => string;
  constructor(options: { readonly persistence_dir?: string; readonly clock?: () => string } = {}) { this.path = options.persistence_dir === undefined ? null : join(options.persistence_dir, "session-identities", "identities.json"); this.clock = options.clock ?? (() => new Date().toISOString()); this.restore(); }
  mutate(input: SessionIdentityMutation): SessionIdentity {
    if (!uxId(input.session_id) || !uxText(input.idempotency_key, 256) || !validProvenance(input.provenance)) throw new Error("session identity mutation requires safe id, idempotency key, and provenance");
    if (input.display_name !== undefined && input.display_name !== null && !uxText(input.display_name, MAX_NAME)) throw new Error("display_name must be null or 1..96 characters");
    const tags = input.tags === undefined ? undefined : normalizeTags(input.tags); if (input.tags !== undefined && tags === null) throw new Error("tags must be 0..12 unique bounded labels");
    const fingerprint = uxHash(input); const replay = this.idempotency.get(input.idempotency_key);
    if (replay) { if (replay.fingerprint !== fingerprint) throw new Error("idempotency key names a different session identity mutation"); const record = this.items.get(replay.session_id); if (!record) throw new Error("session identity idempotency record is corrupt"); return uxClone(record); }
    const prior = this.items.get(input.session_id); const now = this.clock(); const next: SessionIdentity = { session_id: input.session_id, display_name: input.display_name === undefined ? prior?.display_name ?? null : input.display_name?.trim() || null, tags: tags ?? prior?.tags ?? [], revision: (prior?.revision ?? 0) + 1, created_at: prior?.created_at ?? now, updated_at: now, provenance: input.provenance };
    this.items.set(next.session_id, next); this.idempotency.set(input.idempotency_key, { fingerprint, session_id: next.session_id }); this.persist(); return uxClone(next);
  }
  get(sessionId: string): SessionIdentity | null { const found = this.items.get(sessionId); return found === undefined ? null : uxClone(found); }
  search(input: { readonly query?: string; readonly limit: number; readonly cursor?: string } ): { readonly items: readonly SessionIdentity[]; readonly next_cursor: string | null } { if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 || (input.query !== undefined && !uxText(input.query, 128)) || (input.cursor !== undefined && !uxId(input.cursor))) throw new Error("invalid session identity search"); const query = (input.query ?? "").trim().toLocaleLowerCase(); const ranked = [...this.items.values()].filter((item) => fuzzy(`${item.session_id} ${item.display_name ?? ""} ${item.tags.join(" ")}`.toLocaleLowerCase(), query)).sort((a, b) => score(b, query) - score(a, query) || b.updated_at.localeCompare(a.updated_at) || a.session_id.localeCompare(b.session_id)); const start = input.cursor === undefined ? 0 : Math.max(0, ranked.findIndex((item) => item.session_id === input.cursor) + 1); const page = ranked.slice(start, start + input.limit).map(uxClone); return { items: page, next_cursor: start + page.length < ranked.length ? page.at(-1)?.session_id ?? null : null }; }
  private restore(): void { const store = readUxStore<Store>(this.path, { schema_version: 1, items: [], idempotency: [] }, validStore); for (const item of store.items) this.items.set(item.session_id, item); for (const entry of store.idempotency) this.idempotency.set(entry[0], entry[1]); }
  private persist(): void { writeUxStore(this.path, { schema_version: 1, items: [...this.items.values()], idempotency: [...this.idempotency.entries()] } satisfies Store); }
}
function normalizeTags(value: readonly string[]): readonly string[] | null { if (value.length > MAX_TAGS) return null; const tags = value.map((tag) => tag.trim().toLocaleLowerCase()); return tags.every((tag) => uxText(tag, 32) && /^[a-z0-9][a-z0-9._-]*$/.test(tag)) && new Set(tags).size === tags.length ? Object.freeze([...tags].sort((left, right) => left.localeCompare(right))) : null; }
function fuzzy(text: string, query: string): boolean { let at = 0; for (const character of query.replace(/\s+/gu, "")) { at = text.indexOf(character, at); if (at < 0) return false; at += 1; } return true; }
function score(item: SessionIdentity, query: string): number { if (!query) return 0; const text = `${item.session_id} ${item.display_name ?? ""} ${item.tags.join(" ")}`.toLocaleLowerCase(); return (item.display_name?.toLocaleLowerCase().includes(query) ? 4 : 0) + (item.tags.some((tag) => tag.includes(query)) ? 2 : 0) + (text.includes(query) ? 1 : 0); }
function validProvenance(value: unknown): value is Provenance { return typeof value === "object" && value !== null && typeof (value as { tag?: unknown }).tag === "string"; }
function validStore(value: unknown): value is Store { return typeof value === "object" && value !== null && (value as { schema_version?: unknown }).schema_version === 1 && Array.isArray((value as { items?: unknown }).items) && Array.isArray((value as { idempotency?: unknown }).idempotency); }
