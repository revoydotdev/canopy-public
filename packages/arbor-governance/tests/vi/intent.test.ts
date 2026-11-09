import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIntentGraph } from "../../src/vi/intent.js";

// packages/arbor-governance/tests/vi/intent.test.ts -> repo root is four
// directories up, matching tests/record/corpus.test.ts's convention.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Minimal but real ADR markdown — every section `record/parse.ts` requires present. */
function adr(num: string, title: string, status: string, decisionBody = "We decided it."): string {
  return [
    `# ADR-${num}: ${title}`,
    `**Status:** ${status}`,
    `**Date:** 2026-01-01`,
    ``,
    `## Context`,
    ``,
    `Some context.`,
    ``,
    `## Decision`,
    ``,
    decisionBody,
    ``,
    `## Consequences`,
    ``,
    `Some consequences.`,
    ``,
  ].join("\n");
}

let tmpRoot: string | null = null;

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

/**
 * Builds a real, on-disk fixture repo:
 *   - ADR-001 Accepted, cited only from test code       -> test-only governance
 *   - ADR-002 Accepted, cited from src code              -> governed; also the
 *                                                            supersession target below
 *   - ADR-003 Accepted, cited nowhere; README says Draft -> orphan + status disagreement
 *   - ADR-004 Accepted, prose "Supersedes ADR-002", cited nowhere -> orphan itself,
 *                                                            and trips the M-D check on ADR-002
 *   - ADR-005 Proposed, cited nowhere                     -> lifecycle "experimental", no orphan check
 *   - ADR-006 status line does not match the closed DecisionStatus set -> unparseable,
 *                                                            excluded from the intent plane entirely
 *   - ADR-007 Superseded, cited nowhere                   -> lifecycle "deprecated"
 *   - ADR-008 Rejected, cited nowhere                     -> lifecycle "unknown"
 *   - a `packages/pkg-a/src/citing.ts` referencing ADR-002 and the out-of-corpus ADR-777
 *   - a `packages/pkg-a/tests/citing.test.ts` referencing ADR-001
 *   - `decisions/README.md` indexing 001/002/003 (003's status deliberately wrong)
 *     plus a phantom ADR-999 row with no backing file
 */
function buildFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-governance-vi-intent-"));
  const decisionsDir = join(root, "decisions");
  mkdirSync(decisionsDir, { recursive: true });

  writeFileSync(join(decisionsDir, "ADR-001-test-only.md"), adr("001", "Test only decision", "Accepted"));
  writeFileSync(join(decisionsDir, "ADR-002-governed.md"), adr("002", "Governed decision", "Accepted"));
  writeFileSync(join(decisionsDir, "ADR-003-orphan.md"), adr("003", "Orphan decision", "Accepted"));
  writeFileSync(
    join(decisionsDir, "ADR-004-supersedes-002.md"),
    adr("004", "Supersedes decision", "Accepted", "Supersedes ADR-002. We decided differently."),
  );
  writeFileSync(join(decisionsDir, "ADR-005-proposed.md"), adr("005", "Proposed decision", "Proposed"));
  writeFileSync(join(decisionsDir, "ADR-006-malformed-status.md"), adr("006", "Malformed status", "Accepted-ish"));
  writeFileSync(join(decisionsDir, "ADR-007-superseded.md"), adr("007", "Superseded decision", "Superseded"));
  writeFileSync(join(decisionsDir, "ADR-008-rejected.md"), adr("008", "Rejected decision", "Rejected"));

  writeFileSync(
    join(decisionsDir, "README.md"),
    [
      "# ADR Index",
      "",
      "| # | Title | Status |",
      "|---|-------|--------|",
      "| [001](ADR-001-test-only.md) | Test only decision | Accepted |",
      "| [002](ADR-002-governed.md) | Governed decision | Accepted |",
      "| [003](ADR-003-orphan.md) | Orphan decision | Draft |",
      "| [999](ADR-999-nonexistent.md) | Ghost decision | Accepted |",
      "",
    ].join("\n"),
  );

  const srcDir = join(root, "packages", "pkg-a", "src");
  const testsDir = join(root, "packages", "pkg-a", "tests");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(
    join(srcDir, "citing.ts"),
    "// governed by ADR-002\n// also references the out-of-corpus ADR-777\nexport const x = 1;\n",
  );
  writeFileSync(join(testsDir, "citing.test.ts"), "// exercises ADR-001\n");

  return root;
}

describe("buildIntentGraph — fixture repo", () => {
  it("classifies each record's status and lifecycle via the canonical corpus reader, excluding the unparseable file", () => {
    tmpRoot = buildFixtureRepo();
    const result = buildIntentGraph(tmpRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(result.value.records.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual(["ADR-001", "ADR-002", "ADR-003", "ADR-004", "ADR-005", "ADR-007", "ADR-008"]);

    expect(byId.get("ADR-001")?.decisionStatus).toBe("accepted");
    expect(byId.get("ADR-001")?.lifecycle).toBe("active");
    expect(byId.get("ADR-004")?.supersedes).toEqual(["ADR-002"]);
    expect(byId.get("ADR-005")?.decisionStatus).toBe("proposed");
    expect(byId.get("ADR-005")?.lifecycle).toBe("experimental");
    expect(byId.get("ADR-007")?.decisionStatus).toBe("superseded");
    expect(byId.get("ADR-007")?.lifecycle).toBe("deprecated");
    expect(byId.get("ADR-008")?.decisionStatus).toBe("rejected");
    expect(byId.get("ADR-008")?.lifecycle).toBe("unknown");
  });

  it("splits packages/ citations into resolved (production vs test) and dangling", () => {
    tmpRoot = buildFixtureRepo();
    const result = buildIntentGraph(tmpRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.citations).toEqual([
      { recordId: "ADR-002", citingPath: "packages/pkg-a/src/citing.ts", line: 1, isTest: false },
      { recordId: "ADR-001", citingPath: "packages/pkg-a/tests/citing.test.ts", line: 1, isTest: true },
    ]);

    expect(result.value.danglingCitations).toEqual([
      { token: "ADR-777", sites: ["packages/pkg-a/src/citing.ts:2"], isTest: false },
    ]);
  });

  it("flags orphan and test-only Accepted records, but never Proposed/Superseded/Rejected ones", () => {
    tmpRoot = buildFixtureRepo();
    const result = buildIntentGraph(tmpRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect([...result.value.orphanRecordIds].sort()).toEqual(["ADR-003", "ADR-004"]);
    expect(result.value.testOnlyGovernedRecordIds).toEqual(["ADR-001"]);
  });

  it("produces exactly the seven expected findings: M-H, M-F (missing file), M-F (dangling), 2x M-L orphan, M-L test-only, M-D", () => {
    tmpRoot = buildFixtureRepo();
    const result = buildIntentGraph(tmpRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { findings } = result.value;
    expect(findings).toHaveLength(7);

    expect(findings).toContainEqual({
      category: "intent_drift",
      severity: "medium",
      mismatch: "M-H",
      title: "ADR-003 status disagrees: file says 'accepted', index says 'Draft'",
      evidence: "decisions/ADR-003-orphan.md vs decisions/README.md",
    });
    expect(findings).toContainEqual({
      category: "intent_drift",
      severity: "medium",
      mismatch: "M-F",
      title: "decisions/README.md indexes ADR-999, which has no file",
      evidence: "decisions/README.md",
    });
    expect(findings).toContainEqual({
      category: "intent_drift",
      severity: "medium",
      mismatch: "M-F",
      title: "dangling citation ADR-777: cited in source but absent from decisions/ (likely revoy-spec's numbering)",
      evidence: "packages/pkg-a/src/citing.ts:2",
      count: 1,
    });
    expect(findings).toContainEqual({
      category: "intent_drift",
      severity: "medium",
      mismatch: "M-L",
      title: "orphan ADR: ADR-003 is Accepted and governs zero artifacts",
      evidence: "decisions/ADR-003-orphan.md",
    });
    expect(findings).toContainEqual({
      category: "intent_drift",
      severity: "medium",
      mismatch: "M-L",
      title: "orphan ADR: ADR-004 is Accepted and governs zero artifacts",
      evidence: "decisions/ADR-004-supersedes-002.md",
    });
    expect(findings).toContainEqual({
      category: "intent_drift",
      severity: "medium",
      mismatch: "M-L",
      title:
        "test-only governance: ADR-001 is Accepted and cited ONLY from test code (1 site(s)) — it governs no production artifact",
      evidence: "decisions/ADR-001-test-only.md",
    });
    expect(findings).toContainEqual({
      category: "intent_drift",
      severity: "critical",
      mismatch: "M-D",
      title: "ADR-002 is superseded by ADR-004 but still governs 1 artifact(s)",
      evidence: "decisions/ADR-002-governed.md",
    });
  });

  it("reports a not-ok result for a nonexistent decisions directory instead of throwing", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "arbor-governance-vi-intent-empty-"));
    const result = buildIntentGraph(tmpRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unavailable");
  });
});

/**
 * B4 — a dangling citation cited ONLY from test code (a deliberately
 * fabricated id exercising a gate's own test suite, e.g.
 * scripts/tests/adr-trace.test.mjs's ADR-100/101/...) must not be reported
 * identically to a real dangling citation in production source.
 */
describe("buildIntentGraph — B4 dangling citation isTest split", () => {
  function buildFixtureRepoWithTestOnlyDangling(): string {
    const root = buildFixtureRepo();
    const testsDir = join(root, "packages", "pkg-a", "tests");
    // Fabricated id used ONLY in a test fixture — never in production source.
    writeFileSync(join(testsDir, "fabricated-fixture.test.ts"), "// fixture cites the fabricated ADR-888\n");
    return root;
  }

  it("marks a dangling citation cited ONLY from test paths as isTest: true", () => {
    tmpRoot = buildFixtureRepoWithTestOnlyDangling();
    const result = buildIntentGraph(tmpRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fabricated = result.value.danglingCitations.find((d) => d.token === "ADR-888");
    expect(fabricated).toBeTruthy();
    expect(fabricated?.isTest).toBe(true);
    expect(fabricated?.sites).toEqual(["packages/pkg-a/tests/fabricated-fixture.test.ts:1"]);
  });

  it("EXCLUDES a test-only dangling citation from the reported findings", () => {
    tmpRoot = buildFixtureRepoWithTestOnlyDangling();
    const result = buildIntentGraph(tmpRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fabricatedFinding = result.value.findings.find((f) => f.title.includes("ADR-888"));
    expect(fabricatedFinding).toBeUndefined();
    // The real production dangling citation (ADR-777) must still be reported.
    const realFinding = result.value.findings.find((f) => f.title.includes("ADR-777"));
    expect(realFinding).toBeTruthy();
  });

  it("a token cited from BOTH a test and a production site is isTest: false — real dangling site is not excused", () => {
    const root = buildFixtureRepo();
    const testsDir = join(root, "packages", "pkg-a", "tests");
    // ADR-777 is already cited from src/citing.ts (production); add a test-side citation too.
    writeFileSync(join(testsDir, "also-cites.test.ts"), "// also cites the out-of-corpus ADR-777\n");
    tmpRoot = root;

    const result = buildIntentGraph(tmpRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const mixed = result.value.danglingCitations.find((d) => d.token === "ADR-777");
    expect(mixed?.isTest).toBe(false);
    expect(mixed?.sites.length).toBe(2);
    expect(result.value.findings.some((f) => f.title.includes("ADR-777"))).toBe(true);
  });
});

describe("buildIntentGraph — real corpus (decisions/*.md)", () => {
  it("classifies every real ADR file into the intent plane — the highest-value test, it runs on real data", () => {
    const result = buildIntentGraph(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Independently re-globbed (not via the module's own scan), matching this
    // package's existing "counts/derive.test.ts" convention: this fails if the
    // module's file selection breaks, not just if the repo's ADR count changes.
    const decisionsDir = join(REPO_ROOT, "decisions");
    const realAdrFileCount = readdirSync(decisionsDir).filter((name) => /^ADR-\d+-.+\.md$/.test(name)).length;
    expect(realAdrFileCount).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(
      `[vi/intent] ${result.value.records.length}/${realAdrFileCount} real ADR files classified into the intent plane`,
      `— ${result.value.danglingCitations.length} dangling citation token(s),`,
      `${result.value.orphanRecordIds.length} orphan record(s),`,
      `${result.value.testOnlyGovernedRecordIds.length} test-only governed record(s)`,
    );

    // As of this port the real corpus has zero unparseable files
    // (tests/record/corpus.test.ts pins this), so every real ADR file is
    // expected to classify into a record.
    expect(result.value.records.length).toBe(realAdrFileCount);

    // Citations to records that do not exist locally (revoy-spec-numbered ones,
    // among others) must surface as dangling rather than being silently
    // attached to a same-numbered local record.
    //
    // This used to pin one specific token — `ADR-036` — as the proxy for that
    // property. That made the assertion true only for as long as nobody
    // authored a local ADR-036, and it broke the moment someone did
    // (2026-08-07). The number was never the contract; not-resolving-to-a-local
    // -record was. Asserting the invariant directly is both stronger and immune
    // to the corpus growing — deliberately so, since `ADR-037` is the next
    // token in the dangling set and re-pinning would re-arm the same trap.
    const localRecordIds = new Set(result.value.records.map((r) => r.id));
    expect(result.value.danglingCitations.length).toBeGreaterThan(0);
    for (const dangling of result.value.danglingCitations) {
      expect(localRecordIds.has(dangling.token)).toBe(false);
    }
  });

  it("reports a not-ok result for a nonexistent decisions directory instead of throwing", () => {
    const result = buildIntentGraph(join(REPO_ROOT, "no-such-directory-at-all"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unavailable");
  });
});
