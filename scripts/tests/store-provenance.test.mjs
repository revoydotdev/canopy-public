import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessEvidenceProvenance, changedInputPaths, computeEvidenceContentHash, computeEvidenceContentHashForStore, computeStoreDigest, hasRegenerationMarker, regenerationMarkerPath } from "../lib/store-provenance.mjs";
import { mergeJsonlTexts } from "../lib/union-sorted-jsonl-merge.mjs";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const temporary = [];

function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function initRepo() {
  const repo = temp("store-provenance-");
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.name", "Store Test");
  git(repo, "config", "user.email", "store@test.invalid");
  writeFileSync(join(repo, "input.txt"), "same bytes\n");
  git(repo, "add", "input.txt");
  git(repo, "commit", "-q", "-m", "first identity");
  return repo;
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("evidence content provenance", () => {
  it("survives a changed commit identity and changes when an input byte changes", () => {
    const repo = initRepo();
    const firstCommit = git(repo, "rev-parse", "HEAD");
    const firstHash = computeEvidenceContentHash(repo);
    git(repo, "commit", "--amend", "-q", "-m", "different identity");
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(firstCommit);
    expect(computeEvidenceContentHash(repo)).toBe(firstHash);
    writeFileSync(join(repo, "input.txt"), "different bytes\n");
    expect(computeEvidenceContentHash(repo)).not.toBe(firstHash);
  });

  it("refuses a non-ancestor revision and rejects mismatching content, even when content matches", () => {
    const repo = initRepo();
    const old = git(repo, "rev-parse", "HEAD");
    const hash = computeEvidenceContentHash(repo);
    git(repo, "checkout", "--orphan", "replacement");
    git(repo, "rm", "-q", "--cached", "input.txt");
    git(repo, "add", "input.txt");
    git(repo, "commit", "-q", "-m", "same content, unrelated history");
    const head = git(repo, "rev-parse", "HEAD");
    // A revision on an unmerged branch makes the store's distance UNDEFINED.
    // This used to read `state: "ok"` with the problem parked in a prose
    // `advisory` ("not an ancestor of HEAD (content still matches)") — which is
    // `scripts/vi-freshness-gate.mjs` refusing the same invariant two files
    // away. Distance is not the point here; the point is that an unresolvable
    // coordinate is not a passing coordinate.
    const matching = assessEvidenceProvenance({ repo, manifest: { scanned_up_to_revision: old, content_hash: hash }, currentContentHash: hash, head, refresh: "refresh" });
    expect(matching.state).toBe("fail");
    expect(matching.detail).toContain("not an ancestor");
    const mismatch = assessEvidenceProvenance({ repo, manifest: { scanned_up_to_revision: head, content_hash: "sha256:deadbeef" }, currentContentHash: hash, head, refresh: "refresh" });
    expect(mismatch.state).toBe("fail");
    expect(mismatch.detail).toContain("content hash differs");
  });

  it("refuses a revision that is not a commit and a manifest that records no revision at all", () => {
    // `scanned_up_to_revision: "0000…0001"` used to return `state: "ok"` with
    // `detail: "content hash matches; recorded revision is unavailable"`.
    const repo = initRepo();
    const head = git(repo, "rev-parse", "HEAD");
    const hash = computeEvidenceContentHash(repo);
    const notACommit = assessEvidenceProvenance({ repo, manifest: { scanned_up_to_revision: "0".repeat(39) + "1", content_hash: hash }, currentContentHash: hash, head });
    expect(notACommit.state).toBe("fail");
    expect(notACommit.detail).toContain("not a commit");
    const noRevision = assessEvidenceProvenance({ repo, manifest: { content_hash: hash }, currentContentHash: hash, head });
    expect(noRevision.state).toBe("fail");
    expect(noRevision.detail).toContain("UNMEASURED, not zero");
  });

  it("skips a tracked path that is a directory on disk instead of crashing with EISDIR", () => {
    // The exact trip: a submodule gitlink (mode 160000) checks out to a
    // directory at its tracked path, and a tracked file can be replaced
    // in-place by a directory without ever being staged. `existsSync` is
    // true for a directory too, so the prior missing-file guard alone did
    // not catch this — readFileSync on a directory threw EISDIR and crashed
    // the whole hash (and, downstream, store-freshness-gate.mjs --json).
    const repo = initRepo();
    const before = computeEvidenceContentHash(repo);
    rmSync(join(repo, "input.txt"));
    mkdirSync(join(repo, "input.txt"));
    writeFileSync(join(repo, "input.txt", "nested.txt"), "nested bytes\n");
    expect(() => computeEvidenceContentHash(repo)).not.toThrow();
    // The directory contributes no bytes, same as a missing path — content
    // identity moves away from the original file's hash.
    expect(computeEvidenceContentHash(repo)).not.toBe(before);
  });

  it("treats every regeneration marker as blocking, including malformed and dead-owner records", () => {
    const repo = initRepo();
    const marker = regenerationMarkerPath(repo);
    writeFileSync(marker, "not json\n");
    expect(hasRegenerationMarker(repo)).toBe(true);
    writeFileSync(marker, `${JSON.stringify({ pid: 999_999_999, phase: "producing" })}\n`);
    expect(hasRegenerationMarker(repo)).toBe(true);

    const result = assessEvidenceProvenance({
      repo,
      manifest: { scanned_up_to_revision: git(repo, "rev-parse", "HEAD"), content_hash: "sha256:old" },
      currentContentHash: computeEvidenceContentHash(repo),
      head: git(repo, "rev-parse", "HEAD"),
      regenerationInFlight: true,
      refresh: "refresh",
    });
    expect(result.state).toBe("fail");
    expect(result.detail).toContain("evidence is unavailable");
  });
});

describe("changedInputPaths and the single-command remedy", () => {
  function initScopedRepo() {
    const repo = temp("store-provenance-scope-");
    git(repo, "init", "-q", "-b", "master");
    git(repo, "config", "user.name", "Store Test");
    git(repo, "config", "user.email", "store@test.invalid");
    mkdirSync(join(repo, "packages/x/src"), { recursive: true });
    writeFileSync(join(repo, "packages/x/src/y.ts"), "export const y = 1;\n");
    writeFileSync(join(repo, "README.md"), "outside every store's scope\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "seed");
    return repo;
  }

  it("names the dirty in-scope path, not an out-of-scope one", () => {
    const repo = initScopedRepo();
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "packages/x/src/y.ts"), "export const y = 2;\n");
    writeFileSync(join(repo, "README.md"), "changed but out of completion-depth's scope\n");
    const changed = changedInputPaths(repo, "completion-depth", head);
    expect(changed).toContain("packages/x/src/y.ts");
    expect(changed).not.toContain("README.md");
  });

  it("names a path committed since the manifest's recorded revision", () => {
    const repo = initScopedRepo();
    const oldRevision = git(repo, "rev-parse", "HEAD");
    mkdirSync(join(repo, "packages/x/src"), { recursive: true });
    writeFileSync(join(repo, "packages/x/src/z.ts"), "export const z = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "add z");
    const changed = changedInputPaths(repo, "completion-depth", oldRevision);
    expect(changed).toContain("packages/x/src/z.ts");
  });

  it("assessEvidenceProvenance surfaces changed_paths and exactly one remedy command on a mismatch", () => {
    const repo = initScopedRepo();
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "packages/x/src/y.ts"), "export const y = 2;\n");
    const result = assessEvidenceProvenance({
      repo,
      manifest: { scanned_up_to_revision: head, content_hash: "sha256:stale" },
      currentContentHash: computeEvidenceContentHashForStore(repo, "completion-depth"),
      head,
      storeName: "completion-depth",
    });
    expect(result.state).toBe("fail");
    expect(result.changed_paths).toContain("packages/x/src/y.ts");
    expect(result.detail).toContain("packages/x/src/y.ts");
    expect(result.detail).toContain("arbor evidence refresh --scope auto");
    // Exactly the single remedy command — no bare per-store script fallback.
    expect(result.detail).not.toMatch(/bun run completion-depth:refresh/);
  });
});

describe("the store's OWN bytes (defect B)", () => {
  /** A repo whose claim-ledger inputs are committed and whose store carries a manifest with a real digest. */
  function initStoreRepo() {
    const repo = initRepo();
    mkdirSync(join(repo, "decisions"), { recursive: true });
    mkdirSync(join(repo, "packages/x/src"), { recursive: true });
    writeFileSync(join(repo, "decisions/ADR-001-x.md"), "**Status:** accepted\n");
    writeFileSync(join(repo, "packages/x/src/y.ts"), "export const y = 1;\n");
    writeFileSync(join(repo, "ROADMAP.md"), "# roadmap\n");
    writeFileSync(join(repo, "scripts-placeholder.txt"), "");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "store inputs");
    mkdirSync(join(repo, ".claim-ledger"), { recursive: true });
    writeFileSync(join(repo, ".claim-ledger/claims.jsonl"), '{"id":"a","claim_text":"one"}\n');
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, ".claim-ledger/manifest.json"), JSON.stringify({
      scanned_up_to_revision: head,
      content_hash: computeEvidenceContentHashForStore(repo, "claim-ledger"),
      store_digest: computeStoreDigest(join(repo, ".claim-ledger")),
    }));
    return { repo, head };
  }

  it("detects fabrication of the store's own bytes while its INPUTS still hash identically", () => {
    // The exact oracle: `content_hash` covers decisions/, ROADMAP.md and
    // packages/*/src — never `.claim-ledger/` itself. So flipping claim_text
    // on every row left the gate reading "content hash matches; 0 commit(s)
    // behind HEAD" — a store whose every byte was invented, reported as fully
    // measured.
    const { repo, head } = initStoreRepo();
    const before = assessEvidenceProvenance({
      repo, manifest: JSON.parse(readFileSync(join(repo, ".claim-ledger/manifest.json"), "utf8")),
      currentContentHash: computeEvidenceContentHashForStore(repo, "claim-ledger"),
      head, storeName: "claim-ledger",
    });
    expect(before.state).toBe("ok");
    expect(before.store_bytes).toBe("measured");

    const rows = readFileSync(join(repo, ".claim-ledger/claims.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.stringify({ ...JSON.parse(line), claim_text: "fabricated" }));
    writeFileSync(join(repo, ".claim-ledger/claims.jsonl"), `${rows.join("\n")}\n`);

    const after = assessEvidenceProvenance({
      repo, manifest: JSON.parse(readFileSync(join(repo, ".claim-ledger/manifest.json"), "utf8")),
      currentContentHash: computeEvidenceContentHashForStore(repo, "claim-ledger"),
      head, storeName: "claim-ledger",
    });
    // Inputs are provably untouched — that is what made this invisible.
    expect(computeEvidenceContentHashForStore(repo, "claim-ledger")).toBe(before.content_hash);
    expect(after.state).toBe("fail");
    expect(after.store_bytes).toBe("mismatched");
    expect(after.detail).toContain("do not match the digest its own manifest records");
  });

  it("detects truncation, not only rewording", () => {
    const { repo, head } = initStoreRepo();
    writeFileSync(join(repo, ".claim-ledger/claims.jsonl"), "");
    const result = assessEvidenceProvenance({
      repo, manifest: JSON.parse(readFileSync(join(repo, ".claim-ledger/manifest.json"), "utf8")),
      currentContentHash: computeEvidenceContentHashForStore(repo, "claim-ledger"),
      head, storeName: "claim-ledger",
    });
    expect(result.state).toBe("fail");
    expect(result.detail).toContain("do not match the digest");
  });

  it("never reports a store with no digest of its own bytes as measured", () => {
    // The other three producers do not write `store_digest` yet. This does NOT
    // fail them — a red this gate cannot honestly clear on their behalf would be
    // its own kind of lie — but it must never read as though it had verified
    // bytes nothing verified. The fact travels as `store_bytes` data and as a
    // clause in `detail`, so no `--json` consumer can read `content hash
    // matches` as covering the store itself.
    const repo = initRepo();
    const head = git(repo, "rev-parse", "HEAD");
    const hash = computeEvidenceContentHash(repo);
    const result = assessEvidenceProvenance({ repo, manifest: { scanned_up_to_revision: head, content_hash: hash }, currentContentHash: hash, head, storeName: "claim-ledger" });
    expect(result.state).toBe("ok");
    expect(result.store_bytes).toBe("unmeasured");
    expect(result.detail).toContain("the store's own bytes are UNMEASURED");
  });

  it("excludes the manifest from its own digest, so a store can carry a digest of itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-digest-"));
    temporary.push(dir);
    writeFileSync(join(dir, "claims.jsonl"), '{"id":"a"}\n');
    const before = computeStoreDigest(dir);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ store_digest: before }));
    expect(computeStoreDigest(dir)).toBe(before);
    // Every other file in the store is covered.
    writeFileSync(join(dir, "claim-guard.sh"), "# hook\n");
    expect(computeStoreDigest(dir)).not.toBe(before);
  });
});

describe("union-sorted JSONL merge", () => {
  it("preserves both branches, sorts by ID, and deduplicates identical records", () => {
    const a = '{"id":"b","value":2}\n{"id":"shared","value":3}\n';
    const b = '{"id":"a","value":1}\n{"id":"shared","value":3}\n';
    expect(mergeJsonlTexts([a, b])).toBe('{"id":"a","value":1}\n{"id":"b","value":2}\n{"id":"shared","value":3}\n');
  });

  it("refuses a same-ID semantic conflict", () => {
    expect(() => mergeJsonlTexts(['{"id":"same","value":1}\n', '{"id":"same","value":2}\n'])).toThrow(/semantic JSONL conflict/);
  });

  it("satisfies the real git merge-driver contract on the claim-ledger path", () => {
    const repo = initRepo();
    mkdirSync(join(repo, ".claim-ledger"));
    writeFileSync(join(repo, ".gitattributes"), ".claim-ledger/*.jsonl merge=union-sorted-jsonl\n");
    writeFileSync(join(repo, ".claim-ledger/claims.jsonl"), '{"id":"base"}\n');
    git(repo, "add", ".gitattributes", ".claim-ledger");
    git(repo, "commit", "-q", "-m", "store base");
    git(repo, "config", "merge.union-sorted-jsonl.driver", `bun ${join(REPO_ROOT, "scripts/lib/union-sorted-jsonl-merge.mjs")} %O %A %B`);
    git(repo, "checkout", "-q", "-b", "left");
    writeFileSync(join(repo, ".claim-ledger/claims.jsonl"), '{"id":"base"}\n{"id":"left"}\n');
    git(repo, "commit", "-qam", "left record");
    git(repo, "checkout", "-q", "master");
    writeFileSync(join(repo, ".claim-ledger/claims.jsonl"), '{"id":"base"}\n{"id":"right"}\n');
    git(repo, "commit", "-qam", "right record");
    git(repo, "merge", "-q", "left");
    expect(readFileSync(join(repo, ".claim-ledger/claims.jsonl"), "utf8")).toBe('{"id":"base"}\n{"id":"left"}\n{"id":"right"}\n');
  });
});
