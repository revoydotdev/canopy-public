#!/usr/bin/env node
/**
 * Validate the standard durable-artifact metadata block described by
 * docs/artifact-metadata.schema.json.
 *
 * Usage: bun scripts/docs-metadata.mjs [--json] [--require-headers] <file-or-dir>...
 * With no paths, checks the canonical planning set. Unclassified legacy files
 * are reported as unclassified only when --require-headers is supplied.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(ROOT, "docs/artifact-metadata.schema.json");
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const FIELD_ORDER = SCHEMA["x-header-format"]["field-order"];
const FIELDS = new Set(FIELD_ORDER);
const KIND_ENUM = new Set(SCHEMA.properties["Artifact kind"].enum);
const STATUS_ENUM = new Set(SCHEMA.properties.Status.enum);
const EVIDENCE_ENUM = new Set(["observed", "inferred", "target", "mixed"]);

// Templates are scaffolds for future artifacts, not durable artifacts themselves
// (docs/roadmap-1.0.0-and-documentation-governance.md, Phase 0), so they carry no header.
const TEMPLATE_PATHS = new Set(["docs/roadmaps/handoffs/TEMPLATE.md"]);

export function isTemplate(repoRoot, file) {
  return TEMPLATE_PATHS.has(relative(repoRoot, file).split(sep).join("/"));
}

function markdownFiles(path) {
  const absolute = resolve(ROOT, path);
  let info;
  try { info = statSync(absolute); } catch { return []; }
  if (info.isFile()) return extname(absolute).toLowerCase() === ".md" ? [absolute] : [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") return [];
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) return markdownFiles(child);
    return entry.isFile() && extname(entry.name).toLowerCase() === ".md" ? [child] : [];
  });
}

function parseHeader(source) {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (titleIndex < 0) {
    const hasMetadata = lines.some((line) => /^(Artifact kind|Status|Revision|As-of commit|Authority|Evidence scope|Supersedes|Superseded by|Owner|Review trigger)(:|\b)/.test(line));
    return { present: hasMetadata, fields: {}, issues: hasMetadata ? [{ code: "missing-title", line: 1, message: "metadata document must begin with a Markdown title" }] : [] };
  }
  const fields = {};
  const issues = [];
  const seen = new Set();
  let present = false;
  let previousOrder = -1;
  let start = titleIndex + 1;
  while (lines[start]?.trim() === "") start++;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    const match = /^([^:]+):\s*(.*?)\s*$/.exec(line);
    const candidateKey = match?.[1]?.trim() ?? line.trim().replace(/:.*$/, "");
    if (!FIELDS.has(candidateKey)) {
      if (FIELDS.has(candidateKey) || /^(Artifact kind|Status|Revision|As-of commit|Authority|Evidence scope|Supersedes|Superseded by|Owner|Review trigger)\b/.test(line)) {
        present = true;
        issues.push({ code: "malformed-header-line", line: i + 1, message: `malformed metadata field: ${line}` });
        continue;
      }
      break;
    }
    present = true;
    if (!match) {
      issues.push({ code: "malformed-header-line", line: i + 1, message: `metadata field must use “Name: value”: ${line}` });
      continue;
    }
    const key = match[1].trim();
    if (seen.has(key)) {
      issues.push({ code: key === "Artifact kind" ? "duplicate-kind" : "duplicate-field", line: i + 1, message: `metadata field “${key}” appears more than once` });
      continue;
    }
    seen.add(key);
    fields[key] = match[2];
    const order = FIELD_ORDER.indexOf(key);
    if (order < previousOrder) issues.push({ code: "field-order", line: i + 1, message: `metadata field “${key}” is out of order` });
    previousOrder = order;
  }
  return { present, fields, issues, lines };
}

function checkHeader(parsed) {
  const issues = [...parsed.issues];
  if (!parsed.present) return issues;
  for (const field of FIELD_ORDER) {
    if (!(field in parsed.fields)) issues.push({ code: "missing-field", line: 1, message: `required metadata field “${field}” is missing` });
    else if (!parsed.fields[field].trim()) issues.push({ code: "empty-field", line: 1, message: `metadata field “${field}” must not be empty` });
  }
  const { fields } = parsed;
  if (fields["Artifact kind"] && !KIND_ENUM.has(fields["Artifact kind"])) issues.push({ code: "unknown-kind", line: 1, message: `unknown artifact kind “${fields["Artifact kind"]}”` });
  if (fields.Status && !STATUS_ENUM.has(fields.Status)) issues.push({ code: "unknown-status", line: 1, message: `status “${fields.Status}” is outside the documented vocabulary` });
  if (fields.Revision && !/^[1-9]\d*$/.test(fields.Revision)) issues.push({ code: "invalid-revision", line: 1, message: "Revision must be a positive integer" });
  if (fields["As-of commit"] && !/^[0-9a-fA-F]{7,40}( \(\d{4}-\d{2}-\d{2}\))?$/.test(fields["As-of commit"])) issues.push({ code: "invalid-revision-id", line: 1, message: "As-of commit must be a 7–40 character hexadecimal Git revision, optionally followed by its recorded date" });
  if (fields["Evidence scope"]) {
    const scope = /^(observed|inferred|target|mixed)\s+[—:-]\s+(.+)$/i.exec(fields["Evidence scope"]);
    if (!scope || !EVIDENCE_ENUM.has(scope[1].toLowerCase())) issues.push({ code: "invalid-evidence-scope", line: 1, message: "Evidence scope must name observed, inferred, target, or mixed and state its boundary" });
  }
  return issues;
}

function headingSlugs(source) {
  return new Set(source.split(/\r?\n/).flatMap((line) => {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return [];
    return [match[1].toLowerCase().replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/\s+/g, "-")];
  }));
}

function localLinkIssues(file, source, repoRoot = ROOT) {
  const issues = [];
  const lines = source.split(/\r?\n/);
  const slugCache = new Map([[file, headingSlugs(source)]]);
  const resolveTarget = (rawTarget, lineNumber, rootRelative = false) => {
    let target;
    try { target = decodeURIComponent(rawTarget); } catch { target = rawTarget; }
    if (!target || target.startsWith("#")) {
      if (!target) return;
      const fragment = target.slice(1);
      if (!slugCache.get(file).has(fragment)) issues.push({ code: "unresolved-local-link", line: lineNumber, message: `fragment “#${fragment}” does not match a heading in this document` });
      return;
    }
    if (/^(?:[a-z]+:|\/\/)/i.test(target)) return;
    const [pathname, fragment] = target.split("#", 2);
    const cleanPath = pathname.split("?", 1)[0];
    const fromRoot = resolve(repoRoot, cleanPath.replace(/^\//, ""));
    const fromDocument = resolve(dirname(file), cleanPath);
    const destination = cleanPath.startsWith("/") || rootRelative ? fromRoot : fromDocument;
    let exists = false;
    try { exists = statSync(destination).isFile(); } catch {}
    if (!exists) {
      issues.push({ code: "unresolved-local-link", line: lineNumber, message: `local link target “${pathname}” does not exist` });
      return;
    }
    if (fragment && extname(destination).toLowerCase() === ".md") {
      let slugs = slugCache.get(destination);
      if (!slugs) {
        try { slugs = headingSlugs(readFileSync(destination, "utf8")); } catch { slugs = new Set(); }
        slugCache.set(destination, slugs);
      }
      if (!slugs.has(fragment)) issues.push({ code: "unresolved-local-link", line: lineNumber, message: `fragment “#${fragment}” does not match a heading in ${relative(repoRoot, destination).split(sep).join("/")}` });
    }
  };
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    // Inline Markdown links and images. Reference-style links are not expanded
    // here because resolution depends on a separate, document-wide definition pass.
    for (const match of lines[i].matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) resolveTarget(match[1].replace(/^<|>$/g, ""), i + 1);
  }
  // The roadmap's successor fields permit concise code-form paths as well as
  // Markdown links. Validate those explicit successor references too.
  for (let i = 0; i < Math.min(lines.length, 16); i++) {
    if (!/^Supersedes:|^Superseded by:/i.test(lines[i])) continue;
    for (const match of lines[i].matchAll(/`([^`]+\.md(?:#[^`]*)?)`/g)) resolveTarget(match[1], i + 1, true);
  }
  return issues;
}

export function validateFiles(repoRoot, inputPaths, { requireHeaders = false, checkLinks = true } = {}) {
  const files = [...new Set(inputPaths.flatMap((path) => markdownFiles(resolve(repoRoot, path))))].filter((file) => !isTemplate(repoRoot, file)).sort();
  const results = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const parsed = parseHeader(source);
    const issues = checkHeader(parsed);
    if (!parsed.present && requireHeaders) issues.push({ code: "unclassified-artifact", line: 1, message: "durable Markdown artifact has no metadata header" });
    if (checkLinks) issues.push(...localLinkIssues(file, source, repoRoot));
    results.push({ path: relative(repoRoot, file).split(sep).join("/"), classified: parsed.present, kind: parsed.fields["Artifact kind"] ?? null, status: parsed.fields.Status ?? null, issues });
  }
  return { schema: "docs/artifact-metadata.schema.json", files: files.length, classified: results.filter((result) => result.classified).length, unclassified: results.filter((result) => !result.classified).length, issues: results.flatMap((result) => result.issues.map((issue) => ({ path: result.path, ...issue }))), results };
}

function cli() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const requireHeaders = args.includes("--require-headers");
  const paths = args.filter((arg) => !arg.startsWith("--"));
  const selected = paths.length ? paths : ["docs/roadmap-1.0.0-and-documentation-governance.md", "ROADMAP.md", "docs/roadmaps"];
  const report = validateFiles(ROOT, selected, { requireHeaders });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Artifact metadata: ${report.classified}/${report.files} classified; ${report.issues.length} issue(s)`);
    for (const issue of report.issues) console.log(`${issue.path}:${issue.line}: ${issue.code}: ${issue.message}`);
  }
  process.exitCode = report.issues.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
