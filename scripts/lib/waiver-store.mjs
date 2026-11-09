/**
 * scripts/lib/waiver-store.mjs — one waiver primitive for the whole repo.
 *
 * WHY THIS EXISTS. Several files independently reimplement the same rule
 * ("an entry carries a reason and a dated expiry; an expired entry blocks
 * the gate"):
 *   - scripts/reachability/allowlist.json      (keyed on symbol + file)
 *   - scripts/branch-accounting/dispositions.json (keyed on branch)
 *   - scripts/anti-stub/triage.json            (keyed on rule + file + symbol,
 *     carries a `verdict`; only `accepted_tradeoff` is dated — a
 *     `false_positive` says the heuristic itself is wrong at that site,
 *     which does not rot, so forcing an expiry onto it would manufacture
 *     recurring work with no decision to make)
 *   - scripts/tui-catalog-parity/waivers.json  (keyed on kind — a dated
 *     exception to a specific catalog kind's parity finding, distinct from
 *     `scripts/tui-catalog-parity/dispositions.json`, which is the gate's
 *     mandatory per-kind TUI-surface declaration, not a suppression store)
 *
 * The operator chose full format unification, not just a shared predicate:
 * one schema, one validator, one CRUD surface, and every store reads and
 * writes through it. This module is that surface. Each gate script (
 * reachability.mjs, branch-accounting.mjs, anti-stub.mjs, tui-catalog-parity.mjs)
 * still owns its own file path, its own "what counts as unreached/
 * unaccounted/a finding" logic, and its own report shape — only the waiver
 * primitive itself (what a valid entry looks like, whether it has lapsed,
 * and how to add/renew/remove one) is shared.
 *
 * SCHEMA. A waiver entry is a plain JSON object with:
 *   - one or more KEY FIELDS identifying what it waives (store-specific:
 *     {symbol,file} for reachability, {branch} for branch-accounting,
 *     {rule,file,symbol} for anti-stub, {kind} for tui-catalog-parity,
 *     {check,value} for closed-enum-hygiene);
 *   - `reason` (required, non-empty string) — why the waiver exists;
 *   - `expires` (an ISO date "YYYY-MM-DD") — required for entries whose
 *     store schema says they carry a shelf life, forbidden-by-convention
 *     (not hard-blocked, see validateWaiverEntry) otherwise;
 *   - any number of store-specific EXTRA FIELDS (`gap`/`adr` for
 *     reachability, `verdict` for anti-stub, etc.) that this module does not
 *     interpret.
 *
 * A store's SCHEMA (see WAIVER_SCHEMAS below) says which fields are keys and
 * a `requiresExpiry(entry)` predicate deciding, per-entry, whether `expires`
 * is mandatory — this is what preserves anti-stub's asymmetry: a
 * `false_positive` entry never requires (or needs) a date, an
 * `accepted_tradeoff` one always does.
 *
 * FILE CONTAINER. Every store's JSON file is `{ ...whatever wrapper fields
 * the store wants (version/_comment/etc.), entries: WaiverEntry[] }`. This
 * module only ever reads/writes the `entries` array; wrapper fields are
 * passed through untouched by loadWaiverFile/writeWaiverFile.
 */

import { readFileSync, writeFileSync } from "node:fs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Store schemas. See this module's header for what each field means. */
export const WAIVER_SCHEMAS = {
  reachability: {
    keyFields: ["symbol", "file"],
    requiresExpiry: () => true,
  },
  "branch-accounting": {
    keyFields: ["branch"],
    requiresExpiry: () => true,
  },
  "anti-stub": {
    keyFields: ["rule", "file", "symbol"],
    requiresExpiry: (entry) => entry.verdict === "accepted_tradeoff",
    verdicts: ["false_positive", "accepted_tradeoff"],
  },
  "tui-catalog-parity": {
    keyFields: ["kind"],
    requiresExpiry: () => true,
  },
  "closed-enum-hygiene": {
    // {check, value} identifies which of the three checks
    // (adrStatusVocabulary/severityVocabulary/defectShapeVocabulary) fired
    // and the drifted vocabulary member. Coarser than per-file for
    // adrStatusVocabulary (a bad status word shared by two ADR files waives
    // as one entry) — an accepted tradeoff, not an oversight: the
    // vocabulary drift is the thing being waived, not its occurrence count.
    keyFields: ["check", "value"],
    requiresExpiry: () => true,
  },
};

function schemaFor(schemaName) {
  const schema = WAIVER_SCHEMAS[schemaName];
  if (!schema) throw new Error(`waiver-store: unknown schema "${schemaName}" (expected one of ${Object.keys(WAIVER_SCHEMAS).join(", ")})`);
  return schema;
}

/**
 * Validate one waiver entry against a store's schema. Returns
 * `{ ok, errors }` — never throws, so callers can report validation failures
 * as gate findings rather than crashes.
 */
export function validateWaiverEntry(entry, schemaName) {
  const schema = schemaFor(schemaName);
  const errors = [];

  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, errors: ["entry is not an object"] };
  }

  for (const field of schema.keyFields) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      errors.push(`missing or invalid key field "${field}" (expected a non-empty string)`);
    }
  }

  if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
    errors.push('missing or invalid "reason" (expected a non-empty string)');
  }

  if (schema.verdicts) {
    if (!schema.verdicts.includes(entry.verdict)) {
      errors.push(`missing or invalid "verdict" (expected one of ${schema.verdicts.join(", ")})`);
    }
  }

  // requiresExpiry can itself throw/misbehave on a malformed entry (e.g. bad
  // verdict) — guard so one bad field doesn't hide the others' errors.
  let needsExpiry = false;
  try {
    needsExpiry = !!schema.requiresExpiry(entry);
  } catch {
    needsExpiry = true; // fail closed: can't determine shelf-life, demand one
  }

  if (needsExpiry) {
    if (typeof entry.expires !== "string" || !DATE_RE.test(entry.expires) || Number.isNaN(Date.parse(entry.expires))) {
      errors.push('missing or invalid "expires" (expected "YYYY-MM-DD")');
    }
  } else if (entry.expires !== undefined) {
    // Present but not required (e.g. an anti-stub false_positive) — not a
    // hard error (a human may still want a note-to-self date), but it must
    // still be well-formed if given.
    if (typeof entry.expires !== "string" || !DATE_RE.test(entry.expires) || Number.isNaN(Date.parse(entry.expires))) {
      errors.push('"expires" is present but not a valid "YYYY-MM-DD" date');
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * True when `entry` has lapsed as of `today` (defaults to the real date).
 * An entry whose schema says it never carries an expiry (e.g. an anti-stub
 * `false_positive`) never lapses. An entry that requires an expiry but is
 * missing/malformed one is treated as EXPIRED, not exempt — the same
 * fail-closed posture every existing store already had: a broken waiver is
 * not a working waiver.
 */
export function isWaiverExpired(entry, schemaName, today = new Date().toISOString().slice(0, 10)) {
  const schema = schemaFor(schemaName);
  let needsExpiry = false;
  try {
    needsExpiry = !!schema.requiresExpiry(entry);
  } catch {
    needsExpiry = true;
  }
  if (!needsExpiry) return false;
  if (typeof entry.expires !== "string" || !DATE_RE.test(entry.expires)) return true;
  return entry.expires < today;
}

function matchesKey(entry, keyValues, keyFields) {
  return keyFields.every((field) => entry[field] === keyValues[field]);
}

/** First entry matching every key field in `keyValues`, or undefined. */
export function findWaiverEntry(entries, keyValues, schemaName) {
  const schema = schemaFor(schemaName);
  return entries.find((entry) => matchesKey(entry, keyValues, schema.keyFields));
}

/**
 * Read a waiver store file. Contract deliberately matches what
 * reachability.mjs and branch-accounting.mjs already did before migration:
 *   - file missing            -> { entries: [], error: null }   (empty store)
 *   - unparseable / no array  -> { entries: [], error: "<msg>" } (FAIL CLOSED:
 *     an unreadable store must not silently mean "nothing is waived", so
 *     callers should treat a non-null `error` as a gate blocker, not as an
 *     empty allowlist.)
 *   - otherwise               -> { entries, error: null, wrapper }
 * `wrapper` is the full parsed JSON (including whatever container fields the
 * store keeps, e.g. `version`/`_comment`) — writeWaiverFile needs it back to
 * avoid dropping those fields on a round trip.
 */
export function loadWaiverFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { entries: [], error: null, wrapper: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { entries: [], error: `${path} is unparseable: ${error.message}`, wrapper: null };
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    return { entries: [], error: `${path} has no "entries" array`, wrapper: parsed };
  }
  return { entries: parsed.entries, error: null, wrapper: parsed };
}

/** Write a store file back, preserving every wrapper field except `entries`. */
export function writeWaiverFile(path, entries, wrapper = {}) {
  const out = { ...wrapper, entries };
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
}

/**
 * Append a new, validated entry. Throws on an invalid entry or a duplicate
 * key (use renewWaiverEntry to update an existing one) — this is a CRUD
 * primitive meant to replace hand-editing the JSON, so it fails loudly
 * rather than silently producing a store two gates would disagree about.
 */
export function addWaiverEntry(entries, newEntry, schemaName) {
  const { ok, errors } = validateWaiverEntry(newEntry, schemaName);
  if (!ok) throw new Error(`invalid waiver entry: ${errors.join("; ")}`);
  if (findWaiverEntry(entries, newEntry, schemaName)) {
    throw new Error("an entry with this key already exists — use renewWaiverEntry() to update it");
  }
  return [...entries, newEntry];
}

/**
 * Update an existing entry (e.g. a new `expires` date and `reason`) found by
 * its key fields. `updates` is shallow-merged onto the existing entry and
 * the result is re-validated before being accepted.
 */
export function renewWaiverEntry(entries, keyValues, updates, schemaName) {
  const schema = schemaFor(schemaName);
  const index = entries.findIndex((entry) => matchesKey(entry, keyValues, schema.keyFields));
  if (index === -1) throw new Error("no matching waiver entry to renew");
  const updated = { ...entries[index], ...updates };
  const { ok, errors } = validateWaiverEntry(updated, schemaName);
  if (!ok) throw new Error(`invalid waiver entry after renewal: ${errors.join("; ")}`);
  return [...entries.slice(0, index), updated, ...entries.slice(index + 1)];
}

/** Remove the entry matching `keyValues`. Throws if none matches. */
export function removeWaiverEntry(entries, keyValues, schemaName) {
  const schema = schemaFor(schemaName);
  const index = entries.findIndex((entry) => matchesKey(entry, keyValues, schema.keyFields));
  if (index === -1) throw new Error("no matching waiver entry to remove");
  return [...entries.slice(0, index), ...entries.slice(index + 1)];
}

// ---------------------------------------------------------------------------
// Minimal CLI — the CRUD surface these stores previously had none of.
//
//   bun run waiver list   <store> [path]
//   bun run waiver add    <store> [path] '<json entry>'
//   bun run waiver renew  <store> [path] '<json key>' '<json updates>'
//   bun run waiver remove <store> [path] '<json key>'
//
// <store> is one of reachability | branch-accounting | anti-stub |
// tui-catalog-parity | closed-enum-hygiene. `path` is
// OPTIONAL: omitted, it resolves to that store's conventional location in
// this repository (STORE_PATHS below). A foreign project whose stores live
// elsewhere passes the path explicitly, which is why the argument survives.
//
// Registered in package.json as `waiver` because an unregistered CLI is an
// undiscoverable one: this arm existed and worked for a full day while the
// procedure skill's CRUD appendix reported "none — hand-edit" for all three
// stores, and an operator following that table would have hand-edited JSON
// that this command validates properly.
//
// Only invoked directly by a human/agent maintaining a store; no gate calls
// this CLI arm.
// ---------------------------------------------------------------------------

/**
 * Mirrors `DEFAULT_DUE_SOON_DAYS` in `scripts/decision-queue.mjs` — the
 * number of days before an expiry at which decision-queue.mjs turns an
 * uninterviewed commitment into a BLOCKER. Not imported directly: waiver-store
 * has no dependency on decision-queue (decision-queue already depends on
 * waiver-store; importing the other way would make the two files circular),
 * so the value is restated here and cross-checked by
 * scripts/tests/waiver-store.test.mjs against decision-queue's own export.
 * Used only to tell an operator, at `waiver add` time, the date by which
 * decision-queue will start demanding an interview for the entry just added —
 * so that consequence is visible before the gate ever goes red over it.
 */
const DECISION_QUEUE_DUE_SOON_DAYS = 3;

/** `isoDate` minus `days`, as an ISO "YYYY-MM-DD" string. */
function isoDateMinusDays(isoDate, days) {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The decision-queue consequence of adding a dated waiver entry, printed
 * right after `waiver add` succeeds so the obligation is visible at the
 * moment it is created, not discovered later as a red `gate:decision-queue`.
 * Silent for an entry with no `expires` (nothing decision-queue.mjs would
 * ever schedule).
 */
function printDecisionQueueConsequence(entry) {
  if (typeof entry.expires !== "string" || !DATE_RE.test(entry.expires)) return;
  const dueBy = isoDateMinusDays(entry.expires, DECISION_QUEUE_DUE_SOON_DAYS);
  console.log("");
  console.log(`  This entry expires ${entry.expires}. gate:decision-queue will require an interview`);
  console.log(`  covering it once it is within ${DECISION_QUEUE_DUE_SOON_DAYS} day(s) of that date — i.e. by ${dueBy}.`);
  console.log("  Run the interview before then, rather than waiting for the gate to go red:");
  console.log("    /revoy2-interview");
}

function isDirectExecution() {
  return import.meta.url === `file://${process.argv[1]}`;
}

/**
 * Where each store lives in THIS repository. Conventional, not universal —
 * an explicit path argument always wins, so a project that keeps its stores
 * somewhere else is not locked out.
 */
const STORE_PATHS = {
  reachability: "scripts/reachability/allowlist.json",
  "branch-accounting": "scripts/branch-accounting/dispositions.json",
  "anti-stub": "scripts/anti-stub/triage.json",
  "tui-catalog-parity": "scripts/tui-catalog-parity/waivers.json",
  "closed-enum-hygiene": "scripts/closed-enum-hygiene/waivers.json",
};

function runCli(argv) {
  const [verb, schemaName, ...tail] = argv;
  if (!verb || !schemaName) {
    console.error("usage: waiver-store.mjs <list|add|renew|remove> <store> [path] [json args...]");
    console.error(`  <store> is one of ${Object.keys(STORE_PATHS).join(" | ")}`);
    console.error("  [path] is optional; omitted, the store's conventional path is used");
    process.exit(2);
  }
  schemaFor(schemaName); // throws on an unknown store name

  // A JSON argument starts with { or [; anything else in this position is a
  // path. Distinguishing them this way is what lets `path` become optional
  // without changing the argument order callers already use.
  const looksLikeJson = (value) => typeof value === "string" && /^\s*[[{]/.test(value);
  const path = tail.length > 0 && !looksLikeJson(tail[0]) ? tail[0] : STORE_PATHS[schemaName];
  const rest = tail.length > 0 && !looksLikeJson(tail[0]) ? tail.slice(1) : tail;
  if (!path) {
    console.error(`waiver-store: no conventional path for store "${schemaName}" — pass one explicitly`);
    process.exit(2);
  }

  const { entries, error, wrapper } = loadWaiverFile(path);
  if (error) {
    console.error(`waiver-store: ${error}`);
    process.exit(1);
  }

  if (verb === "list") {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (verb === "add") {
    const newEntry = JSON.parse(rest[0] ?? "{}");
    const next = addWaiverEntry(entries, newEntry, schemaName);
    writeWaiverFile(path, next, wrapper ?? {});
    console.log(`added 1 entry to ${path}`);
    printDecisionQueueConsequence(newEntry);
    return;
  }
  if (verb === "renew") {
    const keyValues = JSON.parse(rest[0] ?? "{}");
    const updates = JSON.parse(rest[1] ?? "{}");
    const next = renewWaiverEntry(entries, keyValues, updates, schemaName);
    writeWaiverFile(path, next, wrapper ?? {});
    console.log(`renewed 1 entry in ${path}`);
    printDecisionQueueConsequence(next.find((entry) => matchesKey(entry, keyValues, schemaFor(schemaName).keyFields)));
    return;
  }
  if (verb === "remove") {
    const keyValues = JSON.parse(rest[0] ?? "{}");
    const next = removeWaiverEntry(entries, keyValues, schemaName);
    writeWaiverFile(path, next, wrapper ?? {});
    console.log(`removed 1 entry from ${path}`);
    return;
  }
  console.error(`unknown verb "${verb}" (expected list|add|renew|remove)`);
  process.exit(2);
}

if (isDirectExecution()) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`waiver-store: ${error.message}`);
    process.exit(1);
  }
}
