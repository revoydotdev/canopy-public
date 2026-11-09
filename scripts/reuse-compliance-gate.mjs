#!/usr/bin/env node
/**
 * ADR-147 bounded reuse-compliance gate.
 *
 * It is intentionally an inventory check, not a clean-room detector or legal
 * clearance. Unknown direct dependencies, absent declared notices, and broken
 * vendored hashes fail closed; transitive and human-provenance questions stay
 * outside this scanner's authority.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const POLICY_FILE = "scripts/reuse-compliance-policy.json";
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function manifests(root) {
  const paths = [join(root, "package.json")];
  const packages = join(root, "packages");
  if (existsSync(packages)) for (const entry of readdirSync(packages, { withFileTypes: true })) {
    const path = join(packages, entry.name, "package.json");
    if (entry.isDirectory() && existsSync(path)) paths.push(path);
  }
  return paths;
}

function directExternalDependencies(root) {
  const names = new Set();
  for (const path of manifests(root)) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) if (!name.startsWith("@arbor/")) names.add(name);
    }
  }
  return [...names].sort();
}

function walk(dir, base = dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, base, files);
    else files.push(relative(base, path));
  }
  return files;
}

export function evaluateReuseCompliance({ root = REPO_ROOT, policyPath = join(root, POLICY_FILE) } = {}) {
  const findings = [];
  if (!existsSync(policyPath)) return { ok: false, findings: [`missing policy: ${policyPath}`], dependencies: 0, vendors: 0 };
  let policy;
  try { policy = JSON.parse(readFileSync(policyPath, "utf8")); }
  catch (error) { return { ok: false, findings: [`invalid policy JSON: ${error.message}`], dependencies: 0, vendors: 0 }; }
  if (policy.schema_version !== 1 || typeof policy.ceiling !== "string" || !policy.direct_dependencies || !Array.isArray(policy.vendored_sources)) {
    return { ok: false, findings: ["policy must declare schema_version 1, ceiling, direct_dependencies, and vendored_sources"], dependencies: 0, vendors: 0 };
  }
  const rootLicense = join(root, policy.repository_license?.path ?? "");
  if (!existsSync(rootLicense)) findings.push(`missing repository license: ${policy.repository_license?.path}`);
  else if (!readFileSync(rootLicense, "utf8").includes(policy.repository_license.required_text)) findings.push(`repository license lacks required notice: ${policy.repository_license.required_text}`);
  const allowed = new Set(policy.allowed_direct_dependency_licenses ?? []);
  const direct = directExternalDependencies(root);
  for (const name of direct) {
    const declared = policy.direct_dependencies[name];
    if (!declared) { findings.push(`direct dependency ${name} is absent from policy inventory`); continue; }
    if (declared.status === "excluded_optional_peer") {
      if (existsSync(join(root, "node_modules", ...name.split("/"), "package.json"))) {
        findings.push(`optional peer ${name} is installed; replace excluded_optional_peer with a reviewed license inventory entry`);
      }
      continue;
    }
    if (typeof declared.license !== "string") { findings.push(`direct dependency ${name} has no declared license`); continue; }
    if (!allowed.has(declared.license)) findings.push(`direct dependency ${name} declares disallowed license ${declared.license}`);
    const installed = join(root, "node_modules", ...name.split("/"), "package.json");
    if (!existsSync(installed)) findings.push(`direct dependency ${name} is not installed for license metadata verification`);
    else {
      const actual = JSON.parse(readFileSync(installed, "utf8")).license;
      if (actual !== declared.license) findings.push(`direct dependency ${name} license mismatch: policy ${declared.license}, installed metadata ${actual ?? "missing"}`);
    }
  }
  for (const name of Object.keys(policy.direct_dependencies)) if (!direct.includes(name)) findings.push(`policy inventory contains no direct dependency named ${name}`);
  for (const vendor of policy.vendored_sources) {
    const directory = join(root, vendor.path);
    const inventoryPath = join(directory, vendor.inventory);
    const attributionPath = join(directory, vendor.attribution);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) { findings.push(`vendored source missing: ${vendor.path}`); continue; }
    if (!existsSync(inventoryPath)) { findings.push(`${vendor.path}: missing inventory ${vendor.inventory}`); continue; }
    let inventory;
    try { inventory = JSON.parse(readFileSync(inventoryPath, "utf8")); }
    catch (error) { findings.push(`${vendor.path}: invalid inventory JSON: ${error.message}`); continue; }
    if (inventory.upstream_license !== vendor.license) findings.push(`${vendor.path}: inventory license ${inventory.upstream_license ?? "missing"} does not match policy ${vendor.license}`);
    if (!existsSync(attributionPath)) findings.push(`${vendor.path}: missing attribution ${vendor.attribution}`);
    else for (const phrase of vendor.attribution_contains ?? []) if (!readFileSync(attributionPath, "utf8").includes(phrase)) findings.push(`${vendor.path}: attribution lacks ${JSON.stringify(phrase)}`);
    const listed = inventory.sha256;
    if (!listed || typeof listed !== "object") { findings.push(`${vendor.path}: inventory has no sha256 map`); continue; }
    for (const [file, expected] of Object.entries(listed)) {
      const path = join(directory, file);
      if (!existsSync(path)) findings.push(`${vendor.path}: listed file missing: ${file}`);
      else if (hash(path) !== expected) findings.push(`${vendor.path}: hash mismatch: ${file}`);
    }
    const exempt = new Set([vendor.inventory, vendor.attribution]);
    for (const file of walk(directory)) if (!exempt.has(file) && !(file in listed)) findings.push(`${vendor.path}: untracked vendored file: ${file}`);
  }
  return { ok: findings.length === 0, findings, dependencies: direct.length, vendors: policy.vendored_sources.length, ceiling: policy.ceiling };
}

function main() {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0 ? resolve(process.argv[rootFlag + 1] ?? "") : REPO_ROOT;
  const report = evaluateReuseCompliance({ root });
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`reuse-compliance gate — ${report.dependencies} direct dependency(ies), ${report.vendors} vendored source(s)`);
    console.log(`  Ceiling: ${report.ceiling ?? "policy unavailable"}`);
    for (const finding of report.findings) console.log(`FAIL  ${finding}`);
    console.log(report.ok ? "PASS — declared inventory, license metadata, notices, attribution, and hashes match" : "FAIL — update the declared inventory/evidence or remove the unclassified material");
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (import.meta.main) main();
