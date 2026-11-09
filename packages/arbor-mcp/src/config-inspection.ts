/**
 * Config-inspection backend (roadmap 4C, item 21; scope chain per ADR-110).
 *
 * Produces an effective config view by composing, in precedence order:
 * built-in defaults → organization scope → user scope → loaded/file
 * (project) config → env overrides → runtime-injected overrides. Every leaf
 * carries the source it came from (`default` | `organization` | `user` |
 * `file` | `env` | `ledger` | `injected`) and fallback wins on absent keys.
 * Secret-like values are structurally redacted (the leaf's value is ABSENT /
 * replaced with an explicit `[redacted]` marker) regardless of capability
 * tier. Raw process globals / environment are never exposed as-is — only
 * the already-parsed `ARBOR_CONFIG__*` overlay `@arbor/config`'s
 * `loadConfigWithProvenance` produces reaches here (see `cli.ts`).
 *
 * ADR-110 note: the project scope's source tag stays `"file"` (not renamed
 * to `"project"`) — `native-harness-readiness.ts`'s `config_sources` and its
 * `formatNativeHarnessReadiness` summary line, plus `cli.ts`'s
 * `buildConfigInspectionFromEffective`, already key off `"file"` by name,
 * and a rename is a real blast-radius cost this ADR's Consequences section
 * flags explicitly. `file` denotes the project scope's config file exactly
 * as it always has; `organization`/`user` are the genuinely new tags this
 * ADR adds. `composeEffectiveConfig`'s `organization`/`user` inputs are
 * wired and tested here; `cli.ts`'s live `config.get`/`doctor` call sites
 * still only pass `defaults`/`file`/`env` (they do not yet source
 * `organization_only`/`user_only` from `loadConfigWithProvenance`) — a
 * follow-on wiring change outside `@arbor/config`'s ownership, not a gap in
 * this mechanism itself.
 *
 * `"ledger"` (ADR-020, G-07) is a reserved, typed-but-currently-unfed
 * source: a governance-critical knob whose authority is the audit ledger
 * rather than a mutable file/env value. No production caller populates it
 * yet — wiring a real ledger-derived config source is `arbor-audit`/
 * `arbor-core` territory, out of `arbor-config`'s scope — but the type
 * already reserves the slot so a future ledger-backed knob does not need a
 * second schema change, the same "typed absence, not silently inert"
 * pattern this package already uses for `recovery_leases`/
 * `model_capabilities`/`campaign_runner`.
 *
 * The compose step is a PURE function so it is trivially testable; the
 * service just holds the known sources. Never a second authoritative
 * config store — compose from the single typed ArborConfig.
 */

import { compareCodeUnits } from "@arbor/core";
import { CONFIG_JSON_SCHEMA, resolveNativeProviderSelection, type ArborConfig, type NativeProviderSelection } from "@arbor/config";

export type ConfigSourceKind = "default" | "organization" | "user" | "file" | "env" | "ledger" | "injected";

/**
 * Every field of `T` optional, recursively. `file`/`injected` overlays only
 * ever specify the keys they override — the layering contract falls back to
 * `defaults` per leaf, not per top-level section — so a full `ArborConfig`
 * is the wrong type for them.
 */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export interface ConfigLeaf {
  /** Dotted path, e.g. `tree_search.max_seconds`. */
  path: string;
  source: ConfigSourceKind;
  /** Redacted leaves carry `[redacted]`; the real value is structurally absent. */
  value: unknown;
  redacted: boolean;
}

export interface EffectiveConfigView {
  /** The checked-in schema identity for this projection's ArborConfig shape. */
  schema: { uri: string; title: string };
  /** Flat, bounded list of leaf rows. */
  leaves: readonly ConfigLeaf[];
  /** Declared input sources (interface only, never raw env/globals). */
  sources: { defaults_present: boolean; organization_present: boolean; user_present: boolean; file_present: boolean; env_present: boolean; injected_present: boolean };
  /** Whether the config has any structurally redacted secret leaf. */
  has_redacted: boolean;
  /**
   * Derived from the effective, non-secret `native.*` leaves. This lets an
   * operator distinguish direct-native selection from the connector fallback
   * without inferring it from an endpoint/model string.
   */
  native_selection: NativeProviderSelection | null;
}

export const SECRET_PATH_TOKENS = ["token", "secret", "password", "api_key", "apikey", "credential"] as const;

function isSecretPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SECRET_PATH_TOKENS.some((token) => lower.split(".").some((segment) => segment.includes(token)));
}

/** Depth-first flatten an object into dotted-path leaves with bounded depth. */
function flatten(prefix: string, value: unknown, out: ConfigLeaf[], source: ConfigSourceKind, maxDepth: number, into: (value: unknown) => unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path.split(".").length > maxDepth) continue;
    if (child !== null && typeof child === "object") {
      flatten(path, child, out, source, maxDepth, into);
    } else {
      out.push({ path, source, value: into(child), redacted: false });
    }
  }
}

/**
 * Compose defaults → file → injected into a flat leaf list. Later sources
 * override earlier ones at the same path; absent keys fall back. Pure.
 */
export function composeEffectiveConfig(input: {
  defaults?: ArborConfig | null;
  /** ADR-110: checked-in organization scope, layered after `defaults` and before `user`. */
  organization?: DeepPartial<ArborConfig> | null;
  /** ADR-110: `$ARBOR_USER_CONFIG_DIR/arbor.jsonc` scope, layered after `organization` and before `file` (project). */
  user?: DeepPartial<ArborConfig> | null;
  file?: DeepPartial<ArborConfig> | null;
  /** ADR-020/G-07: `ARBOR_CONFIG__*` overrides, layered after `file` and before `injected`. */
  env?: DeepPartial<ArborConfig> | null;
  injected?: DeepPartial<ArborConfig> | null;
  maxDepth?: number;
}): EffectiveConfigView {
  const maxDepth = input.maxDepth ?? 12;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 32) throw new Error("maxDepth must be an integer from 1 through 32");

  const leaves = new Map<string, { source: ConfigSourceKind; value: unknown }>();
  const record = (config: DeepPartial<ArborConfig> | null | undefined, source: ConfigSourceKind): void => {
    const collected: ConfigLeaf[] = [];
    flatten("", config, collected, source, maxDepth, (v) => v);
    for (const leaf of collected) leaves.set(leaf.path, { source, value: leaf.value });
  };

  // ADR-110 Decision 2: same declared precedence order as `resolveConfigScopes`
  // (defaults -> organization -> user -> project -> env -> injected).
  record(input.defaults, "default");
  record(input.organization, "organization");
  record(input.user, "user");
  record(input.file, "file");
  record(input.env, "env");
  record(input.injected, "injected");
  record(input.injected, "injected"); // idempotent — same path/source overwrites identically

  const rows: ConfigLeaf[] = [...leaves.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([path, { source, value }]) => {
    const redacted = isSecretPath(path);
    return { path, source, value: redacted ? "[redacted]" : value, redacted };
  });

  return {
    // `config.get` is the canonical operator projection. Expose only schema
    // identity, not a separately-maintained copy of the schema, so editors
    // and operators can tie the live view back to @arbor/config's one source.
    schema: { uri: CONFIG_JSON_SCHEMA.$schema, title: CONFIG_JSON_SCHEMA.title },
    leaves: rows,
    sources: {
      defaults_present: input.defaults !== null && input.defaults !== undefined,
      organization_present: input.organization !== null && input.organization !== undefined,
      user_present: input.user !== null && input.user !== undefined,
      file_present: input.file !== null && input.file !== undefined,
      env_present: input.env !== null && input.env !== undefined,
      injected_present: input.injected !== null && input.injected !== undefined,
    },
    has_redacted: rows.some((leaf) => leaf.redacted),
    native_selection: nativeSelection(leaves),
  };
}

function nativeSelection(leaves: ReadonlyMap<string, { source: ConfigSourceKind; value: unknown }>): NativeProviderSelection | null {
  const mode = leaves.get("native.mode")?.value;
  const adapter_id = leaves.get("native.adapter_id")?.value;
  const provider_id = leaves.get("native.provider_id")?.value;
  const base_url = leaves.get("native.base_url")?.value;
  const model = leaves.get("native.model")?.value;
  const revision = leaves.get("native.revision")?.value;
  if ((mode !== "auto" && mode !== "native" && mode !== "fallback") || typeof adapter_id !== "string" || typeof provider_id !== "string" || typeof base_url !== "string" || typeof model !== "string" || (revision !== undefined && typeof revision !== "string")) return null;
  return resolveNativeProviderSelection({ mode, adapter_id: adapter_id as ArborConfig["native"]["adapter_id"], provider_id, base_url, model, ...(typeof revision === "string" ? { revision } : {}) });
}

/** Immutable service holding the composed sources. */
export class ConfigInspectionService {
  constructor(private readonly sources: {
    defaults?: ArborConfig | null;
    /** ADR-110: organization scope, layered before `user` and `file`. */
    organization?: DeepPartial<ArborConfig> | null;
    /** ADR-110: user scope, layered after `organization` and before `file`. */
    user?: DeepPartial<ArborConfig> | null;
    file?: DeepPartial<ArborConfig> | null;
    env?: DeepPartial<ArborConfig> | null;
    injected?: DeepPartial<ArborConfig> | null;
    maxDepth?: number;
  } = {}) {}

  inspect(): EffectiveConfigView {
    return composeEffectiveConfig(this.sources);
  }
}
