/**
 * Proposal §5: the tropism render path.
 *
 * The load-bearing claim these tests exist for is NOT "a tropism gets
 * recorded somewhere". It is that a tropism's body reaches the *model* as
 * prompt text, inside the same framed, `context-only` wrapper every other
 * bounded context scope uses (`repoInstructionsBlock`, `environmentBlock`,
 * `foregroundBlock`).
 *
 * The rejected alternative is `NativeContextManager`, and it is worth
 * recording why it cannot work rather than leaving the choice implicit:
 * `boundedHistory` (`packages/arbor-harness/src/native-worker.ts:1769`)
 * drops any context entry a conversation entry does not cite (`:1774`),
 * drops any cited entry missing from the current snapshot (`:1776`), and
 * renders cited text only through `sources[0].text` (`:1778`). An appended,
 * uncited fact therefore never reaches the model — the lane is dead on
 * arrival. The real-surface version of this claim is proved in
 * `packages/arbor-mcp/tests/hooks/e2e.test.ts`, against the
 * `NativeModelRequest` a real executor actually built.
 */
import { describe, expect, it } from "vitest";
import { AGENT_PROMPTS, crownPrompt, resolveTropisms, seedPrompt, type Tropism } from "../src/index.js";

const TROPISM: Tropism = {
  id: "orient",
  trigger: "session_start",
  lane: "ADVISORY",
  provenance: "generated",
  derived_from: ["ring:a1b2c3"],
  body: "Leased node n-7; write-set is packages/arbor-mcp/src/**.",
  expires_after_turns: 3,
  enforcing_ref: null,
};

describe("tropisms — proposal §5 render path", () => {
  it("renders the tropism body inside the framed, context-only wrapper", () => {
    const scope = resolveTropisms([TROPISM]);
    const prompt = crownPrompt({ tropisms: scope });

    expect(prompt).toContain('<tropisms instruction-authority="context-only">');
    expect(prompt).toContain("</tropisms>");
    expect(prompt).toContain(TROPISM.body);
    // The body must be *inside* the frame, not merely alongside it.
    const framed = prompt.slice(prompt.indexOf('<tropisms instruction-authority="context-only">'));
    expect(framed.slice(0, framed.indexOf("</tropisms>"))).toContain(TROPISM.body);
  });

  it("carries the lane, provenance and derivation into the rendered text", () => {
    const content = resolveTropisms([TROPISM]).content;
    expect(content).toContain("orient");
    expect(content).toContain("ADVISORY");
    expect(content).toContain("provenance=generated");
    expect(content).toContain("derived_from=ring:a1b2c3");
  });

  it("reports the derivation through source_paths, the tropism analogue of RepoInstructionsScope.source_paths", () => {
    expect(resolveTropisms([TROPISM]).source_paths).toEqual(["ring:a1b2c3"]);
  });

  it("renders at every prompt function, not just the root/plan-level ones", () => {
    // ADR-022 G-10 scopes repo instructions to root/plan agents only; a
    // tropism is session state and is relevant at any depth, so a deep leaf
    // must receive it too. This iterates the real render map, so a prompt
    // function added later without the block fails here rather than
    // silently shipping a leaf that never sees its session state.
    for (const [name, render] of Object.entries(AGENT_PROMPTS)) {
      expect(render({ tropisms: resolveTropisms([TROPISM]) }), `${name} must render the tropism block`).toContain(TROPISM.body);
    }
  });

  it("renders for a deep leaf (Seed) that ADR-022 deliberately excludes from repo instructions", () => {
    expect(seedPrompt({ tropisms: resolveTropisms([TROPISM]) })).toContain(TROPISM.body);
  });

  it("is absent, not empty-framed, when there is nothing to inject", () => {
    expect(crownPrompt()).not.toContain("<tropisms");
    expect(crownPrompt({ tropisms: resolveTropisms([]) })).not.toContain("<tropisms");
  });

  it("bounds the composed section and says so rather than clipping silently", () => {
    const oversized: Tropism = { ...TROPISM, body: "x".repeat(5_000) };
    const scope = resolveTropisms([TROPISM, oversized], 200);
    expect(scope.truncated).toBe(true);
    expect(Buffer.byteLength(scope.content, "utf8")).toBeLessThanOrEqual(200);
  });

  it("keeps the first tropism in hook-declaration order when the budget bites", () => {
    const second: Tropism = { ...TROPISM, id: "sink", derived_from: ["ring:d4e5f6"] };
    const scope = resolveTropisms([TROPISM, second], 120);
    expect(scope.content).toContain("orient");
    expect(scope.truncated).toBe(true);
  });
});
