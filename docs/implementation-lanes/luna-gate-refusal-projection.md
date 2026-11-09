# Luna lane: shared gate refusal projection

Branch: `luna/gate-refusal-projection`

## Milestones

- Inventory: complete. Existing gate ownership remains in `@arbor/core`'s
  `GateRecord` and manager/gate authorities. Existing CLI, TUI, and web code
  consumed unrelated refusal/remediation shapes, so the new seam belongs in
  `@arbor/mcp`'s projection layer.
- Contract: complete. `gate-refusal-projection.ts` defines a versioned,
  bounded, redacted projection with `gate`, `code`, `summary`,
  `evidence_deficit`, and `remediation`. `refused` is distinct from
  `unavailable`; a passing gate produces no refusal value.
- Implementation: complete. `projectGateRecord`, `projectGateRefusal`, and
  `projectGateUnavailable` are exported through the MCP package. The
  `gate.refusal` freshness class is registered with an immediate expiry and
  `projectGateRefusalLifecycle` preserves ready-empty, refusal, and unavailable
  states through the existing lifecycle reducer.
- Tests: complete. Five focused tests cover fail/bypass adaptation, passing
  gates, truthful unavailable state, lifecycle transitions, immediate expiry,
  freezing, validation, and bounded text.
- Diff audit: complete. Changes are limited to `packages/arbor-mcp` and this
  report; no core, harness, TUI package, or runtime authority code was edited.

## Validation

```text
./node_modules/.bin/vitest run packages/arbor-mcp/tests/gate-refusal-projection.test.ts
Test Files  1 passed (1)
Tests       5 passed (5)

bun run build:dist
$ tsc --build
(exit 0)
```

`bun run --cwd packages/arbor-mcp build` was attempted during discovery but
the package has no `build` script; the root `build:dist` check is the valid
repository TypeScript build command.

## Review notes and risks

The projection is an adapter over recorded gate facts. It does not run gates,
persist a new authority, or infer an unavailable source as a refusal. The
`remediation` string remains caller-supplied so each owning authority can give
specific corrective action; a future catalog producer should be required to
provide one rather than defaulting to a generic “retry.”

The branch intentionally does not wire a new runtime query: campaign snapshots
and existing source queries remain the authorities. CLI/TUI/web consumers can
now import one bounded contract and wrap it in the registered lifecycle class;
wiring each screen can land independently without duplicating the semantics.
