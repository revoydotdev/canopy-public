// Fixture stub: the campaign hook contracts, in the exact shapes the gate reads.
// A native repository-session lifecycle says nothing about these, which is the
// point — they are invariants about the CAMPAIGN plane and must survive the port.
export type HookLifecycleEvent = "session_start" | "session_end" | "node_start" | "node_end" | "plan_confirm" | "interruption";

export const HOOK_VETO_EVENTS = Object.freeze(["tool_preflight"] as const);
export const HOOK_LIFECYCLE_EVENTS = Object.freeze(["session_start", "session_end", "node_start", "node_end", "plan_confirm", "interruption"] as const);
export const HOOK_LIFECYCLE_VETO_EVENT: HookLifecycleEvent = "session_start";

export interface HookLifecycleContext {
  readonly event: HookLifecycleEvent;
  readonly session_id: string;
}
export type HookObserveOutcome = Readonly<{ note?: string }> | void;
export type HookLifecycleObserveHandler = (context: HookLifecycleContext) => HookObserveOutcome;