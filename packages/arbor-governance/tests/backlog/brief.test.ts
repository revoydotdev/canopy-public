import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveBacklog } from "../../src/backlog/derive.js";
import { renderBrief } from "../../src/backlog/brief.js";

const AT = "2026-08-04T00:00:00.000Z";

/**
 * A synthetic corpus, not the real `decisions/` directory.
 *
 * These tests used to pin real ADR-001 as their "buildable record" fixture,
 * which meant they only passed while that record was unwitnessed: authoring its
 * obligations removed it from the backlog and broke them. Worse, the backlog is
 * *designed* to empty as records gain obligations, so pinning any real record
 * guaranteed eventual failure, and pinning "whatever happens to be first" would
 * become vacuous the moment the corpus is fully migrated.
 *
 * The renderer's behaviour does not depend on the real corpus being deficient,
 * so the fixture does not either.
 */
const FIXTURE_DECISIONS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "decisions");

function requireItem(recordId: string) {
  const backlog = deriveBacklog({ at: AT, decisionsDir: FIXTURE_DECISIONS });
  if (!backlog.ok) throw new Error("deriveBacklog failed in test setup");
  const item = backlog.value.items.find((i) => i.record_id === recordId);
  if (!item) throw new Error(`no backlog item for ${recordId}`);
  return item;
}

describe("renderBrief — author_obligations brief (a real buildable record)", () => {
  it("contains this record's own actual Decision text verbatim, not boilerplate", () => {
    const item = requireItem("revoy2:ADR-901");
    const brief = renderBrief(item);

    expect(brief).toContain(item.decision_text);
    // A real, distinctive fragment of ADR-001's Decision prose — this fails
    // if the brief ever falls back to a generic template instead of the
    // record's own text.
    expect(brief.toLowerCase()).toMatch(/canonical adapter|transport/);
  });

  it("states the task as authoring obligations, cites the file and evidence, and never itself writes an O1/O2 obligation", () => {
    const item = requireItem("revoy2:ADR-901");
    const brief = renderBrief(item);

    expect(brief).toContain("author obligations for revoy2:ADR-901");
    expect(brief).toContain(item.file_path);
    expect(brief).toContain(item.evidence.finding_detail);
    // The brief must show the GRAMMAR (a template line with a placeholder),
    // but never a concrete, already-decided "### O1 — <real claim>" — that
    // would be this module fabricating the obligation itself.
    expect(brief).toContain("### O1 — <one sentence");
    expect(brief).not.toMatch(/### O1 — (?!<)/); // no O1 heading with real (non-placeholder) text
  });

  it("includes the proof-comment resolution rules (symbol=/file=/roundtrip=) so an executor knows what 'resolves' means", () => {
    const item = requireItem("revoy2:ADR-901");
    const brief = renderBrief(item);

    expect(brief).toContain("symbol=");
    expect(brief).toContain("roundtrip=");
    expect(brief).toContain("vitest.config.ts");
    expect(brief).toContain("packages/**/tests/**");
  });

  it("states the hard rule against inventing obligations", () => {
    const item = requireItem("revoy2:ADR-901");
    const brief = renderBrief(item);

    expect(brief).toMatch(/never an invented commitment/i);
    expect(brief).toContain("not_applicable");
  });

  it("a record with no Test implications section says so explicitly rather than fabricating one", () => {
    const item = requireItem("revoy2:ADR-901"); // the fixture with NO "## Test implications"
    expect(item.test_implications_text).toBeNull();
    const brief = renderBrief(item);

    expect(brief).toContain("none — this record has no");
  });

  it("a record WITH a Test implications section reproduces it verbatim", () => {
    const item = requireItem("revoy2:ADR-903"); // the fixture WITH a "## Test implications" section
    expect(item.test_implications_text).not.toBeNull();
    const brief = renderBrief(item);

    expect(brief).toContain(item.test_implications_text as string);
  });
});

describe("renderBrief — not_applicable brief (a non-goal record)", () => {
  it("states the verdict is NOT APPLICABLE and quotes the record's own disclaiming text as the reason", () => {
    const item = requireItem("revoy2:ADR-902");
    expect(item.classification).toBe("not_applicable");
    const brief = renderBrief(item);

    expect(brief).toContain("NOT APPLICABLE");
    expect(brief).toContain(item.reason as string);
  });

  it("explicitly instructs NOT to author an Obligations section, and never emits the authoring template", () => {
    const item = requireItem("revoy2:ADR-902");
    const brief = renderBrief(item);

    expect(brief).toMatch(/Do NOT author an "## Obligations" section/);
    expect(brief).not.toContain("### O1 —");
    expect(brief).not.toContain("proof: symbol=");
  });
});

describe("renderBrief — an operator-action non-goal", () => {
  it("renders not_applicable and cites the operator-decision reason, not a fabricated engineering task", () => {
    const item = requireItem("revoy2:ADR-902");
    const brief = renderBrief(item);

    expect(item.classification).toBe("not_applicable");
    expect(brief).toContain("NOT APPLICABLE");
    expect(brief.toLowerCase()).toMatch(/operator|business decision|agent working inside the repo/);
  });
});
