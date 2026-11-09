# Fixture: `gate:decisions-precommit` must be able to fail.

The gate is a pre-commit interlock. It reads `git diff --cached --name-only` in
its repository root and, when a staged path is under `decisions/`, verifies the
ADR registry and BLOCKS the commit if that verification fails.

Reaching that check needs a repository with a genuinely STAGED `decisions/`
change, which is why this fixture ships its own git directory at `.canary-git/`
and the profile points `GIT_DIR`/`GIT_WORK_TREE` at it.

The directory is deliberately NOT named `.git`: git refuses to track any path
containing a `.git` component, so a fixture using that name could never be
committed and its canary would rot the moment it was cloned. `.canary-git` is an
ordinary directory, so it commits and clones like any other fixture content.

For the same reason the profile does NOT set `git_repo: true`. The runner's
`initGitRepo` runs its own `git init` + `git add -A` + `git commit` in the scratch
root, which would commit the staged change away and leave the gate with a clean
index — and the gate would then take its `skipped: true` early return and pass
its own canary. A green that measured nothing.

What the gate is actually rejecting here: `ADR-900-canary-unallocated.md` is
staged and `Status: Accepted`, but `decisions/registry.json` allocates no such
number. That is the defect the gate exists to catch.
