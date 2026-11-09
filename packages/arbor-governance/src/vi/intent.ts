/**
 * vi/intent.ts — the INTENT-PLANE computation for revoy2's visual-intelligence
 * graph, absorbed from `.claude/skills/revoy2-visual-intelligence/scripts/extract-intent.mjs`.
 *
 * That script maintained its OWN ADR filename regex (`/^ADR-\d{3}.*\.md$/`) and
 * status parsing (`text.match(/^\*\*Status:\*\*\s*(.+)$/m)`), duplicating what
 * `record/corpus.ts`'s `scanDecisionsCorpus` (backed by `record/parse.ts`'s
 * `parseRecord`) already owns as this package's canonical, tested ADR reader.
 * This module consumes that canonical reader instead — no bespoke ADR
 * filename or status regex lives here. Two facts NOT duplicated from a
 * regex, kept only because they are not "ADR parsing" at all:
 *
 *   - `SUPERSEDES_RE`: a cross-reference extraction over a record's own
 *     prose ("Supersedes ADR-NNN"), structurally identical to the citation
 *     scan below. `record/parse.ts` does not model supersession at all.
 *   - `CITATION_RE` / `INDEX_ROW_RE`: citation-in-source-code and
 *     decisions/README.md table-row extraction. Neither is an ADR file's
 *     own filename or status — the canonical reader never touches either.
 *
 * Deliberately NOT ported: the original script's step 2 (ROADMAP.md proof
 * comments -> obligations, resolved against a derived TS symbol graph). That
 * step never touched ADR parsing — it is unrelated to the duplication this
 * module exists to remove — and resolving it needs a derived-plane symbol
 * inventory this package does not build. See this package's `obligation/`
 * directory for the (different, already-canonical) proof-comment machinery
 * this repo actually runs in CI.
 *
 * Also deliberately narrower than the original in one respect and broader in
 * another:
 *   - Narrower: a `decisions/*.md` file the canonical reader classifies
 *     "unparseable" (`record: null`) is EXCLUDED from `records` entirely.
 *     The original script never failed a whole record — a missing/odd
 *     `**Status:**` line degraded to `lifecycle: "unknown"` rather than
 *     dropping the file. As of this port, the real corpus has zero
 *     unparseable files (`tests/record/corpus.test.ts` pins this), so the
 *     two behave identically today; the divergence is latent, not active.
 *   - Broader: the citation scan below walks every file under `packages/`
 *     (any extension), not just whatever a sibling derived-plane extractor
 *     happened to emit "file"/"test" nodes for — this module has no access
 *     to that extractor's inventory, so it builds its own.
 *
 * See this module's own report (delivered alongside the port) for the
 * concrete parser disagreements this port surfaced.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DecisionStatus, GovernanceResult } from "../contracts.js";
import { scanDecisionsCorpus } from "../record/corpus.js";

const CAPABILITY_INTENT = "vi.intent.build";

export type RecordLifecycle = "active" | "deprecated" | "experimental" | "unknown";

/** One ADR classified into the intent plane, via the canonical corpus reader. */
export interface IntentRecord {
  readonly id: string;
  readonly recordNumber: number;
  readonly title: string;
  readonly sourcePath: string;
  readonly decisionStatus: DecisionStatus;
  readonly lifecycle: RecordLifecycle;
  readonly supersedes: readonly string[];
}

/** One `ADR-NNN` token found in a `packages/` file, resolved against the known corpus. */
export interface IntentCitation {
  readonly recordId: string;
  readonly citingPath: string;
  readonly line: number;
  readonly isTest: boolean;
}

/** One `ADR-NNN` token found in `packages/` that does not resolve to any file in `decisions/`. */
export interface DanglingCitation {
  readonly token: string;
  readonly sites: readonly string[];
  /**
   * True when EVERY citing site is a test path (mirrors `IntentCitation.isTest`,
   * via the same `isTestPath` check). A token cited only from test code is
   * dangling by DESIGN, not by defect — e.g. `scripts/tests/adr-trace.test.mjs`
   * deliberately cites fabricated ids (ADR-100/101/200/201/300/500/501/502)
   * purely to exercise the ADR-tracing gates. Reporting that identically to a
   * genuine dangling citation in production source (a real broken reference)
   * is how a fabricated test fixture id gets triaged as if someone had
   * actually mistyped a real ADR number. `false` whenever at least one
   * production site also cites the token — a single real dangling site is
   * enough to make the whole token a real finding.
   */
  readonly isTest: boolean;
}

export type IntentMismatch = "M-F" | "M-H" | "M-L" | "M-D";
export type IntentSeverity = "critical" | "high" | "medium" | "low";

export interface IntentFinding {
  readonly category: "intent_drift" | "verification_gap";
  readonly severity: IntentSeverity;
  readonly mismatch: IntentMismatch;
  readonly title: string;
  readonly evidence: string;
  readonly count?: number;
}

export interface IntentGraphReport {
  readonly records: readonly IntentRecord[];
  readonly citations: readonly IntentCitation[];
  readonly danglingCitations: readonly DanglingCitation[];
  readonly orphanRecordIds: readonly string[];
  readonly testOnlyGovernedRecordIds: readonly string[];
  readonly findings: readonly IntentFinding[];
}

const SUPERSEDES_RE = /[Ss]upersedes\s+ADR-(\d+)/g;
const CITATION_RE = /ADR-(\d{3})/g;
const INDEX_ROW_RE = /\[(\d{3})\]\([^)]*\)\s*\|([^|]*)\|\s*([^|\n]+)/g;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

function toRepoRelative(repoRoot: string, absPath: string): string {
  return relative(repoRoot, absPath).split(sep).join("/");
}

/** `accepted` is the only status this repo treats as governing; everything else is diagnostic. */
function lifecycleFor(status: DecisionStatus): RecordLifecycle {
  if (status === "accepted") return "active";
  if (status === "superseded") return "deprecated";
  if (status === "proposed") return "experimental";
  return "unknown";
}

function extractSupersedes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SUPERSEDES_RE)) out.push(`ADR-${m[1]}`);
  return out;
}

function isTestPath(repoRelativePath: string): boolean {
  return repoRelativePath.includes("/tests/") || /\.test\.[cm]?[jt]sx?$/.test(repoRelativePath);
}

function walkAllFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walkAllFiles(full, out);
    else out.push(full);
  }
}

/**
 * Scans every file under `repoRoot/packages` for `ADR-NNN` citations,
 * splitting each into a resolved citation (against `knownIds`, the ids this
 * corpus actually parsed) or a dangling one — the same "a comment is a claim,
 * not authority" split the original script made, and the same namespace
 * caution: a citation outside `knownIds` almost always belongs to
 * revoy-spec's numbering, never silently attached to a same-numbered local id.
 */
function deriveCitations(
  repoRoot: string,
  knownIds: ReadonlySet<string>,
  sourceRoots: readonly string[],
): { citations: IntentCitation[]; dangling: DanglingCitation[] } {
  const files: string[] = [];
  for (const root of sourceRoots) walkAllFiles(join(repoRoot, root), files);

  const citations: IntentCitation[] = [];
  const danglingSites = new Map<string, string[]>();
  // Tracks "every site seen for this token so far is a test path" — starts
  // true and latches false the moment one production site appears, so a
  // token cited from a mix of test and production sites is correctly NOT
  // isTest (a real production dangling citation is not excused by also
  // having a test-fixture use).
  const danglingAllTest = new Map<string, boolean>();

  for (const abs of files.sort()) {
    const repoRelative = toRepoRelative(repoRoot, abs);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const siteIsTest = isTestPath(repoRelative);
    const seen = new Set<string>();
    for (const m of text.matchAll(CITATION_RE)) {
      const num = m[1];
      if (seen.has(num)) continue;
      seen.add(num);
      const line = text.slice(0, m.index).split("\n").length;
      const token = `ADR-${num}`;
      if (!knownIds.has(token)) {
        const sites = danglingSites.get(token) ?? [];
        sites.push(`${repoRelative}:${line}`);
        danglingSites.set(token, sites);
        danglingAllTest.set(token, (danglingAllTest.get(token) ?? true) && siteIsTest);
        continue;
      }
      citations.push({ recordId: token, citingPath: repoRelative, line, isTest: siteIsTest });
    }
  }

  const dangling: DanglingCitation[] = [...danglingSites.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([token, sites]) => ({ token, sites, isTest: danglingAllTest.get(token) ?? true }));

  return { citations, dangling };
}

/**
 * Cross-checks `decisions/README.md`'s index table against each record's own
 * status. A conflict means one of the two is lying, and readers of the index
 * will never learn which — so both directions are surfaced explicitly:
 * an indexed id with no file (M-F), and an indexed status that disagrees
 * with the file's own (M-H).
 */
function crossCheckIndex(repoRoot: string, decisionsDir: string, records: readonly IntentRecord[]): IntentFinding[] {
  const indexRelPath = `${decisionsDir}/README.md`;
  const indexPath = join(repoRoot, decisionsDir, "README.md");
  if (!existsSync(indexPath)) return [];
  const idx = readFileSync(indexPath, "utf8");
  const byId = new Map(records.map((r) => [r.id, r]));
  const findings: IntentFinding[] = [];

  for (const m of idx.matchAll(INDEX_ROW_RE)) {
    const id = `ADR-${m[1]}`;
    const indexStatus = m[3].trim();
    const record = byId.get(id);
    if (!record) {
      findings.push({
        category: "intent_drift",
        severity: "medium",
        mismatch: "M-F",
        title: `${indexRelPath} indexes ${id}, which has no file`,
        evidence: indexRelPath,
      });
      continue;
    }
    if (record.decisionStatus !== indexStatus.toLowerCase()) {
      findings.push({
        category: "intent_drift",
        severity: "medium",
        mismatch: "M-H",
        title: `${id} status disagrees: file says '${record.decisionStatus}', index says '${indexStatus}'`,
        evidence: `${record.sourcePath} vs ${indexRelPath}`,
      });
    }
  }
  return findings;
}

/**
 * Production and test citations are counted SEPARATELY. A record whose only
 * justification comes from a test file governs nothing in production — the
 * same "test-only reachability" distinction this repo's reachability gate
 * applies to symbols. Folding the two together is how a record with no
 * production governance reads as governed.
 */
function rollupGovernance(
  records: readonly IntentRecord[],
  citations: readonly IntentCitation[],
): { orphanRecordIds: string[]; testOnlyGovernedRecordIds: string[]; findings: IntentFinding[] } {
  const governedByProd = new Map<string, number>();
  const governedByTestOnly = new Map<string, number>();
  for (const c of citations) {
    const bucket = c.isTest ? governedByTestOnly : governedByProd;
    bucket.set(c.recordId, (bucket.get(c.recordId) ?? 0) + 1);
  }

  const orphanRecordIds: string[] = [];
  const testOnlyGovernedRecordIds: string[] = [];
  const findings: IntentFinding[] = [];

  for (const r of records) {
    if (r.lifecycle !== "active") continue;
    const prod = governedByProd.get(r.id) ?? 0;
    if (prod > 0) continue;
    const test = governedByTestOnly.get(r.id) ?? 0;
    if (test > 0) {
      testOnlyGovernedRecordIds.push(r.id);
      findings.push({
        category: "intent_drift",
        severity: "medium",
        mismatch: "M-L",
        title: `test-only governance: ${r.id} is Accepted and cited ONLY from test code (${test} site(s)) — it governs no production artifact`,
        evidence: r.sourcePath,
      });
    } else {
      orphanRecordIds.push(r.id);
      findings.push({
        category: "intent_drift",
        severity: "medium",
        mismatch: "M-L",
        title: `orphan ADR: ${r.id} is Accepted and governs zero artifacts`,
        evidence: r.sourcePath,
      });
    }
  }

  // Superseded records that still govern live code — critical.
  for (const r of records) {
    // Deduplicated: "r supersedes X" is a relation, not a multiset. A record
    // that names the same predecessor twice (ADR-037 cites ADR-011 once for
    // its renderer decision and once for its O4 obligation) states one fact
    // twice, and emitting two byte-identical findings for it is not a second
    // observation — downstream they collapse on their content hash, so the
    // finding count and the witnessed-event count disagree forever after.
    // Found 2026-08-07 via that exact disagreement in governance-projection.
    for (const supersededId of new Set(r.supersedes)) {
      const superseded = records.find((x) => x.id === supersededId);
      if (!superseded) continue;
      const prod = governedByProd.get(superseded.id) ?? 0;
      if (prod > 0) {
        findings.push({
          category: "intent_drift",
          severity: "critical",
          mismatch: "M-D",
          title: `${superseded.id} is superseded by ${r.id} but still governs ${prod} artifact(s)`,
          evidence: superseded.sourcePath,
        });
      }
    }
  }

  return { orphanRecordIds, testOnlyGovernedRecordIds, findings };
}

/** Options controlling where `buildIntentGraph` looks for a project's decision corpus. */
export interface BuildIntentGraphOptions {
  /**
   * Repo-relative directory holding this project's ADR/decision records,
   * e.g. `arbor.profile.jsonc`'s `governance.decisions_dir`. Defaults to
   * `"decisions"` — revoy2's own convention, and `DEFAULT_PROFILE`'s value —
   * so an unprofiled repo (or a caller that omits this option) behaves
   * exactly as before this option existed.
   */
  readonly decisionsDir?: string;
  /**
   * Repo-relative directories scanned for `ADR-NNN` citations —
   * `arbor.profile.jsonc`'s `source_roots` (ADR-073). Defaults to
   * `["packages"]`, revoy2's own convention, so an omitted option behaves
   * exactly as before. A foreign project whose sources live in `src/` rather
   * than `packages/` previously had every citation inside it silently
   * missed: `deriveCitations` would walk a nonexistent `packages/` directory
   * (via `walkAllFiles`'s own `readdirSync` catch) and simply find nothing —
   * an intent graph that looks exactly like a project with zero citations,
   * not one this module failed to read.
   */
  readonly sourceRoots?: readonly string[];

  /**
   * Roots the ADR-citation scan walks, when that set differs from
   * `sourceRoots`. Defaults to `sourceRoots`, so a caller that does not set
   * it gets byte-identical behavior to before this option existed.
   *
   * WHY THIS IS SEPARATE FROM `sourceRoots`. One list was being asked to
   * mean two incompatible things. Most consumers read `source_roots` as
   * "this is a PACKAGE TREE": `typecheck-tests.mjs` requires a
   * `tsconfig.tests.json` in every immediate subdirectory of every root and
   * FAILS CLOSED when one is missing; `anti-stub.mjs`, `artifact/scan.ts`
   * and `counts/derive.ts` all assume a `<root>/<pkg>/src` shape. This
   * scan reads it as "this is a CITATION-BEARING TREE", which is a
   * different claim entirely — a directory can hold governed code without
   * being a package tree.
   *
   * revoy2 is exactly that case: its governance machinery lives in
   * `scripts/`, so six accepted records were counted as orphans purely
   * because nothing scanned there. Those six are listed in
   * `arbor.profile.jsonc`'s `citation_roots` note, deliberately NOT here:
   * writing a record's literal id into a comment under a citation root
   * MINTS a citation edge, so an explanatory mention would make this file
   * read as the implementation of a record it merely talks about. That is
   * not hypothetical -- the first draft of this comment did exactly that,
   * and silently moved one record out of the orphan set. Widening
   * `sourceRoots` to fix it would have made `typecheck-tests` fail on all
   * eight subdirectories of `scripts/`, none of which is a TypeScript
   * package. Separating the two lists fixes the citation gap without
   * asserting that a citation-bearing directory is a package.
   */
  readonly citationRoots?: readonly string[];
}

/**
 * Builds the whole INTENDED-plane report for `repoRoot`: every ADR record
 * (via `scanDecisionsCorpus`, never a bespoke regex), the README index
 * cross-check, `packages/` citation edges (resolved + dangling), and the
 * orphan/test-only/superseded-but-governs rollup. Pure computation — no
 * file is written here; the caller decides how (or whether) to persist it.
 */
export function buildIntentGraph(repoRoot: string, options: BuildIntentGraphOptions = {}): GovernanceResult<IntentGraphReport> {
  const decisionsDirName = options.decisionsDir ?? "decisions";
  const sourceRoots = options.sourceRoots ?? ["packages"];
  // Defaults to sourceRoots so an unset option is a no-op.
  const citationRoots = options.citationRoots ?? sourceRoots;
  const decisionsDir = join(repoRoot, decisionsDirName);
  const scan = scanDecisionsCorpus(decisionsDir, { repoRoot });
  if (!scan.ok) {
    return { ok: false, error: scan.error, capability: CAPABILITY_INTENT };
  }

  const records: IntentRecord[] = [];
  for (const r of scan.value.results) {
    if (!r.record) continue;
    const record = r.record;
    let rawText = "";
    try {
      rawText = readFileSync(record.source_path, "utf8");
    } catch {
      rawText = "";
    }
    records.push({
      id: `ADR-${String(record.record_number).padStart(3, "0")}`,
      recordNumber: record.record_number,
      title: record.title,
      sourcePath: toRepoRelative(repoRoot, record.source_path),
      decisionStatus: record.status.decision,
      lifecycle: lifecycleFor(record.status.decision),
      supersedes: extractSupersedes(rawText),
    });
  }

  const knownIds = new Set(records.map((r) => r.id));
  const { citations, dangling } = deriveCitations(repoRoot, knownIds, citationRoots);
  // B4: a dangling citation cited ONLY from test code (isTest) is dangling by
  // design — a deliberately fabricated id exercising a gate's own test suite,
  // not a real broken reference — so it is excluded from the reported
  // findings, matching `rollupGovernance`'s existing prod/test split for
  // resolved citations. It remains visible on `danglingCitations` (with
  // `isTest: true`) for anyone inspecting the raw citation graph directly.
  const danglingFindings: IntentFinding[] = dangling
    .filter((d) => !d.isTest)
    .map((d) => ({
      category: "intent_drift",
      severity: "medium",
      mismatch: "M-F",
      title: `dangling citation ${d.token}: cited in source but absent from ${decisionsDirName}/ (likely revoy-spec's numbering)`,
      evidence: d.sites.slice(0, 4).join(", "),
      count: d.sites.length,
    }));

  const indexFindings = crossCheckIndex(repoRoot, decisionsDirName, records);
  const { orphanRecordIds, testOnlyGovernedRecordIds, findings: rollupFindings } = rollupGovernance(
    records,
    citations,
  );

  return {
    ok: true,
    value: {
      records,
      citations,
      danglingCitations: dangling,
      orphanRecordIds,
      testOnlyGovernedRecordIds,
      findings: [...indexFindings, ...danglingFindings, ...rollupFindings],
    },
    capability: CAPABILITY_INTENT,
  };
}
