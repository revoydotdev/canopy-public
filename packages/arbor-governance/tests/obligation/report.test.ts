import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { buildObligationCoverageReport } from "../../src/obligation/report.js";

const AT = "2026-08-04T00:00:00.000Z";
const FIXTURE_PATH = resolvePath(dirname(fileURLToPath(import.meta.url)), "fixtures/worked-example.md");

describe("buildObligationCoverageReport: the real decisions/ corpus", () => {
  /**
   * This used to assert "zero obligations, implementation none, everywhere"
   * against the live corpus — i.e. it encoded the corpus being unwitnessed as
   * the expected state, so the act of witnessing a record broke it. That is the
   * same shape as a test that only passes while the repository is wrong.
   *
   * What is asserted now is the invariant that must hold whatever the corpus
   * says: each record's derived status is consistent with its own obligation
   * count, in both directions.
   */
  it("derives each record's status consistently with its own obligation count", () => {
    const result = buildObligationCoverageReport({ at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.records.length).toBeGreaterThan(0);
    for (const record of result.value.records) {
      if (record.obligation_count === 0) {
        expect(record.implementation, `${record.record_id}`).toBe("none");
        expect(record.verification, `${record.record_id}`).toBe("not_applicable");
      } else {
        // A record that declares obligations must not report the "nothing
        // declared" status; that collapse is what made the old assertion
        // survive a genuine improvement.
        expect(record.obligations, `${record.record_id}`).toHaveLength(record.obligation_count);
        expect(
          record.obligations_with_resolving_proof,
          `${record.record_id} cannot have more proven obligations than it declares`,
        ).toBeLessThanOrEqual(record.obligation_count);
      }
    }
  });

  it("emits exactly one POL-04 finding per accepted, zero-obligation record — derived, not pinned", () => {
    const result = buildObligationCoverageReport({ at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pol04 = result.value.findings.filter((f) => f.rule_id === "POL-04");
    // Derived from the corpus rather than restated as a literal: the count
    // legitimately falls as records gain obligations, and a hard-coded number
    // here would break on every genuine improvement.
    // POL-04 fires on `accepted` AND zero-obligation (report.ts:93). Deriving
    // `expected` from obligation_count alone silently assumed every
    // zero-obligation record was accepted, which held only while it happened
    // to be true; a Proposed record with no obligations yet — the normal state
    // of a decision whose mechanism is not built — then reads as a missing
    // finding. Status is read the same way POL-04 reads it, so the two cannot
    // drift apart.
    const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const isAccepted = (sourcePath: string) =>
      /^\*\*Status:\*\*\s*Accepted/m.test(readFileSync(join(REPO_ROOT, sourcePath), "utf8"));
    const expected = result.value.records.filter((r) => r.obligation_count === 0 && isAccepted(r.source_path));
    expect(pol04).toHaveLength(expected.length);
    expect(pol04.every((f) => f.is_legacy_debt)).toBe(true);

    const subjectIds = new Set(pol04.map((f) => (f.subject as { record_id: string }).record_id));
    // Exactly the zero-obligation records, no more and no fewer.
    for (const record of expected) expect(subjectIds.has(record.record_id)).toBe(true);
    for (const record of result.value.records) {
      if (record.obligation_count > 0) expect(subjectIds.has(record.record_id)).toBe(false);
    }
  });

  it("emits no M-B finding — every proof citation in the real corpus resolves", () => {
    const result = buildObligationCoverageReport({ at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A false citation is worse than no citation: it converts "unverified"
    // into "apparently verified". This is the assertion that must never be
    // relaxed as the corpus gains obligations.
    const mb = result.value.findings.filter((f) => f.rule_id === "M-B");
    expect(mb.map((f) => f.detail)).toEqual([]);
  });

  it("determinism: same input => byte-identical report", () => {
    const first = buildObligationCoverageReport({ at: AT });
    const second = buildObligationCoverageReport({ at: AT });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
  });
});

describe("buildObligationCoverageReport: a fixture decisions/ directory", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a fully-resolving record produces no findings at all", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "arbor-governance-obligation-report-"));
    writeFileSync(join(tmpDir, "ADR-900-worked-example.md"), readFileSync(FIXTURE_PATH, "utf-8"));

    const result = buildObligationCoverageReport({ decisionsDir: tmpDir, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.records).toHaveLength(1);
    expect(result.value.records[0].implementation).toBe("complete");
    expect(result.value.findings).toEqual([]);
  });

  it("a record with a broken proof field produces a blocking M-B finding, not a silent pass", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "arbor-governance-obligation-report-"));
    const brokenText = readFileSync(FIXTURE_PATH, "utf-8").replace("symbol=EvidenceLedger", "symbol=TotallyNotReal_582");
    writeFileSync(join(tmpDir, "ADR-901-broken-example.md"), brokenText);

    const result = buildObligationCoverageReport({ decisionsDir: tmpDir, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.records[0].implementation).toBe("partial"); // O2/O3 still resolve
    const mb = result.value.findings.filter((f) => f.rule_id === "M-B");
    expect(mb).toHaveLength(1);
    expect(mb[0].severity).toBe("blocker");
    expect(mb[0].detail).toContain("TotallyNotReal_582");
    expect(mb[0].is_legacy_debt).toBe(false);
  });

  it("an accepted record with zero obligations (still, e.g., a not-yet-migrated file) produces a POL-04 finding", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "arbor-governance-obligation-report-"));
    writeFileSync(join(tmpDir, "ADR-902-legacy-shaped.md"), "# ADR-902: Legacy-shaped\n\n**Status:** Accepted\n\n## Decision\n\nProse only.\n");

    const result = buildObligationCoverageReport({ decisionsDir: tmpDir, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.findings).toHaveLength(1);
    expect(result.value.findings[0].rule_id).toBe("POL-04");
    expect(result.value.findings[0].waiver_eligible).toBe(true);
  });

  it("a missing decisions directory returns a GovernanceResult error, never throws", () => {
    const result = buildObligationCoverageReport({ decisionsDir: "/definitely/does/not/exist/anywhere", at: AT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unavailable");
  });

  it("M-C applies only to active Proposed and Accepted obligations", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "arbor-governance-obligation-report-"));
    const statuses = ["Draft", "Proposed", "Accepted", "Rejected", "Superseded"];
    statuses.forEach((status, index) => {
      const number = 910 + index;
      writeFileSync(
        join(tmpDir, `ADR-${number}-${status.toLowerCase()}.md`),
        `# ADR-${number}: ${status}\n\n**Status:** ${status}\n\n## Decision\n\nFixture.\n\n## Obligations\n\n### O1 — A claim without evidence\n`,
      );
    });

    const result = buildObligationCoverageReport({ decisionsDir: tmpDir, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const mcIds = result.value.findings
      .filter((finding) => finding.rule_id === "M-C")
      .map((finding) => (finding.subject as { record_id: string }).record_id)
      .sort();
    expect(mcIds).toEqual(["revoy2:ADR-911", "revoy2:ADR-912"]);
    expect(result.value.records.map((record) => record.decision_status)).toEqual([
      "draft",
      "proposed",
      "accepted",
      "rejected",
      "superseded",
    ]);
  });

  it("a broken citation remains M-B even after its decision is superseded", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "arbor-governance-obligation-report-"));
    const text = readFileSync(FIXTURE_PATH, "utf-8")
      .replace("**Status:** Accepted", "**Status:** Superseded")
      .replace("symbol=EvidenceLedger", "symbol=TotallyNotReal_583");
    writeFileSync(join(tmpDir, "ADR-920-retired-broken-proof.md"), text);

    const result = buildObligationCoverageReport({ decisionsDir: tmpDir, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.filter((finding) => finding.rule_id === "M-B")).toHaveLength(1);
    expect(result.value.findings.filter((finding) => finding.rule_id === "M-C")).toHaveLength(0);
  });
});
