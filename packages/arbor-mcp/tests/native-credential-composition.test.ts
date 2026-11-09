/**
 * Composition-root coverage for `native.credential_source` (ADR follow-up:
 * wiring the Claude/Codex subscriber-OAuth credential sources into the
 * runtime composition root, cli.ts). Drives the real `arbor doctor --json`
 * CLI path -- the same read-only composition `createDoctorReadiness` uses --
 * over fixture credential files. No real token, no network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../src/cli.js";

const FAKE_CLAUDE_TOKEN = "sk-ant-fixture-not-a-real-token";

function claudeFixture(expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: FAKE_CLAUDE_TOKEN, refreshToken: "sk-ant-fixture-refresh-not-real",
      expiresAt, refreshTokenExpiresAt: expiresAt + 1_000_000,
      scopes: ["user:inference"], subscriptionType: "max", rateLimitTier: "default_max",
    },
  });
}

function fakeJwt(exp: number): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ aud: ["https://api.openai.com/v1"], exp, scp: ["openid"] })}.fixture-signature-not-real`;
}

function codexFixture(exp: number): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { id_token: fakeJwt(exp), access_token: fakeJwt(exp), refresh_token: "rt.1.fixture-not-real", account_id: "fixture-account-id" },
    last_refresh: new Date(0).toISOString(),
  });
}

const roots: string[] = [];
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });
function root(): string { const value = mkdtempSync(join(tmpdir(), "arbor-native-credential-composition-")); roots.push(value); return value; }

async function runDoctor(cwd: string): Promise<{ code: number; report: Record<string, unknown>; text: string }> {
  const stdout = new PassThrough(); let text = ""; stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  const code = await main(["doctor", "--json"], { cwd, stdin: new PassThrough(), stdout, stderr: new PassThrough(), execute_integration_probe: () => "fixture" });
  return { code, report: JSON.parse(text), text };
}

/** Env vars this suite mutates directly, since createDoctorReadiness reads process.env, not environment.env. Snapshotted/restored per test. */
const MUTATED_ENV_KEYS = ["ARBOR_NATIVE_CLAUDE_OAUTH_PATH", "ARBOR_NATIVE_CODEX_OAUTH_PATH", "ANTHROPIC_API_KEY", "ARBOR_NATIVE_API_KEY"] as const;
function withEnv<T>(overrides: Partial<Record<(typeof MUTATED_ENV_KEYS)[number], string>>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(MUTATED_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MUTATED_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  return fn().finally(() => {
    for (const key of MUTATED_ENV_KEYS) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  });
}

describe("native.credential_source composition (doctor)", () => {
  it("api_key remains the unchanged default when credential_source is absent from config", async () => {
    const cwd = root();
    writeFileSync(join(cwd, "arbor.jsonc"), JSON.stringify({ native: { mode: "auto", adapter_id: "openai-compatible", provider_id: "openrouter", base_url: "https://openrouter.ai/api/v1", model: "fixture/model" } }));
    await withEnv({ ARBOR_NATIVE_API_KEY: "fixture-api-key" }, async () => {
      const { report } = await runDoctor(cwd);
      expect(report.credentials).toMatchObject({ native: { source: "env", mechanism: "api_key", state: "present", present: true, env_var: "ARBOR_NATIVE_API_KEY" } });
      expect(report.mode_selection).toMatchObject({ active_lane: "native" });
    });
  });

  it("fails closed when claude_oauth names a product-scoped subscriber token", async () => {
    const cwd = root();
    const credPath = join(cwd, "claude-credentials.json");
    writeFileSync(credPath, claudeFixture(Date.now() + 3_600_000));
    writeFileSync(join(cwd, "arbor.jsonc"), JSON.stringify({
      native: { mode: "auto", adapter_id: "anthropic-messages", provider_id: "anthropic", base_url: "https://api.anthropic.com/v1", model: "claude-fixture", credential_source: "claude_oauth" },
    }));
    await withEnv({ ARBOR_NATIVE_CLAUDE_OAUTH_PATH: credPath }, async () => {
      const { report } = await runDoctor(cwd);
      expect(report.credentials).toMatchObject({ native: { source: "claude_oauth", mechanism: "oauth_bearer", state: "unusable", present: false, file_path: credPath } });
      expect(report.execution).toMatchObject({ kind: "unavailable", reason: "credential_source_unusable" });
      expect(report.mode_selection).toMatchObject({ active_lane: "connector" });
      const actions = report.next_actions as readonly { code: string; action: string }[];
      expect(actions.find((entry) => entry.code === "native_credential_source_unusable")?.action).toContain("Claude Agent SDK");
      expect(JSON.stringify(report)).not.toContain(FAKE_CLAUDE_TOKEN); // never project the secret value
    });
  });

  it("reports an expired claude_oauth token as a legible, typed re-auth requirement, never a crash", async () => {
    const cwd = root();
    const credPath = join(cwd, "claude-credentials.json");
    writeFileSync(credPath, claudeFixture(Date.now() - 1_000));
    writeFileSync(join(cwd, "arbor.jsonc"), JSON.stringify({
      native: { mode: "native", adapter_id: "anthropic-messages", provider_id: "anthropic", base_url: "https://api.anthropic.com/v1", model: "claude-fixture", credential_source: "claude_oauth" },
    }));
    await withEnv({ ARBOR_NATIVE_CLAUDE_OAUTH_PATH: credPath }, async () => {
      const { report } = await runDoctor(cwd);
      expect(report.credentials).toMatchObject({ native: { source: "claude_oauth", mechanism: "oauth_bearer", state: "expired", present: false } });
      expect(report.execution).toMatchObject({ kind: "unavailable", reason: "credential_source_unusable" });
      const actions = report.next_actions as readonly { code: string; action: string }[];
      expect(actions.find((entry) => entry.code === "native_credential_source_unusable")?.action).toContain("api_key");
      expect(report.mode_selection).toMatchObject({ active_lane: "connector" });
    });
  });

  it("codex_oauth is a typed, legible unusable-boundary error at doctor time -- never a silent 401 against the openai-compatible adapter", async () => {
    const cwd = root();
    const credPath = join(cwd, "codex-auth.json");
    // A real `codex login` store is owner-only; the reader refuses a
    // group/other-readable auth.json before it will project readiness.
    writeFileSync(credPath, codexFixture(Math.floor(Date.now() / 1000) + 3600), { mode: 0o600 });
    writeFileSync(join(cwd, "arbor.jsonc"), JSON.stringify({
      native: { mode: "native", adapter_id: "openai-compatible", provider_id: "openai", base_url: "https://api.openai.com/v1", model: "fixture-model", credential_source: "codex_oauth" },
    }));
    await withEnv({ ARBOR_NATIVE_CODEX_OAUTH_PATH: credPath }, async () => {
      const { report, code } = await runDoctor(cwd);
      expect(report.execution).toMatchObject({ kind: "unavailable", reason: "credential_source_unusable" });
      expect(report.credentials).toMatchObject({ native: { source: "codex_oauth", mechanism: "oauth_bearer", present: false, state: "unusable" } });
      const actions = report.next_actions as readonly { code: string; action: string }[];
      const boundary = actions.find((entry) => entry.code === "native_credential_source_unusable");
      expect(boundary?.action).toContain("openai-compatible");
      expect(boundary?.action).toContain("codex_oauth");
      expect(report.mode_selection).toMatchObject({ active_lane: "connector" });
      expect(code).not.toBe(0); // fails closed, not a silent success
    });
  });
});
