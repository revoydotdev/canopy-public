# ADR-177: Governance Acts Only Inside Canopy Harness Runs

**Status:** Accepted
**Date:** 2026-10-01
**Authoring Revision:** dc039389efe9e68b5fc228fc8db2b6f7f15ba481
**Content ID:** sha256:089d7ed454a7bc2af36c9bf6aa3f52ba6d62584f068f833423402ca47f0a1892

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR governance
by ADR-024's ratification note).

revoy2 began as a governance layer for other harnesses (Claude Code, Codex,
OpenCode). Its discipline was therefore enforced from outside whatever agent
happened to be working: thirteen Claude Code hooks and three Codex hooks
registered through `scripts/host-controls.json`, git hooks installed into
every clone and, through a global `core.hooksPath`, into every repository on
the workstation, and a pre-push battery (ADR-025) that re-ran the gate
profile on every push.

The product direction has changed. Canopy is a first-class harness in its own
right, differentiated by governance, provenance, audit trails, strict internal
security and UCT-oriented search; wrapping other harnesses is a post-alpha
side goal. On 2026-10-01 the operator stated the consequence directly: every
mechanism that governs an agent's work, imposes disciplined conventions or
blocks subversion is to be source-level architecture that acts when the Canopy
harness runs, and must not fire on a Claude Code or Codex session, because in
a pre-alpha product it constantly fires on the harness's own development and
impedes it for no benefit.

Two pieces of that already exist. The Arboretum M1 lane devolved every host
hook onto the native hook bus (`gate:hook-devolution`: 16 devolved, 0 pending)
and both host configurations now register no hooks. ADR-170 (Accepted) moves
native-feasible gate logic into `packages/arbor-*`. What remained was the git
hooks, which still refused commits and re-ran the battery for every caller.

## Decision

1. **A Canopy harness run is marked, positively.** `GOVERNED_RUN_ENV`
   (`ARBOR_GOVERNED_RUN=1`, `packages/arbor-core/src/governed-run.ts`) is set
   by the harness on every process it spawns: the native tool host's process
   runner and every sandbox broker path, including inside bubblewrap's cleared
   environment.

2. **External enforcement surfaces act only under that marker.**
   `scripts/hooks/pre-commit`, `commit-msg` and `pre-push` exit 0 unless it is
   present. A host agent session or a human terminal never carries it, so no
   repository hook can refuse, delay or re-run gates on work the harness is
   not running. The gates themselves are unchanged and still run inside a
   harness run and when invoked directly.

3. **Host-agent hooks stay retired.** No mechanism may be re-registered in
   `.claude/settings.json`, `.codex/hooks.json` or any other host's
   configuration. A capability a host hook used to provide is provided by the
   native hook bus.

4. **All governance logic moves to source level, including what ADR-170 kept
   external.** ADR-170 placed ~30 gates in `packages/` and kept ~17
   git-provenance and real-execution gates external permanently. Under this
   record every gate's logic becomes an exported, tested function in
   `packages/`, invoked by the harness; a `scripts/*-gate.mjs` file survives
   only as a thin CLI wrapper, never as the implementation. Real execution
   (tests, `tsc`) and git ancestry remain the techniques those gates use;
   what changes is that the harness owns when they run.

5. **The operator's own workstation policy is out of scope.** The global
   `~/.config/git/hooks/commit-msg` attribution check applies to every
   repository on the machine by the operator's choice and is not repository
   governance.

## Consequences

**Positive.** A Claude Code or Codex session developing this repository is no
longer refused a commit for a missing trailer, held to a session window it
never opened, or made to wait on a multi-minute push battery. Governance
verdicts come from one implementation the harness calls, in its own loop,
where it has live state, instead of from a parallel shell layer that
reconstructs that state from git after the fact.

**Negative, and deliberate.** Work pushed from outside a Canopy run is not
gated at all until the harness runs over it. ADR-025 already recorded that
local hooks were never server-side protection and that `--no-verify` bypassed
them; this record accepts that gap rather than papering over it. Nothing here
claims a pushed commit passed the gate profile unless a harness run says so.

**Negative, load-bearing.** Decision 4 is substantial and unfinished: roughly
65 gate scripts still hold their own logic. Until each migrates, the harness
reaches it through the script. This record sets the direction; it does not
claim the migration is done.

## Alternatives / Roads not taken

- **Leave the git hooks enforcing for every caller.** Rejected by the operator:
  it is exactly the impedance this record exists to remove.
- **Delete the git hooks outright.** Rejected: the harness still drives git,
  and the hook is the only point at which a commit it makes can be checked
  before it exists. Gating them on the marker keeps that for harness runs
  and removes it everywhere else.
- **Detect a harness run from the repository-session record.** Rejected:
  records outlive their sessions (this repository carries records from
  ordinary Claude Code sessions), so their presence says nothing about who is
  running git now. A marker the harness sets on its own children does.

## Obligations

### O1 — The marker is defined once, in the core, and recognised exactly

<!-- proof: symbol=isGovernedRun file=packages/arbor-core/src/governed-run.ts roundtrip=packages/arbor-core/tests/governed-run.test.ts -->

`isGovernedRun` accepts only `ARBOR_GOVERNED_RUN=1`; an absent, empty or
differently-spelled value is not a governed run.

### O2 — Every process the native harness spawns carries the marker

<!-- proof: symbol=withGovernedRun file=packages/arbor-core/src/governed-run.ts roundtrip=packages/arbor-mcp/tests/native-tool-host.test.ts -->

A command run through the native tool host reads `ARBOR_GOVERNED_RUN` back as
`1`.

### O3 — The repository git hooks are inert without the marker

<!-- proof: symbol=GOVERNED_RUN_ENV file=packages/arbor-core/src/governed-run.ts roundtrip=scripts/tests/governed-run-git-hooks.test.mjs -->

commit-msg and pre-commit exit 0 with no output when the marker is absent and
commit-msg enforces when it is present; `pre-push-ref-binding.test.mjs` proves
the same for pre-push, including a multi-ref push it would otherwise refuse.

### O4 — Every gate's logic lives in packages/ and the harness invokes it

<!-- unverifiable: owed — about 65 scripts/*-gate.mjs files still hold their own logic; each migrates under ADR-170's one-commit-per-gate rule, extended here to the git-provenance and real-execution gates ADR-170 kept external. -->

Discharged when no `scripts/*-gate.mjs` contains logic beyond argument parsing,
a call into `packages/`, and reporting.
