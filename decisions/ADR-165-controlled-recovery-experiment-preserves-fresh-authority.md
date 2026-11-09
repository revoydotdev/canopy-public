# ADR-165: Recovery Evaluation Uses Controlled Checkpoints Without Restoring Authority

**Status:** Accepted
**Date:** 2026-09-23
**Authoring Revision:** 0daed8256e1a9d811bd0308594c983a714353beb
**Content ID:** sha256:3eac8621ed045562acf5bf2487e66892ca94b96ace6321f66f446ad2408a304e

## Context

The Q2/Q3 2026 literature review identifies aligned checkpoints of agent context and a controlled environment as a possible way to make long-running work recoverable, while separately measuring partial checklist progress. This is a research hypothesis from AgentRewind and MettleBench, not evidence that checkpointing improves Revoy2 campaigns. Revoy2 already treats process restart as `recovery_required`; ADR-012 requires fresh authority for recovery and forbids treating stored history as permission to replay work.

The open question is whether a redacted recovery projection can improve progress after an injected failure without repeating side effects, widening scope, or manufacturing verification.

## Decision

Authorize one synthetic, reversible evaluation of bounded recovery, not a production checkpoint or automatic resume feature. Compare (a) no recovery, (b) the current `recovery_required` path, and (c) a candidate that restores only a redacted checkpoint manifest and permitted campaign facts alongside a controlled environment checkpoint. Hold task, model, tool budget, and injected failure fixed.

Score final completion and partial checklist progress, duplicate side effects, rejected scope attempts, and evidence deficits. A positive result requires more verified checklist progress with no increase in duplicate effects, scope violations, or falsely verified nodes. A result authorizes only a follow-up design decision.

The experiment must not checkpoint chain-of-thought, raw provider dialogue, credentials, live process handles, unredacted artifacts, or executable tool continuations. It must not reacquire credentials, replay provider/tool/approval side effects, restore a lease, or promote checkpoint contents to `!verified`.

## Consequences

The proposal tests recovery value while keeping the current fresh-authority boundary intact. The synthetic result will not establish safe recovery for real provider work, external repositories, or arbitrary environments. If the candidate does not pass the stated safety conditions, the current recovery path remains the reference.

## Alternatives / Roads not taken

- **Implement checkpoint restoration directly.** Rejected because the cited work does not establish that environment restoration is safe under Revoy2's authority and provenance model.
- **Treat prior benchmark results as transferable.** Rejected because the reported tasks, models, and environments differ from governed repository campaigns.
- **Do no recovery experiment.** Deferred as an option for the operator; it avoids evaluation cost but leaves recovery progress and partial completion unmeasured.

## Obligations

### O1 — The recovery experiment uses matched controls and reports partial progress

The tracked E1 evidence record identifies all three arms, fixed comparison inputs, the checkpoint version, completion and partial-progress scores, and the safety counters.

<!-- unverifiable: E1 is a proposed experiment; no result is claimed until a tracked evidence record exists. -->

### O2 — Recovery evidence cannot restore authority or replay work

The E1 fixture and review demonstrate that the candidate contains no raw history, secrets, live handles, executable continuations, or authority-bearing recovery, and that success remains independently verified.

<!-- unverifiable: E1 is a proposed experiment; its fixture and evidence have not been created. -->
