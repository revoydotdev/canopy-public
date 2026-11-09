# Fixture: `gate:vi-prepush-policy` must be able to fail.

The gate reads `.visual-intelligence/manifest.json` at its repository root and
then runs `git diff-tree` against `manifest.repo_revision`. This fixture points
`repo_revision` at a commit that does not exist in the repository the canary
runner builds, so the revision-inspection leg fails and the gate reports it
rather than silently falling through to the full-reproduction branch.

It deliberately does NOT trigger the full-reproduction path: that spawns a real
graph rebuild, which a canary must never do.
