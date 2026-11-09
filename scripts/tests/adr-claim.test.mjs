/**
 * scripts/tests/adr-claim.test.mjs — real-git coverage for the claim ledger
 * (`scripts/lib/adr-claims.mjs`, `scripts/adr-claim.mjs`) and the status audit
 * (`scripts/adr-status-audit.mjs`). No mocks: every scenario runs against a
 * real `git init` temp repo (and, for the cross-worktree scenario, real
 * `git worktree add` checkouts sharing one git-common-dir), matching the
 * convention already established by `adr-registry.test.mjs` and
 * `e2e-adr-lifecycle.test.mjs`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeClaims, claimAdrs, claimsPath, releaseClaim } from "../lib/adr-claims.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAIM_CLI = resolve(HERE, "..", "adr-claim.mjs");
const STATUS_AUDIT_CLI = resolve(HERE, "..", "adr-status-audit.mjs");

let repo;
let worktrees;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(base, path, text) {
  const absolute = join(base, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "adr-claim-"));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: dir });
  git(dir, "config", "user.email", "claim@test.invalid");
  git(dir, "config", "user.name", "Claim Test");
  write(dir, "decisions/README.md", "# ADR Index\n\n| # | Title | Status |\n|---|---|---|\n");
  write(dir, "decisions/registry.json", `${JSON.stringify({
    schema_version: 1, next_available: 5, reserved: [], reserved_reason: {},
    allocations: [
      { number: 1, slug: "alpha", placeholder_id: "sha256:aaaa" },
      { number: 2, slug: "beta", placeholder_id: "sha256:bbbb" },
      { number: 3, slug: "gamma", placeholder_id: "sha256:cccc" },
    ],
  }, null, 2)}\n`);
  write(dir, "base.txt", "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

beforeEach(() => { repo = seedRepo(); worktrees = []; });
afterEach(() => {
  for (const wt of worktrees) rmSync(wt, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

function runClaimCli(cwd, args) {
  const result = spawnSync(process.execPath, [CLAIM_CLI, ...args, "--repo", cwd, "--json"], { cwd, encoding: "utf8" });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* non-JSON output is itself a finding */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

describe("adr-claims library — B-1 (advisory, not a lock)", () => {
  it("round-trips claim / list / release", () => {
    const claimed = claimAdrs({ repo, adrs: [1, 2], holder: "holder-a" });
    expect(claimed.ok).toBe(true);
    expect(claimed.adrs).toEqual([1, 2]);

    const active = activeClaims({ repo });
    expect(active.map((e) => e.adr).sort()).toEqual([1, 2]);
    expect(active.every((e) => e.holder === "holder-a")).toBe(true);

    const released = releaseClaim({ repo, holder: "holder-a" });
    expect(released.released.length).toBe(2);
    expect(activeClaims({ repo })).toEqual([]);
  });

  it("records two holders claiming the SAME ADR — advisory, never refused", () => {
    claimAdrs({ repo, adrs: [1], holder: "holder-a" });
    claimAdrs({ repo, adrs: [1], holder: "holder-b" });
    const active = activeClaims({ repo });
    const forOne = active.filter((e) => e.adr === 1);
    expect(forOne.map((e) => e.holder).sort()).toEqual(["holder-a", "holder-b"]);
  });

  it("prunes aged-out entries but never removes a live claim on age alone", () => {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days, past the 30-day bound
    claimAdrs({ repo, adrs: [1], holder: "ancient", at: old });
    claimAdrs({ repo, adrs: [2], holder: "recent" });
    const active = activeClaims({ repo });
    expect(active.map((e) => e.holder)).toEqual(["recent"]);
  });

  it("distinguishes a live holder pid from a dead one, and never auto-removes either", () => {
    claimAdrs({ repo, adrs: [1], holder: "me", pid: process.pid });
    // A pid essentially guaranteed not to be alive on this host.
    claimAdrs({ repo, adrs: [2], holder: "ghost", pid: 999999 });
    const active = activeClaims({ repo });
    const mine = active.find((e) => e.adr === 1);
    const ghost = active.find((e) => e.adr === 2);
    expect(mine.pid_alive).toBe(true);
    expect(ghost.pid_alive).toBe(false);
    // Both still present — dead-pid detection is reporting, not remediation.
    expect(active.length).toBe(2);
  });

  it("fails clearly when claiming an ADR number absent from decisions/registry.json", () => {
    expect(() => claimAdrs({ repo, adrs: [999], holder: "holder-a" })).toThrow(/no matching allocation/);
    expect(activeClaims({ repo })).toEqual([]);
  });

  it("concurrent claims from two REAL worktrees are both recorded (shared git-common-dir)", () => {
    const wtA = join(tmpdir(), `adr-claim-wt-a-${Date.now()}`);
    const wtB = join(tmpdir(), `adr-claim-wt-b-${Date.now()}`);
    git(repo, "worktree", "add", "-q", "--detach", wtA, "HEAD");
    git(repo, "worktree", "add", "-q", "--detach", wtB, "HEAD");
    worktrees.push(wtA, wtB);

    const a = runClaimCli(wtA, ["claim", "1", "--holder", "agent-a"]);
    const b = runClaimCli(wtB, ["claim", "1", "--holder", "agent-b"]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);

    const listed = runClaimCli(repo, ["list"]);
    expect(listed.json.map((e) => e.holder).sort()).toEqual(["agent-a", "agent-b"]);
    // Both worktrees see the same shared ledger — it lives outside either tracked tree.
    expect(claimsPath(wtA)).toBe(claimsPath(wtB));
  });
});

describe("adr-claim CLI — B-2", () => {
  it("claim / list / release round-trip through the CLI with --json", () => {
    const claimed = runClaimCli(repo, ["claim", "1", "2", "--holder", "cli-holder"]);
    expect(claimed.status).toBe(0);
    expect(claimed.json.adrs).toEqual([1, 2]);

    const listed = runClaimCli(repo, ["list"]);
    expect(listed.status).toBe(0);
    expect(listed.json.length).toBe(2);
    expect(listed.json.every((e) => "pid_alive" in e)).toBe(true);

    const released = runClaimCli(repo, ["release", "--holder", "cli-holder"]);
    expect(released.status).toBe(0);
    expect(released.json.released.length).toBe(2);
    expect(runClaimCli(repo, ["list"]).json).toEqual([]);
  });

  it("exits non-zero with a clear message for a nonexistent ADR", () => {
    const result = runClaimCli(repo, ["claim", "42", "--holder", "cli-holder"]);
    expect(result.status).not.toBe(0);
    expect(result.json.error).toMatch(/no matching allocation/);
  });

  it("uses a mechanical default holder when --holder is omitted", () => {
    const claimed = runClaimCli(repo, ["claim", "1"]);
    expect(claimed.status).toBe(0);
    expect(typeof claimed.json.holder).toBe("string");
    expect(claimed.json.holder.length).toBeGreaterThan(0);
  });
});

describe("adr-status-audit — B-3", () => {
  function writeAdr(path, { status, obligations }) {
    write(repo, path, `# ADR-001: Fixture\n\n**Status:** ${status}\n**Date:** 2026-01-01\n\n## Context\n\nFixture.\n\n## Obligations\n\n${obligations}\n`);
  }

  /**
   * The obligation resolver (`@arbor/governance`) checks a `roundtrip=`
   * citation against `vitest.config.ts`'s own `include` globs, and resolves a
   * repo root by walking up for `decisions/` + `package.json`/`.git` — both
   * real facts about the WORKING TREE the audit is pointed at, not about this
   * test file's own repo. So a proof that should resolve needs a real symbol
   * file, a real roundtrip file, and a real vitest config, all seeded inside
   * the fixture repo itself.
   */
  function seedResolvableProofFixture() {
    write(repo, "src/thing.ts", "export function doThing() {\n  return 1;\n}\n");
    write(repo, "tests/thing.test.ts", "// fixture roundtrip file — content is irrelevant to resolution\n");
    write(repo, "vitest.config.ts", "export default { test: { include: [\"tests/**/*.test.ts\"] } };\n");
  }

  function runAudit(args = []) {
    // bun, not process.execPath: this script imports @arbor/governance's TS
    // source directly, which only bun's module resolution (not plain node's)
    // can load, same as `bun run gate:adr-status` in package.json.
    const result = spawnSync("bun", [STATUS_AUDIT_CLI, "--repo", repo, ...args], { cwd: repo, encoding: "utf8" });
    let json = null;
    try { json = JSON.parse(result.stdout); } catch { /* non-JSON is a finding for --json-less runs */ }
    return { status: result.status, stdout: result.stdout, json };
  }

  it("flags a Proposed ADR whose proofs all resolve as status_suspect", () => {
    // Real symbol + real roundtrip test, both resolvable against this fixture repo.
    seedResolvableProofFixture();
    writeAdr(
      "decisions/ADR-001-fixture.md",
      {
        status: "Proposed",
        obligations: `### O1 — does the thing\n\n<!-- proof: symbol=doThing file=src/thing.ts roundtrip=tests/thing.test.ts -->\n`,
      },
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "add fixture ADR");

    const run = runAudit(["--json"]);
    // A suspect record is now a FAILING gate. It exited 0 on this exact input
    // until todo 5, which is what `guard:canaries` reported as `unproven`: a
    // gate that classifies a record as suspect, prints it, and returns success.
    expect(run.status).toBe(1);
    const row = run.json.records.find((r) => r.adr === 1);
    expect(row.classification).toBe("status_suspect");
    expect(row.obligations_with_resolving_proof).toBeGreaterThan(0);
  });

  it("does not flag a Superseded ADR whose proofs resolve (it was accepted before it was retired)", () => {
    seedResolvableProofFixture();
    writeAdr(
      "decisions/ADR-001-fixture.md",
      {
        status: "Superseded by ADR-002",
        obligations: `### O1 — does the thing\n\n<!-- proof: symbol=doThing file=src/thing.ts roundtrip=tests/thing.test.ts -->\n`,
      },
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "add fixture ADR");

    const run = runAudit(["--json"]);
    expect(run.status).toBe(0);
    const row = run.json.records.find((r) => r.adr === 1);
    expect(row.classification).toBe("status_consistent");
    expect(row.obligations_with_resolving_proof).toBeGreaterThan(0);
  });

  it("does NOT flag a Proposed ADR with no obligations and no implementation", () => {
    writeAdr("decisions/ADR-001-fixture.md", { status: "Proposed", obligations: "" });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "add fixture ADR");

    const run = runAudit(["--json"]);
    expect(run.status).toBe(0);
    const row = run.json.records.find((r) => r.adr === 1);
    expect(row.classification).toBe("status_consistent");
    expect(row.obligation_count).toBe(0);
  });

  it("does not flag an Accepted record even with unresolved obligations (out of scope)", () => {
    writeAdr(
      "decisions/ADR-001-fixture.md",
      { status: "Accepted", obligations: "### O1 — nothing backs this\n\n<!-- unverifiable: no proof exists -->\n" },
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "add fixture ADR");

    const run = runAudit(["--json"]);
    const row = run.json.records.find((r) => r.adr === 1);
    expect(row.classification).toBe("status_consistent");
  });

  it("produces the documented --json shape", () => {
    writeAdr("decisions/ADR-001-fixture.md", { status: "Proposed", obligations: "" });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "add fixture ADR");

    const run = runAudit(["--json"]);
    // `blocking` is now true: a suspect record blocks. It was false by design
    // until todo 5 — "non-blocking by design" was the R2-01 defect, not a
    // property worth preserving.
    expect(run.json).toMatchObject({ ok: true, blocking: true, checked: expect.any(Number), suspect_count: expect.any(Number) });
    expect(Array.isArray(run.json.records)).toBe(true);
  });

  it("exits 0 when nothing is suspect, and non-zero when a record is (todo 5, R2-01)", () => {
    // Both directions, because the defect was an exit code that never moved.
    // Asserting only the non-zero case would pass against a gate that always
    // failed; asserting only the zero case is the test that let this ship.
    seedResolvableProofFixture();
    writeAdr("decisions/ADR-001-fixture.md", { status: "Proposed", obligations: "" });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "add fixture ADR");
    const clean = runAudit([]);
    expect(clean.status).toBe(0);

    writeAdr(
      "decisions/ADR-002-fixture.md",
      { status: "Proposed", obligations: "### O1 — does the thing\n\n<!-- proof: symbol=doThing file=src/thing.ts roundtrip=tests/thing.test.ts -->\n" },
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "add suspect ADR");
    const suspect = runAudit([]);
    expect(suspect.status).toBe(1);
  });
});
