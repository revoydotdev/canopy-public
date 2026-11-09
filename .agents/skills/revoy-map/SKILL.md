---
name: revoy-map
description: Create validated, self-contained interactive architecture, workflow, sequence, data-flow, lifecycle, and architecture-delta maps. Use for repository/system diagrams, operational flows, lineage, state machines, deployment reviews, or verified presentation/export artifacts. Do not use for freeform illustration or claims unsupported by authored evidence.
license: Proprietary - Revoy internal use
metadata:
  version: "0.2.0"
---

# Revoy Map

Produce a factual typed-IR candidate, validate it deterministically, and atomically deliver one self-contained HTML artifact with inline SVG and viewer runtime.

## Authoring workflow

1. Select `architecture`, `workflow`, `sequence`, `dataflow`, or `lifecycle` based on the question.
2. Establish facts from the named repository or user description. Label inference and never represent an unavailable observed plane as zero findings.
3. Read [references/ir.md](references/ir.md), then author a schema-v1 JSON candidate with stable IDs, one clear path, sparse labels, and normally 8-12 primary nodes.
4. Validate after focused edits:

   ```bash
   bun run map -- validate <type> <candidate.json> --quality showcase --json
   ```

5. Deliver once the receipt passes:

   ```bash
   bun run map -- deliver <type> <candidate.json> <output.html> --quality showcase --json
   bun run map -- visual-check <output.html> --json
   ```

Return the source and HTML paths, receipt hashes, validation summary, capture paths, and truthful human-review status. Non-zero commands are failures.

## Repository maps

For Revoy2, prefer the committed `.visual-intelligence/graph` when its manifest is current. Distinguish source topology, intended governance, and runtime observation. Do not invent ownership, security boundaries, deployment regions, reachability, or runtime impact.

## Interaction and export contract

Artifacts provide theme and style switching, search/focus, upstream/downstream authored reach, directed route tracing, semantic-role lenses, guided views, overview, presentation, pan/zoom, stable hash links, finite motion, share cards, and SVG/PNG/JPEG/WebP/WebM exports. Reader state must not alter canonical exports.

## Brand marks

Do not bundle or infer third-party marks. Only capture a user-authorized official direct image URL. `brands capture` records the exact bytes by digest in the ignored local `.revoy/` store; authored IR pins the returned URL and SHA-256. Rendering fails closed when cached bytes are absent or changed.

## Invariants

- Escape authored content and reject unknown top-level fields, duplicate IDs, dangling endpoints, unsafe outputs, non-finite geometry, and invalid guided views.
- `deployment-ownership` is opt-in and fail-closed: require owners, regions, security groups, protected databases, and labeled boundary crossings.
- Keep stable semantic IDs across revisions so comparison reports exact added, removed, changed, moved, and rerouted facts.
- Do not bundle external source, tests, templates, examples, wording, or visual identity. The implementation and its fixtures are independently authored.

Use `guide`, `doctor`, `examples`, `inspect`, `check`, `compare`, `preview`, `brands`, or `demo` only when relevant. Preview is explicit, loopback-only, and retains the last valid artifact.
