import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepositoryGraphIndex } from "../src/repository-graph.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-repository-graph-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), 'import { Beta } from "./b.js";\nexport function alpha(): Beta { return new Beta(); }\n');
  writeFileSync(join(root, "src", "b.ts"), "export class Beta {}\n");
  writeFileSync(join(root, "src", "ignored.json"), '{"large":"not source"}');
  return root;
}

describe("RepositoryGraphIndex", () => {
  it("returns a focused bidirectional dependency neighborhood", () => {
    const root = fixture();
    const result = new RepositoryGraphIndex().query(root, { path: "src/b.ts", depth: 1 });

    expect(result.files_indexed).toBe(2);
    expect(result.nodes.map((node) => node.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.nodes.find((node) => node.path === "src/b.ts")?.symbols).toContain("Beta");
    expect(result.edges).toEqual([{ from: "src/a.ts", to: "src/b.ts" }]);
  });

  it("reuses a parsed graph until repository metadata changes", () => {
    const root = fixture();
    const index = new RepositoryGraphIndex();
    const first = index.query(root, { symbol: "alpha" });
    const second = index.query(root, { symbol: "alpha" });
    writeFileSync(join(root, "src", "b.ts"), "export class Beta {}\nexport const gamma = 1;\n");
    const changed = index.query(root, { symbol: "gamma" });

    expect(first.cache_hit).toBe(false);
    expect(second.cache_hit).toBe(true);
    expect(second.index_digest).toBe(first.index_digest);
    expect(changed.cache_hit).toBe(false);
    expect(changed.nodes.some((node) => node.symbols.some((symbol) => symbol.includes("gamma")))).toBe(true);
  });

  it("ranks a bounded task-specific neighborhood without copying source text", () => {
    const root = fixture();
    const index = new RepositoryGraphIndex();
    const first = index.queryTask(root, "repair the alpha function and its Beta dependency");
    const second = index.queryTask(root, "repair the alpha function and its Beta dependency");

    expect(first.nodes.map((node) => node.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(first.edges).toEqual([{ from: "src/a.ts", to: "src/b.ts" }]);
    expect(JSON.stringify(first)).not.toContain("return new Beta");
    expect(first.cache_hit).toBe(false);
    expect(second.cache_hit).toBe(true);
  });

  it("returns no broad fallback when task language has no graph match", () => {
    const result = new RepositoryGraphIndex().queryTask(fixture(), "unrelated quasar nebula workflow");
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("focuses retries on changed paths even when the failure wording is generic", () => {
    const result = new RepositoryGraphIndex().queryTask(fixture(), "retry the failed attempt", {
      signals: { changed_paths: ["src/b.ts"] },
    });
    expect(result.nodes.map((node) => node.path)).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("accepts verified memory tags with evidence and ignores weaker memory", () => {
    const root = fixture();
    const index = new RepositoryGraphIndex();
    const verified = index.queryTask(root, "investigate failure", { signals: { memory: [{
      terms: ["Beta"], evidence_pointer: "audit:campaign:memory_1",
      provenance: { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:test", check: { kind: "shell_command", breadth: "single" } },
    }] } });
    const claimed = index.queryTask(root, "investigate failure", { signals: { memory: [{
      terms: ["Beta"], evidence_pointer: "audit:campaign:memory_2", provenance: { tag: "claimed", claimant: "seed" },
    }] } });

    expect(verified.nodes.map((node) => node.path)).toContain("src/b.ts");
    expect(claimed.nodes).toEqual([]);
  });

  it("never indexes campaign worktree replicas as canonical repository evidence", () => {
    const root = fixture();
    mkdirSync(join(root, ".worktrees", "attempt", "src"), { recursive: true });
    writeFileSync(join(root, ".worktrees", "attempt", "src", "stale.ts"), "export const alpha = 'stale';\n");
    const result = new RepositoryGraphIndex().queryTask(root, "repair alpha");
    expect(result.files_indexed).toBe(2);
    expect(result.nodes.every((node) => !node.path.startsWith(".worktrees/"))).toBe(true);
  });

  it("indexes Python, Rust, and Go symbols without copying source content", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-repository-polyglot-"));
    roots.push(root);
    mkdirSync(join(root, "python"));
    mkdirSync(join(root, "rust"));
    mkdirSync(join(root, "go"));
    writeFileSync(join(root, "python", "service.py"), "class PaymentService:\n    pass\n");
    writeFileSync(join(root, "rust", "worker.rs"), "pub struct RetryWorker;\n");
    writeFileSync(join(root, "go", "handler.go"), "package handler\n\ntype RequestHandler struct{}\n");

    const index = new RepositoryGraphIndex();
    const snapshot = index.snapshot(root);
    expect(snapshot.files_indexed).toBe(3);
    expect(snapshot.nodes.find((node) => node.path.endsWith("service.py"))?.symbols).toContain("PaymentService");
    expect(snapshot.nodes.find((node) => node.path.endsWith("worker.rs"))?.symbols).toContain("RetryWorker");
    expect(snapshot.nodes.find((node) => node.path.endsWith("handler.go"))?.symbols).toContain("RequestHandler");
    expect(index.queryTask(root, "repair PaymentService").nodes.map((node) => node.path)).toEqual(["python/service.py"]);
    expect(JSON.stringify(snapshot)).not.toContain("pub struct");
  });

  it("resolves mechanically local Python and Rust module edges", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-repository-polyglot-edges-"));
    roots.push(root);
    mkdirSync(join(root, "py"));
    mkdirSync(join(root, "rs"));
    writeFileSync(join(root, "py", "a.py"), "from .b import Beta\ndef alpha(): pass\n");
    writeFileSync(join(root, "py", "b.py"), "class Beta: pass\n");
    writeFileSync(join(root, "rs", "lib.rs"), "mod worker;\npub fn start() {}\n");
    writeFileSync(join(root, "rs", "worker.rs"), "pub fn run() {}\n");

    const snapshot = new RepositoryGraphIndex().snapshot(root);
    expect(snapshot.edges).toEqual(expect.arrayContaining([
      { from: "py/a.py", to: "py/b.py" },
      { from: "rs/lib.rs", to: "rs/worker.rs" },
    ]));
  });
});
