import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIntentGraph } from "../../packages/arbor-governance/src/vi/intent.ts";
import { profileOrDefaults } from "../lib/project-profile.mjs";

/**
 * scripts/tests/citation-roots.test.mjs — `citation_roots` is a SEPARATE
 * list from `source_roots`, and unset means "same as source_roots".
 *
 * WHY THE TWO LISTS HAD TO SPLIT. One key was being asked to mean two
 * incompatible things. Most consumers read `source_roots` as "this is a
 * PACKAGE TREE": `scripts/typecheck-tests.mjs` requires a
 * `tsconfig.tests.json` in every immediate subdirectory of every declared
 * root and FAILS CLOSED without one, and `anti-stub.mjs`,
 * `artifact/scan.ts` and `counts/derive.ts` all assume a `<root>/<pkg>/src`
 * shape. `deriveCitations` reads the same key as "this is a
 * CITATION-BEARING TREE" — a weaker, different claim, since a directory can
 * hold governed code that cites decisions without being a package tree.
 *
 * revoy2 is exactly that case: its governance machinery lives in `scripts/`,
 * so accepted records cited only by that machinery were counted as orphans
 * purely because nothing scanned there. Widening `source_roots` to
 * fix it would have made `typecheck-tests` fail on all eight subdirectories
 * of `scripts/`, none of which is a TypeScript package — measured, not
 * assumed. Hence a second list.
 *
 * The fixture below is the minimum that can tell the two apart: sources
 * under `src/`, and a citation that exists ONLY under `tooling/`, which is
 * deliberately not a package tree. If the citation scan is driven by
 * `source_roots` the tooling citation is invisible; if it is driven by
 * `citation_roots` it resolves.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/**
 * A fixture whose only source root is `src/`, with its ADR cited from TWO
 * places: `src/` (always scanned) and `tooling/` (scanned only when
 * citation_roots says so).
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "citation-roots-"));
  dirs.push(dir);

  const srcDir = join(dir, "src/widget/src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "index.ts"), "// Implements ADR-001\nexport function w() { return 1; }\n");

  // Not a package tree: no <pkg>/src beneath it, exactly like revoy2's own
  // scripts/ directory. This is the file the split exists to reach.
  mkdirSync(join(dir, "tooling"), { recursive: true });
  writeFileSync(join(dir, "tooling/gate.mjs"), "// Implements ADR-002\nexport const gate = () => 0;\n");

  const decisionsDir = join(dir, "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  for (const [num, slug, title] of [["001", "src-decision", "Src Decision"], ["002", "tooling-decision", "Tooling Decision"]]) {
    writeFileSync(
      join(decisionsDir, `ADR-${num}-${slug}.md`),
      [`# ADR-${num}: ${title}`, "", "**Status:** Accepted", "**Date:** 2026-08-18", "",
       "## Context", "", "Fixture-only record.", "",
       "## Decision", "", "Prove citation_roots is honored.", "",
       "## Consequences", "", "None outside this fixture.", ""].join("\n"),
    );
  }
  return dir;
}

const citedRecords = (graph) => new Set(graph.citations.map((c) => c.recordId));

describe("citation_roots — the citation scan is steered separately from the package tree", () => {
  it("UNSET is a no-op: omitting citationRoots reproduces sourceRoots exactly", () => {
    const dir = fixture();
    const withOut = buildIntentGraph(dir, { decisionsDir: "decisions", sourceRoots: ["src"] });
    const explicit = buildIntentGraph(dir, { decisionsDir: "decisions", sourceRoots: ["src"], citationRoots: ["src"] });
    expect(withOut.ok && explicit.ok).toBe(true);
    // Byte-identical, not merely similar — this is the compatibility claim
    // every existing profile depends on.
    expect(JSON.stringify(withOut.value.citations)).toEqual(JSON.stringify(explicit.value.citations));
    expect([...citedRecords(withOut.value)]).toEqual(["ADR-001"]);
  });

  it("a citation that lives OUTSIDE the source roots is invisible without citation_roots", () => {
    const dir = fixture();
    const g = buildIntentGraph(dir, { decisionsDir: "decisions", sourceRoots: ["src"] });
    expect(g.ok).toBe(true);
    // ADR-002 is cited only from tooling/, which sourceRoots does not name.
    expect(citedRecords(g.value).has("ADR-002")).toBe(false);
    expect(g.value.orphanRecordIds).toContain("ADR-002");
  });

  it("declaring citation_roots resolves it WITHOUT declaring tooling/ a package tree", () => {
    const dir = fixture();
    const g = buildIntentGraph(dir, { decisionsDir: "decisions", sourceRoots: ["src"], citationRoots: ["src", "tooling"] });
    expect(g.ok).toBe(true);
    expect(citedRecords(g.value).has("ADR-002")).toBe(true);
    expect(g.value.orphanRecordIds).not.toContain("ADR-002");
    // The src/ citation is not lost when the list widens.
    expect(citedRecords(g.value).has("ADR-001")).toBe(true);
    // sourceRoots is untouched, which is the whole point: nothing here
    // asserts tooling/ is a package, so typecheck-tests and the artifact
    // scan keep their own narrower view.
    const cite = g.value.citations.find((c) => c.recordId === "ADR-002");
    expect(cite.citingPath).toBe("tooling/gate.mjs");
  });

  it("profileOrDefaults resolves an unset citation_roots to source_roots", () => {
    const dir = fixture();
    writeFileSync(
      join(dir, "arbor.profile.jsonc"),
      JSON.stringify({ schema_version: 1, project_id: "f", language: "typescript", source_roots: ["src"] }, null, 2),
    );
    const p = profileOrDefaults(dir);
    expect(p.source_roots).toEqual(["src"]);
    expect(p.citation_roots).toEqual(["src"]);
  });

  it("this repository declares scripts/ as a citation root but NOT as a source root", () => {
    // The live claim, asserted against the real profile: the split is not
    // hypothetical here, it is what revoy2 actually depends on.
    const p = profileOrDefaults(REPO_ROOT);
    expect(p.source_roots).toEqual(["packages"]);
    expect(p.citation_roots).toEqual(["packages", "scripts"]);
  });

  it("TEETH: records governed only from scripts/ are orphans again if that citation root is dropped", () => {
    const narrow = buildIntentGraph(REPO_ROOT, { decisionsDir: "decisions", sourceRoots: ["packages"] });
    const wide = buildIntentGraph(REPO_ROOT, { decisionsDir: "decisions", sourceRoots: ["packages"], citationRoots: ["packages", "scripts"] });
    expect(narrow.ok && wide.ok).toBe(true);
    const narrowOrphans = new Set(narrow.value.orphanRecordIds);
    const wideOrphans = new Set(wide.value.orphanRecordIds);
    const rescuedByScripts = [...narrowOrphans].filter((id) => !wideOrphans.has(id));
    expect(rescuedByScripts.length).toBeGreaterThan(0);
    for (const id of rescuedByScripts) {
      expect(narrowOrphans.has(id)).toBe(true);
      expect(wideOrphans.has(id)).toBe(false);
      expect(wide.value.citations.some((citation) => citation.recordId === id && citation.citingPath.startsWith("scripts/"))).toBe(true);
    }
    // Widening must not orphan anything that was governed before.
    for (const id of wideOrphans) expect(narrowOrphans.has(id)).toBe(true);
  });
});
