import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENERATED_EVIDENCE_PREFIXES,
  STORE_SCOPES,
  assessEvidenceProvenance,
  computeEvidenceContentHash,
  computeEvidenceContentHashForStore,
  evidenceInputPaths,
  evidenceInputPathsForStore,
  readGraphInputBinding,
} from "../lib/store-provenance.mjs";

const temporary = [];

function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** A fixture repo carrying one file from every store's scope, plus generated-only and irrelevant-prose files. */
function buildFixtureRepo() {
  const repo = temp("store-scope-");
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.name", "Store Scope Test");
  git(repo, "config", "user.email", "store-scope@test.invalid");

  mkdirSync(join(repo, "decisions"), { recursive: true });
  writeFileSync(join(repo, "decisions/ADR-001-example.md"), "**Status:** accepted\n");
  writeFileSync(join(repo, "ROADMAP.md"), "# roadmap\n");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs/notes.md"), "prose\n");
  writeFileSync(join(repo, "README.md"), "readme\n");
  writeFileSync(join(repo, "AGENTS.md"), "agents\n");

  mkdirSync(join(repo, "packages/arbor-mcp/src"), { recursive: true });
  writeFileSync(join(repo, "packages/arbor-mcp/src/index.ts"), "export const x = 1;\n");
  mkdirSync(join(repo, "packages/arbor-mcp/tests"), { recursive: true });
  writeFileSync(join(repo, "packages/arbor-mcp/tests/index.test.ts"), "// test\n");

  mkdirSync(join(repo, "scripts/observation"), { recursive: true });
  writeFileSync(join(repo, "scripts/observation/scenarios.json"), "{}\n");
  writeFileSync(join(repo, "scripts/claim-ledger.ts"), "// claim ledger\n");
  writeFileSync(join(repo, "scripts/completion-depth.mjs"), "// completion depth\n");
  writeFileSync(join(repo, "scripts/determinism-baseline.ts"), "// determinism\n");
  writeFileSync(join(repo, "scripts/vi-observe.mjs"), "// vi observe\n");
  writeFileSync(join(repo, "scripts/docs-truth.mjs"), "// docs truth\n");
  writeFileSync(join(repo, "scripts/reachability.mjs"), "// reachability\n");
  writeFileSync(join(repo, "scripts/unrelated-tool.mjs"), "// unrelated\n");

  mkdirSync(join(repo, ".visual-intelligence/graph"), { recursive: true });
  writeFileSync(join(repo, ".visual-intelligence/graph/nodes.jsonl"), "{}\n");
  mkdirSync(join(repo, ".visual-intelligence/findings"), { recursive: true });
  writeFileSync(join(repo, ".visual-intelligence/findings/triage.jsonl"), "{}\n");
  mkdirSync(join(repo, ".claim-ledger"), { recursive: true });
  writeFileSync(join(repo, ".claim-ledger/claims.jsonl"), "{}\n");

  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return repo;
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("a staged deletion does not crash the digest", () => {
  it("REGRESSION: a path git still lists but the tree no longer has is skipped, not read", () => {
    // `git ls-files -co` reports a deleted-but-uncommitted file because it is
    // still in the index. Reading it threw ENOENT, which crashed hashPaths
    // outright — so `store-freshness-gate.mjs --json` emitted a stack trace
    // instead of a report, and callers parsing it failed with "Unexpected
    // token" rather than anything naming the real cause. Surfaced by deleting
    // a tracked file during the taxonomy move; latent long before that, since
    // the original whole-repo hash had the identical unguarded read.
    const repo = mkdtempSync(join(tmpdir(), "store-deleted-path-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      writeFileSync(join(repo, "kept.ts"), "export const kept = 1;\n");
      writeFileSync(join(repo, "doomed.ts"), "export const doomed = 1;\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "seed"], { cwd: repo });

      const before = computeEvidenceContentHash(repo);
      rmSync(join(repo, "doomed.ts"));
      // git still lists it — this is the condition under test, asserted rather
      // than assumed, so the test cannot pass for the wrong reason.
      const listed = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" });
      expect(listed).toContain("doomed.ts");

      // Must not throw, and must genuinely differ: the file's bytes are gone.
      const after = computeEvidenceContentHash(repo);
      expect(after).not.toBe(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("STORE_SCOPES declares one scope per gated store", () => {
  it("has exactly the four gated stores, each a non-empty array", () => {
    expect(Object.keys(STORE_SCOPES).sort()).toEqual(
      ["claim-ledger", "completion-depth", "determinism-baseline", "vi-observed"].sort(),
    );
    for (const scope of Object.values(STORE_SCOPES)) {
      expect(Array.isArray(scope)).toBe(true);
      expect(scope.length).toBeGreaterThan(0);
    }
  });
});

describe("evidenceInputPathsForStore — scope isolation", () => {
  it("throws for an unknown store name rather than silently returning everything", () => {
    const repo = buildFixtureRepo();
    expect(() => evidenceInputPathsForStore(repo, "not-a-real-store")).toThrow(/no STORE_SCOPES entry/);
  });

  it("claim-ledger scope includes decisions/, ROADMAP.md, and packages/*/src, excludes prose outside its sources and generated dirs", () => {
    const repo = buildFixtureRepo();
    const paths = evidenceInputPathsForStore(repo, "claim-ledger");
    expect(paths).toContain("decisions/ADR-001-example.md");
    expect(paths).toContain("ROADMAP.md");
    expect(paths).toContain("packages/arbor-mcp/src/index.ts");
    expect(paths).toContain("scripts/claim-ledger.ts");
    expect(paths).toContain("scripts/docs-truth.mjs");
    expect(paths).toContain("scripts/reachability.mjs");
    // A symbol proof (`file=`/`symbol=`) resolves against src, not tests.
    expect(paths).not.toContain("packages/arbor-mcp/tests/index.test.ts");
    expect(paths).not.toContain("scripts/unrelated-tool.mjs");
    expect(paths).not.toContain(".visual-intelligence/graph/nodes.jsonl");
    expect(paths).not.toContain(".visual-intelligence/findings/triage.jsonl");
    expect(paths).not.toContain(".claim-ledger/claims.jsonl");
  });

  it("completion-depth scope walks the whole packages/ tree, tests included, and excludes scripts unrelated to it", () => {
    const repo = buildFixtureRepo();
    const paths = evidenceInputPathsForStore(repo, "completion-depth");
    expect(paths).toContain("packages/arbor-mcp/src/index.ts");
    expect(paths).toContain("packages/arbor-mcp/tests/index.test.ts");
    expect(paths).toContain("scripts/completion-depth.mjs");
    // ROADMAP.md and decisions/ are not read by completion-depth itself, but
    // they are inputs of the graph it reads (the intent extractor mints
    // `justifies` edges from them), so the graph's input closure carries them.
    expect(paths).toContain("ROADMAP.md");
    expect(paths).toContain("decisions/ADR-001-example.md");
    expect(paths).toContain("scripts/reachability.mjs");
    expect(paths).not.toContain("scripts/claim-ledger.ts");
    expect(paths).not.toContain("docs/notes.md");
    expect(paths).not.toContain(".visual-intelligence/graph/nodes.jsonl");
  });

  it("determinism-baseline scope is code-only: packages/ and scripts/, no prose", () => {
    const repo = buildFixtureRepo();
    const paths = evidenceInputPathsForStore(repo, "determinism-baseline");
    expect(paths).toContain("packages/arbor-mcp/src/index.ts");
    expect(paths).toContain("packages/arbor-mcp/tests/index.test.ts");
    expect(paths).toContain("scripts/claim-ledger.ts");
    expect(paths).toContain("scripts/unrelated-tool.mjs");
    expect(paths).not.toContain("ROADMAP.md");
    expect(paths).not.toContain("decisions/ADR-001-example.md");
    expect(paths).not.toContain("docs/notes.md");
    expect(paths).not.toContain("README.md");
    expect(paths).not.toContain("AGENTS.md");
  });

  it("vi-observed depends on the graph through the graph's input closure, never through the graph's own bytes", () => {
    const repo = buildFixtureRepo();
    const paths = evidenceInputPathsForStore(repo, "vi-observed");
    expect(paths).toContain("packages/arbor-mcp/src/index.ts");
    expect(paths).toContain("scripts/observation/scenarios.json");
    expect(paths).toContain("scripts/vi-observe.mjs");
    expect(paths).toContain("decisions/ADR-001-example.md");
    expect(paths).toContain("ROADMAP.md");
    expect(paths).not.toContain(".visual-intelligence/graph/nodes.jsonl");
    expect(paths).not.toContain(".visual-intelligence/findings/triage.jsonl");
    expect(paths).not.toContain("docs/notes.md");
  });

  it("a graph store's hash is the same with no graph, a different graph, or a graph in another checkout", () => {
    // The graph is gitignored and revision-stamped: a fresh pre-push candidate
    // has none, and a rebuilt one differs in every record's provenance stamp.
    // Hashing those bytes made a store bound in one checkout unreproducible in
    // every other, so the push gate failed on a tree nothing had changed in.
    const repo = buildFixtureRepo();
    writeFileSync(join(repo, ".gitignore"), ".visual-intelligence/graph/\n");
    git(repo, "rm", "-q", "-r", "--cached", ".visual-intelligence/graph");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "ignore the graph");
    const clone = temp("store-scope-clone-");
    rmSync(clone, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", repo, clone]);
    expect(existsSync(join(clone, ".visual-intelligence/graph"))).toBe(false);
    for (const store of ["completion-depth", "vi-observed"]) {
      const withGraph = computeEvidenceContentHashForStore(repo, store);
      writeFileSync(join(repo, ".visual-intelligence/graph/nodes.jsonl"), '{"id":"rebuilt","first_seen":"other-revision"}\n');
      expect(computeEvidenceContentHashForStore(repo, store)).toBe(withGraph);
      expect(computeEvidenceContentHashForStore(clone, store)).toBe(withGraph);
    }
  });

  it("every graph input still invalidates a graph store — the closure is no narrower than the graph", () => {
    // Under-invalidation is the dangerous direction. Each of these edits can
    // move the graph without touching anything the store reads directly.
    const repo = buildFixtureRepo();
    for (const [path, bytes] of [
      ["decisions/ADR-001-example.md", "**Status:** superseded\n"],
      ["ROADMAP.md", "# roadmap, edited\n"],
      ["scripts/reachability.mjs", "// reachability, edited\n"],
      ["scripts/vi-refresh.mjs", "// the graph producer itself\n"],
    ]) {
      const before = Object.fromEntries(["completion-depth", "vi-observed"].map((s) => [s, computeEvidenceContentHashForStore(repo, s)]));
      writeFileSync(join(repo, path), bytes);
      for (const store of ["completion-depth", "vi-observed"]) {
        expect(computeEvidenceContentHashForStore(repo, store), `${path} -> ${store}`).not.toBe(before[store]);
      }
    }
  });
});

describe("GENERATED_EVIDENCE_PREFIXES now excludes the graph and findings planes from the legacy whole-repo hash", () => {
  it("excludes .visual-intelligence/graph/ and .visual-intelligence/findings/ from evidenceInputPaths", () => {
    const repo = buildFixtureRepo();
    const paths = evidenceInputPaths(repo);
    expect(paths).not.toContain(".visual-intelligence/graph/nodes.jsonl");
    expect(paths).not.toContain(".visual-intelligence/findings/triage.jsonl");
    expect(paths).not.toContain(".claim-ledger/claims.jsonl");
    expect(paths).toContain("ROADMAP.md");
  });
});

describe("the two-direction acceptance test: a store's scoped hash must react ONLY to what it actually reads", () => {
  it("recording a triage verdict (a doc-only/non-code change) leaves determinism-baseline's scoped hash unchanged", () => {
    const repo = buildFixtureRepo();
    const before = computeEvidenceContentHashForStore(repo, "determinism-baseline");
    // Simulate an operator recording a human triage verdict — untracked, exactly
    // the scenario named in the task brief (untracked files count via `-o`).
    writeFileSync(join(repo, ".visual-intelligence/findings/triage.jsonl"), '{"finding_id":"vi:1","verdict":"accepted_tradeoff"}\n');
    // Also touch a docs-only file and README — neither is a determinism input.
    writeFileSync(join(repo, "docs/notes.md"), "prose, edited\n");
    writeFileSync(join(repo, "README.md"), "readme, edited\n");
    const after = computeEvidenceContentHashForStore(repo, "determinism-baseline");
    expect(after).toBe(before);
  });

  it("editing a file the determinism-baseline store actually measures (packages/*/src) changes its scoped hash", () => {
    const repo = buildFixtureRepo();
    const before = computeEvidenceContentHashForStore(repo, "determinism-baseline");
    writeFileSync(join(repo, "packages/arbor-mcp/src/index.ts"), "export const x = 2;\n");
    const after = computeEvidenceContentHashForStore(repo, "determinism-baseline");
    expect(after).not.toBe(before);
  });

  it("under the OLD global hash the same doc-only edit WOULD have flipped every store — demonstrating what scoping fixed", () => {
    const repo = buildFixtureRepo();
    const before = computeEvidenceContentHash(repo);
    writeFileSync(join(repo, "docs/notes.md"), "prose, edited\n");
    const after = computeEvidenceContentHash(repo);
    expect(after).not.toBe(before);
  });
});

describe("assessEvidenceProvenance wired to a per-store scoped hash", () => {
  it("reports ok when the manifest's content_hash matches the store's OWN scoped hash, even though a file outside its scope changed", () => {
    const repo = buildFixtureRepo();
    const head = git(repo, "rev-parse", "HEAD");
    const scopedHash = computeEvidenceContentHashForStore(repo, "determinism-baseline");
    // Change something entirely outside determinism-baseline's scope after the
    // manifest was (hypothetically) written with scopedHash.
    writeFileSync(join(repo, "AGENTS.md"), "agents, edited\n");
    const stillScopedHash = computeEvidenceContentHashForStore(repo, "determinism-baseline");
    expect(stillScopedHash).toBe(scopedHash);
    const result = assessEvidenceProvenance({
      repo, manifest: { scanned_up_to_revision: head, content_hash: scopedHash },
      currentContentHash: stillScopedHash, head, refresh: "captest bun run determinism:refresh",
    });
    expect(result.state).toBe("ok");
  });

  it("reports fail when a file inside the store's scope changed after the manifest was written", () => {
    const repo = buildFixtureRepo();
    const head = git(repo, "rev-parse", "HEAD");
    const scopedHash = computeEvidenceContentHashForStore(repo, "determinism-baseline");
    writeFileSync(join(repo, "packages/arbor-mcp/src/index.ts"), "export const x = 3;\n");
    const newHash = computeEvidenceContentHashForStore(repo, "determinism-baseline");
    const result = assessEvidenceProvenance({
      repo, manifest: { scanned_up_to_revision: head, content_hash: scopedHash },
      currentContentHash: newHash, head, refresh: "captest bun run determinism:refresh",
    });
    expect(result.state).toBe("fail");
    expect(result.detail).toContain("content hash differs");
  });
});

describe("ADR-183 follow-up: a graph store records the graph input binding it consumed", () => {
  const BOUND = "sha256:aaaa";
  const writeGraphManifest = (repo, inputBinding) => {
    mkdirSync(join(repo, ".visual-intelligence"), { recursive: true });
    writeFileSync(join(repo, ".visual-intelligence/manifest.json"), `${JSON.stringify(inputBinding === undefined ? {} : { input_binding: inputBinding })}\n`);
  };
  const assessStore = (repo, storeName, graphBinding) => {
    const head = git(repo, "rev-parse", "HEAD");
    const hash = computeEvidenceContentHashForStore(repo, storeName);
    return assessEvidenceProvenance({
      repo, storeName, head, currentContentHash: hash,
      manifest: { scanned_up_to_revision: head, content_hash: hash, ...(graphBinding === undefined ? {} : { graph_input_binding: graphBinding }) },
    });
  };

  it.each(["completion-depth", "vi-observed"])("%s passes in a graph-less checkout when the committed graph manifest binding matches", (storeName) => {
    const repo = buildFixtureRepo();
    rmSync(join(repo, ".visual-intelligence/graph"), { recursive: true, force: true });
    writeGraphManifest(repo, { content_hash: BOUND });
    expect(existsSync(join(repo, ".visual-intelligence/graph"))).toBe(false);
    expect(readGraphInputBinding(repo)).toBe(BOUND);
    const result = assessStore(repo, storeName, BOUND);
    expect(result.state, result.detail).toBe("ok");
  });

  it.each(["completion-depth", "vi-observed"])("%s fails with a remedy when it consumed a different graph binding", (storeName) => {
    const repo = buildFixtureRepo();
    writeGraphManifest(repo, { content_hash: BOUND });
    const result = assessStore(repo, storeName, "sha256:stale");
    expect(result.state).toBe("fail");
    expect(result.detail).toContain("different graph");
    expect(result.detail).toContain("sha256:stale");
    expect(result.detail).toContain("arbor evidence refresh");
  });

  it("fails closed when the store records no binding, or the graph manifest has none", () => {
    const repo = buildFixtureRepo();
    writeGraphManifest(repo, { content_hash: BOUND });
    expect(assessStore(repo, "completion-depth", undefined).detail).toContain("UNMEASURED");
    writeGraphManifest(repo, undefined);
    const result = assessStore(repo, "completion-depth", BOUND);
    expect(result.state).toBe("fail");
    expect(result.detail).toContain("UNMEASURED");
  });

  it("does not apply to stores that never read the graph", () => {
    const repo = buildFixtureRepo();
    const result = assessStore(repo, "claim-ledger", undefined);
    expect(result.state).toBe("ok");
  });
});
