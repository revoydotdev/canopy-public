import { describe, it, expect } from "vitest";
import {
  extractStringUnionType,
  checkAdrStatusVocabulary,
  extractDocSeverityQuote,
  checkSeverityVocabulary,
  extractRoadmapDefectShapes,
  extractTerminologyDefectShapes,
  checkDefectShapeVocabulary,
} from "../closed-enum-hygiene.mjs";

describe("closed-enum-hygiene: extractStringUnionType", () => {
  it("extracts every string-literal member of a top-level union type", () => {
    const src = `export type Severity = "blocker" | "warning" | "informational";`;
    expect(extractStringUnionType(src, "Severity")).toEqual({
      members: ["blocker", "warning", "informational"],
      error: null,
    });
  });

  it("extracts a single-literal type alias (degenerate union of one)", () => {
    const src = `export type Only = "solo";`;
    expect(extractStringUnionType(src, "Only")).toEqual({ members: ["solo"], error: null });
  });

  it("reports a diagnostic, never a fabricated list, for a missing type", () => {
    const src = `export type Other = "a" | "b";`;
    const result = extractStringUnionType(src, "Severity");
    expect(result.members).toBeNull();
    expect(result.error).toMatch(/no top-level type alias 'Severity' found/);
  });

  it("reports a diagnostic for a union with a non-string-literal member (never guesses)", () => {
    const src = `export type Mixed = "a" | 1 | "b";`;
    const result = extractStringUnionType(src, "Mixed");
    expect(result.members).toBeNull();
    expect(result.error).toMatch(/non-string-literal member/);
  });
});

describe("closed-enum-hygiene: check 1 — ADR decision-status prose", () => {
  const decisionStatusMembers = ["draft", "proposed", "accepted", "rejected", "superseded"];

  it("passes on real revoy2 decisions/*.md status values (Accepted/Draft/Proposed)", () => {
    const files = [
      { file: "decisions/ADR-001-x.md", text: "# ADR-001\n\n**Status:** Accepted\n\nContext...\n" },
      { file: "decisions/ADR-002-y.md", text: "# ADR-002\n\n**Status:** Draft\n\nContext...\n" },
      { file: "decisions/ADR-003-z.md", text: "# ADR-003\n\n**Status:** Proposed\n\nContext...\n" },
    ];
    expect(checkAdrStatusVocabulary(files, decisionStatusMembers)).toHaveLength(0);
  });

  it("REAL VIOLATION: flags a drifted free-text status value — the exact revoy-spec failure shape (27/159 records drifted to 'Implemented'/'Shipped'/prose)", () => {
    const files = [
      { file: "decisions/ADR-999-drifted.md", text: "# ADR-999\n\n**Status:** Implemented\n\nContext...\n" },
    ];
    const violations = checkAdrStatusVocabulary(files, decisionStatusMembers);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("decisions/ADR-999-drifted.md");
    expect(violations[0].value).toBe("Implemented");
    expect(violations[0].reason).toMatch(/not one of the documented DecisionStatus values/);
  });

  it("is case-insensitive against the lowercase TS union (prose capitalizes, the type does not)", () => {
    const files = [{ file: "decisions/ADR-001-x.md", text: "**Status:** ACCEPTED\n" }];
    expect(checkAdrStatusVocabulary(files, decisionStatusMembers)).toHaveLength(0);
  });

  it("does not flag a file with no Status line at all (not this gate's claim to make)", () => {
    const files = [{ file: "decisions/ADR-004-no-status.md", text: "# ADR-004\n\nNo status line here.\n" }];
    expect(checkAdrStatusVocabulary(files, decisionStatusMembers)).toHaveLength(0);
  });

  it("does NOT flag an enum member that simply has zero current users (the reverse direction is deliberately not checked)", () => {
    // Every real file uses "accepted"; "rejected"/"superseded" are unused today.
    // That is normal corpus state, not drift — see the check's own doc comment.
    const files = [{ file: "decisions/ADR-001-x.md", text: "**Status:** Accepted\n" }];
    expect(checkAdrStatusVocabulary(files, decisionStatusMembers)).toHaveLength(0);
  });
});

describe("closed-enum-hygiene: check 2 — Severity vocabulary (contracts.ts vs. prose re-quote)", () => {
  const contractsSrc = `export type Severity = "blocker" | "warning" | "informational";`;
  const goodDoc = 'Severity vocabulary: `contracts.ts`\'s `Severity` (`"blocker" | "warning" |\n"informational"`) only — only `"blocker"` escalates.';

  it("extracts the doc's quoted list", () => {
    expect(extractDocSeverityQuote(goodDoc)).toEqual(["blocker", "warning", "informational"]);
  });

  it("passes when contracts.ts and the doc's quote agree (real revoy2 state)", () => {
    expect(checkSeverityVocabulary(contractsSrc, goodDoc)).toHaveLength(0);
  });

  it("REAL VIOLATION: flags a doc quote that has gone stale after contracts.ts gains a member", () => {
    const grownContracts = `export type Severity = "blocker" | "warning" | "informational" | "critical";`;
    const violations = checkSeverityVocabulary(grownContracts, goodDoc);
    expect(violations).toHaveLength(1);
    expect(violations[0].value).toBe("critical");
    expect(violations[0].reason).toMatch(/quote omits it — the quote is stale/);
  });

  it("REAL VIOLATION: flags the reverse — a doc quote listing a member contracts.ts no longer has", () => {
    const shrunkContracts = `export type Severity = "blocker" | "warning";`;
    const violations = checkSeverityVocabulary(shrunkContracts, goodDoc);
    expect(violations).toHaveLength(1);
    expect(violations[0].value).toBe("informational");
    expect(violations[0].reason).toMatch(/contracts\.ts's Severity type has no such member/);
  });

  it("does not flag anything when the doc no longer re-quotes the vocabulary at all", () => {
    expect(checkSeverityVocabulary(contractsSrc, "no mention of severity here")).toHaveLength(0);
  });
});

describe("closed-enum-hygiene: check 3 — the four defect shapes (ROADMAP.md vs. terminology.md)", () => {
  const roadmap = [
    "**The four shapes, from the audit:**",
    "",
    "| Shape | Instances | What it looks like |",
    "|---|---|---|",
    "| **Unreached** | G-01 | built, tested, no live caller |",
    "| **Hollow** | G-04 | the call fires; the payload is empty |",
    "| **Degraded seam** | G-02 | a typed contract crosses a boundary and comes back as text |",
    "| **Unwitnessed claim** | the roadmap drift itself | a document asserts a state nothing can contradict |",
    "",
    "### Strength ladder",
  ].join("\n");
  const terminology = "| **Defect shape** | `Unreached / Hollow / Degraded seam / Unwitnessed claim`. | note |";

  it("extracts matching sets from both real-shaped sources (verified against actual ROADMAP.md/terminology.md text)", () => {
    expect(extractRoadmapDefectShapes(roadmap)).toEqual(["Unreached", "Hollow", "Degraded seam", "Unwitnessed claim"]);
    expect(extractTerminologyDefectShapes(terminology)).toEqual(["Unreached", "Hollow", "Degraded seam", "Unwitnessed claim"]);
  });

  it("passes when both sources agree (real revoy2 state)", () => {
    expect(checkDefectShapeVocabulary(roadmap, terminology)).toHaveLength(0);
  });

  it("REAL VIOLATION: flags a new shape added to ROADMAP.md's table but never carried into terminology.md — the exact 'two hand-typed axes' drift revoy-spec suffered", () => {
    const roadmapWithNewShape = roadmap.replace(
      "### Strength ladder",
      "| **Silent fallback** | G-40 | a code path substitutes a default instead of failing |\n\n### Strength ladder",
    );
    const violations = checkDefectShapeVocabulary(roadmapWithNewShape, terminology);
    expect(violations).toHaveLength(1);
    expect(violations[0].value).toBe("Silent fallback");
    expect(violations[0].reason).toMatch(/terminology\.md's "Defect shape" row omits it/);
  });

  it("REAL VIOLATION: flags the reverse — terminology.md declaring a shape ROADMAP.md's table dropped", () => {
    const terminologyWithExtra = "| **Defect shape** | `Unreached / Hollow / Degraded seam / Unwitnessed claim / Ghost shape`. | note |";
    const violations = checkDefectShapeVocabulary(roadmap, terminologyWithExtra);
    expect(violations).toHaveLength(1);
    expect(violations[0].value).toBe("Ghost shape");
    expect(violations[0].reason).toMatch(/ROADMAP\.md's Phase 6 table omits it/);
  });

  it("does not fire on unrelated uses of the bare word 'shape' (HTTP shape, Entry shape, etc. — the false-positive class this gate's bias exists to avoid)", () => {
    const noisyRoadmap = roadmap.replace(
      "### Strength ladder",
      "This tranche fixed the HTTP shape and the OMO shape, unrelated to defect shapes.\n\n### Strength ladder",
    );
    expect(checkDefectShapeVocabulary(noisyRoadmap, terminology)).toHaveLength(0);
  });

  it("does not flag anything when a source no longer asserts the vocabulary at all", () => {
    expect(checkDefectShapeVocabulary("no shapes table here", terminology)).toHaveLength(0);
    expect(checkDefectShapeVocabulary(roadmap, "no defect shape row here")).toHaveLength(0);
  });
});
