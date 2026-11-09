/**
 * ADR-111 admits operator-authored hook handlers, but only from inside a
 * signed plugin and only through this loader. Every branch here is a
 * containment guard on code the repository did not write: a path that escapes
 * the plugin root, a non-CommonJS extension, an oversized or empty module, a
 * module that exports no callable, and two modules claiming the same export
 * name. These are precisely the branches that must not be taken on trust.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginHookHandlers } from "../../src/extensibility/plugin-hook-handlers.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function pluginRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-plugin-hooks-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
  return root;
}

const OK = "module.exports = { onPreflight() { return { decision: 'allow' }; } };";

describe("loadPluginHookHandlers containment", () => {
  it("returns an empty registry when a plugin declares no handler modules", () => {
    expect(loadPluginHookHandlers(pluginRoot(), "p1", [])).toEqual({});
  });

  it("loads a well-formed module and namespaces each export under its plugin", () => {
    const root = pluginRoot({ "hooks/a.cjs": OK });
    const registry = loadPluginHookHandlers(root, "p1", ["hooks/a.cjs"]);
    const entry = registry["plugin:p1:onPreflight"];
    expect(entry).toBeDefined();
    // HookHandlerEntry is a union; narrow to the plugin arm before reading
    // fields that only it carries.
    if (entry === undefined || entry.kind !== "plugin") throw new Error("expected a plugin-kind handler entry");
    expect(entry.plugin_id).toBe("p1");
    // The registered handler really calls the plugin's function.
    expect((entry.handler as (context: unknown) => unknown)({})).toEqual({ decision: "allow" });
  });

  it("refuses a path that escapes the plugin root", () => {
    const root = pluginRoot({ "hooks/a.cjs": OK });
    expect(() => loadPluginHookHandlers(root, "p1", ["../outside.cjs"])).toThrow(/escapes its plugin root|unsafe/);
    expect(() => loadPluginHookHandlers(root, "p1", ["hooks/../../outside.cjs"])).toThrow(/escapes its plugin root|unsafe/);
  });

  it("refuses an absolute path, a backslash path, and a non-.cjs extension", () => {
    const root = pluginRoot({ "hooks/a.cjs": OK });
    expect(() => loadPluginHookHandlers(root, "p1", ["/etc/passwd.cjs"])).toThrow(/unsafe/);
    expect(() => loadPluginHookHandlers(root, "p1", ["hooks\\a.cjs"])).toThrow(/unsafe/);
    expect(() => loadPluginHookHandlers(root, "p1", ["hooks/a.js"])).toThrow(/unsafe/);
    expect(() => loadPluginHookHandlers(root, "p1", ["hooks/a.mjs"])).toThrow(/unsafe/);
  });

  it("refuses a declared module that does not exist", () => {
    expect(() => loadPluginHookHandlers(pluginRoot(), "p1", ["hooks/missing.cjs"])).toThrow(/does not exist/);
  });

  it("refuses an empty module", () => {
    const root = pluginRoot({ "hooks/empty.cjs": "" });
    expect(() => loadPluginHookHandlers(root, "p1", ["hooks/empty.cjs"])).toThrow(/empty or oversized/);
  });

  it("refuses a module past the byte ceiling rather than loading it", () => {
    const root = pluginRoot({ "hooks/big.cjs": `// ${"x".repeat(129 * 1024)}\n${OK}` });
    expect(() => loadPluginHookHandlers(root, "p1", ["hooks/big.cjs"])).toThrow(/empty or oversized/);
  });

  it("refuses more modules than the per-plugin ceiling", () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 17; i++) { files[`hooks/m${i}.cjs`] = OK; paths.push(`hooks/m${i}.cjs`); }
    expect(() => loadPluginHookHandlers(pluginRoot(files), "p1", paths)).toThrow(/more than 16 hook_handlers modules/);
  });

  it("refuses a module that exports nothing callable", () => {
    const root = pluginRoot({ "hooks/none.cjs": "module.exports = { notAFunction: 42 };" });
    expect(() => loadPluginHookHandlers(root, "p1", ["hooks/none.cjs"])).toThrow(/exports no functions/);
  });

  it("refuses a module whose export is not an object at all", () => {
    const root = pluginRoot({ "hooks/scalar.cjs": "module.exports = 7;" });
    expect(() => loadPluginHookHandlers(root, "p1", ["hooks/scalar.cjs"])).toThrow(/must export an object of named functions|exports no functions/);
  });

  it("refuses two modules claiming the same export name, which would make dispatch ambiguous", () => {
    const root = pluginRoot({ "hooks/a.cjs": OK, "hooks/b.cjs": OK });
    expect(() => loadPluginHookHandlers(root, "p1", ["hooks/a.cjs", "hooks/b.cjs"]))
      .toThrow(/declared by more than one hook_handlers module/);
  });
});
