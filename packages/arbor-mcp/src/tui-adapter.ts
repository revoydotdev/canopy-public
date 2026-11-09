/**
 * TUI runtime-port adapter (ADR-011 bridge).
 *
 * The TUI is a unidirectional projection over canonical runtime services: it
 * speaks only through a `RuntimePort` (command/query kinds locked to the
 * catalog's supported set) and never imports `@arbor/mcp`. This adapter is the
 * concrete bridge composed where the live runtime is composed: it implements
 * the `RuntimePort` shape over the `RuntimeCatalogRouter`, translating
 * TUI-shaped `{ kind, metadata, params }` requests into catalog envelopes and
 * mapping results/errors back.
 *
 * It lives in `@arbor/mcp` (the allowed mcp→tui direction) and deliberately
 * uses structural typing for the port surface so it carries no hard dependency
 * on `@arbor/tui` — the TUI defines the contract; this adapter fulfils it.
 */
import type { RuntimeCatalogRouter } from "./runtime-catalog.js";
import { LocalSessionAuthority, type LocalSessionIdentity } from "./local-session.js";
import { RUNTIME_PORT_LIMITS, type RuntimeError as TuiRuntimeError, type RuntimeEventSource } from "@arbor/tui";
import type { RuntimeCursor, RuntimeEventSubscription, RuntimeResumeResult, RuntimeSubscriptionOptions } from "@arbor/core";
import { readDevToolsLogTail } from "./devtools-log.js";
import type { CanopyDebugEventInput } from "./canopy-debug-capture.js";

/**
 * Optional launch-scoped sink for canopy-debug's durable telemetry journal.
 *
 * The adapter is the last common boundary for every TUI command/query. Keeping
 * the hook here means provider-facing calls are observed without making the
 * pure TUI package depend on the journal implementation. It is intentionally
 * structural so tests and embedders can provide a lightweight sink.
 */
export interface RuntimePortTelemetrySink {
  event(input: CanopyDebugEventInput): unknown;
}

/** Runtime errors stay structurally aligned with the TUI contract, including its versioned gate remedy. */
export type TuiPortError = Omit<TuiRuntimeError, "code"> & { readonly code: string };

export interface TuiPortCommandAcknowledgement {
  readonly accepted: boolean;
  readonly operation_id: string;
  readonly error?: TuiPortError;
}

export interface TuiPortResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: TuiPortError;
  readonly capability: string | null;
}

export interface TuiPort {
  command(request: { kind: string; metadata: { operation_id: string; idempotency_key: string; expected_version?: string }; params?: Record<string, unknown> }): Promise<TuiPortResult<TuiPortCommandAcknowledgement>>;
  query(request: { kind: string; query_id: string; params: Record<string, unknown> }): Promise<TuiPortResult<unknown>>;
  activeOperationCount(): number;
  /** Push a runtime or loop event into the in-memory devtools stream ring. */
  pushDevtoolsLine(line: DevtoolsStreamLine): void;
  /** Read all current devtools stream lines. */
  devtoolsStream(): DevtoolsStreamResult;
  /** M1.1 read-side event seam — see `RuntimeEventSource`'s doc comment in `@arbor/tui`. */
  readonly events: RuntimeEventSource;
}

/** One line in the devtools stream ring — matches the DevToolsLogLine contract. */
export interface DevtoolsStreamLine {
  seq: number;
  ts: string;
  event_kind: string;
  campaign_id: string | null;
  node_id: string | null;
  node_state?: string;
  synthetic: boolean;
  loop_event?: unknown;
}

/** The devtools.stream query result — the integration contract. */
export interface DevtoolsStreamResult {
  campaign_id: string | null;
  lines: readonly DevtoolsStreamLine[];
}

/** Maximum lines retained in the devtools in-memory ring. */
const DEVTOOLS_RING_CAPACITY = 200;

function toCommandEnvelope(input: { kind: string; metadata: { operation_id: string; idempotency_key: string; expected_version?: string }; params?: Record<string, unknown> }, session: LocalSessionIdentity): unknown {
  // TUI port carries minimal identity; the catalog requires the full metadata,
  // which the adapter supplies (ADR-011: adapter owns idempotency/capability/bounds).
  const meta = input.metadata as Record<string, unknown>;
  const params = { ...(input.params ?? {}) };
  // Actor-bearing approval fields are derived from the signing key, never
  // accepted as free-form TUI persona text.
  if (input.kind === "approval.request") params.proposer = session.actor_id;
  if (input.kind === "approval.approve" || input.kind === "approval.reject") params.actor = session.actor_id;
  // Promotion is a human authority decision.  The TUI never accepts a typed
  // display name as that authority; its signed local session is the only
  // identity it can truthfully present to the canonical catalog.
  if (input.kind === "harness.promote") params.human_approver = session.actor_id;
  if (input.kind === "recovery.abandon" && typeof params.authorization === "object" && params.authorization !== null) {
    params.authorization = { ...(params.authorization as Record<string, unknown>), authorized_by: session.actor_id };
  }
  if (input.kind === "harness.session.interrupt") {
    // The TUI owns no verification authority. Its interruption is a generated
    // operator request; the native worker later supplies the operational
    // terminal evidence when it observes the real AbortSignal.
    params.provenance = { tag: "generated", generator: "arbor-tui", input_hash: `tui:${input.metadata.operation_id}` };
  }
  const metadata = {
    operation_id: input.metadata.operation_id,
    idempotency_key: input.metadata.idempotency_key,
    correlation_id: `tui:${input.kind}:${input.metadata.operation_id}`,
    actor_id: session.actor_id,
    requested_at: new Date().toISOString(),
    ...(meta.expected_version !== undefined ? { expected_version: meta.expected_version } : {}),
  };
  return {
    schema_version: 1,
    metadata: {
      ...metadata,
      session: session.signCommand({ kind: input.kind, metadata, params }),
    },
    command: { kind: input.kind, ...params },
  };
}

function toQueryEnvelope(input: { kind: string; query_id: string; params: Record<string, unknown> }, session: LocalSessionIdentity): unknown {
  const params = { ...input.params };
  if (input.kind === "output.raw") params.session = session.signQuery({ kind: input.kind, query_id: input.query_id, params });
  return {
    schema_version: 1,
    query_id: input.query_id,
    query: { kind: input.kind, ...params },
  };
}

function mapResult<T>(result: { ok: boolean; value?: unknown; error?: TuiPortError; capability?: string | null }): TuiPortResult<T> {
  if (result.ok) return { ok: true, value: result.value as T, capability: result.capability ?? null };
  return { ok: false, error: result.error ?? { code: "internal", summary: "runtime call failed" }, capability: result.capability ?? null };
}

/**
 * Implements the `RuntimePort` contract over a `RuntimeCatalogRouter`.
 * The runtime router may perform durable planner/campaign transitions, so the
 * adapter awaits its command boundary before returning the acknowledgement
 * promised by the TUI-owned port contract.
 */
export class RuntimePortAdapter implements TuiPort {
  private readonly ring: DevtoolsStreamLine[] = [];
  private currentCampaignId: string | null = null;
  private telemetrySink: RuntimePortTelemetrySink | null = null;
  readonly events: RuntimeEventSource;

  constructor(
    private readonly router: RuntimeCatalogRouter,
    private readonly activeCount: () => number = () => 0,
    private readonly session: LocalSessionIdentity = new LocalSessionAuthority().identity(),
    /**
     * EC-063: the in-memory ring is only fed by callers that push into it
     * (the demo does; a real campaign run does not), so DevTools read
     * "0 events" for a run whose durable log held every one. When a log
     * path is known, `devtools.stream` replays its tail (ADR-021) and the
     * ring only adds lines the log does not carry.
     */
    private readonly devtoolsLogPath: string | null = null,
  ) {
    // `subscribe` opens a bounded handle straight on the runtime's own
    // stream (no catalog entry gates a raw poll/close handle — the same
    // reasoning `devtools.stream` documents above). `resume` deliberately
    // goes back through `this.query()` so `event.resume`'s real capability
    // check (`event.read`) still applies to the read side.
    this.events = {
      subscribe: (options?: RuntimeSubscriptionOptions): RuntimeEventSubscription => this.router.eventStream.subscribe(options),
      resume: async (cursor: RuntimeCursor | null): Promise<RuntimeResumeResult<unknown>> => {
        const effectiveCursor = cursor ?? { stream_id: this.router.eventStream.streamId, sequence: 0 };
        const result = await this.query({
          kind: "event.resume",
          query_id: `tui:event.resume:${Date.now()}:${Math.random().toString(36).slice(2)}`,
          params: { cursor: effectiveCursor },
        });
        if (!result.ok) throw new Error(result.error?.summary ?? "event.resume was denied");
        return result.value as RuntimeResumeResult<unknown>;
      },
    };
  }

  /** Attach/detach the journal after the TUI's launch-scoped session opens. */
  setTelemetrySink(sink: RuntimePortTelemetrySink | null): void {
    this.telemetrySink = sink;
  }

  private telemetry(input: CanopyDebugEventInput): void {
    try { this.telemetrySink?.event(input); } catch { /* telemetry must never break the operator path */ }
  }

  private static usageObservation(value: unknown, depth = 0): unknown {
    if (depth > 4 || value === null || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 32)) {
        const found = RuntimePortAdapter.usageObservation(item, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["token_usage", "usage", "usage_and_cost", "tokenUsage"]) {
      if (record[key] !== undefined) return record[key];
    }
    for (const item of Object.values(record).slice(0, 64)) {
      const found = RuntimePortAdapter.usageObservation(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private telemetryResponse(
    phase: "command" | "query",
    kind: string,
    correlationId: string,
    result: TuiPortResult<unknown>,
    startedAt: number,
  ): void {
    const payload: Record<string, unknown> = {
      phase, kind, ok: result.ok, capability: result.capability,
      duration_ms: Math.max(0, Date.now() - startedAt),
      ...(result.ok ? { value: result.value } : { error: result.error }),
    };
    this.telemetry({ kind: "api_response", level: result.ok ? "debug" : "warn", correlation_id: correlationId, payload });
    this.telemetry({ kind: "function_end", level: result.ok ? "trace" : "warn", correlation_id: correlationId, payload: { function: `runtime.${phase}`, kind, ok: result.ok, duration_ms: payload.duration_ms } });
    const usage = RuntimePortAdapter.usageObservation(result.ok ? result.value : result.error);
    if (usage !== undefined) {
      this.telemetry({ kind: "token_usage", level: "info", correlation_id: correlationId, payload: { available: true, source: "runtime_port_response", usage } });
    }
    const lower = kind.toLowerCase();
    if (lower.includes("mcp")) {
      this.telemetry({ kind: "mcp_call", level: result.ok ? "debug" : "warn", correlation_id: correlationId, payload: { phase, kind, ok: result.ok, value: result.ok ? result.value : result.error } });
    }
    if (lower.includes("skill")) {
      this.telemetry({ kind: "skill_load", level: result.ok ? "debug" : "warn", correlation_id: correlationId, payload: { phase, kind, ok: result.ok, value: result.ok ? result.value : result.error } });
    }
  }

  async command(request: { kind: string; metadata: { operation_id: string; idempotency_key: string; expected_version?: string }; params?: Record<string, unknown> }): Promise<TuiPortResult<TuiPortCommandAcknowledgement>> {
    const startedAt = Date.now();
    const correlationId = `tui:command:${request.metadata.operation_id}`;
    this.telemetry({ kind: "function_start", level: "trace", correlation_id: correlationId, payload: { function: "runtime.command", kind: request.kind } });
    this.telemetry({ kind: "api_request", level: "debug", correlation_id: correlationId, payload: { phase: "command", kind: request.kind, operation_id: request.metadata.operation_id, params: request.params ?? {} } });
    const diagnostic = validateCommandRequest(request);
    if (diagnostic !== null) {
      const result = { ok: false as const, error: { code: "validation", summary: diagnostic }, capability: null };
      this.telemetryResponse("command", request.kind, correlationId, result, startedAt);
      return result;
    }
    const envelope = toCommandEnvelope(request, this.session);
    try {
      const result = await this.router.dispatchCommand(envelope);
      const mapped: TuiPortResult<TuiPortCommandAcknowledgement> = result.ok
        ? (() => { const ack = result.value as { accepted: boolean; operation_id: string; error?: TuiPortError }; return { ok: true, value: { accepted: ack.accepted, operation_id: ack.operation_id, error: ack.error }, capability: result.capability }; })()
        : { ok: false, error: result.error, capability: result.capability };
      this.telemetryResponse("command", request.kind, correlationId, mapped as TuiPortResult<unknown>, startedAt);
      return mapped;
    } catch (error) {
      this.telemetry({ kind: "error", level: "error", correlation_id: correlationId, payload: { phase: "command", kind: request.kind, message: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }

  async query(request: { kind: string; query_id: string; params: Record<string, unknown> }): Promise<TuiPortResult<unknown>> {
    const startedAt = Date.now();
    const correlationId = `tui:query:${request.query_id}`;
    this.telemetry({ kind: "function_start", level: "trace", correlation_id: correlationId, payload: { function: "runtime.query", kind: request.kind } });
    this.telemetry({ kind: "api_request", level: "debug", correlation_id: correlationId, payload: { phase: "query", kind: request.kind, query_id: request.query_id, params: request.params } });
    const diagnostic = validateQueryRequest(request);
    if (diagnostic !== null) {
      const result = { ok: false as const, error: { code: "validation", summary: diagnostic }, capability: null };
      this.telemetryResponse("query", request.kind, correlationId, result, startedAt);
      return result;
    }
    // CS-11: devtools.stream deliberately bypasses `RuntimeCatalogRouter`.
    // Assessed and justified, not an oversight:
    //   - `this.ring` is this adapter INSTANCE's own in-memory buffer,
    //     populated by `pushDevtoolsLine` calls from the executor loops
    //     (opencode-executor.ts, opencode-server-executor.ts) running in
    //     THIS SAME process. It is not campaign/governance state — the
    //     router (and the `ArborRuntime`/`CampaignManager` it wraps) has no
    //     model for "the current process's own live debug log" and folding
    //     it in would mean either persisting ephemeral log lines as durable
    //     runtime state (wrong shape for what this is — a tail, not a
    //     ledger) or giving the router a back-reference to this adapter,
    //     inverting the ADR-011 direction this file's own header documents
    //     (adapter wraps router, never the reverse).
    //   - No RUNTIME_CATALOG entry declares "devtools.stream" at all (grep
    //     confirms), so there is no catalog authorization check being
    //     skipped here — there was never one to skip.
    //   - The capability gate that matters (`devtools.read`) is still real:
    //     it is enforced one layer up, at TUI screen availability
    //     (`required_capabilities` + `grants_updated` in tui.ts, which
    //     grants it unconditionally alongside the catalog's own supported
    //     capabilities specifically because this query has no catalog
    //     entry to derive it from). A catalog-level check here would be
    //     theater: `runTui` is a single-operator local terminal process —
    //     any caller able to invoke `adapter.query()` directly is already
    //     running inside the same process as the ring it would be reading.
    if (request.kind === "devtools.stream") {
      const result = {
        ok: true,
        value: this.devtoolsStream(),
        capability: "devtools.read",
      };
      this.telemetryResponse("query", request.kind, correlationId, result, startedAt);
      return result;
    }
    const envelope = toQueryEnvelope(request, this.session);
    const result = this.router.executeQuery(envelope);
    const mapped = mapResult<unknown>(result);
    this.telemetryResponse("query", request.kind, correlationId, mapped, startedAt);
    return mapped;
  }

  activeOperationCount(): number {
    return this.activeCount();
  }

  /** Set the current campaign for the devtools stream ring. */
  setCampaignId(id: string | null): void {
    this.currentCampaignId = id;
  }

  /** Push a runtime or loop event into the devtools in-memory ring. */
  pushDevtoolsLine(line: DevtoolsStreamLine): void {
    this.ring.push(line);
    if (this.ring.length > DEVTOOLS_RING_CAPACITY) {
      this.ring.shift();
    }
  }

  /** Read all current devtools stream lines (most recent first for TUI display). */
  devtoolsStream(): DevtoolsStreamResult {
    const durable: DevtoolsStreamLine[] = this.devtoolsLogPath === null ? [] : readDevToolsLogTail(this.devtoolsLogPath, DEVTOOLS_RING_CAPACITY).map((line) => ({
      seq: line.seq,
      ts: line.ts,
      event_kind: line.event_kind,
      campaign_id: line.campaign_id,
      node_id: line.node_id,
      synthetic: line.synthetic,
      loop_event: line.loop_event ?? line.event,
    }));
    const seen = new Set(durable.map((line) => `${line.seq}|${line.ts}|${line.event_kind}`));
    const merged = [...durable, ...this.ring.filter((line) => !seen.has(`${line.seq}|${line.ts}|${line.event_kind}`))];
    return {
      campaign_id: this.currentCampaignId,
      lines: merged.slice(Math.max(0, merged.length - DEVTOOLS_RING_CAPACITY)),
    };
  }
}

/** Keeps the concrete adapter aligned with the TUI-owned port contract. */
function validateCommandRequest(request: { metadata: { operation_id: string; idempotency_key: string }; params?: Record<string, unknown> }): string | null {
  if (request.metadata.operation_id.length > RUNTIME_PORT_LIMITS.max_operation_id_length) return "operation_id exceeds runtime-port limit";
  if (request.metadata.idempotency_key.length > RUNTIME_PORT_LIMITS.max_idempotency_key_length) return "idempotency_key exceeds runtime-port limit";
  if (Object.keys(request.params ?? {}).length > RUNTIME_PORT_LIMITS.max_command_params) return "command params exceed runtime-port limit";
  return null;
}

function validateQueryRequest(request: { query_id: string; params: Record<string, unknown> }): string | null {
  if (request.query_id.length > RUNTIME_PORT_LIMITS.max_operation_id_length) return "query_id exceeds runtime-port limit";
  if (Object.keys(request.params).length > RUNTIME_PORT_LIMITS.max_query_params) return "query params exceed runtime-port limit";
  return null;
}
