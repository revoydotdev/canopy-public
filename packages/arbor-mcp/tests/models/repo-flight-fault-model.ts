/**
 * Executable finite-state safety model for the repository Flight Director.
 *
 * This is deliberately smaller than runtime state: it models only the fault
 * boundaries whose interleavings matter to the invariants below. Exhaustive
 * breadth-first exploration makes the transition relation executable in the
 * normal Vitest lane without introducing a model-checker runtime dependency.
 */

export type FaultModelSession = "live" | "ambiguous" | "dead_confirmed";
export type FaultModelDrain = "none" | "draining" | "quiesced";
export type FaultModelDelivery = "sent" | "delivered" | "acknowledged" | "applied";
export type FaultModelHolder = "none" | "agent_a" | "agent_b";

export interface RepoFlightFaultModelState {
  readonly holder: FaultModelHolder;
  readonly epoch: number;
  readonly agent_a_epoch: number;
  readonly agent_b_epoch: number;
  readonly drain: FaultModelDrain;
  readonly drain_acknowledged: boolean;
  readonly controller_up: boolean;
  readonly session: FaultModelSession;
  readonly session_fenced: boolean;
  readonly delivery: FaultModelDelivery;
  readonly delivery_ack_receipt: boolean;
}

export interface RepoFlightFaultModelReport {
  readonly explored_states: number;
  readonly explored_transitions: number;
  readonly violations: readonly string[];
}

type Action = { readonly name: string; readonly apply: (state: RepoFlightFaultModelState) => RepoFlightFaultModelState | null };

export const INITIAL_REPO_FLIGHT_FAULT_STATE: RepoFlightFaultModelState = Object.freeze({
  holder: "none", epoch: 0, agent_a_epoch: 0, agent_b_epoch: 0,
  drain: "none", drain_acknowledged: false, controller_up: true,
  session: "live", session_fenced: false, delivery: "sent", delivery_ack_receipt: false,
});

const ACTIONS: readonly Action[] = [
  acquire("agent_a"), acquire("agent_b"),
  { name: "release", apply: (state) => state.controller_up && state.holder !== "none" ? next(state, { holder: "none" }) : null },
  { name: "begin_drain", apply: (state) => state.controller_up && state.drain === "none" ? next(state, { drain: "draining", drain_acknowledged: state.holder === "none" }) : null },
  { name: "acknowledge_drain", apply: (state) => state.controller_up && state.drain === "draining" && state.holder !== "none" ? next(state, { drain_acknowledged: true }) : null },
  { name: "activate_quiescence", apply: (state) => state.controller_up && state.drain === "draining" && state.drain_acknowledged && state.holder === "none" ? next(state, { drain: "quiesced" }) : null },
  { name: "release_drain", apply: (state) => state.controller_up && state.drain !== "none" ? next(state, { drain: "none", drain_acknowledged: false }) : null },
  { name: "controller_crash", apply: (state) => state.controller_up ? next(state, { controller_up: false }) : null },
  { name: "controller_recover", apply: (state) => !state.controller_up ? next(state, { controller_up: true }) : null },
  { name: "pid_reuse", apply: (state) => state.session === "live" ? next(state, { session: "ambiguous", session_fenced: true }) : null },
  { name: "heartbeat", apply: (state) => state },
  { name: "identity_bound_death", apply: (state) => state.session === "live" ? next(state, { session: "dead_confirmed", session_fenced: true }) : null },
  { name: "deliver", apply: (state) => state.delivery === "sent" ? next(state, { delivery: "delivered" }) : null },
  { name: "acknowledge_delivery", apply: (state) => state.delivery === "delivered" ? next(state, { delivery: "acknowledged", delivery_ack_receipt: true }) : null },
  { name: "apply_delivery", apply: (state) => state.delivery === "acknowledged" ? next(state, { delivery: "applied" }) : null },
];

export function exploreRepoFlightFaultModel(maxDepth = 9): RepoFlightFaultModelReport {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 16) throw new Error("fault-model depth must be 1 through 16");
  const seen = new Map<string, { readonly state: RepoFlightFaultModelState; readonly depth: number; readonly trace: readonly string[] }>();
  const initialKey = key(INITIAL_REPO_FLIGHT_FAULT_STATE);
  seen.set(initialKey, { state: INITIAL_REPO_FLIGHT_FAULT_STATE, depth: 0, trace: [] });
  const queue = [initialKey]; let transitions = 0; const violations: string[] = [];
  while (queue.length > 0) {
    const currentKey = queue.shift()!, current = seen.get(currentKey)!;
    for (const failure of invariantFailures(current.state)) violations.push(`${failure}; trace=${current.trace.join(" -> ") || "initial"}`);
    if (current.depth >= maxDepth) continue;
    for (const action of ACTIONS) {
      const successor = action.apply(current.state); if (successor === null) continue; transitions++;
      const successorKey = key(successor); if (seen.has(successorKey)) continue;
      seen.set(successorKey, { state: successor, depth: current.depth + 1, trace: [...current.trace, action.name] }); queue.push(successorKey);
    }
  }
  return Object.freeze({ explored_states: seen.size, explored_transitions: transitions, violations: Object.freeze(violations) });
}

function acquire(holder: Exclude<FaultModelHolder, "none">): Action {
  return { name: `acquire_${holder}`, apply: (state) => {
    if (!state.controller_up || state.holder !== "none" || state.drain !== "none") return null;
    const epoch = state.epoch + 1;
    return holder === "agent_a" ? next(state, { holder, epoch, agent_a_epoch: epoch }) : next(state, { holder, epoch, agent_b_epoch: epoch });
  } };
}

function invariantFailures(state: RepoFlightFaultModelState): string[] {
  const failures: string[] = [];
  if (state.holder === "agent_a" && state.agent_a_epoch !== state.epoch) failures.push("agent_a holds a stale fence");
  if (state.holder === "agent_b" && state.agent_b_epoch !== state.epoch) failures.push("agent_b holds a stale fence");
  if (state.drain === "quiesced" && state.holder !== "none") failures.push("quiescence coexists with a mutator");
  if ((state.session === "ambiguous" || state.session === "dead_confirmed") && !state.session_fenced) failures.push("unsafe process identity is not fenced");
  if (state.delivery === "applied" && !state.delivery_ack_receipt) failures.push("delivery was applied without an acknowledgement receipt");
  return failures;
}

function next(state: RepoFlightFaultModelState, patch: Partial<RepoFlightFaultModelState>): RepoFlightFaultModelState { return Object.freeze({ ...state, ...patch }); }
function key(state: RepoFlightFaultModelState): string { return JSON.stringify(state); }
