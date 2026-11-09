# ADR-167: Verifier Drift Is Measured Against Versioned Adversarial Holdouts

**Status:** Accepted
**Date:** 2026-09-23
**Authoring Revision:** 0daed8256e1a9d811bd0308594c983a714353beb
**Content ID:** sha256:283630066a61935786a227b09dfc8fdbafcd4373e37781f5862d50c9322190e2

## Context

The Q2/Q3 2026 literature review identifies a risk that a fixed verifier loses discrimination as its proposal policy or harness changes. It recommends evaluating verifier quality for faithfulness, robustness, and scalability. This is a research framing, not evidence that Revoy2's current critic or tests have drifted.

Revoy2 separates proposal, critic approval, and verified outcome. A green result is meaningful only for the named evaluator and fixture versions; reusing it after those change can conceal reward-hacking, scope, evidence, or semantic failures.

## Decision

Authorize a versioned verifier-drift evaluation against a frozen task holdout and adversarial fixtures. Each evidence record identifies the proposer/model and harness versions, verifier portfolio and criteria versions, fixture version, and policy version. The cohort includes reward-hack, scope, evidence, and semantic-but-noncompliant candidates plus legitimate completions under matched budgets.

Measure detection of adversarial candidates and false rejection of legitimate work, with blinded independent review of a sample. Re-run the cohort when a proposal policy, generator model, harness, verifier portfolio, or acceptance policy changes, and include the current versions in release-candidate review.

Evaluation results may recommend a verifier change but cannot change acceptance policy automatically. Any policy change requires an explicit human decision and a new version; prior evidence remains bound to the versions it tested.

## Consequences

The verifier's evidence remains interpretable as generator and harness capabilities evolve. Frozen holdouts and adversarial review add maintenance cost, and the cohort cannot prove that a verifier is robust to every unseen strategy.

## Alternatives / Roads not taken

- **Assume a green verifier remains valid indefinitely.** Rejected because generator, harness, and evaluator changes alter the tested relationship.
- **Allow the harness to tune acceptance criteria from observed results.** Rejected because the proposing system must not self-approve or silently weaken its gate.
- **Re-run only after a production failure.** Rejected because it offers no evidence that known adversarial cases remain detectable before release.

## Obligations

### O1 — Verifier evidence is version-bound and includes adversarial and legitimate cases

Each E3 record names the complete version tuple, frozen holdout, adversarial and legitimate cohorts, matched budgets, measured false acceptance and rejection, and independent review sample.

<!-- unverifiable: E3 is a proposed experiment; no result is claimed until a tracked evidence record exists. -->

### O2 — Verifier evaluation cannot change acceptance policy automatically

The evaluation workflow records recommendations separately from policy changes; every changed criterion has an explicit human decision and a new version identity.

<!-- unverifiable: E3 is a proposed experiment; its workflow and evidence have not been created. -->
