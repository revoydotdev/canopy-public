/**
 * backlog/brief.ts — render one `BacklogItem` into a precise, self-contained
 * work brief a coding agent (human or LLM) could execute without any other
 * context than this string plus the repository.
 *
 * A pure function of its one input: no filesystem read, no repo walk, no
 * clock. Everything it prints was already carried on `BacklogItem` by
 * `derive.ts` (which read it from the real record) — this module only
 * formats, it never re-derives or re-decides classification.
 *
 * HONESTY CONSTRAINT THIS MODULE EXISTS TO ENFORCE: a brief is a work order,
 * not a finished obligation. It never writes an "### O1 — ..." line itself —
 * that would be exactly the fabrication this backlog exists to prevent (an
 * agent pattern-matching prose into invented obligations). It states the
 * grammar, the proof-comment resolution rules a real obligation must
 * satisfy, and the record's own Decision/Test-implications text verbatim,
 * then hands the actual judgment call — "what does this record actually
 * assert that is checkable?" — to whoever executes the brief.
 */

import type { BacklogItem } from "./derive.js";

const RULE = "-".repeat(72);

function notApplicableBrief(item: BacklogItem): string {
  return [
    `# Work brief: ${item.record_id} — ${item.title}`,
    ``,
    `File: ${item.file_path}`,
    `Decision status: ${item.decision_status}`,
    `Evidence: ${item.evidence.finding_rule_id} — ${item.evidence.finding_detail}`,
    ``,
    RULE,
    `VERDICT: NOT APPLICABLE`,
    RULE,
    ``,
    item.reason ?? "(no reason recorded — this is a defect in the deriver, not the record; do not proceed)",
    ``,
    `Do NOT author an "## Obligations" section for this record. This record's`,
    `own text already establishes that it commits to no in-repo mechanism (or`,
    `that the actual remediation is an operator/business decision outside`,
    `engineering scope). Writing numbered obligations here would fabricate a`,
    `checkable claim the record never made — the exact defect POL-04 exists`,
    `to catch, reproduced one level down.`,
    ``,
    `If this record is amended in the future to introduce a real, buildable`,
    `commitment, re-run the backlog deriver — this classification is derived`,
    `from the record's current text, not hard-coded, and will change if the`,
    `text does.`,
  ].join("\n");
}

function authorObligationsBrief(item: BacklogItem): string {
  const testImplicationsBlock = item.test_implications_text
    ? [
        `## This record's own "Test implications" section (verbatim)`,
        ``,
        item.test_implications_text,
      ].join("\n")
    : [
        `## This record's own "Test implications" section`,
        ``,
        `(none — this record has no "## Test implications" heading. There is`,
        `no author-supplied pointer to lean on; every proof comment below must`,
        `be derived directly from the Decision text and verified against the`,
        `real working tree, not assumed.)`,
      ].join("\n");

  return [
    `# Work brief: author obligations for ${item.record_id} — ${item.title}`,
    ``,
    `File: ${item.file_path}`,
    `Decision status: ${item.decision_status}`,
    `Evidence: ${item.evidence.finding_rule_id} — ${item.evidence.finding_detail}`,
    ``,
    RULE,
    `TASK: add a "## Obligations" section to ${item.file_path}.`,
    RULE,
    ``,
    `## This record's own "Decision" section (verbatim — the ONLY source of`,
    `truth for what an obligation may assert)`,
    ``,
    item.decision_text,
    ``,
    testImplicationsBlock,
    ``,
    `## Required format, exactly`,
    ``,
    `    ## Obligations`,
    ``,
    `    ### O1 — <one sentence: a checkable claim the Decision text above actually makes>`,
    ``,
    `    <!-- proof: symbol=<ExportedName> file=<repo-relative/path.ts> roundtrip=<repo-relative/path.test.ts> -->`,
    ``,
    `    ### O2 — <next checkable claim>`,
    ``,
    `    <!-- proof: symbol=<ExportedName> roundtrip=<repo-relative/path.test.ts> -->`,
    ``,
    `Ordinals are sequential ("O1", "O2", ...), one "### O<n> — ..." heading`,
    `per obligation, each followed by at least one "<!-- proof: ... -->"`,
    `comment. "file=" is optional; "symbol=" and "roundtrip=" are the fields`,
    `that get checked whether or not "file=" is given.`,
    ``,
    `## Proof-comment resolution rules (packages/arbor-governance/src/obligation/proof.ts)`,
    ``,
    `An obligation is only as good as whether these actually resolve against`,
    `THIS repository's real working tree — do not cite a symbol, file, or`,
    `test you have not confirmed exists:`,
    ``,
    `- "symbol=NAME": NAME must be a top-level`,
    `  "export function/class/interface/type/enum/const/let/var NAME" in the`,
    `  cited "file=" (a re-export via "export { NAME }" also resolves, at`,
    `  lower confidence). If "file=" is omitted, NAME must be uniquely`,
    `  declared/exported somewhere under packages/*/src — more than one match`,
    `  resolves to "unverifiable", not "resolved", so prefer citing "file="`,
    `  whenever more than one file could plausibly contain the symbol.`,
    `- "file=path": optional; the path must exist as a real file under the`,
    `  repository root, or the field resolves to "missing".`,
    `- "roundtrip=path": the path must exist AND be matched by one of`,
    `  vitest.config.ts's own "include" globs. A real file on disk that`,
    `  vitest never collects resolves to "missing", not "resolved" — this is`,
    `  the false-proof case this module exists to catch, so do not cite a`,
    `  test file outside "packages/**/tests/**".`,
    ``,
    RULE,
    `HARD RULE`,
    RULE,
    ``,
    `Every obligation must describe something the Decision text above`,
    `actually asserts — never an invented commitment manufactured to have`,
    `something to check. If, after reading the Decision text and this`,
    `record's Test implications (if any), nothing buildable remains that you`,
    `can honestly turn into a checkable "### O<n>" claim, STOP. Report that`,
    `${item.record_id} should be reclassified "not_applicable" instead —`,
    `do not fabricate an obligation to fill the section.`,
  ].join("\n");
}

/** Renders one backlog item into a complete work brief. Pure — see module header. */
export function renderBrief(item: BacklogItem): string {
  return item.classification === "not_applicable" ? notApplicableBrief(item) : authorObligationsBrief(item);
}
