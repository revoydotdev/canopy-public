# Revoy2 token-economy architecture

Revoy2 treats tokens as an optimization target, not an authority boundary. A
policy may reduce context, calls, turns, or model cost only when the same
governed task is completed with non-inferior held-out quality. Critic
independence, provenance typing, evidence gates, and `!verified` completion are
never relaxed to save tokens.

## Evidence language and current boundary

The runtime contracts and invariants below describe implemented behavior where
their rows say `Production`; they do not establish an empirical economy win.
That distinction is material: query-conditioned retrieval's 24-task, 100%
recall and 96.1092% metadata reduction result is calibration evidence and is
explicitly non-promotable. The structural-centrality regression is a measured
reason that candidate remains off. Promotion requires the paired held-out,
independently verified evidence defined here and in the canonical
[1.0.0 roadmap](roadmap-1.0.0-and-documentation-governance.md#phase-2--token-economy-caching-and-context-efficiency).

The remaining retrieval cohort, provider-specific cache pinning where provider
counters exist, and cost-aware UCT promotion are targets, not completed
measurements. Provider cache counters that an adapter cannot report are
unavailable; they must not be inferred from stable prefixes or estimated
pricing. The September [native harness token-overhead audit](comparative-analysis/native-harness-token-overhead-audit.md)
is a dated 42-span observation from 2026-09-13, not a current baseline. Refresh
its source sample and revision before using its totals as a current release
claim.

This is a clean-room synthesis of the research program around context pruning,
structured memory, retrieval, route selection, value-of-information search,
and long-context failure. It defines the eleven techniques as one Revoy-owned
system so future work cannot quietly substitute a collection of unrelated
heuristics.

## The eleven techniques

| # | Technique | Runtime contract | Activation evidence | Current state |
|---:|---|---|---|---|
| 1 | Phase/role/agent accounting | Provider observations remain typed; absent usage is never zero | Eval manifest totals reconcile with the evidence ledger | Production |
| 2 | Stable-prefix economics | Stable sources form the system prefix; volatile session material is structurally placed in the user projection; cache reads/writes are measured | Byte-stability tests plus cache-read/write ratios in eval manifest v3 | Production for the OpenAI-compatible adapter; provider-specific explicit cache controls remain adapter work |
| 3 | Context-window allocation | Every session reserves output capacity and admits bounded input | Token epoch and prospective admission evidence | Production |
| 4 | Provenance memory | Success/failure facts are witnessed, scoped, durable, and capability-filtered | Memory facts replay into the KB with their witnesses | Production |
| 5 | Semantic repository graph | Compiler-parsed imports and symbols provide bounded neighborhoods | Cache hit, digest, indexed-file count, and truncation state | Production |
| 6 | Query-conditioned retrieval | A bounded hybrid ranker combines path phrases, acronym-safe task terms, distinct-concept coverage, symbols, retry deltas, verified memory tags, and a dependency neighborhood; agents widen through graph/search/read tools rather than receive the repository | Cache state, projection bounds, signal ablations, exact-path recall, and accuracy-gated task comparison | Production lexical + delta + verified-memory hybrid; 24-task calibration reached 100% recall with 96.1092% metadata reduction, but remains non-promotable calibration evidence. Structural centrality is measured but off after a recall regression. |
| 7 | Evidence-preserving pruning | Required facts outrank transcript bulk; folds retain identities, provenance, and raw evidence pointers | Offered/retained/pruned counts by source | Production |
| 8 | Delta-focused retries | Executors classify tracked, untracked, deleted, and renamed worktree paths; durable capsules carry bounded digest-only deltas, unmet requirements, evidence pointers, tool signatures, and failure fingerprints | Retry projection size, delta digest/path coverage, and post-retry success | Production |
| 9 | Duplicate-work prevention | Exact repeatable reads reuse a content-addressed prior result; mutations invalidate the cache; repeated failures can stop or decompose | Reuse diagnostics, redundant-call attribution, failure recurrence | Production for native read reuse; campaign stop/decompose remains explicit policy |
| 10 | Adaptive search allocation | Difficulty selects model/turn depth; UCT and decomposition allocate work instead of globally widening context | Equal-budget task cohorts and verified progress per effective token | Production with experimental cost-aware scoring isolated |
| 11 | Accuracy-first activation | Economy candidates must save material tokens and pass conservative R4R and false-acceptance non-inferiority bounds | Paired held-out task IDs, identical cohort identity, independently verified cohort evidence, and confidence intervals | Production evaluation gate; calibration/unverified cohorts cannot promote a policy |

“Production” means a reachable runtime path with tests; it does not mean the
technique has already won an empirical comparison on every workload. Items
marked pending must not be described as active optimization.

## Accuracy invariants

1. `task`, `system_instructions`, `project_instructions`, and `human_input`
   context are required. If required facts cannot coexist in the model window,
   admission fails instead of pruning one silently.
2. Context selection is deterministic. Required entries are selected first,
   followed by the newest structural curation, preferred memory/graph/critic
   facts, and opportunistic transcript/tool bulk.
3. A memoized tool result is legal only when the host declares the operation
   both `read_only` and `repeatable`. Any write, patch, shell, or external
   operation clears all read memoization before dispatch because its effect may
   invalidate repository state.
4. Retry stopping and decomposition never manufacture success. The loop records
   a typed failure and preserves the ordinary critic/verification boundary for
   any later candidate.
5. An economy candidate is not eligible merely because its point estimate is
   cheaper. `evaluateEconomizationGuard` requires identical unique held-out
   task IDs, a configured minimum token reduction, a conservative confidence
   bound on right-for-right-reasons non-inferiority, and a bound on increased
   false acceptance. Statistically unresolved results remain off.
6. A calibration fixture is never promotion evidence. Both experiment arms
   must name the same held-out cohort and carry independently verified cohort
   provenance; generated or claimed labels force an `unresolved` decision.
7. Campaign worktree replicas are excluded from the canonical repository
   graph. A stale isolated copy may never outrank the source checkout merely
   because the same symbols occur multiple times.
8. Memory influences repository retrieval only through tags with `!verified`
   provenance and a durable evidence pointer. Raw fact bodies and weaker
   provenance never become retrieval authority.
9. Structural centrality cannot seed an unrelated file and remains disabled by
   default after its calibration arm reduced exact-path recall. A fashionable
   graph heuristic does not outrank measured correctness.

## Measurement protocol

For each control/candidate pair, record:

- raw input, output, cache-read, and cache-write tokens;
- weighted effective tokens under the manifest’s declared policy;
- phase, role, and exact botanical agent attribution;
- offered, retained, pruned, indexed-reference, stable-prefix, and dynamic
  context tokens by source;
- host tool executions, exact read reuses, redundant-call clusters, retries,
  decompositions, and repeated failure fingerprints;
- verified progress per effective token;
- right-for-right-reasons and false acceptance on paired held-out tasks.

Compare one change at a time against the same task IDs, environment digest,
model identity, sampling rule, and verification breadth. Promote only an
`eligible` result. A cheaper `unresolved` result is an invitation to gather more
evidence, not permission to turn the policy on.

The live Telemetry screen projects the same immutable ledger into phase- and
agent-attributed provider usage, cache-read efficiency, context retention and
pruning, stable/dynamic/indexed context totals, tool executions, reused reads,
and avoided output bytes. Every displayed economy series retains its source
record IDs and content hashes; the TUI owns no independent counters.

## Remaining frontier work

The next empirical lane is a separately sealed retrieval cohort comparing the
production lexical + delta + verified-memory seed with manual tool-led
retrieval. Structural centrality may be reconsidered only after a revised arm
passes that held-out gate. Provider-specific stable-prefix
pinning follows only where the adapter can report authoritative cache counters;
the generic OpenAI-compatible path now keeps volatile context outside its
byte-stable system prefix and manifest v3 reports observed cache ratios.
Cost-aware UCT promotion remains isolated until it wins an equal-budget,
accuracy-gated held-out experiment.
