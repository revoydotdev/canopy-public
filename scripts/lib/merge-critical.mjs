import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const MERGE_CRITICAL_REGISTRY = "docs/merge-critical-properties.jsonc";

function stripJsonc(input) {
  let output = "", quoted = false, escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; output += character; continue; }
    if (character === "/" && input[index + 1] === "/") {
      index += 2;
      while (index < input.length && !"\r\n".includes(input[index])) index += 1;
      if (index < input.length) output += input[index];
      continue;
    }
    if (character === "/" && input[index + 1] === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += character;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function normalizedPath(path) {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

function validRelativePath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..");
}

export function globMatches(pattern, candidate) {
  const glob = normalizedPath(pattern);
  const path = normalizedPath(candidate);
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") { index += 1; expression += "(?:.*/)?"; }
      else expression += ".*";
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(path);
}

export function loadMergeCriticalRegistry(repo, registryPath = MERGE_CRITICAL_REGISTRY) {
  const absolute = resolve(repo, registryPath);
  if (!existsSync(absolute)) return null;
  let parsed;
  try { parsed = JSON.parse(stripJsonc(readFileSync(absolute, "utf8"))); }
  catch (error) { throw new Error(`invalid merge-critical registry: ${error instanceof Error ? error.message : String(error)}`); }
  return parsed;
}

export function verifyMergeCriticalRegistry(repo, registry = loadMergeCriticalRegistry(repo)) {
  const errors = [];
  if (registry === null) return { ok: false, errors: [`missing ${MERGE_CRITICAL_REGISTRY}`], properties: [] };
  if (registry.schema_version !== 1) errors.push("schema_version must equal 1");
  if (!Array.isArray(registry.properties) || registry.properties.length === 0) errors.push("properties must be a non-empty array");
  const decisions = existsSync(join(repo, "decisions")) ? readdirSync(join(repo, "decisions")) : [];
  const ids = new Set();
  for (const [index, property] of (Array.isArray(registry.properties) ? registry.properties : []).entries()) {
    const label = `properties[${index}]`;
    if (property === null || typeof property !== "object" || Array.isArray(property)) { errors.push(`${label} must be an object`); continue; }
    if (typeof property.property_id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(property.property_id)) errors.push(`${label}.property_id must be a stable slug`);
    else if (ids.has(property.property_id)) errors.push(`duplicate property_id ${property.property_id}`);
    else ids.add(property.property_id);
    if (typeof property.adr !== "string" || !/^ADR-\d{3}$/.test(property.adr)) errors.push(`${label}.adr must have the form ADR-NNN`);
    else if (decisions.filter((name) => name.startsWith(`${property.adr}-`) && name.endsWith(".md")).length !== 1) errors.push(`${label}.adr does not resolve to exactly one decision: ${property.adr}`);
    if (typeof property.statement !== "string" || property.statement.trim().length === 0) errors.push(`${label}.statement must be non-empty`);
    if (!Array.isArray(property.watch_globs) || property.watch_globs.length === 0) errors.push(`${label}.watch_globs must be non-empty`);
    else for (const glob of property.watch_globs) if (!validRelativePath(glob)) errors.push(`${label}.watch_globs contains an unsafe path`);
    if (!validRelativePath(property.test_id)) errors.push(`${label}.test_id must be a repository-relative path`);
    else {
      const testPath = resolve(repo, property.test_id);
      const withinRepo = relative(resolve(repo), testPath);
      if (withinRepo.startsWith("..") || !existsSync(testPath) || !statSync(testPath).isFile()) errors.push(`${label}.test_id is unreachable: ${property.test_id}`);
      else if (!/\.test\.(?:[cm]?[jt]s|tsx)$/.test(property.test_id)) errors.push(`${label}.test_id is not a collected test file: ${property.test_id}`);
    }
  }
  return { ok: errors.length === 0, errors, properties: Array.isArray(registry.properties) ? registry.properties : [] };
}

export function selectMergeCriticalProperties(properties, changedPaths, registryPath = MERGE_CRITICAL_REGISTRY) {
  const changed = [...new Set(changedPaths.map(normalizedPath))];
  if (changed.includes(normalizedPath(registryPath))) return [...properties];
  return properties.filter((property) => changed.some((path) =>
    path === normalizedPath(property.test_id)
    || globMatches(`decisions/${property.adr}-*.md`, path)
    || property.watch_globs.some((glob) => globMatches(glob, path))
  ));
}

function gitChangedPaths(repo, range) {
  const result = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMRTUXB", range, "--"], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot inspect merge diff ${range}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function defaultTestRunner(repo, testId) {
  const result = spawnSync("bun", ["x", "vitest", "run", testId], { cwd: repo, encoding: "utf8", env: process.env });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function runMergeCriticalCheck({ repo, range, changedPaths, registryPath = MERGE_CRITICAL_REGISTRY, runTest = defaultTestRunner, log = () => {} }) {
  const registry = loadMergeCriticalRegistry(repo, registryPath);
  const integrity = verifyMergeCriticalRegistry(repo, registry);
  if (!integrity.ok) return { ok: false, state: "registry_invalid", errors: integrity.errors, selected: [], results: [] };
  const paths = changedPaths ?? gitChangedPaths(repo, range);
  const selected = selectMergeCriticalProperties(integrity.properties, paths, registryPath);
  const results = [];
  for (const property of selected) {
    log(`[merge-critical] ${property.adr} ${property.property_id}: ${property.statement}`);
    const result = runTest(repo, property.test_id, property);
    results.push({ property_id: property.property_id, adr: property.adr, statement: property.statement, test_id: property.test_id, ...result });
  }
  return { ok: results.every((result) => result.status === 0), state: results.every((result) => result.status === 0) ? "passed" : "property_failed", changed_paths: paths, selected: selected.map((property) => property.property_id), results };
}
