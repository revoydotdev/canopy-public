import { createHash } from "node:crypto";
import type { ArborRuntime } from "../runtime.js";
import type { RecoveryDisposition } from "./contracts.js";
import type { ContinuationPlan } from "./continuation-plan.js";

export type RecoveryCommandResult =
  | { readonly ok: true; readonly authorized: false; readonly plans: readonly ContinuationPlan[] }
  | { readonly ok: true; readonly authorized: true; readonly plan: ContinuationPlan; readonly authorization_id: string; readonly session_id: string; readonly campaign_task_id: string; readonly dispatched: boolean }
  | { readonly ok: false; readonly reason: string; readonly plans?: readonly ContinuationPlan[] };

/** Preview by default; --authorize preparation still dispatches only campaign.run. */
export function runRecoveryCommand(input: {
  readonly runtime: ArborRuntime;
  readonly campaign_id: string;
  readonly node_id?: string;
  readonly authorize: boolean;
  readonly actor_id: string;
  readonly reason: string;
  readonly dispositions: readonly RecoveryDisposition[];
  readonly continuation_kind?: "resume" | "respawn";
  readonly now?: () => string;
}): RecoveryCommandResult {
  const service = input.runtime.recoveryService;
  if (service === null) return { ok: false, reason: "recovery service is not configured" };
  const plans = service.previewContinuation(input.campaign_id, input.node_id);
  if (!input.authorize) return { ok: true, authorized: false, plans };
  if (plans.length === 0) return { ok: false, reason: "no interrupted durable session matched the recovery target", plans };
  if (plans.length !== 1) return { ok: false, reason: "--authorize requires --node when more than one interrupted node exists", plans };
  const plan = plans[0]!;
  const recoverable = input.runtime.manager.getRecoverableNodes(input.campaign_id).find((node) => node.node_id === plan.node_id);
  if (recoverable === undefined || recoverable.prior_operation_id === null) return { ok: false, reason: "node has no durable interruption operation identity", plans };
  const semantic = JSON.stringify({ campaign_id: input.campaign_id, node_id: plan.node_id, source: plan.source_session_id, fingerprint: plan.classification_fingerprint, actor: input.actor_id, dispositions: input.dispositions });
  const identity = createHash("sha256").update(semantic).digest("hex");
  const authorizationId = `continuation-${identity.slice(0, 32)}`;
  const prepared = service.prepareContinuation(input.campaign_id, plan.node_id, {
    authorization_id: authorizationId, idempotency_key: `continuation:${identity}`, operation_id: authorizationId,
    prior_operation_id: recoverable.prior_operation_id, expected_version: recoverable.expected_version,
    actor_id: input.actor_id, actor_role: "operator", reason: input.reason,
    dispositions: input.dispositions, authorized_at: (input.now ?? (() => new Date().toISOString()))(),
    continuation_kind: input.continuation_kind ?? "resume",
  });
  if (prepared.status !== "ready") return { ok: false, reason: prepared.reason, plans };
  const dispatched = input.runtime.runPreparedContinuation(input.campaign_id, prepared.authorization.authorization_id);
  if (!dispatched.ok) return { ok: false, reason: dispatched.reason, plans };
  return { ok: true, authorized: true, plan: prepared.plan, authorization_id: prepared.authorization.authorization_id, session_id: prepared.authorization.new_session_id, campaign_task_id: dispatched.task_id, dispatched: dispatched.dispatched };
}
