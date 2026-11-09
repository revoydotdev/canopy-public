#!/usr/bin/env node
/**
 * scripts/claim-ledger.ts — every completeness claim, and whether anything backs it.
 *
 *   bun scripts/claim-ledger.ts            # gate  (bun run gate:claim-ledger)
 *   bun scripts/claim-ledger.ts --refresh  # write (bun run claims:refresh)
 *   ... --json
 *
 * WHAT THIS IS FOR. This repository has good gates for whether the CODE is
 * right. It had none for whether its own ASSERTIONS are backed. Those are
 * different populations, and the second one is larger than it looks: there are
 * only 2 literal TODO/FIXME comments under `packages/*\/src`, but 81 `✅`
 * markers, 38 gap-register rows, 32 ADR statuses, an index table, and a commit
 * history full of "closes G-NN". None of those had a record, a required proof,
 * or an expiry.
 *
 * The defects that motivated this were all found by hand, and all had the same
 * shape — a claim nothing was obliged to back:
 *
 *   - `decisions/README.md` disagreed with the ADR files in four places
 *     (ADR-027/028/029 said Accepted in-file and Draft/Proposed in the index;
 *     ADR-030 was absent entirely). `record/corpus.ts` explicitly EXCLUDES
 *     README.md from parsing, and no other script in the repository reads it,
 *     so nothing could ever have noticed.
 *   - A `🟢` marker at ROADMAP.md:514 sits outside every gate's detection
 *     surface: `docs-truth.mjs` matches `✅` only.
 *   - Ten of the last sixty commits assert closure of a `G-NN`. Nothing links
 *     commit text to the register.
 *
 * ONE FILE, TWO MODES, ON PURPOSE. The producer and the gate share one
 * extraction path. Splitting them is how `.visual-intelligence/`'s refresh
 * recipe came to exist in two places that disagreed, and `extract-exceptions.mjs`
 * states the general rule: "Two stores means two truths, and the older one
 * silently wins."
 *
 * REUSE. ADR parsing and proof resolution come from `@arbor/governance`
 * (`buildObligationCoverageReport`, `sha256Hex`) — the same code
 * `gate:obligations` runs. ROADMAP claim validation defers to
 * `node scripts/docs-truth.mjs --json`, spawned as a subprocess exactly as
 * `docs-truth.mjs` itself spawns `reachability.mjs` (that script sets
 * `process.exitCode` at module scope and cannot be imported). This file
 * inventories claims; it does not re-decide what those two already decide.
 *
 * THE CEILING, stated because a CI log is what people read: a discharged claim
 * means the cited evidence RESOLVES — a file exists, a symbol is reachable, a
 * roundtrip test is collected, an index row matches its file. It does not mean
 * the underlying work is correct, and it inherits every limit
 * `obligations-gate.ts` and `docs-truth.mjs` already document. A claim written
 * in prose this extractor does not recognise is invisible here by construction.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildObligationCoverageReport, sha256Hex } from "@arbor/governance";
import { computeEvidenceContentHashForStore, computeStoreDigest } from "./lib/store-provenance.mjs";
import { assertEvidenceProducerAuthority, evidenceTransactionReadStatus } from "./evidence-transaction.mjs";
import { assertGovernanceConsumerReady, createGovernanceProducerPlan } from "./lib/governance-plan.mjs";

const REPO_ROOT = resolve(argValue("--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
/**
 * `--repo <path>` exists so this gate can be run against a fixture repository
 * rather than only its own checkout (branch-accounting.mjs sets the precedent).
 * Inert when absent: with no flag the root is exactly what it always was.
 */
function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

/**
 * Store location, overridable so a test can point this gate at a fixture rather
 * than mutating the real repository to prove the gate can fail. Defaults to the
 * real store; nothing about normal operation changes.
 */
const STORE_DIR = process.env.REVOY2_CLAIM_LEDGER_DIR
  ? resolve(process.env.REVOY2_CLAIM_LEDGER_DIR)
  : join(REPO_ROOT, ".claim-ledger");
const CLAIMS = join(STORE_DIR, "claims.jsonl");
const MANIFEST = join(STORE_DIR, "manifest.json");
const EXTRACTOR_VERSION = "1.0.0";

const REFRESH = process.argv.includes("--refresh");
const JSON_OUT = process.argv.includes("--json");

/**
 * Ratchet floor: undischarged claims tolerated at adoption.
 *
 * MEASURED 1 on 2026-08-07 against a clean tree, over 139 claims: 32 ADR
 * statuses, 32 index rows, 38 gap-register rows, 15 ✅ headings, 19 ✅ status
 * lines, 2 🟡 headings, 1 🟢 status line. The arithmetic is printed on every
 * run, so this constant can always be checked against the population it counts.
 *
 * The 1 is real and specific: **ROADMAP.md:514's `🟢` status line.** It asserts
 * completion in a marker vocabulary `docs-truth.mjs` does not read (it matches
 * `✅` only), so no gate has ever validated it and no proof comment sits in its
 * section. It is pre-existing backlog, not a regression, and it is exactly the
 * kind of claim this ledger was built to make visible.
 *
 * The correct discharge is to settle the marker vocabulary — either promote the
 * claim to `✅` and attach a proof, or downgrade it to `🟡` if it is substrate.
 * That is a content decision about what the tranche actually is, so it is left
 * to a human rather than resolved by widening the floor and forgetting.
 *
 * It may FALL and must not RISE — the convention `POL_04_FLOOR` and
 * `INDETERMINATE_FLOOR` already set. Raising it to make a red build green is
 * precisely the drift this ledger exists to prevent.
 */
const CLAIM_LEDGER_FLOOR = 1;

type DischargeStatus = "discharged" | "undischarged" | "contradicted" | "waived" | "unverifiable";

interface Claim {
  id: string;
  source: string;
  repository_path: string;
  line: number;
  claim_text: string;
  asserted_value: string;
  discharge_requirement: string;
  discharge_status: DischargeStatus;
  discharge_evidence: { kind: string; ref: string }[];
  first_seen: string;
  last_verified: string;
  content_hash: string;
}

/** Fixed key order — part of the on-disk contract, so the store diffs cleanly. */
const CLAIM_KEYS: (keyof Claim)[] = [
  "id", "source", "repository_path", "line", "claim_text", "asserted_value",
  "discharge_requirement", "discharge_status", "discharge_evidence",
  "first_seen", "last_verified", "content_hash",
];

/** Key-sorted serializer, so a hash never depends on property insertion order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

const shortHash = (input: string) => sha256Hex(input).slice(0, 16);

/**
 * Identity excludes discharge. A claim's TEXT is what makes it that claim; its
 * discharge is expected to change as code changes. Folding discharge into the
 * hash would make every discharge flip read as a brand-new claim, and the gate
 * blocks on new claims — so the ledger would block on its own bookkeeping.
 */
function claimId(source: string, anchor: string): string {
  return `claim:${shortHash(canonical([source, anchor]))}`;
}
function contentHash(claim: Omit<Claim, "id" | "content_hash" | "first_seen" | "last_verified" | "discharge_status" | "discharge_evidence">): string {
  return shortHash(canonical([claim.source, claim.repository_path, claim.claim_text, claim.asserted_value]));
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

// --- source 1+2: ROADMAP markers and the gap register -----------------------

interface DocsTruthReport {
  ok: boolean;
  tranchesChecked: number;
  proofsChecked: number;
  registerRowsChecked: number;
  /**
   * Shape verified by running `node scripts/docs-truth.mjs --json` against a
   * deliberately-broken ROADMAP, not assumed. An earlier version of this file
   * guessed `{heading, detail}`; both are undefined in the real record, so the
   * violated-set was always empty and a new unproven `✅` could never be
   * flagged — a check incapable of firing, inside the gate built to catch
   * checks incapable of firing. It was caught only because the failure test in
   * this ADR's verification plan is mandatory rather than optional.
   */
  violations: { tranche: string; line: number; reason: string }[];
}

/**
 * `--docs-truth-json <path>` reuses a report the caller already produced.
 *
 * WHY. `docs-truth.mjs` itself spawns `reachability.mjs --json`, and this file
 * spawns `docs-truth.mjs`. In a pre-push run that also invokes both gates
 * directly, `reachability` ran THREE times and `docs-truth` TWICE — measured at
 * ~7.5s of a ~30s chain spent recomputing answers the chain already had. A slow
 * pre-push is not a cosmetic problem: it is the thing that makes
 * `--no-verify` a habit, and a bypassed gate protects nothing.
 *
 * This is a reuse path, not a trust flag. The caller passes an actual report
 * produced by an actual run; nothing here assumes "it probably passed".
 */
function computeDocsTruth(): DocsTruthReport | null {
  const flag = process.argv.indexOf("--docs-truth-json");
  if (flag !== -1 && process.argv[flag + 1]) {
    const path = resolve(process.argv[flag + 1]);
    try {
      return JSON.parse(readFileSync(path, "utf8")) as DocsTruthReport;
    } catch {
      // A supplied-but-unreadable report is NOT silently downgraded to "clean" —
      // that would turn a plumbing failure into a false pass. Fall through and
      // compute it properly.
      console.error(`claim-ledger: could not read ${path}; recomputing docs-truth`);
    }
  }
  try {
    const out = execFileSync(process.execPath, [join(REPO_ROOT, "scripts/docs-truth.mjs"), "--json"], {
      cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out) as DocsTruthReport;
  } catch (err) {
    // A non-zero exit is normal — docs-truth exits 1 when it finds violations,
    // and its stdout is still the report we want.
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) { try { return JSON.parse(stdout) as DocsTruthReport; } catch { /* fall through */ } }
    return null;
  }
}

/**
 * One report per process, memoized. `main()` must establish availability
 * BEFORE it takes the producer lease (see the CL-E refusal below), and
 * `extract()` needs the same report; without this the ~7.5s docs-truth spawn
 * above would simply be paid twice per `--refresh`.
 */
let docsTruthCache: DocsTruthReport | null | undefined;
function docsTruth(): DocsTruthReport | null {
  if (docsTruthCache === undefined) docsTruthCache = computeDocsTruth();
  return docsTruthCache;
}

/**
 * `✅` is the only completeness marker `docs-truth.mjs` recognises, so it is the
 * only one any gate validates. `🟢` appears once (ROADMAP.md:514) and asserts
 * completion in a vocabulary nothing checks — the claim is real, the validation
 * is absent, and until now so was any record of that.
 *
 * These are kept in SEPARATE lists on purpose. Folding `🟢` into the validated
 * set would make this ledger report it as discharged on the strength of a gate
 * that never looked at it — inventing the confirmation whose absence is the
 * finding.
 */
const VALIDATED_COMPLETE_MARKERS = ["✅"];
const UNVALIDATED_COMPLETE_MARKERS = ["🟢"];
const PARTIAL_MARKERS = ["🟡"];

/** Index of the nearest heading at or above `from`, or 0 when there is none. */
function findEnclosingHeading(lines: string[], from: number): number {
  for (let i = from; i >= 0; i--) if (/^#+\s/.test(lines[i])) return i;
  return 0;
}

/** Is there a proof comment between this heading and the next of same-or-higher level? */
function hasProofInSection(lines: string[], headingIndex: number): boolean {
  const level = (/^(#+)/.exec(lines[headingIndex]) ?? ["", ""])[1].length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) return false;
    if (lines[i].includes("<!-- proof:")) return true;
  }
  return false;
}

/**
 * Exported for tests that need to drive this against a synthetic ROADMAP and a
 * synthetic docs-truth report — the only two inputs. Every caller inside this
 * file passes the live `dt`.
 */
export function roadmapClaims(dt: DocsTruthReport | null): Claim[] {
  const path = "ROADMAP.md";
  const text = readFileSync(join(REPO_ROOT, path), "utf8");
  const lines = text.split("\n");
  const claims: Claim[] = [];
  /**
   * A `docs-truth` run that produced no usable report is NOT a clean report:
   * `violations` is `[]` either way, so every `✅` below reads as unviolated and
   * DISCHARGES on a validation nobody performed. Unresolved evidence is not
   * evidence, so an unresolved `docs-truth` marks the claim UNDISCHARGED — the
   * same status a real violation produces, because here the two are one fact.
   */
  const resolved = dt !== null;
  const violations = dt?.violations ?? [];
  // Keyed on line number: the most precise join available, and immune to the
  // marker/whitespace differences that make heading-text matching brittle.
  const violatedLines = new Set(violations.map((v) => v.line).filter((n) => typeof n === "number"));
  const violatedTranches = new Set(violations.map((v) => (v.tranche ?? "").trim()).filter(Boolean));

  lines.forEach((line, i) => {
    if (!/^#{2,6}\s/.test(line)) return;
    const validated = VALIDATED_COMPLETE_MARKERS.some((m) => line.includes(m));
    const unvalidated = UNVALIDATED_COMPLETE_MARKERS.some((m) => line.includes(m));
    const partial = PARTIAL_MARKERS.some((m) => line.includes(m));
    if (!validated && !unvalidated && !partial) return;

    const heading = line.replace(/^#+\s*/, "").trim();
    let source: string;
    let requirement: string;
    let status: DischargeStatus;
    let evidence: { kind: string; ref: string }[];

    if (validated) {
      source = "roadmap_heading";
      requirement = "proof_comment";
      status = !resolved || violatedLines.has(i + 1) || violatedTranches.has(heading) ? "undischarged" : "discharged";
      evidence = [{ kind: "gate", ref: "bun run gate:docs-truth" }];
    } else if (unvalidated) {
      // Asserts completion in a marker vocabulary no gate reads. The most this
      // ledger can honestly establish is whether a proof comment is PRESENT —
      // presence is not resolution, and saying otherwise would manufacture the
      // confirmation whose absence is the actual finding.
      source = "roadmap_unvalidated_marker";
      requirement = "proof_comment";
      status = hasProofInSection(lines, i) ? "unverifiable" : "undischarged";
      evidence = [{
        kind: "gap",
        ref: "marker is outside docs-truth.mjs's vocabulary (it matches ✅ only) — no gate validates this claim",
      }];
    } else {
      // Substrate, not completion. Nothing to back; recorded so the ledger's
      // population is the whole marker set rather than only the gated half.
      source = "roadmap_partial_marker";
      requirement = "none_defined";
      status = "unverifiable";
      evidence = [{ kind: "marker", ref: "🟡 asserts substrate, not completion" }];
    }

    claims.push(mk({
      source, repository_path: path, line: i + 1, anchor: heading,
      claim_text: heading,
      asserted_value: partial && !validated && !unvalidated ? "substrate" : "complete",
      discharge_requirement: requirement, discharge_status: status, evidence,
    }));
  });

  // `**Status:**` paragraphs. These carry completion markers too — the single
  // real `🟢` in this repository is one (ROADMAP.md:514, "**Status:** 🟢 the
  // headless core…"), not a heading, which is why a heading-only scan missed it
  // and why it went unrecorded by everything for as long as it has.
  lines.forEach((line, i) => {
    const m = /^\*\*Status(?:\s*\([^)]*\))?:\*\*\s*(.+)$/.exec(line);
    if (!m) return;
    const value = m[1].trim();
    const validated = VALIDATED_COMPLETE_MARKERS.some((mk) => value.includes(mk));
    const unvalidated = UNVALIDATED_COMPLETE_MARKERS.some((mk) => value.includes(mk));
    if (!validated && !unvalidated) return;
    claims.push(mk({
      source: validated ? "roadmap_status_line" : "roadmap_unvalidated_marker",
      repository_path: path, line: i + 1, anchor: `status:${i + 1}`,
      claim_text: value.slice(0, 140), asserted_value: "complete",
      discharge_requirement: "proof_comment",
      discharge_status: validated
        ? (!resolved || violatedLines.has(i + 1) ? "undischarged" : "discharged")
        : (hasProofInSection(lines, findEnclosingHeading(lines, i)) ? "unverifiable" : "undischarged"),
      evidence: validated
        ? [{ kind: "gate", ref: "bun run gate:docs-truth" }]
        : [{ kind: "gap", ref: "marker is outside docs-truth.mjs's vocabulary (it matches ✅ only) — no gate validates this claim" }],
    }));
  });

  // Gap-register rows. docs-truth already validates their citations; the ledger
  // records the CLAIM so a closure has a durable record, not just a passing gate.
  lines.forEach((line, i) => {
    const m = /^\|\s*\*\*(G-\d+)\*\*\s*\|(.*)$/.exec(line);
    if (!m) return;
    const [, gap, rest] = m;
    const closed = /^\s*\*\*(?:CLOSED|RESOLVED|RATIFIED|BOUNDARY)/i.test(rest);
    // The same three inputs its two siblings above consult, for the same
    // reason. This one used to hardcode `closed ? "discharged" : "unverifiable"`
    // and cite `gate:docs-truth` as its evidence while never asking docs-truth
    // anything: fed a RESOLVED report whose violation sat on this row's exact
    // line, the row still read `discharged`, and the gate passed citing a gate
    // that in the same report called its own citation broken. A hardcoded
    // `discharged` is not a weaker check, it is no check — and it survived
    // because the null-docs-truth fix (1cb2dad6) reached two of three siblings
    // 40 lines away and this one was not edited.
    const contradicted = resolved && (violatedLines.has(i + 1) || violatedTranches.has(gap));
    claims.push(mk({
      source: "gap_register_row", repository_path: path, line: i + 1, anchor: gap,
      claim_text: `${gap}: ${rest.slice(0, 120).trim()}`,
      asserted_value: closed ? "closed" : "open",
      discharge_requirement: closed ? "citations_resolve" : "none_defined",
      // docs-truth checks every cited path in every row and is the authority; a
      // clean run means the citations resolve. An unresolved run, or a
      // violation on this row, means nobody established that.
      discharge_status: closed
        ? (!resolved || contradicted ? "undischarged" : "discharged")
        : "unverifiable",
      evidence: [{ kind: "gate", ref: "bun run gate:docs-truth" }],
    }));
  });

  return claims;
}

// --- source 3: ADR file statuses --------------------------------------------

function adrClaims(): { claims: Claim[]; coverageOk: boolean } {
  const claims: Claim[] = [];
  // `at` is a required, caller-supplied timestamp by design — the resolver is a
  // pure function of (proof, repo content, at) so its output is byte-identical
  // across runs. A fixed value keeps this extractor deterministic too.
  const report = buildObligationCoverageReport({ repoRoot: REPO_ROOT, at: "1970-01-01T00:00:00.000Z" });
  if (!report.ok) return { claims, coverageOk: false };

  // The only honest "this claim is not backed" signal is a proof that FAILS TO
  // RESOLVE — rule M-B, which obligations-gate.ts treats as blocking. An
  // obligation with NO proof is explicitly legal: ADR-008 declares three and
  // attaches none, stating that a filesystem-layout claim is not expressible as
  // a symbol/file/roundtrip triple and that forcing one "wouldn't genuinely
  // verify the claim." Counting that as undischarged would punish a record for
  // being honest, and would make this gate disagree with the gate it defers to.
  const unresolved = new Set(
    report.value.findings
      .filter((f) => f.rule_id === "M-B")
      .map((f) => ("record_id" in f.subject ? String(f.subject.record_id) : "")),
  );

  for (const record of report.value.records) {
    const path = record.source_path.replace(`${REPO_ROOT}/`, "");
    const text = existsSync(join(REPO_ROOT, path)) ? readFileSync(join(REPO_ROOT, path), "utf8") : "";
    const statusLine = /^\*\*Status:\*\*\s*(.+)$/m.exec(text);
    if (!statusLine) continue;
    const asserted = statusLine[1].trim();
    const line = text.slice(0, statusLine.index).split("\n").length;
    const accepted = /^accepted/i.test(asserted);

    // An accepted record asserts a decision is in force. Discharge means its
    // cited proofs RESOLVE. Three cases, kept distinct on purpose:
    //   - a proof that fails to resolve (M-B)      -> undischarged
    //   - at least one resolving proof             -> discharged
    //   - obligations declared with no proof, or   -> unverifiable
    //     no obligations at all
    // The third is legal and stated as such by obligations-gate.ts. Calling it
    // undischarged would fail records for being honest about what they cannot
    // prove — the opposite of what this ledger is for.
    let status: DischargeStatus = "unverifiable";
    if (accepted && unresolved.has(record.record_id)) status = "undischarged";
    else if (accepted && record.obligations_with_resolving_proof > 0) status = "discharged";
    claims.push(mk({
      source: "adr_file_status", repository_path: path, line, anchor: record.record_id,
      claim_text: `${record.record_id} is ${asserted}`, asserted_value: asserted,
      discharge_requirement: accepted ? "obligation_proof" : "none_defined",
      discharge_status: status,
      evidence: [
        { kind: "gate", ref: "bun run gate:obligations" },
        { kind: "coverage", ref: `${record.obligations_with_resolving_proof}/${record.obligation_count} obligation(s) with a resolving proof` },
      ],
    }));
  }
  return { claims, coverageOk: true };
}

// --- source 4: the ADR index, which nothing has ever checked ----------------

export interface IndexDefect { adr: string; detail: string; }

export function leadingAdrStatus(value: string): string {
  return String(value).trim().toLowerCase().split(/[\s(]/)[0] ?? "";
}

export function findAdrIndexDefectsFromEntries(indexText: string, adrFiles: ReadonlyMap<string, string>): IndexDefect[] {
  const defects: IndexDefect[] = [];
  const rows = new Map<string, { file: string; status: string; line: number }>();
  indexText.split("\n").forEach((line, i) => {
    const match = /^\|\s*\[(\d+)\]\(([^)]+)\)\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (match) rows.set(match[1].padStart(3, "0"), { file: match[2], status: match[4].trim(), line: i + 1 });
  });
  for (const [file, text] of [...adrFiles].sort(([left], [right]) => left.localeCompare(right))) {
    const number = /^ADR-(\d+)/.exec(file)?.[1];
    if (!number) continue;
    const padded = number.padStart(3, "0");
    const fileStatus = (/^\*\*Status:\*\*\s*(.+)$/m.exec(text) ?? [])[1]?.trim() ?? "";
    const row = rows.get(padded);
    let detail = "";
    if (!row) detail = `ADR-${padded} has no row in decisions/README.md — the index silently omits it`;
    else if (leadingAdrStatus(row.status) !== leadingAdrStatus(fileStatus)) detail = `ADR-${padded}: index says "${row.status}", the file says "${fileStatus}"`;
    else if (row.file !== file) detail = `ADR-${padded}: index links "${row.file}" but the file is "${file}"`;
    if (detail) defects.push({ adr: `ADR-${padded}`, detail });
  }
  return defects;
}

export function findAdrIndexDefects(repoRoot = REPO_ROOT): IndexDefect[] {
  const decisions = join(repoRoot, "decisions");
  const index = join(decisions, "README.md");
  // UNMEASURED, NOT ZERO. An absent index is not an index with no defects: it
  // removes the whole `adr_readme_index_entry` population AND every defect at
  // once, so deleting `decisions/README.md` turned CL-B into a quiet pass with
  // 243 claims instead of 410. Fewer claims read as health. The motivating
  // defect for this whole file is recorded in its header — "ADR-030 was absent
  // entirely" — and the index being absent wholesale is the same failure one
  // level up, so it is reported as the defect it is.
  if (!existsSync(decisions)) {
    return [{ adr: "index", detail: "decisions/ does not exist, so the ADR index cannot be read at all" }];
  }
  if (!existsSync(index)) {
    return [{ adr: "index", detail: "decisions/README.md is absent, so every ADR index claim is UNMEASURED rather than matched — deleting the index removes the claims and the defects together" }];
  }
  const files = new Map(
    readdirSync(decisions)
      .filter((file) => /^ADR-\d+.*\.md$/.test(file))
      .map((file) => [file, readFileSync(join(decisions, file), "utf8")]),
  );
  return findAdrIndexDefectsFromEntries(readFileSync(index, "utf8"), files);
}

function adrIndexClaims(): { claims: Claim[]; defects: IndexDefect[] } {
  const path = "decisions/README.md";
  const claims: Claim[] = [];
  const defects = findAdrIndexDefects(REPO_ROOT);
  const defectByAdr = new Map(defects.map((defect) => [defect.adr, defect]));
  const readmePath = join(REPO_ROOT, path);
  if (!existsSync(readmePath)) return { claims, defects };

  const text = readFileSync(readmePath, "utf8");
  const lines = text.split("\n");
  const rows = new Map<string, { file: string; status: string; line: number }>();
  lines.forEach((line, i) => {
    const m = /^\|\s*\[(\d+)\]\(([^)]+)\)\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (m) rows.set(m[1].padStart(3, "0"), { file: m[2], status: m[4].trim(), line: i + 1 });
  });

  const files = readdirSync(join(REPO_ROOT, "decisions")).filter((f) => /^ADR-\d+.*\.md$/.test(f)).sort();
  for (const file of files) {
    const n = /^ADR-(\d+)/.exec(file)![1];
    const row = rows.get(n);
    const defect = defectByAdr.get(`ADR-${n}`);
    const status: DischargeStatus = defect === undefined
      ? "discharged"
      : defect.detail.includes("has no row") ? "undischarged" : "contradicted";
    claims.push(mk({
      source: "adr_readme_index_entry", repository_path: path, line: row?.line ?? 0,
      anchor: `ADR-${n}`,
      claim_text: `index states ADR-${n} is "${row?.status ?? "(absent)"}"`,
      asserted_value: row?.status ?? "(absent)",
      discharge_requirement: "adr_index_match", discharge_status: status,
      evidence: [{ kind: "file", ref: `decisions/${file}` }],
    }));
  }
  return { claims, defects };
}

// --- source 5: commit messages (report-only, never blocking) ----------------

function commitClaims(since: string | null): Claim[] {
  const range = since ? `${since}..HEAD` : "HEAD~60..HEAD";
  const out = git(["log", range, "--format=%H%x00%s"]);
  if (!out) return [];
  const claims: Claim[] = [];
  for (const row of out.split("\n")) {
    const [sha, subject] = row.split("\0");
    if (!sha || !subject) continue;
    if (!/close[sd]?\s+G-\d+|\bcomplete[d]?\b|\bwired\b/i.test(subject)) continue;
    claims.push(mk({
      source: "commit_message_closure", repository_path: "(git history)", line: 0, anchor: sha,
      claim_text: subject.slice(0, 160), asserted_value: "closure asserted in commit message",
      discharge_requirement: "none_defined",
      // Report-only by design: natural-language commit subjects are too
      // heuristic to gate a push on. Recorded so the surface is visible, not
      // so it can block. This restraint is deliberate, not an oversight.
      discharge_status: "unverifiable",
      evidence: [{ kind: "commit", ref: sha.slice(0, 12) }],
    }));
  }
  return claims;
}

// --- assembly ---------------------------------------------------------------

function mk(input: {
  source: string; repository_path: string; line: number; anchor: string;
  claim_text: string; asserted_value: string; discharge_requirement: string;
  discharge_status: DischargeStatus; evidence: { kind: string; ref: string }[];
}): Claim {
  const base = {
    source: input.source, repository_path: input.repository_path, line: input.line,
    claim_text: input.claim_text, asserted_value: input.asserted_value,
    discharge_requirement: input.discharge_requirement,
  };
  return {
    id: claimId(input.source, input.anchor),
    ...base,
    discharge_status: input.discharge_status,
    discharge_evidence: input.evidence,
    first_seen: "", last_verified: "",
    content_hash: contentHash(base),
  };
}

function extract(since: string | null) {
  const dt = docsTruth();
  const roadmap = roadmapClaims(dt);
  const { claims: adr, coverageOk } = adrClaims();
  const { claims: index, defects } = adrIndexClaims();
  const commits = commitClaims(since);
  const all = [...roadmap, ...adr, ...index, ...commits].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { all, defects, coverageOk };
}

/**
 * How many claims were decided by an actual `docs-truth` report.
 *
 * The control plane's `observes: { min: N }` convention reads this as a plain
 * `observed_count:` line and downgrades a smaller observation to `unresolved`
 * rather than `passed`. Zero here means the validating gate produced nothing, and
 * that is a fact about the run — not a fact about how many claims exist.
 */
function docsTruthObservedCount(all: Claim[], available: boolean): number {
  if (!available) return 0;
  const validated = new Set(["roadmap_heading", "roadmap_status_line"]);
  return all.filter((c) => validated.has(c.source)).length;
}

function readStore(): Map<string, Claim> {
  const map = new Map<string, Claim>();
  if (!existsSync(CLAIMS)) return map;
  for (const line of readFileSync(CLAIMS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const rec = JSON.parse(line) as Claim; map.set(rec.id, rec); } catch { /* skip */ }
  }
  return map;
}

/**
 * Render a complete replacement store from one already-captured canonical
 * source digest.  The digest is deliberately passed in rather than read while
 * writing the sibling directory: provenance describes the producer's source
 * snapshot, never either the old live store or a half-normalized replacement.
 */
export function normalizeStore(claims: Claim[], head: string, contentHash: string, storeDir = STORE_DIR): { staging: string; commit: () => void } {
  mkdirSync(dirname(storeDir), { recursive: true });
  const staging = mkdtempSync(join(dirname(storeDir), `.${basename(storeDir)}.normalizing-`));
  const body = claims
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => `{${CLAIM_KEYS.map((k) => `${JSON.stringify(k)}:${canonical(c[k])}`).join(",")}}`)
    .join("\n");
  writeFileSync(join(staging, "claims.jsonl"), claims.length ? `${body}\n` : "", "utf8");
  // An ancillary regular file is operator-facing policy, not generated evidence.
  // Preserve every one across the generated-store swap; replacing the directory
  // must not silently remove one just because its sibling claims/manifest are
  // refreshed.
  if (existsSync(storeDir)) {
    for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
      if (entry.name === "claims.jsonl" || entry.name === "manifest.json") continue;
      if (!entry.isFile()) throw new Error(`claim-ledger refresh refuses unsupported ancillary entry ${entry.name}; preserve or remove it explicitly before replacing the store`);
      const source = join(storeDir, entry.name);
      const target = join(staging, entry.name);
      copyFileSync(source, target);
      chmodSync(target, statSync(source).mode);
    }
  }
  // The store's OWN bytes. `content_hash` is a digest of this store's INPUTS
  // and can never cover the file a reviewer reads: `.claim-ledger/` is excluded
  // from its own input scope by construction, so editing `claims.jsonl` — or
  // fabricating it wholesale — left `gate:store-freshness` reporting
  // `content hash matches; 0 commit(s) behind HEAD`.
  //
  // ORDER IS LOAD-BEARING: after every other file is in place, and before
  // manifest.json exists, because the digest covers the store except the
  // manifest carrying it. Reordering these writes silently invalidates it.
  const storeDigest = computeStoreDigest(staging);
  writeFileSync(join(staging, "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    scanned_up_to_revision: head,
    content_hash: contentHash,
    store_digest: storeDigest,
    extractor_version: EXTRACTOR_VERSION,
    claim_count: claims.length,
    floor_at_adoption: CLAIM_LEDGER_FLOOR,
  }, null, 2)}\n`, "utf8");
  return {
    staging,
    commit: () => {
      const prior = `${staging}.prior`;
      const hadPrior = existsSync(storeDir);
      try {
        if (hadPrior) renameSync(storeDir, prior);
        renameSync(staging, storeDir);
        if (hadPrior) rmSync(prior, { recursive: true, force: true });
      } catch (error) {
        // A consumer sees the held evidence lease throughout this swap.  Still
        // restore the prior directory whenever possible, so an ordinary write
        // failure does not turn a coherent store into an absent one.
        if (!existsSync(storeDir) && hadPrior && existsSync(prior)) renameSync(prior, storeDir);
        if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    },
  };
}

function main(): number {
  // CL-E: a refresh whose validating gate produced no usable report must write
  // NOTHING. The gate already refuses to call such a run green (CL-C below),
  // but the `--refresh` path never consulted that flag at all: it wrote
  // claims.jsonl + a manifest carrying a real `content_hash` and a real
  // `scanned_up_to_revision` either way, so `gate:store-freshness` then read
  // the result as `ok … content hash matches` — a green freshness signal
  // derived from a validation that never ran. Both halves of that were true at
  // once because the hash covers INPUTS, which a broken docs-truth does not
  // change. Refused here, before the producer lease below, so a refusal cannot
  // itself strand an evidence lease against every sibling producer.
  const docsTruthAvailable = docsTruth() !== null;
  if (REFRESH && !docsTruthAvailable) {
    const message = "CL-E: docs-truth --json produced no usable report, so a refresh now would publish a store "
      + "whose claims were never validated and a manifest that reads as fresh evidence for it. Refused without writing. "
      + "Remedy: run `bun run gate:docs-truth` and fix what it reports, then re-run `bun run claims:refresh`.";
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, code: "validation_unavailable", claims_written: 0, error: message }, null, 2));
    else console.error(message);
    return 1;
  }

  const authority = REFRESH ? assertEvidenceProducerAuthority(REPO_ROOT) : null;
  const plan = REFRESH ? createGovernanceProducerPlan({ name: "claim-ledger-refresh" }) : null;
  if (plan) {
    plan.start("producer");
    authority?.transition?.("claim_ledger_producer_running");
  }
  else {
    try {
      assertGovernanceConsumerReady({ consumer: "claim-ledger gate", evidenceStatus: evidenceTransactionReadStatus({ repo: REPO_ROOT }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (JSON_OUT) console.log(JSON.stringify({ ok: false, code: error && typeof error === "object" && "code" in error ? error.code : "consumer_precondition", error: message }, null, 2));
      else console.error(`claim-ledger gate — FAILED consumer precondition: ${message}`);
      return 1;
    }
  }
  const head = git(["rev-parse", "HEAD"]);
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;
  const prior = readStore();
  const { all, defects, coverageOk } = extract(manifest?.scanned_up_to_revision ?? null);
  // Capture the same scoped input digest store-freshness-gate.mjs validates
  // before normalization starts.  Generated claim-ledger bytes are excluded
  // by store-provenance, so this is a source snapshot rather than a reading of
  // either side of the directory swap.
  const sourceContentHash = REFRESH ? computeEvidenceContentHashForStore(REPO_ROOT, "claim-ledger") : null;
  if (plan) plan.succeed("producer");

  // Carry provenance forward: `first_seen` is history and cannot be re-derived
  // from one revision. Same rule, and the same reason, as the graph's.
  for (const claim of all) {
    const was = prior.get(claim.id);
    claim.first_seen = was?.first_seen || head;
    claim.last_verified = was && was.content_hash === claim.content_hash ? (was.last_verified || head) : head;
  }

  const undischarged = all.filter((c) => c.discharge_status === "undischarged");
  const contradicted = all.filter((c) => c.discharge_status === "contradicted");
  const isNew = (c: Claim) => !prior.has(c.id);
  const newBad = [...undischarged, ...contradicted].filter(isNew);

  if (REFRESH) {
    plan.start("normalization");
    authority?.transition?.("claim_ledger_normalizing");
    const normalized = normalizeStore(all, head, sourceContentHash);
    plan.succeed("normalization");
    plan.start("commit");
    authority?.transition?.("claim_ledger_committing");
    normalized.commit();
    plan.succeed("commit");
    authority?.transition?.("claim_ledger_committed");
    if (JSON_OUT) {
      console.log(JSON.stringify({ ok: true, claims: all.length, transaction_id: authority?.transaction_id ?? null, phase_events: plan.events() }, null, 2));
      return 0;
    }
    console.log(`claim-ledger — wrote ${all.length} claim(s) to .claim-ledger/claims.jsonl at ${head.slice(0, 12)}`);
    const bySource = new Map<string, number>();
    for (const c of all) bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
    for (const [source, n] of [...bySource].sort()) console.log(`  ${String(n).padStart(4)}  ${source}`);
    console.log(`  undischarged=${undischarged.length} contradicted=${contradicted.length}`);
    return 0;
  }

  const observedCount = docsTruthObservedCount(all, docsTruthAvailable);
  const report = {
    ok: true, claims: all.length, undischarged: undischarged.length,
    contradicted: contradicted.length, new_violations: newBad.length,
    index_defects: defects, floor: CLAIM_LEDGER_FLOOR,
    docs_truth_available: docsTruthAvailable, docs_truth_observed: observedCount,
  };

  const failures: string[] = [];
  // CL-C: the validating gate produced no usable report. Not a NOTE — a gate that
  // could not determine anything must not be green. Blocks in its own right rather
  // than relying on CL-R happening to trip on the resulting count.
  if (!docsTruthAvailable) {
    failures.push("CL-C: docs-truth --json produced no usable report, so no ROADMAP claim could be validated — " +
      `${observedCount} observed. No claim is discharged on an unresolved result. ` +
      "Remedy: run `bun run gate:docs-truth` and fix what it reports, then re-run.");
  }
  // CL-B: index-vs-file drift. Unconditional, not ratcheted — a row that
  // disagrees with its own file is a structural bug with no legitimate excuse,
  // and the four that existed were fixed before this gate was wired.
  if (defects.length > 0) {
    failures.push(`CL-B: ${defects.length} decisions/README.md index defect(s) — ${defects.map((d) => d.detail).join("; ")}`);
  }
  // CL-A: only NEW violations block. The backlog is reported, never blocking.
  if (newBad.length > 0) {
    failures.push(`CL-A: ${newBad.length} NEW undischarged/contradicted claim(s):\n` +
      newBad.map((c) => `         ${c.repository_path}:${c.line}  ${c.claim_text.slice(0, 90)}`).join("\n"));
  }
  // CL-R: the ratchet.
  if (undischarged.length > CLAIM_LEDGER_FLOOR) {
    failures.push(`CL-R: ${undischarged.length} undischarged claim(s), above the floor of ${CLAIM_LEDGER_FLOOR} — the floor may fall, never rise`);
  }
  report.ok = failures.length === 0;

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  console.log(`claim-ledger gate — ${all.length} completeness claim(s) across ${new Set(all.map((c) => c.source)).size} source kind(s)`);
  const bySource = new Map<string, { total: number; bad: number }>();
  for (const c of all) {
    const e = bySource.get(c.source) ?? { total: 0, bad: 0 };
    e.total++;
    if (c.discharge_status === "undischarged" || c.discharge_status === "contradicted") e.bad++;
    bySource.set(c.source, e);
  }
  for (const [source, e] of [...bySource].sort()) {
    console.log(`  ${String(e.total).padStart(4)}  ${source.padEnd(28)} ${e.bad ? `${e.bad} unbacked` : ""}`);
  }
  console.log("");
  console.log(`  undischarged: ${undischarged.length} (floor ${CLAIM_LEDGER_FLOOR})   contradicted: ${contradicted.length}   new this run: ${newBad.length}`);
  // The control plane's observation convention: a gate declaring
  // `observes: { min: N }` reads this to refuse to call a smaller observation a
  // pass. Emitted only on the text path — on the JSON path it would corrupt the
  // document, and the control plane never invokes this gate with `--json`.
  console.log(`observed_count: ${observedCount}`);
  if (!docsTruthAvailable) console.log("  NOTE: docs-truth --json produced no usable report; every validated ROADMAP claim is UNDISCHARGED, not discharged");
  if (!coverageOk) console.log("  NOTE: obligation coverage did not build; ADR claims were recorded but not validated");
  console.log("");
  console.log("  Strength: DETECTED, not PREVENTED. A discharged claim means its cited evidence RESOLVES —");
  console.log("  a file exists, a symbol is reachable, a roundtrip test is collected, an index row matches");
  console.log("  its file. It does not mean the work is correct; this inherits every ceiling that");
  console.log("  obligations-gate.ts and docs-truth.mjs already document. Claims written in prose this");
  console.log("  extractor does not recognise are invisible here by construction. Commit-message closures");
  console.log("  are recorded and never blocking — natural language is too heuristic to gate a push on.");
  console.log("  Local-BLOCKED only (ADR-025): bypassable with `git push --no-verify`.");
  console.log("");
  if (failures.length === 0) { console.log("PASS"); return 0; }
  for (const f of failures) console.log(`FAIL — ${f}`);
  return 1;
}

const CLAIM_LEDGER_LIBRARY_IMPORT = Symbol.for("revoy2.claim-ledger.library-import");
if ((globalThis as Record<symbol, unknown>)[CLAIM_LEDGER_LIBRARY_IMPORT] !== true) process.exitCode = main();
