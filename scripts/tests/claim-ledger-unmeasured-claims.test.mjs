/**
 * scripts/tests/claim-ledger-unmeasured-claims.test.mjs — a claim nothing was
 * obliged to back must not read as backed.
 *
 * Four members of one defect class, each a case where an ABSENCE was read as a
 * CLEAN result. Every fixture is synthetic and local: a temp directory with a
 * ROADMAP and (optionally) an ADR index, plus a docs-truth report passed in
 * directly. Nothing touches the real store, the real evidence lease, or the
 * repository's own `.claim-ledger/`.
 *
 * A separate file rather than an addition to `gate-failure-modes.test.mjs`: that
 * one runs every gate inside a real `git worktree` of this repository, which
 * shares the git-common-dir with the live evidence transaction lease. These
 * cases need no worktree, and refusing to publish must be provable without
 * taking a lease another producer may be holding.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLAIM_LEDGER = join(ROOT, "scripts", "claim-ledger.ts");
const CLAIM_LEDGER_LIBRARY_IMPORT = Symbol.for("revoy2.claim-ledger.library-import");

const ROADMAP_WITH_GAP_ROWS = [
  "# Roadmap",
  "",
  "## ✅ A validated tranche",
  "",
  "<!-- proof: ROADMAP.md:1 -->",
  "",
  "| Gap | Statement |",
  "|---|---|",
  "| **G-001** | **RESOLVED** the first thing |",
  "| **G-002** | **RESOLVED** the second thing |",
  "| **G-003** | still open |",
  "",
].join("\n");

const roots = [];

/** 1-indexed line of each gap-register row, so a fixture violation names a real line. */
const GAP_LINES = Object.fromEntries(ROADMAP_WITH_GAP_ROWS.split("\n").map((line, i) => {
  const gap = /^\| \*\*(G-\d+)\*\*/.exec(line);
  return gap ? [gap[1], i + 1] : null;
}).filter(Boolean));

function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

/**
 * The one repo all extraction cases read, since REPO_ROOT is fixed at module
 * load. Deliberately NOT registered for per-test cleanup: three cases read it.
 */
const EXTRACTION_ROOT = mkdtempSync(join(tmpdir(), "claim-unmeasured-"));
writeFileSync(join(EXTRACTION_ROOT, "ROADMAP.md"), ROADMAP_WITH_GAP_ROWS);

// REPO_ROOT is computed from argv at module scope, so argv must carry --repo
// before the single dynamic import below resolves the module for the first time.
process.argv = [...process.argv, "--repo", EXTRACTION_ROOT];
globalThis[CLAIM_LEDGER_LIBRARY_IMPORT] = true;
const { findAdrIndexDefects, roadmapClaims } = await import("../claim-ledger.ts");

const cleanReport = () => ({ ok: true, tranchesChecked: 1, proofsChecked: 1, registerRowsChecked: 3, violations: [] });

afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
afterAll(() => rmSync(EXTRACTION_ROOT, { recursive: true, force: true }));

describe("CL-D: a gap row with a docs-truth violation on its line is not discharged", () => {
  const gapRows = (report) => roadmapClaims(report).filter((claim) => claim.source === "gap_register_row");
  const statusOf = (rows, id) => rows.find((claim) => claim.claim_text.startsWith(id)).discharge_status;

  it("is undischarged when the report flags that exact line, and discharged when it does not", () => {
    // The gap-register branch used to hardcode `closed ? "discharged" :
    // "unverifiable"` and cite `bun run gate:docs-truth` as its evidence while
    // never consulting `dt`, `violatedLines` or `resolved` — so a RESOLVED
    // report carrying a violation on a closed row's exact line still produced
    // `discharged`, and the gate passed citing a gate that in the same report
    // called its own citation broken.
    const violated = cleanReport();
    violated.ok = false;
    violated.violations = [{ tranche: "", line: GAP_LINES["G-001"], reason: "fixture: G-001 cites a path that does not resolve" }];

    const flagged = gapRows(violated);
    expect(statusOf(flagged, "G-001")).toBe("undischarged");
    expect(statusOf(flagged, "G-002")).toBe("discharged");
    expect(statusOf(flagged, "G-003")).toBe("unverifiable");

    expect(gapRows(cleanReport()).filter((c) => c.asserted_value === "closed").every((c) => c.discharge_status === "discharged")).toBe(true);
  });

  it("is undischarged for EVERY closed row when docs-truth produced no report at all", () => {
    // `resolved === false` is the same fact here as a violation: the citations
    // were never checked, so nothing established that they resolve.
    const closed = gapRows(null).filter((c) => c.asserted_value === "closed");
    expect(closed).toHaveLength(2);
    expect(closed.every((claim) => claim.discharge_status === "undischarged")).toBe(true);
  });

  it("holds the same rule for the roadmap_heading sibling, so one rule covers both sites", () => {
    const headings = (report) => roadmapClaims(report).filter((c) => c.source === "roadmap_heading");
    expect(headings(cleanReport()).length).toBeGreaterThan(0);
    expect(headings(cleanReport()).every((c) => c.discharge_status === "discharged")).toBe(true);
    expect(headings(null).every((c) => c.discharge_status === "undischarged")).toBe(true);
  });
});

describe("CL-F: a missing ADR index is a loud defect, not zero claims and zero findings", () => {
  it("reports an absent decisions/README.md as an index defect", () => {
    // Returning `[]` for an absent index removed the whole
    // `adr_readme_index_entry` population AND every defect simultaneously, so
    // deleting the index turned CL-B into a quiet pass over 243 claims instead
    // of 410. Fewer claims read as health.
    const root = temp("claim-noindex-");
    mkdirSync(join(root, "decisions"), { recursive: true });
    writeFileSync(join(root, "decisions", "ADR-001-example.md"), "**Status:** accepted\n");
    const defects = findAdrIndexDefects(root);
    expect(defects).toHaveLength(1);
    expect(defects[0].adr).toBe("index");
    expect(defects[0].detail).toContain("decisions/README.md is absent");
  });

  it("reports an absent decisions/ directory rather than returning nothing", () => {
    expect(findAdrIndexDefects(temp("claim-nodecisions-"))[0].detail).toContain("decisions/ does not exist");
  });

  it("still reports real per-row drift when the index IS present", () => {
    const root = temp("claim-index-drift-");
    mkdirSync(join(root, "decisions"), { recursive: true });
    writeFileSync(join(root, "decisions", "ADR-001-example.md"), "**Status:** accepted\n");
    writeFileSync(join(root, "decisions", "README.md"), "| # | Title | Status |\n|---|---|---|\n| [1](ADR-001-example.md) | One | Draft |\n");
    const defects = findAdrIndexDefects(root);
    expect(defects).toHaveLength(1);
    expect(defects[0].detail).toContain('index says "Draft"');
  });
});

describe("CL-E: --refresh writes nothing when the validating gate produced no report", () => {
  it("refuses, exits non-zero, and leaves no store and no manifest", () => {
    // The gate already refused to call an unresolved run green (CL-C), but the
    // `--refresh` path never read that flag: it wrote claims.jsonl + a manifest
    // carrying a real `content_hash` and a real `scanned_up_to_revision` either
    // way, so `gate:store-freshness` then read the result as `ok … content
    // hash matches` — a green freshness signal derived from a validation that
    // never ran. Both halves were true at once because the hash covers INPUTS,
    // which a broken docs-truth does not change.
    //
    // A temp repo with no `scripts/docs-truth.mjs` is the forced-null path:
    // `execFileSync` cannot spawn it, so `docsTruth()` genuinely returns null
    // rather than depending on whatever state the live docs-truth is in.
    const root = temp("claim-refresh-nodocs-");
    const store = join(root, ".claim-ledger");
    const result = spawnSync("bun", [CLAIM_LEDGER, "--refresh", "--repo", root, "--json"], {
      cwd: root, encoding: "utf-8", env: { ...process.env, REVOY2_CLAIM_LEDGER_DIR: store },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("validation_unavailable");
    expect(existsSync(join(store, "manifest.json"))).toBe(false);
    expect(existsSync(join(store, "claims.jsonl"))).toBe(false);
    expect(existsSync(store)).toBe(false);
  });

  it("refuses before taking the producer lease, so a refusal cannot strand one", () => {
    // A refusal that acquired `assertEvidenceProducerAuthority` and then bailed
    // would leave an evidence transaction held against every sibling producer
    // in this checkout.
    const root = temp("claim-refresh-nolease-");
    const result = spawnSync("bun", [CLAIM_LEDGER, "--refresh", "--repo", root, "--json"], {
      cwd: root, encoding: "utf-8",
    });
    expect(result.status).toBe(1);
    expect(existsSync(join(root, ".git"))).toBe(false);
    const source = readFileSync(CLAIM_LEDGER, "utf8");
    expect(source.indexOf("if (REFRESH && !docsTruthAvailable)")).toBeGreaterThan(-1);
    expect(source.indexOf("if (REFRESH && !docsTruthAvailable)")).toBeLessThan(source.indexOf("assertEvidenceProducerAuthority(REPO_ROOT)"));
  });
});
