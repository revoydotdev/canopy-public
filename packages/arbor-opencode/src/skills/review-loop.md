---
name: review-loop
description: Dual-critic review of a plan, diff, or artifact. Lenticel runs the Five-Point Mandate (approval-biased), Burl runs architectural analysis (read-only). Use before landing a change, after a Seed completes, or when Crown needs a critic verdict for arbor_record_result.
---

# /review-loop — Dual Critic Review

You are dispatching the critic panel. Lenticel is the primary critic (approval-biased, runs the Five-Point Mandate). Burl is the reasoning consultant (architectural depth, read-only). Together they produce a `CriticVerdict` suitable for `arbor_record_result`.

## Inputs

One of:
- A plan path (e.g., `.arbor/plans/auth-refactor.md`)
- A diff or commit range (e.g., `git diff main..feature-branch`)
- A specialist's output (free text or file path)

If none provided, ask the operator what to review.

## Phase 1 — Parallel critic dispatch

Fire Lenticel and Burl in parallel. Each gets the same input artifact but a different mandate.

### Lenticel (Five-Point Mandate)

```
task(subagent_type="lenticel", prompt="Review the following. Run the Five-Point Critic Mandate:
1. ROOT-CAUSE ANALYSIS: on any failure, identify WHY.
2. MEASUREMENT VALIDATION: verify tests aren't flaky, fixtures aren't stale.
3. GUARDRAIL ENFORCEMENT: confirm scope adherence, no unauthorized side effects.
4. INTROSPECTION: verify the author's reasoning is internally consistent.
5. STABILITY MONITORING: flag oscillation (re-proposing rejected changes).

You are APPROVAL-BIASED. Reject only on verified, articulated blockers that would stop execution. 80% clear is executable.

Return: { approved: bool, rationale: string, root_cause?: string }

Artifact: <the thing under review>")
```

Before dispatching Lenticel, inject KB context:
```
arbor_kb_inject(prompt, campaign_id, tier="critic")
```
Critics see all KB entries — including failure modes Specialists can't see (ADR-005).

### Burl (Architectural analysis)

```
task(subagent_type="burl", prompt="Review the following for architectural soundness. Cite specific concerns about:
- Coupling and boundary violations
- Reversibility (can this be undone if it goes wrong?)
- Hidden risks (concurrency, failure modes, scaling cliffs)
- Whether the approach is the simplest viable option

Return: { concerns: [{ severity: 'high'|'medium'|'low', issue, recommendation }], verdict: 'ship'|'revise'|'reject' }

You are READ-ONLY. You advise; Lenticel decides.

Artifact: <the thing under review>")
```

## Phase 2 — Synthesize verdict

Combine the two outputs into a single `CriticVerdict`:

| Lenticel | Burl | Verdict |
|---|---|---|
| approved | ship / revise | **Approved** — record with `critic_approved: true` |
| approved | reject | **Approved with noted concerns** — record with `critic_approved: true`, attach Burl's concerns |
| rejected | * | **Rejected** — record with `critic_approved: false`, Lenticel's root_cause |

For high-stakes nodes (architecture changes, security-sensitive, irreversible), require BOTH Lenticel approval AND Burl verdict ≠ reject.

## Phase 3 — Return

Return the synthesized verdict in the shape `arbor_record_result` expects:

```
{
  critic_agent: "lenticel",
  critic_approved: <bool>,
  critic_rationale: "<Lenticel's rationale + Burl's noted concerns>",
  critic_root_cause: "<Lenticel's root_cause if rejected, else omit>"
}
```

## When to use this skill

- **After a Seed completes**: the `/arbor` loop calls this implicitly at step 5
- **Before landing a PR**: run on the diff against main
- **On a plan**: run `/plan` which embeds this as Phase 5
- **Standalone**: when the operator wants a code review without running a full campaign

## Critical rules

- **No self-approval.** The agent that produced the artifact cannot be on the critic panel.
- **Lenticel decides.** Burl advises. For high-stakes nodes, both must agree.
- **Approval-biased.** 80% clear is executable. Don't block on stylistic preferences or minor gaps.
- **Root cause required on rejection.** "It's wrong" is not a root cause. "The test fixtures are stale because the schema changed in commit X" is.
- **Critics are read-only.** Neither Lenticel nor Burl can edit files. They only judge.
