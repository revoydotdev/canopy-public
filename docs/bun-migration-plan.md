# Bun runtime migration — plan of record

**Branch:** `feat/bun-runtime-migration`. **Decided:** 2026-08-07.

## Why

`@opentui/core@0.5.1` — the renderer revoy2 is adopting to close the TUI's
interaction-quality gap (`audit/tui-parity-census.md` IQ-01..IQ-13) — **cannot
render on Node**. Verified empirically on this machine, same script, same
package version:

| Runtime | Result |
|---|---|
| Node 22.23.2 | `Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet` |
| Bun 1.3.14 | renders correctly |
| vitest launched via `bun x` | same FFI failure — vitest executes tests in Node workers |
| `bun test` | passes |

The package *imports* cleanly under Node (267 exports) and fails only when the
render library binds, so a partial migration would look healthy until first
draw. The vitest row is decisive: OpenTUI is untestable in revoy2's current
harness even with Bun driving vitest. Bun is therefore the repository's
package manager and operator command surface, with a deliberate Node/Vitest
compatibility lane rather than an unsupported claim that every process runs in
one runtime.

## Scope

Full repository: all workspace packages, gate scripts, CI jobs, and the whole committed
test suite, `tsc --build` project references, `npm ci` → `bun install`, and
all documented project commands → `bun run`.

## Established facts (verified before planning, not assumed)

- **Vitest remains intentional.** Its V8 coverage gate enforces repository
  branch metrics and per-package floors that Bun cannot presently express.
  `bun run test` therefore continues to execute the Vitest suite, while
  `bun run test:opentui` executes the native-renderer proofs with `bun test`.
  `bun run test:all` is the required aggregate command.
- **Five gates get simpler.** `gate:eval-regression`, `gate:obligations`,
  `gate:liveness`, `gate:claim-ledger`, `gate:determinism` currently run
  `vite-node -c vitest.config.ts scripts/X.ts` solely to execute TypeScript.
  Bun runs `.ts` natively: these become `bun scripts/X.ts`, dropping the
  `vite-node`/vitest dependency from the gate path entirely.
- **Portable script gates run through Bun.** Their package entries use `bun
  scripts/*.mjs`; a small number of subprocesses deliberately name `node`
  because Vitest workers and Node-only built-ins require it.
- **Only `packages/arbor-mcp/src` imports `@arbor/tui`** — one seam.
- **`tsc` is still required.** Bun transpiles but does not typecheck;
  `bun run build` (`tsc --build`) remains the whole-repo typecheck and must
  keep working. `npx tsc --noEmit` type-checks **zero** files here (root is
  `"files": []` with project references) and is never a valid signal.

## Known risk — coverage floors

`vitest.config.ts` enforces repo-wide coverage thresholds **plus per-package
per-package floors**, and `gate:coverage` (`vitest run --coverage`) is a live
CI job. A `bun test --coverage` probe produced no threshold enforcement.
Bun's `bunfig.toml` coverage thresholds are global, not per-glob. This is the
one part of the migration with no verified equivalent, and the plan must not
silently lower or drop a floor — per repository convention, an honest floor
beats an aspirational one, and a floor is never lowered to make room for a
regression. Resolving this is Lane B's hardest task; if no faithful equivalent
exists, the outcome is a documented, owner-visible gap, not a quiet deletion.

## Lanes (strictly file-disjoint, one branch)

| Lane | Owns | Must not touch |
|---|---|---|
| **A — runtime & package manager** | root `package.json`, `package-lock.json`/`bun.lock`, `bunfig.toml`, `tsconfig*.json`, `.gitignore`, `packages/*/package.json` **except** arbor-tui, `scripts/lockfile-check.mjs` | tests, CI, arbor-tui |
| **B — test suite** | `packages/**/tests/**`, `vitest.config.ts`, `scripts/tests/**`, coverage strategy | src, CI, package.json |
| **C — CI & gates** | `.github/workflows/**`, `scripts/**` except `lockfile-check.mjs` and `scripts/tests/**`, `scripts/hooks/**` | tests, package.json, src |
| **D — OpenTUI + ADR** | `packages/arbor-tui/src/**`, `packages/arbor-tui/package.json`, `decisions/ADR-036-*.md` | everything else |

Lane D does **not** replace the shipped renderer in this pass. It writes the
superseding ADR and proves an OpenTUI renderer behind the existing
`RendererPort` seam (ADR-011 obligation O4) as a second implementation. The
renderer swap is a later change, gated on this migration landing.

## Definition of done

1. `bun install --frozen-lockfile` succeeds on a clean checkout of all workspace packages.
2. `bun run build` (`tsc --build`) typechecks the whole repo green.
3. `bun run test:all` passes with no test deleted, skipped, or weakened. It
   runs Vitest for the coverage-enforced suite and `bun test` for the
   OpenTUI-native lane. Test count is verified against the pre-migration
   baseline and any difference is explained, not absorbed.
4. All 21 gates pass, or a gate's inapplicability is documented with reasoning.
5. CI runs on Bun and is green.
6. Coverage floors are enforced at equal or greater strictness, or the gap is
   explicitly reported to the owner.
7. ADR-036 supersedes ADR-011's renderer decision and carries machine-checkable
   obligations.

## Non-negotiable

The pre-migration baseline, measured on this branch immediately before any
lane started, is **2465 tests / 193 files** — 2463 passing and **2 failing**,    sur-05:historical (migration baseline, 2026-08-07)
both in `packages/arbor-governance/tests/counts/check.test.ts`, both caused by
count drift this very document introduced (now marked historical). That is the
anchor. A migration that "passes" by running fewer tests has failed. Every lane
reports real numbers from real runs and explains any difference against this
baseline rather than absorbing it.

Note for every lane: the SUR-05 doc-drift gate reads prose in `docs/`, `audit/`,
`ROADMAP.md`, `README.md` and `AGENTS.md`. If you write an exact count of tests,
files, ADRs, or catalog kinds into any document, it becomes a live claim the
gate checks on every run. Either omit exact counts or mark point-in-time
measurements with the historical marker (`sur-05` + `:historical`, see
`packages/arbor-governance/src/counts/check.ts`).
