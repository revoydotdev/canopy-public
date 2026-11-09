#!/usr/bin/env node
/**
 * scripts/tests/vi-reachability-labelling.test.mjs
 *
 * The control `checkReachabilityLabelling` never had. It merged in f50c56f3
 * (from f0027d72) and its ONLY evidence that it can fire was the merge worker's
 * four manual sandbox mutations — which is a claim, not a test. A check whose
 * sole evidence is one person's console output is the largest remaining
 * instance of the defect class this plan exists to kill: six times, a check was
 * caught approving the very thing it was meant to measure.
 *
 * WHAT IS UNDER TEST. `scripts/lib/vi-reachability-labelling.mjs` reads
 * `graph/edges.jsonl` and blocks when any `reachable_from` edge carries
 * `evidence_type: "ast_call"` (a BFS is not a resolved call site) or
 * `confidence: "high"` (an inference with no path:line behind it cannot be
 * high-confidence). CD-BR-04 / CD-CD-02.
 *
 * WHY A LIBRARY. `vi-freshness-gate.mjs` ends in `process.exit(main())` at
 * module scope, so importing it from a test runs the whole gate and kills the
 * worker. The sibling counts check from the same gate already lives in
 * `lib/vi-manifest-counts.mjs` and is tested the same way; this follows that
 * established route rather than inventing a second one.
 *
 * THE GATE IS RED ON THIS REPOSITORY AND THAT IS CORRECT. Every `reachable_from`
 * edge in the live corpus carries a forbidden label, because the labelling fix
 * has not shipped into the extractor. So NOTHING here reads the live corpus or
 * asserts this gate is green — that would be asserting the defect. Every
 * expectation is a literal written against a fixture, and `graph/` is gitignored
 * anyway, so a fresh clone has no graph to read.
 *
 * Run: ./node_modules/.bin/vitest run scripts/tests/vi-reachability-labelling.test.mjs
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkReachabilityLabelling,
  reportReachabilityLabelling,
  FORBIDDEN_ON_REACHABILITY,
} from "../lib/vi-reachability-labelling.mjs";

const GATE_SOURCE = new URL("../vi-freshness-gate.mjs", import.meta.url);

let root;
let seq = 0;

/**
 * Write a fixture `edges.jsonl` and return its path.
 *
 * `JSON.stringify` is used deliberately: the check pre-filters raw lines with
 * `line.includes('"relation":"reachable_from"')`, which is the exact compact
 * form `writeJsonl` emits. A fixture hand-written with spaces after the colons
 * would silently match nothing, and a fixture that does not do what its name
 * says is indistinguishable from a control that does not fire.
 */
function edgesFixture(edges) {
  seq += 1;
  const dir = join(root, `g${seq}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "edges.jsonl"),
    edges.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  return join(dir, "edges.jsonl");
}

/** An edge record carrying only what the check reads, plus an id for the example list. */
function edge(id, { relation = "reachable_from", evidence_type = "derived", confidence = "medium" }) {
  return { id, from: "a.ts#f", to: "b.ts#g", relation, evidence_type, confidence };
}

/** Run the reporter with console captured; return the failures it pushed and the text it printed. */
function report(result) {
  const failures = [];
  const printed = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line) => {
    printed.push(String(line));
  });
  try {
    reportReachabilityLabelling(result, failures);
  } finally {
    spy.mockRestore();
  }
  return { failures, printed: printed.join("\n") };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "vi-reachability-labelling-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("absent — no graph on disk is NOT a pass, and is not a fail either", () => {
  it("reports `absent` and nothing else when edges.jsonl does not exist", () => {
    const result = checkReachabilityLabelling(join(root, "no-such-dir", "edges.jsonl"));
    expect(result.state).toBe("absent");
    // The distinction the whole check turns on. If `absent` ever collapsed into
    // `checked`, the gate would report a clean bill of health for a graph it
    // never opened — green by becoming unable to see.
    expect(result.state).not.toBe("checked");
    // It claims nothing about the corpus, so it carries no counts to be
    // misread as a measurement of zero.
    expect(result.total).toBeUndefined();
    expect(result.offending).toBeUndefined();
  });

  it("prints NOT CHECKED in those words, blocks nothing, and does not claim agreement", () => {
    const { failures, printed } = report(checkReachabilityLabelling(join(root, "nope", "edges.jsonl")));
    // A fresh clone legitimately has no graph, so this state must not fail —
    // failing everywhere the graph is not built would make the gate unusable.
    expect(failures).toEqual([]);
    expect(printed).toMatch(/NOT CHECKED/);
    // ...and "not checked" must not read as "checked and clean".
    expect(printed).not.toMatch(/edges checked/);
  });
});

describe("allowed labels must NOT block — otherwise this is an always-red gate", () => {
  it("passes `derived` and every non-`high` confidence, with the exact planted tallies", () => {
    // Four reachable edges, none forbidden. `estimated` and `import` are here on
    // purpose: the rule forbids exactly two values, and a check that had
    // quietly become "anything that is not `derived`" or "anything above low"
    // would still pass this. The tallies below are asserted set-wise, so
    // narrowing the check to a smaller allow-set is visible.
    const result = checkReachabilityLabelling(
      edgesFixture([
        edge("a1", { evidence_type: "derived", confidence: "medium" }),
        edge("a2", { evidence_type: "import", confidence: "low" }),
        edge("a3", { evidence_type: "derived", confidence: "estimated" }),
        edge("a4", { evidence_type: "static", confidence: "low" }),
      ]),
    );
    expect(result.state).toBe("checked");
    expect(result.total).toBe(4);
    expect(result.reachable).toBe(4);
    // THE assertion this file exists for. Zero offending, not "fewer than some
    // bound" — a tolerance here would be the always-red gate wearing a number.
    expect(result.offending).toBe(0);
    expect(result.examples).toEqual([]);
    // Set equality both directions: a membership assertion survives deletion
    // from the expected set, and a widening of the check would change these.
    expect([...result.evidenceTypes.keys()].sort()).toEqual(["derived", "import", "static"]);
    expect([...result.confidences.keys()].sort()).toEqual(["estimated", "low", "medium"]);
  });

  it("pushes zero failures for a correctly labelled graph", () => {
    const { failures, printed } = report(
      checkReachabilityLabelling(
        edgesFixture([edge("ok1", { evidence_type: "derived", confidence: "low" })]),
      ),
    );
    expect(failures).toEqual([]);
    // It still reports having looked, so a reader can tell clean from unseen.
    expect(printed).toMatch(/1\/1 edges checked/);
  });
});

describe("forbidden label #1 — evidence_type: ast_call", () => {
  it("blocks every reachable edge carrying it, and names the offending ids", () => {
    const result = checkReachabilityLabelling(
      edgesFixture([
        edge("bad1", { evidence_type: "ast_call", confidence: "medium" }),
        edge("bad2", { evidence_type: "ast_call", confidence: "low" }),
        edge("bad3", { evidence_type: "ast_call", confidence: "estimated" }),
      ]),
    );
    expect(result.state).toBe("checked");
    expect(result.reachable).toBe(3);
    // Confidence is clean on all three, so this is attributable to evidence_type
    // alone — the two labels are separately controlled, not one merged count.
    expect(result.offending).toBe(3);
    // Exact strings, so the id and the field actually named are the ones read.
    expect(result.examples).toEqual([
      'bad1 (evidence_type="ast_call")',
      'bad2 (evidence_type="ast_call")',
      'bad3 (evidence_type="ast_call")',
    ]);
  });

  it("the failure names BOTH forbidden labels, the count, and the remedy", () => {
    const { failures } = report(
      checkReachabilityLabelling(edgesFixture([edge("bad1", { evidence_type: "ast_call" })])),
    );
    // Exactly one failure — not one per forbidden label, and not none.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^1 of 1 reachable_from edges carry a label this gate forbids/);
    // Both labels named. If either entry were deleted from the forbidden set,
    // this line fails as well as the behavioural test above.
    expect(failures[0]).toMatch(/evidence_type="ast_call" — a BFS is not a resolved call site/);
    expect(failures[0]).toMatch(/confidence="high" — an inference with no path:line behind it cannot be high-confidence/);
    // Gate rule 1 in scripts/README.md: the cause AND one remedy command.
    expect(failures[0]).toMatch(/vi:refresh/);
    expect(failures[0]).toMatch(/CD-CD-02/);
  });
});

describe("forbidden label #2 — confidence: high", () => {
  it("blocks a reachable edge whose evidence_type is clean but whose confidence is `high`", () => {
    const result = checkReachabilityLabelling(
      edgesFixture([
        edge("h1", { evidence_type: "derived", confidence: "high" }),
        edge("h2", { evidence_type: "import", confidence: "high" }),
      ]),
    );
    // evidence_type is `derived`/`import` on both — neither is `ast_call`. If
    // this ever stops blocking, the entry has been removed from the forbidden
    // set, which is the single most likely way this check gets weakened.
    expect(result.offending).toBe(2);
    expect(result.examples).toEqual(['h1 (confidence="high")', 'h2 (confidence="high")']);
  });

  it("counts each offending edge once, not once per matching forbidden label", () => {
    const result = checkReachabilityLabelling(
      edgesFixture([edge("both", { evidence_type: "ast_call", confidence: "high" })]),
    );
    expect(result.reachable).toBe(1);
    expect(result.offending).toBe(1);
    // `find`, not `filter`: the first matching rule is the one named.
    expect(result.examples).toEqual(['both (evidence_type="ast_call")']);
  });
});

describe("the check is scoped to reachable_from and nothing else", () => {
  it("ignores ast_call/high on OTHER relations, so widening the prefilter fails this", () => {
    // Four non-reachable edges carrying BOTH forbidden labels, two clean
    // reachable edges. `ast_call` is the correct, wanted label for a real
    // resolved call — forbidding it outside reachability would break the graph.
    const result = checkReachabilityLabelling(
      edgesFixture([
        edge("n1", { relation: "imports", evidence_type: "ast_call", confidence: "high" }),
        edge("n2", { relation: "declares", evidence_type: "ast_call", confidence: "high" }),
        edge("n3", { relation: "imports", evidence_type: "ast_call", confidence: "medium" }),
        edge("n4", { relation: "declares", evidence_type: "derived", confidence: "high" }),
        edge("r1", { evidence_type: "derived", confidence: "medium" }),
        edge("r2", { evidence_type: "import", confidence: "low" }),
      ]),
    );
    expect(result.total).toBe(6);
    expect(result.reachable).toBe(2);
    // The literal 2/6 is the load-bearing number: a check that scanned every
    // edge, or that derived its expected set from the rule under test, would
    // report something else here.
    expect(result.offending).toBe(0);
  });

  it("examples are capped at 3 while the count keeps rising", () => {
    const result = checkReachabilityLabelling(
      edgesFixture(
        Array.from({ length: 5 }, (_, i) => edge(`e${i + 1}`, { evidence_type: "ast_call" })),
      ),
    );
    // A bounded excerpt, but an UNBOUNDED count: the gate's number is the real
    // measure and must not be truncated to fit the message.
    expect(result.offending).toBe(5);
    expect(result.examples).toHaveLength(3);
    expect(result.examples).toEqual([
      'e1 (evidence_type="ast_call")',
      'e2 (evidence_type="ast_call")',
      'e3 (evidence_type="ast_call")',
    ]);
  });
});

describe("empty — graph present, nothing reachable to observe", () => {
  it("returns `empty` and FAILS, because an unobserved set is not a clean one", () => {
    // This arm of the reporter was DEAD in the merged version: the check only
    // ever returned `absent` or `checked`, so the documented `empty` state could
    // never be produced, and a second live `result.reachable === 0` branch did
    // the same job. The check now returns `empty` so the documented arm is the
    // one that runs. Nothing is weakened — a graph with zero reachable_from
    // edges blocked before this change and still blocks.
    const result = checkReachabilityLabelling(
      edgesFixture([
        edge("x1", { relation: "imports", evidence_type: "ast_call", confidence: "high" }),
        edge("x2", { relation: "declares", evidence_type: "derived", confidence: "medium" }),
        edge("x3", { relation: "imports", evidence_type: "derived", confidence: "low" }),
      ]),
    );
    expect(result.state).toBe("empty");
    // `empty` is its own state, distinct from both `absent` and `checked`.
    expect(result.state).not.toBe("absent");
    expect(result.state).not.toBe("checked");
    expect(result.total).toBe(3);
    expect(result.reachable).toBe(0);

    const { failures, printed } = report(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/0 reachable_from edges/);
    expect(failures[0]).toMatch(/vi:refresh/);
    // It must not print the "checked and clean" tally for a set it never saw.
    expect(printed).not.toMatch(/edges checked/);
  });

  it("an empty edges.jsonl is also `empty`, not a silent pass on zero records", () => {
    const path = edgesFixture([]);
    const result = checkReachabilityLabelling(path);
    expect(result.state).toBe("empty");
    expect(result.total).toBe(0);
    expect(report(result).failures).toHaveLength(1);
  });
});

describe("the forbidden set is the declared one", () => {
  it("carries exactly the two rules, each naming the field it guards", () => {
    // Deliberately NOT asserting the array length. A third forbidden label is a
    // legitimate change that should arrive with its own behavioural test, and
    // pinning the length here would only reward deleting an entry nobody
    // re-added. What is pinned is that BOTH declared rules are present, which
    // is what the two describe-blocks above exercise.
    expect(FORBIDDEN_ON_REACHABILITY.map((f) => f.field).sort()).toEqual(["confidence", "evidence_type"]);
    expect(FORBIDDEN_ON_REACHABILITY.map((f) => f.value).sort()).toEqual(["ast_call", "high"]);
    expect(FORBIDDEN_ON_REACHABILITY.every((f) => typeof f.why === "string" && f.why.length > 0)).toBe(true);
  });
});

describe("wiring — an exported, correct, never-called function is a comment", () => {
  it("the gate still calls the check with the graph's edges path", () => {
    const gate = readFileSync(GATE_SOURCE, "utf8");
    // This is a WIRING guard, not a behavioural one, and it is the only control
    // that can see the call at all: the gate cannot be imported (module-scope
    // process.exit), and running it as a subprocess would fail for a dozen
    // unrelated reasons (input binding, extraction gaps, count drift), so its
    // exit code proves nothing about this one check.
    expect(gate).toMatch(/import \{[^}]*checkReachabilityLabelling[^}]*reportReachabilityLabelling[^}]*\} from "\.\/lib\/vi-reachability-labelling\.mjs"/);
    expect(gate).toMatch(/reportReachabilityLabelling\(checkReachabilityLabelling\(GRAPH_EDGES\), failures\)/);
    // And the check is not re-declared inline, which would silently shadow the
    // tested one with an untested copy.
    expect(gate).not.toMatch(/function checkReachabilityLabelling/);
    expect(gate).not.toMatch(/function reportReachabilityLabelling/);
  });
});
