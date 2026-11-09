import { AGENT_NAMES, CATEGORY_NAMES } from "./types.js";
import { CONFIG_JSON_SCHEMA } from "./schema.js";

/**
 * ADR-020's "env" provenance source (G-07 — the per-knob-provenance
 * remainder). Every `ArborConfig` leaf is addressable as
 * `ARBOR_CONFIG__<PATH>` (segments upper-cased, `-` and `.` folded to `_`,
 * joined by `__`), e.g. `kb.backend` -> `ARBOR_CONFIG__KB__BACKEND`,
 * `categories.crown-structural.model` ->
 * `ARBOR_CONFIG__CATEGORIES__CROWN_STRUCTURAL__MODEL`.
 */
export const CONFIG_ENV_PREFIX = "ARBOR_CONFIG";

/** A single leaf genuinely overridden by a present, well-typed env var. */
export interface ConfigEnvOverride {
  /** Dotted config path, e.g. `tree_search.max_seconds`. */
  path: string;
  env_var: string;
}

export interface ConfigEnvLoadResult {
  /** Nested overlay shaped like `ArborConfig`, safe to deep-merge over a loaded config. Empty object when no env vars are set. */
  overlay: Record<string, unknown>;
  applied: readonly ConfigEnvOverride[];
  /** Present-but-rejected env vars (wrong runtime type, or naming a path the schema does not know) — non-fatal; the leaf keeps its prior value. */
  diagnostics: readonly string[];
}

function pathToEnvVar(path: readonly string[]): string {
  return [CONFIG_ENV_PREFIX, ...path.map((segment) => segment.toUpperCase().replace(/-/g, "_"))].join("__");
}

type LeafKind = "number" | "string" | "boolean";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Closed key sets for the two `additionalProperties`-shaped maps in the schema (agents/categories keyed by name, not by a JSON-schema `properties` block). */
const MAP_KEY_NAMES: Record<string, readonly string[]> = {
  agents: AGENT_NAMES,
  categories: CATEGORY_NAMES,
};

/**
 * Every overridable `ArborConfig` leaf, derived from `CONFIG_JSON_SCHEMA`
 * rather than `DEFAULT_CONFIG`. The runtime default object cannot enumerate
 * every leaf on its own: an optional, currently-empty section like
 * `tui: {}` has no `theme` key to walk, so a walk driven by the default
 * object silently drops any env override for a leaf that is known to the
 * schema but happens to default to an omitted/empty state (C-05). The
 * schema is authored with the full shape — including optional leaves — so
 * walking it here keeps "every leaf is overridable" true without also
 * seeding `DEFAULT_CONFIG` with fabricated non-default values.
 *
 * Array-typed leaves (e.g. `foreground.modes`) are not walked: there is no
 * settled single-env-var encoding for a list, so they are left as
 * file-only/not-env-overridable rather than guessed at here.
 */
function walkSchemaLeaves(node: unknown, path: readonly string[], visit: (path: readonly string[], kind: LeafKind) => void): void {
  if (!isRecord(node)) return;
  const properties = node.properties;
  if (isRecord(properties)) {
    for (const [key, child] of Object.entries(properties)) walkSchemaLeaves(child, [...path, key], visit);
    return;
  }
  const additionalProperties = node.additionalProperties;
  if (isRecord(additionalProperties)) {
    const knownKeys = MAP_KEY_NAMES[path[path.length - 1] ?? ""];
    if (!knownKeys) return; // no closed key set for this map at this path — nothing safe to enumerate
    for (const key of knownKeys) walkSchemaLeaves(additionalProperties, [...path, key], visit);
    return;
  }
  const type = node.type;
  if (type === "number" || type === "integer") { visit(path, "number"); return; }
  if (type === "string") { visit(path, "string"); return; }
  if (type === "boolean") { visit(path, "boolean"); return; }
}

const KNOWN_LEAVES = new Map<string, { path: readonly string[]; kind: LeafKind }>();
walkSchemaLeaves(CONFIG_JSON_SCHEMA, [], (path, kind) => {
  KNOWN_LEAVES.set(pathToEnvVar(path), { path, kind });
});

function setAtPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const existing = cursor[key];
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]!] = value;
}

/**
 * Reads `ARBOR_CONFIG__*` overrides for every known `ArborConfig` leaf
 * (see `walkSchemaLeaves`/`KNOWN_LEAVES`). A leaf's declared schema type
 * governs coercion: numeric leaves are `Number()`-coerced and a non-numeric
 * value is rejected as a diagnostic rather than silently becoming `NaN`
 * (which would slip past `validateConfig`'s `<=`/`<` bound checks
 * unnoticed); boolean leaves accept only the literal strings `"true"`/
 * `"false"`; string leaves pass through as-is — semantic validity (e.g.
 * `kb.backend`'s enum membership) is `validateConfig`'s job, the same as it
 * already is for file-sourced values, so no second validation path is
 * introduced here. An `ARBOR_CONFIG__*` var that does not match any known
 * leaf (unknown section, unknown agent/category name, or a path that is
 * only ever an array in the schema) is reported as a diagnostic instead of
 * being silently ignored, so a typo in an override is discoverable.
 */
export function loadConfigEnvOverrides(env: NodeJS.ProcessEnv = process.env): ConfigEnvLoadResult {
  const overlay: Record<string, unknown> = {};
  const applied: ConfigEnvOverride[] = [];
  const diagnostics: string[] = [];
  const configPrefix = `${CONFIG_ENV_PREFIX}__`;
  for (const [envVar, raw] of Object.entries(env)) {
    if (raw === undefined || !envVar.startsWith(configPrefix)) continue;
    const known = KNOWN_LEAVES.get(envVar);
    if (!known) {
      diagnostics.push(`${envVar} does not match any known ArborConfig leaf; ignored`);
      continue;
    }
    const { path, kind } = known;
    if (kind === "number") {
      const coerced = Number(raw);
      if (!Number.isFinite(coerced)) {
        diagnostics.push(`${envVar}="${raw}" is not a valid number for ${path.join(".")}; ignored`);
        continue;
      }
      setAtPath(overlay, path, coerced);
    } else if (kind === "boolean") {
      if (raw !== "true" && raw !== "false") {
        diagnostics.push(`${envVar}="${raw}" is not a valid boolean for ${path.join(".")}; ignored`);
        continue;
      }
      setAtPath(overlay, path, raw === "true");
    } else {
      setAtPath(overlay, path, raw);
    }
    applied.push({ path: path.join("."), env_var: envVar });
  }
  return { overlay, applied, diagnostics };
}
