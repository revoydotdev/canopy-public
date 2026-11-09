# Canopy public-source roadmap

Current state: curated source preview, not a release. The private development
history and operational records are deliberately absent.

Dependency readiness is still open: the published lockfile's bounded audit has
remaining upstream advisories in its test/development toolchain. See
[public readiness](docs/public-readiness.md#dependency-audit-gate) for the
before/after counts, compatible lock-only fixes, remaining affected packages, and
the required Vitest/Vite upgrade and verification gate. GitHub Actions stays
disabled until that work is completed and evidenced.

1. Establish the imported ADR baseline without weakening the acceptance gate.
2. Clear the test/development dependency audit gate and validate the curated source
   on Bun 1.4.0 using bounded checks.
3. Make media/demo output roots configurable and add synthetic examples.
4. Select lightweight public CI only after dependency, config, and acceptance gates
   pass; then enable Actions deliberately.
5. Record actual release acceptance separately from historical source checks.

See [public readiness](docs/public-readiness.md) for evidence and limits.
