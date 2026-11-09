import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beginPlaneTransaction } from "../vi-refresh.mjs";

/**
 * ADR-169/090: the generated `.visual-intelligence/` plane is one transaction.
 * A stage that fails after an earlier one wrote (the LSP stage timing out after
 * the extractor emitted a new graph) must leave the PREVIOUS graph and manifest
 * byte-identical, so the next successful refresh does not read a half-written
 * pair as its prior generation and record a `generation_mismatch` gap.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VI_REFRESH = join(REPO_ROOT, "scripts/vi-refresh.mjs");
const EXTRACTOR = join(REPO_ROOT, ".claude/skills/repository-visual-intelligence/scripts/vi-extract-ts.mjs");

const temporary = [];
const temp = (prefix) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
};
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Every file under a directory, by relative path, as bytes. */
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(dir, path)] = readFileSync(path).toString("base64");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

describe("beginPlaneTransaction", () => {
  const seed = () => {
    const dir = join(temp("vi-txn-unit-"), ".visual-intelligence");
    mkdirSync(join(dir, "graph"), { recursive: true });
    writeFileSync(join(dir, "graph/nodes.jsonl"), "old\n");
    writeFileSync(join(dir, "manifest.json"), "{\"v\":1}\n");
    return dir;
  };

  it("rollback restores the prior plane byte-for-byte and removes files the run added", () => {
    const dir = seed();
    const before = snapshot(dir);
    const txn = beginPlaneTransaction({ visualIntelligenceDir: dir });
    writeFileSync(join(dir, "graph/nodes.jsonl"), "half-written\n");
    writeFileSync(join(dir, "graph/extra.jsonl"), "new\n");
    rmSync(join(dir, "manifest.json"));
    txn.rollback();
    expect(snapshot(dir)).toEqual(before);
    expect(existsSync(txn.backup)).toBe(false);
  });

  it("rollback of a run that started with no plane leaves no plane", () => {
    const dir = join(temp("vi-txn-fresh-"), ".visual-intelligence");
    const txn = beginPlaneTransaction({ visualIntelligenceDir: dir });
    mkdirSync(join(dir, "graph"), { recursive: true });
    writeFileSync(join(dir, "graph/nodes.jsonl"), "x\n");
    txn.rollback();
    expect(existsSync(dir)).toBe(false);
  });

  it("commit keeps what the run wrote, and settling is idempotent in both directions", () => {
    const dir = seed();
    const txn = beginPlaneTransaction({ visualIntelligenceDir: dir });
    writeFileSync(join(dir, "graph/nodes.jsonl"), "new\n");
    txn.commit();
    txn.rollback(); // no-op once committed
    expect(readFileSync(join(dir, "graph/nodes.jsonl"), "utf8")).toBe("new\n");
    expect(existsSync(txn.backup)).toBe(false);

    const second = beginPlaneTransaction({ visualIntelligenceDir: dir });
    writeFileSync(join(dir, "graph/nodes.jsonl"), "newer\n");
    second.rollback();
    second.rollback(); // a second restore from the deleted snapshot would destroy the plane
    expect(readFileSync(join(dir, "graph/nodes.jsonl"), "utf8")).toBe("new\n");
  });
});

/** A fixture checkout whose extractor writes a NEW graph and whose LSP stage fails. */
function buildFailingLspFixture() {
  const dir = temp("vi-refresh-txn-");
  mkdirSync(join(dir, "scripts/reachability"), { recursive: true });
  mkdirSync(join(dir, "scripts/lib"), { recursive: true });
  mkdirSync(join(dir, ".claude/skills/repository-visual-intelligence/scripts"), { recursive: true });
  copyFileSync(VI_REFRESH, join(dir, "scripts/vi-refresh.mjs"));
  for (const file of [
    "scripts/lib/project-profile.mjs", "scripts/lib/vi-input-binding.mjs", "scripts/evidence-transaction.mjs",
    "scripts/enforcement-control-plane.mjs", "scripts/finalization-progress.mjs", "scripts/lib/governance-plan.mjs",
  ]) copyFileSync(join(REPO_ROOT, file), join(dir, file));
  writeFileSync(join(dir, "scripts/reachability/entry-points.json"), "{}\n");

  const extractor = join(dir, ".claude/skills/repository-visual-intelligence/scripts/vi-extract-ts.mjs");
  writeFileSync(extractor,
    "import { mkdirSync, writeFileSync } from \"node:fs\";\n" +
    "mkdirSync(\".visual-intelligence/graph\", { recursive: true });\n" +
    "writeFileSync(\".visual-intelligence/graph/nodes.jsonl\", \"NEW-GENERATION\\n\");\n" +
    "writeFileSync(\".visual-intelligence/graph/edges.jsonl\", \"NEW-GENERATION\\n\");\n" +
    "writeFileSync(\".visual-intelligence/manifest.json\", \"{\\\"generation\\\":\\\"new\\\"}\\n\");\n");
  const lsp = join(dir, "scripts/vi-lsp-facts.mjs");
  writeFileSync(lsp, "console.error(\"tsserver request timed out\");\nprocess.exit(1);\n");
  chmodSync(extractor, 0o755);

  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  git("add", ".");
  git("commit", "-qm", "fixture");

  // The prior plane. `.visual-intelligence` is an evidence store, so it does not
  // count as in-scope dirt for the clean-tree guard.
  mkdirSync(join(dir, ".visual-intelligence/graph"), { recursive: true });
  writeFileSync(join(dir, ".visual-intelligence/graph/nodes.jsonl"), "PRIOR-GENERATION\n");
  writeFileSync(join(dir, ".visual-intelligence/graph/edges.jsonl"), "PRIOR-GENERATION\n");
  writeFileSync(join(dir, ".visual-intelligence/manifest.json"), "{\"generation\":\"prior\"}\n");
  return dir;
}

describe("vi-refresh when the LSP stage fails after the extractor wrote", () => {
  it("leaves the previous graph and manifest byte-identical and exits non-zero", () => {
    const dir = buildFailingLspFixture();
    const before = snapshot(join(dir, ".visual-intelligence"));
    const result = spawnSync(process.execPath, [join(dir, "scripts/vi-refresh.mjs")], { cwd: dir, encoding: "utf8" });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("LSP static facts were unavailable");
    expect(snapshot(join(dir, ".visual-intelligence"))).toEqual(before);
    expect(readFileSync(join(dir, ".visual-intelligence/graph/nodes.jsonl"), "utf8")).toBe("PRIOR-GENERATION\n");
  });
});

describe("a successful extraction after an aborted refresh records no generation_mismatch", () => {
  it("rolling back the aborted run keeps manifest counts and graph bytes in the same generation", () => {
    const repo = temp("vi-txn-extract-");
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/index.ts"), "export const a = 1;\n");
    git("add", "package.json", ".gitignore", "src");
    git("commit", "-q", "-m", "base");
    mkdirSync(join(repo, "node_modules"));
    symlinkSync(join(REPO_ROOT, "node_modules/typescript"), join(repo, "node_modules/typescript"), "dir");

    const extract = () => {
      const result = spawnSync(process.execPath, [EXTRACTOR, "--root", repo, "--include", "src/**"], { cwd: repo, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`vi-extract-ts exited ${result.status}\n${result.stdout}\n${result.stderr}`);
    };
    const manifest = () => JSON.parse(readFileSync(join(repo, ".visual-intelligence/manifest.json"), "utf8"));
    const viDir = join(repo, ".visual-intelligence");

    extract(); // generation 1 on disk
    const generationOne = snapshot(viDir);

    // An aborted refresh: the extractor writes generation 2, a later stage fails.
    writeFileSync(join(repo, "src/index.ts"), "export const a = 1;\nexport function b() { return a; }\n");
    const txn = beginPlaneTransaction({ visualIntelligenceDir: viDir });
    extract();
    expect(snapshot(viDir)).not.toEqual(generationOne);
    txn.rollback();
    expect(snapshot(viDir)).toEqual(generationOne);

    extract(); // the next successful refresh
    expect(manifest().extraction_gaps.find((gap) => gap.reason === "generation_mismatch")).toBeUndefined();
  });
});
