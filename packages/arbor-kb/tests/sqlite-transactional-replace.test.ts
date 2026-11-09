/**
 * WA-17 (audit/2026-08-23-50-defects.md; packet X-3 in
 * audit/2026-08-23-55-crosscuts.md): `saveKBToSqlite` (persist.ts) used to
 * `clear()` then `fromJSONL()` as two independent statements. `fromJSONL`
 * can throw partway through (a conflicting duplicate id — its own documented
 * conflict rule) after some rows already inserted, and `clear()` had already
 * removed everything ahead of that. The result: an error mid-save left the
 * on-disk SQLite KB with neither its old contents nor its new ones — some
 * rows silently gone.
 *
 * `SqliteKbStore.replaceAll` (sqlite.ts) now wraps clear()+fromJSONL() in a
 * single BEGIN/COMMIT transaction with rollback on throw, and
 * `saveKBToSqlite` calls it instead of the two bare statements.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteKbStore } from "../src/sqlite.js";
import { saveKBToSqlite } from "../src/persist.js";
import { KBIntegrityError } from "../src/kb.js";
import type { Provenance } from "@arbor/core";

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" };

describe("WA-17: SQLite KB save replaces contents atomically", () => {
  it("SqliteKbStore.replaceAll rolls back to the prior contents when fromJSONL throws mid-import, instead of leaving the store cleared/partial", () => {
    const store = new SqliteKbStore(":memory:");
    store.write({
      campaign_id: "camp1", type: "failure_mode", value: "original entry one",
      provenance: verifiedProv, as_of: "iter:1", tier: "specialist_visible", tags: [],
    });
    store.write({
      campaign_id: "camp1", type: "success_pattern", value: "original entry two",
      provenance: verifiedProv, as_of: "iter:2", tier: "specialist_visible", tags: [],
    });
    const originalIds = store.getEntries().map((e) => e.id).sort();
    expect(originalIds).toEqual(["kb_1", "kb_2"]);

    // Crafted replacement data: one new valid entry, then a duplicate of
    // that SAME id with different content — fromJSONL's own conflict rule
    // throws on the second line, after the first has already been inserted
    // into the (by-then-cleared) table.
    const entryX = { id: "kb_x", campaign_id: "camp1", type: "failure_mode", value: "replacement", provenance: verifiedProv, as_of: "iter:3", tier: "specialist_visible", tags: [], created_at: "2026-08-23T00:00:00.000Z" };
    const entryXConflict = { ...entryX, value: "TAMPERED: conflicting replacement" };
    const crafted = `${JSON.stringify(entryX)}\n${JSON.stringify(entryXConflict)}`;

    expect(() => store.replaceAll(crafted)).toThrow(KBIntegrityError);

    // The rollback must restore the ORIGINAL two entries exactly — not zero
    // (a bare clear()), not one (the single row inserted before the throw).
    expect(store.getEntries().map((e) => e.id).sort()).toEqual(originalIds);
    expect(store.getEntries().map((e) => e.value).sort()).toEqual(["original entry one", "original entry two"]);

    // A subsequent write() must not collide with the entries the rollback
    // restored (the in-memory next-id counter must also have rolled back).
    const newId = store.write({
      campaign_id: "camp1", type: "parameter_finding", value: "after rollback",
      provenance: verifiedProv, as_of: "iter:4", tier: "specialist_visible", tags: [],
    });
    expect(store.getEntries().map((e) => e.id)).not.toContain(undefined);
    expect(new Set(store.getEntries().map((e) => e.id)).size).toBe(store.getEntries().length);
    expect(newId).toBeTruthy();
  });

  it("saveKBToSqlite (persist.ts, the real production caller) leaves the on-disk row set unchanged when the source data throws mid-import", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-kb-sqlite-atomic-"));
    try {
      // 1) A genuine successful save establishes the on-disk baseline.
      const seed = new SqliteKbStore(":memory:");
      seed.write({
        campaign_id: "camp1", type: "failure_mode", value: "baseline one",
        provenance: verifiedProv, as_of: "iter:1", tier: "specialist_visible", tags: [],
      });
      seed.write({
        campaign_id: "camp1", type: "success_pattern", value: "baseline two",
        provenance: verifiedProv, as_of: "iter:2", tier: "specialist_visible", tags: [],
      });
      const dbPath = saveKBToSqlite(seed, dir);
      seed.close();

      const before = new SqliteKbStore(dbPath);
      const beforeIds = before.getEntries().map((e) => e.id).sort();
      before.close();
      expect(beforeIds).toEqual(["kb_1", "kb_2"]);

      // 2) A source whose serialized JSONL throws mid-fromJSONL — a fake
      // `kb.toJSONL()` returning one valid entry followed by a conflicting
      // duplicate of it, engineered exactly like the unit test above, but
      // driven through the real `saveKBToSqlite` entry point this lane owns.
      const entryX = { id: "kb_x", campaign_id: "camp1", type: "failure_mode", value: "new", provenance: verifiedProv, as_of: "iter:3", tier: "specialist_visible", tags: [], created_at: "2026-08-23T00:00:00.000Z" };
      const entryXConflict = { ...entryX, value: "TAMPERED" };
      const throwingKb = { toJSONL: () => `${JSON.stringify(entryX)}\n${JSON.stringify(entryXConflict)}` } as unknown as SqliteKbStore;

      expect(() => saveKBToSqlite(throwingKb, dir)).toThrow(KBIntegrityError);

      // 3) Reopen the on-disk file independently and confirm the row set is
      // EXACTLY the pre-existing baseline — not the single row a partial,
      // non-transactional insert would have left behind, and not empty.
      const after = new SqliteKbStore(dbPath);
      const afterIds = after.getEntries().map((e) => e.id).sort();
      const afterValues = after.getEntries().map((e) => e.value).sort();
      after.close();
      expect(afterIds).toEqual(beforeIds);
      expect(afterValues).toEqual(["baseline one", "baseline two"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
