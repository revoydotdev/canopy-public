/**
 * documents.ts — the document set SUR-06 scans for G-NN status assertions.
 *
 * Deliberately small and explicit, unlike counts/documents.ts's repo-wide
 * walk: SUR-05 checks numeric claims anywhere prose could quote a count;
 * SUR-06 checks a much narrower thing (an assertion about a *specific
 * register row's status*), and this repository's own incident history
 * (ROADMAP.md's "Verified gap register" header note) names exactly three
 * places that drift has been observed — ROADMAP.md's own prose outside the
 * register table, `docs/release-readiness.md`'s blocker checklist, and
 * `audit/*.md` reports. Scanning the whole repository for status assertions
 * would risk false positives in places nobody intended as a status claim
 * (code comments, ADRs, chat-transcript-shaped docs); this set is the
 * corpus the drift was actually found in.
 *
 * Purity: pure function of `repoRoot`'s on-disk directory listing (which
 * `audit/*.md` files exist), matching this package's other `derive*`-shaped
 * functions. No content is read here.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Repo-relative path to the document `parseGapRegister` is expected to run against — its own body range is excluded when this document is scanned for mentions (see check.ts). */
export const GAP_REGISTER_DOCUMENT = "ROADMAP.md";

/** Options controlling where `deriveGapStatusScanDocuments` looks for dated audit reports. */
export interface DeriveGapStatusScanDocumentsOptions {
  /**
   * Repo-relative directory of dated audit reports (`*.md`), enumerated live
   * and appended to the scanned document set. Defaults to `"audit"`,
   * revoy2's own numbered-audit convention. Deliberately NOT part of
   * `source_roots` and NOT added to the profile schema, for the same reason
   * commit 169f6699 gave for `ROADMAP.md`/`audit/10-gap-register.md`: this is
   * revoy2's own audit-report convention, not a structural fact every
   * ADR-073-conformant project shares — a foreign project may keep no
   * `audit/` directory at all. Turning the hardcoding into an option
   * (without inventing a schema fact that does not generalize) is the honest
   * middle the prior batch already established for this exact document set.
   */
  readonly auditDir?: string;
}

/** Documents scanned for G-NN status assertions, sorted for determinism. `<auditDir>/*.md` is enumerated live so a new audit report is covered without a hand-maintained list. */
export function deriveGapStatusScanDocuments(repoRoot: string, options: DeriveGapStatusScanDocumentsOptions = {}): string[] {
  const auditDir = options.auditDir ?? "audit";
  const docs = [GAP_REGISTER_DOCUMENT, "docs/release-readiness.md"];
  let auditEntries: string[] = [];
  try {
    auditEntries = readdirSync(join(repoRoot, auditDir)).filter((name) => name.endsWith(".md"));
  } catch {
    auditEntries = [];
  }
  for (const entry of auditEntries.sort()) docs.push(`${auditDir}/${entry}`);
  return docs;
}
