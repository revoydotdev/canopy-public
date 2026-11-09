# Evaluation, cost model, and evidence-backed comparison (`@arbor/eval`, `@arbor/config`)

Evaluation in revoy2 is not a dashboard afterthought; it is a control input.
This is why campaign policy, retrieval, token controls, and benchmark fixtures are
under a dedicated package (`@arbor/eval`) and not embedded in loop code.

## Core function

- benchmark and trajectory execution definitions (`packages/arbor-eval/src`),
- deterministic fixture and policy control (`@arbor/eval` + `@arbor/config`),
- runtime policy projection into config-backed knobs (`config` package),
- cost telemetry and provider usage channels (server transport and opt-in native flows).

The goal is to keep “what got better” evidence in the same governance plane as “what was
attempted.”

## Why this component exists

Without a bounded measurement plane:
- optimization becomes hand-wavey,
- changes to search behavior cannot be compared,
- and operational cost shifts go unobserved until incidents.

With evaluation:
- branch/race/retrieval policies can be stress-tested offline,
- failures can be compared under fixed fixtures,
- deployment can be phased by measured effect rather than sentiment.

## Research grounding

This layer is aligned with recent in-repo research work:

- `docs/research/agent-uct-comparison-2026-08-10.md` and related deterministic
  comparison notes (policy and tuning),
- `docs/research/repository-retrieval-calibration-2026-08-14.md` (retrieval calibration,
  signal ablation),
- `docs/research/openrouter-native-planner-bakeoff*.md` (interop and admission boundary),
- `docs/research/operational-advantage-evaluation.md` (advantage-claim gate conditions).

The key discipline is that evaluation findings are scoped as "measurement claims" and not
implicitly promoted to architecture truth.

## Design choices and rationale

- **Deterministic fixture-first design** for comparability.
- **Token/cost telemetry as separate channels** from success/failure truth.
- **Provider-dependent flows remain opt-in**; repository-owned defaults do not assume networked
  provider behavior.
- **Calibration and ablation artifacts are versioned** to prevent accidental benchmark drift.

## Relevant files

- `packages/arbor-eval/src/index.ts`, `metrics.ts`, `trajectory-metrics.ts`,
  `reuse-ledger.ts`, `repository-retrieval-eval.ts`, `agent-uct.ts`, `staged-native-safety.ts`
- `packages/arbor-config/src/schema.ts`, `validator.ts`, `native-provider.ts`
- `examples/*`, `fixtures/*`
- docs: `docs/evaluation-guide.md`, `docs/public-readiness.md`, `docs/runtime-tuning.md`
