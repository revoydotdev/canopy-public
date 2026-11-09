# Canonical five-minute deterministic campaign

**Purpose:** a safe, reproducible first run of the shipped campaign harness.

**Runner:**

```bash
node ./packages/arbor-mcp/bin/arbor-mcp.mjs run --once --executor deterministic --persistence-dir .arbor/quickstart
```

**Boundary:** this is a reference fixture for the current built-in
deterministic `arbor run` plan, not a plan-file format or a promise that the
CLI reads Markdown. The command deliberately owns its plan so every supported
surface uses the same campaign composition. The fixture records the stable
operator contract: one bounded campaign, no provider/network call, a durable
repository-local trace, and no fabricated provider usage or verification.

## Root

| field | value |
|---|---|
| campaign shape | autonomous tree search |
| root role | Crown |
| root category | planning |
| execution mode | seeded deterministic executor |
| campaign count | exactly one (`--once`) |
| persistence | `.arbor/quickstart/` (ignored, repository-local) |
| specialist provenance | `!claimed` — the deterministic executor did not run a verification command |
| provider usage | typed unavailable — no provider call occurred |

## Candidate work categories

The built-in plan branches work across these bounded categories so the first
run displays selection, specialization, review, and a governed decision:

1. Testing and coverage work delegated to a Seed.
2. A governance decision delegated to Heartwood; it raises the durable
   `needs_input` interview rather than deciding on its own.
3. Configuration provenance work delegated to a Seed.
4. Release-report work delegated to Heartwood.
5. Isolation/emulation and critic-panel work delegated to Seeds.
6. TUI routing work delegated to a Seed.
7. Topology work delegated to Heartwood.

The exact descriptions and scoring inputs remain implementation-owned in
`packages/arbor-mcp/src/demo.ts`; this sample intentionally names the behavior
contract rather than duplicating mutable source literals.

## Expected artifacts

After the command exits, `.arbor/quickstart/` contains the campaign's durable
runtime state, including DevTools trace output. The TUI is a projection over
that state; the ledger and canonical runtime remain authoritative. A scripted
run may surface an operator interview or a critic rejection—those are genuine
seeded outcomes, not a signal that the command failed to start.

For the step-by-step instructions and real-executor warning, see
[`docs/five-minute-quickstart.md`](../../docs/five-minute-quickstart.md).
