/**
 * backlog/derive.ts — turn the real governance findings into a deterministic,
 * ordered work backlog: one item per record this repository's own audit
 * flagged with "POL-04" (an `accepted` record declaring zero obligations —
 * see `obligation/report.ts`'s header for that rule's exact scope).
 *
 * WHY THIS EXISTS. `buildObligationCoverageReport` already tells the honest
 * truth: 25 of 27 real ADRs are accepted with zero obligations, so their
 * "implemented" status rests on prose no reader can check. That is a
 * finding, not a task list. This module is the one step further: for each
 * flagged record, decide (a) whether authoring an "## Obligations" section
 * is even the right next action, and (b) if so, where it ranks against the
 * others — without inventing work that was not actually decided.
 *
 * RANKING RULE (the whole point of this module, stated once, applied
 * everywhere below — see `rank_tier`):
 *
 *   Tier 0 — buildable, and the record already carries a "## Test
 *            implications" section. The author of the record already
 *            pointed at the tests/files that substantiate the decision;
 *            turning that prose into numbered obligations with resolvable
 *            proof comments is close to mechanical.
 *   Tier 1 — buildable, but the record has no "## Test implications"
 *            section. Still real work (`author_obligations`), just harder:
 *            whoever picks this up must derive proof pointers directly from
 *            the Decision/Context prose and the working tree, with no
 *            author-supplied shortcut.
 *   Tier 2 — `not_applicable`. The record's own text says, in its own words,
 *            that it introduces no mechanism, or that the actual fix it
 *            names is an operator/business decision outside engineering
 *            scope. Authoring obligations here would fabricate a checkable
 *            claim about a decision that committed to nothing checkable —
 *            exactly the defect POL-04 exists to catch, one level up.
 *
 * Within a tier, records sort by `record_number` ascending — stable, and
 * matches the corpus's own natural reading order.
 *
 * THE not_applicable DETECTOR IS A NARROW, EXPLICIT-PHRASE MATCH, NOT A
 * SENTIMENT CLASSIFIER. It looks for a small set of phrases an ADR author
 * used to explicitly disclaim a buildable mechanism (see
 * `NOT_APPLICABLE_MARKERS`). Verified against the real corpus (27 records,
 * `tests/backlog/derive.test.ts`): exactly two records — ADR-023 ("no
 * rollback target"; its own "Test implications" section says "this ADR does
 * not introduce a mechanism") and ADR-025 (whose actual fix is named,
 * verbatim, as "not something an agent working inside the repo can decide
 * on the operator's behalf" / "explicitly an operator/business decision")
 * — contain any of these phrases anywhere in the whole corpus. Absence of a
 * marker is the safe default: it means "buildable", i.e. this module errs
 * toward flagging real work rather than silently excusing a record from it.
 * A future record that legitimately decides nothing buildable should say so
 * in those same honest terms, the way ADR-023/025 already do; this detector
 * is not meant to be pattern-matched into new phrasings that overfit
 * incidental prose. If the marker set ever mis-fires on a real record, the
 * fix is to narrow the marker, never to special-case a record id.
 *
 * Reuses `@arbor/governance` internals directly (`scanDecisionsCorpus` for
 * the parsed `CanonicalRecord`s — title, decision status, section text —
 * and `buildObligationCoverageReport` for the actual POL-04 findings and
 * their evidence). This module does not re-implement corpus parsing,
 * obligation parsing, or proof resolution anywhere.
 *
 * DETERMINISM: no `Date.now()`, no `Math.random()`, no env read. `at` is a
 * required caller-supplied timestamp threaded straight through to
 * `buildObligationCoverageReport` (which needs it for `EvidenceRef.at`).
 * Every collection here is built from arrays already returned in a
 * deterministic order (`scanDecisionsCorpus` sorts filenames;
 * `buildObligationCoverageReport` walks sorted filenames) and the final
 * `.sort()` is comparator-based (tier, then a numeric field), never through
 * an iteration-order-sensitive Set/Map. Same repository content + same `at`
 * => byte-identical `JSON.stringify(deriveBacklog(...))`.
 */

import { relative as relativePath, resolve as resolvePath, sep as pathSep } from "node:path";
import type { DecisionStatus, GovernanceResult, RecordId } from "../contracts.js";
import { scanDecisionsCorpus } from "../record/corpus.js";
import type { CanonicalRecord } from "../record/schema.js";
import { buildObligationCoverageReport } from "../obligation/report.js";
import { resolveRepoRoot } from "../obligation/proof.js";

const CAPABILITY = "governance.backlog.derive";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type BacklogClassification = "author_obligations" | "not_applicable";

/**
 * Explicit phrases an ADR author used to disclaim a buildable mechanism.
 * See module header for why this is a narrow phrase match, not a sentiment
 * classifier, and why absence of a match is the safe ("buildable") default.
 */
const NOT_APPLICABLE_MARKERS: readonly RegExp[] = [
  /this ADR does not introduce a mechanism/i,
  /does not introduce a mechanism/i,
  /not something an agent working inside the repo can decide/i,
  /operator\/business decision/i,
  /out of scope for an engineering change/i,
];

const EXCERPT_RADIUS = 90;

/** Recomputable, pure classification of one parsed record. Exported so
 * `brief.ts` can render the same reasoning it produced, verbatim, without
 * re-deriving it differently. */
export function classifyRecordBuildability(
  record: CanonicalRecord,
): { classification: BacklogClassification; reason: string | null } {
  const sections = record.sections;
  // Every section that could plausibly carry an author's own disclaimer,
  // joined in document order. Context is included too (ADR-022's blockquote
  // preamble folds into it) even though no current marker has ever matched
  // there — the search is over the whole document's authored prose, not a
  // hand-picked subset of sections.
  const fullText = [sections.context, sections.decision, sections.consequences, sections.alternatives ?? "", sections.test_implications ?? ""]
    .filter((s) => s.length > 0)
    .join("\n\n");

  for (const marker of NOT_APPLICABLE_MARKERS) {
    const m = marker.exec(fullText);
    if (!m) continue;
    const start = Math.max(0, m.index - EXCERPT_RADIUS);
    const end = Math.min(fullText.length, m.index + m[0].length + EXCERPT_RADIUS);
    const excerpt = fullText.slice(start, end).replace(/\s+/g, " ").trim();
    return {
      classification: "not_applicable",
      reason: `${record.id} states, in its own text, that it commits to no buildable mechanism here: "...${excerpt}..." — authoring an "## Obligations" section would fabricate a checkable claim this record never made.`,
    };
  }
  return { classification: "author_obligations", reason: null };
}

// ---------------------------------------------------------------------------
// Backlog item + report shape
// ---------------------------------------------------------------------------

export interface BacklogItemEvidence {
  /** The policy finding that put this record on the backlog, e.g. "POL-04". */
  readonly finding_rule_id: string;
  /** That finding's own `detail` text, verbatim — not paraphrased. */
  readonly finding_detail: string;
}

export interface BacklogItem {
  readonly record_id: RecordId;
  readonly record_number: number;
  readonly title: string;
  /** Repo-relative, e.g. "decisions/ADR-023-....md". */
  readonly file_path: string;
  readonly decision_status: DecisionStatus;
  readonly classification: BacklogClassification;
  /** Required, human-checkable text when `classification` is
   * "not_applicable"; `null` when "author_obligations" (there is nothing to
   * excuse — the item's evidence and decision_text already say why it's on
   * the backlog). */
  readonly reason: string | null;
  readonly has_test_implications_section: boolean;
  /** 0 = buildable with an existing "Test implications" pointer, 1 =
   * buildable with none, 2 = not_applicable. See module header. */
  readonly rank_tier: 0 | 1 | 2;
  readonly evidence: BacklogItemEvidence;
  /** This record's own "## Decision" section, verbatim — the only source of
   * truth `brief.ts` renders obligations against. */
  readonly decision_text: string;
  /** This record's own "## Test implications" section, verbatim, or `null`
   * when the record has none. */
  readonly test_implications_text: string | null;
}

export interface Backlog {
  readonly decisions_dir: string;
  readonly total_records_scanned: number;
  readonly items: readonly BacklogItem[];
}

export interface DeriveBacklogOptions {
  repoRoot?: string;
  /** Defaults to "<repoRoot>/decisions", same convention as
   * `BuildReportOptions.decisionsDir` — overridable so tests can point this
   * at a fixture directory. */
  decisionsDir?: string;
  /** ISO-8601 timestamp, threaded through to `buildObligationCoverageReport`.
   * Never read internally — see module header on determinism. */
  at: string;
}

/**
 * Derives the real work backlog: one item per record carrying a POL-04
 * finding (an accepted, zero-obligation record), ranked per the rule in this
 * module's header. Never throws — every failure path is a typed
 * `GovernanceResult` error, matching every other function in this package.
 */
export function deriveBacklog(options: DeriveBacklogOptions): GovernanceResult<Backlog> {
  try {
    const repoRoot = options.repoRoot ?? resolveRepoRoot();
    const decisionsDir = options.decisionsDir ?? resolvePath(repoRoot, "decisions");

    const corpus = scanDecisionsCorpus(decisionsDir);
    if (!corpus.ok) return { ok: false, error: corpus.error, capability: CAPABILITY };

    const report = buildObligationCoverageReport({ repoRoot, decisionsDir, at: options.at });
    if (!report.ok) return { ok: false, error: report.error, capability: CAPABILITY };

    const recordsById = new Map<RecordId, CanonicalRecord>();
    for (const result of corpus.value.results) {
      if (result.record) recordsById.set(result.record.id, result.record);
    }

    const pol04 = report.value.findings.filter((f) => f.rule_id === "POL-04");

    const items: BacklogItem[] = [];
    for (const finding of pol04) {
      const subject = finding.subject as { record_id?: RecordId };
      const recordId = subject.record_id;
      if (!recordId) {
        return {
          ok: false,
          error: { code: "internal", message: `POL-04 finding has no record_id subject`, at: finding.detail },
          capability: CAPABILITY,
        };
      }
      const record = recordsById.get(recordId);
      if (!record) {
        return {
          ok: false,
          error: {
            code: "internal",
            message: `POL-04 finding references ${recordId}, which was not found among the parsed decisions/ records`,
            at: recordId,
          },
          capability: CAPABILITY,
        };
      }

      const hasTestImplications = record.sections.test_implications !== null;
      const { classification, reason } = classifyRecordBuildability(record);
      const rank_tier: 0 | 1 | 2 = classification === "not_applicable" ? 2 : hasTestImplications ? 0 : 1;

      // `record.source_path` (from `CanonicalRecord`, via `scanDecisionsCorpus`)
      // is an ABSOLUTE filesystem path — it embeds wherever this checkout
      // happens to live. Re-deriving it repo-relative here (POSIX
      // separators, matching `obligation/report.ts`'s own
      // `decisions/${basename}` convention) is what makes this module's own
      // determinism claim ("same repository content => byte-identical
      // output") actually hold across two different checkouts of the same
      // repo, not just two calls within one process.
      const filePath = relativePath(repoRoot, record.source_path).split(pathSep).join("/");

      items.push({
        record_id: record.id,
        record_number: record.record_number,
        title: record.title,
        file_path: filePath,
        decision_status: record.status.decision,
        classification,
        reason,
        has_test_implications_section: hasTestImplications,
        rank_tier,
        evidence: { finding_rule_id: finding.rule_id, finding_detail: finding.detail },
        decision_text: record.sections.decision,
        test_implications_text: record.sections.test_implications,
      });
    }

    items.sort((a, b) => {
      if (a.rank_tier !== b.rank_tier) return a.rank_tier - b.rank_tier;
      return a.record_number - b.record_number;
    });

    return {
      ok: true,
      capability: CAPABILITY,
      value: { decisions_dir: decisionsDir, total_records_scanned: corpus.value.total, items },
    };
  } catch (err) {
    return {
      ok: false,
      error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
      capability: CAPABILITY,
    };
  }
}

// ---------------------------------------------------------------------------
// Selection — Track B3: which single item should an autonomous consumer
// (arbor-mcp's `selfhost`) work on next.
// ---------------------------------------------------------------------------

/**
 * The next real, buildable item in a derived backlog — deterministic, and the
 * single decision rule a consumer like `selfhost` should defer to rather than
 * re-implementing its own ranking.
 *
 * WHY THIS IS SAFE TO CALL REPEATEDLY WITHOUT A SEPARATE "already satisfied"
 * CHECK: `deriveBacklog` only ever includes a record here because it currently
 * carries a live POL-04 finding (accepted, zero obligations). The moment a
 * record's own "## Obligations" section is authored, `buildObligationCoverageReport`
 * stops emitting POL-04 for it, and the NEXT call to `deriveBacklog` — not this
 * function — drops it from `backlog.items` entirely. So "skip what's already
 * done" is not something this function decides; it is a property of calling
 * `deriveBacklog` fresh each time, against the real corpus, before selecting.
 * This function adds exactly one further rule on top of that: skip
 * `not_applicable` items. Those are not "done" in the same sense — they are
 * items whose own text disclaims a buildable mechanism (ADR-023, ADR-025 as
 * of this writing) — but there is nothing an "author obligations" task could
 * honestly do with them, and `brief.ts`'s own rendered brief for one says so
 * explicitly ("Do NOT author an Obligations section"). Dispatching such an
 * item would waste a real campaign on a task with no legitimate action.
 *
 * `backlog.items` is already sorted tier-then-record_number (see
 * `deriveBacklog`), and `not_applicable` items are always tier 2 — the last
 * tier — so in practice this is "the first item", filtered. Written as an
 * explicit filter anyway so the skip is a stated rule, not an accident of
 * where not_applicable happens to sort.
 *
 * Returns `null` when no buildable item remains (backlog empty, or every
 * remaining item is `not_applicable`) — callers must treat that as "nothing
 * to autonomously dispatch right now," not silently invent a task.
 */
export function selectNextBacklogItem(backlog: Backlog): BacklogItem | null {
  return backlog.items.find((item) => item.classification === "author_obligations") ?? null;
}
