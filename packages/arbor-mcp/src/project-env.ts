import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePersistenceDir } from "./persistence-path.js";

const MAX_ENV_BYTES = 1_048_576;
const MAX_VALUE_BYTES = 32_768;
const PROVIDER_KEYS = new Set([
  "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "HF_TOKEN", "HUGGINGFACE_API_KEY",
  "GROQ_API_KEY", "MISTRAL_API_KEY", "TOGETHER_API_KEY", "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
]);

export interface ProjectEnvLoadResult {
  readonly path: string;
  readonly present: boolean;
  readonly loaded_names: readonly string[];
}

function allowedName(name: string): boolean {
  return name.startsWith("ARBOR_") || PROVIDER_KEYS.has(name);
}

function decodeValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) return trimmed.slice(1, -1);
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\([\\"nrt])/g, (_match, escaped: string) => escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped);
  }
  return trimmed.replace(/\s+#.*$/, "").trimEnd();
}

/**
 * Loads the documented project-local `.env` boundary for direct CLI use.
 * Only Arbor-owned variables and documented provider credentials are
 * accepted; ambient process variables always win. Names, never values, are
 * returned for diagnostics.
 *
 * The contained path wins, and a pre-existing repo-root `.env` is still honoured: `setup` now
 * writes the template inside the persistence root, so preferring the contained file alone would
 * silently stop loading an operator's existing real key in favour of the empty template. The
 * returned `path` names whichever file was used, so the fallback is observable, not silent.
 */
export function loadProjectEnvironment(cwd: string, target: NodeJS.ProcessEnv = process.env, persistenceDir: string = resolvePersistenceDir(cwd)): ProjectEnvLoadResult {
  const contained = join(persistenceDir, ".env");
  const legacy = join(cwd, ".env");
  const path = existsSync(contained) || !existsSync(legacy) ? contained : legacy;
  let stat;
  try { stat = lstatSync(path); }
  catch { return Object.freeze({ path, present: false, loaded_names: Object.freeze([]) }); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Project environment must be a regular non-symlink file: ${path}`);
  if (stat.size > MAX_ENV_BYTES) throw new Error(`Project environment exceeds ${MAX_ENV_BYTES} bytes: ${path}`);

  return Object.freeze({ path, present: true, loaded_names: Object.freeze(loadEnvLines(readFileSync(path, "utf8"), target).sort()) });
}

/** Apply allowlisted, not-yet-set assignments from env-file text; returns the names loaded. An empty value is a placeholder, not a credential. */
function loadEnvLines(text: string, target: NodeJS.ProcessEnv): string[] {
  const loaded: string[] = [];
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=([\s\S]*)$/.exec(line);
    if (match === null) continue;
    const name = match[1]!;
    if (!allowedName(name) || (target[name] !== undefined && target[name] !== "")) continue;
    const value = decodeValue(match[2]!);
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error(`Environment value ${name} exceeds ${MAX_VALUE_BYTES} bytes`);
    if (value === "") continue;
    target[name] = value;
    loaded.push(name);
  }
  return loaded;
}

/**
 * The user-scope credential file: `$XDG_CONFIG_HOME/revoy/revoy.env`, or
 * `~/.config/revoy/revoy.env`. Same allowlist and parser as the project
 * `.env`, loaded AFTER it, so precedence is process environment, then the
 * project, then the user. This is where one operator keeps the provider keys
 * every project on the box may use, instead of copying them into each
 * checkout's `.env` — which is how every provider variable in this
 * repository's `.env` came to be an empty placeholder while a real
 * OPENROUTER_API_KEY sat in the user file unread.
 */
export function userEnvironmentPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "revoy", "revoy.env");
}

export function loadUserEnvironment(target: NodeJS.ProcessEnv = process.env): ProjectEnvLoadResult {
  const path = userEnvironmentPath(target);
  let stat;
  try { stat = lstatSync(path); }
  catch { return Object.freeze({ path, present: false, loaded_names: Object.freeze([]) }); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`User environment must be a regular non-symlink file: ${path}`);
  if (stat.size > MAX_ENV_BYTES) throw new Error(`User environment exceeds ${MAX_ENV_BYTES} bytes: ${path}`);
  return Object.freeze({ path, present: true, loaded_names: Object.freeze(loadEnvLines(readFileSync(path, "utf8"), target).sort()) });
}
