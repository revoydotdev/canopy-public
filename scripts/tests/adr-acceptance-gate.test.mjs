import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { checkAdrAcceptance } from "../lib/adr-acceptance.mjs";

let repo;
const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); }
function write(path, text) { const absolute = join(repo, path); mkdirSync(dirname(absolute), { recursive: true }); writeFileSync(absolute, text); }
function commit(message) { git("add", "-A"); git("commit", "-q", "-m", message); }
function adr(status, body = "The decision body stays fixed.") { return `# ADR-999: Fixture\n\n**Status:** ${status}\n**Date:** 2026-08-12\n\n## Context\n\n${body}\n`; }
function index(status) { return `# ADR Index\n\n| # | Title | Status |\n|---|---|---|\n| [999](ADR-999-fixture.md) | Fixture | ${status} |\n`; }

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "arbor-adr-acceptance-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "acceptance@test.invalid");
  git("config", "user.name", "Acceptance Test");
  write("README.md", "fixture\n");
  commit("base");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("ADR acceptance authority", () => {
  it("refuses the roadmap 09/10 shape: one commit creates an already-Accepted ADR", () => {
    write("decisions/ADR-999-fixture.md", adr("Accepted"));
    write("decisions/README.md", index("Accepted"));
    commit("author and self-accept ADR");
    expect(checkAdrAcceptance({ repo })).toMatchObject({ ok: false, violations: [{ code: "new_adr_not_proposed", message: expect.stringContaining("newly-authored ADR must be Proposed") }] });
  });

  it("allows a later status-only acceptance commit", () => {
    write("decisions/ADR-999-fixture.md", adr("Proposed"));
    write("decisions/README.md", index("Proposed"));
    commit("propose ADR");
    write("decisions/ADR-999-fixture.md", adr("Accepted"));
    write("decisions/README.md", index("Accepted"));
    commit("accept ADR");
    expect(checkAdrAcceptance({ repo })).toMatchObject({ ok: true, violations: [] });
  });

  it("refuses acceptance bundled with substantive content changes", () => {
    write("decisions/ADR-999-fixture.md", adr("Proposed"));
    write("decisions/README.md", index("Proposed"));
    commit("propose ADR");
    write("decisions/ADR-999-fixture.md", adr("Accepted", "The acceptor also rewrote the decision."));
    write("decisions/README.md", index("Accepted"));
    commit("rewrite and accept ADR");
    expect(checkAdrAcceptance({ repo })).toMatchObject({ ok: false, violations: [{ code: "acceptance_bundles_content", message: expect.stringContaining("status-only") }] });
  });

  it("names the adr:accept remedy for a status-only violation", () => {
    write("decisions/ADR-999-fixture.md", adr("Proposed"));
    write("decisions/README.md", index("Proposed"));
    commit("propose ADR");
    write("decisions/ADR-999-fixture.md", adr("Accepted", "The acceptor also rewrote the decision."));
    write("decisions/README.md", index("Accepted"));
    commit("rewrite and accept ADR");
    expect(checkAdrAcceptance({ repo })).toMatchObject({ violations: [{ code: "acceptance_bundles_content", message: expect.stringContaining("bun run adr:accept") }] });
  });

  it("names the adr:accept remedy for a status/index mismatch, but not for other index defects", () => {
    write("decisions/ADR-999-fixture.md", adr("Proposed"));
    write("decisions/README.md", index("Proposed"));
    commit("propose ADR");
    // The file was accepted, but the index row was never updated to match.
    write("decisions/ADR-999-fixture.md", adr("Accepted"));
    commit("accept ADR without updating the index");
    const mismatch = checkAdrAcceptance({ repo }).violations.find((violation) => violation.code === "index_status_contradiction");
    expect(mismatch.message).toContain('index says "Proposed"');
    expect(mismatch.message).toContain("bun run adr:accept");

    // A missing index row entirely is a different defect (no row to reconcile
    // by flipping a status), so no adr:accept remedy is attached to it.
    const missingRowRepo = mkdtempSync(join(tmpdir(), "arbor-adr-acceptance-missing-row-"));
    try {
      const missingRow = missingRowRepo;
      execFileSync("git", ["init", "-q", "-b", "master"], { cwd: missingRow });
      execFileSync("git", ["config", "user.email", "acceptance@test.invalid"], { cwd: missingRow });
      execFileSync("git", ["config", "user.name", "Acceptance Test"], { cwd: missingRow });
      mkdirSync(join(missingRow, "decisions"), { recursive: true });
      writeFileSync(join(missingRow, "decisions", "ADR-999-fixture.md"), adr("Accepted"));
      writeFileSync(join(missingRow, "decisions", "README.md"), "# ADR Index\n\n| # | Title | Status |\n|---|---|---|\n");
      execFileSync("git", ["add", "-A"], { cwd: missingRow });
      execFileSync("git", ["commit", "-q", "-m", "author with no index row"], { cwd: missingRow });
      const noRow = checkAdrAcceptance({ repo: missingRow }).violations.find((violation) => violation.code === "index_status_contradiction");
      expect(noRow.message).toContain("no row in decisions/README.md");
      expect(noRow.message).not.toContain("bun run adr:accept");
    } finally {
      rmSync(missingRowRepo, { recursive: true, force: true });
    }
  });

  it("parses the ADR-024 compound Accepted form by its leading token", () => {
    write("decisions/ADR-999-fixture.md", adr("Proposed"));
    write("decisions/README.md", index("Proposed"));
    commit("propose ADR");
    const compound = "Accepted (ratified 2026-08-05; boundary deferred to ADR-028)";
    write("decisions/ADR-999-fixture.md", adr(compound));
    write("decisions/README.md", index("Accepted (operator ratification recorded separately)"));
    commit("ratify ADR");
    expect(checkAdrAcceptance({ repo })).toMatchObject({ ok: true });
  });

  it("checks the staged snapshot used by the pre-commit hook", () => {
    write("decisions/ADR-999-fixture.md", adr("Accepted"));
    write("decisions/README.md", index("Accepted"));
    git("add", "decisions");
    expect(checkAdrAcceptance({ repo, staged: true })).toMatchObject({ ok: false, violations: [{ code: "new_adr_not_proposed" }] });
  });

  it("imports the claim-ledger's status/index comparison instead of duplicating its parser", () => {
    const source = readFileSync(join(SCRIPT_ROOT, "lib", "adr-acceptance.mjs"), "utf8");
    expect(source).toContain('import("../claim-ledger.ts")');
    expect(source).toContain("findAdrIndexDefectsFromEntries");
    expect(source).toContain("leadingAdrStatus");
  });
});
