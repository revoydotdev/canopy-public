/**
 * DevTools breakpoint registry (ADR-021).
 *
 * A pure, in-memory registry of parked breakpoints. Each breakpoint is a
 * typed predicate over `RuntimeEvent` + a Promise resolver. The registry
 * subscribes to `manager.subscribeEvents` and resolves a breakpoint when a
 * matching event fires.
 *
 * From ADR-021: a parked breakpoint is NOT mutable state that can wedge the
 * loop on restart. Breakpoints live only in this registry's in-memory map
 * and die with the process. The loop is unaffected — only the
 * `devtools_break_on` Promise is parked. `devtools_clear` evicts all parked
 * breakpoints for a campaign.
 */
import type { RuntimeEvent } from "@arbor/core";

export type DevToolsBreakpointKind =
  | "node_failed"
  | "node_verified"
  | "node_claimed"
  | "kb_entry_added"
  | "gate_failed"
  | "gate_passed"
  | "halt"
  | "campaign_changed"
  | "any";

/** The closed set of `park`-able kinds, for boundary validation (WA-11). */
export const DEVTOOLS_BREAKPOINT_KINDS: readonly DevToolsBreakpointKind[] = [
  "node_failed",
  "node_verified",
  "node_claimed",
  "kb_entry_added",
  "gate_failed",
  "gate_passed",
  "halt",
  "campaign_changed",
  "any",
];

export function isDevToolsBreakpointKind(value: unknown): value is DevToolsBreakpointKind {
  return typeof value === "string" && (DEVTOOLS_BREAKPOINT_KINDS as readonly string[]).includes(value);
}

/**
 * WA-11: a breakpoint with no caller-supplied `timeout_ms` used to park its
 * `match` Promise forever. Because the stdio JSON-RPC session serializes
 * every line through one `pending` chain (`cli.ts`'s `startStdioSession`), a
 * never-resolving `devtools_break_on` call wedges the whole session,
 * including `devtools_clear`. Every parked breakpoint now gets a real,
 * bounded timeout: the caller's value clamped to this ceiling, or the
 * default when omitted.
 */
export const DEVTOOLS_BREAKPOINT_DEFAULT_TIMEOUT_MS = 30_000;
export const DEVTOOLS_BREAKPOINT_MAX_TIMEOUT_MS = 30_000;

function boundedTimeoutMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return DEVTOOLS_BREAKPOINT_DEFAULT_TIMEOUT_MS;
  return Math.min(requested, DEVTOOLS_BREAKPOINT_MAX_TIMEOUT_MS);
}

export interface DevToolsBreakpointMatch {
  kind: DevToolsBreakpointKind;
  event: RuntimeEvent;
  ts: string;
}

export interface DevToolsBreakpointRegistration {
  id: string;
  kind: DevToolsBreakpointKind;
  campaign_id: string | null;
  registered_at: string;
  timeout_ms: number | null;
}

export interface RegisteredBreakpoint {
  registration: DevToolsBreakpointRegistration;
  resolve: (match: DevToolsBreakpointMatch) => void;
  reject: (reason: DevToolsBreakpointRejection) => void;
  timeout_handle: ReturnType<typeof setTimeout> | null;
}

export type DevToolsBreakpointRejection =
  | { kind: "timeout"; registration: DevToolsBreakpointRegistration }
  | { kind: "cleared"; registration: DevToolsBreakpointRegistration }
  | { kind: "aborted"; registration: DevToolsBreakpointRegistration };

/**
 * The registry. Construct one per runtime, subscribe it via
 * `manager.subscribeEvents(registry.onEvent)`, and call `park` to register
 * a breakpoint. The registry never throws on event inspection — a malformed
 * or unknown event simply does not match.
 */
export class BreakpointRegistry {
  private readonly breakpoints = new Map<string, RegisteredBreakpoint>();
  private sequence = 0;
  private readonly now: () => string;

  constructor(options: { now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Register a breakpoint and return a Promise that resolves with the
   * matching event (or rejects on timeout/clear/abort). The Promise is the
   * only side effect — the loop is never parked, only the caller's await.
   */
  park(input: {
    kind: DevToolsBreakpointKind;
    campaign_id?: string;
    timeout_ms?: number;
    signal?: AbortSignal;
  }): { registration: DevToolsBreakpointRegistration; match: Promise<DevToolsBreakpointMatch> } {
    const id = `bp_${(++this.sequence).toString(36)}`;
    const registration: DevToolsBreakpointRegistration = {
      id,
      kind: input.kind,
      campaign_id: input.campaign_id ?? null,
      registered_at: this.now(),
      timeout_ms: boundedTimeoutMs(input.timeout_ms),
    };
    let resolver: (match: DevToolsBreakpointMatch) => void;
    let rejecter: (reason: DevToolsBreakpointRejection) => void;
    const match = new Promise<DevToolsBreakpointMatch>((resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
    });
    const entry: RegisteredBreakpoint = {
      registration,
      resolve: (m: DevToolsBreakpointMatch) => {
        this.cleanup(id);
        resolver(m);
      },
      reject: (r: DevToolsBreakpointRejection) => {
        this.cleanup(id);
        rejecter(r);
      },
      timeout_handle: null,
    };
    if (registration.timeout_ms !== null && registration.timeout_ms > 0) {
      entry.timeout_handle = setTimeout(() => {
        entry.reject({ kind: "timeout", registration });
      }, registration.timeout_ms);
      entry.timeout_handle.unref?.();
    }
    if (input.signal) {
      if (input.signal.aborted) entry.reject({ kind: "aborted", registration });
      else input.signal.addEventListener("abort", () => entry.reject({ kind: "aborted", registration }), { once: true });
    }
    this.breakpoints.set(id, entry);
    return { registration, match };
  }

  /** Event sink — wire to `manager.subscribeEvents(registry.onEvent)`. */
  onEvent = (event: RuntimeEvent): void => {
    if (this.breakpoints.size === 0) return;
    for (const entry of [...this.breakpoints.values()]) {
      if (!this.matches(entry.registration, event)) continue;
      entry.resolve({ kind: entry.registration.kind, event, ts: this.now() });
    }
  };

  /** Evict and reject all breakpoints matching the optional campaign filter. */
  clear(campaign_id?: string): number {
    const matching = [...this.breakpoints.values()].filter((e) =>
      campaign_id === undefined || e.registration.campaign_id === null || e.registration.campaign_id === campaign_id,
    );
    for (const entry of matching) entry.reject({ kind: "cleared", registration: entry.registration });
    return matching.length;
  }

  /** Currently parked breakpoints (test/DI only). */
  pending(): readonly DevToolsBreakpointRegistration[] {
    return [...this.breakpoints.values()].map((e) => ({ ...e.registration }));
  }

  private matches(reg: DevToolsBreakpointRegistration, event: RuntimeEvent): boolean {
    if (reg.campaign_id !== null) {
      const eventCampaign = "campaign_id" in event ? (event.campaign_id as string | undefined) : undefined;
      if (eventCampaign !== reg.campaign_id) return false;
    }
    return kindMatches(reg.kind, event);
  }

  private cleanup(id: string): void {
    const entry = this.breakpoints.get(id);
    if (!entry) return;
    if (entry.timeout_handle !== null) clearTimeout(entry.timeout_handle);
    this.breakpoints.delete(id);
  }
}

/**
 * Map a breakpoint kind to the runtime event variants that satisfy it.
 * "any" matches every event variant.
 */
export function kindMatches(kind: DevToolsBreakpointKind, event: RuntimeEvent): boolean {
  if (kind === "any") return true;
  switch (event.kind) {
    case "tree.node_changed":
      if (kind === "node_failed" && event.state === "failed") return true;
      if (kind === "node_verified" && event.state === "verified") return true;
      if (kind === "node_claimed" && event.state === "claimed") return true;
      return false;
    case "kb.entry_added":
      return kind === "kb_entry_added";
    case "gate.recorded":
      if (kind === "gate_failed" && event.result === "fail") return true;
      if (kind === "gate_passed" && event.result === "pass") return true;
      return false;
    case "campaign.changed":
      if (kind === "halt" && event.change === "halted") return true;
      if (kind === "campaign_changed") return true;
      return false;
    default:
      return false;
  }
}
