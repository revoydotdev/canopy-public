# Closing ADR-026's opencode gap: submission over a process boundary

**Status:** Proposal, not an ADR. Nothing here is authorized by being written down.

**Date:** 2026-08-18. Every citation below was read directly from this repository at
`c6feed8`.

## Why this document exists

`docs/release-readiness.md` §8 carries this standing blocker:

> The opencode plugin does not drive a campaign — a real, user-facing gap for anyone
> expecting to launch one from inside opencode (ADR-026).

The wording is inherited from ADR-026's own Consequences section, but read alone it
invites the wrong fix. "Drive a campaign" is **Option B of ADR-026, explicitly
rejected** — tying campaign execution to opencode's process lifecycle rather than
revoy2's supervised-job lifecycle, and needing its own cancellation and reconciliation
story that duplicates `TaskSupervisor`. Anyone picking up that blocker line and
implementing the literal words would be re-litigating a ratified decision.

ADR-026 already names the sanctioned path, in its own Alternatives section:

> Not rejected as permanently out of scope: a future ADR could have the plugin
> *submit* a `campaign.run` job through the same `job.submit` path rather than drive
> one itself, which would close the gap named in Consequences without re-litigating
> this decision.

So the accurate residual gap is narrower than the blocker line implies: **an operator
inside an opencode session has no way to submit a `campaign.run` job.** That is worth
stating precisely, because the two framings have different and non-overlapping
implementations.

## The gap is still real

Confirmed by direct search at `c6feed8`, reproducing ADR-026's own method:

```
grep -c "job.submit\|CAMPAIGN_RUN_JOB_KIND\|runCampaign" packages/arbor-opencode/src/plugin.ts
0
```

`arborPlugin` (`packages/arbor-opencode/src/plugin.ts:127`) returns exactly two hooks —
`config` and `dispose` — and the `config` hook only merges agent and category
registrations into the host's config draft. There is no campaign-submitting surface of
any kind.

## Two structural obstacles the blocker line does not mention

Both were found while scoping this work, and both bear on whether the obvious fix is
even available.

### 1. The dependency graph runs the wrong way

`CAMPAIGN_RUN_JOB_KIND` and the `job.submit` command authority live in `@arbor/mcp`
(`packages/arbor-mcp/src/runtime.ts`, exported from `packages/arbor-mcp/src/index.ts:16`).
But `@arbor/opencode`'s dependencies are only `@arbor/audit`, `@arbor/config`,
`@arbor/core`, `@arbor/prompts` — **it does not depend on `@arbor/mcp`, and `@arbor/mcp`
depends on it.**

A plugin that imported `job.submit` directly would invert an existing dependency edge
and create a cycle. This is not a small refactor to route around: it means the gap
**cannot** be closed by editing `plugin.ts` alone, which is what the blocker line's
phrasing suggests. Whatever closes it must cross a process boundary — the plugin
submitting to an already-running `arbor serve` over its MCP/HTTP surface — or must wait
for the package split described below.

### 2. The plugin API contract is unverified by construction

`@opencode-ai/plugin` is declared as an **optional peer dependency** of
`@arbor/opencode` and is **not installed** in this repository. `ArborPluginContext` and
`ArborHooks` (`plugin.ts:25,34`) are hand-written structural mirrors, each carrying a
comment saying so ("mirrors @opencode-ai/plugin's `PluginInput`" / "`Hooks` interface").

`ArborHooks` declares only `config` and `dispose`. Whether the real API exposes a hook
suitable for an operator-triggered action — a tool, a command, a slash-command
registration — **is not knowable from anything in this repository.** `ArborPluginContext`
does carry `client?: unknown` and `serverUrl?: URL`, which hint that the real
`PluginInput` supplies an SDK client, but `unknown` is exactly the typed absence of a
contract.

Any design past this point requires reading the authoritative `@opencode-ai/plugin`
reference first. This proposal deliberately stops short of specifying hook shapes
rather than reconstructing a third-party contract from memory.

## The strategic conflict, stated plainly

ADR-061 (`Status: Proposed`) declares OpenCode "deprecated as a direct product
dependency," and `docs/operator-ux-readiness.md:86-92` lists the migration as four
structural steps whose end state is:

> remove `@arbor/opencode` from `@arbor/mcp` dependencies and TypeScript references;
> prove the native CLI/TUI/test lane with that package absent.

None of the four steps is marked complete, and that document states that until step 4
passes, the repository must describe OpenCode as a deprecated transitional dependency.

So the two ADRs point in opposite directions on this exact file. ADR-026 invites a
future ADR adding campaign-submission capability to `arbor-opencode/src/plugin.ts`;
ADR-061 aims to empty that package out and delete it. **Building the capability now
means investing in a package with a ratified deletion trajectory** — and step 1 of the
migration is precisely "move Revoy-owned loop, worktree, critic, routing, and token
contracts out of the mixed `@arbor/opencode` package."

This tension is why this document is a proposal and not an implementation. It is a
sequencing decision that belongs to a human.

## Options

**Option 1 — Do nothing; fix only the framing.** Correct the release-readiness blocker
line so it states the accurate gap ("cannot *submit* a campaign job from an opencode
session"; driving one is explicitly rejected by ADR-026) and records the two structural
obstacles above. Cost: near zero. Leaves the capability gap open, but stops the
documentation from inviting the wrong fix. **Recommended as an immediate step
regardless of which longer-term option is chosen.**

**Option 2 — Close it now, over the process boundary.** The plugin gains a
campaign-submission surface that talks to a running `arbor serve` via its existing
MCP/HTTP transport, rather than importing `@arbor/mcp`. This respects the dependency
graph and keeps `job.submit` the sole command authority, satisfying ADR-026's named
path. Costs: requires reading the real `@opencode-ai/plugin` API first; needs a
connection/auth story and honest typed-absence behavior when no server is reachable;
and adds surface to a package slated for removal, so some of the work is knowingly
throwaway.

**Option 3 — Sequence it behind ADR-061.** Do step 1 of the migration first (extract
Revoy-owned contracts out of `@arbor/opencode`), then decide where a campaign-submission
surface belongs in the resulting shape. Costs: the user-facing gap stays open longer.
Benefit: the capability gets built once, in its final home, rather than built and moved.

## Recommendation

Take **Option 1 now** — it is cheap, purely corrective, and removes an active
invitation to implement the rejected Option B of ADR-026.

Then choose between 2 and 3 on one question that this document cannot answer from the
repository alone: **is anyone actually trying to drive revoy2 from inside opencode
today?** If there are real users on that path, Option 2's throwaway cost is worth
paying. If not, Option 3 is strictly better sequencing, because it avoids building into
a package that ADR-061 intends to delete.

## What this proposal does not claim

- It does not claim the `@opencode-ai/plugin` API can or cannot support a
  submission-triggering hook. That is unknown here and requires the vendor reference.
- It does not claim ADR-061's migration is correct or should proceed — only that it is
  ratified-as-proposed and points away from investing in this package.
- It does not estimate implementation effort for Option 2, because the unknown API
  contract dominates the estimate.
