/**
 * arbor-kb/tests/checks-and-balances.test.ts — Phase 5.2 capability-gating invariants.
 *
 * Asserts the checks-and-balances invariant that critic_only KB entries are
 * invisible to specialists (capability denial + structural redaction), across
 * both the JSONL-backed KnowledgeBase and the SQLite-backed SqliteKbStore:
 *
 *   - read() of a critic_only entry by a specialist returns absence
 *     `capability_required` with a null value (no content leaks).
 *   - query() redacts critic_only entries for specialists.
 *   - inject() never leaks critic_only entries into a specialist prompt.
 *   - critic/auditor tiers can read critic_only entries.
 *
 * These tests assert EXISTING behavior; they do not invent new capability
 * semantics.
 */

import { describe, it, expect } from "vitest";
import { KnowledgeBase } from "../src/kb.js";
import { SqliteKbStore } from "../src/sqlite.js";
import type { CapabilityContext, Provenance } from "@arbor/core";

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"};
const criticProv: Provenance = { tag: "critic_approved", critic: "lenticel", rationale: "flaky test detected" };

const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };
const auditorCap: CapabilityContext = { tier: "auditor" };

function seedJsonl(kb: KnowledgeBase): { visibleId: string; criticOnlyId: string } {
  const visibleId = kb.write({
    campaign_id: "camp1",
    type: "failure_mode",
    value: "import error on missing module",
    provenance: verifiedProv,
    as_of: "iter:1",
    tier: "specialist_visible",
    failure_mode: "missing import",
    root_cause: "module not installed",
    fix_template: "pip install missing-module",
    tags: ["refactor"],
  });
  const criticOnlyId = kb.write({
    campaign_id: "camp1",
    type: "failure_mode",
    value: "Critic found test contamination",
    provenance: criticProv,
    as_of: "iter:2",
    tier: "critic_only",
    failure_mode: "test contamination",
    root_cause: "shared fixture state",
    fix_template: "use isolated fixtures",
    tags: ["testing"],
  });
  return { visibleId, criticOnlyId };
}

function seedSqlite(store: SqliteKbStore): { visibleId: string; criticOnlyId: string } {
  const visibleId = store.write({
    campaign_id: "camp1",
    type: "failure_mode",
    value: "import error on missing module",
    provenance: verifiedProv,
    as_of: "iter:1",
    tier: "specialist_visible",
    failure_mode: "missing import",
    root_cause: "module not installed",
    fix_template: "pip install missing-module",
    tags: ["refactor"],
  });
  const criticOnlyId = store.write({
    campaign_id: "camp1",
    type: "failure_mode",
    value: "Critic found test contamination",
    provenance: criticProv,
    as_of: "iter:2",
    tier: "critic_only",
    failure_mode: "test contamination",
    root_cause: "shared fixture state",
    fix_template: "use isolated fixtures",
    tags: ["testing"],
  });
  return { visibleId, criticOnlyId };
}

describe("KnowledgeBase (JSONL): critic_only invisible to specialist", () => {
  it("read() returns capability_required with a null value for a specialist", () => {
    const kb = new KnowledgeBase();
    const { criticOnlyId } = seedJsonl(kb);
    const envelope = kb.read(criticOnlyId, specialistCap);
    expect(envelope.value).toBeNull();
    expect(envelope.absence).toBe("capability_required");
    expect(envelope.provenance).toBeNull();
  });

  it("read() returns the entry for critic and auditor tiers", () => {
    const kb = new KnowledgeBase();
    const { criticOnlyId } = seedJsonl(kb);
    expect(kb.read(criticOnlyId, criticCap).value).not.toBeNull();
    expect(kb.read(criticOnlyId, auditorCap).value).not.toBeNull();
  });

  it("query() redacts critic_only entries for a specialist", () => {
    const kb = new KnowledgeBase();
    seedJsonl(kb);
    const results = kb.query("camp1", null, specialistCap);
    const criticOnly = results.filter((e) => e.absence === "capability_required");
    expect(criticOnly).toHaveLength(1);
    // The visible entry is present with a value.
    expect(results.some((e) => e.value !== null && e.value!.tier === "specialist_visible")).toBe(true);
  });

  it("inject() never leaks critic_only entries into a specialist prompt", () => {
    const kb = new KnowledgeBase();
    seedJsonl(kb);
    const prompt = kb.inject("Do the work", "camp1", specialistCap);
    expect(prompt).not.toContain("test contamination");
    expect(prompt).not.toContain("critic_approved");
  });

  it("inject() includes critic_only entries for a critic", () => {
    const kb = new KnowledgeBase();
    seedJsonl(kb);
    const prompt = kb.inject("Review the work", "camp1", criticCap);
    expect(prompt).toContain("test contamination");
  });
});

describe("SqliteKbStore: critic_only invisible to specialist", () => {
  it("read() returns capability_required with a null value for a specialist", () => {
    const store = new SqliteKbStore(":memory:");
    const { criticOnlyId } = seedSqlite(store);
    const envelope = store.read(criticOnlyId, specialistCap);
    expect(envelope.value).toBeNull();
    expect(envelope.absence).toBe("capability_required");
    expect(envelope.provenance).toBeNull();
  });

  it("read() returns the entry for critic and auditor tiers", () => {
    const store = new SqliteKbStore(":memory:");
    const { criticOnlyId } = seedSqlite(store);
    expect(store.read(criticOnlyId, criticCap).value).not.toBeNull();
    expect(store.read(criticOnlyId, auditorCap).value).not.toBeNull();
  });

  it("query() redacts critic_only entries for a specialist", () => {
    const store = new SqliteKbStore(":memory:");
    seedSqlite(store);
    const results = store.query("camp1", null, specialistCap);
    expect(results.filter((e) => e.absence === "capability_required")).toHaveLength(1);
  });

  it("inject() never leaks critic_only entries into a specialist prompt", () => {
    const store = new SqliteKbStore(":memory:");
    seedSqlite(store);
    const prompt = store.inject("Do the work", "camp1", specialistCap);
    expect(prompt).not.toContain("test contamination");
    expect(prompt).not.toContain("critic_approved");
  });

  it("inject() includes critic_only entries for a critic", () => {
    const store = new SqliteKbStore(":memory:");
    seedSqlite(store);
    const prompt = store.inject("Review the work", "camp1", criticCap);
    expect(prompt).toContain("test contamination");
  });
});
