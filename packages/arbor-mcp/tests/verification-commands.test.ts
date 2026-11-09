/**
 * Which acceptance command verifies a node (B1, EC-061). The plan's own
 * declaration wins; a project-configured command is the fallback on every
 * tier; only when neither exists is there nothing to run.
 */
import { describe, expect, it } from "vitest";
import { verificationCommandsFor, composeSessionScope } from "../src/cli.js";
import { MINED_ACTION_SCOPE_GENERATOR, type NativeHighRiskToolScope } from "../src/native-tools/contracts.js";

describe("verificationCommandsFor", () => {
  it("prefers the plan's declared commands", () => {
    expect(verificationCommandsFor([["node", "--test", "x.test.js"]], [["bun", "run", "test"]])).toEqual([["node", "--test", "x.test.js"]]);
  });
  it("falls back to the project's configured commands, in order", () => {
    expect(verificationCommandsFor([], [["bun", "run", "tests:typecheck"], ["bun", "run", "test"]])).toEqual([["bun", "run", "tests:typecheck"], ["bun", "run", "test"]]);
    expect(verificationCommandsFor(undefined, [["bun", "run", "test"]])).toEqual([["bun", "run", "test"]]);
  });
  it("ignores empty argv vectors and returns null when nothing is authored", () => {
    expect(verificationCommandsFor([[]], [[]])).toBeNull();
    expect(verificationCommandsFor(undefined, undefined)).toBeNull();
  });
  it("prefers the operator's commands over a MINED plan declaration", () => {
    // The observed failure: the arbiter shredded "Run npm test and make sure
    // the whole suite passes" into argv that npm silently ignores, so it exits
    // 0 and a meaningless command produced a passing verification.
    const shredded = [["npm", "test", "and", "make", "sure", "the", "whole", "suite", "passes"]];
    expect(verificationCommandsFor(shredded, [["npm", "test"]], { declared_authored: false })).toEqual([["npm", "test"]]);
  });
  it("keeps an explicitly AUTHORED plan declaration ahead of the project's", () => {
    expect(verificationCommandsFor([["node", "--test", "x.test.js"]], [["bun", "run", "test"]], { declared_authored: true })).toEqual([["node", "--test", "x.test.js"]]);
  });
  it("falls back to a mined declaration when the project authored nothing", () => {
    expect(verificationCommandsFor([["node", "--test", "x.test.js"]], [], { declared_authored: false })).toEqual([["node", "--test", "x.test.js"]]);
    expect(verificationCommandsFor([["node", "--test", "x.test.js"]], undefined, { declared_authored: false })).toEqual([["node", "--test", "x.test.js"]]);
  });
});

describe("composeSessionScope", () => {
  const base = (generator: string): NativeHighRiskToolScope => ({
    scope_id: "s", campaign_id: "c", node_id: "n", session_id: "sess", worktree_root: "/wt",
    provenance: { tag: "generated", generator, input_hash: "sha256:x" }, write_paths: ["src/a.ts"], command_argv: [["bun", "test"]],
  });
  it("stamps a reviewed-tier scope mined by the arbiter as mined and appends the project's acceptance commands, once", () => {
    const composed = composeSessionScope(base("campaign-manager/governed-action-scope-v1"), { tier: "reviewed", acceptance: [["bun", "test"], ["bun", "run", "typecheck"]] });
    expect(composed?.authority).toBe("mined");
    expect(composed?.command_argv).toEqual([["bun", "test"], ["bun", "run", "typecheck"]]);
  });
  it("stamps a governed-tier scope as authored and never widens it; null passes through", () => {
    const composed = composeSessionScope(base("campaign-manager/governed-action-scope-v1"), { tier: "governed", acceptance: [["bun", "run", "typecheck"]] });
    expect(composed?.authority).toBe("authored");
    expect(composed?.command_argv).toEqual([["bun", "test"]]);
    expect(composeSessionScope(null, { tier: "reviewed", acceptance: [["bun", "test"]] })).toBeNull();
  });
  it("treats an unknown tier as governed, the safer default", () => {
    expect(composeSessionScope(base(MINED_ACTION_SCOPE_GENERATOR), { tier: undefined, acceptance: [] })?.authority).toBe("authored");
  });
  it("prefers the persisted per-node scope_provenance over the tier heuristic, in both directions", () => {
    // A governed-tier campaign would heuristically stamp "authored", but the
    // task composer's own per-action record says the action's scope was
    // actually mined from task text — the persisted fact wins.
    const minedDespiteGovernedTier = composeSessionScope(base("campaign-manager/governed-action-scope-v1"), { tier: "governed", acceptance: [["bun", "run", "typecheck"]], scope_provenance: "mined" });
    expect(minedDespiteGovernedTier?.authority).toBe("mined");
    expect(minedDespiteGovernedTier?.command_argv).toEqual([["bun", "test"], ["bun", "run", "typecheck"]]);
    // A reviewed-tier campaign would heuristically stamp "mined", but the
    // task composer's own record says the plan authored this action's
    // scope directly — the persisted fact wins and nothing is widened.
    const authoredDespiteReviewedTier = composeSessionScope(base("campaign-manager/governed-action-scope-v1"), { tier: "reviewed", acceptance: [["bun", "run", "typecheck"]], scope_provenance: "authored" });
    expect(authoredDespiteReviewedTier?.authority).toBe("authored");
    expect(authoredDespiteReviewedTier?.command_argv).toEqual([["bun", "test"]]);
  });
});
