# ADR-008: TypeScript Monorepo with Bun Workspaces

**Status:** Accepted
**Date:** 2026-07-31

**Amended:** 2026-08-08 by the Bun runtime migration plan.

## Context

The project has five distinct packages (core, kb, gate, mcp, audit) with clear dependency boundaries. The language choice affects: the MCP ecosystem (most MCP servers are TypeScript), the test framework, and the distribution model.

## Decision

Use **TypeScript** with **Bun workspaces**. Each package is a separate
directory with its own `package.json` and `tsconfig.json`, and shares the
root-level workspace configuration and committed `bun.lock`.

The repository command surface is Bun-first: install with `bun install
--frozen-lockfile` and invoke project tasks with `bun run <script>`. `tsc
--build` remains the only whole-repository typecheck and is reached through
`bun run build`.

This is not a claim that Node has disappeared. The standard suite remains
Vitest because its V8 coverage gate enforces branch metrics and per-package
thresholds Bun cannot express. Vitest workers, and the small set of
subprocesses that require Node built-ins, intentionally run under Node.
OpenTUI's native renderer is the inverse exception: it runs only in the
dedicated `bun test` lane. `bun run test:all` is the required aggregate test
command.

## Consequences

**Positive:** TypeScript is the dominant language for MCP servers. The type
system catches scoring-formula bugs at compile time. Bun provides the committed
workspace lockfile, the package-manager command surface, and the runtime needed
by OpenTUI's native renderer. Vitest retains its coverage enforcement where it
is materially stronger.

**Negative:** Bun and Node/Vitest are both operational dependencies. The split
must remain explicit in scripts and CI: Bun owns installation and project
commands, Vitest owns coverage enforcement, and only the OpenTUI lane uses
`bun test`. TypeScript's strict mode catches real bugs but requires careful
type annotations.

**Neutral:** The `tsconfig.json` uses project references for incremental builds. Build output goes to `dist/` but tests import directly from `src/` (no build step for testing).

## Alternatives Considered

1. **Python.** Rejected: revoy-spec is already Python and this project is a clean-room TypeScript alternative. The MCP SDK for TypeScript is more mature.

2. **Go.** Rejected: Go's MCP SDK is less mature. Go does not match the
TypeScript/MCP ecosystem used by this repository.

3. **Rust.** Rejected: compile times and ecosystem maturity. Rust is a Phase 3+ option for performance-critical components (e.g., the MCP server).

4. **npm or pnpm workspaces.** Superseded by this amendment. npm does not
provide the runtime needed by OpenTUI, and retaining a separate package manager
would leave the runtime migration only half-complete. pnpm remains viable in
the abstract but does not provide the required native runtime either.

## Obligations

This record's commitments are structural facts about the repository's layout and tooling choice (language, package manager, per-package manifests), not runtime behavior any exported symbol embodies. The obligation resolver checks `symbol=` against declarations/exports inside `packages/*/src/**/*.ts`; a claim like "each package has its own `package.json`" is true and checkable by a human (or a future repo-layout gate), but is not expressible as a symbol/file/roundtrip triple, so no proof is attached to any obligation below rather than forcing one that wouldn't genuinely verify the claim.

### O1 — Every package is a TypeScript source tree with its own `package.json` and `tsconfig.json`, sharing one root-level Bun workspace configuration and `bun.lock`

<!-- unverifiable: a filesystem/manifest-layout claim (per-package package.json + tsconfig.json, one shared root Bun workspace config) — no CONFORMANCE_SPEC element or other exported symbol in packages/*/src checks per-package tsconfig.json existence, so it is not expressible as a symbol/file/roundtrip triple. -->

No proof: this is a filesystem/manifest-layout claim, not a symbol export.

### O2 — Tests import package source directly (`src/`), with no build step required to run either the Vitest suite or Bun-native OpenTUI lane

<!-- unverifiable: a test-runner configuration property (vitest.config.ts's resolution behavior, and the separate bun test lane for OpenTUI) — no exported symbol embodies "tests import src/ directly with no build step"; it is a property of the resolver's own config, not application code. -->

No proof: this is a test-runner configuration property (`vitest.config.ts`'s resolution behavior), not a symbol export.

### O3 — Dependencies between workspace packages resolve through Bun's workspace linking, with installation locked by `bun.lock`

<!-- unverifiable: scripts/lockfile-check.mjs's exported evaluateLockfileDrift (roundtrip scripts/tests/lockfile-check-root.test.mjs) witnesses only the "locked by bun.lock" half of this compound claim (bun.lock stays in sync with every workspace package.json); it does not exercise that intra-workspace dependencies actually resolve through Bun's workspace linking at module-resolution time, so citing it as a full proof would overclaim. -->

No proof: this is a package-manager choice, verifiable by reading `package.json`'s `workspaces` field and committed `bun.lock`, not by a source-level symbol. Correction: `scripts/lockfile-check.mjs` now exports `evaluateLockfileDrift` with a collected roundtrip test (`scripts/tests/lockfile-check-root.test.mjs`), so the "not by a source-level symbol" premise is stale for the bun.lock-sync half of this obligation — a symbol does exist and is exercised. It still does not cover the workspace-linking-resolution half, so the obligation as a whole remains unverifiable rather than proven.
