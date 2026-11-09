import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandIdList, parseCanvasReconciliation, parseDefectRows, reconcile } from "../audit-reconcile.mjs";

/**
 * scripts/tests/audit-reconcile.test.mjs — a defect row must not read as
 * live forever, and this script must never overclaim that it does not.
 *
 * The properties worth protecting, in order:
 *   1. An id is parsed only from its OWN row, never from an "origin" column
 *      that merely cites another id elsewhere in the table.
 *   2. A commit citing the id after the audit date is surfaced as
 *      "fix-committed" evidence — but the label NEVER says a bare "CLOSED".
 *      Per gate:audit-disposition's own doctrine, a commit reference is
 *      evidence a fix was attempted, not proof the defect is gone.
 *   3. A row with no signal reads `unreconciled` — the honest default, never
 *      silently promoted to anything stronger.
 */

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
}

/** A fixture audit/ dir plus a real, isolated git repo with commit history. */
function fixture({ files = {}, commits = [] } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "audit-reconcile-"));
  dirs.push(repo);
  mkdirSync(join(repo, "audit"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, "audit", name), body);

  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  // A commit predating the audit wave, so date filtering has something to exclude.
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "chore: seed", "--date=2026-08-01T00:00:00"]);

  for (const c of commits) {
    writeFileSync(join(repo, `${c.hash ?? Math.random()}.txt`), "x\n");
    git(repo, ["add", "-A"]);
    const args = ["commit", "-q", "-m", c.message, `--date=${c.date}T00:00:00`];
    git(repo, args);
  }
  return repo;
}

describe("row identity: only the row's own first cell is an id", () => {
  it("parses a WA row and ignores an id merely cited in another column", () => {
    const repo = fixture({
      files: {
        "2026-08-23-50-defects.md":
          "| WA | Sev | Origin | Finding | Remedy |\n" +
          "|---|---|---|---|---|\n" +
          "| WA-67 | S2 | live bench | some finding referencing WA-99 in prose | fix it |\n",
      },
    });
    const rows = parseDefectRows(repo);
    expect(rows.map((r) => r.id)).toEqual(["WA-67"]);
    expect(rows[0].description).toContain("fix it");
  });

  it("captures a bold-wrapped id (**WA-25**) the same as a plain one", () => {
    const repo = fixture({
      files: { "2026-08-23-50-defects.md": "| **WA-25** | S2 | live | arrow keys broken | add sequences |\n" },
    });
    expect(parseDefectRows(repo).map((r) => r.id)).toEqual(["WA-25"]);
  });
});

describe("fix-committed status carries the honesty boundary", () => {
  it("derives fix-committed when a later commit cites the id, and never says a bare CLOSED", () => {
    const repo = fixture({
      files: { "2026-08-23-50-defects.md": "| WA-67 | S2 | live | unadoptable verified_result | re-scope flow |\n" },
      commits: [{ message: "fix(adopt): legible refusal and scope ack (WA-67, ADR-065)", date: "2026-08-24" }],
    });
    const report = reconcile({ repo });
    const row = report.rows.find((r) => r.id === "WA-67");
    expect(row.status).toBe("fix-committed");
    expect(row.fix_commits.length).toBe(1);
    expect(row.label).toContain("VERIFY before treating as live");
    expect(row.label).not.toMatch(/\bCLOSED\b/);
    expect(row.label.toLowerCase()).not.toBe("closed");
  });

  it("does NOT credit a commit before the audit wave date", () => {
    const repo = fixture({
      files: { "2026-08-23-50-defects.md": "| WA-67 | S2 | live | thing | fix |\n" },
      // Only the pre-wave seed commit (2026-08-01) exists; nothing after 2026-08-23 cites WA-67.
    });
    const row = reconcile({ repo }).rows.find((r) => r.id === "WA-67");
    expect(row.status).toBe("unreconciled");
  });
});

describe("no signal reads unreconciled, never promoted", () => {
  it("a row with no commit and no register mention is unreconciled", () => {
    const repo = fixture({
      files: { "2026-08-23-50-defects.md": "| WA-05 | S4 | scouting | stale dist artifact | clean + doc |\n" },
    });
    const report = reconcile({ repo });
    expect(report.rows.map((r) => [r.id, r.status])).toEqual([["WA-05", "unreconciled"]]);
    expect(report.unreconciled).toBe(1);
  });
});

describe("canvas register cross-reference", () => {
  it("reads declared-open and declared-closed from the hand-written lists", () => {
    const repo = fixture({
      files: {
        "2026-08-23-50-defects.md":
          "| WA-10 | S1 | live | fixed already | do a thing |\n" +
          "| WA-36 | S2 | live | still broken | do another thing |\n",
        "2026-08-23-60-canvas-register.md":
          "## WA reconciliation at `14416e50`\n" +
          "Verified CLOSED in code: WA-10. Verified still OPEN: WA-36 (`require_local_session` TUI-only). " +
          "Not re-verified this pass: WA-99.\n",
      },
    });
    const report = reconcile({ repo });
    const closed = report.rows.find((r) => r.id === "WA-10");
    const open = report.rows.find((r) => r.id === "WA-36");
    expect(closed.status).toBe("declared-closed");
    expect(closed.label.trim().toUpperCase()).not.toBe("CLOSED");
    expect(closed.label).toContain("VERIFY before treating as live");
    expect(open.status).toBe("declared-open");
  });

  it("flags the contradiction when a commit lands after a row was declared OPEN", () => {
    const repo = fixture({
      files: {
        "2026-08-23-50-defects.md": "| WA-68 | S3 | live bench | auto-confirm undocumented | document it |\n",
        "2026-08-23-60-canvas-register.md":
          "## WA reconciliation at `14416e50`\nVerified still OPEN: WA-68 (no fix yet).\n",
      },
      commits: [{ message: "fix(cli): honest confirm semantics (WA-68, ADR-028)", date: "2026-08-24" }],
    });
    const row = reconcile({ repo }).rows.find((r) => r.id === "WA-68");
    expect(row.status).toBe("fix-committed");
    expect(row.register_declared_open).toBe(true);
    expect(row.label).toMatch(/contradiction/);
  });
});

describe("expandIdList handles the register's comma/slash/range syntax", () => {
  it("expands a comma list with an implied prefix, preserving zero-padding", () => {
    expect(expandIdList("WA-03,10,11,12", "WA")).toEqual(["WA-03", "WA-10", "WA-11", "WA-12"]);
  });

  it("expands a slash-joined pair as two distinct ids", () => {
    expect(expandIdList("WA-67/68", "WA")).toEqual(["WA-67", "WA-68"]);
  });

  it("expands a bare numeric range under the last seen prefix", () => {
    expect(expandIdList("60,62-66,70", "WA")).toEqual(["WA-60", "WA-62", "WA-63", "WA-64", "WA-65", "WA-66", "WA-70"]);
  });
});

describe("honesty: nothing here ever prints a bare CLOSED verdict", () => {
  it("no row's label is exactly the string CLOSED across every status", () => {
    const repo = fixture({
      files: {
        "2026-08-23-50-defects.md":
          "| WA-01 | S3 | live | a | b |\n| WA-02 | S3 | live | c | d |\n| WA-03 | S3 | live | e | f |\n",
        "2026-08-23-60-canvas-register.md":
          "## WA reconciliation at `x`\nVerified CLOSED in code: WA-02. Verified still OPEN: WA-03.\n",
      },
      commits: [{ message: "fix: touches WA-01", date: "2026-08-24" }],
    });
    const report = reconcile({ repo });
    expect(report.rows.length).toBe(3);
    for (const row of report.rows) {
      expect(row.label.trim().toUpperCase()).not.toBe("CLOSED");
    }
  });
});

describe("parseCanvasReconciliation reports absence honestly", () => {
  it("reports found:false when the register file or its reconciliation heading is absent", () => {
    const repo = fixture({ files: { "2026-08-23-50-defects.md": "| WA-01 | S3 | live | a | b |\n" } });
    expect(parseCanvasReconciliation(repo).found).toBe(false);
  });
});
