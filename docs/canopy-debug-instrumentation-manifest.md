# canopy-debug instrumentation deliverables

Artifact kind: roadmap
Status: active
Revision: 1
As-of commit: c479750fd06fe2b1cef34c1a3d75afe3c2218c45
Authority: records the implementation and acceptance requirements for the opt-in local canopy-debug launcher.
Evidence scope: mixed — implementation targets and the linked dated verification report.
Supersedes: none
Superseded by: none
Owner: Canopy/revoy2 maintainers
Review trigger: any change to canopy-debug capture, privacy controls, or acceptance evidence.

This manifest is the durable checklist for the locally installed, current-source
`canopy-debug` TUI build. Every implementation and verification pass must read it.

## Phase 0 — baseline and build

- [x] Identify the canonical TUI entrypoint and install a local `canopy-debug`
      launcher from the current repository build.
- [x] Record source revision, build command, runtime version, and install path.
- [ ] Verify `bun run build`, test lanes, and a real interactive launch.

## Phase 1 — durable event journal

- [x] Timestamp every record with wall-clock and monotonic time plus session id.
- [x] Persist newline-delimited, machine-readable events in an optimized local DB
      (SQLite preferred), with indexed session/time/kind/correlation fields.
- [ ] Capture operator text input, key actions, stdout/stderr/console output,
      errors, lifecycle, function spans, token usage, API requests/responses,
      MCP discovery/calls, and skill loading. Secrets must be redacted.
- [x] Flush safely while the TUI is open and close/recover transactions cleanly.
- [ ] Provide agent-friendly query/export tooling and retention configuration. Query/export exists; retention configuration remains open.

## Phase 2 — visual evidence

- [x] Bind exclusive screenshot and recording start/stop hotkeys.
- [ ] Store PNG/video artifacts durably beside the journal using session/time
      paths; index each artifact, hash, MIME type, dimensions, and timestamps.
      PNG screenshots and asciicast v2 terminal recordings are implemented;
      encoded video export is still open.
- [x] Verify screenshots and recordings can be triggered during a live session.

## Phase 3 — verification and operations

- [x] Add unit/integration tests for event schema, redaction, crash recovery,
      hotkeys, artifact indexing, and query/export.
- [ ] Run build, test, OpenTUI proof, and a real smoke session; retain evidence.
- [ ] Document privacy controls, disable/delete/export operations, and known
      telemetry blind spots. Do not claim reasoning capture when the provider
      does not expose it; record availability explicitly.

## Acceptance evidence

Completion requires current-source build/install evidence, a database containing
input/output/API/MCP/skill/artifact records from one live session, indexed visual
artifacts, passing tests, and a verification report mapping each checklist item
to files and commands. The current Terra report is
[`docs/canopy-debug-verification-report.md`](./canopy-debug-verification-report.md);
it records observed status and does not silently promote conditional or missing
evidence. This checklist is intentionally not satisfied by static code
inspection alone.

The reproducible live smoke is:

```bash
bun run canopy-debug:smoke
```

It invokes the installed `~/.local/bin/canopy-debug` launcher, drives F8/F9,
and writes `.arbor/canopy-debug-smoke/<timestamp>/evidence.json` beside the
SQLite journal and visual artifacts. Pass `--root <repo-relative-path>` when a
separate evidence root is needed. The JSON report includes lifecycle status,
event counts, indexed artifact metadata, and the exact journal path for agent
ingestion. A `forced_after_graceful_timeout` termination label means the TUI
already persisted `session_close` and restored the terminal, but a background
projection handle required bounded process reaping.
