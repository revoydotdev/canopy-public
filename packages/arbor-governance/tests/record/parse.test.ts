import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecord } from "../../src/record/parse.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DECISIONS_DIR = join(REPO_ROOT, "decisions");

function readDecision(name: string): string {
  return readFileSync(join(DECISIONS_DIR, name), "utf8");
}

describe("parseRecord — real corpus shape drift", () => {
  it('normalizes "## Alternatives considered" (lowercase c) to the alternatives section', () => {
    const content = readDecision("ADR-016-interruption-is-a-recoverable-ledger-outcome.md");
    const result = parseRecord(content, "decisions/ADR-016-interruption-is-a-recoverable-ledger-outcome.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sections.alternatives).not.toBeNull();
    expect(result.value.sections.alternatives).toMatch(/./);
  });

  it('normalizes "## Alternatives Considered" (uppercase C) to the same canonical key', () => {
    const content = readDecision("ADR-004-envelope-pattern-for-kb-reads.md");
    const result = parseRecord(content, "decisions/ADR-004-envelope-pattern-for-kb-reads.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sections.alternatives).not.toBeNull();
  });

  it('both casings land in exactly the same CanonicalRecord field (no separate "consideredVariant" field exists)', () => {
    const lower = parseRecord(readDecision("ADR-016-interruption-is-a-recoverable-ledger-outcome.md"), "x");
    const upper = parseRecord(readDecision("ADR-004-envelope-pattern-for-kb-reads.md"), "x");
    expect(lower.ok && upper.ok).toBe(true);
    if (!lower.ok || !upper.ok) return;
    expect(Object.keys(lower.value.sections)).toEqual(Object.keys(upper.value.sections));
    expect(Object.keys(lower.value.sections)).toContain("alternatives");
    expect(Object.keys(lower.value.sections)).not.toContain("alternatives_considered");
    expect(Object.keys(lower.value.sections)).not.toContain("roads_not_taken");
  });

  it.each(["ADR-018-compaction-is-a-ledger-witnessed-lifecycle.md", "ADR-019-user-interview-is-a-governed-ledger-transition.md", "ADR-020-palette-keymap-and-config-are-projections.md"])(
    '"## Roads not taken" in %s parses and maps to the alternatives section',
    (filename) => {
      const result = parseRecord(readDecision(filename), filename);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sections.alternatives).not.toBeNull();
      expect(result.value.sections.alternatives).toMatch(/./);
    },
  );

  it("extracts ADR-024's two in-body amendment blocks", () => {
    const content = readDecision("ADR-024-tool-execution-enforcement-is-a-host-trust-boundary.md");
    const result = parseRecord(content, "decisions/ADR-024-tool-execution-enforcement-is-a-host-trust-boundary.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amendments).toHaveLength(2);
    expect(result.value.amendments[0].ordinal).toBe(1);
    expect(result.value.amendments[0].label).toBe("Amendment");
    expect(result.value.amendments[0].note).toContain("2026-08-04");
    expect(result.value.amendments[0].body.length).toBeGreaterThan(0);
    expect(result.value.amendments[1].ordinal).toBe(2);
    expect(result.value.amendments[1].label).toBe("Second amendment");
    expect(result.value.amendments[1].note).toContain("wave 3");
  });

  it("ADR-024 itself still parses to a full record (status Accepted since its 2026-08-05 ratification, real amendments) without throwing", () => {
    const content = readDecision("ADR-024-tool-execution-enforcement-is-a-host-trust-boundary.md");
    const result = parseRecord(content, "x");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status.decision).toBe("accepted");
    expect(result.value.sections.test_implications).not.toBeNull();
  });

  it("ADR-011's unrecognized '## Renderer decision' subsection is folded into alternatives with a warning, not dropped or errored", () => {
    const content = readDecision("ADR-011-tui-cockpit-architecture.md");
    const result = parseRecord(content, "decisions/ADR-011-tui-cockpit-architecture.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parse_warnings.some((w) => w.includes("Renderer decision"))).toBe(true);
    expect(result.value.sections.alternatives).toContain("Renderer decision");
  });
});

describe("parseRecord — malformed input never throws, always a typed validation error", () => {
  it("empty file", () => {
    expect(() => parseRecord("", "x.md")).not.toThrow();
    const result = parseRecord("", "x.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.error.at).toBe("x.md:1");
  });

  it("whitespace-only file", () => {
    const result = parseRecord("   \n\n\t\n", "x.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
  });

  it("missing H1", () => {
    const content = "**Status:** Accepted\n**Date:** 2026-01-01\n\n## Context\n\nbody\n\n## Decision\n\nbody\n\n## Consequences\n\nbody\n";
    const result = parseRecord(content, "x.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.error.message).toMatch(/H1/);
  });

  it("non-ADR markdown (an H1 that isn't the ADR-NNN: Title shape)", () => {
    const content = "# Just a regular document\n\nSome prose that is not a decision record at all.\n";
    const result = parseRecord(content, "x.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
  });

  it("missing Status line", () => {
    const content = "# ADR-999: Test\n\n**Date:** 2026-01-01\n\n## Context\n\nbody\n\n## Decision\n\nbody\n\n## Consequences\n\nbody\n";
    const result = parseRecord(content, "x.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.error.message).toMatch(/Status/);
  });

  it("unknown status string", () => {
    const content =
      "# ADR-999: Test\n\n**Status:** Superduper\n**Date:** 2026-01-01\n\n## Context\n\nbody\n\n## Decision\n\nbody\n\n## Consequences\n\nbody\n";
    const result = parseRecord(content, "x.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.error.message).toMatch(/unknown status/i);
  });

  it("missing required Context section", () => {
    const content = "# ADR-999: Test\n\n**Status:** Accepted\n**Date:** 2026-01-01\n\n## Decision\n\nbody\n\n## Consequences\n\nbody\n";
    const result = parseRecord(content, "x.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.error.message).toMatch(/Context/);
  });

  it("well-formed minimal record parses cleanly with no warnings", () => {
    const content = "# ADR-999: Minimal Test Record\n\n**Status:** Accepted\n**Date:** 2026-01-01\n\n## Context\n\nctx body\n\n## Decision\n\ndecision body\n\n## Consequences\n\nconsequences body\n";
    const result = parseRecord(content, "x.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parse_warnings).toEqual([]);
    expect(result.value.id).toBe("revoy2:ADR-999");
    expect(result.value.record_number).toBe(999);
    expect(result.value.title).toBe("Minimal Test Record");
    expect(result.value.obligations).toEqual([]);
    expect(result.value.authors.value).toBeNull();
    expect(result.value.accepted_date.value).toBeNull();
  });
});
