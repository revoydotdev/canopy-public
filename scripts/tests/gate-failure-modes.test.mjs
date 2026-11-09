import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { computeEvidenceContentHashForStore } from "../lib/store-provenance.mjs";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

/**
 * Every gate this file runs against "the real, committed stores" hashes the
 * ENTIRE live working tree (scripts/lib/store-provenance.mjs computes it from
 * `git ls-files -co --exclude-standard` + readFileSync of every non-generated
 * path under REPO_ROOT). Pointed straight at REPO_ROOT, that ties every such
 * assertion to whatever this checkout's working tree happens to contain at
 * the moment each `spawnSync` actually runs — anywhere from seconds to several
 * minutes after this file's module-level `CONTENT_HASH` was captured, across
 * a 400+ file suite. This repository's normal operating mode is concurrent —
 * other agents commit into this same checkout while a full suite runs (see
 * the `concurrent-git-index-race` memory) — so REPO_ROOT is not a fixed
 * value for the duration of this file, and a commit landing mid-run changes
 * both which bytes get hashed AND which HEAD the gate reasons about.
 *
 * A `git worktree` frozen once at this file's own start gives every gate in
 * this file — fixture-backed or not — a HEAD and a set of bytes that cannot
 * change out from under an assertion, without touching the shared checkout
 * everyone else is working in. node_modules is hardlinked in rather than
 * symlinked: a symlinked `node_modules` is NOT matched by the `node_modules/`
 * gitignore pattern (git only matches that pattern against real directories),
 * so `git ls-files -co --exclude-standard` would list the symlink itself and
 * computeEvidenceContentHash's readFileSync would EISDIR trying to read a
 * directory. The snapshot lives beside REPO_ROOT (not under os.tmpdir()) so
 * the hardlink is same-filesystem and effectively instant.
 */
const SNAPSHOT_PARENT = mkdtempSync(join(dirname(REPO_ROOT), ".gate-freshness-snapshot-"));
const SNAPSHOT_DIR = join(SNAPSHOT_PARENT, "repo");
execFileSync("git", ["worktree", "add", "-q", "--detach", SNAPSHOT_DIR, "HEAD"], { cwd: REPO_ROOT });
execFileSync("cp", ["-al", join(REPO_ROOT, "node_modules"), join(SNAPSHOT_DIR, "node_modules")]);
const DOCS_TRUTH_REPORT = join(SNAPSHOT_PARENT, "docs-truth.json");
const docsTruth = spawnSync(process.execPath, [join(SNAPSHOT_DIR, "scripts/docs-truth.mjs"), "--json"], {
  cwd: SNAPSHOT_DIR, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024,
});
// Exit 1 means docs-truth found real drift; its JSON remains authoritative.
if (docsTruth.status !== 0 && docsTruth.status !== 1) throw new Error(`frozen docs-truth setup failed: ${docsTruth.stderr}`);
JSON.parse(docsTruth.stdout);
writeFileSync(DOCS_TRUTH_REPORT, docsTruth.stdout);

/**
 * A GATE THAT HAS NEVER BEEN OBSERVED FAILING IS NOT A GATE.
 *
 * This suite exists because that sentence was demonstrated twice in one week,
 * both times by checks that looked completely healthy:
 *
 *   - `vi-freshness-gate.mjs` printed "…and is not degraded" on every run from a
 *     check reading `manifest.planes.derived.reachability` — a key no manifest
 *     the extractor produces has ever contained. It passed for its entire life
 *     while being structurally incapable of firing.
 *   - `claim-ledger.ts` parsed `docs-truth`'s violations as `{heading, detail}`.
 *     The real shape is `{tranche, line, reason}`. Both guessed fields were
 *     undefined, so the violated-set was always empty and a new unproven
 *     completeness marker could never have been flagged — inside the gate built
 *     to catch exactly that.
 *
 * Neither was caught by reading the code, and neither would have been caught by
 * a test asserting the gate PASSES on a clean tree. Only injecting a real defect
 * and demanding a non-zero exit distinguishes "this gate is satisfied" from
 * "this gate is asleep".
 *
 * METHOD. Each gate reads its store from an env-overridable directory, so these
 * tests build a fixture store in a temp dir and never mutate the repository. Git
 * history is still the real one — the point is to corrupt the INPUT the gate
 * reasons about, not to fake the world around it.
 */

const TMP = [];
function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `revoy2-${prefix}-`));
  TMP.push(dir);
  return dir;
}

/** Run a gate — against the frozen snapshot, never the live checkout — and return its exit code, never throwing on non-zero. */
function runGate(script, { env = {}, args = [], docsTruthPath = DOCS_TRUTH_REPORT } = {}) {
  const isTs = script.endsWith(".ts");
  const effectiveArgs = script === "claim-ledger.ts" ? ["--docs-truth-json", docsTruthPath, ...args] : args;
  const cmd = isTs
    ? [join(SNAPSHOT_DIR, "node_modules/.bin/vite-node"), "-c", "vitest.config.ts", join(SNAPSHOT_DIR, "scripts", script), "--", ...effectiveArgs]
    : [join(SNAPSHOT_DIR, "scripts", script), ...effectiveArgs];
  const result = spawnSync(process.execPath, cmd, {
    cwd: SNAPSHOT_DIR,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: SNAPSHOT_DIR, encoding: "utf-8" }).trim();
const ROOT_COMMIT = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: SNAPSHOT_DIR, encoding: "utf-8" })
  .trim().split("\n")[0];
// Per-store, not one shared digest. Each evidence store declares its own
// input scope (STORE_SCOPES in lib/store-provenance.mjs), so the four
// expected hashes genuinely differ — a single shared value would only ever
// match one store and would make three of these fixtures assert nothing.
const STORE_HASH = Object.fromEntries(
  ["claim-ledger", "determinism-baseline", "completion-depth", "vi-observed"]
    .map((name) => [name, computeEvidenceContentHashForStore(SNAPSHOT_DIR, name)]),
);

afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
  spawnSync("git", ["worktree", "remove", "--force", SNAPSHOT_DIR], { cwd: REPO_ROOT });
  rmSync(SNAPSHOT_PARENT, { recursive: true, force: true });
});

describe("store-freshness gate — can it actually fail?", () => {
  const manifest = (dir, revision, contentHash) =>
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema_version: 1, scanned_up_to_revision: revision, content_hash: contentHash }));
  /** The four stores in the order the env vars below are assigned. */
  const STORES = ["claim-ledger", "determinism-baseline", "completion-depth", "vi-observed"];

  it("passes when every store's manifest names HEAD", () => {
    const dirs = [fixture("cl"), fixture("det"), fixture("cd"), fixture("vio")];
    dirs.forEach((d, i) => manifest(d, HEAD, STORE_HASH[STORES[i]]));
    const { code } = runGate("store-freshness-gate.mjs", {
      env: {
        REVOY2_CLAIM_LEDGER_DIR: dirs[0],
        REVOY2_DETERMINISM_DIR: dirs[1],
        REVOY2_COMPLETION_DEPTH_DIR: dirs[2],
        REVOY2_VI_OBSERVED_DIR: dirs[3],
      },
    });
    expect(code).toBe(0);
  });

  it("FAILS when content matches but the recorded revision is unresolvable — UNMEASURED, not zero", () => {
    // One directory per store: each store's expected content hash is derived
    // from its own input scope, so a single shared fixture dir could satisfy at
    // most one of them. The property under test is that a revision that cannot
    // be resolved is refused rather than parked in an advisory string. It used
    // to pass with `code === 0` and `detail: "… recorded revision is
    // unavailable (content still matches)"`, which is the same claim as `ok` —
    // and `scripts/vi-freshness-gate.mjs` already refused it.
    const dirs = STORES.map((name) => fixture(`bogus-${name}`));
    dirs.forEach((d, i) => manifest(d, "0".repeat(40), STORE_HASH[STORES[i]]));
    const { code, out } = runGate("store-freshness-gate.mjs", { env: {
      REVOY2_CLAIM_LEDGER_DIR: dirs[0],
      REVOY2_DETERMINISM_DIR: dirs[1],
      REVOY2_COMPLETION_DEPTH_DIR: dirs[2],
      REVOY2_VI_OBSERVED_DIR: dirs[3],
    } });
    expect(code).toBe(1);
    expect(out).toContain("is not a commit in this repository");
  });

  it("FAILS when a store exists with no manifest — an unmeasurable store is a gap, not a pass", () => {
    const dir = fixture("cd-nomanifest");
    const { code, out } = runGate("store-freshness-gate.mjs", { env: { REVOY2_COMPLETION_DEPTH_DIR: dir } });
    expect(code).toBe(1);
    expect(out).toContain("no manifest");
  });

  it("FAILS when content differs even if the revision is an ancestor", () => {
    const dir = fixture("cd-mismatch");
    manifest(dir, ROOT_COMMIT, "sha256:deadbeef");
    const { code, out } = runGate("store-freshness-gate.mjs", { env: { REVOY2_COMPLETION_DEPTH_DIR: dir } });
    expect(code).toBe(1);
    expect(out).toContain("content hash differs");
  });
});

describe("completion-depth gate — can it actually fail?", () => {
  /**
   * This gate re-extracts findings from source on every run, so a synthetic
   * store row proves nothing. Instead, add a real production guard and a
   * test-only setter to the disposable snapshot for the duration of each
   * assertion. The key is deliberately unique to this fixture, while the
   * production receiver is local rather than parameter-rooted.
   */
  const HOLLOW_KEY = "__completion_depth_gate_fixture__";
  const withNewHollowFixture = (run) => {
    const source = join(SNAPSHOT_DIR, "packages/arbor-core/src/__completion-depth-gate-fixture__.ts");
    const test = join(SNAPSHOT_DIR, "packages/arbor-core/tests/__completion-depth-gate-fixture__.test.ts");
    writeFileSync(source, `export function completionDepthGateFixture(): boolean {
  const local: { ${HOLLOW_KEY}?: boolean } = {};
  if (local.${HOLLOW_KEY}) return true;
  return false;
}\n`);
    writeFileSync(test, `export const completionDepthGateFixtureTestValue = { ${HOLLOW_KEY}: true };\n`);
    try { return run(); } finally {
      rmSync(source, { force: true });
      rmSync(test, { force: true });
    }
  };

  it("FAILS immediately when a newly extracted finding is untriaged", () => {
    const dir = fixture("cd-expired");
    withNewHollowFixture(() => {
      const { code, out } = runGate("completion-depth.mjs", { env: { REVOY2_COMPLETION_DEPTH_DIR: dir } });
      expect(code).toBe(1);
      expect(out).toContain("CD-X");
      expect(out).toContain(HOLLOW_KEY);
    });
  });

  it("does NOT fail once that finding carries a verdict — a verdict closes it, a fix is not required", () => {
    const dir = fixture("cd-triaged");
    withNewHollowFixture(() => {
      expect(runGate("completion-depth.mjs", { env: { REVOY2_COMPLETION_DEPTH_DIR: dir }, args: ["--refresh"] }).code).toBe(0);
      const findings = readFileSync(join(dir, "findings.jsonl"), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(findings).toContainEqual(expect.objectContaining({ gating_key: HOLLOW_KEY, verdict: "untriaged" }));
      writeFileSync(join(dir, "findings.jsonl"), `${findings.map((finding) => JSON.stringify({ ...finding, verdict: "false_positive", verdict_reason: "fixture triage" })).join("\n")}\n`);
      const { code } = runGate("completion-depth.mjs", { env: { REVOY2_COMPLETION_DEPTH_DIR: dir } });
      expect(code).toBe(0);
    });
  });
});

describe("determinism-baseline gate — can it actually fail?", () => {
  const seam = (over) => JSON.stringify({
    id: "seam:test000000000000", roundtrip_path: "packages/x/tests/a.test.ts",
    measured_at: new Date().toISOString(), git_revision: HEAD, node_version: process.version,
    repeat_count: 10, pass_count: 10, fail_count: 0, flake_rate: 0,
    wall_clock_ms_median: 1, wall_clock_ms_spread_pct: 0, nondeterministic: false,
    ...over,
  });

  it("FAILS when a measured seam is above the flake ceiling", () => {
    const dir = fixture("det-flaky");
    writeFileSync(join(dir, "current.jsonl"),
      `${seam({ pass_count: 4, fail_count: 6, flake_rate: 0.6, nondeterministic: true })}\n`);
    const { code, out } = runGate("determinism-baseline.ts", { env: { REVOY2_DETERMINISM_DIR: dir } });
    expect(code).toBe(1);
    expect(out).toContain("DB-B");
  });

  it("FAILS when a cited seam has no baseline at all", () => {
    // Empty store, real repository: every cited roundtrip seam is unmeasured,
    // which is DB-R at a floor of 0 — i.e. the "a new citation must be measured"
    // rule, exercised through its real join against ROADMAP/ADR citations.
    const dir = fixture("det-empty");
    writeFileSync(join(dir, "current.jsonl"), "");
    const { code, out } = runGate("determinism-baseline.ts", { env: { REVOY2_DETERMINISM_DIR: dir } });
    expect(code).toBe(1);
    expect(out).toContain("DB-R");
  });
});

describe("claim-ledger gate — can it actually fail?", () => {
  it("FAILS when an empty store has a new docs-truth violation", () => {
    // This is the CL-A path: a claim absent from the store is NEW, and a new
    // claim that docs-truth reports as undischarged blocks. Inject one
    // line-bound violation into the actual docs-truth report shape; relying on
    // a repository marker to remain unvalidated made this test stop exercising
    // CL-A once that historical marker acquired proof text.
    const dir = fixture("cl-empty");
    writeFileSync(join(dir, "claims.jsonl"), "");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema_version: 1, scanned_up_to_revision: HEAD }));
    const roadmapLines = readFileSync(join(SNAPSHOT_DIR, "ROADMAP.md"), "utf8").split("\n");
    const violationLine = roadmapLines.findIndex((line) => /^#{2,6}\s/.test(line) && line.includes("✅"));
    expect(violationLine).toBeGreaterThanOrEqual(0);
    const docsTruthPath = join(dir, "docs-truth.json");
    writeFileSync(docsTruthPath, JSON.stringify({ ok: false, violations: [{
      line: violationLine + 1,
      tranche: roadmapLines[violationLine].replace(/^#+\s*/, "").trim(),
      reason: "fixture violation proving the CL-A path",
    }] }));
    const { code, out } = runGate("claim-ledger.ts", {
      env: { REVOY2_CLAIM_LEDGER_DIR: dir }, docsTruthPath,
    });
    expect(code).toBe(1);
    expect(out).toContain("CL-A:");
  });
});

describe("vi-findings gate — can it actually fail? (three violation modes in one fixture)", () => {
  const finding = (id, title) => ({
    id, severity: "medium", category: "hollow_candidate", title,
    claim: "x", affected_nodes: ["sym:a"], affected_edges: [], missing_edges: [],
    expected_model: "x", observed_model: "x", evidence: [], confidence: "medium",
    corroborating_heuristics: [], impact: "x", likely_cause: null,
    remediation: "x", validation_method: "x", adr_refs: ["ADR-042"], owner: null,
    found_at_revision: HEAD, status: "open", exception_id: null,
  });

  it("FAILS listing an untriaged finding, an expired row, and a hash-mismatched row together", () => {
    const dir = fixture("vi-findings-three-modes");
    const untriaged = finding("vi:0000000000000001", "hollow-candidate: 1 symbol(s) in a.ts");
    const expiredF = finding("vi:0000000000000002", "hollow-candidate: 1 symbol(s) in b.ts");
    const reopenedF = finding("vi:0000000000000003", "hollow-candidate: 1 symbol(s) in c.ts");
    writeFileSync(join(dir, "findings.jsonl"), [untriaged, expiredF, reopenedF].map((f) => JSON.stringify(f)).join("\n") + "\n");
    // untriaged: no row at all.
    // expired: valid row, but past its deadline.
    // hash-mismatched: valid row, but the finding's content has since changed.
    writeFileSync(join(dir, "triage.jsonl"), [
      { finding_id: "vi:0000000000000002", verdict: "accepted_tradeoff", reason: "x", first_seen: "abc", first_seen_date: "2020-01-01", triage_expires: "2020-01-31", content_hash: "will-not-be-checked-since-expiry-short-circuits" },
      { finding_id: "vi:0000000000000003", verdict: "false_positive", reason: "x", first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31", content_hash: "0000000000000000" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const { code, out } = runGate("vi-findings.mjs", { env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(1);
    expect(out).toContain("untriaged");
    expect(out).toContain("expired");
    expect(out).toContain("REOPENED");
  });
});

describe("the gates agree with themselves on a clean tree", () => {
  // The complement of the tests above. Both halves are needed: a gate that
  // always fails is as useless as one that never does.
  it.each([
    ["store-freshness-gate.mjs"],
    ["completion-depth.mjs"],
    ["determinism-baseline.ts"],
    ["claim-ledger.ts"],
  ])("%s exits 0 against the real, committed stores", (script) => {
    const { code, out } = runGate(script);
    expect(code, `${script} disagreed with its frozen committed inputs\n${out}`).toBe(0);
  });

  // vi-findings.mjs is deliberately NOT in the list above. Unlike the other
  // stores, ADR-042's baseline triage pass left findings genuinely untriaged
  // rather than bulk-stamping verdicts it could not evidence — "honesty over
  // green" per the baseline triage brief. This test locks in that the gate
  // still WORKS (mechanically consistent: every violation it reports really
  // is untriaged/expired/reopened in the real store) without asserting the
  // false claim that the store is fully triaged.
  it("vi-findings.mjs is mechanically consistent against the real, committed store (may legitimately be red)", () => {
    const { code, out } = runGate("vi-findings.mjs");
    expect([0, 1]).toContain(code);
    if (code === 1) {
      expect(out).toContain("finding(s) need a triage decision");
    } else {
      expect(out).toContain("PASS");
    }
  });
});
