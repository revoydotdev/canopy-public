/**
 * arbor-eval/stage0/hermetic — per-attempt config isolation and the
 * effective-config record (pilot-3 report D4).
 *
 * `arbor` merges its project `arbor.jsonc` over the operator's user-scope
 * config (ADR-110). The Revision 2.2 pilot's first run silently measured
 * `estimate_max_output_tokens: 16000` because the operator's own file set it
 * and the experiment's config left the key out. An attempt is therefore run
 * with `ARBOR_USER_CONFIG_DIR` pointing at an empty per-attempt directory, no
 * organization scope and no `ARBOR_CONFIG__*` overrides. `HOME` and
 * `XDG_CONFIG_HOME` are left alone on purpose: provider credentials resolve
 * from `~/.config/revoy/revoy.env` and the process environment, and neither
 * is a config scope.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_ENV_PREFIX, loadConfigWithProvenance, ORGANIZATION_CONFIG_DIR_ENV_VAR, USER_CONFIG_DIR_ENV_VAR } from "@arbor/config";
import type { ArborConfig } from "@arbor/config";

/** The environment an attempt's `arbor` processes run under: `base` minus every config scope above the project, plus an empty user scope. */
export function hermeticEnv(base: NodeJS.ProcessEnv, userConfigDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (name === ORGANIZATION_CONFIG_DIR_ENV_VAR || name === USER_CONFIG_DIR_ENV_VAR || name.startsWith(`${CONFIG_ENV_PREFIX}__`)) continue;
    env[name] = value;
  }
  mkdirSync(userConfigDir, { recursive: true });
  env[USER_CONFIG_DIR_ENV_VAR] = userConfigDir;
  return env;
}

export function attemptConfigHome(runDir: string): string {
  return join(runDir, "config-home");
}

const SECRET_KEY = /(api_?key|secret|password|credential|authorization|bearer|(^|_)token$)/i;

/** A copy of the config with every secret-looking leaf replaced; token COUNTS (`max_output_tokens`) are not secrets. */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) && child !== null && typeof child !== "object" ? "[redacted]" : redactConfig(child);
  }
  return out;
}

/** JSON with object keys sorted, so equal configs hash equally whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface EffectiveConfigRecord {
  /** Fully merged (defaults, scopes, env), secrets redacted. */
  readonly config: Record<string, unknown>;
  /** sha256 of `canonicalJson(config)`. */
  readonly sha256: string;
}

/** Resolve the config `arbor` would run with in `target` under `env`, exactly as the runtime resolves it. */
export function resolveEffectiveConfig(target: string, env: NodeJS.ProcessEnv): { readonly effective: ArborConfig; readonly record: EffectiveConfigRecord } {
  const { effective } = loadConfigWithProvenance(target, env);
  const config = redactConfig(effective) as Record<string, unknown>;
  return { effective, record: { config, sha256: createHash("sha256").update(canonicalJson(config)).digest("hex") } };
}

/** Every leaf of the preregistered native block that the effective config does not carry verbatim (model, max output tokens, turn/wall/cost caps, prices, ...). */
export function preregistrationMismatches(effective: ArborConfig, preregisteredNative: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const walk = (path: string, expected: unknown, actual: unknown): void => {
    if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
      for (const [key, child] of Object.entries(expected as Record<string, unknown>)) {
        walk(`${path}.${key}`, child, actual !== null && typeof actual === "object" ? (actual as Record<string, unknown>)[key] : undefined);
      }
      return;
    }
    if (canonicalJson(expected) !== canonicalJson(actual)) out.push(`${path}: preregistered ${canonicalJson(expected)}, effective ${canonicalJson(actual)}`);
  };
  walk("native", preregisteredNative, (effective as unknown as Record<string, unknown>).native);
  return out;
}

export function assertEffectiveMatchesPreregistration(effective: ArborConfig, preregisteredNative: Readonly<Record<string, unknown>>): void {
  const mismatches = preregistrationMismatches(effective, preregisteredNative);
  if (mismatches.length > 0) throw new Error(`effective arbor config differs from the preregistered native config:\n- ${mismatches.join("\n- ")}`);
}
