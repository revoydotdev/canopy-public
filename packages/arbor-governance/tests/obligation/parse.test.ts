import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRecordId, parseObligationsFromText } from "../../src/obligation/parse.js";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DECISIONS_DIR = resolvePath(REPO_ROOT, "decisions");

describe("deriveRecordId", () => {
  it("derives a namespaced RecordId from a well-formed ADR filename", () => {
    expect(deriveRecordId("ADR-026-campaign-loop-is-a-supervised-job.md")).toBe("revoy2:ADR-026");
    expect(deriveRecordId("ADR-001-botanical-taxonomy-agent-naming.md")).toBe("revoy2:ADR-001");
  });

  it("returns null for non-ADR files rather than guessing", () => {
    expect(deriveRecordId("README.md")).toBeNull();
    expect(deriveRecordId("notes.md")).toBeNull();
    expect(deriveRecordId("ADR-abc-not-a-number.md")).toBeNull();
  });
});

describe("parseObligationsFromText: legacy records (no Obligations section)", () => {
  it("reports exactly zero obligations — never fabricated", () => {
    const text = [
      "# ADR-999: A legacy-shaped record",
      "",
      "**Status:** Accepted",
      "",
      "## Context",
      "",
      "Some prose.",
      "",
      "## Decision",
      "",
      "Some other prose. ADR-018 claimed 14/14 satisfied here, once, in a commit message —",
      "not in this file, and not as a numbered clause this parser could ever find.",
      "",
      "## Consequences",
      "",
      "None worth noting.",
    ].join("\n");

    const result = parseObligationsFromText("revoy2:ADR-999", "decisions/ADR-999-fixture.md", text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.has_obligations_section).toBe(false);
    expect(result.value.obligations).toEqual([]);
    expect(result.value.duplicate_ordinals).toEqual([]);
  });

  it("every real record under decisions/ parses without throwing, and any declared obligations are well-formed", () => {
    const filenames = readdirSync(DECISIONS_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
    const adrFilenames = filenames.filter((f) => deriveRecordId(f) !== null);
    expect(adrFilenames.length).toBeGreaterThan(0);

    for (const basename of adrFilenames) {
      const recordId = deriveRecordId(basename)!;
      const text = readFileSync(resolvePath(DECISIONS_DIR, basename), "utf-8");
      const result = parseObligationsFromText(recordId, `decisions/${basename}`, text);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      // This used to assert `obligations === []` for every record — the
      // honest state when written, but it made migrating a record to the
      // new format a test failure, so the assertion actively resisted the
      // workstream it was written to support. What must hold regardless of
      // how many records have migrated:
      //  - a record either has the section or does not, with no third state
      //  - ordinals are unique within a record
      //  - every declared obligation carries real text and a real line number
      expect(result.value.duplicate_ordinals, `${recordId} has duplicate ordinals`).toEqual([]);
      if (result.value.obligations.length > 0) {
        expect(result.value.has_obligations_section, `${recordId}`).toBe(true);
      }
      for (const obligation of result.value.obligations) {
        expect(obligation.ordinal, `${recordId}`).toMatch(/^O\d+$/);
        expect(obligation.text.trim().length, `${recordId} ${obligation.ordinal} has empty text`).toBeGreaterThan(0);
        expect(obligation.line, `${recordId} ${obligation.ordinal}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("parseObligationsFromText: target format", () => {
  const TARGET_TEXT = [
    "# ADR-950: Target-format fixture",
    "",
    "**Status:** Accepted",
    "",
    "## Obligations",
    "",
    "### O1 — first obligation text",
    "",
    "<!-- proof: symbol=Foo file=packages/x/src/foo.ts roundtrip=packages/x/tests/foo.test.ts -->",
    "",
    "### O2 — second obligation, two proof comments",
    "",
    "<!-- proof: symbol=Bar roundtrip=packages/x/tests/bar.test.ts -->",
    "<!-- proof: symbol=Baz file=packages/x/src/baz.ts roundtrip=packages/x/tests/baz.test.ts -->",
    "",
    "## Consequences",
    "",
    "N/A",
  ].join("\n");

  it("parses ordinals, text, and proof comments in document order", () => {
    const result = parseObligationsFromText("revoy2:ADR-950", "decisions/ADR-950-fixture.md", TARGET_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.has_obligations_section).toBe(true);
    expect(result.value.obligations).toHaveLength(2);

    const [o1, o2] = result.value.obligations;
    expect(o1.id).toBe("revoy2:ADR-950-O1");
    expect(o1.ordinal).toBe("O1");
    expect(o1.text).toBe("first obligation text");
    expect(o1.proofs).toHaveLength(1);
    expect(o1.proofs[0]).toMatchObject({ symbol: "Foo", file: "packages/x/src/foo.ts", roundtrip: "packages/x/tests/foo.test.ts" });

    expect(o2.id).toBe("revoy2:ADR-950-O2");
    expect(o2.proofs).toHaveLength(2);
    expect(o2.proofs[0]).toMatchObject({ symbol: "Bar", file: undefined, roundtrip: "packages/x/tests/bar.test.ts" });
    expect(o2.proofs[1]).toMatchObject({ symbol: "Baz", file: "packages/x/src/baz.ts", roundtrip: "packages/x/tests/baz.test.ts" });
  });

  it("reports zero duplicate ordinals for a well-formed section", () => {
    const result = parseObligationsFromText("revoy2:ADR-950", "decisions/ADR-950-fixture.md", TARGET_TEXT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.duplicate_ordinals).toEqual([]);
  });

  it("preserves an explicit machine-readable reason when no proof is available", () => {
    const text = [
      "## Obligations",
      "",
      "### O1 — externally enforced behavior",
      "",
      "<!-- unverifiable: Requires a platform control outside this repository. -->",
    ].join("\n");
    const result = parseObligationsFromText("revoy2:ADR-950", "decisions/ADR-950-fixture.md", text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.obligations[0]).toMatchObject({
      proofs: [],
      unverifiable_reason: "Requires a platform control outside this repository.",
    });
  });
});

describe("parseObligationsFromText: malformed input, honestly reported (never thrown)", () => {
  it("an Obligations heading with zero matching ### O<n> items reports an empty, non-fabricated list", () => {
    const text = ["## Obligations", "", "Some prose that never became a numbered obligation.", "", "## Consequences"].join("\n");
    const result = parseObligationsFromText("revoy2:ADR-951", "decisions/ADR-951-fixture.md", text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.has_obligations_section).toBe(true);
    expect(result.value.obligations).toEqual([]);
  });

  it("duplicate ordinals are surfaced, not silently deduplicated or renumbered", () => {
    const text = [
      "## Obligations",
      "",
      "### O1 — first copy",
      "<!-- proof: symbol=A roundtrip=a.test.ts -->",
      "",
      "### O1 — second copy, same ordinal",
      "<!-- proof: symbol=B roundtrip=b.test.ts -->",
    ].join("\n");
    const result = parseObligationsFromText("revoy2:ADR-952", "decisions/ADR-952-fixture.md", text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.obligations).toHaveLength(2);
    expect(result.value.duplicate_ordinals).toEqual(["O1"]);
    // ids stay unique even though the ordinal collides
    expect(new Set(result.value.obligations.map((o) => o.id)).size).toBe(2);
  });

  it("never throws on empty or garbage input", () => {
    for (const text of ["", "\n\n\n", "not markdown at all, just a sentence.", "## Obligations"]) {
      expect(() => parseObligationsFromText("revoy2:ADR-953", "decisions/ADR-953-fixture.md", text)).not.toThrow();
      const result = parseObligationsFromText("revoy2:ADR-953", "decisions/ADR-953-fixture.md", text);
      expect(result.ok).toBe(true);
    }
  });
});
