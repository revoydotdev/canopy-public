/**
 * check.ts — scan configured documents for numeric claims about
 * RepositoryCounts and report every claim that no longer matches the
 * repository (SUR-05).
 *
 * Conservatism is the whole point of this module. A false positive here
 * ("this doc is wrong" when it is not) poisons trust in the entire gate, so
 * this module only recognizes a small, deliberately narrow set of phrasings
 * it can attribute to a specific counted quantity with high confidence:
 *
 *   - `"<N> ADRs"` / `"<N> ADR"`                          -> adr_total
 *   - `"<N> kinds"` / `"<N> capability kinds"` /
 *     `"<N> catalog kinds"`                                 -> catalog_kinds
 *   - `"<N> tests / <M> files"` (the exact compound shape
 *      this repo's own docs use for the committed-suite
 *      claim)                                              -> test_count, test_files
 *   - `"<N> test files"` (standalone)                      -> test_files
 *   - `"<N> packages"`                                      -> packages
 *
 * The last two were added by the CD-D-11 widening and are NOT
 * imagination. The phrasings above were enumerated by counting every
 * `"<number> <count-noun>"` in all 1,008 derived documents against the
 * quantities `derive.ts` measures, and the set was then decided by which
 * phrasings the corpus actually uses — see
 * `.omo/graph-remediation/evidence/todo-17-DECLARED-EXPECTED-SET.txt`.
 * Three candidates were REJECTED on that census's evidence: `"<N> source
 * files"` occurs exactly once and there means "files importing
 * `@arbor/opencode`", not `src_files`; every `"<N> test files"` and bare
 * `"<N> tests"` site is either marked historical or counts the external
 * `revoy-spec` tree; `"<N> allowlist entries"` does not occur at all.
 * Before the widening, `"<N> kinds"` was only recognised behind a literal `~`,
 * so **every count in `docs/` phrased the way this repository actually phrases
 * it was unowned drift by construction** — the register's CD-D-11, measured.
 *
 * Deliberately NOT matched (see the final report this module's caller
 * produces for the reasoning): a bare `"<N> files"` (ambiguous — could mean
 * src files, packages, allowlist entries, or nothing this module tracks at
 * all); a bare `"<N> entries"`/`"<N> allowlist entries"`; a bare `"<N> source
 * files"`; a bare `"<N> tests"`. None of these has a distinctive enough shape
 * to attribute safely, and inventing one risks exactly the false-positive
 * failure mode this module exists to avoid. Missing a claim is the safe
 * failure; inventing one is not.
 *
 * `test_count` (the total number of individual test *cases*, as opposed to
 * `RepositoryCounts.test_files`) is NOT derived by derive.ts, and this
 * module does not derive it either: two of this repo's test files use
 * `it.each(...)`, whose real case count depends on evaluating an array
 * literal (or, in the general case, an arbitrary expression) rather than
 * counting call sites — a static approximation would silently drift from
 * vitest's own count the moment a data table is edited. The honest source
 * of truth is an actual `vitest run`, which is an execution, not a static
 * derivation, so it is left as an optional input the caller supplies (e.g.
 * from having just run the suite) rather than something this "pure" module
 * fakes statically.
 *
 * Governing records: ADR-027 (governance control plane), ADR-025 (SUR-05 as a local gate).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicyFinding } from "../contracts.js";
import { contentHashOfString, createArtifactIdentity } from "../artifact/identity.js";
import type { RepositoryCounts } from "./derive.js";

/** Tool identity + version for EvidenceRef.producer, per contracts.ts's requirement that a result be reproducible/invalidatable on upgrade. */
export const COUNTS_CHECK_PRODUCER = "arbor-governance/counts/check@1";

export const SUR_05_RULE_ID = "SUR-05";

type CountedQuantity = "adr_total" | "catalog_kinds" | "test_files" | "test_count" | "packages";

interface RawClaim {
  quantity: CountedQuantity;
  claimed: number;
  line: number;
  matchText: string;
}

function quantityLabel(quantity: CountedQuantity): string {
  switch (quantity) {
    case "adr_total":
      return "ADR count";
    case "catalog_kinds":
      return "RUNTIME_CATALOG kind count";
    case "test_files":
      return "test file count";
    case "test_count":
      return "test case count";
    case "packages":
      return "package count";
  }
}

/**
 * Guards that apply ONLY to the phrasings added by the CD-D-11 widening, and
 * deliberately not to the four that existed before it.
 *
 * A census of the 1,008 derived documents (`.omo/graph-remediation/evidence/
 * todo-17-DECLARED-EXPECTED-SET.txt` §1) found nine unmarked `<N> kinds` sites
 * and twelve unmarked `<N> packages` sites. Three of the nine report a number
 * without claiming the repository's total:
 *
 *   - `docs/architecture-circuit-diagram.md:640` and `:785` — two lines that
 *     CITE `AGENTS.md:93` and repeat its figure. The claim itself is on
 *     `AGENTS.md:93`; counting it three times is one finding, not three. Both
 *     are excluded by the citation rule below.
 *   - `docs/architecture-circuit-diagram.md:599` — "PASS (0 MCP-generic-only of
 *     0 kinds)", an observed zero. Its remediation would say "write 195",
 *     which is nonsense: the sentence is about what the parity gate saw.
 *   - `docs/proposals/operator-decisions-2026-08-23.md:203` — "(7 kinds)", the
 *     member count of a parenthesised enumeration of named kinds.
 *
 * A wider net without these would ship known false positives, and a gate that
 * cries wolf on three lines of `docs/` is the poisoning the module doc above
 * exists to prevent.
 *
 * They are NOT applied to `adr_total` / `test_files` / the compound test rule.
 * The two pre-existing quoted-count findings in `docs/architecture-circuit-
 * diagram.md` and the opencode-tui comparative analysis are the *same*
 * quotation shape and are left standing: adjudicating them is a decision about
 * existing coverage, and a change that deletes findings in order to report
 * green is the exact failure this gate family exists to prevent. They are
 * reported as open findings instead.
 * (The counts are deliberately not quoted here: a doc comment carrying a
 * claim-shaped phrase is itself a SUR-05 finding site, and the module must not
 * be its own violation.)
 */
function isNonClaimForWidenedPhrasing(line: string, numberStart: number, claimed: number): boolean {
  // A zero is an observation, never an assertion that a population is empty.
  if (claimed === 0) return true;
  // `(7 kinds)` counts the members of an enumeration, not the population.
  if (line[numberStart - 1] === "(") return true;
  // A line that cites `some/file.md:NN` is reporting on that line, not
  // asserting about this repository. Known limit, stated rather than hidden: a
  // genuine claim sharing a line with a `file:line` citation is not checked.
  return /(?:^|[\s[(])[^\s]*\.[A-Za-z]+:\d/.test(line.slice(0, numberStart));
}


/** `<N> kinds` / `<N> capability kinds` / `<N> catalog kinds`, with the number adjacent to the noun. */
const KINDS_CLAIM = /(\d+)\s+(?:(?:capability|catalog)\s+)?kinds?\b/i;
const PACKAGES_CLAIM = /(\d+)\s+packages\b/;

/**
 * Marker that exempts a single line's numeric claims from SUR-05.
 *
 * Widening the checked document set (2026-08-06) surfaced a category this
 * module could not previously express: a claim that is *deliberately* a
 * record of a past measurement — "the audit was run against the tree at
 * 1376 tests / 119 files", "last full verified gate: 1147 tests across 98   sur-05:historical (illustrative)
 * test files". Those are not drift. Rewriting them to today's numbers would
 * falsify the record; leaving them unmarked means the gate reports a
 * permanent, un-actionable warning, which is how a gate stops being read.
 *
 * The marker is deliberately an explicit, greppable opt-out rather than an
 * inference ("does this line look historical?"). Consistent with this
 * module's conservatism, the failure mode of a heuristic here is silently
 * suppressing real drift — the one thing the gate exists to catch. Every
 * exemption is enumerable via `findExemptedClaims`, so "what has been waived"
 * is a query, not a thing you have to trust.
 *
 * Written as a concatenation so this defining occurrence is not itself a
 * marker — otherwise this doc comment would exempt its own line.
 */
export const HISTORICAL_CLAIM_MARKER = "sur-05" + ":historical";

function isExempt(line: string): boolean {
  return line.includes(HISTORICAL_CLAIM_MARKER);
}

function findClaims(text: string): RawClaim[] {
  const claims: RawClaim[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (isExempt(line)) return;

    // Compound shape first, and matched as one unit, so its two numbers are
    // never re-attributed by the standalone patterns below on the same line.
    const compound = /(\d+)\s+tests\s*\/\s*(\d+)\s+files\b/.exec(line);
    if (compound) {
      claims.push({ quantity: "test_count", claimed: Number(compound[1]), line: lineNo, matchText: compound[0] });
      claims.push({ quantity: "test_files", claimed: Number(compound[2]), line: lineNo, matchText: compound[0] });
      return;
    }

    // The number must not be the tail of a dotted identifier: "Phase 4D.1 ADR"
    // names a tranche's ADR, and reading it as a claim that the repository has
    // "1 ADR" is a false positive — observed against ROADMAP.md 2026-08-06. sur-05:historical (illustrative)
    const adr = /(?<![\d.])(\d+)\s+ADRs?\b/.exec(line);
    if (adr) claims.push({ quantity: "adr_total", claimed: Number(adr[1]), line: lineNo, matchText: adr[0] });

    const testFiles = /\b(\d+)\s+test\s+files\b/i.exec(line);
    if (testFiles) claims.push({ quantity: "test_files", claimed: Number(testFiles[1]), line: lineNo, matchText: testFiles[0] });

    // KINDS_CLAIM was previously gated behind a literal tilde, so a claim
    // written the way this repository actually writes one was invisible. The
    // number must now be ADJACENT to the noun: the old form scanned a
    // 40-character window for the noun and so read the 27 in a line reading
    // 27 of 155 as a claim of 27.
    const kinds = KINDS_CLAIM.exec(line);
    if (kinds && !isNonClaimForWidenedPhrasing(line, kinds.index, Number(kinds[1]))) {
      claims.push({ quantity: "catalog_kinds", claimed: Number(kinds[1]), line: lineNo, matchText: kinds[0] });
    }

    const packageCount = PACKAGES_CLAIM.exec(line);
    if (packageCount && !isNonClaimForWidenedPhrasing(line, packageCount.index, Number(packageCount[1]))) {
      claims.push({ quantity: "packages", claimed: Number(packageCount[1]), line: lineNo, matchText: packageCount[0] });
    }
  });
  return claims;
}

/** True when the quantity's source could not be read, so its number is not a measurement. */
function isUnmeasured(quantity: CountedQuantity, counts: RepositoryCounts): boolean {
  // `test_count` is supplied by the caller from a real vitest run, never
  // derived here, so it is never in `unmeasured`.
  if (quantity === "test_count") return false;
  return counts.unmeasured.includes(quantity);
}

function actualFor(quantity: CountedQuantity, counts: RepositoryCounts, testCount: number | undefined): number | undefined {
  switch (quantity) {
    case "adr_total":
      return counts.adr_total;
    case "catalog_kinds":
      return counts.catalog_kinds;
    case "test_files":
      return counts.test_files;
    case "test_count":
      return testCount;
    case "packages":
      return counts.packages;
  }
}

export interface CheckCountsOptions {
  /** ISO-8601 timestamp for each finding's EvidenceRef.at. Supplied by the caller so this function reads no clock of its own. */
  at: string;
  /** Total individual test cases, if known (see module doc for why this is not derived here). Omitting it means "<N> tests" claims are not checked, not that they are assumed correct. */
  test_count?: number;
}

/**
 * Scan `documents` (repo-relative paths) for numeric claims about `counts`
 * and return one PolicyFinding per claim that disagrees with the live
 * measurement. A document that does not exist is skipped, not an error —
 * this module checks prose, it does not assert every configured path must
 * exist.
 */
export function checkCounts(
  repoRoot: string,
  documents: readonly string[],
  counts: RepositoryCounts,
  options: CheckCountsOptions,
): PolicyFinding[] {
  const findings: PolicyFinding[] = [];

  for (const doc of documents) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, doc), "utf8");
    } catch {
      continue;
    }

    const contentHash = contentHashOfString(text);
    for (const claim of findClaims(text)) {
      // A quantity whose source was unreadable carries 0, and that 0 means
      // "not known", never "none". Comparing prose against it would report
      // every true claim as drifted and tell the reader to write 0 — a gate
      // instructing someone to replace a correct number with a false one.
      // Skipping is the only honest option; `unmeasured` is reported by the
      // caller so the gap stays visible rather than silently reducing coverage.
      if (isUnmeasured(claim.quantity, counts)) continue;
      const actual = actualFor(claim.quantity, counts, options.test_count);
      if (actual === undefined || actual === claim.claimed) continue;

      findings.push({
        rule_id: SUR_05_RULE_ID,
        severity: "warning",
        subject: createArtifactIdentity({ kind: "doc", path: doc, symbol_id: null, content_hash: contentHash }),
        detail: `${doc}:${claim.line} claims "${claim.matchText}" (${quantityLabel(claim.quantity)} = ${claim.claimed}), but the repository currently measures ${actual}.`,
        remediation: `Update ${doc}:${claim.line} to reflect ${actual}, not ${claim.claimed}.`,
        evidence: [
          {
            kind: "code_location",
            ref: `${doc}:${claim.line}`,
            producer: COUNTS_CHECK_PRODUCER,
            at: options.at,
            content_hash: contentHash,
          },
        ],
        waiver_eligible: true,
        is_legacy_debt: true,
      });
    }
  }

  return findings;
}

/** One line that carries `HISTORICAL_CLAIM_MARKER`, and so is excluded from SUR-05. */
export interface ExemptedClaim {
  /** Repo-relative document path. */
  readonly document: string;
  /** 1-based line number. */
  readonly line: number;
  /** The exempted line, trimmed — enough to judge the exemption without opening the file. */
  readonly text: string;
}

/**
 * Enumerate every line exempted by `HISTORICAL_CLAIM_MARKER` across
 * `documents`. Pure function of on-disk content; a document that does not
 * exist is skipped, matching `checkCounts`.
 *
 * This exists so an exemption is auditable rather than invisible: the answer
 * to "what numeric claims is this repository choosing not to check, and why"
 * is a query over the real files, not a matter of trusting that whoever added
 * a marker had a good reason.
 */
export function findExemptedClaims(
  repoRoot: string,
  documents: readonly string[],
): ExemptedClaim[] {
  const exempted: ExemptedClaim[] = [];

  for (const doc of documents) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, doc), "utf8");
    } catch {
      continue;
    }

    text.split("\n").forEach((line, index) => {
      if (isExempt(line)) {
        exempted.push({ document: doc, line: index + 1, text: line.trim() });
      }
    });
  }

  return exempted;
}
