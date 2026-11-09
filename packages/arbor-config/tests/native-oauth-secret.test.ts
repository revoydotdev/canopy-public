import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  resolveClaudeOAuthCredential,
  resolveCodexOAuthCredential,
  resolveNativeCredentialOverlay,
  defaultClaudeOAuthCredentialPath,
  defaultCodexOAuthCredentialPath,
  storeOpenRouterOAuthApiKey,
  OPENROUTER_OAUTH_CREDENTIAL_PATH_ENV,
  CLAUDE_OAUTH_PATH_ENV,
  CODEX_OAUTH_PATH_ENV,
  OPENAI_WIF_ACCESS_TOKEN_ENV,
  OPENAI_WIF_EXPIRES_AT_ENV,
  type NativeOAuthFileReader,
} from "../src/native-oauth-secret.js";
import { validateConfig, DEFAULT_CONFIG, loadConfigEnvOverrides, loadConfigFromString } from "../src/index.js";

// Fixture tokens: fake shapes only, never a real credential value.
const FAKE_CLAUDE_TOKEN = "sk-ant-fixture-not-a-real-token";
const FAKE_CLAUDE_REFRESH = "sk-ant-fixture-refresh-not-real";

function claudeFixture(expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: FAKE_CLAUDE_TOKEN,
      refreshToken: FAKE_CLAUDE_REFRESH,
      expiresAt,
      refreshTokenExpiresAt: expiresAt + 1_000_000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default_max",
    },
  });
}

/** A minimal unsigned-shape JWT with only the claims this module reads. exp is seconds since epoch. */
function fakeJwtPayload(payload: unknown): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = b64url({ alg: "RS256", typ: "JWT" });
  return `${header}.${b64url(payload)}.fixture-signature-not-real`;
}

function fakeJwt(exp: number, scopes: unknown = ["openid", "profile", "api.connectors.read"]): string {
  return fakeJwtPayload({ aud: ["https://api.openai.com/v1"], exp, scp: scopes });
}

function codexFixture(exp: number, scopes?: unknown): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt(exp, scopes),
      access_token: fakeJwt(exp, scopes),
      refresh_token: "rt.1.fixture-not-real",
      account_id: "fixture-account-id",
    },
    last_refresh: new Date(0).toISOString(),
  });
}

function readerFor(files: Record<string, string>): NativeOAuthFileReader {
  return (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT: fixture has no file at ${path}`);
    return content;
  };
}

describe("resolveClaudeOAuthCredential", () => {
  it("reports absent when the credential file does not exist", () => {
    const overlay = resolveClaudeOAuthCredential({ env: {}, reader: readerFor({}) });
    expect(overlay.source).toBe("claude_oauth");
    expect(overlay.status.state).toBe("absent");
    if (overlay.status.state === "absent") expect(overlay.status.reason).toContain("claude login");
    expect(overlay.inject((secret) => secret)).toBeUndefined();
  });

  it("uses the default file reader only for the configured local path and fails closed when it is absent", () => {
    const path = "/fixture/.claude/missing-credentials.json";
    const overlay = resolveClaudeOAuthCredential({ env: { [CLAUDE_OAUTH_PATH_ENV]: path } });
    expect(overlay).toMatchObject({ file_path: path, status: { state: "absent" } });
  });

  it("uses the process environment only to choose a Claude path when no env overlay is supplied", () => {
    expect(resolveClaudeOAuthCredential({ reader: readerFor({}) }).status.state).toBe("absent");
  });

  it("reports absent when the file is malformed JSON", () => {
    const path = "/fixture/.claude/.credentials.json";
    const overlay = resolveClaudeOAuthCredential({ env: { [CLAUDE_OAUTH_PATH_ENV]: path }, reader: readerFor({ [path]: "not json" }) });
    expect(overlay.status.state).toBe("absent");
  });

  it("fails closed for structurally incomplete Claude credential documents", () => {
    const path = "/fixture/.claude/.credentials.json";
    for (const doc of [
      "null",
      JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: Date.now() + 3_600_000 } }),
      JSON.stringify({ claudeAiOauth: { accessToken: FAKE_CLAUDE_TOKEN, expiresAt: "tomorrow" } }),
    ]) {
      expect(resolveClaudeOAuthCredential({ env: { [CLAUDE_OAUTH_PATH_ENV]: path }, reader: readerFor({ [path]: doc }) }).status.state).toBe("absent");
    }
  });

  it("resolves a present, unexpired token to the oauth_bearer mechanism", () => {
    const path = "/fixture/.claude/.credentials.json";
    const future = Date.now() + 3_600_000;
    const overlay = resolveClaudeOAuthCredential({
      env: { [CLAUDE_OAUTH_PATH_ENV]: path },
      reader: readerFor({ [path]: claudeFixture(future) }),
    });
    expect(overlay.status.state).toBe("present");
    if (overlay.status.state === "present") {
      expect(overlay.status.mechanism).toBe("oauth_bearer");
      expect(overlay.status.scopes).toContain("user:inference");
    }
    const injected = overlay.inject((secret, mechanism) => ({ secret, mechanism }));
    expect(injected).toEqual({ secret: FAKE_CLAUDE_TOKEN, mechanism: "oauth_bearer" });
  });

  it("detects an expired token as a typed expired result, not a crash", () => {
    const path = "/fixture/.claude/.credentials.json";
    const past = Date.now() - 1_000;
    const overlay = resolveClaudeOAuthCredential({
      env: { [CLAUDE_OAUTH_PATH_ENV]: path },
      reader: readerFor({ [path]: claudeFixture(past) }),
    });
    expect(overlay.status.state).toBe("expired");
    if (overlay.status.state === "expired") expect(overlay.status.reason).toContain("claude login");
    expect(overlay.inject((secret) => secret)).toBeUndefined();
  });

  it("defaults to ~/.claude/.credentials.json when no path override is set", () => {
    const path = defaultClaudeOAuthCredentialPath({});
    expect(path).toBe(join(homedir(), ".claude", ".credentials.json"));
  });
});

describe("resolveCodexOAuthCredential", () => {
  it("reports absent when the credential file does not exist", () => {
    const overlay = resolveCodexOAuthCredential({ env: {}, reader: readerFor({}) });
    expect(overlay.source).toBe("codex_oauth");
    expect(overlay.status.state).toBe("absent");
    if (overlay.status.state === "absent") expect(overlay.status.reason).toContain("codex login");
  });

  it("resolves a present, unexpired token from its JWT exp claim", () => {
    const path = "/fixture/.codex/auth.json";
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 3600;
    const overlay = resolveCodexOAuthCredential({
      env: { [CODEX_OAUTH_PATH_ENV]: path },
      reader: readerFor({ [path]: codexFixture(futureExpSeconds) }),
    });
    expect(overlay.status.state).toBe("present");
    const injected = overlay.inject((secret, mechanism) => ({ secret, mechanism }));
    expect(injected?.mechanism).toBe("oauth_bearer");
    expect(injected?.secret).toContain("."); // JWT shape, three dot-separated segments
  });

  it("detects an expired token from an expired JWT exp claim", () => {
    const path = "/fixture/.codex/auth.json";
    const pastExpSeconds = Math.floor(Date.now() / 1000) - 3600;
    const overlay = resolveCodexOAuthCredential({
      env: { [CODEX_OAUTH_PATH_ENV]: path },
      reader: readerFor({ [path]: codexFixture(pastExpSeconds) }),
    });
    expect(overlay.status.state).toBe("expired");
    if (overlay.status.state === "expired") {
      expect(overlay.status.refreshable).toBe(true);
      expect(overlay.status.reason).toContain("attempt refresh");
    }
    const doc = JSON.parse(codexFixture(pastExpSeconds)) as { tokens: Record<string, unknown> };
    delete doc.tokens.refresh_token;
    const noRefresh = resolveCodexOAuthCredential({ env: { [CODEX_OAUTH_PATH_ENV]: path }, reader: readerFor({ [path]: JSON.stringify(doc) }) });
    expect(noRefresh.status).toMatchObject({ state: "expired", refreshable: false, reason: expect.stringContaining("no refresh token") });
  });

  it("projects unsafe on-disk Codex auth modes as unavailable before readiness can select them", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-codex-auth-readiness-"));
    const home = join(root, "codex-home");
    const path = join(home, "auth.json");
    try {
      mkdirSync(home, { mode: 0o700 });
      writeFileSync(path, codexFixture(Math.floor(Date.now() / 1000) + 3600), { mode: 0o600 });
      chmodSync(path, 0o644);
      expect(resolveCodexOAuthCredential({ env: { [CODEX_OAUTH_PATH_ENV]: path } }).status)
        .toMatchObject({ state: "absent", reason: expect.stringContaining("auth.json") });
      chmodSync(path, 0o600);
      chmodSync(home, 0o777);
      expect(resolveCodexOAuthCredential({ env: { [CODEX_OAUTH_PATH_ENV]: path } }).status)
        .toMatchObject({ state: "absent", reason: expect.stringContaining("CODEX_HOME") });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports an opaque Codex access token as absent rather than assuming an expiry", () => {
    const path = "/fixture/.codex/auth.json";
    const fixture = JSON.parse(codexFixture(Math.floor(Date.now() / 1000) + 3600));
    fixture.tokens.access_token = "opaque-not-a-jwt";
    const overlay = resolveCodexOAuthCredential({
      env: { [CODEX_OAUTH_PATH_ENV]: path },
      reader: readerFor({ [path]: JSON.stringify(fixture) }),
    });
    expect(overlay.status).toMatchObject({ state: "absent", reason: expect.stringContaining("readable expiry claim") });
    expect(overlay.inject((secret) => secret)).toBeUndefined();
  });

  it("fails closed when a three-part Codex token cannot decode or has no numeric expiry", () => {
    const path = "/fixture/.codex/auth.json";
    for (const accessToken of ["header.not-json.signature", fakeJwtPayload({ scp: [] }), fakeJwtPayload(null)]) {
      const fixture = JSON.parse(codexFixture(Math.floor(Date.now() / 1000) + 3600));
      fixture.tokens.access_token = accessToken;
      expect(resolveCodexOAuthCredential({ env: { [CODEX_OAUTH_PATH_ENV]: path }, reader: readerFor({ [path]: JSON.stringify(fixture) }) }).status)
        .toMatchObject({ state: "absent", reason: expect.stringContaining("readable expiry claim") });
    }
  });

  it("keeps only string scope claims when a valid Codex token carries mixed values", () => {
    const path = "/fixture/.codex/auth.json";
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 3600;
    const overlay = resolveCodexOAuthCredential({
      env: { [CODEX_OAUTH_PATH_ENV]: path },
      reader: readerFor({ [path]: codexFixture(futureExpSeconds, ["openid", 17, null, "api.connectors.read"]) }),
    });
    expect(overlay.status).toMatchObject({ state: "present", scopes: ["openid", "api.connectors.read"] });
  });

  it("normalizes a non-array Codex scope claim to an empty public scope list", () => {
    const path = "/fixture/.codex/auth.json";
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 3600;
    const overlay = resolveCodexOAuthCredential({
      env: { [CODEX_OAUTH_PATH_ENV]: path },
      reader: readerFor({ [path]: codexFixture(futureExpSeconds, "openid") }),
    });
    expect(overlay.status).toMatchObject({ state: "present", scopes: [] });
  });

  it("uses the default Codex file reader only for the configured local path and fails closed when it is absent", () => {
    const path = "/fixture/.codex/missing-auth.json";
    const overlay = resolveCodexOAuthCredential({ env: { [CODEX_OAUTH_PATH_ENV]: path } });
    expect(overlay).toMatchObject({ file_path: path, status: { state: "absent" } });
  });

  it("uses the process environment only to choose a Codex path when no env overlay is supplied", () => {
    expect(resolveCodexOAuthCredential({ reader: readerFor({}) }).status.state).toBe("absent");
  });

  it("defaults to ~/.codex/auth.json when no path override is set", () => {
    const path = defaultCodexOAuthCredentialPath({});
    expect(path).toBe(join(homedir(), ".codex", "auth.json"));
  });

  it("normalizes relative Codex auth paths before they cross the CLI cwd boundary", () => {
    const cwd = process.cwd();
    expect(defaultCodexOAuthCredentialPath({ CODEX_HOME: "relative-codex-home" }))
      .toBe(resolve(cwd, "relative-codex-home", "auth.json"));
    expect(defaultCodexOAuthCredentialPath({ [CODEX_OAUTH_PATH_ENV]: "relative-auth.json" }))
      .toBe(resolve(cwd, "relative-auth.json"));
  });
});

describe("native.credential_source config selection", () => {
  it("defaults to undefined (api_key behavior) when not configured", () => {
    expect(DEFAULT_CONFIG.native.credential_source).toBeUndefined();
  });

  it("resolves an OpenRouter PKCE key only through the private callback-scoped API credential overlay", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-openrouter-oauth-test-"));
    try {
      const credentialPath = join(root, "private", "openrouter.json");
      mkdirSync(join(root, "private"), { mode: 0o700 });
      const env = { [OPENROUTER_OAUTH_CREDENTIAL_PATH_ENV]: credentialPath };
      storeOpenRouterOAuthApiKey("fixture-openrouter-key", env);
      expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
      expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
      const selection = resolveNativeCredentialOverlay({ credential_source: "openrouter_oauth", provider_id: "openrouter", adapter_id: "openai-compatible", base_url: "https://openrouter.ai/api/v1", env });
      expect(selection.facts).toMatchObject({ source: "openrouter_oauth", mechanism: "api_key", present: true, state: "present", file_path: credentialPath });
      let provided: string | undefined;
      selection.overlay.inject((secret) => { provided = secret; });
      expect(provided).toBe("fixture-openrouter-key");
      const wrongEndpoint = resolveNativeCredentialOverlay({ credential_source: "openrouter_oauth", provider_id: "openrouter", adapter_id: "openai-compatible", base_url: "https://api.openai.com/v1", env });
      expect(wrongEndpoint.boundary).toBeDefined();
      expect(wrongEndpoint.overlay.inject(() => true)).toBeUndefined();
      const unsafeParent = join(root, "custom-parent");
      mkdirSync(unsafeParent, { mode: 0o755 });
      chmodSync(unsafeParent, 0o755);
      expect(() => storeOpenRouterOAuthApiKey("fixture-key", { [OPENROUTER_OAUTH_CREDENTIAL_PATH_ENV]: join(unsafeParent, "key.json") })).toThrow("custom OpenRouter credential parent");
      expect(statSync(unsafeParent).mode & 0o777).toBe(0o755);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("stores OpenRouter PKCE keys privately and resolves them only for the provider endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-openrouter-oauth-test-"));
    try {
      const privateParent = join(root, "private");
      mkdirSync(privateParent, { mode: 0o700 });
      const credentialPath = join(privateParent, "openrouter.json");
      const env = { [OPENROUTER_OAUTH_CREDENTIAL_PATH_ENV]: credentialPath };
      storeOpenRouterOAuthApiKey("fixture-openrouter-key", env);
      expect(statSync(privateParent).mode & 0o777).toBe(0o700);
      expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
      const selection = resolveNativeCredentialOverlay({ credential_source: "openrouter_oauth", provider_id: "openrouter", adapter_id: "openai-compatible", base_url: "https://openrouter.ai/api/v1", env });
      expect(selection.facts).toMatchObject({ source: "openrouter_oauth", mechanism: "api_key", present: true, state: "present", file_path: credentialPath });
      let provided: string | undefined;
      selection.overlay.inject((secret) => { provided = secret; });
      expect(provided).toBe("fixture-openrouter-key");
      const wrongEndpoint = resolveNativeCredentialOverlay({ credential_source: "openrouter_oauth", provider_id: "openrouter", adapter_id: "openai-compatible", base_url: "https://api.openai.com/v1", env });
      expect(wrongEndpoint.boundary).toBeDefined();
      expect(wrongEndpoint.overlay.inject(() => true)).toBeUndefined();
      const unsafeParent = join(root, "unsafe");
      mkdirSync(unsafeParent, { mode: 0o755 });
      chmodSync(unsafeParent, 0o755);
      expect(() => storeOpenRouterOAuthApiKey("fixture-key", { [OPENROUTER_OAUTH_CREDENTIAL_PATH_ENV]: join(unsafeParent, "key.json") })).toThrow("custom OpenRouter credential parent");
      expect(statSync(unsafeParent).mode & 0o777).toBe(0o755);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("bootstraps missing default XDG credential directories without changing an existing XDG parent", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-openrouter-xdg-test-"));
    try {
      const configHome = join(root, "not-created-yet", "config");
      const env = { XDG_CONFIG_HOME: configHome };
      const credentialPath = join(configHome, "arbor", "credentials", "openrouter.json");
      storeOpenRouterOAuthApiKey("fixture-openrouter-key", env);
      expect(statSync(configHome).mode & 0o777).toBe(0o700);
      expect(statSync(join(configHome, "arbor")).mode & 0o777).toBe(0o700);
      expect(statSync(dirname(credentialPath)).mode & 0o777).toBe(0o700);
      expect(statSync(credentialPath).mode & 0o777).toBe(0o600);

      const existingConfigHome = join(root, "existing-config");
      mkdirSync(existingConfigHome, { mode: 0o755 });
      chmodSync(existingConfigHome, 0o755);
      storeOpenRouterOAuthApiKey("fixture-openrouter-key", { XDG_CONFIG_HOME: existingConfigHome });
      expect(statSync(existingConfigHome).mode & 0o777).toBe(0o755);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses group- or other-writable XDG and Arbor parents without changing their modes", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-openrouter-parent-mode-test-"));
    try {
      const unsafeConfigHome = join(root, "unsafe-config");
      mkdirSync(unsafeConfigHome, { mode: 0o775 });
      chmodSync(unsafeConfigHome, 0o775);
      expect(() => storeOpenRouterOAuthApiKey("fixture-key", { XDG_CONFIG_HOME: unsafeConfigHome }))
        .toThrow("XDG config home must be an owned, non-symlink directory without group or other write permission");
      expect(statSync(unsafeConfigHome).mode & 0o777).toBe(0o775);

      const safeConfigHome = join(root, "safe-config");
      const unsafeArborDirectory = join(safeConfigHome, "arbor");
      mkdirSync(unsafeArborDirectory, { recursive: true, mode: 0o700 });
      chmodSync(safeConfigHome, 0o700);
      chmodSync(unsafeArborDirectory, 0o775);
      expect(() => storeOpenRouterOAuthApiKey("fixture-key", { XDG_CONFIG_HOME: safeConfigHome }))
        .toThrow("managed Arbor credential parent must be an owned, non-symlink directory without group or other write permission");
      expect(statSync(unsafeArborDirectory).mode & 0o777).toBe(0o775);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts claude_oauth and codex_oauth as valid selections", () => {
    for (const source of ["api_key", "claude_oauth", "codex_oauth", "openrouter_oauth", "openai_wif"] as const) {
      const config = loadConfigFromString(JSON.stringify({ native: { ...DEFAULT_CONFIG.native, credential_source: source } }));
      const result = validateConfig(config);
      expect(result.errors.filter((e) => e.includes("credential_source"))).toEqual([]);
    }
  });

  it("rejects an unrecognized credential_source value", () => {
    const config = { ...DEFAULT_CONFIG, native: { ...DEFAULT_CONFIG.native, credential_source: "bogus" as never } };
    const result = validateConfig(config);
    expect(result.errors.some((e) => e.includes("native.credential_source"))).toBe(true);
  });

  it("is overridable via ARBOR_CONFIG__NATIVE__CREDENTIAL_SOURCE per ADR-020", () => {
    const { overlay, applied } = loadConfigEnvOverrides({ ARBOR_CONFIG__NATIVE__CREDENTIAL_SOURCE: "claude_oauth" });
    expect(applied).toEqual([{ path: "native.credential_source", env_var: "ARBOR_CONFIG__NATIVE__CREDENTIAL_SOURCE" }]);
    expect((overlay as { native?: { credential_source?: string } }).native?.credential_source).toBe("claude_oauth");
  });
});

describe("resolveNativeCredentialOverlay (the composition root's single credential-selection seam)", () => {
  it("defaults to the unchanged api_key overlay when credential_source is undefined", () => {
    const selection = resolveNativeCredentialOverlay({ credential_source: undefined, provider_id: "anthropic", env: { ANTHROPIC_API_KEY: "sk-ant-fixture" } });
    expect(selection.boundary).toBeUndefined();
    expect(selection.facts).toEqual({ source: "env", mechanism: "api_key", present: true, state: "present", env_var: "ANTHROPIC_API_KEY", file_path: null });
    expect(selection.overlay.inject((secret, mechanism) => ({ secret, mechanism }))).toEqual({ secret: "sk-ant-fixture", mechanism: "api_key" });
  });

  it("api_key selection is absent, byte-identical to the pre-existing behavior, when no env candidate is set", () => {
    const selection = resolveNativeCredentialOverlay({ credential_source: "api_key", provider_id: "anthropic", env: {} });
    expect(selection.facts).toEqual({ source: "absent", mechanism: "api_key", present: false, state: "absent", env_var: null, file_path: null });
    expect(selection.overlay.inject((secret) => secret)).toBeUndefined();
  });

  it("reports claude_oauth as an unusable subscriber boundary and never injects it", () => {
    const path = "/fixture/.claude/.credentials.json";
    const future = Date.now() + 3_600_000;
    const selection = resolveNativeCredentialOverlay({
      credential_source: "claude_oauth",
      env: { [CLAUDE_OAUTH_PATH_ENV]: path },
      reader: readerFor({ [path]: claudeFixture(future) }),
    });
    expect(selection.boundary?.reason).toContain("Claude Agent SDK");
    expect(selection.boundary?.reason).toContain("api_key");
    expect(selection.facts).toEqual({ source: "claude_oauth", mechanism: "oauth_bearer", present: false, state: "unusable", env_var: null, file_path: path });
    expect(selection.overlay.inject((secret) => secret)).toBeUndefined();
  });

  it("reports an expired claude_oauth token as a typed expired state, never an inject", () => {
    const path = "/fixture/.claude/.credentials.json";
    const past = Date.now() - 1_000;
    const selection = resolveNativeCredentialOverlay({
      credential_source: "claude_oauth",
      env: { [CLAUDE_OAUTH_PATH_ENV]: path },
      reader: readerFor({ [path]: claudeFixture(past) }),
    });
    expect(selection.boundary).toBeDefined();
    expect(selection.facts).toMatchObject({ source: "claude_oauth", mechanism: "oauth_bearer", present: false, state: "expired" });
    expect(selection.overlay.inject((secret) => secret)).toBeUndefined();
  });

  it("codex_oauth is always a typed unusable boundary, independent of the raw token's own presence -- never a silent 401", () => {
    const path = "/fixture/.codex/auth.json";
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 3600;
    const selection = resolveNativeCredentialOverlay({
      credential_source: "codex_oauth",
      env: { [CODEX_OAUTH_PATH_ENV]: path },
      reader: readerFor({ [path]: codexFixture(futureExpSeconds) }),
    });
    expect(selection.boundary).toBeDefined();
    expect(selection.boundary?.reason).toContain("openai-compatible");
    expect(selection.boundary?.reason).toContain("codex_oauth");
    // The raw token is genuinely present (real, tested, useful for doctor)
    // but the composition-facing facts and overlay must both refuse to use it.
    expect(selection.facts).toMatchObject({ source: "codex_oauth", mechanism: "oauth_bearer", present: false, state: "unusable" });
    expect(selection.overlay.inject((secret) => secret)).toBeUndefined();
  });

  it("codex_oauth still reports a genuinely absent token truthfully alongside the boundary", () => {
    const selection = resolveNativeCredentialOverlay({ credential_source: "codex_oauth", env: {}, reader: readerFor({}) });
    expect(selection.boundary).toBeDefined();
    expect(selection.facts).toMatchObject({ source: "codex_oauth", present: false, state: "absent" });
  });

  it("injects only an unexpired, pre-exchanged OpenAI WIF access token for OpenAI", () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const selection = resolveNativeCredentialOverlay({
      credential_source: "openai_wif", provider_id: "openai", adapter_id: "openai-compatible", base_url: "https://api.openai.com/v1",
      env: { [OPENAI_WIF_ACCESS_TOKEN_ENV]: "fixture-wif-access-token", [OPENAI_WIF_EXPIRES_AT_ENV]: String(expiry) },
    });
    expect(selection.boundary).toBeUndefined();
    expect(selection.facts).toMatchObject({ source: "openai_wif", mechanism: "oauth_bearer", present: true, state: "present", env_var: OPENAI_WIF_ACCESS_TOKEN_ENV, file_path: null });
    expect(selection.overlay.inject((secret, mechanism) => ({ secret, mechanism }))).toEqual({ secret: "fixture-wif-access-token", mechanism: "oauth_bearer" });
    expect(JSON.stringify(selection)).not.toContain("fixture-wif-access-token");
  });

  it("fails closed for missing, malformed, expired, or wrong-provider WIF credentials", () => {
    const expired = Math.floor(Date.now() / 1000) - 10;
    const route = { provider_id: "openai", adapter_id: "openai-compatible", base_url: "https://api.openai.com/v1" };
    const missing = resolveNativeCredentialOverlay({ credential_source: "openai_wif", ...route, env: {} });
    const malformed = resolveNativeCredentialOverlay({ credential_source: "openai_wif", ...route, env: { OPENAI_WIF_ACCESS_TOKEN: "fixture", OPENAI_WIF_EXPIRES_AT: "tomorrow" } });
    const old = resolveNativeCredentialOverlay({ credential_source: "openai_wif", ...route, env: { OPENAI_WIF_ACCESS_TOKEN: "fixture", OPENAI_WIF_EXPIRES_AT: String(expired) } });
    const wrongProvider = resolveNativeCredentialOverlay({ credential_source: "openai_wif", ...route, provider_id: "openrouter", env: { OPENAI_WIF_ACCESS_TOKEN: "fixture", OPENAI_WIF_EXPIRES_AT: String(expired + 4000) } });
    const wrongAdapter = resolveNativeCredentialOverlay({ credential_source: "openai_wif", ...route, adapter_id: "anthropic-messages", env: { OPENAI_WIF_ACCESS_TOKEN: "fixture", OPENAI_WIF_EXPIRES_AT: String(expired + 4000) } });
    const wrongHost = resolveNativeCredentialOverlay({ credential_source: "openai_wif", ...route, base_url: "https://attacker.example/v1", env: { OPENAI_WIF_ACCESS_TOKEN: "fixture", OPENAI_WIF_EXPIRES_AT: String(expired + 4000) } });
    const http = resolveNativeCredentialOverlay({ credential_source: "openai_wif", ...route, base_url: "http://api.openai.com/v1", env: { OPENAI_WIF_ACCESS_TOKEN: "fixture", OPENAI_WIF_EXPIRES_AT: String(expired + 4000) } });
    const userInfo = resolveNativeCredentialOverlay({ credential_source: "openai_wif", ...route, base_url: "https://user:pass@api.openai.com/v1", env: { OPENAI_WIF_ACCESS_TOKEN: "fixture", OPENAI_WIF_EXPIRES_AT: String(expired + 4000) } });
    expect(missing.facts).toMatchObject({ state: "absent", present: false });
    expect(malformed.facts).toMatchObject({ state: "absent", present: false });
    expect(old.facts).toMatchObject({ state: "expired", present: false });
    expect(wrongProvider.boundary?.reason).toContain('provider_id "openai"');
    for (const selection of [missing, malformed, old, wrongProvider, wrongAdapter, wrongHost, http, userInfo]) expect(selection.overlay.inject((secret) => secret)).toBeUndefined();
  });

  it("updates the source facts and refuses injection when a live WIF token expires", () => {
    let now = new Date("2026-09-23T12:00:00.000Z");
    const expiry = Math.floor(now.getTime() / 1000) + 60;
    const selection = resolveNativeCredentialOverlay({
      credential_source: "openai_wif", provider_id: "openai", adapter_id: "openai-compatible", base_url: "https://api.openai.com/v1",
      env: { OPENAI_WIF_ACCESS_TOKEN: "fixture-wif-token", OPENAI_WIF_EXPIRES_AT: String(expiry) },
      clock: { now: () => now },
    });
    expect(selection.facts).toMatchObject({ present: true, state: "present" });
    now = new Date((expiry + 1) * 1000);
    expect(selection.facts).toMatchObject({ present: false, state: "expired" });
    expect(selection.overlay.inject((secret) => secret)).toBeUndefined();
  });

  it("uses the process environment only to choose the Codex path when no env overlay is supplied", () => {
    const selection = resolveNativeCredentialOverlay({ credential_source: "codex_oauth", reader: readerFor({}) });
    expect(selection.boundary).toBeDefined();
    expect(selection.facts).toMatchObject({ source: "codex_oauth", present: false, state: "absent" });
  });
});
