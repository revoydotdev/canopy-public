# 1.0.0 release boundaries and checklist

Artifact kind: runbook
Status: active
Revision: 1
As-of commit: 43229b83 (2026-09-23)
Authority: release preparation checklist; the canonical roadmap and accepted ADRs govern sequence and policy
Evidence scope: mixed — repository declarations, dated audit records, and candidate-specific checks still required
Supersedes: none
Superseded by: none
Owner: Canopy/revoy2 maintainers
Review trigger: every release candidate, dependency/license change, public endpoint, or deployment-profile change

This checklist records product and release boundaries that an operator must
preserve. It is not a legal opinion, security certification, or 1.0.0 release
approval. The [canonical roadmap](roadmap-1.0.0-and-documentation-governance.md)
owns sequencing; the [release acceptance contract](release-acceptance-1.0.0/README.md)
defines the candidate-bound evidence manifest.

## Boundaries to keep visible

| Area | What the repository establishes | What a release operator must still establish |
|---|---|---|
| License | The root `LICENSE` declares MIT terms for the repository. | Review the exact candidate's dependencies, bundled assets, notices, and distribution obligations. The root license does not assign terms to third-party material. |
| Clean-room provenance | The project describes itself as an independently expressed implementation. The tracked license/provenance matrix is a technical classification and expressly is not legal advice or a legal-clearance conclusion. | Obtain the required owner/legal review of the complete provenance record for the distribution. Research records marked private are not public proof and must not be described as a completed legal review. |
| Secrets | Credentials are configured by the operator and must remain host-owned; the operator guide documents redacted diagnostics and credential leases. | Run secret scanning on the exact release candidate and review any finding. Do not put credentials, private pilot logs, or provider payloads in release artifacts. |
| Merge enforcement | Local hooks can refuse a push on an installed clone. They are opt-in and bypassable; the repository instructions record that server-side branch protection is unavailable in the current private/free-plan setup. | Record enforcement as `REPORTED`, not `BLOCKED`, until a protected server-side rule is independently observed on the release repository. |
| Provider-backed behavior | Provider and integration selection is explicit; unavailable credentials or sandbox capabilities fail closed. | Bind each live provider result to the candidate, provider/model revision, environment, command, and retained artifact. Deterministic fixtures and source reachability do not substitute for live acceptance. |
| Remote and multi-host deployment | Dated release-readiness and ADR records distinguish local/host-composed control from public transport. No public listener or multi-host service is established by a typed bridge alone. | Before enabling a listener, resolve channel binding, PKI and credential lifecycle, key custody, quotas, shared replay protection, and an independent adversarial review. Otherwise mark the deployment surface unavailable or out of scope. |
| External repositories | Enrollment recognizes declared project manifests and avoids inventing build/test commands. | Name the exact external repositories, revisions, integrations, tasks, and acceptance commands. A result applies only to the captured cohort. |

The detailed historical constraints remain in
[`release-readiness.md`](release-readiness.md),
[`frontier-operator-interface/assimilation/license-matrix.md`](frontier-operator-interface/assimilation/license-matrix.md),
and the [operator guide](operator-guide.md). The dated records are not
re-certified by this checklist.

## Candidate checklist

Run these steps against one immutable candidate commit:

1. Freeze and record the full 40-character candidate commit. Any later source
   change creates a different candidate.
2. Install from the lockfile and run the repository's required local gates:

   ```bash
   bun install --frozen-lockfile
   bun run build
   bun run tests:typecheck
   bun run test:all
   bun run docs:metadata -- --require-headers
   bun run docs:inventory:check
   ```

3. Copy `docs/release-acceptance-1.0.0/manifest.template.json` to
   `docs/release-acceptance-1.0.0/release-acceptance.json`; bind it to the
   candidate and add only independently produced, hash-verified artifacts.
   Keep unsupported or unmeasured domains as `unavailable` with a reason.
4. Run the acceptance checker against that exact commit:

   ```bash
   bun run release:acceptance -- --manifest docs/release-acceptance-1.0.0/release-acceptance.json --candidate <full-commit> --json
   ```

5. Review clean-room/provenance, dependency notices, security/secret scan,
   deployment limits, failure-artifact retention, and every unavailable
   domain. Preserve the manifest, producer artifacts, and review record
   together.

The checker returns `release_ready: false` while any required domain is
unavailable or lacks candidate-bound proof. A passing checker validates
manifest structure and artifact binding; an independent reviewer must still
confirm each artifact supports its claimed workflow. Do not describe 1.0.0 as
ready until the exact candidate also passes every phase gate in the canonical
roadmap.
