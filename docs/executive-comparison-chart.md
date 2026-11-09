# Executive comparison reference

> Historical reference, August 2026. This page preserves an earlier
> revoy2-only synthesis. It is not a release checklist, feature promise, or
> substitute for the current operator documentation.

Revoy is a governed execution harness for work that benefits from deliberate
exploration, independent review, and durable evidence. Its distinguishing
design is not a claim to replace every frontier harness. It is a control plane
that can apply provenance, authority separation, isolation, recovery, and
explicit adoption to autonomous work.

## Current references

- [Harness parity matrix](harness-parity-matrix.md) provides the maintained
  cross-harness capability comparison.
- [Architecture](architecture.md) describes the runtime and package
  boundaries.
- [Operator guide](operator-guide.md) explains normal operation and recovery.
- [MCP guide](mcp-guide.md) covers tool-server integration.

## What the earlier comparison established

The original analysis identified durable strengths in the governance layer:

- Provenance is represented in shared types and carried through evidence.
- Proposal and approval are separated by role and capability.
- Gates, isolation, recovery, and result adoption produce inspectable records.
- The CLI, WebUI, TUI, and MCP server share a canonical runtime catalog.

It also identified areas where a frontier harness may offer broader or more
mature experience. Those differences belong in the maintained parity matrix,
where they can be evaluated against the current implementation rather than an
archived planning snapshot.

## Reading this repository

Technical research, ADRs, roadmaps, and postmortems are intentionally retained
for engineering transparency. They document how decisions were made; they are
not customer-facing progress reports. Start with the README and operator
documentation for the current product surface.
