# ADR-160: Commits, evidence and gates run once, at a durable session close

**Status:** Accepted
**Date:** 2026-09-04
**Authoring Revision:** 578ba339a6940ac443b0730e9ec26949d6bdecdc
**Content ID:** sha256:fb7040e4e9b3833323e3e722fc6e9b7f11337d682eabc887db7556cd7344f630

## Context

The governance chain this repository built is correct and expensive in the
wrong places. Measured on 2026-09-03, over one working session:

- `evidence:rebind` cost eight to twelve minutes per source commit series,
  three times in the session, and holds a lease under which every pre-commit
  gate fails; one commit that landed during a rebind invalidated the rebind.
- The Stop hook ran the stop tier at every turn boundary (ADR-074 decision 4)
  at a median of ~16 s per turn (ADR-156), reporting drift the session was
  still in the middle of causing, with no way to act on most of it until the
  work was finished.
- The pre-push battery then ran the same gates a third time.
- Every governed commit needs a trailer naming its ADR (ADR-155), which an
  author answers by running a `git log` incantation and reading it with
  judgement. A harness working on its own repository cannot do that.

The operator's instruction was direct: defer every commit to a durable
session-end signal, then run the rebind and the gates once, at the end, as a
single contiguous process; interviews for any decision the session authored
happen after that and before the push; and the ADR resolution must be a
function that works on any governed repository and stays out of the way on
an ungoverned one.

## Decision

**1. A session is a durable record, and its close is a signal.**
`packages/arbor-mcp/src/repo-session-store.ts` keeps
`<git-common-dir>/arbor/sessions/<sid>/state.json` (never in the working tree,
like stop-guard's state). The session-start hook opens it, the session-end hook
records how it ended, and `arbor repo-session close` closes it with a receipt.
A session is `open`, `closing` (its commit window is open), `closed`, or
`abandoned` (a window retired for want of an actor). The implementation was
ported out of the deleted coordinator script on 2026-09-30; the decision did
not change, and the session-end hook still records the end without ever
closing.

**2. Commits are deferred to the commit window.** While a session is `open`,
the pre-commit hook refuses (`arbor repo-session-assert-window`) with the
remedy: open the window (`arbor repo-session open`), commit by concern, then
`arbor repo-session close`. `ARBOR_COMMIT_WINDOW=1` is
the explicit, logged escape for a commit that cannot wait. With no session
record — a plain terminal, a foreign repository reached through a global
`core.hooksPath` — nothing is refused: this governs agent sessions, not
people, and the pre-commit hook now exits 0 outside this repository.

**3. The close is one contiguous process, composed of existing authorities.**
`--finish` refuses over uncommitted source, then runs `evidence:rebind`, the
store-only evidence commit, `gate:all --tier stop`, `gate:all --tier full`
(every gate, cumulative) and `decision-queue --json`, stopping at the first
red step and writing a receipt either way. In both gate runs
`gate:decision-queue` is advisory, and only there: a session that authored
a record can clear that gate only through the operator's interview, which
is the step after the close (decision 5); the push's own battery keeps it
hard-blocking. It does not write commit
messages, accept decisions, write the interview ledger, or push.

**4. The Stop hook stands down while a session is open.** ADR-074 decision 4
made the stop tier an end condition at every turn. Under this record the hook
prints the session posture and exits 0 while the session is `open`, and
while a close receipt is green at HEAD; in every other state (`closing`,
closed-red, no session record) it runs the battery and vetoes exactly as
ADR-074 defined. ADR-074 otherwise stands: the roster, the tiers, the
advisory set and the escape hatch are unchanged. The end condition moves
from the turn to the session.

**5. Interviews follow the close and precede the push.** The receipt reports
what the decision queue owes (`push_allowed`); the interview itself remains
the operator's, through `/revoy2-interview` (ADR-158).

**6. The governing ADR is resolved, not remembered.** `scripts/adr-resolve.mjs`
ranks candidates for a path from three substrates that already exist:
history (the ADRs cited by commits touching the path, latest commit weighted
highest, repeated citation weighted logarithmically), obligation proofs
(`file=`/`roundtrip=` naming the path), and, only when a path has none of
its own, the nearest ancestor directory below the governed root.
Superseded and rejected records and unallocated numbers are never
suggested. The commit-msg guard (ADR-155) auto-fills the trailer only when
every governed staged path resolves to one confident record, and otherwise
refuses with the ranked candidates. A repository with no decision registry
or no decisions directory is `ungoverned`: empty trailer, no demand.

## Consequences

**Easier.** One rebind and one battery per session instead of one per
commit series and one per turn; a session's turns are no longer taxed for
drift they cannot yet fix; the trailer is a function; a harness can close
its own session on its own repository. The receipt is the durable evidence
that the close happened, with every step's status and duration.

**Harder / costs.** Work-in-progress is uncommitted for longer, so the
session record, the SessionEnd note and the SessionStart report exist to
make that state visible rather than lost; an operator who wants a commit
mid-session opens the window or uses the logged escape. A wrong auto-filled
trailer would survive every gate, which is why the resolver only fills a
unique, confident result and shows candidates otherwise.

## Alternatives / Roads not taken

- **Keep ADR-074's per-turn battery and only speed it up.** ADR-156 already
  budgets the stop tier; the cost was not the seconds but the timing: a red
  gate mid-task is not actionable, and a green one proves nothing about the
  close.
- **Auto-commit at close from the resolver's groups.** Rejected: the commit
  message is the author's claim about the change and its concern; the
  resolver can name the record, not the reason.
- **Run the close in the SessionEnd hook.** Rejected: a ten-minute rebind in
  an exit hook is invisible and unkillable; the close is an explicit command
  with a receipt.
- **Fold tool argument schemas into a nested trailer schema for the
  resolver.** Not applicable here; recorded because the same day's bridge
  work rejected schema nesting for the CLI validator for the same reason a
  resolver should not over-claim: one unsupported keyword refuses every turn.

## Obligations

### O1 — the close runs its steps in order and refuses to skip a red one

<!-- proof: symbol=closeSession file=packages/arbor-mcp/src/repo-session-lifecycle.ts roundtrip=packages/arbor-mcp/tests/repo-session-lifecycle.test.ts -->

`closeSession({ repo, run })` refuses over uncommitted source with the
commit plan, then runs rebind, evidence commit, stop tier, full tier and
decision queue in that order through an injectable runner, stops at the
first red step with a status naming it, and writes a receipt either way.
Proven with a recording runner on a throwaway repository: the order is
asserted literally, a red stop tier is shown to prevent the battery, and a
red rebind is shown to prevent any commit.

### O2 — a commit is refused only while an agent session is open without a window

<!-- proof: symbol=assertWindow file=packages/arbor-mcp/src/repo-session-lifecycle.ts roundtrip=packages/arbor-mcp/tests/repo-session-lifecycle.test.ts -->

`assertWindow(repo, env)` allows a commit when there is no session record,
when the window is open, or when `ARBOR_COMMIT_WINDOW=1`, and refuses with
the remedy only for an open session; proven on a throwaway repository
through each of those states in sequence.

### O3 — the resolver names a governing record only when the evidence is unique, and stays silent on an ungoverned repository

<!-- proof: symbol=resolveAdrsForPaths file=scripts/adr-resolve.mjs roundtrip=scripts/tests/adr-resolve.test.mjs -->

`resolveAdrsForPaths({ repo, paths })` returns per-path ranked candidates
and one suggestion whose `trailer` is non-null only at `unique` confidence.
Proven on a throwaway governed repository (history, proof, superseded and
unallocated cases, ancestor fallback below the confident score) and on a
bare repository with no registry (`ungoverned`, empty trailer).
