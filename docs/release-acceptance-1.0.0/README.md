# 1.0.0 release acceptance manifest

`manifest.template.json` is a deliberately unbound template. Copy it to
`release-acceptance.json`, set `candidate_commit` to the full 40-character
commit under review, and replace each unavailable entry only when its
independent evidence producer has emitted and retained candidate-bound proof.
The checker does not run those producers, launch campaigns, or create proof.

Each required domain has exactly one record. A `passed` record contains:

```json
{
  "status": "passed",
  "kind": "observed",
  "commit": "<full candidate commit>",
  "producer": "<command or capture producer identity>",
  "scope": "<named workflow and limits covered by this proof>",
  "observed_at": "<ISO timestamp>",
  "artifact": "artifacts/<domain-proof.json>",
  "sha256": "<artifact SHA-256>"
}
```

The artifact path is relative to the manifest, must remain inside its
directory (including through symlinks), and is checked against its SHA-256.
`unavailable` is an explicit record with a human-readable `reason`; it is
reported as incomplete and never counts as a pass. Missing, malformed, stale,
or unbound records fail the check. Extra domain names fail as well, so new
release requirements need an intentional schema update.

Run from the repository root:

```sh
bun scripts/release-acceptance.mjs --manifest docs/release-acceptance-1.0.0/release-acceptance.json --candidate <commit> --json
```

The checker resolves the requested Git revision and requires the manifest's
candidate to match it. A normal check exits zero only when every domain has
hash-verified `observed` evidence for that candidate. An unavailable domain
or any fixture proof leaves `release_ready` false and exits nonzero.

The `fixture` evidence kind exists only to test checker behavior. It is
rejected by default. `--allow-fixtures` allows structural validation for
tests and exits zero when structurally valid, but the JSON and text reports
still keep `release_ready` false. Never use fixture records as release proof.

## Required domains

| Domain | Required coverage |
|---|---|
| `native_campaign` | Native campaign lifecycle and verified result path |
| `mcp` | MCP server protocol and governed operation path |
| `cli` | Shipped CLI entrypoints and operator workflow |
| `webui` | WebUI workflow and persisted state |
| `tui` | Launchable TUI workflow, including interactive behavior |
| `recovery` | Durable failure recovery and its evidence |
| `adoption` | Verified result adoption and independent post-adoption checks |
| `evidence` | Ledger integrity, provenance, and artifact binding |
| `selfhost` | Governed self-host workflow against the candidate |
| `external_cohort` | Named external integrations/cohort results and explicit cohort scope |

TUI pass records also require a `coverage` entry for `git.workspace` with
`status: "passed"`. At the `3c828333` baseline, the runtime catalog declared
this surface supported while production routers omitted its service. Until a candidate-bound artifact
demonstrates the actual routed path, record the TUI domain as unavailable;
catalog declaration alone cannot satisfy the requirement. External cohort
pass records require a `cohort` object naming the cohort, integrations, and
tasks so a result cannot silently generalize beyond its captured sample.

## Pinned external cohort

`external-cohort.json` is the pinned 1.0.0 external cohort (roadmap Phase 1,
P1-1a): one JavaScript, one Python, and one compiled-language repository, each
at an exact 40-character upstream revision, with its repository-native
acceptance argv, optional dependency-preparation argv, toolchain
prerequisites, the task text, and the Revoy-injected requirement file(s) that
make the task machine-checkable. Requirement contents are stored as lines
whose `\n`-joined bytes must hash to the recorded `sha256`. The requirement is
Revoy-authored; a passing run proves compatibility with that exact revision
and requirement only, never upstream endorsement or mergeability.

Validate the specification, and optionally resolve each declared tool on
`PATH` (a missing tool is reported as a blocker, never installed):

```sh
bun scripts/release-acceptance.mjs --cohort docs/release-acceptance-1.0.0/external-cohort.json --check-toolchains
```

An `external_cohort` pass record must bind this specification: its `cohort`
object carries `spec` (a path relative to the manifest) and `spec_sha256`; the
spec must validate, `cohort.name` must equal the spec's `cohort`, and
`cohort.tasks` must name every member `id`. A run that covered only part of
the cohort cannot pass the domain.

Dated run records for this cohort live under `evidence/`, with their retained
artifacts under `artifacts/`. A dated record reports what happened; only a
candidate-bound manifest entry can mark the domain passed.

The checker treats `coverage` and `cohort` fields as producer attestations. It
verifies their shape, candidate binding, and the artifact's hash, but it does
not interpret the artifact's internal proof. Independent producer review must
establish that the recorded workflow actually ran and passed.

This manifest covers the acceptance surfaces. It does not claim that any of
these live runs have occurred until their producer records candidate-bound
artifacts. External cohort identity and scope belong in that proof artifact;
the checker intentionally does not infer a cohort or acceptance from a
catalog entry.
