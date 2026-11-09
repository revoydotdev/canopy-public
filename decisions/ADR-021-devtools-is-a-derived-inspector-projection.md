# ADR-021: DevTools Is a Derived Inspector Projection

**Status:** Accepted
**Date:** 2026-08-03

## Context

revoy2 is agentic: MCP, OpenCode plugin, TUI, CLI, and web dashboard all drive
or observe the same canonical `ArborRuntime`. What it lacks is the
chrome-devtools-mcp equivalent — a single surface that lets an external agent
**open a workflow in the harness, drive it one step at a time, watch every
transition stream to a tailable file, set typed breakpoints, and inspect any
node** without becoming an authority over the tree search.

The primitives for this already exist. `ArborRuntime` publishes a bounded,
hash-chained `RuntimeEventStream` over a closed `RuntimeEvent` union
(`campaign.changed`, `tree.node_changed`, `gate.recorded`, `kb.entry_added`,
`audit.evidence_recorded`, …). The audit ledger is hash-chained and append-only
with `record_id` + `content_hash` on every record. `ArborRuntime.snapshot()`
returns a cursor-stamped envelope; `eventStream.resume(cursor, snapshot)` resumes
strictly after a cursor. The web dashboard already bridges events to SSE. The
loop already accepts an `AbortSignal` per dispatch and a `ShutdownGate` for
Ctrl-C. What is missing is the *inspector* surface itself: a `devtools_*`
tool family and a single externally-observable streaming log file.

The risk is inventing a parallel authority. A second event bus, a mutable
debugger state machine, or a "debug log" treated as ground truth would all
violate Commandments I (provenance is a type), II (evidence precedes
observability), IV (checks-and-balances), and ADRs 011/014/017 (TUI, runtime
memory, and telemetry are projections, not parallel domain models).

## Decision

DevTools is a **derived inspector projection**, never authority. Two additions,
neither of which invents new provenance, capability, or mutation:

1. **`devtools_*` MCP tool family** — `devtools_open_campaign`,
   `devtools_snapshot`, `devtools_probe`, `devtools_step`, `devtools_trace_tail`,
   `devtools_break_on`, `devtools_clear`. Every tool returns cursor-stamped
   envelopes and composes existing surfaces: `manager.subscribeEvents`,
   `eventStream.resume(cursor, snapshot)`, `runtime.snapshot()`,
   `runtimeCatalog.executeQuery`, and the loop's existing step/pause controls.
   They introduce no new mutation path; capability gating is inherited from
   `runtimeCatalog` and the campaign manager.

2. **`DevToolsTraceLogger`** — a `RuntimeLifecycleParticipant` that subscribes to
   `manager.subscribeEvents` (the same post-durability sink the SSE bridge taps)
   and appends one ND-JSON line per runtime event to
   `<persistence_dir>/devtools/devtools.log`. Each line records the producing
   `record_id` + `content_hash` when the event was ledger-witnessed, the
   envelope cursor, and the closed `RuntimeEvent` payload. The file is
   append-only, fsynced per line, rotatable at a bounded threshold (default
   100 MB), and backpressure-safe: a slow disk cannot wedge the loop because the
   logger never blocks on a full queue — it applies the same bounded-buffer +
   drop-with-`stream.truncated` discipline the runtime event stream already
   uses.

The log file is explicitly **not** a second audit ledger. It is a derived
surface: lossy by design (rotation evicts old lines), replayable from the
ledger on restart, and incapable of authorizing any state transition. ADRs
014 (runtime memory is a ledger-witnessed projection) and 017 (telemetry is a
ledger-derived projection) govern — DevTools is the same shape applied to the
inspector surface.

### Loop-driving concurrency

A driver (CLI / MCP / opencode plugin / test) calls `devtools_step` to advance
one iteration synchronously; the call returns the post-step cursor and the
trace packet produced. Any number of observers may `tail -f` the log file or
call `devtools_trace_tail(cursor)` concurrently — multiple readers, one writer
(the loop), zero contention. `devtools_break_on({kind})` parks the next
`devtools_step` via the loop's existing `AbortSignal` until a matching
`RuntimeEvent` fires, then returns the matching envelope.

## Consequences

**Positive:**

- One externally-observable streaming surface (`devtools.log`) for every
  campaign transition, tailable by any agent or human.
- Cursor-resume semantics identical to chrome-devtools navigation: an agent
  that loses its context window can resume from its last cursor without
  re-reading the whole history.
- Zero new authority — every check-and-balance, capability tier, and
  provenance rule continues to fire exactly as before.
- Multiple observers cannot corrupt each other; the loop remains the sole
  writer.

**Negative:**

- One extra fsync per runtime event on campaigns with `persistence_dir` set.
  Mitigated by batching at the logger boundary (default 1 ms flush window) and
  by the fact that the audit ledger already fsyncs per governed transition.
- Rotation evicts old lines — the log is a debugging aid, not a durability
  surface. Restart replays from the ledger.

**Neutral:**

- External agents may consume the projection but are not authority and may lose
  data on rotation without affecting campaign correctness — the same posture
  ADR-017 takes for telemetry exporters.

## Test implications

- Rebuilding an empty devtools projection yields no lines.
- Each log line's `record_id`/`content_hash`, where present, matches the
  producing audit ledger record.
- Rotation at the configured threshold evicts the oldest segment and continues
  writing; the active segment never exceeds `max_bytes` per line.
- A slow consumer (simulated fsync delay) cannot delay `manager.emit()` beyond
  a bounded threshold — the logger drops with `stream.truncated`, mirroring the
  event stream's backpressure discipline.
- Restart does not restore from the log file; the ledger is the only restore
  source.
- `devtools_*` tools are subject to the same capability gating as the catalog
  surface they wrap.
- `devtools_step` returns the cursor after the step and the trace packet
  produced by that step (or `null` if no step occurred, e.g. halted).
- `devtools_break_on({kind})` parks the next `devtools_step` until a matching
  event; timeout and abort both unwind cleanly without leaving a parked
  breakpoint.

## Alternatives considered

1. **A second event bus for debugger events.** Rejected: it would compete with
   the canonical `RuntimeEventStream` and inevitably drift. The bus *is* the
   ledger; DevTools subscribes to it.
2. **A mutable debugger state machine.** Rejected: a parked breakpoint would
   become mutable state that could wedge the loop on restart. Breakpoints are
   derived from in-flight `AbortSignal`s that die with the call.
3. **Treat the log file as ground truth.** Rejected (ADR-014, ADR-017): a
   debugging log is lossy and rotatable; only the hash-chained audit ledger is
   authority.
4. **Expose DevTools only through MCP.** Rejected: the log file is the
   externally-observable surface — `tail -f | jq` must work without an MCP
   client. The tool family and the file are complementary projections.
5. **Add DevTools as a fifth process gate.** Rejected: ADR-006 fixes the gate
   set; DevTools observes, never gates.

## Obligations

### O1 — The `devtools_*` MCP tool family is discoverable and composes existing runtime/catalog surfaces rather than introducing a new mutation path

<!-- proof: symbol=defineDevToolsTools file=packages/arbor-mcp/src/devtools.ts roundtrip=packages/arbor-mcp/tests/devtools.test.ts -->

### O2 — `DevToolsTraceLogger` appends one ND-JSON line per runtime event and rotates at a bounded byte threshold rather than growing unbounded

<!-- proof: symbol=DevToolsTraceLogger file=packages/arbor-mcp/src/devtools-log.ts roundtrip=packages/arbor-mcp/tests/devtools-log.test.ts -->

### O3 — The logger is backpressure-safe: a slow consumer cannot delay the runtime — it drops with a synthetic `stream.truncated` marker rather than blocking event emission

<!-- proof: symbol=DevToolsTraceLogger file=packages/arbor-mcp/src/devtools-log.ts roundtrip=packages/arbor-mcp/tests/devtools-log.test.ts -->

### O4 — Restart never restores devtools state from the log file; the audit ledger is the only restore source, and the log remains a lossy debugging aid, never authority

<!-- unverifiable: a negative/absence claim — devtools-log.ts has no read/restore path at all (grep-confirmed: only appends and rotates), and no test in the repo exercises a restart-then-check-devtools-state path, so no exported symbol witnesses "restart never restores from the log" under regression. -->

No proof attached. No test in the repository exercises a restart-then-check-
devtools-state path; the negative claim follows from the log's documented
design (rotation evicts old lines, nothing reads the log back on startup)
but is not itself under regression coverage.
