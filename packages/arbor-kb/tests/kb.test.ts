import { describe, it, expect } from "vitest";
import { KnowledgeBase, KBIntegrityError } from "../src/kb.js";
import type { CapabilityContext, Provenance } from "@arbor/core";

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"};

const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };

function makeKB(): KnowledgeBase {
  const kb = new KnowledgeBase();
  kb.write({
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
  kb.write({
    campaign_id: "camp1",
    type: "success_pattern",
    value: "worktree isolation works for concurrent tasks",
    provenance: verifiedProv,
    as_of: "iter:2",
    tier: "specialist_visible",
    tags: ["worktree"],
  });
  kb.write({
    campaign_id: "camp1",
    type: "failure_mode",
    value: "Critic found test contamination",
    provenance: { tag: "critic_approved", critic: "lenticel", rationale: "flaky test detected" },
    as_of: "iter:3",
    tier: "critic_only",
    failure_mode: "test contamination",
    root_cause: "shared fixture state",
    fix_template: "use isolated fixtures",
    tags: ["testing"],
  });
  return kb;
}

describe("KnowledgeBase write + read round-trip", () => {
  it("writes an entry and reads it back with all fields", () => {
    const kb = new KnowledgeBase();
    const id = kb.write({
      campaign_id: "camp1",
      type: "success_pattern",
      value: "test passed",
      provenance: verifiedProv,
      as_of: "iter:1",
      tier: "specialist_visible",
      tags: ["unit"],
    });

    const env = kb.read(id, criticCap);
    expect(env.absence).toBeNull();
    expect(env.value).not.toBeNull();
    expect(env.value!.value).toBe("test passed");
    expect(env.value!.provenance.tag).toBe("verified");
    expect(env.value!.as_of).toBe("iter:1");
  });

  it("returns not_found envelope for non-existent id", () => {
    const kb = new KnowledgeBase();
    const env = kb.read("nonexistent", criticCap);
    expect(env.value).toBeNull();
    expect(env.absence).toBe("not_found");
  });

  it("rejects verified provenance missing stdout_hash (G-26)", () => {
    const kb = new KnowledgeBase();
    expect(() => kb.write({
      campaign_id: "camp1",
      type: "success_pattern",
      value: "test passed",
      provenance: { tag: "verified", cmd: "pytest", exit: 0 } as never,
      as_of: "iter:1",
      tier: "specialist_visible",
      tags: ["unit"],
    })).toThrow(/complete provenance/);
  });
});

describe("Capability gating", () => {
  it("specialist cannot read critic_only entries", () => {
    const kb = makeKB();
    const entries = kb.query("camp1", { type: "failure_mode" }, specialistCap);

    // Should see the specialist_visible failure but not the critic_only one
    const visibleEntries = entries.filter((e) => e.value !== null);
    const absentEntries = entries.filter((e) => e.absence === "capability_required");

    expect(visibleEntries.length).toBe(1); // The import error one
    expect(visibleEntries[0].value!.failure_mode).toBe("missing import");

    expect(absentEntries.length).toBe(1); // The test contamination one
  });

  it("critic can read all entries including critic_only", () => {
    const kb = makeKB();
    const entries = kb.query("camp1", { type: "failure_mode" }, criticCap);
    const visibleEntries = entries.filter((e) => e.value !== null);
    expect(visibleEntries.length).toBe(2);
  });
});

describe("KB query filters", () => {
  it("filters by type", () => {
    const kb = makeKB();
    const failures = kb.query("camp1", { type: "failure_mode" }, criticCap);
    const successes = kb.query("camp1", { type: "success_pattern" }, criticCap);
    expect(failures.length).toBe(2);
    expect(successes.length).toBe(1);
  });

  it("filters by tags", () => {
    const kb = makeKB();
    const authEntries = kb.query("camp1", { tags: ["auth"] }, criticCap);
    expect(authEntries.length).toBe(1);
    expect(authEntries[0].value!.tags).toContain("auth");
  });
});

describe("KB inject", () => {
  it("specialist gets only failure modes in injected context", () => {
    const kb = makeKB();
    const result = kb.inject("do the task", "camp1", specialistCap);
    expect(result).toContain("KB CONTEXT");
    expect(result).toContain("missing import");
    // Should NOT contain the critic_only entry
    expect(result).not.toContain("test contamination");
  });

  it("critic gets all entries including critic_only", () => {
    const kb = makeKB();
    const result = kb.inject("review this", "camp1", criticCap);
    expect(result).toContain("import error on missing module");
    expect(result).toContain("test contamination");
    expect(result).toContain("success_pattern");
  });

  it("returns prompt unchanged when KB is empty", () => {
    const kb = new KnowledgeBase();
    const result = kb.inject("do the task", "camp1", specialistCap);
    expect(result).toBe("do the task");
  });
});

describe("KB JSONL serialization", () => {
  it("round-trips through toJSONL/fromJSONL", () => {
    const kb1 = makeKB();
    const jsonl = kb1.toJSONL();

    const kb2 = new KnowledgeBase();
    const imported = kb2.fromJSONL(jsonl);
    expect(imported).toBeGreaterThan(0);

    // Verify entries are retrievable
    const entries = kb2.query("camp1", null, criticCap);
    const visible = entries.filter((e) => e.value !== null);
    expect(visible.length).toBeGreaterThanOrEqual(3);
  });

  it("fromJSONL is idempotent (skips duplicates)", () => {
    const kb1 = makeKB();
    const jsonl = kb1.toJSONL();

    const kb2 = new KnowledgeBase();
    kb2.fromJSONL(jsonl);
    const secondImport = kb2.fromJSONL(jsonl);
    expect(secondImport).toBe(0); // No new entries on second import
  });

  it("preserves generated provenance and rejects generated entries without input hashes", () => {
    const kb = new KnowledgeBase();
    const id = kb.write({
      campaign_id: "camp1",
      type: "success_pattern",
      value: "derived finding",
      provenance: { tag: "generated", generator: "campaign_manager.kb_extractor", input_hash: "a".repeat(64) },
      as_of: "iter:1",
      tier: "specialist_visible",
      tags: ["lineage"],
    });
    const jsonl = kb.toJSONL();
    const reloaded = new KnowledgeBase();

    expect(reloaded.fromJSONL(jsonl)).toBe(1);
    expect(reloaded.read(id, criticCap).value!.provenance).toEqual({
      tag: "generated",
      generator: "campaign_manager.kb_extractor",
      input_hash: "a".repeat(64),
    });

    const malformed = JSON.stringify({
      id: "kb_bad",
      campaign_id: "camp1",
      type: "success_pattern",
      value: "missing lineage",
      provenance: { tag: "generated", generator: "campaign_manager.kb_extractor" },
      as_of: "iter:2",
      tier: "specialist_visible",
      created_at: "2026-08-01T00:00:00.000Z",
      tags: [],
    });
    expect(reloaded.fromJSONL(malformed)).toBe(0);
  });

  it("rejects a duplicate id whose content conflicts with the stored entry (replay/merge/tampering attack)", () => {
    const kb = new KnowledgeBase();
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

    expect(kb.fromJSONL(original)).toBe(1);
    expect(() => kb.fromJSONL(conflicting)).toThrow(KBIntegrityError);
    expect(() => kb.fromJSONL(conflicting)).toThrow(/conflicting KB entry for id kb_1/);

    const entries = kb.query("camp1", null, criticCap);
    const visible = entries.filter((e) => e.value !== null);
    expect(visible).toHaveLength(1);
    expect(visible[0].value!.value).toBe("import error on missing module");
  });
});
