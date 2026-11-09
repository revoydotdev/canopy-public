import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAdrSections, checkObligations, isStubBody, isStubObligationBody, runSectionsAudit, sectionBody } from "../adr-sections.mjs";
import { newPendingDecision } from "../lib/adr-registry.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "adr-sections.mjs");

function complete(overrides = {}) {
  return `# ADR-042: Fixture Decision

**Status:** ${overrides.status ?? "Accepted"}
**Date:** 2026-08-24

## Context

Real forces described here.

## Decision

Real decision described here.

## Consequences

Real consequences described here.

## Alternatives / Roads not taken

1. Considered X. Rejected because Y.

## Obligations

### O1 — A checkable claim

<!-- proof: symbol=widgetize file=packages/widget/src/index.ts roundtrip=tests/widget.test.ts -->
`;
}

describe("sectionBody / isStubBody", () => {
  it("extracts the body between a heading and the next top-level heading", () => {
    const text = "## Context\n\nHello.\n\n## Decision\n\nWorld.\n";
    expect(sectionBody(text, "Context").trim()).toBe("Hello.");
    expect(sectionBody(text, "Decision").trim()).toBe("World.");
  });

  it("returns null for a missing heading", () => {
    expect(sectionBody("## Context\n\nHi.\n", "Decision")).toBeNull();
  });

  it("treats an HTML-comment-only body as a stub", () => {
    expect(isStubBody("\n<!-- What forces make this decision necessary? -->\n")).toBe(true);
    expect(isStubBody("\nReal prose.\n")).toBe(false);
  });
});

describe("checkObligations — the real corpus's own shape must not false-positive", () => {
  it("accepts an obligation that carries ONLY a resolving proof comment and no extra prose (ADR-011's actual O1 shape)", () => {
    const body = isStubObligationBody("\n<!-- proof: symbol=RuntimePort file=packages/arbor-tui/src/runtime-port.ts roundtrip=packages/arbor-tui/tests/runtime-port.test.ts -->\n");
    expect(body).toBe(false);
  });

  it("flags the scaffold's bare proof stub (symbol= file= roundtrip=, no values) as unfilled", () => {
    expect(isStubObligationBody("\n<!-- proof: symbol= file= roundtrip= -->\n")).toBe(true);
  });

  it("accepts an unverifiable reason as a filled-in, honest answer", () => {
    expect(isStubObligationBody("\n<!-- unverifiable: no test harness exists yet for this seam -->\n")).toBe(false);
  });

  it("rejects an empty unverifiable comment", () => {
    expect(isStubObligationBody("\n<!-- unverifiable:    -->\n")).toBe(true);
  });

  it("fails when the Obligations heading is entirely absent", () => {
    const result = checkObligations("## Context\n\nHi.\n");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing "## Obligations"/);
  });

  it("fails when the O1 heading still carries its placeholder title", () => {
    const text = "## Obligations\n\n### O1 — <the durable, checkable claim this obligation upholds>\n\n<!-- proof: symbol= file= roundtrip= -->\n";
    const result = checkObligations(text);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/placeholder title/);
  });

  it("passes a real, filled obligation", () => {
    const text = "## Obligations\n\n### O1 — Real claim\n\n<!-- proof: symbol=X file=packages/a/src/b.ts roundtrip=packages/a/tests/b.test.ts -->\n";
    expect(checkObligations(text).ok).toBe(true);
  });
});

describe("checkAdrSections — a complete record", () => {
  it("has zero problems", () => {
    expect(checkAdrSections(complete())).toEqual([]);
  });

  it("flags a stub Context section", () => {
    const text = complete().replace("Real forces described here.", "<!-- What forces make this decision necessary? -->");
    const problems = checkAdrSections(text);
    expect(problems.some((p) => p.includes('"## Context"'))).toBe(true);
  });

  it("flags a missing Consequences heading", () => {
    const text = complete().replace("## Consequences\n\nReal consequences described here.\n\n", "");
    const problems = checkAdrSections(text);
    expect(problems.some((p) => p.includes('missing "## Consequences"'))).toBe(true);
  });

  it("flags a stub Alternatives section once the heading is present but empty", () => {
    const text = complete().replace("1. Considered X. Rejected because Y.", "<!-- What other approaches were considered, and why were they rejected? -->");
    const problems = checkAdrSections(text);
    expect(problems.some((p) => p.includes("Alternatives"))).toBe(true);
  });

  it("does NOT flag a missing Alternatives heading at all — that is the ratchet's job, not a per-record problem", () => {
    const text = complete().replace("## Alternatives / Roads not taken\n\n1. Considered X. Rejected because Y.\n\n", "");
    expect(checkAdrSections(text)).toEqual([]);
  });
});

describe("runSectionsAudit — against a disposable fixture decisions/ dir", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adr-sections-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes when every non-retired ADR is complete", () => {
    writeFileSync(join(dir, "ADR-042-fixture-decision.md"), complete());
    const report = runSectionsAudit(dir);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
    expect(report.violations).toEqual([]);
  });

  it("fails on a stub section in a Proposed record", () => {
    writeFileSync(join(dir, "ADR-042-fixture-decision.md"), complete({ status: "Proposed" }).replace("Real decision described here.", "<!-- What is being decided, and by what mechanism? -->"));
    const report = runSectionsAudit(dir);
    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].problems.some((p) => p.includes('"## Decision"'))).toBe(true);
  });

  it("skips a Retired record entirely, even with every section stubbed", () => {
    const stub = "# ADR-001: Old\n\n**Status:** Retired\n**Date:** 2020-01-01\n\n## Context\n\n<!-- x -->\n\n## Decision\n\n<!-- x -->\n\n## Consequences\n\n<!-- x -->\n\n## Obligations\n\n### O1 — <claim>\n\n<!-- proof: symbol= file= roundtrip= -->\n";
    writeFileSync(join(dir, "ADR-001-old.md"), stub);
    const report = runSectionsAudit(dir);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
  });

  it("skips a Superseded record too", () => {
    writeFileSync(join(dir, "ADR-002-old2.md"), complete({ status: "Superseded" }).replace("Real prose.", "").replace("Real decision described here.", "<!-- stub -->"));
    const report = runSectionsAudit(dir);
    expect(report.ok).toBe(true);
  });

  it("the ratchet passes when missing-Alternatives count is at or below the floor, and fails once it rises above", () => {
    // One record below the floor of 49 changes nothing about the OVER-floor
    // outcome for a tiny fixture corpus (floor is a fixed constant tuned to
    // the real repo), so this asserts the counting mechanism itself: a record
    // missing Alternatives is counted, one carrying it is not.
    const withAlt = complete();
    const withoutAlt = complete().replace("## Alternatives / Roads not taken\n\n1. Considered X. Rejected because Y.\n\n", "");
    writeFileSync(join(dir, "ADR-042-fixture-decision.md"), withAlt);
    writeFileSync(join(dir, "ADR-043-fixture-decision-2.md"), withoutAlt.replace("ADR-042", "ADR-043"));
    const report = runSectionsAudit(dir);
    expect(report.alternatives_missing).toBe(1);
    expect(report.alternatives_over_floor).toBe(false);
    expect(report.ok).toBe(true);
  });
});

describe("dogfooding — newPendingDecision's own scaffold passes gate:adr-sections once the placeholders are filled", () => {
  it("a filled-in scaffold has zero section problems", () => {
    const repo = mkdtempSync(join(tmpdir(), "adr-sections-scaffold-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
      mkdirSync(join(repo, "decisions"), { recursive: true });
      writeFileSync(join(repo, "decisions", "README.md"), "# ADR Index\n");
      writeFileSync(join(repo, "empty.txt"), "");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["-c", "user.email=t@test.invalid", "-c", "user.name=T", "commit", "-q", "-m", "base"], { cwd: repo });

      const scaffolded = newPendingDecision({ repo, slug: "fixture", title: "Fixture" });
      let text = readFileSync(join(repo, scaffolded.file), "utf8");
      // The RAW scaffold is a stub by design — this proves it fails first.
      const raw = checkAdrSections(text);
      expect(raw.length).toBeGreaterThan(0);

      // Fill every placeholder in, exactly as an author would.
      text = text
        .replace("<!-- What forces make this decision necessary? -->", "Real forces.")
        .replace("<!-- What is being decided, and by what mechanism? -->", "Real decision.")
        .replace("<!-- What becomes easier or harder as a result? -->", "Real consequences.")
        .replace("<!-- What other approaches were considered, and why were they rejected? -->", "1. Considered X. Rejected.")
        .replace("### O1 — <the durable, checkable claim this obligation upholds>", "### O1 — A real claim")
        .replace(/proof: symbol= file= roundtrip=/, "proof: symbol=widgetize file=packages/widget/src/index.ts roundtrip=tests/widget.test.ts");
      expect(checkAdrSections(text)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("CLI", () => {
  it("passes (exit 0) against the real repository's decisions/ directory", () => {
    const output = execFileSync(process.execPath, [CLI, "--json"], { encoding: "utf8" });
    const report = JSON.parse(output);
    expect(report.ok).toBe(true);
    expect(report.checked).toBeGreaterThan(0);
  });
});
