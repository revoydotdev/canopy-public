import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  computeRootsByFile,
  classifyRootCoverage,
  collectGuards,
  collectSetters,
  completionDepthGateRationale,
  evaluateCompletionDepthGate,
} from "../completion-depth.mjs";

/**
 * scripts/tests/completion-depth.test.mjs
 *
 * Two things under test:
 *
 *   1. The `--triage` CRUD surface (mirrors vi-findings.mjs's `--triage`,
 *      applied to completion-depth's single-file findings store). Run as
 *      subprocesses against a throwaway STORE dir
 *      (REVOY2_COMPLETION_DEPTH_DIR) — never `.completion-depth/` — matching
 *      vi-findings.test.mjs's own convention for exactly the same reason: the
 *      store is committed evidence.
 *
 *   2. `computeRootsByFile` / `classifyRootCoverage` — Shape B's decision —
 *      as pure unit tests against a hand-built `.visual-intelligence/graph/`
 *      fixture. `extract()`'s own source scan is NOT overridable (it always
 *      walks the real `packages/` tree — see completion-depth.mjs's REPO_ROOT
 *      constant), so a "key set on one root, not another" scenario can only
 *      be constructed at this layer, not through a full CLI run.
 */

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "completion-depth.mjs");

const temporary = [];
function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

// execFileSync throws on non-zero exit, so wrap to capture status + output
// the way the CLI itself reports failure (exit 2 for usage/validation errors).
function runCLI(args, storeDir) {
  try {
    const stdout = execFileSync("bun", [SCRIPT, ...args], {
      encoding: "utf-8",
      env: { ...process.env, REVOY2_COMPLETION_DEPTH_DIR: storeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function readFindings(storeDir) {
  const path = join(storeDir, "findings.jsonl");
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function seedFinding(storeDir) {
  const finding = {
    id: "hollow:fixture", guard_file: "packages/fixture/src/guard.ts", guard_line: 1, guard_symbol: "run",
    gating_expression: "input.enabled", gating_key: "enabled", setters: [], production_setter_count: 0,
    test_setter_count: 1, demo_setter_count: 0, production_reachable_unset: false,
    shape: "no_production_setter", missing_from_roots: [], confidence: "medium", verdict: "untriaged",
    verdict_reason: "", first_seen: "0123456789abcdef0123456789abcdef01234567", first_seen_date: "2026-01-01",
    triage_expires: "2026-01-31", last_verified: "0123456789abcdef0123456789abcdef01234567", content_hash: "fixture",
  };
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, "findings.jsonl"), `${JSON.stringify(finding)}\n`);
  return finding;
}

describe("--triage CRUD surface, mirroring vi-findings.mjs's --triage", () => {
  it("setting a verdict persists it", () => {
    const store = temp("completion-depth-triage-");
    const target = seedFinding(store);
    expect(target.verdict).toBe("untriaged");

    const triaged = runCLI(["--triage", target.id, "--verdict", "accepted_tradeoff", "--reason", "test-authored triage"], store);
    expect(triaged.status).toBe(0);
    const afterTriage = readFindings(store).find((f) => f.id === target.id);
    expect(afterTriage.verdict).toBe("accepted_tradeoff");
    expect(afterTriage.verdict_reason).toBe("test-authored triage");
    // triage_expires was NOT overridden, so it must be exactly what --refresh
    // already stamped — completion-depth never invents a fresh expiry at
    // triage time (unlike vi-findings, which has no prior expiry to inherit).
    expect(afterTriage.triage_expires).toBe(target.triage_expires);
  });

  it("--expires overrides the inherited deadline", () => {
    const store = temp("completion-depth-triage-expires-");
    const target = seedFinding(store);
    const triaged = runCLI(["--triage", target.id, "--verdict", "confirmed_hollow", "--reason", "genuinely dead", "--expires", "2099-01-01"], store);
    expect(triaged.status).toBe(0);
    const row = readFindings(store).find((f) => f.id === target.id);
    expect(row.triage_expires).toBe("2099-01-01");
  });

  it("an invalid verdict is rejected, not silently accepted", () => {
    const store = temp("completion-depth-triage-invalid-verdict-");
    const target = seedFinding(store);
    const result = runCLI(["--triage", target.id, "--verdict", "not_a_real_verdict", "--reason", "x"], store);
    expect(result.status).toBe(2);
    const row = readFindings(store).find((f) => f.id === target.id);
    expect(row.verdict).toBe("untriaged");
  });

  it("a missing --reason is rejected, not silently accepted", () => {
    const store = temp("completion-depth-triage-missing-reason-");
    const target = seedFinding(store);
    const result = runCLI(["--triage", target.id, "--verdict", "false_positive"], store);
    expect(result.status).toBe(2);
    const row = readFindings(store).find((f) => f.id === target.id);
    expect(row.verdict).toBe("untriaged");
  });

  it("an unknown finding id is rejected, not silently accepted", () => {
    const store = temp("completion-depth-triage-unknown-id-");
    seedFinding(store);
    const before = readFindings(store);
    const result = runCLI(["--triage", "hollow:doesnotexist", "--verdict", "false_positive", "--reason", "x"], store);
    expect(result.status).toBe(2);
    expect(readFindings(store)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Shape B — root-partial reachability consumption
// ---------------------------------------------------------------------------

/** Minimal graph fixture builder: two roots, one shared guard file, and two
 * setter files reachable from only one root apiece. */
function buildGraphFixture(repo) {
  const dir = join(repo, ".visual-intelligence", "graph");
  mkdirSync(dir, { recursive: true });

  const nodes = [
    { id: "ep:fixture", kind: "entrypoint", attributes: { roots: ["file:root-a.ts", "file:root-b.ts"] } },
    { id: "file:root-a.ts", kind: "file" },
    { id: "file:root-b.ts", kind: "file" },
    { id: "file:guard.ts", kind: "file" },
    { id: "file:setter-a-only.ts", kind: "file" },
    { id: "file:setter-both.ts", kind: "file" },
  ];

  // Both roots reach guard.ts and setter-both.ts. Only root-a reaches
  // setter-a-only.ts — the "set on some root's path, not another's" case.
  const runtimeEdges = [
    { source: "file:root-a.ts", target: "file:guard.ts", relation: "imports" },
    { source: "file:root-a.ts", target: "file:setter-a-only.ts", relation: "imports" },
    { source: "file:root-a.ts", target: "file:setter-both.ts", relation: "imports" },
    { source: "file:root-b.ts", target: "file:guard.ts", relation: "imports" },
    { source: "file:root-b.ts", target: "file:setter-both.ts", relation: "imports" },
  ];

  // Union of every per-root closure, recorded as `reachable_from` edges —
  // exactly what the vendored walker commits, and what the self-check
  // compares against. Computed by hand here, deliberately: root-a reaches
  // {root-a, guard, setter-a-only, setter-both}; root-b reaches
  // {root-b, guard, setter-both}.
  const unionReachable = [
    "file:root-a.ts", "file:guard.ts", "file:setter-a-only.ts", "file:setter-both.ts",
    "file:root-b.ts",
  ];
  const reachableFromEdges = unionReachable.map((id) => ({ source: id, target: "ep:fixture", relation: "reachable_from" }));

  writeFileSync(join(dir, "nodes.jsonl"), nodes.map((n) => JSON.stringify(n)).join("\n") + "\n");
  writeFileSync(join(dir, "edges.jsonl"), [...runtimeEdges, ...reachableFromEdges].map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("computeRootsByFile — consumes entrypoint-reachability.mjs's exported primitives", () => {
  it("REGRESSION: distinguishes a key set on ALL roots reaching the guard from one set on only SOME of them", () => {
    const repo = temp("completion-depth-reachability-fixture-");
    buildGraphFixture(repo);
    const info = computeRootsByFile({ repo });
    expect(info.available).toBe(true);
    expect(info.allRootIds.sort()).toEqual(["file:root-a.ts", "file:root-b.ts"]);

    // Fully covered: setter-both.ts is reachable from both roots that reach guard.ts.
    const covered = classifyRootCoverage({ guardFile: "guard.ts", prodSetterFiles: ["setter-both.ts"] }, info);
    expect(covered.shape).toBe("fully_covered");
    expect(covered.missingFromRoots).toEqual([]);

    info.directImportsByFile ??= new Map();
    info.directImportsByFile.set("guard.ts", new Set(["setter-a-only.ts"]));
    const directlyImported = classifyRootCoverage({ guardFile: "guard.ts", prodSetterFiles: ["setter-a-only.ts"] }, info);
    expect(directlyImported.shape).toBe("fully_covered");
    info.directImportsByFile.delete("guard.ts");

    // THE DECIDABLE CASE THIS GAP CLOSES: setter-a-only.ts is reachable only
    // from root-a, but the guard itself is reachable from root-a AND root-b.
    // The old predicate (`prod.length > 0 -> continue`) could not see this —
    // it only asked "does a production setter exist anywhere", and one does.
    const partial = classifyRootCoverage({ guardFile: "guard.ts", prodSetterFiles: ["setter-a-only.ts"] }, info);
    expect(partial.shape).toBe("root_partial");
    expect(partial.missingFromRoots).toEqual(["file:root-b.ts"]);

    // classifyRootCoverage itself has no opinion about a totally-absent
    // setter — asked with an empty setter list it correctly reports every
    // guard-reaching root as missing. extract() never actually asks it this:
    // that's Shape A's territory (prod.length === 0 short-circuits before
    // classifyRootCoverage is ever called), which is why Shapes A and B are
    // mutually exclusive by construction rather than by a check in here.
    const none = classifyRootCoverage({ guardFile: "guard.ts", prodSetterFiles: [] }, info);
    expect(none.shape).toBe("root_partial");
    expect(none.missingFromRoots.sort()).toEqual(["file:root-a.ts", "file:root-b.ts"]);
  });

  it("never reports root_partial when reachability data is unavailable (no graph, no roots, or a failed self-check)", () => {
    const repoNoGraph = temp("completion-depth-no-graph-");
    const info = computeRootsByFile({ repo: repoNoGraph });
    expect(info.available).toBe(false);
    const result = classifyRootCoverage({ guardFile: "guard.ts", prodSetterFiles: ["setter-a-only.ts"] }, info);
    expect(result.shape).toBe("unknown");
    expect(result.missingFromRoots).toEqual([]);
  });

  it("reports unknown for a guard file the graph has never heard of", () => {
    const repo = temp("completion-depth-unknown-guard-");
    buildGraphFixture(repo);
    const info = computeRootsByFile({ repo });
    const result = classifyRootCoverage({ guardFile: "not-in-the-graph.ts", prodSetterFiles: ["setter-both.ts"] }, info);
    expect(result.shape).toBe("unknown");
  });

  it("SELF-CHECK-AWARE: a graph whose reachable_from edges disagree with the real walk is treated as unavailable, not trusted", () => {
    const repo = temp("completion-depth-drifted-graph-");
    buildGraphFixture(repo);
    // Corrupt the committed reachable_from set so it disagrees with the
    // union this module would compute — simulating a stale/hand-edited graph.
    const edgesPath = join(repo, ".visual-intelligence", "graph", "edges.jsonl");
    const edges = readFileSync(edgesPath, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const drifted = edges.filter((e) => !(e.relation === "reachable_from" && e.source === "file:setter-a-only.ts"));
    writeFileSync(edgesPath, drifted.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const info = computeRootsByFile({ repo });
    expect(info.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Barrel-mediated reachability — the narrowing this file was written to add
// ---------------------------------------------------------------------------

/**
 * A symbol-granularity graph fixture: `barrel.ts` re-exports `guard.ts`
 * (a plain file->file `exports` edge, exactly what the vendored extractor
 * emits for every barrel re-export line, independent of which symbol a
 * consumer actually imports). `root-a` reaches `guard.ts` ONLY through that
 * barrel — no edge of any kind lands on `guardFn` itself. `root-b` reaches
 * `guard.ts` GENUINELY: a direct `calls` edge onto `sym:guard.ts::guardFn`.
 *
 * `setter.ts` is genuinely `calls`-reachable only from `root-b`.
 *
 * `sibling.ts` exists to prove symbol precision, not just file precision:
 * `root-a` genuinely CALLS `sibling.ts::siblingFn`, and `siblingFn`'s own
 * declaration merely REFERENCES `guard.ts::guardFn` (the
 * `AGENT_PROMPTS`/`foregroundBlock` shape from the file header) — evidence
 * that must NOT vouch for `guardFn` being genuinely invoked by `root-a`.
 */
function buildBarrelGraphFixture(repo) {
  const dir = join(repo, ".visual-intelligence", "graph");
  mkdirSync(dir, { recursive: true });

  const nodes = [
    { id: "ep:fixture", kind: "entrypoint", attributes: { roots: ["file:root-a.ts", "file:root-b.ts"] } },
    { id: "file:root-a.ts", kind: "file" },
    { id: "file:root-b.ts", kind: "file" },
    { id: "file:barrel.ts", kind: "file" },
    { id: "file:guard.ts", kind: "file" },
    { id: "file:setter.ts", kind: "file" },
    { id: "file:sibling.ts", kind: "file" },
    { id: "sym:guard.ts::guardFn", kind: "symbol", repository_path: "guard.ts" },
    { id: "sym:setter.ts::setterFn", kind: "symbol", repository_path: "setter.ts" },
    { id: "sym:sibling.ts::siblingFn", kind: "symbol", repository_path: "sibling.ts" },
  ];

  const runtimeEdges = [
    // root-a: barrel-only path to guard.ts — file-level `exports` edge, no
    // symbol-level edge ever lands on guardFn.
    { source: "file:root-a.ts", target: "file:barrel.ts", relation: "imports" },
    { source: "file:barrel.ts", target: "file:guard.ts", relation: "exports" },
    // root-a: a genuine call into an unrelated sibling in a DIFFERENT file,
    // whose own declaration references guardFn (stored-but-uncalled shape).
    { source: "file:root-a.ts", target: "file:sibling.ts", relation: "imports" },
    { source: "file:root-a.ts", target: "sym:sibling.ts::siblingFn", relation: "calls" },
    { source: "sym:sibling.ts::siblingFn", target: "sym:guard.ts::guardFn", relation: "references" },
    // root-b: genuine direct call into guard.ts and setter.ts.
    { source: "file:root-b.ts", target: "file:guard.ts", relation: "imports" },
    { source: "file:root-b.ts", target: "sym:guard.ts::guardFn", relation: "calls" },
    { source: "file:root-b.ts", target: "file:setter.ts", relation: "imports" },
    { source: "file:root-b.ts", target: "sym:setter.ts::setterFn", relation: "calls" },
  ];

  const unionReachable = [
    "file:root-a.ts", "file:barrel.ts", "file:guard.ts", "file:sibling.ts", "sym:sibling.ts::siblingFn",
    "file:root-b.ts", "sym:guard.ts::guardFn", "file:setter.ts", "sym:setter.ts::setterFn",
  ];
  const reachableFromEdges = unionReachable.map((id) => ({ source: id, target: "ep:fixture", relation: "reachable_from" }));

  writeFileSync(join(dir, "nodes.jsonl"), nodes.map((n) => JSON.stringify(n)).join("\n") + "\n");
  writeFileSync(join(dir, "edges.jsonl"), [...runtimeEdges, ...reachableFromEdges].map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("classifyRootCoverage — barrel-mediated and stored-but-uncalled reachability are discounted", () => {
  it("does NOT fire when the only path to the guard is a barrel re-export (WEAKNESS 1)", () => {
    const repo = temp("completion-depth-barrel-fixture-");
    buildBarrelGraphFixture(repo);
    const info = computeRootsByFile({ repo });
    expect(info.available).toBe(true);

    const result = classifyRootCoverage(
      { guardFile: "guard.ts", guardSymbol: "guardFn", prodSetterFiles: ["setter.ts"] },
      info,
    );
    // root-a's barrel-only path never lands on guardFn, so it is not even a
    // candidate "reaching" root — the only genuine guard-reaching root
    // (root-b) genuinely reaches the setter too.
    expect(result.shape).toBe("fully_covered");
    expect(result.missingFromRoots).toEqual([]);
  });

  it("still FIRES on a genuine call path with a genuinely uncovered root (proves the narrowing didn't blind it)", () => {
    const repo = temp("completion-depth-genuine-partial-fixture-");
    buildBarrelGraphFixture(repo);
    const info = computeRootsByFile({ repo });

    // guardRoots is {root-b} (root-a's path is barrel-only, so it never
    // becomes a candidate at all — see the previous test). Ask coverage
    // against a setter file ("sibling.ts") that root-b does NOT genuinely
    // reach at all (only root-a calls into it): the one genuine guard root
    // is genuinely uncovered, and the finding must fire naming exactly it.
    const result = classifyRootCoverage(
      { guardFile: "guard.ts", guardSymbol: "guardFn", prodSetterFiles: ["sibling.ts"] },
      info,
    );
    expect(result.shape).toBe("root_partial");
    expect(result.missingFromRoots).toEqual(["file:root-b.ts"]);
  });

  it("does not let a genuinely-called SIBLING symbol vouch for the guard's own, merely-referenced symbol", () => {
    const repo = temp("completion-depth-sibling-vouching-fixture-");
    buildBarrelGraphFixture(repo);
    const info = computeRootsByFile({ repo });

    // root-a genuinely calls sibling.ts::siblingFn, and siblingFn's own
    // declaration references guardFn — but that reference is not a call.
    // A file-wide (rather than symbol-precise) invocation check would wrongly
    // credit root-a via siblingFn's genuine call landing somewhere in the
    // guard's file. Assert root-a is excluded from guardRoots by using a
    // setter only root-a reaches: if root-a were (wrongly) a guard-reaching
    // root, this would report root_partial for root-b; instead it must
    // report fully_covered, because root-a was never a genuine guard root at
    // all — the only genuine guard root, root-b, does reach setter.ts.
    const result = classifyRootCoverage(
      { guardFile: "guard.ts", guardSymbol: "guardFn", prodSetterFiles: ["setter.ts"] },
      info,
    );
    expect(result.shape).toBe("fully_covered");
  });
});

// ---------------------------------------------------------------------------
// Setter/guard type-hint pairing — WEAKNESS 2 (name-only key matching)
// ---------------------------------------------------------------------------

/** Parses `source` as a single .ts file and returns { guards, setters } the
 * same way extract() does, exercising the real collectGuards/collectSetters
 * (and therefore the real namedTypeHint/scopeTypeHint/literalContainerHint
 * logic) rather than reimplementing it. */
function parseHints(source, rel = "fixture.ts") {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  const guards = collectGuards(sf, rel);
  const setters = new Map();
  collectSetters(sf, rel, setters);
  return { guards, setters };
}

describe("guard/setter type-hint extraction — distrusting a same-name, different-type setter", () => {
  it("binds constructor guards to the owning class symbol instead of module scope", () => {
    const { guards } = parseHints(`
      interface RegistryOptions { restored_records?: readonly string[]; }
      class OperationRegistry {
        constructor(options: RegistryOptions = {}) {
          if (options.restored_records) this.restore(options.restored_records);
        }
        restore(_records: readonly string[]) {}
      }
    `);
    expect(guards).toHaveLength(1);
    expect(guards[0]).toMatchObject({
      key: "restored_records",
      symbol: "OperationRegistry",
      parameter_rooted: true,
      hint: "RegistryOptions",
    });
  });

  it("resolves a guard's object to its parameter's declared type, unwrapping Readonly<>/optional", () => {
    const { guards } = parseHints(`
      interface PromptContext { taskDescription?: string; }
      function crownPrompt(ctx?: PromptContext): string {
        return ctx?.taskDescription ? "x" : "";
      }
    `);
    expect(guards[0].parameter_rooted).toBe(true);
    expect(guards).toHaveLength(1);
    expect(guards[0].key).toBe("taskDescription");
    expect(guards[0].hint).toBe("PromptContext");
  });

  it("retains a parameter origin through a nested closure", () => {
    const { guards } = parseHints(`
      function run(signal: AbortSignal) {
        return async () => { if (signal.aborted) return; };
      }
    `);
    expect(guards[0].parameter_rooted).toBe(true);
  });

  it("retains injected-input provenance through immutable capability aliases", () => {
    const { guards } = parseHints(`
      function run(
        request: { signal: AbortSignal },
        terminal: { stdin: { setRawMode?: (enabled: boolean) => void } },
      ) {
        const signal = request.signal;
        const stdin = terminal.stdin;
        if (signal.aborted) return;
        if (stdin.setRawMode) stdin.setRawMode(true);
      }
    `);
    expect(guards.map((guard) => guard.key)).toEqual(["aborted", "setRawMode"]);
    expect(guards.every((guard) => guard.parameter_rooted)).toBe(true);
  });

  it("retains host-stream provenance through a type assertion on its alias", () => {
    const { guards } = parseHints(`
      function run(options: { stdin: { setRawMode?: (enabled: boolean) => void } }) {
        const stdin = options.stdin as { setRawMode?: (enabled: boolean) => void };
        if (stdin.setRawMode) stdin.setRawMode(true);
      }
    `);
    expect(guards).toHaveLength(1);
    expect(guards[0].key).toBe("setRawMode");
    expect(guards[0].parameter_rooted).toBe(true);
  });

  it("follows aliases by binding provenance rather than capability identifier names", () => {
    const { guards } = parseHints(`
      function run(source: { control: { halted: boolean } }) {
        const relay = source.control;
        if (relay.halted) return;
      }
    `);
    expect(guards).toHaveLength(1);
    expect(guards[0].parameter_rooted).toBe(true);
  });

  it("fails closed when a mutable local binding shadows a parameter", () => {
    const { guards } = parseHints(`
      function run(signal: { aborted: boolean }) {
        {
          let signal = { aborted: false };
          if (signal.aborted) return;
        }
      }
    `);
    expect(guards).toHaveLength(1);
    expect(guards[0].parameter_rooted).toBe(false);
  });

  it("fails closed at a later lexical declaration's TDZ instead of falling through", () => {
    const { guards } = parseHints(`
      function run(signal: { aborted: boolean }) {
        {
          if (signal.aborted) return;
          const signal = { aborted: false };
        }
      }
    `);
    expect(guards).toHaveLength(1);
    expect(guards[0].parameter_rooted).toBe(false);
  });

  it("resolves a direct-return object literal's hint from the enclosing function's named return type", () => {
    const { setters } = parseHints(`
      interface BaselineResult { taskDescription: string; }
      function runLinearPipeline(task: { description: string }): BaselineResult {
        return { taskDescription: task.description, success: true };
      }
    `);
    const sites = setters.get("taskDescription");
    expect(sites).toHaveLength(1);
    expect(sites[0].hint).toBe("BaselineResult");
  });

  it("reports no hint (null) for a nested call-argument object literal — the honest 'no evidence' case", () => {
    const { setters } = parseHints(`
      function buildReport(build: (x: unknown) => unknown) {
        return build({ taskDescription: "x", runs: 1 });
      }
    `);
    const sites = setters.get("taskDescription");
    expect(sites).toHaveLength(1);
    expect(sites[0].hint).toBeNull();
  });

  it("resolves x.KEY = value assignments through the identifier's declared parameter type", () => {
    const { setters } = parseHints(`
      interface EvalTask { taskDescription: string; }
      function setIt(task: EvalTask) {
        task.taskDescription = "x";
      }
    `);
    const sites = setters.get("taskDescription");
    expect(sites).toHaveLength(1);
    expect(sites[0].hint).toBe("EvalTask");
  });

  it("a guard's hint and a same-named setter's hint DISAGREE when the setter belongs to an unrelated type", () => {
    const guardSrc = parseHints(`
      interface PromptContext { taskDescription?: string; }
      function crownPrompt(ctx?: PromptContext): string { return ctx?.taskDescription ? "x" : ""; }
    `).guards[0];
    const setterSrc = parseHints(`
      interface BaselineResult { taskDescription: string; }
      function runLinearPipeline(): BaselineResult { return { taskDescription: "x" }; }
    `).setters.get("taskDescription")[0];
    expect(guardSrc.hint).toBe("PromptContext");
    expect(setterSrc.hint).toBe("BaselineResult");
    expect(guardSrc.hint).not.toBe(setterSrc.hint);
  });
});

// ---------------------------------------------------------------------------
// The gate's printed rationale must not contradict its own `ok` computation
// (ADR-035's "post-adoption ratchet": ANY untriaged finding fails immediately,
// `triage_expires` is informational only — main()'s `ok` is
// `untriaged.length === 0`, never gated on `expired`). A fresh, empty store
// explicit finding drives the same exported evaluator used by the CLI. This
// keeps the policy test valid even when the real repository has zero findings.
// ---------------------------------------------------------------------------
describe("gate report text agrees with the gate's actual blocking behavior", () => {
  it("never claims only an EXPIRED finding fails, since any untriaged finding already does", () => {
    const store = temp("completion-depth-gate-text-");
    const finding = seedFinding(store);
    const result = evaluateCompletionDepthGate([finding], new Date("2026-01-02T00:00:00.000Z"));
    const rationale = completionDepthGateRationale().join("\n");
    expect(result.report.ok).toBe(false);
    expect(result.report.untriaged).toBe(1);
    expect(result.report.expired_untriaged).toBe(0);
    expect(rationale).toMatch(/fails this gate immediately, not just an expired one/);
    expect(rationale).not.toMatch(/finding past its date FAILS/);
  });
});
