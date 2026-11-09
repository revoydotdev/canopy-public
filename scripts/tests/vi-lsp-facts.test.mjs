import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const available = (() => { try { execFileSync("typescript-language-server", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const suite = available ? describe : describe.skip;
const rustAvailable = (() => { try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

suite("vi-lsp-facts", () => {
  it("records real LSP symbol facts and an explicit soundness regime", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-vi-lsp-"));
    try {
      mkdirSync(join(root, ".visual-intelligence", "graph"), { recursive: true });
      writeFileSync(join(root, "a.ts"), "export function target() { return 42; }\n");
      writeFileSync(join(root, ".visual-intelligence", "graph", "nodes.jsonl"), `${JSON.stringify({ id: "file:a.ts", kind: "file", repository_path: "a.ts" })}\n${JSON.stringify({ id: "sym:target", kind: "symbol", name: "target", repository_path: "a.ts", source_evidence: ["e1"] })}\n${JSON.stringify({ id: "ep:test", kind: "entrypoint" })}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "evidence.jsonl"), `${JSON.stringify({ id: "e1", repository_path: "a.ts", line_start: 1 })}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "edges.jsonl"), "");
      writeFileSync(join(root, ".visual-intelligence", "manifest.json"), JSON.stringify({ repo_revision: "test", entrypoints: { roots: ["file:a.ts"] } }));
      execFileSync("node", [join(repo, "scripts/vi-lsp-facts.mjs"), "--root", root, "--graph", join(root, ".visual-intelligence/graph")], { stdio: "pipe" });
      const facts = JSON.parse(readFileSync(join(root, ".visual-intelligence/graph/lsp-facts.json"), "utf8"));
      expect(facts.symbol_existence.documents[0]).toEqual({ file: "a.ts", symbols: 1, mapped: 1 });
      expect(facts.references.scope).toBe("top-level-semantic-declarations-and-nested-callables");
      expect(facts.backend_regime).toBe("compiler-grade");
      expect(facts.fact_regime).toBe("semantic-symbol-call-reference-reachability");
      const projection = JSON.parse(readFileSync(join(root, ".visual-intelligence/manifest.json"), "utf8")).lsp_static_facts;
      expect(projection).toMatchObject({ fallback: "none", canonical_edges: "projected", identity_mapping: "exact-only", in_scope_target_policy: "coverage-debt" });
      expect(facts.call_hierarchy.status).toBe("projected");
      expect(facts.references.status).toBe("projected");
      expect(facts.reachability.status).toBe("projected");
      const edges = readFileSync(join(root, ".visual-intelligence/graph/edges.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
      expect(edges.filter((edge) => edge.relation === "references" && edge.target === "sym:target")).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40000);

  it("projects only exact graph identities: constructors, methods, and external targets", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-vi-lsp-class-"));
    try {
      mkdirSync(join(root, ".visual-intelligence", "graph"), { recursive: true });
      mkdirSync(join(root, "node_modules", "external-package"), { recursive: true });
      writeFileSync(join(root, "node_modules", "external-package", "package.json"), JSON.stringify({ name: "external-package", types: "index.d.ts" }));
      writeFileSync(join(root, "node_modules", "external-package", "index.d.ts"), "export function externalCall(): number;\n");
      writeFileSync(join(root, "a.ts"), "import { externalCall } from 'external-package';\nexport class C {\n  constructor() {}\n  method() { return 42; }\n}\nfunction unmodelled() { return 0; }\nexport function caller() { const value = new C(); externalCall(); unmodelled(); return value.method(); }\n");
      const nodes = [
        { id: "file:a.ts", kind: "file", repository_path: "a.ts" },
        { id: "type:C", kind: "type", name: "C", repository_path: "a.ts", source_evidence: ["e1"] },
        { id: "sym:constructor", kind: "symbol", name: "constructor", repository_path: "a.ts", source_evidence: ["e2"] },
        { id: "sym:method", kind: "symbol", name: "method", repository_path: "a.ts", source_evidence: ["e3"] },
        { id: "sym:caller", kind: "symbol", name: "caller", repository_path: "a.ts", source_evidence: ["e4"] },
        { id: "ep:test", kind: "entrypoint" },
      ];
      writeFileSync(join(root, ".visual-intelligence", "graph", "nodes.jsonl"), `${nodes.map(JSON.stringify).join("\n")}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "evidence.jsonl"), `${JSON.stringify({ id: "e1", repository_path: "a.ts", line_start: 2 })}\n${JSON.stringify({ id: "e2", repository_path: "a.ts", line_start: 3 })}\n${JSON.stringify({ id: "e3", repository_path: "a.ts", line_start: 4 })}\n${JSON.stringify({ id: "e4", repository_path: "a.ts", line_start: 7 })}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "edges.jsonl"), "");
      writeFileSync(join(root, ".visual-intelligence", "manifest.json"), JSON.stringify({ repo_revision: "test", entrypoints: { roots: ["sym:caller"] } }));

      execFileSync("node", [join(repo, "scripts/vi-lsp-facts.mjs"), "--root", root, "--graph", join(root, ".visual-intelligence/graph")], { stdio: "pipe", timeout: 40000 });
      const edges = readFileSync(join(root, ".visual-intelligence/graph/edges.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
      expect(edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "sym:caller", target: "type:C", relation: "instantiates", evidence_type: "lsp_call_hierarchy" }),
        expect.objectContaining({ source: "sym:caller", target: "sym:method", relation: "calls", evidence_type: "lsp_call_hierarchy", attributes: expect.objectContaining({ identity_mapping: "exact_graph_symbol", backend_regime: "compiler-grade" }) }),
      ]));
      expect(edges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "sym:caller", target: "type:C", relation: "calls" }),
        expect.objectContaining({ target: "external-package" }),
        expect.objectContaining({ target: "sym:unmodelled" }),
      ]));
      const facts = JSON.parse(readFileSync(join(root, ".visual-intelligence/graph/lsp-facts.json"), "utf8"));
      expect(facts.call_hierarchy.external_targets_skipped).toBeGreaterThan(0);
      expect(facts.call_hierarchy.in_scope_targets_unmapped).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 50000);

  it("keeps overload identities and edge bytes deterministic across repeated LSP runs", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-vi-lsp-overload-"));
    try {
      mkdirSync(join(root, ".visual-intelligence", "graph"), { recursive: true });
      writeFileSync(join(root, "a.ts"), [
        "export function overloaded(value: string): string;",
        "export function overloaded(value: number): number;",
        "export function overloaded(value: string | number) { return value; }",
        "export function target() { return 1; }",
        "export function alpha() { target(); target(); return overloaded('x'); }",
        "export function beta() { return target() + overloaded(1); }",
        "",
      ].join("\n"));
      const nodes = [
        { id: "file:a.ts", kind: "file", repository_path: "a.ts" },
        { id: "sym:overloaded", kind: "symbol", name: "overloaded", repository_path: "a.ts", source_evidence: ["e1"] },
        { id: "sym:target", kind: "symbol", name: "target", repository_path: "a.ts", source_evidence: ["e2"] },
        { id: "sym:alpha", kind: "symbol", name: "alpha", repository_path: "a.ts", source_evidence: ["e3"] },
        { id: "sym:beta", kind: "symbol", name: "beta", repository_path: "a.ts", source_evidence: ["e4"] },
        { id: "ep:test", kind: "entrypoint" },
      ];
      writeFileSync(join(root, ".visual-intelligence", "graph", "nodes.jsonl"), `${nodes.map(JSON.stringify).join("\n")}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "evidence.jsonl"), `${JSON.stringify({ id: "e1", repository_path: "a.ts", line_start: 3 })}\n${JSON.stringify({ id: "e2", repository_path: "a.ts", line_start: 4 })}\n${JSON.stringify({ id: "e3", repository_path: "a.ts", line_start: 5 })}\n${JSON.stringify({ id: "e4", repository_path: "a.ts", line_start: 6 })}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "edges.jsonl"), "");
      writeFileSync(join(root, ".visual-intelligence", "manifest.json"), JSON.stringify({ repo_revision: "test", entrypoints: { roots: ["sym:alpha", "sym:beta"] } }));
      const args = [join(repo, "scripts/vi-lsp-facts.mjs"), "--root", root, "--graph", join(root, ".visual-intelligence/graph")];
      execFileSync("node", args, { stdio: "pipe", timeout: 40000 });
      const first = readFileSync(join(root, ".visual-intelligence/graph/edges.jsonl"), "utf8");
      execFileSync("node", args, { stdio: "pipe", timeout: 40000 });
      const second = readFileSync(join(root, ".visual-intelligence/graph/edges.jsonl"), "utf8");
      expect(second).toBe(first);
      const edges = first.split("\n").filter(Boolean).map(JSON.parse);
      expect(edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "sym:alpha", target: "sym:target", relation: "calls", evidence_type: "lsp_call_hierarchy", evidence_location: "a.ts:5:27" }),
        expect.objectContaining({ source: "sym:beta", target: "sym:target", relation: "calls", evidence_type: "lsp_call_hierarchy" }),
        expect.objectContaining({ source: "sym:alpha", target: "sym:overloaded", relation: "references", evidence_type: "lsp_references" }),
        expect.objectContaining({ source: "sym:beta", target: "sym:overloaded", relation: "references", evidence_type: "lsp_references" }),
      ]));
      expect(edges.filter((edge) => edge.source === "sym:alpha" && edge.target === "sym:target" && edge.relation === "calls")).toHaveLength(1);
      expect(edges.map((edge) => edge.id)).toEqual([...edges.map((edge) => edge.id)].sort());
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60000);

  it("projects an exact edge to a nested callable referenced by an unmodelled returned callback", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-vi-lsp-nested-callable-"));
    try {
      mkdirSync(join(root, ".visual-intelligence", "graph"), { recursive: true });
      writeFileSync(join(root, "a.ts"), [
        "export function factory() {",
        "  function nested() { return 1; }",
        "  return { run: () => nested() };",
        "}",
        "",
      ].join("\n"));
      const nodes = [
        { id: "file:a.ts", kind: "file", repository_path: "a.ts" },
        { id: "sym:factory", kind: "symbol", name: "factory", repository_path: "a.ts", source_evidence: ["e1"] },
        { id: "sym:nested", kind: "symbol", name: "nested", repository_path: "a.ts", source_evidence: ["e2"] },
        { id: "ep:test", kind: "entrypoint" },
      ];
      writeFileSync(join(root, ".visual-intelligence", "graph", "nodes.jsonl"), `${nodes.map(JSON.stringify).join("\n")}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "evidence.jsonl"), `${JSON.stringify({ id: "e1", repository_path: "a.ts", line_start: 1 })}\n${JSON.stringify({ id: "e2", repository_path: "a.ts", line_start: 2 })}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "edges.jsonl"), "");
      writeFileSync(join(root, ".visual-intelligence", "manifest.json"), JSON.stringify({ repo_revision: "test", entrypoints: { roots: ["sym:factory"] } }));

      execFileSync("node", [join(repo, "scripts/vi-lsp-facts.mjs"), "--root", root, "--graph", join(root, ".visual-intelligence/graph")], { stdio: "pipe", timeout: 40000 });
      const edges = readFileSync(join(root, ".visual-intelligence", "graph/edges.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
      expect(edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "sym:factory", target: "sym:nested", relation: "references", evidence_type: "lsp_references", attributes: expect.objectContaining({ identity_mapping: "exact_target_canonical_owner" }) }),
        expect.objectContaining({ source: "sym:nested", target: "ep:test", relation: "reachable_from" }),
      ]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 50000);

  it("inherits reachability for a non-exported local declaration from its exact enclosing callable", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-vi-lsp-local-scope-"));
    try {
      mkdirSync(join(root, ".visual-intelligence", "graph"), { recursive: true });
      writeFileSync(join(root, "a.ts"), [
        "export function entry() {",
        "  const observedLocal = 1;",
        "  return observedLocal;",
        "}",
        "",
      ].join("\n"));
      const nodes = [
        { id: "file:a.ts", kind: "file", repository_path: "a.ts" },
        { id: "sym:entry", kind: "symbol", name: "entry", repository_path: "a.ts", source_evidence: ["e1"], attributes: { exported: true, declaration: "FunctionDeclaration" } },
        { id: "sym:local", kind: "symbol", name: "observedLocal", repository_path: "a.ts", source_evidence: ["e2"], attributes: { exported: false, declaration: "VariableDeclaration" } },
        { id: "ep:test", kind: "entrypoint" },
      ];
      writeFileSync(join(root, ".visual-intelligence", "graph", "nodes.jsonl"), `${nodes.map(JSON.stringify).join("\n")}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "evidence.jsonl"), `${JSON.stringify({ id: "e1", repository_path: "a.ts", line_start: 1 })}\n${JSON.stringify({ id: "e2", repository_path: "a.ts", line_start: 2 })}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "edges.jsonl"), "");
      writeFileSync(join(root, ".visual-intelligence", "manifest.json"), JSON.stringify({ repo_revision: "test", entrypoints: { roots: ["sym:entry"] } }));

      execFileSync("node", [join(repo, "scripts/vi-lsp-facts.mjs"), "--root", root, "--graph", join(root, ".visual-intelligence/graph")], { stdio: "pipe", timeout: 40000 });
      const edges = readFileSync(join(root, ".visual-intelligence/graph/edges.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
      expect(edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: "sym:local",
          target: "ep:test",
          relation: "reachable_from",
          evidence_type: "lsp_lexical_scope_reachability",
          attributes: expect.objectContaining({ identity_mapping: "lexical_scope_owner", execution_scope_owner: "sym:entry" }),
        }),
      ]));
      const facts = JSON.parse(readFileSync(join(root, ".visual-intelligence/graph/lsp-facts.json"), "utf8"));
      expect(facts.reachability.lexical_scope_inherited).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 50000);

  it("does not inherit reachability for a file-level local declaration", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-vi-lsp-file-local-"));
    try {
      mkdirSync(join(root, ".visual-intelligence", "graph"), { recursive: true });
      writeFileSync(join(root, "a.ts"), "const moduleLocal = 1;\nexport function entry() { return 1; }\n");
      const nodes = [
        { id: "file:a.ts", kind: "file", repository_path: "a.ts" },
        { id: "sym:module-local", kind: "symbol", name: "moduleLocal", repository_path: "a.ts", source_evidence: ["e1"], attributes: { exported: false, declaration: "VariableDeclaration" } },
        { id: "sym:entry", kind: "symbol", name: "entry", repository_path: "a.ts", source_evidence: ["e2"], attributes: { exported: true, declaration: "FunctionDeclaration" } },
        { id: "ep:test", kind: "entrypoint" },
      ];
      writeFileSync(join(root, ".visual-intelligence", "graph", "nodes.jsonl"), `${nodes.map(JSON.stringify).join("\n")}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "evidence.jsonl"), `${JSON.stringify({ id: "e1", repository_path: "a.ts", line_start: 1 })}\n${JSON.stringify({ id: "e2", repository_path: "a.ts", line_start: 2 })}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "edges.jsonl"), "");
      writeFileSync(join(root, ".visual-intelligence", "manifest.json"), JSON.stringify({ repo_revision: "test", entrypoints: { roots: ["sym:entry"] } }));

      execFileSync("node", [join(repo, "scripts/vi-lsp-facts.mjs"), "--root", root, "--graph", join(root, ".visual-intelligence/graph")], { stdio: "pipe", timeout: 40000 });
      const edges = readFileSync(join(root, ".visual-intelligence/graph/edges.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
      expect(edges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "sym:module-local", relation: "reachable_from" }),
      ]));
      const facts = JSON.parse(readFileSync(join(root, ".visual-intelligence/graph/lsp-facts.json"), "utf8"));
      expect(facts.reachability.lexical_scope_inherited).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 50000);

  it("does not inherit reachability when the exact enclosing callable is itself unreachable", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-vi-lsp-unreached-scope-"));
    try {
      mkdirSync(join(root, ".visual-intelligence", "graph"), { recursive: true });
      writeFileSync(join(root, "a.ts"), [
        "export function entry() { return 1; }",
        "export function dormant() { const localOnlyInDormant = 1; return localOnlyInDormant; }",
        "",
      ].join("\n"));
      const nodes = [
        { id: "file:a.ts", kind: "file", repository_path: "a.ts" },
        { id: "sym:entry", kind: "symbol", name: "entry", repository_path: "a.ts", source_evidence: ["e1"], attributes: { exported: true, declaration: "FunctionDeclaration" } },
        { id: "sym:dormant", kind: "symbol", name: "dormant", repository_path: "a.ts", source_evidence: ["e2"], attributes: { exported: true, declaration: "FunctionDeclaration" } },
        { id: "sym:dormant-local", kind: "symbol", name: "localOnlyInDormant", repository_path: "a.ts", source_evidence: ["e3"], attributes: { exported: false, declaration: "VariableDeclaration" } },
        { id: "ep:test", kind: "entrypoint" },
      ];
      writeFileSync(join(root, ".visual-intelligence", "graph", "nodes.jsonl"), `${nodes.map(JSON.stringify).join("\n")}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "evidence.jsonl"), `${JSON.stringify({ id: "e1", repository_path: "a.ts", line_start: 1 })}\n${JSON.stringify({ id: "e2", repository_path: "a.ts", line_start: 2 })}\n${JSON.stringify({ id: "e3", repository_path: "a.ts", line_start: 2 })}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "edges.jsonl"), "");
      writeFileSync(join(root, ".visual-intelligence", "manifest.json"), JSON.stringify({ repo_revision: "test", entrypoints: { roots: ["sym:entry"] } }));

      execFileSync("node", [join(repo, "scripts/vi-lsp-facts.mjs"), "--root", root, "--graph", join(root, ".visual-intelligence/graph")], { stdio: "pipe", timeout: 40000 });
      const edges = readFileSync(join(root, ".visual-intelligence/graph/edges.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
      expect(edges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "sym:dormant-local", relation: "reachable_from" }),
      ]));
      const facts = JSON.parse(readFileSync(join(root, ".visual-intelligence/graph/lsp-facts.json"), "utf8"));
      expect(facts.reachability.lexical_scope_inherited).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 50000);

  it("treats an ambiguous same-location graph identity as coverage debt, never an arbitrary edge", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-vi-lsp-ambiguous-"));
    try {
      mkdirSync(join(root, ".visual-intelligence", "graph"), { recursive: true });
      writeFileSync(join(root, "a.ts"), "export function target() { return 1; }\nexport function caller() { return target(); }\n");
      const nodes = [
        { id: "file:a.ts", kind: "file", repository_path: "a.ts" },
        { id: "sym:target-a", kind: "symbol", name: "target", repository_path: "a.ts", source_evidence: ["e1"] },
        { id: "sym:target-b", kind: "symbol", name: "target", repository_path: "a.ts", source_evidence: ["e2"] },
        { id: "sym:caller", kind: "symbol", name: "caller", repository_path: "a.ts", source_evidence: ["e3"] },
        { id: "ep:test", kind: "entrypoint" },
      ];
      writeFileSync(join(root, ".visual-intelligence", "graph", "nodes.jsonl"), `${nodes.map(JSON.stringify).join("\n")}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "evidence.jsonl"), `${JSON.stringify({ id: "e1", repository_path: "a.ts", line_start: 1 })}\n${JSON.stringify({ id: "e2", repository_path: "a.ts", line_start: 1 })}\n${JSON.stringify({ id: "e3", repository_path: "a.ts", line_start: 2 })}\n`);
      writeFileSync(join(root, ".visual-intelligence", "graph", "edges.jsonl"), "");
      writeFileSync(join(root, ".visual-intelligence", "manifest.json"), JSON.stringify({ repo_revision: "test", entrypoints: { roots: ["sym:caller"] } }));
      execFileSync("node", [join(repo, "scripts/vi-lsp-facts.mjs"), "--root", root, "--graph", join(root, ".visual-intelligence/graph")], { stdio: "pipe", timeout: 40000 });
      const edges = readFileSync(join(root, ".visual-intelligence/graph/edges.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
      expect(edges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "sym:caller", relation: "calls" }),
      ]));
      const facts = JSON.parse(readFileSync(join(root, ".visual-intelligence/graph/lsp-facts.json"), "utf8"));
      expect(facts.call_hierarchy.in_scope_targets_unmapped).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40000);
});

(rustAvailable ? describe : describe.skip)("vi-lsp-facts Rust projection", () => {
  it("projects a real rust-analyzer caller edge", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-vi-rust-"));
    try {
      mkdirSync(join(root, "src")); mkdirSync(join(root, ".visual-intelligence/graph"), { recursive: true });
      writeFileSync(join(root, "Cargo.toml"), "[package]\nname='x'\nversion='0.1.0'\nedition='2021'\n");
      writeFileSync(join(root, "src/lib.rs"), "pub fn target() -> i32 { 1 }\npub fn caller() -> i32 { target() }\n");
      const ns = [{ id: "file:src/lib.rs", kind: "file", repository_path: "src/lib.rs" }, { id: "sym:target", kind: "symbol", name: "target", repository_path: "src/lib.rs", source_evidence: ["e1"] }, { id: "sym:caller", kind: "symbol", name: "caller", repository_path: "src/lib.rs", source_evidence: ["e2"] }, { id: "ep:test", kind: "entrypoint" }];
      writeFileSync(join(root, ".visual-intelligence/graph/nodes.jsonl"), `${ns.map(JSON.stringify).join("\n")}\n`);
      writeFileSync(join(root, ".visual-intelligence/graph/evidence.jsonl"), `${JSON.stringify({ id: "e1", repository_path: "src/lib.rs", line_start: 1 })}\n${JSON.stringify({ id: "e2", repository_path: "src/lib.rs", line_start: 2 })}\n`); writeFileSync(join(root, ".visual-intelligence/graph/edges.jsonl"), ""); writeFileSync(join(root, ".visual-intelligence/manifest.json"), JSON.stringify({ repo_revision: "test", entrypoints: { roots: ["sym:caller"] } }));
      execFileSync("node", [join(repo, "scripts/vi-lsp-facts.mjs"), "--root", root, "--graph", join(root, ".visual-intelligence/graph"), "--language", "rust"], { stdio: "pipe", timeout: 60000 });
      expect(JSON.parse(readFileSync(join(root, ".visual-intelligence/graph/lsp-facts.json"), "utf8")).call_hierarchy.status).toBe("projected");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 70000);
});
