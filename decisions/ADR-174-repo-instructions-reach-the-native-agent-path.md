# ADR-174: Repository Instructions Reach the Native Agent Path

**Status:** Accepted
**Date:** 2026-09-28
**Authoring Revision:** 82ce26a10946cbc6e98617ceddb1cef0607cef14
**Content ID:** sha256:4e95236fcae9eaa3d5d2a2927b59280ccf8c774cc8b39678998ed1f94769fec6

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR
governance by ADR-024's ratification note).

revoy2 reads a repository's own instruction files — the conventional
names listed in `REPO_INSTRUCTIONS_FILENAMES` (`repo-instructions.ts:19`),
of which this repository's own `AGENTS.md` is one — and can render them
into an agent's system prompt. On the
native path — the default executor, per AGENTS.md's description of
ADR-099 — that capability is never invoked. No live agent has ever
received a repository's `AGENTS.md`. This record decides where the
capability lives, not whether it is wanted: it is wanted, and it is
already implemented and tested.

Every line cited below was read directly in this working tree on
2026-09-27.

**The capability exists, with tests and an ADR.** `resolveRepoInstructions`
is exported from `packages/arbor-prompts/src/repo-instructions.ts` (and
re-exported from that package's `index.ts`), reads
`REPO_INSTRUCTIONS_FILENAMES` (`:19`), bounds the read at
`REPO_INSTRUCTIONS_BYTE_BUDGET` (`:26`), and marks truncation explicitly
(`:88`). It refuses to walk parent directories (`:42`) and declares
`AGENTS.md`/CLAUDE.md content non-authoritative by construction. ADR-022
(G-10) documents the behavior. Two dedicated test files exercise it.

**Its only production call site is unreachable.** The sole call is
`packages/arbor-opencode/src/agents.ts:273`:

    const repoInstructions = isPrimary && options.worktreePath ? resolveRepoInstructions(options.worktreePath) : undefined;

No caller ever supplies `worktreePath`. `buildAllAgents` (`agents.ts:302`),
`buildArborConfigBlock`, and `arborPlugin` each have **zero** non-test
callers anywhere in `packages/` or `scripts/`. The result is a guarded
expression whose true branch is unreachable, which makes the whole
subsystem a test-only island.

**The package that holds it is slated for removal.** AGENTS.md describes
`@arbor/opencode` as deprecated as a direct product dependency by ADR-061,
transitional, with the requirement to "move generic contracts to a neutral
Revoy package… before removing the mcp project reference." The only
working implementation of a capability ADR-022 asserts is delivered lives
in exactly that package. Left alone, ADR-061 removes the implementation
and leaves the ADR-022 claim behind.

**The render path is live and starved.** `role-profiles.ts:98` declares
`repo_instructions` and `:143` renders it;
`packages/arbor-prompts/src/index.ts:87,100,133` interpolate
`repoInstructionsBlock(ctx)` into the Crown, Cambium, and Taproot
prompts. These run on every prompt composition. They are simply never
handed a value.

**The native contract already accepts the field.**
`packages/arbor-mcp/src/native-role-composer.ts:27` declares
`NativeRoleCompositionInput extends RolePromptCompositionInput`, which
carries `repo_instructions`. The native path therefore needs no contract
change and no new type — only a producer at the composition site.

**The producer has its inputs in hand.**
`packages/arbor-mcp/src/native-agent-executor.ts:1049-1063` calls
`composeNativeRole`, and at `:1061` already resolves
`environment: resolveEnvironmentSnapshot(input.workspace_roots[0] ?? this.options.workspace_root)`.
That expression is the worktree this role will act in. The same path is
the right source for repository instructions, and
`native-agent-executor.ts` contains **zero** occurrences of
`repoInstructions` or `repo_instructions`.

The net effect is that an operator's repository instructions are silently
discarded, with no error, no warning, and no observable difference
between a repository that documents its conventions and one that does
not. Nothing in the system distinguishes the two cases.

## Decision

**`resolveRepoInstructions` is called on the native composition path, in
`@arbor/mcp`, from the same worktree root that already resolves the
environment snapshot — and `@arbor/prompts` keeps ownership of the
resolution logic itself.**

The implementing change is small, and its smallness is the point:

1. `native-agent-executor.ts:1049-1063` resolves
   `repo_instructions: resolveRepoInstructions(<the same worktree root
   passed to `resolveEnvironmentSnapshot` at `:1061`>)` and passes it into
   `composeNativeRole`. No new type, no new field, no contract change.
2. `@arbor/mcp` already depends on `@arbor/prompts`; the resolution
   function moves no packages. `@arbor/opencode`'s call site keeps
   working unchanged, so ADR-061's migration is not blocked or forked by
   this change.
3. Because the native root is a per-node worktree and the environment
   snapshot is already resolved from it at composition time, repository
   instructions inherit ADR-103's existing correctness argument: the
   value is read against the tree the role will actually act in, not a
   tree captured at session start.

**Deliberately not in scope.** This record does not change the 8 KiB
budget, does not add a parent-directory walk, and does not change the
`context-only` authority framing. Those are separately defensible
decisions with separately defensible costs, and mixing them into a wiring
fix would make the wiring change unreviewable. A nested-package
Specialist still receives the worktree-root file or nothing; that remains
open, and is recorded as a known limitation in Consequences rather than
silently accepted.

## Consequences

**Positive.** An operator's `AGENTS.md` reaches a live agent for the
first time. The render path that already runs on every composition starts
receiving input, so the change is verifiable at the prompt layer rather
than only at the resolution layer.

**Positive.** ADR-061's migration stops being a countdown on a
capability ADR-022 asserts. The implementation moves to the native path
before the deprecated package loses it.

**Negative.** The system gains a new place where repository content
reaches a model. `AGENTS.md` is operator-authored, not Revoy-authored,
and it is now inside the prompt of every composition that carries it. The
existing mitigations — the non-authoritative framing, the explicit byte
cap, the truncation marker — were designed for exactly this and are
unchanged, but the surface area over which they must hold grows from one
tested path to two.

**Negative, load-bearing.** A file that is silently truncated at 8 KiB is
still silently truncated, and `source_paths` continues to report a file
as fully consumed (`:71`). A reader must not conclude from this record
that an operator's instructions are delivered intact. Mid-sentence
truncation remains a known correctness hazard, unchanged and unaddressed
here.

**Negative, load-bearing.** This does not make instructions hierarchical.
No parent-directory walk is added, so a Seed working in a nested package
receives the worktree-root file or nothing. That is a real gap, recorded
here so it is not mistaken for solved.

## Alternatives / Roads not taken

1. **Retire the capability: remove ADR-022 (G-10), the field, the tests,
   and every doc that claims it works.** Rejected: the implementation is
   real, tested, and deliberately designed with non-authoritative framing
   and an explicit budget. Deleting working, documented, tested
   functionality to close a wiring gap discards the part that works.
2. **Defer to ADR-061's migration decision and fix it in the new
   package.** Rejected as a sequencing risk: ADR-061 removes the
   deprecated package, and until the native path calls this function, the
   capability's only implementation is inside what is being removed. The
   gap would be carried through the migration and resurface after it.
3. **Move `resolveRepoInstructions` from `@arbor/prompts` into
   `@arbor/harness`.** Rejected as unnecessary: `@arbor/mcp` — the native
   path's home — already depends on `@arbor/prompts`, and the resolution
   logic is a prompt-assembly concern that belongs with the other
   prompt-context resolution (`environment-context.ts`, `role-profiles.ts`)
   rather than with the harness. Relocating it would be a move across
   five path-keyed stores for no gain.
4. **Add a parent-directory walk in the same change.** Rejected: it
   interacts with worktree isolation and needs its own argument about
   the boundary. Bundling it would make neither reviewable. Recorded as
   the follow-up in Consequences.
5. **Populate the field on the `arbor-opencode` path only, since that is
   where the call already exists.** Rejected: that path has zero
   production callers, so it would change nothing observable.

## Obligations

### O1 — The resolution logic this record depends on is exported, owned by `@arbor/prompts`, and test-covered today

<!-- proof: symbol=resolveRepoInstructions file=packages/arbor-prompts/src/repo-instructions.ts roundtrip=packages/arbor-prompts/tests/repo-instructions.test.ts -->

This record's entire implementing change is a call into this function
from a second site. The obligation exists so a reader can verify that the
callee is a real exported symbol with a passing roundtrip, rather than
taking the Context's word for it — the exact failure mode this record was
written to correct.

### O2 — A live agent's prompt carries its repository's instructions

<!-- unverifiable: requires the native-agent-executor change this record authorizes; no test asserts the composed prompt on the native path until the implementing commit lands -->

After the implementing change, a `composeNativeRole` call on the native
path with a worktree root containing an `AGENTS.md` produces a
`NativeRoleComposition` whose prompt includes that content. This is the
record's central claim and cannot be discharged before the change exists.

### O3 — The native path accepts `repo_instructions` without a contract change

<!-- unverifiable: is a property of the current type hierarchy, checkable by reading packages/arbor-mcp/src/native-role-composer.ts:27; not citable as a resolved proof because it is an inheritance relation rather than a symbol roundtrip -->

`NativeRoleCompositionInput extends RolePromptCompositionInput`, so the
field is already in the native input contract. Stated as unverifiable
rather than proven because the claim is a type-hierarchy relation, which
the proof resolver does not model.
