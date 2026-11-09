import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractExceptions,
  ALLOWLIST_PATH,
  RULE_UNRESOLVED_AUTHORITY,
  RULE_EXPIRY,
} from "../../src/vi/exceptions.js";

const AT = "2026-08-06T00:00:00.000Z";
const TODAY = "2026-08-06";

function makeFixture(): string {
  return mkdtempSync(join(tmpdir(), "arbor-governance-exceptions-"));
}

function writeAllowlist(root: string, entries: unknown[]): void {
  mkdirSync(join(root, "scripts/reachability"), { recursive: true });
  writeFileSync(
    join(root, ALLOWLIST_PATH),
    JSON.stringify({ version: 1, entries }, null, 2),
  );
}

function writeRoadmapGaps(root: string, gapIds: readonly string[]): void {
  writeFileSync(join(root, "ROADMAP.md"), gapIds.map((g) => `- ${g}: something`).join("\n") + "\n");
}

function writeAdrs(root: string, adrIds: readonly string[]): void {
  mkdirSync(join(root, "decisions"), { recursive: true });
  for (const id of adrIds) {
    writeFileSync(join(root, "decisions", `${id}-a-record.md`), "# a record\n");
  }
}

function writeSrcFile(root: string, relPath: string, content: string): void {
  mkdirSync(join(root, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(root, relPath), content);
}

describe("extractExceptions", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("returns ok:false when the allowlist is missing", () => {
    root = makeFixture();
    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unavailable");
  });

  it("returns ok:false when the allowlist has no .entries array", () => {
    root = makeFixture();
    mkdirSync(join(root, "scripts/reachability"), { recursive: true });
    writeFileSync(join(root, ALLOWLIST_PATH), JSON.stringify({ version: 1 }));
    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("mirrors a healthy waiver (resolving authority, owner, future expiry) with zero findings", () => {
    root = makeFixture();
    writeAdrs(root, []);
    writeRoadmapGaps(root, ["G-01"]);
    writeSrcFile(root, "packages/widget/src/helper.ts", "export function helper(): number { return 1; }\n");
    writeAllowlist(root, [
      {
        symbol: "helper",
        file: "packages/widget/src/helper.ts",
        reason: "not yet wired",
        gap: "G-01",
        owner: "alice",
        expires: "2099-01-01",
      },
    ]);

    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.records).toHaveLength(1);
    const record = result.value.records[0]!;
    expect(record.id).toBe("exc-0001");
    expect(record.scope).toBe("sym:packages/widget/src/helper.ts::helper");
    expect(record.authority).toBe("G-01");
    expect(record.authority_resolves).toBe(true);
    expect(record.owner).toBe("alice");
    expect(record.mirrors).toBe(ALLOWLIST_PATH);

    expect(result.value.summary).toEqual({
      source: ALLOWLIST_PATH,
      total: 1,
      unresolved_authority: 0,
      unowned: 0,
      expired: 0,
      expiring_within_days: { days: 14, count: 0 },
      no_expiry: 0,
    });
    expect(result.value.findings).toEqual([]);
  });

  it("flags M-G when the cited gap does not resolve to a known G-id or ADR", () => {
    root = makeFixture();
    writeAdrs(root, []);
    writeRoadmapGaps(root, ["G-01"]); // G-99 is never listed
    writeAllowlist(root, [
      { symbol: "x", file: "packages/widget/src/x.ts", gap: "G-99", owner: "bob", expires: "2099-01-01" },
    ]);

    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.unresolved_authority).toBe(1);
    const finding = result.value.findings.find((f) => f.rule_id === RULE_UNRESOLVED_AUTHORITY);
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("G-99");
    expect(finding!.severity).toBe("warning");
    expect(finding!.waiver_eligible).toBe(false);
    expect(finding!.is_legacy_debt).toBe(true);
  });

  it("flags M-G when the waiver has no authority reference at all, and counts it unowned when owner is absent", () => {
    root = makeFixture();
    writeAdrs(root, []);
    writeRoadmapGaps(root, []);
    writeAllowlist(root, [
      { symbol: "x", file: "packages/widget/src/x.ts", expires: "2099-01-01" }, // no gap, no adr, no owner
    ]);

    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.unresolved_authority).toBe(1);
    expect(result.value.summary.unowned).toBe(1);
    const finding = result.value.findings.find((f) => f.rule_id === RULE_UNRESOLVED_AUTHORITY);
    expect(finding!.detail).toContain("no authority reference at all");
  });

  it("flags M-H for a waiver with no expiry", () => {
    root = makeFixture();
    writeAdrs(root, []);
    writeRoadmapGaps(root, ["G-01"]);
    writeAllowlist(root, [{ symbol: "x", file: "packages/widget/src/x.ts", gap: "G-01", owner: "carol" }]);

    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.no_expiry).toBe(1);
    const finding = result.value.findings.find((f) => f.rule_id === RULE_EXPIRY);
    expect(finding!.detail).toContain("no expiry");
    expect(finding!.severity).toBe("warning");
  });

  it("flags M-H as a blocker for an expired waiver, and counts expiry correctly relative to `today`", () => {
    root = makeFixture();
    writeAdrs(root, []);
    writeRoadmapGaps(root, ["G-01"]);
    writeAllowlist(root, [
      { symbol: "x", file: "packages/widget/src/x.ts", gap: "G-01", owner: "dave", expires: "2026-01-01" },
    ]);

    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.expired).toBe(1);
    const finding = result.value.findings.find((f) => f.rule_id === RULE_EXPIRY);
    expect(finding!.detail).toContain("EXPIRED");
    expect(finding!.severity).toBe("blocker");
  });

  it("counts a waiver expiring within 14 days as expiring_within_days, without raising a finding", () => {
    root = makeFixture();
    writeAdrs(root, []);
    writeRoadmapGaps(root, ["G-01"]);
    writeAllowlist(root, [
      { symbol: "x", file: "packages/widget/src/x.ts", gap: "G-01", owner: "erin", expires: "2026-08-10" },
    ]);

    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.expiring_within_days).toEqual({ days: 14, count: 1 });
    expect(result.value.summary.expired).toBe(0);
    expect(result.value.findings.some((f) => f.rule_id === RULE_EXPIRY)).toBe(false);
  });

  it("resolves authority via ADR id (decisions/) as well as G-id (ROADMAP.md)", () => {
    root = makeFixture();
    writeAdrs(root, ["ADR-005"]);
    writeRoadmapGaps(root, []);
    writeAllowlist(root, [
      { symbol: "x", file: "packages/widget/src/x.ts", adr: "ADR-005", owner: "frank", expires: "2099-01-01" },
    ]);

    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.records[0]!.authority).toBe("ADR-005");
    expect(result.value.records[0]!.authority_resolves).toBe(true);
    expect(result.value.summary.unresolved_authority).toBe(0);
  });

  it("resolves a G-id authority via a non-default roadmapPath, and reports it unresolved without the option", () => {
    root = makeFixture();
    writeAdrs(root, []);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/PLAN.md"), "- G-07: something\n");
    writeAllowlist(root, [
      { symbol: "x", file: "packages/widget/src/x.ts", gap: "G-07", owner: "frank", expires: "2099-01-01" },
    ]);

    const withoutOption = extractExceptions(root, { today: TODAY, at: AT });
    expect(withoutOption.ok).toBe(true);
    if (withoutOption.ok) {
      expect(withoutOption.value.records[0]!.authority_resolves).toBe(false);
    }

    const withOption = extractExceptions(root, { today: TODAY, at: AT, roadmapPath: "docs/PLAN.md" });
    expect(withOption.ok).toBe(true);
    if (withOption.ok) {
      expect(withOption.value.records[0]!.authority_resolves).toBe(true);
      expect(withOption.value.summary.unresolved_authority).toBe(0);
    }
  });

  it("builds a symbol subject identity with the correct package-qualified symbol_id when the file exists", () => {
    root = makeFixture();
    writeAdrs(root, []);
    writeRoadmapGaps(root, ["G-01"]);
    writeSrcFile(root, "packages/widget/src/helper.ts", "export function helper(): number { return 1; }\n");
    // No expiry, so this waiver also raises an M-H finding we can inspect the subject of.
    writeAllowlist(root, [
      { symbol: "helper", file: "packages/widget/src/helper.ts", gap: "G-01", owner: "grace" },
    ]);

    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const finding = result.value.findings.find((f) => f.rule_id === RULE_EXPIRY)!;
    const subject = finding.subject as { kind: string; path: string; symbol_id: string | null };
    expect(subject.kind).toBe("symbol");
    expect(subject.path).toBe("packages/widget/src/helper.ts");
    expect(subject.symbol_id).toBe("widget::helper");
  });

  it("falls back to a scope-derived content hash (and null symbol_id) when the referenced file no longer exists", () => {
    root = makeFixture();
    writeAdrs(root, []);
    writeRoadmapGaps(root, ["G-01"]);
    // Deliberately do NOT write packages/widget/src/gone.ts.
    writeAllowlist(root, [
      { symbol: "gone", file: "packages/widget/src/gone.ts", gap: "G-01", owner: "heidi" },
    ]);

    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const finding = result.value.findings.find((f) => f.rule_id === RULE_EXPIRY)!;
    const subject = finding.subject as { path: string; content_hash: string };
    expect(subject.path).toBe("packages/widget/src/gone.ts");
    expect(subject.content_hash).toMatch(/^sha256:/);
  });

  it("assigns stable, sequential ids across multiple entries, independent of processing order", () => {
    root = makeFixture();
    writeAdrs(root, []);
    writeRoadmapGaps(root, ["G-01", "G-02"]);
    writeAllowlist(root, [
      { symbol: "a", file: "packages/widget/src/a.ts", gap: "G-01", owner: "x", expires: "2099-01-01" },
      { symbol: "b", file: "packages/widget/src/b.ts", gap: "G-02", owner: "y", expires: "2099-01-01" },
    ]);

    const result = extractExceptions(root, { today: TODAY, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.records.map((r) => r.id)).toEqual(["exc-0001", "exc-0002"]);
  });
});
