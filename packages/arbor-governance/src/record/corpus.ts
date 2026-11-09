/**
 * corpus.ts — the CLI-able corpus check: scans decisions/*.md and returns a
 * machine-readable classification report.
 *
 * This is deliberately a plain exported function, not a script — scripts/ is
 * out of this package's ownership (another workstream owns CI/script
 * wiring). Its real, non-test caller is `arbor-mcp`'s
 * `governance-projection.ts` (via `arbor-mcp`'s wired `governance` CLI
 * command); `tests/record/corpus.test.ts` additionally runs it directly
 * against the actual decisions/ directory (27 real ADR files) and asserts
 * the classification breakdown, per Phase 1's exit criterion.
 *
 * Also backfills the corpus's citation graph (D3, the migration honesty
 * triad — see `migrate.ts`'s own header) into `CorpusScanReport.citations`,
 * over the same `results` this function already computed — an additive
 * field, so existing consumers destructuring `.total`/`.parsed`/`.results`
 * etc. are unaffected. `options.at` is optional and threaded straight to
 * `classifyCorpusCitations`; when omitted (today's only real caller,
 * `governance-projection.ts`, does not yet pass one — see `migrate.ts` on
 * why), the citation report falls back to a fixed, documented sentinel
 * rather than reading a clock, so this function's own determinism
 * (`scanDecisionsCorpus` never depends on wall-clock time) is unaffected
 * either way.
 *
 * ALSO backfills two more additive fields, both gated behind the new
 * `options.repoRoot` (optional, same sentinel-when-omitted shape as
 * `options.at` above — today's real caller does not yet pass one either):
 *   - `doc_identities`: one `ArtifactIdentity` (kind "doc") per scanned ADR
 *     file, built from the file's raw on-disk bytes via `artifact/identity
 *     .ts`'s `contentHashOfFile` — distinct from `results[].record
 *     .source_content_hash`, which hashes the record's NORMALIZED text (see
 *     `parse.ts`), not the literal file bytes. `ArtifactIdentity.path` must
 *     be repo-relative (contracts.ts), which is the one fact this function
 *     does not otherwise have without `repoRoot`.
 *   - `code_duplicate_symbol_findings`: `artifact/duplicates.ts`'s POL-06
 *     check over `packages/*\/src` — the real, wired caller for `scan()` and
 *     `duplicateSymbolIds()` (see that module's own header for why it lives
 *     here and not inside `obligation/report.ts`).
 * Individual file-read failures inside the `doc_identities` loop are skipped,
 * not fatal — consistent with this function's own tolerance for a single bad
 * file elsewhere in this same scan (see the `results` loop below).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ArtifactIdentity, GovernanceResult, GovernanceEdge, PolicyFinding } from "../contracts.js";
import { classifyLegacyRecord } from "./legacy.js";
import type { LegacyReadResult } from "./legacy.js";
import { classifyCorpusCitations, CITATION_MIGRATION_AT_UNSET } from "./migrate.js";
import type { CitationMigrationReport } from "./migrate.js";
import { projectCitationGraph } from "../graph/projector.js";
import { contentHashOfFile, createArtifactIdentity } from "../artifact/identity.js";
import { checkDuplicateSymbolIdentities } from "../artifact/duplicates.js";

const CAPABILITY_SCAN = "record.corpus.scan";

/** Matches this corpus's file-naming convention; excludes decisions/README.md and any non-ADR file. */
const ADR_FILE_RE = /^ADR-\d+-.+\.md$/;

export interface CorpusScanReport {
  readonly decisions_dir: string;
  readonly total: number;
  readonly parsed: number;
  readonly parsed_with_warnings: number;
  readonly unparseable: number;
  readonly results: readonly LegacyReadResult[];
  /** The migration honesty triad's citation-resolution report over this same scan (D3). */
  readonly citations: CitationMigrationReport;
  /**
   * ADR-027 Decision point 3: the corpus's own "derived" graph plane — every
   * RESOLVED citation fact from `citations`, reshaped into `GovernanceEdge`s
   * (`graph/projector.ts::projectCitationGraph`). Additive: existing callers
   * destructuring `.total`/`.parsed`/`.results`/`.citations` are unaffected.
   * See that module's header for why this is the corpus-derived slice of the
   * graph, not the ledger-authoritative one.
   */
  readonly citation_graph: readonly GovernanceEdge[];
  /**
   * One `kind: "doc"` ArtifactIdentity per scanned ADR file, hashed from raw
   * on-disk bytes (`contentHashOfFile`). Populated only when
   * `options.repoRoot` is supplied — see this module's header. `[]` when
   * omitted, never a guess at what repo-relative path would be.
   */
  readonly doc_identities: readonly ArtifactIdentity[];
  /**
   * ADR-027's own code-artifact identity self-check (POL-06): every
   * duplicate `symbol_id` `artifact/duplicates.ts` finds across
   * `packages/*\/src`. Populated only when `options.repoRoot` is supplied —
   * see this module's header. `[]` when omitted.
   */
  readonly code_duplicate_symbol_findings: readonly PolicyFinding[];
}

export interface ScanDecisionsCorpusOptions {
  /** ISO-8601 timestamp stamped on every citation fact's EvidenceRef.at. Defaults to `CITATION_MIGRATION_AT_UNSET` when omitted, so this function never reads a clock of its own. */
  readonly at?: string;
  /**
   * Repository root, used ONLY to (a) compute `doc_identities`' repo-relative
   * `path` field and (b) locate `packages/*\/src` for
   * `code_duplicate_symbol_findings`. Optional and additive — see this
   * module's header for why omitting it is a stated, honest limitation
   * rather than a guess.
   */
  readonly repoRoot?: string;
}

/** Scans every `ADR-*.md` file directly under `decisionsDir` and classifies each one. */
export function scanDecisionsCorpus(
  decisionsDir: string,
  options?: ScanDecisionsCorpusOptions,
): GovernanceResult<CorpusScanReport> {
  let entries: string[];
  try {
    entries = readdirSync(decisionsDir);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "unavailable",
        message: `cannot read decisions directory: ${(err as Error).message}`,
        at: decisionsDir,
      },
      capability: CAPABILITY_SCAN,
    };
  }

  const files = entries.filter((name) => ADR_FILE_RE.test(name)).sort();
  const results: LegacyReadResult[] = [];
  for (const name of files) {
    const fullPath = join(decisionsDir, name);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch (err) {
      results.push({
        source_path: fullPath,
        classification: "unparseable",
        record: null,
        reasons: [`cannot read file: ${(err as Error).message}`],
      });
      continue;
    }
    results.push(classifyLegacyRecord(content, fullPath));
  }

  const parsed = results.filter((r) => r.classification === "parsed").length;
  const parsed_with_warnings = results.filter((r) => r.classification === "parsed_with_warnings").length;
  const unparseable = results.filter((r) => r.classification === "unparseable").length;
  const at = options?.at ?? CITATION_MIGRATION_AT_UNSET;
  const citations = classifyCorpusCitations(results, { at });
  const citationGraph = projectCitationGraph(citations.facts, { at });

  const repoRoot = options?.repoRoot;
  const docIdentities: ArtifactIdentity[] = [];
  let codeDuplicateSymbolFindings: readonly PolicyFinding[] = [];
  if (repoRoot !== undefined) {
    for (const name of files) {
      const fullPath = join(decisionsDir, name);
      const relPath = relative(repoRoot, fullPath).split(sep).join("/");
      try {
        docIdentities.push(
          createArtifactIdentity({
            kind: "doc",
            path: relPath,
            symbol_id: null,
            content_hash: contentHashOfFile(relPath),
          }),
        );
      } catch {
        // A read/path failure here is tolerated exactly like the `results`
        // loop above tolerates one: this doc is skipped from the identity
        // list, not fatal to the whole scan.
      }
    }
    codeDuplicateSymbolFindings = checkDuplicateSymbolIdentities(repoRoot, { at });
  }

  return {
    ok: true,
    value: {
      decisions_dir: decisionsDir,
      total: results.length,
      parsed,
      parsed_with_warnings,
      unparseable,
      results,
      citations,
      citation_graph: citationGraph.edges,
      doc_identities: docIdentities,
      code_duplicate_symbol_findings: codeDuplicateSymbolFindings,
    },
    capability: CAPABILITY_SCAN,
  };
}
