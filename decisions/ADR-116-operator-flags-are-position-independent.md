# ADR-116: An Operator Flag Works Where It Reads Naturally, And Usage Matches The Parser

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** f8312bdb933bf2aa03fe29347f56d7ea9c67f59d
**Content ID:** sha256:8b0a766ea1a883c21bec4446a4c9a73961588d29a32196dcfec545cb6fc221e0

## Context

`taskComposerCommand` (`packages/arbor-mcp/src/cli.ts:3200`) resolves `args[0]` against `TASK_SUBCOMMANDS` (`:3198`, `["list", "show", "answer", "confirm", "retry", "reject", "follow-up"]`); when it matches none of those, `subcommand` is set to `""`. The very next check (`:3218-3220`) is:

```ts
if (subcommand === "" && requested.startsWith("-")) {
  environment.stderr.write(`Unknown task option: ${requested}\n`);
  return taskUsage(environment.stderr);
}
```

So `arbor task --tier direct "text"` — where `args[0]` is `--tier`, not free-text and not a known subcommand — is refused as an "unknown" option before the parser ever looks at it. But `--tier` genuinely is a known, parsed flag: `tierFlagIndex = args.indexOf("--tier")` and the value validation against `direct`/`reviewed`/`governed` sit 24 lines later (`:3243-3248`), and the CLI accepts and strips `--tier` from anywhere in `args` once past the `:3218` gate. The refusal fires purely on `--tier` occupying `args[0]`; the same flag placed after the task text is accepted.

This compounds because the refusal path and the help path disagree about the flag's existence. `taskUsage` (`:3824-3833`), the exact function the `:3218` refusal calls, lists five usage lines and never mentions `--tier`. `printTaskHelp` (`:3585` onward), reached only via `arbor task --help`, documents it in full at `:3592`. A reader who hits the refusal and checks the usage text it printed sees no `--tier` and reasonably concludes the flag doesn't exist — the refusal both misattributes the cause (position, not existence) and points to a source of truth that corroborates the wrong conclusion.

Grepping `cli.ts` for the pattern (`startsWith("-")` gating a subcommand-or-nothing dispatch) turns up exactly one hit: line 3218. `evidence` (`:4392` onward) requires a fixed `args[0] === "refresh"` but reads every flag — `--scope`, `--json`, `--dry-run` — via `indexOf`/`includes` on the remainder, position-independently. `project` (`:2503` onward) takes `args[1]` as its subcommand, then builds `flags` from `rest.filter(item => item.startsWith("--"))` and the positional `path` from `rest.find(item => !item.startsWith("--"))` — flags and the positional argument can appear in either order. `task` is the only subcommand family here that special-cases a leading flag as an error rather than falling through to free-text/flag parsing.

Existing coverage never exercises this ordering: every call site across `cli.test.ts`, `task-composer.test.ts`, `task-wait-writer-lock.test.ts`, and `session-start-admission.test.ts` that passes `--tier` places it after the task text (e.g. `["task", "inspect the widget and report findings", "--tier", "direct", ...]`). Nothing calls `main(["task", "--tier", "direct", "text"])`, which is why this shape survived.

## Decision

**1. `task`'s leading-flag rejection is replaced with the same fall-through every other multi-flag subcommand in this file uses.** Remove the `:3218-3220` special case. A `requested` that starts with `-` and isn't `--help`/`-h` is no longer an automatic refusal; it falls through to the existing flag-stripping logic (`tierFlagIndex`, `attachmentPaths`, the `--json`/`--progress`/`--wait`/`--plan`/`--allow-primary-checkout` filters already in `taskComposerCommand`) exactly as it does when the same flags appear after the task text. An argument that is a flag-shaped token matching none of the recognized flags — the actual "unknown option" case — is caught the same way an unrecognized flag after valid text already would be: `withoutJson.join(" ")` (`:3251` onward) would otherwise dispatch it as literal task text to the planner, which is the exact "field-observed `arbor task --help`" defect `:3206-3211`'s own comment warns against for `--help`. This decision extends that same reasoning: any leading token starting with `-` that is not one of the recognized flags (`--tier`, `--json`, `--progress`, `--wait`, `--plan`, `--allow-primary-checkout`, `--attach`, `--help`/`-h`) is still rejected with `Unknown task option: ${requested}` — the refusal becomes accurate (this flag genuinely isn't recognized) rather than a false negative against a flag the parser does know.

**2. `taskUsage` and `printTaskHelp` are generated from one shared flag table, not maintained as two hand-written strings.** Add a small `TASK_FLAGS` array (name, value shape, one-line description) that both functions render from — `taskUsage` as compact `[--flag value]` tokens, `printTaskHelp` as the fuller per-flag prose it already carries. `--tier` (and any future flag) is declared once; both surfaces render it or neither does, closing the disagreement structurally rather than by remembering to update both strings by hand.

**3. A test drives both properties through the real CLI entrypoint.** One test calls `main(["task", "--tier", "direct", "inspect the widget and report findings", "--json"])` and asserts it reaches the same planner-submission path as the equivalent trailing-flag call (not `EXIT_CODES.USAGE`) — proving position independence through `main`, the real entrypoint, not through calling `taskComposerCommand` or the flag-parsing internals directly. A second test asserts `taskUsage`'s and `printTaskHelp`'s rendered output agree on the same flag set (derived from `TASK_FLAGS`, not two independently-typed literals), so a future flag added to one and not the other fails at test time instead of surviving to another field report.

## Consequences

**Easier:** `arbor task --tier direct "text"` — a natural way to type the command, and the one an operator reasonably reaches for first — works. The usage text an operator sees on any future refusal is provably the same flag set the parser accepts, because both are rendered from `TASK_FLAGS` rather than typed twice.

**Harder:** the leading-flag fall-through means a typo like `arbor task --tiar direct "text"` now falls through further into the parsing pipeline before it's caught as unrecognized — still caught, per decision 1, but by a later check than the old fast `:3218` gate. `TASK_FLAGS` becomes one more table to keep synchronized with the real `if (args.includes(...))` reads in `taskComposerCommand`; decision 2 removes the two-string duplication, but decision 3's second test is what actually guards against the table itself drifting from the parsing code.

**Unchanged:** every other `task` subcommand's argument order, the writer-lock acquisition sequence, and the `--tier` value-validation error (`:3245-3248`, still fires for a value outside `direct`/`reviewed`/`governed`) are untouched.

## Alternatives / Roads not taken

**Special-case `--tier` alone at the `:3218` guard, leaving the general leading-flag rejection in place.** Rejected: it fixes the one flag this survey found, but the underlying pattern — a bespoke `startsWith("-")` gate this file's other subcommands don't use — stays as a trap for the next flag added to `task`. Fixing the class, not the instance, is why this ADR removes the special case entirely rather than patching around it.

**Leave `taskUsage` and `printTaskHelp` as independent strings and just add `--tier` to `taskUsage` by hand.** Rejected: this closes today's specific disagreement but not the mechanism that produced it — two hand-maintained lists of the same facts is exactly the DRY violation that let them diverge once already, and nothing stops a third flag from repeating it. A shared table is the smaller change once decision 1 already touches this function's flag handling.

**Require `--tier` first (mirror the found ordering instead of removing it).** Rejected: `evidence`, `project`, and `audit` already establish this file's convention that a flag reads naturally wherever an operator types it; inventing a second, opposite convention for `task` alone would fix the disagreement while making `task` the one command that still surprises.

## Obligations

### O1 — The defect is reproducible through the real CLI entrypoint, not just readable in source

`main` is the exported entrypoint every test in `cli.test.ts` drives; it is the same function that dispatches into `taskComposerCommand` and hits the `:3218` guard. This grounds that the leading-`--tier` rejection is a real, externally observable behavior of the shipped CLI, not an internal code path a reader might mistake for dead or unreachable.

<!-- proof: symbol=main file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/cli.test.ts -->

### O2 — `TASK_SUBCOMMANDS` is the real, exported list the `:3217` dispatch checks against, and is what decision 1's fall-through must keep consistent with

Any leading token not in this list and not a recognized flag remains rejected as unknown; this is the boundary decision 1 preserves rather than loosens.

<!-- proof: symbol=TASK_SUBCOMMANDS file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/cli.test.ts -->

### O3 — `taskUsage` and `printTaskHelp` disagree on `--tier` today, and this specific disagreement is unverifiable by proof

Both functions are internal to `cli.ts` — neither is exported — so `resolveProofComment`'s exported-symbol requirement cannot cite either one directly; `main`'s proof (O1) demonstrates the surrounding entrypoint is real and tested, but not this particular string-disagreement between two private functions.

<!-- unverifiable: taskUsage and printTaskHelp are module-private (no `export`), so no top-level exported symbol names this specific disagreement; O1 grounds the entrypoint that reaches taskUsage instead -->

### O4 — A shared `TASK_FLAGS` table and the position-independence/usage-agreement tests from decisions 1-3 do not exist yet

<!-- unverifiable: TASK_FLAGS, the fall-through change, and the two new tests are the implementation this ADR authorizes; none exist in the working tree as of this ADR, so nothing can resolve against them yet -->
