# Canary: gate:hook-devolution — a devolved row with no descriptor is the 2026-09-30 incident

Run as `bun run gate:hook-devolution --repo {repo}`.

## What is under test, stated precisely

The invariant is "all gates proven effective must be proven to be fully
transitioned to native source level before they are deprecated". The single
mechanical way that sentence fails is a ledger row claiming `devolved` for a
hook whose native replacement is **registered but never activated** — the
handler is a key in `HOOK_HANDLERS`, and no descriptor in `DEFAULT_HOOK_SET`
names it, so `HookBus.wrapToolPort` takes its `vetoHooks.length === 0`
short-circuit and returns the port unwrapped.

That is not a hypothetical. Four host hooks were deleted and replaced with
exactly that shape, and three independent checks reported green: `arbor hook
validate` (zero descriptors, exit 0), `gate:hook-liveness` (deleting a hook
removes it from the manifest it walks), and `wrapToolPort` itself (a veto that
never wraps looks like a veto that approved).

This fixture drives the ledger side of that failure and nothing else:

- one live registration, whose script EXISTS (so check (a) is not what fires),
- one ledger row marked `devolved`, with a `handler_ref` that IS in the closed
  registry and a `seam` that IS a public `HookBus` method — both halves true,
  so checks (b) and (d) are satisfied,
- and a `descriptor` that is NOT in `DEFAULT_HOOK_SET`, which is the only thing
  left to be wrong.

## What this canary proves, and what it does not

Proves: `gate:hook-devolution` can return non-zero, and the specific reason it
returns non-zero is the unactivated-descriptor claim rather than some
unrelated malformation. The census distinguishes a gate that answered from a
gate with no failure mode at all, and this is the run that shows the failure
mode exists where the incident happened.

Does NOT prove activation works. No canary can: the gate reads source and the
local `.arbor/hooks`, and whether a *shipped* descriptor fires at runtime is
`HookBus`'s own `neverFired()` evidence, not this file's to certify. Nor does
it prove the twelve currently-`pending_activation` rows in the real ledger are
honest — the real-tree test in `scripts/tests/hook-devolution-gate.test.mjs`
covers that, by running the gate over the real checkout.

## The stubs

`packages/arbor-mcp/src/hooks/{handlers,catalog,bus,contracts}.ts` here are
minimal stubs carrying only the shapes the gate parses — the `HOOK_HANDLERS`
literal, the `DEFAULT_HOOK_SET` array, `class HookBus`'s method list, and the
`HOOK_*_EVENTS` sets the bus's event parameters are typed with. They are stubs
so the fixture cannot pass or fail for a reason that has moved in source. The
registry and the hook set deliberately disagree: `veto.git-write-guard`
is registered, and `DEFAULT_HOOK_SET` ships a descriptor with a DIFFERENT
`hook_id`. That disagreement is the whole fixture.

## What the gate checks that the fixture does NOT exercise

The gate also links the three halves of a devolved claim — that the descriptor
binds the row's `handler_ref`, and that the row's seam dispatches the
descriptor's event. A descriptor that is absent from `DEFAULT_HOOK_SET` cannot
be linked to anything, so this fixture cannot reach either check; the cases for
them are in `scripts/tests/hook-devolution-gate.test.mjs`, which drives the same
gate as a subprocess.
