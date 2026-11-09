#!/usr/bin/env node
/**
 * scripts/lib/vi-reachability-labelling.mjs — check the labelling of every
 * `reachable_from` edge in `graph/edges.jsonl` (CD-BR-04 / CD-CD-02).
 *
 * WHY THIS IS A LIBRARY AND NOT A FUNCTION IN THE GATE. `vi-freshness-gate.mjs`
 * ends in `process.exit(main())` at module scope, so importing it from a test
 * runs the whole gate and kills the test process. The sibling check from the
 * same gate — `manifest.counts` versus the graph bytes — was extracted to
 * `lib/vi-manifest-counts.mjs` for exactly this reason and is tested that way;
 * this module follows that established route rather than inventing a second one.
 * The gate imports both and passes its own paths in, so the bytes it reads are
 * unchanged.
 *
 * WHY THE CHECK EXISTS AT ALL. The manifest is metadata and says nothing about
 * how an edge is labelled; the labels are payload, living in `edges.jsonl`.
 * Before this, every consumer went through a consumer-side quarantine rule, so
 * nothing was visibly wrong — the defect was LATENT, reachable only by whoever
 * opened the file directly, which is exactly what a third party does.
 *
 * `reachable_from` is an INFERENCE — a breadth-first search over an adjacency
 * that is itself inferred. It is not a resolved call site, and it is not a
 * citation. The extractor used to write `evidence_type: "ast_call"` (the same
 * field it writes for a real resolved call, and the modal value of the whole
 * corpus) and `confidence: "high"`, so a consumer reading `edges.jsonl` with
 * nothing but a JSON parser read every inferred edge as compiler-grade AST
 * evidence. `CD-CD-02`.
 *
 * THE GATE IS RED ON THIS REPOSITORY AND THAT IS CORRECT. Every `reachable_from`
 * edge in the live corpus carries a forbidden label, because the labelling fix
 * has not shipped into the extractor. A test asserting this gate is green would
 * be asserting the defect. The tests drive fixtures and assert the gate blocks
 * on a forbidden label and stays quiet on an allowed one.
 *
 * THREE OUTCOMES, and only one of them is a pass. The failure this repository
 * keeps shipping is a gate that reports green while observing nothing.
 *
 *   absent  — no graph on disk. Legitimate: the graph is gitignored, so a fresh
 *             clone has the manifest and nothing else. Reported as NOT CHECKED
 *             in its own words. It is not a pass on this check, and it does not
 *             fail, because failing would make the gate unusable everywhere the
 *             graph is not built.
 *   empty   — graph present, and ZERO `reachable_from` edges. That is a
 *             contradiction with a manifest that declares entry-point roots, and
 *             it FAILS. An empty input set is never a clean bill of health.
 *   checked — counted, and any forbidden label fails with the offending ids.
 *
 * NOTE ON `empty`. In the merged version this branch was DEAD: the check only
 * ever returned `absent` or `checked`, and the reporter's `empty` arm was
 * followed by a second, live `result.reachable === 0` arm doing the same job.
 * The check now returns `empty` when nothing reachable was found, which makes
 * the documented arm the single reachable one. Nothing is weakened: both arms
 * pushed the same failure, and a graph with zero `reachable_from` edges still
 * blocks exactly as before.
 */

import { existsSync, readFileSync } from "node:fs";

/**
 * The two labels a reachability edge must never carry. Named as constants so
 * the rule is one comparison each, and so a future producer cannot quietly
 * reintroduce either.
 */
export const FORBIDDEN_ON_REACHABILITY = Object.freeze([
  Object.freeze({ field: "evidence_type", value: "ast_call", why: "a BFS is not a resolved call site" }),
  Object.freeze({
    field: "confidence",
    value: "high",
    why: "an inference with no path:line behind it cannot be high-confidence",
  }),
]);

/** The exact serialized form `writeJsonl` emits, which is what the prefilter matches. */
const REACHABLE_FROM = '"relation":"reachable_from"';

/**
 * Read `graph/edges.jsonl` and tally the labelling of its `reachable_from` edges.
 *
 * @param {string} graphEdgesPath path to `edges.jsonl`
 * @returns {{state: "absent"|"empty"|"checked", total: number, reachable: number,
 *            offending: number, examples: string[], evidenceTypes: Map<string, number>,
 *            confidences: Map<string, number>}}
 */
export function checkReachabilityLabelling(graphEdgesPath) {
  if (!existsSync(graphEdgesPath)) return { state: "absent" };
  const lines = readFileSync(graphEdgesPath, "utf8").split("\n");
  let total = 0;
  let reachable = 0;
  let offending = 0;
  const evidenceTypes = new Map();
  const confidences = new Map();
  const examples = [];
  for (const line of lines) {
    if (!line) continue;
    total += 1;
    if (!line.includes(REACHABLE_FROM)) continue;
    reachable += 1;
    const edge = JSON.parse(line);
    evidenceTypes.set(edge.evidence_type, (evidenceTypes.get(edge.evidence_type) ?? 0) + 1);
    confidences.set(edge.confidence, (confidences.get(edge.confidence) ?? 0) + 1);
    const bad = FORBIDDEN_ON_REACHABILITY.find((f) => edge[f.field] === f.value);
    if (!bad) continue;
    offending += 1;
    if (examples.length < 3) examples.push(`${edge.id} (${bad.field}="${bad.value}")`);
  }
  if (reachable === 0) return { state: "empty", total, reachable, offending, examples, evidenceTypes, confidences };
  return { state: "checked", total, reachable, offending, examples, evidenceTypes, confidences };
}

/**
 * Render a `checkReachabilityLabelling` result and push any failure onto
 * `failures`. Never returns a pass for a state it could not observe.
 */
export function reportReachabilityLabelling(result, failures) {
  const tally = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
  if (result.state === "absent") {
    console.log("  reachability labelling: NOT CHECKED — no .visual-intelligence/graph/edges.jsonl on disk.");
    console.log("    This is a distinct state, not a pass. Build the graph on a clean worktree with `bun run vi:refresh` to check it.");
    return;
  }
  if (result.state === "empty") {
    failures.push(
      "graph bytes are present and the manifest declares entry-point roots, but edges.jsonl contains 0 reachable_from edges — " +
      "the labelling of this gate could not be observed, and an unobserved set is not a clean one. Remedy: run `bun run vi:refresh` on a clean worktree.",
    );
    return;
  }
  console.log(`  reachability labelling: ${result.reachable}/${result.total} edges checked (read from graph bytes, not the manifest)`);
  console.log(`    evidence_type: ${tally(result.evidenceTypes) || "(none)"}`);
  console.log(`    confidence:    ${tally(result.confidences) || "(none)"}`);
  if (result.offending > 0) {
    failures.push(
      `${result.offending} of ${result.reachable} reachable_from edges carry a label this gate forbids ` +
      `(${FORBIDDEN_ON_REACHABILITY.map((f) => `${f.field}="${f.value}" — ${f.why}`).join("; ")}); e.g. ${result.examples.join(", ")} — ` +
      "CD-CD-02: an inferred edge is not AST-call evidence. Remedy: `bun run vi:refresh` on a clean worktree after the labelling fix.",
    );
  }
}
