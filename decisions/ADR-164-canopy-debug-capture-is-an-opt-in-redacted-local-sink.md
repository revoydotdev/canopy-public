# ADR-164: canopy-debug capture is an opt-in, redacted, non-authoritative local sink

**Status:** Accepted
**Date:** 2026-09-23
**Authoring Revision:** ab9e3d79394e14ef11137461c5b3de9cc1486a33
**Content ID:** sha256:cf3eb3ca4179f436b88c18b1cb1b5db5809eb51df9acbeb9c09fdf54be01ac24

## Context

`canopy-debug` is a locally installed build of the TUI that records an operator session for later diagnosis. It stores events, screenshots and terminal recordings, in a JSONL capture index (`canopy-debug-capture.ts`) and an indexed SQLite journal (`canopy-debug-journal.ts`). It shipped in `2348ddbb` against a roadmap checklist (`docs/canopy-debug-instrumentation-manifest.md`), but no decision record governs it. Visual intelligence therefore reports its modules as implementation without intent (finding `vi:09a11e41a63c075b`), and the operator chose to record the decision rather than extend a false-positive verdict (interview 2026-09-23).

ADR-021 governs the DevTools inspector, which is also a derived, non-authoritative debug surface, but its obligations are specific to the `devtools_*` tools and `DevToolsTraceLogger`, and its rotation claim does not hold here. Session capture handles operator input, API payloads and screen contents, so it carries privacy risk the DevTools log does not.

## Decision

1. **Opt-in only.** Capture runs only when the dedicated launcher sets `CANOPY_DEBUG_ENABLED=1` (`isCanopyDebugEnabled`). An ordinary `arbor tui` session creates no capture store.
2. **Redact before persistence.** Every event payload passes through structural key-based redaction plus a credential-value matcher before it reaches either sink. Exports read only the redacted rows.
3. **A local sink, never authority.** Capture writes append-only rows under a persistence root outside the checkout (`defaultCanopyDebugPersistenceDir`). No runtime, ledger or projection state is restored from it. The journal's own recovery only closes an abandoned prior capture session.
4. **The two stores share one event envelope** (`CanopyDebugCaptureRecord`), so the JSONL index and the SQLite journal export the same NDJSON without translation.

## Consequences

- Operators can reconstruct a failing interactive session without granting the capture any say over runtime state.
- Redaction is best-effort pattern matching. An unrecognized secret shape in a free-text field can still be stored, which is why capture is opt-in and local.
- Retention, rotation and deletion are **not** decided here. The manifest records retention configuration as open, and encoded video export is also still open. A later decision must settle bounded retention before capture could be enabled by default.

## Alternatives / Roads not taken

- **Cite canopy-debug under ADR-021 O2.** Rejected: O2 asserts bounded rotation, which canopy-debug does not implement. A proof there would witness a false claim.
- **Record `false_positive` for the canopy-debug files.** Rejected by the operator: the modules capture sensitive session data and deserve a governing decision.
- **Write capture into the audit ledger.** Rejected: that would make a lossy, operator-local debugging aid part of the authoritative record.

## Obligations

### O1 — Capture is disabled unless the dedicated launcher opts in

`isCanopyDebugEnabled` returns true only for `CANOPY_DEBUG_ENABLED=1`, and the TUI creates the capture store only behind it.

<!-- proof: symbol=isCanopyDebugEnabled file=packages/arbor-mcp/src/canopy-debug-launch.ts roundtrip=packages/arbor-mcp/tests/canopy-debug-journal.test.ts -->

### O2 — Captured payloads are redacted before they are persisted or exported

The journal's NDJSON export never contains a credential value supplied in an event payload.

<!-- proof: symbol=createCanopyDebugJournal file=packages/arbor-mcp/src/canopy-debug-journal.ts roundtrip=packages/arbor-mcp/tests/canopy-debug-journal.test.ts -->

### O3 — Capture is an append-only local sink indexed beside its artifacts

Each capture row is self-contained and timestamped, and it names its artifact's relative path, so the index survives a crash without transaction replay.

<!-- proof: symbol=createCanopyDebugCaptureStore file=packages/arbor-mcp/src/canopy-debug-capture.ts roundtrip=packages/arbor-mcp/tests/canopy-debug-capture.test.ts -->
