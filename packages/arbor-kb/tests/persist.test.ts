import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeBase, KBIntegrityError, saveKBProjection, loadKBResult, loadKBFromSqlite } from "../src/index.js";
import type { Provenance } from "@arbor/core";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-kb-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"};

/**
 * `saveKB`/`loadKB` were deleted 2026-08-06 as unreached (manager.ts had long
 * since moved to the projection pair). These cases were ported rather than
 * dropped: every behaviour they cover — round-trip, empty-directory, save/load
 * idempotency, legacy-JSONL migration, and fail-closed integrity — is a
 * property of the surviving `saveKBProjection`/`loadKBResult` pair too. The
 * one real difference is shape: `loadKB` threw `KBIntegrityError`, while
 * `loadKBResult` reports diagnostics, so the integrity cases now assert on the
 * diagnostics the live API actually returns.
 */
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

describe("saveKBProjection + loadKBResult", () => {
  it("round-trips entries of all types", () => {
    const kb = new KnowledgeBase();
    kb.write({
      campaign_id: "camp1",
      type: "failure_mode",
      value: "import error",
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible",
      failure_mode: "missing import",
      root_cause: "not installed",
      tags: ["auth"],
    });
    kb.write({
      campaign_id: "camp1",
      type: "success_pattern",
      value: "worktree works",
      provenance: verifiedProv,
      as_of: "iter:2",
      tier: "specialist_visible",
      tags: ["worktree"],
    });
    kb.write({
      campaign_id: "camp1",
      type: "parameter_finding",
      value: "batch_size=32",
      provenance: verifiedProv,
      as_of: "iter:3",
      tier: "specialist_visible",
      parameter: "batch_size",
      validated_value: "32",
      tags: ["config"],
    });

    saveKBProjection(kb, tempDir);
    const loaded = loadOrFail(tempDir);

    const entries = loaded.query("camp1", null, { tier: "auditor" });
    const visible = entries.filter((e) => e.value !== null);
    expect(visible.length).toBe(3);
  });

  it("returns empty KB for non-existent directory", () => {
    const kb = loadOrFail(tempDir);
    const entries = kb.query("camp1", null, { tier: "auditor" });
    expect(entries).toHaveLength(0);
  });

  it("is idempotent across save-load cycles", () => {
    const kb1 = new KnowledgeBase();
    kb1.write({
      campaign_id: "camp1",
      type: "success_pattern",
      value: "test",
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible",
      tags: [],
    });

    saveKBProjection(kb1, tempDir);
    const kb2 = loadOrFail(tempDir);
    saveKBProjection(kb2, tempDir);
    const kb3 = loadOrFail(tempDir);

    const entries = kb3.query("camp1", null, { tier: "auditor" });
    const visible = entries.filter((e) => e.value !== null);
    expect(visible.length).toBe(1);
  });

  it("writes sealed versioned streams and migrates legacy JSONL on the next save", () => {
    const kbDir = join(tempDir, "kb");
    const legacy = JSON.stringify({
      id: "kb_1", campaign_id: "camp1", type: "success_pattern", value: "legacy",
      provenance: verifiedProv, as_of: "iter:1", tier: "specialist_visible",
      created_at: "2026-08-01T00:00:00.000Z", tags: [],
    });
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "success-patterns.jsonl"), `${legacy}\n`);

    const loaded = loadOrFail(tempDir);
    expect(loaded.query("camp1", null, { tier: "auditor" })).toHaveLength(1);
    saveKBProjection(loaded, tempDir);

    const migrated = readFileSync(join(kbDir, "success-patterns.jsonl"), "utf-8").split("\n").filter(Boolean);
    expect(JSON.parse(migrated[0])).toMatchObject({ kind: "arbor_kb_stream", version: 1, stream: "success_pattern" });
    expect(JSON.parse(migrated.at(-1)!)).toMatchObject({ kind: "arbor_kb_seal", entry_count: 1 });
  });

  it("rejects mutation, reordering, truncation, and stream conflicts", () => {
    const kb = new KnowledgeBase();
    kb.write({ campaign_id: "camp1", type: "success_pattern", value: "one", provenance: verifiedProv, as_of: "iter:1", tier: "specialist_visible", tags: [] });
    kb.write({ campaign_id: "camp1", type: "success_pattern", value: "two", provenance: verifiedProv, as_of: "iter:2", tier: "specialist_visible", tags: [] });
    saveKBProjection(kb, tempDir);
    const path = join(tempDir, "kb", "success-patterns.jsonl");
    const source = readFileSync(path, "utf-8").split("\n").filter(Boolean);

    const mutated = [...source];
    mutated[1] = mutated[1].replace("one", "tampered");
    writeFileSync(path, `${mutated.join("\n")}\n`);
    expect(() => loadOrFail(tempDir)).toThrow(KBIntegrityError);

    writeFileSync(path, `${[source[0], source[2], source[1], source[3]].join("\n")}\n`);
    expect(() => loadOrFail(tempDir)).toThrow(KBIntegrityError);

    writeFileSync(path, `${source.slice(0, -1).join("\n")}\n`);
    expect(() => loadOrFail(tempDir)).toThrow(KBIntegrityError);

    const conflict = JSON.parse(source[1]) as { entry: { value: string } };
    conflict.entry.value = "conflict";
    writeFileSync(path, `${source[0]}\n${JSON.stringify(conflict)}\n${source[2]}\n${source[3]}\n`);
    expect(() => loadOrFail(tempDir)).toThrow(KBIntegrityError);
  });

  it("returns trusted streams and quarantines a corrupt stream with typed diagnostics", () => {
    const kb = new KnowledgeBase();
    kb.write({ campaign_id: "camp1", type: "success_pattern", value: "trusted", provenance: verifiedProv, as_of: "iter:1", tier: "specialist_visible", tags: [] });
    kb.write({ campaign_id: "camp1", type: "failure_mode", value: "corrupt me", provenance: verifiedProv, as_of: "iter:2", tier: "specialist_visible", tags: [] });
    saveKBProjection(kb, tempDir);
    writeFileSync(join(tempDir, "kb", "failure-modes.jsonl"), "not json\n");

    const result = loadKBResult(tempDir);
    expect(result.value?.query("camp1", { type: "success_pattern" }, { tier: "auditor" })).toHaveLength(1);
    expect(result.value?.query("camp1", { type: "failure_mode" }, { tier: "auditor" })).toHaveLength(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      artifact: "knowledge_base", quarantined_path: expect.stringContaining("quarantine"),
    }));
  });

  it("reports quarantine failure without trusting the corrupt stream", () => {
    const kbDir = join(tempDir, "kb");
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "failure-modes.jsonl"), "corrupt\n");
    writeFileSync(join(tempDir, "quarantine"), "blocks quarantine directory");

    const result = loadKBResult(tempDir);
    expect(result.value?.getEntries()).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      artifact: "knowledge_base", code: "quarantine_failed",
    }));
    expect(result.diagnostics[0]).not.toHaveProperty("quarantined_path");
  });

  it("migrates sealed v1 streams into the SQLite backend", () => {
    const kb = new KnowledgeBase();
    kb.write({
      campaign_id: "camp1",
      type: "success_pattern",
      value: "sealed migration",
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible",
      tags: [],
    });
    saveKBProjection(kb, tempDir);

    const { store, migrated } = loadKBFromSqlite(tempDir);
    try {
      expect(migrated).toBe(1);
      expect(store.query("camp1", null, { tier: "auditor" })).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
