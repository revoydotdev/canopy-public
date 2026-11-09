#!/usr/bin/env node
/**
 * ADR-147 package-boundary gate.
 *
 * The policy is deliberately a bounded import matrix: it examines literal
 * workspace specifiers in package src/ and tests/ files.  It proves neither
 * runtime reachability nor that an allowed dependency is a good abstraction.
 *
 * Workspace specifiers are checked against the per-package allowlists.
 * Relative specifiers are resolved lexically against the importing file and
 * checked against the top-level `forbidden_source_roots` — notably `scripts/`,
 * because a `packages/` file reaching into `scripts/` inverts the boundary
 * (the convention `packages/arbor-mcp/src/project-registry.ts` documents by
 * shelling out instead).  `imports` counts workspace specifiers only.
 */
import ts from "typescript";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const POLICY_FILE = "scripts/package-boundary-policy.json";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) files.push(path);
  }
  return files;
}

function packageSpecifiers(path) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const specs = new Set();
  const visit = (node) => {
    let text = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) text = node.moduleSpecifier.text;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) text = node.arguments[0].text;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) text = node.argument.literal.text;
    if (text?.startsWith("@arbor/") || text?.startsWith("./") || text?.startsWith("../")) specs.add(text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...specs].sort();
}

function fail(findings, message) { findings.push(message); }

export function evaluatePackageBoundaries({ root = REPO_ROOT, policyPath = join(root, POLICY_FILE) } = {}) {
  const findings = [];
  if (!existsSync(policyPath)) return { ok: false, findings: [`missing policy: ${policyPath}`], packages: 0, imports: 0 };
  let policy;
  try { policy = JSON.parse(readFileSync(policyPath, "utf8")); }
  catch (error) { return { ok: false, findings: [`invalid policy JSON: ${error.message}`], packages: 0, imports: 0 }; }
  if (policy.schema_version !== 1 || !policy.packages || typeof policy.packages !== "object") {
    return { ok: false, findings: ["policy must declare schema_version 1 and packages"], packages: 0, imports: 0 };
  }
  const forbiddenRoots = policy.forbidden_source_roots;
  if (forbiddenRoots !== undefined && (!Array.isArray(forbiddenRoots) || new Set(forbiddenRoots).size !== forbiddenRoots.length || forbiddenRoots.some((entry) => typeof entry !== "string"))) {
    return { ok: false, findings: ["forbidden_source_roots must be a duplicate-free array"], packages: 0, imports: 0 };
  }
  const forbiddenSourceRoots = (forbiddenRoots ?? []).map((entry) => resolve(root, entry));
  const packageRoot = join(root, "packages");
  const manifests = existsSync(packageRoot) ? readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packageRoot, entry.name, "package.json"))) : [];
  const seen = new Set();
  let imports = 0;
  for (const entry of manifests) {
    const directory = join(packageRoot, entry.name);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const name = manifest.name;
    const rule = policy.packages[name];
    if (!rule) { fail(findings, `${name}: missing policy entry`); continue; }
    seen.add(name);
    if (rule.path !== relative(root, directory).replaceAll("\\", "/")) fail(findings, `${name}: policy path ${rule.path} does not match package path`);
    for (const [kind, allowed] of [["source_imports", rule.source_imports], ["test_imports", rule.test_imports]]) {
      if (!Array.isArray(allowed) || new Set(allowed).size !== allowed.length) { fail(findings, `${name}: ${kind} must be a duplicate-free array`); continue; }
    }
    for (const [directoryName, policyField] of [["src", "source_imports"], ["tests", "test_imports"]]) {
      const allowed = new Set(rule[policyField] ?? []);
      for (const file of walk(join(directory, directoryName))) {
        for (const specifier of packageSpecifiers(file)) {
          if (!specifier.startsWith("@arbor/")) {
            // ponytail: lexical resolution, not realpath — a symlinked workspace
            // resolving outside the root would turn this into a false positive.
            const resolved = resolve(dirname(file), specifier);
            if (forbiddenSourceRoots.some((forbidden) => resolved === forbidden || resolved.startsWith(forbidden + sep))) {
              fail(findings, `${relative(root, file)}: ${specifier} is not permitted by ${name}.forbidden_source_roots`);
            }
            continue;
          }
          imports++;
          if (!allowed.has(specifier)) fail(findings, `${relative(root, file)}: ${specifier} is not permitted by ${name}.${policyField}`);
        }
      }
    }
    if (name === "@arbor/core" && (rule.source_imports.length !== 0 || rule.test_imports.length !== 0)) {
      fail(findings, "@arbor/core: no-internal-dependency rule requires empty source_imports and test_imports");
    }
  }
  for (const name of Object.keys(policy.packages)) if (!seen.has(name)) fail(findings, `${name}: policy names no workspace package`);
  return { ok: findings.length === 0, findings, packages: manifests.length, imports };
}

function main() {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0 ? resolve(process.argv[rootFlag + 1] ?? "") : REPO_ROOT;
  const report = evaluatePackageBoundaries({ root });
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`package-boundary gate — ${report.packages} workspace package(s), ${report.imports} workspace import(s)`);
    for (const finding of report.findings) console.log(`FAIL  ${finding}`);
    console.log(report.ok ? "PASS" : "FAIL — update scripts/package-boundary-policy.json or remove the forbidden import");
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (import.meta.main) main();
