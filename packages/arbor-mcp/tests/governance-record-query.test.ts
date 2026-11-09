import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { executeGovernanceRecordQuery, validateGovernanceRecordQuery } from "../src/governance-record-query.js";

const markdown = `# ADR-001: First record

**Status:** Accepted
**Date:** 2026-09-19

## Context

The repository needs a durable reader.

## Decision

Use the canonical decisions directory.

## Consequences

Search and readers share one source.
`;

describe("governance record runtime query contract", () => {
  it("searches and reads the canonical decisions source through the query surface", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-record-query-"));
    try {
      mkdirSync(join(root, "decisions"));
      writeFileSync(join(root, "decisions", "ADR-001-first-record.md"), markdown);
      const search = executeGovernanceRecordQuery({ schema_version: 1, query_id: "q1", query: { kind: "governance.record.search", repo_root: root, query: "durable" } });
      expect(search.ok).toBe(true);
      if (!search.ok || !("entries" in search.value)) return;
      expect(search.value.entries.map((entry) => entry.id)).toEqual(["revoy2:ADR-001"]);
      const read = executeGovernanceRecordQuery({ schema_version: 1, query_id: "q2", query: { kind: "governance.record.read", repo_root: root, id: "revoy2:ADR-001" } });
      expect(read.ok).toBe(true);
      if (!read.ok || !("record" in read.value) || !read.value.record.ok) return;
      expect(read.value.record.value.title).toBe("First record");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed for malformed query envelopes", () => {
    expect(validateGovernanceRecordQuery({ schema_version: 2, query_id: "", query: { kind: "governance.record.read", id: "" } })).toEqual([
      "schema_version must be 1", "query_id must be non-empty", "query.id must be non-empty",
    ]);
    expect(validateGovernanceRecordQuery(null)).toEqual(["query envelope must be an object"]);
    expect(validateGovernanceRecordQuery({ schema_version: 1, query_id: "q" })).toEqual(["query must be an object"]);
    expect(validateGovernanceRecordQuery({ schema_version: 1, query_id: "q", query: [] })).toEqual(["query must be an object"]);
    expect(validateGovernanceRecordQuery({ schema_version: 1, query_id: "q", query: { kind: "governance.record.nope" } })).toEqual([
      "query.kind must be governance.record.search or governance.record.read",
    ]);
    expect(executeGovernanceRecordQuery({ schema_version: 1, query_id: "q", query: [] })).toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
  });

  it("validates bounded paging", () => {
    expect(validateGovernanceRecordQuery({ schema_version: 1, query_id: "q", query: { kind: "governance.record.search", limit: 0, offset: -1 } })).toEqual([
      "query.limit must be 1..500", "query.offset must be non-negative",
    ]);
  });
});
