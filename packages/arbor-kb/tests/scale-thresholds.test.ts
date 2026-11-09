/**
 * arbor-kb/tests/scale-thresholds.test.ts — Phase 5.2 scale/threshold benchmarks.
 *
 * Asserts bounded, deterministic scale behavior across the JSONL-backed
 * KnowledgeBase and the SQLite-backed SqliteKbStore:
 *
 *   - Both backends handle >1,000 entries with identical query results (parity).
 *   - Byte-equivalent rebuild: saveKBProjection → loadKBResult reproduces the exact same
 *     entries (crash-at-boundary / byte-equivalent rebuild pattern).
 *   - KB stream tail truncation is detected by the sealed v1 hash-chain seal.
 *
 * Uses temp directories and deterministic data — no wall-clock sleeps.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeBase, saveKBProjection, loadKBResult, KBIntegrityError } from "../src/index.js";
import { parseKBStream, serializeKBStream } from "../src/kb.js";
import { SqliteKbStore } from "../src/sqlite.js";
import type { Provenance } from "@arbor/core";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-kb-scale-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"};

/** Write `count` failure_mode entries into a JSONL KnowledgeBase. */
function seedJsonl(count: number): KnowledgeBase {
  const kb = new KnowledgeBase();
  for (let i = 0; i < count; i++) {
    kb.write({
      campaign_id: "camp1",
      type: "failure_mode",
      value: `failure ${i}`,
      provenance: verifiedProv,
      as_of: `iter:${i}`,
      tier: "specialist_visible",
      failure_mode: `failure ${i}`,
      root_cause: `cause ${i}`,
      fix_template: `fix ${i}`,
      tags: ["scale"],
    });
  }
  return kb;
}

/** Write `count` failure_mode entries into a SQLite store. */
function seedSqlite(count: number): SqliteKbStore {
  const store = new SqliteKbStore(":memory:");
  for (let i = 0; i < count; i++) {
    store.write({
      campaign_id: "camp1",
      type: "failure_mode",
      value: `failure ${i}`,
      provenance: verifiedProv,
      as_of: `iter:${i}`,
      tier: "specialist_visible",
      failure_mode: `failure ${i}`,
      root_cause: `cause ${i}`,
      fix_template: `fix ${i}`,
      tags: ["scale"],
    });
  }
  return store;
}

/**
 * What `loadKB` did before it was deleted: fail closed on any diagnostic.
 * Kept as test scaffolding so the integrity cases below still assert
 * "refuses to load tampered data" rather than merely "reports something".
 */
function loadOrFail(dir: string): KnowledgeBase {
  const result = loadKBResult(dir);
  if (result.diagnostics.length > 0) {
    throw new KBIntegrityError(result.diagnostics.map((d) => d.message).join("; "));
  }
  return result.value ?? new KnowledgeBase();
}

describe("JSONL vs SQLite thresholds (>1,000 entries)", () => {
  it("both backends store and query >1,000 entries with identical results", () => {
    const count = 1_100;
    const kb = seedJsonl(count);
    const store = seedSqlite(count);

    const jsonlCount = kb.getEntries().filter((e) => e.campaign_id === "camp1" && e.type === "failure_mode").length;
    const sqliteCount = store.getEntries().filter((e) => e.campaign_id === "camp1" && e.type === "failure_mode").length;
    expect(jsonlCount).toBe(count);
    expect(sqliteCount).toBe(count);

    // Parity: both backends return the same set of values for a specialist query.
    const jsonlValues = kb.query("camp1", { type: "failure_mode" }, { tier: "specialist" })
      .filter((e) => e.value !== null).map((e) => e.value!.value).sort();
    const sqliteValues = store.query("camp1", { type: "failure_mode" }, { tier: "specialist" })
      .filter((e) => e.value !== null).map((e) => e.value!.value).sort();
    expect(jsonlValues).toEqual(sqliteValues);
    expect(jsonlValues).toHaveLength(count);
  });

  it("JSONL round-trip preserves all >1,000 entries", () => {
    const count = 1_100;
    const kb = seedJsonl(count);
    const jsonl = kb.toJSONL();

    const restored = new KnowledgeBase();
    const imported = restored.fromJSONL(jsonl);
    expect(imported).toBe(count);
    expect(restored.getEntries().filter((e) => e.campaign_id === "camp1" && e.type === "failure_mode")).toHaveLength(count);
  });

  it("SQLite JSONL export/import preserves all >1,000 entries", () => {
    const count = 1_100;
    const store = seedSqlite(count);
    const jsonl = store.toJSONL();

    const restored = new SqliteKbStore(":memory:");
    const imported = restored.fromJSONL(jsonl);
    expect(imported).toBe(count);
    expect(restored.getEntries().filter((e) => e.campaign_id === "camp1" && e.type === "failure_mode")).toHaveLength(count);
  });
});

describe("byte-equivalent rebuild (crash-at-boundary)", () => {
  it("saveKBProjection → loadKBResult reproduces the exact same entries", () => {
    const kb = seedJsonl(50);
    saveKBProjection(kb, tempDir);

    const loaded = loadOrFail(tempDir);
    const original = kb.getEntries().map((e) => JSON.stringify(e)).sort();
    const rebuilt = loaded.getEntries().map((e) => JSON.stringify(e)).sort();
    expect(rebuilt).toEqual(original);
    expect(rebuilt).toHaveLength(50);
  });

  it("saveKBProjection is idempotent across repeated saves", () => {
    const kb = seedJsonl(20);
    saveKBProjection(kb, tempDir);
    const first = loadOrFail(tempDir).getEntries().map((e) => JSON.stringify(e)).sort();
    saveKBProjection(kb, tempDir);
    const second = loadOrFail(tempDir).getEntries().map((e) => JSON.stringify(e)).sort();
    expect(second).toEqual(first);
  });
});

describe("KB stream tail-truncation detection (sealed v1)", () => {
  it("detects a truncated sealed stream via the terminal seal", () => {
    const kb = seedJsonl(5);
    const stream = serializeKBStream("failure_mode", kb.getEntries());
    const lines = stream.trim().split("\n");
    // Drop the terminal seal line — the stream is now truncated.
    const truncated = lines.slice(0, -1).join("\n") + "\n";

    expect(() => parseKBStream(truncated, "failure_mode")).toThrow("missing its terminal seal");
  });

  it("detects a dropped record via the seal entry_count/tip_hash mismatch", () => {
    const kb = seedJsonl(5);
    const stream = serializeKBStream("failure_mode", kb.getEntries());
    const lines = stream.trim().split("\n");
    // Remove one record line (index 1 is the first kb_entry after the header).
    lines.splice(1, 1);
    const tampered = lines.join("\n") + "\n";

    expect(() => parseKBStream(tampered, "failure_mode")).toThrow(KBIntegrityError);
  });

  it("detects a mutated record via its content hash", () => {
    const kb = seedJsonl(3);
    const stream = serializeKBStream("failure_mode", kb.getEntries());
    const lines = stream.trim().split("\n");
    const record = JSON.parse(lines[1]) as { entry: { value: string } };
    record.entry.value = "tampered";
    lines[1] = JSON.stringify(record);
    const tampered = lines.join("\n") + "\n";

    expect(() => parseKBStream(tampered, "failure_mode")).toThrow("content hash does not match");
  });
});
