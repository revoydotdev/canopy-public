// arbor-core/node-card — Capability-addressable, tiered, verifiable re-derivable projection
// of the ledger + tree + capability registry. Clean-room design.
//
// Commandment III: NodeCard is a PURE PROJECTION, never a separately stored registry.
// The inputs (node_id, role, skills, etc.) are the authority; deriveNodeCard produces
// the card deterministically at call time.

import { compareCodeUnits } from "./ordering.js";
import { createHmac, timingSafeEqual } from "node:crypto";

// ============================================================
// CATALOG DISCRIMINATOR (mirrors ADR-020's catalog.source)
// ============================================================

/** Source discriminator: where this card's definition originates. */
export type NodeCardSource = "builtin" | "node" | "skill" | "command";

// ============================================================
// MODE & ROLE / TIER VOCABULARY
// ============================================================

/** Operational mode the card supports. */
export type NodeCardMode = "streaming" | "steerable" | "promote";

// ============================================================
// BOUNDS CONSTANTS
// ============================================================

/** Maximum number of skills a card may list. */
export const NODE_CARD_MAX_SKILLS = 32;
/** Maximum number of input bindings a card may declare. */
export const NODE_CARD_MAX_INPUTS = 32;
/** Maximum number of output bindings a card may declare. */
export const NODE_CARD_MAX_OUTPUTS = 32;
/** Maximum byte length of any string field in a card (skills, ids, etc.). */
export const NODE_CARD_MAX_FIELD_BYTES = 128;

// ============================================================
// CARD TYPE
// ============================================================

/**
 * A closed, frozen, re-derivable projection of the durable tree + capability registry.
 *
 * Every NodeCard is a derived value: the authority is the input data from which it was
 * projected. Cards are never stored as a separate mutable registry — they are re-derived
 * at each use site (Commandment III).
 *
 * The `signature` is an HMAC-SHA256 over the canonical JSON of the projection, enabling
 * integrity verification without a central registry.
 */
export interface NodeCard {
  readonly node_id: string;
  readonly role: "specialist" | "critic" | "auditor" | "orchestrator";
  readonly skills: readonly string[];
  readonly tier: "specialist" | "critic" | "auditor" | "orchestrator";
  readonly modes: ReadonlySet<NodeCardMode>;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly source: NodeCardSource;
  readonly signature: string;
}

// ============================================================
// DERIVATION INPUT
// ============================================================

/** Inputs required to derive a NodeCard. The authority for the projection. */
export interface NodeCardInputs {
  readonly node_id: string;
  readonly role: NodeCard["role"];
  readonly skills: readonly string[];
  readonly tier: NodeCard["tier"];
  readonly modes: readonly NodeCardMode[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly source: NodeCardSource;
}

// ============================================================
// VALID CATALOG MEMBERS (closed)
// ============================================================

const VALID_ROLES = new Set<string>(["specialist", "critic", "auditor", "orchestrator"]);
const VALID_TIERS = new Set<string>(["specialist", "critic", "auditor", "orchestrator"]);
const VALID_MODES = new Set<string>(["streaming", "steerable", "promote"]);
const VALID_SOURCES = new Set<string>(["builtin", "node", "skill", "command"]);

// ============================================================
// HELPERS
// ============================================================

function hasDuplicates(items: readonly string[]): boolean {
  return new Set(items).size !== items.length;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must be non-empty`);
}

function assertMaxBytes(value: string, max: number, label: string): void {
  if (Buffer.byteLength(value, "utf8") > max) throw new Error(`${label} exceeds ${max} bytes`);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function assertMaxItems(value: readonly unknown[], max: number, label: string): void {
  if (value.length > max) throw new Error(`${label} exceeds maximum of ${max}`);
}

// ============================================================
// CANONICAL JSON — deterministic, sorted keys, no whitespace
// ============================================================

/**
 * Produce deterministic canonical JSON for a NodeCard (without signature).
 *
 * - Object keys are sorted lexicographically.
 * - No whitespace or newlines.
 * - UTF-8 byte counting uses `[...str].length` idiom (see token-economy.ts).
 * - Sets (`modes`) are serialized as a sorted array.
 * - The `signature` field is excluded — it would create a circular dependency.
 */
export function canonicalNodeCardJson(card: {
  node_id: string;
  role: string;
  skills: readonly string[];
  tier: string;
  modes: ReadonlySet<NodeCardMode> | readonly NodeCardMode[];
  inputs: readonly string[];
  outputs: readonly string[];
  source: string;
}): string {
  // Convert Set to sorted array for deterministic ordering
  const modesArray =
    card.modes instanceof Set
      ? [...card.modes].sort()
      : [...card.modes].sort();

  // Build a sorted-key object for deterministic JSON serialization
  const canonical: Record<string, unknown> = {};
  const keys = ["inputs", "node_id", "outputs", "role", "skills", "source", "tier"];

  // Insert the modes array at the correct sorted position ("modes" sorts after
  // "inputs" and before "node_id" alphabetically: i < m < n < o < r < s < t)
  const allKeys = [...keys.slice(0, 1), "modes", ...keys.slice(1)].sort();

  const data: Record<string, unknown> = {
    node_id: card.node_id,
    role: card.role,
    skills: [...card.skills],
    tier: card.tier,
    modes: modesArray,
    inputs: [...card.inputs],
    outputs: [...card.outputs],
    source: card.source,
  };

  for (const key of allKeys) {
    canonical[key] = data[key];
  }

  return JSON.stringify(canonical);
}

// ============================================================
// SIGNING
// ============================================================

/**
 * Produce an HMAC-SHA256 signature over the canonical JSON of a card.
 *
 * The secret is INJECTED at the boundary (`@arbor/mcp`), never owned by core.
 * Returns a new card object with the `signature` field filled.
 */
export function signNodeCard(
  card: Omit<NodeCard, "signature">,
  secret: string,
): NodeCard {
  const canonical = canonicalNodeCardJson(card);
  const hmac = createHmac("sha256", secret);
  hmac.update(canonical, "utf8");
  const signature = hmac.digest("hex");

  return Object.freeze({
    node_id: card.node_id,
    role: card.role,
    skills: Object.freeze([...card.skills]) as readonly string[],
    tier: card.tier,
    modes: new Set(card.modes),
    inputs: Object.freeze([...card.inputs]) as readonly string[],
    outputs: Object.freeze([...card.outputs]) as readonly string[],
    source: card.source,
    signature,
  });
}

// ============================================================
// VERIFICATION
// ============================================================

/**
 * Verify a NodeCard's signature.
 *
 * Re-canonicalizes (excluding the stored signature), re-signs, and
 * constant-time compares. Returns `false` on ANY malformed input rather
 * than throwing, so a corrupted projection is detected silently without
 * crashing the caller.
 */
export function verifyNodeCard(card: NodeCard, secret: string): boolean {
  try {
    if (!card || typeof card !== "object") return false;
    if (typeof card.node_id !== "string" || card.node_id.length === 0) return false;
    if (typeof card.signature !== "string" || card.signature.length === 0) return false;

    // Re-canonicalize without the signature
    const canonical = canonicalNodeCardJson(card);
    const hmac = createHmac("sha256", secret);
    hmac.update(canonical, "utf8");
    const expectedSig = hmac.digest("hex");

    // Constant-time comparison
    const actualBuf = Buffer.from(card.signature, "hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");

    if (actualBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

// ============================================================
// DERIVATION
// ============================================================

/**
 * Derive a signed NodeCard from authoritative inputs.
 *
 * This is the ONLY way to produce a valid NodeCard. It validates all inputs
 * (bounds, non-empty ids, closed-catalog membership, no duplicates), builds
 * an unsigned card, and signs it via the injected secret.
 *
 * Throws on validation failure with a precise error message naming the
 * failing field.
 *
 * Two calls with identical inputs and the same secret produce byte-identical
 * signatures (replay equivalence).
 */
export function deriveNodeCard(input: NodeCardInputs, secret: string): NodeCard {
  // Validate node_id
  assertNonEmpty(input.node_id, "node_id");
  assertMaxBytes(input.node_id, NODE_CARD_MAX_FIELD_BYTES, "node_id");

  // Validate role
  assertNonEmpty(input.role, "role");
  if (!VALID_ROLES.has(input.role)) {
    throw new Error(`role must be one of: ${[...VALID_ROLES].join(", ")}`);
  }

  // Validate skills
  assertMaxItems(input.skills, NODE_CARD_MAX_SKILLS, "skills");
  for (const skill of input.skills) {
    assertNonEmpty(skill, "skill entry");
    assertMaxBytes(skill, NODE_CARD_MAX_FIELD_BYTES, "skill entry");
  }
  if (hasDuplicates(input.skills)) throw new Error("skills must not contain duplicates");

  // Validate tier
  assertNonEmpty(input.tier, "tier");
  if (!VALID_TIERS.has(input.tier)) {
    throw new Error(`tier must be one of: ${[...VALID_TIERS].join(", ")}`);
  }

  // Validate modes
  for (const mode of input.modes) {
    if (!VALID_MODES.has(mode)) {
      throw new Error(`mode must be one of: ${[...VALID_MODES].join(", ")}`);
    }
  }

  // Validate inputs
  assertMaxItems(input.inputs, NODE_CARD_MAX_INPUTS, "inputs");
  for (const dep of input.inputs) {
    assertNonEmpty(dep, "input entry");
    assertMaxBytes(dep, NODE_CARD_MAX_FIELD_BYTES, "input entry");
  }
  if (hasDuplicates(input.inputs)) throw new Error("inputs must not contain duplicates");

  // Validate outputs
  assertMaxItems(input.outputs, NODE_CARD_MAX_OUTPUTS, "outputs");
  for (const out of input.outputs) {
    assertNonEmpty(out, "output entry");
    assertMaxBytes(out, NODE_CARD_MAX_FIELD_BYTES, "output entry");
  }
  if (hasDuplicates(input.outputs)) throw new Error("outputs must not contain duplicates");

  // Validate source
  assertNonEmpty(input.source, "source");
  if (!VALID_SOURCES.has(input.source)) {
    throw new Error(`source must be one of: ${[...VALID_SOURCES].join(", ")}`);
  }

  // Build unsigned projection then sign
  const unsigned: Omit<NodeCard, "signature"> = {
    node_id: input.node_id,
    role: input.role,
    skills: Object.freeze([...input.skills]),
    tier: input.tier,
    modes: new Set(input.modes),
    inputs: Object.freeze([...input.inputs]),
    outputs: Object.freeze([...input.outputs]),
    source: input.source,
  };

  return signNodeCard(unsigned, secret);
}

// ============================================================
// CAPABILITY FILTER — structural redaction (Commandment IV, handoff §2.IV)
// ============================================================

/**
 * Tier-visibility matrix (handoff §2.IV):
 *
 * | Requester \ Target | specialist | critic | auditor | orchestrator |
 * |--------------------|------------|--------|---------|--------------|
 * | specialist         | ✓          | ✗      | ✗       | ✗            |
 * | critic             | ✓          | ✓      | ✓       | ✓            |
 * | auditor            | ✓          | ✓      | ✓       | ✓            |
 * | orchestrator       | ✓          | ✓      | ✓       | ✓            |
 *
 * specialist sees only specialist-tier cards. All higher tiers see every card.
 */
const TIER_VISIBLE = new Set<string>(["critic", "auditor", "orchestrator"]);

/**
 * Return only the cards whose tier is visible to the requesting tier.
 *
 * This is STRUCTURAL REDACTION: the returned array contains only allowed cards,
 * never a "hidden" marker. specialist-tier requesters see only specialist cards;
 * all higher tiers see everything.
 */
export function cardsForCapability(
  cards: readonly NodeCard[],
  requestingTier: NodeCard["tier"],
): NodeCard[] {
  if (TIER_VISIBLE.has(requestingTier)) {
    return [...cards];
  }
  // specialist sees only specialist
  return cards.filter((card) => card.tier === "specialist");
}

// ============================================================
// ROUTING — pure, no side effects
// ============================================================

/**
 * Select the card with the highest skill overlap for a given task at the
 * requested tier.
 *
 * Returns `null` when no card covers any requested skill at the given tier.
 * Tie-breaks are deterministic by `node_id` ascending.
 *
 * This is the routing primitive 4D.3 promises — a pure projection.
 * @arbor/mcp's `selectNode` will call this in a later tranche.
 */
export function selectNodeByCapability(
  cards: readonly NodeCard[],
  taskSkills: readonly string[],
  requestedTier: NodeCard["tier"],
): NodeCard | null {
  // Filter to visible tier
  const visible = cardsForCapability(cards, requestedTier);
  if (visible.length === 0) return null;

  const taskSet = new Set(taskSkills);
  let best: NodeCard | null = null;
  let bestOverlap = -1;

  for (const card of visible) {
    const overlap = card.skills.filter((skill) => taskSet.has(skill)).length;
    if (overlap === 0) continue;

    if (overlap > bestOverlap) {
      best = card;
      bestOverlap = overlap;
    } else if (overlap === bestOverlap && best !== null) {
      // Deterministic tie-break by node_id ascending
      if (card.node_id < best.node_id) {
        best = card;
      }
    }
  }

  return best;
}

// ============================================================
// FOREGROUND DERIVATION (Phase 4D.4 — Appendix A)
// ============================================================

export const FOREGROUND_MAX_DELEGATION_ENTRIES = 32;
export const FOREGROUND_MAX_MODEL_FAMILY_BYTES = 64;
export const FOREGROUND_MAX_PROMPT_FRAGMENT_BYTES = 4096;

export interface ForegroundDelegationEntry {
  readonly skill: string;
  readonly target_node_id: string;
  readonly target_tier: NodeCard["tier"];
}

export interface ForegroundInputs {
  readonly node_id: string;
  readonly role: NodeCard["role"];
  readonly tier: NodeCard["tier"];
  readonly model_family: string;
  readonly skills: readonly string[];
  readonly delegation_catalog: readonly ForegroundDelegationEntry[];
  readonly operator_overrides?: Partial<Pick<NodeCard, "modes" | "inputs" | "outputs">>;
  readonly source: NodeCardSource;
}

export interface ForegroundProjection {
  readonly card: NodeCard;
  readonly delegation_table: readonly ForegroundDelegationEntry[];
  readonly prompt_fragment: string;
}

export function deriveForeground(input: ForegroundInputs, secret: string): ForegroundProjection {
  assertNonEmpty(input.model_family, "model_family");
  assertMaxBytes(input.model_family, FOREGROUND_MAX_MODEL_FAMILY_BYTES, "model_family");
  assertMaxItems(input.delegation_catalog, FOREGROUND_MAX_DELEGATION_ENTRIES, "delegation_catalog");

  for (const entry of input.delegation_catalog) {
    assertNonEmpty(entry.skill, "delegation skill");
    assertNonEmpty(entry.target_node_id, "delegation target_node_id");
    assertMaxBytes(entry.skill, NODE_CARD_MAX_FIELD_BYTES, "delegation skill");
    assertMaxBytes(entry.target_node_id, NODE_CARD_MAX_FIELD_BYTES, "delegation target_node_id");
    if (!VALID_TIERS.has(entry.target_tier)) throw new Error(`delegation target_tier ${entry.target_tier} is not in the closed catalog`);
  }
  if (hasDuplicates(input.delegation_catalog.map((e) => e.skill))) {
    throw new Error("delegation_catalog skills must be unique");
  }

  const modesOverride = input.operator_overrides?.modes;
  const modesArray: readonly NodeCardMode[] = modesOverride === undefined
    ? ["steerable"]
    : modesOverride instanceof Set
      ? [...modesOverride]
      : [...modesOverride];
  const cardInput: NodeCardInputs = {
    node_id: input.node_id,
    role: input.role,
    skills: input.skills,
    tier: input.tier,
    modes: modesArray,
    inputs: input.operator_overrides?.inputs ?? [],
    outputs: input.operator_overrides?.outputs ?? [],
    source: input.source,
  };
  const card = deriveNodeCard(cardInput, secret);

  const delegation_table = [...input.delegation_catalog].sort((a, b) => compareCodeUnits(a.skill, b.skill));

  const promptData = {
    lead: input.node_id,
    role: input.role,
    model_family: input.model_family,
    tier: input.tier,
    delegation: delegation_table.map((e) => ({ skill: e.skill, target: e.target_node_id, tier: e.target_tier })),
  };
  let prompt_fragment = JSON.stringify(promptData);
  if (Buffer.byteLength(prompt_fragment, "utf8") > FOREGROUND_MAX_PROMPT_FRAGMENT_BYTES) {
    prompt_fragment = truncateUtf8(prompt_fragment, FOREGROUND_MAX_PROMPT_FRAGMENT_BYTES);
  }

  return Object.freeze({
    card,
    delegation_table: Object.freeze([...delegation_table]),
    prompt_fragment,
  });
}
