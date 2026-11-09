import {
  HARNESS_PROTOCOL_VERSION,
  type Completion,
  type EventEnvelope,
  type ExecutionPolicy,
  type NativeSessionEngineOptions,
  type SessionEvent,
  type SessionEventInput,
  type SessionInspection,
  type SessionLineage,
  type SessionStartRequest,
  type SessionState,
  type TerminalEvent,
} from "./protocol.js";
import {
  isHarnessCapability,
  isSupportGrade,
  negotiateCapabilities,
  type CapabilityRequirement,
  type CapabilitySupport,
} from "./capabilities.js";

export class HarnessAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessAdmissionError";
  }
}

export class HarnessSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessSessionError";
  }
}

interface StoredSession {
  readonly id: string;
  readonly policy: ExecutionPolicy;
  readonly capabilities: readonly CapabilitySupport[];
  readonly lineage: SessionLineage;
  readonly ephemeral: boolean;
  readonly started_at_ms: number;
  state: SessionState;
  readonly events: SessionEvent[];
  terminal: TerminalEvent["payload"] | null;
}

/**
 * Deterministic, in-process implementation of the mandatory harness kernel.
 * It intentionally executes no model or tool: recording a tool intent is the
 * policy boundary this reference implementation can enforce truthfully.
 */
export class NativeSessionEngine {
  private readonly capabilities: readonly CapabilitySupport[];
  private readonly clock: NativeSessionEngineOptions["clock"];
  private readonly onEvent: NativeSessionEngineOptions["on_event"];
  private readonly continuationAuthority: NativeSessionEngineOptions["continuation_authority"];
  private readonly sessions = new Map<string, StoredSession>();

  constructor(options: NativeSessionEngineOptions) {
    this.capabilities = freezeCapabilities(options.capabilities);
    this.clock = options.clock;
    this.onEvent = options.on_event;
    this.continuationAuthority = options.continuation_authority;
  }

  start(request: SessionStartRequest): SessionInspection {
    assertNonEmpty(request.session_id, "session_id");
    if (this.sessions.has(request.session_id)) throw new HarnessAdmissionError(`session already exists: ${request.session_id}`);
    const policy = freezePolicy(request.policy);
    validatePolicy(policy);
    this.validateCapabilities(request.required_capabilities, request.lineage, request.ephemeral);
    this.validateLineage(request.lineage, request.session_id);

    const startedAt = this.now();
    const session: StoredSession = {
      id: request.session_id,
      policy,
      capabilities: this.capabilities,
      lineage: freezeLineage(request.lineage),
      ephemeral: request.ephemeral,
      started_at_ms: startedAt,
      state: "running",
      events: [],
      terminal: null,
    };
    this.sessions.set(session.id, session);
    this.append(session, "lifecycle", {
      state: "started", lineage: session.lineage, ephemeral: session.ephemeral,
      ...(request.model_identity === undefined ? {} : { model_identity: freezeModelIdentity(request.model_identity) }),
    });
    return this.inspect(session.id);
  }

  observe(sessionId: string, afterSequence = 0): readonly SessionEvent[] {
    const session = this.requireSession(sessionId);
    this.enforceWallClock(session);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new HarnessSessionError("checkpoint must be a non-negative safe integer");
    return Object.freeze(session.events.filter((event) => event.sequence > afterSequence).slice());
  }

  inspect(sessionId: string): SessionInspection {
    const session = this.requireSession(sessionId);
    this.enforceWallClock(session);
    return Object.freeze({
      session_id: session.id,
      state: session.state,
      policy: session.policy,
      capabilities: session.capabilities,
      lineage: session.lineage,
      ephemeral: session.ephemeral,
      latest_sequence: session.events.length,
      terminal: session.terminal,
    });
  }

  /** A control-plane interruption settles at this deterministic safe boundary. */
  interrupt(sessionId: string, reason: string): SessionInspection {
    const session = this.requireActive(sessionId);
    assertNonEmpty(reason, "interrupt reason");
    this.enforceWallClock(session);
    if (isTerminal(session.state)) return this.inspect(sessionId);
    session.state = "interrupt_requested";
    // Preserve an operator-requested stop even at the final event slot.  The
    // request event is useful evidence when there is room; the terminal fact
    // takes precedence over producing an event-limit failure instead.
    if (session.events.length + 2 <= session.policy.max_events) {
      this.append(session, "interrupt_requested", { reason });
    }
    this.terminal(session, "interrupted", "interrupted", reason);
    return this.inspect(sessionId);
  }

  /** Record a canonical non-terminal event after policy and bounds enforcement. */
  record(sessionId: string, input: SessionEventInput): SessionInspection {
    const session = this.requireActive(sessionId);
    this.enforceWallClock(session);
    if (isTerminal(session.state)) return this.inspect(sessionId);
    if (input.kind === "tool_intent" && !isToolPermitted(session.policy, input.payload.tool)) {
      throw new HarnessSessionError(`tool denied by immutable policy: ${input.payload.tool}`);
    }
    this.appendWithinLimit(session, input.kind, input.payload);
    return this.inspect(sessionId);
  }

  /**
   * Completion records precisely the supplied provenance.  A claimed result
   * cannot be upgraded, and operational termination never fabricates one.
   */
  complete(sessionId: string, completion: Completion): SessionInspection {
    const session = this.requireActive(sessionId);
    this.enforceWallClock(session);
    if (isTerminal(session.state)) return this.inspect(sessionId);
    assertNonEmpty(completion.message, "completion message");
    const state = completion.result === "failed" ? "failed" : "completed";
    this.terminal(session, state, completion.result === "failed" ? "failed" : "completed", completion.message, completion);
    return this.inspect(sessionId);
  }

  /**
   * Settle an operational failure without inventing completion provenance.
   * Execution ports use this for transport, policy, and adapter failures;
   * callers use `complete` only when they actually possess a result claim.
   */
  fail(sessionId: string, message: string): SessionInspection {
    const session = this.requireActive(sessionId);
    this.enforceWallClock(session);
    if (isTerminal(session.state)) return this.inspect(sessionId);
    assertNonEmpty(message, "failure message");
    this.terminal(session, "failed", "failed", message);
    return this.inspect(sessionId);
  }

  private validateCapabilities(requirements: readonly CapabilityRequirement[], lineage: SessionLineage, ephemeral: boolean): void {
    const automatic: CapabilityRequirement[] = [];
    if (lineage.kind === "resume" || lineage.kind === "continuation") automatic.push({ capability: "resumption", minimum_grade: "governed" });
    if (lineage.kind === "fork") automatic.push({ capability: "forking", minimum_grade: "governed" });
    if (ephemeral) automatic.push({ capability: "ephemeral_sessions", minimum_grade: "governed" });
    const negotiation = negotiateCapabilities([...requirements, ...automatic], this.capabilities, {
      now: () => new Date(this.now()),
    });
    if (!negotiation.admitted) {
      const failure = negotiation.rejected[0]!;
      throw new HarnessAdmissionError(`required capability rejected (${failure.reason}): ${failure.requirement.capability}`);
    }
  }

  private validateLineage(lineage: SessionLineage, sessionId: string): void {
    if (lineage.kind === "new") return;
    assertNonEmpty(lineage.source_session_id, "source_session_id");
    if (!Number.isSafeInteger(lineage.checkpoint) || lineage.checkpoint < 0) throw new HarnessAdmissionError("lineage checkpoint must be a non-negative safe integer");
    if (lineage.kind === "continuation") {
      assertNonEmpty(lineage.authorization_id, "continuation authorization_id");
      if (this.continuationAuthority?.(lineage, sessionId) !== true) throw new HarnessAdmissionError("continuation lineage lacks fresh durable authority");
      return;
    }
    const source = this.sessions.get(lineage.source_session_id);
    if (source === undefined) throw new HarnessAdmissionError(`lineage source does not exist: ${lineage.source_session_id}`);
    if (source.ephemeral) throw new HarnessAdmissionError("an ephemeral session cannot be resumed or forked");
    if (lineage.checkpoint > source.events.length) throw new HarnessAdmissionError("lineage checkpoint exceeds source replay");
    if (lineage.kind === "resume" && !isTerminal(source.state)) throw new HarnessAdmissionError("resumption requires a terminal source session");
  }

  private enforceWallClock(session: StoredSession): void {
    if (!isTerminal(session.state) && this.now() - session.started_at_ms > session.policy.max_wall_clock_ms) {
      this.terminal(session, "failed", "wall_clock_limit", "session wall-clock limit exceeded");
    }
  }

  private appendWithinLimit<K extends SessionEvent["kind"]>(session: StoredSession, kind: K, payload: PayloadFor<K>): void {
    // Reserve one slot for a terminal event. A normal event never leaves a
    // session unable to record why it stopped.
    if (session.events.length + 2 > session.policy.max_events) {
      this.terminal(session, "failed", "event_limit", "session event limit exceeded");
      return;
    }
    this.append(session, kind, payload);
  }

  private terminal(
    session: StoredSession,
    state: Extract<SessionState, "completed" | "failed" | "interrupted">,
    cause: TerminalEvent["payload"]["cause"],
    message: string,
    completion?: Completion,
  ): void {
    if (isTerminal(session.state)) return;
    const payload: TerminalEvent["payload"] = completion === undefined
      ? { state, cause, message }
      : { state, cause, message, provenance: completion.provenance, result: completion.result };
    session.state = state;
    session.terminal = Object.freeze(payload);
    this.append(session, "terminal", payload);
  }

  private append<K extends SessionEvent["kind"]>(session: StoredSession, kind: K, payload: PayloadFor<K>): void {
    const event = Object.freeze({
      protocol_version: HARNESS_PROTOCOL_VERSION,
      session_id: session.id,
      sequence: session.events.length + 1,
      occurred_at: toTimestamp(this.now()),
      kind,
      payload: Object.freeze(payload),
    }) as unknown as EventEnvelope<K, PayloadFor<K>>;
    session.events.push(event as SessionEvent);
    // This is intentionally synchronous. A durable observer may fail closed
    // here; the caller has not crossed its next external side-effect boundary
    // until it returns.
    this.onEvent?.(event as SessionEvent, this.inspect(session.id));
  }

  private requireSession(sessionId: string): StoredSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new HarnessSessionError(`unknown session: ${sessionId}`);
    return session;
  }

  private requireActive(sessionId: string): StoredSession {
    const session = this.requireSession(sessionId);
    if (isTerminal(session.state)) throw new HarnessSessionError(`session is terminal: ${sessionId}`);
    return session;
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new HarnessSessionError("clock must return a non-negative safe integer epoch millisecond");
    return now;
  }
}

function freezeModelIdentity(value: import("./protocol.js").NativeSessionModelIdentity): import("./protocol.js").NativeSessionModelIdentity {
  assertNonEmpty(value.provider_id, "model identity provider_id");
  assertNonEmpty(value.model_id, "model identity model_id");
  for (const [label, revision] of Object.entries({ configured_revision: value.configured_revision, revision: value.revision })) {
    if (revision !== null && (typeof revision !== "string" || revision.trim().length === 0)) throw new HarnessAdmissionError(`model identity ${label} must be a non-empty string or null`);
  }
  return Object.freeze({ ...value });
}

type PayloadFor<K extends SessionEvent["kind"]> = Extract<SessionEvent, { kind: K }>["payload"];

/** Deny takes precedence even when the same tool occurs earlier in the allow list. */
export function isToolPermitted(policy: ExecutionPolicy, tool: string): boolean {
  return policy.tool_allow.includes(tool) && !policy.tool_deny.includes(tool);
}

function validatePolicy(policy: ExecutionPolicy): void {
  if (!Number.isSafeInteger(policy.max_wall_clock_ms) || policy.max_wall_clock_ms <= 0) throw new HarnessAdmissionError("max_wall_clock_ms must be a positive safe integer");
  if (!Number.isSafeInteger(policy.max_events) || policy.max_events < 2) throw new HarnessAdmissionError("max_events must reserve start and terminal events");
  if (policy.workspace_roots.length === 0) throw new HarnessAdmissionError("at least one workspace root is required");
  for (const root of policy.workspace_roots) validateWorkspaceRoot(root);
  for (const tool of [...policy.tool_allow, ...policy.tool_deny]) assertNonEmpty(tool, "tool identifier");
  if (policy.network_allowed && policy.approvals === "never") throw new HarnessAdmissionError("network access requires approval mediation");
  if (policy.filesystem !== "read_only" && policy.approvals === "never") throw new HarnessAdmissionError("writable filesystem access requires approval mediation");
  if (policy.inherited_credentials_allowed && policy.approvals === "never") throw new HarnessAdmissionError("inherited credentials require approval mediation");
}

function validateWorkspaceRoot(root: string): void {
  assertNonEmpty(root, "workspace root");
  if (!root.startsWith("/") || root.includes("//") || root.split("/").includes("..")) {
    throw new HarnessAdmissionError(`workspace root is not canonical: ${root}`);
  }
}

function freezePolicy(policy: ExecutionPolicy): ExecutionPolicy {
  return Object.freeze({
    ...policy,
    tool_allow: Object.freeze([...policy.tool_allow]),
    tool_deny: Object.freeze([...policy.tool_deny]),
    workspace_roots: Object.freeze([...policy.workspace_roots]),
  });
}

function freezeCapabilities(capabilities: readonly CapabilitySupport[]): readonly CapabilitySupport[] {
  const seen = new Set<string>();
  const frozen = capabilities.map((capability) => {
    if (!isHarnessCapability(capability.capability) || !isSupportGrade(capability.grade) || seen.has(capability.capability)) {
      throw new HarnessAdmissionError(`invalid or duplicate capability evidence: ${capability.capability}`);
    }
    seen.add(capability.capability);
    assertNonEmpty(capability.evidence.implementation_id, "capability implementation_id");
    assertNonEmpty(capability.evidence.detail, "capability evidence detail");
    if (Number.isNaN(Date.parse(capability.evidence.observed_at))) throw new HarnessAdmissionError("capability observed_at must be an ISO timestamp");
    return Object.freeze({ ...capability, evidence: Object.freeze({ ...capability.evidence }) });
  });
  return Object.freeze(frozen);
}

function freezeLineage(lineage: SessionLineage): SessionLineage {
  return Object.freeze({ ...lineage });
}

function toTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function isTerminal(state: SessionState): state is Extract<SessionState, "completed" | "failed" | "interrupted"> {
  return state === "completed" || state === "failed" || state === "interrupted";
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new HarnessAdmissionError(`${label} must be non-empty`);
}
