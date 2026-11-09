/**
 * Y-3 (ADR-066, sibling-scoped inverted regression oracle): behavior tests
 * for `amplifySiblingSites` and its supporting composition/parsing seams.
 * Mirrors `scope-enforcement-adversarial.test.ts`'s fixture style -- fake
 * `AmplifierModelPort`/`MachineVerificationCommandPort` injected, no real
 * network or process spawn.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenAICompatibleFetch } from "@arbor/harness";
import type { ArborConfig, NativeProviderSecretOverlay } from "@arbor/config";
import type { MachineVerificationCommandPort, MachineVerificationCommandResult } from "../src/worktree-machine-verifier.js";
import {
  ARBOR_TEST_AMPLIFIER_ENV,
  TEST_AMPLIFIER_MAX_SITES,
  amplifierPromptFor,
  amplifySiblingSites,
  assessAmplifierApplicability,
  createNativeTestAmplifierPort,
  extractGeneratedTestSource,
  type AmplifierModelPort,
  type FlaggedSiblingSite,
} from "../src/test-amplifier.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function worktree(): string { const directory = mkdtempSync(join(tmpdir(), "arbor-amplifier-")); directories.push(directory); return directory; }

function site(overrides: Partial<FlaggedSiblingSite> = {}): FlaggedSiblingSite {
  return { pattern: "if (x > MAX) throw new Error();", file: "lib/sibling.js", line: 42, ...overrides };
}

function readyPort(text: string | ((prompt: string) => string)): AmplifierModelPort {
  return Object.freeze({
    ready: true,
    async call(prompt: string) { return { ok: true as const, text: typeof text === "function" ? text(prompt) : text }; },
  });
}

function notReadyPort(): AmplifierModelPort {
  return Object.freeze({ ready: false, async call() { return { ok: false as const, error: "not ready" }; } });
}

function exitedResult(exit: number, stdout = ""): MachineVerificationCommandResult {
  return { kind: "exited", exit, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

function commandPort(handler: (argv: readonly string[]) => MachineVerificationCommandResult): MachineVerificationCommandPort {
  return { async run(request) { return handler(request.argv); } };
}

const baseRunCommand = () => ({ argv: ["node", "--test"] as const, network: "unrestricted" as const });

describe("amplifySiblingSites — disabled by default", () => {
  it("returns [] and never calls the model or command port when ARBOR_TEST_AMPLIFIER is unset", async () => {
    let modelCalls = 0;
    let commandCalls = 0;
    const findings = await amplifySiblingSites({
      worktree_path: worktree(),
      flagged_sites: [site()],
      model_port: { ready: true, async call() { modelCalls++; return { ok: true, text: "test" }; } },
      command_port: { async run() { commandCalls++; return exitedResult(0); } },
      run_generated_test: baseRunCommand,
      env: {},
    });
    expect(findings).toEqual([]);
    expect(modelCalls).toBe(0);
    expect(commandCalls).toBe(0);
  });

  it("returns [] for any value other than exactly 'native'", async () => {
    const findings = await amplifySiblingSites({
      worktree_path: worktree(), flagged_sites: [site()], model_port: readyPort("test"),
      command_port: commandPort(() => exitedResult(1)), run_generated_test: baseRunCommand,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "true" },
    });
    expect(findings).toEqual([]);
  });

  it("returns [] when the model port itself is not ready, without calling the command port", async () => {
    let commandCalls = 0;
    const findings = await amplifySiblingSites({
      worktree_path: worktree(), flagged_sites: [site()], model_port: notReadyPort(),
      command_port: { async run() { commandCalls++; return exitedResult(0); } }, run_generated_test: baseRunCommand,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    expect(findings).toEqual([]);
    expect(commandCalls).toBe(0);
  });
});

describe("amplifySiblingSites — enabled: generation, compile-gate, and evidence-only findings", () => {
  it("writes the generated test, runs it, and reports a finding only when it RUNS and FAILS", async () => {
    const directory = worktree();
    const findings = await amplifySiblingSites({
      worktree_path: directory, flagged_sites: [site()], model_port: readyPort("test('x', () => { throw new Error('unfixed'); });"),
      command_port: commandPort(() => exitedResult(1, "1 failing")), run_generated_test: baseRunCommand,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.site).toEqual(site());
    expect(findings[0]!.note).toMatch(/FAILED/);
    expect(findings[0]!.note).toMatch(/evidence only/i);
    expect(findings[0]!.evidence.exit_code).toBe(1);
    expect(findings[0]!.evidence.output_excerpt).toContain("1 failing");
    expect(readFileSync(findings[0]!.evidence.test_file, "utf-8")).toContain("unfixed");
  });

  it("a generated test that RUNS and PASSES produces no finding -- a clean exit is never evidence of brokenness", async () => {
    const findings = await amplifySiblingSites({
      worktree_path: worktree(), flagged_sites: [site()], model_port: readyPort("test('x', () => {});"),
      command_port: commandPort(() => exitedResult(0)), run_generated_test: baseRunCommand,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    expect(findings).toEqual([]);
  });

  it("compile-gate: a result that never reaches 'exited' (spawn failure, timeout, cancellation) is discarded silently", async () => {
    for (const failure of [{ kind: "spawn_failed" as const }, { kind: "timed_out" as const, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, { kind: "cancelled" as const, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }]) {
      const findings = await amplifySiblingSites({
        worktree_path: worktree(), flagged_sites: [site()], model_port: readyPort("garbage(((("),
        command_port: commandPort(() => failure), run_generated_test: baseRunCommand,
        env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
      });
      expect(findings).toEqual([]);
    }
  });

  it("a model call that fails or returns unusable text never reaches the command port", async () => {
    let commandCalls = 0;
    const failingModel: AmplifierModelPort = { ready: true, async call() { return { ok: false, error: "provider error" }; } };
    const findings = await amplifySiblingSites({
      worktree_path: worktree(), flagged_sites: [site()], model_port: failingModel,
      command_port: { async run() { commandCalls++; return exitedResult(1); } }, run_generated_test: baseRunCommand,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    expect(findings).toEqual([]);
    expect(commandCalls).toBe(0);

    const emptyModel = readyPort("   \n\n  ");
    const findings2 = await amplifySiblingSites({
      worktree_path: worktree(), flagged_sites: [site()], model_port: emptyModel,
      command_port: { async run() { commandCalls++; return exitedResult(1); } }, run_generated_test: baseRunCommand,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    expect(findings2).toEqual([]);
    expect(commandCalls).toBe(0);
  });

  it("is bounded to TEST_AMPLIFIER_MAX_SITES model/command calls regardless of how many sites are flagged", async () => {
    let modelCalls = 0;
    const sites = [site({ file: "a.js", line: 1 }), site({ file: "b.js", line: 2 }), site({ file: "c.js", line: 3 })];
    expect(sites.length).toBeGreaterThan(TEST_AMPLIFIER_MAX_SITES);
    await amplifySiblingSites({
      worktree_path: worktree(), flagged_sites: sites,
      model_port: { ready: true, async call() { modelCalls++; return { ok: true, text: "test('x', () => {});" }; } },
      command_port: commandPort(() => exitedResult(0)), run_generated_test: baseRunCommand,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    expect(modelCalls).toBe(TEST_AMPLIFIER_MAX_SITES);
  });

  it("never touches manager.recordResult's shape -- a finding carries only {site, note, evidence}", async () => {
    const findings = await amplifySiblingSites({
      worktree_path: worktree(), flagged_sites: [site()], model_port: readyPort("test('x', () => { throw new Error(); });"),
      command_port: commandPort(() => exitedResult(2)), run_generated_test: baseRunCommand,
      env: { [ARBOR_TEST_AMPLIFIER_ENV]: "native" },
    });
    expect(Object.keys(findings[0]!).sort()).toEqual(["evidence", "note", "site"]);
  });
});

describe("extractGeneratedTestSource", () => {
  it("strips a markdown code fence when present", () => {
    expect(extractGeneratedTestSource("```ts\ntest('x', () => {});\n```")).toBe("test('x', () => {});");
  });
  it("returns trimmed raw text when unfenced", () => {
    expect(extractGeneratedTestSource("  test('x', () => {});  ")).toBe("test('x', () => {});");
  });
  it("returns null for empty or whitespace-only text", () => {
    expect(extractGeneratedTestSource("")).toBeNull();
    expect(extractGeneratedTestSource("   \n  ")).toBeNull();
    expect(extractGeneratedTestSource("```\n\n```")).toBeNull();
  });
});

describe("amplifierPromptFor — generation prompt shape", () => {
  it("names the pattern, the remaining site, and asks for known-good post-fix behavior only, no prose", () => {
    const prompt = amplifierPromptFor(site());
    expect(prompt).toContain("if (x > MAX) throw new Error();");
    expect(prompt).toContain("lib/sibling.js:42");
    expect(prompt).toMatch(/KNOWN-GOOD/);
    expect(prompt).toMatch(/No prose/);
  });
});

function nativeConfig(overrides: Partial<ArborConfig["native"]> = {}): Pick<ArborConfig, "native"> {
  return { native: { mode: "native", adapter_id: "openai-compatible", provider_id: "openai-compatible", base_url: "https://model.invalid", model: "test-model", ...overrides } };
}
const absentCredential: NativeProviderSecretOverlay = Object.freeze({
  source: "absent", env_var: null, present: false, mechanism: "api_key",
  inject<T>(_recipient: (apiKey: string, mechanism: "api_key" | "oauth_bearer") => T): T | undefined { return undefined; },
});
const unusedFetch: OpenAICompatibleFetch = async () => { throw new Error("must not be called"); };

describe("createNativeTestAmplifierPort — composition readiness (mirrors createNativeCriticPort's pattern)", () => {
  it("is not ready when the native provider selection is incomplete", () => {
    const port = createNativeTestAmplifierPort({ config: nativeConfig({ base_url: "", model: "" }), credential: absentCredential, fetch: unusedFetch });
    expect(port.ready).toBe(false);
  });

  it("is not ready when no credential is present", () => {
    const port = createNativeTestAmplifierPort({ config: nativeConfig(), credential: absentCredential, fetch: unusedFetch });
    expect(port.ready).toBe(false);
  });
});

describe("assessAmplifierApplicability — Y-3 JS/TS-shape applicability signal (cli.ts's testAmplifier composition skips amplifySiblingSites entirely when this is false)", () => {
  it("is not applicable when there are no flagged sites", () => {
    const applicability = assessAmplifierApplicability([]);
    expect(applicability).toEqual({ applicable: false, reason: "no flagged sibling sites to assess" });
  });

  it("is applicable when at least one flagged site is JS/TS-shaped", () => {
    expect(assessAmplifierApplicability([site({ file: "lib/sibling.py" }), site({ file: "lib/sibling.ts" })])).toEqual({ applicable: true });
  });

  it("is not applicable when every flagged site is non-JS/TS, and names the observed extensions", () => {
    const applicability = assessAmplifierApplicability([site({ file: "lib/sibling.py" }), site({ file: "lib/other.go" })]);
    expect(applicability.applicable).toBe(false);
    expect(applicability.reason).toContain(".go");
    expect(applicability.reason).toContain(".py");
  });
});
