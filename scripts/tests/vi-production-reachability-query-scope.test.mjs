/**
 * The production reachability queries are public-runtime-surface checks, not
 * inventories of every lexical binding or of source/config files.  The LSP
 * projection deliberately inventories locals for other evidence purposes;
 * treating each local as an independently callable node made this query's
 * result overwhelmingly noise (ADR-042 finding triage cannot resolve that).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runQuery } from "../../.claude/skills/repository-visual-intelligence/scripts/lib/queries.mjs";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const pack = JSON.parse(readFileSync(join(REPO_ROOT, ".visual-intelligence", "queries", "queries.json"), "utf8"));

const node = (id, kind, attributes = {}, repository_path = "packages/arbor-demo/src/example.ts") => ({
  id, kind, name: id, repository_path, attributes,
});
const edge = (source, relation, target) => ({ id: `${source}:${relation}:${target}`, source, relation, target });

function query(name) {
  const found = pack.queries.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing ${name} query`);
  return found;
}

describe("production reachability query scope", () => {
  it("does not call a declared entrypoint root an orphan merely because it has no callers", () => {
    const root = node("ep:root", "entrypoint");
    const publicApi = node("sym:public-api", "symbol", { exported: true });
    const dormantExport = node("sym:dormant", "symbol", { exported: true });
    const graph = {
      nodes: [root, publicApi, dormantExport],
      edges: [edge(publicApi.id, "reachable_from", root.id)],
    };

    const result = runQuery(query("orphans-no-inbound"), graph);

    expect(result.results.map((hit) => hit.id)).toEqual(["sym:dormant"]);
  });

  it("reports only an unreached exported symbol, never a local binding or file node", () => {
    const exported = node("sym:exported", "symbol", { exported: true });
    const local = node("sym:local", "symbol", { exported: false, declaration: "VariableDeclaration" });
    const file = node("file:example", "file");
    const rooted = node("sym:rooted", "symbol", { exported: true });
    const root = node("ep:root", "entrypoint");
    const graph = { nodes: [exported, local, file, rooted, root], edges: [edge(rooted.id, "reachable_from", root.id)] };

    const result = runQuery(query("unreachable-production"), graph);

    expect(result.results.map((hit) => hit.id)).toEqual(["sym:exported"]);
  });

  it("reports only an exported symbol with test evidence as test-only reachable", () => {
    const exported = node("sym:exported", "symbol", { exported: true });
    const local = node("sym:local", "symbol", { exported: false, declaration: "VariableDeclaration" });
    const file = node("file:example", "file");
    const test = node("file:test", "file", { is_test: true }, "packages/arbor-demo/tests/example.test.ts");
    const rooted = node("sym:rooted", "symbol", { exported: true });
    const root = node("ep:root", "entrypoint");
    const graph = {
      nodes: [exported, local, file, test, rooted, root],
      edges: [
        edge(test.id, "tests", exported.id), edge(test.id, "tests", local.id), edge(test.id, "tests", file.id),
        edge(rooted.id, "reachable_from", root.id),
      ],
    };

    const result = runQuery(query("test-only-reachable"), graph);

    expect(result.results.map((hit) => hit.id)).toEqual(["sym:exported"]);
  });
});
