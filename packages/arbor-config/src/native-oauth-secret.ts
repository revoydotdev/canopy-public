/**
 * Native-lane credential sources that are not plain provider API keys.
 *
 * Claude/Codex CLI subscriber tokens are inspected for diagnostics but never
 * sent to unrelated provider HTTP APIs. OpenAI WIF is a separate direct API
 * source: it accepts an already exchanged bearer token and explicit expiry,
 * but does not read external subject-token files or perform token exchange.
 * No source here performs an interactive login or redeems a refresh token.
 *
 * Empirically verified against this machine's real CLI credential stores
 * (2026-08-24; values redacted below, structure real):
 *
 *  - `claude`: `~/.claude/.credentials.json` ->
 *    `{ claudeAiOauth: { accessToken, refreshToken, expiresAt (ms epoch),
 *    refreshTokenExpiresAt (ms epoch), scopes: [..., "user:inference", ...],
 *    subscriptionType, rateLimitTier } }`. Per the `claude-api` skill's
 *    Authentication reference, an OAuth access token is presented to the
 *    Messages API as `Authorization: Bearer <token>` plus the beta header
 *    `anthropic-beta: oauth-2025-04-20` -- never `x-api-key`. The observed
 *    Live differential probes on 2026-08-24 showed the important boundary:
 *    the same valid token receives a generic 429 from an ordinary Messages
 *    request and succeeds only when the system channel asserts Claude Code
 *    or Claude Agent SDK identity. Endpoint, beta, user-agent, tools, metadata,
 *    and conversation shape were independently eliminated as causes. Revoy's
 *    owned adapter is neither first-party client and must not impersonate one,
 *    so this subscriber source is reported but never injected. OpenAI API WIF
 *    is accepted only by a separate endpoint-bound source below.
 *
 *  - `codex`: `~/.codex/auth.json` -> `{ auth_mode, tokens: { id_token,
 *    access_token (JWT), refresh_token, account_id }, last_refresh }`. The
 *    access token's JWT payload carries `aud: ["https://api.openai.com/v1"]`
 *    but its `scp` claims are ChatGPT session scopes (`openid profile email
 *    offline_access api.connectors.read api.connectors.invoke`), not an
 *    inference grant. Static inspection of the installed `codex` CLI binary
 *    (0.149.0, `strings` over the vendored Rust binary) shows its
 *    authenticated requests target `https://chatgpt.com/backend-api/codex*`
 *    with a required `ChatGPT-Account-Id` header and a `codex_cli_rs`
 *    request originator -- a separate, undocumented backend contract, not
 *    the public OpenAI Chat Completions/Responses API our
 *    `openai-compatible` adapter calls. Presenting this token as a bearer
 *    credential against the public API would not authenticate. This module
 *    still resolves and reports the token's presence/expiry state (real,
 *    tested, and useful on its own -- e.g. for `doctor`), but that state is
 *    deliberately never wired into `openai-compatible.ts`'s request path.
 *    See the task report for the full boundary and its evidence.
 *
 *  - Refresh: `codex`'s binary strings show token refresh happens against
 *    `https://auth.openai.com/oauth/token`, and its own error copy
 *    ("Your access token could not be refreshed because your refresh token
 *    has expired/was already used/was revoked. Please log out and sign in
 *    again.") is the model for this module's expired-credential message.
 *    Redeeming a refresh token is a live network round trip this module
 *    does not perform; an expired token instead resolves to a legible typed
 *    `expired` result naming the CLI's own re-auth command
 *    (`claude login` / `codex login`).
 */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { NativeCredentialSourceId } from "./types.js";
import { loadNativeProviderSecretOverlay, type NativeCredentialMechanism, type NativeCredentialOverlay } from "./native-secret.js";

export type NativeOAuthCredentialAuthMechanism = "oauth_bearer";

export type NativeOAuthCredentialStatus =
  | { readonly state: "present"; readonly mechanism: NativeOAuthCredentialAuthMechanism; readonly expires_at: string; readonly scopes: readonly string[] }
  | { readonly state: "absent"; readonly reason: string }
  | { readonly state: "expired"; readonly reason: string; readonly expired_at: string; readonly refreshable?: boolean };

/**
 * Deliberately excludes `api_key`: that source already has its own overlay
 * shape (`NativeProviderSecretOverlay`) and callback contract in
 * `native-secret.ts`.
 */
export interface NativeOAuthCredentialOverlay extends NativeCredentialOverlay {
  readonly source: Extract<NativeCredentialSourceId, "claude_oauth" | "codex_oauth">;
  readonly mechanism: "oauth_bearer";
  /** Non-secret: the on-disk path read, safe to project into doctor/audit output. */
  readonly file_path: string;
  readonly status: NativeOAuthCredentialStatus;
  /**
   * Provides the secret only to an immediate composition callback; it is
   * never a field of the overlay, a log line, or a returned value. Returns
   * `undefined` whenever `status.state !== "present"`.
   */
  inject<T>(recipient: (secret: string, mechanism: NativeOAuthCredentialAuthMechanism) => T): T | undefined;
}

/** Pre-exchanged OpenAI API workload identity token. Refresh stays with the workload identity provider. */
export interface NativeOpenAIWifCredentialOverlay extends NativeCredentialOverlay {
  readonly source: "openai_wif";
  readonly mechanism: "oauth_bearer";
  readonly env_var: "OPENAI_WIF_ACCESS_TOKEN" | null;
  readonly expires_at: string | null;
  readonly status: NativeOAuthCredentialStatus;
}

export interface NativeOAuthClock {
  now(): Date;
}
export const systemNativeOAuthClock: NativeOAuthClock = { now: () => new Date() };

export interface NativeOAuthFileReader {
  (path: string): string;
}
export const defaultNativeOAuthFileReader: NativeOAuthFileReader = (path) => readFileSync(path, "utf8");

/** Override for tests/ops; unset means the CLI's real default location. */
export const CLAUDE_OAUTH_PATH_ENV = "ARBOR_NATIVE_CLAUDE_OAUTH_PATH";
/** Override for tests/ops; unset means the CLI's real default location. */
export const CODEX_OAUTH_PATH_ENV = "ARBOR_NATIVE_CODEX_OAUTH_PATH";
export const OPENAI_WIF_ACCESS_TOKEN_ENV = "OPENAI_WIF_ACCESS_TOKEN";
export const OPENROUTER_OAUTH_CREDENTIAL_PATH_ENV = "ARBOR_OPENROUTER_OAUTH_CREDENTIAL_PATH";
export const OPENAI_WIF_EXPIRES_AT_ENV = "OPENAI_WIF_EXPIRES_AT";

export function defaultClaudeOAuthCredentialPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[CLAUDE_OAUTH_PATH_ENV]?.trim() || join(homedir(), ".claude", ".credentials.json");
}

export function defaultCodexOAuthCredentialPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[CODEX_OAUTH_PATH_ENV]?.trim();
  return resolve(configured || join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json"));
}

export function defaultOpenRouterOAuthCredentialPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = resolve(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"));
  const configured = env[OPENROUTER_OAUTH_CREDENTIAL_PATH_ENV]?.trim();
  return resolve(configured || join(configHome, "arbor", "credentials", "openrouter.json"));
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("OpenRouter credential directory must be an owned, non-symlink directory");
  chmodSync(path, 0o700);
}

/** Persist only the OpenRouter-issued API key, atomically, in a user-private file. */
export function storeOpenRouterOAuthApiKey(key: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!key || key.trim() !== key || /[\r\n\0]/u.test(key) || Buffer.byteLength(key) > 4096) throw new Error("OpenRouter returned an invalid API key");
  const path = defaultOpenRouterOAuthCredentialPath(env);
  const directory = dirname(path);
  const override = env[OPENROUTER_OAUTH_CREDENTIAL_PATH_ENV]?.trim();
  if (override) {
    // Custom locations are caller-owned: never chmod or create their parent.
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("custom OpenRouter credential parent must already be an owned, private, non-symlink directory");
  } else {
    const configHome = resolve(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"));
    if (!existsSync(configHome)) mkdirSync(configHome, { recursive: true, mode: 0o700 });
    const configStat = lstatSync(configHome);
    if (!configStat.isDirectory() || configStat.isSymbolicLink() || (configStat.mode & 0o022) !== 0 || (typeof process.getuid === "function" && configStat.uid !== process.getuid())) throw new Error("XDG config home must be an owned, non-symlink directory without group or other write permission");
    const arborDirectory = join(configHome, "arbor");
    if (!existsSync(arborDirectory)) mkdirSync(arborDirectory, { mode: 0o700 });
    const arborStat = lstatSync(arborDirectory);
    if (!arborStat.isDirectory() || arborStat.isSymbolicLink() || (arborStat.mode & 0o022) !== 0 || (typeof process.getuid === "function" && arborStat.uid !== process.getuid())) throw new Error("managed Arbor credential parent must be an owned, non-symlink directory without group or other write permission");
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    assertPrivateDirectory(directory);
  }
  if (existsSync(path)) {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || (typeof process.getuid === "function" && existing.uid !== process.getuid())) throw new Error("OpenRouter credential file must be an owned, non-symlink regular file");
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ key }), { encoding: "utf8" }); } finally { closeSync(fd); }
  chmodSync(temp, 0o600);
  try { renameSync(temp, path); } catch (error) { try { unlinkSync(temp); } catch {} throw error; }
  return path;
}

function readOpenRouterOAuthApiKey(env: NodeJS.ProcessEnv): string | null {
  const path = defaultOpenRouterOAuthCredentialPath(env);
  try {
    const parent = lstatSync(dirname(path));
    const stat = lstatSync(path);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && (parent.uid !== process.getuid() || stat.uid !== process.getuid())) || stat.size > 8192) return null;
    const doc = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(doc) && typeof doc.key === "string" && doc.key.length > 0 && doc.key.trim() === doc.key ? doc.key : null;
  } catch { return null; }
}

export interface ResolveNativeOAuthCredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly reader?: NativeOAuthFileReader;
  readonly clock?: NativeOAuthClock;
}

export function resolveClaudeOAuthCredential(options: ResolveNativeOAuthCredentialOptions = {}): NativeOAuthCredentialOverlay {
  const env = options.env ?? process.env;
  const reader = options.reader ?? defaultNativeOAuthFileReader;
  const clock = options.clock ?? systemNativeOAuthClock;
  const filePath = defaultClaudeOAuthCredentialPath(env);
  const doc = readJsonFile(filePath, reader);
  const oauth = doc && isRecord(doc.claudeAiOauth) ? doc.claudeAiOauth : null;
  const accessToken = oauth && typeof oauth.accessToken === "string" && oauth.accessToken.length > 0 ? oauth.accessToken : null;
  const expiresAt = oauth && typeof oauth.expiresAt === "number" ? oauth.expiresAt : null;
  if (accessToken === null || expiresAt === null) {
    return overlay("claude_oauth", filePath, {
      state: "absent",
      reason: `no Claude OAuth token found at ${filePath}; run \`claude login\` to authenticate, or set native.credential_source to "api_key" and configure ANTHROPIC_API_KEY instead`,
    });
  }
  if (clock.now().getTime() >= expiresAt) {
    return overlay("claude_oauth", filePath, {
      state: "expired",
      reason: "Claude OAuth access token has expired; re-authenticate with `claude login`",
      expired_at: new Date(expiresAt).toISOString(),
    });
  }
  return overlay(
    "claude_oauth",
    filePath,
    { state: "present", mechanism: "oauth_bearer", expires_at: new Date(expiresAt).toISOString(), scopes: stringArray(oauth!.scopes) },
    accessToken,
  );
}

export function resolveCodexOAuthCredential(options: ResolveNativeOAuthCredentialOptions = {}): NativeOAuthCredentialOverlay {
  const env = options.env ?? process.env;
  const reader = options.reader ?? defaultNativeOAuthFileReader;
  const clock = options.clock ?? systemNativeOAuthClock;
  const filePath = defaultCodexOAuthCredentialPath(env);
  if (options.reader === undefined) {
    const safetyIssue = codexAuthStoreSafetyIssue(filePath);
    if (safetyIssue !== null) return overlay("codex_oauth", filePath, { state: "absent", reason: safetyIssue });
  }
  const doc = readJsonFile(filePath, reader);
  const tokens = doc && isRecord(doc.tokens) ? doc.tokens : null;
  const accessToken = tokens && typeof tokens.access_token === "string" && tokens.access_token.length > 0 ? tokens.access_token : null;
  if (accessToken === null) {
    return overlay("codex_oauth", filePath, {
      state: "absent",
      reason: `no Codex OAuth token found at ${filePath}; run \`codex login\` to authenticate, or set native.credential_source to "api_key" and configure OPENAI_API_KEY instead`,
    });
  }
  const payload = decodeJwtPayload(accessToken);
  const exp = payload && typeof payload.exp === "number" ? payload.exp : null;
  if (exp === null) {
    return overlay("codex_oauth", filePath, {
      state: "absent",
      reason: `Codex OAuth token at ${filePath} did not carry a readable expiry claim; re-authenticate with \`codex login\``,
    });
  }
  const expiresAtMs = exp * 1000;
  if (clock.now().getTime() >= expiresAtMs) {
    const refreshable = typeof tokens?.refresh_token === "string" && tokens.refresh_token.length > 0 && tokens.refresh_token.trim() === tokens.refresh_token;
    return overlay("codex_oauth", filePath, {
      state: "expired",
      reason: refreshable
        ? "Codex OAuth access token has expired; the first-party CLI can attempt refresh with its stored refresh token"
        : "Codex OAuth access token has expired and no refresh token is stored; re-authenticate with `codex login`",
      expired_at: new Date(expiresAtMs).toISOString(),
      refreshable,
    });
  }
  return overlay(
    "codex_oauth",
    filePath,
    { state: "present", mechanism: "oauth_bearer", expires_at: new Date(expiresAtMs).toISOString(), scopes: stringArray(payload!.scp) },
    accessToken,
  );
}

/** Refuse unsafe real Codex credential stores before projecting readiness or reading tokens. */
function codexAuthStoreSafetyIssue(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const homePath = dirname(filePath);
    const home = lstatSync(homePath);
    const auth = lstatSync(filePath);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!home.isDirectory() || home.isSymbolicLink() || (uid !== null && home.uid !== uid) || (home.mode & 0o022) !== 0 || (home.mode & 0o300) !== 0o300) {
      return `Codex CODEX_HOME at ${homePath} must be an owned, non-symlink directory without group or other write permission`;
    }
    if (!auth.isFile() || auth.isSymbolicLink() || (uid !== null && auth.uid !== uid) || (auth.mode & 0o777) !== 0o600) {
      return `Codex auth.json at ${filePath} must be an owned, non-symlink file with owner read/write and no group or other permissions`;
    }
    return null;
  } catch {
    return `Codex auth store at ${filePath} cannot be inspected safely`;
  }
}

export type NativeCredentialSourceSelection = NativeCredentialSourceId;

/** Non-secret facts about a resolved credential, safe for doctor/audit projection. */
export interface NativeHarnessCredentialFacts {
  readonly source: "env" | "absent" | "claude_oauth" | "codex_oauth" | "openrouter_oauth" | "openai_wif";
  readonly mechanism: NativeCredentialMechanism;
  readonly present: boolean;
  /** `unusable` covers a credential the composition root refuses to wire in, independent of the raw token's own presence/expiry (see `codex_oauth` below). */
  readonly state: "present" | "absent" | "expired" | "unusable";
  readonly env_var: string | null;
  readonly file_path: string | null;
}

/**
 * The composition root's single selection point across the two credential
 * shapes: `env` (`native-secret.ts`) and `claude_oauth`/`codex_oauth` (this
 * file). `overlay` is what the executor composition injects into the model
 * adapter; `facts` is what doctor/readiness project without ever touching
 * the secret; `boundary`, when present, means the selected source is
 * permanently unusable for inference regardless of the raw credential's own
 * state -- composition must fail closed with `boundary.reason`; it must
 * never attempt the call.
 */
export interface NativeCredentialSelection {
  readonly overlay: NativeCredentialOverlay;
  readonly facts: NativeHarnessCredentialFacts;
  readonly boundary?: { readonly reason: string };
}

export interface ResolveNativeCredentialSelectionOptions {
  readonly credential_source: NativeCredentialSourceSelection | undefined;
  readonly provider_id?: string;
  readonly adapter_id?: string;
  readonly base_url?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly reader?: NativeOAuthFileReader;
  readonly clock?: NativeOAuthClock;
}

/**
 * Selects and resolves the one credential overlay `native.credential_source`
 * names. Absent config means `api_key` -- the original, unchanged default
 * behavior. This is the only place the executor composition root needs to
 * call to get a credential, regardless of source.
 */
export function resolveNativeCredentialOverlay(options: ResolveNativeCredentialSelectionOptions): NativeCredentialSelection {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemNativeOAuthClock;
  const source = options.credential_source ?? "api_key";
  if (source === "api_key") {
    const apiKeyOverlay = loadNativeProviderSecretOverlay(env, options.provider_id);
    return Object.freeze({
      overlay: apiKeyOverlay,
      facts: Object.freeze({
        source: apiKeyOverlay.source, mechanism: apiKeyOverlay.mechanism, present: apiKeyOverlay.present,
        state: apiKeyOverlay.present ? "present" as const : "absent" as const,
        env_var: apiKeyOverlay.env_var, file_path: null,
      }),
    });
  }
  if (source === "claude_oauth") {
    const claudeOverlay = resolveClaudeOAuthCredential({ env, reader: options.reader, clock });
    const reason = "native.credential_source is \"claude_oauth\", but the Claude Code subscriber token is restricted to Claude Code/Claude Agent SDK traffic; Anthropic's direct Messages API accepts it only with a first-party identity assertion that Revoy's owned adapter cannot truthfully make. Set native.credential_source to \"api_key\" and configure ARBOR_NATIVE_API_KEY or ANTHROPIC_API_KEY, or use native.auth_route=claude_code_cli so the local CLI retains its own login. OpenAI API WIF is a separate credential and does not authorize Anthropic calls.";
    const neverInject: NativeOAuthCredentialOverlay["inject"] = () => undefined;
    return Object.freeze({
      overlay: Object.freeze({ ...claudeOverlay, present: false, inject: neverInject }),
      facts: Object.freeze({
        source: claudeOverlay.source, mechanism: claudeOverlay.mechanism, present: false,
        state: claudeOverlay.status.state === "present" ? "unusable" as const : claudeOverlay.status.state,
        env_var: null, file_path: claudeOverlay.file_path,
      }),
      boundary: Object.freeze({ reason }),
    });
  }
  if (source === "openrouter_oauth") {
    const token = readOpenRouterOAuthApiKey(env);
    let allowed = false;
    try { const url = new URL(options.base_url ?? ""); allowed = options.provider_id?.trim().toLowerCase() === "openrouter" && options.adapter_id === "openai-compatible" && url.protocol === "https:" && url.hostname === "openrouter.ai" && url.pathname.replace(/\/$/u, "") === "/api/v1" && !url.username && !url.password && !url.search && !url.hash; } catch {}
    const valid = token !== null && allowed;
    const filePath = defaultOpenRouterOAuthCredentialPath(env);
    const overlay: NativeCredentialOverlay = Object.freeze({ source: "openrouter_oauth", mechanism: "api_key", present: valid, inject<T>(recipient: (secret: string, mechanism: NativeCredentialMechanism) => T) { return valid ? recipient(token!, "api_key") : undefined; } });
    return Object.freeze({ overlay, facts: Object.freeze({ source: "openrouter_oauth" as const, mechanism: "api_key" as const, present: valid, state: valid ? "present" as const : token === null ? "absent" as const : "unusable" as const, env_var: null, file_path: filePath }), ...(!allowed ? { boundary: Object.freeze({ reason: 'native.credential_source "openrouter_oauth" requires provider_id "openrouter", adapter_id "openai-compatible", and https://openrouter.ai/api/v1.' }) } : {}) });
  }
  if (source === "openai_wif") {
    const token = env[OPENAI_WIF_ACCESS_TOKEN_ENV];
    const rawExpiry = env[OPENAI_WIF_EXPIRES_AT_ENV];
    const expirySeconds = rawExpiry !== undefined && /^\d+$/.test(rawExpiry) ? Number(rawExpiry) : Number.NaN;
    const expiryMs = Number.isSafeInteger(expirySeconds) && expirySeconds > 0 && expirySeconds <= 8_640_000_000_000 ? expirySeconds * 1000 : Number.NaN;
    const status: NativeOAuthCredentialStatus = typeof token !== "string" || token.length === 0 || token.trim() !== token || !Number.isFinite(expiryMs)
      ? { state: "absent", reason: `OpenAI WIF requires ${OPENAI_WIF_ACCESS_TOKEN_ENV} and ${OPENAI_WIF_EXPIRES_AT_ENV} (Unix seconds); supply an already exchanged API access token` }
      : clock.now().getTime() >= expiryMs
        ? { state: "expired", reason: "OpenAI WIF access token has expired; obtain a new token from the configured workload identity provider", expired_at: new Date(expiryMs).toISOString() }
        : { state: "present", mechanism: "oauth_bearer", expires_at: new Date(expiryMs).toISOString(), scopes: [] };
    let openAiOrigin = false;
    try {
      const url = new URL(options.base_url ?? "");
      openAiOrigin = url.protocol === "https:" && url.hostname === "api.openai.com" && url.port === "" &&
        url.username === "" && url.password === "" && url.search === "" && url.hash === "" && url.pathname.replace(/\/$/, "") === "/v1";
    } catch { /* missing or malformed endpoint is a credential boundary */ }
    const isOpenAI = options.provider_id?.trim().toLowerCase() === "openai" && options.adapter_id === "openai-compatible" && openAiOrigin;
    const routeAllowed = isOpenAI;
    const currentlyValid = () => routeAllowed && status.state === "present" && token !== undefined && token.length > 0 && clock.now().getTime() < expiryMs;
    const overlay: NativeOpenAIWifCredentialOverlay = Object.freeze({
      source: "openai_wif", mechanism: "oauth_bearer", env_var: token ? OPENAI_WIF_ACCESS_TOKEN_ENV : null,
      expires_at: status.state === "present" ? status.expires_at : null,
      get status() {
        if (status.state === "present" && clock.now().getTime() >= expiryMs) {
          return { state: "expired" as const, reason: "OpenAI WIF access token has expired; obtain a new token from the configured workload identity provider", expired_at: status.expires_at };
        }
        return status;
      },
      get present() { return currentlyValid(); },
      inject<T>(recipient: (secret: string, mechanism: NativeOAuthCredentialAuthMechanism) => T): T | undefined {
        if (!currentlyValid()) return undefined;
        return recipient(token!, "oauth_bearer");
      },
    });
    const facts: NativeHarnessCredentialFacts = Object.freeze({
      source: "openai_wif", mechanism: "oauth_bearer",
      get present() { return overlay.present; },
      get state() { return status.state === "present" ? routeAllowed ? overlay.present ? "present" : "expired" : "unusable" : status.state; },
      env_var: overlay.env_var, file_path: null,
    });
    return Object.freeze({
      overlay,
      facts,
      ...(!isOpenAI ? { boundary: Object.freeze({ reason: 'native.credential_source "openai_wif" requires provider_id "openai", adapter_id "openai-compatible", and the exact HTTPS endpoint https://api.openai.com/v1; use the provider API key source for other routes.' }) } : {}),
    });
  }
  // codex_oauth: still resolved and reported truthfully (real, tested, and
  // useful on its own for doctor -- see this module's header comment) but
  // never wired into an adapter's request path. No shipped adapter can
  // authenticate with the Codex CLI's subscriber token: it is scoped to
  // ChatGPT's private backend-api contract, not the public OpenAI API the
  // `openai-compatible` adapter calls. This is a fixed property of the
  // source, not a function of which adapter happens to be configured, so
  // the boundary applies unconditionally whenever codex_oauth is selected --
  // fail closed with a typed, legible reason instead of ever attempting the
  // call and surfacing a silent 401.
  const codexOverlay = resolveCodexOAuthCredential({ env, reader: options.reader, clock });
  const reason = "native.credential_source is \"codex_oauth\", but no shipped native adapter can use a Codex CLI subscriber token: it authenticates ChatGPT's private backend-api contract, not the public OpenAI API the \"openai-compatible\" adapter calls. Set native.credential_source to \"api_key\" and configure ARBOR_NATIVE_API_KEY or OPENAI_API_KEY.";
  const neverInject: NativeOAuthCredentialOverlay["inject"] = () => undefined;
  return Object.freeze({
    overlay: Object.freeze({ ...codexOverlay, present: false, inject: neverInject }),
    facts: Object.freeze({
      source: codexOverlay.source, mechanism: codexOverlay.mechanism, present: false,
      state: codexOverlay.status.state === "present" ? "unusable" as const : codexOverlay.status.state,
      env_var: null, file_path: codexOverlay.file_path,
    }),
    boundary: Object.freeze({ reason }),
  });
}

function overlay(
  source: "claude_oauth" | "codex_oauth",
  filePath: string,
  status: NativeOAuthCredentialStatus,
  secret?: string,
): NativeOAuthCredentialOverlay {
  return Object.freeze({
    source,
    mechanism: "oauth_bearer" as const,
    present: status.state === "present",
    file_path: filePath,
    status,
    inject<T>(recipient: (secret: string, mechanism: NativeOAuthCredentialAuthMechanism) => T): T | undefined {
      if (status.state !== "present" || secret === undefined) return undefined;
      return recipient(secret, status.mechanism);
    },
  });
}

function readJsonFile(path: string, reader: NativeOAuthFileReader): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = reader(path);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Decodes (never cryptographically verifies) a JWT payload to read its own
 * claims. This module trusts the file it just read from an operator-owned
 * local path -- it is not a security boundary and must never be used to
 * authorize anything on its own.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const segment = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): readonly string[] {
  return Object.freeze(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
