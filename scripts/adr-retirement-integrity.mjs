#!/usr/bin/env node
/**
 * scripts/adr-retirement-integrity.mjs — a retired/superseded ADR must be
 * cross-referenced BOTH DIRECTIONS.
 *
 * Usage:
 *   bun scripts/adr-retirement-integrity.mjs                # human report
 *   bun scripts/adr-retirement-integrity.mjs --json          # machine report
 *   bun scripts/adr-retirement-integrity.mjs --decisions-dir <path>  # fixture override
 *   bun run gate:adr-retirement-integrity                    # wired via package.json (sibling-owned)
 *
 * WHY THIS EXISTS. Nothing in this repository checked ADR retirement or
 * supersession before now: no script, no gate, no CLI verb. A record can
 * declare "this supersedes ADR-NNN's obligation OX" and the superseded
 * record can simply never say so back — the retiring citation exists, but
 * nothing points the other way, so a reader of the superseded record alone
 * has no signal it has been overtaken. That asymmetry is real and already
 * exists in this corpus: ADR-036 supersedes ADR-011's renderer decision and
 * ADR-037 supersedes ADR-011's obligation O4, but ADR-011 itself carries
 * ZERO back-reference to either — grep for "036"/"037"/"superseded" in
 * ADR-011's file returns nothing. By contrast ADR-077 supersedes ADR-036's
 * obligation O3, and ADR-036 DOES carry a back-reference ("SUPERSEDED BY
 * ADR-077 ... retires it and restates the commitment positively") — that
 * pair is fully cross-referenced.
 *
 * WHAT THIS GATE CHECKS. Two directions, both required for a supersession
 * pair to be considered integral:
 *   1. FORWARD — the retiring record cites the record/obligation it
 *      supersedes. Discovered directly: this gate finds every "supersedes
 *      ... ADR-NNN" declaration in the corpus (the convention this repo's
 *      own supersession records already use — see ADR-036/037/077's
 *      "**Scope.** This record supersedes only ADR-NNN's ..." paragraphs),
 *      so a discovered pair has, by construction, a forward citation. This
 *      gate still asserts it explicitly (a plain "ADR-NNN" mention anywhere
 *      in the retiring record) so a regex-matched-but-otherwise-broken
 *      citation cannot slip through silently.
 *   2. BACKWARD — the retired record is marked as superseded, referencing
 *      the retiring record by number, near the word "supersed*". This is
 *      the direction that can silently go missing, because nothing requires
 *      an author editing ADR-011 at the time ADR-036 lands.
 *
 * A pair fails when direction 2 (or, defensively, direction 1) is absent.
 *
 * WHY REGEX OVER A DEDICATED FRONTMATTER FIELD. This corpus does not have a
 * structured `supersedes:`/`superseded_by:` field — supersession is stated
 * in prose, in a fixed convention this repo's own ADR-036/037/077 already
 * follow ("**Scope.** This record supersedes only ADR-NNN's ..."). Rather
 * than inventing a stricter structured convention this gate would then be
 * the only consumer of, it reads the convention that already exists. A
 * `--decisions-dir` override (mirroring reachability.mjs's `--allowlist`
 * and branch-accounting.mjs's `--dispositions`) lets tests exercise this
 * against a throwaway fixture corpus instead of mutating the real one.
 *
 * CONSERVATIVE BIAS: this gate only evaluates pairs it can actually find via
 * the "supersedes ... ADR-NNN" pattern. It does not attempt to infer
 * supersession from softer language ("obsoletes", "replaces", "no longer
 * applies") — a missed pair is a false negative this gate cannot yet catch,
 * named here rather than silently assumed complete. Widening the pattern is
 * a follow-up, not a claim this gate already makes.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const DECISIONS_DIR = argValue("--decisions-dir") ?? join(REPO_ROOT, "decisions");
const JSON_OUTPUT = process.argv.includes("--json");

const ADR_FILE_RE = /^ADR-(\d+)-.+\.md$/;
// Matches this repo's real supersession convention verbatim ("This record
// supersedes only ADR-036's obligation **O3**", "Supersedes ADR-011's O4.")
// and is deliberately loose about "only"/capitalization/punctuation so a
// slightly different phrasing of the same declaration still registers.
const SUPERSEDES_RE = /supersedes\s+(?:only\s+)?ADR-0*(\d+)/gi;

// ---------------------------------------------------------------------------
// 1. Load the corpus.
// ---------------------------------------------------------------------------

function loadAdrCorpus(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    return { adrs: null, error: `cannot read decisions directory "${dir}": ${error.message}` };
  }
  const adrs = new Map(); // number -> { number, file, text }
  for (const entry of entries) {
    const match = ADR_FILE_RE.exec(entry);
    ADR_FILE_RE.lastIndex = 0;
    if (!match) continue;
    const full = join(dir, entry);
    let isFile;
    try {
      isFile = statSync(full).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    const number = parseInt(match[1], 10);
    let text;
    try {
      text = readFileSync(full, "utf-8");
    } catch (error) {
      return { adrs: null, error: `cannot read "${full}": ${error.message}` };
    }
    adrs.set(number, { number, file: entry, text });
  }
  return { adrs, error: null };
}

const { adrs, error: corpusError } = loadAdrCorpus(DECISIONS_DIR);

if (corpusError) {
  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ ok: false, error: corpusError, pairs: [], violations: [] }, null, 2));
  } else {
    console.error(`adr-retirement-integrity: ${corpusError}`);
  }
  process.exitCode = 1;
} else {
  // -------------------------------------------------------------------------
  // 2. Discover every "X supersedes ADR-Y" declaration in the corpus.
  // -------------------------------------------------------------------------

  const rawPairs = [];
  for (const [retiringNumber, retiringAdr] of adrs) {
    let match;
    SUPERSEDES_RE.lastIndex = 0;
    while ((match = SUPERSEDES_RE.exec(retiringAdr.text))) {
      const retiredNumber = parseInt(match[1], 10);
      if (retiredNumber === retiringNumber) continue; // a record cannot supersede itself
      rawPairs.push({ retiring: retiringNumber, retired: retiredNumber });
    }
  }

  // De-duplicate — the same "supersedes ADR-NNN" declaration can be phrased
  // more than once in one record's prose (e.g. Scope paragraph + a later
  // "Supersedes ADR-011's O4." recap).
  const seenPairs = new Set();
  const pairs = rawPairs.filter((pair) => {
    const key = `${pair.retiring}->${pair.retired}`;
    if (seenPairs.has(key)) return false;
    seenPairs.add(key);
    return true;
  });

  // -------------------------------------------------------------------------
  // 3. For each pair, check both directions.
  // -------------------------------------------------------------------------

  const violations = [];
  const ok_pairs = [];

  for (const pair of pairs) {
    const retiringAdr = adrs.get(pair.retiring);
    const retiredAdr = adrs.get(pair.retired);

    if (!retiredAdr) {
      violations.push({
        retiring: pair.retiring,
        retiringFile: retiringAdr.file,
        retired: pair.retired,
        retiredFile: null,
        citesForward: true,
        hasBackReference: false,
        reason: `ADR-${pair.retiring} (${retiringAdr.file}) claims to supersede ADR-${pair.retired}, which does not exist in this corpus`,
      });
      continue;
    }

    const forwardRe = new RegExp(`ADR-0*${pair.retired}\\b`);
    const citesForward = forwardRe.test(retiringAdr.text);

    // Backward: the retired record must mention the retiring ADR's number
    // in a paragraph that also uses the word "supersed*" — the same
    // structural pairing this repo's real back-reference already uses
    // ("SUPERSEDED BY ADR-077 ... retires it"). Checked per-paragraph
    // (blank-line-delimited) rather than per-line so a wrapped sentence
    // still counts.
    const backRe = new RegExp(`ADR-0*${pair.retiring}\\b`);
    const paragraphs = retiredAdr.text.split(/\n\s*\n/);
    const hasBackReference = paragraphs.some((para) => /supersed/i.test(para) && backRe.test(para));

    if (!citesForward || !hasBackReference) {
      const reasonParts = [];
      if (!citesForward) {
        reasonParts.push(`ADR-${pair.retiring} (${retiringAdr.file}) does not actually cite ADR-${pair.retired} despite the "supersedes" declaration`);
      }
      if (!hasBackReference) {
        reasonParts.push(
          `ADR-${pair.retired} (${retiredAdr.file}) is missing a back-reference marking it superseded by ADR-${pair.retiring}`,
        );
      }
      violations.push({
        retiring: pair.retiring,
        retiringFile: retiringAdr.file,
        retired: pair.retired,
        retiredFile: retiredAdr.file,
        citesForward,
        hasBackReference,
        reason: reasonParts.join("; "),
      });
    } else {
      ok_pairs.push({
        retiring: pair.retiring,
        retiringFile: retiringAdr.file,
        retired: pair.retired,
        retiredFile: retiredAdr.file,
      });
    }
  }

  const ok = violations.length === 0;

  if (JSON_OUTPUT) {
    console.log(
      JSON.stringify(
        {
          ok,
          decisionsDir: DECISIONS_DIR,
          totalAdrs: adrs.size,
          pairsFound: pairs.length,
          ok_pairs,
          violations,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`adr-retirement-integrity gate — ${adrs.size} ADR(s) scanned, ${pairs.length} supersession declaration(s) found\n`);

    if (ok_pairs.length) {
      console.log(`${ok_pairs.length} pair(s) fully cross-referenced:`);
      for (const p of ok_pairs) console.log(`  - ADR-${p.retiring} supersedes ADR-${p.retired}  (both directions present)`);
      console.log("");
    }

    if (violations.length) {
      console.log(`${violations.length} violation(s):`);
      for (const v of violations) console.log(`  - ${v.reason}`);
      console.log("");
    }

    console.log(ok ? "PASS" : "FAIL");
  }

  process.exitCode = ok ? 0 : 1;
}
