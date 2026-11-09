/**
 * scripts/lib/project-profile.mjs — loads `arbor.profile.jsonc`, the
 * declarative description of "what shape is this repo" that lets a
 * revoy2-family project vary by language/tooling while staying structurally
 * checkable (ADR-073).
 *
 * Two entry points, deliberately different failure postures:
 *
 *   `loadProjectProfile(repo)` — strict. Throws a `ProjectProfileError`
 *   (structured `errors: [{path, message}]`, never a bare string) if the
 *   file is missing, unreadable, not valid JSONC, or fails validation.
 *   Callers that need to know "does this repo actually declare a profile"
 *   (e.g. `scripts/project-conform.mjs`'s own `profile-file` spec element)
 *   use this.
 *
 *   `profileOrDefaults(repo)` — NEVER throws. Falls back to
 *   `DEFAULT_PROFILE` on any failure from `loadProjectProfile`, including a
 *   simply-absent file. This is the non-negotiable back-compat seam: every
 *   caller migrated to read `source_roots` etc. through this function must
 *   behave byte-identically on a repo that has never heard of
 *   `arbor.profile.jsonc`, because `DEFAULT_PROFILE` encodes exactly the
 *   hardcoded assumptions those callers made before this module existed
 *   (single "packages" source root, the four evidence stores at repo root,
 *   ".arbor" as the arbor state dir, "decisions" as the decisions dir, and
 *   "scripts/reachability/allowlist.json" as the waiver allowlist).
 *
 * Every field is optional in the file on disk; `DEFAULT_PROFILE` documents
 * what "omitted" means for each one. A present-but-partial profile merges
 * per-field against the defaults, not all-or-nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROFILE_FILENAME = "arbor.profile.jsonc";

export class ProjectProfileError extends Error {
  constructor(errors) {
    super(`${PROFILE_FILENAME} failed validation:\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n")}`);
    this.name = "ProjectProfileError";
    this.errors = errors;
  }
}

/**
 * Documented defaults — what an unprofiled repo behaves as. Frozen so a
 * caller cannot accidentally mutate the shared fallback object.
 */
export const DEFAULT_PROFILE = Object.freeze({
  schema_version: 1,
  project_id: null,
  language: null,
  source_roots: Object.freeze(["packages"]),
  // Null, not a list: unset means "same as source_roots", which keeps a
  // profile that never mentions citation_roots byte-identical to its
  // pre-existing behavior. A literal default of ["packages"] would silently
  // pin the citation scan even for a project that redeclared source_roots.
  citation_roots: null,
  governance: Object.freeze({
    decisions_dir: "decisions",
    evidence_stores: Object.freeze([".claim-ledger", ".completion-depth", ".determinism-baseline", ".visual-intelligence"]),
    arbor_dir: ".arbor",
    allowlist_path: "scripts/reachability/allowlist.json",
  }),
  commands: Object.freeze({}),
});

// ---------------------------------------------------------------------------
// Minimal JSONC support: line/block comments and trailing commas. Deliberately
// hand-rolled rather than a dependency — this repo has no jsonc-parser-class
// package installed, and the grammar this file actually needs (comments +
// trailing commas, nothing exotic like JSON5 identifiers) is small enough to
// implement directly and keep testable in isolation.
// ---------------------------------------------------------------------------

function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
        continue;
      }
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function stripTrailingCommas(text) {
  return text.replace(/,(\s*[\]}])/g, "$1");
}

function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validates the raw parsed JSONC value. Returns an array of structured
 * `{path, message}` errors (empty when valid) — never throws itself, so the
 * caller controls exactly where validation failure becomes an exception. */
export function validateProfile(raw) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    push("$", "profile must be a JSON object");
    return errors;
  }
  if (raw.schema_version !== undefined && raw.schema_version !== 1) {
    push("schema_version", "must be 1 (the only schema version this loader understands)");
  }
  if (raw.project_id !== undefined && !isNonEmptyString(raw.project_id)) {
    push("project_id", "must be a non-empty string when present");
  }
  if (raw.language !== undefined && !isNonEmptyString(raw.language)) {
    push("language", "must be a non-empty string when present");
  }
  if (raw.source_roots !== undefined && !(isStringArray(raw.source_roots) && raw.source_roots.length > 0)) {
    push("source_roots", "must be a non-empty array of strings when present");
  }
  if (raw.citation_roots !== undefined && !(isStringArray(raw.citation_roots) && raw.citation_roots.length > 0)) {
    push("citation_roots", "must be a non-empty array of strings when present");
  }
  if (raw.governance !== undefined) {
    const g = raw.governance;
    if (g === null || typeof g !== "object" || Array.isArray(g)) {
      push("governance", "must be an object when present");
    } else {
      if (g.decisions_dir !== undefined && !isNonEmptyString(g.decisions_dir)) push("governance.decisions_dir", "must be a non-empty string when present");
      if (g.evidence_stores !== undefined && !isStringArray(g.evidence_stores)) push("governance.evidence_stores", "must be an array of strings when present");
      if (g.arbor_dir !== undefined && !isNonEmptyString(g.arbor_dir)) push("governance.arbor_dir", "must be a non-empty string when present");
      if (g.allowlist_path !== undefined && !isNonEmptyString(g.allowlist_path)) push("governance.allowlist_path", "must be a non-empty string when present");
    }
  }
  if (raw.commands !== undefined) {
    const c = raw.commands;
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      push("commands", "must be an object when present");
    } else {
      for (const [key, value] of Object.entries(c)) {
        if (!isNonEmptyString(value)) push(`commands.${key}`, "must be a non-empty string");
      }
    }
  }
  return errors;
}

function mergeWithDefaults(raw) {
  return {
    schema_version: raw.schema_version ?? DEFAULT_PROFILE.schema_version,
    project_id: raw.project_id ?? DEFAULT_PROFILE.project_id,
    language: raw.language ?? DEFAULT_PROFILE.language,
    source_roots: raw.source_roots ?? DEFAULT_PROFILE.source_roots,
    citation_roots: raw.citation_roots ?? raw.source_roots ?? DEFAULT_PROFILE.source_roots,
    governance: {
      decisions_dir: raw.governance?.decisions_dir ?? DEFAULT_PROFILE.governance.decisions_dir,
      evidence_stores: raw.governance?.evidence_stores ?? DEFAULT_PROFILE.governance.evidence_stores,
      arbor_dir: raw.governance?.arbor_dir ?? DEFAULT_PROFILE.governance.arbor_dir,
      allowlist_path: raw.governance?.allowlist_path ?? DEFAULT_PROFILE.governance.allowlist_path,
    },
    commands: raw.commands ?? DEFAULT_PROFILE.commands,
  };
}

/**
 * Strict loader. Throws `ProjectProfileError` on any of: missing file,
 * unreadable file, invalid JSONC, or a validation failure. Returns a frozen,
 * fully-defaulted profile on success.
 */
export function loadProjectProfile(repo) {
  const path = join(repo, PROFILE_FILENAME);
  if (!existsSync(path)) {
    throw new ProjectProfileError([{ path: PROFILE_FILENAME, message: "file does not exist" }]);
  }
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    throw new ProjectProfileError([{ path: PROFILE_FILENAME, message: `could not read: ${error.message}` }]);
  }
  let raw;
  try {
    raw = parseJsonc(text);
  } catch (error) {
    throw new ProjectProfileError([{ path: PROFILE_FILENAME, message: `invalid JSONC: ${error.message}` }]);
  }
  const errors = validateProfile(raw);
  if (errors.length > 0) throw new ProjectProfileError(errors);
  return deepFreeze(mergeWithDefaults(raw));
}

/**
 * Never throws. This is the seam every migrated caller (docs-truth.mjs,
 * registration-integrity.mjs, project-conform.mjs) must use so a repo with
 * no `arbor.profile.jsonc` — or a temporarily broken one — behaves exactly
 * as it did before this module existed.
 */
export function profileOrDefaults(repo) {
  try {
    return loadProjectProfile(repo);
  } catch {
    return DEFAULT_PROFILE;
  }
}
