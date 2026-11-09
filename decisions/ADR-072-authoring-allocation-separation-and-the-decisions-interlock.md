# ADR-072: Authoring/Allocation Separation and the Decisions Interlock

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** 6f347583864801701de48e8e266f087d77c26279
**Content ID:** sha256:726db9407de1e2095a03ddaf5e42209a79c5850bead2dcf47099eb1782b6bd45

## Context

Four ADR-number collisions occurred across this session's cycles (063,
066/067, 068/069, 070/071), each costing a manual `decisions/registry.json` +
`decisions/README.md` conflict resolution. `scripts/lib/adr-registry.mjs`
already acquires a correct cross-worktree lock via `git rev-parse
--git-common-dir` — serialization was never the missing piece. The safe path
was unusable and broken, so every agent bypassed it, reproduced empirically
2026-08-15 in a detached worktree:

- **D1 — no scaffold command.** `allocate SLUG` required a hand-authored
  `decisions/ADR-PENDING-<slug>.md` carrying `**Content ID:**
  sha256:<64hex>` = `sha256(JSON.stringify({title, created_at,
  authoring_revision}))`. Only `verify` and `allocate` existed:
  `usage: adr-registry.mjs <verify|allocate SLUG>`; `parsePending` threw
  "lacks title, Date, Authoring Revision, Content ID, or Status metadata".
- **D2 — `allocate` (default `--commit`) failed whenever the pending file
  was never tracked** — the normal case, since nothing authored one through
  git. It staged the pre-rename path unconditionally:
  `git add -- decisions/ADR-PENDING-verify-allocator-probe.md … failed:
  fatal: pathspec 'decisions/ADR-PENDING-…md' did not match any files`.
- **D3 — failure rollback was incomplete.** `renderGovernanceCounts()` runs
  before the git step, and the catch restored the index, the registry, and
  the pending rename, but not the three rendered count documents. After a
  failed allocate the on-disk decision count and the rendered count documents
  disagreed by exactly one — the rendered docs claimed one ADR more than
  `decisions/` actually held. (A
  second, closely related gap surfaced while writing this ADR's own
  regression test: the catch's pending-file rename also restored the
  already-*rewritten* numbered content — the retitled `# ADR-NNN:` heading
  and swapped internal filename references — rather than the original
  pending text, so a retried allocation of the same draft failed
  `parsePending`'s own content-ID check against its own prior mutation.)
- **D4 — enforcement was advisory.** All four Claude Code hooks are
  `.hook-liveness/wrap.sh` logging wrappers; git `pre-commit` was
  claim-ledger-and-acceptance-only (deliberate scope, ADR-034's cousin
  narrowness). 26 gates detect drift at test time; nothing prevented it at
  action time for the decisions registry specifically.

## Decision

### Authoring and allocation are two separate acts

`newPendingDecision({repo, slug, title, status})` (`scripts/lib/adr-registry.mjs`,
wired as `adr-registry.mjs new SLUG --title "…" [--status Proposed]`) writes
`decisions/ADR-PENDING-<slug>.md` with the exact header grammar
`parsePending` requires, computing the Content ID via the existing
`contentId()` export — never re-derived by hand — plus a skeleton
`## Context` / `## Decision` / `## Consequences` and a commented obligation-
proof example. It refuses to overwrite an existing pending file, validates
the slug is lowercase kebab-case (the same check `allocateDecision` already
enforced), and emits `{ok, file, content_id, next_step}` where `next_step`
is the exact `allocate` command to run next. `new` never touches the
registry, the index, or git: authoring a draft carries no allocation
authority, so two agents can author concurrently without contention — only
`allocate`, serialized by the pre-existing common-dir lock, needs to
serialize.

### `allocate` stages only real changes

The git stage/commit step now stages the pending path only when
`git ls-files --error-unmatch` confirms it was tracked before the rename —
i.e., only when the rename is a real tracked deletion. An untracked pending
draft (the normal case, produced by `new`) is simply omitted from the
staged set; there is nothing to delete that git ever knew about.

### `allocate`'s rollback is now complete

Before `renderGovernanceCounts()` runs, every document it exports as
`ADR_COUNT_DOCUMENTS` (never a second, hand-maintained list) has its
pre-render text captured. On any later failure — including a failure in the
git step, which runs after the render — every captured document is restored
verbatim in the same catch handler that already restored the index and the
registry. The pending file's ORIGINAL text (captured before the
title-rewrite and internal reference substitution) is what gets restored on
rollback, not the already-rewritten numbered content, so a retried
allocation of the same draft succeeds identically to a first attempt.

### The decisions interlock

`scripts/hooks/pre-commit` (checked-in source, installed by
`scripts/install-git-hooks.mjs`) now runs
`scripts/decisions-precommit-gate.mjs` alongside its existing claim-ledger
and ADR-acceptance steps. When and only when the staged set touches
`decisions/`, it calls `verifyRegistry` and blocks the commit on failure
with a one-line remedy. A commit that does not touch `decisions/` never
calls `verifyRegistry` at all — zero added cost. `ARBOR_SKIP_DECISION_GATE=1`
bypasses the block, and doing so always appends an audit line — timestamp,
HEAD sha, staged `decisions/` paths — to `.hook-liveness/invocations.jsonl`:
a logged bypass, never a silent one.

## Consequences

Authoring a decision never mutates the registry, the index, or git history
— two or more agents can run `new` concurrently with zero contention, and a
draft that is never allocated leaves no trace beyond its own untracked file.

Allocation remains serialized by the pre-existing `git rev-parse
--git-common-dir`-scoped lock; this ADR does not introduce a new
serialization mechanism, it makes the existing one reachable without a
failed `git add` or a silently-stale governance document along the way.

The interlock's bypass is always logged, never silent: `.hook-liveness/
invocations.jsonl` carries every bypass's timestamp, HEAD sha, and the
staged `decisions/` paths that were let through unverified, so a bypassed
commit is auditable after the fact even though it was not blocked at commit
time.

**Honest limit.** A `git-common-dir`-scoped lock cannot span separate
clones — only worktrees of one shared `.git`. Two independent clones (e.g.
this repository checked out twice on different machines, or two CI
checkouts) can still both allocate the same number concurrently; this ADR
does not close that gap. Cross-clone allocation collisions remain a
merge-time reconcile, exactly as this session's four prior collisions were
resolved, and exactly as this ADR's own number (072) and its sibling
(073, allocated concurrently by a separate worktree under the same
`.git`) were reconciled by hand one final time before this ADR's own
fixes made that unnecessary going forward.

## Obligations

### O1 — `newPendingDecision` never touches the registry, the index, or git

<!-- proof: symbol=newPendingDecision file=scripts/lib/adr-registry.mjs roundtrip=scripts/tests/adr-registry.test.mjs -->

A real throwaway git repository's `decisions/registry.json` and
`decisions/README.md` are byte-identical, and `git status --porcelain`
reports no change to either, before and after calling `newPendingDecision`
— verified directly against real files and real git.

### O2 — `allocateDecision` succeeds when the pending draft was never tracked

<!-- proof: symbol=allocateDecision file=scripts/lib/adr-registry.mjs roundtrip=scripts/tests/adr-registry.test.mjs -->

Against a real throwaway git repository where the pending file exists only
on disk (never `git add`ed — the D2 precondition, confirmed by asserting
`git ls-files --error-unmatch` itself throws beforehand), `allocateDecision`
with `commit: true` succeeds, leaves `git status --porcelain` clean, and the
committed tree contains the numbered file but never the pending path.

### O3 — A forced post-render failure restores every governance-count document and the pending draft's original text

<!-- proof: symbol=allocateDecision file=scripts/lib/adr-registry.mjs roundtrip=scripts/tests/adr-registry.test.mjs -->

Against a real throwaway git repository with real `ADR_COUNT_DOCUMENTS`
fixtures committed, forcing the git step (which runs after
`renderGovernanceCounts`) to fail via a real .git/index.lock (git's own
transient lock, present only mid-operation, never checked in) — no
test-only production hook — leaves every `ADR_COUNT_DOCUMENTS` file
byte-identical to its pre-allocate content, the numbered file absent, the
pending file present with its original (not rewritten) text, and the
common-dir lock file gone. A retried allocation of the same draft then
succeeds.

### O4 — The decisions interlock blocks a `decisions/`-touching commit exactly when `verifyRegistry` fails, and is a no-op otherwise

<!-- proof: symbol=runDecisionsGate file=scripts/decisions-precommit-gate.mjs roundtrip=scripts/tests/decisions-precommit-gate.test.mjs -->

Against a real throwaway git repository, staging only a non-`decisions/`
path returns `{ok: true, skipped: true}` without calling `verifyRegistry`;
staging a `decisions/` path against a registry that fails verification
returns `{ok: false}` with the verification errors; staging a `decisions/`
path against a registry that verifies returns `{ok: true}`.

### O5 — `ARBOR_SKIP_DECISION_GATE=1` bypasses a failing gate and always appends an audit record

<!-- proof: symbol=runDecisionsGate file=scripts/decisions-precommit-gate.mjs roundtrip=scripts/tests/decisions-precommit-gate.test.mjs -->

With the bypass env var set against a `decisions/`-touching commit whose
registry fails verification, `runDecisionsGate` returns
`{ok: true, bypassed: true}` and appends exactly one JSONL record to
`.hook-liveness/invocations.jsonl` carrying `hook_id:
"decisions-precommit-gate"`, `bypass: true`, the real `HEAD` sha, and the
real staged `decisions/` paths; the log is never written when the bypass is
not used.
