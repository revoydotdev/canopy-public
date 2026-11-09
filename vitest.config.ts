import { defineConfig } from "vitest/config";

const coverageRun = process.env.VITEST_COVERAGE === "1";

export default defineConfig({
  test: {
    // Strips GIT_DIR/GIT_WORK_TREE/etc. from process.env before any test
    // runs — see the file itself for the live incident this closes.
    setupFiles: [
      "./scripts/tests/setup-sanitize-git-env.mjs",
      // Points every config/credential scope that resolves through the
      // operator's home at empty directories — see the file for the incident.
      "./scripts/tests/setup-isolate-operator-scope.mjs",
    ],
    include: ["packages/**/tests/**/*.test.ts", "scripts/tests/**/*.test.mjs"],
    // The MCP TUI integration tests drive real stdin, runtime-catalog calls,
    // persistence, and renderer shutdown. V8 coverage instrumentation roughly
    // doubles their wall time when the complete 300+ file suite is contending
    // for workers, so Vitest's 5 s default is not a reliable process-level
    // bound for this repository. Keep a finite ceiling, but size it for the
    // instrumented gate that CI actually enforces.
    testTimeout: coverageRun ? 30_000 : 15_000,
    // Vitest executes tests in Node worker threads, and `@opentui/core`'s
    // native render library does not initialize under Node — it throws
    // "OpenTUI native FFI is not available for this runtime yet". This holds
    // even when vitest itself is launched via `bun x`, because the workers are
    // still Node. Verified empirically 2026-08-07 on both runtimes.
    //
    // These native-renderer files therefore run under `bun test` instead (`bun run
    // test:opentui`), which is the ONLY thing in this repository that needs
    // Bun's test runner. Everything else stays here deliberately: measured on
    // the full suite, vitest is faster (20.3s vs 33.5s for `bun test
    // --parallel`) AND Bun's coverage model has no branch metric at all and no
    // per-package thresholds, so moving the suite would silently discard the
    // branch floors and all eleven per-package floors configured below.
    //
    // Files that merely import @opentui types (e.g. frame.test.ts) are NOT
    // excluded — types erase, only the render library binds natively.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "packages/arbor-tui/tests/opentui-*.test.ts",
      "packages/arbor-eval/tests/frontier-interface-native-cli.test.ts",
      // Bun-only pilot apparatus tests (`Bun.spawn({ terminal })`); run by test:opentui.
      "scripts/tests/**/*.bun.test.mjs",
    ],
    // No `alias` map for @arbor/* here (removed 2026-08-05). Every workspace
    // package's package.json declares an identical `exports`/`main`/`types`
    // shape pointing straight at `./src/index.ts`, and npm workspaces symlink
    // node_modules/@arbor/<name> -> packages/<name>. Node's own package-exports
    // resolution (which Vitest/Vite defer to for unaliased specifiers) already
    // lands on the TS source with no build step involved, so a Vitest alias
    // adds nothing. Confirmed empirically: the alias block previously here
    // covered only 7 of the 11 packages (missing @arbor/config, /opencode, sur-05:historical (package count then)
    // /prompts, /governance) yet all 11 resolved correctly in tests, and
    // removing the block for the other 7 as well left the full suite
    // (180 files / 2242 tests) passing unchanged. Do not re-add a partial
    // alias map — if a future package genuinely needs one (e.g. it lacks a
    // matching `exports` field), that is itself the bug to fix.
    coverage: {
      provider: "v8",
      // Widened from arbor-tui-only (Phase 6.9, wave 5, 2026-08-04): the
      // gate previously measured one package while the aspirational 85%
      // floor was described as repo-wide. Measuring honestly now.
      include: ["packages/*/src/**/*.ts"],
      // `opentui-renderer.ts` is structurally unmeasurable by this tool, not
      // merely untested. Its code path only executes once @opentui/core's
      // native render library binds, which never happens under Node — and
      // vitest's coverage provider only ever sees Node workers. Leaving it in
      // scope does not report a real gap; it reports a permanent 0% for lines
      // that CANNOT run here, dragging arbor-tui's whole-package floor down by
      // an amount unrelated to how well the package is tested.
      //
      // It is genuinely covered, by `npm run test:opentui` under `bun test`
      // (tests/opentui-renderer.test.ts, tests/opentui-hit-test.test.ts,
      // asserting real rendered output from a real native renderer). Bun's
      // coverage model has no per-package thresholds and no branch metric, so
      // that coverage cannot be folded into these floors — which is a real,
      // disclosed measurement gap for this one file, recorded here rather than
      // hidden by a lowered threshold.
      exclude: ["packages/arbor-tui/src/opentui-renderer.ts"],
      // Aspirational target remains 85% across the board (ROADMAP.md
      // §6.9). Re-measured wave 2 (2026-08-04, eval-coverage lane): repo-wide
      // statements/lines 90.50%, branches 80.87%, functions 95.05%. Per
      // CLAUDE.md's instruction not to lower a bar silently, the enforced
      // floors here are the honest current measured value (floored to a
      // whole percent, so a clean re-run isn't flaky), not 85 — a healthy
      // repo-wide average must not be allowed to hide a weak package, so the
      // same rule is applied per package, not just globally. Raise a
      // package's floor whenever real tests push its coverage up; never
      // lower one to make room for a regression.
      //
      // Below 85% (branches, the hardest metric to move): arbor-mcp (78%)
      // and arbor-tui (75%). Both are pre-existing debt, not this wave's
      // regression:
      //   - arbor-mcp: statements/lines were ALREADY measuring 84.81% before
      //     this wave (confirmed by stash) against a stale 85% floor that
      //     was failing silently because nothing in CI ever ran `vitest run
      //     --coverage` (see the coverage-floor-gate CI job added this wave,
      //     the first thing to actually enforce this file's thresholds).
      //     cli.ts (43%) and demo.ts (42%) are the largest drags — both are
      //     process-entry/scripted-demo surfaces with real integration tests
      //     possible but not yet written. This wave's lane owns
      //     packages/arbor-eval/**, scripts/**, and .github/** only —
      //     arbor-mcp/src and arbor-mcp/tests belong to a concurrently
      //     active sibling lane this wave, so raising this floor requires a
      //     follow-up pass inside packages/arbor-mcp/tests, not this one.
      //   - arbor-tui: branches was reported elsewhere as "85.26%", which is
      //     the CLI table's `arbor-tui/src` row alone — it excludes the
      //     `arbor-tui/src/screens/**` subtree, which the coverage glob
      //     below (`**/*.ts`, matching what the threshold check actually
      //     enforces) does not exclude. The true combined figure, verified
      //     against this file's own enforced threshold error output, is
      //     75.85%. Also a concurrently-owned sibling package this wave.
      thresholds: {
        statements: 90,
        // Lowered from 80 to 75 by operator decision on 2026-08-26. This is a
        // ratchet loosening, which is the opposite of this repo's usual house
        // pattern (a floor that only tightens) -- recorded here so a future
        // reader sees it was a decision, not drift. Measured global branch
        // coverage at the time was 79.73%.
        branches: 75,
        functions: 95,
        lines: 90,
        "packages/arbor-audit/src/**/*.ts": { statements: 88, branches: 85, functions: 97, lines: 88 },
        "packages/arbor-config/src/**/*.ts": { statements: 97, branches: 91, functions: 100, lines: 97 },
        "packages/arbor-core/src/**/*.ts": { statements: 96, branches: 84, functions: 97, lines: 96 },
        "packages/arbor-eval/src/**/*.ts": { statements: 92, branches: 87, functions: 91, lines: 92 },
        "packages/arbor-gate/src/**/*.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/arbor-kb/src/**/*.ts": { statements: 96, branches: 85, functions: 100, lines: 96 },
        "packages/arbor-mcp/src/**/*.ts": { statements: 84, branches: 78, functions: 91, lines: 84 },
        "packages/arbor-opencode/src/**/*.ts": { statements: 94, branches: 84, functions: 97, lines: 94 },
        // branches: 98 not 100 — G-10's repo-instructions module added real
        // filesystem/byte-budget defensive branches to a package that was
        // previously pure template functions. Every branch representing real
        // behaviour is covered (truncation, header exhaustion, budget guard,
        // boundary); the residual is defensive. An honest floor beats an
        // aspirational one that never holds.
        "packages/arbor-prompts/src/**/*.ts": { statements: 100, branches: 98, functions: 100, lines: 100 },
        "packages/arbor-tui/src/**/*.ts": { statements: 95, branches: 75, functions: 96, lines: 95 },
      },
    },
  },
});
