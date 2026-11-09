import { describe, it, expect } from "vitest";
import {
  deriveNodeCard,
  signNodeCard,
  verifyNodeCard,
  canonicalNodeCardJson,
  cardsForCapability,
  selectNodeByCapability,
  NODE_CARD_MAX_SKILLS,
  NODE_CARD_MAX_INPUTS,
  NODE_CARD_MAX_OUTPUTS,
  NODE_CARD_MAX_FIELD_BYTES,
} from "../src/node-card.js";
import type { NodeCard, NodeCardInputs, NodeCardMode } from "../src/node-card.js";

const TEST_SECRET = "arbor-phase-4d-3-test-secret";

const baseInputs: NodeCardInputs = {
  node_id: "node:specialist:1",
  role: "specialist",
  skills: ["refactor", "test", "lint"],
  tier: "specialist",
  modes: ["streaming", "steerable"],
  inputs: ["ledger", "tree"],
  outputs: ["patch", "report"],
  source: "builtin",
};

describe("deriveNodeCard", () => {
  it("produces a signed card with correct shape", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    expect(card.node_id).toBe("node:specialist:1");
    expect(card.role).toBe("specialist");
    expect(card.skills).toEqual(["refactor", "test", "lint"]);
    expect(card.tier).toBe("specialist");
    expect(card.source).toBe("builtin");
    expect(card.signature).toBeTruthy();
    expect(typeof card.signature).toBe("string");
    expect(card.signature.length).toBe(64); // SHA-256 hex = 64 chars
  });

  it("accepts all valid roles", () => {
    const roles = ["specialist", "critic", "auditor", "orchestrator"] as const;
    for (const role of roles) {
      const card = deriveNodeCard({ ...baseInputs, node_id: `node:${role}:1`, role, tier: role }, TEST_SECRET);
      expect(card.role).toBe(role);
      expect(card.tier).toBe(role);
    }
  });

  it("accepts all valid sources", () => {
    const sources = ["builtin", "node", "skill", "command"] as const;
    for (const source of sources) {
      const card = deriveNodeCard({ ...baseInputs, node_id: `node:${source}:1`, source }, TEST_SECRET);
      expect(card.source).toBe(source);
    }
  });

  it("accepts all valid modes", () => {
    const modes: NodeCardMode[] = ["streaming", "steerable", "promote"];
    const card = deriveNodeCard({ ...baseInputs, modes }, TEST_SECRET);
    expect(card.modes.has("streaming")).toBe(true);
    expect(card.modes.has("steerable")).toBe(true);
    expect(card.modes.has("promote")).toBe(true);
  });

  it("throws on empty node_id", () => {
    expect(() => deriveNodeCard({ ...baseInputs, node_id: "" }, TEST_SECRET)).toThrow("node_id must be non-empty");
  });

  it("throws on oversized node_id", () => {
    const longId = "x".repeat(NODE_CARD_MAX_FIELD_BYTES + 1);
    expect(() => deriveNodeCard({ ...baseInputs, node_id: longId }, TEST_SECRET)).toThrow("node_id exceeds");
  });

  it("throws on invalid role", () => {
    expect(() => deriveNodeCard({ ...baseInputs, role: "king" as any }, TEST_SECRET)).toThrow("role must be one of");
  });

  it("throws on invalid tier", () => {
    expect(() => deriveNodeCard({ ...baseInputs, tier: "pleb" as any }, TEST_SECRET)).toThrow("tier must be one of");
  });

  it("throws on invalid source", () => {
    expect(() => deriveNodeCard({ ...baseInputs, source: "plugin" as any }, TEST_SECRET)).toThrow("source must be one of");
  });

  it("throws on invalid mode", () => {
    expect(() => deriveNodeCard({ ...baseInputs, modes: ["teleport" as any] }, TEST_SECRET)).toThrow("mode must be one of");
  });

  it("throws on oversize skill array", () => {
    const skills = Array.from({ length: NODE_CARD_MAX_SKILLS + 1 }, (_, i) => `skill-${i}`);
    expect(() => deriveNodeCard({ ...baseInputs, skills }, TEST_SECRET)).toThrow("skills exceeds maximum of 32");
  });

  it("throws on oversize inputs array", () => {
    const inputs = Array.from({ length: NODE_CARD_MAX_INPUTS + 1 }, (_, i) => `input-${i}`);
    expect(() => deriveNodeCard({ ...baseInputs, inputs }, TEST_SECRET)).toThrow("inputs exceeds maximum of 32");
  });

  it("throws on oversize outputs array", () => {
    const outputs = Array.from({ length: NODE_CARD_MAX_OUTPUTS + 1 }, (_, i) => `output-${i}`);
    expect(() => deriveNodeCard({ ...baseInputs, outputs }, TEST_SECRET)).toThrow("outputs exceeds maximum of 32");
  });

  it("throws on empty skill entry", () => {
    expect(() => deriveNodeCard({ ...baseInputs, skills: ["", "test"] }, TEST_SECRET)).toThrow("skill entry must be non-empty");
  });

  it("throws on empty input entry", () => {
    expect(() => deriveNodeCard({ ...baseInputs, inputs: ["", "tree"] }, TEST_SECRET)).toThrow("input entry must be non-empty");
  });

  it("throws on empty output entry", () => {
    expect(() => deriveNodeCard({ ...baseInputs, outputs: ["", "report"] }, TEST_SECRET)).toThrow("output entry must be non-empty");
  });

  it("throws on empty role string", () => {
    expect(() => deriveNodeCard({ ...baseInputs, role: "" as any }, TEST_SECRET)).toThrow("role must be non-empty");
  });

  it("throws on duplicate skills", () => {
    expect(() => deriveNodeCard({ ...baseInputs, skills: ["refactor", "refactor"] }, TEST_SECRET)).toThrow("skills must not contain duplicates");
  });

  it("throws on duplicate inputs", () => {
    expect(() => deriveNodeCard({ ...baseInputs, inputs: ["ledger", "ledger"] }, TEST_SECRET)).toThrow("inputs must not contain duplicates");
  });

  it("throws on duplicate outputs", () => {
    expect(() => deriveNodeCard({ ...baseInputs, outputs: ["patch", "patch"] }, TEST_SECRET)).toThrow("outputs must not contain duplicates");
  });

  it("throws on oversize skill entry", () => {
    const longSkill = "x".repeat(NODE_CARD_MAX_FIELD_BYTES + 1);
    expect(() => deriveNodeCard({ ...baseInputs, skills: [longSkill] }, TEST_SECRET)).toThrow("skill entry exceeds 128 bytes");
  });

  it("throws on oversize input entry", () => {
    const longInput = "x".repeat(NODE_CARD_MAX_FIELD_BYTES + 1);
    expect(() => deriveNodeCard({ ...baseInputs, inputs: [longInput] }, TEST_SECRET)).toThrow("input entry exceeds 128 bytes");
  });

  it("throws on oversize output entry", () => {
    const longOutput = "x".repeat(NODE_CARD_MAX_FIELD_BYTES + 1);
    expect(() => deriveNodeCard({ ...baseInputs, outputs: [longOutput] }, TEST_SECRET)).toThrow("output entry exceeds 128 bytes");
  });
});

describe("verifyNodeCard", () => {
  it("round-trips true for a freshly-derived card", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    expect(verifyNodeCard(card, TEST_SECRET)).toBe(true);
  });

  it("returns false for a card with tampered signature", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    const tampered: NodeCard = { ...card, signature: "0".repeat(64) };
    expect(verifyNodeCard(tampered, TEST_SECRET)).toBe(false);
  });

  it("returns false for a card with wrong secret", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    expect(verifyNodeCard(card, "wrong-secret")).toBe(false);
  });

  it("returns false for a card with tampered node_id", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    const tampered: NodeCard = { ...card, node_id: "node:evil:1" };
    expect(verifyNodeCard(tampered, TEST_SECRET)).toBe(false);
  });

  it("returns false for a card with tampered skills", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    const tampered: NodeCard = {
      ...card,
      skills: Object.freeze([...card.skills, "malicious"]),
    };
    expect(verifyNodeCard(tampered, TEST_SECRET)).toBe(false);
  });

  it("returns false for a card missing signature", () => {
    const { signature: _, ...rest } = deriveNodeCard(baseInputs, TEST_SECRET);
    expect(verifyNodeCard(rest as any, TEST_SECRET)).toBe(false);
  });

  it("returns false for a card with empty signature string", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    const tampered: NodeCard = { ...card, signature: "" };
    expect(verifyNodeCard(tampered, TEST_SECRET)).toBe(false);
  });

  it("returns false for null input", () => {
    expect(verifyNodeCard(null as any, TEST_SECRET)).toBe(false);
  });

  it("returns false for undefined input", () => {
    expect(verifyNodeCard(undefined as any, TEST_SECRET)).toBe(false);
  });

  it("returns false for a non-object input", () => {
    expect(verifyNodeCard("hello" as any, TEST_SECRET)).toBe(false);
  });

  it("does NOT throw on malformed input (returns false)", () => {
    expect(() => verifyNodeCard(null as any, TEST_SECRET)).not.toThrow();
    expect(() => verifyNodeCard({} as any, TEST_SECRET)).not.toThrow();
    expect(() => verifyNodeCard({ node_id: 42 } as any, TEST_SECRET)).not.toThrow();
  });

  it("rejects a card signed with different secret", () => {
    const cardA = deriveNodeCard(baseInputs, "secret-a");
    const cardB = deriveNodeCard(baseInputs, "secret-b");
    expect(verifyNodeCard(cardA, "secret-b")).toBe(false);
    expect(verifyNodeCard(cardB, "secret-a")).toBe(false);
  });
});

describe("canonicalNodeCardJson", () => {
  it("is byte-stable across object key reordering", () => {
    // Build cards from different insertion order
    const inputA: NodeCardInputs = {
      node_id: "node:test:1",
      role: "critic",
      skills: ["audit", "verify"],
      tier: "critic",
      modes: ["steerable"],
      inputs: ["evidence", "tree"],
      outputs: ["verdict"],
      source: "builtin",
    };
    const cardA = deriveNodeCard(inputA, TEST_SECRET);

    // Build via signNodeCard with keys in different order
    const reversed: Omit<NodeCard, "signature"> = {
      source: "builtin",
      outputs: Object.freeze(["verdict"]),
      node_id: "node:test:1",
      modes: new Set<NodeCardMode>(["steerable"]),
      tier: "critic",
      skills: Object.freeze(["audit", "verify"]),
      role: "critic",
      inputs: Object.freeze(["evidence", "tree"]),
    };
    const cardB = signNodeCard(reversed, TEST_SECRET);

    const jsonA = canonicalNodeCardJson(cardA);
    const jsonB = canonicalNodeCardJson(cardB);
    expect(jsonA).toBe(jsonB);
  });

  it("produces deterministic JSON with sorted keys", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    const json = canonicalNodeCardJson(card);
    // Parse and verify key order
    const parsed = JSON.parse(json);
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("includes all card fields except signature", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    const json = canonicalNodeCardJson(card);
    const parsed = JSON.parse(json);
    expect(parsed.node_id).toBe(card.node_id);
    expect(parsed.role).toBe(card.role);
    expect(parsed.skills).toEqual([...card.skills]);
    expect(parsed.tier).toBe(card.tier);
    expect(parsed.modes).toEqual([...card.modes].sort());
    expect(parsed.inputs).toEqual([...card.inputs]);
    expect(parsed.outputs).toEqual([...card.outputs]);
    expect(parsed.source).toBe(card.source);
    // signature is NOT in the canonical JSON
    expect(parsed.signature).toBeUndefined();
  });
});

describe("signNodeCard", () => {
  it("produces a frozen card with filled signature", () => {
    const unsigned: Omit<NodeCard, "signature"> = {
      node_id: "node:signed:1",
      role: "specialist",
      skills: Object.freeze(["lint"]),
      tier: "specialist",
      modes: new Set<NodeCardMode>(["streaming"]),
      inputs: Object.freeze(["tree"]),
      outputs: Object.freeze(["lint-report"]),
      source: "builtin",
    };
    const card = signNodeCard(unsigned, TEST_SECRET);
    expect(card.signature).toBeTruthy();
    expect(card.signature.length).toBe(64);
  });
});

describe("NodeCard immutability", () => {
  it("is frozen (Object.isFrozen === true)", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    expect(Object.isFrozen(card)).toBe(true);
  });

  it("has frozen skills array", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    expect(Object.isFrozen(card.skills)).toBe(true);
  });

  it("has frozen inputs array", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    expect(Object.isFrozen(card.inputs)).toBe(true);
  });

  it("has frozen outputs array", () => {
    const card = deriveNodeCard(baseInputs, TEST_SECRET);
    expect(Object.isFrozen(card.outputs)).toBe(true);
  });
});

describe("Replay byte-identity", () => {
  it("two deriveNodeCard calls with identical inputs and secret produce identical signature", () => {
    const cardA = deriveNodeCard(baseInputs, TEST_SECRET);
    const cardB = deriveNodeCard(baseInputs, TEST_SECRET);
    expect(cardA.signature).toBe(cardB.signature);
    // Full structural equality
    expect(JSON.stringify(cardA)).toBe(JSON.stringify(cardB));
  });

  it("same inputs but different secret produce different signatures", () => {
    const cardA = deriveNodeCard(baseInputs, "secret-alpha");
    const cardB = deriveNodeCard(baseInputs, "secret-beta");
    expect(cardA.signature).not.toBe(cardB.signature);
  });
});

describe("cardsForCapability", () => {
  function makeCard(id: string, tier: NodeCard["tier"]): NodeCard {
    return deriveNodeCard(
      {
        node_id: id,
        role: tier,
        skills: ["test"],
        tier,
        modes: ["streaming"],
        inputs: [],
        outputs: [],
        source: "builtin",
      },
      TEST_SECRET,
    );
  }

  const allCards = [
    makeCard("node:spec:1", "specialist"),
    makeCard("node:crit:1", "critic"),
    makeCard("node:aud:1", "auditor"),
    makeCard("node:orch:1", "orchestrator"),
  ];

  it("specialist sees only specialist-tier cards", () => {
    const result = cardsForCapability(allCards, "specialist");
    expect(result).toHaveLength(1);
    expect(result[0]!.node_id).toBe("node:spec:1");
    expect(result[0]!.tier).toBe("specialist");
  });

  it("critic sees all cards", () => {
    const result = cardsForCapability(allCards, "critic");
    expect(result).toHaveLength(4);
  });

  it("auditor sees all cards", () => {
    const result = cardsForCapability(allCards, "auditor");
    expect(result).toHaveLength(4);
  });

  it("orchestrator sees all cards", () => {
    const result = cardsForCapability(allCards, "orchestrator");
    expect(result).toHaveLength(4);
  });

  it("never returns a card with higher tier than the requester for specialist", () => {
    const result = cardsForCapability(allCards, "specialist");
    for (const card of result) {
      expect(card.tier).toBe("specialist");
    }
  });

  it("returns empty array for specialist when no specialist cards exist", () => {
    const nonSpecialistCards = allCards.slice(1);
    const result = cardsForCapability(nonSpecialistCards, "specialist");
    expect(result).toHaveLength(0);
  });
});

describe("selectNodeByCapability", () => {
  function makeCard(id: string, tier: NodeCard["tier"], skills: string[]): NodeCard {
    return deriveNodeCard(
      {
        node_id: id,
        role: tier,
        skills,
        tier,
        modes: ["streaming"],
        inputs: [],
        outputs: [],
        source: "builtin",
      },
      TEST_SECRET,
    );
  }

  it("picks the card with highest skill overlap", () => {
    const cards = [
      makeCard("node:low:1", "specialist", ["lint"]),
      makeCard("node:high:1", "specialist", ["refactor", "test", "lint"]),
      makeCard("node:med:1", "specialist", ["test", "lint"]),
    ];
    const result = selectNodeByCapability(cards, ["refactor", "test", "lint"], "specialist");
    expect(result).not.toBeNull();
    expect(result!.node_id).toBe("node:high:1");
  });

  it("tie-breaks by node_id ascending", () => {
    const cards = [
      makeCard("node:b:1", "specialist", ["test", "lint"]),
      makeCard("node:a:1", "specialist", ["test", "lint"]),
    ];
    const result = selectNodeByCapability(cards, ["test", "lint"], "specialist");
    expect(result).not.toBeNull();
    expect(result!.node_id).toBe("node:a:1");
  });

  it("returns null when no card matches any skill", () => {
    const cards = [
      makeCard("node:spec:1", "specialist", ["rust", "web"]),
      makeCard("node:spec:2", "specialist", ["db", "sql"]),
    ];
    const result = selectNodeByCapability(cards, ["python", "ml"], "specialist");
    expect(result).toBeNull();
  });

  it("returns null when empty card list", () => {
    const result = selectNodeByCapability([], ["test"], "specialist");
    expect(result).toBeNull();
  });

  it("does not select critic-tier cards when specialist requests", () => {
    const cards = [
      makeCard("node:spec:1", "specialist", ["test"]),
      makeCard("node:crit:1", "critic", ["test", "audit"]),
    ];
    const result = selectNodeByCapability(cards, ["test", "audit"], "specialist");
    // specialist can only see specialist cards, so only the specialist card wins
    expect(result).not.toBeNull();
    expect(result!.node_id).toBe("node:spec:1");
    expect(result!.tier).toBe("specialist");
  });

  it("orchestrator can select critic-tier cards", () => {
    const cards = [
      makeCard("node:spec:1", "specialist", ["test"]),
      makeCard("node:crit:1", "critic", ["audit", "review"]),
    ];
    const result = selectNodeByCapability(cards, ["audit", "review"], "orchestrator");
    expect(result).not.toBeNull();
    expect(result!.node_id).toBe("node:crit:1");
  });

  it("returns null when no cards at visible tier match", () => {
    const cards = [
      makeCard("node:crit:1", "critic", ["test"]),
    ];
    // specialist can't see critic cards
    const result = selectNodeByCapability(cards, ["test"], "specialist");
    expect(result).toBeNull();
  });
});