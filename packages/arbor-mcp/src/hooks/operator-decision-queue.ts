/**
 * `inject.operator-decision-queue` — the native replacement for the deleted
 * `scripts/hooks/codex-decision-interview-session-start.mjs`, and the
 * SessionStart surfacing of every decision the OPERATOR still owns.
 *
 * WHY THIS SUBPROCESSES `scripts/decision-queue.mjs` INSTEAD OF REIMPLEMENTING
 * IT. The script derives the queue from nine sources over three `scripts/lib`
 * dependencies, and `gate:decision-queue` enforces the result. A TypeScript
 * reimplementation would be a SECOND implementation of an invariant the gate
 * already owns, and that drift is SILENT in the worst direction available:
 * the interview would be owed, the injected queue would not mention it, and
 * the model would proceed as though nothing were outstanding with nothing
 * anywhere saying otherwise. So there is exactly one derivation — the
 * subprocess — and this module only maps its JSON to a `Tropism`. Shelling out
 * from a package is legitimate and precedented (`cli.ts`,
 * `native-tools/evidence-refresh.ts`, `repo-session-lifecycle.ts`, which
 * subprocesses this very same script at the session close). The claim in
 * `git-write-guard.ts` that `gate:package-boundaries` forbids it was false —
 * that gate reads import specifiers, never argv — and was corrected in
 * 234dcf7b.
 *
 * THE GUARANTEE BEING PRESERVED, because it is easy to overstate. The handler
 * READS and RENDERS. It has no write path at all: it cannot write
 * `decisions/interviews.jsonl`, cannot record coverage, cannot edit a status or
 * a waiver, and cannot answer on the operator's behalf. That was never the
 * shell hook's property either — it lived in `LEGAL_TRANSITIONS`
 * (`packages/arbor-governance/src/record/status.ts`) plus a store that only
 * PARSES the interview ledger, and a read-only handler cannot weaken either.
 *
 * THE TIMING IS GENUINELY DIFFERENT, and is not papered over. The shell hook
 * fired on the HOST's session start, before the host's first model action;
 * revoy2 does not own that moment. The native guarantee is: *a revoy2-DRIVEN
 * session cannot cross its first model action without the uncovered operator
 * queue being surfaced* — `inject @ session_start` fires before the first
 * model call on every native session, subagent children included.
 *
 * `derived_from` hashes the rows the body is composed of, so §5.3 rule 2's
 * dedupe suppresses a re-render when the queue has not moved. That is the
 * anti-spam property, and also this handler's sharpest failure mode: a queue
 * that stops being read does not lie, it disappears, and a session that finds
 * nothing here has no way to tell that from a session with nothing owed.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Tropism } from "@arbor/prompts";

/**
 * The kinds the deleted hook surfaced, in its fixed render order.
 *
 * Deliberately NOT every owed row: `waiver`, `vi_triage`, `completion_depth` and
 * `discharge_obligation` are real work, but they are not CHOICES the operator
 * makes in an interview, and listing them under "ask the operator" would be a
 * category error. `covered` is excluded for the same reason the script excluded
 * it: a row an interview already answered is not owed.
 */
export const OPERATOR_QUEUE_KINDS = Object.freeze(["proposed_record", "operator_decision", "operator_call"] as const);

export type OperatorQueueKind = (typeof OPERATOR_QUEUE_KINDS)[number];

export interface DecisionQueueRow {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly covered: boolean;
  readonly source?: string;
  readonly due?: string | null;
}

export interface DecisionQueueHazard {
  readonly id: string;
  readonly detail: string;
}

export interface DecisionQueueReport {
  readonly items: readonly DecisionQueueRow[];
  readonly hazards: readonly DecisionQueueHazard[];
}

/** Long enough to survive a skim, and the same window its session-start siblings declare. */
const QUEUE_TTL_TURNS = 3;

const QUEUE_SCRIPT = "decision-queue.mjs";

/**
 * This handler's declared wall-clock bound.
 *
 * DERIVED, not chosen. The bus's 50 ms default is sized for a pure in-process
 * predicate and this handler spawns a `bun` runtime, so the default would drop
 * the tropism — and a dropped tropism is not a warning, it is a session that
 * proceeds with no queue in context. Measured at 57-62 ms over three runs of
 * the real script on this repository, so 2 s is roughly thirty times the
 * measured cost: the same bound and the same reasoning
 * `inject.vi-freshness` declares for a git-spawning sibling, because it is the
 * same cost class. It is also comfortably below the turn loop's
 * `TURN_INJECT_SETTLE_MS`, so a handler that used its whole declared budget
 * still settles inside the window that awaits it rather than being dropped
 * there instead — which would be a named drop instead of a named overrun, for
 * the same underlying cost.
 */
export const OPERATOR_QUEUE_HANDLER_BOUND_MS = 2_000;

const isString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Parses the script's report. Narrow on purpose: this is untrusted-shaped
 * output crossing a process boundary, and a row missing the one field the body
 * is built from is a row the body cannot honestly render.
 */
function parseReport(stdout: string | null): DecisionQueueReport | null {
  if (stdout === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.items)) return null;
  const items: DecisionQueueRow[] = [];
  for (const candidate of record.items) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const row = candidate as Record<string, unknown>;
    if (!isString(row.id) || !isString(row.kind) || !isString(row.summary)) continue;
    items.push(Object.freeze({ id: row.id, kind: row.kind, summary: row.summary, covered: row.covered === true }));
  }
  const hazards: DecisionQueueHazard[] = [];
  for (const candidate of Array.isArray(record.hazards) ? record.hazards : []) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const hazard = candidate as Record<string, unknown>;
    if (!isString(hazard.id) || !isString(hazard.detail)) continue;
    hazards.push(Object.freeze({ id: hazard.id, detail: hazard.detail }));
  }
  return Object.freeze({ items: Object.freeze(items), hazards: Object.freeze(hazards) });
}

/**
 * The one derivation. Returns the script's machine report, or `null` when it
 * could not be produced — which the caller must treat as UNKNOWN, never as an
 * empty queue.
 */
export function runDecisionQueue(repo: string): string | null {
  const script = join(repo, "scripts", QUEUE_SCRIPT);
  if (!existsSync(script)) return null;
  const result = spawnSync("bun", [script, "--json", "--repo", repo], { cwd: repo, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return typeof result.stdout === "string" && result.stdout.trim() !== "" ? result.stdout : null;
}

export function uncoveredOperatorItems(report: DecisionQueueReport): readonly DecisionQueueRow[] {
  return report.items.filter((item) => !item.covered && (OPERATOR_QUEUE_KINDS as readonly string[]).includes(item.kind));
}

const KIND_LABELS: Readonly<Record<OperatorQueueKind, string>> = Object.freeze({
  proposed_record: "Proposed ADRs",
  operator_decision: "operator decisions",
  operator_call: "operator disposal calls",
});

/** The script's own section format and section order, reproduced exactly. */
export function buildOperatorQueueSections(report: DecisionQueueReport): readonly string[] {
  const items = uncoveredOperatorItems(report);
  if (items.length === 0 && report.hazards.length === 0) return [];
  const sections: string[] = [];
  for (const kind of OPERATOR_QUEUE_KINDS) {
    const rows = items.filter((item) => item.kind === kind);
    if (rows.length === 0) continue;
    sections.push(`${KIND_LABELS[kind]} (${rows.length}):\n${rows.map((item) => `- ${item.id}: ${item.summary}`).join("\n")}`);
  }
  if (report.hazards.length > 0) {
    sections.push(`governance hazards (${report.hazards.length}):\n${report.hazards.map((hazard) => `- ${hazard.id}: ${hazard.detail}`).join("\n")}`);
  }
  return sections;
}

/**
 * The tropism, or `null` for the script's `quiet` — which is both "nothing is
 * uncovered" and "the queue could not be read". Those two are deliberately the
 * same shape of answer: a queue this handler could not establish is not a queue
 * it may assert is empty, and `gate:decision-queue` still enforces the real one.
 *
 * The body opens with a NOUN PHRASE on purpose. The deleted script opened with
 * "MANDATORY REVOY2 SESSION-START INTERVIEW", which `HookCatalog`'s
 * advisory-imperative lint REFUSES: a tropism that asks for behaviour must
 * declare lane CODE and name an enforcing_ref, and this one asks for nothing. So
 * the imperative survives on a later line, where the lint — anchored to the
 * first token — cannot reach it.
 */
export function operatorDecisionQueueTropism(root: string, run: (repo: string) => string | null = runDecisionQueue): Tropism | null {
  const report = parseReport(run(root));
  if (report === null) return null;
  const sections = buildOperatorQueueSections(report);
  if (sections.length === 0) return null;
  const body = [
    `revoy2 operator decision queue — ${uncoveredOperatorItems(report).length} uncovered operator-owned row(s) and ${report.hazards.length} governance hazard(s) await a decision that is the operator's alone:`,
    "Each row below is asked through the host's native multiple-choice tool (ADR-178): derive the question pack with `bun scripts/decision-queue.mjs --question-pack`, read each cited source, ask each question verbatim, then record the operator's verbatim answers with `bun scripts/interview-record.mjs --pack <pack> --answers <answers>` (or let the operator run `arbor interview` in a terminal). Never infer an answer, never self-record coverage, and never edit a status or a waiver as part of the interview record. If the operator answers only part of the queue, record only that part.",
    ...sections,
  ].join("\n\n");
  const derivation = Object.freeze({
    items: uncoveredOperatorItems(report).map((item) => [item.id, item.kind, item.summary]),
    hazards: report.hazards.map((hazard) => [hazard.id, hazard.detail]),
  });
  return Object.freeze({
    id: "operator-decision-queue", trigger: "session_start", lane: "ADVISORY", provenance: "generated",
    derived_from: Object.freeze([`decision-queue:${createHash("sha256").update(JSON.stringify(derivation)).digest("hex").slice(0, 16)}`]),
    body, expires_after_turns: QUEUE_TTL_TURNS, enforcing_ref: null,
  });
}
