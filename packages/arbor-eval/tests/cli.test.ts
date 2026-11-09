/**
 * arbor-eval/tests/cli.test.ts — exercises the CLI entry point directly
 * (G-12 follow-up): before this file, `cli.ts` had 0% coverage because
 * nothing ever imported or invoked it — every existing test called
 * `runBenchmark`/`runBaseline` directly, bypassing argument parsing, the
 * output-directory/report-file write path, and the "no tasks selected"
 * exit branch entirely.
 *
 * `main()`/`parseArgs` are now exported and `main()` no longer auto-runs
 * when imported under vitest (see cli.ts's `process.env.VITEST` guard), so
 * this drives the real functions with real filesystem I/O against a
 * temp directory — no mocking of the module under test.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs, main } from "../src/cli.js";

describe("parseArgs", () => {
  it("applies documented defaults when no flags are given", () => {
    expect(parseArgs([])).toEqual({
      taskCount: 5,
      runsPerTask: 3,
      maxIterations: 50,
      outputDir: ".arbor/eval",
      scenarioFixture: null,
      analyticsFixture: null,
      reuseLedgerDir: null,
      reuseLedgerId: null,
    });
  });

  it("parses every flag when all are supplied", () => {
    expect(parseArgs(["--tasks", "2", "--runs", "4", "--max-iterations", "10", "--output", "/tmp/x"])).toEqual({
      taskCount: 2,
      runsPerTask: 4,
      maxIterations: 10,
      outputDir: "/tmp/x",
      scenarioFixture: null,
      analyticsFixture: null,
      reuseLedgerDir: null,
      reuseLedgerId: null,
    });
  });

  it("ignores unknown flags without throwing", () => {
    expect(parseArgs(["--bogus", "value", "--tasks", "1"]).taskCount).toBe(1);
  });
});

describe("main() — real end-to-end CLI run", () => {
  let outDir: string;
  let inheritedSignalListeners: Map<NodeJS.Signals, Function[]>;

  beforeEach(() => {
    inheritedSignalListeners = new Map([
      ["SIGINT", process.listeners("SIGINT")],
      ["SIGTERM", process.listeners("SIGTERM")],
    ]);
  });

  afterEach(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    // main() registers a real `process.once("SIGINT"/"SIGTERM", ...)` pair on
    // every call (by design — a real CLI process only calls main() once).
    // Repeated calls across these tests would otherwise leak listeners onto
    // the shared worker process for the rest of the suite run.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const inherited = inheritedSignalListeners.get(signal) ?? [];
      for (const listener of process.listeners(signal)) {
        if (!inherited.includes(listener)) process.removeListener(signal, listener);
      }
    }
  });

  it("turns an exact saved OpenRouter Flash catalog document into a live-lane attestation", () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-flash-attestation-"));
    const catalogPath = join(outDir, "catalog.json");
    const attestationPath = join(outDir, "attestation.json");
    writeFileSync(catalogPath, JSON.stringify({
      id: "deepseek/deepseek-v4-flash-0731",
      canonical_slug: "deepseek/deepseek-v4-flash-20260731",
      created: 1_785_478_908,
      context_length: 1_048_576,
      top_provider: { max_completion_tokens: 384_000 },
      pricing: { prompt: "0.000000065", completion: "0.00000018" },
      supported_parameters: ["tools"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    main(["frontier-flash-attestation", catalogPath, attestationPath, "2026-08-30T12:00:00.000Z"]);

    expect(JSON.parse(readFileSync(attestationPath, "utf-8"))).toMatchObject({
      checked_at: "2026-08-30T12:00:00.000Z",
      source_url: "https://openrouter.ai/api/v1/model/deepseek/deepseek-v4-flash-0731",
      id: "deepseek/deepseek-v4-flash-0731",
      observed_metadata: { tool_calling: true, context_length: 1_048_576 },
    });
  });

  it("runs governance-friction through the real binary and writes JSON plus a denominator-explicit summary", () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-governance-friction-"));
    const fixturePath = join(outDir, "episodes.json");
    const reportPath = join(outDir, "reports", "friction.json");
    writeFileSync(fixturePath, JSON.stringify({
      schema: "arbor.governance-friction-fixture/v1",
      episodes: [{ task_id: "task-1", cohort_id: "offline", task_wall_time_ms: 1200,
        gate_latencies_ms: [12, 18], gate_refusals: 1, false_veto: null,
        operator_interventions: 1, recovery: "not_attempted", time_to_next_action_ms: 25 }],
    }));
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const result = spawnSync("bun", ["packages/arbor-eval/src/cli.ts", "governance-friction", fixturePath, reportPath], {
      cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, VITEST: "false" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
      schema: "arbor.governance-friction-report/v1",
      cohorts: [{ cohort_id: "offline", gate_count: 2, gate_refusal_rate: 0.5, evidence_linked_false_veto_rate: null, evidence_linked_unsubstantiated_task_count: 0 }],
    });
    const markdown = readFileSync(join(outDir, "reports", "friction.md"), "utf8");
    expect(markdown).toContain("evidence-linked false-veto rate uses asserted outcomes with both a reviewer ID and evidence reference");
    expect(markdown).toContain("unmeasured (0; 0 unsubstantiated)");
    expect(markdown).toContain("unmeasured (0; 0 unavailable)");
  });

  it("routes the historical native recorder through the real package entrypoint", () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-cli-legacy-native-"));
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const result = spawnSync(
      "bun",
      [
        "packages/arbor-eval/src/cli.ts",
        "frontier-interface",
        "record-original-interface-baseline",
        outDir,
        "f74b50548c0f23af959802e0bef88a4810bfc71f",
      ],
      { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, VITEST: "false" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      receipt: { source_revision: "f74b50548c0f23af959802e0bef88a4810bfc71f" },
      verification: { valid: true },
    });
  });

  it("writes a real report file to the given output directory and prints it to stdout", () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-cli-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    main(["--tasks", "2", "--runs", "1", "--max-iterations", "10", "--output", outDir]);

    const files = readdirSync(outDir).filter((f) => f.startsWith("report-") && f.endsWith(".md"));
    expect(files).toHaveLength(1);

    const written = readFileSync(join(outDir, files[0]), "utf-8");
    expect(written).toContain("Arbor Eval — Benchmark Report");
    expect(written).toContain("Methodology caveat");
    expect(written).toContain("## Timing");

    // The same content was printed to stdout (minus the timing footer's
    // exact numbers, which the log call includes verbatim too).
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain("Arbor Eval — Benchmark Report");
    expect(errSpy).toHaveBeenCalled();
  });

  it("writes a deterministic governed-scenario comparison only when a fixture is explicitly supplied", () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-cli-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = fileURLToPath(new URL("../fixtures/governed-loop-scenarios.json", import.meta.url));

    main(["--tasks", "1", "--runs", "1", "--max-iterations", "5", "--output", outDir, "--scenario-fixture", fixture]);

    const result = JSON.parse(readFileSync(join(outDir, "governed-scenarios.json"), "utf-8"));
    expect(result).toHaveLength(3);
    expect(result[0].governed.cost.provider_cost_usd).toBeNull();
  });

  it("writes advanced analytics into the canonical report and a machine-readable artifact", () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-cli-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = fileURLToPath(new URL("../fixtures/advanced-analytics.json", import.meta.url));
    main(["--tasks", "1", "--runs", "1", "--max-iterations", "5", "--output", outDir, "--analytics-fixture", fixture]);
    const report = readFileSync(join(outDir, readdirSync(outDir).find((entry) => entry.startsWith("report-"))!), "utf-8");
    const analytics = JSON.parse(readFileSync(join(outDir, "advanced-analytics.json"), "utf-8"));
    expect(report).toContain("## Advanced Evaluation Analytics");
    expect(analytics).toMatchObject({ schema: "arbor.eval-analytics-report/v1", provenance: { tag: "generated" }, agent_uct: { policy: { mode: "agent_uct" } } });
  });

  it("makes missing persisted ledger state explicit rather than silently substituting an empty ledger", () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-cli-"));
    const ledgerDir = mkdtempSync(join(tmpdir(), "arbor-eval-ledger-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = fileURLToPath(new URL("../fixtures/advanced-analytics.json", import.meta.url));
    main(["--tasks", "1", "--runs", "1", "--max-iterations", "5", "--output", outDir, "--analytics-fixture", fixture, "--reuse-ledger-dir", ledgerDir, "--reuse-ledger-id", "absent"]);
    const analytics = JSON.parse(readFileSync(join(outDir, "advanced-analytics.json"), "utf-8"));
    expect(analytics.reuse_ledger).toBeNull();
    expect(analytics.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_reuse_ledger" })]));
    expect(readFileSync(join(outDir, readdirSync(outDir).find((entry) => entry.startsWith("report-"))!), "utf-8"))
      .toContain("Analytics diagnostic [missing_reuse_ledger]");
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  it("emits a typed diagnostic when an on-disk reuse ledger is corrupt", () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-cli-"));
    const ledgerDir = mkdtempSync(join(tmpdir(), "arbor-eval-ledger-"));
    mkdirSync(join(ledgerDir, "eval-reuse-ledger"));
    writeFileSync(join(ledgerDir, "eval-reuse-ledger", "corrupt.json"), "not json");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = fileURLToPath(new URL("../fixtures/advanced-analytics.json", import.meta.url));
    main(["--tasks", "1", "--runs", "1", "--max-iterations", "5", "--output", outDir, "--analytics-fixture", fixture, "--reuse-ledger-dir", ledgerDir, "--reuse-ledger-id", "corrupt"]);
    const analytics = JSON.parse(readFileSync(join(outDir, "advanced-analytics.json"), "utf-8"));
    expect(analytics.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_json", path: expect.stringContaining("corrupt.json") })]));
    expect(readFileSync(join(outDir, readdirSync(outDir).find((entry) => entry.startsWith("report-"))!), "utf-8"))
      .toContain("Analytics diagnostic [invalid_json]");
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  it("defaults --tasks above the available count down to defaultTasks.length rather than erroring", () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-cli-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => main(["--tasks", "999", "--runs", "1", "--max-iterations", "5", "--output", outDir])).not.toThrow();
    expect(readdirSync(outDir).length).toBe(1);
  });

  it("exits 1 without writing a report when --tasks resolves to zero tasks selected", () => {
    outDir = mkdtempSync(join(tmpdir(), "arbor-eval-cli-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    expect(() => main(["--tasks", "0", "--output", outDir])).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(readdirSync(outDir)).toHaveLength(0);
  });
});
