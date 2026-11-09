// Shared synthetic attempt records for the Stage 0 harness tests. No live calls.
import { STAGE0_ATTEMPT_SCHEMA } from "../src/stage0/types.js";
import type { Stage0AttemptRecord } from "../src/stage0/types.js";

export function attempt(fields: Partial<Stage0AttemptRecord> & { task_id: string; seed: number; attempt_index: number; verified?: boolean; adopted_ok?: boolean }): Stage0AttemptRecord {
  const verified = fields.verified ?? false;
  const adoptedOk = fields.adopted_ok ?? verified;
  const startedMs = Date.UTC(2026, 9, 6, 12, 0, 0) + fields.attempt_index * 1000;
  const wall = fields.wall_ms ?? 60_000;
  return {
    schema: STAGE0_ATTEMPT_SCHEMA,
    experiment: "full",
    wave: 0,
    started_at: new Date(startedMs).toISOString(),
    finished_at: new Date(startedMs + wall).toISOString(),
    wall_ms: wall,
    campaign_id: `c-${fields.task_id}-${fields.seed}-${fields.attempt_index}`,
    arbor_task_exit: verified ? 0 : 3,
    arbor_task_timed_out: false,
    halt_reason: verified ? "verified_result" : "no_nodes",
    harness_verified: verified,
    verification: verified ? { tag: "verified", cmd: "npm test", exit: 0, stdout_hash: "sha256:x" } : null,
    adopt_apply_exit: verified ? 0 : null,
    adopted: verified,
    changed_paths: verified ? ["index.js"] : [],
    independent_acceptance_exit: verified ? (adoptedOk ? 0 : 1) : null,
    protected_paths_intact: true,
    verified_and_adopted: verified && adoptedOk,
    cost_usd: 0.1,
    cost_priced_usd: 0.1,
    cost_unpriced_estimate_usd: 0,
    unpriced_spans: 0,
    tokens: { input: 1000, output: 100, cache_read: 0, cache_write: 0 },
    failure_class: verified ? (adoptedOk ? null : "harness") : "model",
    failure_detail: null,
    run_dir: "/nonexistent",
    ...fields,
  };
}
