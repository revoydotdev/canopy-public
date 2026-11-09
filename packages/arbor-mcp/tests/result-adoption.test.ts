import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptCapturedResult, authorizeScopeExpansion, bestVerifiedResult, captureWorktreeResult, composeCapturedResults, inspectCapturedResult, listCapturedResults, readCapturedComposition, readScopeExpansion, readScopeExpansionAuthorization, revertCapturedResult } from "../src/result-adoption.js";
import { validateResultReviewQuery } from "../src/result-review-contracts.js";

const TMP: string[] = [];
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arbor-adopt-"));
  TMP.push(dir);
  const g = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  return dir;
}
afterEach(() => { for (const dir of TMP.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("adopt-result capture and application", () => {
  it("captures a worktree's new and modified files as an applicable patch, or null when nothing changed", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const clean = repo();
    expect(captureWorktreeResult({ campaign_id: "c1", node_id: "n0", worktree_path: clean, verified: true, score: 1, persistence_dir: persistence, now: () => "T" })).toBeNull();

    const wt = repo();
    writeFileSync(join(wt, "docs.md"), "# new doc\n"); // untracked new file
    writeFileSync(join(wt, "seed.txt"), "seed\nmodified\n"); // modified tracked file
    const captured = captureWorktreeResult({ campaign_id: "c1", node_id: "n1", worktree_path: wt, verified: true, score: 0.9, persistence_dir: persistence, now: () => "T" });
    expect(captured).not.toBeNull();
    expect([...captured!.files].sort()).toEqual(["docs.md", "seed.txt"]);
    expect(captured!.verified).toBe(true);
    expect(captured!.patch_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies a captured verified result to a separate clean tree, creating the new file", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo();
    mkdirSync(join(wt, "docs"), { recursive: true });
    writeFileSync(join(wt, "docs", "native-doctor.md"), "# doctor\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "n1", worktree_path: wt, verified: true, score: 0.9, persistence_dir: persistence, now: () => "T" });

    const target = repo();
    expect(existsSync(join(target, "docs", "native-doctor.md"))).toBe(false);
    const preview = adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: target, check_only: true });
    expect(preview).toMatchObject({ ok: true });
    // Preview mutated nothing.
    expect(existsSync(join(target, "docs", "native-doctor.md"))).toBe(false);

    const applied = adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: target });
    expect(applied).toMatchObject({ ok: true, applied: true, node_id: "n1" });
    expect(readFileSync(join(target, "docs", "native-doctor.md"), "utf8")).toBe("# doctor\n");
  });

  it("downgrades and refuses a verified capture when its patch exceeds the declared write scope", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo();
    mkdirSync(join(wt, "apps", "worker"), { recursive: true });
    writeFileSync(join(wt, "apps", "worker", "package.json"), "{}\n");
    writeFileSync(join(wt, "package.json"), "{}\n");
    const captured = captureWorktreeResult({
      campaign_id: "c1", node_id: "n-scope", worktree_path: wt, verified: true, score: 1,
      declared_write_paths: ["apps/worker/package.json"], persistence_dir: persistence, now: () => "T",
    });
    expect(captured).toMatchObject({
      verified: false,
      declared_write_paths: ["apps/worker/package.json"],
      scope_violations: ["package.json"],
    });
    expect(adoptCapturedResult({ campaign_id: "c1", node_id: "n-scope", persistence_dir: persistence, target_root: repo() }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("exceed its declared write scope: package.json") });
  });

  it("refuses to apply a patch that conflicts, never force-applying over a divergent tree", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo();
    writeFileSync(join(wt, "seed.txt"), "seed\nfrom-worktree\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "n1", worktree_path: wt, verified: true, score: 1, persistence_dir: persistence, now: () => "T" });

    const target = repo();
    writeFileSync(join(target, "seed.txt"), "seed\nlocally-diverged\n"); // conflicting local change
    spawnSync("git", ["add", "-A"], { cwd: target }); spawnSync("git", ["commit", "-qm", "diverge"], { cwd: target });
    const outcome = adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: target });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("does not apply cleanly");
  });

  it("ranks verified captures ahead of unverified and returns the best verified one", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const mk = (node: string, verified: boolean, score: number) => {
      const wt = repo(); writeFileSync(join(wt, `${node}.txt`), `${node}\n`);
      captureWorktreeResult({ campaign_id: "c1", node_id: node, worktree_path: wt, verified, score, persistence_dir: persistence, now: () => "T" });
    };
    mk("low-verified", true, 0.3);
    mk("high-unverified", false, 0.99);
    mk("high-verified", true, 0.8);
    expect(listCapturedResults(persistence, "c1")[0]!.node_id).toBe("high-verified");
    expect(bestVerifiedResult(persistence, "c1")!.node_id).toBe("high-verified");
    expect(adoptCapturedResult({ campaign_id: "c1", node_id: "high-unverified", persistence_dir: persistence, target_root: repo() })).toMatchObject({ ok: false, reason: expect.stringContaining("not verified") });
  });

  // The capture store keeps several sibling record kinds per node, all
  // suffixed `.json` (`<node>.json` for the capture itself, but also
  // `<node>.composition.json`, `<node>.scope-expansion.json`, and
  // `<node>.scope-authorization.json`). `listCapturedResults` must return
  // ONLY genuine captures — a composition/authorization record sharing the
  // same `schema_version: 1` and `node_id` shape must never be mistaken for
  // one (it lacks `files`/`patch_sha256`, so callers that trust the listing
  // — e.g. rendering `c.files.join(", ")` — would corrupt output or crash).
  it("never returns a sibling composition/authorization record as a captured result", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo(); writeFileSync(join(wt, "real.txt"), "real capture\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "genuine", worktree_path: wt, verified: true, score: 1, persistence_dir: persistence, now: () => "T" });

    // A composition manifest for a DIFFERENT node id (`verify`), which shares
    // this campaign's store and also ends in `.json`.
    expect(composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "verify", worktree_path: repo(), source_node_ids: ["genuine"] }).ok).toBe(true);

    const results = listCapturedResults(persistence, "c1");
    expect(results.map((record) => record.node_id)).toEqual(["genuine"]);
    for (const record of results) {
      expect(typeof record.patch_sha256).toBe("string");
      expect(Array.isArray(record.files)).toBe(true);
    }
  });

  it("rejects tampered patches and traversal identities", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo(); writeFileSync(join(wt, "change.txt"), "safe\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "n1", worktree_path: wt, verified: true, score: 1, persistence_dir: persistence, now: () => "T" });
    writeFileSync(join(persistence, "adopt", "c1", "n1.patch"), "tampered\n");
    expect(adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: repo() })).toMatchObject({ ok: false, reason: expect.stringContaining("integrity") });
    expect(adoptCapturedResult({ campaign_id: "../escape", node_id: "n1", persistence_dir: persistence, target_root: repo() })).toMatchObject({ ok: false, reason: expect.stringContaining("safe path segment") });
  });

  it("refuses adoption when the confirmed inspection hash is stale", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo(); writeFileSync(join(wt, "change.txt"), "safe\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "n1", worktree_path: wt, verified: true, score: 1, persistence_dir: persistence, now: () => "T" });
    expect(adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: repo(), expected_patch_sha256: "0".repeat(64) }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("changed since it was inspected") });
  });

  it("adopts only an exact selected subset of the captured manifest", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo(); writeFileSync(join(wt, "one.txt"), "one\n"); writeFileSync(join(wt, "two.txt"), "two\n");
    const capture = captureWorktreeResult({ campaign_id: "c1", node_id: "n1", worktree_path: wt, verified: true, score: 1, persistence_dir: persistence, now: () => "T" })!;
    const target = repo();
    expect(adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: target, expected_patch_sha256: capture.patch_sha256, files: ["one.txt"] }))
      .toMatchObject({ ok: true, files: ["one.txt"] });
    expect(existsSync(join(target, "one.txt"))).toBe(true);
    expect(existsSync(join(target, "two.txt"))).toBe(false);
    expect(adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: repo(), files: ["missing.txt"] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("subset") });
  });

  it("inspects a bounded patch only after verifying its durable identity", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo(); writeFileSync(join(wt, "change.txt"), "safe review content\n");
    const captured = captureWorktreeResult({ campaign_id: "c1", node_id: "n1", worktree_path: wt, verified: true, score: 1, persistence_dir: persistence, now: () => "T" })!;
    const inspection = inspectCapturedResult({ persistence_dir: persistence, campaign_id: "c1", node_id: "n1", max_patch_bytes: 24 });
    expect(inspection.record).toEqual(captured);
    expect(inspection.patch).toMatchObject({ truncated: true, sha256: captured.patch_sha256 });
    expect(Buffer.byteLength(inspection.patch.content, "utf8")).toBeLessThanOrEqual(24);
  });

  it("reverts an adopted subset only while the workspace still matches", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo(); writeFileSync(join(wt, "one.txt"), "one\n"); writeFileSync(join(wt, "two.txt"), "two\n");
    const capture = captureWorktreeResult({ campaign_id: "c1", node_id: "n1", worktree_path: wt, verified: true, score: 1, persistence_dir: persistence, now: () => "T" })!;
    const target = repo();
    expect(adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: target, expected_patch_sha256: capture.patch_sha256, files: ["one.txt"] }).ok).toBe(true);
    expect(revertCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: target, expected_patch_sha256: capture.patch_sha256, files: ["one.txt"] })).toMatchObject({ ok: true, reverted: true, files: ["one.txt"] });
    expect(existsSync(join(target, "one.txt"))).toBe(false);
    const divergent = repo();
    expect(adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: divergent, expected_patch_sha256: capture.patch_sha256, files: ["one.txt"] }).ok).toBe(true);
    writeFileSync(join(divergent, "one.txt"), "operator edit\n");
    expect(revertCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: divergent, expected_patch_sha256: capture.patch_sha256, files: ["one.txt"] })).toMatchObject({ ok: false, reason: expect.stringContaining("cannot be reverted cleanly") });
  });

  // Selective-file adoption turns each selected path into a `--include=`
  // glob for `git apply`. A path containing a literal glob metacharacter
  // (`[`, `*`, `?`) must select EXACTLY that file, not accidentally match a
  // sibling file (wrong-target) or fail to match its own escaped self.
  it("selects an exact file subset even when a captured filename contains glob metacharacters", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo();
    writeFileSync(join(wt, "release[v1].txt"), "bracketed\n");
    writeFileSync(join(wt, "releaseXv1Y.txt"), "not selected\n"); // would match `release[v1].txt` as an UNESCAPED glob
    const capture = captureWorktreeResult({ campaign_id: "c1", node_id: "n1", worktree_path: wt, verified: true, score: 1, persistence_dir: persistence, now: () => "T" })!;
    expect([...capture.files].sort()).toEqual(["releaseXv1Y.txt", "release[v1].txt"]);

    const target = repo();
    const applied = adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: target, expected_patch_sha256: capture.patch_sha256, files: ["release[v1].txt"] });
    expect(applied).toMatchObject({ ok: true, applied: true, files: ["release[v1].txt"] });
    expect(existsSync(join(target, "release[v1].txt"))).toBe(true);
    expect(existsSync(join(target, "releaseXv1Y.txt"))).toBe(false); // the sibling must NOT have been pulled in
  });

  // Idempotency/replay: a duplicate dispatch of the exact same adopt (or
  // revert) command must never double-write or corrupt the target tree. This
  // is not something `adoptCapturedResult` tracks explicitly (there is no
  // "already applied" ledger) — it relies entirely on `git apply --check`
  // naturally refusing a patch whose context no longer matches once it has
  // already been applied. Assert that fail-closed property directly, for
  // both adopt and revert, so a future change to the apply/check ordering
  // cannot silently reopen a double-apply path.
  it("replaying an identical adopt (or revert) after it already succeeded fails closed rather than double-applying", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo(); writeFileSync(join(wt, "once.txt"), "applied once\n");
    const capture = captureWorktreeResult({ campaign_id: "c1", node_id: "n1", worktree_path: wt, verified: true, score: 1, persistence_dir: persistence, now: () => "T" })!;
    const target = repo();
    const first = adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: target, expected_patch_sha256: capture.patch_sha256 });
    expect(first).toMatchObject({ ok: true, applied: true });
    expect(readFileSync(join(target, "once.txt"), "utf8")).toBe("applied once\n");

    // Replay: same command, same target, nothing in between. Must refuse,
    // not reapply (which would be a no-op here but corrupt on any patch
    // whose hunks are not purely additive).
    const replay = adoptCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: target, expected_patch_sha256: capture.patch_sha256 });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toContain("does not apply cleanly");
    expect(readFileSync(join(target, "once.txt"), "utf8")).toBe("applied once\n"); // unchanged, not doubled

    const reverted = revertCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: target, expected_patch_sha256: capture.patch_sha256 });
    expect(reverted).toMatchObject({ ok: true, reverted: true });
    expect(existsSync(join(target, "once.txt"))).toBe(false);

    // Replaying the revert must likewise fail closed, not error further.
    const revertReplay = revertCapturedResult({ campaign_id: "c1", node_id: "n1", persistence_dir: persistence, target_root: target, expected_patch_sha256: capture.patch_sha256 });
    expect(revertReplay.ok).toBe(false);
    if (!revertReplay.ok) expect(revertReplay.reason).toContain("cannot be reverted cleanly");
    expect(existsSync(join(target, "once.txt"))).toBe(false);
  });

  it("composes ordered unverified source captures and records inherited content identities", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const first = repo(); writeFileSync(join(first, "seed.txt"), "seed\nfirst\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "implement", worktree_path: first, verified: false, score: 1, persistence_dir: persistence, now: () => "T" });
    const second = repo(); writeFileSync(join(second, "test.txt"), "test\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "tests", worktree_path: second, verified: false, score: 1, persistence_dir: persistence, now: () => "T" });
    const verifier = repo();
    const outcome = composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "verify", worktree_path: verifier, source_node_ids: ["implement", "tests"] });
    expect(outcome).toMatchObject({ ok: true, record: { source_node_ids: ["implement", "tests"], files: ["seed.txt", "test.txt"] } });
    expect(readFileSync(join(verifier, "seed.txt"), "utf8")).toBe("seed\nfirst\n");
    expect(readFileSync(join(verifier, "test.txt"), "utf8")).toBe("test\n");
    const manifest = readCapturedComposition(persistence, "c1", "verify");
    expect(manifest?.baseline_hashes["seed.txt"]).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest?.baseline_hashes["test.txt"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reduces transitive cumulative captures to maximal descendants before composition", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const implementation = repo(); writeFileSync(join(implementation, "implementation.txt"), "implemented\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "implement", worktree_path: implementation, verified: false, score: 1, persistence_dir: persistence, now: () => "T" });

    const tests = repo();
    expect(composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "tests", worktree_path: tests, source_node_ids: ["implement"] }).ok).toBe(true);
    writeFileSync(join(tests, "tests.txt"), "tests\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "tests", worktree_path: tests, verified: false, score: 1, declared_write_paths: ["implementation.txt", "tests.txt"], persistence_dir: persistence, now: () => "T" });

    const verifier = repo();
    const outcome = composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "verify", worktree_path: verifier, source_node_ids: ["implement", "tests"] });
    expect(outcome).toMatchObject({ ok: true, record: { source_node_ids: ["tests"], files: ["implementation.txt", "tests.txt"] } });
    expect(readFileSync(join(verifier, "implementation.txt"), "utf8")).toBe("implemented\n");
    expect(readFileSync(join(verifier, "tests.txt"), "utf8")).toBe("tests\n");
  });

  it("omits only explicitly declared empty workspace sources", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const verifier = repo();
    expect(composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "verify", worktree_path: verifier, source_node_ids: ["discovery"], empty_source_node_ids: ["discovery"] }))
      .toMatchObject({ ok: true, record: { source_node_ids: [], files: [] } });
    expect(composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "verify-strict", worktree_path: repo(), source_node_ids: ["missing"] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("missing") });
    expect(composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "verify-invalid", worktree_path: repo(), source_node_ids: ["one"], empty_source_node_ids: ["other"] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("requested source IDs") });
  });

  // A composition whose union of source files exceeds MAX_COMPOSITION_FILES
  // must fail WITHOUT mutating the verifier worktree. The bound existed but
  // was checked only after every source patch had already been `git apply
  // --index`-ed into `worktree_path` — a rejected composition (`ok: false`)
  // left the worktree fully mutated and staged, silently, with no manifest
  // recorded to explain why. A caller trusting `ok: false` to mean "nothing
  // changed" would reuse or discard that worktree believing it was still
  // clean.
  it("refuses an over-bound composition WITHOUT applying any source patch to the verifier worktree", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const big = repo();
    for (let i = 0; i < 512; i++) writeFileSync(join(big, `f${String(i).padStart(4, "0")}.txt`), `${i}\n`);
    captureWorktreeResult({ campaign_id: "c1", node_id: "big", worktree_path: big, verified: false, score: 1, persistence_dir: persistence, now: () => "T" });
    const extra = repo();
    writeFileSync(join(extra, "one-more.txt"), "one more\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "extra", worktree_path: extra, verified: false, score: 1, persistence_dir: persistence, now: () => "T" });

    const verifier = repo();
    const outcome = composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "verify-over-bound", worktree_path: verifier, source_node_ids: ["big", "extra"] });
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("too many paths") });
    // The worktree must remain exactly as it started: no source file materialized.
    expect(existsSync(join(verifier, "f0000.txt"))).toBe(false);
    expect(existsSync(join(verifier, "one-more.txt"))).toBe(false);
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: verifier, encoding: "utf-8" });
    expect(status.stdout.trim()).toBe("");
    expect(readCapturedComposition(persistence, "c1", "verify-over-bound")).toBeNull();
  });

  it("fails closed for missing, scoped, tampered, or conflicting source captures", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const target = repo();
    expect(composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "verify", worktree_path: target, source_node_ids: ["missing"] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("missing") });

    const scoped = repo(); writeFileSync(join(scoped, "out-of-scope.txt"), "no\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "scoped", worktree_path: scoped, verified: false, score: 1, declared_write_paths: ["allowed.txt"], persistence_dir: persistence, now: () => "T" });
    expect(composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "verify-scoped", worktree_path: repo(), source_node_ids: ["scoped"] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("invalid metadata") });

    const tampered = repo(); writeFileSync(join(tampered, "safe.txt"), "safe\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "tampered", worktree_path: tampered, verified: false, score: 1, persistence_dir: persistence, now: () => "T" });
    writeFileSync(join(persistence, "adopt", "c1", "tampered.patch"), "tampered\n");
    expect(composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "verify-tampered", worktree_path: repo(), source_node_ids: ["tampered"] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("integrity") });

    const conflict = repo(); writeFileSync(join(conflict, "seed.txt"), "seed\nsource\n");
    captureWorktreeResult({ campaign_id: "c1", node_id: "conflict", worktree_path: conflict, verified: false, score: 1, persistence_dir: persistence, now: () => "T" });
    const divergent = repo(); writeFileSync(join(divergent, "seed.txt"), "seed\ndivergent\n");
    spawnSync("git", ["add", "-A"], { cwd: divergent }); spawnSync("git", ["commit", "-qm", "diverge"], { cwd: divergent });
    expect(composeCapturedResults({ persistence_dir: persistence, campaign_id: "c1", node_id: "verify-conflict", worktree_path: divergent, source_node_ids: ["conflict"] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("does not apply cleanly") });
    expect(readCapturedComposition(persistence, "c1", "verify-conflict")).toBeNull();
  });

  // WA-67: a `verified_result` campaign (real command/critic verification
  // passed) is unadoptable because the arbiter's heuristically MINED write
  // scope under-declared it, with no legible reason and no path forward. The
  // refusal must name the out-of-scope files, cite the declared scope and its
  // (mined) provenance, and name the `--expand-scope` remedy — and that
  // remedy must actually work and leave a durable, readable-back record.
  it("names the out-of-scope files, declared scope, and remedy for a command-verified capture that exceeds a MINED scope, and lets --expand-scope adopt it with a durable record", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo();
    writeFileSync(join(wt, "lib.js"), "module.exports = {};\n");
    writeFileSync(join(wt, "test.js"), "require('./lib.js');\n");
    const captured = captureWorktreeResult({
      campaign_id: "c1", node_id: "n-mined", worktree_path: wt, verified: true, score: 1,
      declared_write_paths: ["test.js"], scope_provenance: "mined", persistence_dir: persistence, now: () => "T",
    })!;
    expect(captured).toMatchObject({
      verified: false, command_verified: true, scope_provenance: "mined",
      declared_write_paths: ["test.js"], scope_violations: ["lib.js"],
    });

    const target = repo();
    const refused = adoptCapturedResult({ campaign_id: "c1", node_id: "n-mined", persistence_dir: persistence, target_root: target });
    expect(refused).toMatchObject({
      ok: false,
      reason: expect.stringContaining("exceed its declared write scope: lib.js"),
    });
    if (!refused.ok) {
      expect(refused.reason).toContain("test.js"); // the declared scope itself
      expect(refused.reason).toContain("mined"); // provenance is legible
      expect(refused.reason).toContain("--expand-scope"); // the named remedy
    }
    expect(readScopeExpansion(persistence, "c1", "n-mined")).toBeNull();

    // The remedy requires the same digest-bound confirmation the ordinary
    // adopt path uses.
    expect(adoptCapturedResult({ campaign_id: "c1", node_id: "n-mined", persistence_dir: persistence, target_root: target, acknowledge_scope_expansion: true }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("expected_patch_sha256") });

    const expanded = adoptCapturedResult({
      campaign_id: "c1", node_id: "n-mined", persistence_dir: persistence, target_root: target,
      acknowledge_scope_expansion: true, expected_patch_sha256: captured.patch_sha256, acknowledged_by: "test-operator",
    });
    expect(expanded).toMatchObject({ ok: true, applied: true, files: expect.arrayContaining(["lib.js", "test.js"]) });
    expect(readFileSync(join(target, "lib.js"), "utf8")).toBe("module.exports = {};\n");

    const record = readScopeExpansion(persistence, "c1", "n-mined");
    expect(record).toMatchObject({
      campaign_id: "c1", node_id: "n-mined", patch_sha256: captured.patch_sha256,
      declared_write_paths: ["test.js"], acknowledged_paths: ["lib.js"],
      scope_provenance: "mined", acknowledged_by: "test-operator",
    });
  });

  // The standing default must not weaken: without --expand-scope, adoption
  // still refuses on the exact same capture.
  it("still refuses an unacknowledged mined-scope violation on repeat adoption attempts", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo();
    writeFileSync(join(wt, "lib.js"), "x\n");
    captureWorktreeResult({
      campaign_id: "c1", node_id: "n-mined", worktree_path: wt, verified: true, score: 1,
      declared_write_paths: ["test.js"], scope_provenance: "mined", persistence_dir: persistence, now: () => "T",
    });
    expect(adoptCapturedResult({ campaign_id: "c1", node_id: "n-mined", persistence_dir: persistence, target_root: repo() }).ok).toBe(false);
    expect(adoptCapturedResult({ campaign_id: "c1", node_id: "n-mined", persistence_dir: persistence, target_root: repo() }).ok).toBe(false);
  });

  it("requires a separately durable, hash-bound authorization before the preferred re-scope-and-adopt path applies", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo();
    writeFileSync(join(wt, "lib.js"), "x\n");
    const captured = captureWorktreeResult({
      campaign_id: "c1", node_id: "n-authorized", worktree_path: wt, verified: true, score: 1,
      declared_write_paths: ["test.js"], scope_provenance: "mined", persistence_dir: persistence, now: () => "T",
    })!;
    const target = repo();
    expect(adoptCapturedResult({
      campaign_id: "c1", node_id: "n-authorized", persistence_dir: persistence, target_root: target,
      expected_patch_sha256: captured.patch_sha256, scope_expansion_authorization_id: "scope-auth-1",
    })).toMatchObject({ ok: false, reason: expect.stringContaining("authorization is missing") });

    expect(authorizeScopeExpansion({
      campaign_id: "c1", node_id: "n-authorized", persistence_dir: persistence,
      expected_patch_sha256: captured.patch_sha256, authorization_id: "scope-auth-1",
      authorized_by: "operator-42", authorization_evidence_id: "scopedec_ledger_42", now: () => "T",
    })).toMatchObject({ ok: true, authorization: { patch_sha256: captured.patch_sha256, authorized_paths: ["lib.js"] } });
    expect(readScopeExpansionAuthorization(persistence, "c1", "n-authorized")).toMatchObject({
      authorization_id: "scope-auth-1", authorization_evidence_id: "scopedec_ledger_42", authorized_by: "operator-42",
    });

    expect(adoptCapturedResult({
      campaign_id: "c1", node_id: "n-authorized", persistence_dir: persistence, target_root: target,
      expected_patch_sha256: captured.patch_sha256, scope_expansion_authorization_id: "scope-auth-1",
    })).toMatchObject({ ok: true, applied: true });
    expect(readScopeExpansion(persistence, "c1", "n-authorized")).toMatchObject({
      authorization_id: "scope-auth-1", authorization_evidence_id: "scopedec_ledger_42", acknowledged_by: "operator-42",
    });
  });

  // --expand-scope can never rescue a capture that genuinely failed
  // verification for a reason unrelated to scope (command_verified: false).
  it("refuses --expand-scope for a capture that was never command-verified, regardless of scope", () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-adopt-store-")); TMP.push(persistence);
    const wt = repo();
    writeFileSync(join(wt, "lib.js"), "x\n");
    const captured = captureWorktreeResult({
      campaign_id: "c1", node_id: "n-failed", worktree_path: wt, verified: false, score: 1,
      declared_write_paths: ["test.js"], scope_provenance: "mined", persistence_dir: persistence, now: () => "T",
    })!;
    expect(captured.command_verified).toBe(false);
    const outcome = adoptCapturedResult({
      campaign_id: "c1", node_id: "n-failed", persistence_dir: persistence, target_root: repo(),
      acknowledge_scope_expansion: true, expected_patch_sha256: captured.patch_sha256,
    });
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("exceed its declared write scope: lib.js") });
    expect(readScopeExpansion(persistence, "c1", "n-failed")).toBeNull();
  });

  it("validates campaign-scoped result review queries and their byte bound", () => {
    expect(validateResultReviewQuery({ schema_version: 1, query_id: "q1", query: { kind: "result.list", campaign_id: "c1" } }).ok).toBe(true);
    expect(validateResultReviewQuery({ schema_version: 1, query_id: "q2", query: { kind: "result.inspect", campaign_id: "c1", node_id: "n1", max_patch_bytes: 1_048_576 } }).ok).toBe(true);
    expect(validateResultReviewQuery({ schema_version: 1, query_id: "q3", query: { kind: "result.inspect", campaign_id: "../escape", node_id: "n1" } }).ok).toBe(false);
    expect(validateResultReviewQuery({ schema_version: 1, query_id: "q4", query: { kind: "result.inspect", campaign_id: "c1", node_id: "n1", max_patch_bytes: 1_048_577 } }).ok).toBe(false);
  });
});
