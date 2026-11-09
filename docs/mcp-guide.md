# revoy2 MCP Guide

**Status:** describes the shipped implementation as of 2026-08-02.

**Evidence boundary:** the server identity, tools, resources, and command/query
semantics below are a dated implementation description. The MCP version string
and a reachable stdio server do not, by themselves, establish full protocol
conformance. Cursor pagination is explicitly unavailable in the limitation
below; list-change rediscovery, elicitation, transport breadth, and other
conformance properties remain unclaimed unless separately demonstrated by a
revision-bound test or capture. The [canonical 1.0.0 roadmap](roadmap-1.0.0-and-documentation-governance.md#phase-3--mcp-skills-and-tool-use-as-one-governed-economy)
tracks the target conformance work.

This guide documents the MCP server surface: the 12 tools, the resources, and
the `arbor_command`/`arbor_query` catalog dispatch. The MCP server is the
integration layer over the canonical `ArborRuntime` and `RuntimeCatalogRouter`.

---

## 1. Server identity

- Protocol: MCP stdio, protocol version `2025-06-18`.
- Server name: `arbor-mcp`, version `0.1.0`.
- Capabilities: `tools` (listChanged: false), `resources` (listChanged: false,
  subscribe: false).

---

## 2. Tools

The 12 tools (from `packages/arbor-mcp/src/tools.ts`):

| Tool | Purpose |
|---|---|
| `arbor_start_campaign` | Start a campaign (admission gate) |
| `arbor_select_node` | Select the highest-scoring pending node via UCT |
| `arbor_expand_node` | Expand a node (isolation gate) |
| `arbor_record_result` | Record a specialist/critic result |
| `arbor_branch` | Branch a node into candidate actions |
| `arbor_prune` | Prune a node |
| `arbor_halt_check` | Evaluate the halt condition |
| `arbor_kb_read` | Read KB entries (capability-gated) |
| `arbor_kb_query` | Query the KB |
| `arbor_kb_inject` | Inject KB context into a specialist prompt |
| `arbor_interrupt_campaign` | Interrupt a campaign (ADR-016) |
| `arbor_get_state` | Get campaign state |

---

## 3. Resources

From `packages/arbor-mcp/src/resources.ts`:

| URI template | Description |
|---|---|
| `arbor://campaigns/{id}/state` | Campaign state |
| `arbor://campaigns/{id}/kb` | Campaign KB entries |
| `arbor://campaigns/{id}/audit` | Campaign audit evidence |

---

## 4. Catalog dispatch (`arbor_command` / `arbor_query`)

Beyond the 12 tools, the MCP server exposes `arbor_command` and `arbor_query`
methods that dispatch through the canonical `RuntimeCatalogRouter`. These accept
a bare `{ kind, ...params }` input and wrap it into the catalog command/query
envelope.

### Commands

`campaign.start`, `campaign.halt`, `tree.branch`, `tree.prune`,
`tree.interrupt`, `operation.cancel`, `task.retry`, `recovery.retry`,
`recovery.abandon`, `communication.record`, `output.capture`,
`surveillance.scan`, `job.submit`, `job.cancel`, `job.retry`, `job.pause`,
`job.resume`, `approval.request`, `approval.approve`, `approval.reject`,
`approval.expire`.

### Queries

`campaign.list`, `campaign.snapshot`, `campaign.tree`, `operation.get`,
`task.list`, `event.resume`, `communication.selection`, `communication.history`,
`output.descriptor`, `output.raw`, `surveillance.findings`, `config.get`,
`agent.list`, `job.list`, `approval.list`.

---

## 5. Command/query semantics

- Every command is accepted once by idempotency key. Replaying an identical
  operation returns the same semantic result; reusing an identity with a
  different payload is a typed conflict.
- A command acknowledgement reports accepted/rejected and operation ID;
  completion is an event, not a synchronous assumption.
- Capability gating: the router enforces `granted_capabilities` when supplied.
- Structured errors: validation, permission, conflict, unavailable, timeout,
  transport, corrupt-data, and internal are mapped to a typed `RuntimeError`
  with severity, recoverability, and source.
- `output.raw` requires explicit `raw_output_authorization` (transport-
  established identity, never accepted from the raw retrieval request).
- `communication.*` enforces capability-tier redaction: a lower-tier reader
  cannot read a higher-tier communication.

---

## 6. Example

Start a campaign via `arbor_command`:

```json
{
  "kind": "campaign.start",
  "campaign_id": "auth-refactor-2026-08-02",
  "plan_path": ".arbor/plans/auth-refactor.md",
  "root_action": { "description": "refactor auth", "category": "heartwood-deep", "delegate_to": "heartwood" },
  "config": { "max_seconds": 3600, "min_score": 0.7, "convergence_iterations": 2, "exploration_constant": 1.414 }
}
```

Query campaign state via `arbor_query`:

```json
{ "kind": "campaign.snapshot", "campaign_id": "auth-refactor-2026-08-02" }
```

---

## 7. Known limitations

- Cursor pagination for `campaign.list`, `campaign.tree`, and `task.list` is not
  yet wired to the event stream; passing a `cursor` to those queries currently
  throws "cursor pagination is not available until event-stream integration".
