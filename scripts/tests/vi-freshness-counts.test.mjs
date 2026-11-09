#!/usr/bin/env node
/**
 * scripts/tests/vi-freshness-counts.test.mjs
 *
 * The check that CD-BR-04 needed and did not have: does the freshness gate's
 * count comparison actually see the graph bytes, or does it merely reason from
 * a summary? Every expectation below is written as a literal — 36132, 110106,
 * 48117, 35816, 133087, 47955, +316, -22981, +162 — taken from the declared
 * expected set in `.omo/graph-remediation/evidence/todo-21-DECLARED-EXPECTED-SET.txt`,
 * which was written before any of this code. Nothing here derives an
 * expectation from the function under test; that mistake has been made six
 * times in this repository and approving a widening by construction is worse
 * than having no control at all.
 *
 * Run: ./node_modules/.bin/vitest run scripts/tests/vi-freshness-counts.test.mjs
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareManifestCountsToGraphBytes,
  countJsonlLines,
} from "../lib/vi-manifest-counts.mjs";

/** manifest.counts as committed in .visual-intelligence/manifest.json. */
const MANIFEST_COUNTS = { nodes: 36132, edges: 110106, evidence: 48117 };
/** The graph that was on disk beside it. Three different numbers on purpose. */
const ON_DISK_COUNTS = { nodes: 35816, edges: 133087, evidence: 47955 };

let root;

function graphWith(counts) {
  const dir = join(root, `graph-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, n] of Object.entries(counts)) {
    // `("x\n").repeat(n)` is n newline-terminated records. NOTE: do not reach
    // for `padEnd(n, "x\n")` here — that pads to a LENGTH in characters, so it
    // yields about n/2 records, and a fixture that does not do what its name
    // says is indistinguishable from a control that does not fire.
    writeFileSync(join(dir, `${name}.jsonl`), "x\n".repeat(n), "utf8");
  }
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "vi-counts-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("countJsonlLines", () => {
  it("counts records, not lines of file: a final line with no newline is a record", () => {
    const p = join(root, "no-trailing-newline.jsonl");
    writeFileSync(p, "a\nb\nc", "utf8");
    expect(countJsonlLines(p)).toBe(3);
  });

  it("counts an empty file as 0, not 1", () => {
    const p = join(root, "empty.jsonl");
    writeFileSync(p, "", "utf8");
    expect(countJsonlLines(p)).toBe(0);
  });
});

describe("compareManifestCountsToGraphBytes — the four states", () => {
  it("POSITIVE: agrees when the graph's line counts are the recorded counts", () => {
    const result = compareManifestCountsToGraphBytes({ counts: MANIFEST_COUNTS }, graphWith(MANIFEST_COUNTS));
    expect(result.state).toBe("agreed");
    // Set equality, not a one-sided membership test. A membership assertion
    // survives deletion from the expected list; this does not.
    expect(result.artifacts.map((a) => a.name)).toEqual(["nodes", "edges", "evidence"]);
    expect(result.artifacts.map((a) => a.onDisk)).toEqual([36132, 110106, 48117]);
    expect(result.artifacts.every((a) => a.delta === 0)).toBe(true);
  });

  it("NEGATIVE: disagrees on all three artifacts, with the register's deltas", () => {
    const result = compareManifestCountsToGraphBytes({ counts: MANIFEST_COUNTS }, graphWith(ON_DISK_COUNTS));
    expect(result.state).toBe("disagreed");
    expect(result.artifacts.map((a) => a.delta)).toEqual([316, -22981, 162]);
    // The negative edge delta is the load-bearing detail: no amount of
    // one-directional staleness produces it, so these are two generations.
    expect(result.artifacts[1].delta).toBeLessThan(0);
  });

  it("NEGATIVE: a graph directory that exists but is missing a file is INCOMPLETE, never agreed", () => {
    const dir = join(root, "partial-graph");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nodes.jsonl"), "x\n".repeat(10), "utf8");
    const result = compareManifestCountsToGraphBytes({ counts: MANIFEST_COUNTS }, dir);
    expect(result.state).toBe("incomplete");
    expect(result.reason).toMatch(/absent|empty/);
  });

  it("NEGATIVE: no graph at all is NOT_OBSERVED, a state distinct from agreed", () => {
    const result = compareManifestCountsToGraphBytes(
      { counts: MANIFEST_COUNTS },
      join(root, "does-not-exist"),
    );
    expect(result.state).toBe("not_observed");
    // The distinction the whole fix turns on. If these two ever collapse, the
    // gate reports agreement for a graph it never opened.
    expect(result.state).not.toBe("agreed");
    expect(result.artifacts).toEqual([]);
  });

  it("a manifest with no counts block reports them as absent rather than zero-matching", () => {
    const result = compareManifestCountsToGraphBytes({}, graphWith(MANIFEST_COUNTS));
    expect(result.state).toBe("disagreed");
    expect(result.artifacts.map((a) => a.recorded)).toEqual([null, null, null]);
  });
});

/**
 * The committed manifest is a GENERATED file, so the mismatch block, the
 * overlap figures and the count provenance in it were hand-declared rather than
 * emitted. A hand-declared block with no control is a comment. These assert the
 * declarations are present, machine-readable, and carry the figures the register
 * records — as literals, not read back out of the file under test.
 */
describe("the committed .visual-intelligence/manifest.json states what its counts are", () => {
  // This block used to pin one hand-annotated generation (2026-09-24's
  // 22,981-edge disagreement). Any rebind replaces that manifest, so the pins
  // failed every regeneration. What must hold for EVERY generation is below;
  // the generation check itself is tested against the real extractor in
  // vi-extract-ts-tree-state.test.mjs.
  const manifest = JSON.parse(
    readFileSync(new URL("../../.visual-intelligence/manifest.json", import.meta.url), "utf8"),
  );

  it("any generation_mismatch gap carries both sides, by source, as numbers", () => {
    const gap = manifest.extraction_gaps.find((g) => g.reason === "generation_mismatch");
    if (gap === undefined) return;
    // The extractor records this gap only when a prior graph was on disk, so
    // both sides always exist together. A gap with no `prior_on_disk` was written
    // by the pre-03401352 extractor, which compared against its own run's counts:
    // this manifest is a stale generation and the next rebind replaces it. Say so
    // rather than failing inside Object.keys(undefined).
    expect(
      gap.prior_on_disk,
      "generation_mismatch gap has no prior_on_disk side: committed manifest predates 03401352; rebind it",
    ).toBeDefined();
    for (const side of [gap.prior, gap.prior_on_disk]) {
      expect(Object.keys(side)).toEqual(expect.arrayContaining(["nodes", "edges", "evidence"]));
      expect(typeof side.edges).toBe("number");
    }
  });

  it("records the non-disjointness of its history counters, as numbers", () => {
    expect(manifest.history.counters_are_disjoint).toBe(false);
    expect(typeof manifest.history.overlap.edges).toBe("number");
    expect(manifest.history.do_not_sum).toMatch(/double-counts/);
  });

  it("labels counts with the run that wrote them, at the manifest's own revision", () => {
    expect(manifest.counts.source).toMatch(/lines written by this run/);
    expect(manifest.counts.revision).toBe(manifest.repo_revision);
  });
});
