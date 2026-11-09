#!/usr/bin/env node
/**
 * Generated catalog-to-TUI parity gate.
 *
 * The runtime catalog is the canonical public surface.  The disposition file
 * is deliberately narrow: every supported catalog kind has exactly one TUI
 * disposition.  A live control must name both its operator trigger and an
 * executable test that proves the route remains exercised.  This keeps the
 * TUI parity register auditable from the catalog instead of relying on prose.
 *
 * Usage:
 *   bun scripts/tui-catalog-parity.mjs
 *   bun scripts/tui-catalog-parity.mjs --json
 *   bun scripts/tui-catalog-parity.mjs --root <path>
 *
 * `--root` already existed (see `run()` below); ADR-073's follow-up (Roadmap
 * 23 B2) only asked this script to stop hardcoding the `packages/` prefix in
 * its default `--catalog` path. The default now reads the target root's
 * `arbor.profile.jsonc` (via `profileOrDefaults`, which never throws and
 * falls back to `["packages"]` for a repo with none — byte-identical to the
 * previous literal on this repo) and joins its first declared source root
 * with the rest of the (still-literal, arbor-mcp-specific) relative path. An
 * explicit `--catalog` still overrides this entirely, as before.
 *
 * PARSING (governance-walk item 7). This used to scan the catalog source
 * with a regex requiring an entire `{ kind, direction, ..., supported }`
 * entry to sit on one physical line — silently invisible to any entry
 * reformatted across multiple lines. It now delegates to
 * `scripts/lib/tui-catalog-parity/catalog-parser.mjs`, a structural
 * `ts.createSourceFile` walk of the `RUNTIME_CATALOG` array literal (see
 * that module's header for why neither `hollow-parity.mjs` nor
 * `reachability.mjs` already provided a reusable structural parser to share
 * instead).
 *
 * WAIVERS. Findings are matched against
 * `scripts/tui-catalog-parity/waivers.json` — a `tui-catalog-parity` waiver
 * store through `scripts/lib/waiver-store.mjs`, the exact CRUD/expiry
 * primitive `scripts/branch-accounting.mjs` uses for its own dispositions
 * store. This is a SEPARATE file from
 * `scripts/tui-catalog-parity/dispositions.json` above: the dispositions
 * file is this gate's mandatory per-kind TUI-surface declaration (every
 * supported kind must have one), while `waivers.json` is an optional, dated
 * exception suppressing a specific parity FINDING for a specific kind. Only
 * findings that name a `kind` are waivable; an expired or malformed waiver
 * entry becomes a blocker in its own right, exactly like
 * branch-accounting's expired dispositions. Manage waivers with
 * `bun run waiver <list|add|renew|remove> tui-catalog-parity`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { profileOrDefaults } from "./lib/project-profile.mjs";
import { parseRuntimeCatalog, loadRuntimeCatalog } from "./lib/tui-catalog-parity/catalog-parser.mjs";
import { loadWaiverFile, validateWaiverEntry, isWaiverExpired } from "./lib/waiver-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");
const DISPOSITIONS = new Set(["live_query", "live_control", "detail_required", "authoring_required", "excluded"]);
const WAIVER_SCHEMA = "tui-catalog-parity";

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

export { parseRuntimeCatalog };

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function evidenceError(entry, root) {
  const evidence = entry.e2e;
  if (!evidence || typeof evidence !== "object" || !nonEmptyString(evidence.file) || !nonEmptyString(evidence.title)) {
    return "live_control requires e2e.file and e2e.title";
  }
  const path = resolve(root, evidence.file);
  if (!existsSync(path)) return `e2e file does not exist: ${evidence.file}`;
  const source = readFileSync(path, "utf8");
  const marker = `it(${JSON.stringify(evidence.title)}`;
  return source.includes(marker) ? null : `e2e title is not an executable it() case: ${evidence.file} :: ${evidence.title}`;
}

/**
 * Return every drift finding as `{ kind, message }` — `kind` is the catalog
 * kind the finding is about, or `undefined` for a structural/document-level
 * finding that names no single kind (and is therefore never waivable; see
 * `run()`). Callers decide whether to render, waive, or fail.
 */
export function collectParityFindings(catalog, dispositionDocument, root) {
  const findings = [];
  const push = (message, kind) => findings.push({ kind, message });
  const supported = catalog.filter((entry) => entry.supported);
  if (catalog.length === 0) push("runtime catalog parser found no entries");
  if (!Array.isArray(dispositionDocument?.entries)) return [{ message: "dispositions document must contain an entries array" }];

  const byKind = new Map();
  for (const [index, entry] of dispositionDocument.entries.entries()) {
    const label = `dispositions.entries[${index}]`;
    if (!entry || typeof entry !== "object" || !nonEmptyString(entry.kind)) {
      push(`${label} requires a non-empty kind`);
      continue;
    }
    if (byKind.has(entry.kind)) push(`${label} duplicates disposition for ${entry.kind}`, entry.kind);
    else byKind.set(entry.kind, entry);
  }

  const catalogByKind = new Map(supported.map((entry) => [entry.kind, entry]));
  for (const entry of supported) {
    const disposition = byKind.get(entry.kind);
    if (!disposition) {
      push(`supported ${entry.direction} ${entry.kind} has no TUI disposition`, entry.kind);
      continue;
    }
    if (typeof disposition.operator_visible !== "boolean") {
      push(`${entry.kind} must declare operator_visible as true or false`, entry.kind);
      continue;
    }
    if (!DISPOSITIONS.has(disposition.disposition)) {
      push(`${entry.kind} has invalid disposition ${JSON.stringify(disposition.disposition)}`, entry.kind);
      continue;
    }
    if (!disposition.operator_visible) {
      if (disposition.disposition !== "excluded") push(`${entry.kind} is not operator-visible and must be explicitly excluded`, entry.kind);
      if (!nonEmptyString(disposition.reason)) push(`${entry.kind} exclusion requires a reason`, entry.kind);
      continue;
    }
    if (disposition.disposition === "excluded") {
      push(`${entry.kind} is operator-visible but cannot be excluded`, entry.kind);
      continue;
    }
    if (disposition.disposition === "live_query") {
      if (entry.direction !== "query") push(`${entry.kind} is a command, not a live_query`, entry.kind);
      if (!nonEmptyString(disposition.trigger)) push(`${entry.kind} live_query requires an operator trigger`, entry.kind);
    } else if (disposition.disposition === "live_control") {
      if (entry.direction !== "command") push(`${entry.kind} is a query, not a live_control`, entry.kind);
      if (!nonEmptyString(disposition.trigger)) push(`${entry.kind} live_control requires an operator trigger`, entry.kind);
      const error = evidenceError(disposition, root);
      if (error) push(`${entry.kind} ${error}`, entry.kind);
    } else if (!nonEmptyString(disposition.reason)) {
      push(`${entry.kind} ${disposition.disposition} requires a reason`, entry.kind);
    }
  }

  for (const kind of byKind.keys()) {
    if (!catalogByKind.has(kind)) push(`${kind} is dispositioned but is not a supported runtime catalog kind`, kind);
  }
  return findings;
}

/**
 * String-only view of `collectParityFindings`, kept for backward
 * compatibility with existing callers/tests that only care about the
 * rendered messages, not which kind (if any) each one is about.
 */
export function validateParity(catalog, dispositionDocument, root) {
  return collectParityFindings(catalog, dispositionDocument, root).map((finding) => finding.message);
}

/**
 * Split `collectParityFindings`'s output against the waiver store: a
 * finding whose `kind` matches an active (validated, non-expired) waiver
 * entry is suppressed from `errors` and reported under `waived` instead. A
 * finding with no `kind` is never waivable. Mirrors
 * `branch-accounting.mjs`'s own active/expired split over
 * `loadWaiverFile`/`validateWaiverEntry`/`isWaiverExpired`.
 */
function applyWaivers(findings, waiversPath, today = new Date().toISOString().slice(0, 10)) {
  const { entries, error: waiverFileError } = loadWaiverFile(waiversPath);
  const expiredWaivers = [];
  const activeByKind = new Map();
  for (const entry of entries) {
    const { ok, errors: entryErrors } = validateWaiverEntry(entry, WAIVER_SCHEMA);
    if (!ok) {
      expiredWaivers.push({ ...entry, why: `incomplete entry — ${entryErrors.join("; ")}` });
      continue;
    }
    if (isWaiverExpired(entry, WAIVER_SCHEMA, today)) {
      expiredWaivers.push({ ...entry, why: `expired ${entry.expires}` });
      continue;
    }
    activeByKind.set(entry.kind, entry);
  }

  const errors = [];
  const waived = [];
  for (const finding of findings) {
    const waiver = finding.kind !== undefined ? activeByKind.get(finding.kind) : undefined;
    if (waiver) waived.push({ kind: finding.kind, message: finding.message, reason: waiver.reason, expires: waiver.expires });
    else errors.push(finding.message);
  }
  if (waiverFileError) errors.push(waiverFileError);
  for (const entry of expiredWaivers) errors.push(`waiver for ${entry.kind ?? "(unnamed)"} — ${entry.why}`);

  return { errors, waived, expiredWaivers, waiverFileError };
}

export function run(args = process.argv.slice(2)) {
  const root = resolve(argumentValue(args, "--root") ?? DEFAULT_ROOT);
  const defaultSourceRoot = profileOrDefaults(root).source_roots[0];
  const catalogPath = resolve(root, argumentValue(args, "--catalog") ?? `${defaultSourceRoot}/arbor-mcp/src/runtime-catalog.ts`);
  const dispositionsPath = resolve(root, argumentValue(args, "--dispositions") ?? "scripts/tui-catalog-parity/dispositions.json");
  const waiversPath = resolve(root, argumentValue(args, "--waivers") ?? "scripts/tui-catalog-parity/waivers.json");
  const json = args.includes("--json");
  const readErrors = [];
  let catalog = [];
  let document = null;
  // `loadRuntimeCatalog`, not the pure `parseRuntimeCatalog`: the manifest now
  // lives in `@arbor/core` behind a re-export alias in arbor-mcp, so parsing
  // only the file at `catalogPath` finds no array literal at all. That made
  // this gate observe 0 supported entries — and a gate that observes nothing
  // cannot flag drift. `root` is what lets it follow the import.
  try { catalog = loadRuntimeCatalog(catalogPath, root); }
  catch (error) { readErrors.push(`cannot read runtime catalog ${catalogPath}: ${error.message}`); }
  try { document = JSON.parse(readFileSync(dispositionsPath, "utf8")); }
  catch (error) { readErrors.push(`cannot read dispositions ${dispositionsPath}: ${error.message}`); }

  let errors = readErrors;
  let waived = [];
  let expiredWaivers = [];
  let waiverFileError = null;
  if (readErrors.length === 0) {
    const findings = collectParityFindings(catalog, document, root);
    ({ errors, waived, expiredWaivers, waiverFileError } = applyWaivers(findings, waiversPath));
  }

  const report = {
    supported_catalog_entries: catalog.filter((entry) => entry.supported).length,
    disposition_entries: Array.isArray(document?.entries) ? document.entries.length : 0,
    errors,
    waived,
    expired_waivers: expiredWaivers,
    waiver_file_error: waiverFileError,
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`TUI catalog parity gate — ${report.supported_catalog_entries} supported catalog entries, ${report.disposition_entries} dispositions`);
    for (const item of waived) console.log(`WAIVED: ${item.message}  (${item.reason}, expires ${item.expires})`);
    for (const error of errors) console.log(`BLOCKER: ${error}`);
    console.log(errors.length === 0 ? "PASS" : `FAIL — ${errors.length} blocker(s)`);
  }
  return { code: errors.length === 0 ? 0 : 1, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run().code;
