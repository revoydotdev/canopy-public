/** Additive, provenance-bearing context management for native model turns. */
import type { Provenance } from "@arbor/core";
import type { NativeContextEvidenceRef } from "./inference.js";
import { redactCredentialShapes } from "./credential-shape-redaction.js";

export type NativeContextOperation = "generate" | "reflect" | "curate" | "evidence" | "human_input";
export const NATIVE_CONTEXT_SOURCES = Object.freeze([
  "system_instructions", "project_instructions", "task", "repository_graph", "code",
  "tool_output", "trajectory", "memory", "critic_feedback", "human_input",
] as const);
export type NativeContextSource = typeof NATIVE_CONTEXT_SOURCES[number];
export type NativeContextCacheClass = "stable" | "dynamic";
export type NativeContextDisposition = "absent" | "retained" | "pruned" | "indexed" | "mixed";
/**
 * Selection strength is semantic, not merely chronological. Required facts
 * fail closed if they cannot coexist in the active window; preferred facts
 * outrank opportunistic transcript bulk while remaining prunable.
 */
export type NativeContextRetention = "required" | "preferred" | "opportunistic";

export interface NativeContextBudget {
  readonly max_tokens: number;
  /** Space held back for a model response; context may use at most the remainder. */
  readonly reserve_output_tokens: number;
}

export interface NativeContextEntry {
  readonly entry_id: string;
  readonly operation: NativeContextOperation;
  /** Semantic origin, independent of the lifecycle operation that appended it. */
  readonly source: NativeContextSource;
  readonly text: string;
  readonly token_count: number;
  readonly retention: NativeContextRetention;
  readonly provenance: Provenance;
  /** Earlier context facts used to produce this addition. */
  readonly evidence: readonly NativeContextEvidenceRef[];
}

export interface NativeContextCheckpoint {
  readonly sequence: number;
  readonly used_tokens: number;
  readonly entry_ids: readonly string[];
}

export interface NativeContextSnapshot {
  readonly checkpoint: NativeContextCheckpoint;
  readonly entries: readonly NativeContextEntry[];
  readonly used_tokens: number;
  readonly available_tokens: number;
  readonly compacted: boolean;
}

/**
 * A read-only projection of what a snapshot actually contains, for
 * token-economy telemetry. `offered` is every entry ever appended;
 * `retained` is what `snapshot()` currently selects; `pruned` is the
 * difference. `stable_prefix` is the folded `curate` summary (if any),
 * `dynamic` is the remaining retained entries, and `indexed_reference` is
 * retained `evidence` entries — pointer-shaped facts rather than live
 * generation. This never influences selection, folding, or budget
 * decisions; it only observes them after the fact.
 */
export interface NativeContextCompositionObservation {
  readonly offered_tokens: number;
  readonly retained_tokens: number;
  readonly pruned_tokens: number;
  readonly indexed_reference_tokens: number;
  readonly stable_prefix_tokens: number;
  readonly dynamic_tokens: number;
  /**
   * A fixed-size (bounded) breakdown, one row per `NativeContextOperation`,
   * each carrying both its offered and retained token counts — the ten
   * per-source numbers underlying the six aggregate counters above. Always
   * exactly `NATIVE_CONTEXT_OPERATIONS.length` rows, in a stable order, so
   * this can never grow unbounded with entry count.
   */
  readonly per_source: readonly NativeContextSourceComposition[];
}

export interface NativeContextSourceComposition {
  readonly source: NativeContextSource;
  readonly offered_tokens: number;
  readonly retained_tokens: number;
  readonly cache_class: NativeContextCacheClass;
  readonly disposition: NativeContextDisposition;
  readonly reason: string;
  /** Provenance of this derived row; entry provenance remains in the append-only store. */
  readonly provenance: Provenance;
  /** Content-free pointer joining the row to its bounded aggregate digest. */
  readonly evidence_pointer: string;
}

export interface NativeContextManagerOptions {
  readonly budget: NativeContextBudget;
  /** Injected measurement prevents a hidden provider tokenizer or heuristic. */
  readonly count_tokens: (text: string) => number;
  readonly redaction?: NativeRedactionPolicy;
  /** Opaque redaction capability may remain owned by a credential broker. */
  readonly redactor?: NativeContextRedactorPort;
  /**
   * Optional per-entry ceiling applied only to `tool_output`-sourced entries.
   * A single raw tool result (a large file read, verbose shell output) can
   * otherwise consume a large share of the whole session budget on its own,
   * accelerating the fold cadence and starving later turns even though
   * `append()`'s overall budget check would still admit it. Left unset,
   * tool-output entries are bounded only by that overall check (today's
   * behavior); composition roots serving real sessions should set this.
   */
  readonly max_tool_output_tokens?: number;
  /**
   * Automatic mid-session compaction. Absent means enabled at the
   * conservative default threshold (see `DEFAULT_COMPACTION_THRESHOLD_FRACTION`);
   * `enabled: false` turns automatic compaction off entirely — `compact()`
   * then always resolves `{ kind: "disabled" }` and never appends an anchor.
   */
  readonly compaction?: NativeContextCompactionConfig;
}

/**
 * A composition-owned, injectable model-call seam for turning folded turn
 * history into a real semantic summary (§ROADMAP: "an actual compaction").
 * `summarize` is async because a genuine implementation calls a model; a
 * test double may resolve synchronously so compaction stays deterministic.
 * Returning `unavailable` (never throwing, though `compact()` also treats a
 * thrown rejection the same way) falls back to the always-available
 * structural fold rather than blocking compaction on the summarizer.
 */
export interface NativeContextSummarizerPort {
  summarize(input: {
    readonly candidates: readonly NativeContextEntry[];
    /** Upper bound, in the manager's own counter units, for the returned summary text. */
    readonly max_tokens: number;
  }): Promise<{ readonly kind: "summarized"; readonly text: string } | { readonly kind: "unavailable"; readonly reason: string }>;
}

export type NativeContextCompactionMethod = "structural_fold" | "model_summary";

/**
 * Closed reasons `compact()` may honestly decline to produce an anchor even
 * though the threshold was crossed. Never emitted for "nothing needed
 * compacting" (that is `not_triggered`) or "compaction is turned off" (that
 * is `disabled`) — only for a real, evidenced incapacity, so a caller can
 * tell "we chose not to" from "there was nothing to compact".
 */
export type NativeContextCompactionSkipReason =
  | "no_foldable_candidates"
  | "anchor_uncapturable";

/**
 * Typed pre/post evidence for one compaction (ROADMAP: the missing half of
 * the withdrawn automatic-compaction claim). `pre_tokens`/`post_tokens` are
 * both measured from the same `sumTokens`/`snapshot()` machinery the manager
 * already uses for admission, never a separate estimator.
 * `anchored_entry_ids` plus `integrity_hash` make the compaction
 * reversible-in-principle: every folded entry's identity is named, its raw
 * text remains in the durable append-only store, and the hash lets a
 * replay verify the exact input set that produced the anchor.
 */
export interface NativeContextCompactionEvidence {
  readonly compaction_id: string;
  readonly method: NativeContextCompactionMethod;
  readonly pre_tokens: number;
  readonly post_tokens: number;
  readonly threshold_tokens: number;
  readonly anchored_entry_ids: readonly string[];
  readonly anchor_entry_id: string;
  readonly integrity_hash: string;
  readonly provenance: Provenance;
}

export type NativeContextCompactionOutcome =
  | { readonly kind: "disabled" }
  | { readonly kind: "not_triggered"; readonly used_tokens: number; readonly threshold_tokens: number }
  | { readonly kind: "cooldown"; readonly remaining_turns: number; readonly cooldown_until_turn: number }
  | { readonly kind: "compacted"; readonly anchor: NativeContextEntry; readonly evidence: NativeContextCompactionEvidence }
  | { readonly kind: "skipped"; readonly reason: NativeContextCompactionSkipReason; readonly detail: string; readonly pre_tokens: number; readonly threshold_tokens: number };

/** Fraction of the usable budget (`max_tokens - reserve_output_tokens`) that triggers automatic compaction. See ROADMAP's withdrawn automatic-compaction claim for why ON-by-default is the recommended default: bounded turns plus context growth was the historical native session killer. Firing at 0.75 (not 1.0) leaves headroom before the hard per-entry/per-request budget check in `append()` would otherwise reject a turn outright. */
export const DEFAULT_COMPACTION_THRESHOLD_FRACTION = 0.75;

export interface NativeContextCompactionConfig {
  /** `false` disables automatic compaction; every other value keeps it on. */
  readonly enabled?: boolean;
  /** Must be in `(0, 1]` when configured. Defaults to `DEFAULT_COMPACTION_THRESHOLD_FRACTION`. */
  readonly threshold_fraction?: number;
  /** Optional real summarizer; absent means every compaction uses the deterministic structural fold. */
  readonly summarizer?: NativeContextSummarizerPort;
  readonly max_descriptors?: number;
  readonly preview_chars?: number;
  /** Number of model turns to wait after a successful compaction before another attempt. */
  readonly cooldown_turns?: number;
}

export interface NativeRedactionPolicy {
  /** Exact values that must never enter retained context or an intent summary. */
  readonly secrets?: readonly string[];
  readonly replacement?: string;
}

/** The manager holds this capability, never its underlying credential value. */
export interface NativeContextRedactorPort {
  redact(value: string): string;
}

export interface NativeContextAppend {
  readonly entry_id: string;
  readonly text: string;
  readonly provenance: Provenance;
  /** Defaults conservatively from the append operation for compatibility. */
  readonly source?: NativeContextSource;
  /** Defaults from source; callers may only strengthen or explicitly relax it. */
  readonly retention?: NativeContextRetention;
  readonly evidence?: readonly NativeContextEvidenceRef[];
}

/**
 * Context remains append-only.  Curation adds a new, attributable projection;
 * it never deletes or rewrites the facts from which it was derived.  Snapshot
 * selection is deterministic and retains the latest curation plus referenced
 * evidence instead of silently collapsing history into an untraceable string.
 */
export class NativeContextManager {
  private readonly budget: NativeContextBudget;
  private readonly counter: NativeContextManagerOptions["count_tokens"];
  private readonly redaction: NativeRedactionPolicy;
  private readonly redactor: NativeContextRedactorPort | undefined;
  private readonly maxToolOutputTokens: number | undefined;
  private readonly compactionEnabled: boolean;
  private readonly compactionThresholdFraction: number;
  private readonly summarizer: NativeContextSummarizerPort | undefined;
  private readonly compactionMaxDescriptors: number;
  private readonly compactionPreviewChars: number;
  private readonly compactionCooldownTurns: number;
  private lastCompactionTurn: number | null = null;
  private compactAttemptTurn = 0;
  private readonly entries: NativeContextEntry[] = [];

  constructor(options: NativeContextManagerOptions) {
    validateBudget(options.budget);
    if (options.max_tool_output_tokens !== undefined && (!Number.isSafeInteger(options.max_tool_output_tokens) || options.max_tool_output_tokens <= 0)) {
      throw new NativeContextError("max_tool_output_tokens must be a positive safe integer when configured");
    }
    const threshold = options.compaction?.threshold_fraction ?? DEFAULT_COMPACTION_THRESHOLD_FRACTION;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new NativeContextError("compaction.threshold_fraction must be a number in (0, 1] when configured");
    }
    const cooldown = options.compaction?.cooldown_turns ?? 0;
    if (!Number.isSafeInteger(cooldown) || cooldown < 0) throw new NativeContextError("compaction.cooldown_turns must be a non-negative safe integer when configured");
    this.budget = Object.freeze({ ...options.budget });
    this.counter = options.count_tokens;
    this.redaction = Object.freeze({ secrets: Object.freeze([...(options.redaction?.secrets ?? [])]), replacement: options.redaction?.replacement ?? "[REDACTED]" });
    this.redactor = options.redactor;
    this.maxToolOutputTokens = options.max_tool_output_tokens;
    this.compactionEnabled = options.compaction?.enabled ?? true;
    this.compactionThresholdFraction = threshold;
    this.summarizer = options.compaction?.summarizer;
    this.compactionMaxDescriptors = Math.max(1, options.compaction?.max_descriptors ?? 40);
    this.compactionPreviewChars = Math.max(16, options.compaction?.preview_chars ?? 120);
    this.compactionCooldownTurns = cooldown;
  }

  generate(input: NativeContextAppend): NativeContextEntry { return this.append("generate", input); }
  reflect(input: NativeContextAppend): NativeContextEntry { return this.append("reflect", input); }
  curate(input: NativeContextAppend): NativeContextEntry { return this.append("curate", input); }
  evidence(input: NativeContextAppend): NativeContextEntry { return this.append("evidence", input); }
  humanInput(input: NativeContextAppend): NativeContextEntry { return this.append("human_input", input); }

  checkpoint(): NativeContextCheckpoint {
    return Object.freeze({ sequence: this.entries.length, used_tokens: sumTokens(this.entries), entry_ids: Object.freeze(this.entries.map((entry) => entry.entry_id)) });
  }

  has(entryId: string): boolean { return this.entries.some((entry) => entry.entry_id === entryId); }

  /** Apply this manager's broker-owned and generic redaction without appending context. */
  redact(value: string): string {
    const externallyRedacted = this.redactor === undefined ? value : this.redactor.redact(value);
    if (typeof externallyRedacted !== "string") throw new NativeContextError("context redactor must return a string");
    return redactNativeText(externallyRedacted, this.redaction);
  }

  /** Fails closed rather than allowing a tool to cite an unknown context fact. */
  assertEvidence(refs: readonly NativeContextEvidenceRef[]): void {
    for (const ref of refs) {
      const entry = this.entries.find((candidate) => candidate.entry_id === ref.entry_id);
      if (!entry || !sameProvenance(entry.provenance, ref.provenance)) throw new NativeContextError(`unknown or mismatched context evidence: ${ref.entry_id}`);
    }
  }

  /**
   * Deterministic structural fold. `snapshot()` keeps a bounded recent tail and
   * silently drops everything older; over a long session that loses old history
   * to nothing and, before the drop, inflates every request toward the
   * per-request budget ceiling. This instead rolls the non-recent entries into
   * one `curate` summary that retains each folded entry's identity, operation,
   * provenance tag, and a bounded head/tail preview — Commandment VII: keep
   * identities and pointers before eliding bulk. The raw entries remain in
   * durable append-only storage for audit; only the model's projection shrinks.
   *
   * It supersedes rather than accumulates: each fold's candidates include any
   * prior fold, so the newest curation always covers all non-recent history and
   * `snapshot()` (which keeps only the newest curation) stays complete-enough.
   * Returns the appended fold entry, or null when nothing needed folding.
   */
  foldToRecentTail(options: { readonly fold_entry_id: string; readonly recent_tail_fraction?: number; readonly max_descriptors?: number; readonly preview_chars?: number }): NativeContextEntry | null {
    const limit = this.budget.max_tokens - this.budget.reserve_output_tokens;
    if (sumTokens(this.entries) <= limit) return null; // still fits verbatim; nothing to fold
    const fraction = options.recent_tail_fraction ?? 0.5;
    const candidates = this.selectFoldCandidates(fraction > 0 && fraction < 1 ? fraction : 0.5, limit);
    if (candidates.length === 0) return null;
    const text = this.buildStructuralAnchorText(candidates, limit, Math.max(1, options.max_descriptors ?? 40), Math.max(16, options.preview_chars ?? 120));
    return this.append("curate", { entry_id: options.fold_entry_id, text, source: "memory", provenance: { tag: "generated", generator: "native-context-fold", input_hash: foldInputHash(candidates) } });
  }

  /**
   * Walks newest-first, keeping entries within `limit * tailFraction`
   * verbatim; everything older (including any prior fold/anchor) becomes a
   * fold/compaction candidate. Shared by `foldToRecentTail` and `compact` so
   * their notions of "recent enough to keep verbatim" never diverge.
   */
  private selectFoldCandidates(tailFraction: number, limit: number): NativeContextEntry[] {
    const tailBudget = Math.max(0, Math.floor(limit * tailFraction));
    const recentIds = new Set<string>();
    let tail = 0;
    for (const entry of [...this.entries].reverse()) {
      if (tail + entry.token_count > tailBudget) break;
      tail += entry.token_count;
      recentIds.add(entry.entry_id);
    }
    return this.entries.filter((entry) => !recentIds.has(entry.entry_id));
  }

  /**
   * Deterministic head/tail descriptor text for a set of fold candidates,
   * shrunk (dropping oldest descriptors, then hard-truncating) until it fits
   * `limit` under this manager's own counter. This is `compact`'s always-
   * available fallback method (`structural_fold`): it makes no model call
   * and cannot fail for lack of a summarizer, so automatic compaction never
   * depends on an optional seam to produce real, evidenced output.
   */
  private buildStructuralAnchorText(candidates: readonly NativeContextEntry[], limit: number, maxDescriptors: number, previewChars: number): string {
    // Most recent candidates carry the most useful detail; older ones collapse
    // to a bounded count so the fold text itself stays within budget.
    const detailed = candidates.slice(-maxDescriptors);
    const descriptors = detailed.map((entry) => `[${entry.entry_id}] ${entry.operation}/${entry.provenance.tag}: ${preview(entry.text, previewChars)}`);
    const header = (kept: number): string => `Folded ${candidates.length} earlier context ${candidates.length === 1 ? "entry" : "entries"} (raw retained in durable context)${kept < candidates.length ? `; ${candidates.length - kept} elided below the cap` : ""}.`;
    let text = [header(descriptors.length), ...descriptors].join("\n");
    // Never exceed the entry-size ceiling `append` enforces. First drop
    // descriptors from the tail; if the header alone still overflows a small
    // budget, hard-truncate it (monotonic in length for any real counter).
    while (this.counter(text) > limit && descriptors.length > 0) {
      descriptors.shift(); // drop the oldest descriptor first; recent folded entries are the more useful to retain
      text = [header(descriptors.length), ...descriptors].join("\n");
    }
    while (this.counter(text) > limit && text.length > 1) text = text.slice(0, codePointSafeIndex(text, Math.max(1, Math.floor(text.length * 0.8))));
    return text;
  }

  /**
   * Automatic, evidenced compaction (extends `foldToRecentTail`'s always-on
   * structural fold — this closes the ROADMAP gap it left open). Fires on a
   * real, measured threshold crossed mid-session
   * (`compactionThresholdFraction` of the usable budget), not only once the
   * hard per-request ceiling is already exceeded. When a summarizer is
   * configured it is tried first for a real semantic anchor; an
   * `unavailable` result or a thrown rejection falls back to the always-safe
   * structural fold rather than blocking compaction — so a broken/unset
   * summarizer degrades gracefully instead of losing automatic compaction.
   *
   * Every branch is either a real evidenced compaction (`compacted`, with
   * measured pre/post tokens and the exact anchored entry ids) or an honest
   * typed report of why one did not happen (`disabled`, `not_triggered`, or
   * `skipped` with a concrete reason) — never a fabricated evidence record,
   * per the ROADMAP finding that made this design necessary.
   */
  async compact(options: {
    readonly compaction_id: string;
    readonly turn?: number;
    /** Bypass threshold and cooldown for a caller-confirmed hard context limit. */
    readonly force?: boolean;
  }): Promise<NativeContextCompactionOutcome> {
    const limit = this.budget.max_tokens - this.budget.reserve_output_tokens;
    const preTokens = sumTokens(this.entries);
    if (!this.compactionEnabled) return Object.freeze({ kind: "disabled" });
    const turn = options.turn ?? ++this.compactAttemptTurn;
    if (!Number.isSafeInteger(turn) || turn < 1) throw new NativeContextError("compaction turn must be a positive safe integer");
    this.compactAttemptTurn = Math.max(this.compactAttemptTurn, turn);
    const thresholdTokens = Math.floor(limit * this.compactionThresholdFraction);
    if (!options.force && preTokens <= thresholdTokens) return Object.freeze({ kind: "not_triggered", used_tokens: preTokens, threshold_tokens: thresholdTokens });
    if (!options.force && this.lastCompactionTurn !== null && turn < this.lastCompactionTurn + this.compactionCooldownTurns) {
      const until = this.lastCompactionTurn + this.compactionCooldownTurns;
      return Object.freeze({ kind: "cooldown", remaining_turns: until - turn, cooldown_until_turn: until });
    }

    const candidates = this.selectFoldCandidates(0.5, limit);
    if (candidates.length === 0) {
      return Object.freeze({ kind: "skipped", reason: "no_foldable_candidates", detail: "every retained entry is within the recent tail; nothing older is available to compact", pre_tokens: preTokens, threshold_tokens: thresholdTokens });
    }

    let method: NativeContextCompactionMethod = "structural_fold";
    let text: string | null = null;
    if (this.summarizer !== undefined) {
      let summarized: Awaited<ReturnType<NativeContextSummarizerPort["summarize"]>>;
      try {
        summarized = await this.summarizer.summarize({ candidates, max_tokens: Math.floor(limit * 0.5) });
      } catch {
        summarized = { kind: "unavailable", reason: "summarizer rejected" };
      }
      if (summarized.kind === "summarized" && summarized.text.trim().length > 0) {
        method = "model_summary";
        const ids = candidates.map((entry) => entry.entry_id);
        const idList = ids.length > this.compactionMaxDescriptors
          ? `${ids.slice(0, this.compactionMaxDescriptors).join(", ")}, +${ids.length - this.compactionMaxDescriptors} more`
          : ids.join(", ");
        let summaryText = `Compacted ${candidates.length} earlier context ${candidates.length === 1 ? "entry" : "entries"} via model summary (raw retained in durable context): ${idList}\n${summarized.text}`;
        while (this.counter(summaryText) > limit && summaryText.length > 1) summaryText = summaryText.slice(0, codePointSafeIndex(summaryText, Math.max(1, Math.floor(summaryText.length * 0.8))));
        text = summaryText;
      }
    }
    if (text === null) text = this.buildStructuralAnchorText(candidates, limit, this.compactionMaxDescriptors, this.compactionPreviewChars);

    let anchor: NativeContextEntry;
    try {
      anchor = this.append("curate", {
        entry_id: options.compaction_id,
        text,
        source: "memory",
        provenance: { tag: "generated", generator: method === "model_summary" ? "native-context-summary" : "native-context-fold", input_hash: foldInputHash(candidates) },
      });
    } catch (error) {
      return Object.freeze({
        kind: "skipped",
        reason: "anchor_uncapturable",
        detail: error instanceof Error ? error.message : "compaction anchor could not be appended",
        pre_tokens: preTokens,
        threshold_tokens: thresholdTokens,
      });
    }

    const postTokens = this.snapshot().used_tokens;
    this.lastCompactionTurn = turn;
    const evidence: NativeContextCompactionEvidence = Object.freeze({
      compaction_id: options.compaction_id,
      method,
      pre_tokens: preTokens,
      post_tokens: postTokens,
      threshold_tokens: thresholdTokens,
      anchored_entry_ids: Object.freeze(candidates.map((entry) => entry.entry_id)),
      anchor_entry_id: anchor.entry_id,
      integrity_hash: foldInputHash(candidates),
      provenance: anchor.provenance,
    });
    return Object.freeze({ kind: "compacted", anchor, evidence });
  }

  snapshot(): NativeContextSnapshot {
    const limit = this.budget.max_tokens - this.budget.reserve_output_tokens;
    const selected: NativeContextEntry[] = [];
    const selectedIds = new Set<string>();
    // Required facts are admitted as a set at append time, so selection can
    // never silently trade the task, human direction, or governing
    // instructions for a more recent tool transcript.
    for (const entry of this.entries.filter((candidate) => candidate.retention === "required")) {
      addWithEvidence(entry, this.entries, selected, selectedIds, limit);
    }
    const newestCuration = [...this.entries].reverse().find((entry) => entry.operation === "curate");
    if (newestCuration) addWithEvidence(newestCuration, this.entries, selected, selectedIds, limit);
    for (const retention of ["preferred", "opportunistic"] as const) {
      for (const entry of [...this.entries].reverse()) {
        if (entry.retention === retention) addWithEvidence(entry, this.entries, selected, selectedIds, limit);
      }
    }
    selected.sort((a, b) => this.entries.indexOf(a) - this.entries.indexOf(b));
    const used = sumTokens(selected);
    return Object.freeze({
      checkpoint: this.checkpoint(),
      entries: Object.freeze(selected),
      used_tokens: used,
      available_tokens: limit - used,
      compacted: selected.length !== this.entries.length,
    });
  }

  /** Pure derivation from `snapshot()`; does not itself select, fold, or prune. */
  observeComposition(): NativeContextCompositionObservation {
    const snapshot = this.snapshot();
    const offered_tokens = sumTokens(this.entries);
    const retained_tokens = snapshot.used_tokens;
    const stable_prefix_tokens = sumTokens(snapshot.entries.filter((entry) => nativeContextCacheClass(entry.source) === "stable"));
    const indexed_reference_tokens = sumTokens(snapshot.entries.filter((entry) => entry.operation === "evidence"));
    const per_source = Object.freeze(NATIVE_CONTEXT_SOURCES.map((source) => {
      const offered = this.entries.filter((entry) => entry.source === source);
      const retained = snapshot.entries.filter((entry) => entry.source === source);
      const offeredForSource = sumTokens(offered);
      const retainedForSource = sumTokens(retained);
      const indexed = retained.length > 0 && retained.every((entry) => entry.operation === "evidence");
      const disposition: NativeContextDisposition = offeredForSource === 0 ? "absent"
        : retainedForSource === 0 ? "pruned"
          : indexed ? "indexed"
            : retainedForSource === offeredForSource ? "retained" : "mixed";
      const digest = sourceDigest(source, offered, retained);
      return Object.freeze({
        source,
        offered_tokens: offeredForSource,
        retained_tokens: retainedForSource,
        cache_class: nativeContextCacheClass(source),
        disposition,
        reason: dispositionReason(disposition),
        provenance: Object.freeze({ tag: "generated", generator: "native-context-composition", input_hash: digest }) as Provenance,
        evidence_pointer: `context-source:${source}:${digest}`,
      });
    }));
    return Object.freeze({
      offered_tokens,
      retained_tokens,
      pruned_tokens: offered_tokens - retained_tokens,
      indexed_reference_tokens,
      stable_prefix_tokens,
      dynamic_tokens: retained_tokens - stable_prefix_tokens,
      per_source,
    });
  }

  private append(operation: NativeContextOperation, input: NativeContextAppend): NativeContextEntry {
    assertNonEmpty(input.entry_id, "context entry_id");
    if (this.has(input.entry_id)) throw new NativeContextError(`duplicate context entry: ${input.entry_id}`);
    assertNonEmpty(input.text, "context text");
    this.assertEvidence(input.evidence ?? []);
    const source = input.source ?? defaultSource(operation);
    const redacted = this.redact(input.text);
    const text = source === "tool_output" && this.maxToolOutputTokens !== undefined
      ? truncateToolOutputForBudget(redacted, this.maxToolOutputTokens, this.counter)
      : redacted;
    const count = this.counter(text);
    if (!Number.isSafeInteger(count) || count < 0) throw new NativeContextError("token counter must return a non-negative safe integer");
    if (count > this.budget.max_tokens - this.budget.reserve_output_tokens) throw new NativeContextError("context entry exceeds available context budget");
    const entry = Object.freeze({
      entry_id: input.entry_id,
      operation,
      source,
      text,
      token_count: count,
      retention: input.retention ?? defaultRetention(source),
      provenance: Object.freeze({ ...input.provenance }),
      evidence: Object.freeze((input.evidence ?? []).map((ref) => Object.freeze({ entry_id: ref.entry_id, provenance: Object.freeze({ ...ref.provenance }) }))),
    });
    const candidateEntries = [...this.entries, entry];
    if (entry.retention === "required" && requiredClosureTokens(candidateEntries) > this.budget.max_tokens - this.budget.reserve_output_tokens) {
      throw new NativeContextError("required context exceeds available context budget");
    }
    this.entries.push(entry);
    return entry;
  }
}

export class NativeContextError extends Error {
  constructor(message: string) { super(message); this.name = "NativeContextError"; }
}

/** Conservative redaction used for retained context and canonical summaries. */
export function redactNativeText(value: string, policy: NativeRedactionPolicy = {}): string {
  let result = value;
  const replacement = policy.replacement ?? "[REDACTED]";
  for (const secret of policy.secrets ?? []) if (secret.length > 0) result = result.split(secret).join(replacement);
  // Key-shaped credentials (sk-…, AKIA…, ghp_…, JWTs, …) are removed by shape, label or no label.
  result = redactCredentialShapes(result, replacement);
  // Common bearer/API-secret shapes are removed even when a composition root did not list a value.
  return result
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]{12,}\b/gi, replacement)
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[=:]\s*[^\s"']+/gi, (match) => `${match.split(/[=:]/, 1)[0]}=${replacement}`);
}

function addWithEvidence(entry: NativeContextEntry, all: readonly NativeContextEntry[], selected: NativeContextEntry[], selectedIds: Set<string>, limit: number): void {
  if (selectedIds.has(entry.entry_id)) return;
  const dependencies = entry.evidence.map((ref) => all.find((candidate) => candidate.entry_id === ref.entry_id)).filter((candidate): candidate is NativeContextEntry => candidate !== undefined);
  const required = [...dependencies, entry];
  const used = sumTokens(selected);
  // A dependency already being selected (e.g. shared evidence cited by two
  // retained entries) must not block adding this entry — only the entry's
  // own not-yet-selected cost should count against the remaining budget.
  const unselected = required.filter((candidate) => !selectedIds.has(candidate.entry_id));
  if (used + sumTokens(unselected) > limit) return;
  for (const candidate of unselected) { selected.push(candidate); selectedIds.add(candidate.entry_id); }
}

function validateBudget(budget: NativeContextBudget): void {
  if (!Number.isSafeInteger(budget.max_tokens) || budget.max_tokens <= 0) throw new NativeContextError("max_tokens must be a positive safe integer");
  if (!Number.isSafeInteger(budget.reserve_output_tokens) || budget.reserve_output_tokens < 0 || budget.reserve_output_tokens >= budget.max_tokens) throw new NativeContextError("reserve_output_tokens must be a non-negative safe integer below max_tokens");
}
function sumTokens(entries: readonly NativeContextEntry[]): number { return entries.reduce((total, entry) => total + entry.token_count, 0); }
/**
 * Nudges a UTF-16 code-unit slice index left by one when it would otherwise
 * land between a surrogate pair's two halves, so `text.slice(0, idx)` and
 * `text.slice(idx)` never each keep one lone surrogate. A lone surrogate is
 * invalid UTF-16/UTF-8 and corrupts the character (e.g. an emoji) rather
 * than merely shortening the text, so every head/tail truncation in this
 * file must cut only at a code-point boundary.
 */
function codePointSafeIndex(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const before = text.charCodeAt(index - 1);
  return before >= 0xd800 && before <= 0xdbff ? index - 1 : index;
}
/** Stable, greppable identity for a bounded tool-output excerpt; never present on an untruncated entry. */
export const NATIVE_TOOL_OUTPUT_TRUNCATION_MARKER = "tool-output-truncated";
/**
 * Bounds one `tool_output` entry to `cap` (per the injected counter) by
 * keeping a head/tail excerpt around a typed marker, rather than letting a
 * single oversized read consume a large share of the whole session budget
 * (Commandment VII: keep identity/pointers before eliding bulk). This runs
 * before the overall per-entry budget check in `append()`, so a smaller cap
 * than the overall budget only shrinks growth; it never widens what
 * `append()` would otherwise admit.
 */
function truncateToolOutputForBudget(text: string, cap: number, counter: (text: string) => number): string {
  if (counter(text) <= cap) return text;
  const originalBytes = Buffer.byteLength(text, "utf8");
  const midpoint = codePointSafeIndex(text, Math.ceil(text.length / 2));
  let head = text.slice(0, midpoint);
  let tail = text.slice(midpoint);
  const marker = `\n…[${NATIVE_TOOL_OUTPUT_TRUNCATION_MARKER}: bounded head/tail excerpt of ${originalBytes} original bytes; the full output remains in the tool result evidence]…\n`;
  let candidate = `${head}${marker}${tail}`;
  while (counter(candidate) > cap && (head.length > 0 || tail.length > 0)) {
    head = head.slice(0, codePointSafeIndex(head, Math.floor(head.length * 0.8)));
    tail = tail.slice(codePointSafeIndex(tail, Math.ceil(tail.length * 0.2)));
    candidate = `${head}${marker}${tail}`;
  }
  return candidate;
}
/** A bounded single-line head/tail glimpse of an entry, for a fold descriptor. */
function preview(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= chars) return flat;
  const headIndex = codePointSafeIndex(flat, Math.ceil(chars / 2));
  const tailIndex = codePointSafeIndex(flat, flat.length - Math.floor(chars / 2));
  return `${flat.slice(0, headIndex)}…${flat.slice(tailIndex)}`;
}
/** Deterministic identity for a fold's input set, for its generated provenance. */
function foldInputHash(entries: readonly NativeContextEntry[]): string {
  let hash = 2_166_136_261;
  for (const entry of entries) for (const char of entry.entry_id) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16_777_619); }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function assertNonEmpty(value: string, label: string): void { if (value.trim().length === 0) throw new NativeContextError(`${label} must be non-empty`); }
function sameProvenance(left: Provenance, right: Provenance): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function defaultSource(operation: NativeContextOperation): NativeContextSource {
  if (operation === "curate") return "memory";
  if (operation === "reflect") return "critic_feedback";
  if (operation === "evidence") return "code";
  if (operation === "human_input") return "human_input";
  return "trajectory";
}
function defaultRetention(source: NativeContextSource): NativeContextRetention {
  if (source === "system_instructions" || source === "project_instructions" || source === "task" || source === "human_input") return "required";
  if (source === "repository_graph" || source === "memory" || source === "critic_feedback") return "preferred";
  return "opportunistic";
}
/** Direct evidence closure mirrors snapshot selection's current one-hop evidence contract. */
function requiredClosureTokens(entries: readonly NativeContextEntry[]): number {
  const byId = new Map(entries.map((entry) => [entry.entry_id, entry]));
  const included = new Map<string, NativeContextEntry>();
  for (const entry of entries) {
    if (entry.retention !== "required") continue;
    included.set(entry.entry_id, entry);
    for (const ref of entry.evidence) {
      const dependency = byId.get(ref.entry_id);
      if (dependency) included.set(dependency.entry_id, dependency);
    }
  }
  return sumTokens([...included.values()]);
}
/**
 * Provider-neutral cache partition. Stable sources may enter a byte-stable
 * system prefix; dynamic sources must remain in the per-turn user projection.
 */
export function nativeContextCacheClass(source: NativeContextSource): NativeContextCacheClass {
  return source === "system_instructions" || source === "project_instructions" || source === "repository_graph" || source === "memory" ? "stable" : "dynamic";
}
function dispositionReason(disposition: NativeContextDisposition): string {
  if (disposition === "absent") return "source not offered to this session";
  if (disposition === "pruned") return "source excluded from the bounded projection";
  if (disposition === "indexed") return "source retained as provenance-bearing evidence";
  if (disposition === "mixed") return "source partially retained by deterministic projection";
  return "source retained in the bounded projection";
}
function sourceDigest(source: NativeContextSource, offered: readonly NativeContextEntry[], retained: readonly NativeContextEntry[]): string {
  let hash = 2_166_136_261;
  const identity = [source, ...offered.map((entry) => `${entry.entry_id}:${entry.token_count}:${entry.provenance.tag}`), "retained", ...retained.map((entry) => entry.entry_id)].join("\0");
  for (const char of identity) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16_777_619); }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
