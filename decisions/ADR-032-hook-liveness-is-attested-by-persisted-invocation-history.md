# ADR-032: Hook Liveness Is Attested by Persisted Invocation History

**Status:** Accepted
**Date:** 2026-08-07

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR governance
by ADR-024's ratification note), and POL-05 flags any record arriving already
accepted as never having traversed the lifecycle.

## Context

Every gate in this repository asks whether the code is right. Nothing asks
whether the things doing the asking still work.

Hooks fail in a uniquely quiet way. A broken gate usually goes red; a broken
hook keeps emitting a confident verdict long after it stopped measuring
anything, and because the verdict *looks* like output, nobody investigates.
Three instances are on the record, all found by hand during a single audit:

1. **vi-freshness.sh reported `DIVERGED — 42 uncommitted path(s)` at every
   session start, against a working tree with zero uncommitted paths, for
   roughly 42 consecutive sessions.** It read `.visual-intelligence/.dirty`,
   which is append-only and which nothing cleared. Worse, the verdict ladder
   tested dirtiness before distance, so the false alarm *masked* the true
   `STALE` verdict underneath it.
2. **`vi-freshness-gate.mjs` printed "…and is not degraded" on every run** from
   a check reading `manifest.planes.derived.reachability` — a key no manifest
   the extractor produces has ever contained. The check could not fire.
3. **The vendored skill's VENDOR.md promised `npm run gate:vi-vendor` would detect edits to
   vendored files.** The script did not exist. A 65-line divergence between the
   vendored copy and upstream went unreported.

All three are one shape: **a signal that cannot vary, presented as a signal
that does.** ADR-025 already named the consequence in a different register — a
signal nothing blocks on gets skimmed, and POL-04 fired 29 times unacted. A
signal that cannot change is the limit case of that.

ADR-030 established the right instinct — liveness is attested by *invocation*,
not by analysis — but it is **deliberately stateless**. `runLiveness()` builds a
throwaway composition root, probes once, returns an in-memory report, and
persists nothing. That is correct for seam liveness, where the current answer is
the whole question. It is insufficient for hook rot, because "has this stopped
varying" is a claim about *history*, and history is the one thing ADR-030 does
not keep.

## Decision

**Persist an append-only invocation log for hooks, and judge each hook against a
hand-authored declaration of what its output is supposed to do over time.**

1. **`.hook-liveness/hook-manifest.json` (committed, hand-authored).** Per hook:
   `{hook_id, event, expect_variability, why}`. Machine-read, hand-written — the
   same convention as `scripts/reachability/entry-points.json`, and for the same
   reason: the answer is a judgement no extractor can derive.

   `expect_variability` is the load-bearing field. Without it the rot rule
   cannot distinguish a hook that is **correctly quiet** from one that is
   **broken and quiet**, and would flag every working guard.

   | Value | Applicable invocations | For |
   |---|---|---|
   | `always` | all | output tracks repository state, so constancy is suspicious |
   | `conditional` | only those with non-empty stdout | silence is the normal resting state |
   | `never` | none | legitimately constant output; exempt by explicit declaration |

2. **`.hook-liveness/wrap.sh` (committed).** Records that a hook fired and what
   it decided. Registered *around* the real hook rather than edited into it.

3. **`.hook-liveness/invocations.jsonl` (gitignored, bounded at 1000 lines,
   trimmed to 500).** Session-local and machine-specific; committing it would
   merge one machine's hook history into another's.

4. **The rot rule.** Over the last `window` (20) applicable invocations, if at
   least `min_samples` (10) were recorded and every `verdict_hash` among them is
   identical, the hook is `SUSPECTED-ROTTED`.

5. **`npm run gate:hook-liveness` is REPORT-ONLY, permanently, and has no CI
   job.**

### Why the instrumentation is in the registration, not the hooks

The hooks are vendored (ADR-031). The vendored skill's VENDOR.md rule 1 forbids editing them, and
an edited vendored copy is no longer a copy of anything. So
`scripts/vi-install-hooks.mjs` registers
`.hook-liveness/wrap.sh <path-to-real-hook>` instead of the hook path directly.
The vendored files stay byte-identical to upstream and `gate:vi-vendor` keeps
passing.

### Why the wrapper is the most conservative script in the repository

A bug in one hook affects that hook. A bug in the wrapper affects **every** hook
at once — including a `PreToolUse` guard whose failure mode is denying every
edit in the repository. So the wrapper: fails open at every step (a recording
failure still runs the hook and passes its output through); is byte-transparent
in both directions, using temp files rather than command substitution, which
would strip trailing newlines from a JSON payload; never touches stderr;
preserves the real hook's exit code; and never writes to stdout itself, because
stdout is the hook's decision channel and Claude Code parses it as JSON.

### Why report-only, permanently

A rot verdict is a statistical claim over local invocation history. It is a
strong hint and a weak proof: a hook can legitimately return the same verdict
twenty times because the repository genuinely did not change. Blocking a push on
that would be blocking on an inference — the precise substitution this line of
work exists to stop.

### Why there is no CI job, breaking the one-job-per-gate convention

CI never fires a Claude Code hook, and `invocations.jsonl` is gitignored. In CI
this gate would read an empty log and print a clean result forever: **a check
that cannot fail, reported as a check that passed.** That is defect #2 from the
Context, reproduced inside the mechanism built to detect it. A vacuous green job
is worse than no job, so there is no job.

## Consequences

**Positive.** The failure mode that produced all three recorded defects becomes
detectable rather than requiring an audit to find. The rot rule was validated
against the real historical failure: replaying twenty `DIVERGED — 42 uncommitted
path(s)` verdicts produces `SUSPECTED-ROTTED`. `NEVER-FIRED` additionally
catches a hook that is registered but not wired — which is how vi-graph-debt.sh
sat vendored and unregistered.

**Negative, and load-bearing.** The manifest is hand-authored, so it carries the
same honesty risk as every hand-authored declaration in this repository: a wrong
`expect_variability` makes the rot rule wrong in a way nothing detects.
Declaring `never` on a hook that should vary silently exempts it forever. The
`why` field on each entry exists so that a reviewer can argue with the
judgement, but nothing enforces that it is right.

**Negative.** Evidence is local and machine-specific. A hook that rotted on one
developer's machine is invisible on another's, and a fresh clone starts with no
history and reports `INSUFFICIENT` until twenty applicable invocations
accumulate.

**Negative.** Every hook now runs through an extra process. The wrapper's cost
is two temp files, a `jq` call, and a `sha256sum` per invocation — small, but it
is on the path of every tool use, and it is a new dependency on `jq` at a point
where the previous failure mode was silence.

## Alternatives considered

1. **Extend ADR-030's `runLiveness()` to cover hooks.** Rejected: ADR-030 probes
   seams by dispatching synthetic requests against a composition root. A hook is
   invoked by Claude Code with real tool-use context that cannot be synthesised
   faithfully; a probe would attest to the probe's fixture, not to the hook.

2. **Have each hook self-report.** Rejected: requires editing vendored files,
   forbidden by ADR-031 / VENDOR.md rule 1, and a rotted hook is exactly the
   thing least able to report its own rot.

3. **Evaluate a shell `condition_probe` from the manifest in the wrapper**, so
   `conditional` hooks could be judged precisely. Rejected: it would mean
   `eval`-ing manifest content inside the one script whose blast radius is every
   hook. "Produced non-empty output" is a fact the wrapper already records and is
   a good enough proxy.

4. **Commit `invocations.jsonl`.** Rejected: merging one machine's hook history
   into another's produces a log that describes no machine.

5. **Make the gate blocking once enough history accumulates.** Rejected for now;
   revisit only with evidence that rot verdicts have been reliable in practice.
   Blocking on an unvalidated inference is how `gate:anti-stub` would have
   behaved had it not defaulted to REPORT-ONLY, and 9 of its first 10 findings
   were false positives.

## Obligations

### O1 — A hook's invocations are recorded without altering what the hook does

<!-- unverifiable: the wrapper is .hook-liveness/wrap.sh, a shell script; the proof grammar's symbol= has nothing to cite in a non-JS/TS file. -->

The wrapper must be byte-transparent in both directions and preserve the exit
code. Verified by running a wrapped and an unwrapped hook on identical stdin and
comparing stdout byte-for-byte.

*No proof comment: the wrapper is `.hook-liveness/wrap.sh`, a shell script, and
the proof grammar's `symbol=` resolves only against exported declarations under
`packages/*/src`. Citing an unrelated TypeScript symbol to satisfy the parser
would be a false proof of exactly the kind `gate:obligations` exists to prevent.
Discharge is the transparency check recorded in this ADR's Consequences.*

### O2 — A hook whose verdict has stopped varying is reported

<!-- unverifiable: the rot rule lives in scripts/hook-liveness-gate.mjs, which declares no exported top-level symbol; it is a bare CLI entrypoint. -->

The rot rule fires on the real historical failure. Verified by replaying twenty
identical `DIVERGED — 42 uncommitted path(s)` verdicts through
`scripts/hook-liveness-gate.mjs` and observing `SUSPECTED-ROTTED`.

*No proof comment, same reason as O1: the gate is a repository script, not a
package export.*

### O3 — A hook that is registered but never fires is distinguished from one that fires and repeats

<!-- unverifiable: the NEVER-FIRED vs SUSPECTED-ROTTED verdict logic is in scripts/hook-liveness-gate.mjs, an unexported CLI entrypoint with no top-level symbol to cite. -->

`NEVER-FIRED` and `SUSPECTED-ROTTED` are separate verdicts. Conflating them
would have hidden vi-graph-debt.sh, which was vendored and never registered.

### O4 — The instrumentation never edits a vendored file

<!-- unverifiable: the wiring is scripts/vi-install-hooks.mjs and .hook-liveness/wrap.sh, and the check is gate:vi-vendor's scripts/vi-vendor.mjs; none declare an exported top-level symbol. -->

*Cross-reference: `gate:vi-vendor`'s own obligations (ADR-031 O2) carry the
same reason — the hash-comparison script it runs has no exported symbol
either.*

`npm run gate:vi-vendor` must continue to pass after the wrapper is wired, and
must report zero edited files.

### O5 — Silence is not counted as evidence of rot for hooks that are silent by design

<!-- unverifiable: the expect_variability filtering logic is in scripts/hook-liveness-gate.mjs, an unexported CLI entrypoint with no top-level symbol to cite. -->

`expect_variability: conditional` restricts the applicable set to invocations
with non-empty stdout. Without this, every working `PreToolUse` guard would be
flagged.
