# gate:interview-attestation canary — `git_repo: true` is load-bearing, not decorative

`readInterviewReceipts(REPO_ROOT)` resolves the receipt store through
`git rev-parse --git-common-dir`, which THROWS on a non-repository. This gate
calls it unguarded, so a fixture without `git_repo: true` does not fail the
gate — it crashes it, with a Bun stack trace and no verdict line at all. That is
a non-zero exit, but it is a crash being counted as a gate result.

Note the asymmetry with `scripts/decision-queue.mjs`'s `interviewAttestation`,
which wraps the same call in `try { … } catch { store = { present: false, … } }`
with the comment "tolerating a clone that has no receipt store at all". The two
gates read one store and disagree about what a missing store means. See the
report.

With `git_repo: true`, the runner initialises a repository in the scratch, so
the store under test is that scratch repository's own common dir. It is absent
there, `readInterviewReceipts` reports `{ ok: true, present: false }`, and the
one ledger record — held well after the epoch baseline beside it — matches no
receipt. That is the intended verdict.

## Obligations

None.
