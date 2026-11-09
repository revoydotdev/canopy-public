# ADR-182: The Stop Battery Runs Only Gates Whose Declared Inputs Changed, and Owned Baseline Debt Does Not Block

**Status:** Accepted
**Date:** 2026-10-06
**Authoring Revision:** 0340135296b271230647f545eb6723873f64a822
**Content ID:** sha256:0f105adb848fe774b71794ceb1812e52ad605f49aa3ba4e3b24c55e088c74c74

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances).

Arboretum M2 (`docs/proposals/arboretum-coordination-plane.md` §7.3 moves 1
and 2, §9 M2, §12 item 2). The native stop battery (`9a7ec933`) runs the
whole stop tier — 38 gates — on every measured turn boundary, whatever the
turn changed, and refuses the turn on any blocking red. The proposal records
a session in which every turn reported the same seven red gates, none caused
by the turn: "red means you broke something" stopped being true, and the cost
was paid on every stop. Running this record's own implementation on its
worktree reproduced the shape: four blocking reds (`gate:adr-trace`,
`gate:decision-queue`, `gate:ledger-audit`, `gate:vi-freshness`) on a change
that touched none of their inputs.

M2 depends on M1 (ratified by `ADR-PENDING-gate-canaries-and-tri-state-results`) so
that a gate scheduled out is one whose green, when it runs, means something.

## Decision

1. **A gate may declare its inputs.** `inputs` in a gate's
   `scripts/execution-profile.json` entry is a non-empty list of
   repository-relative globs; `auditExecutionProfile` rejects an empty,
   non-string, absolute or `..`-escaping entry. A gate with no `inputs`
   always runs: an unknown read-set is treated as everything, and inputs are
   declared by a reviewer reading the gate's source, never inferred. This
   record declares six: `gate:adr-sections` and
   `gate:adr-retirement-integrity` (`decisions/**`), `gate:lockfile`,
   `gate:package-boundaries`, `gate:execution-profile` and
   `gate:remedy-coverage`. Gates whose verdict depends on something that is not
   a repository path — wall-clock expiry, the git common dir, another
   process's evidence transaction, history — stay undeclared.

2. **Declared inputs are widened, never narrowed.** Every declared gate also
   reads `package.json`, `bun.lock`, `scripts/execution-profile.json`,
   `scripts/gate-all.mjs`, `scripts/gate-manifest.json` and `scripts/lib/**`,
   plus its entry script and that script's static import closure, with an
   `@arbor/<pkg>` import widened to the whole workspace package
   (`gateImplicitInputs`). Editing a gate's implementation re-runs it.

3. **The harness schedules; `gate-all.mjs` keeps the roster.** The measuring
   half of the native stop battery records the session's base (HEAD at its
   first measurement, never moved) and computes the changed set: uncommitted
   and untracked paths, paths committed since the base, and the paths the
   native `observe.vi-dirty-tracker` recorded in `.visual-intelligence/.dirty`
   (`changedPathsSince`). Every stop-context gate whose declared and implicit
   inputs no changed path matches is passed to the battery as
   `--skip` (`scheduleStopGates`). `gate-all.mjs` prints each as `SKIP`,
   reports it in `--json`, refuses a skip naming an undeclared gate, and still
   runs any gate the caller did not name. If any source of the changed set
   cannot be read, nothing is scheduled out. `ARBOR_STOP_BATTERY_SCOPE=all`
   runs the whole tier, and the observer's ledger note says which mode ran.
   This is ADR-177 decision 4's division: the harness owns when a gate runs.

4. **The verdict's cache key includes the changed set.** The key gains a
   digest of the changed path set beside the HEAD oid and dirty count, so two
   trees with the same number of dirty paths but different paths are measured
   separately.

5. **Pre-existing reds are owned baseline debt.**
   `scripts/stop-guard/debt.json` lists gates observed red at a recorded
   revision, each owned by a decision record. It is written only by
   `bun scripts/stop-guard-debt.mjs open <gate> --owner ADR-NNN --reason …`,
   which refuses a dirty tree, refuses an owner with no file in `decisions/`,
   RUNS the gate and refuses one that exits 0, and records the observed exit
   code and HEAD. `close` removes an entry. The battery only reads the record
   (`loadBaselineDebt`), and an entry that fails validation is dropped, so a
   broken record can make a red block but never hide one.

6. **Attribution is by gate, and only owned reds stop blocking.** A blocking
   red that an entry owns is rendered as one line naming its owner and
   revision and does not refuse the turn. A battery whose every blocking red is
   owned allows the turn and resets the no-progress breaker. Any unowned red
   still blocks, and the breaker fingerprints only the unowned set
   (`unownedBlocking`), so owned debt cannot make two different session
   failures look like one.

7. **Scoped cost is kept out of the whole-tier ratchet.** A run with skipped
   gates records its total under `stop:scoped` in measured costs, never under
   `stop`, which `gate:stop-budget` (ADR-156) reads as the cost of the whole
   tier.

## Consequences

**Positive.** A turn that changed nothing a declared gate reads no longer pays
for that gate, and a red the session did not cause can be owned once instead
of refusing every turn. A red that is NEW still blocks.

**Negative, stated rather than implied.**

- Six of 38 stop gates are declared, so most of the tier still runs on every
  measurement until more declarations are reviewed in. The p50 reduction the
  proposal names as its measurement has not been taken.
- The debt record starts empty. Owning the reds this tree carries today is an
  operator decision per gate (who owns it), so none is opened here, and those
  reds keep blocking until they are owned or fixed.
- Attribution is by gate name. A session that breaks an owned gate in a new
  way is not distinguished from the baseline red on that gate; the debt line
  names the gate so the reader can check.
- A path a shell command wrote and committed before the session's first
  measurement is outside the recorded base. The `.dirty` record covers native
  file-tool writes regardless.
- Prepush and CI select gates from the profile and never read this schedule
  or the debt record, so neither relaxes a push.
- Until Rings (M3) exists the debt record is a repository file, not a machine
  index event, which adds one governance store against the proposal's §10
  aim to reduce their count.
- The proposal's third §7.3 move — re-tiering the repository-wide gates to the
  session close — is not decided here.

## Alternatives / Roads not taken

- **Let `gate-all.mjs` compute the schedule.** Rejected: ADR-177 decision 4
  puts "when a gate runs" in the harness. The battery owning the roster and the
  harness naming only what to skip also means a stale view can only run too
  much.
- **Measure debt automatically at the session's first turn.** Rejected: the
  first measurement already includes the first turn's edits, and an
  automatically recorded debt has no owner.
- **Infer inputs from a gate's source.** Rejected: the proposal's §1.4 records
  prose-to-write-set inference at recall 0.27; inputs are declared, and only
  the import closure — a mechanical widening — is derived.

## Obligations

### O1 — An input declaration is validated in the profile

<!-- proof: symbol=auditExecutionProfile file=scripts/enforcement-control-plane.mjs roundtrip=scripts/tests/enforcement-control-plane.test.mjs -->

Absent and well-formed `inputs` pass; empty, non-string, absolute and escaping
entries are problems.

### O2 — Only a declared gate whose inputs are untouched is scheduled out

<!-- proof: symbol=scheduleStopGates file=packages/arbor-mcp/src/hooks/stop-battery-scope.ts roundtrip=packages/arbor-mcp/tests/hooks/stop-battery-scope.test.ts -->

An undeclared gate is never skipped, a change under a declared input or to the
roster files schedules the gate in, and an incomplete changed set skips
nothing.

### O3 — Editing a gate's implementation re-runs it

<!-- proof: symbol=gateImplicitInputs file=packages/arbor-mcp/src/hooks/stop-battery-scope.ts roundtrip=packages/arbor-mcp/tests/hooks/stop-battery-scope.test.ts -->

The entry script, its relative import closure and any imported workspace
package are inputs of every declared gate.

### O4 — The changed set includes committed, uncommitted and tool-recorded paths

<!-- proof: symbol=changedPathsSince file=packages/arbor-mcp/src/hooks/stop-battery-scope.ts roundtrip=packages/arbor-mcp/tests/hooks/stop-battery-scope.test.ts -->

The union covers a commit since the base, a modified file, an untracked file
and a `.dirty` entry, and an undiffable base marks the set incomplete.

### O5 — The native battery passes the schedule and keeps its base

<!-- proof: symbol=measureStopBattery file=packages/arbor-mcp/src/hooks/stop-battery.ts roundtrip=packages/arbor-mcp/tests/hooks/stop-battery.test.ts -->

The battery is spawned with `--skip` naming the untouched declared gate, without
it once that gate's input changes, and a change committed after the first
measurement stays in the changed set.

### O6 — gate-all honours a skip without dropping it

<!-- proof: symbol=parseSkipList file=scripts/gate-all.mjs roundtrip=scripts/tests/gate-all.test.mjs -->

A skipped gate does not run and is reported as skipped, and a skip naming an
undeclared gate exits 2 having run nothing.

### O7 — Scoped runs do not feed the whole-tier budget

<!-- proof: symbol=measuredCostsTier file=scripts/gate-all.mjs roundtrip=scripts/tests/gate-all.test.mjs -->

A run with skipped gates records under `<tier>:scoped`.

### O8 — Debt is opened only on a witnessed red against a clean tree, with an existing owner

<!-- proof: symbol=openDebt file=scripts/stop-guard-debt.mjs roundtrip=packages/arbor-mcp/tests/hooks/stop-battery-scope.test.ts -->

`open` refuses a green gate, a dirty tree and a missing owner, and the reader
accepts what it writes.

### O9 — An invalid debt entry owns nothing

<!-- proof: symbol=loadBaselineDebt file=packages/arbor-mcp/src/hooks/stop-battery-scope.ts roundtrip=packages/arbor-mcp/tests/hooks/stop-battery-scope.test.ts -->

Entries with a missing owner record, empty reason, short revision, zero exit
code or duplicate gate are dropped with a problem line; a malformed file is no
debt.

### O10 — Only owned reds stop blocking, and the breaker judges the unowned set

<!-- proof: symbol=unownedBlocking file=packages/arbor-mcp/src/hooks/stop-battery.ts roundtrip=packages/arbor-mcp/tests/hooks/stop-battery.test.ts -->

A turn whose only red is owned is allowed; an unowned red beside owned debt
blocks, the refusal renders the debt line, and the breaker's fingerprint covers
the unowned red alone.
