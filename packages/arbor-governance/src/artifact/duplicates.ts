/**
 * artifact/duplicates.ts — POL-06: find every duplicate `symbol_id` across
 * `packages/*\/src` and render each as a `PolicyFinding`.
 *
 * WHY THIS EXISTS. `identity.ts`'s `duplicateSymbolIds` (built on
 * `groupBySymbolKey`) precisely characterizes a real ambiguity: two files in
 * ONE package independently exporting the same name (`kind: "symbol"`, same
 * `symbol_id = "<package>::<export>"`, different `path`). `scan.ts`'s `scan()`
 * is the AST-verified inventory that feeds it. `obligation/proof.ts`'s own
 * `findSymbolAcrossRepo` already reports a WEAKER, textual/regex, repo-wide
 * version of a related question ("how many files anywhere in the repo declare
 * or re-export this name") per proof lookup — deliberately narrower, per that
 * module's own header, because a full AST scan was judged out of scope for a
 * single-symbol lookup. This module is the complementary, STRONGER,
 * whole-tree check for the package-scoped case identity.ts actually
 * disambiguates, computed once rather than per lookup.
 *
 * WHY NOT INSIDE obligation/report.ts. `buildObligationCoverageReport`'s own
 * tests pin EXACT finding counts (including `toEqual([])`) against small
 * per-record fixture `decisions/` directories. A repo-wide,
 * decisions/-independent check folded into that function's findings array
 * would inject unrelated noise into every one of those fixtures and silently
 * break assertions that have nothing to do with `packages/*\/src`. This
 * finding set is therefore its own function, with its own caller
 * (`record/corpus.ts`'s `scanDecisionsCorpus`, additively, behind the same
 * optional `repoRoot` its sibling `doc_identities` field also requires — see
 * that module's header).
 *
 * Deterministic: `scan()` is pure/deterministic (scan.ts's own determinism
 * test), and findings here are sorted by `symbol_id` (via `compareCodeUnits`,
 * never `localeCompare` — this repo's own ordering convention) rather than by
 * `Map` iteration order.
 */

import { compareCodeUnits } from "@arbor/core";
import type { PolicyFinding } from "../contracts.js";
import { duplicateSymbolIds, identitiesEqual, parseSymbolId } from "./identity.js";
import { scan } from "./scan.js";

export const POL_DUPLICATE_SYMBOL_ID = "POL-06";
export const DUPLICATE_SYMBOL_PRODUCER = "arbor-governance/artifact-duplicates@1";

export interface CheckDuplicateSymbolIdentitiesOptions {
  /** ISO-8601 timestamp stamped on every finding's EvidenceRef.at. This module reads no clock of its own. */
  readonly at: string;
}

/**
 * Scans `packages/*\/src` under `repoRoot` (via `scan()`) and returns one
 * `PolicyFinding` per member of every duplicate `symbol_id` group
 * `duplicateSymbolIds` finds — i.e. one package with the same export name
 * declared in 2+ different files. Empty when no such group exists (the
 * common, healthy case).
 */
export function checkDuplicateSymbolIdentities(
  repoRoot: string,
  options: CheckDuplicateSymbolIdentitiesOptions,
): readonly PolicyFinding[] {
  const identities = scan(repoRoot);
  const duplicates = duplicateSymbolIds(identities);

  const findings: PolicyFinding[] = [];
  const sortedKeys = [...duplicates.keys()].sort(compareCodeUnits);

  for (const key of sortedKeys) {
    const group = duplicates.get(key);
    if (!group) continue; // defensive: key was just read from this same map
    // `scan()` is expected to enumerate each declaration once, but this is a
    // governance finding producer: it must not turn an accidental repeated
    // observation of the *same* artifact into a claim that two artifacts
    // collide. Use the canonical full-identity comparator rather than a
    // hand-rolled path/hash comparison, so generated-artifact semantics stay
    // identical wherever identity is interpreted.
    const distinctArtifacts = group.filter(
      (identity, index) => !group.slice(0, index).some((prior) => identitiesEqual(prior, identity)),
    );

    // groupBySymbolKey's key is "<kind> <symbol_id>" — symbol_id is
    // everything after the first space.
    const symbolIdPart = key.slice(key.indexOf(" ") + 1);
    const parsed = parseSymbolId(symbolIdPart);
    const sortedPaths = [...distinctArtifacts.map((identity) => identity.path)].sort(compareCodeUnits);

    for (const identity of [...distinctArtifacts].sort((a, b) => compareCodeUnits(a.path, b.path))) {
      findings.push({
        rule_id: POL_DUPLICATE_SYMBOL_ID,
        severity: "warning",
        subject: identity,
        detail: parsed
          ? `"${parsed.exportName}" is exported from ${sortedPaths.length} different files in package "${parsed.packageName}" (${sortedPaths.join(", ")}) — a symbol_id ambiguity that a file=-less "symbol=" proof citation cannot honestly resolve to one target.`
          : `symbol_id "${symbolIdPart}" is exported from ${sortedPaths.length} different files (${sortedPaths.join(", ")}).`,
        remediation: parsed
          ? `Rename one of the conflicting "${parsed.exportName}" exports in package "${parsed.packageName}", or always cite a "file=" alongside "symbol=${parsed.exportName}" so a proof comment resolves unambiguously.`
          : `Rename one of the conflicting exports, or always cite a "file=" alongside the "symbol=" so a proof comment resolves unambiguously.`,
        evidence: [
          {
            kind: "code_location",
            ref: identity.path,
            producer: DUPLICATE_SYMBOL_PRODUCER,
            at: options.at,
            content_hash: identity.content_hash,
          },
        ],
        waiver_eligible: true,
        is_legacy_debt: false,
      });
    }
  }

  return findings;
}
