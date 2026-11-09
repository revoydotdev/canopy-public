/**
 * obligation/report.ts — walk every record in `decisions/`, compute its
 * obligation coverage, and render the result as `PolicyFinding[]` per
 * contracts.ts's shared finding shape.
 *
 * Three rule ids, deliberately narrow:
 *   - "POL-04": an `accepted` record that declares zero obligations. This is
 *     the exact shape named by the prior in-repo audit
 *     (`docs/ADR-completion-audit-review.md`, finding F5) — an accepted
 *     record's implementation status resting on prose no reader can check.
 *   - "M-B":    a proof field (symbol=/file=/roundtrip=) that did not resolve
 *     ("missing" or "unverifiable") — a mismatch between what a proof comment
 *     claims and what the working tree actually contains.
 *   - "M-C":    an active (Proposed or Accepted) obligation has neither a
 *     resolving proof nor an explicit unverifiable reason. Draft work may be
 *     incomplete, while Rejected and Superseded records remain historical
 *     evidence rather than active implementation commitments.
 *
 * Determinism: this function takes NO wall-clock reading of its own. `options.at`
 * is a required, caller-supplied timestamp threaded through to every EvidenceRef
 * this report (and everything it calls) produces, `decisions/` entries are
 * processed in sorted filename order, and every downstream collection
 * (obligations, proofs, fields) is iterated in the order it was parsed/produced
 * — never through a Set/Map whose iteration order could vary input-to-input.
 * Same repository content + same `at` => byte-identical
 * `JSON.stringify(report)`, which this package's test suite asserts directly.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { DecisionStatus, GovernanceResult, PolicyFinding } from "../contracts.js";
import { deriveRecordId, parseObligationsFromText } from "./parse.js";
import { computeRecordCoverage, type RecordCoverage } from "./coverage.js";
import { hashContent, PRODUCER_ID, resolveRepoRoot, type ResolveProofOptions } from "./proof.js";

export interface ObligationRecordCoverage extends RecordCoverage {
  /** Parsed from the record itself; null is preserved rather than guessed. */
  decision_status: DecisionStatus | null;
}

export interface ObligationCoverageReport {
  records: readonly ObligationRecordCoverage[];
  findings: readonly PolicyFinding[];
}

export interface BuildReportOptions extends ResolveProofOptions {
  /** Defaults to "<repoRoot>/decisions". Overridable so tests can point this
   * at a fixture directory without touching the real decisions/ tree, which
   * this package does not own and must not modify. */
  decisionsDir?: string;
}

const STATUS_LINE_RE = /^\*\*Status:\*\*\s*(.+)$/m;
const KNOWN_DECISION_STATUSES: readonly DecisionStatus[] = ["draft", "proposed", "accepted", "rejected", "superseded"];

/** Parses an ADR's own `**Status:** <word>` line into a DecisionStatus, or
 * null when absent/unrecognized — never guessed. */
function parseDecisionStatus(text: string): DecisionStatus | null {
  const m = STATUS_LINE_RE.exec(text);
  if (!m) return null;
  const raw = m[1].trim().toLowerCase();
  return (KNOWN_DECISION_STATUSES as readonly string[]).includes(raw) ? (raw as DecisionStatus) : null;
}

export function buildObligationCoverageReport(options: BuildReportOptions): GovernanceResult<ObligationCoverageReport> {
  try {
    const repoRoot = options.repoRoot ?? resolveRepoRoot();
    const decisionsDir = options.decisionsDir ?? resolvePath(repoRoot, "decisions");
    const resolveOptions: ResolveProofOptions = { repoRoot, at: options.at };

    let filenames: string[];
    try {
      filenames = readdirSync(decisionsDir).filter((f) => f.endsWith(".md"));
    } catch (err) {
      return {
        ok: false,
        error: { code: "unavailable", message: `could not read decisions directory ${decisionsDir}: ${err instanceof Error ? err.message : String(err)}`, at: decisionsDir },
        capability: "governance.obligation.report",
      };
    }
    filenames.sort(); // deterministic regardless of readdir order

    const records: ObligationRecordCoverage[] = [];
    const findings: PolicyFinding[] = [];

    for (const basename of filenames) {
      const recordId = deriveRecordId(basename);
      if (!recordId) continue; // README.md and anything else that isn't an ADR-NNN record

      const sourcePath = `decisions/${basename}`;
      const text = readFileSync(resolvePath(decisionsDir, basename), "utf-8");

      const parsed = parseObligationsFromText(recordId, sourcePath, text);
      if (!parsed.ok) return { ok: false, error: parsed.error, capability: parsed.capability };

      const coverage = computeRecordCoverage(parsed.value, resolveOptions);
      if (!coverage.ok) return { ok: false, error: coverage.error, capability: coverage.capability };
      const decisionStatus = parseDecisionStatus(text);
      records.push({ ...coverage.value, decision_status: decisionStatus });
      if (decisionStatus === "accepted" && coverage.value.obligation_count === 0) {
        findings.push({
          rule_id: "POL-04",
          severity: "warning",
          subject: { record_id: recordId },
          detail: `${recordId} is accepted but declares zero obligations — its "implemented" status rests on prose, not on anything a reader can check.`,
          remediation: `Add a "## Obligations" section to ${sourcePath} with numbered "### O<n> — ..." items and proof comments, or accept that ${recordId}'s implementation status is currently unfalsifiable as written.`,
          evidence: [{ kind: "code_location", ref: sourcePath, producer: PRODUCER_ID, at: options.at, content_hash: hashContent(text) }],
          waiver_eligible: true,
          is_legacy_debt: true,
        });
      }

      for (const obligation of coverage.value.obligations) {
        for (const proof of obligation.proofs) {
          const fields = [proof.symbol, proof.file, proof.roundtrip];
          for (const field of fields) {
            if (!field || field.state === "resolved") continue;
            findings.push({
              rule_id: "M-B",
              severity: field.state === "missing" ? "blocker" : "warning",
              subject: { record_id: recordId },
              detail: `${recordId} ${obligation.ordinal}: proof field "${field.field}=${field.value ?? ""}" is ${field.state} — ${field.detail}`,
              remediation:
                field.state === "missing"
                  ? `Fix or remove the "${field.field}=" citation in ${recordId} ${obligation.ordinal} (${sourcePath}) — it does not resolve against the working tree.`
                  : `Disambiguate the "${field.field}=" citation in ${recordId} ${obligation.ordinal} (${sourcePath}) so it resolves to exactly one target.`,
              evidence: field.evidence,
              waiver_eligible: field.state === "unverifiable",
              is_legacy_debt: false,
            });
          }
        }

        if (
          (decisionStatus === "proposed" || decisionStatus === "accepted")
          && obligation.resolving_proof_count === 0
          && !obligation.unverifiable_reason
        ) {
          findings.push({
            rule_id: "M-C",
            severity: "blocker",
            subject: { record_id: recordId },
            detail: `${recordId} ${obligation.ordinal}: active obligation has no resolving proof and no explicit unverifiable reason.`,
            remediation: `Add a resolving proof to ${recordId} ${obligation.ordinal} (${sourcePath}), or document a truthful one-line <!-- unverifiable: reason --> if the claim cannot be mechanically witnessed.`,
            evidence: [{ kind: "code_location", ref: sourcePath, producer: PRODUCER_ID, at: options.at, content_hash: hashContent(text) }],
            waiver_eligible: true,
            is_legacy_debt: false,
          });
        }
      }
    }

    return { ok: true, capability: "governance.obligation.report", value: { records, findings } };
  } catch (err) {
    return {
      ok: false,
      error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
      capability: "governance.obligation.report",
    };
  }
}
