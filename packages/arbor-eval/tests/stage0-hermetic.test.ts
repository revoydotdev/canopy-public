// Stage 0 driver isolation (pilot-3 D4) and preregistration freeze (D5). No live calls.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAttempt } from "../src/stage0/attempt.js";
import type { AttemptEnvironment } from "../src/stage0/attempt.js";
import { assertEffectiveMatchesPreregistration, canonicalJson, hermeticEnv, redactConfig, resolveEffectiveConfig } from "../src/stage0/hermetic.js";
import { freezePreregistration, readLedger } from "../src/stage0/ledger.js";
import type { Stage0FixtureProof, Stage0Task } from "../src/stage0/types.js";

const scratch = () => mkdtempSync(join(tmpdir(), "stage0-hermetic-"));

const native = {
  model: "poolside/laguna-s-2.1",
  usage_budget: { estimate_authority: "preregistration", estimate_max_input_tokens: 100000, estimate_max_output_tokens: 8000 },
  pricing: {
    price_source_id: "test", provider_id: "openrouter", model_id: "poolside/laguna-s-2.1", currency: "USD", observed_at: "2026-10-07T00:00:00Z", minor_unit_exponent: 6,
    input_minor_units_per_million_tokens: 90000, output_minor_units_per_million_tokens: 180000, cache_read_minor_units_per_million_tokens: 9000, cache_write_minor_units_per_million_tokens: 90000,
  },
} as const;

function userConfig(dir: string, body: unknown): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify(body));
  return dir;
}

function project(native_: unknown): string {
  const dir = scratch();
  writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify({ native: native_ }));
  return dir;
}

describe("hermetic arbor config", () => {
  const conflicting = { native: { usage_budget: { estimate_authority: "operator", estimate_max_input_tokens: 100000, estimate_max_output_tokens: 16000 } } };
  const lenient = { ...native, usage_budget: { estimate_authority: "preregistration", estimate_max_input_tokens: 100000 } };

  it("does not let the operator's user-scope config leak into an attempt", () => {
    const user = userConfig(join(scratch(), "operator"), conflicting);
    const target = project(lenient);
    const leaky = resolveEffectiveConfig(target, { ARBOR_USER_CONFIG_DIR: user });
    expect(leaky.effective.native.usage_budget?.estimate_max_output_tokens).toBe(16000);
    const isolated = resolveEffectiveConfig(target, hermeticEnv({ ARBOR_USER_CONFIG_DIR: user, ARBOR_ORGANIZATION_CONFIG_DIR: user, ARBOR_CONFIG__NATIVE__MODEL: "other/model" }, join(scratch(), "home")));
    expect(isolated.effective.native.usage_budget?.estimate_max_output_tokens).not.toBe(16000);
    expect(isolated.effective.native.model).toBe("poolside/laguna-s-2.1");
  });

  it("keeps credentials and unrelated environment reachable", () => {
    const env = hermeticEnv({ HOME: "/h", XDG_CONFIG_HOME: "/x", OPENROUTER_API_KEY: "k" }, join(scratch(), "home"));
    expect(env.HOME).toBe("/h");
    expect(env.XDG_CONFIG_HOME).toBe("/x");
    expect(env.OPENROUTER_API_KEY).toBe("k");
  });

  it("hashes the redacted effective config deterministically and redacts secrets", () => {
    const target = project(native);
    const env = hermeticEnv({}, join(scratch(), "home"));
    const a = resolveEffectiveConfig(target, env).record;
    expect(a.sha256).toBe(resolveEffectiveConfig(target, env).record.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
    const redacted = redactConfig({ api_key: "sk-live", nested: { password: "p", estimate_max_output_tokens: 8000 } }) as { api_key: string; nested: { password: string; estimate_max_output_tokens: number } };
    expect(redacted.api_key).toBe("[redacted]");
    expect(redacted.nested.password).toBe("[redacted]");
    expect(redacted.nested.estimate_max_output_tokens).toBe(8000);
  });

  it("refuses an effective config that differs from the preregistered values", () => {
    const env = hermeticEnv({}, join(scratch(), "home"));
    const ok = resolveEffectiveConfig(project(native), env).effective;
    expect(() => assertEffectiveMatchesPreregistration(ok, native)).not.toThrow();
    const drifted = resolveEffectiveConfig(project({ ...native, usage_budget: { ...native.usage_budget, estimate_max_output_tokens: 16000 } }), env).effective;
    expect(() => assertEffectiveMatchesPreregistration(drifted, native)).toThrow(/estimate_max_output_tokens: preregistered 8000, effective 16000/);
    const otherModel = resolveEffectiveConfig(project({ ...native, model: "other/model" }), env).effective;
    expect(() => assertEffectiveMatchesPreregistration(otherModel, native)).toThrow(/native\.model/);
  });
});

describe("runAttempt records the effective config", () => {
  it("writes the hash and redacted config into the attempt record, under an isolated user scope", async () => {
    const root = scratch();
    const repo = join(root, "fixture");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "x");
    git("add", "a.txt");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fixture");
    const commit = git("rev-parse", "HEAD");
    // A fake `arbor`: enroll reports ready; any other command records the user-scope dir it ran with and exits 3.
    const fake = join(root, "fake-arbor.sh");
    writeFileSync(fake, `#!/bin/sh\nif [ "$1" = project ]; then echo '{"inspection":{"state":"ready"}}'; exit 0; fi\necho "$ARBOR_USER_CONFIG_DIR" > "${root}/seen-user-dir"\nexit 3\n`);
    chmodSync(fake, 0o755);
    const operator = userConfig(join(root, "operator"), { native: { usage_budget: { estimate_authority: "operator", estimate_max_input_tokens: 100000, estimate_max_output_tokens: 16000 } } });
    const task: Stage0Task = { id: "t", member: "semver", language: "rust", generator: "stub", symbol: "s", edit_paths: ["a.txt"], task_text: "do", acceptance: ["true"], protected_paths: [], split: "dev" } as unknown as Stage0Task;
    const proof: Stage0FixtureProof = { task_id: "t", fixture_repo: repo, fixture_commit: commit, baseline_exit: 1, reference_exit: 0, protected_sha256: {}, admitted: true, reason: null };
    const lenient = { ...native, usage_budget: { estimate_authority: "preregistration", estimate_max_input_tokens: 100000 } };
    const env = {
      arbor: [fake], native_config: lenient, tier: "reviewed", runs_root: join(root, "runs"), attempt_timeout_ms: 60_000,
      fixtures: { fixtures_root: root, pristine: {}, node_modules_cache: root, cargo_lock: root },
    } as unknown as AttemptEnvironment;
    const previous = process.env.ARBOR_USER_CONFIG_DIR;
    process.env.ARBOR_USER_CONFIG_DIR = operator;
    try {
      const record = await runAttempt({ experiment: "pilot", task, proof, seed: 0, attempt_index: 0, wave: 0 }, env);
      expect(record.failure_detail).not.toMatch(/differs from the preregistered/);
      expect(record.effective_config_sha256).toMatch(/^[0-9a-f]{64}$/);
      const config = record.effective_config as { native: { usage_budget: { estimate_max_output_tokens?: number } } };
      expect(config.native.usage_budget.estimate_max_output_tokens).not.toBe(16000);
      const seen = readFileSync(join(root, "seen-user-dir"), "utf8").trim();
      expect(seen).not.toBe(operator);
      expect(seen).toBe(join(record.run_dir, "config-home"));
      expect(existsSync(join(record.run_dir, "effective-config.json"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ARBOR_USER_CONFIG_DIR;
      else process.env.ARBOR_USER_CONFIG_DIR = previous;
    }
  });
});

describe("preregistration freeze", () => {
  it("refuses to run when the preregistration file is missing", () => {
    const dir = scratch();
    const ledger = join(dir, "ledger.jsonl");
    expect(() => freezePreregistration(ledger, "pilot", join(dir, "missing.md"))).toThrow(/preregistration file not found/);
    expect(existsSync(ledger)).toBe(false);
  });

  it("writes preregistration_frozen as the first ledger line, creating the work directory", () => {
    const dir = scratch();
    const prereg = join(dir, "prereg.md");
    writeFileSync(prereg, "frozen text");
    const ledger = join(dir, "work", "nested", "ledger.jsonl");
    const result = freezePreregistration(ledger, "pilot", prereg);
    expect(result.written).toBe(true);
    const first = JSON.parse(readFileSync(ledger, "utf8").split("\n")[0]) as { event: string; detail: { path: string; sha256: string; frozen_at: string }; at: string };
    expect(first.event).toBe("preregistration_frozen");
    expect(first.detail.path).toBe(prereg);
    expect(first.detail.sha256).toBe(result.sha256);
    expect(first.at).toMatch(/^\d{4}-/);
  });

  it("resumes an unchanged freeze without a second event and refuses a changed file", () => {
    const dir = scratch();
    const prereg = join(dir, "prereg.md");
    writeFileSync(prereg, "v1");
    const ledger = join(dir, "ledger.jsonl");
    freezePreregistration(ledger, "pilot", prereg);
    expect(freezePreregistration(ledger, "pilot", prereg).written).toBe(false);
    expect(readLedger(ledger, "pilot").events.filter((e) => e.event === "preregistration_frozen")).toHaveLength(1);
    writeFileSync(prereg, "v2");
    expect(() => freezePreregistration(ledger, "pilot", prereg)).toThrow(/changed since it was frozen/);
  });
});
