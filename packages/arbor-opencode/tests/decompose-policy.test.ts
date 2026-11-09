import { describe, it, expect } from "vitest";
import type { Action } from "@arbor/core";
import {
  MAX_DECOMPOSITION_DEPTH,
  MIN_DECOMPOSITION_FANOUT,
  MAX_DECOMPOSITION_FANOUT,
  decompositionDepthOf,
  depthBoundReached,
  validateDecomposition,
  decompositionProvenance,
} from "@arbor/campaign-support";

// The epic-shaped candidate action from the real timeout campaign this seam
// exists for — "bring repo-wide branch coverage to >=85%" — seeded as a tree
// leaf with nothing left to decompose.
const parent: Action = {
  description: "Bring repo-wide branch coverage to >=85%",
  estimated_gain: 80,
  estimated_cost: 40,
  category: "testing",
  delegate_to: "seed",
};

function child(overrides: Partial<Action> = {}): Action {
  return {
    description: "write unit tests for module X",
    estimated_gain: 20,
    estimated_cost: 5,
    category: "testing",
    delegate_to: "seed",
    ...overrides,
  };
}

describe("decompositionDepthOf / depthBoundReached", () => {
  it("defaults to 0 for an action with no decomposition_depth", () => {
    expect(decompositionDepthOf(parent)).toBe(0);
    expect(depthBoundReached(parent)).toBe(false);
  });

  it("reaches the bound exactly at MAX_DECOMPOSITION_DEPTH, not before", () => {
    const atBound: Action = { ...parent, decomposition_depth: MAX_DECOMPOSITION_DEPTH };
    expect(depthBoundReached(atBound)).toBe(true);
    const belowBound: Action = { ...parent, decomposition_depth: MAX_DECOMPOSITION_DEPTH - 1 };
    expect(depthBoundReached(belowBound)).toBe(false);
  });
});

describe("validateDecomposition — termination & shape guarantees", () => {
  it("accepts a well-formed decomposition within fanout bounds and stamps child depth", () => {
    const result = validateDecomposition(parent, [
      child({ description: "write tests for module A" }),
      child({ description: "write tests for module B" }),
      child({ description: "write tests for module C" }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.children).toHaveLength(3);
      for (const c of result.children) expect(c.decomposition_depth).toBe(1);
    }
  });

  it("compounds depth: a child of an already-depth-1 parent is stamped depth 2", () => {
    const depth1Parent: Action = { ...parent, decomposition_depth: 1 };
    const result = validateDecomposition(depth1Parent, [child({ description: "a" }), child({ description: "b" })]);
    expect(result.ok).toBe(true);
    if (result.ok) for (const c of result.children) expect(c.decomposition_depth).toBe(2);
  });

  it("rejects outright when the parent already reached the depth bound — never calls into shape checks", () => {
    const exhausted: Action = { ...parent, decomposition_depth: MAX_DECOMPOSITION_DEPTH };
    // Deliberately malformed candidates too, to prove the depth check short-circuits first.
    const result = validateDecomposition(exhausted, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/depth bound/);
  });

  it(`rejects fanout below ${MIN_DECOMPOSITION_FANOUT}`, () => {
    const result = validateDecomposition(parent, [child()]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/fanout/);
  });

  it(`rejects fanout above ${MAX_DECOMPOSITION_FANOUT}`, () => {
    const many = Array.from({ length: MAX_DECOMPOSITION_FANOUT + 1 }, (_, i) => child({ description: `task ${i}` }));
    const result = validateDecomposition(parent, many);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/fanout/);
  });

  it("rejects a child identical to its parent (case/whitespace-insensitive) as a non-decomposition", () => {
    const result = validateDecomposition(parent, [
      child({ description: `  ${parent.description.toUpperCase()}  ` }),
      child({ description: "a real sub-task" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/identical to its parent/);
  });

  it("rejects the whole decomposition on a duplicate sibling — no silent dedup", () => {
    const result = validateDecomposition(parent, [
      child({ description: "same task" }),
      child({ description: "Same Task" }),
      child({ description: "a distinct third task" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/duplicates/);
  });

  it("rejects a child with a non-positive estimated_gain", () => {
    const result = validateDecomposition(parent, [child({ estimated_gain: 0 }), child({ description: "b" })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/estimated_gain/);
  });

  it("rejects a child with a non-finite estimated_cost", () => {
    const result = validateDecomposition(parent, [child({ estimated_cost: Number.POSITIVE_INFINITY }), child({ description: "b" })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/estimated_cost/);
  });

  it("rejects a child with an empty (whitespace-only) description", () => {
    const result = validateDecomposition(parent, [child({ description: "   " }), child({ description: "b" })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty description/);
  });

  it("rejects a child with an empty category or delegate_to", () => {
    const badCategory = validateDecomposition(parent, [child({ category: "" }), child({ description: "b" })]);
    expect(badCategory.ok).toBe(false);
    const badDelegate = validateDecomposition(parent, [child({ delegate_to: "  " }), child({ description: "b" })]);
    expect(badDelegate.ok).toBe(false);
  });

  it("one violation anywhere in the candidate set rejects the ENTIRE decomposition, not just the bad child", () => {
    const result = validateDecomposition(parent, [
      child({ description: "a good task" }),
      child({ description: "" }), // violates shape
      child({ description: "another good task" }),
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("decompositionProvenance", () => {
  it("is always tagged generated — decomposition children are model-proposed, never claimed or verified", () => {
    const provenance = decompositionProvenance("camp1", "node1", parent, [child({ description: "a" }), child({ description: "b" })]);
    expect(provenance.tag).toBe("generated");
    expect(provenance.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.generator.length).toBeGreaterThan(0);
  });

  it("is deterministic for identical input and changes when the input changes", () => {
    const children = [child({ description: "a" }), child({ description: "b" })];
    const p1 = decompositionProvenance("camp1", "node1", parent, children);
    const p2 = decompositionProvenance("camp1", "node1", parent, children);
    expect(p1.input_hash).toBe(p2.input_hash);
    const p3 = decompositionProvenance("camp1", "node1", parent, [...children, child({ description: "c" })]);
    expect(p3.input_hash).not.toBe(p1.input_hash);
  });
});
