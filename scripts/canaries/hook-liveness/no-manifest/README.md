# Canary: gate:hook-liveness — nothing declares what these hooks should do

Run as `bun run gate:hook-liveness --repo {repo}`.

## What is under test, stated precisely

This gate is REPORT-ONLY by permanent design, and its file says so. Every rot
verdict it can reach — `SUSPECTED-ROTTED`, `NEVER-FIRED`, `INSUFFICIENT`,
`NO-DECISIONS`, and `LIVE` — returns exit 0. A rot verdict is a statistical
claim over a machine-specific local invocation history, and blocking a push on
one would be blocking on an inference.

It has exactly one non-zero path, and that is what this fixture drives: with no
`.hook-liveness/hook-manifest.json`, nothing declares what the hooks are supposed
to do, and the gate returns 2 rather than printing a clean report over an empty
history. That refusal is the whole of the gate's blocking surface.

## Why the fixture is nearly empty

Because the gate's only input is the manifest and the invocation log beneath the
same root, and because the interesting input — a manifest — is precisely what
must be absent. A directory holding a README and nothing else is the honest
representation of "the manifest is missing", not a stripped-down version of a
populated fixture.

## What this canary proves, and what it does not

Proves: the gate CAN return non-zero. The census exists to separate "this gate
answered" from "this gate has no failure mode at all" (finding R2, and the
`adr-status-audit.mjs` defect it names), and this is the run that shows a failure
mode exists.

Does NOT prove rot detection. A fixture whose manifest declares an
`expect_variability: always` hook with twenty identical `verdict_hash` values
produces a `SUSPECTED-ROTTED` verdict and still exits 0, because that is what
"report-only" means. No canary can prove this gate's rot detection, and that is
not a gap in the fixture — it is the gate's declared contract. Read this row as
"the gate can fail", never as "the gate's central claim is verified".
