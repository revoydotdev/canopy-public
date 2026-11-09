import { describe, it, expect } from "vitest";
import { readCatalogFromSource } from "@arbor/governance";
import {
  checkDeadEntrypoints,
  checkCliDispatch,
  checkToolRegistration,
  checkCatalogDispatchDrift,
  checkOrphanedScripts,
} from "../registration-integrity.mjs";

describe("registration-integrity: check 1 — dead entrypoints", () => {
  it("flags a process-entry file with no top-level executable statement at all", () => {
    const files = { "empty.ts": `export function helper() { return 1; }\nconst X = 5;\n` };
    const entries = [{ id: "empty", file: "empty.ts", kind: "process-entry" }];
    const violations = checkDeadEntrypoints(entries, (f) => files[f] ?? null);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/no top-level executable statement/);
  });

  it("flags a top-level guard whose body never calls anything, even though the file does have an executable statement", () => {
    const files = {
      "inert.ts": `function main() { console.log("unreached by design of this test"); }\nif (process.env.FOO === "1") { const y = 1; }\n`,
    };
    const entries = [{ id: "inert", file: "inert.ts", kind: "process-entry" }];
    const violations = checkDeadEntrypoints(entries, (f) => files[f] ?? null);
    expect(violations.some((v) => /empty\/no-call body/.test(v.reason))).toBe(true);
  });

  it("flags a top-level main()/run()/serve() declaration that is never invoked anywhere in its own file", () => {
    const files = {
      "uninvoked.ts": `export function main() { console.log("defined but never called"); }\nif (process.env.FOO === "1") { console.log("guard fires but calls something else entirely"); }\n`,
    };
    const entries = [{ id: "uninvoked", file: "uninvoked.ts", kind: "process-entry" }];
    const violations = checkDeadEntrypoints(entries, (f) => files[f] ?? null);
    expect(violations.some((v) => /defines 'main'.*never invokes it/.test(v.reason))).toBe(true);
  });

  it("does not flag a file whose guard fires and calls its own main() (the real, fixed cli.ts shape)", () => {
    const files = {
      "good.ts": `export function main() { console.log("run"); }\nif (process.env.FOO === "1") { main(); }\n`,
    };
    const entries = [{ id: "good", file: "good.ts", kind: "process-entry" }];
    expect(checkDeadEntrypoints(entries, (f) => files[f] ?? null)).toHaveLength(0);
  });

  it("does not flag a library-export entry that defines but never self-invokes its export (that's the whole point of a library export)", () => {
    const files = {
      "plugin.ts": `export function arborPlugin() { return { ok: true }; }\n`,
    };
    const entries = [{ id: "plugin", file: "plugin.ts", kind: "library-export", symbol: "arborPlugin" }];
    expect(checkDeadEntrypoints(entries, (f) => files[f] ?? null)).toHaveLength(0);
  });

  it("skips (never guesses false-DEAD) an entry-point file the reader cannot find", () => {
    const entries = [{ id: "missing", file: "does-not-exist.ts", kind: "process-entry" }];
    expect(checkDeadEntrypoints(entries, () => null)).toHaveLength(0);
  });
});

describe("registration-integrity: check 2 — CLI subcommand dispatch vs. --help text", () => {
  it("flags a dispatched command with no --help documentation, and the inverse (documented but not dispatched)", () => {
    const cli = `
      export function main(args) {
        if (args[0] === "serve") { doServe(); }
        if (args[0] === "mystery") { doMystery(); }
        if (args[0] === "--help" || args.length === 0) {
          environment.stderr.write("arbor-mcp serve — start\\n");
          environment.stderr.write("arbor-mcp webui — start\\n");
          return 0;
        }
      }
    `;
    const { violations } = checkCliDispatch(cli);
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: "undocumented-dispatch", command: "mystery" }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: "undispatched-help-line", command: "webui" }),
    );
  });

  it("resolves a two-token dispatch (devtools tail) against its two-token help line without flagging it", () => {
    const cli = `
      export function main(args) {
        if (args[0] === "devtools" && args[1] === "tail") { tail(); }
        if (args[0] === "--help" || args.length === 0) {
          environment.stderr.write("arbor-mcp devtools tail [<campaign>] — tail the log\\n");
          return 0;
        }
      }
    `;
    expect(checkCliDispatch(cli).violations).toHaveLength(0);
  });

  it("does not flag a fully-consistent dispatch/help pairing", () => {
    const cli = `
      export function main(args) {
        if (args[0] === "serve") { doServe(); }
        if (args[0] === "--help" || args.length === 0) {
          environment.stderr.write("arbor-mcp serve — start\\n");
          return 0;
        }
      }
    `;
    expect(checkCliDispatch(cli).violations).toHaveLength(0);
  });

  it("recognizes the primary arbor name, stdout aliases, and documented option aliases", () => {
    const cli = `
      export function main(args) {
        if (args[0] === "--version" || args[0] === "-V") { showVersion(); }
        if (args[0] === "serve") { doServe(); }
        if (args[0] === "--help" || args.length === 0) {
          const output = environment.stdout;
          output.write("arbor --version (\`-V\`) — print version\\n");
          output.write("arbor serve — start\\n");
          return 0;
        }
      }
    `;
    expect(checkCliDispatch(cli).violations).toHaveLength(0);
  });

  it("does not flag an alias mentioned only in backtick prose next to another command's help line (the real cli.ts `demo` shape)", () => {
    const cli = `
      export function main(args) {
        if (args[0] === "run" || args[0] === "demo") { doRun(); }
        if (args[0] === "--help" || args.length === 0) {
          environment.stderr.write("arbor-mcp run — run a campaign; \`demo\` is an alias\\n");
          return 0;
        }
      }
    `;
    expect(checkCliDispatch(cli).violations).toHaveLength(0);
  });

  it("accepts a top-level dispatcher documented through its nested subcommands", () => {
    const cli = `
      export function main(args) {
        if (args[0] === "plugin") { installPlugin(args.slice(1)); }
        if (args[0] === "--help" || args.length === 0) {
          environment.stderr.write("arbor-mcp plugin install <manifest> — install a plugin\\n");
          return 0;
        }
      }
    `;
    expect(checkCliDispatch(cli).violations).toHaveLength(0);
  });
});

describe("registration-integrity: check 3 — MCP tool registration drift", () => {
  const goodDevtools = `export function defineDevToolsTools() { return [{ name: "dt", description: "ok" }]; }`;

  it("flags a tool-shaped const never included in defineTools's returned array, and a spread of an undefined identifier", () => {
    const tools = `
      const ORPHAN_TOOL = { name: "orphan_tool", description: "never included" };
      export function defineTools() {
        return [
          { name: "real_tool", description: "ok" },
          ...MISSING_SET,
        ];
      }
    `;
    const server = `
      class ArborMCPServer {
        constructor() { this.tools = defineTools(); this.devtoolsTools = defineDevToolsTools(); this.tools.find(() => true); this.devtoolsTools.find(() => true); }
      }
    `;
    const violations = checkToolRegistration(tools, goodDevtools, server);
    expect(violations.some((v) => /orphan_tool.*never included/.test(v.reason))).toBe(true);
    expect(violations.some((v) => /MISSING_SET.*not a top-level declaration/.test(v.reason))).toBe(true);
  });

  it("flags server.ts discarding defineTools's result, and never calling defineDevToolsTools at all", () => {
    const tools = `export function defineTools() { return [{ name: "real_tool", description: "ok" }]; }`;
    const server = `
      class ArborMCPServer {
        constructor() { defineTools(); }
      }
    `;
    const violations = checkToolRegistration(tools, goodDevtools, server);
    expect(violations.some((v) => /discarded/.test(v.reason))).toBe(true);
    expect(violations.some((v) => /defineDevToolsTools' is never called/.test(v.reason))).toBe(true);
  });

  it("flags a captured registration that is never read again (registered but never dispatched)", () => {
    const tools = `export function defineTools() { return [{ name: "real_tool", description: "ok" }]; }`;
    const server = `
      class ArborMCPServer {
        constructor() { this.tools = defineTools(); this.devtoolsTools = defineDevToolsTools(); this.devtoolsTools.find(() => true); }
      }
    `;
    const violations = checkToolRegistration(tools, goodDevtools, server);
    expect(violations.some((v) => /this\.tools.*never read again/.test(v.reason))).toBe(true);
  });

  it("does not flag the real repo's own inline-array, fully-wired shape", () => {
    const tools = `export function defineTools() { return [{ name: "real_tool", description: "ok" }]; }`;
    const server = `
      class ArborMCPServer {
        constructor() {
          this.tools = defineTools();
          this.devtoolsTools = defineDevToolsTools();
        }
        callTool(name) {
          return this.tools.find((t) => t.name === name) ?? this.devtoolsTools.find((t) => t.name === name);
        }
      }
    `;
    expect(checkToolRegistration(tools, goodDevtools, server)).toHaveLength(0);
  });
});

describe("registration-integrity: check 4 — RUNTIME_CATALOG / dispatch drift", () => {
  it("flags a supported:true kind with zero dispatch reference anywhere (the real G-29 shape)", () => {
    const catalog = `
      export const RUNTIME_CATALOG = [
        { kind: "foo.bar", direction: "query", capability: "x", idempotency: "not_applicable", supported: true },
      ] as const;
    `;
    const { violations } = checkCatalogDispatchDrift(catalog, readCatalogFromSource(catalog, "runtime-catalog.ts"));
    expect(violations).toContainEqual(expect.objectContaining({ kind: "foo.bar" }));
  });

  it("flags a dispatch reference to a kind absent from the catalog entirely (the inverse)", () => {
    const catalog = `
      export const RUNTIME_CATALOG = [
        { kind: "foo.bar", direction: "query", capability: "x", idempotency: "not_applicable", supported: true },
      ] as const;
      function exec(envelope) {
        switch (envelope.query.kind) {
          case "foo.bar": return 1;
          case "ghost.kind": return 2;
        }
      }
    `;
    const { violations } = checkCatalogDispatchDrift(catalog, readCatalogFromSource(catalog, "runtime-catalog.ts"));
    expect(violations).toContainEqual(expect.objectContaining({ kind: "ghost.kind" }));
  });

  it("does not flag a supported:false kind with no dispatch reference (the catalog's own supported flag is the allowlist)", () => {
    const catalog = `
      export const RUNTIME_CATALOG = [
        { kind: "future.thing", direction: "query", capability: "x", idempotency: "not_applicable", supported: false, unavailable_reason: "not wired yet" },
      ] as const;
    `;
    expect(checkCatalogDispatchDrift(catalog, readCatalogFromSource(catalog, "runtime-catalog.ts")).violations).toHaveLength(0);
  });

  it("does not flag a kind whose only wiring is the implicit else-branch of a two-variant kind check (the real compaction.list/userinput.list shape)", () => {
    const catalog = `
      export const RUNTIME_CATALOG = [
        { kind: "thing.alpha", direction: "query", capability: "x", idempotency: "not_applicable", supported: true },
        { kind: "thing.beta", direction: "query", capability: "x", idempotency: "not_applicable", supported: true },
      ] as const;
      function exec(envelope) {
        if (envelope.query.kind === "thing.beta") return specialCase();
        return defaultCase();
      }
    `;
    expect(checkCatalogDispatchDrift(catalog, readCatalogFromSource(catalog, "runtime-catalog.ts")).violations).toHaveLength(0);
  });

  it("recognizes a namespaced kind guard and ignores unrelated bare result discriminants", () => {
    const catalog = `
      export const RUNTIME_CATALOG = [
        { kind: "composer.submit", direction: "command", capability: "x", idempotency: "required", supported: true },
      ] as const;
      function accepts(input) {
        if (input.command.kind.startsWith("composer.")) return dispatch(input);
        return input.result.kind === "unavailable";
      }
    `;
    expect(checkCatalogDispatchDrift(catalog, readCatalogFromSource(catalog, "runtime-catalog.ts")).violations).toHaveLength(0);
  });
});

describe("registration-integrity: check 5 — orphaned scripts/*.mjs gates", () => {
  it("flags a self-declared gate script with no matching package.json entry", () => {
    const scriptFiles = [{ basename: "foo-gate.mjs", text: "/**\n * Usage:\n *   bun run gate:foo\n */\n" }];
    const violations = checkOrphanedScripts(scriptFiles, {});
    expect(violations.some((v) => v.file === "foo-gate.mjs" && /no "gate:foo" script/.test(v.reason))).toBe(true);
  });

  it("flags a gate:* package.json entry that points at a scripts/*.mjs file which does not exist (the inverse)", () => {
    const violations = checkOrphanedScripts([], { "gate:ghost": "bun scripts/ghost.mjs" });
    expect(violations).toContainEqual(expect.objectContaining({ file: "ghost.mjs" }));
  });

  it("does not flag a gate whose declared name matches a real package.json entry", () => {
    const scriptFiles = [{ basename: "foo-gate.mjs", text: "/**\n * Usage:\n *   bun run gate:foo\n */\n" }];
    expect(checkOrphanedScripts(scriptFiles, { "gate:foo": "bun scripts/foo-gate.mjs" })).toHaveLength(0);
  });

  it("does not flag a pure library script that merely mentions the word 'gate' describing a DIFFERENT file (the real anti-stub-rules.mjs/roundtrip-shape.mjs shape)", () => {
    const scriptFiles = [{
      basename: "helper-rules.mjs",
      text: "/**\n * scripts/helper-rules.mjs — shared rule bodies for the foo gate (scripts/foo.mjs).\n */\nexport function rule() { return true; }\n",
    }];
    expect(checkOrphanedScripts(scriptFiles, {})).toHaveLength(0);
  });

  it("does not flag a real CLI utility bound under a non-gate script name (the real install-git-hooks.mjs shape)", () => {
    const scriptFiles = [{
      basename: "install-thing.mjs",
      text: "/**\n * scripts/install-thing.mjs — installs a thing.\n *\n * Usage:\n *   bun scripts/install-thing.mjs\n */\nprocess.exit(0);\n",
    }];
    expect(checkOrphanedScripts(scriptFiles, { "install-thing": "bun scripts/install-thing.mjs" })).toHaveLength(0);
  });
});
