import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectViPrepushMode } from "../vi-prepush-policy-gate.mjs";
import { computeViInputBinding, viProducerChangedPaths } from "../lib/vi-input-binding.mjs";

const temporaryRoots = [];
afterEach(() => { while (temporaryRoots.length) rmSync(temporaryRoots.pop(), { recursive: true, force: true }); });

describe("VI exact binding and prepush reproduction policy", () => {
  it("keeps ordinary source changes on the exact-binding path", () => {
    expect(selectViPrepushMode(["packages/arbor-tui/src/app.ts", "decisions/ADR-147-example.md"])).toEqual({ mode: "exact_binding_only", producer_changes: [] });
  });

  it("requires full reproduction when the producer, roots, or vendored tool changed", () => {
    const paths = ["scripts/vi-refresh.mjs", "scripts/reachability/entry-points.json", ".claude/skills/repository-visual-intelligence/scripts/vi-extract-ts.mjs"];
    expect(viProducerChangedPaths(paths)).toEqual(paths);
    expect(selectViPrepushMode(paths)).toMatchObject({ mode: "full_reproduction", producer_changes: paths });
  });

  it("changes for tracked producer inputs but not generated graph bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "vi-binding-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "packages", "demo"), { recursive: true });
    mkdirSync(join(root, ".visual-intelligence", "graph"), { recursive: true });
    writeFileSync(join(root, "packages", "demo", "index.ts"), "export const value = 1;\n");
    writeFileSync(join(root, ".visual-intelligence", "graph", "nodes.jsonl"), "first graph\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });

    const initial = computeViInputBinding(root);
    writeFileSync(join(root, ".visual-intelligence", "graph", "nodes.jsonl"), "second graph\n");
    expect(computeViInputBinding(root)).toEqual(initial);
    writeFileSync(join(root, "packages", "demo", "index.ts"), "export const value = 2;\n");
    expect(computeViInputBinding(root).content_hash).not.toBe(initial.content_hash);
  });

  it("binds citation roots that can mint intent nodes outside source roots", () => {
    const root = mkdtempSync(join(tmpdir(), "vi-citation-binding-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "packages", "demo"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "packages", "demo", "index.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "scripts", "gate.mjs"), "// no citation yet\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });

    const profile = { source_roots: ["packages"], citation_roots: ["packages", "scripts"] };
    const initial = computeViInputBinding(root, { profile });
    writeFileSync(join(root, "scripts", "gate.mjs"), "// ADR-147 now mints an intent edge\n");
    expect(computeViInputBinding(root, { profile }).content_hash).not.toBe(initial.content_hash);
  });
});
