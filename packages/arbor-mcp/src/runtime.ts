import type { HarnessIntegrationRegistry } from "@arbor/harness";
import type { CampaignHarnessIntegration } from "./campaign-harness-integration.js";
import {
  RuntimeEventStream,
  OperationRegistry,
  TaskSupervisor,
  type RuntimeError,
  type RuntimeEvent,
  type RuntimeSnapshot,
  type SupervisorTask,
  type OperationRecord,
} from "@arbor/core";
import { TaskComposer, type TaskComposerPlannerPort } from "./task-composer.js";
import type { TaskAttachmentStore } from "./task-attachment-store.js";
import { type ArbiterIntakePort } from "./arbiter-intake.js";
import { createSupervisedTaskComposerAdmissionPort } from "./task-composer-admission.js";
import { CampaignManager } from "./manager.js";
import { RecoveryService, type RecoveryContinuationAdmissionAuthority, type RecoveryLeaseAuthority } from "./recovery-service.js";
import { buildContinuationPlan } from "./recovery/continuation-plan.js";
import type { AgentConfig, KbBackend } from "@arbor/config";
import { OutputEvidenceStore } from "@arbor/audit";
import {
  loadSupervisorSnapshot,
  saveSupervisorSnapshot,
  type SupervisorPersistenceDiagnostic,
} from "./supervisor-persist.js";
import { loadOperationSnapshot, saveOperationSnapshot, type OperationPersistenceDiagnostic } from "./operation-persist.js";
import { CampaignSurveillanceSource, SurveillanceMonitor, type SurveillanceScanResult } from "./surveillance-monitor.js";
import type { SurveillanceFinding } from "@arbor/core";
import {
  ManagerOutputEvidenceCaptureAdapter,
  ManagerSelectionCommunicationAdapter,
  ManagerScoreContextAdapter,
  ManagerTelemetryAdapter,
  RuntimeModelCapabilityAdapter,
  type ProviderModelCapabilityPort,
  type CanonicalLoopPorts,
} from "./loop-adapters.js";
import { TokenEpochService } from "./token-epoch-service.js";
import { NativeCampaignBudgetAuthority } from "./native-campaign-budget.js";
import { ConfigInspectionService } from "./config-inspection.js";
import { AgentRegistry } from "./agent-registry.js";
import type { AgentDefinitionSource } from "./agent-registry.js";
import { JobScheduler } from "./job-scheduler.js";
import { CampaignRunAttemptIndex, type CampaignRunAttemptLatestTaskState } from "./campaign-run-attempt-index.js";
import { isTerminalSupervisorTaskState, projectCampaignRunStatus, type CampaignRunStatusProjection } from "./campaign-run-status-projection.js";
import type { LongHorizonScheduler } from "./scheduler/scheduler.js";
import { ApprovalService } from "./approval-service.js";
import { GovernedContextService } from "./governed-context-service.js";
import { RemoteSessionAuthority } from "./remote-session.js";
import type { Provenance } from "@arbor/core";import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createDevToolsTraceLogger, type DevToolsTraceLoggerOptions } from "./devtools-log.js";
import type { SiblingSpawner } from "./sibling-spawner.js";
import type { GitWorkspaceService } from "./git-workspace-projection.js";
import {
  HarnessControlPlane,
  type HarnessConnectorSelection,
} from "./harness-control-plane.js";
import type {
  CapabilityRequirement,
  ConnectorInspection,
  ConnectorRegistry,
  InMemoryCredentialLeaseBroker,
} from "@arbor/harness";
import { redactNativeText } from "@arbor/harness";
import { HarnessSessionJournal, redactHarnessSessionEvent, type HarnessSessionSummary, type HarnessSessionToolAuditProjection, type HarnessSessionArtifactProjection } from "./harness-session-journal.js";
import { HarnessSessionReplayStore } from "./harness-session-replay-store.js";
import { LiveNativeSessionRegistry } from "./live-native-session-registry.js";
import { beginProjectionRequest, checkProjectionFreshness, initialProjectionLifecycle, resolveProjectionFailure, type ProjectionClock, type ProjectionLifecycle } from "./projection-lifecycle.js";
import { projectCampaignRunStatusLifecycle, projectGateRefusalLifecycle } from "./projection-lifecycle-catalog.js";
import { RuntimePerformanceProbe, type RuntimeCostObservation, type RuntimeCostSummary } from "./runtime-performance-probe.js";
import { projectGateRecord, projectGateUnavailable, type GateRefusalProjection } from "./gate-refusal-projection.js";
import type { GateRecord, GateType } from "@arbor/core";
import type { DeclarativeSubagentExecutionPort } from "./declarative-subagent-executor.js";
import type { HarnessEvaluationPort } from "./harness-evaluation-port.js";
import type { NativeHarnessReadinessService } from "./native-harness-readiness.js";
import { buildUnifiedDoctor, inspectMigration, type UnifiedDoctorProjection } from "./operator-maintenance.js";
import { HookBus } from "./hooks/bus.js";
import { ProductIntegrationControlPlane, builtinProductIntegrations, type ProductIntegrationDescriptor } from "./product-integrations.js";
import { SessionIdentityService } from "./session-identity-service.js";
import { ResultVerificationService } from "./result-verification-service.js";
import { NotificationInboxService, type NotificationSeverity } from "./notification-inbox-service.js";
import { FollowUpLineageService } from "./follow-up-lineage-service.js";
import { PluginRegistry, type AdmittedPlugin } from "./extensibility/plugin-registry.js";
import { NativePeerChannelService } from "./native-peer-channel.js";
import type { DistributedControlRuntime, DistributedControlOperatorProjection } from "./distributed-control-runtime.js";
import type { DistributedControlDisabledProjection, DistributedControlQueryKind } from "./distributed-control-contracts.js";

export type RuntimeLifecycleState = "new" | "starting" | "started" | "closing" | "closed" | "failed";

/**
 * The sole place that owns runtime lifecycle work.  Adapters are deliberately
 * excluded: MCP, Web, OpenCode, and TUI consume this boundary rather than
 * creating a second manager, task registry, or event sequence.
 */
export interface RuntimeLifecycleParticipant {
  name: string;
  start?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
}

/**
 * The `job.submit` `job_kind` that binds a supervised job to the genuine
 * `@arbor/opencode` tree-search loop (Wave 1 Lane A: "the loop as a job").
 * `RuntimeCatalogRouter`'s existing `job.submit` command is the sole
 * authority that creates one — no second dispatch path is introduced.
 */
export const CAMPAIGN_RUN_JOB_KIND = "campaign.run";

/** What a supervised campaign-loop run settled as when it stopped. */
export interface CampaignRunOutcome {
  halted: boolean;
  halt_reason: string | null;
  cancelled: boolean;
  awaiting_user_input: boolean;
}

/**
 * The seam a composition root (`cli.ts`, tests) supplies to make
 * `CAMPAIGN_RUN_JOB_KIND` jobs genuinely runnable. `run` must resolve (not
 * reject) for every ordinary stopping condition — halt, cancellation,
 * awaiting user input, max_iterations — and reject only for a genuine
 * operational failure; `ArborRuntime.runCampaignJob` uses the distinction to
 * decide whether the supervised task completes or fails.
 */
export interface CampaignRunner {
  run(campaignId: string, signal: AbortSignal, onHeartbeat?: () => void): Promise<CampaignRunOutcome>;
}

/**
 * Settlement `awaitCampaignRun` resolves with once a supervised
 * `campaign.run` job's task reaches a terminal state. `task_state` is read
 * directly off the `TaskSupervisor` immediately after the exact
 * finalize/finish routine `runCampaignJob`'s fire-and-forget dispatch
 * already runs for every job — never a second authority or an independent
 * guess at "how the run ended". `null` only when `awaitCampaignRun` is
 * called for a campaign id that never had a tracked run in this runtime
 * instance (never submitted, or submitted against a different runtime).
 */
export interface CampaignRunSettlement {
  readonly task_state: SupervisorTask["state"] | null;
  /**
   * WA-12: whether this run settled because it was cancelled (operator
   * interrupt, `job.cancel`, or the caller aborting its own signal) rather
   * than running to an ordinary stop condition. `false` — never omitted —
   * for the `{ task_state: null }` untracked-campaign fallback below, since
   * "no run was ever tracked" is not a cancellation.
   */
  readonly cancelled: boolean;
  /**
   * WA-40: `"campaign_halt_diagnostic"` carries a durable
   * `manager.recordCampaignRunDiagnostic` entry (e.g. the isolation gate's
   * own detail, recorded by `loop.ts` on a node's first gate refusal) even
   * for an ORDINARY (non-throwing) run settlement — `"campaign_run_failed"`
   * remains reserved for the run genuinely throwing/rejecting below.
   */
  readonly diagnostic?: Readonly<{ code: "campaign_run_failed" | "campaign_halt_diagnostic"; summary: string }>;
}

export interface RuntimeCompositionOptions {
  manager?: CampaignManager;
  supervisor?: TaskSupervisor;
  operations?: OperationRegistry;
  output_evidence?: OutputEvidenceStore;
  event_stream?: RuntimeEventStream;
  /** Optional bounded local timing probe; disabled unless explicitly composed. */
  performance_probe?: RuntimePerformanceProbe;
  surveillance?: SurveillanceMonitor;
  lifecycle?: readonly RuntimeLifecycleParticipant[];
  /** Optional long-lived cross-host coordinator/bridge participant owned by this runtime. */
  distributed_control?: DistributedControlRuntime | null;
  /**
   * Optional live/snapshot provider metadata. No token estimate is
   * fabricated when absent.
   *
   * A-7 identified this as unfed everywhere because no live provider
   * capability query existed anywhere in the repo. One now does:
   * `opencode serve`'s `GET /provider` endpoint, verified live 2026-08-04
   * against opencode 1.18.10 — it returns, per connected provider, every
   * model's `limit: {context, output}` (real provider-advertised
   * context/output-token ceilings). `cli.ts`'s `createCliRuntime` supplies
   * a real `OpenCodeProviderCapabilityAdapter` built on that endpoint (see
   * its doc comment there for the sync-contract/lazy-warm design and why
   * the one current caller, `arbor-opencode`'s `modelCapabilityTokenBridge`,
   * never yet exercises it — it doesn't pass a `model` id, a gap in a file
   * outside this package). `demo.ts` still leaves this unfed; it builds its
   * own standalone runtime for the scripted demo path, not the CLI
   * composition root.
   */
  model_capabilities?: ProviderModelCapabilityPort;
  token_epochs?: TokenEpochService;
  /** Optional durable task projection; active records still require reconciliation. */
  persistence_dir?: string;
  /** Host-owned repository root for explicitly confirmed result adoption. */
  workspace_root?: string;
  /** Optional host-composed Git projection and governed worktree operations. */
  git_workspace?: GitWorkspaceService;
  /**
   * KB storage engine passed through to the manager when it composes one.
   * Defaults to "jsonl". Ignored when `manager` is supplied directly. See
   * `CampaignManagerOptions.kb_backend` (G-11).
   */
  kb_backend?: KbBackend;
  /** Defer replay of large durable audit ledgers until the host is interactive. */
  defer_audit_restore?: boolean;
  /** Optional config-inspection sources. When absent, an empty defaults-only view is offered. */
  config_inspection?: ConfigInspectionService;
  /** Optional static agent-definition source. When absent, definitions are empty and only live supervisor instances surface. */
  agent_definitions?: AgentDefinitionSource;
  /** Optional job scheduler over the supervisor; defaults to a new bounded queue. */
  job_scheduler?: JobScheduler;
  long_horizon_scheduler?: LongHorizonScheduler;
  /** Optional durable approval service; defaults to a new instance. */
  approvals?: ApprovalService;
  /**
   * Host-owned registry for explicitly enrolled remote identities. This is a
   * local trust authority only: composing it does not start a listener or
   * expose any public/A2A transport.
   */
  remote_session_authority?: RemoteSessionAuthority;
  /**
   * ADR-012 lease authority (G-03). When supplied, the runtime composes a
   * real `RecoveryService` from it plus the canonical manager/supervisor and
   * exposes it as `recoveryService`. Omitted by default so a bare
   * `new ArborRuntime()` (used pervasively by tests) never touches a real
   * lease store; `cli.ts`'s `createCliRuntime` is the production caller that
   * supplies one.
   */
  recovery_leases?: RecoveryLeaseAuthority;
  /** ADR-043 fresh-authority checks; continuation stays unavailable when omitted. */
  recovery_continuation_admissions?: RecoveryContinuationAdmissionAuthority;
  /**
   * DevTools trace logger (ADR-021). When omitted and `persistence_dir` is
   * set, a default logger is auto-composed (rotatable ND-JSON projection at
   * `<persistence_dir>/devtools/devtools.log`). Pass `false` to disable.
   */
  devtools_logger?: DevToolsTraceLoggerOptions | false;
  /**
   * Optional executor for `CAMPAIGN_RUN_JOB_KIND` jobs (Wave 1 Lane A). When
   * absent, `job.submit` for that kind is rejected `unavailable` — typed
   * absence, not a silently inert job, matching `recovery_leases`/
   * `model_capabilities`'s pattern. `cli.ts`'s `createCliRuntime` is the
   * production caller that supplies a real one; a bare `new ArborRuntime()`
   * (used pervasively by tests) never touches opencode or the filesystem.
   */
  campaign_runner?: CampaignRunner;
  /**
   * Optional revoy-owned connector registry.  The runtime registers its
   * native descriptor into this supplied registry (unless disabled), but
   * never creates a global catalog or starts a connector itself.
   */
  harness_connector_registry?: ConnectorRegistry;
  /**
   * The host's campaign integrations (claude-code / codex / opencode /
   * native), the same registry `createProductionCampaignRunner` selects
   * through. Exposed so a surface that composes its own loop (`arbor
   * selfhost`) can honour ARBOR_HARNESS_INTEGRATION instead of hard-wiring
   * one connector.
   */
  harness_integrations?: HarnessIntegrationRegistry<CampaignHarnessIntegration>;
  /** The installed plugin registry is injected by the composition root; no ambient plugin lookup occurs. */
  plugin_registry?: PluginRegistry;
  /** Optional opaque lease broker. Secrets remain inside this injected service. */
  credential_lease_broker?: InMemoryCredentialLeaseBroker;
  /** Disable automatic registration of the native descriptor in an injected registry. */
  register_native_harness_connector?: boolean;
  /** Testable observation timestamp used only when registering the native descriptor. */
  native_harness_observed_at?: string;
  /** Effective agent configuration; projections are re-derived, never stored. */
  agent_config?: Readonly<Record<string, AgentConfig>>;
  sibling_spawner?: (manager: CampaignManager, supervisor: TaskSupervisor) => SiblingSpawner;
  /** Governed context artifacts/folds/playbook/harness overlays. Defaults to a durable local service when persistence is configured. */
  governed_context?: GovernedContextService;
  /** Separately capability-gated, fixed no-tools execution of active descriptor revisions. */
  declarative_subagent_executor?: DeclarativeSubagentExecutionPort;
  harness_evaluator?: HarnessEvaluationPort;
  /** Optional durable, redacted native-session observation journal. */
  harness_sessions?: HarnessSessionJournal;
  /** Protected native conversation continuity store; never exposed by journal read APIs. */
  harness_session_replay?: HarnessSessionReplayStore;
  /** Process-local active native-session control plane. */
  native_session_registry?: LiveNativeSessionRegistry;
  /** Secret-free native setup/readiness doctor, composed only by a host that knows its config layers. */
  native_harness_readiness?: NativeHarnessReadinessService;
  /** Optional operator environment facts for the versioned, local-only doctor projection. */
  operator_doctor_integration?: import("./doctor.js").HarnessIntegrationDoctorReport;
  product_integrations?: ProductIntegrationControlPlane;
  native_peer_channels?: NativePeerChannelService;
  session_identities?: SessionIdentityService;
  result_verification?: ResultVerificationService;
  notification_inbox?: NotificationInboxService;
  follow_up_lineage?: FollowUpLineageService;
  /** Durable pre-campaign task intake and admission authority. */
  task_composer?: TaskComposer;
  /** Host-composed read-only Taproot planner for the default task composer. */
  task_composer_planner?: TaskComposerPlannerPort | null;
  /** Content-addressed rich-input authority for the default task composer. */
  task_composer_attachment_store?: TaskAttachmentStore;
  /** ADR-062: cheap governance-tier classifier for the default task composer. Absent = every submission defaults to `governed`. */
  task_composer_arbiter?: ArbiterIntakePort | null;
}

export interface RuntimeHealth {
  state: RuntimeLifecycleState;
  healthy: boolean;
  active_campaign_id: string | null;
  active_tasks: number;
  event_cursor: { stream_id: string; sequence: number };
  failures: RuntimeError[];
  campaign_run_diagnostics: ReadonlyArray<Readonly<{ campaign_id: string; code: "campaign_run_failed"; summary: string }>>;
  persistence_diagnostics: Array<SupervisorPersistenceDiagnostic | OperationPersistenceDiagnostic>;
  reconciliation_tasks: SupervisorTask[];
  reconciliation_operations: OperationRecord[];
}

export interface RuntimeView {
  lifecycle: RuntimeHealth;
  campaigns: ReturnType<CampaignManager["listCampaigns"]>;
  tasks: SupervisorTask[];
  operations: OperationRecord[];
}

export type RuntimeResult<T> =
  | { ok: true; value: T; failures: RuntimeError[] }
  | { ok: false; value: T | null; failures: RuntimeError[] };

/** Composition root for one canonical campaign runtime. */
export class ArborRuntime {
  readonly manager: CampaignManager;
  readonly supervisor: TaskSupervisor;
  readonly operations: OperationRegistry;
  /** Full outputs are durable evidence and are intentionally absent from RuntimeEventStream. */
  readonly outputEvidence: OutputEvidenceStore | null;
  /** Canonical OpenCode loop ports; both share this runtime's manager/store. */
  readonly selectionCommunications: ManagerSelectionCommunicationAdapter;
  readonly outputCapture: ManagerOutputEvidenceCaptureAdapter;
  readonly modelCapabilities: RuntimeModelCapabilityAdapter;
  readonly tokenEpochs: TokenEpochService;
  /** Durable campaign-wide native allocation authority (distinct from context epochs). */
  readonly nativeCampaignBudget: NativeCampaignBudgetAuthority;
  readonly configInspection: ConfigInspectionService;
  readonly agentRegistry: AgentRegistry;
  readonly jobScheduler: JobScheduler;
  /** ADR-093: durable campaign-run attempt identity index; see `getCampaignRunStatus`. */
  readonly campaignRunAttempts: CampaignRunAttemptIndex;
  readonly longHorizonScheduler: LongHorizonScheduler | null;
  readonly approvals: ApprovalService;
  /** Local persisted trust registry consumed by explicit remote adapters only. */
  readonly remoteSessionAuthority: RemoteSessionAuthority;
  /** Campaign-local, provenance-backed context and harness projections. */
  readonly governedContext: GovernedContextService;
  /** Null unless the composition root deliberately supplies native descriptor execution. */
  readonly declarativeSubagentExecutor: DeclarativeSubagentExecutionPort | null;
  readonly harnessEvaluator: HarnessEvaluationPort | null;
  /** ADR-012 recovery (G-03); null unless `recovery_leases` was supplied. */
  readonly recoveryService: RecoveryService | null;
  /** Wave 1 Lane A: null unless `campaign_runner` was supplied — see `runCampaignJob`. */
  readonly campaignRunner: CampaignRunner | null;
  /** Optional injected connector and credential services; never process-global. */
  readonly harnessControl: HarnessControlPlane;
  /** Null when a bare runtime has no host-composed native configuration to inspect. */
  readonly nativeHarnessReadiness: NativeHarnessReadinessService | null;
  readonly operatorDoctorIntegration: import("./doctor.js").HarnessIntegrationDoctorReport | null;
  readonly productIntegrations: ProductIntegrationControlPlane;
  readonly nativePeerChannels: NativePeerChannelService;
  /** Null until a composition root supplies the typed distributed-control config. */
  readonly distributedControl: DistributedControlRuntime | null;
  readonly pluginRegistry: PluginRegistry | null;
  /** Local product records; none carries model history, credentials, or approvals. */
  readonly sessionIdentities: SessionIdentityService;
  readonly resultVerification: ResultVerificationService;
  readonly notificationInbox: NotificationInboxService;
  readonly followUpLineage: FollowUpLineageService;
  /** Null when this composition has no durable persistence directory. */
  readonly harnessSessions: HarnessSessionJournal | null;
  /** Host-local replay authority, separate from redacted evidence projection. */
  readonly harnessSessionReplay: HarnessSessionReplayStore;
  /** Active native sessions; deliberately separate from the durable journal. */
  readonly nativeSessionRegistry: LiveNativeSessionRegistry;
  readonly agentConfig: Readonly<Record<string, AgentConfig>>;
  readonly siblingSpawner: SiblingSpawner | null;
  /** Null when this composition has no valid repository workspace. */
  readonly gitWorkspace: GitWorkspaceService | null;
  readonly loopPorts: CanonicalLoopPorts;
  readonly eventStream: RuntimeEventStream;
  /** Pre-campaign intake; no UI package imports this concrete service. */
  readonly taskComposer: TaskComposer;
  readonly surveillance: SurveillanceMonitor;
  /**
   * The same `RuntimeEvent` publisher the constructor wires `manager`/
   * `taskComposer` through (`eventSink` there). `runCampaignJob` — the sole
   * choke point for a supervised `campaign.run` job (see its own doc
   * comment) — uses this to publish `task.changed` at the two edges it
   * itself owns: the run becoming observably active, and its terminal
   * settlement. Before this, a `CAMPAIGN_RUN_JOB_KIND` task's `started`/
   * `completed`/`failed`/`cancelled` transitions were visible only to a
   * caller that polled `task.list`; the ADR-161 read model (`applyEnvelopes`
   * folding `task.changed`) never heard about them, so the TUI's Inspect
   * rail tab (`summarizeForInspect`) could never show a real running or
   * completed task — only ever "No task selected or observed yet."
   */
  private readonly publishEvent: (event: RuntimeEvent) => void;
  private readonly performanceProbe: RuntimePerformanceProbe | null;
  private readonly lifecycle: readonly RuntimeLifecycleParticipant[];
  private state: RuntimeLifecycleState = "new";
  private readonly failures: RuntimeError[] = [];
  private startedParticipants: RuntimeLifecycleParticipant[] = [];
  private readonly persistenceDir: string | null;
  readonly harnessIntegrations: HarnessIntegrationRegistry<CampaignHarnessIntegration> | null;
  /** The durable persistence root, or null for a memory-only runtime. Read-only. */
  get persistenceRoot(): string | null { return this.persistenceDir; }
  private readonly workspaceDir: string | null;
  /** The configured operator workspace; never supplied by an untrusted command. */
  get workspaceRoot(): string | null { return this.workspaceDir; }
  private persistenceDiagnostics: Array<SupervisorPersistenceDiagnostic | OperationPersistenceDiagnostic> = [];
  private reconciliationTasks: SupervisorTask[] = [];
  private reconciliationOperations: OperationRecord[] = [];
  private unsubscribeManagerEvents: (() => void) | null = null;
  private readonly surveillanceSubscribers = new Set<(event: SurveillanceRuntimeEvent) => void>();
  /** Campaign IDs with a `campaignRunner.run` currently in flight (Wave 1 Lane A). Memory-only: never survives a restart, matching ADR-012's "recovery is operator-authorized" rule (see `runCampaignJob`). */
  private readonly activeCampaignRuns = new Set<string>();
  /**
   * Awaitable settlement handle for the same `campaignRunner.run(...)`
   * promise `runCampaignJob` already drives, keyed by campaign id (see
   * `awaitCampaignRun`). Set once a run starts and left in place after it
   * settles — the promise is already resolved by then, so a late caller
   * still "returns immediately" with no extra bookkeeping. A fresh
   * `runCampaignJob` for the same campaign (only reachable once the prior
   * run is no longer `activeCampaignRuns`-tracked) simply overwrites the
   * entry; nothing else can hold a stale reference across that boundary.
   * Memory-only, matching `activeCampaignRuns`: never survives a restart.
   */
  private readonly campaignRunSettlements = new Map<string, Promise<CampaignRunSettlement>>();
  /** Bounded observational diagnostics for fire-and-forget callers. */
  private readonly campaignRunDiagnostics = new Map<string, Readonly<{ code: "campaign_run_failed"; summary: string }>>();

  constructor(options: RuntimeCompositionOptions = {}) {
    const startupStarted = options.performance_probe ? performance.now() : 0;
    this.performanceProbe = options.performance_probe ?? null;
    this.eventStream = options.event_stream ?? new RuntimeEventStream("arbor-runtime");
    const eventSink = (event: RuntimeEvent) => {
      const started = this.performanceProbe ? performance.now() : 0;
      try {
        const sequence = this.eventStream.cursor().sequence + 1;
        this.eventStream.publish({
          id: `${this.eventStream.streamId}:${sequence}`,
          occurred_at: new Date().toISOString(),
          correlation_id: "runtime",
          redacted: false,
          event,
        });
        // WA-41: every campaign terminal halt — manual, auto (budget/
        // threshold/convergence/no_nodes/verified_result/...), or the
        // gate-recorded halts `manualHalt`/`completeAutoHalt` both already
        // emit this SAME `campaign.changed`/"halted" event for — reaches the
        // notification inbox here. Before this, only native-session
        // completion (`recordSessionCompletionUx`, below) ever published to
        // the inbox; a supervised campaign run finishing was otherwise
        // invisible to it.
        if (event.kind === "campaign.changed" && event.change === "halted") this.publishHaltNotification(event.campaign_id);
      } finally {
        this.observeRuntimeCost("runtime_event_publish", started);
      }
    };
    this.publishEvent = eventSink;
    if (options.manager) {
      this.manager = options.manager;
      this.unsubscribeManagerEvents = this.manager.subscribeEvents(eventSink);
    } else {
      this.manager = new CampaignManager({ persistence_dir: options.persistence_dir, on_event: eventSink, kb_backend: options.kb_backend, defer_audit_restore: options.defer_audit_restore });
    }
    this.taskComposer = options.task_composer ?? new TaskComposer({
      manager: this.manager,
      // A confirmed draft must genuinely run, not just admit a tree
      // (`jobScheduler`/`campaignRunner` are read lazily below — they are
      // assigned later in this constructor, but `admit()` is only ever
      // invoked later still, at a real `taskcomposer.confirm`).
      admission: createSupervisedTaskComposerAdmissionPort({
        manager: this.manager,
        jobScheduler: () => this.jobScheduler,
        campaignRunJobKind: CAMPAIGN_RUN_JOB_KIND,
        hasCampaignRunner: () => this.campaignRunner !== null,
        runCampaignJob: (campaignId, jobId) => this.runCampaignJob(campaignId, jobId),
        ...(options.task_composer_attachment_store === undefined ? {} : { attachment_store: options.task_composer_attachment_store }),
      }),
      ...(options.task_composer_planner === undefined ? {} : { planner: options.task_composer_planner }),
      ...(options.task_composer_arbiter === undefined ? {} : { arbiter: options.task_composer_arbiter }),
      ...(options.task_composer_attachment_store === undefined ? {} : { attachment_store: options.task_composer_attachment_store }),
      ...(options.persistence_dir === undefined ? {} : { persistence_dir: options.persistence_dir }),
      on_change: (draft) => eventSink({ kind: "taskcomposer.changed", draft_id: draft.id, status: draft.status, revision: draft.revision }),
    });
    this.supervisor = options.supervisor ?? new TaskSupervisor();
    this.harnessSessions = options.harness_sessions ?? (options.persistence_dir ? new HarnessSessionJournal({ persistence_dir: options.persistence_dir }) : null);
    this.harnessSessionReplay = options.harness_session_replay ?? new HarnessSessionReplayStore(options.persistence_dir ? { persistence_dir: options.persistence_dir } : {});
    this.recoveryService = options.recovery_leases ? new RecoveryService(this.manager, this.supervisor, options.recovery_leases, 100,
      this.harnessSessions !== null
        ? { journal: this.harnessSessions, ...(options.recovery_continuation_admissions === undefined ? {} : { admissions: options.recovery_continuation_admissions }) }
        : undefined) : null;
    this.operations = options.operations ?? new OperationRegistry();
    this.outputEvidence = options.output_evidence ?? (options.persistence_dir ? new OutputEvidenceStore(options.persistence_dir) : null);
    this.selectionCommunications = new ManagerSelectionCommunicationAdapter(this.manager);
    this.outputCapture = new ManagerOutputEvidenceCaptureAdapter(this.outputEvidence);
    this.modelCapabilities = new RuntimeModelCapabilityAdapter(options.model_capabilities ?? null);
    const scoreContext = new ManagerScoreContextAdapter(this.manager);
    // Both services require a real directory and mkdirSync it eagerly — unlike
    // every other optional durable service in this constructor (approvals,
    // remoteSessionAuthority, sessionIdentities, ...), which accept an absent
    // `persistence_dir` as "stay in memory". Without an explicit
    // `persistence_dir`, defaulting to a relative ".arbor" wrote real files
    // under whatever the process's cwd happened to be — the live repository
    // checkout for the pervasive bare `new ArborRuntime()` used across this
    // package's tests. An isolated per-instance OS temp directory keeps the
    // "no default worktree touch" invariant this file already documents for
    // `recovery_leases`/`campaign_runner`/`model_capabilities` above.
    this.tokenEpochs = options.token_epochs ?? new TokenEpochService(join(options.persistence_dir ?? mkdtempSync(join(tmpdir(), "arbor-token-epochs-")), "token-epochs"));
    this.nativeCampaignBudget = new NativeCampaignBudgetAuthority(join(options.persistence_dir ?? mkdtempSync(join(tmpdir(), "arbor-native-campaign-budget-")), "native-campaign-budget"));
    // This constructor is the recovered single-writer boundary. No native
    // worker from the prior process can still provide usage telemetry, so an
    // orphaned reservation is settled at its durable admission estimate rather
    // than silently restored as available campaign budget.
    this.nativeCampaignBudget.reconcileOrphanedReservations();
    this.configInspection = options.config_inspection ?? new ConfigInspectionService();
    this.agentRegistry = new AgentRegistry(options.agent_definitions ?? { definitions: () => [] }, this.supervisor);
    this.jobScheduler = options.job_scheduler ?? new JobScheduler(this.supervisor);
    this.campaignRunAttempts = new CampaignRunAttemptIndex(options.persistence_dir ? { persistence_dir: options.persistence_dir } : {});
    this.longHorizonScheduler = options.long_horizon_scheduler ?? null;
    this.approvals = options.approvals ?? new ApprovalService(options.persistence_dir ? { persistence_dir: options.persistence_dir } : {});
    this.remoteSessionAuthority = options.remote_session_authority ?? new RemoteSessionAuthority(options.persistence_dir ? { persistence_dir: options.persistence_dir } : {});
    this.distributedControl = options.distributed_control ?? null;
    this.pluginRegistry = options.plugin_registry ?? null;
    this.productIntegrations = options.product_integrations ?? new ProductIntegrationControlPlane(options.persistence_dir ? { persistence_dir: options.persistence_dir } : {});
    this.harnessIntegrations = options.harness_integrations ?? null;
    this.nativePeerChannels = options.native_peer_channels ?? new NativePeerChannelService(this.manager, options.persistence_dir ? { persistence_dir: options.persistence_dir } : {});
    for (const descriptor of builtinProductIntegrations({ remote_ready: options.remote_session_authority !== undefined, scheduler_ready: this.longHorizonScheduler !== null })) {
      try { this.productIntegrations.register(descriptor); } catch { /* persisted/composed registrations remain authoritative */ }
    }
    this.sessionIdentities = options.session_identities ?? new SessionIdentityService(options.persistence_dir ? { persistence_dir: options.persistence_dir } : {});
    this.resultVerification = options.result_verification ?? new ResultVerificationService(options.persistence_dir ? { persistence_dir: options.persistence_dir } : {});
    this.notificationInbox = options.notification_inbox ?? new NotificationInboxService(options.persistence_dir ? { persistence_dir: options.persistence_dir } : {});
    this.followUpLineage = options.follow_up_lineage ?? new FollowUpLineageService(options.persistence_dir ? { persistence_dir: options.persistence_dir } : {});
    this.governedContext = options.governed_context ?? new GovernedContextService({
      ...(options.persistence_dir ? { persistence_dir: options.persistence_dir } : {}),
      message_evidence: {
        hasMessageRange: (campaign_id, range) => {
          try {
            const messages = this.manager.getAuditRecords(campaign_id).filter((record) => record.kind === "node_communication");
            const start = messages.findIndex((record) => record.id === range.start_communication_id);
            const end = messages.findIndex((record) => record.id === range.end_communication_id);
            if (start < 0 || end < start) return false;
            return messages.slice(start, end + 1).every((record) => record.communication.conversation_id === range.context_id
              && (record.communication.parent_communication_id ?? "root") === range.thread_id);
          } catch { return false; }
        },
      },
    });
    this.declarativeSubagentExecutor = options.declarative_subagent_executor ?? null;
    this.harnessEvaluator = options.harness_evaluator ?? null;
    this.campaignRunner = options.campaign_runner ?? null;
    this.harnessControl = new HarnessControlPlane({
      connector_registry: options.harness_connector_registry,
      credential_broker: options.credential_lease_broker,
      register_native_connector: options.register_native_harness_connector,
      native_observed_at: options.native_harness_observed_at,
      native_artifact_capture: options.persistence_dir !== undefined || options.harness_sessions?.isAvailable() === true,
    });
    this.refreshProductIntegrationDiscovery();
    this.nativeHarnessReadiness = options.native_harness_readiness ?? null;
    this.operatorDoctorIntegration = options.operator_doctor_integration ?? null;
    this.nativeSessionRegistry = options.native_session_registry ?? new LiveNativeSessionRegistry();
    // A persisted active-session record can only prove its last redacted
    // checkpoint after restart. Reconcile it into a read-only recovery
    // disposition; never restart provider/tool work from a constructor.
    if (this.harnessSessions?.isAvailable()) this.harnessSessions.reconcileOrphanedSessions();
    this.agentConfig = Object.freeze({ ...(options.agent_config ?? {}) });
    this.siblingSpawner = options.sibling_spawner?.(this.manager, this.supervisor) ?? null;
    this.loopPorts = {
      communications: this.selectionCommunications,
      output_evidence: this.outputCapture,
      model_capabilities: this.modelCapabilities,
      token_epochs: this.tokenEpochs,
      score_ctx: (campaignId) => scoreContext.score_ctx(campaignId),
      telemetry: new ManagerTelemetryAdapter(this.manager),
      interruptions: { interrupt: (input) => {
        const identity = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        this.interrupt({
          campaign_id: input.campaign_id, node_id: input.node_id, scope: input.scope,
          operation_id: `loop-interrupt-${identity}`, reason: input.reason,
          expected_version: this.manager.getCampaignVersion(input.campaign_id),
          partial_evidence_ids: [],
          provenance: { tag: "generated", generator: "arbor-runtime", input_hash: identity },
        });
      } },
    };
    this.surveillance = options.surveillance ?? new SurveillanceMonitor({
      source: new CampaignSurveillanceSource(this.manager, this.supervisor),
      persistence_dir: options.persistence_dir,
      on_finding: (finding) => this.publishSurveillanceFinding(finding),
    });
    this.lifecycle = composeLifecycle(options, this.manager);
    this.persistenceDir = options.persistence_dir ?? null;
    this.workspaceDir = options.workspace_root ?? null;
    this.gitWorkspace = options.git_workspace ?? null;
    const names = new Set<string>();
    for (const participant of this.lifecycle) {
      if (!participant.name.trim()) throw new Error("runtime lifecycle participant names must be non-empty");
      if (names.has(participant.name)) throw new Error(`duplicate runtime lifecycle participant ${participant.name}`);
      names.add(participant.name);
    }
    this.restoreSupervisor();
    this.restoreOperations();
    this.observeRuntimeCost("runtime_startup", startupStarted);
  }

  /** Canonical interruption entry point shared by transports, signals and overflow routing. */
  interrupt(input: {
    campaign_id: string; node_id: string; operation_id: string; scope: "node" | "subtree";
    reason: string; expected_version: string; partial_evidence_ids?: readonly string[]; provenance: Provenance;
  }): { affected_node_ids: string[]; version: string } {
    return this.manager.interrupt({ ...input, acknowledge: (nodeIds) => {
      const matching = this.supervisor.list({ include_terminal: true }).filter((task) =>
        task.owner_scope_id === input.campaign_id && nodeIds.some((nodeId) => task.kind.includes(nodeId))
        && ["accepted", "started", "retrying", "cancel_requested"].includes(task.state));
      for (const task of matching) {
        this.supervisor.requestCancellationSubtree(task.id);
        this.checkpointSupervisor();
        this.supervisor.acknowledgeCancellationSubtree(task.id);
        this.checkpointSupervisor();
      }
      // Wave 1 Lane A (todo 3): reach a genuinely running campaign loop. The
      // loop has exactly one in-flight specialist/critic dispatch at a time
      // and shares a single AbortSignal across the whole run — there is no
      // finer-grained per-node signal to cancel. So when the interrupted
      // subtree includes the node currently being expanded, the only way
      // this interrupt can "stop work in flight" is to cancel that
      // campaign's supervised CAMPAIGN_RUN_JOB_KIND task, exactly the way
      // job.cancel already does via TaskSupervisor.requestCancellation
      // (runCampaignJob finalizes on whatever state the task actually ends
      // up in, so this is safe to trigger from any interrupt source,
      // including the loop's own context-overflow port). An interrupt that
      // does not touch the active node still applies the ledger-level
      // interruption above with nothing live left to cancel.
      const activeNode = this.manager.getActiveExpandingNode(input.campaign_id);
      if (activeNode !== null && nodeIds.includes(activeNode)) {
        const job = this.supervisor.list().find((task) =>
          task.owner_scope_id === input.campaign_id && task.kind === CAMPAIGN_RUN_JOB_KIND
          && (task.state === "started" || task.state === "retrying"));
        if (job) {
          this.supervisor.requestCancellation(job.id);
          this.checkpointSupervisor();
        }
      }
    } });
  }

  /**
   * Start executing the tree-search loop for an already-registered,
   * already-started `CAMPAIGN_RUN_JOB_KIND` supervised task (see
   * `RuntimeCatalogRouter.dispatchJobCommand`'s `job.submit` case — the sole
   * caller). Fire-and-forget: the supervisor task's own AbortSignal
   * (`supervisor.signalFor(taskId)`) is threaded straight into
   * `campaignRunner.run` as its cancellation signal, so `job.cancel` and a
   * `tree.interrupt` that reaches the active node (see `interrupt` above)
   * both already abort it — no second cancellation channel is introduced.
   * Finalization reads the task's actual terminal state back off the
   * supervisor rather than trusting the runner's own report, so it is
   * correct regardless of *why* the signal was aborted.
   *
   * Returns `{ ok: false }` without mutating the task when no
   * `campaign_runner` is configured (typed absence) or a run is already
   * active for this campaign — the caller is responsible for failing the
   * task in that case.
   *
   * The `campaignRunner.run(...).then(...)` chain below is still
   * fire-and-forget from this method's own return value — the default,
   * non-blocking dispatch path is unchanged. It is additionally registered
   * in `campaignRunSettlements` so `awaitCampaignRun` can hand an opt-in
   * caller (`arbor task confirm --wait`) the identical settlement instead of
   * starting a second run or polling.
   */
  runCampaignJob(campaignId: string, taskId: string): { ok: true } | { ok: false; reason: string } {
    // ADR-093 §1: this is the sole choke point every canonical dispatch path
    // (cli.ts, task-composer-admission.ts, runPreparedContinuation below,
    // runtime-catalog.ts's job.submit/job.retry) already funnels through, so
    // it is where the durable attempt identity record is appended before a
    // campaign run becomes observable — no second dispatch path is added.
    const operationId = this.supervisor.get(taskId)?.operation_id ?? taskId;
    if (!this.campaignRunner) {
      this.campaignRunAttempts.recordRefusal({ campaign_id: campaignId, operation_id: operationId, code: "no_campaign_runner_configured" });
      return { ok: false, reason: "no campaign runner is configured for this composition root" };
    }
    if (this.activeCampaignRuns.has(campaignId)) {
      this.campaignRunAttempts.recordRefusal({ campaign_id: campaignId, operation_id: operationId, code: "campaign_already_running" });
      return { ok: false, reason: `campaign ${campaignId} already has an active supervised run` };
    }
    const attempt = this.campaignRunAttempts.recordAttempt(
      { campaign_id: campaignId, operation_id: operationId, supervisor_task_id: taskId },
      this.latestCampaignRunAttemptTaskState(campaignId),
    );
    if (!attempt.ok) return { ok: false, reason: attempt.reason };
    const signal = this.supervisor.signalFor(taskId);
    this.campaignRunDiagnostics.delete(campaignId);
    // WA-12: a fresh run starting for this campaign supersedes whatever a
    // PRIOR run's settlement recorded — never let a stale cancellation from
    // an earlier `campaign.run` job bleed into this one's outcome.
    this.manager.clearCampaignRunCancelled(campaignId);
    this.activeCampaignRuns.add(campaignId);
    // `jobScheduler.submit` already drove `register`+`start` on `taskId`
    // before this method was ever called (see the doc comment above), so
    // this is the task's real, current `"started"` state — publish it here,
    // the one place both the supervisor mutation and event-stream access
    // (`publishEvent`) are both in scope for this job kind.
    const startedTask = this.supervisor.get(taskId);
    if (startedTask) this.publishEvent({ kind: "task.changed", task: startedTask });
    const finish = (settle: () => void): SupervisorTask["state"] | null => {
      this.activeCampaignRuns.delete(campaignId);
      try { settle(); } catch { /* task may already be terminal via a racing cancel acknowledgement */ }
      this.checkpointSupervisor();
      const finalTask = this.supervisor.get(taskId);
      if (finalTask) this.publishEvent({ kind: "task.changed", task: finalTask });
      return finalTask?.state ?? null;
    };
    // WA-12: `runtime.interrupt()` (the canonical cancellation entry point —
    // see its own doc above) synchronously requests AND acknowledges
    // cancellation on this exact supervised task the moment the interrupted
    // subtree includes the actively-expanding node — well before
    // `campaignRunner.run(...)` below ever resolves. By the time this
    // `.then()` fires, `task.state` is therefore already the TERMINAL
    // `"cancelled"`, not `"cancel_requested"` — the old `task?.state ===
    // "cancel_requested"` check missed that and fell through to
    // `onOtherwise` (`supervisor.complete`), which silently overwrote the
    // already-cancelled task back to `"completed"` (see `terminate`'s
    // unconditional `task.state = state` once neither the same-state nor
    // the `cancel_requested` guard applies). `outcome.cancelled` — the
    // loop's own `report.cancelled` (see `runCampaign`'s cancellation
    // branches), threaded through every real `CampaignRunner` — is checked
    // independently so this is correct even when no supervisor-mediated
    // cancellation request happened at all (a bare `AbortSignal` the caller
    // aborted directly).
    // A bare `AbortSignal` the caller aborted directly (no `job.cancel`/
    // `interrupt` in between) never puts this task through
    // `requestCancellation` at all, so it is still ordinarily `"started"`
    // here — `acknowledgeCancellation` alone would reject that
    // (`"cancellation must be requested before it can be acknowledged"`).
    // Request it first (idempotent, and a no-op abort on an already-aborted
    // signal) so every `cancelled` outcome reaches the same terminal
    // `"cancelled"` state regardless of which path got there.
    const acknowledgeAsCancelled = (): void => {
      const current = this.supervisor.get(taskId);
      if (current && current.state !== "cancel_requested" && current.state !== "cancelled") {
        try { this.supervisor.requestCancellation(taskId); } catch { /* already advanced past this by a race */ }
      }
      this.supervisor.acknowledgeCancellation(taskId);
    };
    const finalize = (cancelled: boolean, onOtherwise: () => void, diagnostic?: CampaignRunSettlement["diagnostic"]): CampaignRunSettlement => {
      if (cancelled) this.manager.markCampaignRunCancelled(campaignId);
      return {
        task_state: finish(cancelled ? acknowledgeAsCancelled : onOtherwise),
        cancelled,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      };
    };
    const settled: Promise<CampaignRunSettlement> = this.campaignRunner.run(campaignId, signal, () => {
      const current = this.supervisor.get(taskId);
      if (!current || (current.state !== "started" && current.state !== "retrying")) return;
      try {
        const heartbeatTask = this.supervisor.reportHeartbeat(taskId);
        this.checkpointSupervisor();
        this.publishEvent({ kind: "task.changed", task: heartbeatTask });
      } catch { /* a late heartbeat must not affect campaign execution */ }
    }).then(
      (outcome) => {
        const task = this.supervisor.get(taskId);
        const cancelled = outcome.cancelled === true || task?.state === "cancel_requested" || task?.state === "cancelled";
        // WA-40: surface a durable gate-refusal diagnostic (e.g. the
        // isolation gate's own detail, recorded by `loop.ts` on the FIRST
        // node gate refusal this run hit) even for this ordinary,
        // non-throwing settlement — a cancelled run already carries its own
        // signal and does not need this too.
        const runDiagnostic = cancelled ? null : this.manager.getCampaignRunDiagnostic(campaignId);
        const diagnostic = runDiagnostic === null ? undefined
          : { code: "campaign_halt_diagnostic" as const, summary: redactNativeText(runDiagnostic.message).slice(0, 512) };
        return finalize(cancelled, () => this.supervisor.complete(taskId), diagnostic);
      },
      (error: unknown) => {
        const diagnostic = { code: "campaign_run_failed" as const, summary: boundedCampaignRunFailure(error) };
        // B2: the in-memory map below never survives the process, which is
        // exactly how the field-tested silent job death left no trace. Record
        // the same bounded summary durably on the campaign state as well.
        try {
          const stackHead = error instanceof Error && error.stack ? error.stack.split("\n").slice(0, 3).join("\n") : undefined;
          this.manager.recordCampaignRunDiagnostic(campaignId, { message: diagnostic.summary, ...(stackHead === undefined ? {} : { stack_head: stackHead }) });
        } catch { /* diagnostics must never mask the original settlement */ }
        this.campaignRunDiagnostics.delete(campaignId);
        this.campaignRunDiagnostics.set(campaignId, diagnostic);
        while (this.campaignRunDiagnostics.size > 64) this.campaignRunDiagnostics.delete(this.campaignRunDiagnostics.keys().next().value!);
        const task = this.supervisor.get(taskId);
        const cancelled = task?.state === "cancel_requested" || task?.state === "cancelled";
        return finalize(cancelled, () => this.supervisor.fail(taskId), diagnostic);
      },
    );
    this.campaignRunSettlements.set(campaignId, settled);
    return { ok: true };
  }

  /** Submit an admitted continuation through the one canonical campaign.run authority. */
  runPreparedContinuation(campaignId: string, authorizationId: string): { readonly ok: true; readonly task_id: string; readonly dispatched: boolean } | { readonly ok: false; readonly reason: string } {
    const operationId = `continuation-run:${authorizationId}`;
    const taskId = `campaign-run:${campaignId}:${authorizationId}`;
    const submitted = this.jobScheduler.submit({ id: taskId, operation_id: operationId, kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: operationId });
    if (!submitted.ok) return { ok: false, reason: submitted.error };
    if (!submitted.dispatched) return { ok: true, task_id: submitted.job.id, dispatched: false };
    this.checkpointSupervisor();
    const started = this.runCampaignJob(campaignId, submitted.job.id);
    if (!started.ok) { try { this.supervisor.fail(submitted.job.id); this.checkpointSupervisor(); } catch { /* preserve original typed failure */ } return { ok: false, reason: started.reason }; }
    return { ok: true, task_id: submitted.job.id, dispatched: true };
  }

  /**
   * Await the same supervised `campaign.run` job `runCampaignJob` already
   * drives for `campaignId`, resolving once its task reaches a terminal
   * state (completed/failed/cancelled) — the exact settlement
   * `finalize`/`finish` above already compute, read straight off
   * `TaskSupervisor`. No second run is started and no wall-clock polling is
   * used: this returns the tracked promise itself (already resolved if the
   * run settled before this was called — "returns immediately" falls out of
   * awaiting an already-resolved promise, no special-casing needed), or a
   * `{ task_state: null }` fallback when no run was ever tracked for this
   * campaign in this runtime instance.
   */
  awaitCampaignRun(campaignId: string): Promise<CampaignRunSettlement> {
    return this.campaignRunSettlements.get(campaignId) ?? Promise.resolve({ task_state: null, cancelled: false });
  }

  /** Decision §3: a new attempt cannot supersede a still-runnable predecessor. */
  private latestCampaignRunAttemptTaskState(campaignId: string): CampaignRunAttemptLatestTaskState {
    const latest = this.campaignRunAttempts.latestFor(campaignId);
    if (latest === null) return "none";
    if (latest.refusal !== null || latest.supervisor_task_id === null) return "terminal";
    const task = this.supervisor.get(latest.supervisor_task_id);
    if (task === undefined) return "terminal";
    if (this.supervisor.reconciliationTasks().some((reconciling) => reconciling.id === task.id)) return "reconciliation_required";
    return isTerminalSupervisorTaskState(task.state) ? "terminal" : "runnable";
  }

  /**
   * ADR-093 §4: the sole canonical campaign-run status read. CLI/TUI/web
   * adapters (out of this tranche's ownership) must call through here
   * rather than rejoining `supervisor`/`jobScheduler`/`manager`/
   * `harnessSessions` themselves.
   */
  getCampaignRunStatus(campaignId?: string, asOf = new Date().toISOString()): CampaignRunStatusProjection {
    const started = this.performanceProbe ? performance.now() : 0;
    try {
      const reconciliationIds = new Set(this.supervisor.reconciliationTasks().map((task) => task.id));
      const campaignFacts = this.manager.listCampaigns().map((campaign) => ({ id: campaign.id, halted: campaign.halted, terminal_outcome: campaign.terminal_outcome }));
      const diagnostics = new Map<string, { code: string; summary: string }>();
      for (const fact of campaignFacts) {
        const diagnostic = this.manager.getCampaignRunDiagnostic(fact.id);
        if (diagnostic !== null) diagnostics.set(fact.id, { code: "campaign_run_failed", summary: diagnostic.message });
      }
      return projectCampaignRunStatus({
        attempts: this.campaignRunAttempts.list(campaignId),
        tasks: this.supervisor.list({ include_terminal: true }),
        reconciliation_required_task_ids: reconciliationIds,
        campaigns: campaignFacts,
        campaign_run_diagnostics: diagnostics,
        ephemeral: !this.campaignRunAttempts.isAvailable(),
        as_of: asOf,
        ...(campaignId === undefined ? {} : { campaign_id: campaignId }),
      });
    } finally {
      this.observeRuntimeCost("campaign_status_projection", started);
    }
  }

  /**
   * ADR-094: the same campaign-run status, carried in the versioned
   * `ProjectionLifecycle<T>` envelope every operator-facing projection must
   * use. The domain payload is untouched — `getCampaignRunStatus` above stays
   * the canonical producer — and the envelope adds only observation and
   * freshness facts, so a renderer can tell a stale read from a fresh one
   * instead of presenting both as current.
   */
  getCampaignRunStatusProjection(
    campaignId?: string,
    clock: ProjectionClock = { now: () => new Date().toISOString() },
    prior: ProjectionLifecycle<CampaignRunStatusProjection> = initialProjectionLifecycle<CampaignRunStatusProjection>("campaign.run.status"),
  ): ProjectionLifecycle<CampaignRunStatusProjection> {
    // A local in-process read is "connected" in transport terms: there is no
    // channel that could have dropped between producer and reader here.
    const requested = beginProjectionRequest(prior, clock, "connected");
    let status: CampaignRunStatusProjection;
    try {
      status = this.getCampaignRunStatus(campaignId, requested.requested_at ?? clock.now());
    } catch (error) {
      // An envelope that can only report success is not carrying observation
      // facts, it is hiding them. A failed read stays failed rather than
      // surfacing as an empty-but-ready projection a renderer would trust.
      return resolveProjectionFailure(requested, {
        code: "campaign_run_status_read_failed",
        diagnostic_ref: error instanceof Error ? error.message.slice(0, 200) : null,
        clock,
        transport: "connected",
      });
    }
    // Freshness is re-evaluated on the way out, so a value produced inside its
    // budget and read after it has expired reports `stale`, not `ready`.
    return checkProjectionFreshness(projectCampaignRunStatusLifecycle(requested, { status, clock, transport: "connected" }), clock);
  }

  /**
   * ADR-118's gate-refusal projection, carried in the same ADR-094
   * `ProjectionLifecycle<T>` envelope `getCampaignRunStatusProjection` above
   * uses. Takes an already-computed `GateRecord` (the manager's own
   * admission/isolation/evidence/audit gate result) rather than re-deriving
   * gate logic — this call only projects what the manager already recorded,
   * per `gate-refusal-projection.ts`'s own contract. A `null` source means
   * the gate ran and passed (or has not recorded a refusal); an
   * `{ available: false }` source means the gate's own authority/result
   * could not be read at all, which is reported as `unavailable` rather than
   * silently treated as "no refusal" or a synthetic failure.
   */
  getGateRefusalProjection(
    source:
      | { readonly available: true; readonly record: GateRecord | null }
      | { readonly available: false; readonly gate: GateType; readonly code: string; readonly reason: string },
    remediation: string,
    clock: ProjectionClock = { now: () => new Date().toISOString() },
  ): ProjectionLifecycle<GateRefusalProjection | null> {
    const requested = beginProjectionRequest(initialProjectionLifecycle<GateRefusalProjection | null>("gate.refusal"), clock, "connected");
    if (!source.available) {
      const unavailable = projectGateUnavailable({ gate: source.gate, code: source.code, reason: source.reason, remediation });
      return checkProjectionFreshness(projectGateRefusalLifecycle(requested, {
        source: { kind: "unavailable", code: source.code, diagnostic_ref: unavailable.summary },
        clock,
        transport: "connected",
      }), clock);
    }
    const projection = source.record === null ? null : projectGateRecord(source.record, remediation);
    return checkProjectionFreshness(projectGateRefusalLifecycle(requested, {
      source: { kind: "available", value: projection },
      clock,
      transport: "connected",
    }), clock);
  }

  /** Inspect an isolated connector without exposing connector implementation types. */
  inspectHarnessConnector(connectorId: string): ConnectorInspection | null {
    return this.harnessControl.inspect(connectorId);
  }

  /** A stable inspection projection for supervised dispatch admission. */
  listHarnessConnectors(): readonly ConnectorInspection[] {
    return this.harnessControl.list();
  }

  /** Reconciles only already-composed connectors/plugins into product discovery. It never starts one. */
  refreshProductIntegrationDiscovery(): void {
    for (const connector of this.listHarnessConnectors()) {
      const capabilities = connector.capabilities.map((item) => item.capability).filter((capability) => ["browser_observe", "web_research", "computer_use"].includes(capability));
      if (capabilities.length === 0) continue;
      const key = createHash("sha256").update(connector.connector_id).digest("hex").slice(0, 24);
      const risky = capabilities.length > 0;
      this.productIntegrations.discover({ id: `browser.connector-${key}`, kind: "browser", version: connector.implementation_version, capabilities, permissions: risky ? ["network", ...(capabilities.includes("computer_use") ? ["computer_use"] : [])] : [], dependencies: [`harness connector ${connector.connector_id}`], handoff: { kind: "command", value: `arbor integration inspect browser.connector-${key} --json` }, health: { status: connector.health === "healthy" ? "ready" : "unavailable", detail: connector.diagnostic ?? `composed connector ${connector.connector_id}` } }, connector.health === "healthy" ? "discovered" : "unavailable");
    }
    for (const plugin of this.pluginRegistry?.list() ?? []) this.productIntegrations.discover(pluginIntegrationDescriptor(plugin), plugin.state);
  }

  applyProductIntegrationLifecycle(input: { readonly kind: "integration.install" | "integration.enable" | "integration.disable" | "integration.update" | "integration.rollback"; readonly integration_id: string; readonly version?: string; readonly plugin_manifest?: string; readonly plugin_root?: string; readonly acknowledge_risk: boolean }): void {
    if (!input.integration_id.startsWith("extension.")) {
      if (input.kind === "integration.rollback") this.productIntegrations.rollback(input.integration_id, input.acknowledge_risk);
      else if (input.kind === "integration.update") this.productIntegrations.update(input.integration_id, input.version!, input.acknowledge_risk);
      else this.productIntegrations.setState(input.integration_id, input.kind === "integration.enable" ? "enabled" : input.kind === "integration.disable" ? "disabled" : "installed", input.acknowledge_risk);
      return;
    }
    const registry = this.pluginRegistry; if (registry === null) throw new Error("plugin registry is not composed"); const pluginId = input.integration_id.slice("extension.".length);
    if (input.kind === "integration.install") {
      const plugin = registry.admit(input.plugin_manifest!, input.plugin_root!); if (plugin.manifest.plugin_id !== pluginId) throw new Error("integration id must match the plugin manifest id"); this.productIntegrations.discover(pluginIntegrationDescriptor(plugin), plugin.state); return;
    }
    if (input.kind === "integration.enable") { const plugin = registry.enable(pluginId, input.acknowledge_risk); this.productIntegrations.discover(pluginIntegrationDescriptor(plugin), plugin.state); this.productIntegrations.setState(input.integration_id, "enabled", input.acknowledge_risk); return; }
    if (input.kind === "integration.disable") { const plugin = registry.disable(pluginId); this.productIntegrations.discover(pluginIntegrationDescriptor(plugin), plugin.state); this.productIntegrations.setState(input.integration_id, "disabled", input.acknowledge_risk); return; }
    if (input.kind === "integration.update") {
      this.productIntegrations.update(input.integration_id, input.version!, input.acknowledge_risk);
      try { const plugin = registry.update(pluginId, input.plugin_manifest!, input.plugin_root!, input.acknowledge_risk); this.productIntegrations.discover(pluginIntegrationDescriptor(plugin), plugin.state); } catch (error) { this.productIntegrations.rollback(input.integration_id, input.acknowledge_risk); throw error; }
      return;
    }
    const plugin = registry.rollback(pluginId, input.acknowledge_risk); this.productIntegrations.discover(pluginIntegrationDescriptor(plugin), plugin.state); this.productIntegrations.rollback(input.integration_id, input.acknowledge_risk);
  }

  /**
   * Negotiate a connector before campaign work is dispatched. This does not
   * start a session or a campaign; job.submit(campaign.run) remains sole
   * execution authority.
   */
  selectHarnessConnector(requirements: readonly CapabilityRequirement[]): HarnessConnectorSelection {
    return this.harnessControl.select(requirements);
  }

  /** Live records win over an older durable snapshot for the same session id. */
  listHarnessSessions(campaignId?: string, limit = 200): readonly HarnessSessionSummary[] | null {
    const durable = this.harnessSessions?.list(campaignId, limit) ?? [];
    const live = this.nativeSessionRegistry.list().filter((session) => campaignId === undefined || session.campaign_id === campaignId);
    if (this.harnessSessions === null && live.length === 0) return null;
    const byId = new Map<string, HarnessSessionSummary>();
    for (const session of durable) byId.set(session.session_id, session);
    for (const session of live) byId.set(session.session_id, session);
    return [...byId.values()].sort((left, right) => right.session_id.localeCompare(left.session_id)).slice(0, limit);
  }

  inspectHarnessSession(sessionId: string): HarnessSessionSummary | null {
    return this.nativeSessionRegistry.inspect(sessionId) ?? this.harnessSessions?.inspect(sessionId) ?? null;
  }

  /** Durable host audit evidence is bounded and always independently redacted. */
  harnessSessionToolAudits(sessionId: string, limit = 50): readonly HarnessSessionToolAuditProjection[] {
    return this.harnessSessions?.toolAudits(sessionId, limit) ?? [];
  }

  /** Immutable redacted manifests only; this is not a continuation or replay port. */
  harnessSessionArtifacts(sessionId: string, limit = 50): readonly HarnessSessionArtifactProjection[] {
    return this.harnessSessions?.artifactsFor(sessionId, limit) ?? [];
  }

  harnessSessionEvents(sessionId: string, afterSequence = 0, limit = 200) {
    const live = this.nativeSessionRegistry.events(sessionId, afterSequence);
    if (live !== null) return live.map(redactHarnessSessionEvent).slice(0, limit);
    return this.harnessSessions?.events(sessionId, afterSequence, limit) ?? null;
  }

  hasHarnessSessionSource(): boolean { return this.harnessSessions !== null || this.nativeSessionRegistry.list().length > 0; }

  /**
   * WA-41: publish an inbox notification for a campaign's terminal halt —
   * the sole caller is the `manager.subscribeEvents` sink wired in the
   * constructor, which fires for every `campaign.changed`/"halted" event
   * (`manualHalt` and `completeAutoHalt` both emit it; there is no other
   * halt path in `manager.ts`). Severity follows the same
   * `terminal_outcome` projection `listCampaigns` already derives — never a
   * second, independently-drifting classification of the same halt.
   * Secret-free by construction: the body is a fixed template carrying only
   * the halt reason and node counts already exposed on the campaign
   * snapshot (never `specialist_output`/free-text node content), and
   * `NotificationInboxService.publish` additionally redacts title/body.
   */
  private publishHaltNotification(campaignId: string): void {
    const listed = this.manager.listCampaigns().find((campaign) => campaign.id === campaignId);
    if (!listed) return;
    const severity: NotificationSeverity = listed.terminal_outcome === "completed" ? "info"
      : listed.terminal_outcome === "failed" ? "error"
      : "warning"; // "partial" | "cancelled" | "in_progress" (should not halt without an outcome)
    const provenance: Provenance = { tag: "generated", generator: "arbor-runtime/campaign-halt", input_hash: createHash("sha256").update(`${campaignId}:${listed.halt_reason ?? "unspecified"}`).digest("hex") };
    const notificationKey = createHash("sha256").update(`campaign-halted-notification:${campaignId}`).digest("hex");
    try {
      this.notificationInbox.publish({
        id: `campaign-halted-${notificationKey}`, fingerprint: `campaign-halted:${notificationKey}`,
        project_id: campaignId, severity,
        title: `Campaign ${listed.terminal_outcome}: ${listed.halt_reason ?? "unspecified"}`,
        body: `Campaign ${campaignId} halted (${listed.halt_reason ?? "unspecified"}); ${listed.verified_nodes} of ${listed.total_nodes} node(s) verified.`,
        actions: [{ label: "Inspect campaign", action: "campaign.report" }],
        delivery: { channels: ["tui", "terminal"], quiet_hours: null }, provenance,
        idempotency_key: `campaign-halted-notification:${campaignId}`,
      });
    } catch {
      // A campaign's halt state is already durable in the ledger via
      // completeAutoHalt/manualHalt's own gate checkpoint — inbox
      // persistence is an observability side effect and must never mask or
      // reclassify that.
      this.failures.push(this.failure("internal", "notification_inbox", "campaign halt notification could not be persisted"));
    }
  }

  /** Records the canonical absence of verification evidence when a session settles. */
  recordSessionCompletionUx(input: { readonly session_id: string; readonly campaign_id: string; readonly node_id: string }): void {
    const provenance: Provenance = { tag: "generated", generator: "arbor-runtime/session-completion", input_hash: createHash("sha256").update(`${input.session_id}:${input.campaign_id}:${input.node_id}`).digest("hex") };
    this.resultVerification.record({
      campaign_id: input.campaign_id, node_id: input.node_id, checks: [], files: [],
      diffstat: { additions: null, deletions: null, files_changed: null }, confidence: "unavailable",
      absence_reason: "session ended without canonical verification evidence", provenance,
      idempotency_key: `session-completion-verification:${input.session_id}`,
    });
    const notificationKey = createHash("sha256").update(`session-completion-notification:${input.session_id}`).digest("hex");
    try {
      this.notificationInbox.publish({
        id: `session-completed-${notificationKey}`, fingerprint: `session-completed:${notificationKey}`,
        project_id: input.campaign_id, severity: "info", title: "Session ended",
        body: "The session ended without recorded verification. Inspect the result before retrying or adopting changes.",
        actions: [{ label: "Inspect verification", action: "result.verification.list" }],
        delivery: { channels: ["tui", "terminal"], quiet_hours: null }, provenance,
        idempotency_key: `session-completion-notification:${notificationKey}`,
      });
    } catch {
      // Completion is already recorded above. Inbox persistence is an
      // observability side effect and must not reclassify verified work.
      this.failures.push(this.failure("internal", "notification_inbox", "session completion notification could not be persisted"));
    }
  }

  /** Records a bounded post-commit observability failure without changing campaign or result state. */
  recordProductObservabilityFailure(source: "notification_inbox" | "result_verification", summary: string): void {
    this.failures.push(this.failure("internal", source, summary));
  }

  /** Shared versioned operator diagnosis. It is local-only and exposes only credential presence. */
  inspectOperatorDoctor(): UnifiedDoctorProjection | null {
    if (this.persistenceDir === null || this.workspaceDir === null || this.operatorDoctorIntegration === null) return null;
    const productIntegrations = this.productIntegrations.list();
    const schedules = this.longHorizonScheduler?.list() ?? [];
    const sessionInventory = this.listHarnessSessions(undefined, 200) ?? [];
    const liveSessions = this.nativeSessionRegistry.list();
    // WA-43/J3-21: fold governed hook catalog/bus diagnostics into the
    // existing `operational.extensions` block as one more extension-kind
    // integration summary, so an operator sees a malformed hook descriptor
    // or a declared-but-never-fired hook the same way they already see any
    // other unhealthy extension — without widening the doctor schema.
    const hookBus = HookBus.fromDirectory(join(this.workspaceDir, ".arbor", "hooks"));
    const hookDiagnostics = hookBus.diagnostics();
    const hookNeverFired = hookBus.neverFired();
    const hookIntegration = {
      id: "hooks", kind: "extension",
      state: hookDiagnostics.length > 0 ? "invalid" : "enrolled",
      health: hookDiagnostics.length > 0 ? "attention" as const : "ready" as const,
      detail: hookDiagnostics.length > 0
        ? `${hookDiagnostics.length} hook descriptor(s) failed validation: ${hookDiagnostics.map((diagnostic) => `${diagnostic.source} (${diagnostic.code})`).join(", ")}`
        : hookNeverFired.length > 0
          ? `${hookNeverFired.length} declared hook(s) have never fired: ${hookNeverFired.map((hook) => `${hook.hook_id}@${hook.version}`).join(", ")}`
          : "hook catalog is valid",
      permissions: [] as readonly string[], dependencies: [] as readonly string[], handoff: { kind: "none", value: null as string | null },
    };
    return buildUnifiedDoctor({
      cwd: this.workspaceDir, persistence_dir: this.persistenceDir, config: this.configInspection.inspect(), readiness: this.nativeHarnessReadiness?.inspect() ?? null, integration: this.operatorDoctorIntegration,
      connectors: this.listHarnessConnectors().map((connector) => ({ connector_id: connector.connector_id, status: connector.health === "healthy" ? "ready" as const : "unavailable" as const, capabilities: connector.capabilities.map((capability) => capability.capability), detail: `${connector.implementation_version} (${connector.supported_upstream_range})` })),
      operational: {
        integrations: [...productIntegrations.map((item) => ({ id: item.id, kind: item.kind, state: item.state, health: item.health.status === "ready" ? "ready" as const : item.health.status === "unavailable" ? "unavailable" as const : "attention" as const, detail: item.health.detail, permissions: item.permissions, dependencies: item.dependencies, handoff: item.handoff })), hookIntegration],
        remote: { composed: productIntegrations.some((item) => item.kind === "remote" && item.health.status === "ready"), registered_sessions: this.remoteSessionAuthority.list().length, detail: productIntegrations.find((item) => item.kind === "remote")?.health.detail ?? "remote integration is not composed" },
        scheduler: { composed: this.longHorizonScheduler !== null, schedules: schedules.length, active: schedules.filter((item) => item.state === "active").length, human_required: schedules.filter((item) => item.state === "human_required").length, runs: this.longHorizonScheduler?.runHistory().length ?? 0, detail: this.longHorizonScheduler === null ? "long-horizon scheduler is not composed" : "durable scheduler and run history are available" },
        sessions: { source_available: this.hasHarnessSessionSource(), known: sessionInventory.length, live: liveSessions.length, detail: this.hasHarnessSessionSource() ? "durable and live session continuity inventory is available" : "no durable or live session source is composed" },
      },
    });
  }

  inspectMigration(): import("./operator-maintenance.js").MigrationInspection | null { return this.workspaceDir === null ? null : inspectMigration(this.workspaceDir); }

  distributedControlProjection(kind: DistributedControlQueryKind): DistributedControlOperatorProjection | DistributedControlDisabledProjection {
    return this.distributedControl === null
      ? { availability: "disabled", kind, reason: "distributed control is not configured", remediation: "Set ARBOR_DISTRIBUTED_CONTROL_CONFIG to a closed v1 authority or join config, then restart this runtime." }
      : this.distributedControl.operatorProjection(kind);
  }

  /** Availability is a read-only projection; it does not mint recovery authority. */
  sessionContinuationAvailability(sessionId: string): { readonly resume: boolean; readonly respawn: boolean; readonly fork: boolean; readonly reason: string } {
    const service = this.recoveryService; const plan = service?.previewSession(sessionId) ?? null;
    if (service === null || plan === null) return { resume: false, respawn: false, fork: false, reason: "no terminal session with a composed recovery authority" };
    const durableNode = this.manager.getRecoverableNodes(plan.campaign_id).find((candidate) => candidate.node_id === plan.node_id && candidate.prior_operation_id !== null);
    const recoverable = durableNode !== undefined && service.previewContinuation(plan.campaign_id, plan.node_id).some((candidate) => candidate.source_session_id === sessionId);
    // `harness.session.fork` reopens a halted campaign only for a no_nodes or
    // converged halt it can actually run (ADR-043 amendment, fork reopen) and
    // refuses every other halt, so availability advertises exactly that.
    const reopen = !this.manager.getCampaignSnapshot(plan.campaign_id) ? null : this.manager.forkReopenPreview(plan.campaign_id, plan.node_id);
    const fork = reopen === null || reopen.kind !== "refused";
    const reason = recoverable ? "fresh governed admission is required before dispatch" : "fork is available from terminal evidence; resume and respawn require an interrupted recoverable source";
    if (reopen?.kind === "refused") return { resume: recoverable, respawn: recoverable, fork, reason: `${reason}; fork is unavailable because the campaign is halted: ${reopen.detail}` };
    if (reopen?.kind === "reopenable") return { resume: recoverable, respawn: recoverable, fork, reason: `${reason}; a fork reopens this ${reopen.overridden_halt_reason} halt` };
    return { resume: recoverable, respawn: recoverable, fork, reason };
  }

  /** Bounded effect decisions needed before a session continuation may run. */
  sessionContinuationRequirements(sessionId: string): readonly { readonly operation_id: string; readonly classification: string; readonly reason: string }[] {
    const journal = this.harnessSessions; const session = journal?.inspect(sessionId) ?? null;
    if (journal === null || session === null || (session.terminal === null && session.recovery.kind !== "recovery_required")) return [];
    const plan = buildContinuationPlan({ session, checkpoints: journal.operationCheckpoints(sessionId), tool_audits: journal.toolAudits(sessionId, 1_000), events: journal.events(sessionId, 0, 1_000), artifacts: journal.artifactsFor(sessionId, 64) });
    const required = new Set(plan.requires_disposition);
    return plan.classifications.filter((item) => required.has(item.operation_id)).map((item) => Object.freeze({ operation_id: item.operation_id, classification: item.classification, reason: item.reason }));
  }

  /**
   * Convert a hard-crash orphan into the same durable interrupted-node state
   * produced by a graceful shutdown. Preview is side-effect free; apply only
   * records interruption evidence and never replays provider or tool work.
   */
  reconcileHarnessSessionCrash(sessionId: string, apply: boolean): { readonly ok: boolean; readonly applied: boolean; readonly reason: string } {
    const session = this.harnessSessions?.inspect(sessionId) ?? null;
    if (session === null || session.recovery.kind !== "recovery_required") return { ok: false, applied: false, reason: "session is not a durable nonterminal crash orphan" };
    const node = this.manager.getNodeInfo(session.campaign_id, session.node_id);
    if (node === null || node === undefined) return { ok: false, applied: false, reason: "the source campaign node is missing" };
    if (node.state === "interrupted") return { ok: true, applied: false, reason: "the source node is already durably interrupted" };
    if (node.state !== "expanding" && node.state !== "awaiting_review") return { ok: false, applied: false, reason: `the source node is ${node.state}, not an orphaned in-flight node` };
    if (!apply) return { ok: true, applied: false, reason: "hard-crash checkpoint can be reconciled into a durable interruption" };
    const digest = createHash("sha256").update(JSON.stringify({ session_id: session.session_id, campaign_id: session.campaign_id, node_id: session.node_id, checkpoint: session.recovery.checkpoint })).digest("hex");
    const operationId = `crash-reconcile-${digest.slice(0, 32)}`;
    this.manager.interrupt({
      campaign_id: session.campaign_id,
      node_id: session.node_id,
      operation_id: operationId,
      scope: "node",
      reason: "operator-authorized recovery of a durable hard-crash checkpoint",
      expected_version: this.manager.getCampaignVersion(session.campaign_id),
      provenance: { tag: "generated", generator: "runtime-crash-reconciliation", input_hash: `sha256:${digest}` },
      acknowledge: () => {},
    });
    // WA-34: `interruptNode` (arbor-core/tree.ts) only transitions
    // pending/expanding nodes — an `awaiting_review` node (a durably
    // captured specialist candidate still waiting on a critic verdict) is
    // structurally left unchanged by the call above, which nonetheless
    // durably records an interruption request/acknowledgement for it. The
    // prior code returned `applied: true` unconditionally, reporting the
    // no-op as a success. Read the node's actual post-call state — the
    // one ground truth `interruptNode`'s own affected/unchanged split
    // (tree.ts:256-269) determines — rather than assuming the call worked.
    const reconciled = this.manager.getNodeInfo(session.campaign_id, session.node_id);
    if (reconciled?.state !== "interrupted") {
      return {
        ok: false, applied: false,
        reason: `the source node is ${reconciled?.state ?? "missing"} and cannot be interrupted directly; resolve its pending review first with "arbor recover --campaign ${session.campaign_id} --resume-review"`,
      };
    }
    return { ok: true, applied: true, reason: "hard-crash checkpoint was durably reconciled as interrupted" };
  }

  async start(): Promise<RuntimeResult<RuntimeHealth>> {
    if (this.state === "started") return this.result(this.health());
    if (this.state !== "new") return this.failureResult(this.failure("conflict", "runtime", `cannot start runtime while ${this.state}`));
    this.state = "starting";
    for (const participant of this.lifecycle) {
      try {
        await participant.start?.();
        this.startedParticipants.push(participant);
      } catch (error) {
        this.failures.push(this.failure("unavailable", participant.name, "runtime participant failed to start", error));
        await this.closeStartedParticipants();
        this.state = "failed";
        return this.result(this.health());
      }
    }
    this.state = "started";
    return this.result(this.health());
  }

  async close(): Promise<RuntimeResult<RuntimeHealth>> {
    if (this.state === "closed") return this.result(this.health());
    if (this.state === "closing") return this.failureResult(this.failure("conflict", "runtime", "runtime close is already in progress"));
    this.state = "closing";
    await this.closeStartedParticipants();
    this.checkpointSupervisor();
    this.checkpointOperations();
    this.unsubscribeManagerEvents?.();
    this.unsubscribeManagerEvents = null;
    this.state = this.failures.length === 0 ? "closed" : "failed";
    return this.result(this.health());
  }

  health(): RuntimeHealth {
    return {
      state: this.state,
      healthy: this.state === "started" && this.failures.length === 0 && this.reconciliationTasks.length === 0 && this.reconciliationOperations.length === 0,
      active_campaign_id: this.manager.getActiveCampaignId(),
      active_tasks: this.supervisor.list().length,
      event_cursor: this.eventStream.cursor(),
      failures: this.failures.map((failure) => ({ ...failure })),
      campaign_run_diagnostics: [...this.campaignRunDiagnostics].map(([campaign_id, diagnostic]) => ({ campaign_id, ...diagnostic })),
      persistence_diagnostics: this.persistenceDiagnostics.map((diagnostic) => ({ ...diagnostic })),
      reconciliation_tasks: this.reconciliationTasks.map((task) => ({ ...task })),
      reconciliation_operations: this.reconciliationOperations.map((operation) => structuredClone(operation)),
    };
  }

  /** Snapshot is a read model over canonical services, never a parallel domain model. */
  snapshot(): RuntimeResult<RuntimeSnapshot<RuntimeView>> {
    try {
      const view: RuntimeView = {
        lifecycle: this.health(),
        campaigns: this.manager.listCampaigns(),
        tasks: this.supervisor.list(),
        operations: this.operations.list(),
      };
      return this.result(this.eventStream.snapshot(view));
    } catch (error) {
      return this.failureResult(this.failure("internal", "runtime", "unable to read canonical runtime snapshot", error));
    }
  }

  /** Persist a complete supervisor projection at an explicit runtime boundary. */
  checkpointSupervisor(): RuntimeResult<null> {
    if (!this.persistenceDir) return this.result(null);
    const started = this.performanceProbe ? performance.now() : 0;
    try {
      saveSupervisorSnapshot(this.supervisor.list({ include_terminal: true }), this.persistenceDir);
      return this.result(null);
    } catch (error) {
      return this.failureResult(this.failure("internal", "supervisor_persistence", "unable to checkpoint supervisor state", error));
    } finally {
      this.observeRuntimeCost("supervisor_persistence", started);
    }
  }

  /** Explicit snapshot of bounded opt-in local timings; null when not composed. */
  getPerformanceSnapshot(): readonly RuntimeCostSummary[] | null {
    return this.performanceProbe?.snapshot() ?? null;
  }

  private observeRuntimeCost(operation: RuntimeCostObservation["operation"], started: number): void {
    if (!this.performanceProbe) return;
    const duration = Math.max(0, performance.now() - started);
    try { this.performanceProbe.observe({ operation, duration_ms: duration }); } catch { /* measurement must not affect runtime behavior */ }
  }

  /** Persist canonical operation identity/outcome records at an explicit boundary. */
  checkpointOperations(): RuntimeResult<null> {
    if (!this.persistenceDir) return this.result(null);
    try {
      saveOperationSnapshot(this.operations.list(true), this.persistenceDir);
      return this.result(null);
    } catch (error) {
      return this.failureResult(this.failure("internal", "operation_persistence", "unable to checkpoint operation registry", error));
    }
  }

  /** Explicit post-durability checkpoint; surveillance never owns a timer. */
  scanSurveillance(campaignId: string, asOf?: string): RuntimeResult<SurveillanceScanResult> {
    try { return this.result(this.surveillance.scan(campaignId, asOf)); }
    catch (error) { return this.failureResult(this.failure("internal", "surveillance", "unable to scan durable campaign projection", error)); }
  }

  subscribeSurveillance(listener: (event: SurveillanceRuntimeEvent) => void): () => void {
    this.surveillanceSubscribers.add(listener);
    return () => this.surveillanceSubscribers.delete(listener);
  }

  private publishSurveillanceFinding(finding: SurveillanceFinding): void {
    const event: SurveillanceRuntimeEvent = { kind: "surveillance.finding_recorded", campaign_id: finding.campaign_id, dedup_key: finding.dedup_key, finding: structuredClone(finding) };
    for (const subscriber of this.surveillanceSubscribers) {
      try { subscriber(structuredClone(event)); } catch { /* observational subscribers cannot invalidate durable dedup state */ }
    }
  }

  private restoreSupervisor(): void {
    if (!this.persistenceDir) return;
    const restored = loadSupervisorSnapshot(this.persistenceDir);
    this.persistenceDiagnostics = restored.diagnostics.map((diagnostic) => ({ ...diagnostic }));
    if (!restored.value) {
      if (restored.diagnostics.some((diagnostic) => diagnostic.artifact === "supervisor_snapshot")) {
        this.failures.push(this.failure("corrupt_data", "supervisor_persistence", "supervisor snapshot was quarantined during restore"));
      }
      return;
    }
    try {
      this.supervisor.restore(restored.value.tasks);
      this.reconciliationTasks = this.supervisor.reconciliationTasks();
    } catch (error) {
      this.failures.push(this.failure("corrupt_data", "supervisor_persistence", "supervisor snapshot could not be restored", error));
    }
  }

  private restoreOperations(): void {
    if (!this.persistenceDir) return;
    const restored = loadOperationSnapshot(this.persistenceDir);
    this.persistenceDiagnostics.push(...restored.diagnostics.map((diagnostic) => ({ ...diagnostic })));
    if (!restored.value) {
      if (restored.diagnostics.some((diagnostic) => diagnostic.artifact === "operation_snapshot")) this.failures.push(this.failure("corrupt_data", "operation_persistence", "operation snapshot was quarantined during restore"));
      return;
    }
    try {
      this.operations.restore(restored.value.operations);
      this.reconciliationOperations = restored.reconciliation.map((operation) => structuredClone(operation));
    } catch (error) {
      this.failures.push(this.failure("corrupt_data", "operation_persistence", "operation snapshot could not be restored", error));
    }
  }

  private async closeStartedParticipants(): Promise<void> {
    const participants = this.startedParticipants.splice(0).reverse();
    for (const participant of participants) {
      try {
        await participant.close?.();
      } catch (error) {
        this.failures.push(this.failure("internal", participant.name, "runtime participant failed to close", error));
      }
    }
  }

  private result<T>(value: T): RuntimeResult<T> {
    const failures = this.failures.map((failure) => ({ ...failure }));
    return failures.length === 0 ? { ok: true, value, failures } : { ok: false, value, failures };
  }

  private failureResult<T>(failure: RuntimeError): RuntimeResult<T> {
    this.failures.push(failure);
    return { ok: false, value: null, failures: this.failures.map((existing) => ({ ...existing })) };
  }

  private failure(code: RuntimeError["code"], source: string, summary: string, cause?: unknown): RuntimeError {
    return {
      code, severity: "error", recoverable: code !== "internal", source, summary,
      diagnostic: cause === undefined ? undefined : redactNativeText(cause instanceof Error ? cause.message : String(cause)).slice(0, 512),
    };
  }
}

function pluginIntegrationDescriptor(plugin: AdmittedPlugin): ProductIntegrationDescriptor {
  const capabilities = Object.freeze([...plugin.manifest.capabilities.tools]);
  const risky = plugin.manifest.capabilities.code_execution || plugin.manifest.capabilities.network || plugin.manifest.capabilities.filesystem_write || plugin.manifest.components.mcp_servers.length > 0;
  return {
    id: `extension.${plugin.manifest.plugin_id}`, kind: "extension", version: plugin.manifest.version, capabilities,
    permissions: Object.freeze([...(plugin.manifest.capabilities.network ? ["network"] : []), ...(plugin.manifest.capabilities.filesystem_write ? ["repository_write"] : []), ...(plugin.manifest.capabilities.code_execution ? ["code_execution"] : []), ...(plugin.manifest.components.mcp_servers.length > 0 ? ["mcp_server"] : [])]),
    dependencies: Object.freeze([`plugin trust tier ${plugin.tier}`]), handoff: { kind: "command", value: `arbor plugin inspect ${plugin.manifest.plugin_id} --json` },
    health: { status: plugin.state === "enabled" ? "ready" : risky ? "unknown" : "ready", detail: plugin.state === "enabled" ? "plugin is enabled through the composed registry" : "plugin is installed but not active" },
  };
}

function boundedCampaignRunFailure(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === "string" ? error : "unknown campaign runner rejection";
  return redactNativeText(raw).slice(0, 512);
}

/** Separate from the core control stream: this event asserts only durable advisory projection state. */
export interface SurveillanceRuntimeEvent {
  kind: "surveillance.finding_recorded";
  campaign_id: string;
  dedup_key: string;
  finding: SurveillanceFinding;
}

function composeLifecycle(options: RuntimeCompositionOptions, manager: CampaignManager): readonly RuntimeLifecycleParticipant[] {
  const callers = [...(options.lifecycle ?? [])];
  if (options.distributed_control) callers.push({ name: "distributed-control", start: async () => { await options.distributed_control!.start(); }, close: () => options.distributed_control!.close() });
  if (options.devtools_logger === false) return callers;
  if (options.devtools_logger !== undefined) {
    callers.push(createDevToolsTraceLogger(manager, options.devtools_logger));
    return callers;
  }
  if (options.persistence_dir) {
    callers.push(createDevToolsTraceLogger(manager, { persistence_dir: options.persistence_dir }));
  }
  return callers;
}
