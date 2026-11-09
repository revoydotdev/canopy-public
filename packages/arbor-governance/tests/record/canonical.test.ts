import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalRecordView, recordContentHash } from "../../src/record/canonical.js";
import { parseRecord } from "../../src/record/parse.js";
import type { CanonicalRecord } from "../../src/record/schema.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function realRecord(): CanonicalRecord {
  const path = join(REPO_ROOT, "decisions", "ADR-001-botanical-taxonomy-agent-naming.md");
  const result = parseRecord(readFileSync(path, "utf8"), path);
  if (!result.ok) throw new Error("fixture ADR-001 failed to parse — test setup is broken");
  return result.value;
}

describe("recordContentHash", () => {
  it("is stable across repeated calls on the same record", () => {
    const record = realRecord();
    const first = recordContentHash(record);
    const second = recordContentHash(record);
    const third = recordContentHash(record);
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is UNCHANGED when only a computed status field (implementation/verification/compliance) differs", () => {
    const record = realRecord();
    const hashBefore = recordContentHash(record);
    const mutated: CanonicalRecord = {
      ...record,
      status: { ...record.status, implementation: "complete", verification: "verified", compliance: "consistent" },
    };
    const hashAfter = recordContentHash(mutated);
    expect(hashAfter).toBe(hashBefore);
  });

  it("is CHANGED when the decision status changes", () => {
    const record = realRecord();
    const hashBefore = recordContentHash(record);
    const mutated: CanonicalRecord = { ...record, status: { ...record.status, decision: "superseded" } };
    const hashAfter = recordContentHash(mutated);
    expect(hashAfter).not.toBe(hashBefore);
  });

  it("is CHANGED when a section's text changes", () => {
    const record = realRecord();
    const hashBefore = recordContentHash(record);
    const mutated: CanonicalRecord = {
      ...record,
      sections: { ...record.sections, decision: `${record.sections.decision}\n\nExtra sentence.` },
    };
    const hashAfter = recordContentHash(mutated);
    expect(hashAfter).not.toBe(hashBefore);
  });

  it("is UNCHANGED when only source_path or source_content_hash differ (provenance, not content)", () => {
    const record = realRecord();
    const hashBefore = recordContentHash(record);
    const mutated: CanonicalRecord = {
      ...record,
      source_path: "/somewhere/else/entirely.md",
      source_content_hash: "0".repeat(64),
    };
    expect(recordContentHash(mutated)).toBe(hashBefore);
  });

  it("is UNCHANGED when only parse_warnings differ (an artifact of parsing, not content)", () => {
    const record = realRecord();
    const hashBefore = recordContentHash(record);
    const mutated: CanonicalRecord = { ...record, parse_warnings: ["some warning that wasn't there before"] };
    expect(recordContentHash(mutated)).toBe(hashBefore);
  });

  it("determinism: parsing the same source twice yields records with equal content hashes and deep-equal shape", () => {
    const path = join(REPO_ROOT, "decisions", "ADR-002-uct-scoring-with-regression-priorsors.md");
    const content = readFileSync(path, "utf8");
    const first = parseRecord(content, path);
    const second = parseRecord(content, path);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toEqual(second.value);
    expect(recordContentHash(first.value)).toBe(recordContentHash(second.value));
  });
});

describe("canonicalRecordView round-trip through canonicalizeForHash", () => {
  it("JSON.parse(canonicalizeForHash(view)) reproduces the view exactly", async () => {
    const { canonicalizeForHash } = await import("@arbor/core");
    const record = realRecord();
    const view = canonicalRecordView(record);
    const canonicalJson = canonicalizeForHash(view);
    const roundTripped = JSON.parse(canonicalJson);
    expect(roundTripped).toEqual(view);
  });
});
