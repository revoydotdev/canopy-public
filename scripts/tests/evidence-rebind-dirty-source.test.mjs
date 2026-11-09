/**
 * scripts/tests/evidence-rebind-dirty-source.test.mjs — the rebind chain refuses
 * a dirty source tree.
 *
 * WHY THIS IS PINNED. `evidence:rebind` stamps the VI graph with the CURRENT
 * tree's input identity and, unlike `evidence:refresh-atomic`, creates no
 * evidence-transaction snapshot for a dirty build to be checked against. Run
 * over dirty source it produces a graph describing a state no commit has, which
 * `gate:vi-freshness` rejects and which no in-place edit can repair — the fix is
 * a full rebind on a clean tree, and if the dirty paths belong to another
 * session they are not yours to commit or revert at all. That happened on
 * 2026-08-29.
 *
 * The distinction the guard has to get right is evidence-vs-source: rewriting
 * the evidence stores IS this chain's job, so dirt there must not block it,
 * while dirt anywhere else must.
 */
import { describe, it, expect } from "vitest";
import { dirtySourcePaths } from "../evidence-rebind.mjs";
import { EVIDENCE_PATH_PREFIXES } from "../evidence-transaction.mjs";

/** A fake `git status --porcelain` so the assertions do not depend on the live tree. */
const runner = (lines) => () => lines.join("\n");

describe("dirtySourcePaths", () => {
  it("reports modified and untracked source paths", () => {
    expect(dirtySourcePaths(".", runner([
      " M packages/arbor-tui/src/renderer.ts",
      "?? decisions/ADR-150-something.md",
      "M  scripts/hooks/commit-msg",
    ]))).toEqual([
      "packages/arbor-tui/src/renderer.ts",
      "decisions/ADR-150-something.md",
      "scripts/hooks/commit-msg",
    ]);
  });

  it("ignores evidence paths, because rewriting them is the chain's own job", () => {
    const evidence = EVIDENCE_PATH_PREFIXES.map((prefix) => ` M ${prefix}manifest.json`);
    expect(dirtySourcePaths(".", runner(evidence))).toEqual([]);
  });

  it("slices the path from the raw porcelain line, not a trimmed one", () => {
    // The prefix is a fixed three columns. Trimming first eats the leading
    // status column on an unstaged change and truncates every path by one
    // character — which it did, reporting "ackages/..." on the first run.
    expect(dirtySourcePaths(".", runner([" M packages/arbor-tui/src/syntax.ts"])))
      .toEqual(["packages/arbor-tui/src/syntax.ts"]);
  });

  it("takes the destination of a rename, which is what would be measured", () => {
    expect(dirtySourcePaths(".", runner(["R  scripts/old.mjs -> scripts/new.mjs"])))
      .toEqual(["scripts/new.mjs"]);
  });

  it("is empty on a clean tree, and safe when git itself fails", () => {
    expect(dirtySourcePaths(".", runner([]))).toEqual([]);
    expect(dirtySourcePaths(".", () => null)).toEqual([]);
  });

  it("reports a mixed tree's source paths only", () => {
    expect(dirtySourcePaths(".", runner([
      " M .visual-intelligence/graph/nodes.jsonl",
      " M AGENTS.md",
      " M .claim-ledger/manifest.json",
    ]))).toEqual(["AGENTS.md"]);
  });
});
