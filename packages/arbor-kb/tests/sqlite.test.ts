import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteKbStore } from "../src/sqlite.js";
import { KBIntegrityError } from "../src/kb.js";
import type { CapabilityContext, Provenance } from "@arbor/core";

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"};
const criticProv: Provenance = { tag: "critic_approved", critic: "lenticel", rationale: "flaky test detected" };

const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };

function makeStore(): SqliteKbStore {
  const store = new SqliteKbStore(":memory:");
  store.write({
    campaign_id: "camp1",
    type: "failure_mode",
    value: "import error on missing module",
    provenance: verifiedProv,
    as_of: "iter:1",
    tier: "specialist_visible",
    failure_mode: "missing import",
    root_cause: "module not installed",
    fix_template: "pip install missing-module",
    tags: ["refactor", "auth"],
  });
  store.write({
    campaign_id: "camp1",
    type: "success_pattern",
    value: "worktree isolation works for concurrent tasks",
    provenance: verifiedProv,
    as_of: "iter:2",
    tier: "specialist_visible",
    tags: ["worktree"],
  });
  store.write({
    campaign_id: "camp1",
    type: "failure_mode",
    value: "Critic found test contamination",
    provenance: criticProv,
    as_of: "iter:3",
    tier: "critic_only",
    failure_mode: "test contamination",
    root_cause: "shared fixture state",
    fix_template: "use isolated fixtures",
    tags: ["testing"],
  });
  return store;
}

describe("SqliteKbStore write + read round-trip", () => {
  it("writes an entry and reads it back with all fields", () => {
    const store = new SqliteKbStore(":memory:");
    const id = store.write({
      campaign_id: "camp1",
      type: "success_pattern",
      value: "test passed",
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible",
      tags: ["unit"],
    });

    const env = store.read(id, criticCap);
    expect(env.absence).toBeNull();
    expect(env.value).not.toBeNull();
    expect(env.value!.value).toBe("test passed");
    expect(env.value!.provenance.tag).toBe("verified");
    expect(env.value!.as_of).toBe("iter:1");
    store.close();
  });

  it("returns not_found envelope for non-existent id", () => {
    const store = new SqliteKbStore(":memory:");
    const env = store.read("nonexistent", criticCap);
    expect(env.value).toBeNull();
    expect(env.absence).toBe("not_found");
    store.close();
  });

  it("assigns unique ids across entries", () => {
    const store = new SqliteKbStore(":memory:");
    const id1 = store.write({
      campaign_id: "camp1",
      type: "success_pattern",
      value: "first",
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible",
      tags: [],
    });
    const id2 = store.write({
      campaign_id: "camp1",
      type: "failure_mode",
      value: "second",
      provenance: verifiedProv,
      as_of: "iter:2",
      tier: "specialist_visible",
      tags: [],
    });
    expect(id1).not.toBe(id2);
    store.close();
  });
});

describe("SqliteKbStore capability gating", () => {
  it("specialist cannot read critic_only entries", () => {
    const store = makeStore();
    const entries = store.query("camp1", { type: "failure_mode" }, specialistCap);

    const visibleEntries = entries.filter((e) => e.value !== null);
    const absentEntries = entries.filter((e) => e.absence === "capability_required");

    expect(visibleEntries.length).toBe(1);
    expect(visibleEntries[0].value!.failure_mode).toBe("missing import");
    expect(absentEntries.length).toBe(1);
    store.close();
  });

  it("critic can read all entries including critic_only", () => {
    const store = makeStore();
    const entries = store.query("camp1", { type: "failure_mode" }, criticCap);
    const visibleEntries = entries.filter((e) => e.value !== null);
    expect(visibleEntries.length).toBe(2);
    store.close();
  });
});

describe("SqliteKbStore query filters", () => {
  it("filters by type", () => {
    const store = makeStore();
    const failures = store.query("camp1", { type: "failure_mode" }, criticCap);
    const successes = store.query("camp1", { type: "success_pattern" }, criticCap);
    expect(failures.length).toBe(2);
    expect(successes.length).toBe(1);
    store.close();
  });

  it("filters by tags", () => {
    const store = makeStore();
    const authEntries = store.query("camp1", { tags: ["auth"] }, criticCap);
    expect(authEntries.length).toBe(1);
    expect(authEntries[0].value!.tags).toContain("auth");
    store.close();
  });

  it("returns empty when no campaign matches", () => {
    const store = makeStore();
    const entries = store.query("nonexistent", null, criticCap);
    expect(entries.length).toBe(0);
    store.close();
  });
});

describe("SqliteKbStore inject", () => {
  it("specialist gets only failure modes in injected context", () => {
    const store = makeStore();
    const result = store.inject("do the task", "camp1", specialistCap);
    expect(result).toContain("KB CONTEXT");
    expect(result).toContain("missing import");
    expect(result).not.toContain("test contamination");
    store.close();
  });

  it("critic gets all entries including critic_only", () => {
    const store = makeStore();
    const result = store.inject("review this", "camp1", criticCap);
    expect(result).toContain("import error on missing module");
    expect(result).toContain("test contamination");
    expect(result).toContain("success_pattern");
    store.close();
  });

  it("returns prompt unchanged when KB is empty", () => {
    const store = new SqliteKbStore(":memory:");
    const result = store.inject("do the task", "camp1", specialistCap);
    expect(result).toBe("do the task");
    store.close();
  });
});

describe("SqliteKbStore JSONL serialization", () => {
  it("round-trips through toJSONL/fromJSONL", () => {
    const store1 = makeStore();
    const jsonl = store1.toJSONL();

    const store2 = new SqliteKbStore(":memory:");
    const imported = store2.fromJSONL(jsonl);
    expect(imported).toBeGreaterThan(0);

    const entries = store2.query("camp1", null, criticCap);
    const visible = entries.filter((e) => e.value !== null);
    expect(visible.length).toBeGreaterThanOrEqual(3);

    store1.close();
    store2.close();
  });

  it("fromJSONL is idempotent (skips duplicates)", () => {
    const store1 = makeStore();
    const jsonl = store1.toJSONL();

    const store2 = new SqliteKbStore(":memory:");
    store2.fromJSONL(jsonl);
    const secondImport = store2.fromJSONL(jsonl);
    expect(secondImport).toBe(0);

    store1.close();
    store2.close();
  });

  it("rejects persisted generated entries that omit their input hash", () => {
    const store = new SqliteKbStore(":memory:");
    const malformed = JSON.stringify({
      id: "kb_bad",
      campaign_id: "camp1",
      type: "success_pattern",
      value: "missing lineage",
      provenance: { tag: "generated", generator: "campaign_manager.kb_extractor" },
      as_of: "iter:1",
      tier: "specialist_visible",
      created_at: "2026-08-01T00:00:00.000Z",
      tags: [],
    });

    expect(store.fromJSONL(malformed)).toBe(0);
    expect(store.query("camp1", null, criticCap)).toHaveLength(0);
    store.close();
  });

  it("preserves all entry fields through JSONL round-trip", () => {
    const store1 = new SqliteKbStore(":memory:");
    store1.write({
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
    const jsonl = store1.toJSONL();

    const store2 = new SqliteKbStore(":memory:");
    store2.fromJSONL(jsonl);

    const entries = store2.query("camp1", { type: "parameter_finding" }, criticCap);
    expect(entries.length).toBe(1);
    expect(entries[0].value!.parameter).toBe("batch_size");
    expect(entries[0].value!.validated_value).toBe("32");

    store1.close();
    store2.close();
  });

  it("rejects a duplicate id whose content conflicts with the stored entry (replay/merge/tampering attack)", () => {
    const store = new SqliteKbStore(":memory:");
    const original = JSON.stringify({
      id: "kb_1",
      campaign_id: "camp1",
      type: "failure_mode",
      value: "import error on missing module",
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible",
      failure_mode: "missing import",
      root_cause: "module not installed",
      tags: ["auth"],
      created_at: "2026-08-01T00:00:00.000Z",
    });
    // Same id, different value — a genuine conflict (replay, merge accident,
    // or tampering), never a legitimate re-append.
    const conflicting = JSON.stringify({
      id: "kb_1",
      campaign_id: "camp1",
      type: "failure_mode",
      value: "TAMPERED: this never happened",
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible",
      failure_mode: "missing import",
      root_cause: "module not installed",
      tags: ["auth"],
      created_at: "2026-08-01T00:00:00.000Z",
    });

    expect(store.fromJSONL(original)).toBe(1);
    expect(() => store.fromJSONL(conflicting)).toThrow(KBIntegrityError);
    expect(() => store.fromJSONL(conflicting)).toThrow(/conflicting KB entry for id kb_1/);

    // The stored row must remain the original — a rejected conflict must not
    // silently mutate what is already on disk/in the store.
    const entries = store.query("camp1", null, criticCap);
    const visible = entries.filter((e) => e.value !== null);
    expect(visible).toHaveLength(1);
    expect(visible[0].value!.value).toBe("import error on missing module");

    store.close();
  });
});

describe("SqliteKbStore disk persistence", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-sqlite-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("survives close and reopen", () => {
    const dbPath = join(tempDir, "kb.sqlite");
    const store1 = new SqliteKbStore(dbPath);
    store1.write({
      campaign_id: "camp1",
      type: "failure_mode",
      value: "persistent error",
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible",
      tags: ["persist"],
    });
    store1.close();

    const store2 = new SqliteKbStore(dbPath);
    const entries = store2.query("camp1", null, criticCap);
    const visible = entries.filter((e) => e.value !== null);
    expect(visible.length).toBe(1);
    expect(visible[0].value!.value).toBe("persistent error");
    store2.close();
  });

  it("recreates schema on existing DB without errors", () => {
    const dbPath = join(tempDir, "kb.sqlite");
    const store1 = new SqliteKbStore(dbPath);
    store1.write({
      campaign_id: "camp1",
      type: "success_pattern",
      value: "before reopen",
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible",
      tags: [],
    });
    store1.close();

    // Reopen — CREATE TABLE IF NOT EXISTS should be safe
    const store2 = new SqliteKbStore(dbPath);
    store2.write({
      campaign_id: "camp1",
      type: "success_pattern",
      value: "after reopen",
      provenance: verifiedProv,
      as_of: "iter:2",
      tier: "specialist_visible",
      tags: [],
    });
    const entries = store2.query("camp1", { type: "success_pattern" }, criticCap);
    expect(entries.length).toBe(2);
    store2.close();
  });
});

describe("SqliteKbStore parameter_finding fields", () => {
  it("stores and retrieves parameter/validated_value", () => {
    const store = new SqliteKbStore(":memory:");
    const id = store.write({
      campaign_id: "camp1",
      type: "parameter_finding",
      value: "exploration_constant=1.5",
      provenance: verifiedProv,
      as_of: "iter:5",
      tier: "specialist_visible",
      parameter: "exploration_constant",
      validated_value: "1.5",
      tags: ["tuning"],
    });
    const env = store.read(id, criticCap);
    expect(env.value!.parameter).toBe("exploration_constant");
    expect(env.value!.validated_value).toBe("1.5");
    store.close();
  });
});
