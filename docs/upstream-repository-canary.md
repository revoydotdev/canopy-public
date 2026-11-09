# Pinned upstream repository canary

`bun run demo:upstream-canary` records a governed Revoy2 campaign against an
exact revision of a third-party production repository. It exists to replace a
weak claim, "the same fixture works in several languages," with stronger but
still bounded evidence: a provider-backed campaign can enter a real upstream
layout, satisfy that repository's native acceptance command, pass independent
review and verification, and adopt only the verified result.

The closed catalog includes `BurntSushi/byteorder` at commit
`5a82625fae462e8ba64cec8146b24a372b4d75c6` (`Unlicense OR MIT`). Revoy injects
and commits a compile-failing compatibility test for missing five-byte unsigned
integer convenience methods. The package says
`requirement_origin: revoy_injected_compatibility_canary`; it never implies that
the task came from, was requested by, or was accepted by the upstream project.

The second cohort entry is `sindresorhus/yocto-queue` at commit
`b07eac099753833b29d06c614149904445739776` (MIT). It exercises a dependency-backed
JavaScript package and injects an AVA requirement for an atomic iterable queue
operation. Dependency preparation disables lifecycle scripts and package-lock
mutation, while the governed campaign and independent acceptance both use the
repository's declared `npm test` lane.

## Record the Codex-backed canary

Run from a clean, committed generator worktree with authenticated Codex CLI:

```bash
bun run demo:upstream-canary -- \
  --run-id byteorder-codex-YYYYMMDD-a \
  --integration codex \
  --generator-worktree "$PWD"
```

The generator worktree may start without `node_modules`. The canary installs
exactly its frozen lockfile before dispatch and then rechecks `git status`; it
refuses if dependency preparation changes any source-visible byte. This keeps a
fresh revision-pinned worktree executable without relying on hidden setup from a
previous run.

Record the JavaScript cohort entry with:

```bash
bun run demo:upstream-javascript -- \
  --run-id yocto-queue-codex-YYYYMMDD-a \
  --generator-worktree "$PWD"
```

Artifacts are sealed beneath
`/mnt/sda2/revoy2/exemplars/upstream-canary/<run-id>/`. The public package
contains:

- the exact upstream URL, revision, license, injected requirement identities, and
  native acceptance command;
- a red baseline and sanitized campaign result;
- adopted changed-path and diff-hash evidence, without republishing source;
- real-time, secret-scanned MP4 and WebM terminal recordings;
- nested media and outer package manifests plus reproducible checksums; and
- an explicit claim boundary.

The temporary clone, raw terminal stream, and unfiltered campaign evidence are
removed after publication. A package fails closed if the baseline is green,
the campaign is unattributable, adoption fails, native acceptance remains red,
no source path changes, media cannot be verified, privacy scanning fails, or
the generator/upstream revision is not exact.

## Evidence boundary

One sealed canary proves compatibility only for the named Revoy revision,
provider integration, task, and upstream revision. It does not prove upstream
endorsement, patch mergeability, arbitrary-repository compatibility, provider
equivalence, or unbounded autonomy. Frontier breadth requires expanding this
closed cohort across repository shapes and tracking longitudinal pass, cost,
latency, refusal, and recovery evidence without weakening that boundary.
