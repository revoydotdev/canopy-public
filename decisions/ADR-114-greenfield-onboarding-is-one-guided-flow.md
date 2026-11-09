# ADR-114: Greenfield Work Is One Guided Operator Flow, Not A Sequence Of Refusals

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 2d639ca6cce7d17e0862ffaf9535b0ee577a265c
**Content ID:** sha256:9450eb61aade9a2df7c9ad9007636c01ac5e4fdebed98d3b3c83631ff52fbfb2

## Context

On 2026-08-26 the operator drove the native harness (openrouter,
`deepseek/deepseek-v4-pro`, `native.mode: "native"`) against a fresh
greenfield repo at `<local-greenfield-repository>` with the trivial
task "create a file hello.txt containing exactly the word hello." Four
refusals surfaced, each correct alone, each visible only after the
previous was fixed:

1. **Forbidden branch.** Against the harness's own checkout on `master`,
   `checkTargetIsolationSafety` (`target-isolation-guard.ts`) refused with
   `forbidden_branch`, naming `--allow-primary-checkout` as the escape.
2. **Isolation gate.** Pointed at `.demo-astro` instead, `worktree.ts`'s
   acquire path refused over uncommitted product changes absent from HEAD.
3. **Argument order.** `arbor task --tier direct "text"` printed "Unknown
   task option: --tier" because `taskComposerCommand` (`cli.ts`) rejects a
   leading `args[0]` starting with `-` before `--tier` is ever located by
   `args.indexOf`. `--tier` genuinely is parsed, just after the task text,
   exactly as `arbor task --help` documents — order sensitivity with a
   misleading message, not undocumented drift.
4. **Terminal scope refusal — decisive.** With the first three fixed, the
   campaign tree
   (.arbor/tree/composer-draft-82dd6fd8-37bf-42cd-9f5a-1ec87e10223a.json — a
   single investigation run's ephemeral draft state, never checked in)
   shows node `node_mtag1j5n_1`'s planner-declared
   `high_risk_tool_scope: { write_paths: ["hello.txt"], command_argv: [] }`
   — a file write authorized, no command. The specialist tried
   `shell.execute`; `native-tool-host.ts:274`'s `highRiskScopeFailure`
   refused: "command argv exceeds the system-owned action scope." The node
   recorded `outcome.error.recoverable: false`; `halted: true` /
   `halt_reason: "no_nodes"` followed after one iteration. (No
   `terminal_outcome` field exists on the tree; those are the actual facts.)

Refusal 4 exposes two defects. **A: a scope refusal takes the terminal
path, not a recoverable one.** `NativeHarnessWorker.executeTool`
(`native-worker.ts`) already has a recoverable path for a tool-shaped
mismatch: `recordUncomposedToolCall` deliberately never calls
`this.failed()` when a model names an uncomposed tool, so the model sees a
typed refusal and the turn continues. The admission branch a few hundred
lines earlier calls `this.failed()` unconditionally instead
(`native-worker.ts:844-847`: `if (admission !== undefined &&
!admission.allowed) { ...; this.failed(sessionId, turn, admission.code,
...); return true; }`), and `admission` for a high-risk tool resolves
through `highRiskScopeFailure`. Nobody documented this asymmetry as
intentional; it is the path built for "wrong tool name," never extended to
"right tool, authority not held for this argv."

**B: exact-argv pre-authorization cannot survive greenfield scaffolding.**
`sameArgv` (`native-tool-host.ts:1684`) demands an exact match. ADR-088
built this deliberately — Decision §3 leaves `highRiskScopeFailure`
"untouched," rejecting isolation-first audit-at-adoption to keep real-time
per-call enforcement. That holds for "write hello.txt" (the investigation's
own scratch example, never checked in). It cannot hold
for `npm create astro@latest site -- --template minimal`, whose exact argv
is unknowable before the scaffolder runs. ADR-088's mining fallback only
narrows an argv already present in an action's own text.

## Decision

**1. `arbor greenfield <intent>` runs every preflight blocker once and
reports them together, then dispatches.** A new subcommand beside
`TASK_SUBCOMMANDS` in `cli.ts` (rationale for not making it a `task` flag:
see Alternatives). It calls `checkTargetIsolationSafety`, `worktree.ts`'s
dirty-tree probe (ahead of a real acquire, so it's reportable up front),
and tier resolution (defaulting `direct`, matching what the operator
hand-supplied every run) — collecting every blocker before dispatch,
extending `checkIsolation`'s per-gate "report everything" property across
the whole sequence.

**2. `action_scope_command_denied`/`action_scope_path_denied` become
recoverable, narrowly, for greenfield-tagged sessions only.**
`executeTool`'s admission branch (`native-worker.ts:844-847`) splits by
code: `tool_denied`, `approval_unavailable`, `approval_denied`, and
intent/context failures keep calling `this.failed()` unchanged, since those
are answers no retry changes. The two `action_scope_*` codes follow
`recordUncomposedToolCall`'s shape instead — push a `tool_result` naming
the scope the specialist DOES hold, let the turn continue — scoped to
greenfield sessions because on an established repo the planner had every
fact needed to declare the right argv, so retrying there just burns turns
against a wrong plan, not an underspecified one.

**3. Argv authority is negotiated once via a scaffold-command action, not a
global pattern grammar.** The composer gains one narrow field,
`high_risk_tool_scope.scaffold_command` — an operator-approved argv PREFIX
(e.g. `["npm", "create", "astro@latest"]`), distinct from `command_argv`'s
exact-match set. `highRiskScopeFailure` checks it only for `shell.execute`
when the argv starts with that prefix; whatever the scaffolder appends is
authorized as a consequence of running the named tool, not separately
approved. Every other command call still goes through unmodified
`sameArgv` — keeping ADR-088's invariant while admitting the one case
exact match can't express.

## Consequences

A greenfield session goes from four sequential refusals to one preflight
report plus, for the one un-declarable case, one scaffold-command approval
— matching what the operator already did by hand. The costs:
`arbor greenfield` duplicates knowledge of which gates exist, giving
`checkIsolation`/`checkTargetIsolationSafety`'s failure shape two callers
to keep in sync. Splitting `executeTool`'s admission branch by code is a
real special case in code that was uniform before — a future refusal code
must consciously choose a side, and choosing wrong either widens
recoverable authority or re-introduces today's opacity. `scaffold_command`
is a second, differently-shaped authorization primitive beside
`command_argv`'s exact match, wider than an exact string by construction.
This ADR does NOT touch `sameArgv`, ADR-088's approval auto-grant, or the
`governed`-tier scope-mining exemption.

## Alternatives / Roads not taken

**Widen `sameArgv` globally to a prefix/allowlist grammar.** Rejected: a
one-line change at `native-tool-host.ts:1684`, but it loosens exact-match
authorization on every tier, including `governed` — the property ADR-088
built and left untouched. `scaffold_command` confines the widening to the
one shape that needs it.

**Make `action_scope_*` refusals recoverable unconditionally.** Rejected:
on an established repo the planner can always know the correct argv (why
ADR-088's mining apparatus exists), so making every refusal retriable turns
a pre-authorization gate into a discovery loop — isolation-first, the
design ADR-088 already rejected, through the back door.

**A full mid-session scope-negotiation turn: specialist proposes argv,
operator approves inline.** Rejected here, though it is the more general
answer — it requires mutating an already-admitted `high_risk_tool_scope`
mid-campaign, bigger than a prefix field the composer already had authority
to set at plan time. Worth a follow-on ADR if `scaffold_command` proves too
narrow beyond `npm create`/`cargo new`/`django-admin startproject`. A flag
on `task` instead of a `greenfield` subcommand was rejected for the same
reason refusal 3 happened: a flag inherits `taskComposerCommand`'s
leading-`-` hazard, a sibling subcommand sidesteps.

## Obligations

### O1 — `NativeHarnessWorker.executeTool` routes every admission-level refusal, `action_scope_*` included, through the terminal `this.failed()` path today — `recordUncomposedToolCall` proves a recoverable path is achievable

<!-- unverifiable: Decision §2 is superseded — ADR-117 already landed RECOVERABLE_PREFLIGHT_CODES (packages/arbor-harness/src/native-worker.ts:397-401) and recordRecoverableRefusal (native-worker.ts:879), making action_scope_command_denied/action_scope_path_denied/action_scope_missing_or_stale recoverable for EVERY session, not narrowed to greenfield-tagged sessions as this ADR proposed; building the narrower greenfield-only split now would be a regression, so it was not implemented. -->

### O2 — `highRiskScopeFailure`'s exact-match `sameArgv` check is real and today unconditional for every `shell.execute`/`verification.run` call — the mechanism `scaffold_command` must extend, not weaken

<!-- unverifiable: Decision §3 (scaffold_command) is superseded — ADR-119 landed {argv_prefix, purpose} intent entries that bind on first use and journal the bind as a hash-chained ScopeIntentBindRecord in the audit ledger; adding an unbound, unjournaled scaffold_command prefix path would undermine that provenance guarantee, so it was not implemented. -->

### O3 — `arbor greenfield` reports every preflight blocker (branch, isolation, tier) in one pass before any campaign starts

The four-refusal run this ADR is grounded in is the cost of the opposite
design: each blocker paid for, fixed, and re-run separately. `arbor
greenfield` (`packages/arbor-mcp/src/cli.ts`'s `greenfieldCommand`) calls
`checkGenericTargetSafety` (the generic-path wrapper around
`checkTargetIsolationSafety` that `arbor task`'s own campaign runner
already uses — refusing only the harness's-own-checkout hazard, not every
ordinary repo on master/main), a read-only reissue of `worktree.ts`'s
dirty-tree probe (`probeGreenfieldDirtyTree`, since a real
`WorktreeManager.acquireLease` call has side effects the moment its own
check passes), and tier resolution defaulting to `direct`, collecting
every failure into one report before ever dispatching.

<!-- proof: symbol=greenfieldCommand file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/greenfield-command.test.ts -->

### O4 — the greenfield-scoped recoverable path for `action_scope_command_denied`/`action_scope_path_denied` never applies outside a greenfield-tagged session, preserving ADR-088's terminal behavior for every established-repository plan

<!-- unverifiable: Decision §2 is superseded — ADR-117's RECOVERABLE_PREFLIGHT_CODES path already applies to every session, not only greenfield-tagged ones; no greenfield session tag or code-scoped executeTool branch was built, so there is nothing here to verify against. -->
