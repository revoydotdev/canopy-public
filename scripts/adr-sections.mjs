#!/usr/bin/env -S node
/**
 * scripts/adr-sections.mjs — the ADR section-completeness gate (gate:adr-sections).
 *
 * WHY THIS EXISTS. Everything an ADR author cannot see structurally — whether
 * Alternatives was ever considered, whether an obligation exists at all — was
 * emulated by reading other ADRs, never enforced. `newPendingDecision`'s
 * scaffold now writes every required section as a real heading with an
 * HTML-comment prompt in place of content (see `scripts/lib/adr-registry.mjs`).
 * This gate is the other half of that contract: it detects a heading that
 * still carries only its prompt — never a lock at write time (ADR-075's
 * "detection and remediation are different authorities" split, the same one
 * `adr-trace.mjs`/`branch-accounting.mjs` already establish), a check at
 * stop/CI time instead.
 *
 * STRUCTURE ONLY, NEVER PROSE QUALITY. This gate asks two questions per
 * required section: is the heading present, and is there at least one line
 * of real text under it once its own HTML-comment prompt is stripped out. It
 * never asks whether that text is any good — that is exactly the part of
 * authoring the SCAFFOLD class deliberately leaves to a human/model.
 *
 * WHY ALTERNATIVES IS RATCHETED, CONTEXT/DECISION/CONSEQUENCES/OBLIGATIONS
 * ARE NOT. Measured on 2026-08-24: every non-retired ADR in this corpus
 * already carries Context, Decision, Consequences, and Obligations — those
 * four are unconditionally required. "## Alternatives" (in any of its
 * existing spellings — "Alternatives considered", "Alternatives / Roads not
 * taken", …) is missing from 49 of them, authored long before this gate or
 * any Alternatives convention existed. Requiring it unconditionally today
 * would fail the whole corpus on a rule that did not exist when those records
 * were written — the same "gate fires on legitimate work, gets disabled
 * wholesale" failure this repository has already measured
 * (`obligations-gate.ts`'s `POL_04_FLOOR` header). So Alternatives is a
 * one-way ratchet exactly like POL-04: it fails only if the count of
 * non-retired ADRs missing the heading RISES above the pinned floor below.
 * Once a record does carry an "## Alternatives" heading, though, it is held
 * to the same non-stub bar as every other section — the ratchet forgives
 * never having started the section, not starting it and leaving it empty.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

const ADR_FILE_RE = /^ADR-(\d+)-.+\.md$/;
const STATUS_RE = /^\*\*Status:\*\*\s*(.+)$/m;
const RETIRED_STATUS_RE = /^(Retired|Superseded|Rejected)\b/i;

/** Unconditionally required for every non-retired ADR — see header. */
const REQUIRED_SECTIONS = ["Context", "Decision", "Consequences"];

/**
 * Non-retired ADRs missing "## Alternatives" as of 2026-08-24, the day this
 * gate was introduced. Lower this only as records genuinely gain the section;
 * never raise it to make room for a new record skipping it (same discipline
 * as `obligations-gate.ts`'s `POL_04_FLOOR`).
 */
const ALTERNATIVES_FLOOR = 49;

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const TOP_HEADING_RE = /^##\s+/m;
const STUB_TITLE_RE = /^<.*>$/;
const OBLIGATION_ITEM_RE = /^###\s+(O\d+)\s*[—-]\s*(.+?)\s*$/gm;

// ---------------------------------------------------------------------------
// Pure helpers — read text, return data. No filesystem access below this line.
// ---------------------------------------------------------------------------

/** Text between one "## <name>..." heading and the next top-level "## " heading (or EOF), or null if the heading is absent. */
export function sectionBody(text, name) {
  const heading = new RegExp(`^##\\s+${name}\\b.*$`, "m").exec(text);
  if (!heading) return null;
  const rest = text.slice(heading.index + heading[0].length);
  const next = TOP_HEADING_RE.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** True when a section body carries no content beyond its own HTML-comment prompt(s). */
export function isStubBody(body) {
  return body.replace(HTML_COMMENT_RE, "").trim().length === 0;
}

export function hasAlternativesSection(text) {
  return /^##\s+Alternatives\b/m.test(text);
}

const PROOF_COMMENT_RE = /<!--\s*proof:(.*?)-->/gs;
const UNVERIFIABLE_COMMENT_RE = /<!--\s*unverifiable:\s*(.*?)\s*-->/gs;
/** A `key=value` pair with an actual (non-whitespace) value — distinguishes
 * a filled-in proof field ("symbol=RuntimePort") from the scaffold's bare
 * stub ("symbol= file= roundtrip="), which has the key but no value. */
const FILLED_PROOF_FIELD_RE = /\w+=\S/;

/**
 * True when an obligation item body is still the scaffold's stub: no populated
 * `proof:` field, no non-empty `unverifiable:` reason, and no prose beyond its
 * own HTML-comment prompts. Deliberately does NOT require prose in addition to
 * a resolving proof comment — most of this corpus's real, accepted obligations
 * (e.g. ADR-011's O1) carry only a proof comment and no extra sentence, and
 * treating that as incomplete would be a false positive against real, shipped
 * work, not a real gap.
 */
export function isStubObligationBody(body) {
  PROOF_COMMENT_RE.lastIndex = 0;
  let m;
  while ((m = PROOF_COMMENT_RE.exec(body))) {
    if (FILLED_PROOF_FIELD_RE.test(m[1])) return false;
  }
  UNVERIFIABLE_COMMENT_RE.lastIndex = 0;
  while ((m = UNVERIFIABLE_COMMENT_RE.exec(body))) {
    if (m[1].trim().length > 0) return false;
  }
  return isStubBody(body);
}

/**
 * Checks the "## Obligations" section: present, at least one "### O<n> — …"
 * item, no item left at its placeholder title, and every item is filled in
 * per `isStubObligationBody`.
 */
export function checkObligations(text) {
  const body = sectionBody(text, "Obligations");
  if (body === null) return { ok: false, reason: 'missing "## Obligations" heading' };

  const items = [];
  OBLIGATION_ITEM_RE.lastIndex = 0;
  let m;
  while ((m = OBLIGATION_ITEM_RE.exec(body))) {
    items.push({ ordinal: m[1], title: m[2].trim(), index: m.index, length: m[0].length });
  }
  if (items.length === 0) return { ok: false, reason: 'no "### O<n> — ..." obligation item under "## Obligations"' };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (STUB_TITLE_RE.test(item.title)) {
      return { ok: false, reason: `${item.ordinal} still carries its placeholder title "${item.title}"` };
    }
    const bodyStart = item.index + item.length;
    const bodyEnd = items[i + 1] ? items[i + 1].index : body.length;
    if (isStubObligationBody(body.slice(bodyStart, bodyEnd))) {
      return { ok: false, reason: `${item.ordinal} — "${item.title}" has no filled-in proof, unverifiable reason, or prose beyond its HTML-comment prompt` };
    }
  }
  return { ok: true, reason: null };
}

/** Full section audit for one ADR's raw text. Returns a list of problem strings — empty means clean. */
export function checkAdrSections(text) {
  const problems = [];
  for (const name of REQUIRED_SECTIONS) {
    const body = sectionBody(text, name);
    if (body === null) problems.push(`missing "## ${name}" heading`);
    else if (isStubBody(body)) problems.push(`"## ${name}" is present but carries no content beyond its HTML-comment prompt`);
  }
  const obligations = checkObligations(text);
  if (!obligations.ok) problems.push(obligations.reason);

  if (hasAlternativesSection(text)) {
    // Ratchet forgives never starting the section, not starting it and
    // leaving it a stub — see header. Find the ACTUAL heading text (which
    // may be "Alternatives considered", "Alternatives / Roads not taken", …)
    // rather than assuming the literal word "Alternatives" alone.
    const headingLine = /^##\s+(Alternatives\b.*)$/m.exec(text)[1].trim();
    const body = sectionBody(text, headingLine.split(/\s/)[0]);
    if (body !== null && isStubBody(body)) {
      problems.push(`"## ${headingLine}" is present but carries no content beyond its HTML-comment prompt`);
    }
  }
  return problems;
}

function parseStatus(text) {
  const match = STATUS_RE.exec(text);
  return match ? match[1].trim() : null;
}

function isRetired(status) {
  return status !== null && RETIRED_STATUS_RE.test(status);
}

function loadCorpus(decisionsDir) {
  const entries = readdirSync(decisionsDir);
  const adrs = [];
  for (const entry of entries) {
    const match = ADR_FILE_RE.exec(entry);
    if (!match) continue;
    adrs.push({ number: Number(match[1]), file: entry, text: readFileSync(join(decisionsDir, entry), "utf-8") });
  }
  adrs.sort((a, b) => a.number - b.number);
  return adrs;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export function runSectionsAudit(decisionsDir) {
  const adrs = loadCorpus(decisionsDir);
  const violations = [];
  let missingAlternatives = 0;

  for (const adr of adrs) {
    const status = parseStatus(adr.text);
    if (isRetired(status)) continue;

    if (!hasAlternativesSection(adr.text)) missingAlternatives += 1;

    const problems = checkAdrSections(adr.text);
    if (problems.length > 0) violations.push({ file: adr.file, status, problems });
  }

  const alternativesOverFloor = missingAlternatives > ALTERNATIVES_FLOOR;
  return {
    ok: violations.length === 0 && !alternativesOverFloor,
    checked: adrs.length,
    violations,
    alternatives_missing: missingAlternatives,
    alternatives_floor: ALTERNATIVES_FLOOR,
    alternatives_over_floor: alternativesOverFloor,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const decisionsDir = argValue(argv, "--decisions-dir") ?? join(argValue(argv, "--repo") ?? REPO_ROOT, "decisions");
  const jsonMode = argv.includes("--json");

  const report = runSectionsAudit(decisionsDir);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`gate:adr-sections — ${report.checked} ADR(s) checked`);
    // The one convention a gate uses to say how much it actually looked at
    // (scripts/guard-canaries.mjs). A profile entry that declares
    // `observes: { min: N }` turns a corpus smaller than N into `unresolved`
    // rather than `passed`, so an empty or vanished input cannot read as green.
    console.log(`observed_count: ${report.checked}`);
    console.log(`  Alternatives missing: ${report.alternatives_missing} (floor ${report.alternatives_floor}, ratchet only)`);
    if (report.violations.length > 0) {
      console.log(`\n  ${report.violations.length} record(s) with an incomplete/stub section:\n`);
      for (const violation of report.violations) {
        console.log(`  ${violation.file} (${violation.status ?? "no Status line"})`);
        for (const problem of violation.problems) console.log(`    - ${problem}`);
      }
    }
    if (report.alternatives_over_floor) {
      console.log(`\nFAIL — ${report.alternatives_missing} non-retired ADR(s) lack "## Alternatives", above the floor of ${report.alternatives_floor}.`);
      console.log("  Add an Alternatives / Roads not taken section, or lower the floor only if a record was legitimately retired.");
    }
    console.log(report.ok ? "\nPASS" : "\nFAIL");
  }

  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
