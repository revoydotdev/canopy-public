# ADR-190: The session journal persists a typed, redacted provider failure reason

**Status:** Accepted
**Date:** 2026-10-07
**Authoring Revision:** abb0abc0fa37b744f8140bfc3803572a94657299
**Content ID:** sha256:444760cd391264b8eddca2a66fa4668684ac7988c4f658de3e0ebcad4166a083

## Context

`HarnessSessionJournal` (`packages/arbor-mcp/src/harness-session-journal.ts`)
is the durable, redacted record of a native session. Its event redactor kept
only the stable `code` of a `diagnostic` event and only `state`/`cause` of the
terminal event, because diagnostic and terminal messages can carry adapter or
provider text. Bounded retry facts (`attempt`, `max_attempts`, `delay_ms`,
`failure_kind`) were already allowlisted for `model_retry`.

The consequence (remediation manifest `audit/2026-09-06-remediation`, items
A02 and A06): a session that failed on a provider error showed its reason
while the process lived, through the worker's in-memory inspection, and lost
it after a restart. The terminal read `failed`/`failed`; the HTTP status, the
provider's typed error code and the adapter class were gone, and no surface
assembled the retry chronology with the reason that ended it. The manifest
also records the constraint: raw error text must not be restored as a
shortcut.

The provider adapters already reduce an error body to typed fields
(the module-private bounded provider-error-detail helper in `packages/arbor-harness/src/openai-compatible.ts` and
`anthropic-messages.ts`), and the worker's `describeModelError` formats a
terminal model-port failure as `model port failed: <Class> (<kind>): <detail>`
after its own redaction and a 256-character bound.

## Decision

1. For the worker's terminal model-port failure codes only (`model_failure`,
   `model_retry_exhausted`), the journal's event redactor parses that message
   into a closed `provider_failure` record: `error_class` (identifier
   grammar), `failure_kind` (the same closed enum retry facts use),
   `http_status` (100..599 or null), `provider_code` (the provider's typed
   error type/code atom, or null) and `message`. Any message not in that
   shape yields no record; it is not guessed.
2. `message` crosses a second, independent boundary in the journal: it is cut
   at the first `{`, `}`, `<` or `>` so a forwarded raw body cannot persist,
   passed through `redactNativeText`, scrubbed of credential shapes the
   generic redactor does not name (`sk-`/`pk-`/`rk-` keys, AWS access key
   ids, GitHub and Slack tokens, JWTs, and any opaque run of 32 or more
   key-alphabet characters), stripped of control characters and bounded to
   256 characters.
3. Replay validates the record with a closed key set and the same grammars; a
   journal line that carries anything else is refused as `invalid_entry`.
4. `deriveHarnessSessionFailure` derives, only from redacted canonical events
   and only for a `failed` terminal, the ordered `model_retry` attempts and the
   canonical reason (the last non-retry diagnostic before the terminal). The
   durable journal and `LiveNativeSessionRegistry` both call it, so
   `harness.session.inspect`/`.attach` expose the same `failure` field before
   and after a restart. A `started` row cannot carry one.
5. `buildRunReport` adds an additive `session_failures` section read from the
   same session projection, and the TUI Console renders a diagnostic's
   `provider_failure` as its detail line.

## Consequences

- An operator can see, after a restart, which provider failed a session,
  with which HTTP status and typed code, after which bounded retries.
- The journal now retains a bounded, redacted fragment of provider prose. The
  credential-shape scrub is pattern-based: a secret that matches none of its
  shapes and is shorter than 32 characters would survive both redactors.
  `scoped-native-credential-broker.ts` redacts the configured credential by
  value upstream; this boundary does not know that value.
- The parser is coupled to `describeModelError`'s format. A format change
  produces no record (fail closed) rather than a wrong one.
- Unchanged and outside this decision: the worker's own node failure message,
  which reaches the campaign snapshot, ledger and KB failure-mode fact, is
  redacted only by the worker's redactor. The restart test observed an `sk-`
  shaped key surviving there.

## Alternatives / Roads not taken

- **Persist the raw diagnostic message.** Rejected by the manifest's A06 row
  and by this journal's purpose.
- **Emit a structured provider error from the native worker.** Cleaner, since
  the worker holds the error object, but it changes `@arbor/harness`'s event
  contract and every adapter; the journal still needs its own boundary, so
  this can follow without changing the persisted shape.
- **Persist only `http_status` and `provider_code`.** Smaller, but loses the
  provider's typed explanation that distinguishes, for example, quota from
  billing failures under one status.

## Obligations

### O1 — A failed session's retry chronology and canonical reason are identical before and after a real process death

A campaign run in a separate process fails through the production runtime on a provider error, is SIGKILLed, and a fresh runtime reproduces the same ordered events, `failure` chronology and run-report `session_failures` through `harness.session.attach`/`.inspect`, and the Console renders them in order.

<!-- proof: symbol=deriveHarnessSessionFailure file=packages/arbor-mcp/src/harness-session-journal.ts roundtrip=packages/arbor-mcp/tests/recovery/provider-failure-restart.test.ts -->

### O2 — The persisted provider reason is typed, bounded and carries no planted credential or raw body

Planted credentials and raw body fields in a provider error never reach a journal byte or evidence manifest, and a forged journal line carrying a body or an extra field is refused on replay.

<!-- proof: symbol=redactHarnessSessionEvent file=packages/arbor-mcp/src/harness-session-journal.ts roundtrip=packages/arbor-mcp/tests/provider-failure-redaction.test.ts -->
