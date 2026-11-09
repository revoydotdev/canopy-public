/**
 * narration.ts — ledger events, rendered as sentences an operator can read.
 *
 * WHY THIS EXISTS. A 25-minute recording of a real governed campaign showed the
 * cockpit's activity line unchanged from minute 1 to minute 25. In that window
 * nine nodes were seeded, one was decomposed into three, four specialists and
 * three critics were dispatched, one node was rejected and backtracked, and two
 * were claimed. Every one of those events reached the adjacent debug pane — as
 * raw machine projections:
 *
 *   2026-08-27T18:31:51.010Z  loop.node_claimed  c=demo-0-mtbu8sak  n=node_mtbuskcf_a
 *
 * The data was never missing. What was missing was anything that turned it into
 * a sentence. This module is that, and nothing more: it decides what is worth
 * saying and how to say it, and constructs no state of its own.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never invents progress. A specialist
 * turn can run fifteen minutes emitting nothing, and the honest signal for that
 * is elapsed time since the last real event — not a bar, not a percentage, not
 * an ETA. The system has no fractional-progress signal for a model turn, and
 * rendering one would be fabricating certainty it does not have.
 *
 * It also does not duplicate `screens/devtools.ts`, which owns the raw table,
 * its columns and its row identities. The shared vocabulary — `eventKindClass`,
 * `eventClassColor` — lives in `player-piano.ts` and is reused here rather than
 * restated, so the narrated view and the raw view can never disagree about what
 * class an event belongs to.
 */

/** One narrated lifecycle beat: a title, and an optional supporting detail. */
export interface LifecycleNarration {
  readonly title: string;
  readonly detail: string | null;
}

/** A node id is machine identity; show its tail so a human can still match rows. */
function shortNode(nodeId: string | null): string {
  if (nodeId === null || nodeId === "") return "campaign";
  const tail = nodeId.split("_").at(-1) ?? nodeId;
  return tail.length >= 2 ? `node ${tail}` : `node ${nodeId}`;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function suppliedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Shared operator vocabulary for lifecycle events shown by both the compact
 * cockpit narration and the unified Console timeline. It only names facts
 * carried by the event: roles, gates, node identity and reasons are never
 * inferred. A null result means structural bookkeeping, not missing data.
 */
export function lifecycleNarration(
  eventKind: string,
  loopEvent: unknown,
  nodeId: string | null,
): LifecycleNarration | null {
  const payload = record(loopEvent);
  const subject = shortNode(nodeId);
  const suppliedAgent = suppliedText(payload?.["agent"]);
  const reason = suppliedText(payload?.["reason"]) ?? suppliedText(payload?.["root_cause"]);
  switch (eventKind) {
    case "loop.campaign_start":
      return { title: "starting governed campaign", detail: null };
    case "loop.decomposed":
    case "tree.decomposed":
      return { title: "expanding plan into tasks", detail: subject };
    case "loop.specialist_dispatched":
      return {
        title: suppliedAgent === null
          ? "dispatching specialist through flight control"
          : `dispatching ${suppliedAgent} through flight control`,
        detail: subject,
      };
    case "loop.critic_dispatched":
      return {
        title: suppliedAgent === null ? "dispatching Lenticel review" : `dispatching ${suppliedAgent} review`,
        detail: subject,
      };
    case "loop.node_claimed":
      return { title: "claim recorded", detail: subject };
    case "loop.node_verified":
      return { title: "verification passed", detail: subject };
    case "loop.node_failed":
      return { title: "Lenticel rejected node", detail: reason ?? subject };
    case "loop.backtracked":
      return { title: "backtracking to next approach", detail: subject };
    case "loop.halt":
      return { title: "campaign halted", detail: reason };
    case "gate.recorded": {
      const gate = suppliedText(payload?.["gate"]);
      const result = suppliedText(payload?.["result"]);
      if (gate === null) return null;
      return {
        title: result === "pass" ? `${gate} gate passed` : result === "fail" ? `${gate} gate failed` : `${gate} gate recorded`,
        detail: null,
      };
    }
    case "stream.truncated":
      return { title: "event stream truncated — older events dropped", detail: null };
    default:
      return null;
  }
}
