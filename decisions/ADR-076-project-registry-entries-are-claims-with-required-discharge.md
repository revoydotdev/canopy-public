# ADR-076: Project Registry Entries Are Claims With a Required Discharge

**Status:** Accepted
**Date:** 2026-08-18
**Authoring Revision:** 3188f57c07005adba85ffe6f9fbc3ace17b42dd9
**Content ID:** sha256:558674488b7d3c6daa6f57667c7f38fa5b94374cbee9a60719fd65a5c4d0a923

## Context

Roadmap 23 identifies the four structural blockers between this repository and
a harness that can create, enroll, and manage multiple projects. Blocker B4 is
that **no registry of enrolled projects exists**. Without one there is no
"manage": no way to ask which projects are under governance, which are failing
gates, or which carry stale evidence.

The obvious shape — a file listing project paths — is where this decision
actually has to be made, because the repository already has two incompatible
precedents for what such a file *means*.

**Precedent 1: derived facts.** `deriveRepositoryCounts` and
`deriveGapStatusScanDocuments` compute their answers from on-disk content on
every call. `packages/arbor-governance/src/counts/documents.ts` records why the
scan set stopped being hand-maintained: a hand-picked list "reproduced, one
level up, the exact defect this module family exists to catch: a fact about the
repository maintained by hand and drifting the moment somebody added a
document."

**Precedent 2: dated, discharged claims.** `scripts/reachability/allowlist.json`
and `scripts/branch-accounting/dispositions.json` each require a reason and an
expiry, and an expired entry fails its gate. The allowlist states the principle:
a waiver is "a decision with a shelf life, not a permanent exemption."

A project registry cannot follow precedent 1. A project's location is external
input — nothing on disk inside this repository can derive that some other
checkout exists at `/some/path` and is enrolled. Derivation is unavailable by
construction, not by omission.

But a naive hand-maintained list inherits exactly the defect precedent 1 was
created to escape. The registry would assert "project X is enrolled and
conformant" and that assertion would rot silently: the path moves, the profile
changes, the project stops passing its own gates, and the registry keeps
saying otherwise. This repository has a documented, repeated history of exactly
this failure — `ROADMAP.md`'s gap register described finished work as open
release blockers for as long as twelve commits, which is what motivated
`gate:gap-status` (SUR-06).

Registering a project is therefore a **claim about a thing outside this
repository**, which is the one category the existing derivation machinery
cannot check and the one most likely to go stale.

## Decision

**A project registry entry is a claim, not a fact, and carries a required
discharge.**

Concretely:

1. **The registry records an assertion, never a conclusion.** An entry states:
   `project_id`, `path`, the `profile_hash` observed at enrollment, the
   `verified_at_revision` of that project, and a `verified_at` timestamp. It
   does **not** state "conformant" as a standing property.

2. **The discharge is a conformance run against that path.** An entry is
   discharged when `evaluateConformance(path)` — reachable from the CLI since
   Roadmap 23 W1 added `--root` — passes and the project's profile still
   hashes to `profile_hash`. Discharge is re-established by re-running, never
   by editing the entry.

3. **An entry expires.** Following the allowlist and disposition precedent,
   every entry carries an expiry. An expired entry fails the registry gate.
   This is what prevents the silent-rot failure above: the registry cannot
   keep asserting conformance for a project nobody has checked recently.

4. **A drifted `profile_hash` is a failure, not an auto-update.** If the
   project's profile changed, the entry's claim about what was verified is no
   longer true. Re-enrollment is an explicit act. Silently absorbing the new
   hash would make the recorded provenance meaningless — the same reasoning
   ADR-012 applies to recovery being explicit rather than an automatic startup
   mutation.

5. **An unreachable path is reported, never pruned.** If a registered path no
   longer exists, the gate reports it and fails. It must not self-heal by
   deleting the entry, because "the project we were governing has vanished" is
   precisely the fact an operator needs to see.

**What this decision does not decide.** Whether governance *state* is
centralized or federated — this fixes the semantics of the registry, not the
storage topology of `.arbor` directories. Nor does it decide how a
non-TypeScript project expresses its gate commands; ADR-073's `commands` block
is bare package.json script names today and a second-language project will
force that question separately.

## Consequences

**Positive:**

- The registry inherits the repository's existing, proven discipline (reason +
  expiry + mechanical discharge) rather than inventing a new one, so it fails
  loudly in the one direction that matters: asserting governance over a project
  it has not actually checked.
- "Manage N projects" acquires a checkable meaning. The management surface
  (Roadmap 23 W6) becomes a fold over discharged entries rather than a
  best-effort sweep.
- Enrollment (W4) gets a precise success condition: an entry whose discharge
  passes on the day it is written.

**Negative:**

- Every enrolled project imposes recurring verification cost. A registry of N
  projects means N conformance runs to keep the gate green, and that cost grows
  linearly. This is the deliberate price of not asserting what is unchecked.
- An operator who moves a project must re-enroll rather than edit a path. That
  friction is intentional but real.

**Neutral:**

- The registry file's location and exact schema are implementation detail for
  Roadmap 23 W2 and are not fixed here beyond the five required fields.

## Obligations

Each states a property this decision requires, with a proof citation an
external reader can resolve. They are numbered so a later record can supersede
one individually.

### O1 — An entry records an assertion, never a standing conclusion

<!-- proof: symbol=ProjectRegistryEntry file=packages/arbor-mcp/src/project-registry.ts roundtrip=packages/arbor-mcp/tests/project-registry.test.ts -->

The entry type carries `project_id`, `path`, `profile_hash`,
`verified_at_revision`, `verified_at` and an expiry, and carries no
`conformant`/`ok`/`status` field. The test asserts the shape explicitly rather
than asserting a value, so adding such a field fails the suite.

### O2 — Discharge is a live conformance run, never a cached verdict

<!-- proof: symbol=verifyRegistryEntry file=packages/arbor-mcp/src/project-registry.ts roundtrip=packages/arbor-mcp/tests/project-registry.test.ts -->

Verification re-runs conformance against the registered path on every call, via
`runConformanceCheck`. A project that regresses after registration therefore
fails without its entry changing.

### O3 — An expired entry fails even when the project itself is healthy

<!-- proof: symbol=evaluateProjectRegistry file=packages/arbor-mcp/src/project-registry.ts roundtrip=packages/arbor-mcp/tests/project-registry.test.ts -->

The claim is stale regardless of the underlying truth; that is what makes the
expiry a forcing function rather than decoration.

### O4 — A drifted profile hash fails and is never silently absorbed

<!-- proof: symbol=computeProfileHash file=packages/arbor-mcp/src/project-registry.ts roundtrip=packages/arbor-mcp/tests/project-registry.test.ts -->

Re-enrollment is the only path that updates a recorded hash. Verified directly:
after mutating a registered project's `arbor.profile.jsonc`, the gate reports
`profile_drifted` and the persisted entry still holds its original hash.

### O5 — An unreachable path is reported and retained, never pruned

<!-- proof: symbol=evaluateProjectRegistry file=packages/arbor-mcp/src/project-registry.ts roundtrip=packages/arbor-mcp/tests/project-registry.test.ts -->

"The project we were governing has vanished" is the fact an operator most needs
to see, so the gate must not self-heal by deleting the entry.

### O6 — A gate that did not run is never reported as a passing gate

<!-- proof: symbol=manageProjects file=packages/arbor-mcp/src/project-manage.ts roundtrip=packages/arbor-mcp/tests/project-manage.test.ts -->

The management fold distinguishes `not_applicable` (the gate cannot target
another project) and `not_run_discharge_failed` (the entry's own claim is void)
from `pass`. Verified directly: drifting a registered project yields all
catalog gates `not_run_discharge_failed` and zero passes.

## Test implications

- An entry whose `profile_hash` no longer matches the project's profile fails
  the gate rather than being rewritten.
- An entry past its expiry fails the gate even when the project itself is
  fully conformant — the claim is stale regardless of the underlying truth.
- An entry whose `path` does not exist fails and is reported, and the entry is
  still present afterwards.
- A registry with zero entries passes: governing no projects is a valid state,
  not a failure.
- Discharge is computed by running conformance against the registered path, so
  a project that regresses causes its entry to fail without the entry changing.
