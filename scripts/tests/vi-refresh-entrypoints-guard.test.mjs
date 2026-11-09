import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyEntryPointsMaterialized } from "../vi-refresh.mjs";

/**
 * VI-1 guard: a declared entry point in `scripts/reachability/entry-points.json`
 * that does not materialize as a root in `.visual-intelligence/manifest.json`
 * must fail the refresh loudly, not silently degrade reachability.
 *
 * Root cause this guards against, confirmed against the vendored extractor
 * (`.claude/skills/repository-visual-intelligence/scripts/vi-extract-ts.mjs:748-765`,
 * not editable under ADR-031 when written; first-party since ADR-176): a declared
 * entry whose `file` is not covered by `--include` resolves to no fileNodeId,
 * the extractor logs "entrypoint not found in scope" and `continue`s, and the
 * root is dropped from `manifest.entrypoints.roots` with no non-zero exit and
 * no other signal. `verifyEntryPointsMaterialized` closes that gap from
 * OUTSIDE the vendored file by cross-checking the two artifacts directly.
 *
 * These tests run the REAL vi-extract-ts.mjs (vendored) against a real,
 * minimal git fixture — the same pattern as
 * vi-extract-ts-tree-state.test.mjs — so the "dropped root" and "materializes
 * correctly" fixtures are genuine extractor output, not a hand-written
 * manifest.json standing in for one.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTRACTOR = join(REPO_ROOT, ".claude/skills/repository-visual-intelligence/scripts/vi-extract-ts.mjs");
const REAL_TYPESCRIPT = join(REPO_ROOT, "node_modules/typescript");

let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runExtractor(entrypointsPath) {
  execFileSync(process.execPath, [
    EXTRACTOR, "--root", repo, "--include", "src/**", "--entrypoints", entrypointsPath,
  ], { cwd: repo, encoding: "utf-8" });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "vi-refresh-entrypoints-guard-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");

  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  mkdirSync(join(repo, "src"));
  // The one entry point INSIDE the declared --include scope.
  writeFileSync(join(repo, "src/primary.ts"), "import { worker } from \"./worker.js\";\nworker();\n");
  // A second, independent root: nothing under src/primary.ts's import graph
  // reaches this file or its export. Only being a declared root does.
  // The `worker();` top-level call is what makes `worker` (and, transitively,
  // `onlyReachableFromWorker`) reachable when this file is a root: vi-extract-ts
  // records file->symbol declarations as `contains` edges, which the BFS
  // deliberately excludes (only executable references count) — reachability
  // comes from the file's own top-level `calls` edge to `worker`, exactly
  // like production `cli.ts` files that end in a bare `main()` call.
  writeFileSync(join(repo, "src/worker.ts"), "export function worker() { return onlyReachableFromWorker(); }\nfunction onlyReachableFromWorker() { return 1; }\nworker();\n");
  // Deliberately OUTSIDE `--include "src/**"` — this is the dropped root.
  mkdirSync(join(repo, "outside"));
  writeFileSync(join(repo, "outside/orphan-entry.ts"), "export function orphanMain() { return 1; }\n");

  git("add", "package.json", ".gitignore", "src", "outside");
  git("commit", "-q", "-m", "base");

  mkdirSync(join(repo, "node_modules"));
  symlinkSync(REAL_TYPESCRIPT, join(repo, "node_modules/typescript"), "dir");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("verifyEntryPointsMaterialized", () => {
  it("passes when every declared entry point materializes as a root", () => {
    const entrypointsPath = join(repo, "entry-points.json");
    writeFileSync(entrypointsPath, JSON.stringify({
      entryPoints: [
        { id: "primary", file: "src/primary.ts" },
        { id: "worker", file: "src/worker.ts" },
      ],
    }));
    runExtractor(entrypointsPath);

    const failure = verifyEntryPointsMaterialized(repo, "entry-points.json", "src/**");
    expect(failure).toBeNull();
  });

  it("fails loudly, naming the dropped entry, when a declared root falls outside --include", () => {
    const entrypointsPath = join(repo, "entry-points.json");
    writeFileSync(entrypointsPath, JSON.stringify({
      entryPoints: [
        { id: "primary", file: "src/primary.ts" },
        { id: "orphan-entry-cli", file: "outside/orphan-entry.ts" },
      ],
    }));
    runExtractor(entrypointsPath);

    const failure = verifyEntryPointsMaterialized(repo, "entry-points.json", "src/**");
    expect(failure).not.toBeNull();
    expect(failure).toContain("orphan-entry-cli");
    expect(failure).toContain("outside/orphan-entry.ts");
    expect(failure).toContain("1 of 2 declared entry point(s)");
  });

  it("fails loudly when a declared symbol export is not found on an otherwise-materialized root", () => {
    const entrypointsPath = join(repo, "entry-points.json");
    writeFileSync(entrypointsPath, JSON.stringify({
      entryPoints: [
        { id: "primary", file: "src/primary.ts" },
        { id: "worker", file: "src/worker.ts", symbol: "thisExportDoesNotExist" },
      ],
    }));
    runExtractor(entrypointsPath);

    const failure = verifyEntryPointsMaterialized(repo, "entry-points.json", "src/**");
    expect(failure).not.toBeNull();
    expect(failure).toContain("thisExportDoesNotExist");
  });

  it("counts reachability from a non-primary root — a symbol reachable ONLY via the second entry point is marked reachable", () => {
    const entrypointsPath = join(repo, "entry-points.json");
    // Declare ONLY worker.ts as a root (drop primary.ts entirely). worker.ts
    // is a "non-primary" root in the sense entry-points.json's real 4 roots
    // are: not the main CLI, reached on its own. onlyReachableFromWorker is
    // not exported and has no caller anywhere except worker() in this same
    // file, so it can only be marked reachable via this second, independent
    // root — never as a side effect of primary.ts.
    writeFileSync(entrypointsPath, JSON.stringify({
      entryPoints: [
        { id: "worker", file: "src/worker.ts" },
      ],
    }));
    runExtractor(entrypointsPath);

    const failure = verifyEntryPointsMaterialized(repo, "entry-points.json", "src/**");
    expect(failure).toBeNull();

    const nodes = readFileSyncJsonl(join(repo, ".visual-intelligence/graph/nodes.jsonl"));
    const helper = nodes.find((n) => n.kind === "symbol" && n.name === "onlyReachableFromWorker");
    expect(helper).toBeDefined();
    expect(helper.implementation_status).toBe("wired_but_unverified"); // reachable
  });
});

function readFileSyncJsonl(path) {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}
