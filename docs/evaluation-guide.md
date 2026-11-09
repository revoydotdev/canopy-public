# Evaluation comparison guide

This guide runs the existing deterministic evaluator and comparison report. It
is a reproducible rehearsal of the measurement pipeline—not proof that revoy2
outperforms a coding agent, a provider, or a linear workflow.

## Prerequisite

From the repository root:

```bash
bun install --frozen-lockfile
```

## Produce a bounded report

```bash
bun run eval:report -- --tasks 5 --runs 3 --max-iterations 50 --output .arbor/eval/operational-comparison
```

The command runs the tree-search evaluator and its linear synthetic baseline,
prints Markdown, and writes a timestamped report below ignored
`.arbor/eval/operational-comparison/`. Lower the values only to shorten a local
smoke run; preserve them when comparing evaluator revisions.

For the compact summary used by the regression workflow:

```bash
bun packages/arbor-eval/scripts/run-baseline-comparison.ts --runs 3 --max-iterations 50
```

Both paths are deterministic and bounded. They make no provider request and
collect no real token/currency spend. The report's methodology caveat is part
of the result, not boilerplate to omit.

## Read the report correctly

Use branching, backtrack, KB-hit, convergence, score, and iteration metrics to
detect an unexpected evaluator/tree-search change. Do not convert its
comparison “winner” into an operational-advantage claim: both arms use scripted
outcome generators and timing is local evaluator timing.

For a real claim, use one row in the canonical scenario matrix and follow the
pre-registration, paired control, independent scoring, and acceptance thresholds
in [`research/operational-advantage-evaluation.md`](research/operational-advantage-evaluation.md).
Until those artifacts exist, call the result a deterministic harness self-test
or **inconclusive**.

## The live ablation (real model, real verification)

Everything above is the deterministic lane and makes no provider request. The
live lane is separate, costs money, and is the only thing here that measures
outcomes rather than harness behaviour.

It runs three arms over the same tasks, the same model and the same fixed
verification-call budget, so that each adjacent pair isolates one variable:

| Arm | Governance | Selection |
|-----|-----------|-----------|
| `ungoverned_linear` | none | fixed order |
| `governed_linear` | full campaign path | fixed order |
| `governed_tree` | full campaign path | UCB with backtracking |

`ungoverned_linear` to `governed_linear` is the **governance** effect.
`governed_linear` to `governed_tree` is the **search** effect. The previous two
arms confounded these, which is why the arm names changed and the report schema
moved to `arbor.live-ablation/v2` (ADR-157).

```bash
envchain openrouter env \
  ARBOR_EVAL_LIVE_BASE_URL=https://openrouter.ai/api/v1 \
  ARBOR_EVAL_LIVE_PROVIDER_ID=openrouter \
  ARBOR_EVAL_LIVE_MODEL_ID=<model> \
  ARBOR_EVAL_LIVE_PRICE_INPUT_USD=<usd per input token> \
  ARBOR_EVAL_LIVE_PRICE_OUTPUT_USD=<usd per output token> \
  sh -c 'ARBOR_EVAL_LIVE_API_KEY="$OPENROUTER_API_KEY" bun packages/arbor-eval/src/cli.ts live \
    --runs 3 --max-calls 3 --max-output-tokens 1200 \
    --cost-ceiling-usd 2.00 --output .arbor/eval/<name>'
```

Read it with the same discipline as the deterministic lane, plus three of its own:

- **A ceiling effect is a property of the task-model pair, not the tasks.** A
  strong model can one-shot the whole suite, at which point every arm reads 1.0
  and the comparison is vacuous rather than negative. Check the first-attempt
  rate before reading any delta; run `--max-calls 1` to measure it directly.
- **Every task is proven both broken and solvable in CI.** A task that already
  passes is a free win handed to every arm; an unsolvable one drags every arm
  toward zero. Neither is visible in an aggregate.
- **A crisp pass/fail oracle is all this measures.** The governance machinery
  also exists to stop unaudited claims, stubs and unreachable code, none of
  which a passing test detects. A governance effect near zero here is evidence
  about verifiable-task throughput and is not evidence that the gates are
  worthless.

The falsifiability findings are pre-registered for BOTH claims and a tie counts
as a trigger: the burden is on the extra machinery to earn its place.

## Staged native-safety evaluator

`@arbor/eval` also exposes `evaluateStagedNativeSafety()`. It is a hermetic,
primary-source-derived regression evaluator for the P1 gap recorded in the
[native-harness delta](research/native-harness-primary-source-delta-2026-08-09.md),
especially SafeClawBench's observation that semantic acceptance, audit evidence,
and observed sandbox state can diverge.

It runs five fixed in-process scenarios: prompt injection, tool-return
injection, memory/context extraction, ambiguous unsafe inference, and a benign
control. The public native executor and OpenAI-compatible adapter are driven by
scripted SSE responses. A reversible in-memory oracle records only synthetic
filesystem, process, and message effects; it performs no provider request,
network access, host filesystem mutation, or command execution.

Every episode separately reports semantic acceptance/refusal, whether its
event/provider-request/tool evidence was redacted, and the expected versus
observed synthetic state. The artifact includes generated provenance and equal
ceilings (two model turns, two tool calls, 64 events), making a future paired
baseline budget-comparable. It does **not** measure a real model or demonstrate
benchmark transfer, provider safety, or operational advantage.

## Release boundary

`bun run gate:eval-regression` is a scripted regression detector, not a
provider-quality, cost, security, or release-acceptance gate. The full release
procedure remains [`release-readiness.md`](release-readiness.md); a real
provider experiment is manual/opt-in, needs its own budget and secret handling,
and must never be silently folded into a PR check.

Raw SWE-bench Verified pass rate is not an internal quality claim. Independent
2026 work finds overestimation from narrow tests, benchmark-specific overfitting,
and large Verified-to-Live drops: SWE-ABS ([arXiv 2603.00520](https://arxiv.org/abs/2603.00520)),
SWE-Bench ProMax ([arXiv 2608.09802](https://arxiv.org/abs/2608.09802)),
*Saving SWE-Bench* ([arXiv 2510.08996](https://arxiv.org/abs/2510.08996)), and
SWE-bench-Live ([arXiv 2505.23419](https://arxiv.org/abs/2505.23419)). If a
SWE-bench-family signal is used, prefer a contamination-resistant live variant,
state the overestimation risk beside it, and pair it with stronger/adversarial
tests rather than promoting a raw pass rate into a release gate.
