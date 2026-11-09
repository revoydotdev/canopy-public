# canary: gate:vi-reproducible — the clean-worktree guard fails closed

`scripts/vi-refresh.mjs --check` evaluates the CD-BR-05 clean-worktree rule
BEFORE any extractor runs, and it fails CLOSED: if the target root's git state
cannot be read at all, the refresh cannot claim to have measured a commit, so
it stops rather than extracting over state no commit describes. This fixture
is a directory that is not a git repository, which is what makes that read
fail.

`git_repo` is deliberately ABSENT here. With `git_repo: true` the scratch would
be a repository and this canary would be proving a different, later check
instead.

## What this does and does not prove

It proves the fail-closed path is live: the guard runs, it reads the target
root, and a root it cannot read stops the refresh. It does NOT prove the
gate can detect a graph that fails to reproduce — that check is `--check`'s
structural comparison, and it only exists after the whole extraction pipeline
has run over an entire source tree, so no minimal fixture can reach it.

## A second, non-portable failure this fixture runs into

The dirty-scope check that follows spans BOTH checkouts when `--root` names a
foreign directory ("with a foreign `--root` the in-scope set spans two
checkouts"). So with `git_repo: true` and a clean fixture, this gate can still
be made red by an uncommitted file in the REAL repository's extraction scope.
That is a real property of the gate, not of this fixture: a canary for
`gate:vi-reproducible` cannot be made independent of the working tree's
cleanliness as long as the guard is reached at all. Fail-closed is reached
first and is the only stable discriminator, which is what this fixture uses.
