import { describe, expect, it } from "vitest";
import type { ArborAgentName } from "../../src/agent-taxonomy.js";
import { CAPABILITY_TIER } from "../../src/capability-manifest.js";
import { applyC2Reply, authorizeC2Issue, authorizeC2Reply, canIssueC2, type C2CommandState } from "../../src/comms/authority.js";
import { C2_REPLY_KINDS, isTerminalC2Reply } from "../../src/comms/c2.js";
import { COMMS_AGENTS, COMMS_ROLE_TIER, LIVE_MODEL_ORCHESTRATOR_AGENT, type CommsAgentPrincipal, type CommsPrincipal, type CommsTreeView } from "../../src/comms/roles.js";
import { isRuntimeGateRefusal } from "../../src/runtime-contracts.js";
import { createSeededRng, hashSeed } from "../../src/search/rng.js";
import { ALL_AGENTS } from "./fixtures.js";

const ORCHESTRATORS = new Set<ArborAgentName>(["crown", "cambium"]);
const CRITICS = new Set<ArborAgentName>(["lenticel", "burl", "xylem"]);
const RELATIONS = ["direct_parent", "grandparent", "child", "sibling", "self", "unrelated"] as const;
type Relation = (typeof RELATIONS)[number];

/** A tree placing `issuer` in `relation` to `target`; the filler nodes are seeds. */
function treeFor(issuer: ArborAgentName, target: ArborAgentName, relation: Relation): { tree: CommsTreeView; issuerNode: string; targetNode: string } {
  const nodes: Record<string, { parent_id: string | null; agent: ArborAgentName }> = { root: { parent_id: null, agent: "seed" } };
  switch (relation) {
    case "direct_parent":
      nodes.i = { parent_id: "root", agent: issuer };
      nodes.t = { parent_id: "i", agent: target };
      return { tree: { nodes }, issuerNode: "i", targetNode: "t" };
    case "grandparent":
      nodes.i = { parent_id: "root", agent: issuer };
      nodes.mid = { parent_id: "i", agent: "seed" };
      nodes.t = { parent_id: "mid", agent: target };
      return { tree: { nodes }, issuerNode: "i", targetNode: "t" };
    case "child":
      nodes.t = { parent_id: "root", agent: target };
      nodes.i = { parent_id: "t", agent: issuer };
      return { tree: { nodes }, issuerNode: "i", targetNode: "t" };
    case "sibling":
      nodes.i = { parent_id: "root", agent: issuer };
      nodes.t = { parent_id: "root", agent: target };
      return { tree: { nodes }, issuerNode: "i", targetNode: "t" };
    case "self":
      nodes.t = { parent_id: "root", agent: target };
      return { tree: { nodes }, issuerNode: "t", targetNode: "t" };
    case "unrelated":
      nodes.a = { parent_id: "root", agent: "seed" };
      nodes.i = { parent_id: "a", agent: issuer };
      nodes.b = { parent_id: "root", agent: "seed" };
      nodes.t = { parent_id: "b", agent: target };
      return { tree: { nodes }, issuerNode: "i", targetNode: "t" };
  }
}

describe("communication role tiers", () => {
  it("refine ADR-005 capability tiers without widening them", () => {
    expect([...COMMS_AGENTS].sort()).toEqual([...ALL_AGENTS].sort());
    for (const agent of ALL_AGENTS) {
      const comms = COMMS_ROLE_TIER[agent];
      const capability = CAPABILITY_TIER[agent];
      if (comms === "orchestrator" || comms === "planner") expect(capability).toBe("orchestrator");
      else expect(comms).toBe(capability);
    }
  });

  it("names Cambium as the live model orchestrator, at orchestrator tier", () => {
    expect(LIVE_MODEL_ORCHESTRATOR_AGENT).toBe("cambium");
    expect(COMMS_ROLE_TIER[LIVE_MODEL_ORCHESTRATOR_AGENT]).toBe("orchestrator");
    expect(COMMS_ROLE_TIER.taproot).toBe("planner");
  });
});

describe("canIssueC2 — exhaustive authority matrix", () => {
  it("authorizes exactly a direct orchestrator-tier parent among agent issuers, over every role pair and relation", () => {
    let cases = 0;
    for (const issuer of ALL_AGENTS) {
      for (const target of ALL_AGENTS) {
        for (const relation of RELATIONS) {
          if (relation === "self" && issuer !== target) continue;
          const { tree, issuerNode, targetNode } = treeFor(issuer, target, relation);
          const principal: CommsPrincipal = { kind: "agent", agent: issuer, node_id: issuerNode };
          const targetPrincipal: CommsAgentPrincipal = { kind: "agent", agent: target, node_id: targetNode };
          const expected = ORCHESTRATORS.has(issuer) && !CRITICS.has(target) && relation === "direct_parent";
          const decision = authorizeC2Issue(principal, targetPrincipal, tree);
          expect({ issuer, target, relation, ok: decision.ok }).toEqual({ issuer, target, relation, ok: expected });
          expect(canIssueC2(principal, targetPrincipal, tree)).toBe(expected);
          if (decision.ok) expect(decision.basis).toBe("direct_parent");
          else expect(isRuntimeGateRefusal(decision.refusal)).toBe(true);
          cases += 1;
        }
      }
    }
    expect(cases).toBe(11 * 11 * 5 + 11);
  });

  it("refuses specialists, planners and critics with the tier code, and never a critic target", () => {
    for (const issuer of ALL_AGENTS) {
      for (const target of ALL_AGENTS) {
        const { tree, issuerNode, targetNode } = treeFor(issuer, target, "direct_parent");
        const decision = authorizeC2Issue({ kind: "agent", agent: issuer, node_id: issuerNode }, { kind: "agent", agent: target, node_id: targetNode }, tree);
        if (CRITICS.has(target)) expect(decision).toMatchObject({ ok: false, code: "c2.target_is_critic" });
        else if (!ORCHESTRATORS.has(issuer)) expect(decision).toMatchObject({ ok: false, code: "c2.issuer_tier" });
      }
    }
  });

  it("lets the operator command every non-critic node and no critic", () => {
    for (const target of ALL_AGENTS) {
      const { tree, targetNode } = treeFor("seed", target, "unrelated");
      const decision = authorizeC2Issue({ kind: "operator" }, { kind: "agent", agent: target, node_id: targetNode }, tree);
      expect(decision.ok).toBe(!CRITICS.has(target));
      if (decision.ok) expect(decision.basis).toBe("operator");
    }
  });

  it("gives the host loop the edge unless an orchestrator-tier parent holds it", () => {
    for (const parent of ALL_AGENTS) {
      for (const target of ALL_AGENTS) {
        const { tree, targetNode } = treeFor(parent, target, "direct_parent");
        const decision = authorizeC2Issue({ kind: "host_loop" }, { kind: "agent", agent: target, node_id: targetNode }, tree);
        const expected = !CRITICS.has(target) && !ORCHESTRATORS.has(parent);
        expect({ parent, target, ok: decision.ok }).toEqual({ parent, target, ok: expected });
        if (!decision.ok && !CRITICS.has(target)) expect(decision.code).toBe("c2.host_loop_displaced");
      }
    }
    const root: CommsTreeView = { nodes: { r: { parent_id: null, agent: "cambium" } } };
    expect(canIssueC2({ kind: "host_loop" }, { kind: "agent", agent: "cambium", node_id: "r" }, root)).toBe(true);
  });

  it("refuses identities that do not resolve against the tree", () => {
    const { tree } = treeFor("cambium", "seed", "direct_parent");
    expect(authorizeC2Issue({ kind: "operator" }, { kind: "agent", agent: "heartwood", node_id: "t" }, tree)).toMatchObject({ ok: false, code: "c2.target_unknown" });
    expect(authorizeC2Issue({ kind: "operator" }, { kind: "agent", agent: "seed", node_id: "missing" }, tree)).toMatchObject({ ok: false, code: "c2.target_unknown" });
    // A specialist presenting itself as Cambium at the parent's node is refused, not trusted.
    expect(authorizeC2Issue({ kind: "agent", agent: "crown", node_id: "i" }, { kind: "agent", agent: "seed", node_id: "t" }, tree)).toMatchObject({ ok: false, code: "c2.issuer_unknown" });
    expect(authorizeC2Issue({ kind: "agent", agent: "cambium", node_id: "ghost" }, { kind: "agent", agent: "seed", node_id: "t" }, tree)).toMatchObject({ ok: false, code: "c2.issuer_unknown" });
  });

  it("gives every node exactly one non-operator commander (none for a critic), over random trees", () => {
    const rng = createSeededRng(hashSeed("c2-unique-commander"));
    for (let trial = 0; trial < 200; trial++) {
      const nodes: Record<string, { parent_id: string | null; agent: ArborAgentName }> = {};
      const size = 1 + (rng.nextUint32() % 12);
      for (let index = 0; index < size; index++) {
        const parent = index === 0 ? null : `n${rng.nextUint32() % index}`;
        nodes[`n${index}`] = { parent_id: parent, agent: ALL_AGENTS[rng.nextUint32() % ALL_AGENTS.length] };
      }
      const tree: CommsTreeView = { nodes };
      for (const [id, node] of Object.entries(nodes)) {
        const target: CommsAgentPrincipal = { kind: "agent", agent: node.agent, node_id: id };
        const issuers: CommsPrincipal[] = [{ kind: "host_loop" }, ...Object.entries(nodes).map(([nodeId, other]) => ({ kind: "agent" as const, agent: other.agent, node_id: nodeId }))];
        const commanders = issuers.filter((issuer) => canIssueC2(issuer, target, tree));
        expect(commanders.length).toBe(CRITICS.has(node.agent) ? 0 : 1);
        expect(canIssueC2(target, target, tree)).toBe(false);
      }
    }
  });
});

describe("authorizeC2Reply", () => {
  const open: C2CommandState = { command_id: "cmd-1", target_node_id: "t", closed: false };

  it("admits only the target, on its own open command", () => {
    for (const kind of C2_REPLY_KINDS) {
      expect(authorizeC2Reply({ kind: "agent", agent: "seed", node_id: "t" }, open, { kind, command_id: "cmd-1" }).ok).toBe(true);
      expect(authorizeC2Reply({ kind: "agent", agent: "cambium", node_id: "i" }, open, { kind, command_id: "cmd-1" })).toMatchObject({ ok: false, code: "c2.reply_not_target" });
      expect(authorizeC2Reply({ kind: "operator" }, open, { kind, command_id: "cmd-1" })).toMatchObject({ ok: false, code: "c2.reply_not_target" });
      expect(authorizeC2Reply({ kind: "host_loop" }, open, { kind, command_id: "cmd-1" })).toMatchObject({ ok: false, code: "c2.reply_not_target" });
      expect(authorizeC2Reply({ kind: "agent", agent: "seed", node_id: "t" }, open, { kind, command_id: "cmd-2" })).toMatchObject({ ok: false, code: "c2.reply_wrong_command" });
    }
  });

  it("closes a command on decline, done or failed and refuses every later reply", () => {
    for (const first of C2_REPLY_KINDS) {
      const after = applyC2Reply(open, { kind: first });
      expect(after.closed).toBe(isTerminalC2Reply(first));
      for (const next of C2_REPLY_KINDS) {
        const decision = authorizeC2Reply({ kind: "agent", agent: "seed", node_id: "t" }, after, { kind: next, command_id: "cmd-1" });
        expect(decision.ok).toBe(!after.closed);
        if (!decision.ok) expect(isRuntimeGateRefusal(decision.refusal)).toBe(true);
      }
    }
  });
});
