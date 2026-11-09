# Public source readiness

This is the initial curated Canopy source preview, published separately from the
private development repository. It carries no inherited Git history or branch
refs, operational audit records, private research notes or media captures.
The MIT license and original copyright attribution are preserved.

## Verification scope

The source checkout used to prepare this snapshot passed its build/ADR checks and
185 focused persistence, gate and policy tests earlier in the preparation round.
Those results do not certify the curated subset: it was not rebuilt or subjected
to a broad suite after curation. A bounded secret scan found 25 synthetic test/mock
patterns, with no confirmed credential. Relative documentation links were checked.

Bun metadata now matches the CI configuration at 1.4.0; the earlier local checks
used Bun 1.4.4. GitHub Actions is disabled for this initial publication to avoid
starting heavy runners. No workflow was dispatched.

## Dependency audit gate

`bun audit --json` on the published preview lockfile reported 24 advisories across
9 package entries before a bounded lock-only update, then 17 advisories across 7
entries afterward (audit exit 1 in both cases). The lock-only update moved
`brace-expansion` 2.1.4 → 2.1.7 and 5.0.9 → 5.0.12, and `source-map-js` 1.2.1 →
1.2.2, within the existing dependency ranges. Before/after JSON summaries are
retained outside this repository under `/tmp/engels-readiness/`.

The remaining findings are in the declared test/development toolchain; the root
manifest declares Vitest and its coverage plugin only as `devDependencies`, and
no affected package is declared as an application `dependencies` entry. Remaining
alerts: `@vitest/mocker` 2.1.9 (2 moderate), `tinypool` 1.1.1 (2 critical),
`vitest` 2.1.9 (1 critical, 1 moderate), `vite` 5.4.21 (1 high, 6 moderate,
1 low), `esbuild` 0.21.5 (1 moderate), `glob` 10.5.0 (1 moderate), and
`minimatch` 10.2.6 / 9.0.9 (1 moderate). These remain real advisories in tooling
used to run repository tests and tooling; they are not dismissed by their
development-only placement.

The smallest upgrade target must satisfy both Vitest ≥4.1.12 (covering the
Vitest and `@vitest/mocker` advisory ranges) and Vite ≥6.4.4 (past the reported
Vite affected range), while aligning `@vitest/coverage-v8` with Vitest. The current
Vitest 2/Vite 5 constraints cannot resolve those versions by lockfile refresh
alone. Before enabling CI or calling this a release, update those manifest
constraints, review the existing Vitest/Vite configs for API changes, then run the
bounded authoritative test/typecheck gates on the new toolchain and require a
clean `bun audit --json`. No upgrade installation, build, or test run was performed
for this preview update.

## Remaining gates

- Establish a public baseline for the history-dependent ADR acceptance checks.
  The existing `build` command retains its audit gates; it is not advertised as
  freshly passing on this history-free snapshot. `bun run typecheck` is the
  separate compilation/type-check command, not an acceptance certificate.
- Verify the curated source on the declared Bun version with explicitly selected
  lightweight checks before enabling an appropriate public CI workflow.
- Clear the test/development dependency audit gate above; require a dependency-
  constrained Vitest/Vite upgrade, config review, bounded test/typecheck gates, and
  a clean dependency audit before enabling Actions or treating the preview as a
  release.
- Replace the media/demo output-root assumptions: `/mnt/sda2` appears in 22
  source/config files and 13 documentation files. These are separate from normal
  workdir resolution; do not assume those demo paths work on another host.
- Recreate omitted visual demonstrations with new synthetic fixtures if needed.
  Placeholder documentation describes omissions; it does not supply the original
  material or establish that any associated requirement has passed.

Legacy internal package identifiers remain `revoy2`; the CLI remains `arbor`.
The product presented by this repository is Canopy.
