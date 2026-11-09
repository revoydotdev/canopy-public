# ADR-105: A Tool's Contract Is What Its Caller May Assume, Not What Its Name Suggests

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 5afc268fd12b3731abf2ba5b1ca52a3c941f8153
**Content ID:** sha256:c22106a215540bd230f6a34a987d6d64378f247177ee75b3fd284a9c6ebc40da

## Context

The 2026-08-26 parity audit graded `packages/arbor-mcp/src/native-tool-host.ts` against Claude Code's and Codex CLI's tool surfaces and found repository-search the highest-impact functional gap. `NativeRepositoryToolHost.search` (`native-tool-host.ts:256-291`) walks the sandboxed root and, per line, does `line.includes(query)` — a plain substring test. No regex, no case-insensitivity, no context lines; `SEARCH_MATCH_LIMIT`/`SEARCH_FILE_LIMIT` cap the walk but don't change what counts as a match. The tool is named `repository.search` as though it were a real search tool, but a model asking for `foo\d+` or `FOO` gets zero matches or wrong ones, silently — the tool has no way to say "unsupported."

`shell.execute`/`verification.run` (`command()`, lines 432-449) is confirmed synchronous-buffered only: it awaits `this.sandbox.run(...)`, collects stdout/stderr into one buffer, returns after exit or `timeout_ms`. `grep -n "background"` across `native-tool-host.ts` and `cli.ts` returns nothing — a long-running command has nowhere to run but inside its own request timeout, with no way to poll still-running output.

There is no todo-tracking tool (no `TodoWrite` equivalent in either file) and no notebook tool (`grep -rln ipynb packages/arbor-mcp/src` returns zero hits). Both are real Claude Code capabilities this host lacks.

Two things are worth preserving, not replacing. `write()` (lines 400-410) requires `expected_sha256` on any update and refuses with `stale_write` when the live file's hash mismatches — optimistic concurrency with no equivalent in Claude Code's `Edit`/`Write`. `patch()` (lines 412-430) refuses when `expected` text is absent (`patch_precondition_missing`) or matches more than once (`patch_precondition_ambiguous`) before writing — an ambiguity refusal Claude Code's replace tool doesn't carry as a first-class outcome.

## Decision

**1. `repository.search` becomes an owned in-process regex engine, not a shell-out to `ripgrep`.** The walk stays (sandboxed traversal, `SEARCH_FILE_BYTES`/`SEARCH_FILE_LIMIT`/`SEARCH_MATCH_LIMIT`, `sensitive()` redaction); the match test changes from `.includes()` to a bounded `RegExp`: `query` stays literal-by-default, an explicit `regex: true` switches to pattern compilation, `case_sensitive` (default `true`) controls flags. Two lines of context (`context_lines`, capped at 5) come from the already-read `text.split(/\r?\n/)` array — no second read. Compilation errors surface as `semantic`/`search_pattern_invalid`, not a raw exception; a bounded pattern-length guard and per-file `signal.aborted` checks bound the cost of an adversarial pattern.

**2. `shell.execute` gains a `background: boolean` mode backed by a bounded in-process job table, not a new sandbox primitive.** The synchronous path stays default. With `background: true`, the process spawns through the existing `SandboxBroker.run` and the call returns immediately with a `job_id`; new `shell.poll`/`shell.stop` tools read ring-buffered output (capped at `commandOutputBytes`) and send the sandbox's cancellation signal. The job table is bounded and every job is force-terminated at session end, the same as synchronous `AbortSignal` teardown today — no background process outlives its session.

**3. A `todo.write`/`todo.read` port is added, modeled on `skill.load`/`skill.list`'s shipped two-tool pattern (lines 1082-1108, ADR-087).** State is a bounded, ordered `{id, text, status}` list, session-scoped, in-process, no new persistence layer. This is model scratch state, not a governance artifact — it carries no obligation, waiver, or gate semantics.

**4. Notebook editing is explicitly deferred.** `file.read`/`file.write`/`file.patch` already handle `.ipynb` as opaque JSON, correct but forcing character-by-character hand-edits. A cell-addressed `notebook.edit` port is real work with its own validation surface and is out of scope here; this decision only commits to not treating "notebooks are just JSON" as sufficient going forward.

## Consequences

`repository.search` becomes usable for the queries a model actually issues — case-insensitive substrings, simple patterns — without a subprocess dependency. The cost is a larger, more carefully audited path in a security-sensitive host: regex compilation from model input is new attack surface (catastrophic backtracking) the length guard and abort checks only partially close. Background execution unblocks long-running workflows but adds real state — a job table, a ring buffer, forced-cleanup logic — a bug in which is a new class of resource leak this host didn't previously risk. `todo.write`/`todo.read` stays deliberately small and untouched by `@arbor/governance` — conflating a scratch list with a governed obligation was a temptation this decision declines. This ADR does not change `write`'s staleness check, `patch`'s ambiguity refusal, or `search()`'s confinement model — those are cited as the bar the new tools must clear, not as work items.

## Alternatives / Roads not taken

**Shell out to `ripgrep`.** `rg` is installed here (`/usr/bin/rg`, 15.2.0) and would outperform an owned engine. Rejected for this repository specifically: `arbor-mcp/package.json`'s dependencies are `@arbor/*` workspace packages plus `typescript` — no external runtime dependency at all — and `rg` isn't guaranteed on every deployment target. Shelling out would also require an allowlist entry (`this.commands`, line 115) and re-reasoning sandbox confinement per platform, duplicating the walk's own sandboxing in a second, less-controlled place.

**Give the model raw `child_process` background spawn instead of a job table.** Rejected: this host's own header states "command execution never uses a shell" and requests are structured at every boundary. An unbounded spawn primitive with no table, buffer, or cleanup contract is exactly the ungoverned process lifecycle this host exists to avoid.

## Obligations

### O1 — `write`'s optimistic-concurrency staleness check is real today and is the bar the new tools are held to

`write()` refuses `stale_write` whenever `expected_sha256` mismatches the live file's hash, and requires it on any non-`create` update. This is the concrete precedent for treating background-job and regex-search failures as hard refusals, not silent degradation.

<!-- proof: symbol=createNativeRepositoryToolHost file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-tool-host.test.ts -->

### O2 — `repository.search` gains regex, case-insensitivity, and context lines without adding an external process dependency

The rewritten `search()` (`native-tool-host.ts`, `NativeRepositoryToolHost.search`/`compileSearchMatcher`) compiles a bounded `RegExp` only when `regex: true` is requested, defaults to today's literal substring behavior, and captures `context_before`/`context_after` (capped at `SEARCH_MAX_CONTEXT_LINES`, 5) from the already-read `text.split(/\r?\n/)` line array. `case_sensitive` (default `true`) controls flags on either branch. Regex compilation is bounded by `SEARCH_REGEX_MAX_LENGTH` (256 chars) and a per-file `signal.aborted` check on every line; a compile failure or oversized pattern surfaces as `search_pattern_invalid`, never a raw exception. No new sandbox allowlist entry, no subprocess — verified by `packages/arbor-mcp/tests/native-tool-host.test.ts`'s "matches a regex query, case-insensitively, and returns bounded context lines" and "refuses an invalid or oversized regex pattern" cases.

<!-- proof: symbol=createNativeRepositoryToolHost file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-tool-host.test.ts -->

### O3 — `shell.execute` background mode never outlives its owning session

A job started via `background: true` (`NativeRepositoryToolHost.startBackgroundJob`) spawns through the same `SandboxBroker.run` as the synchronous path, keyed by a bounded, session-scoped `backgroundJobs` table (capped at `MAX_BACKGROUND_JOBS`, oldest-terminal-evicted). The job's controller is aborted, and its table entry deleted synchronously, the moment the owning call's `AbortSignal` fires — the same forwarding path in-flight synchronous cancellation already uses — so `shell.poll`/`shell.stop` refuse `background_job_not_found` for a job whose session has closed, never stale output. `shell.stop` sends the same cancellation signal for a still-running job. Verified by `native-tool-host.test.ts`'s "shell.execute background mode returns a job_id immediately and shell.poll observes it settle", "shell.stop terminates a running background job", and "a background job is force-terminated when its owning session's signal aborts, and its table entry is removed with it".

<!-- proof: symbol=createNativeRepositoryToolHost file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-tool-host.test.ts -->

### O4 — `todo.write`/`todo.read` carries no governance semantics of its own

The session-scoped todo list (`NativeRepositoryToolHost.todoItems`/`todoWrite`/`todoRead`) is not wired into `@arbor/governance`'s obligation, waiver, or gate machinery — model scratch state only, mirroring `skill.list`'s read-only, non-governance nature. Both tools are classified risk `"low"` in `NATIVE_REPOSITORY_TOOL_RISKS`, so `resolve_high_risk_scope` (the one governance-adjacent seam a repository tool can reach) is never consulted for either, and their audit evidence always carries `action_scope: { status: "not_required" }`. Verified by `native-tool-host.test.ts`'s "todo.write replaces the bounded ordered list, todo.read observes it, and neither consults high-risk governance scope", which asserts the injected `resolve_high_risk_scope` is called zero times across a todo.write/todo.read round trip and every resulting audit record carries `action_scope.status === "not_required"`.

<!-- proof: symbol=createNativeRepositoryToolHost file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-tool-host.test.ts -->
