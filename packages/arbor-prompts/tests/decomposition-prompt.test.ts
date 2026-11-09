import { describe, it, expect } from "vitest";
import { cambiumDecompositionPrompt, type DecompositionPromptAction } from "../src/index.js";

const bigAction: DecompositionPromptAction = {
  description: "Bring repo-wide branch coverage to >=85%",
  estimated_gain: 40,
  estimated_cost: 900,
  category: "quality",
  delegate_to: "heartwood",
  constraints: ["MUST NOT delete existing tests", "MUST run the full suite before claiming done"],
};

describe("cambiumDecompositionPrompt", () => {
  it("names the parent action's fields verbatim", () => {
    const p = cambiumDecompositionPrompt(bigAction, { reason: "timeout", depth: 1 });
    expect(p).toContain(bigAction.description);
    expect(p).toContain("quality");
    expect(p).toContain("heartwood");
    expect(p).toContain("40");
    expect(p).toContain("900");
  });

  it("includes parent constraints when present", () => {
    const p = cambiumDecompositionPrompt(bigAction, { reason: "timeout", depth: 1 });
    expect(p).toContain("MUST NOT delete existing tests");
    expect(p).toContain("MUST run the full suite before claiming done");
  });

  it("omits the constraints block when the parent has none", () => {
    const { constraints, ...rest } = bigAction;
    const p = cambiumDecompositionPrompt(rest, { reason: "timeout", depth: 1 });
    expect(p).not.toContain("Parent constraints");
  });

  it("explains the timeout reason distinctly from the operator reason", () => {
    const timeoutPrompt = cambiumDecompositionPrompt(bigAction, { reason: "timeout", depth: 1 });
    const operatorPrompt = cambiumDecompositionPrompt(bigAction, { reason: "operator", depth: 1 });
    expect(timeoutPrompt).toContain("ran for its full time budget");
    expect(operatorPrompt).toContain("An operator has flagged");
    expect(timeoutPrompt).not.toBe(operatorPrompt);
  });

  it("states the depth", () => {
    const p = cambiumDecompositionPrompt(bigAction, { reason: "operator", depth: 3 });
    expect(p).toContain("depth 3");
  });

  it("demands independently completable children, not sequential fragments", () => {
    const p = cambiumDecompositionPrompt(bigAction, { reason: "timeout", depth: 1 });
    expect(p.toLowerCase()).toContain("independently completable");
    expect(p).toContain("step 1 of 5");
  });

  it("demands independently verifiable children tied to a real command", () => {
    const p = cambiumDecompositionPrompt(bigAction, { reason: "timeout", depth: 1 });
    expect(p.toLowerCase()).toContain("independently verifiable");
    expect(p).toContain("!verified");
  });

  it("bans aspirational children and gives a concrete-vs-aspirational example", () => {
    const p = cambiumDecompositionPrompt(bigAction, { reason: "timeout", depth: 1 });
    expect(p).toContain("packages/arbor-kb/src/sqlite.ts");
    expect(p).toContain("improve arbor-kb reliability");
  });

  it("forbids inventing scope beyond the parent", () => {
    const p = cambiumDecompositionPrompt(bigAction, { reason: "timeout", depth: 1 });
    expect(p.toUpperCase()).toContain("WITHOUT INVENTING SCOPE");
  });

  it("allows an honest empty array instead of manufactured filler children", () => {
    const p = cambiumDecompositionPrompt(bigAction, { reason: "timeout", depth: 1 });
    expect(p).toContain("[]");
    expect(p.toLowerCase()).toContain("cannot decompose");
  });

  it("specifies the exact JSON output shape and forbids prose/markdown fences", () => {
    const p = cambiumDecompositionPrompt(bigAction, { reason: "timeout", depth: 1 });
    expect(p).toContain('"description"');
    expect(p).toContain('"estimated_gain"');
    expect(p).toContain('"estimated_cost"');
    expect(p).toContain('"category"');
    expect(p).toContain('"delegate_to"');
    expect(p).toContain('"constraints"');
    expect(p.toLowerCase()).toContain("no markdown code fences");
    expect(p.toLowerCase()).toContain("only a raw json array");
  });

  it("two calls with identical inputs are byte-identical (pure, no hidden per-call state)", () => {
    const a = cambiumDecompositionPrompt(bigAction, { reason: "operator", depth: 2 });
    const b = cambiumDecompositionPrompt(bigAction, { reason: "operator", depth: 2 });
    expect(a).toBe(b);
  });
});
