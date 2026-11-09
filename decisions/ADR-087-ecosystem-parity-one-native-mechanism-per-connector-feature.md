# ADR-087: One Native Mechanism per Connector-Inherited Ecosystem Feature

**Status:** Accepted
**Date:** 2026-08-24
**Authoring Revision:** 2886eb100a3a34f22642ee6fc92c1b7813f87fac
**Content ID:** sha256:c5e9594b882e34272136236c3cc3b3b52a4bbf069777104c58d4a7d4875fa00b

## Context

A 2026-08-24 parity audit compared the native harness lane against the three
subprocess connectors (`claude-code`, `codex`, `opencode`, under
`packages/arbor-mcp/src/integrations/`) and found the native lane behind on a
cluster of features every connector inherits for free from its upstream
product, simply by shelling out to it: Claude Code hook semantics,
`SKILL.md`-style loadable skills, model-callable subagent dispatch, vision
(image input a model can actually act on), user clarification, and
cross-lane agent-to-agent communication. The operator's directive is
unambiguous: **anything reachable via a connector must be reachable
natively.** A campaign that happens to run through the native lane must not
be second-class relative to one that happens to shell out to Claude Code.

This is not a greenfield gap. arbor already owns adjacent machinery for four
of these five concerns, built for reasons that predate this audit:

- **Hooks.** `packages/arbor-mcp/src/hooks/` (`catalog.ts`, `contracts.ts`,
  `handlers.ts`, `bus.ts`) is a governed hook engine in the ADR-083 lineage:
  immutable, filename-identified descriptors under `.arbor/hooks/`, a closed
  handler registry (`HOOK_HANDLERS`), and three event families —
  `HOOK_VETO_EVENTS` (`tool_preflight`), `HOOK_OBSERVE_EVENTS` (`tool_audit`,
  `phase`, `ledger_transition`), `HOOK_LIFECYCLE_EVENTS` (`session_start`,
  `session_end`, `node_start`, `node_end`, `plan_confirm`, `interruption`).
  It already fires around native session lifecycle and native tool calls, not
  a stub. Commit `ddccd39f` documents `arbor hook list/validate/events` as
  **CLI-only by design** (canvas C-11): hook *inspection* is operator
  diagnostics, deliberately with no MCP catalog kind, TUI screen, or Web
  panel. That decision was about the inspection surface, not the firing
  engine — the engine itself has been running natively the whole time.
- **Loadable skills.** `packages/arbor-mcp/src/skills/catalog.ts` mirrors the
  hook catalog's shape wholesale: immutable descriptors, filename identity, a
  closed load-time validator, bounded diagnostics. `integration-marketplace.ts`
  (`SignedIntegrationMarketplace`) is a signed, ed25519-verified package index
  and installer for extension bundles, with cache/stage/install/upgrade paths
  and a strict manifest schema. Between them: a governed skill-descriptor
  format and a governed way to distribute one. Neither reproduces a
  connector's specific plugin format; both predate this audit.
- **Cross-lane agent-to-agent communication.** ADR-083 already decided this
  axis in the native lane's favor: `createNativeBusThreadToolPorts`
  (`packages/arbor-mcp/src/native-tool-host.ts`) gives a dispatched native
  child `bus.thread.send`/`bus.thread.ack`/`sibling.status` scoped to its own
  parent edge, over the same append-only `NodeCommunicationRecord` ledger
  every other participant uses. No connector has an equivalent — this is the
  one axis where native is *ahead*, not behind, and this record changes
  nothing about it.
- **Model-callable subagent dispatch and clarification — half-present.**
  `native-tool-host.ts`'s own doc comment states the gap precisely:
  `subagent.execute` "have no port here at all: the router is only ever
  invoked with a `bus.thread.send`/`bus.thread.ack`/`sibling.status` envelope
  this module constructs itself from the trusted scope." A dispatched native
  child can report to and hear from its parent, but cannot itself call a
  tool that spawns a further subagent (Claude Code's Task tool, Codex's
  approval-scoped subprocess exec, OpenCode's permission-scoped agent call —
  three different names for the same primitive) or ask the operator a
  blocking clarifying question mid-session. The bus's own message-kind
  vocabulary (`BUS_THREAD_MESSAGE_KINDS`) already includes `"clarify"` as a
  wire-level kind; nothing surfaces it as a tool the model itself can invoke.
- **Vision.** `image_input` is a first-class capability in
  `packages/arbor-harness/src/inference.ts`'s capability union and is wired
  through the OpenAI-compatible adapter (`openai-compatible.ts`'s
  `governedImages`, attached to the final user turn only, never mid-history).
  `native.capabilities.image_input` is a real arbor.jsonc leaf, and
  `arbor doctor` already refuses to call it "actionable" from a model name
  alone — only an explicit, adapter-verified capability counts
  (`operator-maintenance.ts`'s `imageInputConfigured` computation). The
  transport-level plumbing exists; what a connector gets for free (any image
  the host CLI's own multimodal handling accepts, without a governed
  attachment path) is not yet reachable the same way for an arbitrary native
  session turn, not just a pre-campaign planning attachment.

`docs/research/reference-harness-clean-room-spec.md` already commits the
native lane to a superset of connector-observed behavior — non-interactive
execution, capability negotiation with `native`/`governed`/`observed`/
`unsupported` grades, tool policy, approval mediation, structured output —
under the closed-room protocol (no upstream implementation, prompts, or
control flow copied; behavior surveyed from published CLI help and metadata
only). This record extends that same protocol to the five named features:
survey what each connector's proprietary primitive *does*, absorb it as one
native mechanism, and cite the arbor-owned machinery each absorption extends.

## Decision

**Each ecosystem feature gets exactly one native mechanism, chosen by
extending existing arbor-owned machinery — never three per-connector
imitations.** Building three separate, never-created files — a hypothetical
claude_task_tool.ts, codex_approval_tool.ts, and
opencode_permission_tool.ts — as three parallel absorptions of the same
underlying primitive (a scoped, model-callable subagent call) would be the
AHA-violating outcome this record exists to foreclose: three near-duplicate
mechanisms serving one concern, each drifting independently. Every mapping
below names the one native surface the feature extends, not a place a new
one gets built.

1. **Hook semantics → the existing hook engine (ADR-083 lineage), unchanged
   in mechanism, extended in coverage.** `packages/arbor-mcp/src/hooks/`
   remains the single native hook mechanism. Its event tables
   (`HOOK_VETO_EVENTS`, `HOOK_OBSERVE_EVENTS`, `HOOK_LIFECYCLE_EVENTS`) and
   handler registry (`HOOK_HANDLERS`) are the closed surface any new granular
   event (a per-tool-name matcher, the way Claude Code's `PreToolUse`/
   `PostToolUse` hooks match on tool name and input) is added to, not
   replaced by. Commit `ddccd39f`'s CLI-only-by-design decision for
   `arbor hook list/validate/events` stands unchanged: this record is about
   the firing engine reaching connector-equivalent granularity, not about
   giving hook inspection a wider surface than canvas C-11 already decided
   it should have.
2. **`SKILL.md`-style loadable skills → the existing skill catalog
   (`packages/arbor-mcp/src/skills/catalog.ts`) plus the existing signed
   marketplace (`integration-marketplace.ts`).** A loadable skill pack is a
   marketplace-installed bundle whose manifest resolves to one or more
   governed skill descriptors in the catalog's existing closed schema. No
   new package format, no new signing scheme, no `SKILL.md`-compatible
   frontmatter parser cloned from any connector — the absorption is "the
   governed skill descriptor is arbor's `SKILL.md`", installed through the
   mechanism that already verifies, stages, and installs extension bundles.
3. **Model-callable subagent dispatch → a scoped `NativeToolPort` on the
   existing dispatched-child tool surface
   (`packages/arbor-mcp/src/native-tool-host.ts`).** The same file that
   documents today's absence (`subagent.execute` has no port) is where the
   port is added: a new tool, constructed the same way
   `createNativeBusThreadToolPorts` constructs its ports — from the trusted
   dispatch scope, never from anything the model's own input can widen —
   that lets a dispatched native agent request a further subagent dispatch
   through the existing `declarative_subagent_executor` /
   `subagent.execute` catalog path (`createDeclarativeSubagentExecutor`,
   already wired at `packages/arbor-mcp/src/cli.ts`). One native primitive
   absorbs Claude Code's Task tool, Codex's approval-scoped subprocess call,
   and OpenCode's permission-scoped agent call — they differ in surface
   vocabulary, not in the shape of what they let the model do: dispatch
   bounded, policy-checked further work and get a result back.
4. **User clarification → a scoped `NativeToolPort` on the same tool host,
   backed by the bus's existing `"clarify"` message kind.** The wire-level
   vocabulary is already present in `BUS_THREAD_MESSAGE_KINDS`; the addition
   is a tool the model can call mid-session that sends a `clarify` message
   on the child's own parent edge (the same scoping rule ADR-083 O2 already
   enforces for every bus-thread port: a foreign edge fails closed, never
   silently redirected) and suspends for a bounded reply, rather than only
   being reachable as an operator-initiated event.
5. **Vision → complete the existing `image_input` capability path
   end-to-end, not a new multimodal mechanism.** `governedImages` and the
   `image_input` capability declaration in
   `packages/arbor-harness/src/openai-compatible.ts` already exist for the
   final user turn of a governed context; the extension is making a
   mid-session native tool call able to attach a governed image to that same
   path, through the same attachment store already used for pre-campaign
   task attachments (`taskAttachmentStore`, `packages/arbor-mcp/src/cli.ts`),
   so a running session gains vision the same way a planning turn already
   has it, rather than only at plan time.
6. **Cross-lane A2A stays exactly as ADR-083 decided it.** No connector has
   an equivalent bidirectional channel; this record does not reopen, narrow,
   or duplicate that decision. It is named here only so the parity audit's
   "native lane is ahead here" finding is on the same record as the five
   gaps, rather than living only in the audit's own notes.

**Absorption discipline.** Each of 1–5 is bound to exactly one arbor-owned
file or module named above. A future change that adds a second mechanism for
any of these five concerns — a parallel hook system, a second skill-loading
path, a second subagent-dispatch tool, a second clarification channel, a
second image-attachment path — is a defect this record exists to name, the
same way ADR-072/ADR-083 treat a second mechanism for one concern as a
finding rather than a feature.

## Consequences

**Easier.** A campaign running through direct native execution is no longer
structurally capped below a connector-run campaign on any of these five
axes. A skill pack, a hook, or a subagent dispatch authored once works
whichever lane a campaign happens to run through, because each is one
governed mechanism rather than a per-lane reimplementation. Vision and
clarification become native-session capabilities an operator can rely on
without routing through a connector purely to get them.

**Harder, deliberately.** Two new model-callable tool ports (subagent
dispatch, clarification) on the dispatched-child surface widen what a native
child can request mid-session, which is exactly the kind of capability
escalation ADR-083 O2/O3 exist to keep scoped: both new ports must fail
closed on a foreign edge and must not smuggle in `sibling.spawn` or an
unscoped `subagent.execute` the way a full external MCP client can reach.
Getting the scoping wrong here is a materially worse failure than not having
the feature at all, because a silently over-broad tool looks like a working
feature until it is abused.

**Not decided here.** The exact event-matcher shape for finer-grained hook
coverage (item 1), the marketplace manifest schema for a skill-pack-shaped
bundle (item 2), and the bounded-wait/timeout semantics for a mid-session
clarification call (item 4) are implementation detail left to the
implementing obligation, not fixed by this record. This record fixes *which
mechanism* absorbs each feature and *that* it is one mechanism, not the
field-level shape of the extension.

## Alternatives considered

- **Build three per-connector imitations (a Claude-Code-shaped Task tool
  clone, a Codex-shaped approval clone, an OpenCode-shaped permission
  clone).** Rejected: this is the literal AHA/DRY violation the "one
  mechanism per feature" framing exists to prevent — three near-identical
  tools serving one concern, each free to drift, each requiring its own
  scoping review. The three connectors already differ in surface vocabulary
  for the same underlying primitive; native does not need to reproduce that
  fragmentation.
- **Leave the five features as permanently connector-only, native as a
  deliberately reduced lane.** Rejected outright by the operator's directive
  — "anything reachable via a connector must be reachable natively" is
  stated as a requirement, not a preference, and this record exists to
  discharge it.
- **Bridge each connector's native plugin/hook/skill format directly (import
  a Claude Code `SKILL.md` file, a `settings.json` hook block, or a Codex
  approval policy verbatim) instead of a native-owned schema.** Rejected:
  this would make arbor's governed surfaces dependent on undocumented
  connector-internal formats the clean-room boundary in
  `docs/research/reference-harness-clean-room-spec.md` already excludes from
  implementation (behavior may be surveyed; upstream format/prompt/control
  flow may not be reproduced). A future compatibility *importer* that reads
  a `SKILL.md` file and emits a native governed descriptor is a legitimate
  and much smaller idea, but it is a separate decision from what this record
  fixes: the native mechanism itself must be arbor-owned regardless of
  whether an importer for a foreign format is ever built.
- **Give the native hook engine an MCP catalog kind / TUI screen now, as
  part of closing this gap.** Rejected: commit `ddccd39f`'s CLI-only-by-design
  decision for hook *inspection* is a separate, already-settled question
  (canvas C-11) about a diagnostics surface, not about the firing engine this
  record is extending. Revisiting it is out of scope here and would need its
  own record if a real requirement for a wider inspection surface emerges.

## Obligations

### O1 — A dispatched native agent can request a further subagent dispatch through one scoped tool

<!-- proof: symbol=NativeAgentExecutor file=packages/arbor-mcp/src/native-agent-executor.ts roundtrip=packages/arbor-mcp/tests/native-agent-executor.test.ts -->

`NativeAgentExecutor.createNativeSubagentDispatchToolPort` is the sole
model-callable native constructor; its roundtrip uses `specialize()` and its
`subagent-` child is fixed no-tools/no-worktree, bounding recursion to one.

### O2 — A dispatched native agent can ask one bounded clarifying question mid-session

<!-- proof: symbol=createNativeClarificationToolPort file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-child-bus.test.ts -->

The port uses `bus.thread.send` with the existing `clarify` kind and polls
only its trusted parent edge for a correlated `reply`; one call is in-flight
per session and same-call replay returns its recorded result.

### O3 — A native session can attach a governed image to a mid-session model call, not only a pre-campaign planning attachment

<!-- proof: symbol=createNativeImageToolPorts file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-agent-executor.test.ts -->

`image.attach` resolves only a campaign-held governed image and folds it into
the next native model turn. The cited executor roundtrip proves that next-turn
delivery and the deny-by-default transport/capability gate; it does not rely
on a planning-time attachment alone.
