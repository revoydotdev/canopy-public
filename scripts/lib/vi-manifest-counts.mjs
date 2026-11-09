#!/usr/bin/env node
/**
 * scripts/lib/vi-manifest-counts.mjs — compare a manifest's `counts` to the graph
 * bytes sitting beside it.
 *
 * WHY THIS EXISTS (CD-BR-04). `gate:vi-freshness` read `.visual-intelligence/
 * manifest.json` and nothing else. A gate that reads only a summary of a thing
 * can assert that the summary is internally well-formed; it can never assert
 * that the summary matches reality. `.visual-intelligence/graph/` is gitignored
 * (`.gitignore:81`) and regenerable, so "the graph is not in git" is not a
 * reason to stop checking — the graph is on disk in every checkout that has run
 * `vi:refresh`, which is every checkout whose graph anyone is reading.
 *
 * The observed defect this makes visible: the committed manifest records
 * nodes 36,132 / edges 110,106 / evidence 48,117, while the graph files beside
 * it held 35,816 / 133,087 / 47,955 — wrong on ALL THREE artifacts, and the
 * edges gap is negative, so the manifest is not merely stale, it describes a
 * DIFFERENT GENERATION. Both numbers are correct for their own source; the
 * point is that they are different and nothing said so. Never mix them: this
 * module labels every figure with the source it came from.
 *
 * FOUR STATES, and `not_observed` is deliberately NOT one of the good ones.
 * A check that cannot run must never be reported as a check that passed — that
 * is the shape of every "green by becoming unable to see" in this repository.
 *
 *   agreed        every artifact's line count equals its recorded count
 *   disagreed     at least one does not — the counts describe another graph
 *   incomplete    the graph directory exists but a file is missing or empty,
 *                 so the counts can be neither confirmed nor refuted
 *   not_observed  there is no graph on disk at all; the counts are UNVERIFIED
 *
 * `not_observed` is not a failure. A fresh clone has no graph by design (the
 * directory is gitignored and regenerated on demand), and failing every clone
 * would be a gate that trips correct workflow. It is also not a pass: the
 * caller must print it as unobserved and must not print agreement.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** The three artifacts `manifest.counts` names, and the file each one lives in. */
export const COUNTED_ARTIFACTS = Object.freeze([
  { name: "nodes", file: "nodes.jsonl" },
  { name: "edges", file: "edges.jsonl" },
  { name: "evidence", file: "evidence.jsonl" },
]);

/**
 * Count newline-terminated records in a file without holding it in memory.
 * edges.jsonl is ~78MB and grows with the repository; the gate runs on prepush
 * and in CI, so it should not allocate the whole graph to count its lines.
 */
export function countJsonlLines(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let lines = 0;
    let read = 0;
    let lastByte = -1;
    do {
      read = readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      for (let i = 0; i < read; i += 1) if (buf[i] === 0x0a) lines += 1;
      lastByte = buf[read - 1];
    } while (read === buf.length);
    // A final record with no trailing newline is still a record. writeJsonl
    // always terminates, but a hand-edited or truncated file may not, and
    // undercounting by one here would manufacture a false mismatch.
    return lastByte === 0x0a || lastByte === -1 ? lines : lines + 1;
  } finally {
    closeSync(fd);
  }
}

/**
 * Compare `manifest.counts` against the graph bytes in `graphDir`.
 *
 * @param {object} manifest parsed `.visual-intelligence/manifest.json`
 * @param {string} graphDir  directory holding nodes/edges/evidence .jsonl
 * @returns {{state: "agreed"|"disagreed"|"incomplete"|"not_observed",
 *            reason: string|null, artifacts: Array<object>}}
 */
export function compareManifestCountsToGraphBytes(manifest, graphDir) {
  const counts = manifest?.counts ?? {};
  if (!existsSync(graphDir)) {
    return {
      state: "not_observed",
      reason: `no graph on disk at ${graphDir}; manifest counts were NOT compared against graph bytes`,
      artifacts: [],
    };
  }

  const artifacts = [];
  const missing = [];
  for (const { name, file } of COUNTED_ARTIFACTS) {
    const path = join(graphDir, file);
    const recorded = Number.isInteger(counts[name]) ? counts[name] : null;
    if (!existsSync(path) || statSync(path).size === 0) {
      missing.push(`${file} (${existsSync(path) ? "empty" : "absent"})`);
      artifacts.push({ name, file, recorded, onDisk: null, delta: null });
      continue;
    }
    const onDisk = countJsonlLines(path);
    artifacts.push({ name, file, recorded, onDisk, delta: recorded === null ? null : recorded - onDisk });
  }

  if (missing.length > 0) {
    return {
      state: "incomplete",
      reason:
        `graph directory exists but ${missing.join(", ")} — a partial graph can neither confirm ` +
        "nor refute the manifest counts, and a partial graph must never read as agreement",
      artifacts,
    };
  }
  const drifted = artifacts.filter((a) => a.delta !== 0);
  return {
    state: drifted.length === 0 ? "agreed" : "disagreed",
    reason:
      drifted.length === 0
        ? null
        : "manifest counts do not describe the graph bytes beside them; " +
          "writeJsonl returns the count it wrote, so within one run these cannot differ",
    artifacts,
  };
}
