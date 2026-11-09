# ADR-136: The Persona-to-Authority Mapping Fails Closed On Anything Unrecognized

**Status:** Accepted
**Date:** 2026-08-27
**Authoring Revision:** 3e7ffa215cf325197b8f0065d2df1e48470650b6
**Content ID:** sha256:455036491792ac671fd45f26d81ccb3961b34b9828da0c2667318f794d5f5efa

## Context

This repository has two role taxonomies for the same work. Eleven
"botanical" personas (`packages/arbor-opencode/src/agents.ts`) name the
agent a task is delegated *to*: crown, cambium, taproot, seed, heartwood,
lenticel, burl, xylem, rhizome, mycelium, stoma. A separate, smaller set of
four native role profiles (`packages/arbor-prompts/src/role-profiles.ts`) —
architect, documentation-writer, specialist-executor, critic-reviewer —
carries the ENFORCED tool authority: `NATIVE_ROLE_PROFILES` fixes each
profile's `allowed_tools` and `implementation_writes_forbidden`, and
`composeNativeRole` (`packages/arbor-mcp/src/native-role-composer.ts`) can
only ever intersect that authority down against host-available tools, never
expand it. `delegate_to` names a persona; `defaultNativeRoleFor`
(`native-role-composer.ts`) maps that persona to a profile whenever a
caller does not supply `execution_role` explicitly.

Research suggests this two-taxonomy split is not organic-growth debt to be
collapsed but the pattern other systems converge on: OpenHands splits
controller-authority from agent-behaviour the same way; MiniScope
(2512.11147, UC Berkeley) and Dynamic Capability Scoping (2607.22445) both
formalise decoupling authority from task-facing role; ToolPrivBench
(2606.20023) found general safety alignment does not reliably transfer to
least-privilege tool selection, so the scoping layer must be structural
code the model cannot talk its way around, not the model's own judgement.
`deriveNativeHighRiskToolScope` (`packages/arbor-mcp/src/manager.ts`)
already is that: no model call, pure code, with a regex mining fallback —
exactly the deterministic layer ToolPrivBench's finding argues a system
needs. The split stays.

The risk research does not settle is the mapping itself. Reading
`defaultNativeRoleFor` as it stood before this decision:

```
export function defaultNativeRoleFor(input: { readonly operation: "specialize" | "review"; readonly agent: string }): NativeRoleProfileId {
  if (input.operation === "review") return "critic-reviewer";
  if (input.agent === "architect" || input.agent === "taproot") return "architect";
  if (input.agent === "documentation-writer") return "documentation-writer";
  return "specialist-executor";
}
```

`input.agent` is not validated before this function is called from a
model-facing surface: `packages/arbor-mcp/src/tools.ts` declares
`specialist_agent: { type: "string" }` in the MCP tool schema with no enum,
and `native-agent-executor.ts:558`'s `specialize()` passes that string
straight through as `params.specialist_agent`. Every branch not explicitly
matched — a typo, a name from a future persona, or one of six of the
eleven documented botanical agents — falls to `return
"specialist-executor"`: the ONE native profile with `shell.execute`,
`file.write`, and `file.patch`, and `implementation_writes_forbidden:
false`.

That default is not the safe one. opencode's own `permissions.ts`
(ADR-001/ADR-005 — read in full alongside `agents.ts`'s header comment)
grants full worktree `edit`/`write` authority to exactly two botanical
subagents, Heartwood and Seed, and documents every other subagent —
Lenticel, Burl, Xylem (critics) and Rhizome, Mycelium, Stoma (research
specialists) — as "read-only. Cannot edit, cannot delegate." So before this
decision, a specialize turn for `"burl"` (a read-only reasoning consultant
by every existing contract) or `"rhizome"` (read-only codebase search) fell
through the same unmatched branch as a plain typo and landed on
`specialist-executor` — full write and shell authority, directly
contradicting what `permissions.ts` already grants that identical persona
name one layer up. The function's own comment called this fallback a
"least-authority default"; among the four profiles it is in fact the
single MOST permissive one. This is a real gap, not a manufactured one: it
is reachable from unvalidated, potentially model-controlled input, and the
existing test suite (`native-role-composer.test.ts`, pre-this-decision)
documented only the safe cases (`"taproot"`, `"documentation-writer"`,
`"seed"`) — nothing exercised what an unrecognized persona actually
received.

## Decision

**`defaultNativeRoleFor` becomes total over every value it accepts and
fails closed — by throwing — for anything it does not.**

1. For `operation: "review"`, behavior is unchanged: every review turn maps
   to `critic-reviewer` unconditionally, regardless of `agent`. This branch
   was already total and already the narrowest profile; nothing here
   needed to change.

2. For `operation: "specialize"`, the function now enumerates every value
   it accepts, in agreement with opencode's own `permissions.ts` grant for
   the identical persona name:
   - `"architect"` or `"taproot"` → `architect` (unchanged).
   - `"documentation-writer"` → `documentation-writer` (unchanged).
   - `"heartwood"` or `"seed"` (the two botanical agents `permissions.ts`
     grants full edit/write) → `specialist-executor`.
   - `"lenticel"`, `"burl"`, `"xylem"`, `"rhizome"`, `"mycelium"`, `"stoma"`
     (the six botanical agents `permissions.ts` documents as read-only) →
     `critic-reviewer` — the only native profile with no write/shell tools,
     matching the grant those names already carry one layer up.
   - Anything else — including `"crown"`/`"cambium"` (orchestrators,
     never a valid `specialize` delegate: `agents.ts`'s own `DESCRIPTIONS`
     says Crown/Cambium "do NOT write code"), a misspelled persona, or any
     future/unknown name — throws, naming the rejected value.

3. A caller with a genuine need to route an unlisted name through native
   execution still can: `specialize()`'s existing `execution_role`
   parameter bypasses this function entirely and is unaffected. This
   decision only changes what happens when no explicit role is supplied
   and the implicit default has to guess.

## Consequences

An unrecognized or misspelled `specialist_agent` value now surfaces
immediately, as a thrown error at the composition boundary, instead of
silently granting the campaign's most permissive execution profile. This
converts a silent authority escalation into a loud, attributable failure —
exactly the shape a total, fail-closed mapping is supposed to have. Six
botanical personas that were never supposed to write files or run shell
commands (per `permissions.ts`, already true before this decision) can no
longer acquire that authority through the native path's implicit default;
they now correctly resolve to `critic-reviewer`, matching the read-only
grant `permissions.ts` already gives them under opencode.

The cost is availability, not safety: a caller that was relying on the old
catch-all to route some seventh persona name (or a typo) through
`specialist-executor` without explicitly requesting it will now see a
thrown error where it previously got silent (if unintended) success. The
full `arbor-mcp` suite (2,570 passing tests, 3 pre-existing and unrelated
failures — a stale marketplace-index fixture, a `dist/` build-artifact
gap, and a host-dependent seccomp assertion, none touching this seam) shows
no caller in this repository actually depended on that fallthrough:
`declarative-subagent-executor.ts`'s `EXECUTABLE_ROLES` and
`native-agent-executor.ts`'s `SUBAGENT_EXECUTABLE_ROLES` already pre-
validate against `{seed, heartwood, architect, documentation-writer}`
before ever reaching this function, and every other in-repo caller passes
one of the botanical names this decision explicitly maps.

## Alternatives / Roads not taken

**Default the fallback to `critic-reviewer` instead of throwing.** Rejected:
this still silently resolves an unrecognized name to *some* profile rather
than surfacing the gap. A persona this system does not know about is a
configuration or code defect, not a routing decision this function should
make quietly on the caller's behalf — the caller needs to know its
`specialist_agent` value did not resolve, not receive a plausible-looking
but arbitrary answer.

**Collapse the two taxonomies into one.** Rejected per the research cited
in Context: OpenHands, MiniScope, and Dynamic Capability Scoping all
independently arrive at separating controller-facing persona from
enforced tool authority. Merging them would remove the seam that lets
`composeNativeRole` intersect authority down regardless of which persona
system a caller uses, and would need to be re-derived the moment a twelfth
persona or a fifth profile is added.

**Let the model self-select its tool authority (e.g. have the persona
declare its own required tools).** Rejected on ToolPrivBench's
(2606.20023) finding directly: general safety alignment does not reliably
transfer to least-privilege tool selection, so authority must stay in a
structural layer the model cannot talk its way around — exactly what
`defaultNativeRoleFor` and `composeNativeRole`'s tool-intersection already
are, and what a model-driven declaration would give up.

## Obligations

### O1 — `defaultNativeRoleFor` never returns `specialist-executor` (or any profile) for a `specialize` agent it does not explicitly enumerate; it throws instead

`native-role-composer.test.ts`'s new case ("ADR-persona-authority-mapping-fails-closed: throws rather than silently granting write/shell authority for an agent it does not recognize") drives `defaultNativeRoleFor` with Crown, Cambium, a misspelled persona, an empty string, and profile-id look-alike strings, and asserts every one throws with a message naming the rejected value; a companion case proves `review` stays total and safe regardless of `agent`.

<!-- proof: symbol=defaultNativeRoleFor file=packages/arbor-mcp/src/native-role-composer.ts roundtrip=packages/arbor-mcp/tests/native-role-composer.test.ts -->

### O2 — Every botanical persona `permissions.ts` documents read-only (Lenticel, Burl, Xylem, Rhizome, Mycelium, Stoma) resolves to `critic-reviewer`, never `specialist-executor`, for a `specialize` turn

`native-role-composer.test.ts`'s new case ("ADR-persona-authority-mapping-fails-closed: maps every read-only botanical agent to critic-reviewer for a specialize turn, never the write-capable specialist-executor default") asserts all six read-only botanical names resolve to `critic-reviewer` and that Heartwood — the botanical name `permissions.ts` does grant full edit/write — still resolves to `specialist-executor`, so the mapping's write/no-write line is proven to track `permissions.ts`'s existing grant exactly, not just documented in prose.

<!-- proof: symbol=defaultNativeRoleFor file=packages/arbor-mcp/src/native-role-composer.ts roundtrip=packages/arbor-mcp/tests/native-role-composer.test.ts -->
