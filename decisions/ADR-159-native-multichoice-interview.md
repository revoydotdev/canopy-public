# ADR-159: The Native Ask Tool Carries Real Choices

**Status:** Accepted
**Date:** 2026-09-03
**Authoring Revision:** 015ad981f58fc478551049863d4f60413c4899ba
**Content ID:** sha256:93160cb71cf72558b92083a03382e9805c0fb05d3664fa7abb9c25f5c3e9fb40

## Context

Every layer of the operator-question path already supported a multiple-choice question,
except the one the model actually calls.

`RequestUserInput` has carried `options: readonly UserInputOption[]` since ADR-019.
`validateUserInputCommand` requires the array to be non-empty and each entry to have an id
and text. The TUI compose overlay renders an `Options: id — text · id — text` row, its
answer path matches a typed option id (or an `id, note` prefix, so an operator can keep a
rationale attached), and it refuses free text outright unless some option declares
`is_other`. That refusal is what makes a question multiple *choice* rather than a prompt
with suggestions.

`createNativeUserInputToolPort` hardcoded a single option:

```ts
options: [{ id: USERINPUT_ASK_DEFAULT_OPTION_ID, text: "Provide an answer", is_other: true }],
```

and the advertised tool schema accepted only `{ question: string }`. So a native model
could ask the operator an essay question and nothing else. The consequence that matters:
`revoy2-interview` requires a multiple-choice surface in terms, saying the step "is not
optional and not satisfiable by writing a paragraph" — and the governance interview
therefore could not be conducted through revoy2's own harness at all. It reached the
operator only through the Claude Code skill.

## Decision

**`userinput.ask` accepts the options it was always able to record.**

1. **The tool takes an optional `options` array**, each entry `{ id, text, is_other? }`,
   passed through to the existing `RequestUserInput` question unchanged. No new ledger
   shape, no second question queue: this is the ADR-019 machinery every other caller
   already uses, finally reachable from a model.

2. **Omitting `options` keeps the previous behaviour exactly** — one `provide-answer`
   free-text choice. Every existing caller and test passes only `question`, and a silent
   change to their semantics would be a worse defect than the one being fixed.

3. **An empty array is refused rather than treated as "no options".** Falling back to free
   text there would turn a caller's malformed multiple-choice question into a silently
   different question, which is the shape of defect this repository spends most of its
   gates catching.

4. **Ids that collide case-insensitively are refused.** The TUI matches a typed answer
   against the id with `toLocaleLowerCase`, so `accept` and `Accept` are indistinguishable
   to the operator and one of them would be recorded arbitrarily. Refusing is the only
   honest option; picking a winner records an answer the operator did not give.

5. **The option count is bounded at twelve and text at 512 bytes.** A question with fifty
   choices is not a question. The bound is a judgement, not a measurement, and is stated
   as one.

6. **`blocking` is deliberately NOT exposed, and stays pinned to `"async"`.** The field is
   validated in two places and rendered as a column in the interviews screen, but a
   repository-wide search finds no consumer that halts anything on it. Advertising a
   `blocking` parameter would offer a model a halt that does not happen. A session that
   genuinely cannot proceed uses the existing `request_human_input` halting convention,
   and the tool description says so.

## Consequences

The governance interview becomes conductable natively: a model can put a real
`accept / reject / defer` question to the operator, the operator sees the choices, types
an id, and the answer lands in the ledger as a chosen `option_id` rather than as prose
someone has to interpret later. Combined with ADR-158, an answer recorded that way is both
a real choice and traceable to the recorder.

Narrower than it may read: this closes the *asking* half. It does not make the interview
mandatory, does not block anything, and does not prove a human rather than an agent typed
the answer. It removes the reason the native path could not be used, which was that the
question surface did not exist.

The `blocking` field is left as a known piece of unwired vocabulary rather than quietly
removed. Removing it would break the validators and the screen column; implementing it is
a real change to session control flow that deserves its own decision. Naming it here as
validated-but-unconsumed is the honest interim state, and this record is where a future
reader should start.

## Alternatives / Roads not taken

**Also expose `blocking`.** Rejected as described. A parameter whose documented effect
does not occur is worse than an absent one, because a model would reasonably rely on it.

**Add a second, separate `interview.ask` tool for governance questions.** Rejected: it
would fork the question path in two, and the existing `userinput.ask` already reaches the
right ledger, the right screen and the right answer validator. The gap was a hardcoded
literal, not a missing mechanism.

**Let the model set `authority`.** Rejected for now. `delegated_needs_input` is the honest
description of a model-originated question, and `lead` would let a model describe its own
question as carrying an authority it does not have.

**Default to refusing when `options` is absent, forcing every caller to be explicit.**
Rejected: it breaks every existing caller to fix a gap none of them hit, and a free-text
question is a legitimate thing to ask.

## Obligations

### O1 — A model-supplied option set reaches the operator's question unchanged

`userInputOptions` passes real ids, text and `is_other` through, defaults to the previous
single free-text choice when omitted, and refuses an empty array, a case-insensitive id
collision, and more choices than the bound allows.

<!-- proof: symbol=createNativeUserInputToolPort file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-agent-executor.test.ts -->
