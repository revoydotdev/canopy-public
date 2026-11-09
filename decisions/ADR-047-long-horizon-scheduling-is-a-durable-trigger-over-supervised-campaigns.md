# ADR-047: Long-Horizon Scheduling Is a Durable Trigger Over Supervised Campaigns

**Status:** Accepted
**Date:** 2026-08-12

## Context

ADR-026 makes `campaign.run` a supervised job, but the runtime has no durable source of deferred, recurring, or external-triggered jobs. In-memory timers would silently disappear on restart. Long-running sessions also need an explicit durable human suspension and must not inherit stale verification from reused work.

## Decision

The scheduler is a durable, versioned trigger registry over the existing supervised `campaign.run` path. It never runs a second campaign loop. A stateless evaluator reloads schedules and determines due work; no `setInterval` or in-memory timer is authoritative.

Schedules support once, bounded five-field cron, and external-key triggers. Every missed-run decision uses one recorded policy: skip, fire once, or bounded backfill. Each fire binds the schedule version it observed, making stale work detectable. ADR-029's one-writer persistence boundary applies.

`human_required` is a durable schedule state. Resume increments the row version and only a fresh scheduler evaluation may launch more work. Continuation of an interrupted underlying campaign remains governed by ADR-012 and ADR-043; scheduling is not replay authority.

A verified plan template may be selected by a deterministic intent-template cache before launch. The reused projection is always `claimed`, never `verified`; current-run verification is still required.

## Consequences

Schedules and run decisions survive restarts and remain inspectable. Hosts must call `tick` or deliver an external trigger; process liveness is deliberately separate from durable correctness. V1 is single-node, single-writer, has bounded cron syntax and backfill, and does not predict tasks or learn scheduling policy.

## Obligations

### O1 — Restart cannot erase a schedule

<!-- proof: symbol=DurableScheduleStore file=packages/arbor-mcp/src/scheduler/schedule-store.ts roundtrip=packages/arbor-mcp/tests/scheduler/long-horizon.test.ts -->

Registry rows and run records atomically persist and replay.

### O2 — Catch-up is explicit and bounded

<!-- proof: symbol=LongHorizonScheduler file=packages/arbor-mcp/src/scheduler/scheduler.ts roundtrip=packages/arbor-mcp/tests/scheduler/long-horizon.test.ts -->

Skip, fire-once, and bounded-backfill behavior derives from each row.

### O3 — Human suspension is durable

<!-- proof: symbol=LongHorizonScheduler file=packages/arbor-mcp/src/scheduler/scheduler.ts roundtrip=packages/arbor-mcp/tests/scheduler/long-horizon.test.ts -->

Human-required and resume transitions persist with monotonically increasing versions.

### O4 — Plan reuse cannot inherit verified authority

<!-- proof: symbol=PlanReuseCache file=packages/arbor-mcp/src/scheduler/plan-reuse.ts roundtrip=packages/arbor-mcp/tests/scheduler/long-horizon.test.ts -->

Every cache hit returns claimed provenance and requires current-run verification.

### O5 — Production dispatch uses the supervised campaign path

<!-- proof: symbol=createCliRuntime file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/cli.test.ts -->

CLI runtime composition launches due rows through `JobScheduler` and `ArborRuntime.runCampaignJob`.
