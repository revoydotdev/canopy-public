# ADR-083: Bidirectional Agent Communication Is One Mechanism, Scoped Per Edge

**Status:** Accepted
**Date:** 2026-08-19
**Authoring Revision:** c68679859673fad3bf71bcea3e435a59b773fbd0
**Content ID:** sha256:e8057eed4f98b1064ca7b9bf9b8dfe3bbe9529acabce42402d092b62d95debbe

## Context

Agent-to-agent communication is a first-class concern: communication must be
possible in both directions between agents, between an agent and its
sub-agents, and within a single session.

The honest starting point was that most of this already worked, and the missing
part was narrow and specific — which is only knowable by looking, and the
looking corrected two beliefs held that morning.

**What already existed.** Twelve catalog kinds covering communication are
declared supported, tested, and carry landed roundtrip entries: `bus.record`,
`bus.history`, `bus.thread.send`, `bus.thread.ack`, `bus.thread.history`,
`sibling.spawn`, `sibling.status`, `subagent.execute`, `subagent.executions`,
`a2a.send`, `a2a.receive`, `a2a.cards`. The transport beneath them is not a
stub: `conversation-bus.ts` projects communications from an append-only ledger
of `NodeCommunicationRecord`, never a mutable mailbox, with
`reply_to_communication_id` binding a reply to its thread, immutable
`ack_required`/`deadline_at` fields, replay-derived pending/acknowledged/
timed-out state, and `expected_thread_version` optimistic concurrency. Restart
safety is structural rather than promised.

**The first correction.** An audit concluded that no A2A, bus, or sibling tool
existed on the MCP surface, and therefore that an MCP-driven agent could not
reach these capabilities at all. That was wrong, and the way it was wrong is
worth recording, because the two surfaces it conflated are genuinely different
and the difference is the substance of this record:

- `tools.ts` is what an **external client** driving this process receives:
  generic `arbor_command`/`arbor_query` whose `kind` enum is generated from the
  catalog itself. Any catalog kind is dispatchable. Broad, by design.
- `native-tool-host.ts` is what a **dispatched sub-agent** receives: twelve
  sandboxed tools — repository reads, file reads and writes, shell, git status
  and diff, evidence refresh. Narrow, by design.

Reading the second and taking it for the whole picture inverts the conclusion.

**The actual gap.** None of those twelve tools could dispatch a catalog command.
A dispatched child therefore could not send a message to its parent, acknowledge
one, or ask a clarifying question while it worked. Its only return path was the
single terminal result the executor reported on its behalf. Parent-to-child
communication was real; child-to-parent mid-flight did not exist. That asymmetry
was the whole of what "bidirectional" was missing.

**The second correction, and why the visual-intelligence graph did not catch
it.** It did — and the finding was blunted rather than missed. `a2a-bridge.ts`
sits inside a `catalog_gap` finding reading "72 file(s) in arbor-mcp load but
are never invoked", which carried an `accepted_tradeoff` verdict on the grounds
that the observation catalog is narrow. True of the bucket, and it hid the one
member where "never invoked" meant something categorically different: not
under-exercised, but unreachable by construction on every entry point except the
interactive TUI. Three structural reasons the signal could not sharpen itself:

1. `completion-depth` is the store built for exactly this shape — a guard whose
   key is assigned only by tests or demos — but its predicate skips any guard
   with a production setter, and `a2a_bridge` has one, in `tui.ts`. The
   predicate models "never set in production", not "set in only one of several
   composition roots".
2. ADR-035 named this limitation in writing, in its rejected alternative 4: the
   graph's `reachable_from` cannot distinguish a demo path from the production
   path, and "solving it properly requires the per-entry-point reachability the
   graph does not currently model". This defect is precisely that.
3. The graph models structure; "an optional config is never populated on this
   path" is a value fact, which neither plane represents.

## Decision

**The three axes are one mechanism, not three.**

An agent, a sub-agent, and an intra-session participant are all nodes in the
same campaign tree, addressed by tree-node identity over the same append-only
communication ledger. There is no separate peer protocol, no separate sub-agent
channel, and no separate intra-session bus. Introducing one would be a second
mechanism for an existing concern, which this repository treats as a defect.

**Child-to-parent communication becomes a scoped capability.** A dispatched
sub-agent gains native tool ports for `bus.thread.send`, `bus.thread.ack`, and a
read-only `sibling.status`, restricted to its own parent edge. The restriction
is the load-bearing half:

- The child does **not** gain `sibling.spawn` or `subagent.execute`. No
  recursive or lateral capability escalation.
- A send or ack addressed to any edge other than its own **fails closed**, with
  an explicit, specific denial. It is never silently redirected to the correct
  edge and never quietly accepted — a silent redirect would be worse than the
  original gap, because it would look like it worked.
- A session with no resolved scope at all is refused every bus-thread tool,
  rather than defaulting to something permissive.

**The remote and wire surface stays closed.** This record decides nothing about
network transport, TLS, remote enrolment, or public A2A wire conformance.
ADR-040 and ADR-041 remain rejected and are not narrowed here. `a2a.send` and
`a2a.receive` remain `unavailable` on the `arbor serve` path, because nothing
there composes an `A2ABridgeConfig` — only the interactive TUI does, from an
environment variable. That is a deliberate exclusion with a stated reason, not
an accident left for a reader to trip over.

**This record decides afresh; it resurrects nothing.** ADR-039, ADR-040 and
ADR-041 were rejected under operator-decision D2. `rejected` is terminal —
`packages/arbor-governance/src/record/status.ts`'s `LEGAL_TRANSITIONS` has no outgoing edge from it — so none
of the three could be reinstated even if that were wanted.

## Consequences

**Easier.** A sub-agent can report progress, raise a question, or acknowledge an
instruction while it is still working, instead of being scored solely on one
terminal result. A long-running child becomes observable rather than opaque, and
the parent's supervision becomes concurrent rather than retrospective.

**Harder, deliberately.** Every child message is scope-checked, so a child
cannot reach a sibling's thread even by accident. Broadening that scope later is
a decision someone has to make explicitly rather than discover they already had.

**Not decided here.** Cross-process or networked A2A. If a same-host caller ever
needs the `a2a.*` envelope shape specifically, composing a bridge is a separate
decision requiring its own record — and a test asserts today's `unavailable`
behavior precisely so that composing one silently breaks a test and forces the
question rather than slipping through.

**A waiver note, stated to prevent a wrong inference.** Four reachability
waivers expiring 2026-09-08 exempt `A2ADirectThreadProfile*` symbols and cite
the now-rejected ADR-041. They concern `a2a-direct-thread-profile.ts`'s
host-composed JSON-RPC adapter, a different file from the bus mechanism this
record governs. Making child-to-parent communication reachable does **not** make
those symbols reachable, so those waivers are not retired by this work and must
not be treated as though they were.

**Follow-up delivered (2026-08-25).** `gate:reachability` now emits a stable,
per-entry-point ADR-083 proof from the named public roots in
`scripts/reachability/entry-points.json`. The required `arbor-mcp-cli` root
must reach the parent-derived scope resolver, native child tool factory,
runtime router, campaign manager, and canonical thread identity/projection.
The same gate AST-checks that the scoped send/ack handlers invoke the
fail-closed edge check and that each exposed scoped port has exactly one native
tool emission from the canonical factory. It fails if the required root is
removed, a second mechanism is declared, or a duplicate emitter appears.

This is intentionally not value-flow or arbitrary-transport proof: it proves
the defined native child communication surface and its canonical ledger path.
It does not establish that an unrelated future transport cannot be added under
a different capability without extending this manifest-bound proof.

## Obligations

### O1 — A child can talk on its own parent edge, durably

<!-- proof: symbol=createNativeBusThreadToolPorts file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-child-bus.test.ts -->

A dispatched child's `bus.thread.send` lands in the real ledger and is readable
through `bus.thread.history` for that edge — a projection round trip, not an
in-memory echo.

### O2 — A foreign edge fails closed, never silently redirected

<!-- proof: symbol=createNativeBusThreadToolPorts file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-child-bus.test.ts -->

A send or ack targeting an edge that is not the child's own is denied with a
specific failure. Silent redirection to the correct edge is the failure mode
this obligation exists to forbid, because it would present as success.

### O3 — The scoped surface grants nothing beyond itself

<!-- proof: symbol=createNativeBusThreadToolPorts file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-child-bus.test.ts -->

The child's tool surface exposes exactly the scoped bus-thread ports and never
`sibling.spawn` or `subagent.execute`. A session with no resolved scope is
refused every one of them.

### O4 — The three axes are demonstrably one mechanism

<!-- proof: symbol=nativeRepositoryToolPorts file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/a2a-axes.test.ts -->

Agent-to-agent and intra-session traffic are asserted to travel the same ledger,
addressed differently — asserted rather than duplicated across two near-identical
tests, so the test suite cannot imply two mechanisms exist where one does.

### O5 — `a2a.*` stays honestly unavailable until a record says otherwise

<!-- proof: symbol=nativeRepositoryToolPorts file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/a2a-axes.test.ts -->

`a2a.send` returns the router's real refusal when no bridge is composed. If a
bridge is ever composed without a governing decision, this test fails — which is
the point. The failure is a prompt, not a bug.
