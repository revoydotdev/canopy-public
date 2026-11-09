/**
 * CANARY STUB — not the real `packages/arbor-mcp/src/hooks/contracts.ts`.
 *
 * The gate reads the declared event sets here to resolve which events a
 * `HookBus` seam that takes a typed `event` parameter can dispatch. Without
 * this file the gate would report `native_source_unreadable` and the census
 * would read a canary that fails for two reasons as proof of one.
 */
export const HOOK_VETO_EVENTS = Object.freeze(["tool_preflight"] as const);
export const HOOK_OBSERVE_EVENTS = Object.freeze(["tool_audit", "tool_write", "phase", "ledger_transition", "user_prompt_submit", "pre_compact", "notification", "turn_end"] as const);
export const HOOK_LIFECYCLE_EVENTS = Object.freeze(["session_start", "session_end", "node_start", "node_end", "plan_confirm", "interruption"] as const);
export const HOOK_INJECT_EVENTS = Object.freeze([...HOOK_LIFECYCLE_EVENTS, "turn_end"] as const);
export const HOOK_LIFECYCLE_VETO_EVENT: HookLifecycleEvent = "session_start";