/**
 * arbor-eval/stage0/journal-usage — spend of sessions that never finish (D9).
 *
 * The campaign audit log gets a node's `usage_cost` span only when the node
 * completes. A session killed by the attempt timeout, or one whose campaign
 * crashed, therefore never reaches it, although every turn's usage reached
 * the harness session journal (`.arbor/harness-sessions.ndjson`) as it
 * happened. This module reads that journal and reports what the audit spans
 * do not already cover:
 *
 * - measured tokens: journal input/output minus the audit spans' input/output
 *   (the two agree exactly on sessions that finished, so the difference is
 *   the sessions the audit never saw). Priced at the configured price
 *   observation, so it is an estimate and is carried apart from the
 *   runtime-priced cost. The journal carries no cache split, so cache reads
 *   and writes of these sessions are not in it;
 * - aborted-turn estimates: a turn aborted mid-stream without a provider
 *   report is a journal usage event with null tokens whose
 *   `unavailable_reason` names an upper bound on the streamed output tokens.
 *   The bound is priced at the output rate (conservative: the true count is
 *   at most the bound). Its input tokens are unknown and are not priced;
 *   an estimate that names no bound is counted, never priced.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Stage0Tokens, Stage0UnrecordedUsage } from "./types.js";

interface JournalUsage {
  readonly input: number;
  readonly output: number;
  readonly estimate_turns: number;
  readonly estimate_output_bound: number;
  readonly unbounded_estimates: number;
  readonly campaign_ids: readonly string[];
}

const ESTIMATE_BOUND = /at most (\d+) output tokens/;

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Totals over every `usage` event in a target's harness session journal, de-duplicated by session and sequence. */
export function journalUsage(target: string): JournalUsage {
  const path = join(target, ".arbor", "harness-sessions.ndjson");
  const empty: JournalUsage = { input: 0, output: 0, estimate_turns: 0, estimate_output_bound: 0, unbounded_estimates: 0, campaign_ids: [] };
  if (!existsSync(path)) return empty;
  const seen = new Set<string>();
  const campaigns = new Set<string>();
  let input = 0;
  let output = 0;
  let estimateTurns = 0;
  let bound = 0;
  let unbounded = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    const record = parse(line) as { kind?: string; summary?: { campaign_id?: unknown }; event?: { session_id?: string; sequence?: number; kind?: string; payload?: { input_tokens?: unknown; output_tokens?: unknown; unavailable_reason?: unknown } } } | null;
    if (record?.kind === "started" && typeof record.summary?.campaign_id === "string") campaigns.add(record.summary.campaign_id);
    const event = record?.event;
    if (record?.kind !== "event" || event?.kind !== "usage" || event.payload === undefined) continue;
    const key = `${String(event.session_id)}#${String(event.sequence)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { input_tokens: i, output_tokens: o, unavailable_reason: reason } = event.payload;
    if (typeof i === "number" && typeof o === "number") {
      input += i;
      output += o;
      continue;
    }
    estimateTurns++;
    const match = typeof reason === "string" ? ESTIMATE_BOUND.exec(reason) : null;
    if (match === null) unbounded++;
    else bound += Number(match[1]);
  }
  return { input, output, estimate_turns: estimateTurns, estimate_output_bound: bound, unbounded_estimates: unbounded, campaign_ids: [...campaigns] };
}

export interface UnrecordedPrice {
  readonly input_minor_units_per_million_tokens: number;
  readonly output_minor_units_per_million_tokens: number;
  readonly minor_unit_exponent: number;
}

/**
 * What the session journal records beyond the audit spans (whose tokens are
 * `recorded`), priced at the configured rates; null when nothing is missing.
 */
export function unrecordedUsage(target: string, recorded: Pick<Stage0Tokens, "input" | "output">, price: UnrecordedPrice): Stage0UnrecordedUsage | null {
  const journal = journalUsage(target);
  const input = Math.max(0, journal.input - recorded.input);
  const output = Math.max(0, journal.output - recorded.output);
  if (input === 0 && output === 0 && journal.estimate_turns === 0) return null;
  const scale = 10 ** price.minor_unit_exponent;
  const cost = (input * price.input_minor_units_per_million_tokens + (output + journal.estimate_output_bound) * price.output_minor_units_per_million_tokens) / 1e6 / scale;
  return {
    input_tokens: input,
    output_tokens: output,
    aborted_turn_estimates: journal.estimate_turns,
    aborted_turn_output_upper_bound: journal.estimate_output_bound,
    unbounded_estimates: journal.unbounded_estimates,
    cost_usd: cost,
    basis: "estimate: session-journal tokens not in the audit spans, priced at the configured rates; no cache split; aborted-turn output bound priced at the output rate, its input unknown",
  };
}

/**
 * The campaign id of an attempt whose `arbor task` reported none (killed by
 * a cap): the journal's session summaries name it, else a single campaign
 * audit log does. Null when the evidence names none or several.
 */
export function campaignIdFromTarget(target: string): string | null {
  const fromJournal = journalUsage(target).campaign_ids;
  if (fromJournal.length === 1) return fromJournal[0];
  if (fromJournal.length > 1) return null;
  const dir = join(target, ".arbor", "audit");
  if (!existsSync(dir)) return null;
  const logs = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  return logs.length === 1 ? logs[0].slice(0, -".jsonl".length) : null;
}
