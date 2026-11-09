# Canary: gate:campaign-run-status — a projection that exists but is not wired

Run as `bun run gate:campaign-run-status --repo {repo}`.

## The defect shape this reproduces

ADR-093 Decision §5 makes this gate the acceptance-blocking check, and names the
specific failure it exists to catch: a durable projection module that "merely
exists alongside" `ArborRuntime` instead of being wired into it. A green unit
suite that imports the module directly would not catch that — the module is fine;
the composition root never calls it. So the gate's second leg is a source-text
check on the runtime's own composition root.

This fixture is that shape. `packages/arbor-mcp/src/runtime.ts` is a plausible
runtime that runs a campaign job and returns a status, and it never grew the
durable attempt index at all: no field declaration, no instantiation, no attempt
or refusal recording, and no read method that constructs the status. Every marker
the gate looks for is genuinely absent. The barrel export leg has three named
absences for the same reason.

## Why the test files here are placeholders

The gate's first leg shells out to `bunx vitest run` over three named fixture
files. Those are the real projection suite, which cannot be moved into a fixture
— a canary that redirects the wiring root cannot also keep pointing at the real
`packages/` tree, because then the wiring leg would find real source and pass.

So the three files exist and pass, and the vitest leg is green. That isolates the
failure to the legs actually under test instead of letting a second, unrelated
failure share the verdict. `link_repo_paths: ["node_modules"]` is what lets
`bunx vitest` resolve at all in a throwaway root.

## What this canary proves, and what it does not

Proves: the gate refuses to pass when `ArborRuntime` does not wire the durable
attempt index, and when the projector is not exported from the package barrel.
That is the ADR-093 §5 acceptance condition, driven end to end through the real
gate.

Does NOT prove the first leg — that the real projection's own fixture suite
passes. That leg is only meaningful against the real `packages/arbor-mcp/tests/`
tree, which is mutually exclusive with redirecting the root. Read this row as
"the wiring and export checks can fail", never as "the projection's behaviour is
verified".
