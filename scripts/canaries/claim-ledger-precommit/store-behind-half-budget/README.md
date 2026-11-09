# Fixture: `gate:claim-ledger-precommit` must be able to fail.

The hook measures how far `.claim-ledger/` trails HEAD. When the store is more
than HALF its budget behind (7 commits against a budget of 10), it refreshes and
stages the store, and it BLOCKS the commit if that refresh fails.

Reaching that branch needs real git history, so this fixture ships a repository
at `.canary-git/` with seven seed commits plus a manifest pinned to the root
commit — 7 behind, comfortably past the 5-commit half-budget threshold. The
profile points `GIT_DIR`/`GIT_WORK_TREE` at it and does NOT set `git_repo: true`,
because the runner's own `initGitRepo` would overwrite this history.

The refresh then fails for the reason a real one would: this `package.json` has
no `claims:refresh` script, so `bun run claims:refresh` cannot run and the hook
aborts the commit. That is the failure path the hook exists to produce — it
proves the hook BLOCKS rather than silently continuing when the store cannot be
brought up to date.

The directory is named `.canary-git` and not `.git` on purpose: git refuses to
track any path with a `.git` component, so a fixture using that name could never
be committed, and this canary would rot on the next clone.
