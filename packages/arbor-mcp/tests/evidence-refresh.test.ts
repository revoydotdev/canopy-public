import { describe, expect, it } from "vitest";
import { runEvidenceRefresh, SUITE_CHECK_EXCLUSIONS, failuresAreAllUnclearable, extractFailingFiles, type CommandOutcome, type EvidenceRefreshRunner } from "../src/native-tools/evidence-refresh.js";

/**
 * `runEvidenceRefresh`'s only external seam is the `run` callback
 * (`EvidenceRefreshRunner`); these fakes return exactly the
 * `{ ok, exit_code, output }` shape the real sandbox-backed runner in
 * `native-tool-host.ts` produces (see `evidenceRefresh`'s `runner`), so the
 * double matches the real contract rather than a convenient stand-in for it.
 */
function freshnessReportOutput(states: Readonly<Record<string, "ok" | "fail">>): string {
  const names = ["claim-ledger", "determinism-baseline", "completion-depth", "vi-observed"] as const;
  return JSON.stringify({
    ok: Object.values(states).every((state) => state === "ok"),
    stores: names.map((name) => ({ name, state: states[name] ?? "ok", detail: states[name] === "fail" ? `${name} trails HEAD` : `${name} is fresh`, refresh: `bun run ${name}:refresh` })),
  });
}

type RecordedResponse = CommandOutcome | readonly CommandOutcome[];

function recordingRunner(responses: ReadonlyMap<string, RecordedResponse>, calls: string[][]): EvidenceRefreshRunner {
  const queued = new Map([...responses].map(([key, response]) => [key, Array.isArray(response) ? [...response] : [response]]));
  return async (argv) => {
    calls.push([...argv]);
    const key = argv.join(" ");
    const response = queued.get(key)?.shift();
    if (response === undefined) throw new Error(`unexpected command in test double: ${key}`);
    return response;
  };
}

describe("runEvidenceRefresh", () => {
  it("auto scope refreshes only the stores the freshness gate reports stale", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome | CommandOutcome[]>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "claim-ledger": "fail", "completion-depth": "ok", "vi-observed": "ok", "determinism-baseline": "ok" }) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run claims:refresh", { ok: true, exit_code: 0, output: "claim ledger refreshed" }],
    ]);
    const result = await runEvidenceRefresh({ scope: "auto" }, { run: recordingRunner(responses, calls) });

    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    const claimLedger = result.stores.find((s) => s.name === "claim-ledger")!;
    expect(claimLedger.action).toBe("refreshed");
    expect(claimLedger.stale).toBe(true);
    for (const name of ["completion-depth", "vi-observed", "determinism-baseline"] as const) {
      const store = result.stores.find((s) => s.name === name)!;
      expect(store.action).toBe("skipped");
      expect(store.stale).toBe(false);
    }
    // Only the two staleness instruments and the one stale store's refresh
    // command ran — nothing else, and the graph check precedes the refresh.
    expect(calls.map((c) => c.join(" "))).toEqual([
      "bun scripts/store-freshness-gate.mjs --json",
      "bun run gate:vi-freshness",
      "bun run gate:vi-reproducible",
      "bun run claims:refresh",
    ]);
    expect(result.commit_before_verify_note).toMatch(/COMMITTED/);
  });

  /**
   * Constraint 3 — completion-depth and vi-observed read the VI graph, so a
   * store refreshed before the graph is regenerated was computed from a stale
   * graph. Observed for real on 2026-08-15: a refresh-then-commit came back
   * red against a clean working tree. The stores' content hash now covers
   * the graph's inputs rather than its bytes (store-provenance.mjs,
   * GRAPH_CONSUMING_STORES), so this ordering is the guard for that case.
   */
  it("regenerates a stale graph BEFORE any store, so the refresh is not immediately invalidated", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome | CommandOutcome[]>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "claim-ledger": "fail", "completion-depth": "fail", "vi-observed": "fail" }) }],
      ["bun run gate:vi-freshness", [
        { ok: false, exit_code: 1, output: "graph is 129 commits behind HEAD, above the budget of 25" },
        { ok: true, exit_code: 0, output: "graph is current" },
      ]],
      ["bun run vi:refresh", { ok: true, exit_code: 0, output: "graph regenerated" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run vi:observe", { ok: true, exit_code: 0, output: "runtime observations refreshed" }],
      ["bun run claims:refresh", { ok: true, exit_code: 0, output: "claim ledger refreshed" }],
      ["bun run completion-depth:refresh", { ok: true, exit_code: 0, output: "completion depth refreshed" }],
      ["bun run test", { ok: true, exit_code: 0, output: "all tests passed" }],
      ["bun run determinism:refresh", { ok: true, exit_code: 0, output: "determinism refreshed" }],
    ]);
    const result = await runEvidenceRefresh({ scope: "auto" }, { run: recordingRunner(responses, calls) });

    expect(result.ok).toBe(true);
    expect(result.graph_precheck!.action).toBe("refreshed");
    const sequence = calls.map((c) => c.join(" "));
    // The ordering IS the guarantee: vi:refresh strictly precedes every store.
    expect(sequence.indexOf("bun run vi:refresh")).toBeLessThan(sequence.indexOf("bun run vi:observe"));
    expect(sequence.indexOf("bun run vi:refresh")).toBeLessThan(sequence.indexOf("bun run claims:refresh"));
    expect(sequence.indexOf("bun run vi:refresh")).toBeLessThan(sequence.indexOf("bun run completion-depth:refresh"));
    // Observations are themselves an input to the downstream stores.
    expect(sequence.indexOf("bun run vi:observe")).toBeLessThan(sequence.indexOf("bun run claims:refresh"));
    expect(sequence.indexOf("bun run vi:observe")).toBeLessThan(sequence.indexOf("bun run completion-depth:refresh"));
  });

  it("does not regenerate a current graph, which would needlessly stale every store", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "claim-ledger": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run claims:refresh", { ok: true, exit_code: 0, output: "claim ledger refreshed" }],
    ]);
    const result = await runEvidenceRefresh({ scope: "auto" }, { run: recordingRunner(responses, calls) });

    expect(result.graph_precheck!.action).toBe("skipped");
    expect(result.graph_precheck!.stale).toBe(false);
    expect(calls.map((c) => c.join(" "))).not.toContain("bun run vi:refresh");
  });

  it("regenerates a commit-fresh graph when its bytes do not reproduce", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome | CommandOutcome[]>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "claim-ledger": "fail" }) }],
      ["bun run gate:vi-freshness", [
        { ok: true, exit_code: 0, output: "graph is within its commit budget" },
        { ok: true, exit_code: 0, output: "graph is current" },
      ]],
      ["bun run gate:vi-reproducible", [
        { ok: false, exit_code: 1, output: "graph differs from current source" },
        { ok: true, exit_code: 0, output: "graph reproduces" },
      ]],
      ["bun run vi:refresh", { ok: true, exit_code: 0, output: "graph regenerated" }],
      ["bun run vi:observe", { ok: true, exit_code: 0, output: "observations regenerated" }],
      ["bun run claims:refresh", { ok: true, exit_code: 0, output: "claim ledger refreshed" }],
      ["bun run completion-depth:refresh", { ok: true, exit_code: 0, output: "completion depth refreshed" }],
      ["bun run test", { ok: true, exit_code: 0, output: "all tests passed" }],
      ["bun run determinism:refresh", { ok: true, exit_code: 0, output: "determinism refreshed" }],
    ]);

    const result = await runEvidenceRefresh({ scope: "auto" }, { run: recordingRunner(responses, calls) });
    const sequence = calls.map((call) => call.join(" "));

    expect(result.graph_precheck!.action).toBe("refreshed");
    expect(result.stores.filter((store) => store.name !== "determinism-baseline").every((store) => store.action === "refreshed")).toBe(true);
    expect(result.stores.find((store) => store.name === "determinism-baseline")?.action).toBe("skipped");
    expect(sequence).not.toContain("bun run determinism:refresh");
    expect(sequence.indexOf("bun run gate:vi-reproducible")).toBeLessThan(sequence.indexOf("bun run vi:refresh"));
    expect(sequence.indexOf("bun run vi:refresh")).toBeLessThan(sequence.indexOf("bun run vi:observe"));
    expect(sequence.indexOf("bun run vi:refresh")).toBeLessThan(sequence.indexOf("bun run claims:refresh"));
  });

  it("reports a failed graph pre-step as a real failure, since stores refreshed after it may already be stale", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "claim-ledger": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: false, exit_code: 1, output: "graph is behind HEAD" }],
      ["bun run vi:refresh", { ok: false, exit_code: 1, output: "vi-refresh exploded" }],
    ]);
    const result = await runEvidenceRefresh({ scope: "auto" }, { run: recordingRunner(responses, calls) });

    expect(result.graph_precheck!.action).toBe("failed");
    expect(result.graph_precheck!.detail).toContain("vi-refresh exploded");
    expect(result.ok).toBe(false); // never a false green
    expect(result.stores.find((store) => store.name === "claim-ledger")!.action).toBe("refused");
    expect(calls.map((call) => call.join(" "))).not.toContain("bun run claims:refresh");
    // The remedy list is an ordered script: the graph command must lead.
    expect(result.remedy_commands[0]).toBe("bun run vi:refresh");
  });

  it("rejects a dirty-input graph even when vi:refresh exits zero, before any store refresh", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, RecordedResponse>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "claim-ledger": "fail" }) }],
      ["bun run gate:vi-freshness", [
        { ok: false, exit_code: 1, output: "graph is stale" },
        { ok: false, exit_code: 1, output: "graph was built from a dirty working tree" },
      ]],
      ["bun run vi:refresh", { ok: true, exit_code: 0, output: "graph regenerated from dirty inputs" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph structure reproduces" }],
    ]);

    const result = await runEvidenceRefresh({ scope: "auto" }, { run: recordingRunner(responses, calls) });

    expect(result.graph_precheck).toMatchObject({ action: "failed" });
    expect(result.ok).toBe(false);
    expect(result.stores.find((store) => store.name === "claim-ledger")!.action).toBe("refused");
    expect(calls.map((call) => call.join(" "))).toEqual([
      "bun scripts/store-freshness-gate.mjs --json",
      "bun run gate:vi-freshness",
      "bun run vi:refresh",
      "bun run gate:vi-freshness",
      "bun run gate:vi-reproducible",
    ]);
  });

  it("dry_run reports the plan and executes no refresh or suite commands", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "claim-ledger": "fail", "determinism-baseline": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
    ]);
    const result = await runEvidenceRefresh({ scope: "auto", dry_run: true }, { run: recordingRunner(responses, calls) });

    expect(result.dry_run).toBe(true);
    expect(result.stores.find((s) => s.name === "claim-ledger")!.action).toBe("would_refresh");
    expect(result.stores.find((s) => s.name === "determinism-baseline")!.action).toBe("skipped");
    expect(result.suite_check.ran).toBe(false);
    // Only the two read-only staleness instruments ran — the "would" plan
    // never executes, including the graph pre-step.
    expect(calls.map((c) => c.join(" "))).toEqual([
      "bun scripts/store-freshness-gate.mjs --json",
      "bun run gate:vi-freshness",
      "bun run gate:vi-reproducible",
    ]);
  });

  it("refuses the determinism-baseline refresh when the single-pass suite check is red, but still performs other refreshes", async () => {
    const calls: string[][] = [];
    const vitestFailureOutput = "RUN  v1.0.0\n\n FAIL  packages/arbor-mcp/tests/broken.test.ts > widget breaks\nAssertionError: expected 1 to be 2\n\n Test Files  1 failed | 12 passed (13)\n";
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "claim-ledger": "fail", "determinism-baseline": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run claims:refresh", { ok: true, exit_code: 0, output: "claim ledger refreshed" }],
      ["bun run test", { ok: false, exit_code: 1, output: vitestFailureOutput }],
    ]);
    const result = await runEvidenceRefresh({ scope: ["claim-ledger", "determinism-baseline"] }, { run: recordingRunner(responses, calls) });

    expect(result.ok).toBe(false); // requested work is incomplete, even when refusal is mechanically correct
    const determinism = result.stores.find((s) => s.name === "determinism-baseline")!;
    expect(determinism.action).toBe("refused");
    expect(determinism.reason).toMatch(/red/);
    expect(determinism.failing_tests).toContain("packages/arbor-mcp/tests/broken.test.ts > widget breaks");
    expect(result.suite_check.ran).toBe(true);
    expect(result.suite_check.green).toBe(false);
    // The independently-stale claim-ledger store still refreshed despite the red suite.
    expect(result.stores.find((s) => s.name === "claim-ledger")!.action).toBe("refreshed");
    // determinism:refresh itself must never have been invoked.
    expect(calls.map((c) => c.join(" "))).not.toContain("bun run determinism:refresh");
    expect(result.remedy_commands).toContain("bun run determinism:refresh");
  });

  it("runs determinism:refresh once the suite check reports green", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: true, exit_code: 0, output: freshnessReportOutput({ "determinism-baseline": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run test", { ok: true, exit_code: 0, output: "Test Files  13 passed (13)" }],
      ["bun run determinism:refresh", { ok: true, exit_code: 0, output: "baseline captured" }],
    ]);
    const result = await runEvidenceRefresh({ scope: ["determinism-baseline"] }, { run: recordingRunner(responses, calls) });

    expect(result.suite_check.green).toBe(true);
    const determinism = result.stores.find((s) => s.name === "determinism-baseline")!;
    expect(determinism.action).toBe("refreshed");
    expect(calls.map((c) => c.join(" "))).toEqual([
      "bun scripts/store-freshness-gate.mjs --json",
      "bun run gate:vi-freshness",
      "bun run gate:vi-reproducible",
      "bun run test",
      "bun run determinism:refresh",
    ]);
  });

  it("gives the suite check thirty minutes by default and preserves an explicit timeout override", async () => {
    const calls: Array<{ readonly command: string; readonly timeoutMs: number }> = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: true, exit_code: 0, output: freshnessReportOutput({ "determinism-baseline": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run test", { ok: true, exit_code: 0, output: "Test Files  13 passed (13)" }],
      ["bun run determinism:refresh", { ok: true, exit_code: 0, output: "baseline captured" }],
    ]);
    const run: EvidenceRefreshRunner = async (argv, timeoutMs) => {
      const command = argv.join(" ");
      calls.push({ command, timeoutMs });
      const response = responses.get(command);
      if (response === undefined) throw new Error(`unexpected command in test double: ${command}`);
      return response;
    };

    await runEvidenceRefresh({ scope: ["determinism-baseline"] }, { run });
    expect(calls.find((call) => call.command === "bun run test")!.timeoutMs).toBe(1_800_000);

    calls.length = 0;
    await runEvidenceRefresh({ scope: ["determinism-baseline"] }, { run, suiteCheckTimeoutMs: 45_000 });
    expect(calls.find((call) => call.command === "bun run test")!.timeoutMs).toBe(45_000);
  });

  it("reports a failed refresh script honestly rather than claiming success", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "completion-depth": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run completion-depth:refresh", { ok: false, exit_code: 3, output: "Error: docs-truth report missing" }],
    ]);
    const result = await runEvidenceRefresh({ scope: "auto" }, { run: recordingRunner(responses, calls) });

    const store = result.stores.find((s) => s.name === "completion-depth")!;
    expect(store.action).toBe("failed");
    expect(store.output).toContain("docs-truth report missing");
    expect(store.reason).toMatch(/exited 3/);
    expect(result.ok).toBe(false);
  });

  it("all scope refreshes every automatic store while keeping determinism manual", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: true, exit_code: 0, output: freshnessReportOutput({}) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run claims:refresh", { ok: true, exit_code: 0, output: "" }],
      ["bun run completion-depth:refresh", { ok: true, exit_code: 0, output: "" }],
      ["bun run vi:observe", { ok: true, exit_code: 0, output: "" }],
      ["bun run test", { ok: true, exit_code: 0, output: "" }],
      ["bun run determinism:refresh", { ok: true, exit_code: 0, output: "" }],
    ]);
    const result = await runEvidenceRefresh({ scope: "all" }, { run: recordingRunner(responses, calls) });

    expect(result.stores.filter((s) => s.name !== "determinism-baseline").every((s) => s.action === "refreshed")).toBe(true);
    expect(result.stores.find((s) => s.name === "determinism-baseline")?.action).toBe("skipped");
    expect(calls.some((argv) => argv.join(" ") === "bun run determinism:refresh")).toBe(false);
    expect(calls.some((argv) => argv.join(" ") === "bun run test")).toBe(false);
  });

  it("returns a typed error rather than a bare string when the scope names an unknown store", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: true, exit_code: 0, output: freshnessReportOutput({}) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
    ]);
    const result = await runEvidenceRefresh({ scope: ["not-a-real-store" as never] }, { run: recordingRunner(responses, calls) });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown store/);
    expect(result.stores).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("returns a typed error when the freshness gate output cannot be parsed", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: "not json at all" }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
    ]);
    const result = await runEvidenceRefresh({ scope: "auto" }, { run: recordingRunner(responses, calls) });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be read/);
  });
});

/**
 * Real vitest output renders every failure TWICE — a `×` line carrying only
 * the describe/test name, and a `FAIL` line carrying `<file> > <test>`. The
 * first draft of these doubles emitted only the `FAIL` form, so a predicate
 * that broke on the `×` lines passed the suite and failed in production.
 * These fixtures carry both, matching what `bun run test` actually prints.
 */
const REAL_SHAPE_UNCLEARABLE = [
  "   \u00d7 the gates agree with themselves on a clean tree > store-freshness-gate.mjs exits 0 against the real, committed stores 137ms",
  " FAIL  scripts/tests/gate-failure-modes.test.mjs > the gates agree with themselves on a clean tree > store-freshness-gate.mjs exits 0 against the real, committed stores",
].join("\n");

const REAL_SHAPE_OTHER = [
  "   \u00d7 selects the highest-UCT node 4ms",
  " FAIL  packages/arbor-core/tests/tree.test.ts > selects the highest-UCT node",
].join("\n");

/**
 * The SAME failure, as vitest actually renders it when it colorizes — copied
 * from a real captured run, escape sequences and all. The uncoloured fixtures
 * above are the tidy rendering; this is the one that shipped a false refusal.
 */
const REAL_SHAPE_COLOURED = [
  "\u001B[31m\u001B[1m\u001B[7m FAIL \u001B[27m\u001B[22m\u001B[39m scripts/tests/gate-failure-modes.test.mjs\u001B[2m > \u001B[22mthe gates agree with themselves on a clean tree\u001B[2m > \u001B[22mstore-freshness-gate.mjs exits 0 against the real, committed stores",
].join("\n");

describe("ADR-079 — the parser must read vitest's REAL rendering, not a tidy one", () => {
  it("REGRESSION: a COLOURED FAIL line still yields its file path", () => {
    // Vitest colorizes depending on how the subprocess was spawned. A coloured
    // FAIL line begins with an escape sequence rather than whitespace, so the
    // anchored match found nothing, failuresAreAllUnclearable([]) returned
    // false, and the tool REFUSED over a red set consisting entirely of
    // assertions it cannot clear — the exact deadlock ADR-079 exists to
    // prevent, reintroduced one layer down.
    expect(extractFailingFiles(REAL_SHAPE_COLOURED)).toEqual(["scripts/tests/gate-failure-modes.test.mjs"]);
    expect(failuresAreAllUnclearable(extractFailingFiles(REAL_SHAPE_COLOURED))).toBe(true);
  });

  it("the coloured and uncoloured renderings of one failure agree", () => {
    // If these ever diverge, one of the two fixtures has stopped matching what
    // vitest emits — which is how both bugs in this parser got shipped.
    expect(extractFailingFiles(REAL_SHAPE_COLOURED)).toEqual(extractFailingFiles(REAL_SHAPE_UNCLEARABLE));
  });

  it("an empty failure set is NOT treated as unclearable", () => {
    // The safe direction: parsing nothing must never be read as "everything is
    // excluded", or a parser bug becomes a silent bypass instead of a refusal.
    expect(failuresAreAllUnclearable([])).toBe(false);
  });
});

describe("ADR-079 — a precondition must be satisfiable by the action it gates", () => {
  /**
   * The deadlock this closes, reproduced from the real 2026-08-18 incident:
   * `.determinism-baseline` is stale, which makes gate-failure-modes'
   * committed-store assertion red, which refuses the refresh that would fix it.
   * The tool never commits (constraint 2), so nothing it can do clears that
   * test — it is an unsatisfiable precondition, not a safety check.
   */
  function determinismStaleWithSuite(suite: CommandOutcome, calls: string[][]) {
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "claim-ledger": "ok", "completion-depth": "ok", "vi-observed": "ok", "determinism-baseline": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run test", suite],
      ["bun run determinism:refresh", { ok: true, exit_code: 0, output: "determinism baseline measured" }],
    ]);
    return runEvidenceRefresh({ scope: ["determinism-baseline"] }, { run: recordingRunner(responses, calls) });
  }

  it("proceeds when the ONLY red test is one this action cannot clear", async () => {
    const calls: string[][] = [];
    const result = await determinismStaleWithSuite(
      { ok: false, exit_code: 1, output: REAL_SHAPE_UNCLEARABLE },
      calls,
    );
    const determinism = result.stores.find((s) => s.name === "determinism-baseline")!;
    expect(determinism.action).toBe("refreshed");
    expect(calls.some((c) => c.join(" ") === "bun run determinism:refresh")).toBe(true);
  });

  it("still reports the suite as red — it does not relabel it green to justify proceeding", async () => {
    const calls: string[][] = [];
    const result = await determinismStaleWithSuite(
      { ok: false, exit_code: 1, output: REAL_SHAPE_UNCLEARABLE },
      calls,
    );
    expect(result.suite_check.green).toBe(false);
    expect(result.suite_check.detail).toMatch(/cannot clear/i);
    expect(result.suite_check.detail).toMatch(/ADR-079/);
  });

  it("still refuses when any OTHER test is red", async () => {
    const calls: string[][] = [];
    const result = await determinismStaleWithSuite(
      { ok: false, exit_code: 1, output: REAL_SHAPE_OTHER },
      calls,
    );
    const determinism = result.stores.find((s) => s.name === "determinism-baseline")!;
    expect(determinism.action).toBe("refused");
    expect(calls.some((c) => c.join(" ") === "bun run determinism:refresh")).toBe(false);
  });

  it("still refuses on a MIXED failure set — one unclearable test does not excuse the others", async () => {
    const calls: string[][] = [];
    const result = await determinismStaleWithSuite(
      { ok: false, exit_code: 1, output: `${REAL_SHAPE_UNCLEARABLE}\n${REAL_SHAPE_OTHER}` },
      calls,
    );
    expect(result.stores.find((s) => s.name === "determinism-baseline")!.action).toBe("refused");
  });

  it("still refuses when the suite is red but named no test — unparsed is not excused", async () => {
    // The dangerous default: an empty failure set must never read as
    // "nothing unclearable failed, therefore proceed".
    const calls: string[][] = [];
    const result = await determinismStaleWithSuite(
      { ok: false, exit_code: 1, output: "vitest crashed before reporting" },
      calls,
    );
    expect(result.stores.find((s) => s.name === "determinism-baseline")!.action).toBe("refused");
  });
});

describe("ADR-079 — the exclusion set is declared and cannot grow silently", () => {
  it("contains exactly its one declared member, each carrying a reason", () => {
    // ADR-079 states growth here is a signal to re-examine, not a routine
    // edit. This pins that: adding an exclusion fails until someone updates
    // this assertion deliberately, which is the forcing function.
    expect(SUITE_CHECK_EXCLUSIONS.map((e) => e.match)).toEqual(["gate-failure-modes.test.mjs"]);
    for (const entry of SUITE_CHECK_EXCLUSIONS) {
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  it("an empty failure set is never unclearable", () => {
    expect(failuresAreAllUnclearable([])).toBe(false);
  });
});

describe("register item 11 (2026-08-24) — design choice: option (b), not (a) or (c)", () => {
  /**
   * The chosen fix (ADR-079's SUITE_CHECK_EXCLUSIONS, already in place before
   * this register item) is deliberately an ORCHESTRATOR-level tolerance, not
   * a change to `gate-failure-modes.test.mjs` itself. That file is untouched
   * by this register item, which means its "the gates agree with themselves"
   * block stays EXACTLY as strict outside a transaction as it is inside one —
   * there is no `REVOY_EVIDENCE_TRANSACTION_ID`-conditioned softening for this
   * predicate to have. This test pins that by construction: whether
   * `transaction_snapshot` is set or not, an unclearable suite failure is
   * treated identically. (`transaction_snapshot` DOES change one unrelated
   * thing — `runGraphPrecheck`'s post-refresh freshness re-check, which is a
   * different constraint (3) with its own tests above.)
   */
  function determinismStaleWithUnclearableSuite(calls: string[][]) {
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "determinism-baseline": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run test", { ok: false, exit_code: 1, output: REAL_SHAPE_UNCLEARABLE }],
      ["bun run determinism:refresh", { ok: true, exit_code: 0, output: "determinism baseline measured" }],
    ]);
    return { run: recordingRunner(responses, calls) };
  }

  it("proceeds identically whether or not transaction_snapshot is set", async () => {
    const outsideCalls: string[][] = [];
    const outside = await runEvidenceRefresh({ scope: ["determinism-baseline"] }, determinismStaleWithUnclearableSuite(outsideCalls));
    const insideCalls: string[][] = [];
    const inside = await runEvidenceRefresh({ scope: ["determinism-baseline"], transaction_snapshot: true }, determinismStaleWithUnclearableSuite(insideCalls));

    for (const result of [outside, inside]) {
      expect(result.stores.find((s) => s.name === "determinism-baseline")!.action).toBe("refreshed");
      expect(result.suite_check.green).toBe(false); // still reported honestly, never relabeled
    }
  });
});

describe("register item 11 (2026-08-24) — refusal legibility names the producer chain", () => {
  it("graph_precheck failure names the post-commit recovery and the ordered producer chain", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "claim-ledger": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: false, exit_code: 1, output: "graph is behind HEAD" }],
      ["bun run vi:refresh", { ok: false, exit_code: 1, output: "vi-refresh exploded" }],
    ]);
    const result = await runEvidenceRefresh({ scope: "auto" }, { run: recordingRunner(responses, calls) });

    expect(result.graph_precheck!.detail).toMatch(/after a source commit/i);
    expect(result.graph_precheck!.detail).toContain("bun run vi:refresh && bun run vi:observe && bun run claims:refresh && bun run completion-depth:refresh");
    expect(result.graph_precheck!.detail).toContain("bun run evidence:rebind");
  });

  it("a genuinely red suite (not the excludable self-test) stays a plain refusal, with no false post-commit claim", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "determinism-baseline": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run test", { ok: false, exit_code: 1, output: REAL_SHAPE_OTHER }],
    ]);
    const result = await runEvidenceRefresh({ scope: ["determinism-baseline"] }, { run: recordingRunner(responses, calls) });

    const determinism = result.stores.find((s) => s.name === "determinism-baseline")!;
    expect(determinism.action).toBe("refused");
    // Nothing here is caused by a source commit — the message must not claim it is.
    expect(determinism.reason).not.toMatch(/after a source commit/i);
  });

  it("a MIXED red suite (self-test plus a real failure) names both: the self-test is not the bug, the other failure is", async () => {
    const calls: string[][] = [];
    const responses = new Map<string, CommandOutcome>([
      ["bun scripts/store-freshness-gate.mjs --json", { ok: false, exit_code: 1, output: freshnessReportOutput({ "determinism-baseline": "fail" }) }],
      ["bun run gate:vi-freshness", { ok: true, exit_code: 0, output: "graph is current" }],
      ["bun run gate:vi-reproducible", { ok: true, exit_code: 0, output: "graph reproduces" }],
      ["bun run test", { ok: false, exit_code: 1, output: `${REAL_SHAPE_UNCLEARABLE}\n${REAL_SHAPE_OTHER}` }],
    ]);
    const result = await runEvidenceRefresh({ scope: ["determinism-baseline"] }, { run: recordingRunner(responses, calls) });

    const determinism = result.stores.find((s) => s.name === "determinism-baseline")!;
    expect(determinism.action).toBe("refused");
    expect(determinism.reason).toMatch(/not itself a bug/i);
    expect(determinism.reason).toMatch(/after a source commit/i);
    expect(determinism.reason).toContain("bun run evidence:rebind");
  });
});

describe("ADR-079 — the predicate reads file paths, not test names", () => {
  it("extracts only FAIL-line file paths, ignoring the duplicate × rendering", () => {
    // The × lines are a second rendering of the SAME failures and never carry
    // a filename; treating them as entries is what broke the first draft.
    expect(extractFailingFiles(REAL_SHAPE_UNCLEARABLE)).toEqual(["scripts/tests/gate-failure-modes.test.mjs"]);
  });

  it("real dual-rendered output for an unclearable failure reads as unclearable", () => {
    expect(failuresAreAllUnclearable(extractFailingFiles(REAL_SHAPE_UNCLEARABLE))).toBe(true);
  });

  it("real dual-rendered output for any other failure does not", () => {
    expect(failuresAreAllUnclearable(extractFailingFiles(REAL_SHAPE_OTHER))).toBe(false);
  });
});
