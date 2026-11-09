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

## Remaining gates

- Establish a public baseline for the history-dependent ADR acceptance checks.
  The existing `build` command retains its audit gates; it is not advertised as
  freshly passing on this history-free snapshot. `bun run typecheck` is the
  separate compilation/type-check command, not an acceptance certificate.
- Verify the curated source on the declared Bun version with explicitly selected
  lightweight checks before enabling an appropriate public CI workflow.
- Replace the media/demo output-root assumptions: `/mnt/sda2` appears in 22
  source/config files and 13 documentation files. These are separate from normal
  workdir resolution; do not assume those demo paths work on another host.
- Recreate omitted visual demonstrations with new synthetic fixtures if needed.
  Placeholder documentation describes omissions; it does not supply the original
  material or establish that any associated requirement has passed.

Legacy internal package identifiers remain `revoy2`; the CLI remains `arbor`.
The product presented by this repository is Canopy.
