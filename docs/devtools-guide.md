# DevTools Guide — revoy2

**ADR-021.** DevTools is a derived inspector projection over the canonical
runtime. It lets an agent (or a human) **open a workflow in the revoy2
harness, drive it one step at a time, watch every transition stream to a
tailable file, set typed breakpoints, and inspect any node** — the
chrome-devtools-mcp equivalent for tree-search-as-cognition.

DevTools introduces **no new authority**. Every tool is a projection over
existing runtime/catalog APIs; the log file is a derived surface. The audit
ledger remains the only source of truth.

---

## Two surfaces, one projection

### 1. The streaming log file

When `ArborRuntime` is constructed with a `persistence_dir`, a
`DevToolsTraceLogger` is auto-composed as a lifecycle participant. It writes
one ND-JSON line per runtime event to:

```
<persistence_dir>/devtools/devtools.log
```

- One line per event, append-only, `fsync` per line (configurable).
- Rotation at 100 MB by default; 5 rotated segments retained.
- Backpressure-safe: a slow disk cannot wedge the loop. Overflow drops the
  oldest pending event and writes a synthetic `stream.truncated` marker.
- Each line records the producing ledger `record_id` when the event was
  ledger-witnessed (`audit.evidence_recorded`, `kb.entry_added`).

Tail it from any agent or human:

```bash
arbor devtools tail                       # all campaigns
arbor devtools tail my-campaign           # one campaign
tail -f .arbor/devtools/devtools.log | jq .
```

### 2. The `devtools_*` MCP tool family

Seven tools, all cursor-stamped, all discoverable via `tools/list`:

| Tool | chrome-devtools analogue | What it does |
|---|---|---|
| `devtools_open_campaign` | `open_page` | Start a fresh campaign with the DevTools trace log active. Returns the initial cursor-stamped snapshot envelope. |
| `devtools_snapshot` | `snapshot` | Read a projection: `lifecycle`, `campaigns`, `tree`, `kb`, `ledger`, `telemetry`. Pass a cursor to resume strictly after it. |
| `devtools_probe` | `evaluate` | Run a read-only `arbor_query` against the catalog. Capability-gated passthrough. |
| `devtools_trace_tail` | `network_log` | Replay runtime events after a cursor. Returns bounded event list + new cursor. |
| `devtools_step` | `click` | Advance the active campaign by one iteration. Returns the selected node id and the post-step cursor. |
| `devtools_break_on` | `set_breakpoint` | Park until a typed event fires (`node_failed`, `node_verified`, `kb_entry_added`, `gate_failed`, `halt`, `any`, …). The loop is never parked — only this tool's response Promise. |
| `devtools_clear` | `remove_breakpoint` | Clear all parked breakpoints for a campaign. |

---

## Loop-driving concurrency

The chrome-devtools pattern translates directly:

- **The driver** (CLI / MCP / opencode plugin / test harness) calls
  `devtools_step` to advance one iteration synchronously. It returns the
  cursor after the step.
- **The observer** (any number of agents / `tail -f` processes) reads the log
  file or calls `devtools_trace_tail(cursor)`. Multiple readers, one writer
  (the loop), zero contention.
- **The breakpoint** primitive converts a busy-poll into a typed wait:
  `devtools_break_on({kind: "node_failed"})` parks the next observation until
  a matching `RuntimeEvent` fires, then returns the matching envelope.

So one agent can drive the workflow while another watches the streaming log
and a third inspects a specific node's state — exactly chrome-devtools.

### Streaming the full autonomous-loop feedback (in-session recursion)

`devtools_step` advances a **single** tree-search transition. To drive the
full autonomous loop — select → specialize (dispatch a Seed/Heartwood) →
critic-review (Lenticel) → record → branch/backtrack, repeated until
halt — use `runCampaign` from `@arbor/opencode` with a `LoopExecutor`. That
executor's `log` hook emits the iteration-level narrative (`specialist_dispatched`,
`critic_dispatched`, `node_verified`, `node_failed`, `branched`, `backtracked`,
`halt`, `iteration`, …).

Route that hook into the DevTools log so the autonomous loop's feedback is
captured **externally and in-session** — an agent driving `runCampaign` can
then read its own iteration feedback back from `devtools.log` between steps
(the recursive drive → read → drive loop):

```ts
import { devtoolsLoopHook } from "@arbor/mcp";

const hook = devtoolsLoopHook(runtimeDeviceLogger); // or server's logger
executor.log = (e) => { yourExistingLog?.(e); hook(e); };

await runCampaign({ manager, campaign_id, executor, config /* , worktrees, signal */ });
```

`devtoolsLoopHook(logger)` returns an `executor.log`-compatible sink; it is
safe before the logger starts, defensive against malformed events, and shares
the logger's bounded FIFO so runtime and loop feedback preserve arrival order.
Loop lines appear in the log as `event_kind: "loop.*"` with the full payload
under `loop_event`.

---

## Cursor-resume semantics

Every read tool returns a `{ stream_id, sequence }` cursor. Pass it back on
the next call to resume strictly after that point — no need to re-read the
whole history. If the in-memory event stream has rotated past your cursor,
the runtime returns a `resync` envelope with a fresh snapshot.

---

## Line shape

```json
{
  "schema": "arbor.devtools/v1",
  "seq": 42,
  "ts": "2026-08-03T16:34:40.803Z",
  "campaign_id": "my-campaign",
  "node_id": "n1",
  "event_kind": "audit.evidence_recorded",
  "event": { "kind": "audit.evidence_recorded", "campaign_id": "my-campaign", "evidence_id": "trace_42" },
  "source_record_id": "trace_42",
  "source_content_hash": null,
  "synthetic": false
}
```

`source_record_id` is non-null only for ledger-witnessed events. For events
with no direct ledger counterpart (`tree.node_changed`, `task.changed`) the
line carries the event payload verbatim and `source_record_id` is null —
DevTools never invents a synthetic pointer.

---

## Disabling DevTools

For tests or ephemeral runs, pass `devtools_logger: false` to
`ArborRuntime`:

```typescript
const runtime = new ArborRuntime({ persistence_dir: dir, devtools_logger: false });
```

---

## Authority posture

| Question | Answer |
|---|---|
| Can DevTools verify a tree node? | No. Only `!verified(cmd⇒exit)` evidence can, and that path is unchanged. |
| Can DevTools gate a transition? | No. The four gates (admission, isolation, evidence, audit) are unchanged. |
| Can DevTools affect campaign correctness? | No. It's a projection; lossy by design (rotation). Restart replays from the ledger. |
| Can multiple observers corrupt each other? | No. The loop is the sole writer; observers are read-only. |
| Are DevTools tools capability-gated? | Yes — they inherit the gating from the catalog surface they wrap. |
