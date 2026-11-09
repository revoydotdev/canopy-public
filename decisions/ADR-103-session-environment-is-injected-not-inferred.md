# ADR-103: The Agent Is Told Its Environment Rather Than Left To Infer It

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 5afc268fd12b3731abf2ba5b1ca52a3c941f8153
**Content ID:** sha256:71c73d0b714e95e06d46915e105a9138291e36b55874bfd09fd68c7cd087f690

## Context

The 2026-08-26 four-agent parity audit against revoy2 @ 5afc268f found that
nothing in `packages/arbor-prompts/src/` injects git status, working
directory, platform, or the current date into a composed system prompt. That
verifies: `PromptContext` (`packages/arbor-prompts/src/index.ts:3-25`) carries
exactly `campaignId`, `taskDescription`, `foregroundFragment`, and
`repoInstructions` — the last of these, `resolveRepoInstructions`
(`repo-instructions.ts`), reads `AGENTS.md`/CLAUDE.md content within an
8,000-byte budget and hands it to `repoInstructionsBlock`
(`index.ts:45-50`), which frames it with `framedContext`'s
`instruction-authority="context-only"` wrapper. No sibling block exists for
cwd, git status, platform, or date; grepping `packages/arbor-prompts/src/` for
`git status`, `process.platform`, `cwd()`, or `new Date()` returns nothing.
Both Claude Code and Codex CLI inject all four by default, so an arbor agent
is reasoning about a repository it has not been told the state of, while a
peer harness's agent has.

This repository's own operating condition makes the naive fix wrong. ADR-078
(`decisions/ADR-078-tests-over-repository-state-run-against-a-frozen-snapshot.md`)
recorded, with a directly reproduced mechanism, that hashing "every
non-generated, non-gitignored file" in a live checkout is a function of
whatever else is happening in the tree — `HEAD` itself advanced twice during
that investigation from ambient activity alone — because "this repository's
normal operating mode is several agents committing into one checkout." The
present session is a live instance of that condition: a concurrent Codex
session is committing into this checkout while this ADR is drafted. A naive
design — read git status once, bake it into a cached system-prompt block,
reuse it for the campaign's duration — would silently tell every later turn a
`git status` a sibling agent's commits had already invalidated, which is
worse than no git status at all: a wrong observed input is false confidence.
`PromptContext` already has a seam built for this shape — `repoInstructions`
is resolved fresh per call from `resolveRepoInstructions`, never cached
across a campaign — and git status must inherit that discipline, not
`foregroundFragment`'s snapshot-once shape.

`packages/arbor-mcp/src/target-isolation-guard.ts` already shells out to git
safely and synchronously for isolation checks — `resolvePrimaryCheckout`
(`execFileSync("git", ["-C", from, "rev-parse", "--git-common-dir"], ...)`)
and `readCurrentBranch` are the existing, tested precedent that this
repository already treats "spawn `git` and parse its stdout" as a safe,
bounded operation at session-composition time, not an anti-pattern to avoid.

## Decision

**1. `PromptContext` gains an `environment` field carrying a typed,
timestamped snapshot — not a plain string.** A new
`packages/arbor-prompts/src/environment-context.ts` exports
`ArborEnvironmentSnapshot`: `{ cwd: string; platform: NodeJS.Platform; date:
string /* ISO 8601 */; git: ArborGitStatusSnapshot | null; observed_at: string
/* ISO 8601 */ }`, where `ArborGitStatusSnapshot` is `{ branch: string | null;
head: string | null; dirty: boolean; ahead_behind: { ahead: number; behind:
number } | null }`. `observed_at` is mandatory and distinct from `date`:
`date` is the calendar fact the agent reasons with (matching Claude
Code/Codex's date injection); `observed_at` is the provenance timestamp
§4's staleness-honesty requirement reads.

**2. A new `resolveEnvironmentSnapshot(worktreePath)` function composes the
snapshot fresh, mirroring `resolveRepoInstructions`'s call-time-resolution
contract rather than `foregroundFragment`'s pre-derived-and-passed-in
shape.** It shells to `git` the same bounded way
`target-isolation-guard.ts`'s `readCurrentBranch`/`resolvePrimaryCheckout`
already do (a short-timeout `execFileSync`, never interactive), reading `git
status --porcelain=v1 --branch` in one call to get branch, ahead/behind, and
dirty state together. A git failure (not a repository, git not installed, a
timeout) resolves `git: null` — never a thrown error, and never a
silently-stale cached value standing in for it.

**3. A new `environmentBlock` renderer joins the unexported `repoInstructionsBlock` helper
inside `packages/arbor-prompts/src/index.ts`, framed the same way** — through the existing
`framedContext("environment", ...)` helper with the same
`instruction-authority="context-only"` wrapper `repoInstructionsBlock` and
`foregroundBlock` already use, so a stale or adversarial-looking git status
line cannot be read as a directive. Unlike `repoInstructions` (root/plan-level
only, per ADR-022/G-10), the environment block renders for every prompt
function that composes a `PromptContext`, since cwd/platform/date/git-dirty
state are relevant at any depth.

**4. Staleness is a declared property of the snapshot, not an implicit
risk.** The rendered block states its own `observed_at` timestamp inline
(`"Environment observed at {observed_at}; may be stale if the repository has
changed since."`) rather than presenting git status as current fact. The
caller composing a `PromptContext` (the campaign runner, building a session's
initial prompt) calls `resolveEnvironmentSnapshot` immediately before
composition — this decision adds no automatic mid-session refresh or
background poller; a long-running session re-resolves at its next prompt
composition, the same event-driven cadence `repoInstructions` already uses.

## Consequences

An arbor agent reasoning about "should I `git add` this file" or "is my
worktree clean" gets the same baseline situational fact Claude Code and Codex
already give their agents, closing a concrete parity gap the audit named.
Because the snapshot is provenanced and framed as context rather than
instruction, a stale value is a labeled, honest degradation rather than a
silent wrong answer — the property ADR-078's incident showed this repository
cannot skip. This does not change `resolveRepoInstructions`,
`repoInstructionsBlock`, or the 8KB repo-instructions budget; it adds a
sibling block through the same `framedContext` mechanism. It also does not
add a filesystem/environment-watching capability — no file watcher, no
background poller — only a call-time snapshot resolved the moment a prompt
is composed.

The cost: every prompt composition that includes an environment block now
shells to `git` — a real synchronous cost per session start, competing with
whatever else is hitting the checkout concurrently, the exact condition
ADR-078 flagged. A campaign with many short-lived leaf sessions pays this
repeatedly rather than once, unlike `repoInstructions`, which amortizes
across a worktree's lifetime via its own resolution cache upstream of
`PromptContext`. This decision does not add a shared cache for the
environment snapshot across sibling sessions in one worktree — doing so
safely means solving cache invalidation under concurrent mutation, out of
scope here and left for a future decision if the per-session git cost proves
material.

## Alternatives / Roads not taken

**Cache the git snapshot once per campaign and reuse it across every
session's prompt, the way `foregroundFragment` is derived once and passed
in.** Rejected: this is precisely the shape ADR-078 already proved unsafe —
a cached repository fact goes stale under concurrent commits, and this
checkout's actual operating condition (a concurrent Codex session committing
during this session) is not a hypothetical, it is the present tree state.

**Poll git status on a timer and push a refreshed environment block into a
running session.** Rejected: it adds a background process with its own
failure modes (a poller that dies silently, a refresh landing mid-turn) for a
benefit — staying current between compositions — a short-lived leaf session
rarely needs. The event-driven "re-resolve at next composition" cadence
matches how `repoInstructions` already behaves.

**Fold the environment snapshot into `repoInstructions`'s existing block.**
Rejected: `repoInstructions` is operator-authored configuration with
git-history provenance ("never a ledger-witnessed MemoryFact," per its own
doc comment); an environment snapshot is an *observed* runtime fact with a
different provenance and staleness contract. Merging them would force
git-status framing to inherit the root/plan-level-only restriction
ADR-022/G-10 placed on repo instructions (wrong — every depth needs
cwd/platform/date), or force repo instructions to inherit a staleness caveat
that doesn't apply to checked-in files.

## Obligations

### O1 — `PromptContext` and its rendering pipeline are the real, exported seam the environment block extends

`PromptContext` is the exported interface every prompt-composition call site
already threads through `crownPrompt`/`cambiumPrompt`/`taprootPrompt` and the
other role prompts; `repoInstructionsBlock`'s existing pattern (a
`framedContext`-wrapped, context-only-authority block gated on an optional
field) is the concrete mechanism `environmentBlock` mirrors. Proving this
symbol demonstrates the seam this decision extends is real, tested, and
already in the render path every prompt function calls.

<!-- proof: symbol=resolveRepoInstructions file=packages/arbor-prompts/src/repo-instructions.ts roundtrip=packages/arbor-prompts/tests/repo-instructions.test.ts -->

### O2 — Git status reads in this repository already run through a bounded, tested `execFileSync` call, not an unbounded shell-out

`readCurrentBranch`/`resolvePrimaryCheckout` in `target-isolation-guard.ts`
are the existing precedent that shelling to `git` synchronously at
composition time is a pattern this repository already trusts and tests, with
a bounded timeout and typed null-on-failure result — the exact shape
`resolveEnvironmentSnapshot`'s git read reuses rather than inventing a new
git-invocation convention.

<!-- proof: symbol=resolveEnvironmentSnapshot file=packages/arbor-prompts/src/environment-context.ts roundtrip=packages/arbor-prompts/tests/environment-context.test.ts -->

### O3 — The environment block never renders without its `observed_at` provenance timestamp, and a git-read failure degrades to `git: null`, never a stale cached value or a thrown error

This is the staleness-honesty property this ADR's Context section commits to
in response to ADR-078: the rendered block must always carry the timestamp
of the observation it is reporting, and a failed or unavailable git read
must be visibly absent from the block rather than silently omitted or
replaced by a prior campaign's value.

<!-- proof: symbol=formatEnvironmentSnapshot file=packages/arbor-prompts/src/environment-context.ts roundtrip=packages/arbor-prompts/tests/environment-block.test.ts -->
