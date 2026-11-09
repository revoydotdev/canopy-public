/**
 * check.ts — compare G-NN status assertions across the corpus against
 * ROADMAP.md's Verified gap register and report every contradiction (SUR-06).
 *
 * WHY THIS EXISTS. `ROADMAP.md`'s own header note on the register documents
 * two prior incidents: four rows (G-02, G-09, G-17, G-30) described release
 * blockers that had already been fixed, surviving 8-12 commits past their
 * own resolution because nothing checked a row's STATUS against the rest of
 * the corpus — `gate:docs-truth` validated citations, duplicate IDs, and
 * reachability claims, but says outright it does "not validate gap-register
 * rows" for status drift. It happened again with G-36: `ROADMAP.md` marked
 * it OPEN while `docs/release-readiness.md` marked it closed and a passing
 * test proved it closed. This module is the mechanism the register's own
 * note names as the intended remedy.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. Read this before trusting a green
 * run: this module proves the corpus does not CONTRADICT ITSELF about a
 * gap's status. It does NOT prove the register's own status is correct —
 * ROADMAP.md's Verified gap register is trusted as ground truth here, the
 * same way `docs-truth.mjs`'s own header states a row's prose "can still be
 * wrong in ways this gate cannot mechanically catch." A register row that
 * is itself stale, with nothing elsewhere in the corpus contradicting it,
 * passes this check silently — that failure mode is out of scope for a
 * self-consistency check and is what human review, the reachability gate,
 * and the citation checks in `docs-truth.mjs` are for.
 *
 * CONSERVATISM. See mentions.ts's header for the detection rules and their
 * deliberate narrowness. A gap id mentioned somewhere in the scanned corpus
 * but never given its own register row is NOT reported here — this module
 * only compares a mention against a row that exists; a G-NN with no row at
 * all in ROADMAP.md is already a `docs-truth.mjs` violation on its own
 * (Check 2, "every G-NN mentioned anywhere in ROADMAP.md must have a row"),
 * so re-flagging it here would be a duplicate signal for a gap this repo
 * already fails the build on elsewhere.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicyFinding } from "../contracts.js";
import { contentHashOfString, createArtifactIdentity } from "../artifact/identity.js";
import { gapRegisterMap, type GapRegister } from "./register.js";
import { findGapStatusMentions } from "./mentions.js";
import { GAP_REGISTER_DOCUMENT } from "./documents.js";

export const GAP_STATUS_CHECK_PRODUCER = "arbor-governance/gap-status/check@1";
export const SUR_06_RULE_ID = "SUR-06";

export interface CheckGapStatusOptions {
  /** ISO-8601 timestamp for each finding's EvidenceRef.at. Supplied by the caller so this function reads no clock of its own. */
  readonly at: string;
  /**
   * Repo-relative path to the document `register` was parsed from. When this
   * document appears in `documents`, `register.bodyRange` is excluded from
   * its own mention-scan — the register table is ground truth, not a
   * mention of itself. Defaults to `GAP_REGISTER_DOCUMENT` ("ROADMAP.md");
   * override it in tests that parse a fixture register from a different
   * path.
   */
  readonly registerDocument?: string;
}

function gapLabel(id: number): string {
  return `G-${String(id).padStart(2, "0")}`;
}

/**
 * Scan `documents` (repo-relative paths) for G-NN status assertions and
 * return one PolicyFinding per assertion that contradicts `register`. A
 * document that does not exist is skipped, not an error, matching
 * `checkCounts`'s convention.
 */
export function checkGapStatusConsistency(
  repoRoot: string,
  documents: readonly string[],
  register: GapRegister,
  options: CheckGapStatusOptions,
): PolicyFinding[] {
  const byId = gapRegisterMap(register);
  const registerDocument = options.registerDocument ?? GAP_REGISTER_DOCUMENT;
  const findings: PolicyFinding[] = [];

  for (const doc of documents) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, doc), "utf8");
    } catch {
      continue;
    }

    const excludeRange = doc === registerDocument ? register.bodyRange : undefined;
    const mentions = findGapStatusMentions(text, doc, excludeRange);
    if (mentions.length === 0) continue;

    const contentHash = contentHashOfString(text);
    for (const mention of mentions) {
      const row = byId.get(mention.id);
      if (!row) continue; // no register row to compare against — see module doc
      if (row.status === mention.assertion) continue;

      const label = gapLabel(mention.id);
      findings.push({
        rule_id: SUR_06_RULE_ID,
        severity: "blocker",
        subject: createArtifactIdentity({ kind: "doc", path: doc, symbol_id: null, content_hash: contentHash }),
        detail:
          `${doc}:${mention.line} asserts ${label} is ${mention.assertion} ("${mention.context}"), but ` +
          `${registerDocument}'s Verified gap register (line ${row.line}) declares it ${row.status} ` +
          `("${row.statusRaw}").`,
        remediation: `Reconcile ${doc}:${mention.line} with ${registerDocument}:${row.line} — one of the two is stale.`,
        evidence: [
          {
            kind: "code_location",
            ref: `${doc}:${mention.line}`,
            producer: GAP_STATUS_CHECK_PRODUCER,
            at: options.at,
            content_hash: contentHash,
          },
        ],
        waiver_eligible: true,
        is_legacy_debt: false,
      });
    }
  }

  return findings;
}
