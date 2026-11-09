import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadSourceMap, offsetToLineColumn, resolvePosition } from "../observation/sourcemap.mjs";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

// ADR-078 class C (live by design). vi-observe aggregates coverage against the
// symbols in `.visual-intelligence/graph/nodes.jsonl`, which is gitignored and
// produced by `vi:refresh`; with no graph every scenario still runs and exits 0
// but `observation_count` is 0, so tests asserting real observations fail for a
// missing input, not a defect. Skip those, and only those, when the graph is
// absent. The failure-injection and outcome-sink tests need no graph and run.
const itLiveGraph = it.skipIf(!existsSync(join(REPO_ROOT, ".visual-intelligence", "graph", "nodes.jsonl")));
const require_ = createRequire(import.meta.url);

const TMP = [];
function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `revoy2-${prefix}-`));
  TMP.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

function runViObserve({ env = {}, args = [] } = {}) {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "vi-observe.mjs"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// ---------------------------------------------------------------------------
// sourcemap.mjs — unit-level VLQ decoding, no compiler involved
// ---------------------------------------------------------------------------

describe("sourcemap.mjs — VLQ mapping decode", () => {
  it("decodes a hand-built single-segment map to the expected original position", () => {
    // One generated line, one segment: genColumn=0, sourceIndex=0, origLine=0, origColumn=0.
    // VLQ-base64 for [0,0,0,0] is "AAAA".
    const map = loadSourceMap({ version: 3, sources: ["a.ts"], mappings: "AAAA" });
    const pos = resolvePosition(map, 0, 0);
    expect(pos).toEqual({ source: "a.ts", line: 0, column: 0 });
  });

  it("resolves a mid-line offset to the last segment at or before it (range semantics, not exact match)", () => {
    // Two segments on line 0: col 0 -> orig (0,0); col 5 -> orig (0,10).
    // [0,0,0,0] = "AAAA"; delta to next segment [5,0,0,10] = "KAAU".
    const map = loadSourceMap({ version: 3, sources: ["a.ts"], mappings: "AAAA,KAAU" });
    expect(resolvePosition(map, 0, 3)).toEqual({ source: "a.ts", line: 0, column: 0 });
    expect(resolvePosition(map, 0, 5)).toEqual({ source: "a.ts", line: 0, column: 10 });
    expect(resolvePosition(map, 0, 100)).toEqual({ source: "a.ts", line: 0, column: 10 });
  });

  it("returns null for a generated line with no mapping segments", () => {
    const map = loadSourceMap({ version: 3, sources: ["a.ts"], mappings: "AAAA;;" });
    expect(resolvePosition(map, 1, 0)).toBeNull();
  });

  it("rejects an unsupported sourcemap version", () => {
    expect(() => loadSourceMap({ version: 2, sources: [], mappings: "" })).toThrow(/unsupported version/);
  });

  it("offsetToLineColumn walks plain ASCII text correctly", () => {
    const text = "abc\ndef\nghi";
    expect(offsetToLineColumn(text, 0)).toEqual({ line: 0, column: 0 });
    expect(offsetToLineColumn(text, 4)).toEqual({ line: 1, column: 0 });
    expect(offsetToLineColumn(text, 9)).toEqual({ line: 2, column: 1 });
  });
});

// ---------------------------------------------------------------------------
// THE EMPIRICAL QUESTION: are V8 coverage offsets UTF-16 code units or bytes?
//
// This is not asserted from documentation — it is re-verified here every run
// against a REAL V8 coverage report, exactly as it was first verified while
// building vi-observe.mjs (see sourcemap.mjs's header comment for the
// narrative). A multibyte fixture is compiled with this repository's own
// `typescript` package, executed under NODE_V8_COVERAGE, and the reported
// startOffset for a known function is walked BOTH ways; only the UTF-16
// interpretation may land on the function's own declaration.
// ---------------------------------------------------------------------------

describe("V8 coverage offset unit — empirical, not assumed", () => {
  it("resolves correctly as a UTF-16 code-unit offset and NOT as a UTF-8 byte offset", () => {
    const dir = fixture("mb-offset");
    const ts = require_("typescript");

    const source = [
      "// comment with multibyte chars: 日本語テスト emoji-pair",
      "const greeting = \"héllo wörld -- mB chars: 日本語\";",
      "export function coveredFn(x) {",
      "  return x + 1;",
      "}",
      "coveredFn(41);",
      "",
    ].join("\n");

    const transpiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: true },
      fileName: "fixture.ts",
    });

    const distPath = join(dir, "fixture.js");
    const mapPath = `${distPath}.map`;
    // transpileModule's sourceMapText names the input "module.ts" by default;
    // point it at this fixture's own name so sourcemap.mjs's normal dist-file
    // relative-path resolution logic is exercised unmodified.
    const mapObj = JSON.parse(transpiled.sourceMapText);
    mapObj.sources = ["fixture.ts"];
    const jsText = `${transpiled.outputText.replace(/\/\/# sourceMappingURL=.*$/m, "").trimEnd()}\n//# sourceMappingURL=fixture.js.map\n`;
    writeFileSync(distPath, jsText, "utf8");
    writeFileSync(mapPath, JSON.stringify(mapObj), "utf8");

    const coverageDir = join(dir, "coverage");
    mkdirSync(coverageDir, { recursive: true });
    const run = spawnSync(process.execPath, [distPath], {
      cwd: dir,
      env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
      encoding: "utf-8",
    });
    expect(run.status).toBe(0);

    const covFiles = require_("node:fs").readdirSync(coverageDir).filter((f) => f.endsWith(".json"));
    expect(covFiles.length).toBeGreaterThan(0);
    let startOffset = null;
    for (const f of covFiles) {
      const data = JSON.parse(readFileSync(join(coverageDir, f), "utf8"));
      const script = data.result.find((r) => r.url.endsWith("fixture.js"));
      if (!script) continue;
      const fn = script.functions.find((fn2) => fn2.functionName === "coveredFn");
      if (fn) startOffset = fn.ranges[0].startOffset;
    }
    expect(startOffset, "V8 must report coverage for coveredFn").not.toBeNull();

    const distText = readFileSync(distPath, "utf8");

    // UTF-16 code-unit interpretation (what offsetToLineColumn implements):
    // must land on the "function coveredFn" declaration text.
    const utf16Pos = offsetToLineColumn(distText, startOffset);
    const utf16Text = distText.slice(startOffset, startOffset + 24);
    expect(utf16Text).toContain("coveredFn");

    // UTF-8 BYTE interpretation: must NOT land on the same text (proves the
    // two interpretations genuinely diverge on this fixture, so the assertion
    // above is meaningful and not accidentally true for any offset).
    const buf = Buffer.from(distText, "utf8");
    const byteSlice = buf.subarray(startOffset, startOffset + 24).toString("utf8");
    expect(byteSlice).not.toContain("coveredFn");

    // And the full pipeline: resolve through the real sourcemap to the
    // original .ts position, which must land on coveredFn's own line.
    const map = loadSourceMap(readFileSync(mapPath, "utf8"));
    const original = resolvePosition(map, utf16Pos.line, utf16Pos.column);
    expect(original).not.toBeNull();
    const originalLine = source.split("\n")[original.line];
    expect(originalLine).toContain("coveredFn");
  });
});

// ---------------------------------------------------------------------------
// vi-observe.mjs — the producer, via failure injection (per the gate-failure-
// modes.test.mjs convention: a check never observed failing is not a check).
// ---------------------------------------------------------------------------

describe("vi-observe.mjs — can it actually fail?", () => {
  it("FAILS the whole run loudly when a scenario's real exit code does not match expected_exit", () => {
    const catalogDir = fixture("catalog-mismatch");
    const catalogPath = join(catalogDir, "scenarios.json");
    writeFileSync(catalogPath, JSON.stringify({
      schema_version: 1,
      scenarios: [{
        id: "help-wrong-exit",
        argv: ["node", "packages/arbor-mcp/dist/cli.js", "--help"],
        env: {},
        run_class: "production",
        timeout_ms: 10_000,
        expected_exit: 97,
      }],
    }));
    const storeDir = fixture("store-mismatch");
    const { code, out } = runViObserve({
      env: { REVOY2_VI_OBSERVE_CATALOG: catalogPath, REVOY2_VI_OBSERVED_DIR: storeDir },
    });
    expect(code).toBe(1);
    expect(out).toContain("expected 97");
    // A failed run must not leave a plausible-looking partial store behind.
    expect(existsSync(join(storeDir, "manifest.json"))).toBe(false);
  });

  it("REFUSES a catalog entry whose entry point is not a packages/*/dist/**.js file (bin/arbor-mcp.mjs forbidden)", () => {
    const catalogDir = fixture("catalog-bin-launcher");
    const catalogPath = join(catalogDir, "scenarios.json");
    writeFileSync(catalogPath, JSON.stringify({
      schema_version: 1,
      scenarios: [{
        id: "forbidden-bin-entry",
        argv: ["node", "packages/arbor-mcp/bin/arbor-mcp.mjs", "--help"],
        env: {},
        run_class: "production",
        timeout_ms: 10_000,
        expected_exit: 0,
      }],
    }));
    const { code, out } = runViObserve({
      env: { REVOY2_VI_OBSERVE_CATALOG: catalogPath, REVOY2_VI_OBSERVED_DIR: fixture("store-bin-launcher") },
    });
    expect(code).toBe(1);
    expect(out).toContain("not a packages/*/dist/**.js entry point");
  });

  it("REFUSES a catalog with a duplicate scenario id", () => {
    const catalogDir = fixture("catalog-dup");
    const catalogPath = join(catalogDir, "scenarios.json");
    const scenario = {
      id: "dup", argv: ["node", "packages/arbor-mcp/dist/cli.js", "--help"],
      env: {}, run_class: "production", timeout_ms: 10_000, expected_exit: 0,
    };
    writeFileSync(catalogPath, JSON.stringify({ schema_version: 1, scenarios: [scenario, scenario] }));
    const { code, out } = runViObserve({
      env: { REVOY2_VI_OBSERVE_CATALOG: catalogPath, REVOY2_VI_OBSERVED_DIR: fixture("store-dup") },
    });
    expect(code).toBe(1);
    expect(out).toContain("duplicate scenario id");
  });

  it("produces a real observed store from a minimal one-scenario catalog run against the real dist build", () => {
    const catalogDir = fixture("catalog-minimal");
    const catalogPath = join(catalogDir, "scenarios.json");
    writeFileSync(catalogPath, JSON.stringify({
      schema_version: 1,
      scenarios: [{
        id: "help-only",
        argv: ["node", "packages/arbor-mcp/dist/cli.js", "--help"],
        env: {},
        run_class: "production",
        timeout_ms: 10_000,
        expected_exit: 0,
      }],
    }));
    const storeDir = fixture("store-minimal");
    const { code, out } = runViObserve({
      env: { REVOY2_VI_OBSERVE_CATALOG: catalogPath, REVOY2_VI_OBSERVED_DIR: storeDir },
    });
    expect(code).toBe(0);
    expect(out).toContain("ran 1 scenario(s)");
    expect(existsSync(join(storeDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(storeDir, "observations.jsonl"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(storeDir, "manifest.json"), "utf8"));
    expect(manifest.scenario_count).toBe(1);
    expect(typeof manifest.catalog_content_hash).toBe("string");
  });

  it("isolates git_init fixtures from an ambient global hooksPath", () => {
    const catalogDir = fixture("catalog-git-hooks-isolation");
    const catalogPath = join(catalogDir, "scenarios.json");
    writeFileSync(catalogPath, JSON.stringify({
      schema_version: 1,
      scenarios: [{
        id: "help-with-isolated-git",
        argv: ["node", "packages/arbor-mcp/dist/cli.js", "--help"],
        env: {},
        run_class: "production",
        timeout_ms: 10_000,
        expected_exit: 0,
        git_init: true,
      }],
    }));
    const hostileHooks = fixture("hostile-global-hooks");
    writeFileSync(join(hostileHooks, "pre-commit"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
    const globalConfig = join(fixture("global-git-config"), "config");
    writeFileSync(globalConfig, `[core]\n\thooksPath = ${hostileHooks}\n`);
    const storeDir = fixture("store-git-hooks-isolation");

    const { code, out } = runViObserve({
      env: {
        GIT_CONFIG_GLOBAL: globalConfig,
        REVOY2_VI_OBSERVE_CATALOG: catalogPath,
        REVOY2_VI_OBSERVED_DIR: storeDir,
      },
    });
    expect(code).toBe(0);
    expect(out).toContain("ran 1 scenario(s)");
    expect(existsSync(join(storeDir, "manifest.json"))).toBe(true);
  });

  it("isolates nested git repositories created by a production scenario from ambient hooks", () => {
    const catalogDir = fixture("catalog-nested-git-hooks-isolation");
    const catalogPath = join(catalogDir, "scenarios.json");
    writeFileSync(catalogPath, JSON.stringify({
      schema_version: 1,
      scenarios: [{
        id: "liveness-with-isolated-nested-git",
        argv: ["node", "packages/arbor-mcp/dist/cli.js", "liveness", "--json"],
        env: {},
        // liveness-runner copies the active repository's decisions directory;
        // vi-observe scenarios run from an isolated empty cwd, so provide the
        // minimal directory shape the production composition root requires.
        seed_files: { "decisions/fixture.md": "# Isolated liveness fixture\n" },
        run_class: "production",
        timeout_ms: 20_000,
        expected_exit: 0,
      }],
    }));
    const hostileHooks = fixture("hostile-nested-global-hooks");
    writeFileSync(join(hostileHooks, "pre-commit"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
    const globalConfig = join(fixture("nested-global-git-config"), "config");
    writeFileSync(globalConfig, `[core]\n\thooksPath = ${hostileHooks}\n`);
    const storeDir = fixture("store-nested-git-hooks-isolation");

    const { code, out } = runViObserve({
      env: {
        GIT_CONFIG_GLOBAL: globalConfig,
        REVOY2_VI_OBSERVE_CATALOG: catalogPath,
        REVOY2_VI_OBSERVED_DIR: storeDir,
      },
    });
    expect(code).toBe(0);
    expect(out).toContain("ran 1 scenario(s)");
    expect(existsSync(join(storeDir, "manifest.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T5.3, 2026-08-23 remediation — outcome-aware observation + real-surface
// scenarios (hollow-parity.mjs items 2 and 4).
// ---------------------------------------------------------------------------

describe("outcome-aware observation (item 2): outcomes.jsonl", () => {
  itLiveGraph("records a `permission` outcome (not `validation`) for a real junior-tier-denied mutation over `arbor serve` stdio", () => {
    const catalogDir = fixture("catalog-outcome-permission");
    const catalogPath = join(catalogDir, "scenarios.json");
    const requestedAt = new Date().toISOString();
    const stdin = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vi-observe-test", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "arbor_command", params: { input: {
        kind: "session.identity.mutate", session_id: "vi-observe-test-cli-junior", display_name: "should not persist",
        provenance: { tag: "claimed", claimant: "vi-observe-test" },
        metadata: { operation_id: "vi-observe-test-cli-junior-op", idempotency_key: "vi-observe-test-cli-junior-op", correlation_id: "vi-observe-test-cli-junior-op", actor_id: "vi-observe-test", requested_at: requestedAt },
      } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "arbor_query", params: { input: { kind: "session.identity.get", session_id: "vi-observe-test-cli-junior" } } }),
      "",
    ].join("\n");
    writeFileSync(catalogPath, JSON.stringify({
      schema_version: 1,
      scenarios: [{
        id: "cli-junior-denied-mutation",
        argv: ["node", "packages/arbor-mcp/dist/cli.js", "serve", "--persistence-dir", ".arbor"],
        env: {},
        stdin,
        run_class: "cli",
        timeout_ms: 20_000,
        expected_exit: 0,
      }],
    }));
    const storeDir = fixture("store-outcome-permission");
    const { code, out } = runViObserve({
      env: { REVOY2_VI_OBSERVE_CATALOG: catalogPath, REVOY2_VI_OBSERVED_DIR: storeDir },
    });
    expect(code).toBe(0);
    expect(out).toContain("ran 1 scenario(s)");

    const manifest = JSON.parse(readFileSync(join(storeDir, "manifest.json"), "utf8"));
    expect(manifest.outcome_count).toBeGreaterThan(0);

    expect(existsSync(join(storeDir, "outcomes.jsonl"))).toBe(true);
    const outcomeRows = readFileSync(join(storeDir, "outcomes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const denial = outcomeRows.find((r) => r.scenario === "cli-junior-denied-mutation" && r.kind === "session.identity.mutate");
    expect(denial).toBeDefined();
    expect(denial.direction).toBe("command");
    // The point of this test: a caller_tier rejection is a `permission`
    // outcome, never `validation` — the two are different Hollow-shape
    // findings and hollow-parity.mjs item 2 depends on this distinction.
    expect(denial.code).toBe("permission");
    expect(typeof denial.summary).toBe("string");
    expect(denial.summary.length).toBeGreaterThan(0);

    // The read still succeeds — this scenario proves a denial, not a broken query path.
    expect(outcomeRows.some((r) => r.kind === "session.identity.get")).toBe(false);

    // Real coverage was collected too — this is a genuine dispatched scenario, not a stub.
    expect(existsSync(join(storeDir, "observations.jsonl"))).toBe(true);
    expect(manifest.observation_count).toBeGreaterThan(0);
  }, 30_000);

  it("[fixture] the outcome sink env var is a documented no-op when unset — a scenario with no ok:false router result writes zero outcome rows", () => {
    const catalogDir = fixture("catalog-outcome-none");
    const catalogPath = join(catalogDir, "scenarios.json");
    writeFileSync(catalogPath, JSON.stringify({
      schema_version: 1,
      scenarios: [{
        id: "help-no-outcome",
        argv: ["node", "packages/arbor-mcp/dist/cli.js", "--help"],
        env: {},
        run_class: "production",
        timeout_ms: 10_000,
        expected_exit: 0,
      }],
    }));
    const storeDir = fixture("store-outcome-none");
    const { code } = runViObserve({ env: { REVOY2_VI_OBSERVE_CATALOG: catalogPath, REVOY2_VI_OBSERVED_DIR: storeDir } });
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(storeDir, "manifest.json"), "utf8"));
    expect(manifest.outcome_count).toBe(0);
    expect(readFileSync(join(storeDir, "outcomes.jsonl"), "utf8")).toBe("");
  });
});

describe("real-surface scenarios (item 4): TUI keyboard, CLI stdio junior-tier, webui HTTP", () => {
  itLiveGraph("TUI over real stdin (\\, 1, PageDown, Down, R) drives packages/arbor-tui coverage — same chord pattern as tui-keyboard-scrolling.test.ts", () => {
    const catalogDir = fixture("catalog-tui-keys");
    const catalogPath = join(catalogDir, "scenarios.json");
    const ESC = "";
    const stdin = `\\1${ESC}[6~${ESC}[BR`;
    writeFileSync(catalogPath, JSON.stringify({
      schema_version: 1,
      scenarios: [{
        id: "tui-scroll-and-select",
        argv: ["node", "packages/arbor-mcp/dist/cli.js", "tui", "--renderer", "stdout"],
        env: {},
        stdin,
        run_class: "tui",
        timeout_ms: 20_000,
        expected_exit: 0,
      }],
    }));
    const storeDir = fixture("store-tui-keys");
    const { code, out } = runViObserve({ env: { REVOY2_VI_OBSERVE_CATALOG: catalogPath, REVOY2_VI_OBSERVED_DIR: storeDir } });
    expect(code).toBe(0);
    expect(out).toContain("ran 1 scenario(s)");
    const manifest = JSON.parse(readFileSync(join(storeDir, "manifest.json"), "utf8"));
    expect(manifest.observation_count).toBeGreaterThan(0);
    const observationRows = readFileSync(join(storeDir, "observations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(observationRows.some((r) => r.scenario_id === "tui-scroll-and-select")).toBe(true);
  }, 30_000);

  itLiveGraph("webui over real HTTP hits an unknown-campaign 404 and a malformed-JSON 400, plus a live SSE stream, and shuts down cleanly on SIGINT", () => {
    const catalogDir = fixture("catalog-webui-http");
    const catalogPath = join(catalogDir, "scenarios.json");
    writeFileSync(catalogPath, JSON.stringify({
      schema_version: 1,
      scenarios: [{
        id: "webui-http-surface",
        argv: ["node", "packages/arbor-mcp/dist/cli.js", "webui", "0"],
        env: {},
        run_class: "web",
        timeout_ms: 20_000,
        expected_exit: 0,
        http_probe: {
          ready_pattern: "operator session: http://127\\.0\\.0\\.1:(\\d+)/\\?operator_token=([A-Za-z0-9_-]+)",
          bootstrap_operator_session: true,
          requests: [
            { method: "GET", path: "/" },
            { method: "GET", path: "/api/campaigns" },
            { method: "GET", path: "/api/campaigns/vi-observe-test-no-such-campaign" },
            { method: "GET", path: "/api/stream", sse: true, wait_ms: 150 },
            { method: "POST", path: "/api/runtime/query", body: "{not valid json" },
          ],
          shutdown_signal: "SIGINT",
        },
      }],
    }));
    const storeDir = fixture("store-webui-http");
    const { code, out } = runViObserve({ env: { REVOY2_VI_OBSERVE_CATALOG: catalogPath, REVOY2_VI_OBSERVED_DIR: storeDir } });
    expect(code).toBe(0);
    expect(out).toContain("ran 1 scenario(s)");
    const manifest = JSON.parse(readFileSync(join(storeDir, "manifest.json"), "utf8"));
    expect(manifest.observation_count).toBeGreaterThan(0);
    const observationRows = readFileSync(join(storeDir, "observations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(observationRows.some((r) => r.scenario_id === "webui-http-surface")).toBe(true);
  }, 30_000);

  it("REFUSES an http_probe scenario missing ready_pattern or an array of requests", () => {
    const catalogDir = fixture("catalog-http-probe-invalid");
    const catalogPath = join(catalogDir, "scenarios.json");
    writeFileSync(catalogPath, JSON.stringify({
      schema_version: 1,
      scenarios: [{
        id: "bad-http-probe",
        argv: ["node", "packages/arbor-mcp/dist/cli.js", "webui", "0"],
        env: {},
        run_class: "web",
        timeout_ms: 10_000,
        expected_exit: 0,
        http_probe: { ready_pattern: "running at http://localhost:(\\d+)", requests: null },
      }],
    }));
    const { code, out } = runViObserve({ env: { REVOY2_VI_OBSERVE_CATALOG: catalogPath, REVOY2_VI_OBSERVED_DIR: fixture("store-http-probe-invalid") } });
    expect(code).toBe(1);
    expect(out).toContain("http_probe.requests must be an array");
  });
});

describe("paced stdin (stdin_await_response): a request must see the state a prior request left", () => {
  it("REFUSES stdin_await_response without stdin and stdin_linger_ms", () => {
    const catalogDir = fixture("catalog-line-gap-invalid");
    const catalogPath = join(catalogDir, "scenarios.json");
    writeFileSync(catalogPath, JSON.stringify({
      schema_version: 1,
      scenarios: [{
        id: "bad-line-gap",
        argv: ["node", "packages/arbor-mcp/dist/cli.js", "--help"],
        env: {},
        stdin: "a\nb\n",
        stdin_await_response: true,
        run_class: "production",
        timeout_ms: 10_000,
        expected_exit: 0,
      }],
    }));
    const { code, out } = runViObserve({ env: { REVOY2_VI_OBSERVE_CATALOG: catalogPath, REVOY2_VI_OBSERVED_DIR: fixture("store-line-gap-invalid") } });
    expect(code).toBe(1);
    expect(out).toContain("stdin_await_response requires stdin and stdin_linger_ms");
  });

  itLiveGraph("the committed taskcomposer retry scenario reaches resetIntentTurn only because its two retries are paced", () => {
    const real = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "observation", "scenarios.json"), "utf8"));
    const scenario = real.scenarios.find((s) => s.id === "production-taskcomposer-retry-resets-intent-turn");
    expect(scenario.stdin_await_response).toBe(true);
    const catalogDir = fixture("catalog-paced-retry");
    const catalogPath = join(catalogDir, "scenarios.json");
    writeFileSync(catalogPath, JSON.stringify({ schema_version: 1, scenarios: [scenario] }));
    const storeDir = fixture("store-paced-retry");
    const { code } = runViObserve({ env: { REVOY2_VI_OBSERVE_CATALOG: catalogPath, REVOY2_VI_OBSERVED_DIR: storeDir } });
    expect(code).toBe(0);
    const rows = readFileSync(join(storeDir, "observations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.some((r) => r.symbol_id.endsWith("intent-admission.ts::resetIntentTurn"))).toBe(true);
  }, 60_000);
});
