import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findSubprocessOutputJsonParses } from "../anti-stub-rules.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseWithChecker(source, fileName = join(REPO_ROOT, ".anti-stub-rule4-fixture.ts")) {
  const absoluteFile = resolve(fileName);
  const options = { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, skipLibCheck: true, types: ["node"] };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(name) === absoluteFile
      ? ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.TS)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = (name) => resolve(name) === absoluteFile || fileExists(name);
  host.readFile = (name) => resolve(name) === absoluteFile ? source : readFile(name);
  const program = ts.createProgram([absoluteFile], options, host);
  return { sourceFile: program.getSourceFile(absoluteFile), checker: program.getTypeChecker() };
}

function parseLines(source) {
  const { sourceFile, checker } = parseWithChecker(source);
  return findSubprocessOutputJsonParses(sourceFile, checker)
    .map((node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
}

describe("anti-stub Rule 4 — subprocess JSON input provenance", () => {
  it("finds JSON.parse of direct output, spawnSync output, aliases, and exec callbacks", () => {
    const source = `
      import { execFileSync, spawnSync, execFile } from "node:child_process";
      function direct() { return JSON.parse(execFileSync("tool", [], { encoding: "utf8" })); }
      function spawned() {
        const child = spawnSync("tool", [], { encoding: "utf8" });
        const stdout = child.stdout;
        return JSON.parse(stdout);
      }
      function callback() {
        execFile("tool", [], (_error, stdout) => { JSON.parse(stdout); });
      }
    `;
    expect(parseLines(source)).toHaveLength(3);
  });

  it("does not treat independent persisted JSON parsing as subprocess text in process-owning files", () => {
    const store = readFileSync(join(REPO_ROOT, "packages/arbor-governance/src/record/store.ts"), "utf8");
    const journal = readFileSync(join(REPO_ROOT, "packages/arbor-mcp/src/canopy-debug-journal.ts"), "utf8");
    expect(store).toContain("JSON.parse(line)");
    expect(store).toContain('JSON.parse(readFileSync(this.index_path, "utf8"))');
    expect(journal).toContain('JSON.parse(String(row[key]))');
    expect(journal).toContain('JSON.parse(String(row.metadata_json))');
    const storeProgram = parseWithChecker(store, join(REPO_ROOT, "packages/arbor-governance/src/record/store.ts"));
    const journalProgram = parseWithChecker(journal, join(REPO_ROOT, "packages/arbor-mcp/src/canopy-debug-journal.ts"));
    expect(findSubprocessOutputJsonParses(storeProgram.sourceFile, storeProgram.checker)).toHaveLength(0);
    expect(findSubprocessOutputJsonParses(journalProgram.sourceFile, journalProgram.checker)).toHaveLength(0);
  });

  it("does not confuse a local function named exec with child_process output", () => {
    expect(parseLines(`
      function exec(command: string) { return command; }
      function parseConfig() { return JSON.parse(exec("read config")); }
    `)).toEqual([]);
  });

  it("keeps output taint bound to its symbol when another function shadows the name", () => {
    const source = `
      import { execSync } from "node:child_process";
      import { readFileSync } from "node:fs";
      const output = execSync("tool");
      function parsePersisted() {
        const output = readFileSync("config.json", "utf8");
        return JSON.parse(output);
      }
      function parseProcessOutput() { return JSON.parse(output); }
    `;
    const { sourceFile, checker } = parseWithChecker(source);
    const parses = findSubprocessOutputJsonParses(sourceFile, checker);
    expect(parses).toHaveLength(1);
    expect(parses[0].getText(sourceFile)).toBe("JSON.parse(output)");
    expect(sourceFile.getLineAndCharacterOfPosition(parses[0].getStart(sourceFile)).line + 1).toBe(9);
  });

  it("supports CommonJS namespace and destructured child_process requires", () => {
    expect(parseLines(`
      const cp = require("node:child_process");
      const direct = cp.execFileSync("tool");
      JSON.parse(direct);
      const { spawnSync: run } = require("child_process");
      const result = run("tool");
      JSON.parse(result.stdout);
      const { execSync } = require("node:child_process");
      JSON.parse(execSync("tool"));
    `)).toHaveLength(3);
  });

  it("finds CommonJS require bindings nested in function and block scopes", () => {
    expect(parseLines(`
      function nested() {
        const cp = require("node:child_process");
        const output = cp.execSync("tool");
        JSON.parse(output);
        {
          const { spawnSync: run } = require("node:child_process");
          const result = run("tool");
          JSON.parse(result.stdout);
        }
      }
    `)).toHaveLength(2);
  });

  it("does not treat a local function named require as Node's CommonJS builtin", () => {
    expect(parseLines(`
      function require(_name: string) { return { execSync: (_command: string) => "{}" }; }
      function parseLookalike() {
        const cp = require("node:child_process");
        return JSON.parse(cp.execSync("not a process"));
      }
    `)).toEqual([]);
  });

  it("follows named exec and stream-data callbacks without tainting unrelated same-name parameters", () => {
    expect(parseLines(`
      import { execFile, spawn } from "node:child_process";
      function parseExec(_error: unknown, stdout: string) { JSON.parse(stdout); }
      function parseData(data: string) { JSON.parse(data); }
      function unrelated(stdout: string) { JSON.parse(stdout); }
      execFile("tool", [], parseExec);
      const child = spawn("tool");
      child.stdout?.on("data", parseData);
    `)).toHaveLength(2);
  });
});
