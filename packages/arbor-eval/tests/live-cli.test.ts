/**
 * arbor-eval/tests/live-cli — drives the REAL entrypoint chain
 * (`cli.ts`'s `main(["live", ...])` -> `live-cli.ts`'s `runLiveCli` ->
 * `live-model-port.ts`'s real `createOpenAICompatibleModelPort` adapter ->
 * `live-ablation.ts` -> real `CampaignManager` + real verification
 * commands) with only the process-global `fetch` stubbed — the one
 * network boundary this run cannot cross without a real credential
 * (see `main()`'s dispatch in `cli.ts` and this file's header note on
 * why default (non-"live") invocations must stay untouched).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { parseLiveArgs, resolveFrontierFlashLiveConfig, runLiveCli } from "../src/live-cli.js";

function sseFinal(message: string): Response {
  const payload = { choices: [{ delta: { content: message } }], usage: { prompt_tokens: 11, completion_tokens: 3 } };
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("parseLiveArgs", () => {
  it("applies documented defaults", () => {
    expect(parseLiveArgs([])).toEqual({
      runsPerArmPerTask: 3, maxCallsPerRun: 3, costCeilingUsd: null, estimatedPromptTokensPerCall: 800, maxOutputTokensPerCall: null, outputDir: ".arbor/eval", frontierFlashAttestation: null,
    });
  });
  it("parses every flag when supplied", () => {
    expect(parseLiveArgs(["--runs", "1", "--max-calls", "1", "--cost-ceiling-usd", "0.5", "--output", "/tmp/x"])).toMatchObject({
      runsPerArmPerTask: 1, maxCallsPerRun: 1, costCeilingUsd: 0.5, outputDir: "/tmp/x",
    });
  });
});

describe("resolveFrontierFlashLiveConfig — closed economy lane", () => {
  const fixtureDirs: string[] = [];

  afterEach(() => {
    for (const fixtureDir of fixtureDirs.splice(0)) rmSync(fixtureDir, { recursive: true, force: true });
  });

  function writeAttestation(overrides: Record<string, unknown> = {}): string {
    const fixtureDir = mkdtempSync(join(tmpdir(), "arbor-eval-flash-"));
    fixtureDirs.push(fixtureDir);
    const path = join(fixtureDir, "attestation.json");
    const body = {
      checked_at: "2026-08-30T11:57:00.000Z",
      source_url: "https://openrouter.ai/api/v1/model/deepseek/deepseek-v4-flash-0731",
      id: "deepseek/deepseek-v4-flash-0731",
      canonical_slug: "deepseek/deepseek-v4-flash-20260731",
      observed_metadata: {
        created: 1785478908,
        context_length: 1_048_576,
        top_provider_max_completion_tokens: 384_000,
        tool_calling: true,
        input_modality: "text",
        output_modality: "text",
        price_input_usd_per_token: 0.00000007868,
        price_output_usd_per_token: 0.00000026,
      },
      ...overrides,
    };
    writeFileSync(path, JSON.stringify(body));
    return path;
  }

  it("pins OpenRouter and DeepSeek V4 Flash without consulting generic live-provider overrides", () => {
    const path = writeAttestation();
    const resolved = resolveFrontierFlashLiveConfig({
      attestationPath: path,
      nowMs: Date.parse("2026-08-30T12:00:00.000Z"),
      env: {
        ARBOR_EVAL_FRONTIER_FLASH_API_KEY: "flash-test-secret",
        ARBOR_EVAL_LIVE_PROVIDER_ID: "must-not-be-used",
        ARBOR_EVAL_LIVE_MODEL_ID: "deepseek/deepseek-v4-pro",
      },
    });
    expect(resolved).toMatchObject({
      base_url: "https://openrouter.ai/api/v1",
      provider_id: "openrouter",
      model_id: "deepseek/deepseek-v4-flash-0731",
      credential: "flash-test-secret",
    });
  });

  it("fails unmeasured on Pro, stale attestation, or absent dedicated credential", () => {
    const proPath = writeAttestation({ id: "deepseek/deepseek-v4-pro" });
    expect(() => resolveFrontierFlashLiveConfig({
      attestationPath: proPath,
      nowMs: Date.parse("2026-08-30T12:00:00.000Z"),
      env: { ARBOR_EVAL_FRONTIER_FLASH_API_KEY: "secret", ARBOR_EVAL_FRONTIER_FLASH_PRICE_OUTPUT_USD: "0.1" },
    })).toThrow(/invalid.*no fallback/i);
    const validPath = writeAttestation();
    expect(() => resolveFrontierFlashLiveConfig({
      attestationPath: validPath,
      nowMs: Date.parse("2026-08-30T12:00:00.000Z"),
      env: { ARBOR_EVAL_FRONTIER_FLASH_PRICE_OUTPUT_USD: "0.1" },
    })).toThrow(/skipped.*no fallback/i);
  });
});

describe("runLiveCli — credential honesty", () => {
  const savedEnv = { ...process.env };
  afterEach(() => { process.env = { ...savedEnv }; vi.unstubAllGlobals(); });

  it("refuses to run and never falls back to a scripted result when live credentials are absent", async () => {
    for (const key of ["ARBOR_EVAL_LIVE_BASE_URL", "ARBOR_EVAL_LIVE_PROVIDER_ID", "ARBOR_EVAL_LIVE_MODEL_ID", "ARBOR_EVAL_LIVE_API_KEY", "ARBOR_EVAL_LIVE_PRICE_INPUT_USD", "ARBOR_EVAL_LIVE_PRICE_OUTPUT_USD"]) {
      delete process.env[key];
    }
    await expect(runLiveCli([])).rejects.toThrow(/missing live-provider configuration/);
  });
});

describe("runLiveCli — real entrypoint chain with only fetch stubbed", () => {
  const savedEnv = { ...process.env };
  let outDir: string;

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("writes a real live-ablation report and JSON artifact reachable from cli.ts's own dispatch", async () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-live-cli-"));
    Object.assign(process.env, {
      ARBOR_EVAL_LIVE_BASE_URL: "https://live-eval-fixture.invalid/v1",
      ARBOR_EVAL_LIVE_PROVIDER_ID: "fixture-provider",
      ARBOR_EVAL_LIVE_MODEL_ID: "fixture-model",
      ARBOR_EVAL_LIVE_API_KEY: "test-secret",
      ARBOR_EVAL_LIVE_PRICE_INPUT_USD: "0.000001",
      ARBOR_EVAL_LIVE_PRICE_OUTPUT_USD: "0.000002",
    });
    // Every task's target file is `broken.mjs` and prompt asks for the whole
    // corrected file text — a fixed correct-looking response won't pass every
    // task's real verification, so this fake intentionally always returns a
    // benign (still-broken) reply: the point of this test is to prove the
    // real wiring runs end to end and writes a real report, not to force a
    // specific pass rate (that is `live-ablation.test.ts`'s job with an
    // injected port and controlled fixtures).
    vi.stubGlobal("fetch", vi.fn(async () => sseFinal("export const notAFix = true;\n")));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runLiveCli(["--runs", "1", "--max-calls", "1", "--output", outDir]);

    const files = readdirSync(outDir);
    expect(files.some((f) => f.startsWith("live-report-") && f.endsWith(".md"))).toBe(true);
    expect(files).toContain("live-ablation.json");
    const artifact = JSON.parse(readFileSync(join(outDir, "live-ablation.json"), "utf-8"));
    expect(artifact.schema).toBe("arbor.live-ablation/v2");
    expect(artifact.task_results.length).toBeGreaterThan(0);
    expect(logSpy).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  }, 30_000);

  it("main([\"live\", ...]) reaches the same real chain from the package's own entrypoint (cli.ts)", async () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-live-cli-main-"));
    Object.assign(process.env, {
      ARBOR_EVAL_LIVE_BASE_URL: "https://live-eval-fixture.invalid/v1",
      ARBOR_EVAL_LIVE_PROVIDER_ID: "fixture-provider",
      ARBOR_EVAL_LIVE_MODEL_ID: "fixture-model",
      ARBOR_EVAL_LIVE_API_KEY: "test-secret",
      ARBOR_EVAL_LIVE_PRICE_INPUT_USD: "0.000001",
      ARBOR_EVAL_LIVE_PRICE_OUTPUT_USD: "0.000002",
    });
    vi.stubGlobal("fetch", vi.fn(async () => sseFinal("export const notAFix = true;\n")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    main(["live", "--runs", "1", "--max-calls", "1", "--output", outDir]);
    // main() dispatches live work as a fire-and-forget promise (see cli.ts);
    // wait for the artifact it writes rather than asserting synchronously.
    await vi.waitFor(() => {
      expect(readdirSync(outDir)).toContain("live-ablation.json");
    }, { timeout: 30_000, interval: 100 });
  }, 30_000);
});
