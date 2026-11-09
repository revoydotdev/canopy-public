import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveRepositoryCounts } from "../../src/counts/derive.js";

// vitest runs from the repo root, so process.cwd() is the real checkout —
// these assertions run against the actual repository, not a fixture, per
// this branch's dispatch brief ("assert against the real repo so the test
// fails if the repo changes, which is the point").
const REPO_ROOT = process.cwd();

describe("deriveRepositoryCounts — real repo", () => {
  it("is a pure function: two calls return a deep-equal result", () => {
    expect(deriveRepositoryCounts(REPO_ROOT)).toEqual(deriveRepositoryCounts(REPO_ROOT));
  });

  it("counts adr_total from the allocation registry and excludes pending drafts", () => {
    const registry = JSON.parse(readFileSync(join(REPO_ROOT, "decisions", "registry.json"), "utf8")) as { allocations: unknown[] };
    const expected = registry.allocations.length;
    expect(expected).toBeGreaterThan(0);
    expect(deriveRepositoryCounts(REPO_ROOT).adr_total).toBe(expected);
  });

  it("counts catalog_kinds as the 195 distinct kind literals in the manifest RUNTIME_CATALOG aliases", () => {
    // `RUNTIME_CATALOG` is `export const RUNTIME_CATALOG = RUNTIME_CATALOG_MANIFEST;`
    // (packages/arbor-mcp/src/runtime-catalog.ts), a one-line alias onto the
    // array literal in packages/arbor-core/src/runtime-catalog-manifest.ts. The
    // deriver used to look only for an array literal bound to the name, found
    // none, and returned **0 as a measurement** — the absence-as-zero defect
    // this module exists to prevent, live in the quantity SUR-05 compares prose
    // against. This assertion is the control that caught it: it expected 163
    // and received 0.
    //
    // The literal is pinned (unlike src_files/test_files/packages below) because
    // the property worth protecting is that the alias hop resolves AT ALL, and
    // a self-consistency check cannot distinguish "resolved and counted 0" from
    // "did not resolve". 163 was the count before `bcb0f831` added the 32
    // `repo.flight.*` kinds; `supported` is still 163, which is what made 163
    // look current.
    expect(deriveRepositoryCounts(REPO_ROOT).catalog_kinds).toBe(195);
  });

  it("counts allowlist_entries as scripts/reachability/allowlist.json's .entries length", () => {
    // NOT pinned to a literal, unlike catalog_kinds above. Allowlist size is
    // inherently volatile by design: entries are dated and self-cancelling, so
    // they are added when substrate lands and removed when it is wired or
    // deleted. This test originally pinned 76 and immediately broke when the
    // 41 ADR-027 entries for @arbor/governance were added — a false failure
    // that reported a legitimate change as a defect.
    //
    // The property actually worth asserting is self-consistency: the derived
    // count must equal the file's real length, whatever that length is. That
    // catches a broken deriver, which is the thing this module can get wrong.
    const allowlistPath = join(REPO_ROOT, "scripts/reachability/allowlist.json");
    const parsed = JSON.parse(readFileSync(allowlistPath, "utf8")) as { entries: unknown[] };
    expect(parsed.entries.length).toBeGreaterThan(0);
    expect(deriveRepositoryCounts(REPO_ROOT).allowlist_entries).toBe(parsed.entries.length);
  });

  it("counts packages as the number of directories under packages/", () => {
    const packagesDir = join(REPO_ROOT, "packages");
    const expected = readdirSync(packagesDir).filter((entry) => statSync(join(packagesDir, entry)).isDirectory()).length;
    expect(expected).toBeGreaterThan(0);
    expect(deriveRepositoryCounts(REPO_ROOT).packages).toBe(expected);
  });

  // src_files and test_files are NOT pinned to a single hardcoded literal.
  // This branch's dispatch brief states src_files "should be 151"; measured
  // directly at the time this test was written it was 154 even before this
  // task's own changes, and by the time all four governance sub-agents'
  // concurrent work had landed in this shared worktree it measured 171 (see
  // this task's final report for the exact numbers and how they were
  // measured) — three OTHER sub-agents are adding files under
  // packages/arbor-governance/src/** and packages/*/tests/** in this same
  // worktree at the same time this file is being written, so any single
  // hardcoded count would already be stale before this pass finishes,
  // independent of derive.ts's own correctness. Instead, each count is
  // cross-checked against an independently-written glob in this test file,
  // so this test still fails the moment derive.ts's OWN counting logic goes
  // wrong (wrong extension filter, wrong directory, off-by-one), without
  // being coupled to a snapshot that three concurrent lanes are actively
  // moving.
  it("counts src_files as packages/*/src/**/*.{ts,tsx} (independently re-globbed), excluding .d.ts", () => {
    function walk(dir: string, out: string[]): void {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
      }
    }
    const packagesDir = join(REPO_ROOT, "packages");
    let expected = 0;
    for (const pkg of readdirSync(packagesDir)) {
      const srcDir = join(packagesDir, pkg, "src");
      try {
        if (statSync(srcDir).isDirectory()) {
          const files: string[] = [];
          walk(srcDir, files);
          expected += files.length;
        }
      } catch {
        // no src/ for this package — nothing to count
      }
    }
    expect(expected).toBeGreaterThan(0);
    expect(deriveRepositoryCounts(REPO_ROOT).src_files).toBe(expected);
  });

  it("counts test_files as packages/*/tests/**/*.test.ts plus scripts/tests/**/*.test.mjs (independently re-globbed)", () => {
    function walk(dir: string, matches: (name: string) => boolean, out: string[]): void {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, matches, out);
        else if (matches(entry)) out.push(full);
      }
    }
    const packagesDir = join(REPO_ROOT, "packages");
    const files: string[] = [];
    for (const pkg of readdirSync(packagesDir)) {
      const testsDir = join(packagesDir, pkg, "tests");
      try {
        if (statSync(testsDir).isDirectory()) walk(testsDir, (name) => name.endsWith(".test.ts"), files);
      } catch {
        // no tests/ for this package — nothing to count
      }
    }
    const scriptsTestsDir = join(REPO_ROOT, "scripts/tests");
    try {
      if (statSync(scriptsTestsDir).isDirectory()) walk(scriptsTestsDir, (name) => name.endsWith(".test.mjs"), files);
    } catch {
      // no scripts/tests/ — nothing to count
    }
    expect(files.length).toBeGreaterThan(0);
    expect(deriveRepositoryCounts(REPO_ROOT).test_files).toBe(files.length);
  });

  /**
   * This test used to be named "returns 0 rather than throwing" and asserted a
   * bare all-zero object. It made the absence-as-zero defect look deliberate:
   * a reader would conclude that an unreadable source legitimately measures
   * zero. It does not — those zeros meant "not known", and `checkCounts`
   * compared prose against them, which would have reported every truthful
   * document as drifted with remediation text saying to write 0.
   *
   * Not throwing is still right. What changed is that the result now says
   * which quantities are not measurements.
   */
  it("does not throw for a repo root with none of the expected structure, and marks the quantities unmeasured", () => {
    const empty = deriveRepositoryCounts("/nonexistent-repo-root-for-derive-test");

    expect(empty.adr_total).toBe(0);
    expect(empty.catalog_kinds).toBe(0);
    expect(empty.allowlist_entries).toBe(0);
    expect(empty.packages).toBe(0);

    // The zeros above are only honest because of this: each is declared to be
    // an unread source rather than a counted nothing.
    expect([...empty.unmeasured].sort()).toEqual(
      ["adr_total", "allowlist_entries", "catalog_kinds", "packages"],
    );
  });

  it("reports nothing unmeasured against the real repository, so the flag means what it says", () => {
    expect(deriveRepositoryCounts(REPO_ROOT).unmeasured).toEqual([]);
  });
});
