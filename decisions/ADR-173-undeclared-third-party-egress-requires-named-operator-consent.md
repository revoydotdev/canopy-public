# ADR-173: Undeclared Third-Party Egress Requires Named Operator Consent

**Status:** Accepted
**Date:** 2026-09-28
**Authoring Revision:** 4e3d021fabcfc10392272713692dc7251e975f03
**Content ID:** sha256:b7fc510bf1459883fee79fd3c8619492148afd6265924de851c192c1d3903a40

## Context

`scripts/observe-devtools.sh` is an external headless observer. It tails the
campaign's DevTools event log and hands the newly-appended complete lines to a
headless `opencode` agent, which returns a Markdown health digest.

"Asking a model for a digest" is a network egress. The script shipped with
`MODEL="${OBSERVER_MODEL:-opencode/deepseek-v4-flash-free}"` — a third-party
hosted model as a *default* — plus a `*/15 * * * *` crontab installer and a
900-second loop. The installed crontab entry carried neither `--model` nor any
consent argument, so every unattended fire silently re-derived that default.

Three properties made the result indefensible, and they compound:

1. **The destination was implicit.** An operator reading `--install-cron` had
   no way to see which third party their campaign's runtime event log was being
   sent to before it was sent.
2. **The header claimed `READ-ONLY`.** It was true of local state and false of
   the network, and the one-word version of the claim was the false one. A
   maintainer auditing the repository had a reason to skip the file.
3. **Failure was swallowed.** The transmit ended `|| true`, so a provider
   refusal, an auth failure, and a successful digest were indistinguishable
   from the exit status and the log.

The affected parties are not the same person. The repository maintainer is
misled by the header. Separately, whoever's campaign runs on the machine has
their live runtime event log transmitted off it every fifteen minutes, by a
schedule nobody installed deliberately, having consented to nothing.

An earlier audit of this repository reported **zero** outbound telemetry, and
struck the finding on six recorded probes. Every probe searched a *vendor* axis
— twelve vendor names, `*telemetry*` filenames, declared dependencies, tokens
inside `*telemetry*` modules. This file contains no vendor name, is not named
`*telemetry*`, and declares no dependency. The negative was not merely wrong;
it was wrong *by construction*, and a control that cannot see a class reports
the class as absent.

## Decision

**Egress that leaves the machine is never implied by a default, an
environment variable, a schedule, or a mode. It requires an explicit opt-in
that names the destination, and the name must equal the destination actually
used.**

Mechanically, in any script that transmits:

1. **No default destination.** A third-party model identifier is never the
   fallback value of a configuration variable. The operator supplies it.
2. **Consent names the destination.** `--allow-third-party-egress=<provider/model>`.
   The value is compared for exact equality against the model the run would
   transmit to, and a mismatch is refused. A bare flag is refused identically
   to omission, so there is one refusal path rather than two that can diverge.
3. **Scheduling is consent, and the schedule carries it.** Installing an
   unattended egress requires the same named opt-in, and the installed entry
   embeds both the model and the consent. A consent granted once to install is
   the consent the unattended run is held to, and the fire cannot drift onto a
   destination nobody approved.
4. **A refusal states its reason and its remedy.** "No model configured",
   "no consent given", and "consent names a different model" are distinct
   refusals, each naming the flag that would resolve it. One bare `exit 2` for
   all three would be indistinguishable from a gate that has stopped
   discriminating.
5. **Failure is the exit status.** A failed transmit is logged, recorded, and
   propagated. It is not converted to success by a trailing `|| true`.
6. **Claims are scoped to what they are true about.** A `READ-ONLY` claim, where
   it survives, names the axis it holds on.

## Consequences

Consent becomes a value in the invocation rather than an assumption behind it.
The refusal is unconditional in the sense that no flag combination short-cuts
it, and conditional in the sense that supplying the named opt-in makes every
path work — the observer is not left permanently broken.

Two costs are accepted. First, every existing caller of the observer must now
name a model, which is the point but is a breaking change for scripted use.
Second, the refusal is the default, so an unattended schedule that predates this
decision stops firing until re-installed with consent; a stopped observer is the
correct failure direction.

The generalisable cost is the one the audit already demonstrated. Any census of
egress that searches by *vendor identity* will report this class as absent,
because the destination is a string in a shell variable and the file is named
after the feature rather than the party. **Census rules must search the
mechanism, not the counterparty.**

## Alternatives / Roads not taken

**Delete the observer.** Rejected: the digest is genuinely useful, and removing
the consumer does not address the general rule. The defect is the absence of
consent, not the presence of the feature.

**Keep the default but log loudly.** Rejected. A log line nobody reads is not
consent, and it leaves the false `READ-ONLY` header in place.

**Require only a bare `--yes`.** Rejected. A boolean records that *someone*
consented; it does not record *what they consented to*. The operator must be
able to see the destination before it is used, and a flag whose value is
ignored by the checker cannot carry that.

**Rely on the environment variable already present.** Rejected: `OBSERVER_MODEL`
is a configuration convenience, and a configured value is not an authorisation.
An environment variable present in a cron environment is not a decision anyone
made about this data.

**Cite an existing record instead of allocating one.** Rejected, and worth
recording because the trailer gate permits it: `scripts/adr-trailer-check.mjs`
accepts a trailer whose number merely *exists* in the registry, and does not
check that the record governs the change. ADR-164 governs a *local* opt-in
redacted sink; ADR-017 defines what telemetry *is* in this repository's model
rather than when it is authorised. Citing either would have turned a red gate
green for the wrong reason — the same shape as a census that reports a class
absent because it cannot see it.

## Obligations

### O1 — No third-party destination is a default; consent names the destination actually used

The observer declares no fallback model identifier, and every code path that
reaches the model compares the operator-supplied consent value for exact
equality against the model the run would transmit to.

<!-- unverifiable: require_egress_consent is a bash function, not a top-level export, and adr-proof.mjs cannot cite it; demonstrated instead by the 12 hermetic runs and the three guard-deletion mutations recorded in .omo/graph-remediation/evidence/todo-4-telemetry.txt -->

### O2 — An unattended egress schedule cannot be installed without named consent

`--install-cron` refuses with a non-zero status and a message naming the
required flag when the named opt-in is absent, and the entry it installs
carries both the model and the consent so a later fire cannot drift.

<!-- unverifiable: install_cron is a bash function with no exported declaration and no roundtrip test file; the same 12 hermetic runs cover it, using a stub crontab so no real schedule is ever installed -->

### O3 — A transmit failure is never reported as success

The transmit call's status is captured, logged with the model and the report
path, and returned as the run's exit status; no trailing `|| true` converts a
provider failure into a successful exit.

<!-- unverifiable: run_agent is a bash function and the asserting signal is the script's process exit status, which adr-proof.mjs does not model; verified by mutation M3, which restores the swallow and turns the observed exit code red -->
