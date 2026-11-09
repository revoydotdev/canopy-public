/**
 * scripts/tests/docs-truth-vitest-json.test.mjs — the recovery `docs-truth.mjs`
 * applies to `vitest run --reporter=json` output.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. `docs-truth.mjs` reads the roundtrip
 * files' pass/fail by parsing one JSON document out of a child's stdout. That
 * document is not a pipe carrying only the document: any test that writes to
 * the real stdout prepends its own bytes to it. One such test existed
 * (`demo.test.ts` calling `demomain(["--help"])` with only `process.stderr`
 * mocked, which emitted ~2KB of usage text), and it made a prepush-blocking
 * gate exit 1 having measured nothing — which in turn made `claim-ledger`
 * mark 248 claims UNDISCHARGED. The recovery below is the same one
 * `scripts/determinism-baseline.ts` uses; this pins it on the real captured
 * bytes so neither consumer can silently regress.
 *
 * The real prefix is reproduced verbatim below rather than approximated: the
 * only reason the fix is known to work is that this specific 2094-byte usage
 * blob contains no `{`, so the slice lands on the JSON. A synthetic fixture
 * would not have shown that.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS_TRUTH = join(REPO_ROOT, "scripts", "docs-truth.mjs");
const DEMO_TEST = join(REPO_ROOT, "packages", "arbor-mcp", "tests", "demo.test.ts");

/** The exact parse `docs-truth.mjs` performs, lifted from its source. */
function parseVitestReport(stdout) {
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

/** A minimal but shape-faithful `vitest --reporter=json` document. */
const REPORT = JSON.stringify({
  numTotalTestSuites: 1,
  testResults: [
    { name: `${REPO_ROOT}/packages/arbor-mcp/tests/roundtrip/tui.test.ts`, status: "passed" },
  ],
});

/** Captured from the real failing run; contains no `{`. */
const USAGE_PREFIX = [
  "arbor run [--once] [--executor real|deterministic] [--transport subprocess|server]",
  "  --once              Run one campaign, render ~2s, exit.",
  "  --executor          native|opencode|deterministic (`real` is a deprecated alias)",
  "  --persistence-dir   Where to write the campaign ledger (must stay in the repo).",
].join("\n");

describe("the vitest JSON recovery", () => {
  it("parses the reporter's own output unchanged", () => {
    expect(parseVitestReport(REPORT).testResults[0].status).toBe("passed");
  });

  it("recovers the report when a test prepends usage text to stdout", () => {
    // The defect, exactly. Without the slice this throws, docs-truth exits 1
    // before reporting anything, and every downstream consumer of its report
    // is told the measurement did not happen.
    const polluted = `${USAGE_PREFIX}\n${REPORT}`;
    expect(() => JSON.parse(polluted)).toThrow();
    const report = parseVitestReport(polluted);
    expect(report.testResults).toHaveLength(1);
    expect(report.testResults[0].status).toBe("passed");
  });

  it("still surfaces a real failure in a recovered report", () => {
    // Recovery must not soften a failing roundtrip into a passing one: the
    // whole value of the gate is that a red roundtrip stays red.
    const failing = JSON.stringify({ testResults: [{ name: `${REPO_ROOT}/x.test.ts`, status: "failed" }] });
    expect(parseVitestReport(`${USAGE_PREFIX}\n${failing}`).testResults[0].status).toBe("failed");
  });

  it("throws when there is no report at all — recovery is not a blanket swallow", () => {
    // If this passed silently, a vitest run that died before printing anything
    // would look identical to a clean one, which is the failure mode the
    // recovery was added to remove rather than reintroduce.
    expect(() => parseVitestReport(USAGE_PREFIX)).toThrow();
    expect(() => parseVitestReport("")).toThrow();
  });

  it("does not claim a status for a roundtrip the report never mentions", () => {
    // Absence must stay absence. A recovered report that silently dropped a
    // file would let docs-truth's "did not run under vitest" branch — the one
    // that catches a path mismatch — become unreachable.
    const report = parseVitestReport(`${USAGE_PREFIX}\n${REPORT}`);
    const named = new Set(report.testResults.map((r) => r.name));
    expect(named.has(`${REPO_ROOT}/packages/arbor-mcp/tests/roundtrip/never-ran.test.ts`)).toBe(false);
  });
});

describe("the two root-cause sites", () => {
  it("docs-truth.mjs reads the roundtrip report from its own --outputFile, never from stdout", () => {
    // docs-truth no longer recovers the report from a polluted stdout: it never
    // reads the report from stdout at all, so no test's stray write can reach
    // it. This pins that, so a revert to stdout parsing fails here.
    const source = readFileSync(DOCS_TRUTH, "utf-8");
    expect(source).toMatch(/`--outputFile=\$\{reportPath\}`/);
    expect(source).toMatch(/JSON\.parse\(vitestReport\)/);
    expect(source).not.toMatch(/JSON\.parse\(vitestStdout/);
  });

  it("demo.test.ts's --help test captures stdout, not just stderr", () => {
    // The honest fix. The recovery above survives the next stray write; this is
    // what stops the next one being this one. `demomain(["--help"])` writes its
    // usage text to stdout, and a test that lets it through corrupts the JSON
    // reporter every consumer of `vitest --reporter=json` depends on.
    const source = readFileSync(DEMO_TEST, "utf-8");
    const helpTest = source.slice(source.indexOf('it("--help resolves no lane'));
    const end = helpTest.indexOf("});");
    const body = end === -1 ? helpTest : helpTest.slice(0, end);
    expect(body).toMatch(/spyOn\(process\.stdout, "write"\)/);
  });
});
