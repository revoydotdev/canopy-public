# Positive fixture: a native repository-session lifecycle the gate must ACCEPT

The sibling fixture next door, `undocumented-repo-session-dispatch`, is a NEGATIVE
canary: it exists so `gate:repo-session-conformance` is proved able to fail. This
one is the INVERSE, and it is the only evidence that the refactor changed the gate
rather than merely deleting checks from it.

**What it is.** A minimal repository root whose repository-session lifecycle is
implemented natively: a `cli.ts` that dispatches the five verbs, a
`repo-session-close.ts` that calls a source-owned module in-process, that module's
own `--finish`-equivalent step list, and the session_end hook handler. There is no
`scripts/session-close.mjs`, no `scripts/hooks/*.sh` bridge, no `spawnSync`, and no
flag map anywhere in the tree.

**Why it exists.** Before the refactor this fixture was RED: the gate mandated a
spawnSync shim resolving `scripts/session-close.mjs`, an exact
begin/status/open/close/abort flag map, and `.sh` bridges whose text matched
`/bun scripts\/session-close\.mjs/`. Every one of those pins described the shape of
the implementation, not the contract, so a conforming native implementation could
not pass. The refactor splits the gate into INVARIANTS (five verbs reachable; the
end path never closes the record; campaign `session_end` stays observe-only; the
close orders rebind → stop tier → full tier; at most one lifecycle adapter per host
event) and SHAPE (dropped). This fixture satisfies every invariant and none of the
shape, so it goes green only because the gate now asks the right question.

**Run against it:**

```bash
bun scripts/repo-session-conformance-gate.mjs --root scripts/canaries/repo-session-conformance/native-repo-session-accepted
```

`--root` relocates INPUT only; every pattern is unchanged, so the result is the
same code path the real checkout runs. `scripts/tests/repo-session-conformance.test.mjs`
drives this and asserts exit 0.

**The trap this fixture has to avoid** is the one its sibling already fell into: the
gate greps these files' TEXT, so a fixture comment that happens to contain the
spawnSync call, the flag map, or the bridge path would satisfy the very assertions
the fixture exists to make fail. These files therefore mention none of them, and the
`host-controls.mjs` stub exits 0 so the gate's first action is not a missing-file
problem.