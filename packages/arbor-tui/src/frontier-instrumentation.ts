/**
 * Small, composition-owned measurement foundation for the frontier operator
 * projection.  This module does not subscribe to runtime facts, alter the
 * renderer, or write diagnostics: callers supply observations at their real
 * boundaries and may retain the resulting bounded receipts as run evidence.
 *
 * In particular, a renderer invocation finishing is not evidence that a frame
 * reached a terminal.  Only `observeRendererCommit` records that stronger
 * boundary, and it is intentionally named for a renderer-native observer.
 */

export interface InstrumentationClock {
  now(): number;
}

export interface OperatorMetricObserver {
  observe(receipt: OperatorMetricReceipt): void;
}

export type LatencyOrigin = "input" | "canonical_event";
export type OperatorMetric =
  | "input_to_projection_ms"
  | "canonical_event_to_projection_ms"
  | "input_to_renderer_commit_ms"
  | "canonical_event_to_renderer_commit_ms"
  | "renderer_invocation_ms"
  | "queue_retention_high_water"
  | "resource_settlement"
  | "accessibility_capability";

export type ReceiptState = "observed" | "inconclusive";
export type ResourceSettlement = "settled" | "pending" | "unknown";

export interface LatencyObservation {
  readonly origin: LatencyOrigin;
  readonly correlation_id: string;
  readonly observed_at_ms: number;
}

export interface RenderInvocation {
  readonly started_at_ms: number;
}

export interface QueueRetentionSnapshot {
  readonly pending?: number;
  readonly retained_rows?: number;
  readonly retained_bytes?: number;
}

export interface QueueRetentionHighWater {
  readonly pending: number | null;
  readonly retained_rows: number | null;
  readonly retained_bytes: number | null;
}

export interface ResourceSettlementFacts {
  /** The explicit composition-owned scope, never an inferred process-wide count. */
  readonly expected_resource_ids: readonly string[];
  readonly active_resource_ids: readonly string[];
  readonly settlement: ResourceSettlement;
}

export interface AccessibilityCapabilityFacts {
  readonly color_mode?: "truecolor" | "ansi256" | "none";
  readonly unicode?: boolean;
  readonly reduced_motion?: boolean;
  readonly tty?: boolean;
}

export interface OperatorMetricReceipt {
  readonly sequence: number;
  readonly metric: OperatorMetric;
  readonly state: ReceiptState;
  readonly measured_at_ms: number;
  readonly correlation_id?: string;
  readonly duration_ms?: number;
  readonly reason?: string;
  readonly queue_high_water?: QueueRetentionHighWater;
  readonly resources?: ResourceSettlementFacts;
  readonly accessibility?: AccessibilityCapabilityFacts;
}

export interface FrontierInstrumentationOptions {
  readonly clock: InstrumentationClock;
  readonly observer?: OperatorMetricObserver;
  /** Bounded in-process evidence. Values above 512 are clamped deliberately. */
  readonly receipt_limit?: number;
}

const DEFAULT_RECEIPT_LIMIT = 64;
const MAX_RECEIPT_LIMIT = 512;

/**
 * Receipts are measurements, not budget verdicts. A caller decides whether a
 * measured duration satisfies a program budget; an unavailable boundary is
 * represented explicitly as `inconclusive` rather than as a passing zero.
 */
export class FrontierInstrumentation {
  private readonly receiptsBuffer: OperatorMetricReceipt[] = [];
  private readonly resources = new Map<string, string>();
  private readonly receiptLimit: number;
  private sequence = 0;
  private evictedReceiptCount = 0;
  private queueHighWater: QueueRetentionHighWater = {
    pending: null,
    retained_rows: null,
    retained_bytes: null,
  };

  constructor(private readonly options: FrontierInstrumentationOptions) {
    this.receiptLimit = boundedLimit(options.receipt_limit ?? DEFAULT_RECEIPT_LIMIT);
  }

  beginLatency(origin: LatencyOrigin, correlationId: string): LatencyObservation {
    requireNonEmpty(correlationId, "correlationId");
    return { origin, correlation_id: correlationId, observed_at_ms: this.options.clock.now() };
  }

  observeProjection(observation: LatencyObservation): OperatorMetricReceipt {
    return this.emit({
      metric: projectionMetric(observation.origin),
      state: "observed",
      correlation_id: observation.correlation_id,
      duration_ms: elapsed(this.options.clock.now(), observation.observed_at_ms),
    });
  }

  /**
   * Use only from a renderer-provided commit/present callback. A successful
   * call to `RendererPort.render()` is not enough to call this method.
   */
  observeRendererCommit(observation: LatencyObservation): OperatorMetricReceipt {
    return this.emit({
      metric: commitMetric(observation.origin),
      state: "observed",
      correlation_id: observation.correlation_id,
      duration_ms: elapsed(this.options.clock.now(), observation.observed_at_ms),
    });
  }

  /** Records why commit latency cannot be claimed for this particular fact. */
  rendererCommitInconclusive(observation: LatencyObservation, reason = "no renderer commit observer is installed"): OperatorMetricReceipt {
    requireNonEmpty(reason, "reason");
    return this.emit({
      metric: commitMetric(observation.origin),
      state: "inconclusive",
      correlation_id: observation.correlation_id,
      reason,
    });
  }

  beginRendererInvocation(): RenderInvocation {
    return { started_at_ms: this.options.clock.now() };
  }

  /** Times only the synchronous/awaited renderer invocation boundary, not presentation. */
  observeRendererInvocation(invocation: RenderInvocation): OperatorMetricReceipt {
    return this.emit({
      metric: "renderer_invocation_ms",
      state: "observed",
      duration_ms: elapsed(this.options.clock.now(), invocation.started_at_ms),
    });
  }

  observeQueueRetention(snapshot: QueueRetentionSnapshot): OperatorMetricReceipt {
    const pending = measuredCount(snapshot.pending, "pending");
    const retainedRows = measuredCount(snapshot.retained_rows, "retained_rows");
    const retainedBytes = measuredCount(snapshot.retained_bytes, "retained_bytes");
    if (pending === null && retainedRows === null && retainedBytes === null) {
      return this.emit({
        metric: "queue_retention_high_water",
        state: "inconclusive",
        reason: "queue and retention counters were not supplied",
        queue_high_water: this.queueHighWater,
      });
    }
    this.queueHighWater = {
      pending: highWater(this.queueHighWater.pending, pending),
      retained_rows: highWater(this.queueHighWater.retained_rows, retainedRows),
      retained_bytes: highWater(this.queueHighWater.retained_bytes, retainedBytes),
    };
    return this.emit({ metric: "queue_retention_high_water", state: "observed", queue_high_water: this.queueHighWater });
  }

  observeResourceAcquired(resourceId: string, resourceKind: string): OperatorMetricReceipt {
    requireNonEmpty(resourceId, "resourceId");
    requireNonEmpty(resourceKind, "resourceKind");
    if (this.resources.has(resourceId)) {
      return this.emit({
        metric: "resource_settlement",
        state: "inconclusive",
        reason: `resource '${resourceId}' is already tracked as active`,
      });
    }
    this.resources.set(resourceId, resourceKind);
    this.resourceIdsEverObserved.add(resourceId);
    return this.emit({ metric: "resource_settlement", state: "observed" });
  }

  observeResourceReleased(resourceId: string): OperatorMetricReceipt {
    requireNonEmpty(resourceId, "resourceId");
    if (!this.resources.delete(resourceId)) {
      return this.emit({
        metric: "resource_settlement",
        state: "inconclusive",
        reason: `resource '${resourceId}' has no tracked acquisition`,
      });
    }
    return this.emit({ metric: "resource_settlement", state: "observed" });
  }

  /**
   * Makes a scoped cleanup fact. No scope means the process-wide cleanup claim
   * is unknown; an empty active set becomes `settled` only for supplied IDs.
   */
  observeResourceSettlement(expectedResourceIds?: readonly string[]): OperatorMetricReceipt {
    if (expectedResourceIds === undefined) {
      return this.emit({
        metric: "resource_settlement",
        state: "inconclusive",
        reason: "expected resource scope was not supplied",
        resources: { expected_resource_ids: [], active_resource_ids: [], settlement: "unknown" },
      });
    }
    const expected = uniqueIds(expectedResourceIds);
    const missing = expected.filter((id) => !this.resources.has(id) && !this.hasObservedResource(id));
    if (missing.length > 0) {
      return this.emit({
        metric: "resource_settlement",
        state: "inconclusive",
        reason: `expected resource observations are missing: ${missing.join(", ")}`,
        resources: { expected_resource_ids: expected, active_resource_ids: [], settlement: "unknown" },
      });
    }
    const active = expected.filter((id) => this.resources.has(id));
    return this.emit({
      metric: "resource_settlement",
      state: "observed",
      resources: {
        expected_resource_ids: expected,
        active_resource_ids: active,
        settlement: active.length === 0 ? "settled" : "pending",
      },
    });
  }

  observeAccessibilityCapabilities(facts: AccessibilityCapabilityFacts): OperatorMetricReceipt {
    if (Object.keys(facts).length === 0) {
      return this.emit({ metric: "accessibility_capability", state: "inconclusive", reason: "no accessibility or reduced-capability facts were supplied" });
    }
    return this.emit({ metric: "accessibility_capability", state: "observed", accessibility: { ...facts } });
  }

  receipts(): readonly OperatorMetricReceipt[] { return [...this.receiptsBuffer]; }
  evictedReceipts(): number { return this.evictedReceiptCount; }

  private hasObservedResource(resourceId: string): boolean {
    // The active map alone cannot distinguish a released resource from an
    // unseen one. Keep this separate from the bounded receipt ring so receipt
    // eviction never turns a once-observed resource into invented unknownness.
    return this.resourceIdsEverObserved.has(resourceId);
  }

  private readonly resourceIdsEverObserved = new Set<string>();

  private emit(receipt: Omit<OperatorMetricReceipt, "sequence" | "measured_at_ms">): OperatorMetricReceipt {
    const complete: OperatorMetricReceipt = {
      ...receipt,
      sequence: this.sequence + 1,
      measured_at_ms: this.options.clock.now(),
    };
    this.sequence = complete.sequence;
    if (this.receiptsBuffer.length === this.receiptLimit) {
      this.receiptsBuffer.shift();
      this.evictedReceiptCount += 1;
    }
    this.receiptsBuffer.push(complete);
    this.options.observer?.observe(complete);
    return complete;
  }
}

function projectionMetric(origin: LatencyOrigin): OperatorMetric {
  return origin === "input" ? "input_to_projection_ms" : "canonical_event_to_projection_ms";
}

function commitMetric(origin: LatencyOrigin): OperatorMetric {
  return origin === "input" ? "input_to_renderer_commit_ms" : "canonical_event_to_renderer_commit_ms";
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("receipt_limit must be a positive safe integer");
  return Math.min(value, MAX_RECEIPT_LIMIT);
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be non-empty`);
}

function measuredCount(value: number | undefined, name: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function highWater(previous: number | null, current: number | null): number | null {
  if (current === null) return previous;
  return previous === null ? current : Math.max(previous, current);
}

function elapsed(now: number, started: number): number {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(started)) throw new Error("clock must return safe integer milliseconds");
  return Math.max(0, now - started);
}

function uniqueIds(ids: readonly string[]): string[] {
  const result = new Set<string>();
  for (const id of ids) {
    requireNonEmpty(id, "resource id");
    result.add(id);
  }
  return [...result];
}
