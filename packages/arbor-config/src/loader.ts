import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ArborConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { parseKeymap, type NormalizedBinding } from "./keymap.js";
import { loadConfigEnvOverrides, type ConfigEnvOverride } from "./env.js";
import { validateConfig } from "./validator.js";

const FORBIDDEN_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertValidConfig(config: ArborConfig): ArborConfig {
  assertKnownConfigShape(config, DEFAULT_CONFIG, "");
  const validation = validateConfig(config);
  if (validation.errors.length > 0) throw new Error(`Invalid Arbor config: ${validation.errors.join("; ")}`);
  return config;
}

/**
 * `validateConfig` owns semantic rules, while this loader owns the runtime
 * type boundary. Derive known-leaf checks from defaults so a JSON cast cannot
 * smuggle strings, NaN, or arrays into numeric/string config leaves.
 */
function assertKnownConfigShape(value: unknown, defaults: unknown, path: string): void {
  if (typeof defaults === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid Arbor config type at ${path || "<root>"}: expected finite number`);
    return;
  }
  if (typeof defaults === "string") {
    if (typeof value !== "string") throw new Error(`Invalid Arbor config type at ${path || "<root>"}: expected string`);
    return;
  }
  if (defaults !== null && typeof defaults === "object" && !Array.isArray(defaults)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Arbor config type at ${path || "<root>"}: expected object`);
    for (const [key, defaultValue] of Object.entries(defaults as Record<string, unknown>)) {
      assertKnownConfigShape((value as Record<string, unknown>)[key], defaultValue, path ? `${path}.${key}` : key);
    }
  }
}

export function stripJsonc(input: string): string {
  // JSONC delimiters and commas can occur inside a provider endpoint/model
  // string (notably `https://…`). A regex stripper corrupts those values, so
  // keep a minimal string-aware scanner here instead of treating JSONC as
  // arbitrary text.
  let withoutComments = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (quote) {
      withoutComments += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') { quote = true; withoutComments += character; continue; }
    if (character === "/" && input[index + 1] === "/") {
      index += 2;
      while (index < input.length && input[index] !== "\n" && input[index] !== "\r") index++;
      if (index < input.length) withoutComments += input[index]!;
      continue;
    }
    if (character === "/" && input[index + 1] === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index++;
      if (index < input.length) index++;
      continue;
    }
    withoutComments += character;
  }

  let result = "";
  quote = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index++) {
    const character = withoutComments[index]!;
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') { quote = true; result += character; continue; }
    if (character === ",") {
      let next = index + 1;
      while (/\s/.test(withoutComments[next] ?? "")) next++;
      if (withoutComments[next] === "}" || withoutComments[next] === "]") continue;
    }
    result += character;
  }
  return result;
}

function deepMerge<T>(defaults: T, override: Partial<T>): T {
  if (typeof defaults !== "object" || defaults === null) return override as T;
  if (typeof override !== "object" || override === null) return override as T;
  const result: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) throw new Error(`Unsafe config key: ${key}`);
    if (
      typeof value === "object" && value !== null && !Array.isArray(value) &&
      typeof result[key] === "object" && result[key] !== null && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export function loadConfigFromString(jsonc: string): ArborConfig {
  const stripped = stripJsonc(jsonc.trim());
  if (!stripped) return structuredClone(DEFAULT_CONFIG);
  const parsed: unknown = JSON.parse(stripped);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Arbor config must be a JSON object");
  return assertValidConfig(deepMerge(DEFAULT_CONFIG, parsed as Partial<ArborConfig>));
}

/** ADR-110: `$ARBOR_USER_CONFIG_DIR/arbor.jsonc` (default `~/.arbor/arbor.jsonc`) is the new, deliberately-weakest scope. */
export const USER_CONFIG_DIR_ENV_VAR = "ARBOR_USER_CONFIG_DIR";
/**
 * ADR-110: the organization scope's directory. No default — an unset
 * organization scope is a normal, no-op layer (matching how an absent
 * project `arbor.jsonc` already behaves today), not an error. Deliberately
 * a directory, not `resolveCliOrganizationPolicy`'s `ARBOR_ORGANIZATION_POLICY`
 * *file* path (`packages/arbor-mcp/src/cli.ts`) — that env var names the
 * checked-in policy-floor document (`organization-policy.ts`'s separate
 * mechanism); this one names a directory that, when set, is expected to be
 * the same directory an operator points `ARBOR_ORGANIZATION_POLICY` at, so
 * the two travel together operationally without collapsing into one file or
 * one mechanism (ADR-110 Decision 3).
 */
export const ORGANIZATION_CONFIG_DIR_ENV_VAR = "ARBOR_ORGANIZATION_CONFIG_DIR";

export type ConfigScopeName = "organization" | "user" | "project";

export interface ConfigScopeLayer {
  readonly scope: ConfigScopeName;
  /** Absolute path this scope was resolved to check. `""` when the scope has no configured location at all (organization scope with no `ARBOR_ORGANIZATION_CONFIG_DIR`). */
  readonly path: string;
  /** Whether an `arbor.jsonc` actually existed at `path`. */
  readonly present: boolean;
  /** The raw parsed partial for this scope alone (not merged with any other scope). `null` when absent. */
  readonly layer: Partial<ArborConfig> | null;
}

export interface ConfigScopeResolution {
  readonly organization: ConfigScopeLayer;
  readonly user: ConfigScopeLayer;
  readonly project: ConfigScopeLayer;
  /** defaults -> organization -> user -> project, fully merged and shape/semantically validated. No env/injected layer. */
  readonly scoped: ArborConfig;
}

function resolveUserConfigDir(env: NodeJS.ProcessEnv): string {
  const override = env[USER_CONFIG_DIR_ENV_VAR]?.trim();
  return override ? override : join(homedir(), ".arbor");
}

/** Parses `<path>/arbor.jsonc` into a raw, un-defaulted partial for folding onto a prior scope's result. `null` when the file is absent or empty. */
function loadScopeLayer(path: string): Partial<ArborConfig> | null {
  if (!existsSync(path)) return null;
  const stripped = stripJsonc(readFileSync(path, "utf-8").trim());
  if (!stripped) return null;
  // Name the FILE. Three scopes are all called `arbor.jsonc` (organization,
  // user, project), so a bare "JSON Parse error: Expected '}'" left an
  // operator who mis-edited one with no way to know which to open — and the
  // crash screen showed only that sentence plus a parser stack frame
  // (EC-041). The sibling check below already names the path; this now
  // matches it. OpenCode carries `path` as a field of its config
  // `InvalidError`; Claude Code reports "failed to parse ${file} as JSON".
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    throw new Error(`Arbor config at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Arbor config must be a JSON object: ${path}`);
  return parsed as Partial<ArborConfig>;
}

/**
 * ADR-110 Decision 1: `loadConfig` grows a declared scope chain —
 * defaults -> organization -> user -> project -> env -> injected. This
 * resolves the first three (the new, purely file-based layers) as a single
 * fold, reusing `deepMerge`/`assertKnownConfigShape` (via `assertValidConfig`)
 * unchanged once per layer, exactly as `loadConfig` already did for its one
 * prior file layer — an additional fold over the same two functions, not a
 * new merge algorithm. Each scope is optional; an absent scope is a no-op
 * layer, exactly as an absent project `arbor.jsonc` already is today.
 */
export function resolveConfigScopes(dir: string, env: NodeJS.ProcessEnv = process.env): ConfigScopeResolution {
  const organizationDir = env[ORGANIZATION_CONFIG_DIR_ENV_VAR]?.trim();
  const organizationPath = organizationDir ? join(organizationDir, "arbor.jsonc") : "";
  const userPath = join(resolveUserConfigDir(env), "arbor.jsonc");
  const projectPath = join(dir, "arbor.jsonc");

  const organizationLayer = organizationDir ? loadScopeLayer(organizationPath) : null;
  const userLayer = loadScopeLayer(userPath);
  const projectLayer = loadScopeLayer(projectPath);

  let scoped: ArborConfig;
  if (organizationLayer === null && userLayer === null) {
    // No ADR-110 scope configured above the project layer — identical to
    // `loadConfig`'s pre-ADR-110 single-file behavior, and by far the
    // common case until an operator actually adopts organization/user
    // scopes. Reuse `loadConfigFromString` itself (the tested "defaults +
    // one file, validated" entry point) rather than re-deriving the same
    // guarantee a second way for this case.
    scoped = existsSync(projectPath) ? loadConfigFromString(readFileSync(projectPath, "utf-8")) : structuredClone(DEFAULT_CONFIG);
  } else {
    scoped = structuredClone(DEFAULT_CONFIG);
    if (organizationLayer) scoped = assertValidConfig(deepMerge(scoped, organizationLayer));
    if (userLayer) scoped = assertValidConfig(deepMerge(scoped, userLayer));
    if (projectLayer) scoped = assertValidConfig(deepMerge(scoped, projectLayer));
  }

  return {
    organization: { scope: "organization", path: organizationPath, present: organizationLayer !== null, layer: organizationLayer },
    user: { scope: "user", path: userPath, present: userLayer !== null, layer: userLayer },
    project: { scope: "project", path: projectPath, present: projectLayer !== null, layer: projectLayer },
    scoped,
  };
}

/**
 * Loads the full ADR-110 scope chain (organization -> user -> project) and
 * layers `ARBOR_CONFIG__*` env overrides (ADR-020 / G-07) on top — the same
 * precedence order `ConfigInspectionService`'s provenance view reports.
 * `env` defaults to `process.env` and is only ever overridden by
 * tests/callers that want to load without env interference (see
 * `loadConfigWithProvenance`, which does exactly that to keep the scope and
 * env layers separately addressable for provenance).
 */
export function loadConfig(dir: string, env: NodeJS.ProcessEnv = process.env): ArborConfig {
  const { scoped } = resolveConfigScopes(dir, env);
  const { overlay } = loadConfigEnvOverrides(env);
  return assertValidConfig(deepMerge(scoped, overlay as Partial<ArborConfig>));
}

export interface ConfigLoadResult {
  /** defaults -> organization -> user -> project -> env, fully merged — what a runtime should actually run with. */
  effective: ArborConfig;
  /**
   * defaults -> organization -> user -> project, with no env layer — the
   * "checked-in" provenance baseline. Named `file_only` for backward
   * compatibility with existing callers that treated this as "the file
   * layer"; it is now the full scope-chain result short of env/injected.
   * Use `scopes`/`organization_only`/`user_only` for the per-scope
   * breakdown this single field can no longer distinguish on its own.
   */
  file_only: ArborConfig;
  /** defaults -> organization only, with no user/project/env layer. */
  organization_only: ArborConfig;
  /** defaults -> organization -> user, with no project/env layer. */
  user_only: ArborConfig;
  /** The per-scope layers (path, presence, raw partial) that produced `file_only`. */
  scopes: ConfigScopeResolution;
  /** Nested overlay of only the env-overridden leaves; `{}` when no `ARBOR_CONFIG__*` var is set. */
  env_overlay: Record<string, unknown>;
  env_overrides: readonly ConfigEnvOverride[];
  /** Non-fatal: present-but-rejected env vars (wrong runtime type for the leaf). */
  env_diagnostics: readonly string[];
}

/**
 * G-07 (ADR-020 remainder) + ADR-110: loads the same effective config as
 * `loadConfig` but keeps every scope layer (organization/user/project) and
 * the env layer separately addressable, so a caller building per-leaf
 * provenance (`ConfigInspectionService`) can tell which scope a value came
 * from instead of a single merged view that can only say "differs from
 * default". Still the one loader (`loadConfig`/`resolveConfigScopes`)
 * underneath — this composes it, it does not re-implement
 * file/JSONC/scope-resolution a second way.
 */
export function loadConfigWithProvenance(dir: string, env: NodeJS.ProcessEnv = process.env): ConfigLoadResult {
  // `env` here locates the organization/user scope *directories*
  // (`ARBOR_ORGANIZATION_CONFIG_DIR`/`ARBOR_USER_CONFIG_DIR`) — a distinct
  // concern from the `ARBOR_CONFIG__*` leaf-value overrides
  // `loadConfigEnvOverrides` reads below, which must stay excluded from
  // `file_only` so the file and env layers stay separately addressable.
  const scopes = resolveConfigScopes(dir, env);
  let organization_only: ArborConfig = structuredClone(DEFAULT_CONFIG);
  if (scopes.organization.layer) organization_only = assertValidConfig(deepMerge(organization_only, scopes.organization.layer));
  let user_only = organization_only;
  if (scopes.user.layer) user_only = assertValidConfig(deepMerge(user_only, scopes.user.layer));
  const file_only = scopes.scoped;
  const { overlay, applied, diagnostics } = loadConfigEnvOverrides(env);
  const effective = assertValidConfig(deepMerge(file_only, overlay as Partial<ArborConfig>));
  return { effective, file_only, organization_only, user_only, scopes, env_overlay: overlay, env_overrides: applied, env_diagnostics: diagnostics };
}

export const KEYMAP_FILENAME = "arbor.keymap";

export interface KeymapLoadResult {
  /** Whether a keymap file existed on disk. A missing file is normal, not an error. */
  readonly present: boolean;
  readonly bindings: readonly NormalizedBinding[];
  /** Parse diagnostics from a malformed file. Non-fatal — callers should fall back to defaults. */
  readonly diagnostics: readonly string[];
}

/**
 * Load the optional keymap-as-config grammar (ADR-020) from `<dir>/arbor.keymap`.
 * Mirrors `loadConfig`'s contract: a missing file returns an empty, valid
 * result rather than throwing, so a caller can always fall back to built-in
 * bindings without treating "no keymap file" as an error.
 */
export function loadKeymap(dir: string): KeymapLoadResult {
  const keymapPath = join(dir, KEYMAP_FILENAME);
  if (!existsSync(keymapPath)) return { present: false, bindings: [], diagnostics: [] };
  const raw = readFileSync(keymapPath, "utf-8");
  const parsed = parseKeymap(raw);
  if (!parsed.ok) return { present: true, bindings: [], diagnostics: parsed.diagnostics };
  return { present: true, bindings: parsed.bindings, diagnostics: [] };
}
