import { describe, expect, it } from "vitest";
import {
  ANSI,
  availableScreens,
  clearRegisteredScreens,
  displayWidth,
  governanceScreen,
  installScreens,
  type GovernanceSnapshotShape,
} from "../src/index.js";

function project(result: unknown, width = 80, height = 100) {
  return governanceScreen.project(result, { width, height });
}

function render(result: unknown, width = 80, height = 100, color = false) {
  const projection = project(result, width, height);
  return governanceScreen.render({ projection, width, height, color });
}

/**
 * A realistic composed snapshot shaped exactly like
 * `governance-projection.ts`'s real `GovernanceSnapshot` (field names copied
 * from that file, not guessed), reflecting the audit's stated true state of
 * this repo: most records `accepted`, ZERO obligations declared anywhere,
 * POL-04 fires once per accepted-with-no-obligations record, and SUR-05
 * catches a stale numeric claim in prose.
 */
const POL_04_FINDINGS = Array.from({ length: 25 }, (_, i) => ({
  rule_id: "POL-04",
  severity: "warning",
  subject: { record_id: `revoy2:ADR-${String(i + 1).padStart(3, "0")}` },
  detail: "accepted with zero obligations declared",
}));

const REALISTIC_SNAPSHOT: GovernanceSnapshotShape = {
  decision_status_distribution: { draft: 1, proposed: 1, accepted: 25, rejected: 0, superseded: 1 },
  legacy_classification: { total: 28, parsed: 26, parsed_with_warnings: 2, unparseable: 0 },
  obligation_coverage: {
    total_records: 28,
    total_obligations: 0,
    records_with_obligations_section: 0,
    records_fully_covered: 0,
  },
  policy_findings: [
    ...POL_04_FINDINGS,
    {
      rule_id: "SUR-05",
      severity: "warning",
      subject: { kind: "doc", path: "docs/ROADMAP.md" },
      detail: "docs/ROADMAP.md:42 claims 30 ADRs, repository measures 28",
    },
  ],
  repository_counts: { adr_total: 28, catalog_kinds: 34, src_files: 212, packages: 9, test_files: 66, allowlist_entries: 143 },
};

describe("governance screen — registration", () => {
  it("is registered by installScreens and gated on governance.read", () => {
    clearRegisteredScreens();
    installScreens();
    try {
      const granted = availableScreens(new Set(["governance.read"]));
      expect(granted.map((s) => s.id)).toContain("governance");
      const without = availableScreens(new Set([]));
      expect(without.map((s) => s.id)).not.toContain("governance");
    } finally {
      clearRegisteredScreens();
    }
  });

  it("declares the governance.snapshot round trip it actually refreshes on", () => {
    // This test previously asserted an EMPTY queries list and was titled
    // "honest about the missing producer". It was honest, and it was also the
    // evidence that this screen could never show live data: an independent
    // audit found the pane would read "awaiting first projection" forever
    // while the roadmap called this the first real consumer of
    // @arbor/governance. The producer now exists (runtime-catalog.ts's
    // governance.snapshot, backed by buildGovernanceSnapshot over the real
    // decisions/ corpus), so the honest assertion is the inverse.
    expect(governanceScreen.surface.commands).toEqual([]);
    expect(governanceScreen.surface.queries).toEqual(["governance.snapshot"]);
  });
});

describe("governance screen — realistic projection", () => {
  it("projects the decision-status distribution", () => {
    const projection = project(REALISTIC_SNAPSHOT);
    const rows = projection.rows.filter((r) => r.section === "records");
    expect(rows).toContainEqual({ section: "records", label: "accepted", value: "25" });
    expect(rows).toContainEqual({ section: "records", label: "rejected", value: "0" });
    expect(rows).toHaveLength(5);
  });

  it("renders zero obligation coverage as a real, informative zero — never blank", () => {
    const lines = render(REALISTIC_SNAPSHOT, 140);
    const body = lines.join("\n");
    expect(body).toContain("Obligation coverage");
    expect(body).toContain("0 obligations across 28 records");
    expect(body).toContain("0 declare an Obligations section");
  });

  it("surfaces all 25 POL-04 findings and the SUR-05 count-drift finding, never fabricated, with subject resolved", () => {
    const projection = project(REALISTIC_SNAPSHOT);
    const findingRows = projection.rows.filter((r) => r.section === "finding");
    const pol04 = findingRows.filter((r) => r.rule_id === "POL-04");
    const sur05 = findingRows.filter((r) => r.rule_id === "SUR-05");
    expect(pol04).toHaveLength(25);
    expect(sur05).toHaveLength(1);
    // record_id-shaped subject resolves to the record id
    expect(pol04[0].value).toContain("revoy2:ADR-001");
    // {kind, path}-shaped subject resolves to "kind:path"
    expect(sur05[0].value).toContain("doc:docs/ROADMAP.md");
  });

  it("renders derived repository counts", () => {
    const body = render(REALISTIC_SNAPSHOT).join("\n");
    expect(body).toContain("Repository counts");
    expect(body).toContain("ADRs");
    expect(body).toContain("212"); // src_files
  });

  it("renders the legacy-classification breakdown", () => {
    const body = render(REALISTIC_SNAPSHOT).join("\n");
    expect(body).toContain("Legacy classification");
    expect(body).toContain("parsed_with_warnings");
    expect(body).toContain("total");
  });

  it("caption summarizes total records, total obligations, and finding count", () => {
    const projection = project(REALISTIC_SNAPSHOT);
    expect(projection.caption).toBe("Governance: 28 records · 0 obligations · 26 findings");
  });

  // Every row here is an aggregated facet, never one-to-one with a single
  // backend record — this is the explicit "no meaningful per-row identity"
  // case (screen.ts's `ScreenProjection.row_ids` doc comment), not an
  // oversight: the field is genuinely absent, never an all-null array faked
  // just to satisfy the shape.
  it("carries no row_ids — its rows are aggregated dashboard facets, not backend records", () => {
    const projection = project(REALISTIC_SNAPSHOT);
    expect(projection.row_ids).toBeUndefined();
  });
});

describe("governance screen — purposeful empty state", () => {
  it("renders a missing ADR store as a normal greenfield absence, not an ENOENT fault", () => {
    const result = {
      governance_absence: true,
      decisions_dir: "/new-project/decisions",
      message: "No canonical ADRs yet — the first governed decision will create the project decision store.",
    };
    const projection = project(result);
    const body = render(result).join("\n");
    expect(projection.rows).toEqual([]);
    expect(body).toContain("No canonical ADRs yet");
    expect(body).not.toContain("ENOENT");
    expect(body).not.toContain("unrecognised");
  });

  it("says why, rather than showing a blank or generic panel, when no projection has landed", () => {
    const lines = render(null);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("\n")).toContain("awaiting first projection");
    expect(lines.join("\n").toLowerCase()).not.toBe("no data");
  });

  it("treats a plain object with none of the five facets as unrecognised, not a false zero", () => {
    const lines = render({ unrelated: true });
    expect(lines[0]).not.toContain("0 obligations");
    expect(lines[0].toLowerCase()).toContain("unrecognised");
  });

  it("distinguishes a genuinely-unissued query from a real result that failed to match any recognized shape (WA-59)", () => {
    // `null` — no query has landed yet — is the true "awaiting first
    // projection" case.
    const neverQueried = render(null);
    // A non-null object that matches none of the five facets, none of the
    // envelope shapes: a real response DID arrive, but this screen could not
    // recognize it (a wire/contract mismatch, e.g. a future schema change or
    // a producer bug) — a materially different fact from "nothing has run
    // yet". Rendering the identical "awaiting first projection... has never
    // been produced" caption for both hides a real bug behind a message that
    // reads as "everything is normal, just early".
    const unrecognisedResult = render({ unrelated: true });
    expect(unrecognisedResult[0]).not.toEqual(neverQueried[0]);
    expect(unrecognisedResult[0].toLowerCase()).toContain("unrecognised");
  });
});

// ---------------------------------------------------------------------------
// C2 — `arbor-mcp governance --json` now emits the real
// `GovernanceResult<GovernanceSnapshot>` envelope (contracts.ts's
// {ok,value,capability} / {ok:false,error,capability} union), not a bare
// snapshot. These tests prove the screen actually recognizes what its real
// producer now emits, instead of silently falling through to the generic
// empty state — the exact "documented but not wired" gap this repo's own
// audit calls out.
// ---------------------------------------------------------------------------
describe("governance screen — GovernanceResult<GovernanceSnapshot> envelope (C2)", () => {
  it("an {ok:true, value: <snapshot>} envelope projects identically to passing the bare snapshot directly", () => {
    const fromEnvelope = project({ ok: true, value: REALISTIC_SNAPSHOT, capability: "governance.projection.snapshot" });
    const fromBare = project(REALISTIC_SNAPSHOT);
    expect(fromEnvelope.rows).toEqual(fromBare.rows);
    expect(fromEnvelope.caption).toEqual(fromBare.caption);
  });

  it("renders identically whether the caller passes the envelope or the unwrapped value", () => {
    const envelopeLines = render({ ok: true, value: REALISTIC_SNAPSHOT, capability: "governance.projection.snapshot" }, 140);
    const bareLines = render(REALISTIC_SNAPSHOT, 140);
    expect(envelopeLines).toEqual(bareLines);
  });

  it("an {ok:false, error} envelope renders an explicit FAILED state, never the generic 'awaiting first projection' empty state", () => {
    const lines = render({ ok: false, error: { code: "unavailable", message: "cannot read decisions directory: ENOENT" }, capability: "governance.projection.snapshot" });
    const body = lines.join("\n");
    expect(body).toContain("FAILED");
    expect(body).toContain("unavailable");
    expect(body).toContain("cannot read decisions directory");
    expect(body).not.toContain("awaiting first projection");
  });

  it("an {ok:false} envelope with a malformed/missing error object still renders FAILED, never throws, never fabricates a message", () => {
    expect(() => render({ ok: false })).not.toThrow();
    const lines = render({ ok: false });
    expect(lines.join("\n")).toContain("FAILED");
    expect(lines.join("\n")).toContain("unknown");
  });

  it("a bare object that merely has an 'ok' field but no matching facets is not confused with a snapshot (envelope match requires value to look like one)", () => {
    // ok:true but `value` doesn't look like a GovernanceSnapshot at all —
    // must not silently render "success" over nothing. This is also not the
    // same fact as "no query issued yet": a real {ok:true} envelope arrived,
    // it just didn't carry a recognizable snapshot — the unrecognised-shape
    // case, not the empty one.
    const lines = render({ ok: true, value: { unrelated: true } });
    expect(lines[0].toLowerCase()).toContain("unrecognised");
    expect(lines[0]).not.toContain("awaiting first projection");
  });
});

describe("governance screen — structural degradation", () => {
  it("never crashes on an unknown or partial shape", () => {
    expect(() => render(undefined)).not.toThrow();
    expect(() => render("a string")).not.toThrow();
    expect(() => render(42)).not.toThrow();
    expect(() => render([])).not.toThrow();
    expect(() => render({ repository_counts: "not an object" })).not.toThrow();
    expect(() => render({ policy_findings: "not an array" })).not.toThrow();
    expect(() => render({ policy_findings: [null, 1, "x", { rule_id: "POL-04" }] })).not.toThrow();
    expect(() => render({ decision_status_distribution: { accepted: "25" } })).not.toThrow();
    expect(() => render({ legacy_classification: { parsed: Number.NaN } })).not.toThrow();
    expect(() => render({ policy_findings: [{ rule_id: "X", subject: { record_id: 5 } }] })).not.toThrow();
  });

  it("drops a malformed finding field to '?' rather than fabricating one, and never invents a numeric field that was the wrong type", () => {
    const projection = project({
      policy_findings: [{ rule_id: "POL-04" }], // no severity, no detail, no subject
      decision_status_distribution: { accepted: "25" }, // wrong type — must not be shown as a real 25
    });
    const findingRow = projection.rows.find((r) => r.section === "finding");
    expect(findingRow).toMatchObject({ rule_id: "POL-04", severity: "?", value: "?" });
    expect(projection.rows.some((r) => r.section === "records" && r.label === "accepted")).toBe(false);
  });

  it("only shows a decision category actually present and numeric — never fabricates the other four as zero", () => {
    const projection = project({ decision_status_distribution: { accepted: 3 } });
    const recordRows = projection.rows.filter((r) => r.section === "records");
    expect(recordRows).toEqual([{ section: "records", label: "accepted", value: "3" }]);
  });

  it("partial shape (repository_counts only) renders only that section — silence elsewhere, no fabrication", () => {
    const lines = render({ repository_counts: { adr_total: 5 } });
    const body = lines.join("\n");
    expect(body).toContain("Repository counts");
    expect(body).not.toContain("Records by decision");
    expect(body).not.toContain("Obligation coverage");
    expect(body).not.toContain("Findings");
    expect(body).not.toContain("Legacy classification");
  });
});

describe("governance screen — wide-glyph alignment", () => {
  it("keeps the findings table's column boundary aligned for CJK/emoji content (assert on computed display width)", () => {
    const width = 80;
    const projection = project({
      policy_findings: [
        { rule_id: "POL-04", severity: "warning", detail: "accepted with no obligations" },
        { rule_id: "SUR-05", severity: "warning", detail: "漢字テスト emoji 🔥 count drift" },
      ],
    }, width, 40);
    const lines = governanceScreen.render({ projection, width, height: 40, color: false });
    const findingsIndex = lines.findIndex((l) => l === "Findings");
    expect(findingsIndex).toBeGreaterThanOrEqual(0);
    // header + 2 data rows, immediately following the "Findings" title line
    const tableLines = lines.slice(findingsIndex + 1, findingsIndex + 4);
    expect(tableLines).toHaveLength(3);
    // ruleWidth(8) + sevWidth(14) + detailWidth(56) + 2 separators = 80,
    // for EVERY row regardless of glyph width — that is the alignment
    // guarantee `renderTable`'s displayWidth-based pad() provides.
    const widths = tableLines.map((line) => displayWidth(line));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(width);
  });
});

describe("governance screen — colour discipline", () => {
  it("emits no raw ANSI escape codes when color is disabled", () => {
    const lines = render(REALISTIC_SNAPSHOT, 100, 100, false);
    for (const line of lines) expect(line).not.toContain("[");
  });

  it("confines ANSI escapes to theme-produced severity styling when color is enabled", () => {
    const lines = render(REALISTIC_SNAPSHOT, 100, 100, true);
    const coloredLines = lines.filter((l) => l.includes("["));
    expect(coloredLines.length).toBeGreaterThan(0);
    // Every escape sequence present is one of the ANSI helper's own SGR codes
    // (bold/dim/inverse/reset/red/green/yellow/magenta/cyan) — never an ad hoc
    // 256-color or raw byte sequence assembled inline in this screen. Read
    // directly off the ANSI export (theme-derived truecolor SGR, 4F polish
    // pass) rather than a hardcoded literal list, so this assertion tracks
    // the real values instead of a stale copy of them.
    const knownCodes = [ANSI.reset, ANSI.bold, ANSI.dim, ANSI.inverse, ANSI.red, ANSI.green, ANSI.yellow, ANSI.magenta, ANSI.cyan];
    for (const line of coloredLines) {
      const stripped = knownCodes.reduce((acc, code) => acc.split(code).join(""), line);
      expect(stripped).not.toContain("[");
    }
  });
});

describe("governance screen — determinism", () => {
  it("renders identical output for identical input, twice", () => {
    const projection = project(REALISTIC_SNAPSHOT);
    const r1 = governanceScreen.render({ projection, width: 100, height: 100, color: true });
    const r2 = governanceScreen.render({ projection, width: 100, height: 100, color: true });
    expect(r1).toEqual(r2);
  });

  it("re-projecting the same raw input twice yields deep-equal projections", () => {
    const p1 = project(REALISTIC_SNAPSHOT);
    const p2 = project(REALISTIC_SNAPSHOT);
    expect(p1).toEqual(p2);
  });
});

describe("governance screen — bound enforcement", () => {
  it("width clips every rendered line", () => {
    const lines = render(REALISTIC_SNAPSHOT, 30, 40);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30);
  });

  it("height bounds the total number of rendered lines", () => {
    const lines = render(REALISTIC_SNAPSHOT, 100, 6);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it("caps findings at the cardinality bound even when the input over-supplies", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => ({ rule_id: "POL-04", severity: "warning", detail: `d${i}` }));
    const projection = project({ policy_findings: huge }, 100, 200);
    expect(projection.rows.filter((r) => r.section === "finding").length).toBeLessThanOrEqual(200);
  });

  it("marks the caption's finding count as truncated, rather than reporting the bounded count as if it were the true total", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => ({ rule_id: "POL-04", severity: "warning", detail: `d${i}` }));
    const projection = project({ policy_findings: huge }, 100, 200);
    // 200 findings are shown (the cardinality bound), but the real snapshot
    // reported 5000 — a bare "200 findings" caption reads as a complete
    // count when it is actually a silently truncated one. The caption must
    // say so, the same way control.ts's host/inbox captions append "+" when
    // `truncated === true`.
    expect(projection.caption).toContain("200+");
    expect(projection.caption).not.toBe("Governance: 200 findings");
  });
});
