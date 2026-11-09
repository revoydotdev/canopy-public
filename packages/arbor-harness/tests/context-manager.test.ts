import { describe, expect, it } from "vitest";

import { DEFAULT_COMPACTION_THRESHOLD_FRACTION, NATIVE_TOOL_OUTPUT_TRUNCATION_MARKER, NativeContextError, NativeContextManager, redactNativeText, type NativeContextSummarizerPort } from "../src/context-manager.js";

const verified = { tag: "verified", cmd: "check", exit: 0, stdout_hash: "sha256:check" } as const;

describe("NativeContextManager", () => {
  it("keeps generate, reflect, and curate additions immutable and provenance-bearing", () => {
    const context = new NativeContextManager({ budget: { max_tokens: 20, reserve_output_tokens: 4 }, count_tokens: (text) => text.split(/\s+/).filter(Boolean).length });
    const evidence = context.evidence({ entry_id: "evidence", text: "repository fact", provenance: verified });
    const generated = context.generate({ entry_id: "draft", text: "initial plan", provenance: { tag: "generated", generator: "test", input_hash: "sha256:draft" }, evidence: [{ entry_id: evidence.entry_id, provenance: evidence.provenance }] });
    context.reflect({ entry_id: "reflection", text: "trade-off noted", provenance: { tag: "claimed", claimant: "reviewer" }, evidence: [{ entry_id: generated.entry_id, provenance: generated.provenance }] });
    context.curate({ entry_id: "curation", text: "keep the evidence and plan", provenance: { tag: "critic_approved", critic: "lenticel", rationale: "bounded" }, evidence: [{ entry_id: evidence.entry_id, provenance: evidence.provenance }] });

    const checkpoint = context.checkpoint();
    expect(checkpoint).toMatchObject({ sequence: 4, entry_ids: ["evidence", "draft", "reflection", "curation"] });
    expect(context.snapshot().entries.map((entry) => entry.entry_id)).toContain("curation");
    expect(Object.isFrozen(generated.evidence)).toBe(true);
  });

  it("selects a deterministic bounded snapshot while retaining curation provenance", () => {
    const context = new NativeContextManager({ budget: { max_tokens: 8, reserve_output_tokens: 2 }, count_tokens: (text) => text.length });
    const source = context.evidence({ entry_id: "source", text: "aa", provenance: verified });
    context.generate({ entry_id: "old", text: "bbbb", provenance: { tag: "generated", generator: "test", input_hash: "old" } });
    context.curate({ entry_id: "curation", text: "cc", provenance: { tag: "generated", generator: "test", input_hash: "curation" }, evidence: [{ entry_id: source.entry_id, provenance: source.provenance }] });

    const snapshot = context.snapshot();
    expect(snapshot).toMatchObject({ used_tokens: 4, available_tokens: 2, compacted: true });
    expect(snapshot.entries.map((entry) => entry.entry_id)).toEqual(["source", "curation"]);
  });

  it("does not drop a retained entry merely because its evidence dependency was already selected by an earlier pass", () => {
    // "fact" is required, so it is admitted in snapshot()'s first (required) pass.
    // "note" is preferred and cites "fact" as evidence; ample budget means both
    // should be retained, but a shared, already-selected dependency must not
    // cause the dependent entry to be skipped outright.
    const context = new NativeContextManager({ budget: { max_tokens: 100, reserve_output_tokens: 2 }, count_tokens: (text) => text.length });
    const fact = context.evidence({ entry_id: "fact", text: "shared fact", source: "code", retention: "required", provenance: verified });
    context.curate({
      entry_id: "note", text: "builds on the shared fact", source: "memory", retention: "preferred",
      provenance: { tag: "generated", generator: "test", input_hash: "note" },
      evidence: [{ entry_id: fact.entry_id, provenance: fact.provenance }],
    });

    expect(context.snapshot().entries.map((entry) => entry.entry_id)).toEqual(["fact", "note"]);
  });

  it("retains required task context ahead of newer opportunistic transcript bulk", () => {
    const context = new NativeContextManager({ budget: { max_tokens: 12, reserve_output_tokens: 2 }, count_tokens: (text) => text.length });
    context.evidence({ entry_id: "task", text: "TASK", source: "task", provenance: verified });
    context.evidence({ entry_id: "tool-1", text: "aaaaaa", source: "tool_output", provenance: verified });
    context.generate({ entry_id: "latest", text: "bbbbb", source: "trajectory", provenance: { tag: "generated", generator: "test", input_hash: "latest" } });

    const snapshot = context.snapshot();
    expect(snapshot.entries.map((entry) => entry.entry_id)).toContain("task");
    expect(snapshot.entries.find((entry) => entry.entry_id === "task")?.retention).toBe("required");
    expect(snapshot.used_tokens).toBeLessThanOrEqual(10);
  });

  it("fails closed when required facts cannot coexist in the active context window", () => {
    const context = new NativeContextManager({ budget: { max_tokens: 10, reserve_output_tokens: 2 }, count_tokens: (text) => text.length });
    context.evidence({ entry_id: "task", text: "12345", source: "task", provenance: verified });
    expect(() => context.humanInput({ entry_id: "operator", text: "6789", provenance: { tag: "claimed", claimant: "operator" } }))
      .toThrow("required context exceeds available context budget");
    expect(context.snapshot().entries.map((entry) => entry.entry_id)).toEqual(["task"]);
  });

  it("rejects unverifiable evidence and over-budget entries instead of silently collapsing context", () => {
    const context = new NativeContextManager({ budget: { max_tokens: 5, reserve_output_tokens: 1 }, count_tokens: (text) => text.length });
    expect(() => context.reflect({ entry_id: "bad", text: "a", provenance: verified, evidence: [{ entry_id: "missing", provenance: verified }] })).toThrow(NativeContextError);
    expect(() => context.generate({ entry_id: "large", text: "12345", provenance: verified })).toThrow("exceeds available context budget");
  });

  it("redacts explicit and common secret forms before retained context can expose them", () => {
    const value = redactNativeText("token=top-secret Bearer abcdefghijklmnop", { secrets: ["top-secret"] });
    expect(value).not.toContain("top-secret");
    expect(value).not.toContain("abcdefghijklmnop");
  });

  it("uses an opaque redaction port before retaining a context entry", () => {
    const context = new NativeContextManager({
      budget: { max_tokens: 20, reserve_output_tokens: 4 }, count_tokens: (text) => text.length,
      redactor: { redact: (text) => text.replace("unmarked-provider-key", "[REDACTED]") },
    });
    const entry = context.evidence({ entry_id: "source", text: "key unmarked-provider-key", provenance: verified });
    expect(entry.text).toBe("key [REDACTED]");
    expect(JSON.stringify(context.snapshot())).not.toContain("unmarked-provider-key");
  });

  it("does not fold while the whole context still fits within budget", () => {
    const context = new NativeContextManager({ budget: { max_tokens: 100, reserve_output_tokens: 10 }, count_tokens: (text) => text.length });
    context.generate({ entry_id: "a", text: "short", provenance: { tag: "generated", generator: "t", input_hash: "a" } });
    expect(context.foldToRecentTail({ fold_entry_id: "fold-1" })).toBeNull();
    expect(context.snapshot().compacted).toBe(false);
  });

  it("folds non-recent history into one bounded curation that retains identity and provenance, keeping the recent tail verbatim", () => {
    const gen = (id: string) => ({ tag: "generated" as const, generator: "t", input_hash: id });
    const big = (c: string) => c.repeat(100);
    const context = new NativeContextManager({ budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length });
    // Four 100-char entries = 400 chars, over the 360-char usable budget → would compact.
    context.generate({ entry_id: "old-1", text: big("A"), provenance: gen("old-1") });
    context.generate({ entry_id: "old-2", text: big("B"), provenance: gen("old-2") });
    context.generate({ entry_id: "recent-1", text: big("C"), provenance: gen("recent-1") });
    context.generate({ entry_id: "recent-2", text: big("D"), provenance: gen("recent-2") });

    const fold = context.foldToRecentTail({ fold_entry_id: "fold-1", recent_tail_fraction: 0.5, preview_chars: 8 });
    expect(fold).not.toBeNull();
    expect(fold!.operation).toBe("curate");
    expect(fold!.provenance).toMatchObject({ tag: "generated", generator: "native-context-fold" });
    // The fold names the folded entries' identities (structural retention).
    expect(fold!.text).toContain("old-1");
    expect(fold!.text).toContain("old-2");
    // Raw entries survive in durable storage even though the snapshot elides them.
    expect(context.has("old-1")).toBe(true);

    const snapshot = context.snapshot();
    const ids = snapshot.entries.map((e) => e.entry_id);
    expect(ids).toContain("fold-1");          // the fold is kept (newest curation)
    expect(ids).toContain("recent-2");        // recent tail kept verbatim
    expect(ids).not.toContain("old-1");       // old bulk elided from the projection
    expect(snapshot.used_tokens).toBeLessThanOrEqual(360);
  });

  it("supersedes a prior fold rather than accumulating, so the newest curation still covers the oldest history", () => {
    const gen = (id: string) => ({ tag: "generated" as const, generator: "t", input_hash: id });
    const big = (c: string) => c.repeat(100);
    const context = new NativeContextManager({ budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length });
    context.generate({ entry_id: "e1", text: big("A"), provenance: gen("e1") });
    context.generate({ entry_id: "e2", text: big("B"), provenance: gen("e2") });
    context.generate({ entry_id: "e3", text: big("C"), provenance: gen("e3") });
    context.generate({ entry_id: "e4", text: big("D"), provenance: gen("e4") });
    const first = context.foldToRecentTail({ fold_entry_id: "fold-1", preview_chars: 8 });
    expect(first).not.toBeNull();
    context.generate({ entry_id: "e5", text: big("E"), provenance: gen("e5") });
    context.generate({ entry_id: "e6", text: big("F"), provenance: gen("e6") });
    const second = context.foldToRecentTail({ fold_entry_id: "fold-2", preview_chars: 8 });
    expect(second).not.toBeNull();
    // The second fold rolls up the first fold too, so its coverage reaches e1.
    expect(second!.text).toContain("fold-1");
    const ids = context.snapshot().entries.map((e) => e.entry_id);
    expect(ids).toContain("fold-2");
    expect(ids).not.toContain("fold-1"); // only the newest curation is projected
  });

  it("observes composition without altering selection, folding, or budget", () => {
    const context = new NativeContextManager({ budget: { max_tokens: 8, reserve_output_tokens: 2 }, count_tokens: (text) => text.length });
    const source = context.evidence({ entry_id: "source", text: "aa", provenance: verified });
    context.generate({ entry_id: "old", text: "bbbb", provenance: { tag: "generated", generator: "test", input_hash: "old" } });
    context.curate({ entry_id: "curation", text: "cc", provenance: { tag: "generated", generator: "test", input_hash: "curation" }, evidence: [{ entry_id: source.entry_id, provenance: source.provenance }] });

    const before = context.snapshot();
    const observation = context.observeComposition();
    expect(observation).toMatchObject({
      offered_tokens: 8,     // "aa" + "bbbb" + "cc" == 2 + 4 + 2
      retained_tokens: 4,    // snapshot keeps "source" (2) + "curation" (2)
      pruned_tokens: 4,      // "old" (4) was dropped by selection
      indexed_reference_tokens: 2, // retained "evidence" entry ("source")
      stable_prefix_tokens: 2,     // retained memory entry ("curation")
      dynamic_tokens: 2,           // retained code evidence is dynamic
    });
    expect(observation.per_source).toHaveLength(10);
    expect(observation.per_source).toContainEqual(expect.objectContaining({ source: "trajectory", offered_tokens: 4, retained_tokens: 0, disposition: "pruned", cache_class: "dynamic" }));
    expect(observation.per_source).toContainEqual(expect.objectContaining({ source: "memory", offered_tokens: 2, retained_tokens: 2, disposition: "retained", cache_class: "stable" }));
    expect(observation.per_source).toContainEqual(expect.objectContaining({ source: "code", offered_tokens: 2, retained_tokens: 2, disposition: "indexed" }));
    expect(observation.per_source.every((row) => row.evidence_pointer.startsWith(`context-source:${row.source}:fnv1a:`))).toBe(true);
    // Calling it twice, or interleaving with another snapshot(), never mutates state.
    expect(context.observeComposition()).toEqual(observation);
    expect(context.snapshot()).toEqual(before);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.per_source)).toBe(true);
    expect(Object.isFrozen(observation.per_source[0])).toBe(true);
  });

  it("reports zero retention for an empty context", () => {
    const context = new NativeContextManager({ budget: { max_tokens: 8, reserve_output_tokens: 2 }, count_tokens: (text) => text.length });
    const observation = context.observeComposition();
    expect(observation).toMatchObject({
      offered_tokens: 0, retained_tokens: 0, pruned_tokens: 0,
      indexed_reference_tokens: 0, stable_prefix_tokens: 0, dynamic_tokens: 0,
    });
    expect(observation.per_source).toHaveLength(10);
    expect(observation.per_source.every((row) => row.disposition === "absent" && row.offered_tokens === 0 && row.retained_tokens === 0)).toBe(true);
  });

  describe("compact", () => {
    const gen = (id: string) => ({ tag: "generated" as const, generator: "t", input_hash: id });
    const big = (c: string) => c.repeat(100);

    it("reports not_triggered while usage stays under the configured threshold", async () => {
      const context = new NativeContextManager({ budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length });
      context.generate({ entry_id: "a", text: "short", provenance: gen("a") });
      const outcome = await context.compact({ compaction_id: "compact-1" });
      expect(outcome).toMatchObject({ kind: "not_triggered", threshold_tokens: Math.floor(360 * DEFAULT_COMPACTION_THRESHOLD_FRACTION) });
      expect(context.snapshot().compacted).toBe(false);
    });

    it("reports disabled and never appends an anchor when compaction is turned off", async () => {
      const context = new NativeContextManager({ budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length, compaction: { enabled: false } });
      context.generate({ entry_id: "old-1", text: big("A"), provenance: gen("old-1") });
      context.generate({ entry_id: "old-2", text: big("B"), provenance: gen("old-2") });
      context.generate({ entry_id: "old-3", text: big("C"), provenance: gen("old-3") });
      const outcome = await context.compact({ compaction_id: "compact-1" });
      expect(outcome).toEqual({ kind: "disabled" });
      expect(context.has("compact-1")).toBe(false);
    });

    it("compacts via structural fold once the configured threshold is crossed mid-session, capturing real pre/post evidence and an actual token reduction", async () => {
      const context = new NativeContextManager({ budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length, compaction: { threshold_fraction: 0.5, preview_chars: 8 } });
      context.generate({ entry_id: "old-1", text: big("A"), provenance: gen("old-1") });
      context.generate({ entry_id: "old-2", text: big("B"), provenance: gen("old-2") });
      context.generate({ entry_id: "old-3", text: big("C"), provenance: gen("old-3") });
      context.generate({ entry_id: "old-4", text: big("D"), provenance: gen("old-4") });
      context.generate({ entry_id: "recent-1", text: big("E"), provenance: gen("recent-1") });
      // 500 chars offered, over both the 180-char (0.5 * 360) threshold and the 360-char hard limit.
      const preTokens = 500;
      const outcome = await context.compact({ compaction_id: "compact-1" });
      expect(outcome.kind).toBe("compacted");
      if (outcome.kind !== "compacted") throw new Error("unreachable");
      expect(outcome.evidence).toMatchObject({
        compaction_id: "compact-1",
        method: "structural_fold",
        pre_tokens: preTokens,
        threshold_tokens: 180,
        anchor_entry_id: "compact-1",
      });
      expect(outcome.evidence.anchored_entry_ids).toEqual(["old-1", "old-2", "old-3", "old-4"]);
      expect(outcome.evidence.post_tokens).toBeLessThan(outcome.evidence.pre_tokens);
      expect(outcome.evidence.integrity_hash).toMatch(/^fnv1a:[0-9a-f]{8}$/);
      // Raw entries survive durably even though the projection shrinks.
      expect(context.has("old-1")).toBe(true);
      expect(context.has("old-4")).toBe(true);
      const snapshot = context.snapshot();
      expect(snapshot.entries.map((e) => e.entry_id)).toContain("compact-1");
      expect(snapshot.entries.map((e) => e.entry_id)).not.toContain("old-1");
      expect(snapshot.used_tokens).toBe(outcome.evidence.post_tokens);
    });

    it("reports and enforces the configured cooldown after a successful threshold compaction", async () => {
      const context = new NativeContextManager({ budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length, compaction: { threshold_fraction: 0.5, cooldown_turns: 2, preview_chars: 8 } });
      context.generate({ entry_id: "old-1", text: big("A"), provenance: gen("old-1") });
      context.generate({ entry_id: "old-2", text: big("B"), provenance: gen("old-2") });
      context.generate({ entry_id: "recent-1", text: big("C"), provenance: gen("recent-1") });
      expect((await context.compact({ compaction_id: "compact-1", turn: 1 })).kind).toBe("compacted");
      context.generate({ entry_id: "later-1", text: big("D"), provenance: gen("later-1") });
      expect(await context.compact({ compaction_id: "compact-2", turn: 2 })).toEqual({ kind: "cooldown", remaining_turns: 1, cooldown_until_turn: 3 });
      expect((await context.compact({ compaction_id: "compact-3", turn: 3 })).kind).toBe("compacted");
    });

    it("uses an injectable summarizer for a real semantic anchor, staying deterministic under a synchronous fake", async () => {
      const seen: string[][] = [];
      const summarizer: NativeContextSummarizerPort = {
        summarize: async ({ candidates }) => {
          seen.push(candidates.map((c) => c.entry_id));
          return { kind: "summarized", text: "the operator read two files and made no edits" };
        },
      };
      const context = new NativeContextManager({ budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length, compaction: { threshold_fraction: 0.5, summarizer } });
      context.generate({ entry_id: "old-1", text: big("A"), provenance: gen("old-1") });
      context.generate({ entry_id: "old-2", text: big("B"), provenance: gen("old-2") });
      context.generate({ entry_id: "recent-1", text: big("C"), provenance: gen("recent-1") });

      const outcome = await context.compact({ compaction_id: "compact-1" });
      expect(outcome.kind).toBe("compacted");
      if (outcome.kind !== "compacted") throw new Error("unreachable");
      expect(outcome.evidence.method).toBe("model_summary");
      expect(outcome.anchor.text).toContain("the operator read two files and made no edits");
      expect(outcome.anchor.provenance).toMatchObject({ generator: "native-context-summary" });
      expect(seen).toEqual([["old-1", "old-2"]]);
    });

    it("falls back to the always-available structural fold when the summarizer reports unavailable", async () => {
      const summarizer: NativeContextSummarizerPort = { summarize: async () => ({ kind: "unavailable", reason: "no model port composed" }) };
      const context = new NativeContextManager({ budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length, compaction: { threshold_fraction: 0.5, summarizer } });
      context.generate({ entry_id: "old-1", text: big("A"), provenance: gen("old-1") });
      context.generate({ entry_id: "old-2", text: big("B"), provenance: gen("old-2") });
      context.generate({ entry_id: "recent-1", text: big("C"), provenance: gen("recent-1") });

      const outcome = await context.compact({ compaction_id: "compact-1" });
      expect(outcome.kind).toBe("compacted");
      if (outcome.kind !== "compacted") throw new Error("unreachable");
      expect(outcome.evidence.method).toBe("structural_fold");
    });

    it("falls back to the structural fold, never propagating, when the summarizer rejects", async () => {
      const summarizer: NativeContextSummarizerPort = { summarize: async () => { throw new Error("provider unreachable"); } };
      const context = new NativeContextManager({ budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length, compaction: { threshold_fraction: 0.5, summarizer } });
      context.generate({ entry_id: "old-1", text: big("A"), provenance: gen("old-1") });
      context.generate({ entry_id: "old-2", text: big("B"), provenance: gen("old-2") });
      context.generate({ entry_id: "recent-1", text: big("C"), provenance: gen("recent-1") });

      const outcome = await context.compact({ compaction_id: "compact-1" });
      expect(outcome.kind).toBe("compacted");
      if (outcome.kind !== "compacted") throw new Error("unreachable");
      expect(outcome.evidence.method).toBe("structural_fold");
    });

    it("emits an honest typed skip — never a silent or fabricated one — when the threshold is crossed but nothing older than the recent tail is foldable", async () => {
      const context = new NativeContextManager({ budget: { max_tokens: 100, reserve_output_tokens: 0 }, count_tokens: (text) => text.length, compaction: { threshold_fraction: 0.3 } });
      // 40 chars offered: over the 30-char (0.3 * 100) threshold, but every
      // entry individually still fits inside the fixed 50-char (0.5 * 100)
      // recent-tail budget compact() itself uses — so nothing is old enough
      // to become a fold candidate.
      context.generate({ entry_id: "a", text: "a".repeat(20), provenance: gen("a") });
      context.generate({ entry_id: "b", text: "b".repeat(20), provenance: gen("b") });

      const outcome = await context.compact({ compaction_id: "compact-1" });
      expect(outcome).toMatchObject({ kind: "skipped", reason: "no_foldable_candidates", pre_tokens: 40, threshold_tokens: 30 });
      expect(context.has("compact-1")).toBe(false);
    });

    it("emits an honest typed skip when the anchor cannot actually be appended, instead of fabricating a compaction record", async () => {
      const context = new NativeContextManager({ budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length, compaction: { threshold_fraction: 0.5 } });
      context.generate({ entry_id: "old-1", text: big("A"), provenance: gen("old-1") });
      context.generate({ entry_id: "old-2", text: big("B"), provenance: gen("old-2") });
      context.generate({ entry_id: "recent-1", text: big("C"), provenance: gen("recent-1") });
      // A prior entry already occupies the id `compact()` is about to use —
      // `append()` genuinely refuses a duplicate id, so the evidence is
      // truly uncapturable here, not merely inconvenient to produce.
      context.generate({ entry_id: "compact-1", text: "collides", provenance: gen("collision") });

      const outcome = await context.compact({ compaction_id: "compact-1" });
      expect(outcome).toMatchObject({ kind: "skipped", reason: "anchor_uncapturable" });
      if (outcome.kind !== "skipped") throw new Error("unreachable");
      expect(outcome.detail).toContain("duplicate context entry");
      // The candidates named in the failed attempt remain fully intact — a
      // skip never partially mutates durable state.
      expect(context.has("old-1")).toBe(true);
      expect(context.has("old-2")).toBe(true);
    });

    it("supersedes a prior compaction rather than accumulating, so the newest anchor still covers the oldest history", async () => {
      const context = new NativeContextManager({ budget: { max_tokens: 400, reserve_output_tokens: 40 }, count_tokens: (text) => text.length, compaction: { threshold_fraction: 0.5, preview_chars: 8 } });
      context.generate({ entry_id: "e1", text: big("A"), provenance: gen("e1") });
      context.generate({ entry_id: "e2", text: big("B"), provenance: gen("e2") });
      context.generate({ entry_id: "e3", text: big("C"), provenance: gen("e3") });
      const first = await context.compact({ compaction_id: "compact-1" });
      expect(first.kind).toBe("compacted");

      context.generate({ entry_id: "e4", text: big("D"), provenance: gen("e4") });
      context.generate({ entry_id: "e5", text: big("E"), provenance: gen("e5") });
      const second = await context.compact({ compaction_id: "compact-2" });
      expect(second.kind).toBe("compacted");
      if (second.kind !== "compacted") throw new Error("unreachable");
      expect(second.evidence.anchored_entry_ids).toContain("compact-1");
      const ids = context.snapshot().entries.map((e) => e.entry_id);
      expect(ids).toContain("compact-2");
      expect(ids).not.toContain("compact-1");
    });
  });

  it("truncates tool_output content dense with multi-byte characters (CJK and emoji) without splitting a surrogate pair", () => {
    // Emoji outside the BMP are UTF-16 surrogate pairs; a code-unit-blind
    // slice() can keep one half of a pair and drop the other, leaving an
    // invalid lone surrogate in retained context. Dense, realistic content
    // (not one emoji at a convenient boundary) is required to catch this,
    // since a single centered emoji happens to get chipped away by the
    // shrink loop before it can be observed.
    const emojis = ["\u{1F600}", "\u{1F680}", "\u{1F4A9}", "\u{1F602}"];
    let dense = "";
    for (let i = 0; i < 100; i++) dense += i % 2 === 0 ? emojis[i % emojis.length] : "文";
    const context = new NativeContextManager({
      budget: { max_tokens: 5_000, reserve_output_tokens: 100 }, count_tokens: (text) => text.length, max_tool_output_tokens: 141,
    });
    const entry = context.evidence({ entry_id: "dense-read", text: dense, source: "tool_output", provenance: verified });

    for (let i = 0; i < entry.text.length; i++) {
      const code = entry.text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        expect(entry.text.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(entry.text.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        expect(entry.text.charCodeAt(i - 1)).toBeGreaterThanOrEqual(0xd800);
        expect(entry.text.charCodeAt(i - 1)).toBeLessThanOrEqual(0xdbff);
      }
    }
  });

  it("bounds an oversized tool_output entry to the configured per-entry cap with a typed marker, leaving other sources untouched", () => {
    const context = new NativeContextManager({
      budget: { max_tokens: 5_000, reserve_output_tokens: 100 }, count_tokens: (text) => text.length, max_tool_output_tokens: 200,
    });
    const huge = "X".repeat(400) + "MIDDLE" + "Y".repeat(400);
    const entry = context.evidence({ entry_id: "big-read", text: huge, source: "tool_output", provenance: verified });

    expect(entry.text.length).toBeLessThanOrEqual(200);
    expect(entry.text).toContain(NATIVE_TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(entry.text).toContain("806"); // declares the untruncated byte length
    expect(entry.text.startsWith("X")).toBe(true);
    expect(entry.text.endsWith("Y")).toBe(true);

    // A non-tool_output entry of identical size is unaffected by the cap: it
    // fits comfortably in the overall budget the cap does not touch.
    const untouched = context.generate({ entry_id: "big-generate", text: huge, provenance: verified });
    expect(untouched.text).toBe(huge);
  });

  it("leaves a tool_output entry untouched when it already fits the configured cap", () => {
    const context = new NativeContextManager({
      budget: { max_tokens: 5_000, reserve_output_tokens: 100 }, count_tokens: (text) => text.length, max_tool_output_tokens: 200,
    });
    const entry = context.evidence({ entry_id: "small-read", text: "small tool output", source: "tool_output", provenance: verified });
    expect(entry.text).toBe("small tool output");
  });

  it("counts every stable source in the provider-prefix partition", () => {
    const context = new NativeContextManager({ budget: { max_tokens: 100, reserve_output_tokens: 10 }, count_tokens: (text) => text.length });
    const provenance = { tag: "generated" as const, generator: "test", input_hash: "stable-sources" };
    context.generate({ entry_id: "system", text: "aa", source: "system_instructions", provenance });
    context.generate({ entry_id: "project", text: "bbb", source: "project_instructions", provenance });
    context.evidence({ entry_id: "graph", text: "cccc", source: "repository_graph", provenance });
    context.curate({ entry_id: "memory", text: "ddddd", source: "memory", provenance });
    context.reflect({ entry_id: "critic", text: "eeeeee", source: "critic_feedback", provenance });

    expect(context.observeComposition()).toMatchObject({
      retained_tokens: 20,
      stable_prefix_tokens: 14,
      dynamic_tokens: 6,
    });
  });
});
