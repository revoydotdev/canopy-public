# ADR-142: The Native Harness Executes Campaigns; Connectors Are A Switchable Lane

**Status:** Accepted
**Date:** 2026-08-27
**Authoring Revision:** c702c9ec2e82966ceb86207bceca85481112df07
**Content ID:** sha256:88e9f40722fdd9ef99867e5c83f6bde98ceb32df69e74ccbd716539ce336e88a

**Scope.** This record supersedes ADR-141 (Orchestration Belongs To The Harness,
Not To A Connector) in full: it keeps that record's architectural thesis and
replaces its cost estimate, which was measured false.

## Context

ADR-141 argued that orchestration belongs to the harness and that opencode,
codex, claude-code and bedrock are connector plugins subsumed by revoy2's
governance model. That thesis is correct. Its stated cost was not: ADR-141
claimed the change is "exhausted by moves, renames, and import rewrites". It
is not, and this record replaces it rather than leaving a measured-false cost
estimate standing in an Accepted decision.

Two measurements, taken 2026-08-27.

**The connector is not a lane beside the harness. It is the only lane.**
There are exactly three `runCampaign` call sites:

| Call site | Executor it builds |
|---|---|
| `demo.ts:490` (`arbor run`, the CLI's primary name for a real campaign) | `createOpenCodeLoopExecutor` |
| `selfhost.ts:613` | `createOpenCodeLoopExecutor` |
| `cli.ts:849` (integration campaigns) | `selected.integration.createExecutor` |

`demo.ts` types its choice as a closed union — `executor: "real" | "deterministic"`
— where `"real"` means opencode; its own `--help` says "genuine opencode LLM
agents". There is no native option to select. `selfhost.ts` constructs the
opencode executor unconditionally.

**The one place that looks native is not executing natively.**
`createNativeLoopExecutor` is reachable only from `packages/arbor-mcp/src/integrations/opencode-campaign.ts`,
and it *supervises* rather than executes: it wraps a downstream dispatch and
stamps every session with `OPENCODE_FALLBACK_SESSION_EXECUTION`, whose
`connector_id` is the literal `"opencode"` and whose `execution_kind` is
`"connector_fallback"`. The model turn is still an `opencode run` subprocess.

Meanwhile `NativeAgentExecutor` — a `NativeHarnessWorker` driving a
composition-root-supplied `NativeModelPort`, with `NativeUsageBudgetController`
accounting — does own its model turns, and is not a `LoopExecutor`. It is
constructed once, in `cli.ts`'s `configuredNativeAgentExecutor`, for task and
planner paths only.

**So no campaign turn in this repository has ever been executed by the native
harness.** That is the gap ADR-141 was reaching for, stated in the terms that
make its real cost visible.

The consequence is not only architectural. An unbudgeted real run on
2026-08-27 recorded `input_tokens: 6672` and `output_tokens: 0` across two
specialist dispatches and a critic, from three records carrying usage at all;
the cockpit independently reported `COST unavailable`. Usage and cost
accounting live in the native lane, so on the lane that actually runs, budget
enforcement and cost telemetry are blind. The same run spent the full 900s
specialist ceiling on one node and then failed it, because a subprocess
boundary is also where turn-level governance stops being observable.

## Decision

**The native harness is the default campaign executor. Connectors become a
selectable lane, chosen by an explicit variable, never by construction.**

1. **`NativeAgentExecutor` is used as a `LoopExecutor` directly — no adapter.**
   Measured after this record was drafted and corrected here rather than left
   standing: `NativeAgentExecutor` already satisfies the interface
   structurally. It exposes `specialize()` and `review()` returning exactly
   `SpecialistResult` and `CriticResult`, and already computes
   `tokenUsage(events)` and `usageCostTelemetry(...)`, so usage reaches the
   ledger with no translation layer. An earlier draft of this decision called
   the adapter "the substance of this ADR"; that was wrong in the same way
   ADR-141's premise was wrong, and is recorded here rather than quietly
   dropped.

2. **One composition point, three consumers.** `arbor run`, `selfhost` and the
   integration path resolve their executor through a single selector rather
   than each constructing one. A new call site that wants a campaign gets the
   default without opting in, which is the property that failed here: the
   native lane existed and two of three call sites simply never reached it.

3. **The selector is explicit and switchable**, honouring, in order: an
   explicit `--executor native|opencode|deterministic` flag; then config
   (`native.mode`, already `"auto" | "native" | "fallback"`, and
   `ARBOR_HARNESS_INTEGRATION`); then the default, which becomes **native**.
   `"real"` is retained as a deprecated alias for whatever the resolved
   default is, so existing scripts keep working but stop meaning "opencode".

4. **Fallback is recorded, never silent.** When the native lane is
   unavailable — no endpoint, no credential, an unsupported capability — the
   run may fall back to a connector, and that fallback is written to the
   ledger with its reason. A default that quietly degrades to the old lane
   would reproduce today's situation while reporting that it had been fixed.

5. **`OPENCODE_FALLBACK_SESSION_EXECUTION` stops being the only stamp.**
   Sessions record the lane that actually ran them. A native session stamped
   `connector_id: "opencode"` is a false provenance claim in the audit ledger.

## Consequences

Campaign turns become observable at the turn level: tool calls, token usage,
cost and budget enforcement all move inside the process that governs them.
`output_tokens: 0` on a live run stops being the expected reading.

This is a real behavioural change to the default execution path, not a
refactor, and it should be expected to change how campaigns fail. The
subprocess boundary that hides a stuck specialist today also insulates the
loop from a native worker's exceptions; moving execution in-process makes
those failures the loop's problem, which is the point, but it will surface
faults that opencode currently absorbs.

Connector parity becomes a testable claim rather than an assumption. Each
connector is exercised through the same selector as the native lane, so
"opencode still works" is demonstrated by selecting it, not by it being the
only thing that runs.

The migration is stageable: the selector lands first, then each composition
root is taught to consult it, and the default flip is last. The real cost is
not an adapter but a composition-root split — `demo.ts` is deliberately its
own production composition root and composes config, agents and provider
capability without ever composing the native lane, so `arbor run` cannot
reach it today no matter what it selects.

## Alternatives / Roads not taken

**Move the spine to a neutral package (ADR-141 as written).** Rejected on
measurement: 16 `arbor-mcp` source files import 35 symbols from
`@arbor/opencode`, 13 of them value imports (`runCampaign`, `WorktreeManager`,
`PanelOfCritics`, `FAULT_MATRIX`, `DEFAULT_LOOP_CONFIG`, `buildAllAgents`,
`appendGovernedOverlay` among them). Moving the spine leaves every one of those
edges intact and does not collapse `loop.ts`'s mirrors, so it would fail
ADR-141's own Decision 4 check while appearing to satisfy the ADR.

**Make `createNativeLoopExecutor` execute natively instead of supervising.**
Rejected: its supervision — wall-clock terminalization, live session
registration, machine verification of specialist worktrees — is worth keeping
and is orthogonal to who runs the turn. Overloading it would fuse two concerns
that currently compose, and the natural shape is native execution *inside* that
supervision.

**Leave the default as opencode and make native opt-in.** Rejected as the
status quo with a flag: a lane nobody selects is a lane nobody tests, which is
how the native lane arrived at zero campaign turns while being fully built.
The default is the only setting that gets exercised by accident.

**Remove the connectors entirely.** Rejected: their strengths are the reason
the meta-harness model exists, and a connector reached through a governed
selector is exactly the plugin role ADR-141 correctly described. This ADR
demotes them from "the implementation" to "a lane", which is a different act
from deleting them.

## Obligations

### O1 — The native harness is the default lane, and a fallback away from it is recorded, never silent.

`resolveCampaignExecutorLane` resolves to `native` when nothing is requested,
and when the native lane cannot run it returns the connector lane carrying
`fell_back_from` and a reason naming the cause — so a connector run is
distinguishable from a native one rather than inferred.

<!-- proof: symbol=resolveCampaignExecutorLane file=packages/arbor-mcp/src/campaign-executor-lane.ts roundtrip=packages/arbor-mcp/tests/campaign-executor-lane.test.ts -->

### O2 — A lane is chosen explicitly, and an unrecognised one is refused rather than defaulted.

`parseCampaignExecutorRequest` accepts `native`, `opencode` and
`deterministic`, keeps `real` as a deprecated alias that resolves to the
default rather than to opencode, and throws on anything else — a typo must not
resolve to "whatever the default is", which is how an operator comes to
believe they selected a lane they did not.

<!-- proof: symbol=parseCampaignExecutorRequest file=packages/arbor-mcp/src/campaign-executor-lane.ts roundtrip=packages/arbor-mcp/tests/campaign-executor-lane.test.ts -->
