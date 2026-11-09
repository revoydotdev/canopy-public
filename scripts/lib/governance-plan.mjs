/**
 * Canonical sequencing vocabulary for governance-derived evidence.
 *
 * A producer must finish its derivation, normalize it, and commit it before a
 * consumer may inspect the result.  Evidence transactions provide the lease
 * and atomic publication; this module deliberately owns only the portable
 * order, deterministic event shape, and consumer precondition.  Keeping it
 * here avoids creating a second execution-profile/DAG control plane.
 */

export const GOVERNANCE_PLAN_SCHEMA_VERSION = 1;
export const GOVERNANCE_PLAN_KIND = "revoy2.governance_producer_plan";
export const GOVERNANCE_PHASES = Object.freeze(["producer", "normalization", "commit", "consumer"]);

export class GovernancePlanRefusal extends Error {
  constructor(code, message, state = null) {
    super(message);
    this.code = code;
    this.state = state;
  }
}

/**
 * Deterministic, machine-readable phase/status events.  Events deliberately
 * contain no clock, PID, or random transaction value: their ordering and
 * meaning must compare exactly across equivalent runs.
 */
export function createGovernanceProducerPlan({ name = "governance-derived-evidence" } = {}) {
  let nextPhase = 0;
  let sequence = 0;
  const events = [];

  function record(phase, status) {
    if (!GOVERNANCE_PHASES.includes(phase)) {
      throw new GovernancePlanRefusal("unknown_phase", `governance plan does not define phase ${phase}`);
    }
    if (status !== "started" && status !== "succeeded" && status !== "failed") {
      throw new GovernancePlanRefusal("unknown_status", `governance plan does not define status ${status}`);
    }
    const phaseIndex = GOVERNANCE_PHASES.indexOf(phase);
    if (status === "started") {
      if (phaseIndex !== nextPhase) {
        throw new GovernancePlanRefusal("phase_out_of_order", `cannot start ${phase}; ${GOVERNANCE_PHASES[nextPhase] ?? "plan completion"} is required next`);
      }
    } else if (phaseIndex !== nextPhase) {
      throw new GovernancePlanRefusal("phase_not_active", `cannot mark ${phase} ${status}; it is not the active governance phase`);
    }
    const event = Object.freeze({
      schema_version: GOVERNANCE_PLAN_SCHEMA_VERSION,
      kind: GOVERNANCE_PLAN_KIND,
      name,
      sequence: ++sequence,
      phase,
      status,
    });
    events.push(event);
    if (status === "succeeded") nextPhase += 1;
    return event;
  }

  return Object.freeze({
    start: (phase) => record(phase, "started"),
    succeed: (phase) => record(phase, "succeeded"),
    fail: (phase) => record(phase, "failed"),
    events: () => Object.freeze(events.slice()),
  });
}

/**
 * Consumers must never read an actively-produced store.  A completed writer
 * publishes atomically; an active one may be between its producer,
 * normalization, and commit steps, so it is refused rather than sampled.
 * Store freshness remains the responsibility of store-freshness-gate.mjs,
 * which compares each producer's scoped input digest.
 */
export function assertGovernanceConsumerReady({ consumer, evidenceStatus }) {
  if (!consumer) throw new GovernancePlanRefusal("consumer_name_required", "governance consumer precondition requires a consumer name");
  if (!evidenceStatus || evidenceStatus.ok !== true) {
    throw new GovernancePlanRefusal("producer_status_unavailable", `${consumer} cannot establish whether a governance evidence producer is active`);
  }
  if (evidenceStatus.held && evidenceStatus.delegated_read !== true) {
    // ADR-101 rule 2: reuse evidenceTransactionStatus's own owner/heartbeat
    // summary (`evidenceStatus.message`) rather than composing a shorter,
    // duplicate one from transaction_id/phase alone — that summary already
    // names the holder and its heartbeat age, and, for an
    // `unsupported_schema_version` lock, already says plainly that this is
    // a newer/older writer's healthy lock, not corruption.
    const phaseFragment = evidenceStatus.phase ? ` at ${evidenceStatus.phase}` : "";
    const detail = evidenceStatus.message ? ` — ${evidenceStatus.message}` : "";
    throw new GovernancePlanRefusal(
      "producer_incomplete",
      `${consumer} refuses derived governance evidence while transaction ${evidenceStatus.transaction_id ?? "unknown"} is active${phaseFragment}${detail}; wait for its atomic commit or recover it explicitly`,
      evidenceStatus,
    );
  }
  return Object.freeze({
    schema_version: GOVERNANCE_PLAN_SCHEMA_VERSION,
    kind: GOVERNANCE_PLAN_KIND,
    consumer,
    phase: "consumer",
    status: evidenceStatus.delegated_read === true ? "delegated_read_ready" : "ready",
  });
}
