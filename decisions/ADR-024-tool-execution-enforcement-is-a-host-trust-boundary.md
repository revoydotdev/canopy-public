# ADR-024: Tool-Execution Enforcement Is a Host Trust Boundary, Not a revoy2 Gate

**Status:** Accepted
**Date:** 2026-08-04
**Ratified:** 2026-08-05 by revelri (repository owner), on an explicit
review of the host-boundary Decision below. Recorded here because no agent
holds acceptance authority over a decision it drafted: the implementing agent
proposed this record and a human ratified it, which is the checks-and-balances
rule in AGENTS.md applied to ADR governance itself.

Ratification covers the host tool-dispatch boundary (boundary 1) as written.
It does NOT resolve boundary 2 — revoy2-owned mutating MCP surfaces — which
Decision point 4 deliberately leaves open. That question moves to ADR-028,
authored as Proposed on the same date, per the follow-up this record names.

## Context

revoy2 has no enforcement point in front of tool execution (G-14, ROADMAP.md
Verified gap register). Two things exist that look like they should compose
into one, and do not:

1. **`ApprovalService`** (`arbor-mcp/src/approval-service.ts`) is a durable,
   idempotent approval-record service with real checks-and-balances: a
   request carries its proposer, and a decision by that same actor is
   structurally rejected as self-approval (fail-closed). But its own header
   comment already says what it is: "It never blesses an action itself — it
   only records the durable approval decision for an orchestration layer to
   act on." It is a ledger of decisions, not a decision-maker consulted
   before anything happens.
2. **`opencode-executor.ts`** — the actual tool-dispatch path the campaign
   loop drives — has zero references to `ApprovalService` anywhere in it.
   Confirmed by direct search: nothing in the executor calls, imports, or
   checks against approval state before a specialist or critic tool runs.

Separately, `arbor-opencode/src/permissions.ts` builds a declarative
`PermissionConfig` (`allow` / `deny` / `ask`, opencode's nested-glob rule
syntax) per botanical agent, enforcing ADR-001 isolation and ADR-005
capability tiers *on paper*. That config is handed to the opencode host at
agent-registration time. **The host enforces it, not revoy2.** revoy2 emits
the rules; it does not sit between an agent's decision to call a tool and
the tool actually running.

**Amendment (2026-08-04, before this ADR left Proposed status):** the
original survey above missed a third thing, and it does not fit the "looks
like enforcement, isn't" shape of the other two. `arbor-core/src/capability.ts`
and arbor-core/src/capability-token.ts (landed `690cabd`, 2026-08-02 — two
days *before* this ADR was first drafted; capability-token.ts was itself
later deleted — see O4) are a pure, dependency-free pair of
decision functions: `enforceAction(actionClass, tier)` throws
`CapabilityError` before a mutation if the caller's tier doesn't meet the
action class's required tier, and `tokenCovers(token, path, action)` answers
whether a minted, TTL-bounded, tamper-evident scope token authorizes an
action on a path. Both are fully tested (`capability.test.ts`,
capability-token.test.ts) and exported from `arbor-core`'s public barrel.
`capability.ts`'s own docstring names its intended callers explicitly: "any
mutating surface (MCP tool handler, CLI mutator, **the ops edit server**) can
enforce it identically with no authority of its own" — which is a direct,
pre-existing answer to the "MCP tool like ops-server.ts's `ops_edit`,
invoked directly ... nothing inside revoy2 stops it" gap this ADR's own
Negative Consequences section (below) independently names. Confirmed by
reading both files in full and cross-referencing the reachability
allowlist, which carries all 12 of their exports under `G-14` with the
reason "same unenforced boundary as G-14" — i.e. the gate already knows
these symbols are unreached, and the allowlist already (if implicitly)
treats their dormancy as this ADR's doing.

This module is **not** the same kind of thing as `ApprovalService` or
`permissions.ts`. Those two are structurally incapable of being "the"
enforcement point without a larger change (a record nothing consults; a
ruleset only the host reads). `capability.ts`/capability-token.ts is a
callable gate — the only thing missing is a call site. That distinction
matters for the Decision below: it is not enough to say "nothing enforces
tool execution today," because for one class of mutating surface, something
*could*, cheaply, and already exists tested and dependency-free. See the new
Context subsection immediately below and Decision point 4.

**Second amendment (2026-08-04, wave 3, still Proposed):** ops-server.ts's
`ops_edit` — this ADR's concrete boundary-2 example throughout — was deleted
in wave 5 (G-17, resolved by removal alongside hashline.ts/ops-edit.ts;
`grep` over `packages/*/src` confirms all three are gone). The example is
stale; the underlying point is not. `arbor-mcp/src/tools.ts` (commit
`241a02b`, wave 2, landed after this ADR was drafted) now exposes
`RuntimeCatalogRouter`'s ~30 command/query kinds <!-- sur-05:historical — the
count as of this ADR's date; an ADR records its reasoning as of when it was
written and is not edited to chase a moving number --> — including mutating ones
like `job.submit`, `approval.approve`/`reject`, `campaign.halt`,
`recovery.retry`/`abandon` — as two standard, MCP-`tools/list`-discoverable
tools (`arbor_command`/`arbor_query`), reachable from any MCP client, not
just this repo's own CLI/webui callers. Confirmed neither `tools.ts` nor
`runtime-catalog.ts` imports `enforceAction`/`tokenCovers` from
`@arbor/core` — `capability.ts`/capability-token.ts remains exactly as
unwired against this now-externally-reachable surface as it was against the
deleted `ops_edit`. Boundary 2's live example is `arbor_command`'s mutating
kinds, not `ops_edit`; Decision point 4's deferral stands unchanged, but an
operator evaluating it should weigh that the surface it defers on is now MCP-
client-reachable, not merely a revoy2-internal handler.

### Two different boundaries, not one

The three things above do not all bear on the same boundary, and treating
them as one caused the original miss:

1. **The host's tool-dispatch boundary** — an opencode-driven botanical
   agent deciding to call Bash, Edit, or any other tool the host itself
   executes. revoy2 never sits in that call path; only the host process
   does. `capability.ts`'s `ActionClass`/`CapabilityTier` model has no
   concept of a shell command, a file-write syscall, or an opencode tool
   name — it cannot answer "should this Bash invocation run" without a
   mapping from arbitrary tool calls to `{read, plan, preview-confirm,
   forbidden}` that does not exist and is not a small addition. Wiring it
   here would face the same partial-coverage problem Alternative 1 (below)
   already rejects.
2. **revoy2-owned mutating MCP surfaces** — code revoy2 itself implements
   and fully controls, such as ops-server.ts's `ops_edit` tool handler
   (ops-server.ts was later deleted — see the second amendment below).
   Nothing outside revoy2 sits between "this handler received
   a call" and "the mutation happens." `capability.ts`'s footprint-glob and
   action-class model was built for exactly this shape (its own docstring
   says so), and needs no mapping layer to apply — the handler already knows
   its own action class and can check a token's footprint against the path
   it is about to touch.

So there are, today, two independent, non-composing things that fail to be
"revoy2 blocking a tool call" at the *host* boundary (an approval *record*
nothing consults, and a permission *ruleset* revoy2 itself does not
enforce), and a third thing — a real, callable, unwired gate — that bears
only on the *narrower, revoy2-owned* boundary. The gap register correctly
identifies the host boundary as needing a decision, not a bug fix: is that
architecture — as built — an accepted trust boundary, or a defect to close
by making revoy2 itself an enforcement point? This ADR answers that
question for the host boundary. It does **not** answer it for revoy2-owned
mutating surfaces, and says so explicitly in the Decision below rather than
letting the host-boundary answer silently cover ground it never examined.

## Decision

**Ratify the host tool-dispatch boundary as explicit and intentional.**
(Scope note: this Decision covers boundary 1 from the Context amendment above
— an opencode-driven agent's own tool calls. It does not resolve boundary 2
— revoy2-owned mutating MCP surfaces such as `ops_edit` — see point 4 below.)
revoy2 is a
governance-and-evidence layer *around* tool execution — it types provenance,
records approval decisions, gates campaign/tree lifecycle transitions
(ADR-006's four process gates), and emits declarative permission rules for
its host — but it is **not, and will not become, an enforcement point in
front of the raw tool call itself.** The host process actually running the
tool (opencode today; any future co-process executor per the
`full-harness-ownership-brief.md` direction ADR's seam-contract work already
anticipates) is the only thing standing between "an agent decided to call a
tool" and "the tool executed," and its enforcement of the emitted
`PermissionConfig` is revoy2's entire defense against unwanted tool
execution.

State the consequence plainly, because a documented-but-unconfirmed
safeguard is worse than an absent one (the exact shape G-14 found):
**revoy2 is only ever as safe as the harness it runs inside, for tool calls
the harness itself dispatches.** If a host ignores or misimplements the
emitted permission rules, nothing inside revoy2 stops it — that limitation
is real and this ADR does not change it. For an MCP tool revoy2 itself
implements and dispatches directly, such as ops-server.ts's
`ops_edit` (ops-server.ts was later deleted — see the second amendment below), invoked without going through the host's tool-call surface at
all, the situation is different in kind, not just degree: **today nothing
inside revoy2 stops it either, but that is a standing choice, not a
technical limit** — `capability.ts`/capability-token.ts (Context
amendment above) is a ready, tested, dependency-free gate that `ops_edit`'s
own handler could call before mutating. Point 4 below states this as an
explicit, currently-undecided follow-up rather than letting it hide inside
the host-boundary language above. revoy2's four process gates govern
campaign/tree *state transitions* — admission, isolation, evidence, audit —
a narrower and different boundary than "did this specific shell command or
file write happen."

Concretely, this ADR codifies four things as intentional, not accidental —
three ratified now, one explicitly deferred rather than silently ratified
by omission:

1. **`ApprovalService` remains record-keeping, not gating.** The approvable
   action set (`campaign.halt`, `recovery.abandon`, `output.raw`,
   `permission.grant`) is durably logged with checks-and-balances for
   whoever reads it later (an operator, a future TUI approval screen) — it
   is evidence of a decision, not the mechanism that enforces it.
2. **No `LoopExecutor` implementation is required to consult
   `ApprovalService` before dispatching a tool.** This was never the
   contract; ADR/6.6's seam-contract suite for `LoopExecutor` should not add
   an approval-consultation requirement as part of this ADR, and any future
   wave proposing one should treat it as new scope, not a bug fix for this
   gap.
3. **`permissions.ts`'s `PermissionConfig` is the real, sole enforcement
   surface for the host tool-dispatch boundary, and it is host-enforced.**
   This should be stated in that module's own header as a documentation
   follow-up (not a code change this ADR performs), so a future reader does
   not mistake the ruleset's existence for revoy2-side enforcement.
4. **`capability.ts`/capability-token.ts remains unwired, and that is a
   deferred decision, not a ratified non-goal.** Unlike `ApprovalService`
   and `permissions.ts`, this module is not being kept dormant because it
   structurally cannot be the enforcement point — it could be, for
   revoy2-owned mutating MCP surfaces (boundary 2), with no architectural
   change beyond adding call sites. This ADR does **not** decide whether to
   wire it into ops-server.ts (or any other revoy2-owned mutating
   handler); it declines to decide that here, because doing so touches
   files outside this ADR's survey and deserves its own Context/Decision
   rather than an offhand yes/no attached to the host-boundary question.
   What this ADR does do is refuse to let the host-boundary Decision above
   be read as also covering boundary 2 — the two were conflated in this
   ADR's first draft, and the `G-14` allowlist entries for both files
   inherited that conflation (their `reason` text reads "same unenforced
   boundary as G-14," which is accurate for what the gate observes —
   unreached — but was written before this distinction existed). A
   follow-up gap or ADR should pick this up explicitly; this ADR record is
   deliberately not the place that closes it, to avoid the same
   "documented-but-unconfirmed" trap it warns against for `ApprovalService`.

## Consequences

**Positive:**

- Avoids building and maintaining a second enforcement engine that would
  have to duplicate — and could silently drift from — the host's own
  tool-gating. revoy2 is a TypeScript library/MCP server; it has no OS- or
  process-level sandboxing boundary to enforce with, and pretending
  otherwise would be worse than not trying.
- Makes the architecture's actual safety story explicit instead of implicit.
  The diagram already drew this boundary; this ADR says so out loud and
  retires `ApprovalService`'s dormancy from "apparent oversight" to "ratified
  design."

**Negative:**

- revoy2 cannot itself guarantee that no exploited or malicious tool call
  ever runs, for any host that does not correctly enforce the emitted
  permission rules. This is a real, user-facing safety limitation, not a
  hypothetical one. It must be surfaced wherever revoy2's safety properties
  are documented for an operator (release-readiness notes, any future
  security-posture doc) so nobody mistakes `ApprovalService`'s existence, or
  the four process gates, for tool-execution enforcement.
- Leaves boundary 2 (revoy2-owned mutating MCP surfaces, e.g. `ops_edit`)
  open with a *cheaper* fix sitting unused than boundary 1 has: this ADR
  does not wire `capability.ts` in, so `ops_edit` and any sibling revoy2-
  implemented mutating handler remain exactly as unenforced today as before
  this amendment. The only change is that this is now a named, tracked
  choice instead of an unexamined gap.

**Neutral:**

- Campaign-level governance — the four process gates and
  checks-and-balances on the approval decisions that *do* flow through
  `ApprovalService` — remains real and unchanged. This ADR narrows what is
  claimed about tool execution specifically; it does not weaken anything
  already built.

## Test implications

- `ApprovalService`'s existing self-approval-rejection and idempotency tests
  continue to prove the record-keeping guarantees this ADR relies on.
- `capability.ts`'s and capability-token.ts's existing unit tests
  (`capability.test.ts`, capability-token.test.ts) continue to prove the
  gate/token guarantees stand ready to be called; this ADR does not touch or
  invalidate them, and their pass/fail status is not evidence for or against
  the wiring decision this ADR defers.
- A new documentation-level check (not a runtime test) belongs wherever the
  project tracks safety claims: assert that no doc claims revoy2 enforces
  tool execution independent of its host, mirroring how `docs-truth.mjs`
  already refuses to let a ✅ claim outrun its evidence.
- No new runtime test is implied by this ADR, because it deliberately does
  not add an enforcement mechanism to test.

## Alternatives considered

1. **Wire `ApprovalService` into `opencode-executor.ts` as a hard gate
   before every specialist/critic tool dispatch.** Rejected for now: a large
   behavior change to the live dispatch loop (every call needing a
   synchronous or async approval round-trip) touching files two other
   lanes are actively editing this wave. More fundamentally, it would only
   cover tool calls routed through *this* executor — MCP tools reachable
   directly (ops-server.ts, `runtime-catalog.ts` command/query dispatch)
   would remain unenforced, so a partial wire-up would manufacture a false
   sense of completeness rather than closing the actual gap. Left as a real,
   costed option for a future ADR if "revoy2 owns enforcement" is chosen
   over "ratify the host boundary."
2. **Build an in-process policy/sandbox engine independent of the host**
   (intercept `child_process`, filesystem calls, etc.) so revoy2 enforces
   regardless of which host runs it. Rejected for the host tool-dispatch
   boundary: revoy2 already declines to own process isolation — worktrees
   delegate that to git and the filesystem (ADR-001). A policy engine at
   *that* layer would duplicate OS-level sandboxing poorly and expand
   revoy2's trust surface exactly where the checks-and-balances discipline
   says authority should stay narrow and typed, not become an ambient,
   kernel-adjacent capability. **Correction from this ADR's first draft:**
   this alternative was originally framed as a purely hypothetical future
   build. It is not hypothetical — a narrower version already exists
   (`capability.ts`/capability-token.ts, landed two days before this ADR),
   and it does not attempt OS-level interception at all; it is an
   application-level action-class/footprint check a handler calls
   voluntarily, not a `child_process`/filesystem intercept. The rejection
   above still holds for the host boundary (an opencode tool call has no
   `ActionClass` mapping and this module cannot answer for it), but does
   **not** transfer to boundary 2 (revoy2-owned mutating handlers) — see
   Alternative 4.
3. **Leave it undecided (no ADR).** Rejected — this is precisely the
   "unwitnessed claim" shape Phase 6 exists to close. A comment saying
   "never blesses an action" without a ratifying decision is a safeguard
   that is documented but not confirmed as intentional, which is worse than
   no comment at all.
4. **Wire `capability.ts`/capability-token.ts into ops-server.ts's
   `ops_edit` (and any sibling revoy2-owned mutating handler) as part of
   this ADR.** Rejected *for this ADR specifically*, not rejected outright:
   this ADR's Context survey was scoped to the host tool-dispatch boundary
   and only surfaced the module during the 2026-08-04 remediation amendment;
   deciding to wire it now, inside an amendment to an already-drafted ADR,
   would be making a new architectural decision without its own proper
   Context/Consequences treatment (e.g., what happens to in-flight
   `ops_edit` calls during a campaign another lane is actively running this
   wave; whether `preview-confirm`-tier gating is the right shape for every
   existing `ops_edit` caller). Left as the explicit, named follow-up (see
   Decision point 4) rather than either silently adopting it here or
   silently leaving it unexamined, which is what the original draft did.

## Obligations

Scope note: these obligations cover boundary 1 (the host tool-dispatch
boundary), the only boundary this ADR's Decision resolves. Boundary 2
(revoy2-owned mutating MCP surfaces) is deliberately left open here and is
ADR-028's subject, not this record's.

### O1 — `ApprovalService` structurally rejects self-approval and remains a durable record of decisions; it is never itself consulted as a gate

<!-- proof: symbol=ApprovalService file=packages/arbor-mcp/src/approval-service.ts roundtrip=packages/arbor-mcp/tests/approval-service.test.ts -->

### O2 — No `LoopExecutor` implementation is required to consult `ApprovalService` before dispatching a tool call

<!-- unverifiable: negative claim over every LoopExecutor implementation (confirmed today: nothing under arbor-opencode/src or arbor-opencode/tests references ApprovalService), and no test can witness an absence that a future implementation could reintroduce. -->

No proof attached. This is a real negative claim (confirmed by direct
search: nothing under `arbor-opencode/src` or `arbor-opencode/tests`
references `ApprovalService`), but no test in the repository asserts the
absence — the claim rests on grep, not on regression coverage.

### O3 — `permissions.ts`'s generated `PermissionConfig` is the real, host-enforced boundary for tool dispatch; revoy2 emits the ruleset but does not itself enforce it

<!-- proof: symbol=permissionsFor file=packages/arbor-opencode/src/permissions.ts roundtrip=packages/arbor-opencode/tests/agent-bindings.test.ts -->

### O4 — `capability.ts` is a real, tested, callable gate; ADR-028 later wires its enforcement and introspection at revoy2-owned catalog surfaces

<!-- proof: symbol=enforceAction file=packages/arbor-core/src/capability.ts roundtrip=packages/arbor-core/tests/capability.test.ts -->

As of this ADR, no mutating handler called it; ADR-028 later wires it into
`RuntimeCatalogRouter` and its read-only introspection projection. The dormant
path-scoped token helper referred to by the historical context was removed
when no path-naming surface emerged.
