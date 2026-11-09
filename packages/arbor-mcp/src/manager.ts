// arbor-mcp — MCP server exposing the tree-search loop controller and KB
// Clean-room. The MCP is harness-agnostic — usable from opencode, Claude Code,
// Codex, or any MCP-compatible client.

import type {
  CampaignState,
  CampaignConfig,
  TreeNode,
  Action,
  AcceptanceCheckAssignment,
  ScoreContext,
  Provenance,
  CapabilityContext,
  NodeState,
  GateRecord,
  HaltReason,
  RuntimeEvent,
  RecoveryAttempt,
  RecoveryAbandonment,
  NodeError,
  NodeOutcome,
  CriticVerdict,
  MemoryMode,
  TerminalOutcome,
  CandidateArtifact,
  TokenUsageResult,
  ArbiterDecision,
  GovernanceTier,
  HighRiskCommandIntent,
  BoundHighRiskIntent,
} from "@arbor/core";
import { projectCrossSessionHandoff, type CrossSessionHandoffInput, type CrossSessionHandoffProjection } from "./cross-session-handoff.js";
import { formatCostStatusLine, projectCostHud, renderCostStatusLine, ShellStatusLineRenderer, type CostHudProjection } from "./cost/hud-projection.js";
import {
  selectNode,
  createChild,
  beginExpansion,
  retryInterruptedNode,
  resumeAwaitingUserInputNode,
  abandonInterruptedNode,
  interruptNode,
  verifyNode,
  failNode,
  backpropagate,
  pruneNode,
  reviveFailedNode,
  reviveScopeBlockedNode,
  createCampaign,
  scoreAction,
  combineReward,
  haltCheck,
  DEFAULT_CAMPAIGN_CONFIG,
  saveCampaign,
  loadCampaignResult,
  listCampaigns as listPersistedCampaigns,
  readBoulderResult,
  writeBoulder,
  type PersistenceDiagnostic,
  type BackedUpReward,
  type RewardObservation,
  type VerifiedProvenance,
  selectNodeByCapability,
} from "@arbor/core";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  KnowledgeBase,
  SqliteKbStore,
  loadKBResult,
  saveKBProjection,
  loadKBFromSqlite,
  saveKBToSqlite,
  type KBEntry,
  type KbStore,
} from "@arbor/kb";
import type { KbBackend } from "@arbor/config";
import {
  EvidenceLedger,
  AuditIntegrityError,
  loadLedgerResult,
  persistGateCheckpoint,
  persistRecoveryDecision,
  persistCampaignReopen,
  persistTelemetryObservation,
  persistTerminalProfile,
  persistTerminalNotification,
  persistScopeIntentBind,
  saveLedger,
  type GovernedTransition,
  type RecoveryDecisionInput,
  type CampaignReopenInput,
  type CampaignReopenRecord,
  type TracePacket,
  type NodeCommunicationInput,
  type NodeCommunicationRecord,
  type NodeCommunication,
  type MemoryFactInput,
  type InterruptionInput,
  type TelemetryObservationInput,
  type TerminalProfileInput,
  type TerminalNotificationInput,
  type CompactionLifecycleInput,
  type CompactionLifecycleRecord,
  type PhaseMessageInput,
  type PhaseMessageRecord,
  type PhaseMessageKind,
  type RequestUserInputInput,
  type RequestUserInputRecord,
  type UserInputAnswer,
  type FoldedWaiverOutcome,
  type AdvisoryEvidenceGenerator,
  scopeDecisionSigningPayload,
  type ScopeDecisionKind,
  type ScopeIntentBindInput,
  type ScopeIntentBindRecord,
  appendLedgerHeadAttestation,
} from "@arbor/audit";
import {
  checkAdmission,
  checkIsolation,
  checkEvidence,
  checkAudit,
  bypassGate,
  attachGateRecord,
  type GateResult,
} from "@arbor/gate";
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { canonicalizeForHash, isClosedToDirectInput, isTerminalNodeState } from "@arbor/core";
import type { RecoveryCampaignPort, RecoveryNodeView, RecoveryRequest } from "./recovery-service.js";
import { projectMemoryFacts, projectMemoryFactsPage } from "./memory-projector.js";
import { projectTelemetry, type TelemetryProjection, type TelemetryProjectionOptions } from "./metrics-projector.js";
import { parentChildThreadId, projectConversationBus, projectParentChildThread } from "./conversation-bus.js";
import { countCategoryVisits, kbExtractionProvenance } from "./manager-pure.js";
import { redactNativeText } from "@arbor/harness";
import { MINED_ACTION_SCOPE_GENERATOR, type NativeHighRiskToolScope, type NativeHighRiskScopeDenialReason } from "./native-tools/contracts.js";
import { extractDeclaredScope } from "./arbiter-intake.js";
import { authorizeScopeExpansion, inspectCapturedResult, type ScopeExpansionAuthorizationOutcome } from "./result-adoption.js";

/**
 * A read-only startup finding produced by comparing a durable tree snapshot to
 * durable audit facts.  It intentionally does not prescribe a state change:
 * recovery must not turn an incomplete operation into success or failure.
 */
export type RecoveryDiagnosticCode =
  | "interrupted_expansion"
  | "expanding_without_isolation_checkpoint"
  | "pending_node_has_isolation_checkpoint"
  | "orphan_gate_checkpoint"
  | "orphan_admission_checkpoint"
  | "terminal_trace_conflicts_with_snapshot"
  | "trace_references_unknown_node"
  | "legacy_unwitnessed_kb"
  | "kb_projection_rebuilt";

/** One plan action whose `depends_on` is not yet fully satisfied — see `deferredActions`. */
interface DeferredPlanAction {
  readonly action: Action;
  /** Sibling action `description` strings this action is still waiting on. */
  readonly depends_on: readonly string[];
}

function assertValidPlanDependencyGraph(actions: readonly Action[]): void {
  const withDependencies = actions.some((action) => (action.depends_on?.length ?? 0) > 0);
  if (!withDependencies) return;
  const descriptions = new Set<string>();
  for (const action of actions) {
    if (descriptions.has(action.description)) throw new Error(`campaign plan dependency graph requires unique action descriptions: ${action.description}`);
    descriptions.add(action.description);
  }
  const edges = new Map<string, readonly string[]>();
  for (const action of actions) {
    const dependencies = action.depends_on ?? [];
    if (new Set(dependencies).size !== dependencies.length) throw new Error(`campaign plan action has duplicate dependencies: ${action.description}`);
    for (const dependency of dependencies) {
      if (dependency === action.description) throw new Error(`campaign plan action cannot depend on itself: ${action.description}`);
      if (!descriptions.has(dependency)) throw new Error(`campaign plan dependency references unknown sibling action: ${dependency}`);
    }
    edges.set(action.description, dependencies);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (description: string): void => {
    if (visiting.has(description)) throw new Error(`campaign plan dependency graph contains a cycle at: ${description}`);
    if (visited.has(description)) return;
    visiting.add(description);
    for (const dependency of edges.get(description) ?? []) visit(dependency);
    visiting.delete(description);
    visited.add(description);
  };
  for (const description of descriptions) visit(description);
}

/** Materialize a planner's explicit criterion-to-action map before any tree node exists. */
function materializePlanAcceptance(
  actions: readonly Action[],
  acceptanceChecks: readonly string[] | undefined,
  acceptanceMapping: readonly AcceptanceCheckAssignment[] | undefined,
): readonly Action[] {
  // A direct/legacy plan that never supplied acceptance metadata is valid as
  // before. A stated criterion without the new map is never guessed or folded
  // into generic constraints: admission fails before campaign creation.
  if (acceptanceChecks === undefined && acceptanceMapping === undefined) return actions;
  if (acceptanceChecks === undefined) throw new Error("campaign plan acceptance mapping requires acceptance checks");
  if (acceptanceMapping === undefined) {
    if (acceptanceChecks.length === 0) return actions;
    throw new Error("campaign plan acceptance checks require an explicit acceptance_mapping");
  }
  if (acceptanceChecks.length > 32 || new Set(acceptanceChecks).size !== acceptanceChecks.length
    || acceptanceChecks.some((criterion) => !criterion.trim() || criterion.length > 4_096)) {
    throw new Error("campaign plan acceptance checks must be unique non-empty strings of at most 4096 characters (maximum 32)");
  }
  const actionDescriptions = new Set(actions.map((action) => action.description));
  if (actionDescriptions.size !== actions.length) throw new Error("campaign plan acceptance mapping requires unique action descriptions");
  if (acceptanceMapping.length > 32 || acceptanceMapping.length !== acceptanceChecks.length) throw new Error("campaign plan acceptance mapping must cover every acceptance check exactly once (maximum 32)");
  const expected = new Set(acceptanceChecks); const seen = new Set<string>(); const checksByAction = new Map<string, string[]>();
  for (const assignment of acceptanceMapping) {
    if (!assignment || typeof assignment.criterion !== "string" || !assignment.criterion.trim() || assignment.criterion.length > 4_096 || !expected.has(assignment.criterion)
      || seen.has(assignment.criterion) || !Array.isArray(assignment.action_descriptions) || assignment.action_descriptions.length === 0 || assignment.action_descriptions.length > 32
      || new Set(assignment.action_descriptions).size !== assignment.action_descriptions.length
      || assignment.action_descriptions.some((description) => typeof description !== "string" || description.length > 4_096 || !actionDescriptions.has(description))) {
      throw new Error("campaign plan acceptance mapping must assign each known criterion to one or more exact action descriptions");
    }
    seen.add(assignment.criterion);
    for (const description of assignment.action_descriptions) {
      const assigned = checksByAction.get(description) ?? [];
      assigned.push(assignment.criterion); checksByAction.set(description, assigned);
    }
  }
  if (seen.size !== expected.size) throw new Error("campaign plan acceptance mapping omits a stated acceptance check");
  return actions.map((action) => {
    const assigned = checksByAction.get(action.description);
    return assigned === undefined ? action : { ...action, acceptance_checks: Object.freeze(assigned) };
  });
}

export interface RecoveryDiagnostic {
  code: RecoveryDiagnosticCode;
  campaign_id: string;
  node_id: string;
  detail: string;
  operation_id?: string;
  trace_id?: string;
}

/**
 * The `recovery.retry`/`recovery.abandon` read-path projection —
 * `getRecoverableNodes`'s result shape. `prior_operation_id` is `null` when
 * no durable operation id was ever recorded for this node's current
 * (recoverable) state — a real "unavailable", not a guess.
 */
export interface RecoverableNodeView {
  campaign_id: string;
  node_id: string;
  state: NodeState;
  prior_operation_id: string | null;
  /** Durable campaign revision required by the recovery command's CAS guard. */
  expected_version: string;
}

/** A post-durability domain-event observer. Envelopes/cursors belong to runtime composition. */
/**
 * Halt reasons an operator session fork reopens (ADR-043 amendment, fork
 * reopen): the search ran out, it was not stopped. Budget and manual halts
 * are deliberately absent.
 */
export const FORK_REOPENABLE_HALT_REASONS = ["no_nodes", "converged"] as const;
export type ForkReopenableHaltReason = typeof FORK_REOPENABLE_HALT_REASONS[number];
export function isForkReopenableHaltReason(reason: HaltReason): reason is ForkReopenableHaltReason {
  return (FORK_REOPENABLE_HALT_REASONS as readonly string[]).includes(String(reason));
}

export type CampaignManagerEventSink = (event: RuntimeEvent) => void;

export interface CampaignManagerOptions {
  persistence_dir?: string;
  on_event?: CampaignManagerEventSink;
  /** Defer the expensive durable audit replay until the interactive shell is visible. */
  defer_audit_restore?: boolean;
  /**
   * KB storage engine. Defaults to "jsonl". Sourced from arbor-config's
   * `kb.backend` key (G-06 wires config loading into this option; until then
   * callers pass it explicitly).
   */
  kb_backend?: KbBackend;
}

/**
 * E-7a: bound and neutralize free-text KB entry content before it reaches
 * `kbInject`'s specialist-visible prompt. Two properties matter, not one:
 *
 *   1. Collapse embedded newlines/control characters to spaces. `@arbor/kb`'s
 *      `inject()` renders every failure_mode entry as ONE bullet line; a
 *      multi-line payload lets a poisoned entry forge additional lines
 *      (a fake role header, a fake instruction) that a single-line bullet
 *      was never meant to contain.
 *   2. Neutralize the literal KB block delimiters ("--- KB CONTEXT ---" /
 *      "--- END KB CONTEXT ---"). Those strings are what tells the model
 *      where untrusted context ends; letting entry content contain them lets
 *      a poisoned entry forge a fake end-of-context boundary and have
 *      whatever follows read as trusted instructions instead of KB data.
 *
 * Bounded length as a third, independent defense: even a maximally-neutralized
 * payload should not be allowed to dominate the prompt.
 */
/** Bound on `CampaignManager.sessionGovernanceTier`'s FIFO cache (see decisions/ADR-PENDING-native-structured-scope-pre-authorization-and-auto-approve.md) -- see that field's doc. */
const SESSION_GOVERNANCE_TIER_CACHE_MAX = 512;
const KB_ENTRY_SANITIZED_MAX_CHARS = 500;
const KB_ENTRY_CONTROL_CHARS_PATTERN = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(9)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, "g");
const KB_ENTRY_BOUNDARY_MARKER_PATTERN = /-{2,}\s*(?:END\s+)?KB\s+CONTEXT\s*-{0,}/gi;

export function sanitizeMemoryEntryText(text: string): string {
  // Credential redaction first, so an entry recorded before the failure path
  // redacted its text still cannot carry a secret into a specialist prompt.
  let sanitized = redactNativeText(text)
    .replace(KB_ENTRY_CONTROL_CHARS_PATTERN, " ")
    .replace(KB_ENTRY_BOUNDARY_MARKER_PATTERN, "[neutralized-kb-boundary-marker]")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length > KB_ENTRY_SANITIZED_MAX_CHARS) {
    sanitized = `${sanitized.slice(0, KB_ENTRY_SANITIZED_MAX_CHARS)}...[truncated]`;
  }
  return sanitized;
}

/** The failure path's free-text fields, each through the shared harness redactor; structure and provenance are untouched. */
function redactFailureParams<T extends { specialist_output: string; critic_rationale: string; critic_root_cause?: string; verification_failure?: { readonly diagnostic?: string }; node_error?: NodeError }>(params: T): T {
  const nodeError = params.node_error;
  return {
    ...params,
    specialist_output: redactNativeText(params.specialist_output),
    critic_rationale: redactNativeText(params.critic_rationale),
    ...(params.critic_root_cause === undefined ? {} : { critic_root_cause: redactNativeText(params.critic_root_cause) }),
    ...(params.verification_failure?.diagnostic === undefined ? {} : { verification_failure: { ...params.verification_failure, diagnostic: redactNativeText(params.verification_failure.diagnostic) } }),
    ...(nodeError === undefined ? {} : { node_error: redactNodeError(nodeError) }),
  };
}

/** A NodeError's free text (message, salvaged timeout output) through the shared harness redactor. */
function redactNodeError(error: NodeError): NodeError {
  return {
    ...error,
    message: redactNativeText(error.message),
    ...(error.kind === "timeout" && error.partial_output !== null ? { partial_output: redactNativeText(error.partial_output) } : {}),
  } as NodeError;
}

// ============================================================
// CAMPAIGN MANAGER — holds all active campaigns
// ============================================================

/**
 * The campaign manager is the top-level state holder.
 * It owns all campaigns, the shared KB, and the evidence ledger.
 */
export class CampaignManager implements RecoveryCampaignPort {
  private campaigns: Map<string, CampaignState> = new Map();
  private kb: KbStore;
  private readonly kbBackend: KbBackend;
  private ledger: EvidenceLedger = new EvidenceLedger();
  private campaignStartTimes: Map<string, number> = new Map();
  private persistenceDir: string | null;
  private activeCampaignId: string | null = null;
  private persistenceDiagnostics: PersistenceDiagnostic[] = [];
  private recoveryDiagnostics: RecoveryDiagnostic[] = [];
  private auditRestoreDeferred = false;
  private readonly eventSinks = new Set<CampaignManagerEventSink>();
  /**
   * Plan actions admitted with a `depends_on` whose prerequisites have not
   * ALL reached `verified` yet. Manager-local, not tree state: the tree only
   * ever contains real executable nodes, never a synthetic "blocked" node
   * state the rest of the codebase (selection, scoring, TUI) would have to
   * learn about. Re-checked on every scheduling pass (`selectNode`) and
   * immediately after a node verifies (`recordResult`), so a dependent
   * action is admitted as soon as its prerequisites are satisfied.
   * `persistCampaign` mirrors this map onto `CampaignState.deferredActions`
   * (arbor-core's `saveCampaign`/`validateCampaignSnapshot`) so it survives a
   * process restart with `persistence_dir`; `restoreCampaigns` reloads it
   * from there below.
   */
  private deferredActions: Map<string, DeferredPlanAction[]> = new Map();

  /**
   * WA-12: campaign ids whose supervised `campaign.run` job settled with
   * `CampaignRunOutcome.cancelled === true` (runtime.ts's `runCampaignJob`
   * is the sole writer, via `markCampaignRunCancelled`). Deliberately kept
   * OUT of `CampaignState` and independent of `campaign.halted`: a
   * cancelled RUN must not block the underlying campaign from being resumed
   * by a later `campaign.run` job (the exact reason `runCampaign` itself
   * leaves `report.halted: false` on cancellation — see loop.ts's
   * cancellation branches). Memory-only, matching the same documented
   * tradeoff as `runtime.ts`'s own `campaignRunDiagnostics` map: it does not
   * survive a process restart, and a restart-recovered campaign simply loses
   * the "last run was cancelled" read (never a correctness hazard, since a
   * genuinely still-running job would still show `terminal_outcome:
   * "in_progress"` either way).
   */
  private cancelledRuns: Set<string> = new Set();

  /**
   * Y (ADR-070): campaign-local ephemeral Ed25519 keypairs for scope-decision
   * signing. Deliberately IN MEMORY ONLY -- never persisted, never
   * serialized into any campaign/ledger JSON (asserted by
   * `manager-scope-decision.test.ts`'s no-private-key-material test). A
   * process restart drops every entry, so `scopeDecisionSigner` below
   * always starts a FRESH generation (a `parent_decision_id: null` genesis
   * hop with a newly generated key) rather than silently reusing a key it
   * no longer holds -- the honest trade ADR-070's consequences section
   * documents: this proves intra-campaign hop integrity, not identity, and
   * a resumed campaign's post-restart hops form a new generation rather
   * than extending the pre-restart one.
   */
  private readonly scopeDecisionKeys = new Map<string, { privateKey: KeyObject; publicKeyBase64: string; lastDecisionId: string | null }>();

  /**
   * decisions/ADR-PENDING-native-structured-scope-pre-authorization-and-auto-approve.md:
   * a small, bounded (never persisted) `session_id -> governance
   * tier` cache, populated as a side effect of `deriveNativeHighRiskToolScope`
   * -- the one call every native specialize session makes, with the exact
   * `campaign_id`/`session_id` pairing, before any tool call (including a
   * high-risk one) can be dispatched. This is the composition-owned answer
   * to "which tier is this session's action-scope approval decision for"
   * (`cli.ts`'s `approvals.decide`), without parsing `session_id` text or
   * plumbing a new per-session context channel through
   * `NativeAgentExecutor`/`NativeHarnessWorker` (neither owns tier
   * semantics). Bounded to `SESSION_GOVERNANCE_TIER_CACHE_MAX` entries with
   * FIFO eviction -- a long-running process dispatches far more sessions
   * than any one approval decision needs to remember, and an evicted lookup
   * fails safe (see `governanceTierForSession`'s doc).
   */
  private readonly sessionGovernanceTier = new Map<string, GovernanceTier>();

  /**
   * S02: "distinguish tier denial from missing per-action authority. Never
   * broaden authority silently." `deriveNativeHighRiskToolScope` returns a
   * bare `null` on several structurally distinct causes; this bounded,
   * session-scoped, never-persisted cache records WHICH one, so a caller
   * denying a high-risk call (`native-tool-host.ts`'s `highRiskScopeFailure`,
   * via `resolve_high_risk_scope_denial_reason`) can say so truthfully
   * instead of always claiming "nothing was declared" -- which is false
   * exactly when an authored declaration existed but the governance tier
   * refused it. Same FIFO-eviction shape as `sessionGovernanceTier`; an
   * evicted or absent entry means "unknown reason", never "authorized".
   */
  private readonly sessionHighRiskScopeDenialReason = new Map<string, NativeHighRiskScopeDenialReason>();

  /**
   * With persistence_dir, tree snapshots are the durable source of truth.
   * boulder.json is only a derived active-campaign hint and is reconciled from
   * snapshots at startup, so it cannot strand a restart.
   */
  constructor(options: CampaignManagerOptions = {}) {
    this.kbBackend = options.kb_backend ?? "jsonl";
    this.kb = this.createKbCache();
    this.persistenceDir = options.persistence_dir ?? null;
    if (options.on_event) this.eventSinks.add(options.on_event);
    if (this.persistenceDir) {
      const previous = this.kb;
      if (this.kbBackend === "sqlite") {
        this.kb = loadKBFromSqlite(this.persistenceDir).store;
      } else {
        const kb = loadKBResult(this.persistenceDir);
        this.kb = kb.value ?? new KnowledgeBase();
        this.persistenceDiagnostics.push(...kb.diagnostics);
      }
      if (previous instanceof SqliteKbStore) previous.close();
      this.restoreCampaigns();
      if (options.defer_audit_restore === true) this.auditRestoreDeferred = true;
      else this.restoreAuditLedgers();
      this.projectStartupRecovery();
      if (!this.auditRestoreDeferred) this.reconcileForkReopens();
      this.reconcileKBProjection();
    }
  }

  /** Complete a startup-deferred audit replay at an explicit UI lifecycle boundary. */
  restoreDeferredAuditLedgers(): void {
    if (!this.auditRestoreDeferred) return;
    this.auditRestoreDeferred = false;
    this.restoreAuditLedgers();
    this.reconcileForkReopens();
  }

  /** Fresh, empty, backend-selected KB cache. Never touches disk; callers persist explicitly. */
  private createKbCache(): KbStore {
    return this.kbBackend === "sqlite" ? new SqliteKbStore(":memory:") : new KnowledgeBase();
  }

  // --- Campaign lifecycle ---

  /**
   * Start a new campaign. Runs the admission gate first.
   */
  startCampaign(
    id: string,
    planPath: string,
    rootAction: Action,
    config?: Partial<CampaignConfig>,
  ): { ok: true; campaign_id: string } | { ok: false; gate: GateResult } {
    if (this.campaigns.has(id)) throw new Error(`Campaign ${id} already exists`);
    // Admission gate
    const admission = checkAdmission({
      plan_reviewed: true, // Caller must ensure plan was reviewed
      resources_available: true,
      config_valid: config?.max_seconds !== undefined ? config.max_seconds >= 0 : true,
    });

    this.checkpointGate(id, "root", "campaign_start", `${id}:campaign_start`, admission);
    if (admission.result === "fail") {
      return { ok: false, gate: admission };
    }

    const mergedConfig = { ...DEFAULT_CAMPAIGN_CONFIG, ...config };
    const campaign = createCampaign(id, planPath, rootAction);
    campaign.config = mergedConfig;
    this.campaigns.set(id, campaign);
    this.campaignStartTimes.set(id, Date.now());
    this.activeCampaignId = id;
    this.persistCampaign(campaign);
    this.emit({ kind: "campaign.changed", campaign_id: id, change: "created" });
    return { ok: true, campaign_id: id };
  }

  /**
   * Admit one reviewed task-composer proposal as a complete initial tree.
   * All child construction happens before the campaign becomes observable, so
   * an invalid branch can never leave a root-only campaign behind.
   */
  admitCampaignPlan(input: {
    id: string;
    plan_path: string;
    root_action: Action;
    actions: readonly Action[];
    acceptance_checks?: readonly string[];
    acceptance_mapping?: readonly AcceptanceCheckAssignment[];
    config?: Partial<CampaignConfig>;
    /** ADR-062: the arbiter/operator governance-tier decision for this campaign, persisted durably at admission time. */
    governance?: ArbiterDecision;
  }): { ok: true; campaign_id: string; root_id: string; child_ids: string[] } | { ok: false; gate: GateResult } {
    if (this.campaigns.has(input.id)) throw new Error(`Campaign ${input.id} already exists`);
    if (!input.id.trim() || !input.plan_path.trim() || input.actions.length < 1) throw new Error("campaign plan requires an id, plan path, and at least one action");
    const actions = materializePlanAcceptance(input.actions, input.acceptance_checks, input.acceptance_mapping);
    assertValidPlanDependencyGraph(actions);
    const admission = checkAdmission({
      plan_reviewed: true,
      resources_available: true,
      config_valid: input.config?.max_seconds !== undefined ? input.config.max_seconds >= 0 : true,
    });
    this.checkpointGate(input.id, "root", "campaign_start", `${input.id}:campaign_start`, admission);
    if (admission.result === "fail") return { ok: false, gate: admission };

    const campaign = createCampaign(input.id, input.plan_path, input.root_action);
    campaign.config = { ...DEFAULT_CAMPAIGN_CONFIG, ...input.config };
    if (input.governance) campaign.governance = input.governance;
    // Actions with a real `depends_on` are NOT created as tree nodes yet — a
    // fresh admission has nothing verified, so any such action would always
    // be unsatisfied at this instant. They are held in `deferredActions` and
    // admitted later, once their prerequisites verify (see
    // `admitUnblockedDeferredActions`). This is the DAG-admission fix: before
    // it, every planned action (including a "final synthesis" action) became
    // a direct, immediately-executable child of root regardless of any real
    // prerequisite relationship the plan declared.
    const ready: Action[] = [];
    const deferred: DeferredPlanAction[] = [];
    for (const action of actions) {
      const dependsOn = (action.depends_on ?? []).filter((d) => d.trim().length > 0);
      if (dependsOn.length === 0) ready.push(action);
      else deferred.push({ action, depends_on: dependsOn });
    }
    const childIds = ready.map((action) => createChild(campaign.tree, "root", action));
    const priorActive = this.activeCampaignId;
    this.campaigns.set(input.id, campaign);
    this.campaignStartTimes.set(input.id, Date.now());
    this.activeCampaignId = input.id;
    if (deferred.length > 0) this.deferredActions.set(input.id, deferred);
    try { this.persistCampaign(campaign); }
    catch (error) {
      this.campaigns.delete(input.id); this.campaignStartTimes.delete(input.id); this.activeCampaignId = priorActive;
      this.deferredActions.delete(input.id);
      throw error;
    }
    this.emit({ kind: "campaign.changed", campaign_id: input.id, change: "created" });
    for (const childId of childIds) this.emit({ kind: "tree.node_changed", campaign_id: input.id, node_id: childId, state: "pending" });
    return { ok: true, campaign_id: input.id, root_id: "root", child_ids: childIds };
  }

  /**
   * Re-check every deferred (dependency-blocked) plan action for this
   * campaign and admit any whose full `depends_on` set has now reached a
   * critic-approved terminal success ("verified", or non-root "claimed" —
   * see the ordering-not-evidence note inside). Called on every scheduling
   * pass (`selectNode`) and immediately after a node records a result
   * (`recordResult`), so a dependent action becomes eligible as soon as
   * possible rather than only at the next external poll.
   */
  private admitUnblockedDeferredActions(campaignId: string): void {
    const pending = this.deferredActions.get(campaignId);
    if (!pending || pending.length === 0) return;
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return;
    // `depends_on` encodes ORDERING between plan actions, not an evidence
    // gate: the places that must not trust unverified output (adoption,
    // learned-success KB memory, the scoring frontier) each enforce that
    // boundary themselves against the provenance type. A dependency is
    // therefore satisfied by any critic-approved terminal success —
    // "verified" or "claimed" — because requiring "verified" here deadlocked
    // every connector campaign whose plan chained on a read-only discovery
    // step (a read-only action has no machine-verifiable artifact, so its
    // node can never leave "claimed"; observed live: halt_reason "no_nodes"
    // with both dependent actions still deferred). The root node is excluded:
    // it is "claimed" at admission by the planner, before any critic ran.
    const satisfiedDescriptions = new Set<string>();
    for (const node of campaign.tree.values()) {
      if (node.state === "verified" || (node.state === "claimed" && node.parent_id !== null)) {
        satisfiedDescriptions.add(node.action.description);
      }
    }
    const stillBlocked: DeferredPlanAction[] = [];
    const unblockedChildIds: string[] = [];
    for (const entry of pending) {
      if (entry.depends_on.every((dep) => satisfiedDescriptions.has(dep))) {
        unblockedChildIds.push(createChild(campaign.tree, "root", entry.action));
      } else {
        stillBlocked.push(entry);
      }
    }
    if (unblockedChildIds.length === 0) return;
    if (stillBlocked.length > 0) this.deferredActions.set(campaignId, stillBlocked);
    else this.deferredActions.delete(campaignId);
    this.persistCampaign(campaign);
    for (const childId of unblockedChildIds) this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: childId, state: "pending" });
  }

  /**
   * Count of this campaign's plan actions still waiting on an unresolved
   * `depends_on` prerequisite. Used by `listCampaigns`/`getCampaignSnapshot`
   * to distinguish a halt with real pending prerequisites (never a hollow
   * success, but not a hard failure either) from a halt with nothing left to
   * do at all.
   */
  private deferredActionCount(campaignId: string): number {
    return this.deferredActions.get(campaignId)?.length ?? 0;
  }

  /**
   * A task-composer root is normally the tree anchor, not an executable node.
   * That leaves a plan hollow when its only runnable decomposition action
   * fails and every remaining action is correctly held behind it. In that
   * narrow case, schedule the already-reviewed root as one durable recovery
   * child instead of returning `no_nodes` before any implementation can run.
   *
   * Do not release the blocked actions: their `depends_on` contract still
   * requires the named prerequisite to succeed. The root is a bounded
   * fallback for the whole requested outcome, not evidence that E1 completed.
   */
  private admitRootRecoveryForBlockedPlan(campaignId: string): string | null {
    const pending = this.deferredActions.get(campaignId);
    if (!pending || pending.length === 0) return null;
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return null;

    const failedDescriptions = new Set(
      [...campaign.tree.values()]
        .filter((node) => node.state === "failed")
        .map((node) => node.action.description),
    );
    if (!pending.some((entry) => entry.depends_on.some((dependency) => failedDescriptions.has(dependency)))) return null;

    const root = campaign.tree.get(campaign.root_id);
    if (!root) return null;
    const description = `[root recovery] ${root.action.description}`;
    // The marker is durable tree data, so recovery remains one-shot across a
    // restart without adding a second manager-local persistence channel.
    if ([...campaign.tree.values()].some((node) => node.parent_id === root.id && node.action.description === description)) return null;

    const childId = createChild(campaign.tree, root.id, { ...root.action, description, depends_on: [] });
    this.persistCampaign(campaign);
    this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: childId, state: "pending" });
    return childId;
  }

  // --- Tree search operations ---

  /**
   * Select the next node to expand via UCT.
   * Returns null if halted or no expandable nodes.
   */
  /**
   * `campaign.best_score`, or `null` when no node has verified yet.
   *
   * `best_score` is the best MEASURED reward any terminal outcome has backed
   * up (`combineReward`): 1 for a `!verified` pass, a weighted stage fraction
   * below 1 for a measured failure. It is never a planner prior. Until a node
   * verifies it is either its initial, unmeasured 0 or a partial stage
   * fraction — and neither is grounds to abandon the search: halting on
   * either ended a campaign after its first failed expansion with every
   * remaining candidate unexplored, making backtracking unreachable. So the
   * below_threshold halt reads it only once a node has verified, which on the
   * measured scale means it reads 1 (ADR-185).
   *
   * Shared by BOTH `haltCheck` call sites deliberately. The first fix for this
   * touched only `haltStatus` (the reporting path) and missed `selectNode`
   * (the deciding path, and the one the loop actually runs), so campaigns kept
   * halting while `haltStatus` cheerfully reported they should not. One helper,
   * both callers, no third way to ask the question.
   */
  private measuredBestScore(campaign: { best_score: number; tree: Map<string, { state: string }> }): number | null {
    for (const node of campaign.tree.values()) if (node.state === "verified") return campaign.best_score;
    return null;
  }

  selectNode(campaignId: string, ctx: ScoreContext): string | null {
    const campaign = this.getCampaign(campaignId);
    if (campaign.halted) return null;

    // Re-check dependency-deferred actions before every scheduling decision:
    // a node that verified since the last call may have just unblocked one
    // or more deferred actions, and those must become selectable candidates
    // (and count against a premature no_nodes halt) before we ask the core
    // scheduler or the halt check anything.
    this.admitUnblockedDeferredActions(campaignId);

    // Check halt conditions
    const startedAt = this.campaignStartTimes.get(campaignId) ?? Date.now();
    const halt = haltCheck(
      startedAt,
      this.measuredBestScore(campaign),
      campaign.iterations_completed,
      campaign.iterations_without_kb_entry,
      campaign.config,
    );
    if (halt.halted) {
      campaign.halted = true;
      campaign.halt_reason = halt.reason;
      this.persistCampaign(campaign);
      this.emit({ kind: "campaign.changed", campaign_id: campaignId, change: "halted" });
      return null;
    }

    const selected = selectNode(campaign.tree, ctx, campaign.config.score_config);
    if (selected !== null) return selected;
    return this.admitRootRecoveryForBlockedPlan(campaignId);
  }

  /**
   * Phase 4D.4 wiring: UCT-first selection with optional capability refinement.
   * Calls existing selectNode, then optionally applies selectNodeByCapability to
   * find the best card. UCT wins on mismatch — capability routing refines, never
   * overrides the UCT decision (checks-and-balances, Commandment IV).
   */
  selectNodeWithCard(
    campaignId: string,
    ctx: ScoreContext,
    options: { taskSkills?: readonly string[]; requestedTier?: import("@arbor/core").NodeCard["tier"]; cards?: readonly import("@arbor/core").NodeCard[] } = {},
  ): { node_id: string | null; card: import("@arbor/core").NodeCard | null } {
    const nodeId = this.selectNode(campaignId, ctx);
    if (nodeId === null) return { node_id: null, card: null };
    if (options.cards === undefined || options.taskSkills === undefined || options.requestedTier === undefined) {
      return { node_id: nodeId, card: null };
    }
    const bestCard = selectNodeByCapability(options.cards, options.taskSkills, options.requestedTier);
    if (bestCard === null) return { node_id: nodeId, card: null };
    // Capability routing refines: if the best card's node matches UCT's pick, return both.
    // On mismatch, UCT wins (the tree is the authority, the card is advisory).
    if (bestCard.node_id === nodeId) return { node_id: nodeId, card: bestCard };
    return { node_id: nodeId, card: null };
  }

  /**
   * Expand a node: run isolation gate, mark expanding.
   */
  expandNode(
    campaignId: string,
    nodeId: string,
    isolationCheck: { worktree_isolated: boolean; starting_commit_correct: boolean; lease_acquired: boolean },
  ): { ok: true } | { ok: false; gate: GateResult } {
    const campaign = this.getCampaign(campaignId);
    const node = campaign.tree.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);

    // Isolation gate
    const isolation = checkIsolation(isolationCheck);
    this.checkpointGate(
      campaignId,
      nodeId,
      "node_expansion",
      `${campaignId}:${nodeId}:node_expansion`,
      isolation,
    );
    attachGateRecord(node, isolation);
    if (isolation.result === "fail") {
      return { ok: false, gate: isolation };
    }

    beginExpansion(campaign.tree, nodeId);
    campaign.iterations_completed++;
    this.persistCampaign(campaign);
    this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: nodeId, state: "expanding" });
    return { ok: true };
  }

  /**
   * Record a Specialist's result. Runs the evidence gate and Critic verdict.
   * If approved with !verified provenance: node becomes 'verified'.
   * If approved with !claimed only: node becomes 'claimed'.
   * If rejected: node fails, backtrack.
   */
  recordResult(
    campaignId: string,
    nodeId: string,
    params: {
      specialist_output: string;
      specialist_agent: string;
      provenance: Provenance;
      /** Independently observed text anchored by verified provenance. */
      verification_evidence?: string;
      critic_agent: string;
      critic_approved: boolean;
      critic_rationale: string;
      critic_root_cause?: string;
      /**
       * Trusted machine verification attempted this result and failed.
       * `stages`, when the verifier ran a staged plan, is how many of its
       * stages passed out of how many it declared — the graded signal the
       * reward contract backs up for a failed node. Absent means no graded
       * measurement exists, and the failure backs up an unmeasured 0.
       */
      verification_failure?: {
        readonly code: string;
        readonly exit?: number;
        readonly diagnostic?: string;
        readonly stages?: { readonly passed: number; readonly total: number };
      };
      /** Full five-mandate critic evidence, if a critic actually rendered it. */
      critic_verdict?: CriticVerdict;
      /**
       * The real classified operational failure (timeout, transport error,
       * context overflow, ...) when this call originates from
       * `recordClassifiedError` (loop.ts) rather than a genuine Critic
       * rejection. Threaded onto the node's `outcome` on failure so a
       * specialist timeout or a decompose-rejection reason survives past
       * the free-text `specialist_output` string. Absent for an ordinary
       * Critic-rejected result — that is a design rejection, not an
       * operational error, and must not be mislabeled as one.
       */
      node_error?: NodeError;
      /** Stable identity for replaying one expansion result across a crash. */
      result_operation_id?: string;
      /**
       * ADR-062 (`direct` governance tier): present ONLY when this result was
       * accepted WITHOUT a real critic verdict — the arbiter explicitly
       * waived review for this node. Must never be set alongside a genuine
       * `critic_verdict`; the caller (loop.ts) never does both. This is the
       * one honest way a node can leave `recordResult` verified/claimed
       * without checks-and-balances having actually run — the alternative
       * (fabricating a `critic_approved` verdict) is exactly what this
       * marker exists to avoid.
       */
      review_waived?: { readonly by: string; readonly reason: string };
      /**
       * Y-1 (ADR-065): an audit-tier write-scope mismatch the machine
       * verifier observed for this result. Journaled as a durable
       * `scope_observation` ledger record alongside the trace; never a
       * verdict input — enforcement already happened (or deliberately did
       * not) at the verifier, and this is the auditable evidence of it.
       */
      scope_observation?: { readonly declared: readonly string[]; readonly observed_out_of_scope: readonly string[]; readonly enforcement: "audit" | "blocked" };
      /**
       * Y-1 (ADR-068): zero or more durable advisory findings surfaced by an
       * offline analysis pass (sibling-tree scan, test amplifier, mutation
       * probe) for this result. Journaled as `advisory_evidence` ledger
       * records into the SAME staged target/fsync as the trace, witnessed by
       * this call's own freshly-appended trace id -- never a verdict input,
       * purely durable evidence for a later human or auditor read. Wiring
       * findings from the loop into this parameter is out of this package's
       * ownership this cycle (see ADR-068's contract-point note); this is
       * the seam a caller wires into.
       */
      advisory_evidence?: readonly { readonly generator: AdvisoryEvidenceGenerator; readonly activity: string; readonly payload: string }[];
      /**
       * E-7b (objective drift / task-echo mismatch, AgentLAB 2602.16901).
       * Optional: absent for every existing caller today (`loop.ts` does not
       * yet surface it — no transport this cycle carries a distinct
       * task-identity echo separate from the node's own `Action`). When a
       * caller DOES supply it — a critic/specialist transport that echoes
       * back which task it believes it addressed — it must equal this
       * node's own `action.description` exactly, or the result is a
       * contract violation, not an ordinary Critic rejection: the evidence
       * being accepted does not correspond to the task this node asked for.
       */
      task_echo?: string;
      /**
       * E-7c (evidence replay). Optional: absent for every existing caller
       * today (the worktree machine-verification port's return type does
       * not yet carry campaign/node identity through to `recordResult` —
       * see `worktree-machine-verifier.ts`, out of this cycle's file
       * scope). When a caller DOES supply it — the campaign/node identity
       * the verification evidence actually originated from — it must equal
       * `{campaignId, nodeId}` (this exact call's target) or the evidence is
       * a replay: verification provenance captured for a DIFFERENT node or
       * campaign, attached here instead of where it was actually observed.
       */
      verification_source?: { readonly campaign_id: string; readonly node_id: string };
      /**
       * Selection context for the node's recorded selection `score`. Never an
       * input to the backed-up reward, which derives only from measured outcomes.
       */
      score_ctx: ScoreContext;
    },
  ): {
    state: NodeState;
    backtrack_parent: string | null;
    kb_entry_id: string | null;
    /** The measured, provenance-tagged reward this outcome backed up the tree. */
    reward: BackedUpReward;
  } {
    const campaign = this.getCampaign(campaignId);
    const node = campaign.tree.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);

    const nodeStateBefore = node.state;
    const scoreBefore = node.score;

    // E-7b: reject before any critic/evidence-gate reasoning runs — a
    // task-echo mismatch is a contract violation regardless of what the
    // (mismatched) critic verdict claims.
    if (params.task_echo !== undefined && params.task_echo !== node.action.description) {
      const rootCause = `task-echo mismatch: result addresses "${params.task_echo}" but node ${nodeId} `
        + `is "${node.action.description}" — the evidence being submitted does not correspond to this node's task`;
      return this.recordFailure(campaignId, nodeId, node, campaign, nodeStateBefore, scoreBefore, params, rootCause, rootCause);
    }
    // E-7c: reject a replayed verification whose recorded origin does not
    // match this call's own target, before it can promote this node.
    if (params.verification_source !== undefined
      && (params.verification_source.campaign_id !== campaignId || params.verification_source.node_id !== nodeId)) {
      const rootCause = `evidence replay: verification provenance originates from `
        + `${params.verification_source.campaign_id}/${params.verification_source.node_id}, `
        + `not this call's target ${campaignId}/${nodeId}`;
      return this.recordFailure(campaignId, nodeId, node, campaign, nodeStateBefore, scoreBefore, params, rootCause, rootCause);
    }

    if (params.critic_verdict) {
      assertCriticVerdict(params.critic_verdict, params);
    }
    if (params.critic_approved && params.critic_agent === params.specialist_agent) {
      throw new Error("Critic self-approval is forbidden");
    }

    // The verifier has already made the authorization decision; this branch
    // faithfully applies its BLOCKED outcome to the tree. Critic approval can
    // validate the implementation's design, but cannot authorize writes the
    // admitted action did not grant. Audit-tier observations remain evidence
    // only and continue through the ordinary acceptance path below.
    if (params.scope_observation?.enforcement === "blocked" && params.scope_observation.observed_out_of_scope.length > 0) {
      const paths = [...new Set(params.scope_observation.observed_out_of_scope)].sort();
      const rootCause = `write scope violation: modified path(s) outside declared authority: ${paths.join(", ")}`;
      return this.recordFailure(campaignId, nodeId, node, campaign, nodeStateBefore, scoreBefore, params, rootCause, rootCause);
    }

    // A real acceptance command is an authority-bearing verifier, not
    // advisory context for the panel. Preserve the panel's truthful approval
    // fields while making its red machine result a failure transition; this
    // is what activates the loop's bounded corrective retry instead of
    // stranding the node as an approved-but-unadoptable claim.
    if (params.verification_failure !== undefined) {
      const rootCause = `machine verification failed: ${params.verification_failure.code}${params.verification_failure.exit === undefined ? "" : ` (exit ${params.verification_failure.exit})`}${params.verification_failure.diagnostic === undefined ? "" : `: ${params.verification_failure.diagnostic}`}`;
      return this.recordFailure(campaignId, nodeId, node, campaign, nodeStateBefore, scoreBefore, params, rootCause, rootCause);
    }

    // Real acceptance-check gate (fix for the reported "critic rubber-stamps
    // refusals" defect): a self-reported `approved: true` is not, by itself,
    // trusted. `acceptanceOverrideReason` re-derives the verdict from data
    // this call frame actually has — provenance, a classified operational
    // error, and whether a full five-mandate verdict backs the approval —
    // and forces a rejection when that data structurally contradicts the
    // claim. See its own doc for exactly which two conditions fire.
    const overrideReason = params.critic_approved ? acceptanceOverrideReason(params) : null;
    if (!params.critic_approved || overrideReason) {
      const failureValue = overrideReason ?? params.critic_rationale;
      const rootCause = overrideReason ?? params.critic_root_cause ?? params.critic_rationale;
      return this.recordFailure(campaignId, nodeId, node, campaign, nodeStateBefore, scoreBefore, params, failureValue, rootCause);
    }

    // Critic approved: run evidence gate
    const evidence = checkEvidence({
      provenance_tag: params.provenance.tag,
      stdout_hash: params.provenance.tag === "verified" ? params.provenance.stdout_hash : null,
      exit_code: params.provenance.tag === "verified" ? params.provenance.exit : null,
      ...(params.provenance.tag === "verified" && params.verification_evidence !== undefined
        ? { promoted_claim: params.specialist_output, evidence_text: params.verification_evidence }
        : {}),
    });
    this.checkpointGate(
      campaignId,
      nodeId,
      "node_verification",
      `${campaignId}:${nodeId}:node_verification`,
      evidence,
    );
    attachGateRecord(node, evidence);

    // Fail closed in this same call frame (A-1): a caller-claimed provenance
    // tier the evidence gate can't support does not get to retire the branch.
    // This mirrors checkAdmission/checkIsolation's pattern above — the ledger's
    // recordGovernedTransition re-check below remains as a second, independent
    // backstop, not the sole enforcement.
    if (evidence.result === "fail") {
      const rootCause = `evidence gate failed: ${evidence.detail}`;
      return this.recordFailure(campaignId, nodeId, node, campaign, nodeStateBefore, scoreBefore, params, rootCause, rootCause);
    }

    // The node's selection score: planner gain/cost priors plus an
    // exploration bonus. It is recorded as the node's own `score` (the
    // trace's score_after, and what `getBestPath` and the eval harness rank
    // by), but it is a prior, not an outcome — it is never backed up the
    // tree and never raises `best_score`. `reward` below is what is.
    const categoryVisits = countCategoryVisits(campaign, node.action.category);
    const score = scoreAction(node.action, params.score_ctx, categoryVisits, campaign.config.score_config);

    const newState: NodeState = params.provenance.tag === "verified" ? "verified" : "claimed";
    // The reward contract: only a `!verified` transition is a terminal pass,
    // and the action's estimates are deliberately not an input.
    const reward = this.terminalReward(params, params.provenance.tag === "verified" ? params.provenance : null);
    // A "claimed" result already passed the critic gate above, but it is
    // still, by the provenance type's own doc, "asserted by an agent but not
    // machine-verified" — never itself grounds for cross-campaign learned
    // memory or for raising the in-campaign scoring baseline. Before this
    // gate, ANY critic-approved result (claimed or verified) wrote a
    // success_pattern fact and could raise best_score, so a merely claimed
    // (unverified, possibly wrong) result could both pollute other
    // campaigns' learned-success memory and corrupt this campaign's own
    // scoring frontier. Only a genuinely verified result may do either.
    //
    // This gate is deliberately narrower than "did this reset convergence":
    // `learned` below still reflects any novel critic-approved result
    // (verified or claimed) for the loop's own convergence bookkeeping,
    // exactly as before this fix — a campaign making real (if unverified)
    // forward progress is not the pollution/corruption this fix targets, and
    // narrowing convergence too would silently change the loop's halt timing
    // out from under arbor-opencode's own tests, which this bucket does not
    // own.
    const isAcceptedForMemory = newState === "verified";

    // Write success-pattern KB entry, deduplicated by value — verified only.
    // This is the memory-pollution guard from 3220c8ed: an unverified/claimed
    // result must never write a portable success_pattern fact, however
    // "novel" it is within its own campaign.
    const successValue = `${node.action.description}: succeeded`;
    const learnedForMemory = isAcceptedForMemory && !this.hasMemoryFact(campaignId, "success_pattern", successValue);
    // Convergence novelty is tracked separately from the cross-campaign
    // ledger fact above (3220c8ed's `learned` used to be the same boolean,
    // which is the bug: gating the fact write on `isAcceptedForMemory` made
    // `hasMemoryFact` permanently false for any claimed-only campaign, so
    // `learned` was permanently true and the counter reset every iteration,
    // and `converged` could never fire). Instead, ask whether this campaign
    // has already recorded this exact success (claimed or verified) by
    // scanning its own tree — a fact that is durable in `campaign.tree`
    // (persisted with the campaign) without ever becoming a cross-campaign
    // memory import, so it cannot reintroduce the pollution the gate above
    // guards against.
    const novelInCampaign = this.isNovelCampaignSuccess(campaign, nodeId, successValue);
    const { traceId, kbId } = this.journalResult(campaignId, nodeId, nodeStateBefore, newState, scoreBefore, score, params,
      learnedForMemory ? { scope: { kind: "campaign" }, type: "success_pattern", content: successValue,
        // Cross-campaign import policy requires the source fact itself to
        // carry the verification that made the result portable; a generated
        // extraction wrapper would weaken that type at the authority edge.
        provenance: params.provenance, tags: [node.action.category] } : null,
      { transition: "node_verification", operation_id: `${campaignId}:${nodeId}:node_verification` });

    verifyNode(campaign.tree, nodeId, params.provenance, params.specialist_output, score);
    // ADR-106 / ADR-185: backpropagate
    // this terminal outcome's MEASURED reward along the exact path that was
    // selected — this node and every ancestor to the root — once per terminal
    // transition, never mid-expansion. Additive to `failNode`'s own ancestor
    // walk below; touches no field it reads for its backtrack decision. A
    // verified pass backs up 1; a claimed (unverified) success backs up only
    // what was measured, which without a measurement is an unmeasured 0.
    //
    // Guarded on the pre-call state because `verifyNode` treats a
    // byte-identical re-verification of an already-`verified` node as a
    // silent no-op (tree.ts's identicalReplay branch) — it transitions
    // nothing. Backpropagating anyway would walk this node and every
    // ancestor to the root a second time on evidence that was already
    // counted, inflating the very `edge_visit_count` denominator
    // `backpropagate`'s own contract calls "once per terminal transition"
    // and that `agent_uct`'s per-edge exploration term divides by.
    if (nodeStateBefore !== "verified") backpropagate(campaign.tree, nodeId, reward.value);
    // ADR-185: keep the full reward record (not just the value that landed in
    // value_estimate) so replay/audit can read why it was backed up. A repeat
    // call on an already-verified node backed nothing up, so it keeps its record.
    if (nodeStateBefore !== "verified") node.reward = structuredClone(reward);
    this.resolveCandidateReview(node);
    if (params.critic_verdict) node.critic_verdict = structuredClone(params.critic_verdict);
    if (params.review_waived) node.review_waived = { ...params.review_waived };
    // Only a measured reward may raise the best score; a claimed result
    // carries no measurement, so it cannot (the 3220c8ed guard, now by type).
    if (isAcceptedForMemory && reward.measured && reward.value > campaign.best_score) campaign.best_score = reward.value;
    // This node just verified; it may be the last dependency a deferred
    // action was waiting on. Admit any now-unblocked deferred actions before
    // returning, so the next scheduling pass sees them immediately.
    this.admitUnblockedDeferredActions(campaignId);

    // Only reset convergence if this campaign genuinely learned something new.
    if (novelInCampaign) {
      campaign.iterations_without_kb_entry = 0;
    }

    this.persistCampaign(campaign);
    if (kbId !== null) this.emit({ kind: "kb.entry_added", campaign_id: campaignId, entry_id: kbId });
    this.emit({ kind: "audit.evidence_recorded", campaign_id: campaignId, evidence_id: traceId });
    this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: nodeId, state: newState });
    return { state: newState, backtrack_parent: null, kb_entry_id: kbId, reward };
  }

  /**
   * The reward a terminal outcome backs up, from measured observations only.
   * `verified` is the `!verified` provenance of a transition that actually
   * verifies the node, and `null` on every failure path — including one that
   * arrived carrying a `verified` tag the evidence gate or a replay check
   * refused, which must not be credited as a pass. The critic's confidence
   * is recorded as an estimate with no calibration, so it weighs 0 until a
   * recorded calibration earns it a weight (operator decision 2026-10-06).
   */
  private terminalReward(
    params: Parameters<CampaignManager["recordResult"]>[2],
    verified: VerifiedProvenance | null,
  ): BackedUpReward {
    const observations: RewardObservation[] = [];
    if (verified !== null) observations.push({ channel: "terminal", provenance: verified });
    const stages = params.verification_failure?.stages;
    if (stages !== undefined) {
      observations.push({ channel: "graded", source: "verification_stage_fraction", stages_passed: stages.passed, stages_total: stages.total });
    }
    const confidence = params.critic_verdict?.confidence;
    if (confidence !== undefined && params.critic_agent !== params.specialist_agent) {
      observations.push({ channel: "estimate", source: "critic_confidence", value: confidence, calibration: null });
    }
    return combineReward(observations);
  }

  /**
   * Shared terminal-failure path for `recordResult`: used both when the
   * Critic rejects a result and when the evidence gate fails a `verified`
   * claim it can't support (A-1). `failureValue` is the failure_mode KB
   * fact's dedup/content key; `rootCause` is the message attached to the
   * node via `failNode` (the two differ for critic rejection, where the
   * caller may supply a more specific `critic_root_cause`).
   */
  private recordFailure(
    campaignId: string,
    nodeId: string,
    node: TreeNode,
    campaign: CampaignState,
    nodeStateBefore: NodeState,
    scoreBefore: number,
    rawParams: Parameters<CampaignManager["recordResult"]>[2],
    rawFailureValue: string,
    rawRootCause: string,
  ): { state: NodeState; backtrack_parent: string | null; kb_entry_id: string | null; reward: BackedUpReward } {
    // A failure's free text is often a provider or tool error message, and it
    // is persisted three ways here (trace packet, failure_mode KB fact that is
    // later injected into specialist prompts, node error) — so it passes the
    // shared harness redactor once, at this boundary, whatever produced it.
    const params = redactFailureParams(rawParams);
    const failureValue = redactNativeText(rawFailureValue);
    const rootCause = redactNativeText(rawRootCause);
    const extractionProvenance = kbExtractionProvenance(campaignId, nodeId, params);
    const learned = !this.hasMemoryFact(campaignId, "failure_mode", failureValue);
    // A failure is never a terminal pass, whatever provenance tag it carried.
    const reward = this.terminalReward(params, null);
    const { traceId, kbId } = this.journalResult(campaignId, nodeId, nodeStateBefore, "failed", scoreBefore, 0, params,
      learned ? { scope: { kind: "campaign" }, type: "failure_mode", content: failureValue, provenance: extractionProvenance, tags: [node.action.category] } : null);

    // Evidence and its memory fact are durable before the terminal tree state
    // or its materialized KB view can become observable.
    const parentId = failNode(campaign.tree, nodeId, rootCause);
    // ADR-106 / ADR-185: backpropagate
    // this terminal failure's MEASURED reward — the weighted fraction of
    // machine-verification stages that passed, bounded below a verified
    // pass, or an unmeasured 0 when no stage evidence exists — along the
    // exact path that was selected. It runs AFTER `failNode` so that walk
    // (the backtrack-target search) is computed from state validity alone.
    // The pre-failure `scoreBefore` was a selection prior, never an outcome.
    backpropagate(campaign.tree, nodeId, reward.value);
    node.reward = structuredClone(reward); // ADR-185 durable record of why this value was backed up
    // A measured partial is real quality evidence and may raise the best
    // score; it can never reach a verified pass's 1 (`combineReward`'s ceiling).
    if (reward.measured && reward.value > campaign.best_score) campaign.best_score = reward.value;
    this.resolveCandidateReview(node);
    if (params.critic_verdict) node.critic_verdict = structuredClone(params.critic_verdict);
    if (params.review_waived) node.review_waived = { ...params.review_waived };
    // A classified operational failure gets a structured `outcome` alongside
    // `failNode`'s free-text message, so the real NodeError (timeout kind,
    // context-overflow signal, decompose-rejection reason) survives past the
    // rendered string. A genuine Critic rejection carries no `node_error` and
    // sets no outcome here — it is a design rejection, not an operational one.
    if (params.node_error) node.outcome = { kind: "error", error: params.node_error };

    // Only reset convergence if we actually learned something new.
    if (learned) {
      campaign.iterations_without_kb_entry = 0;
    }

    this.persistCampaign(campaign);
    if (kbId !== null) this.emit({ kind: "kb.entry_added", campaign_id: campaignId, entry_id: kbId });
    this.emit({ kind: "audit.evidence_recorded", campaign_id: campaignId, evidence_id: traceId });
    this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: nodeId, state: "failed" });
    return { state: "failed", backtrack_parent: parentId, kb_entry_id: kbId, reward };
  }

  /**
   * ADR-062 bounded critic-block retry: revive a critic-rejected `"failed"`
   * node back to `"pending"` so `selectNode` can dispatch it again, with the
   * rejection rationale already saved as a retry-context capsule
   * (loop.ts's `saveRetryContext`, run before this is called). This is a
   * loop-owned, narrowly-scoped mechanism — distinct from the operator-
   * authorized recovery service (`recovery-service.ts`) — and performs no
   * capping itself: the caller (loop.ts) is the sole authority for whether
   * `node.critic_retry_count` has room for another attempt.
   */
  reviveNodeForRetry(campaignId: string, nodeId: string): void {
    const campaign = this.getCampaign(campaignId);
    if (!campaign.tree.has(nodeId)) throw new Error(`Node ${nodeId} not found`);
    reviveFailedNode(campaign.tree, nodeId);
    this.persistCampaign(campaign);
    this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: nodeId, state: "pending" });
  }

  /** Revive a machine-blocked scope failure without consuming critic retry budget. */
  reviveNodeForScopeRetry(campaignId: string, nodeId: string): void {
    const campaign = this.getCampaign(campaignId);
    if (!campaign.tree.has(nodeId)) throw new Error(`Node ${nodeId} not found`);
    reviveScopeBlockedNode(campaign.tree, nodeId);
    this.persistCampaign(campaign);
    this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: nodeId, state: "pending" });
  }

  /**
   * Capture a Specialist's completed output as a durable candidate BEFORE
   * critic dispatch (tranche1 §13 items 2/3). Before this, a specialist's
   * already-completed work lived only in a local variable until
   * `recordResult` ran — so a critic-transport failure (network/timeout, not
   * a verdict) had nothing durable to fall back on and the node was recorded
   * as failed, discarding real work purely because review never happened.
   * `node.candidate` is that durable "awaiting review" state, independent of
   * whatever the critic later decides.
   */
  recordCandidate(
    campaignId: string,
    nodeId: string,
    candidate: {
      specialist_output: string;
      specialist_agent: string;
      provenance: Provenance;
      /** Q4: the specialist's observed token usage, if the executor measured it. */
      token_usage?: TokenUsageResult;
    },
  ): void {
    const campaign = this.getCampaign(campaignId);
    const node = campaign.tree.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    const artifact: CandidateArtifact = Object.freeze({
      specialist_output: candidate.specialist_output,
      specialist_agent: candidate.specialist_agent,
      provenance: candidate.provenance,
      captured_at: new Date().toISOString(),
      review_status: "awaiting_review",
      ...(candidate.token_usage === undefined ? {} : { token_usage: candidate.token_usage }),
    });
    node.candidate = artifact;
    node.state = "awaiting_review";
    this.persistCampaign(campaign);
    this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: nodeId, state: "awaiting_review" });
  }

  /**
   * S1: once a node's review actually resolves (verified, claimed, or
   * failed — via `recordResult`/`recordFailure`), a captured candidate
   * (`recordCandidate`) must stop reading `"awaiting_review"` forever.
   * `resumableReviewNodes` already gates on `node.state` too, so this was
   * never a functional bug in that read path — but the persisted
   * `CandidateArtifact` itself stayed permanently stale, which is
   * misleading to anyone inspecting `node.candidate` directly (e.g. `arbor
   * report`, webui). `CandidateArtifact` is frozen, so this replaces it
   * with a new frozen artifact rather than mutating the existing one.
   */
  private resolveCandidateReview(node: TreeNode): void {
    if (node.candidate === undefined || node.candidate.review_status === "resolved") return;
    node.candidate = Object.freeze({ ...node.candidate, review_status: "resolved" });
  }

  /**
   * Record that critic DISPATCH itself failed — a transport/timeout/spawn
   * error, never a rendered verdict. The captured candidate
   * (`recordCandidate`) is left completely untouched and the node stays
   * `"awaiting_review"`: real specialist work is still waiting on a genuine
   * review, this is not a scored implementation failure, so this path never
   * calls `recordFailure`/`failNode` and never touches `campaign.best_score`
   * or the failure_mode KB memory. The observed `NodeError` (carrying G-08's
   * timeout salvage fields — `elapsed_ms`/`partial_output`/`usage` — where
   * applicable) is retained on the node's `outcome` for evidence/debugging;
   * `node.outcome.kind === "error"` does not by itself mean terminal here —
   * `node.state` remains the sole terminality authority (see
   * `persist.ts`'s snapshot validator, which only cross-checks `outcome` for
   * `"interrupted"`, never `"error"`).
   */
  recordReviewFailure(campaignId: string, nodeId: string, error: NodeError): void {
    const campaign = this.getCampaign(campaignId);
    const node = campaign.tree.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    node.outcome = { kind: "error", error: redactNodeError(error) };
    node.state = "awaiting_review";
    this.persistCampaign(campaign);
    this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: nodeId, state: "awaiting_review" });
  }

  /**
   * B2 (item 3): durably record the diagnostic for a failed `campaign.run`
   * job onto the campaign's own snapshot (`CampaignState.run_diagnostic`).
   *
   * The literal `.arbor/supervisor/tasks.json` supervised-task record is
   * owned by `TaskSupervisor`/`checkpointSupervisor` (arbor-core's
   * `task-supervisor.ts`, driven from `runtime.ts`) — outside this file's
   * change scope. Today `runtime.ts`'s `runCampaignJob` already computes a
   * `{ code, summary }` diagnostic on a rejected `campaignRunner.run(...)`,
   * but only keeps it in an in-memory `Map` (`campaignRunDiagnostics`) that
   * is never written to disk, so a process restart loses it and the
   * persisted task record itself carries no diagnostic at all — exactly
   * "no diagnostic recorded anywhere" from the field test. This method
   * gives that call site (or any other caller) a durable place to put it:
   * once wired, a failed run's reason survives a restart and is visible
   * next to the campaign it belongs to, not just in a task queue's memory.
   */
  recordCampaignRunDiagnostic(campaignId: string, diagnostic: { message: string; stack_head?: string }): void {
    const campaign = this.getCampaign(campaignId);
    // Both fields can quote a raw error message (a stack head's first line is
    // `Error: <message>`), and this snapshot is durable and operator-visible.
    campaign.run_diagnostic = { message: redactNativeText(diagnostic.message), stack_head: diagnostic.stack_head === undefined ? undefined : redactNativeText(diagnostic.stack_head), recorded_at: new Date().toISOString() };
    this.persistCampaign(campaign);
  }

  /** The durable diagnostic `recordCampaignRunDiagnostic` last recorded for this campaign, if any. */
  getCampaignRunDiagnostic(campaignId: string): { message: string; stack_head?: string; recorded_at: string } | null {
    return this.campaigns.get(campaignId)?.run_diagnostic ?? null;
  }

  /**
   * B3: nodes stranded in `"awaiting_review"` with a durably captured
   * candidate whose own `review_status` is still `"awaiting_review"` — i.e.
   * a specialist result that was recorded (`recordCandidate`) but never
   * reached a critic verdict, whether because the process died between
   * dispatch and verdict, a prior run of B2's containment boundary left it
   * pending, or any other reason review never completed. `arbor recover`
   * only journals durable *interruption* evidence (a `RecoveryDecisionInput`
   * against an isolation checkpoint); `recordCandidate`/`recordReviewFailure`
   * deliberately never write that kind of record (this is not an
   * interrupted expansion, the specialist finished), so these nodes are
   * otherwise invisible to every existing recovery path — `arbor recover`
   * matches nothing, `re-confirm` is an idempotent no-op, and `adopt` sees
   * no result to adopt. This is the read used to give the tree-search loop
   * something concrete to resume: dispatch the critic (never the
   * specialist — the candidate already IS the specialist's output) for
   * each id this returns.
   */
  resumableReviewNodes(campaignId: string): string[] {
    const campaign = this.getCampaign(campaignId);
    const ids: string[] = [];
    for (const node of campaign.tree.values()) {
      if (node.state === "awaiting_review" && node.candidate?.review_status === "awaiting_review") ids.push(node.id);
    }
    return ids;
  }

  /**
   * Branch: create child nodes under a verified/claimed node.
   */
  branch(campaignId: string, parentId: string, actions: Action[]): string[] {
    const campaign = this.getCampaign(campaignId);
    const children = actions.map((action) => createChild(campaign.tree, parentId, action));
    this.persistCampaign(campaign);
    for (const childId of children) this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: childId, state: "pending" });
    // decompose-policy.ts is the sole setter of `action.decomposition_depth`
    // (validateDecomposition), so its presence on any child unambiguously
    // means this branch call originated from FAULT_MATRIX's timeout ->
    // "decompose" recovery, not the ordinary branch_actions happy path.
    const decomposeDepth = actions.find((a) => (a.decomposition_depth ?? 0) > 0)?.decomposition_depth;
    if (decomposeDepth !== undefined) {
      this.emit({ kind: "tree.decomposed", campaign_id: campaignId, parent_id: parentId, children_ids: children, depth: decomposeDepth });
    }
    return children;
  }

  /**
   * Prune a node and all its children.
   */
  prune(campaignId: string, nodeId: string): void {
    const campaign = this.getCampaign(campaignId);
    const priorStates = new Map([...campaign.tree.values()].map((node) => [node.id, node.state]));
    pruneNode(campaign.tree, nodeId);
    this.persistCampaign(campaign);
    for (const node of campaign.tree.values()) {
      if (priorStates.get(node.id) !== node.state) this.emit({ kind: "tree.node_changed", campaign_id: campaignId, node_id: node.id, state: node.state });
    }
  }

  /**
   * Get the halt status for a campaign.
   */
  haltStatus(campaignId: string) {
    const campaign = this.getCampaign(campaignId);
    const startedAt = this.campaignStartTimes.get(campaignId) ?? Date.now();
    return haltCheck(
      startedAt,
      this.measuredBestScore(campaign),
      campaign.iterations_completed,
      campaign.iterations_without_kb_entry,
      campaign.config,
    );
  }

  /**
   * The RECORDED halt of a campaign: what `manualHalt`/`completeAutoHalt`
   * durably wrote, as opposed to `haltStatus`, which re-runs the automatic
   * halt check and so reports `halted: false` for a campaign that is in fact
   * halted. `at` is the `campaign_halt` gate checkpoint's time; `actor` is
   * null because no halt path records the requester on the campaign.
   */
  recordedHalt(campaignId: string): { halted: boolean; reason: HaltReason; at: string | null; actor: string | null; operation_id: string | null } {
    const campaign = this.getCampaign(campaignId);
    if (!campaign.halted) return { halted: false, reason: null, at: null, actor: null, operation_id: null };
    const checkpoints = this.ledger.getGateCheckpoints(campaignId).filter((record) => record.checkpoint.transition === "campaign_halt");
    const latest = checkpoints[checkpoints.length - 1];
    return {
      halted: true,
      reason: campaign.halt_reason,
      at: latest?.timestamp ?? null,
      actor: null,
      operation_id: latest?.checkpoint.operation_id ?? null,
    };
  }

  /**
   * Cheap durable halt-flag read. Unlike `haltStatus` (which only evaluates
   * the automatic budget/score/convergence conditions via `haltCheck` and
   * never looks at the `campaign.halted` flag itself), this reports exactly
   * what `manualHalt`/`completeAutoHalt`/`selectNode`'s own auto-halt branch
   * last durably recorded — the one place an operator-driven `campaign.halt`
   * (which sets `halt_reason: "manual"` directly, independent of any
   * haltCheck condition) is actually visible. The canonical loop checks this
   * ahead of `haltStatus` so a manual halt is noticed on the very next
   * iteration instead of only surfacing indirectly — and mislabeled
   * "no_nodes" — once `selectNode`'s own `campaign.halted` guard returns
   * null.
   */
  isHalted(campaignId: string): { halted: boolean; reason: HaltReason } {
    const campaign = this.getCampaign(campaignId);
    return { halted: campaign.halted, reason: campaign.halt_reason };
  }

  /**
   * Halt by an explicit, independently-audited operator decision. This is
   * intentionally separate from automatic budget/convergence halts, which do
   * not claim an audit result that never occurred.
   */
  manualHalt(
    campaignId: string,
    params: {
      requested_by: string;
      auditor_agent: string;
      auditor_agrees: boolean;
      operation_id: string;
      expected_version?: string;
    },
  ): { ok: true; version: string } | { ok: false; reason: "invalid_request" | "conflict" | "already_halted" | "audit_failed"; gate?: GateResult } {
    const campaign = this.getCampaign(campaignId);
    if (!params.requested_by.trim() || !params.auditor_agent.trim() || !params.operation_id.trim()
      || params.requested_by === params.auditor_agent) {
      return { ok: false, reason: "invalid_request" };
    }
    if (campaign.halted) return { ok: false, reason: "already_halted" };
    if (params.expected_version !== undefined && params.expected_version !== this.getCampaignVersion(campaignId)) {
      return { ok: false, reason: "conflict" };
    }

    const audit = checkAudit({ auditor_agrees: params.auditor_agrees, bypasses_recorded: campaign.tree.get(campaign.root_id)?.gate_records ?? [] });
    const root = campaign.tree.get(campaign.root_id);
    if (!root) throw new Error(`Campaign ${campaignId} root node ${campaign.root_id} not found`);
    this.checkpointGate(campaignId, root.id, "campaign_halt", params.operation_id, audit);
    if (audit.result === "fail") {
      this.emit({ kind: "gate.recorded", campaign_id: campaignId, node_id: root.id, gate: audit.gate, result: audit.result, bypass_evidence_deficit: audit.bypass_evidence_deficit });
      return { ok: false, reason: "audit_failed", gate: audit };
    }

    attachGateRecord(root, audit);
    campaign.halted = true;
    campaign.halt_reason = "manual";
    this.persistCampaign(campaign);
    this.attestLedgerHead(campaignId);
    this.emit({ kind: "gate.recorded", campaign_id: campaignId, node_id: root.id, gate: audit.gate, result: audit.result, bypass_evidence_deficit: audit.bypass_evidence_deficit });
    this.emit({ kind: "campaign.changed", campaign_id: campaignId, change: "halted" });
    return { ok: true, version: this.getCampaignVersion(campaignId) };
  }

  /**
   * Record the audit gate for an automatic halt (budget/threshold/convergence).
   * Automatic halts cannot claim an independent auditor, so the audit gate is
   * recorded as an explicit bypass with an evidence deficit rather than being
   * skipped entirely — the gate still fires and the deficit is durable for a
   * later operator/auditor resolution.
   */
  completeAutoHalt(campaignId: string, reason: HaltReason): { ok: true; version: string } {
    const campaign = this.getCampaign(campaignId);
    if (campaign.halted) return { ok: true, version: this.getCampaignVersion(campaignId) };
    const root = campaign.tree.get(campaign.root_id);
    if (!root) throw new Error(`Campaign ${campaignId} root node ${campaign.root_id} not found`);
    // D51: an audit-tier scope observation means the machine/critic result
    // may be real, but its captured patch is not adoptable under the scope
    // that governed the run. Do not settle that state as `verified_result`:
    // preserve the exact observed paths in the ledger and record the halt as
    // the honest partial-success reason instead. A later, separately audited
    // re-scope/adoption service may resolve it; this automatic halt never
    // silently grants that authority.
    const settledReason: HaltReason = reason === "verified_result" && this.unadoptableScopeViolations(campaignId, campaign).length > 0
      ? "scope_unadoptable"
      : reason;
    const audit = bypassGate(
      "audit",
      `campaign auto-halted: ${settledReason}; independent audit deferred to operator`,
      `no independent auditor for auto-halt (${settledReason})`,
    );
    const operationId = `${campaignId}:auto-halt:${settledReason}`;
    this.checkpointGate(campaignId, root.id, "campaign_halt", operationId, audit);
    attachGateRecord(root, audit);
    campaign.halted = true;
    campaign.halt_reason = settledReason;
    this.persistCampaign(campaign);
    this.attestLedgerHead(campaignId);
    this.emit({ kind: "gate.recorded", campaign_id: campaignId, node_id: root.id, gate: audit.gate, result: audit.result, bypass_evidence_deficit: audit.bypass_evidence_deficit });
    this.emit({ kind: "campaign.changed", campaign_id: campaignId, change: "halted" });
    return { ok: true, version: this.getCampaignVersion(campaignId) };
  }

  /**
   * Whether an operator session fork may reopen this campaign so its forked
   * child can run (ADR-043 amendment, fork reopen). Read-only.
   *
   * Only a halt that means "the search ran out" is reopenable: `no_nodes`
   * (nothing left to select) and `converged` (the stall heuristic). Every
   * other halt stays closed — above all `budget_exhausted`, which a fork must
   * never be a way around, and `manual`, which is an audited operator stop.
   *
   * A reopen is also refused when it could not do its job:
   * - `would_rehalt`: with the convergence window reset, the very next halt
   *   check would still stop the campaign (budget elapsed, or a threshold
   *   that cannot be met). This is the budget rule again, seen from the
   *   other side: budget counters are never reset, so an elapsed budget
   *   keeps a reopenable halt closed.
   * - `fork_child_unselectable`: the child would hang under a failed, pruned
   *   or abandoned ancestor, which UCT selection never picks, and it would
   *   not be the sole pending node either, which is the only case the
   *   production loop dispatches directly
   *   (`deriveProductionExecutionStrategy`, cli.ts). Reopening for it would
   *   re-halt at once and strand an authorized child.
   *
   * `parentNodeId` is the node the forked child hangs (or will hang) under;
   * `childNodeId` excludes an already-branched child from the pending count.
   */
  forkReopenPreview(campaignId: string, parentNodeId: string, childNodeId: string | null = null):
    | { readonly kind: "not_halted" }
    | { readonly kind: "reopenable"; readonly overridden_halt_reason: ForkReopenableHaltReason; readonly iterations_without_kb_entry: { readonly before: number; readonly after: number } }
    | { readonly kind: "refused"; readonly code: "halt_not_reopenable" | "would_rehalt" | "fork_child_unselectable"; readonly halt_reason: HaltReason; readonly detail: string } {
    const campaign = this.getCampaign(campaignId);
    if (!campaign.halted) return { kind: "not_halted" };
    const haltReason = campaign.halt_reason;
    if (!isForkReopenableHaltReason(haltReason)) {
      return { kind: "refused", code: "halt_not_reopenable", halt_reason: haltReason, detail: `campaign ${campaignId} is halted (${String(haltReason ?? "unspecified")}); only a ${FORK_REOPENABLE_HALT_REASONS.join(" or ")} halt is reopened by a fork` };
    }
    // A reopen opens a fresh convergence window: the operator's fork is the
    // new direction the stall heuristic said was missing. Leaving the counter
    // at or above `convergence_iterations` would make the loop's first halt
    // check re-halt `converged` before anything was selected. Nothing else is
    // reset — start time (max_seconds), iterations_completed and the native
    // campaign spend carry on from where the halted campaign left them.
    const iterations = { before: campaign.iterations_without_kb_entry, after: 0 };
    const projected = haltCheck(
      this.campaignStartTimes.get(campaignId) ?? Date.now(),
      this.measuredBestScore(campaign),
      campaign.iterations_completed,
      iterations.after,
      campaign.config,
    );
    if (projected.halted) {
      return { kind: "refused", code: "would_rehalt", halt_reason: haltReason, detail: `campaign ${campaignId} halted (${haltReason}) and would re-halt at once (${String(projected.reason)}); a fork does not reset budget` };
    }
    const unselectable = this.forkChildUnselectableDetail(campaign, parentNodeId, childNodeId);
    if (unselectable !== null) return { kind: "refused", code: "fork_child_unselectable", halt_reason: haltReason, detail: unselectable };
    return { kind: "reopenable", overridden_halt_reason: haltReason, iterations_without_kb_entry: iterations };
  }

  /**
   * Whether a fork child hung under `parentNodeId` could never be picked by
   * node selection: it would sit below a failed, pruned or abandoned node
   * (which UCT selection never descends) and not be the only pending node
   * (the one case the production loop dispatches directly). Applies to any
   * campaign, halted or not. Returns the refusal detail, or null when the
   * child is selectable. Read-only.
   */
  forkChildSelectionRefusal(campaignId: string, parentNodeId: string, childNodeId: string | null = null): string | null {
    return this.forkChildUnselectableDetail(this.getCampaign(campaignId), parentNodeId, childNodeId);
  }

  private forkChildUnselectableDetail(campaign: CampaignState, parentNodeId: string, childNodeId: string | null): string | null {
    let ancestorsLive = true;
    for (let cursor: string | null = parentNodeId, guard = 0; cursor !== null && guard <= campaign.tree.size; guard++) {
      const node = campaign.tree.get(cursor);
      if (node === undefined) return `fork parent ${parentNodeId} is not in campaign ${campaign.id}`;
      if (node.state === "failed" || node.state === "pruned" || node.state === "abandoned") { ancestorsLive = false; break; }
      cursor = node.parent_id;
    }
    const otherPending = [...campaign.tree.values()].filter((node) => node.state === "pending" && node.id !== childNodeId).length;
    const root = campaign.tree.get(campaign.root_id);
    const directDispatch = otherPending === 0 && (root?.action.decomposition_depth ?? 0) === 0;
    if (!ancestorsLive && !directDispatch) {
      return `a fork child under ${parentNodeId} hangs below a failed, pruned or abandoned node and is not the only pending node, so ${campaign.halted ? "a reopened campaign" : "campaign selection"} would never select it`;
    }
    return null;
  }

  /**
   * Reopen a `no_nodes`/`converged` halt for an operator session fork whose
   * pending child `forkNodeId` already exists. The typed `reopened` record is
   * fsynced before the halt flag clears, so the ledger never trails the
   * state it explains. The caller reverts with `revertForkReopen` if the
   * fork does not go on to dispatch; a crash in between is reconciled at the
   * next startup (`reconcileForkReopens`).
   */
  reopenForFork(campaignId: string, params: {
    readonly operation_id: string; readonly actor_id: string; readonly source_session_id: string;
    readonly fork_node_id: string; readonly reason: string;
  }): { readonly ok: true; readonly record_id: string; readonly overridden_halt_reason: ForkReopenableHaltReason }
    | { readonly ok: false; readonly code: "not_halted" | "halt_not_reopenable" | "would_rehalt" | "fork_child_unselectable" | "fork_child_not_pending"; readonly detail: string } {
    const campaign = this.getCampaign(campaignId);
    const child = campaign.tree.get(params.fork_node_id);
    if (child === undefined || child.state !== "pending" || child.parent_id === null) {
      return { ok: false, code: "fork_child_not_pending", detail: `fork child ${params.fork_node_id} is not a pending child node` };
    }
    const preview = this.forkReopenPreview(campaignId, child.parent_id, child.id);
    if (preview.kind === "not_halted") return { ok: false, code: "not_halted", detail: `campaign ${campaignId} is not halted` };
    if (preview.kind === "refused") return { ok: false, code: preview.code, detail: preview.detail };
    const record_id = this.persistCampaignReopen({
      campaign_id: campaignId, node_id: child.id, operation_id: params.operation_id, phase: "reopened",
      actor: params.actor_id, authority: "operator", overridden_halt_reason: preview.overridden_halt_reason,
      source_session_id: params.source_session_id, reason: params.reason,
      iterations_without_kb_entry: { ...preview.iterations_without_kb_entry },
    });
    campaign.halted = false;
    campaign.halt_reason = null;
    campaign.iterations_without_kb_entry = preview.iterations_without_kb_entry.after;
    this.persistCampaign(campaign);
    return { ok: true, record_id, overridden_halt_reason: preview.overridden_halt_reason };
  }

  /**
   * Undo a fork reopen whose fork did not reach dispatch: record the typed
   * `reverted` phase, then restore the halt it overrode. Idempotent. A
   * campaign that has since halted on its own keeps that later halt.
   */
  revertForkReopen(campaignId: string, operationId: string, reason: string): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
    const campaign = this.getCampaign(campaignId);
    const records = this.ledger.getCampaignReopens(campaignId).filter((record) => record.reopen.operation_id === operationId);
    const reopened = records.find((record) => record.reopen.phase === "reopened");
    if (reopened === undefined) return { ok: false, detail: `no fork reopen was recorded for operation ${operationId}` };
    if (records.some((record) => record.reopen.phase === "reverted")) return { ok: true };
    this.persistCampaignReopen({
      campaign_id: campaignId, node_id: reopened.node_id, ...reopened.reopen, phase: "reverted", reason,
    });
    if (!campaign.halted) {
      campaign.halted = true;
      campaign.halt_reason = reopened.reopen.overridden_halt_reason;
      this.persistCampaign(campaign);
    }
    return { ok: true };
  }

  /** Durable fork reopen evidence for one campaign, in append order. */
  getCampaignReopens(campaignId: string): readonly CampaignReopenRecord[] {
    return this.ledger.getCampaignReopens(campaignId);
  }

  /**
   * ADR-043 restart reconciliation for fork reopens. A campaign whose latest
   * reopen was never reverted, that is still open, and that has no node a
   * run could pick up or recover (pending, expanding, interrupted, awaiting
   * review) was reopened for a fork that never reached a runnable child —
   * the process stopped between the reopen and the fork's dispatch, or
   * between a failed fork's cleanup and its revert. Restore the halt it
   * overrode rather than leave an open campaign with nothing to run.
   */
  private reconcileForkReopens(): void {
    for (const campaign of this.campaigns.values()) {
      if (campaign.halted) continue;
      const latest = this.ledger.getCampaignReopens(campaign.id).at(-1);
      if (latest === undefined || latest.reopen.phase !== "reopened") continue;
      const runnable = [...campaign.tree.values()].some((node) =>
        node.state === "pending" || node.state === "expanding" || node.state === "interrupted" || node.state === "awaiting_review");
      if (runnable) continue;
      this.revertForkReopen(campaign.id, latest.reopen.operation_id, "restart reconciliation: the reopened campaign has no runnable node, so the fork never reached dispatch");
    }
  }

  private persistCampaignReopen(input: CampaignReopenInput): string {
    return this.persistenceDir
      ? persistCampaignReopen(this.ledger, this.persistenceDir, input)
      : this.ledger.recordCampaignReopen(input);
  }

  /**
   * WA-12: record that the most recent supervised `campaign.run` job for
   * this campaign settled as cancelled (`CampaignRunOutcome.cancelled`),
   * without touching `campaign.halted`/`halt_reason` — see `cancelledRuns`'
   * own doc for why a cancelled RUN must not foreclose a future run on the
   * same campaign. `deriveTerminalOutcome` reads this ahead of the ordinary
   * `!campaign.halted` early-return so a cancelled run is never
   * misclassified as `"in_progress"` (as if nothing happened) or, worse,
   * silently read as a genuine completion.
   */
  markCampaignRunCancelled(campaignId: string): void {
    this.cancelledRuns.add(campaignId);
  }

  /** Clears a prior `markCampaignRunCancelled` — a fresh run has started for this campaign. */
  clearCampaignRunCancelled(campaignId: string): void {
    this.cancelledRuns.delete(campaignId);
  }

  /**
   * E-6 (CAVA 2607.13716): append a durable, external attestation of this
   * campaign's ledger head at the moment it settles. `checkpointGate` above
   * has already fsynced the campaign_halt gate onto `this.ledger`, so the
   * head this reads is the final, complete state at settle time — not a
   * point that could still grow before the campaign becomes observably
   * halted. No-op when there is no persistence directory: an in-memory-only
   * ledger has nothing an external attestation file could anchor.
   */
  private attestLedgerHead(campaignId: string): void {
    if (!this.persistenceDir) return;
    const records = this.ledger.getRecords(campaignId);
    const entryCount = records.length;
    const headHash = entryCount > 0 ? records[entryCount - 1].content_hash : null;
    appendLedgerHeadAttestation(this.persistenceDir, campaignId, headHash, entryCount);
  }

  /** Stable read-version for optimistic command preconditions. */
  getCampaignVersion(campaignId: string): string {
    const snapshot = this.getCampaignSnapshot(campaignId);
    if (!snapshot) throw new Error(`Campaign ${campaignId} not found`);
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  }

  /**
   * Apply one governed interruption. Evidence is fsynced in the strict
   * request -> supervisor acknowledgement -> state-applied order before the
   * tree snapshot/event becomes observable. Replays resume at the first
   * missing phase and never manufacture Critic or KB evidence.
   */
  interrupt(input: {
    campaign_id: string;
    node_id: string;
    operation_id: string;
    scope: "node" | "subtree";
    reason: string;
    expected_version: string;
    partial_evidence_ids?: readonly string[];
    provenance: Provenance;
    acknowledge: (affectedNodeIds: readonly string[]) => void;
  }): { affected_node_ids: string[]; version: string } {
    const campaign = this.getCampaign(input.campaign_id);
    const existing = this.ledger.getInterruptions(input.campaign_id, input.operation_id);
    const request = existing.find((record) => record.interruption.phase === "requested");
    if (!request && this.getCampaignVersion(input.campaign_id) !== input.expected_version) {
      throw new Error("snapshot version no longer matches expected_version");
    }

    // Derive the complete deterministic target set without exposing a partial
    // mutation before the durable request exists.
    const previewTree = structuredClone(campaign.tree) as Map<string, TreeNode>;
    const preview = interruptNode(previewTree, input.node_id, {
      operation_id: input.operation_id, scope: input.scope, reason: input.reason,
      partial_evidence_ids: input.partial_evidence_ids, provenance: input.provenance,
    });
    const affectedNodeIds = request
      ? [...request.interruption.affected_node_ids]
      : [...preview.affected_node_ids, ...preview.unchanged_node_ids];
    const common = {
      campaign_id: input.campaign_id, node_id: input.node_id, operation_id: input.operation_id,
      scope: input.scope, affected_node_ids: affectedNodeIds,
      partial_evidence_ids: [...(input.partial_evidence_ids ?? [])], provenance: input.provenance,
      reason: input.reason,
    } as const;
    const requestId = request?.id ?? this.persistInterruption({ ...common, phase: "requested", request_record_id: null });
    const acknowledged = existing.some((record) => record.interruption.phase === "acknowledged");
    if (!acknowledged) {
      input.acknowledge(affectedNodeIds);
      this.persistInterruption({ ...common, phase: "acknowledged", request_record_id: requestId });
    }

    const result = interruptNode(campaign.tree, input.node_id, {
      operation_id: input.operation_id, scope: input.scope, reason: input.reason,
      partial_evidence_ids: input.partial_evidence_ids, provenance: input.provenance,
    });
    const applied = this.ledger.getInterruptions(input.campaign_id, input.operation_id)
      .some((record) => record.interruption.phase === "state_applied");
    if (!applied) this.persistInterruption({ ...common, phase: "state_applied", request_record_id: requestId });
    this.persistCampaign(campaign);
    for (const nodeId of result.affected_node_ids) {
      this.emit({ kind: "tree.node_changed", campaign_id: input.campaign_id, node_id: nodeId, state: "interrupted" });
    }
    return { affected_node_ids: affectedNodeIds, version: this.getCampaignVersion(input.campaign_id) };
  }

  /** Durable campaign/node projection used by ADR-012 recovery commands. */
  readNode(campaignId: string, nodeId: string): RecoveryNodeView | null {
    const campaign = this.campaigns.get(campaignId);
    const node = campaign?.tree.get(nodeId);
    if (!campaign || !node) return null;
    return {
      campaign_id: campaignId,
      node_id: nodeId,
      state: node.state,
      prior_operation_id: node.outcome?.kind === "interrupted" ? node.outcome.operation_id : null,
      version: this.getCampaignVersion(campaignId),
    };
  }

  /**
   * The missing `recovery.retry`/`recovery.abandon` read path: both commands
   * require a `prior_operation_id` (`runtime-contracts.ts`), but nothing
   * previously surfaced it to any client — `getCampaignSnapshot`'s node
   * projection (below) omits `TreeNode.outcome` entirely, so a caller had no
   * honest way to learn the value except by having independently recorded
   * the operation that interrupted the node.
   *
   * Scoped to `state === "interrupted"`: `tree.ts`'s `interruptNode` always
   * sets `node.outcome = {kind: "interrupted", operation_id, ...}` on that
   * transition, so `prior_operation_id` is unambiguous and always present
   * for a genuinely interrupted node. Plain "pending" nodes are deliberately
   * excluded — that is every untouched node's default resting state, not a
   * recovery signal, and including it would misreport the whole tree as
   * "needing recovery". A node stuck in "expanding" after a crash (no formal
   * interrupt was ever recorded) has no durable operation id at all; it is
   * listed with `prior_operation_id: null` — a typed "unavailable", never a
   * fabricated or zero value — rather than silently omitted.
   */
  getRecoverableNodes(campaignId: string): readonly RecoverableNodeView[] {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return [];
    const out: RecoverableNodeView[] = [];
    for (const node of campaign.tree.values()) {
      if (node.state !== "interrupted" && node.state !== "expanding") continue;
      const prior_operation_id = node.outcome?.kind === "interrupted" ? node.outcome.operation_id : null;
      out.push({ campaign_id: campaignId, node_id: node.id, state: node.state, prior_operation_id, expected_version: this.getCampaignVersion(campaignId) });
    }
    return out;
  }

  /**
   * Durable retry preparation for RecoveryService. This does not dispatch a
   * worker, increment a visit, fabricate output, or record a terminal trace.
   */
  persistRetryTransition(input: {
    request: RecoveryRequest;
    lease_id: string;
    isolation: { worktree_isolated: boolean; starting_commit_correct: boolean; lease_acquired: true };
  }): { ok: true } | { ok: false; detail: string } {
    const { request } = input;
    const campaign = this.campaigns.get(request.campaign_id);
    const node = campaign?.tree.get(request.node_id);
    if (!campaign || !node) return { ok: false, detail: "campaign or node was not found" };
    if (request.action !== "retry") return { ok: false, detail: "recovery transition is not a retry" };

    const existingDecision = this.ledger.getRecoveryDecisions(request.campaign_id, request.node_id).find(
      (record) => record.decision.recovery_operation_id === request.operation_id,
    );
    if (existingDecision) {
      const decision = existingDecision.decision;
      if (decision.decision !== "retry" || decision.actor !== request.actor_id
        || decision.reason !== request.reason || decision.prior_operation_id !== request.prior_operation_id
        || decision.new_operation_id !== request.operation_id || decision.expected_version !== request.expected_version
        || decision.lease.new_lease_id !== input.lease_id) {
        return { ok: false, detail: "recovery operation id conflicts with durable decision evidence" };
      }
      return { ok: true };
    }
    const observedVersion = this.getCampaignVersion(request.campaign_id);
    if (observedVersion !== request.expected_version) return { ok: false, detail: "snapshot version no longer matches expected_version" };
    if (node.state !== "interrupted" && node.state !== "expanding" && node.state !== "pending") return { ok: false, detail: `node state ${node.state} is not recoverable` };
    if (node.state === "interrupted" && (node.outcome?.kind !== "interrupted" || node.outcome.operation_id !== request.prior_operation_id)) {
      return { ok: false, detail: "prior_operation_id does not match the interrupted node outcome" };
    }

    const priorCheckpoint = this.ledger.getGateCheckpoints(request.campaign_id).find(
      (checkpoint) => checkpoint.node_id === request.node_id
        && checkpoint.checkpoint.transition === "node_expansion"
        && checkpoint.checkpoint.operation_id === request.operation_id,
    );
    let isolation: GateResult;
    if (priorCheckpoint) {
      isolation = {
        gate: priorCheckpoint.checkpoint.gate.gate,
        result: priorCheckpoint.checkpoint.gate.result,
        checked_at: priorCheckpoint.checkpoint.gate.checked_at,
        detail: priorCheckpoint.checkpoint.gate.detail,
        failures: [...priorCheckpoint.checkpoint.failures],
        unresolved: [...priorCheckpoint.checkpoint.unresolved],
        bypass_evidence_deficit: priorCheckpoint.checkpoint.gate.bypass_evidence_deficit,
      };
    } else {
      isolation = checkIsolation(input.isolation);
      this.checkpointGate(request.campaign_id, request.node_id, "node_expansion", request.operation_id, isolation, false);
      if (isolation.result === "fail") return { ok: false, detail: isolation.detail };
    }
    if (isolation.result === "fail") return { ok: false, detail: "durable fresh isolation evidence failed" };

    const recoveryDecision: RecoveryDecisionInput = {
      campaign_id: request.campaign_id,
      node_id: request.node_id,
      recovery_operation_id: request.operation_id,
      decision: "retry",
      actor: request.actor_id,
      authority: recoveryAuthority(request),
      reason: request.reason,
      prior_operation_id: request.prior_operation_id,
      new_operation_id: request.operation_id,
      expected_version: request.expected_version,
      observed_version: observedVersion,
      lease: { previous: "unknown", new_lease_id: input.lease_id },
      isolation: {
        result: isolation.result,
        checkpoint_operation_id: request.operation_id,
        evidence_deficit: isolation.bypass_evidence_deficit ?? null,
      },
      outcome: "authorized",
    };
    const recoveryEvidenceId = this.persistRecoveryDecision(recoveryDecision);
    attachGateRecord(node, isolation);
    const attempt: RecoveryAttempt = {
      action: "retry", operation_id: request.operation_id, prior_operation_id: request.prior_operation_id,
      actor_id: request.actor_id, reason: request.reason, expected_version: request.expected_version,
      lease_id: input.lease_id, recorded_at: new Date().toISOString(),
    };
    retryInterruptedNode(campaign.tree, request.node_id, attempt);
    this.persistCampaign(campaign);
    this.emit({ kind: "gate.recorded", campaign_id: request.campaign_id, node_id: request.node_id, gate: isolation.gate, result: isolation.result, bypass_evidence_deficit: isolation.bypass_evidence_deficit });
    this.emit({ kind: "audit.evidence_recorded", campaign_id: request.campaign_id, evidence_id: recoveryEvidenceId });
    this.emit({ kind: "tree.node_changed", campaign_id: request.campaign_id, node_id: request.node_id, state: "pending" });
    return { ok: true };
  }

  persistAbandonment(input: { request: RecoveryRequest; old_lease_state: "inactive" | "released" }): { ok: true } | { ok: false; detail: string } {
    const node = this.readNode(input.request.campaign_id, input.request.node_id);
    if (!node) return { ok: false, detail: "campaign or node was not found" };
    if (node.version !== input.request.expected_version) return { ok: false, detail: "snapshot version no longer matches expected_version" };
    if (input.request.action !== "abandon") return { ok: false, detail: "recovery transition is not an abandonment" };
    if (input.request.actor_role !== "operator" && input.request.actor_role !== "auditor") {
      return { ok: false, detail: "abandonment requires operator or auditor authority" };
    }
    const campaign = this.getCampaign(input.request.campaign_id);
    const treeNode = campaign.tree.get(input.request.node_id)!;
    if (treeNode.state !== "interrupted" && treeNode.state !== "pending" && treeNode.state !== "expanding") return { ok: false, detail: `node state ${treeNode.state} is not recoverable` };
    if (treeNode.state === "interrupted" && (treeNode.outcome?.kind !== "interrupted" || treeNode.outcome.operation_id !== input.request.prior_operation_id)) {
      return { ok: false, detail: "prior_operation_id does not match the interrupted node outcome" };
    }
    const evidence: RecoveryDecisionInput = {
      campaign_id: input.request.campaign_id, node_id: input.request.node_id,
      recovery_operation_id: input.request.operation_id, decision: "abandon",
      actor: input.request.actor_id, authority: recoveryAuthority(input.request), reason: input.request.reason,
      prior_operation_id: input.request.prior_operation_id, new_operation_id: null,
      expected_version: input.request.expected_version, observed_version: node.version,
      lease: { previous: input.old_lease_state, new_lease_id: null },
      isolation: { result: "not_checked", checkpoint_operation_id: null, evidence_deficit: null },
      outcome: "authorized",
    };
    const evidenceId = this.persistRecoveryDecision(evidence);
    const abandonment: RecoveryAbandonment = {
      action: "abandon", operation_id: input.request.operation_id, prior_operation_id: input.request.prior_operation_id,
      actor_id: input.request.actor_id, actor_role: input.request.actor_role, reason: input.request.reason,
      expected_version: input.request.expected_version, recorded_at: new Date().toISOString(),
    };
    abandonInterruptedNode(campaign.tree, input.request.node_id, abandonment);
    this.persistCampaign(campaign);
    this.emit({ kind: "audit.evidence_recorded", campaign_id: input.request.campaign_id, evidence_id: evidenceId });
    this.emit({ kind: "tree.node_changed", campaign_id: input.request.campaign_id, node_id: input.request.node_id, state: "abandoned" });
    return { ok: true };
  }

  // --- KB operations ---

  kbRead(campaignId: string, entryId: string, cap: CapabilityContext) {
    return this.scopedMemoryProjection(campaignId, cap).read(entryId, cap);
  }

  kbQuery(
    campaignId: string | null,
    filter: { type?: KBEntry["type"]; tags?: string[] } | null,
    cap: CapabilityContext,
  ) {
    if (campaignId === null) {
      const seen = new Set<string>();
      return this.kb.query(null, filter, cap).filter((entry) => {
        const value = entry.value as (KBEntry & { evidence_pointer?: string }) | null;
        const identity = value?.evidence_pointer ?? entry.id;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
    }
    return this.scopedMemoryProjection(campaignId, cap).query(campaignId, filter, cap);
  }

  kbInject(prompt: string, campaignId: string, cap: CapabilityContext, nodeId?: string): string {
    const campaign = this.getCampaign(campaignId);
    const selected = nodeId ?? campaign.root_id;
    const ancestry: string[] = [];
    let cursor = campaign.tree.get(selected);
    if (!cursor) throw new Error(`Node ${selected} not found`);
    while (cursor) {
      ancestry.push(cursor.id);
      cursor = cursor.parent_id === null ? undefined : campaign.tree.get(cursor.parent_id);
    }
    const scoped = new KnowledgeBase();
    // E-7a (AgentLAB 2602.16901, memory poisoning): `failure_mode`/`root_cause`
    // are free text sourced from a specialist's own `action_description` and a
    // critic's `critic_root_cause` (manager.ts's `journalResult`/`recordFailure`
    // — both agent-authored, both untrusted). `@arbor/kb`'s `inject()`
    // interpolates them verbatim into the next Specialist's prompt with no
    // escaping, so a poisoned KB entry (e.g. embedded newlines forging a fake
    // role header, or a literal "--- END KB CONTEXT ---" forging the boundary
    // that marks where untrusted context ends) reaches specialist context
    // unbounded. `@arbor/kb` is not this cycle's file scope, so the fix lives
    // at this manager/KB boundary instead: sanitize every entry BEFORE it is
    // fed into `scoped`, not after `inject()` has already assembled the prompt.
    const sanitizedEntries = projectMemoryFacts(this.ledger, {
      campaign_id: campaignId, node_ancestry: ancestry, capability: cap, limit: 100,
    }).map((entry) => ({
      ...entry,
      value: sanitizeMemoryEntryText(entry.value),
      failure_mode: entry.failure_mode === undefined ? undefined : sanitizeMemoryEntryText(entry.failure_mode),
      root_cause: entry.root_cause === undefined ? undefined : sanitizeMemoryEntryText(entry.root_cause),
      fix_template: entry.fix_template === undefined ? undefined : sanitizeMemoryEntryText(entry.fix_template),
    }));
    scoped.fromJSONL(sanitizedEntries.map((entry) => JSON.stringify(entry)).join("\n"));
    const target = campaign.tree.get(selected);
    const category = target?.action.category && target.action.category !== "unknown" ? target.action.category : undefined;
    return scoped.inject(prompt, campaignId, cap, category);
  }

  /** E-8: every review-waived outcome recorded for a campaign, folded with its latest `adopted`/`later_failed` amendments. */
  getWaiverOutcomes(campaignId: string): FoldedWaiverOutcome[] {
    return this.ledger.getFoldedWaiverOutcomes(campaignId);
  }

  /** Y-1 (ADR-065): the journaled write-scope mismatch observations for one campaign. */
  getScopeObservations(campaignId: string): ReturnType<EvidenceLedger["getScopeObservations"]> {
    return this.ledger.getScopeObservations(campaignId);
  }

  /** Y-1 (ADR-068): every durable advisory finding journaled for a campaign. */
  getAdvisoryEvidence(campaignId: string): ReturnType<EvidenceLedger["getAdvisoryEvidence"]> {
    return this.ledger.getAdvisoryEvidence(campaignId);
  }

  /** Y-2 (ADR-066): every scope observation for a campaign, folded with its later-repeat counts. */
  getFoldedScopeObservations(campaignId: string): ReturnType<EvidenceLedger["getFoldedScopeObservations"]> {
    return this.ledger.getFoldedScopeObservations(campaignId);
  }

  /** Y (ADR-070): every signed scope-decision hop journaled for a campaign. */
  getScopeDecisions(campaignId: string): ReturnType<EvidenceLedger["getScopeDecisions"]> {
    return this.ledger.getScopeDecisions(campaignId);
  }

  /**
   * Y-1 (ADR-066, lineage-scoped diff union): the union of tracked-write
   * paths recorded for `nodeId`'s strict ancestor lineage -- walks the
   * `parent_id` chain from the node's immediate parent upward, STOPPING AT
   * AND EXCLUDING the nearest ancestor that is both `state === "verified"`
   * and carries a genuine `critic_verdict` (already fully accepted --
   * settled, out of scope for a lineage-smuggling check) or the campaign
   * root (also excluded; an unsettled lineage that reaches the root without
   * ever hitting a verified-and-critic-approved ancestor has no "locked in"
   * boundary, but the root itself is not part of the RETRY lineage this
   * check exists for).
   *
   * Sourcing (documented precisely per the manifest): the ONLY durable
   * path-shaped evidence this data model records per node is the
   * `declared`/`observed_out_of_scope` path lists on journaled
   * `scope_observation` ledger records (`getScopeObservations`). `Provenance`
   * carries no paths (`verified`'s `cmd`/`stdout_hash` are not paths),
   * `CandidateArtifact` carries none, and `TreeNode.verified_ref` is an
   * opaque git ref/hash, not a path list -- so "each ancestor's recorded
   * result evidence" reduces, honestly, to its scope observations alone.
   * KNOWN GAP: an ancestor whose diff never mismatched its own declared
   * scope journals NO scope_observation at all (see
   * `worktree-machine-verifier.ts`'s `verifyOutcome`), so that ancestor's
   * in-scope writes leave no ledger trace to union against here -- named
   * explicitly in ADR-066 rather than silently left to be discovered.
   */
  deriveScopeLineagePaths(campaignId: string, nodeId: string): readonly string[] {
    const campaign = this.getCampaign(campaignId);
    const node = campaign.tree.get(nodeId);
    if (!node) return [];
    const observations = this.ledger.getScopeObservations(campaignId);
    const paths = new Set<string>();
    for (const ancestorId of this.lineageAncestorIds(campaign, node)) {
      for (const record of observations) {
        if (record.node_id !== ancestorId) continue;
        for (const path of record.observation.declared) paths.add(path);
        for (const path of record.observation.observed_out_of_scope) paths.add(path);
      }
    }
    return Array.from(paths);
  }

  /**
   * Y-2 (ADR-066, escalation): true iff an already-journaled `"blocked"`
   * scope observation exists, within `nodeId`'s own lineage (itself plus the
   * same strict-ancestor walk `deriveScopeLineagePaths` uses), for any of
   * `paths`. Escalation itself (flipping an audit-tier check to block) is
   * decided where `DeclaredWriteScope.enforcement` is constructed --
   * `cli.ts`'s `scopeIsAuthored`-driven composition, outside this
   * workstream's file scope (see ADR-066). This is the query primitive that
   * decision point must call: `enforcement: hasBlockedScopePrecedent(...) ?
   * "block" : (scopeIsAuthored(campaignId) ? "block" : "audit")`.
   */
  hasBlockedScopePrecedent(campaignId: string, nodeId: string, paths: readonly string[]): boolean {
    const campaign = this.getCampaign(campaignId);
    const node = campaign.tree.get(nodeId);
    if (!node) return false;
    const candidates = new Set(paths);
    const lineageIds = new Set<string>([nodeId, ...this.lineageAncestorIds(campaign, node)]);
    return this.ledger.getScopeObservations(campaignId).some((record) =>
      record.observation.enforcement === "blocked"
      && lineageIds.has(record.node_id)
      && record.observation.observed_out_of_scope.some((path) => candidates.has(path)));
  }

  /**
   * Shared ancestor walk for Y-1/Y-2: strict ancestors of `node` (never
   * `node` itself), starting at `node.parent_id` and walking upward,
   * stopping at (and excluding) the nearest verified-and-critic-approved
   * ancestor or the campaign root. See `deriveScopeLineagePaths`'s doc for
   * the exact boundary rule this implements.
   */
  private lineageAncestorIds(campaign: CampaignState, node: TreeNode): readonly string[] {
    const ids: string[] = [];
    let cursor = node.parent_id ? campaign.tree.get(node.parent_id) ?? null : null;
    while (cursor) {
      const isBoundary = cursor.state === "verified" && cursor.critic_verdict !== undefined;
      const isRoot = cursor.parent_id === null;
      if (isBoundary || isRoot) break;
      ids.push(cursor.id);
      cursor = cursor.parent_id ? campaign.tree.get(cursor.parent_id) ?? null : null;
    }
    return ids;
  }

  /**
   * Y-2 grouping key: the id of the nearest verified-and-critic-approved
   * ancestor (the same boundary `lineageAncestorIds` stops at), or the
   * campaign root when no such ancestor exists between this node and the
   * root. Two nodes sharing this value are both unresolved descendants of
   * the same "locked in" commitment point -- the notion of "lineage root"
   * `recordScopeObservation`'s fold/escalation grouping keys off of.
   */
  private lineageRootId(campaign: CampaignState, node: TreeNode): string {
    let cursor: TreeNode | undefined = node;
    while (cursor.parent_id) {
      const parent = campaign.tree.get(cursor.parent_id);
      if (!parent) break;
      if (parent.state === "verified" && parent.critic_verdict !== undefined) return parent.id;
      cursor = parent;
    }
    return campaign.root_id;
  }

  /**
   * Y (ADR-070): this campaign's signer, generating a fresh campaign-local
   * Ed25519 keypair on first use (or after a restart dropped the in-memory
   * map). Never persisted -- see `scopeDecisionKeys`'s doc.
   */
  private scopeDecisionSigner(campaignId: string): { privateKey: KeyObject; publicKeyBase64: string; lastDecisionId: string | null } {
    let entry = this.scopeDecisionKeys.get(campaignId);
    if (!entry) {
      const keys = generateKeyPairSync("ed25519");
      const publicKeyBase64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      entry = { privateKey: keys.privateKey, publicKeyBase64, lastDecisionId: null };
      this.scopeDecisionKeys.set(campaignId, entry);
    }
    return entry;
  }

  /**
   * Y (ADR-070): journal one signed scope-decision hop -- shared by
   * `approveScopeWidening`/`revokeScopeWidening`. Signs over the campaign's
   * ACTUAL current ledger tip (`EvidenceLedger.getLedgerTip`), chaining onto
   * this process's own last-minted hop for the campaign (or `null`,
   * starting a fresh generation on first use / after a restart), and stages
   * the write through the same fresh-ledger/`fromJSONL`/`saveLedger`
   * pattern every other journal method in this file uses.
   */
  private journalScopeDecision(
    campaignId: string, nodeId: string, paths: readonly string[], decision: ScopeDecisionKind,
    decidedBy: string, parentDecisionId: string | null, idempotencyKey: string,
  ): string {
    const target = this.persistenceDir ? new EvidenceLedger() : this.ledger;
    if (target !== this.ledger) target.fromJSONL(this.ledger.toJSONL());
    // Idempotency pre-check: `parentDecisionId` is computed from mutable
    // signer state (`lastDecisionId`), which a SUCCESSFUL first mint
    // advances -- so re-deriving it on a retry would build a payload with a
    // different `parent_decision_id` than the original call signed, and the
    // ledger's own idempotency check (which requires byte-identical content)
    // would reject it as a conflict rather than dedupe it. Short-circuit
    // BEFORE touching the signer/parent at all, mirroring `journalResult`'s
    // `priorFact`/`prior` pre-check idiom one file up.
    const existing = target.getScopeDecisions(campaignId).find((record) => record.decision.idempotency_key === idempotencyKey);
    if (existing) return existing.id;
    const signer = this.scopeDecisionSigner(campaignId);
    const previousRecordContentHash = target.getLedgerTip(campaignId);
    const sortedPaths = [...paths].sort();
    const payload = scopeDecisionSigningPayload({
      campaign_id: campaignId, node_id: nodeId, paths: sortedPaths, decision,
      parent_decision_id: parentDecisionId, previous_record_content_hash: previousRecordContentHash,
    });
    const signature = cryptoSign(null, Buffer.from(canonicalizeForHash(payload), "utf8"), signer.privateKey).toString("base64");
    const id = target.recordScopeDecision({
      campaign_id: campaignId, node_id: nodeId, paths: sortedPaths, decision,
      decided_by: decidedBy, parent_decision_id: parentDecisionId,
      public_key: signer.publicKeyBase64, signature, idempotency_key: idempotencyKey,
      previous_record_content_hash: previousRecordContentHash,
    });
    signer.lastDecisionId = id;
    if (this.persistenceDir) {
      saveLedger(target, this.persistenceDir, campaignId);
      this.ledger = target;
    }
    this.emit({ kind: "audit.evidence_recorded", campaign_id: campaignId, evidence_id: id });
    return id;
  }

  /**
   * Y (ADR-070): journal a signed `approved_widening` hop -- an audit-tier
   * widening judged legitimate, carried forward so a descendant node's
   * enforcement decision (the future, integrator-wired consumer; see
   * `hasApprovedWideningPrecedent`) does not have to re-litigate it. Does
   * NOT suppress `recordScopeObservation` journaling: an approved widening
   * and the raw observation it approves are deliberately decoupled evidence
   * -- see `hasApprovedWideningPrecedent`'s doc.
   */
  approveScopeWidening(campaignId: string, nodeId: string, paths: readonly string[], decidedBy: string): string {
    const signer = this.scopeDecisionSigner(campaignId);
    // Content-derived, not state-derived (mirrors `recordWaiverOutcomeFollowUp`'s
    // idiom): a genuine retry with identical (node, paths, decider) dedupes
    // to the same hop via `recordScopeDecision`'s own idempotency check,
    // which short-circuits BEFORE any parent/tip/signature validation --
    // deliberately NOT keyed off `signer.lastDecisionId`, which changes on
    // every mint and would defeat dedup on a real retry.
    const idempotencyKey = `${campaignId}:${nodeId}:approved_widening:${[...paths].sort().join(",")}:${decidedBy}`;
    return this.journalScopeDecision(campaignId, nodeId, paths, "approved_widening", decidedBy, signer.lastDecisionId, idempotencyKey);
  }

  /**
   * D51 composition seam: mint an adoption-specific, hash-bound re-scope
   * authorization only after recording the corresponding signed scope
   * widening in the campaign ledger. The result-adoption store keeps the
   * exact patch binding; this manager supplies the independently auditable
   * authorization evidence. Surface adapters must call this before the
   * separate adopt operation rather than treating a scope mismatch as an
   * implicit apply permission.
   */
  authorizeCapturedResultScope(input: {
    readonly campaign_id: string;
    readonly node_id: string;
    readonly persistence_dir: string;
    readonly expected_patch_sha256: string;
    readonly authorization_id: string;
    readonly authorized_by: string;
    readonly authorized_paths?: readonly string[];
  }): ScopeExpansionAuthorizationOutcome {
    const campaign = this.getCampaign(input.campaign_id);
    if (!campaign.tree.has(input.node_id)) return { ok: false, reason: `node ${input.node_id} does not belong to campaign ${input.campaign_id}` };
    let inspection: ReturnType<typeof inspectCapturedResult>;
    try {
      inspection = inspectCapturedResult({ persistence_dir: input.persistence_dir, campaign_id: input.campaign_id, node_id: input.node_id, max_patch_bytes: 1 });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "captured result could not be inspected" };
    }
    const violations = inspection.record.scope_violations ?? [];
    const requested = input.authorized_paths === undefined ? violations : input.authorized_paths;
    if (inspection.record.patch_sha256 !== input.expected_patch_sha256 || inspection.record.command_verified !== true || violations.length === 0
      || requested.length !== violations.length || new Set(requested).size !== requested.length || requested.some((path) => !violations.includes(path))) {
      return { ok: false, reason: "scope authorization requires the exact inspected, command-verified capture and every observed out-of-scope path" };
    }
    const evidenceId = this.approveScopeWidening(input.campaign_id, input.node_id, requested, input.authorized_by);
    return authorizeScopeExpansion({
      ...input,
      authorized_paths: requested,
      authorization_evidence_id: evidenceId,
    });
  }

  /**
   * Y (ADR-070): journal a signed `revoked` hop with parent linkage to the
   * decision it revokes. Only possible while this process still holds the
   * private key for `decisionId`'s generation (its `public_key` must match
   * this campaign's CURRENT in-memory key) -- a decision minted in an
   * earlier generation (i.e. before a process restart) cannot be revoked
   * after the restart, an explicit, documented consequence of the
   * campaign-local, never-persisted key design (ADR-070).
   */
  revokeScopeWidening(campaignId: string, decisionId: string, decidedBy: string): string {
    const target = this.ledger.getScopeDecisions(campaignId).find((record) => record.id === decisionId);
    if (!target) throw new AuditIntegrityError(`revokeScopeWidening: unknown scope decision ${decisionId} in campaign ${campaignId}`);
    const idempotencyKey = `${campaignId}:${decisionId}:revoked`;
    return this.journalScopeDecision(campaignId, target.node_id, target.decision.paths, "revoked", decidedBy, decisionId, idempotencyKey);
  }

  /**
   * Y (ADR-070): true iff `nodeId`'s lineage (itself plus the same
   * strict-ancestor walk `hasBlockedScopePrecedent` uses) carries a SIGNED,
   * UNREVOKED `approved_widening` scope decision whose `paths` cover ALL of
   * `paths`. This is a pure query primitive -- it does not itself suppress
   * anything. The enforcement-mode decision point (`cli.ts`, integrator
   * glue, outside this workstream) is the intended caller: an approved
   * widening keeps re-flagging in every descendant TODAY because nothing
   * yet consults this method from the enforcement path; `recordScopeObservation`
   * is untouched by this method and keeps journaling every raw observation
   * regardless -- evidence (what was observed) and enforcement (whether a
   * prior approval already settled it) are deliberately decoupled, so a
   * campaign's evidence trail never goes silent just because a widening was
   * approved.
   */
  hasApprovedWideningPrecedent(campaignId: string, nodeId: string, paths: readonly string[]): boolean {
    const campaign = this.getCampaign(campaignId);
    const node = campaign.tree.get(nodeId);
    if (!node) return false;
    const candidates = new Set(paths);
    const lineageIds = new Set<string>([nodeId, ...this.lineageAncestorIds(campaign, node)]);
    const decisions = this.ledger.getScopeDecisions(campaignId).filter((record) => lineageIds.has(record.node_id));
    const revokedIds = new Set(decisions.filter((record) => record.decision.decision === "revoked")
      .map((record) => record.decision.parent_decision_id).filter((id): id is string => id !== null));
    return decisions.some((record) =>
      record.decision.decision === "approved_widening"
      && !revokedIds.has(record.id)
      && [...candidates].every((path) => record.decision.paths.includes(path)));
  }

  /**
   * E-8's documented API for future feedback loops. Nothing in this cycle
   * calls this automatically — policy auto-adjustment from waiver outcomes
   * is explicitly out of scope (roadmap). This is the durable, governed way
   * a later cycle (or an operator, via a future CLI surface) records that a
   * previously-waived result later proved problematic — or, just as
   * honestly, that it did NOT (recording `false` closes out the
   * "unadjudicated" state without needing a fabricated success).
   */
  recordWaiverOutcomeFollowUp(input: {
    readonly campaign_id: string;
    readonly node_id: string;
    readonly waiver_record_id: string;
    readonly later_failed: boolean;
    readonly recorded_by: string;
    readonly reason: string;
  }): string {
    const target = this.persistenceDir ? new EvidenceLedger() : this.ledger;
    if (target !== this.ledger) target.fromJSONL(this.ledger.toJSONL());
    const id = target.recordWaiverOutcomeAmendment({
      campaign_id: input.campaign_id, node_id: input.node_id,
      waiver_record_id: input.waiver_record_id, kind: "later_failed", value: input.later_failed,
      recorded_by: input.recorded_by, reason: input.reason,
      // Content-derived, not time-derived: a retried call with the same
      // determination dedupes to the same record (this file's idempotency
      // idiom throughout), while a genuinely new determination (different
      // reason or a flip from false to true) mints a fresh amendment.
      idempotency_key: `${input.waiver_record_id}:later_failed:${input.recorded_by}:${input.later_failed}:`
        + `${createHash("sha256").update(input.reason).digest("hex")}`,
    });
    if (this.persistenceDir) {
      saveLedger(target, this.persistenceDir, input.campaign_id);
      this.ledger = target;
    }
    this.emit({ kind: "audit.evidence_recorded", campaign_id: input.campaign_id, evidence_id: id });
    return id;
  }

  /**
   * Content-minimized repository retrieval hints from ledger-authoritative
   * memory. Only verified, capability-visible tags cross this seam; fact
   * bodies remain in the KB projection and are never duplicated into search.
   */
  repositoryRetrievalMemory(campaignId: string, nodeId: string): readonly {
    readonly terms: readonly string[];
    readonly provenance: Extract<Provenance, { tag: "verified" }>;
    readonly evidence_pointer: string;
  }[] {
    const campaign = this.getCampaign(campaignId);
    const ancestry: string[] = [];
    let cursor = campaign.tree.get(nodeId);
    if (!cursor) return [];
    while (cursor) {
      ancestry.push(cursor.id);
      cursor = cursor.parent_id === null ? undefined : campaign.tree.get(cursor.parent_id);
    }
    return Object.freeze(projectMemoryFacts(this.ledger, {
      campaign_id: campaignId, node_ancestry: ancestry, capability: { tier: "specialist" }, limit: 100,
    }).flatMap((entry) => entry.provenance.tag === "verified" && entry.evidence_pointer.trim().length > 0 && entry.tags.length > 0
      ? [Object.freeze({ terms: Object.freeze([...entry.tags]), provenance: entry.provenance, evidence_pointer: entry.evidence_pointer })]
      : []));
  }

  private scopedMemoryProjection(campaignId: string, cap: CapabilityContext): KnowledgeBase {
    const campaign = this.getCampaign(campaignId);
    const scoped = new KnowledgeBase();
    scoped.fromJSONL(this.projectAllMemoryFacts(campaignId, [...campaign.tree.keys()], cap)
      .map((entry) => JSON.stringify(entry)).join("\n"));
    return scoped;
  }

  // --- Audit operations ---

  auditCampaign(campaignId: string) {
    return this.ledger.stats(campaignId);
  }

  auditBypasses(campaignId: string) {
    return this.ledger.getBypasses(campaignId);
  }

  /** Journal a bounded telemetry observation only after its source evidence is durable. */
  recordTelemetryObservation(input: TelemetryObservationInput): string {
    return this.persistenceDir
      ? persistTelemetryObservation(this.ledger, this.persistenceDir, input)
      : this.ledger.recordTelemetryObservation(input);
  }

  getTelemetryObservations(campaignId: string, limit = 1_000): import("@arbor/audit").TelemetryObservationRecord[] {
    return this.ledger.getTelemetryObservations(campaignId, limit);
  }

  recordTerminalProfile(input: TerminalProfileInput): string {
    this.getCampaign(input.campaign_id);
    return this.persistenceDir ? persistTerminalProfile(this.ledger, this.persistenceDir, input) : this.ledger.recordTerminalProfile(input);
  }

  recordTerminalNotification(input: TerminalNotificationInput): string {
    this.getCampaign(input.campaign_id);
    return this.persistenceDir ? persistTerminalNotification(this.ledger, this.persistenceDir, input) : this.ledger.recordTerminalNotification(input);
  }

  /** Latest durable evidence id for a campaign, used as a telemetry source witness. */
  getLatestEvidenceId(campaignId: string): string | null {
    const records = this.ledger.getRecords(campaignId);
    if (records.length === 0) return null;
    return records[records.length - 1].id;
  }

  /** Existing durable records for an in-flight node, suitable for an interruption's partial-evidence linkage. */
  getLatestNodeEvidenceIds(campaignId: string, nodeId: string, limit = 128): readonly string[] {
    this.getCampaign(campaignId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("partial evidence limit must be from 1 to 128");
    return this.ledger.getRecords(campaignId).filter((record) => record.node_id === nodeId).slice(-limit).map((record) => record.id);
  }

  /** Deterministically rebuild telemetry metrics from ledger authority. */
  projectTelemetry(campaignId: string, options?: TelemetryProjectionOptions): TelemetryProjection {
    return projectTelemetry(this.ledger, campaignId, options);
  }

  /** Live list-rate/context/phase HUD, rebuilt from durable telemetry on every assistant-message refresh. */
  projectCostHud(campaignId: string, contextCapacity: number | null): CostHudProjection {
    return projectCostHud(this.ledger, campaignId, contextCapacity);
  }

  /** Render the live HUD internally or through an explicitly composed status-line process. */
  renderCostStatusLine(campaignId: string, contextCapacity: number | null, external?: { command: string; args?: readonly string[]; timeout_ms?: number }): Promise<string> {
    const projection = this.projectCostHud(campaignId, contextCapacity);
    const renderer = external === undefined
      ? { render: (state: CostHudProjection) => formatCostStatusLine(state) }
      : new ShellStatusLineRenderer(external.command, external.args, external.timeout_ms);
    return renderCostStatusLine(projection, renderer);
  }

  // --- Node introspection ---

  /**
   * Read a single node's metadata (action, state, score, lineage) without
   * mutating state. Used by the loop controller to dispatch specialists and
   * branch with real Action metadata.
   */
  getNodeInfo(
    campaignId: string,
    nodeId: string,
  ): {
    id: string;
    action: Action;
    state: NodeState;
    score: number;
    parent_id: string | null;
    children_ids: string[];
    provenance: Provenance | null;
    specialist_output?: string;
    created_at: string;
    /** Durable pre-review candidate captured before critic dispatch (tranche1 §13 items 2/3). */
    candidate?: CandidateArtifact;
    /** ADR-062: present only when this node's result was accepted without a real critic verdict. */
    review_waived?: { readonly by: string; readonly reason: string };
    /** ADR-062: bounded critic-block retries already spent on this node. */
    critic_retry_count: number;
    scope_retry_count: number;
    /** Durable retry/abandon history used to prevent recovery nodes from re-entering as ordinary pending work. */
    recovery_attempts: RecoveryAttempt[];
    /** ADR-106: edge-local backpropagation bookkeeping — see `backpropagate` in @arbor/core. */
    edge_visit_count: number;
    /** Durable logical expansion attempt number; stable on re-entry and advanced on retry. */
    visit_count: number;
    value_estimate: number;
    /** ADR-185: the full reward this node's terminal transition backed up; absent before any terminal transition. */
    reward?: BackedUpReward;
  } | null {
    const campaign = this.getCampaign(campaignId);
    const node = campaign.tree.get(nodeId);
    if (!node) return null;
    return {
      id: node.id,
      action: node.action,
      state: node.state,
      score: node.score,
      parent_id: node.parent_id,
      children_ids: [...node.children_ids],
      provenance: node.provenance,
      specialist_output: node.specialist_output,
      created_at: node.created_at,
      candidate: node.candidate,
      review_waived: node.review_waived,
      critic_retry_count: node.critic_retry_count ?? 0,
      scope_retry_count: node.scope_retry_count ?? 0,
      recovery_attempts: [...(node.recovery_attempts ?? [])],
      edge_visit_count: node.edge_visit_count ?? 0,
      visit_count: node.visit_count,
      value_estimate: node.value_estimate ?? 0,
      ...(node.reward === undefined ? {} : { reward: structuredClone(node.reward) }),
    };
  }

  /**
   * Derive one fresh high-risk native-tool scope exclusively from the action
   * stored in this campaign's durable tree.  The executor never receives a
   * model/prompt-derived authority here: an omitted or malformed declaration
   * stays absent, and the host will deny high-risk tools.
   *
   * The session/worktree binding is deliberately fresh while the provenance
   * hash identifies the persisted action declaration.  Restarting from the
   * same tree therefore derives the same declared effect set without replaying
   * a prior session's authority.
   */
  deriveNativeHighRiskToolScope(input: {
    readonly campaign_id: string;
    readonly node_id: string;
    readonly session_id: string;
    readonly worktree_path: string;
  }): NativeHighRiskToolScope | null {
    if (!nonEmptyScopeAtom(input.session_id) || !input.worktree_path.trim()) return null;
    const campaign = this.campaigns.get(input.campaign_id);
    if (campaign) this.recordSessionGovernanceTier(input.session_id, campaign.governance?.tier ?? "governed");
    const node = campaign?.tree.get(input.node_id);
    if (!node) return null;
    // ADR-119 Decision §3: intent entries are available at direct/reviewed
    // tier only. A `governed` action that declares one is treated exactly
    // like a structurally malformed declaration -- refused whole, not
    // silently stripped to its literal entries -- matching ADR-088's
    // fully-literal declare-and-reject posture for that tier.
    const tier = campaign?.governance?.tier ?? "governed";
    const declaration = node.action.high_risk_tool_scope;
    if (declaration !== undefined) {
      if (!validNativeHighRiskDeclaration(declaration, tier !== "governed")) {
        // S02: this exact declaration IS structurally valid when intent
        // entries are permitted -- so if it is being refused only because
        // this tier disallows that shape, that is tier policy, not a
        // missing/broken declaration. Anything else invalid regardless of
        // tier (bad path, empty argv, ...) is the action's own authored
        // fact being broken, never a tier question.
        const reason: NativeHighRiskScopeDenialReason = validNativeHighRiskDeclaration(declaration, true) ? "tier_forbids_declared_scope" : "declared_scope_invalid";
        this.recordHighRiskScopeDenialReason(input.session_id, reason);
        return null;
      }
      this.recordHighRiskScopeDenialReason(input.session_id, null);
      return this.bindNativeHighRiskScope(input, declaration, "governed-action-scope", "campaign-manager/governed-action-scope-v1", node);
    }
    // 2026-08-24 re-bench blocker: the reviewed-tier native planner
    // (cli.ts's structured-output instruction, cli.ts:1884) sometimes
    // leaves an action's high_risk_tool_scope null even though the action's
    // own description plainly declares the write target -- deepseek-v4-pro
    // does not reliably follow that part of the schema. Rather than refuse
    // an action the task text already authorizes, mine the same
    // `extractDeclaredScope` text-mining the heuristic arbiter intake
    // already uses to grant direct/reviewed authority when the planner is
    // skipped entirely (arbiter-intake.ts). This is a fallback ONLY for an
    // action the planner left unscoped (never overrides an authored
    // declaration, valid or invalid) and ONLY outside the `governed` tier
    // -- the same tier boundary `createHeuristicArbiterIntakePort` already
    // draws for this exact function, because a governed multi-action plan
    // deliberately leaves many actions read-only by omission; mining every
    // omission there would over-grant write authority the plan never
    // intended. The resulting scope is provenance-stamped
    // "mined-action-scope-v1" (not "governed-action-scope-v1") so the audit
    // trail shows it was derived, not planner/operator-authored, and it is
    // enforced through the exact same session/worktree/path/argv checks as
    // an authored scope -- it can only ever narrow authority to what the
    // task text names, never widen beyond it.
    if (campaign?.governance?.tier === "governed") {
      this.recordHighRiskScopeDenialReason(input.session_id, "no_declared_scope");
      return null;
    }
    // Mine the action's own description AND its planner-assigned
    // `acceptance_checks` (materialized per-action by `materializePlanAcceptance`
    // via the plan's `acceptance_mapping` -- see task-composer-contracts.ts).
    // `acceptance_checks` is the strongest source this fallback has: it is
    // already scoped to exactly this action by the plan's own structured
    // criterion->action map, and an operator states the literal verification
    // command there at least as often as in `description` ("Verify by
    // running: ..."). It remains free text, not a typed command_argv field --
    // there is no such field on `Action` today (only the whole-declaration
    // `high_risk_tool_scope.command_argv`, checked above and always
    // preferred when present). Concatenating both sources can only ADD text
    // to mine from, so it can only ever narrow authority to what SOME piece
    // of task-authored text names, never widen beyond it.
    const mineable = [node.action.description, ...(node.action.acceptance_checks ?? [])].join("\n");
    const mined = extractDeclaredScope(mineable);
    if (mined.write_paths.length === 0 && mined.command_argv.length === 0) {
      this.recordHighRiskScopeDenialReason(input.session_id, "no_declared_scope");
      return null;
    }
    this.recordHighRiskScopeDenialReason(input.session_id, null);
    return this.bindNativeHighRiskScope(input, mined, "mined-action-scope", MINED_ACTION_SCOPE_GENERATOR, node);
  }

  /** `reason === null` clears a stale denial once this call actually derives a bound scope. */
  private recordHighRiskScopeDenialReason(sessionId: string, reason: NativeHighRiskScopeDenialReason | null): void {
    if (reason === null) { this.sessionHighRiskScopeDenialReason.delete(sessionId); return; }
    if (!this.sessionHighRiskScopeDenialReason.has(sessionId) && this.sessionHighRiskScopeDenialReason.size >= SESSION_GOVERNANCE_TIER_CACHE_MAX) {
      const oldest = this.sessionHighRiskScopeDenialReason.keys().next().value;
      if (oldest !== undefined) this.sessionHighRiskScopeDenialReason.delete(oldest);
    }
    this.sessionHighRiskScopeDenialReason.set(sessionId, reason);
  }

  /**
   * S02: why the most recent `deriveNativeHighRiskToolScope` call for this
   * session returned `null`, if it did. `null` means either the session
   * never derived a scope, its last derivation succeeded, or the entry was
   * evicted -- callers must treat that the same as "unknown", never as a
   * signal to grant anything.
   */
  getHighRiskScopeDenialReason(sessionId: string): NativeHighRiskScopeDenialReason | null {
    return this.sessionHighRiskScopeDenialReason.get(sessionId) ?? null;
  }

  private recordSessionGovernanceTier(sessionId: string, tier: GovernanceTier): void {
    if (!this.sessionGovernanceTier.has(sessionId) && this.sessionGovernanceTier.size >= SESSION_GOVERNANCE_TIER_CACHE_MAX) {
      const oldest = this.sessionGovernanceTier.keys().next().value;
      if (oldest !== undefined) this.sessionGovernanceTier.delete(oldest);
    }
    this.sessionGovernanceTier.set(sessionId, tier);
  }

  /**
   * The governance tier bound to a native session, as recorded by
   * `deriveNativeHighRiskToolScope` (the one call every native specialize
   * session makes, with campaign_id, before any tool call). `null` means
   * unknown -- no session with this id ever derived a scope (a review/critic
   * session, a fixed-read-only dispatch, or simply not this cache's
   * business), or the entry was evicted. Callers (`cli.ts`'s approval
   * composition) MUST treat `null` the same as `"governed"`: the safer,
   * more restrictive default, never the more permissive one.
   */
  governanceTierForSession(sessionId: string): GovernanceTier | null {
    return this.sessionGovernanceTier.get(sessionId) ?? null;
  }

  private bindNativeHighRiskScope(
    input: { readonly campaign_id: string; readonly node_id: string; readonly session_id: string; readonly worktree_path: string },
    declaration: NonNullable<Action["high_risk_tool_scope"]>,
    scopeIdPrefix: string,
    generator: string,
    node: TreeNode,
  ): NativeHighRiskToolScope {
    const source = canonicalNativeHighRiskDeclaration(input.campaign_id, input.node_id, declaration);
    const binding = JSON.stringify({ schema_version: 1, source, session_id: input.session_id, worktree_path: input.worktree_path });
    // ADR-119: split this declaration's command_argv into literal entries
    // (unchanged authority) and intent entries. An intent already durably
    // bound on THIS node (`node.bound_scope_intents`, O3) is promoted to a
    // literal entry here -- monotonic and single-shot even across a brand
    // new session/host instance (a restart or continuation), and dropped
    // from the still-unbound intent list a fresh session may still bind.
    const alreadyBound = new Map((node.bound_scope_intents ?? []).map((record) => [record.intent_index, record]));
    const literalArgv: (readonly string[])[] = [];
    const unboundIntents: { readonly bind_id: number; readonly intent: HighRiskCommandIntent }[] = [];
    declaration.command_argv.forEach((entry, index) => {
      if (Array.isArray(entry)) { literalArgv.push(Object.freeze([...entry])); return; }
      const bound = alreadyBound.get(index);
      if (bound) { literalArgv.push(bound.bound_argv); return; }
      unboundIntents.push(Object.freeze({ bind_id: index, intent: entry as HighRiskCommandIntent }));
    });
    const campaignId = input.campaign_id;
    const nodeId = input.node_id;
    const sessionId = input.session_id;
    return Object.freeze({
      scope_id: `${scopeIdPrefix}:${sha256Text(binding)}`,
      campaign_id: campaignId,
      node_id: nodeId,
      session_id: sessionId,
      worktree_root: input.worktree_path,
      provenance: Object.freeze({ tag: "generated", generator, input_hash: `sha256:${sha256Text(JSON.stringify(source))}` }),
      write_paths: Object.freeze([...declaration.write_paths]),
      command_argv: Object.freeze(literalArgv),
      ...(unboundIntents.length === 0 ? {} : {
        command_intents: Object.freeze(unboundIntents),
        // ADR-119 O3: the ONE way `native-tool-host.ts` can durably record a
        // bind. Closes over this call's own campaign/node/session identity
        // so the host never has to (and cannot) mint one itself.
        bind_intent: (bindInput: { readonly bind_id: number; readonly argv: readonly string[] }): boolean => {
          const target = unboundIntents.find((entry) => entry.bind_id === bindInput.bind_id);
          if (!target) return false;
          return this.recordScopeIntentBind({
            campaign_id: campaignId, node_id: nodeId, session_id: sessionId,
            intent_index: target.bind_id, argv_prefix: target.intent.argv_prefix, purpose: target.intent.purpose,
            bound_argv: bindInput.argv,
          });
        },
      }),
    });
  }

  /**
   * ADR-119 O3: the durable, replayable record of an intent-entry bind --
   * the condition ADR-119 was accepted on. Called synchronously by
   * `native-tool-host.ts`'s bind-on-first-use path (via the `bind_intent`
   * closure `bindNativeHighRiskScope` returns), THE MOMENT the bind
   * happens, before the call it authorizes returns a result.
   *
   * Provenance gap closure: the operator's acceptance of ADR-119's looser
   * pre-authorization rested on one recorded ground (`decisions/interviews.jsonl`)
   * -- "the bind is journaled with the exact argv, so provenance is
   * complete." `TreeNode.bound_scope_intents` alone is mutable campaign
   * state, not a journal: no hash chain, no tamper evidence. This method
   * now ALSO appends a `scope_intent_bind` record to the append-only,
   * hash-chained `EvidenceLedger` (`recordScopeIntentBind`/
   * `persistScopeIntentBind`, modeled on `recordScopeObservation`) BEFORE
   * touching the node's working state. The ledger append is idempotent on a
   * deterministic key (`campaign_id:node_id:intent_index` -- this slot can
   * only ever bind once, so the key needs no randomness), so a retry after
   * a crash between the ledger write and the node write safely converges.
   * If the ledger append throws for any reason (fsync failure, a
   * discontinuous on-disk chain, a conflicting idempotency key) the bind is
   * REFUSED -- the node's `bound_scope_intents` is never touched and this
   * returns `false`, exactly the shape `native-tool-host.ts`'s
   * `bind_intent` closure already treats as "refuse the call, do not
   * authorize an unjournaled execution."
   *
   * The node write itself remains the SAME `persistCampaign` every other
   * durable node mutation in this file uses -- fsync'd, atomic, and
   * reloaded by `persist.ts` on restart. `TreeNode.bound_scope_intents`
   * keeps its own job: fast promotion of a bound intent back to a literal
   * `command_argv` entry on re-derivation (`bindNativeHighRiskScope`
   * above); the ledger record is the provenance. Monotonic: an
   * `intent_index` already recorded here is never rebound, matching
   * `sameArgv`'s own single-shot contract one layer up.
   */
  private recordScopeIntentBind(input: {
    readonly campaign_id: string;
    readonly node_id: string;
    readonly session_id: string;
    readonly intent_index: number;
    readonly argv_prefix: readonly string[];
    readonly purpose: string;
    readonly bound_argv: readonly string[];
  }): boolean {
    const campaign = this.campaigns.get(input.campaign_id);
    const node = campaign?.tree.get(input.node_id);
    if (!campaign || !node) return false;
    // Defense in depth: `deriveNativeHighRiskToolScope` already refuses to
    // hand a governed session any command_intents/bind_intent at all, so
    // this should be unreachable in practice -- but a bind is a real
    // authorization grant, so it re-asserts the same tier boundary rather
    // than trusting the caller.
    if ((campaign.governance?.tier ?? "governed") === "governed") return false;
    if (input.bound_argv.length < input.argv_prefix.length
      || !input.argv_prefix.every((part, index) => part === input.bound_argv[index])) return false;
    const already = node.bound_scope_intents ?? [];
    if (already.some((record) => record.intent_index === input.intent_index)) return false;

    const ledgerInput: ScopeIntentBindInput = {
      campaign_id: input.campaign_id, node_id: input.node_id, session_id: input.session_id,
      intent_index: input.intent_index, argv_prefix: [...input.argv_prefix], purpose: input.purpose,
      bound_argv: [...input.bound_argv],
      // Deterministic, not random: this (campaign, node, intent_index)
      // triple binds at most once, ever, so the key needs no per-call
      // uniqueness -- a retried call after a crash lands on the same
      // ledger record instead of minting a conflicting one.
      idempotency_key: `scope-intent-bind:${input.campaign_id}:${input.node_id}:${input.intent_index}`,
    };
    try {
      if (this.persistenceDir) persistScopeIntentBind(this.ledger, this.persistenceDir, ledgerInput);
      else this.ledger.recordScopeIntentBind(ledgerInput);
    } catch {
      // Fail closed: an unjournaled bind is never a granted bind.
      return false;
    }

    const record: BoundHighRiskIntent = Object.freeze({
      intent_index: input.intent_index,
      argv_prefix: Object.freeze([...input.argv_prefix]),
      purpose: input.purpose,
      bound_argv: Object.freeze([...input.bound_argv]),
      bound_at: new Date().toISOString(),
      session_id: input.session_id,
    });
    node.bound_scope_intents = Object.freeze([...already, record]);
    this.persistCampaign(campaign);
    return true;
  }

  /** ADR-119 O3: every intent-entry bind durably recorded for this node so far (fast working-state view). */
  getBoundScopeIntents(campaignId: string, nodeId: string): readonly BoundHighRiskIntent[] {
    return this.campaigns.get(campaignId)?.tree.get(nodeId)?.bound_scope_intents ?? [];
  }

  /**
   * Provenance gap closure: the append-only, hash-chained ledger view of
   * every scope-intent bind for a campaign (optionally filtered to one
   * node) -- the durable evidence ADR-119's operator acceptance rested on,
   * distinct from `getBoundScopeIntents`'s mutable working-state view.
   */
  getScopeIntentBinds(campaignId: string, nodeId?: string): ScopeIntentBindRecord[] {
    return this.ledger.getScopeIntentBinds(campaignId, nodeId);
  }

  /**
   * Fast, free preflight for a node about to be dispatched (tranche1 §13
   * item 4/5). Before this, a malformed `action.high_risk_tool_scope`
   * declaration was only discovered mid-session — `deriveNativeHighRiskToolScope`
   * silently returns `null` for it exactly as it does for a genuinely absent
   * declaration (`!declaration || !validNativeHighRiskDeclaration(declaration)`),
   * so the host denies the specialist's write/command tools and the first
   * write/command tool call fails, after an expensive model dispatch already
   * ran. This reuses that exact same structural validity check
   * (`validNativeHighRiskDeclaration`) before any model call — but ONLY to
   * catch the unambiguous case: a declaration that IS present but
   * structurally invalid. That is a real, evidenced authoring bug (the plan
   * tried to grant scope and got it wrong).
   *
   * A merely ABSENT declaration is deliberately never flagged here.
   * `Action.high_risk_tool_scope`'s own doc says "omitted means native
   * high-risk tools deny" — that is the ordinary, common, and often entirely
   * correct state for a read-only or non-native-tool action (and is what
   * this repo's own test fixtures dispatch with throughout), not evidence of
   * a missing authorization the plan author intended to grant. Nothing
   * locally knowable from `campaign.tree` here can distinguish "this action
   * needs write access and the author forgot to declare it" from "this
   * action never needed it" — `Action` carries no separate intent field for
   * that, and guessing one from `category`/`description` text would be
   * fabricating a check this method has no evidence for. That gap is real;
   * flagging every omission as "missing" would be a false-positive preflight
   * that rejects the overwhelmingly common, legitimate case instead of the
   * one this fix actually targets.
   *
   * `workspace` is honestly always `"ready"`: worktree/lease acquisition is
   * owned by `arbor-opencode`'s `WorktreeManager`, not this manager, and
   * nothing else locally knowable from `campaign.tree` here constitutes a
   * workspace-readiness gap. Fabricating a workspace check this method
   * cannot actually perform would be worse than reporting nothing.
   */
  projectDispatchPreflight(
    campaignId: string,
    nodeId: string,
  ): {
    workspace: "ready" | "not_ready";
    authority: "sufficient" | "missing";
    reasons: readonly string[];
  } {
    const campaign = this.getCampaign(campaignId);
    const node = campaign.tree.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);

    const declaration = node.action.high_risk_tool_scope;
    const reasons: string[] = [];
    if (declaration !== undefined && !validNativeHighRiskDeclaration(declaration, (campaign.governance?.tier ?? "governed") !== "governed")) {
      reasons.push(
        "action.high_risk_tool_scope is declared but structurally invalid: the specialist's write/command tools will be denied by the host, and any attempted write or command call will only fail mid-session",
      );
    }
    return Object.freeze({
      workspace: "ready",
      authority: reasons.length > 0 ? "missing" : "sufficient",
      reasons: Object.freeze(reasons),
    });
  }

  /**
   * Walk the tree to find the best-scoring verified/claimed node chain.
   * Returns the winning path from root to the best leaf.
   */
  getBestPath(campaignId: string): { node_id: string; state: NodeState; score: number }[] {
    const campaign = this.getCampaign(campaignId);
    const path: { node_id: string; state: NodeState; score: number }[] = [];
    let current: TreeNode | null = null;
    for (const node of campaign.tree.values()) {
      if (node.state === "verified" || node.state === "claimed") {
        if (!current || node.score > current.score) current = node;
      }
    }
    if (!current) return path;
    // Walk up to root collecting the chain.
    const chain: TreeNode[] = [];
    let cursor: TreeNode | null = current;
    while (cursor) {
      chain.unshift(cursor);
      cursor = cursor.parent_id ? campaign.tree.get(cursor.parent_id) ?? null : null;
    }
    for (const node of chain) {
      path.push({ node_id: node.id, state: node.state, score: node.score });
    }
    return path;
  }

  // --- Observability introspection ---

  /**
   * List all active campaigns with summary state.
   * Read-only — safe to call from any observer.
   */
  listCampaigns(): {
    id: string;
    started_at: string;
    plan_path: string;
    halted: boolean;
    halt_reason: HaltReason;
    iterations_completed: number;
    iterations_without_kb_entry: number;
    best_score: number;
    root_node_state: NodeState | null;
    active_node_state: NodeState | null;
    active_node_id: string | null;
    active_node_description: string | null;
    active_node_role: string | null;
    failed_nodes: number;
    recovery_nodes: number;
    total_nodes: number;
    /**
     * Nodes whose state is `verified`. Added for the cockpit's campaign list,
     * which had a `verified` column reading a `verified_count` field nothing
     * ever returned — it rendered "0" for every campaign on every run. The
     * count is derived here rather than in the screen because the tree is the
     * manager's, and a projection deriving it would need the whole tree
     * shipped to the TUI just to count one state.
     */
    verified_nodes: number;
    /**
     * Derived, non-persisted outcome projection — see `TerminalOutcome`'s own
     * doc. Closes the "false completion" gap where a halt (e.g.
     * `halt_reason: "no_nodes"`) with zero verified nodes read identically to
     * a halt after real, accepted work.
     *
     * WA-12: widened locally to also carry `"cancelled"` — a supervised
     * run stopped by `job.cancel`/an operator interrupt/SIGINT before the
     * campaign itself halted. `TerminalOutcome` (arbor-core) does not carry
     * this member; adding it there is a cross-lane change, so this file
     * widens its own local read of the type instead of the shared one.
     */
    terminal_outcome: TerminalOutcome | "cancelled";
    /** Audit-tier paths that make an otherwise verified result unadoptable. */
    unadoptable_scope_violations: readonly { readonly node_id: string; readonly declared: readonly string[]; readonly observed_out_of_scope: readonly string[] }[];
  }[] {
    const result: ReturnType<CampaignManager["listCampaigns"]> = [];
    for (const [id, campaign] of this.campaigns) {
      const rootNode = campaign.tree.get(campaign.root_id);
      let verified = 0;
      let failed = 0;
      let recovery = 0;
      let activeNode: TreeNode | null = null;
      for (const node of campaign.tree.values()) {
        if (node.state === "verified") verified += 1;
        if (node.state === "failed") failed += 1;
        if (node.action.description.startsWith("[root recovery] ")) recovery += 1;
        if (activeNode === null && node.state === "expanding") activeNode = node;
      }
      if (activeNode === null) {
        for (const node of campaign.tree.values()) {
          if (node.state === "awaiting_review") { activeNode = node; break; }
        }
      }
      const unadoptableScopeViolations = this.unadoptableScopeViolations(id, campaign);
      result.push({
        id,
        started_at: campaign.started_at,
        verified_nodes: verified,
        plan_path: campaign.plan_path,
        halted: campaign.halted,
        halt_reason: campaign.halt_reason,
        iterations_completed: campaign.iterations_completed,
        iterations_without_kb_entry: campaign.iterations_without_kb_entry,
        best_score: campaign.best_score,
        root_node_state: rootNode?.state ?? null,
        active_node_state: activeNode?.state ?? null,
        active_node_id: activeNode?.id ?? null,
        active_node_description: activeNode?.action.description ?? null,
        active_node_role: activeNode?.action.delegate_to ?? null,
        failed_nodes: failed,
        recovery_nodes: recovery,
        total_nodes: campaign.tree.size,
        terminal_outcome: this.deriveTerminalOutcome(id, campaign, verified),
        unadoptable_scope_violations: unadoptableScopeViolations,
      });
    }
    return result;
  }

  /**
   * Derive `terminal_outcome` for one campaign — see the type's own doc for
   * the full semantics. `verifiedCount` is passed in by callers that already
   * counted verified nodes for their own projection, so this never re-walks
   * the tree a second time in the same pass.
   */
  private deriveTerminalOutcome(campaignId: string, campaign: CampaignState, verifiedCount: number): TerminalOutcome | "cancelled" {
    // WA-12: checked ahead of the campaign-halted gate below — a cancelled
    // run leaves `campaign.halted: false` by design (see `cancelledRuns`'
    // doc), so it would otherwise always read as the ordinary
    // `"in_progress"` case even though the run genuinely stopped and the
    // caller (`arbor task confirm --wait`) is done waiting.
    if (this.cancelledRuns.has(campaignId)) return "cancelled";
    if (!campaign.halted) return "in_progress";
    const hasVerified = verifiedCount > 0;
    let hasUnresolvedBlockers = this.deferredActionCount(campaignId) > 0;
    if (!hasUnresolvedBlockers) {
      for (const node of campaign.tree.values()) {
        if (node.state === "interrupted") { hasUnresolvedBlockers = true; break; }
      }
    }
    // WA-67 (label half): ADR-065 graduated enforcement lets a run proceed
    // in AUDIT mode when the heuristic arbiter under-declares write scope —
    // the node is genuinely marked `verified` (a real acceptance command
    // passed), but its capture touched paths outside its declared
    // authority. Reading that as an ordinary "completed" halt is exactly
    // the false-completion shape this projection exists to close: the
    // result is real but not, as recorded, cleanly adoptable — see
    // `result-adoption.ts`'s own declared-write-scope refusal at capture
    // time. Re-scoping/acknowledging the violation is a separate lane; this
    // only corrects the terminal label.
    const hasAuditScopeViolationOnVerified = hasVerified && this.unadoptableScopeViolations(campaignId, campaign).length > 0;
    if (hasVerified && !hasUnresolvedBlockers) return hasAuditScopeViolationOnVerified ? "partial" : "completed";
    if (hasUnresolvedBlockers) return "partial";
    // A critic-approved claimed node is real, accepted work that simply has
    // no machine verification (e.g. a read-only investigation, or a
    // reviewed-tier action with no declared command). Per this type's own
    // doc, "failed" is reserved for the genuine hollow halt — a halt after
    // approved work is "partial", not hollow. The root is excluded: it is
    // claimed at admission, before any critic runs.
    for (const node of campaign.tree.values()) {
      // Non-root "claimed" is critic-approved by construction: recordResult
      // only yields "claimed" after the critic gate passes (rejections go to
      // recordFailure/"failed"), and only the root is claimed at admission.
      if (node.parent_id !== null && node.state === "claimed") return "partial";
    }
    return "failed";
  }

  /** The durable audit observations that prevent a verified capture from being adopted as-scoped. */
  private unadoptableScopeViolations(campaignId: string, campaign: CampaignState): readonly { readonly node_id: string; readonly declared: readonly string[]; readonly observed_out_of_scope: readonly string[] }[] {
    return this.ledger.getScopeObservations(campaignId)
      .filter((record) => record.observation.enforcement === "audit"
        && record.observation.observed_out_of_scope.length > 0
        && campaign.tree.get(record.node_id)?.state === "verified")
      .map((record) => Object.freeze({
        node_id: record.node_id,
        declared: Object.freeze([...record.observation.declared]),
        observed_out_of_scope: Object.freeze([...record.observation.observed_out_of_scope]),
      }));
  }

  /**
   * Return a full serializable snapshot of a campaign's state, including
   * all tree nodes serialized to a plain array (not a Map, for JSON).
   * Read-only.
   */
  getCampaignSnapshot(campaignId: string): {
    id: string;
    plan_path: string;
    config: CampaignConfig;
    root_id: string;
    started_at: string;
    iterations_completed: number;
    iterations_without_kb_entry: number;
    best_score: number;
    halted: boolean;
    halt_reason: HaltReason;
    /** ADR-062: the arbiter/operator governance-tier decision for this campaign, if one was recorded at admission. */
    governance: ArbiterDecision | null;
    /**
     * Nodes whose `action.decomposition_depth` is set — i.e. produced by
     * FAULT_MATRIX's timeout -> "decompose" recovery (decompose-policy.ts's
     * `validateDecomposition` is the sole setter). Fully derived from
     * already-persisted node data; no new counter to keep in sync.
     */
    decomposed: number;
    nodes: ({
      id: string;
      action_description: string;
      action_category: string;
      action_delegate: string;
      action_estimated_gain: number;
      action_estimated_cost: number;
      /** Redacted operator projection of durable high-risk tool authority. */
      high_risk_tool_scope: { declared: boolean; write_path_count: number; command_argv_count: number; declaration_hash: string | null };
      /** Present only when produced by decompose recovery; absent otherwise. */
      decomposition_depth: number | null;
      score: number;
      state: NodeState;
      parent_id: string | null;
      children_ids: string[];
      /** Ancestor count from the root (root itself is depth 0). */
      depth: number;
      visit_count: number;
      /** ADR-106: edge-local backpropagation bookkeeping — see `backpropagate` in @arbor/core. */
      edge_visit_count: number;
      value_estimate: number;
      provenance_tag: string | null;
      /** Full provenance record — verification command/exit, critic rationale, generator id. */
      provenance: Provenance | null;
      specialist_output: string | null;
      /** Full five-mandate critic result when the loop has persisted one. */
      critic_verdict: CriticVerdict | null;
      /** Process gate checkpoints attached to this node, in recorded order. */
      gate_records: GateRecord[];
      /** Closed result projection: verdict, interruption, or classified error. */
      outcome: NodeOutcome | null;
      recovery_attempts: RecoveryAttempt[];
      memory_mode: MemoryMode;
      memory_mode_version: number;
      kb_entries_extracted: number;
      created_at: string;
      /** ADR-062: present only when this node's result was accepted without a real critic verdict. */
      review_waived: { readonly by: string; readonly reason: string } | null;
      /** ADR-062: bounded critic-block retries already spent on this node. */
      critic_retry_count: number;
      scope_retry_count: number;
    })[];
  } | null {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return null;
    const nodes = Array.from(campaign.tree.values());
    const depthOf = (n: TreeNode): number => {
      let depth = 0;
      let cursor = n.parent_id ? campaign.tree.get(n.parent_id) : undefined;
      while (cursor) {
        depth += 1;
        cursor = cursor.parent_id ? campaign.tree.get(cursor.parent_id) : undefined;
      }
      return depth;
    };
    return {
      id: campaign.id,
      plan_path: campaign.plan_path,
      config: campaign.config,
      root_id: campaign.root_id,
      started_at: campaign.started_at,
      iterations_completed: campaign.iterations_completed,
      iterations_without_kb_entry: campaign.iterations_without_kb_entry,
      best_score: campaign.best_score,
      halted: campaign.halted,
      halt_reason: campaign.halt_reason,
      governance: campaign.governance ?? null,
      decomposed: nodes.filter((n) => (n.action.decomposition_depth ?? 0) > 0).length,
      nodes: nodes.map((n) => ({
        id: n.id,
        action_description: n.action.description,
        action_category: n.action.category,
        action_delegate: n.action.delegate_to,
        action_estimated_gain: n.action.estimated_gain,
        action_estimated_cost: n.action.estimated_cost,
        high_risk_tool_scope: nativeHighRiskScopeProjection(campaign.id, n.id, n.action.high_risk_tool_scope),
        decomposition_depth: n.action.decomposition_depth ?? null,
        score: n.score,
        state: n.state,
        parent_id: n.parent_id,
        children_ids: [...n.children_ids],
        depth: depthOf(n),
        visit_count: n.visit_count,
        edge_visit_count: n.edge_visit_count ?? 0,
        value_estimate: n.value_estimate ?? 0,
        provenance_tag: n.provenance?.tag ?? null,
        provenance: n.provenance ?? null,
        specialist_output: n.specialist_output ?? null,
        critic_verdict: n.critic_verdict ?? null,
        gate_records: [...n.gate_records],
        outcome: n.outcome ?? null,
        recovery_attempts: [...(n.recovery_attempts ?? [])],
        memory_mode: n.memory_mode,
        memory_mode_version: n.memory_mode_version,
        kb_entries_extracted: n.kb_entries_extracted,
        created_at: n.created_at,
        review_waived: n.review_waived ?? null,
        critic_retry_count: n.critic_retry_count ?? 0,
        scope_retry_count: n.scope_retry_count ?? 0,
      })),
    };
  }

  // --- Serialization ---

  exportKB(): string {
    return this.kb.toJSONL();
  }

  exportAudit(campaignId: string): string {
    return this.ledger.getCampaign(campaignId).map((packet) => JSON.stringify(packet)).join("\n");
  }

  /** Immutable, complete audit projection for read-only runtime observers. */
  getAuditRecords(campaignId: string) {
    this.getCampaign(campaignId);
    return this.ledger.getRecords(campaignId);
  }

  /**
   * Durably append a node-addressed message before making it observable.
   * The audit ledger owns idempotency and linkage validation.
   */
  recordNodeCommunication(rawInput: NodeCommunicationInput): string {
    // Every agent- and operator-authored message passes this one append
    // choke point (thread, peer, bus, A2A, relay), so content is redacted
    // here, once, before the hash chain and the idempotency comparison see it.
    // Redaction is deterministic, so an identical retry still maps to the
    // same record. Only the free-text content is rewritten.
    const redactedContent = redactNativeText(rawInput.payload.content);
    const input: NodeCommunicationInput = redactedContent === rawInput.payload.content
      ? rawInput
      : { ...rawInput, payload: { ...rawInput.payload, content: redactedContent } };
    this.getCampaign(input.campaign_id);
    const existing = this.ledger.getRecords().find((record) => record.kind === "node_communication"
      && record.campaign_id === input.campaign_id
      && record.communication.idempotency_key === input.idempotency_key);
    // Stage persistent writes so a failed fsync cannot make evidence observable
    // only in memory. The durable ledger remains the communication authority.
    const target = this.persistenceDir ? new EvidenceLedger() : this.ledger;
    if (target !== this.ledger) target.fromJSONL(this.ledger.toJSONL());
    const id = target.recordNodeCommunication(input);
    if (this.persistenceDir) {
      saveLedger(target, this.persistenceDir, input.campaign_id);
      this.ledger = target;
    }
    if (!existing) this.emit({ kind: "audit.evidence_recorded", campaign_id: input.campaign_id, evidence_id: id });
    return id;
  }

  /** Capability-projected, bounded communication history; never an inbox count. */
  getNodeCommunications(
    campaignId: string,
    nodeId: string,
    tier: NodeCommunication["capability_tier"],
    limit = 100,
  ): NodeCommunicationRecord[] {
    this.getCampaign(campaignId);
    return this.ledger.getNodeCommunications(campaignId, nodeId, { tier, limit });
  }

  /**
   * Immutable selection-checkpoint projection. Callers may inject these facts
   * into a selected node's next prompt; reading does not claim delivery.
   */
  getSelectionCommunications(
    campaignId: string,
    nodeId: string,
    tier: NodeCommunication["capability_tier"],
    options: { limit?: number; as_of?: string } = {},
  ): NodeCommunicationRecord[] {
    const asOf = options.as_of === undefined ? Number.POSITIVE_INFINITY : Date.parse(options.as_of);
    if (Number.isNaN(asOf)) throw new Error("selection communication as_of must be ISO-parseable");
    return this.getNodeCommunications(campaignId, nodeId, tier, options.limit)
      .filter((record) => (record.communication.recipient_node_id === nodeId
        || record.communication.other_recipient_node_ids.includes(nodeId))
        && Date.parse(record.communication.as_of) <= asOf);
  }

  // --- Compaction lifecycle operations ---

  /**
   * Durably append a compaction lifecycle record before any projection/tree
   * state changes become observable (Commandment II). The pre_evidence_id
   * points into the content-addressed store; the guard is reconciled from
   * durable facts, never a cached flag (Commandment III).
   */
  recordCompactionLifecycle(input: CompactionLifecycleInput): string {
    this.getCampaign(input.campaign_id);
    const existing = this.ledger.getRecords().find((record) => record.kind === "compaction_lifecycle"
      && record.campaign_id === input.campaign_id
      && record.lifecycle.idempotency_key === input.idempotency_key);
    // Stage persistent writes so a failed fsync cannot make evidence observable
    // only in memory. The durable ledger remains the compaction authority.
    const target = this.persistenceDir ? new EvidenceLedger() : this.ledger;
    if (target !== this.ledger) target.fromJSONL(this.ledger.toJSONL());
    const id = target.recordCompactionLifecycle(input);
    if (this.persistenceDir) {
      saveLedger(target, this.persistenceDir, input.campaign_id);
      this.ledger = target;
    }
    if (!existing) this.emit({ kind: "audit.evidence_recorded", campaign_id: input.campaign_id, evidence_id: id });
    return id;
  }

  /**
   * Bounded, snapshot-stable compaction lifecycle query. An as_of filter
   * returns the state at a ledger sequence point.
   */
  getCompactionLifecycles(
    campaignId: string,
    nodeId?: string,
    options: { as_of?: string; limit?: number } = {},
  ): CompactionLifecycleRecord[] {
    this.getCampaign(campaignId);
    return this.ledger.getCompactionLifecycles(campaignId, nodeId, options);
  }

  // --- Phase message operations (ADR-016) ---

  /**
   * Durably journal a specialist's streaming/completed output as ledger
   * evidence, distinct from the node's critic-governed outcome
   * (`recordResult`). The only producer is `arbor-opencode`'s `runCampaign`
   * (via the telemetry port `ManagerTelemetryAdapter` wires below); there is
   * deliberately no command surface that lets an external caller fabricate
   * one (see `phase-message-contracts.ts`).
   */
  recordPhaseMessage(input: PhaseMessageInput): string {
    this.getCampaign(input.campaign_id);
    const existing = this.ledger.getRecords().find((record) => record.kind === "phase_message"
      && record.campaign_id === input.campaign_id
      && record.message.idempotency_key === input.idempotency_key);
    // Stage persistent writes so a failed fsync cannot make evidence observable
    // only in memory. The durable ledger remains the phase-message authority.
    const target = this.persistenceDir ? new EvidenceLedger() : this.ledger;
    if (target !== this.ledger) target.fromJSONL(this.ledger.toJSONL());
    const id = target.recordPhaseMessage(input);
    if (this.persistenceDir) {
      saveLedger(target, this.persistenceDir, input.campaign_id);
      this.ledger = target;
    }
    if (!existing) this.emit({ kind: "audit.evidence_recorded", campaign_id: input.campaign_id, evidence_id: id });
    return id;
  }

  /** Bounded phase-message query, optionally scoped to one node and/or phase. */
  getPhaseMessages(
    campaignId: string,
    options: { node_id?: string; phase?: PhaseMessageKind; limit?: number } = {},
  ): PhaseMessageRecord[] {
    this.getCampaign(campaignId);
    return this.ledger.getPhaseMessages(campaignId, options);
  }

  /**
   * PURE reconciliation function for the compaction guard — recomputed from
   * durable ledger facts every call, never a cached flag (Commandment III).
   *
   * Returns {active: true, since: <as_of>} if the latest compaction record for
   * this node has status "interrupted" or "failed" within the guard window.
   * A "completed" status or any record outside the window deactivates the guard.
   *
   * Default window: 300 seconds (5 minutes) — short enough that a stale
   * interrupted compaction does not permanently disable compactions for a node,
   * but long enough for a low-latency retry cycle to complete.
   */
  getCompactionGuard(
    campaignId: string,
    nodeId: string,
    windowMs = 300_000,
  ): { active: boolean; since: string | null } {
    this.getCampaign(campaignId);
    const lifecycles = this.ledger.getCompactionLifecycles(campaignId, nodeId);
    if (lifecycles.length === 0) return { active: false, since: null };
    const latest = lifecycles[lifecycles.length - 1];
    if (latest.lifecycle.status === "completed") return { active: false, since: latest.lifecycle.as_of };
    if (latest.lifecycle.status === "interrupted" || latest.lifecycle.status === "failed") {
      const asOfTime = Date.parse(latest.lifecycle.as_of);
      if (Number.isFinite(asOfTime) && Date.now() - asOfTime <= windowMs) {
        return { active: true, since: latest.lifecycle.as_of };
      }
      return { active: false, since: latest.lifecycle.as_of };
    }
    return { active: false, since: null };
  }

  /**
   * Materialize one verified, specialist-visible source fact into a target
   * campaign.  This is intentionally an explicit two-actor import, not the
   * old implicit cross-campaign success leak: the target gets a bounded
   * campaign-scoped projection while the ledger retains the source fact id,
   * source campaign, original evidence pointer, requester, and approver.
   */
  importMemoryFact(input: {
    source_campaign_id: string;
    source_memory_fact_id: string;
    target_campaign_id: string;
    target_node_id: string;
    requested_by: string;
    approved_by: string;
    idempotency_key: string;
  }): string {
    if (!input.requested_by.trim() || !input.approved_by.trim() || input.requested_by === input.approved_by || !input.idempotency_key.trim()) {
      throw new Error("memory import requires independent requester/approver and idempotency key");
    }
    this.getCampaign(input.source_campaign_id);
    this.getCampaign(input.target_campaign_id);
    if (!this.getCampaign(input.target_campaign_id).tree.has(input.target_node_id)) throw new Error("memory import target node was not found");
    const source = this.ledger.getMemoryFacts(input.source_campaign_id).find((record) => record.id === input.source_memory_fact_id);
    if (!source) throw new Error("memory import source fact was not found");
    const sourceWitness = this.ledger.getRecords(input.source_campaign_id).find((record) => record.id === source.fact.source_evidence_id);
    const sourceTrace = sourceWitness !== undefined && (sourceWitness.kind === "trace" || sourceWitness.kind === undefined)
      ? sourceWitness as TracePacket : null;
    if (source.fact.tier !== "specialist_visible" || source.fact.provenance.tag !== "verified" || sourceTrace?.provenance?.tag !== "verified") {
      throw new Error("memory import requires a verified specialist-visible source fact");
    }
    const target = this.persistenceDir ? new EvidenceLedger() : this.ledger;
    if (target !== this.ledger) target.fromJSONL(this.ledger.toJSONL());
    const id = target.recordMemoryFact({
      campaign_id: input.target_campaign_id,
      node_id: input.target_node_id,
      scope: { kind: "campaign" },
      type: source.fact.type,
      content: source.fact.content,
      provenance: structuredClone(source.fact.provenance),
      tier: "specialist_visible",
      source_evidence_id: source.fact.source_evidence_id,
      idempotency_key: input.idempotency_key,
      tags: [...source.fact.tags],
      imported_from: {
        campaign_id: input.source_campaign_id,
        memory_fact_id: source.id,
        requested_by: input.requested_by,
        approved_by: input.approved_by,
      },
    });
    if (this.persistenceDir) {
      saveLedger(target, this.persistenceDir, input.target_campaign_id);
      this.ledger = target;
    }
    this.rebuildKBProjection();
    this.emit({ kind: "kb.entry_added", campaign_id: input.target_campaign_id, entry_id: id });
    return id;
  }

  // --- User-interview operations (Phase 4D.8, ADR-019) ---

  /**
   * Emit a RequestUserInput ledger transition (ADR-019) — evidence before the
   * loop may stall (Commandment II). Lead-only question authority is enforced at
   * the gate/catalog layer (ADR-005): only the lead/root may emit `blocking`
   * questions; a delegated sibling must use async with delegated authority.
   */
  askForUserInput(input: RequestUserInputInput): string {
    this.getCampaign(input.campaign_id);
    const existing = this.ledger.getRecords().find((record) => record.kind === "request_user_input"
      && record.campaign_id === input.campaign_id
      && record.question.idempotency_key === input.idempotency_key);
    const target = this.persistenceDir ? new EvidenceLedger() : this.ledger;
    if (target !== this.ledger) target.fromJSONL(this.ledger.toJSONL());
    const id = target.recordRequestUserInput(input);
    if (this.persistenceDir) {
      saveLedger(target, this.persistenceDir, input.campaign_id);
      this.ledger = target;
    }
    if (!existing) this.emit({ kind: "audit.evidence_recorded", campaign_id: input.campaign_id, evidence_id: id });
    return id;
  }

  /** Bounded, snapshot-stable list of user-interview records for a campaign. */
  getUserInputs(
    campaignId: string,
    nodeId?: string,
    options: { limit?: number } = {},
  ): RequestUserInputRecord[] {
    this.getCampaign(campaignId);
    return this.ledger.getRequestUserInputs(campaignId, nodeId, options);
  }

  /** Ids of this campaign's questions that already have an answer record. */
  answeredUserInputIds(campaignId: string, nodeId?: string): string[] {
    this.getCampaign(campaignId);
    return this.ledger.answeredQuestionIds(campaignId, nodeId);
  }

  /** PURE reconciliation: is the loop blocked on an unanswered interview? */
  awaitingUserInput(campaignId: string, nodeId?: string, scope: "blocking" | "any" = "blocking"): boolean {
    this.getCampaign(campaignId);
    return this.ledger.awaitingUserInput(campaignId, nodeId, scope);
  }

  /** Append the human's answer as its own ledger record (approve-from-ledger). */
  answerUserInput(recordId: string, answer: UserInputAnswer): RequestUserInputRecord {
    const record = this.ledger.getRecords().find((r): r is RequestUserInputRecord => r.kind === "request_user_input" && r.id === recordId);
    if (!record) throw new Error(`RequestUserInput record ${recordId} not found`);
    const target = this.persistenceDir ? new EvidenceLedger() : this.ledger;
    if (target !== this.ledger) target.fromJSONL(this.ledger.toJSONL());
    target.recordUserInputAnswer({ campaign_id: record.campaign_id, node_id: record.node_id, question_record_id: recordId, answer });
    if (this.persistenceDir) {
      saveLedger(target, this.persistenceDir, record.campaign_id);
      this.ledger = target;
    }
    // A native/model handoff pauses before a Specialist result exists, leaving
    // its exact node in `expanding`.  The append-only answer is the durable
    // prerequisite for making that one node selectable again; no dispatch,
    // approval, or sibling state change occurs at this boundary.
    const campaign = this.getCampaign(record.campaign_id);
    resumeAwaitingUserInputNode(campaign.tree, record.node_id);
    this.persistCampaign(campaign);
    this.emit({ kind: "tree.node_changed", campaign_id: record.campaign_id, node_id: record.node_id, state: this.getNodeInfo(record.campaign_id, record.node_id)?.state ?? "pending" });
    return record;
  }

  // --- Conversation bus operations (Phase 4D.2) ---

  /**
   * Bounded, snapshot-stable conversation-bus projection. Replays durable
   * NodeCommunicationRecord[] from the audit ledger — never a mailbox/count
   * file (Commandment III). Capability tiers redact structurally at projection.
   */
  getConversationBus(
    campaignId: string,
    options: { as_of?: string; limit?: number; conversation_id?: string; tier?: NodeCommunication["capability_tier"] } = {},
  ): import("./conversation-bus.js").ConversationBusProjection {
    this.getCampaign(campaignId);
    const records = this.ledger.getRecords(campaignId).filter(
      (record): record is NodeCommunicationRecord => record.kind === "node_communication",
    );
    return projectConversationBus(records, { campaign_id: campaignId, ...options });
  }

  /**
   * Durably append a conversation-bus message. Thin wrapper over
   * recordNodeCommunication that requires a non-null conversation_id (≤512
   * bytes). Idempotent on idempotency_key; conflicts loudly on different payload.
   */
  recordBusMessage(
    input: NodeCommunicationInput & { conversation_id: string },
  ): string {
    if (!input.conversation_id || !input.conversation_id.trim()) {
      throw new Error("conversation_id must be non-empty");
    }
    if ([...input.conversation_id].length > 512) {
      throw new Error("conversation_id must be ≤512 bytes");
    }
    return this.recordNodeCommunication(input);
  }

  /** Durable evidence deficit for a compensated sibling-spawn attempt. */
  recordSiblingSpawnCompensation(campaignId: string, nodeId: string, operationId: string, reason: string): void {
    const campaign = this.getCampaign(campaignId); const node = campaign.tree.get(nodeId);
    if (!node) return;
    const gate = bypassGate("isolation", `sibling spawn compensated: ${reason}`, "isolated sibling worktree/supervisor activation did not complete");
    this.checkpointGate(campaignId, nodeId, "sibling_spawn", operationId, gate);
    attachGateRecord(node, gate); this.persistCampaign(campaign);
  }

  /**
   * Append one message in a direct parent↔child thread. Both directions are
   * valid: `from_node_id` is checked against the durable tree relationship,
   * rather than assuming a parent always starts a conversation. The ledger is
   * still the single writer and idempotency authority.
   */
  recordParentChildThreadMessage(input: Omit<NodeCommunicationInput, "conversation_id"> & {
    parent_node_id: string;
    child_node_id: string;
    expected_thread_version: string;
  }): { message_id: string; thread_id: string } {
    const snapshot = this.getCampaignSnapshot(input.campaign_id);
    if (!snapshot) throw new Error(`campaign ${input.campaign_id} was not found`);
    const child = snapshot.nodes.find((node) => node.id === input.child_node_id);
    if (!child || child.parent_id !== input.parent_node_id) throw new Error("thread endpoint conflict: endpoints must be a direct parent and child in this campaign");
    const endpoints = new Set([input.parent_node_id, input.child_node_id]);
    if (!endpoints.has(input.author_node_id) || !endpoints.has(input.recipient_node_id) || input.author_node_id === input.recipient_node_id) {
      throw new Error("thread endpoint conflict: author and recipient must be opposite direct parent/child endpoints");
    }
    const thread_id = parentChildThreadId(input.parent_node_id, input.child_node_id);
    const current = projectParentChildThread(
      this.ledger.getRecords(input.campaign_id).filter((record): record is NodeCommunicationRecord => record.kind === "node_communication"),
      { campaign_id: input.campaign_id, parent_node_id: input.parent_node_id, child_node_id: input.child_node_id, tier: "orchestrator", limit: 1000 },
    ).version;
    if (input.expected_thread_version !== current) throw new Error(`thread version conflict: expected ${input.expected_thread_version}, current ${current}`);
    const linkedRecords = new Map<string, NodeCommunicationRecord>();
    for (const linkedId of [input.parent_communication_id, input.acknowledges_communication_id, input.retracts_communication_id, input.reply_to_communication_id]) {
      if (!linkedId) continue;
      const linked = this.ledger.getRecords(input.campaign_id).find(
        (record): record is NodeCommunicationRecord => record.kind === "node_communication" && record.id === linkedId,
      );
      if (!linked || linked.communication.conversation_id !== thread_id) throw new Error(`thread linkage conflict: ${linkedId} is not in this parent-child thread`);
      linkedRecords.set(linkedId, linked);
    }
    if (input.reply_to_communication_id) {
      const replyTo = linkedRecords.get(input.reply_to_communication_id)!;
      if (!replyTo.communication.recipient_node_id || replyTo.communication.recipient_node_id !== input.author_node_id) {
        throw new Error("thread reply conflict: only the reply target's recipient may reply");
      }
      if (replyTo.communication.correlation_id !== input.correlation_id) {
        throw new Error("thread correlation conflict: reply must retain the target correlation_id");
      }
    }
    const message_id = this.recordBusMessage({ ...input, conversation_id: thread_id });
    return { message_id, thread_id };
  }

  /**
   * Append an explicit acknowledgement to one ack-required direct-thread
   * record. The target remains immutable; idempotency and restart recovery are
   * inherited from the same audit ledger append as ordinary sends.
   */
  acknowledgeParentChildThreadMessage(input: {
    campaign_id: string; parent_node_id: string; child_node_id: string; from_node_id: string;
    expected_thread_version: string; message_id: string; provenance: NodeCommunication["payload"]["provenance"];
    capability_tier: NodeCommunication["capability_tier"]; as_of: string; correlation_id: string; idempotency_key: string;
    remote_attribution?: NonNullable<NodeCommunication["remote_attribution"]>;
  }): { message_id: string; thread_id: string } {
    const target = this.ledger.getRecords(input.campaign_id).find(
      (record): record is NodeCommunicationRecord => record.kind === "node_communication" && record.id === input.message_id,
    );
    const threadId = parentChildThreadId(input.parent_node_id, input.child_node_id);
    if (!target || target.communication.conversation_id !== threadId) throw new Error("thread acknowledgement conflict: target is not in this parent-child thread");
    if (!target.communication.ack_required) throw new Error("thread acknowledgement conflict: target does not require acknowledgement");
    if (target.communication.recipient_node_id !== input.from_node_id) throw new Error("thread acknowledgement conflict: only the target recipient may acknowledge");
    return this.recordParentChildThreadMessage({
      campaign_id: input.campaign_id, node_id: input.from_node_id,
      parent_node_id: input.parent_node_id, child_node_id: input.child_node_id,
      expected_thread_version: input.expected_thread_version,
      author_node_id: input.from_node_id, recipient_node_id: target.communication.author_node_id,
      other_recipient_node_ids: [], kind: "reply",
      payload: { content: `Acknowledged ${input.message_id}`, provenance: input.provenance },
      capability_tier: input.capability_tier, trigger_turn: false, as_of: input.as_of,
      correlation_id: target.communication.correlation_id, idempotency_key: input.idempotency_key,
      acknowledges_communication_id: input.message_id, retracts_communication_id: null,
      parent_communication_id: null, intent: "notify", reply_to_communication_id: input.message_id,
      ack_required: false, deadline_at: null,
      ...(input.remote_attribution === undefined ? {} : { remote_attribution: input.remote_attribution }),
    });
  }

  /** A capability-filtered, restart-stable projection of exactly one direct thread. */
  getParentChildThread(
    campaignId: string,
    parentNodeId: string,
    childNodeId: string,
    options: { as_of?: string; limit?: number; tier?: NodeCommunication["capability_tier"] } = {},
  ): import("./conversation-bus.js").ParentChildThreadProjection {
    const snapshot = this.getCampaignSnapshot(campaignId);
    if (!snapshot) throw new Error(`campaign ${campaignId} was not found`);
    const child = snapshot.nodes.find((node) => node.id === childNodeId);
    if (!child || child.parent_id !== parentNodeId) throw new Error("thread endpoint conflict: endpoints must be a direct parent and child in this campaign");
    const records = this.ledger.getRecords(campaignId).filter((record): record is NodeCommunicationRecord => record.kind === "node_communication");
    const projected = projectParentChildThread(records, { campaign_id: campaignId, parent_node_id: parentNodeId, child_node_id: childNodeId, ...options });
    const parent = snapshot.nodes.find((node) => node.id === parentNodeId)!;
    // NOT isTerminalNodeState: a claimed node is done expanding but its thread
    // stays open, because a claim is when an operator most wants to respond.
    // See @arbor/core's STATES_CLOSED_TO_DIRECT_INPUT for why these two
    // predicates are deliberately different sets.
    return Object.freeze({ ...projected, can_accept_direct_input: !snapshot.halted && !isClosedToDirectInput(parent.state) && !isClosedToDirectInput(child.state) });
  }

  // --- Sibling background agent reconciliation (Phase 4D.5) ---

  /**
   * PURE reconciliation of sibling status from durable ledger facts. A sibling
   * is active when a `delegate` NodeCommunication has no matching `report` or
   * `retract` acknowledging it. Never an in-memory count — recomputed every
   * call (Commandment III).
   */
  getSiblingStatus(
    campaignId: string,
    nodeId: string,
  ): { active: readonly string[]; depth: number; within_bounds: boolean } {
    this.getCampaign(campaignId);
    const records = this.ledger.getRecords(campaignId).filter(
      (record): record is NodeCommunicationRecord => record.kind === "node_communication",
    );

    // Delegates authored by this node spawn siblings. Reports/retracts that
    // acknowledge a delegate close them. Active = spawned - closed.
    const spawned = new Map<string, string>(); // sibling_node_id → delegate_record_id
    for (const record of records) {
      const comm = record.communication;
      if (comm.kind === "delegate" && comm.author_node_id === nodeId) {
        const siblingId = comm.recipient_node_id;
        if (!spawned.has(siblingId)) spawned.set(siblingId, record.id);
      }
    }
    const closed = new Set<string>();
    for (const record of records) {
      const comm = record.communication;
      if ((comm.kind === "report" || comm.kind === "retract") && comm.acknowledges_communication_id !== null) {
        for (const [siblingId, delegateId] of spawned) {
          if (comm.acknowledges_communication_id === delegateId) closed.add(siblingId);
        }
      }
    }
    const active = [...spawned.keys()].filter((id) => !closed.has(id)).sort();

    // Depth: count the chain of delegate edges from this node upward through
    // ancestors. A node whose parent delegated to it is at depth ≥1.
    let depth = 0;
    const nodeRecords = records.filter(
      (r) => r.communication.recipient_node_id === nodeId && r.communication.kind === "delegate",
    );
    if (nodeRecords.length > 0) depth = 1; // this node was delegated-to; minimal depth trace

    const MAX_NESTING_DEPTH = 4;
    const MAX_SIMULTANEOUS_SIBLINGS = 8;
    const withinBounds = active.length <= MAX_SIMULTANEOUS_SIBLINGS && depth <= MAX_NESTING_DEPTH;

    return { active, depth, within_bounds: withinBounds };
  }

  // --- Internal ---

  private getCampaign(id: string): CampaignState {
    const campaign = this.campaigns.get(id);
    if (!campaign) throw new Error(`Campaign ${id} not found`);
    return campaign;
  }

  private persistCampaign(campaign: CampaignState): void {
    if (!this.persistenceDir) return;
    const deferredActions = this.deferredActions.get(campaign.id);
    let toSave = campaign;
    if (deferredActions && deferredActions.length > 0) {
      toSave = { ...campaign, deferredActions };
    } else if (campaign.deferredActions !== undefined) {
      // The manager-local map is the source of truth; a campaign snapshot
      // carrying a stale `deferredActions` (e.g. reloaded from disk before a
      // deferred action was admitted, or a stale reference held elsewhere)
      // must not resurrect an already-admitted/released dependency on the
      // next restart.
      const { deferredActions: _stale, ...rest } = campaign;
      toSave = rest as CampaignState;
    }
    saveCampaign(toSave, this.persistenceDir);
    this.activeCampaignId = campaign.halted ? this.findNewestActiveCampaignId() : campaign.id;
    this.writeBoulderPointer();
  }

  private persistInterruption(input: InterruptionInput): string {
    const target = this.persistenceDir ? new EvidenceLedger() : this.ledger;
    if (target !== this.ledger) target.fromJSONL(this.ledger.toJSONL());
    const id = target.recordInterruption(input);
    if (this.persistenceDir) {
      saveLedger(target, this.persistenceDir, input.campaign_id);
      this.ledger = target;
    }
    this.emit({ kind: "audit.evidence_recorded", campaign_id: input.campaign_id, evidence_id: id });
    return id;
  }

  private checkpointGate(
    campaignId: string,
    nodeId: string,
    transition: GovernedTransition,
    operationId: string,
    result: GateResult,
    emitEvent = true,
  ): string {
    const prior = this.ledger.getGateCheckpoints(campaignId).find((record) =>
      record.node_id === nodeId && record.checkpoint.transition === transition
      && record.checkpoint.operation_id === operationId);
    if (prior) {
      const witnessed = prior.checkpoint.gate;
      if (witnessed.gate !== result.gate || witnessed.result !== result.result
        || witnessed.detail !== result.detail
        || witnessed.bypass_evidence_deficit !== result.bypass_evidence_deficit
        || JSON.stringify(prior.checkpoint.failures) !== JSON.stringify(result.failures)
        || JSON.stringify(prior.checkpoint.unresolved) !== JSON.stringify(result.unresolved)) {
        throw new Error(`conflicting gate checkpoint for operation ${operationId}`);
      }
      return prior.id;
    }
    const gate: GateRecord = {
      gate: result.gate,
      result: result.result,
      checked_at: result.checked_at,
      detail: result.detail,
      bypass_evidence_deficit: result.bypass_evidence_deficit,
    };
    const input = {
      campaign_id: campaignId,
      node_id: nodeId,
      transition,
      operation_id: operationId,
      gate,
      failures: [...result.failures],
      unresolved: [...result.unresolved],
    };
    const evidenceId = this.persistenceDir
      ? persistGateCheckpoint(this.ledger, this.persistenceDir, input)
      : this.ledger.recordGateCheckpoint(input);
    if (emitEvent) this.emit({ kind: "gate.recorded", campaign_id: campaignId, node_id: nodeId, gate: gate.gate, result: gate.result, bypass_evidence_deficit: gate.bypass_evidence_deficit });
    return evidenceId;
  }

  private persistRecoveryDecision(decision: RecoveryDecisionInput): string {
    return this.persistenceDir
      ? persistRecoveryDecision(this.ledger, this.persistenceDir, decision)
      : this.ledger.recordRecoveryDecision(decision);
  }

  private restoreAuditLedgers(): void {
    if (!this.persistenceDir) return;
    // Audit can be durably ahead of a tree snapshot if a process stopped after
    // a gate checkpoint was fsynced. Include those ledgers in the projection;
    // otherwise an orphan admission/expansion would be invisible at restart.
    const auditDir = join(this.persistenceDir, "audit");
    const campaignIds = new Set(this.campaigns.keys());
    if (existsSync(auditDir)) {
      for (const file of readdirSync(auditDir)) {
        if (file.endsWith(".jsonl")) campaignIds.add(file.slice(0, -".jsonl".length));
      }
    }
    for (const campaignId of campaignIds) {
      const persisted = loadLedgerResult(this.persistenceDir, campaignId);
      this.persistenceDiagnostics.push(...persisted.diagnostics);
      if (persisted.value) this.ledger.fromJSONL(persisted.value.toJSONL());
    }
  }

  /**
   * Compare durable tree state with durable checkpoints and action traces.
   * This is deliberately a projection, not a replay engine: a trace that
   * disagrees with its snapshot is a conflict for an operator to resolve, not
   * authority to mutate the tree after a crash.
   */
  private projectStartupRecovery(): void {
    this.recoveryDiagnostics = [];
    const campaignIds = new Set<string>();
    for (const campaign of this.campaigns.values()) campaignIds.add(campaign.id);
    for (const record of this.ledger.getRecords()) campaignIds.add(record.campaign_id);

    for (const campaignId of campaignIds) {
      const campaign = this.campaigns.get(campaignId);
      const checkpoints = this.ledger.getGateCheckpoints(campaignId);
      const traces = this.ledger.getCampaign(campaignId);

      if (!campaign) {
        for (const checkpoint of checkpoints) {
          this.recoveryDiagnostics.push({
            code: checkpoint.checkpoint.transition === "campaign_start"
              ? "orphan_admission_checkpoint"
              : "orphan_gate_checkpoint",
            campaign_id: campaignId,
            node_id: checkpoint.node_id,
            operation_id: checkpoint.checkpoint.operation_id,
            detail: `durable ${checkpoint.checkpoint.transition} checkpoint has no campaign snapshot`,
          });
        }
        for (const trace of traces) {
          this.recoveryDiagnostics.push({
            code: "trace_references_unknown_node",
            campaign_id: campaignId,
            node_id: trace.node_id,
            trace_id: trace.id,
            detail: "durable action trace has no campaign snapshot",
          });
        }
        continue;
      }

      const isolationByNode = new Map<string, typeof checkpoints>();
      for (const checkpoint of checkpoints) {
        const node = campaign.tree.get(checkpoint.node_id);
        if (!node) {
          this.recoveryDiagnostics.push({
            code: "orphan_gate_checkpoint",
            campaign_id: campaignId,
            node_id: checkpoint.node_id,
            operation_id: checkpoint.checkpoint.operation_id,
            detail: `durable ${checkpoint.checkpoint.transition} checkpoint references no node in the snapshot`,
          });
          continue;
        }
        if (checkpoint.checkpoint.transition === "node_expansion") {
          const entries = isolationByNode.get(node.id) ?? [];
          entries.push(checkpoint);
          isolationByNode.set(node.id, entries);
        }
      }

      const terminalTraceByNode = new Map<string, TracePacket>();
      for (const trace of traces) {
        const node = campaign.tree.get(trace.node_id);
        if (!node) {
          this.recoveryDiagnostics.push({
            code: "trace_references_unknown_node",
            campaign_id: campaignId,
            node_id: trace.node_id,
            trace_id: trace.id,
            detail: "durable action trace references no node in the snapshot",
          });
          continue;
        }
        if (isTerminalNodeState(trace.node_state_after)) {
          terminalTraceByNode.set(trace.node_id, trace);
          if (node.state !== trace.node_state_after) {
            this.recoveryDiagnostics.push({
              code: "terminal_trace_conflicts_with_snapshot",
              campaign_id: campaignId,
              node_id: node.id,
              trace_id: trace.id,
              detail: `trace records ${trace.node_state_after} but snapshot records ${node.state}`,
            });
          }
        }
      }

      for (const node of campaign.tree.values()) {
        if (node.state === "pending" && isolationByNode.has(node.id)) {
          const latest = isolationByNode.get(node.id)!.at(-1)!;
          const authorizedRetry = this.ledger.getRecoveryDecisions(campaignId, node.id).some(
            (decision) => decision.decision.decision === "retry"
              && decision.decision.outcome === "authorized"
              && decision.decision.new_operation_id === latest.checkpoint.operation_id,
          );
          if (!authorizedRetry) {
            this.recoveryDiagnostics.push({
              code: "pending_node_has_isolation_checkpoint",
              campaign_id: campaignId,
              node_id: node.id,
              operation_id: latest.checkpoint.operation_id,
              detail: "node is pending despite durable isolation evidence for expansion",
            });
          }
        }
        if (node.state !== "expanding") continue;
        const isolation = isolationByNode.get(node.id) ?? [];
        const terminal = terminalTraceByNode.get(node.id);
        if (terminal) continue; // its conflicting state is already explicit above.
        if (isolation.length > 0) {
          const latest = isolation.at(-1)!;
          this.recoveryDiagnostics.push({
            code: "interrupted_expansion",
            campaign_id: campaignId,
            node_id: node.id,
            operation_id: latest.checkpoint.operation_id,
            detail: "node is expanding with durable isolation evidence but no terminal action trace",
          });
        } else {
          this.recoveryDiagnostics.push({
            code: "expanding_without_isolation_checkpoint",
            campaign_id: campaignId,
            node_id: node.id,
            detail: "node is expanding but no durable isolation checkpoint was found",
          });
        }
      }
    }
  }

  /**
   * Restore complete campaign snapshots before consulting boulder.json. The
   * latter is a convenience pointer, never permission to discard valid state.
   */
  private restoreCampaigns(): void {
    if (!this.persistenceDir) return;
    for (const id of listPersistedCampaigns(this.persistenceDir)) {
      const loaded = loadCampaignResult(id, this.persistenceDir);
      this.persistenceDiagnostics.push(...loaded.diagnostics);
      const campaign = loaded.value;
      if (!campaign) continue;
      if (campaign.deferredActions && campaign.deferredActions.length > 0) {
        this.deferredActions.set(id, campaign.deferredActions.map((entry) => ({ action: entry.action, depends_on: entry.depends_on })));
      }
      this.campaigns.set(id, campaign);
      const start = Date.parse(campaign.started_at);
      this.campaignStartTimes.set(id, Number.isFinite(start) ? start : Date.now());
      this.emit({ kind: "campaign.changed", campaign_id: id, change: "restored" });
    }

    const boulderResult = readBoulderResult(this.persistenceDir);
    this.persistenceDiagnostics.push(...boulderResult.diagnostics);
    const boulder = boulderResult.value;
    const pointed = boulder ? this.campaigns.get(boulder.active_campaign) : undefined;
    this.activeCampaignId = pointed && !pointed.halted
      ? pointed.id
      : this.findNewestActiveCampaignId();

    // Repair a missing, malformed, or stale pointer when a resumable campaign
    // exists. No continuation marker or synthetic task registry is introduced.
    if (this.activeCampaignId && this.activeCampaignId !== boulder?.active_campaign) {
      this.writeBoulderPointer();
    }
  }

  private findNewestActiveCampaignId(): string | null {
    let newest: CampaignState | null = null;
    for (const campaign of this.campaigns.values()) {
      if (campaign.halted) continue;
      if (!newest || campaign.started_at > newest.started_at) newest = campaign;
    }
    return newest?.id ?? null;
  }

  private writeBoulderPointer(): void {
    if (!this.persistenceDir || !this.activeCampaignId) return;
    const campaign = this.campaigns.get(this.activeCampaignId);
    if (!campaign) return;
    writeBoulder(this.persistenceDir, {
      active_plan: campaign.plan_path,
      active_campaign: campaign.id,
      session_ids: [],
      started_at: campaign.started_at,
      plan_name: basename(campaign.plan_path),
    });
  }

  private hasMemoryFact(campaignId: string, type: KBEntry["type"], content: string, includeCrossCampaign = false): boolean {
    return this.ledger.getRecords().some((record) => record.kind === "memory_fact" && record.fact.type === type
      && record.fact.content === content && (record.campaign_id === campaignId || (includeCrossCampaign && record.fact.scope.kind === "cross_campaign")));
  }

  /**
   * Campaign-local convergence novelty for `recordResult`'s success path.
   * Deliberately independent of `hasMemoryFact`/the ledger: whether a
   * success_pattern fact was durably written depends on the memory-pollution
   * gate (verified-only), and asking the ledger conflates "was this novel in
   * this campaign" with "was this campaign allowed to write cross-campaign
   * memory" — that conflation is exactly what made the convergence counter
   * reset on every claimed success. Instead this scans the campaign's own
   * tree (persisted with the campaign, restored on reload) for any other
   * node — claimed or verified — that already recorded the same success
   * value.
   */
  private isNovelCampaignSuccess(campaign: CampaignState, nodeId: string, successValue: string): boolean {
    for (const [id, other] of campaign.tree) {
      if (id === nodeId) continue;
      if (other.state !== "verified" && other.state !== "claimed") continue;
      if (`${other.action.description}: succeeded` === successValue) return false;
    }
    return true;
  }

  /** Replace the disposable KB cache with a deterministic ledger projection. */
  private rebuildKBProjection(): void {
    const previous = this.kb;
    const projected = this.createKbCache();
    const campaignIds = new Set(this.ledger.getRecords().map((record) => record.campaign_id));
    for (const campaignId of [...campaignIds].sort()) {
      const ancestry = [...(this.campaigns.get(campaignId)?.tree.keys() ?? [])];
      const entries = this.projectAllMemoryFacts(campaignId, ancestry);
      projected.fromJSONL(entries.map((entry) => JSON.stringify(entry)).join("\n"));
    }
    this.kb = projected;
    if (this.persistenceDir) {
      if (projected instanceof SqliteKbStore) saveKBToSqlite(projected, this.persistenceDir);
      else saveKBProjection(projected as KnowledgeBase, this.persistenceDir);
    }
    if (previous instanceof SqliteKbStore) previous.close();
  }

  /** Legacy KB rows without a witnessed MemoryFact are reported, never blessed. */
  private reconcileKBProjection(): void {
    const legacy = this.kb.getEntries();
    const facts = this.ledger.getRecords().filter((record) => record.kind === "memory_fact");
    const projectedIds = new Set<string>();
    for (const campaignId of new Set(facts.map((record) => record.campaign_id))) {
      const ancestry = [...(this.campaigns.get(campaignId)?.tree.keys() ?? [])];
      for (const entry of this.projectAllMemoryFacts(campaignId, ancestry)) projectedIds.add(entry.id);
    }
    const unwitnessed = legacy.filter((entry) => !projectedIds.has(entry.id));
    if (unwitnessed.length > 0) {
      for (const entry of unwitnessed) this.recoveryDiagnostics.push({
        code: "legacy_unwitnessed_kb", campaign_id: entry.campaign_id, node_id: "root",
        detail: `legacy KB entry ${entry.id} has no witnessed memory fact and was excluded from the projection`,
      });
    }
    this.rebuildKBProjection();
    if (facts.length > 0 && (legacy.length !== facts.length || unwitnessed.length > 0)) this.recoveryDiagnostics.push({
      code: "kb_projection_rebuilt", campaign_id: facts[0]!.campaign_id, node_id: facts[0]!.node_id,
      detail: `rebuilt ${facts.length} witnessed memory fact(s) into the KB projection`,
    });
  }

  private projectAllMemoryFacts(campaignId: string, nodeAncestry: string[], capability: CapabilityContext = { tier: "auditor" }) {
    const entries: ReturnType<typeof projectMemoryFacts> = [];
    let cursor: string | undefined;
    for (;;) {
      const page = projectMemoryFactsPage(this.ledger, {
        campaign_id: campaignId, node_ancestry: nodeAncestry, capability, limit: 1_000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      entries.unshift(...page.entries);
      if (!page.has_more || page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    return entries;
  }

  private journalResult(
    campaignId: string, nodeId: string, stateBefore: NodeState, stateAfter: NodeState,
    scoreBefore: number, scoreAfter: number,
    params: Parameters<CampaignManager["recordResult"]>[2],
    fact: Pick<MemoryFactInput, "scope" | "type" | "content" | "provenance" | "tags"> | null,
    governed?: { transition: GovernedTransition; operation_id: string },
  ): { traceId: string; kbId: string | null } {
    const target = this.persistenceDir ? new EvidenceLedger() : this.ledger;
    if (target !== this.ledger) target.fromJSONL(this.ledger.toJSONL());
    const operationId = params.result_operation_id ?? `${campaignId}:${nodeId}:result:${this.getCampaign(campaignId).iterations_completed}`;
    const priorFact = target.getMemoryFacts(campaignId).find((record) => record.fact.idempotency_key.startsWith(`${operationId}:`));
    const prior = priorFact ? target.getCampaign(campaignId).find((trace) => trace.id === priorFact.fact.source_evidence_id) : undefined;
    const traceId = prior?.id ?? this.appendTrace(target, campaignId, nodeId, stateBefore, stateAfter, scoreBefore, scoreAfter, params, [], governed);
    let memoryId: string | null = null;
    if (fact) memoryId = target.recordMemoryFact({
      campaign_id: campaignId, node_id: nodeId,
      tier: "specialist_visible", source_evidence_id: traceId,
      idempotency_key: `${operationId}:${fact.type}:${createHash("sha256").update(fact.content).digest("hex")}`,
      ...fact,
    });
    else memoryId = target.getMemoryFacts(campaignId).find((record) => record.fact.source_evidence_id === traceId)?.id ?? null;
    // E-8 (waiver-outcome ledger, 2605.26508 shape): a durable record per
    // review-waived (direct-tier) result, independent of this node's own
    // outcome — the arbiter's decision to waive review is the auditable
    // event. Written into the SAME staged `target` as the trace/memory-fact
    // above, so it lands in the same fsynced `saveLedger` call below rather
    // than a separate, unsynchronized write.
    if (params.review_waived) {
      const waivedNode = this.getCampaign(campaignId).tree.get(nodeId);
      target.recordWaiverOutcome({
        campaign_id: campaignId, node_id: nodeId,
        task_category: waivedNode?.action.category ?? "unknown",
        waived_by: params.review_waived.by,
        waived_reason: params.review_waived.reason,
        waived_at: new Date().toISOString(),
        idempotency_key: `${operationId}:waiver`,
      });
    }
    // Y-1 (ADR-065): journal an observed write-scope mismatch into the same
    // staged target/fsync as the trace above — same idempotency pattern as
    // the waiver record so a retried journal call never doubles it.
    if (params.scope_observation) {
      const scopeCampaign = this.getCampaign(campaignId);
      const scopeNode = scopeCampaign.tree.get(nodeId);
      target.recordScopeObservation({
        campaign_id: campaignId, node_id: nodeId,
        declared: params.scope_observation.declared,
        observed_out_of_scope: params.scope_observation.observed_out_of_scope,
        enforcement: params.scope_observation.enforcement,
        idempotency_key: `${operationId}:scope`,
        // Y-2: group by the same "locked in" boundary Y-1's ancestor walk
        // stops at, so a repeat/escalation query is scoped to nodes that
        // actually share an unresolved lineage, not merely the same node.
        lineage_root: scopeNode ? this.lineageRootId(scopeCampaign, scopeNode) : nodeId,
      });
    }
    // Y-1 (ADR-068): journal each advisory finding into the same staged
    // target/fsync as the trace above, witnessed by the trace id this exact
    // call just appended (or reused, on a replay).
    //
    // X-3 (blindspot class 4, index-keyed idempotency): the key here was
    // originally `${operationId}:advisory:${index}` -- positional. The
    // generators that produce these findings (sibling scan, test amplifier,
    // mutation probe) are model-driven and nondeterministic, so a retried
    // journal call can legitimately carry a different finding COUNT or a
    // different ORDER for the same operation. Under the old positional key,
    // a reordered-but-otherwise-identical replay collided two DIFFERENT
    // findings onto the SAME index/key and `recordAdvisoryEvidence` threw a
    // loud idempotency conflict on an operation that should have been a
    // harmless no-op replay -- not silent corruption, but a real defect: an
    // honest retry of the same work became a hard failure. The key is now
    // derived from the finding's own content (generator + activity +
    // payload), so identical findings dedupe regardless of position and
    // genuinely different findings never collide.
    //
    // MIGRATION CONSEQUENCE: existing ledger records already carry their old
    // `${operationId}:advisory:${index}` key permanently (idempotency keys
    // are never rewritten in place). The first replay of an operation that
    // was originally journaled under the OLD scheme will not match any
    // existing key under the NEW scheme, so it re-appends one
    // content-addressed record per finding rather than recognizing them as
    // already journaled -- a one-time duplication for ledgers written before
    // this change, not an ongoing hazard for ledgers written after it.
    if (params.advisory_evidence) {
      for (const finding of params.advisory_evidence) {
        const contentKey = createHash("sha256")
          .update(`${finding.generator} ${finding.activity} ${finding.payload}`)
          .digest("hex").slice(0, 32);
        target.recordAdvisoryEvidence({
          campaign_id: campaignId, node_id: nodeId,
          generator: finding.generator,
          activity: finding.activity,
          payload: finding.payload,
          source_evidence_id: traceId,
          idempotency_key: `${operationId}:advisory:${contentKey}`,
        });
      }
    }
    if (this.persistenceDir) {
      saveLedger(target, this.persistenceDir, campaignId);
      this.ledger = target;
    }
    this.rebuildKBProjection();
    const kbId = memoryId === null ? null : projectMemoryFacts(this.ledger, {
      campaign_id: campaignId, node_ancestry: [nodeId], capability: { tier: "auditor" }, limit: 1_000,
    }).find((entry) => entry.evidence_pointer.endsWith(`:${memoryId}`))?.id ?? null;
    return { traceId, kbId };
  }

  /**
   * Increment the "iterations without new KB entry" counter. Called by the loop
   * after an iteration that produced no new learning (kb_entry_id was null).
   * When this crosses convergence_iterations, haltCheck returns "converged".
   */
  incrementNoKbIteration(campaignId: string): void {
    const campaign = this.getCampaign(campaignId);
    campaign.iterations_without_kb_entry++;
    this.persistCampaign(campaign);
  }

  /** Returns the reconciled active campaign pointer, if one exists. */
  getActiveCampaignId(): string | null {
    return this.activeCampaignId;
  }

  /**
   * Returns the id of the first node in state `"expanding"` in the given
   * campaign's tree, or null if the campaign doesn't exist or has no
   * expanding nodes. Read-only; needed by the TUI interrupt flow and the
   * operator-input screen.
   */
  getActiveExpandingNode(campaignId: string): string | null {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return null;
    for (const [id, node] of campaign.tree) {
      if (node.state === "expanding") return id;
    }
    return null;
  }

  /** Startup recovery diagnostics retained for operator and transport surfaces. */
  getPersistenceDiagnostics(): readonly PersistenceDiagnostic[] {
    return structuredClone(this.persistenceDiagnostics);
  }

  /**
   * Read-only recovery projection for operators and transport adapters.
   * Findings are derived from durable snapshots and evidence on every startup;
   * they never rewrite a node or manufacture a terminal outcome.
   */
  getRecoveryDiagnostics(): readonly RecoveryDiagnostic[] {
    return structuredClone(this.recoveryDiagnostics);
  }

  /** Subscribe to post-durability domain events. Returns an idempotent unsubscribe. */
  subscribeEvents(sink: CampaignManagerEventSink): () => void {
    this.eventSinks.add(sink);
    return () => { this.eventSinks.delete(sink); };
  }

  private appendTrace(
    ledger: EvidenceLedger,
    campaignId: string,
    nodeId: string,
    stateBefore: NodeState,
    stateAfter: NodeState,
    scoreBefore: number,
    scoreAfter: number,
    params: {
      specialist_output: string;
      specialist_agent: string;
      provenance: Provenance;
      critic_agent: string;
      critic_approved: boolean;
      critic_rationale: string;
      critic_root_cause?: string;
      critic_verdict?: CriticVerdict;
    },
    kbEntries: string[],
    governed?: { transition: GovernedTransition; operation_id: string },
  ): string {
    const node = this.getCampaign(campaignId).tree.get(nodeId);
    const packet = {
      campaign_id: campaignId,
      node_id: nodeId,
      parent_id: node?.parent_id ?? null,
      timestamp: new Date().toISOString(),
      action_description: node?.action.description ?? "",
      action_category: node?.action.category ?? "",
      specialist_agent: params.specialist_agent,
      critic_agent: params.critic_agent,
      node_state_before: stateBefore,
      node_state_after: stateAfter,
      provenance: params.provenance,
      specialist_output: params.specialist_output,
      critic_verdict_approved: params.critic_approved,
      critic_root_cause: params.critic_root_cause ?? null,
      score_before: scoreBefore,
      score_after: scoreAfter,
      gates: node?.gate_records ?? [],
      kb_entries_written: kbEntries,
    };
    const evidenceId = governed
      ? ledger.recordGovernedTransition(governed.transition, governed.operation_id, packet)
      : ledger.record(packet);
    if (ledger === this.ledger && this.persistenceDir) saveLedger(this.ledger, this.persistenceDir, campaignId);
    return evidenceId;
  }

  /** Build a bounded continuation view from durable snapshot/thread inputs. */
  projectCrossSessionHandoff(input: CrossSessionHandoffInput): CrossSessionHandoffProjection {
    return projectCrossSessionHandoff(input);
  }

  private emit(event: RuntimeEvent): void {
    for (const sink of this.eventSinks) {
      try {
        sink(structuredClone(event));
      } catch {
        // benign-catch: observers never get to invalidate a transition that
        // has already passed its durable checkpoint. Runtime composition
        // handles sink availability; a subscriber's own exception must not
        // propagate back into the manager and unwind an already-durable write.
      }
    }
  }
}

/**
 * The flattened legacy fields remain the transport boundary, but a persisted
 * five-mandate verdict must agree with them exactly.  Otherwise a caller could
 * show the operator one verdict while governing the tree with another.
 */
/**
 * A real, data-driven override of a self-reported `approved: true`, using a
 * structural fact `recordResult` already has in hand rather than a
 * text-pattern guess at the specialist's free-form output (fragile, and easy
 * to route around, per this fix's own brief):
 *
 * `node_error` is present — a classified operational failure (timeout,
 * transport error, context overflow, ...) was recorded for this call. That
 * is structurally incompatible with an approved governance verdict: nothing
 * can be approved that did not actually complete.
 *
 * A broader "no verified provenance and no critic_verdict" override was
 * evaluated and deliberately rejected — see the inline comment below for why
 * it turned out to describe the SYSTEM'S NORMAL claimed-approval shape
 * (proven by a real test failure against the MCP boundary's own untrusted-
 * input suite), not a rubber stamp.
 *
 * Returns the override's root-cause message, or `null` when nothing
 * structurally contradicts the approval.
 */
function acceptanceOverrideReason(params: {
  provenance: Provenance;
  critic_verdict?: CriticVerdict;
  node_error?: NodeError;
}): string | null {
  if (params.node_error) {
    return `critic approval overridden: node carries a classified operational error (${params.node_error.kind}), which cannot coexist with an approved verdict`;
  }
  // A broader gate was deliberately NOT added here: "approved with no
  // `verified` provenance and no full five-mandate `critic_verdict`" looked
  // like a real signal in isolation, but the MCP boundary's own untrusted-
  // input design (arbor_record_result downgrades any caller-claimed
  // "verified" tag it cannot independently authenticate down to "claimed")
  // makes "claimed provenance, approved: true, no critic_verdict object"
  // the NORMAL shape of a legitimate result over that transport, not a
  // rubber stamp — proven by running this exact condition against
  // `server.test.ts`'s real MCP-boundary suite, which failed across every
  // ordinary approved-claim path once it was added. A text-pattern check
  // against the specialist's free-form output was considered too (per this
  // fix's own brief) and rejected as fragile and easy to route around. The
  // structural fix for the reported scenario (a synthesis node approved
  // despite its own output admitting missing prerequisites) is `depends_on`
  // admission gating above: such a node cannot even be scheduled — let alone
  // reach a critic — before its declared prerequisites verify.
  return null;
}

function assertCriticVerdict(
  verdict: CriticVerdict,
  params: {
    specialist_agent: string;
    critic_agent: string;
    critic_approved: boolean;
    critic_rationale: string;
    critic_root_cause?: string;
  },
): void {
  const names = ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"] as const;
  // X-2 (patch-overfitting #2): `completeness` is an OPTIONAL sixth check
  // name a critic verdict may carry alongside the five-point mandate (see
  // native-critic-contract.ts, the same optional-check convention). Never
  // required -- an older verdict with exactly the five mandate checks is
  // still a complete result.
  const optionalNames = ["completeness"] as const;
  const allNames: readonly string[] = [...names, ...optionalNames];
  if (verdict.critic !== params.critic_agent || verdict.critic === params.specialist_agent) {
    throw new Error("Critic verdict identity must name a distinct critic agent");
  }
  if (verdict.approved !== params.critic_approved || verdict.rationale !== params.critic_rationale
    || (verdict.root_cause ?? undefined) !== (params.critic_root_cause ?? undefined)) {
    throw new Error("Critic verdict conflicts with the governed result fields");
  }
  if (!verdict.rationale.trim() || typeof verdict.measurement_validated !== "boolean"
    || typeof verdict.guardrails_enforced !== "boolean" || typeof verdict.introspection_passed !== "boolean"
    || typeof verdict.stability_ok !== "boolean"
    || verdict.checks.length < names.length || verdict.checks.length > allNames.length) {
    throw new Error("Critic verdict is not a complete five-mandate result");
  }
  const seen = new Set<string>();
  for (const check of verdict.checks) {
    if (!allNames.includes(check.name) || seen.has(check.name) || typeof check.passed !== "boolean" || !check.detail.trim()) {
      throw new Error("Critic verdict has invalid five-mandate checks");
    }
    seen.add(check.name);
  }
  if (!names.every((name) => seen.has(name))) throw new Error("Critic verdict is missing a five-mandate check");
}



function recoveryAuthority(request: RecoveryRequest): "crown" | "cambium" | "operator" | "auditor" {
  if (request.actor_role === "crown" || request.actor_role === "operator" || request.actor_role === "auditor") return request.actor_role;
  // RecoveryService rejects specialist/critic mutations before reaching this port.
  throw new Error(`${request.actor_role} cannot author a recovery decision`);
}

function nonEmptyScopeAtom(value: string): boolean {
  return value.trim().length > 0 && value.length <= 512 && !value.includes("\u0000");
}

/**
 * ADR-119 Decision §3: `allowIntentEntries` is the tier boundary. `governed`
 * sessions pass `false` -- an intent entry there makes the WHOLE declaration
 * structurally invalid (fail-closed, matching ADR-088's fully-literal
 * declare-and-reject posture), never silently stripped down to its literal
 * entries. `direct`/`reviewed` pass `true`.
 */
function validNativeHighRiskDeclaration(value: NonNullable<Action["high_risk_tool_scope"]>, allowIntentEntries: boolean): boolean {
  return Array.isArray(value.write_paths) && Array.isArray(value.command_argv)
    && value.write_paths.every((path) => isCanonicalNativeScopePath(path))
    && value.command_argv.every((entry) => validNativeCommandArgvEntry(entry, allowIntentEntries));
}

function validNativeCommandArgvEntry(entry: unknown, allowIntentEntries: boolean): entry is readonly string[] | HighRiskCommandIntent {
  if (Array.isArray(entry)) {
    return entry.length > 0 && entry.length <= 32
      && entry.every((part) => typeof part === "string" && part.length > 0 && part.length <= 4_096 && !part.includes("\u0000"));
  }
  if (!allowIntentEntries || typeof entry !== "object" || entry === null) return false;
  const intent = entry as Record<string, unknown>;
  return Array.isArray(intent.argv_prefix) && intent.argv_prefix.length > 0 && intent.argv_prefix.length <= 32
    && intent.argv_prefix.every((part) => typeof part === "string" && part.length > 0 && part.length <= 4_096 && !part.includes("\u0000"))
    && typeof intent.purpose === "string" && intent.purpose.trim().length > 0 && intent.purpose.length <= 4_096;
}

function isCanonicalNativeScopePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 1_024
    && !path.startsWith("/") && !path.startsWith("\\")
    && path.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..");
}

function canonicalNativeHighRiskDeclaration(
  campaign_id: string,
  node_id: string,
  declaration: NonNullable<Action["high_risk_tool_scope"]>,
): Readonly<{ schema_version: 1; campaign_id: string; node_id: string; write_paths: readonly string[]; command_argv: readonly unknown[] }> {
  return Object.freeze({
    schema_version: 1,
    campaign_id,
    node_id,
    write_paths: Object.freeze([...declaration.write_paths]),
    command_argv: Object.freeze(declaration.command_argv.map((entry) => Array.isArray(entry)
      ? Object.freeze([...entry])
      : Object.freeze({ argv_prefix: Object.freeze([...(entry as HighRiskCommandIntent).argv_prefix]), purpose: (entry as HighRiskCommandIntent).purpose }))),
  });
}

/**
 * A safe UI/catalog projection: operators can verify that an action carries
 * bounded write/command authority without exporting its exact tool scope.
 */
function nativeHighRiskScopeProjection(campaignId: string, nodeId: string, declaration: Action["high_risk_tool_scope"] | undefined): { declared: boolean; write_path_count: number; command_argv_count: number; declaration_hash: string | null } {
  // Display-only structural-validity projection: tier-blind by design
  // (`allowIntentEntries: true`) since it never grants authority -- the
  // real tier boundary is enforced at `deriveNativeHighRiskToolScope`.
  if (!declaration || !validNativeHighRiskDeclaration(declaration, true)) {
    return Object.freeze({ declared: false, write_path_count: 0, command_argv_count: 0, declaration_hash: null });
  }
  return Object.freeze({
    declared: true,
    write_path_count: declaration.write_paths.length,
    command_argv_count: declaration.command_argv.length,
    declaration_hash: `sha256:${sha256Text(JSON.stringify(canonicalNativeHighRiskDeclaration(campaignId, nodeId, declaration)))}`,
  });
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
