#!/usr/bin/env node
import { resolve, join, dirname, sep, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { chmodSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { trackChild } from "./child-registry.js";
import type { Readable, Writable } from "node:stream";
import { acquireWriterLock, WRITER_LOCK_FILENAME, type DecomposerPort, type GovernanceTier, type WriterLockHandle } from "@arbor/core";
import { runLiveness, formatLivenessReport } from "./liveness-runner.js";
import { runEvidenceRefresh, EVIDENCE_STORE_NAMES, type EvidenceRefreshScope, type EvidenceRefreshResult, type EvidenceStoreName } from "./native-tools/evidence-refresh.js";
import { EvidenceLedger, loadLedger, saveLedger, USER_INPUT_MAX_QUESTION_BYTES } from "@arbor/audit";
import { HarnessSessionDurabilityError } from "./harness-session-journal.js";
import { ArborRuntime, CAMPAIGN_RUN_JOB_KIND, type CampaignRunner, type CampaignRunOutcome } from "./runtime.js";
import type { RuntimePerformanceProbe } from "./runtime-performance-probe.js";
import { createNativeHarnessConnectorDescriptor, DEFAULT_DIRECT_NATIVE_CAMPAIGN_REQUIREMENTS } from "./harness-control-plane.js";
import { NATIVE_REPOSITORY_MODEL_TOOLS, NATIVE_PLANNING_MODEL_TOOLS, NATIVE_BUS_THREAD_MODEL_TOOLS } from "./native-model-tool-catalog.js";
export { NATIVE_REPOSITORY_MODEL_TOOLS, NATIVE_PLANNING_MODEL_TOOLS, NATIVE_BUS_THREAD_MODEL_TOOLS } from "./native-model-tool-catalog.js";
import { NATIVE_MAX_TURNS_DEFAULT, NativeAgentExecutor, createNativeSessionContext } from "./native-agent-executor.js";
import { createNativeWebToolPorts, createSearxngWebSearchProvider, type GovernedNetworkPolicy, type WebSearchProvider } from "./native-web-tools.js";
import { createHttpBrowserAutomationProvider, createNativeBrowserToolPorts, type BrowserAutomationProvider } from "./native-browser-tools.js";
import type { NativeBusThreadRouter, NativeBusThreadScope } from "./native-bus-thread-contracts.js";
import type { ArborMCPServer, McpOperatorElicitationPort, McpOperatorElicitationRequest, McpOperatorElicitationResult } from "./server.js";
import { ArborWebUIServer } from "./webui.js";
import { createWorktreeRecoveryLeaseAuthority } from "./recovery-lease-adapter.js";
import { buildAgentDefinitionSource, composeLoopConfigPorts, type TokenEconomyModelIdentity } from "./loop-ports-helper.js";
import { ConfigInspectionService, type DeepPartial } from "./config-inspection.js";
import { RuntimeCatalogRouter } from "./runtime-catalog.js";
import { GitAdapter, GitWorkspaceService, GovernedWorktreeOperations } from "./git-workspace-projection.js";
import { RuntimePortAdapter } from "./tui-adapter.js";
import type { CampaignHarnessIntegration } from "./campaign-harness-integration.js";
import { createOpenCodeCampaignIntegration, createOpenCodeHarnessConnectorDescriptor, createOpenCodeTaskPlanner } from "./integrations/opencode-campaign.js";
import { createClaudeCodeCampaignIntegration, createClaudeCodeHarnessConnectorDescriptor, createClaudeCodeTaskPlanner } from "./integrations/claude-code-campaign.js";
import { createOpenRouterBridgeFallback } from "./openrouter-bridge-fallback.js";
import { createCodexCampaignIntegration, createCodexHarnessConnectorDescriptor, createCodexTaskPlanner } from "./integrations/codex-campaign.js";
import { TaskAttachmentStore, TASK_ATTACHMENT_MAX_BYTES } from "./task-attachment-store.js";
import { loadProjectEnvironment, loadUserEnvironment } from "./project-env.js";
import { resolvePersistenceDir } from "./persistence-path.js";
import { applyPersistenceReconciliation, formatReconcilePlan, planPersistenceReconciliation } from "./persistence-reconcile.js";
import { ManagerScoreContextAdapter, type ProviderModelCapabilityPort } from "./loop-adapters.js";
import { loadConfig, loadConfigWithProvenance, resolveNativeCredentialOverlay, resolveNativeProviderSelection, loadOrganizationPolicyLayers, DEFAULT_CONFIG, DEFAULT_NATIVE_ESTIMATE_MAX_OUTPUT_TOKENS, type ArborConfig, type NativeProviderSelection, type OrganizationPolicy } from "@arbor/config";
import { runCampaign, DEFAULT_LOOP_CONFIG, WorktreeManager, PanelOfCritics, routeCategory, type CampaignExecutionStrategy, type CampaignLoopConfig, type ReviewerRunner } from "@arbor/opencode";
import { BoundedToolSchemaManifestCache, HarnessIntegrationRegistry, InMemoryCredentialLeaseBroker, createReferenceNativeModelAdapterRegistry, NativeUtf8UpperBoundTokenEstimator, StaticNativeModelPricingAuthority, type CapabilityRequirement, type CapabilitySupport, type NativeCredentialLeasePort, type NativeModelAdapterToolDefinition } from "@arbor/harness";
import { buildGovernanceSnapshot, formatGovernanceSnapshot } from "./governance-projection.js";
import { EXIT_CODES, exitCodeForGovernanceError, exitCodeForFindings, escalate } from "./exit-codes.js";
import { MCP_CALL_TIMEOUT_MS, MCP_MAX_ELICIT_MESSAGE_BYTES, MCP_MAX_FRAME_BYTES, MCP_MAX_INPUT_REQUESTS } from "./mcp-client/contracts.js";
import { classifyLegacyRecord, type DecisionStatus } from "@arbor/governance";
import { SiblingSpawner } from "./sibling-spawner.js";
import { buildRunReport, formatRunReport, type RunReportResult } from "./run-report.js";
import { adoptCapturedResult, bestVerifiedResult, captureWorktreeResult, composeCapturedResults, listCapturedResults, locateCampaign, readCapturedComposition, readScopeExpansion } from "./result-adoption.js";
import { fencedResultAdoptionFromEnvironment } from "./fenced-result-adoption.js";
import { ScopedNativeCredentialBroker } from "./scoped-native-credential-broker.js";
import { NativeSystemPolicyApprovalPort } from "./native-system-policy-approval.js";
import { WorktreeMachineVerifier, type WorktreeVerificationCommand, type WorktreeVerificationSpec } from "./worktree-machine-verifier.js";
import { isMinedHighRiskScope, type NativeHighRiskToolScope } from "./native-tools/contracts.js";
import { resolveLinkedDependencyRoots, SandboxedVerificationCommandPort, verifierNetworkFor, type VerifierNetworkEgressGrant } from "./sandbox/confined-command.js";
import { RepositoryGraphIndex } from "./repository-graph.js";
import { createDeclarativeSubagentExecutor } from "./declarative-subagent-executor.js";
import { ProductionHarnessEvaluator } from "./production-harness-evaluator.js";
import { NATIVE_CRITIC_VERDICT_CONTRACT, NATIVE_CRITIC_VERDICT_SCHEMA } from "./native-critic-contract.js";
import { createNativeCriticPort, ARBOR_CRITIC_TRANSPORT_ENV } from "./native-critic-transport.js";
import { admitDeprecatedHarnessLane, CANOPY_CONNECTOR_ID, deprecatedLaneForIntegration, describeDeprecatedHarnessAdmission, recordDeprecatedHarnessAdmission, resolveConfiguredHarnessIntegrationId, type DeprecatedHarnessAdmission } from "./canopy-lane-policy.js";
import { NATIVE_TASK_PLAN_CONTRACT, NATIVE_TASK_PLAN_SCHEMA } from "./native-task-plan-contract.js";
import { NativeHarnessReadinessService, describeNativeConnectorFallbackDemotion, formatNativeHarnessReadiness, resolveNativeHarnessExecutionReadiness, type NativeHarnessExecutionReadiness, type NativeHarnessReadinessProjection } from "./native-harness-readiness.js";
import { composeNativeExecutorEnvironment, loadPluginTrust, resolveOpenAICodexCliSelection, type NativeExecutorComposition } from "./native-executor-composition.js";
import { assertClosedProductionModel, createClosedProviderRoutedModel } from "./closed-provider-routing.js";
import { createClaudeCodeNativeModelPort } from "./claude-code-native-route.js";
import { createOpenAICodexNativeModelPort } from "./openai-codex-native-route.js";
import { loginOpenRouterOAuth } from "./openrouter-oauth-login.js";
import { SkillCatalog } from "./skills/catalog.js";
import { runRecoveryCommand } from "./recovery/recovery-command.js";
import { formatOperatorResume, resumeInterruptedWork } from "./operator-resume.js";
import type { FreshAdmissionResult, FreshAdmissionKind, RecoveryDisposition } from "./recovery/contracts.js";
import { LongHorizonScheduler } from "./scheduler/scheduler.js";
import { DurableScheduleStore } from "./scheduler/schedule-store.js";
import { RemoteRuntimeIngress } from "./remote-ingress.js";
import { distributedControlFromEnvironment, runDistributedControlCli } from "./distributed-control-runtime.js";
import { RemoteOperationTokenAuthority } from "./remote/ephemeral-token.js";
import { RemoteResultReconciler, LocalPatchApplicabilityVerifier } from "./remote/remote-reconcile.js";
import { createAuthenticatedRemoteHttpHost } from "./remote/http-listener.js";
import { HookBus } from "./hooks/bus.js";
import { DifficultyCalibrator } from "./routing/difficulty.js";
import { DifficultyRoutingPolicy } from "./routing/routing-policy.js";
import { HookCatalog } from "./hooks/catalog.js";
import { HOOK_ALL_EVENTS } from "./hooks/contracts.js";
import { CommandCatalog, invokeUserCommand } from "./extensibility/command-catalog.js";
import { PluginRegistry } from "./extensibility/plugin-registry.js";
import { createNativePeerToolPorts } from "./native-peer-tools.js";
import { InstallableIntegrationSdk, probeInstallableIntegrationHealth } from "./integration-sdk.js";
import { LocalIntegrationRegistry } from "./integration-local-registry.js";
import { SignedIntegrationMarketplace } from "./integration-marketplace.js";
import { REPRESENTATIVE_INTEGRATIONS, createRepresentativeIntegrationBundle, createRepresentativeIntegrationPackage } from "./representative-integrations.js";
import { formatOperatorDoctor, inspectHarnessIntegrationEnvironment, inspectOperatorEnvironment, type HarnessIntegrationDoctorReport } from "./doctor.js";
import { applyMigration, buildUnifiedDoctor, formatUnifiedDoctor, inspectMigration, previewMigration, rollbackMigration } from "./operator-maintenance.js";
import { runFlightControlStress } from "./flight-control-stress.js";
import { formatSetupResult, setupProject } from "./setup.js";
import { buildPromptInputDebugDump } from "./prompt-input-debug.js";
import { enrollProject, formatProjectLifecycle, inspectProjectOverlay, repairProjectOverlay } from "./project-lifecycle.js";
import { evaluateProjectRegistry, formatProjectRegistryReport, formatRegisterOutcome, formatRegistryList, loadProjectRegistry, registerProject } from "./project-registry.js";
import { manageProjects, formatProjectManageReport } from "./project-manage.js";
import { defaultGateRemediation, isGateRefusalProjection, projectCapabilityRefusal, projectGateRecord, type GateRefusalProjection } from "./gate-refusal-projection.js";
import type { TaskComposerCommandBinding, TaskComposerDraft } from "./task-composer-contracts.js";
import { GREENFIELD_DEFAULT_TIER } from "./task-composer.js";
import { composeArbiterIntakePort } from "./native-arbiter-transport.js";
import { amplifySiblingSites, assessAmplifierApplicability, createNativeTestAmplifierPort } from "./test-amplifier.js";
import { probeMutations } from "./mutation-probe.js";
import { resolveLearnedForkThresholdMs } from "@arbor/opencode";
import { checkGenericTargetSafety } from "./target-isolation-guard.js";
import { AcpIdeJourney, createAcpIdeRuntimePort } from "./acp-ide.js";
import { runAcpIdeStdio } from "./acp-ide-stdio.js";
import { SafeStartupController } from "./safe-startup.js";
import { RepoFlightDirector, createRepoFlightOperatorClient, repoFlightDirectorPaths } from "./repo-flight-director.js";
import { createRepoFlightTransportNativeHook, type RepoFlightTransportNativeHookOptions } from "./repo-flight-native-transport-hook.js";
import { createRepoFlightTransportProviderHook, type RepoFlightTransportProviderHookOptions } from "./repo-flight-provider-transport-hook.js";
import type { RepoFlightProviderLifecycleHook } from "./integrations/repo-flight-provider-hook.js";
import type { RepoFlightNativeLifecycleHook } from "./integrations/repo-flight-native-hook.js";
import type { RepoFlightProfileProvider } from "./repo-flight-profile.js";
import { probeRepoFlightHostProcess } from "./repo-flight-process.js";
import { repoFlightOpenCodeEnrollmentBarrierAvailable } from "./opencode-executor.js";
import { repoFlightRepositoryId } from "./repo-flight-contracts.js";
import { probeRepoFlightGitCandidate } from "./repo-flight-git.js";
import { repoSessionAssertWindowCommand, repoSessionLifecycleCommand, repoSessionReconcileCommand } from "./repo-session-close.js";
import { repoFlightGovernanceFromEnvironment } from "./repo-flight-governance-adapter.js";

/**
 * ADR-069 (X-2): the current worktree diff's new-side changed lines as
 * mutation-candidate sites. Fixed harness-owned git query (no model input in
 * the argv); best-effort — any failure yields no sites and the probe simply
 * has less to chew on.
 */
function diffChangedLines(worktreePath: string): { file: string; line: number }[] {
  try {
    const result = spawnSync("git", ["-C", worktreePath, "diff", "--unified=0"], { encoding: "utf-8", timeout: 10_000 });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    const sites: { file: string; line: number }[] = [];
    let file: string | null = null;
    for (const line of result.stdout.split("\n")) {
      if (sites.length >= 40) break;
      const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
      if (fileMatch) { file = fileMatch[1] ?? null; continue; }
      const hunkMatch = /^@@ [^+]*\+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunkMatch && file !== null) {
        const start = Number(hunkMatch[1]);
        const span = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
        for (let offset = 0; offset < span && sites.length < 40; offset++) sites.push({ file, line: start + offset });
      }
    }
    return sites;
  } catch {
    return [];
  }
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
const INTERRUPT_ACK_TIMEOUT_MS = 5_000;

// ============================================================
// model_capabilities — a real live provider-capability query (A-7).
//
// Twice previously deferred (commit 8decd93) because no live provider
// capability query existed anywhere in this repo. One now does:
// `opencode serve`'s `GET /provider` endpoint — verified live 2026-08-04
// against opencode 1.18.10 (`opencode serve` + `curl .../provider`). It
// returns, per connected provider, every model's
// `limit: {context, output}` — real provider-advertised context/output
// token ceilings, keyed by `providerID/modelID`, exactly the shape
// `ProviderModelCapabilityPort.maxOutputTokens` needs. Confirmed against a
// live response (zhipuai's glm-5.2: `{"limit":{"context":1000000,
// "output":131072}}`).
// ============================================================

/** The slice of `GET /provider`'s response this adapter reads. */
interface OpenCodeProviderListResult {
  all?: ReadonlyArray<{
    id?: string;
    models?: Record<string, { limit?: { context?: number; output?: number } } | undefined>;
  }>;
}

interface CapabilityServerHandle {
  baseUrl: string;
  close(): void;
}

/**
 * Spawn a short-lived `opencode serve` process purely to query `/provider`.
 * Mirrors `opencode-server-executor.ts`'s spawn/HTTP pattern (platform
 * `fetch` + `spawn`, no new runtime dependency) — duplicated rather than
 * imported because production campaign dispatch is subprocess-based
 * (`opencode-executor.ts`) and never runs a `serve` process itself, so
 * there is no already-running server this adapter could instead piggyback
 * on, and that file is outside this lane's ownership.
 */
function spawnCapabilityServer(opencodeBin: string, timeoutMs: number): Promise<CapabilityServerHandle> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(opencodeBin, ["serve", "--hostname=127.0.0.1", "--port=0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    // Third `opencode` spawn site in this package, and it leaked like the other
    // two: a capability probe that outlives its parent becomes a PPID-1 orphan
    // holding ~300-700MB. The registry reaps on exit and on SIGINT/SIGTERM;
    // the local timeout/settle path below still owns the normal case.
    trackChild(child);
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`opencode serve did not report listening within ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (d: Buffer): void => {
      if (settled) return;
      output += String(d);
      const match = output.match(/opencode server listening on\s+(https?:\/\/\S+)/);
      if (match) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          baseUrl: match[1]!,
          close: () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } },
        });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (d) => { output += String(d); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`opencode serve spawn failed: ${e.message}`));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`opencode serve exited ${code} before it reported listening`));
    });
    // Best-effort: don't leak a long-lived opencode process past our own exit.
    process.once("exit", () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  });
}

/**
 * Pure parse of `GET /provider`'s response body into a
 * `"providerID/modelID" -> { context, output }` map. Split out from
 * `OpenCodeProviderCapabilityAdapter.refresh` so the real wire-shape
 * handling (missing `id`, missing `limit`, non-finite/zero `output`) is
 * directly testable without spawning any process or opening a socket.
 */
export function parseProviderCapabilities(body: OpenCodeProviderListResult): Map<string, { readonly context: number | null; readonly output: number | null }> {
  const out = new Map<string, { readonly context: number | null; readonly output: number | null }>();
  for (const provider of body.all ?? []) {
    if (!provider.id) continue;
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const context = model?.limit?.context;
      const output = model?.limit?.output;
      const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
      if (valid(context) || valid(output)) out.set(`${provider.id}/${modelId}`, { context: valid(context) ? context : null, output: valid(output) ? output : null });
    }
  }
  return out;
}

/**
 * Real `ProviderModelCapabilityPort` backed by `opencode serve`'s
 * `GET /provider`. `maxOutputTokens` is synchronous by contract
 * (`loop-adapters.ts`); the real data source is a live HTTP call, so this
 * warms an in-memory cache lazily — on the first cache-miss lookup for a
 * *named* model, it kicks off a best-effort background `refresh()` (never
 * blocking the caller, never throwing) and answers `null` for that call,
 * same as "no estimate available" always has. A later call for the same
 * model, once the warm completes, gets the live value.
 *
 * `maxOutputTokens({model: undefined})` always answers `null` without ever
 * spawning anything — the current sole caller,
 * `@arbor/opencode`'s `modelCapabilityTokenBridge`, never passes a model id
 * (a gap in a file outside this lane's ownership; see
 * `runtime.ts`'s `model_capabilities` doc comment), so this adapter is
 * fully real and tested but, honestly, dark in production until that
 * caller is fixed. It activates immediately and correctly for any caller
 * that does pass a real `providerID/modelID`.
 *
 * `options.baseUrl`/`options.fetchImpl` are test hooks — same pattern
 * `opencode-server-executor.ts` already uses — letting a test point this at
 * a fake HTTP server instead of spawning a real `opencode` binary.
 */
export class OpenCodeProviderCapabilityAdapter implements ProviderModelCapabilityPort {
  private readonly cache = new Map<string, { readonly context: number | null; readonly output: number | null }>();
  private warming: Promise<void> | null = null;
  private readonly opencodeBin: string;
  private readonly timeoutMs: number;
  private readonly baseUrl?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { opencodeBin?: string; timeoutMs?: number; baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.opencodeBin = options.opencodeBin ?? "opencode";
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Best-effort warm. Never throws; a failed refresh just leaves the cache as-is (honest absence). */
  async refresh(): Promise<boolean> {
    let server: CapabilityServerHandle | undefined;
    try {
      const baseUrl = this.baseUrl ?? (server = await spawnCapabilityServer(this.opencodeBin, this.timeoutMs)).baseUrl;
      const res = await this.fetchImpl(`${baseUrl}/provider`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return false;
      const body = (await res.json()) as OpenCodeProviderListResult;
      for (const [key, value] of parseProviderCapabilities(body)) this.cache.set(key, value);
      return true;
    } catch {
      return false;
    } finally {
      server?.close();
    }
  }

  maxOutputTokens(input: { model?: string }): { value: number; source: "runtime" | "snapshot" } | null {
    if (!input.model) return null;
    const value = this.cache.get(input.model);
    if (value?.output !== null && value?.output !== undefined) return { value: value.output, source: "runtime" };
    if (!this.warming) {
      this.warming = this.refresh().then(() => { this.warming = null; }, () => { this.warming = null; });
    }
    return null;
  }

  contextCapacity(input: { model?: string }): { value: number; source: "runtime" | "snapshot" } | null {
    if (!input.model) return null;
    const value = this.cache.get(input.model);
    if (value?.context !== null && value?.context !== undefined) return { value: value.context, source: "runtime" };
    if (!this.warming) this.warming = this.refresh().then(() => { this.warming = null; }, () => { this.warming = null; });
    return null;
  }
}

/**
 * The real-world event that made a shutdown gate fire. Threaded all the way
 * into the durable interruption record (`reason`/`operation_id`) so an
 * operator reading that record later learns what actually happened — an OS
 * signal, or a client hanging up its stdio pipe (S03: before `serve` also
 * triggered this gate on bare EOF, `"signal"` was the only door and the
 * hardcoded `cli_sigint_shutdown` reason was always true; it would otherwise
 * silently misreport a client disconnect as a SIGINT that never happened).
 */
export type ShutdownCause = "signal" | "client_disconnect";

/** Bridges OS signals to the runtime interruption system before shutdown. */
export class ShutdownGate {
  readonly signal: Promise<void>;
  private runtime: ArborRuntime | null = null;
  private _resolve!: () => void;
  private triggered = false;
  private cause: ShutdownCause = "signal";
  private readonly ackTimeoutMs: number;

  /** `ackTimeoutMs` defaults to the real production value; overridable so tests can prove the full round-trip without a slow wall-clock wait. */
  constructor(ackTimeoutMs: number = INTERRUPT_ACK_TIMEOUT_MS) {
    this.signal = new Promise<void>((resolve) => { this._resolve = resolve; });
    this.ackTimeoutMs = ackTimeoutMs;
  }

  /** Called by main() once the runtime is composed. If a signal arrived first, interrupts immediately. */
  bind(runtime: ArborRuntime): void {
    this.runtime = runtime;
    if (this.triggered) void this.execute();
  }

  /**
   * Called by OS signal handlers and by a transport's own owned-cleanup
   * door (e.g. `serve` on stdin EOF). Non-blocking; the signal promise races
   * with normal shutdown. `cause` defaults to `"signal"` — every existing OS
   * signal call site is unchanged — and is recorded verbatim (not inferred)
   * the first time `trigger()` actually wins; a later call, from either
   * door, is a no-op per the `triggered` guard.
   */
  trigger(cause: ShutdownCause = "signal"): void {
    if (this.triggered) return;
    this.triggered = true;
    this.cause = cause;
    if (this.runtime) void this.execute();
    else this._resolve(); // runtime not yet bound — let its shutdown clean up
  }

  private async execute(): Promise<void> {
    const rt = this.runtime!;
    const doorTag = this.cause === "signal" ? "sigint" : "client-disconnect";
    const reason = this.cause === "signal" ? "cli_sigint_shutdown" : "cli_client_disconnect_shutdown";
    let requestedInterrupt = false;
    try {
      const campaigns = rt.manager.listCampaigns().filter((c) => !c.halted);
      for (const cam of campaigns) {
        const snap = rt.manager.getCampaignSnapshot(cam.id);
        if (!snap) continue;
        const interruptibleNodes = snap.nodes.filter(
          (n) => n.state === "expanding" || n.state === "pending",
        );
        for (const node of interruptibleNodes) {
          try {
            rt.interrupt({
              campaign_id: cam.id, node_id: node.id,
              operation_id: `cli-${doorTag}-shutdown-${cam.id}-${node.id}`,
              scope: "subtree", reason,
              expected_version: rt.manager.getCampaignVersion(cam.id),
              provenance: { tag: "generated", generator: "arbor-cli", input_hash: `cli-${doorTag}-shutdown` },
            });
            requestedInterrupt = true;
          } catch { /* best-effort per-node */ }
        }
      }
    } catch { /* best-effort; proceed to shutdown regardless */ }
    // Bounded ack: give supervisor a window to cancel tasks before we tear down
    if (requestedInterrupt) await new Promise<void>((resolve) => setTimeout(resolve, this.ackTimeoutMs));
    this._resolve();
  }
}

/** Re-exported from `persistence-path.js` so the dynamic import in `scheduler-command.ts` and the
 *  sinks that must write inside the root share ONE definition of the containment guard. */
export { resolvePersistenceDir };

/**
 * Structural diff of `candidate` against `base`, keeping only the paths that
 * differ. `loadConfigWithProvenance()`'s `file_only` already returns the
 * fully deep-merged defaults+file config, so it cannot itself tell a
 * file-supplied value apart from an untouched default — this recovers that
 * distinction without re-parsing `arbor.jsonc` a second time (the loader
 * stays the single source of truth for reading/parsing the file; this only
 * diffs its already-loaded result against the known `DEFAULT_CONFIG`).
 */
function diffFromDefaults<T>(base: T, candidate: T): DeepPartial<T> | undefined {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return Object.is(base, candidate) ? undefined : (candidate as unknown as DeepPartial<T>);
  }
  if (base === null || typeof base !== "object") return candidate as unknown as DeepPartial<T>;
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    const diff = diffFromDefaults((base as Record<string, unknown>)[key], value);
    if (diff !== undefined) {
      out[key] = diff;
      changed = true;
    }
  }
  return changed ? (out as DeepPartial<T>) : undefined;
}

/**
 * Real `ConfigInspectionService` sources (A-6/A-7, extended by G-07/ADR-020)
 * composed from an already-loaded `file_only` config plus its separately
 * tracked env overlay. `defaults` is the in-code `DEFAULT_CONFIG`; `file` is
 * only the leaves that genuinely differ from it (via `diffFromDefaults`),
 * kept apart from `env` so `config.get` can distinguish a checked-in
 * `arbor.jsonc` value from an `ARBOR_CONFIG__*` operator override instead of
 * merging both into one anonymous "not the default" bucket.
 */
function buildConfigInspectionFromEffective(
  fileOnly: ArborConfig,
  envOverlay: DeepPartial<ArborConfig> | null,
  // ADR-110: the organization and user scopes are optional so the standalone
  // callers below keep working, but when the loader supplies them the
  // inspection must attribute each leaf to the scope that actually won.
  // Passing only `file` would report an organization-supplied value as
  // project-supplied, which is worse than reporting nothing — a governed
  // harness that misattributes a setting cannot audit it.
  scopes?: { readonly organizationOnly: ArborConfig; readonly userOnly: ArborConfig },
): ConfigInspectionService {
  const organization = scopes ? diffFromDefaults(DEFAULT_CONFIG, scopes.organizationOnly) ?? null : null;
  const user = scopes ? diffFromDefaults(scopes.organizationOnly, scopes.userOnly) ?? null : null;
  const base = scopes ? scopes.userOnly : DEFAULT_CONFIG;
  return new ConfigInspectionService({
    defaults: DEFAULT_CONFIG,
    organization,
    user,
    file: diffFromDefaults(base, fileOnly) ?? null,
    env: envOverlay,
  });
}

/**
 * `@arbor/config`'s `loadConfigWithProvenance` is the single loader (never
 * re-parse `arbor.jsonc` or re-derive env overrides a second way); this is a
 * thin cwd-based wrapper kept for standalone callers/tests.
 * `createCliRuntime` below loads config exactly once itself and reuses
 * `buildConfigInspectionFromEffective` directly so a single production
 * `createCliRuntime` call never re-reads the file twice.
 */
export function buildConfigInspection(cwd: string): ConfigInspectionService {
  const { file_only, organization_only, user_only, env_overlay, env_overrides } = loadConfigWithProvenance(cwd);
  return buildConfigInspectionFromEffective(
    file_only,
    env_overrides.length > 0 ? (env_overlay as DeepPartial<ArborConfig>) : null,
    { organizationOnly: organization_only, userOnly: user_only },
  );
}

/**
 * Q1: `arbor doctor` is documented as a read-only diagnostic, but it used to
 * call `createCliRuntime`, which constructs a full `new ArborRuntime(...)` —
 * and that constructor unconditionally `mkdirSync`s `<persistence_dir>/
 * token-epochs` and `<persistence_dir>/native-campaign-budget` (see
 * `TokenEpochService`'s and `NativeCampaignBudgetAuthority`'s own
 * constructors in this package), creating `.arbor/` in a target repo that
 * was never enrolled, purely from running a diagnostic.
 *
 * `doctor`'s entire runtime dependency is `nativeHarnessReadiness` — nothing
 * else it reads (`inspectOperatorEnvironment`, `inspectHarnessIntegrationEnvironment`)
 * touches the runtime at all. This composes exactly the
 * `NativeHarnessReadinessService` the doctor needs from the same read-only
 * sources `createCliRuntime` uses (`loadConfigWithProvenance`,
 * `buildConfigInspectionFromEffective`, `loadNativeProviderSecretOverlay`,
 * `createReferenceNativeModelAdapterRegistry` — all verified read-only: no
 * `mkdirSync`/`writeFileSync` in any of them) without ever constructing an
 * `ArborRuntime`, so the diagnostic genuinely writes nothing.
 */
export function createDoctorReadiness(cwd: string): NativeHarnessReadinessService {
  const { effective: config, file_only, env_overlay, env_overrides } = loadConfigWithProvenance(cwd);
  const configInspection = buildConfigInspectionFromEffective(file_only, env_overrides.length > 0 ? (env_overlay as DeepPartial<ArborConfig>) : null);
  const nativeCredentialSelection = config.native.auth_route === "claude_code_cli"
    ? resolveNativeCredentialOverlay({ credential_source: "api_key", provider_id: config.native.provider_id, adapter_id: config.native.adapter_id, base_url: config.native.base_url, env: {} })
    : config.native.auth_route === "openai_codex_cli" ? resolveOpenAICodexCliSelection(process.env)
    : resolveNativeCredentialOverlay({
      credential_source: config.native.credential_source, provider_id: config.native.provider_id,
      adapter_id: config.native.adapter_id, base_url: config.native.base_url, env: process.env,
    });
  const nativeAdapters = createReferenceNativeModelAdapterRegistry(fetch);
  return new NativeHarnessReadinessService({
    config, config_view: configInspection.inspect(), credential: nativeCredentialSelection.facts, adapters: nativeAdapters,
    ...(nativeCredentialSelection.boundary === undefined ? {} : { credential_boundary: nativeCredentialSelection.boundary }),
  });
}

/**
 * Q2: when a harness integration (opencode/claude-code) is configured and
 * ready, native config is an alternative execution path, not a blocking
 * requirement — but `buildNativeHarnessReadiness` (native-harness-readiness.ts,
 * outside this lane's file scope) has no idea a connector exists, so its
 * `missing_requirements` always reads as "you must configure native.*" even
 * when the campaign will genuinely run through the ready connector instead.
 * Reword only the native-prefixed entries, at the doctor call site, into the
 * honest "optional alternative" framing; every other entry (and the rest of
 * the projection) is passed through unchanged. Applies identically to the
 * `--json` `missing_requirements` field and the human `formatNativeHarnessReadiness`
 * text, since both are rendered from this same corrected projection.
 */
export function reflectHarnessIntegrationAlternative(
  projection: NativeHarnessReadinessProjection,
  integration: HarnessIntegrationDoctorReport,
): NativeHarnessReadinessProjection {
  const integrationReady = integration.executable_present && integration.authenticated !== false;
  if (!integrationReady || projection.missing_requirements.length === 0) return projection;
  const reworded = projection.missing_requirements.map((item) => item.code.startsWith("native_")
    ? Object.freeze({ code: item.code, action: `${item.action} Optional: native config is not required because campaign execution will use the configured "${integration.integration_id}" connector instead.` })
    : item);
  return Object.freeze({ ...projection, missing_requirements: Object.freeze(reworded) });
}

/**
 * Wave 1 Lane A (todo 1/5): the real `CampaignRunner` every CLI transport
 * (`serve`, `webui`, `tui`) wires in, so a `job.submit` with `job_kind:
 * CAMPAIGN_RUN_JOB_KIND` genuinely drives the tree-search loop with real
 * opencode agents — the same real subprocess executor `arbor run --executor
 * real --transport subprocess` already uses. Unlike `arbor run`'s own
 * demo-plan scaffolding (`demo.ts`'s `runOneCampaign`, unchanged by this),
 * the campaign here must already exist (via `campaign.start` + `tree.branch`)
 * — this runner only drives the loop, it never seeds a plan.
 *
 * The router/adapter pair is built lazily, on first `run()`, because
 * `campaign_runner` is itself an `ArborRuntime` constructor option — the
 * runtime instance is only available once `createCliRuntime` has finished
 * constructing it. This is a second `RuntimeCatalogRouter` *instance*, not a
 * second authority: it delegates to the exact same runtime, exactly the way
 * `server.ts`/`webui.ts`/`demo.ts` already each construct their own.
 */
/**
 * The campaign's admitted root action is the only durable, operator-supplied
 * statement of what its work is about before the loop begins. Derive the
 * capability request from that action rather than borrowing demo-plan skills
 * or enabling every capability indiscriminately. The tree's own UCT choice
 * remains authoritative if a candidate card disagrees.
 */
export function deriveProductionTaskSkills(runtime: ArborRuntime, campaignId: string): readonly string[] {
  const root = runtime.manager.getCampaignSnapshot(campaignId)?.nodes.find((node) => node.parent_id === null);
  if (!root) return [];
  return [...new Set([
    routeCategory(root.action_description),
    root.action_category,
    root.action_delegate,
  ].filter((skill) => skill.length > 0))];
}

/**
 * Derive task execution from the durable admitted tree shape. A single
 * depth-zero action needs no UCT choice. Multiple actions are conservatively
 * treated as required workflow steps: the durable campaign shape has no
 * alternatives/acceptance marker that would authorize first-result wins.
 */
export function deriveProductionExecutionStrategy(runtime: ArborRuntime, campaignId: string): CampaignExecutionStrategy {
  const snapshot = runtime.manager.getCampaignSnapshot(campaignId);
  if (!snapshot) return { kind: "tree_search" };
  const root = snapshot.nodes.find((node) => node.parent_id === null);
  const pending = snapshot.nodes.filter((node) => node.state === "pending");
  const decomposed = (root?.decomposition_depth ?? 0) > 0
    || pending.some((node) => (node.decomposition_depth ?? 0) > 0);
  if (decomposed) return { kind: "tree_search" };
  if (pending.length === 1) {
    // ADR-062: the `direct` governance tier waives critic review for this
    // single dispatch — every other tier (including a campaign with no
    // recorded `governance` decision at all, e.g. one admitted through a
    // path that predates ADR-062) keeps the ordinary critic gate, and the
    // `review` field is omitted entirely (identical shape to before ADR-062).
    return snapshot.governance?.tier === "direct"
      ? { kind: "direct_single_action", node_id: pending[0]!.id, review: "waived" }
      : { kind: "direct_single_action", node_id: pending[0]!.id };
  }
  return { kind: "tree_search" };
}

/**
 * Compose the one loop configuration used by supervised `campaign.run` jobs.
 * Exported so regression tests exercise the exact production values without
 * spawning a provider process. The caller must provide a reviewer runner:
 * production supplies the selected integration's reviewer; tests can supply a
 * deterministic critic while still running the real loop and manager.
 */
export function createProductionCampaignLoopConfig(
  runtime: ArborRuntime,
  campaignId: string,
  runReviewer: ReviewerRunner,
  agentConfig: ArborConfig["agents"] = {},
  decomposer?: DecomposerPort,
  acceptanceCommands?: readonly (readonly string[])[],
  modelIdentity?: TokenEconomyModelIdentity,
): CampaignLoopConfig {
  const scoreAdapter = new ManagerScoreContextAdapter(runtime.manager);
  const nodeRouting = new DifficultyRoutingPolicy(new DifficultyCalibrator(runtime.persistenceRoot ?? undefined));
  return {
    ...DEFAULT_LOOP_CONFIG,
    // Project-authored acceptance commands: named to the specialist, run by the harness (B1).
    ...(acceptanceCommands === undefined ? {} : { acceptance_commands: acceptanceCommands }),
    max_iterations: 80,
    specialist_cap: { tier: "specialist" },
    critic_cap: { tier: "critic" },
    score_ctx: (id: string) => scoreAdapter.score_ctx(id),
    branch_actions: () => null,
    execution_strategy: deriveProductionExecutionStrategy(runtime, campaignId),
    // ADR-062 bounded critic-block retry: one automatic re-dispatch, capped,
    // on every production campaign. See `CampaignLoopConfig.critic_retry`'s
    // own doc for exactly what this does and does not change.
    critic_retry: { max_retries: 1 },
    // A scope refusal is recoverable once with exact verifier feedback, but
    // consumes an independent cap so repeated unauthorized writes halt.
    scope_retry: { max_retries: 1 },
    // The campaign root, not a demo fixture, supplies this capability request.
    task_skills: deriveProductionTaskSkills(runtime, campaignId),
    node_routing: nodeRouting,
    // Phase 3.4: all production campaign jobs use independently-dispatched
    // panel critics; the supplied reviewer fails closed on provider errors.
    panel: new PanelOfCritics(),
    run_reviewer: runReviewer,
    // Wire the decomposer, same as selfhost.ts's real-executor path
    // (d7928bb). Without it, FAULT_MATRIX's timeout -> "decompose"
    // recovery is inert on the one other production CampaignLoopConfig
    // construction site: a timed-out node in a real `arbor tui`
    // interactive campaign just fails instead of getting split.
    ...(decomposer === undefined ? {} : { decomposer }),
    // Adopt-result: durably capture each node's worktree changes before the
    // worktree is removed, so a verified result can be adopted later
    // (`arbor adopt`). Only wired when the runtime is durable.
    ...(runtime.persistenceRoot === null ? {} : {
      result_capture: {
        capture: (input) => {
          const inherited = readCapturedComposition(runtime.persistenceRoot!, input.campaign_id, input.node_id)?.files ?? [];
          const declared = input.declared_write_paths === undefined ? undefined : [...new Set([...inherited, ...input.declared_write_paths])];
          // The real per-action fact (`task-composer.ts`'s
          // `classifyAndRepairMutatingActions`) wins when known — recorded on
          // the capture so an adopt-time scope refusal (WA-67) can name it,
          // never derived from anything a specialist/arbiter could write.
          // Absent (a scope constructed outside the task composer), falls
          // back to the same tier-based approximation `scopeIsAuthored`
          // (ADR-065, verification enforcement) uses for the same reason.
          const actionProvenance = runtime.manager.getNodeInfo(input.campaign_id, input.node_id)?.action.high_risk_tool_scope?.scope_provenance;
          const governanceTier = runtime.manager.getCampaignSnapshot(input.campaign_id)?.governance?.tier;
          const scopeProvenance: "authored" | "mined" = actionProvenance ?? (governanceTier === undefined || governanceTier === null || governanceTier === "governed" ? "authored" : "mined");
          const captured = captureWorktreeResult({ ...input, ...(declared === undefined ? {} : { declared_write_paths: declared, scope_provenance: scopeProvenance }), persistence_dir: runtime.persistenceRoot! });
          const provenance = input.verification_provenance;
          const command = input.verification_command_argv;
          if (captured?.verified === true && provenance?.tag === "verified" && provenance.exit === 0 && provenance.strength !== "outputs_check" && command !== undefined) {
            runtime.resultVerification.record({
              campaign_id: input.campaign_id,
              node_id: input.node_id,
              checks: [{ command: [...command], exit_status: provenance.exit, duration_ms: null, summary: `machine verification passed: ${provenance.cmd}`, provenance }],
              files: [...captured.files],
              diffstat: { additions: null, deletions: null, files_changed: captured.files.length },
              confidence: "verified",
              absence_reason: null,
              provenance,
              idempotency_key: `campaign-result-verification:${input.campaign_id}:${input.node_id}:${captured.patch_sha256}:${provenance.stdout_hash}`,
            });
          }
        },
      },
      workspace_composition: {
        compose: (input) => {
          const capturedNodeIds = new Set(listCapturedResults(runtime.persistenceRoot!, input.campaign_id).map((record) => record.node_id));
          const governed = runtime.manager.getCampaignSnapshot(input.campaign_id)?.governance?.tier === "governed";
          const emptySourceNodeIds = governed ? input.source_node_ids.filter((sourceNodeId) => {
            if (capturedNodeIds.has(sourceNodeId)) return false;
            const scope = runtime.manager.getNodeInfo(input.campaign_id, sourceNodeId)?.action.high_risk_tool_scope;
            return (scope?.write_paths.length ?? 0) === 0;
          }) : [];
          return composeCapturedResults({ ...input, persistence_dir: runtime.persistenceRoot!, empty_source_node_ids: emptySourceNodeIds });
        },
      },
    }),
    ...composeLoopConfigPorts(runtime, agentConfig, modelIdentity),
  };
}

/** Minimum governed behavior required before the native campaign adapter can receive work. */
/** @deprecated import the seam-owned name from harness-control-plane for new code. */
export const DEFAULT_NATIVE_CAMPAIGN_REQUIREMENTS = DEFAULT_DIRECT_NATIVE_CAMPAIGN_REQUIREMENTS;

/**
 * Structural composition seam for the reference harness. It remains local to
 * @arbor/mcp so @arbor/harness does not depend on the campaign-loop package.
 */
/** @deprecated use CampaignHarnessIntegration; retained as a source-compatible type alias. */
export type NativeCampaignLoopExecutorFactory = CampaignHarnessIntegration;

export interface ProductionCampaignRunnerOptions {
  /** Capability-admitted executable integrations; the runner owns no upstream implementation. */
  readonly integrations?: HarnessIntegrationRegistry<CampaignHarnessIntegration>;
  /** Capability request used before any integration is asked to construct an executor. */
  readonly requirements?: readonly CapabilityRequirement[];
  /**
   * The composition-root native choice. An explicit `native` configuration
   * that cannot be composed must fail closed, rather than quietly becoming a
   * different connector's run. `auto` and `fallback` remain ordinary
   * OpenCode fallback states.
   */
  readonly native_selection?: NativeHarnessExecutionReadiness;
  /** ADR-066 (Y-3): native provider config for the generated-oracle amplifier; omitted = no amplification. */
  readonly native_config?: Pick<ArborConfig, "native">;
  /**
   * Isolation-guard gap: `selfhost.ts`'s `runSelfhostCampaign` refuses a
   * forbidden branch/primary-checkout/worker-checkout target before it ever
   * constructs a worktree. This runner is the generic `arbor task`/
   * `arbor run` equivalent — its guard fires ONLY for the shared hazard,
   * a target that is the harness's own source checkout (see
   * `checkGenericTargetSafety`); ordinary repositories are never refused.
   * An operator who explicitly accepts the self-hosting risk sets this
   * true. Never true unless the CLI's `--allow-primary-checkout` flag was
   * given explicitly.
   */
  readonly allow_primary_checkout?: boolean;
  /** Test seam for `checkGenericTargetSafety`: overrides harness-source-checkout detection. */
  readonly isolation_guard?: { readonly harness_checkout?: string | null };
  /**
   * The composition root's admission of a deprecated (non-Canopy) lane, set
   * only when the operator opted in. Recorded in each campaign's ledger that
   * runs on a connector other than `revoy-native`.
   */
  readonly deprecated_harness_admission?: DeprecatedHarnessAdmission;
}

/** Selects and runs only capability-admitted integrations supplied by the composition root. */
export function createProductionCampaignRunner(
  runtimeBox: { current: ArborRuntime | null },
  cwd: string,
  agentConfig: ArborConfig["agents"],
  options: ProductionCampaignRunnerOptions = {},
): CampaignRunner {
  let adapter: RuntimePortAdapter | null = null;
  let worktrees: WorktreeManager | null = null;
  let targetSafetyChecked = false;
  return {
    async run(campaignId: string, signal: AbortSignal, onHeartbeat?: () => void): Promise<CampaignRunOutcome> {
      const runtime = runtimeBox.current;
      if (!runtime) throw new Error("campaign runner invoked before its runtime finished composing");
      // Isolation-guard gap: checked once, before the first `WorktreeManager`
      // this runner ever constructs is rooted at `cwd`. Scoped to the
      // SELF-HOSTING hazard only — a target that is the harness's own source
      // checkout — because refusing ordinary repos (the first wiring did, on
      // master/main and on any primary checkout) makes the daily-driver flow
      // impossible; caught by the native e2e suite the day it landed.
      if (!targetSafetyChecked) {
        targetSafetyChecked = true;
        if (options.allow_primary_checkout !== true) {
          const safety = checkGenericTargetSafety(cwd, options.isolation_guard?.harness_checkout === undefined ? {} : { harnessCheckout: options.isolation_guard.harness_checkout });
          if (!safety.ok) {
            throw new Error(`${safety.error.message}. Refusing to run this campaign directly against ${cwd} — it is the harness's own source checkout, the same recursion 'arbor selfhost' guards. Point arbor at a non-primary clone or a non-forbidden branch of it, or pass --allow-primary-checkout to accept this risk explicitly.`);
          }
        }
      }
      worktrees ??= new WorktreeManager({
        repoRoot: cwd,
        ...(runtime.persistenceRoot === null ? {} : { persistenceDir: runtime.persistenceRoot }),
        operationalPaths: runtime.persistenceRoot === null ? [] : [runtime.persistenceRoot],
      });
      if (!adapter) adapter = new RuntimePortAdapter(new RuntimeCatalogRouter(runtime), () => runtime.operations.list().length);
      const requirements = options.requirements ?? DEFAULT_NATIVE_CAMPAIGN_REQUIREMENTS;
      const selected = options.integrations?.select(requirements);
      if (selected === undefined || selected.kind !== "selected") {
        const nativeWhy = options.native_selection !== undefined && options.native_selection.kind !== "direct_native" ? `; the Canopy lane (revoy-native) is not ready (${options.native_selection.reason}) and there is no connector fallback — run \`arbor doctor\`` : "";
        throw new Error(`no healthy harness integration satisfies campaign requirements${selected?.kind === "unavailable" ? `: ${selected.reason}` : ""}${nativeWhy}`);
      }
      if (selected.connector.connector_id !== CANOPY_CONNECTOR_ID && options.deprecated_harness_admission !== undefined) {
        recordDeprecatedHarnessAdmission(runtime.manager, campaignId, options.deprecated_harness_admission);
      }
      const integrationInput = {
        runtime,
        campaign_id: campaignId,
        adapter,
        cwd,
        connector: selected.connector,
      } as const;
      const reviewer = selected.integration.createReviewer(integrationInput);
      const decomposer = selected.integration.createDecomposer?.(integrationInput);
      const loopConfig = loadConfig(cwd);
      const loopSelection = resolveNativeProviderSelection(loopConfig.native);
      const config = createProductionCampaignLoopConfig(
        runtime, campaignId, reviewer, agentConfig, decomposer,
        loopConfig.verification?.acceptance_commands,
        loopSelection.kind === "native" ? { provider_id: loopSelection.provider_id, model_id: loopSelection.model } : undefined,
      );
      // ADR-066 (Y-3): generated-oracle amplifier — inert unless
      // ARBOR_TEST_AMPLIFIER=native (amplifySiblingSites gates itself and
      // degrades silently on any transport failure). Findings are evidence
      // notes for the critic only.
      const nativeConfig = options.native_config;
      const testAmplifier = nativeConfig === undefined ? undefined : async (input: { worktree_path: string; flagged_sites: readonly { pattern: string; file: string; line: number }[]; campaign_id: string; node_id: string; signal: AbortSignal }) => {
        const contextRootOf = (worktreePath: string): string | undefined => {
          const worktreesIndex = worktreePath.lastIndexOf(`${sep}.worktrees${sep}`);
          return worktreesIndex > 0 ? worktreePath.slice(0, worktreesIndex) : undefined;
        };
        // Y-3 (BLINDSPOT-MANIFEST class 5): run_generated_test below is
        // fixed to `["node", "--test", testFilePath]` -- a Node/JS test
        // runner -- so this caller's amplifier IS JS-shaped, not
        // language-agnostic. Checking applicability here (mirroring
        // loop.ts's caller-side assessAnalyzerApplicability note) avoids
        // spending a model call and a process spawn generating and running
        // a Node test against a flagged site that structurally cannot be
        // JS (e.g. a `.py`-only diff), and reports why instead of silently
        // finding nothing. This guards ONLY the amplifier call below -- the
        // mutation probe further down has its own internal applicability
        // gate (assessMutationProbeApplicability, wired inside
        // probeMutations itself) and must still run on a non-JS diff.
        const applicability = assessAmplifierApplicability(input.flagged_sites);
        const findings: { note: string; generator?: "test_amplifier" | "mutation_probe" }[] = applicability.applicable
          ? (await amplifySiblingSites({
              worktree_path: input.worktree_path,
              flagged_sites: input.flagged_sites,
              signal: input.signal,
              model_port: createNativeTestAmplifierPort({ config: nativeConfig }),
              command_port: new SandboxedVerificationCommandPort(),
              // A model-generated test never gets host network: no operator
              // egress grant can name it, so it is pinned to denied.
              run_generated_test: (testFilePath) => {
                const contextRoot = contextRootOf(input.worktree_path);
                return { argv: ["node", "--test", testFilePath], network: "enforced_denied", timeout_ms: 60_000, ...(contextRoot === undefined ? {} : { context_root: contextRoot }) };
              },
            })).map((finding) => ({ note: finding.note, generator: "test_amplifier" as const }))
          : [{ note: `Generated-oracle amplifier: NOT APPLICABLE to this diff's flagged sites (${applicability.reason}) -- not analyzed, not evidence of correctness either way.`, generator: "test_amplifier" as const }];
        // ADR-069 (X-2): the mutation probe rides the same advisory channel.
        // The declared acceptance command comes from the node's own scope
        // (session id participates only in the derived scope_id hash, so a
        // fixed advisory identity is honest here); no declared command means
        // nothing to probe against.
        const declared = runtimeBox.current?.manager.deriveNativeHighRiskToolScope({ campaign_id: input.campaign_id, node_id: input.node_id, session_id: "advisory-probe", worktree_path: input.worktree_path })?.command_argv?.[0];
        if (declared !== undefined && declared.length > 0) {
          const probed = await probeMutations({
            worktree_path: input.worktree_path,
            diff_changed_lines: diffChangedLines(input.worktree_path),
            sibling_flagged_sites: input.flagged_sites.map((site) => ({ file: site.file, line: site.line })),
            command_port: new SandboxedVerificationCommandPort(),
            acceptance_command: (worktreePath) => {
              const contextRoot = contextRootOf(worktreePath);
              return { argv: [...declared] as [string, ...string[]], ...verifierNetworkFor(declared, loopConfig.verification?.network_egress), ...(contextRoot === undefined ? {} : { context_root: contextRoot }) };
            },
            // ADR-071 (PM-2): CoHarden-lite — a rigorous killer test per
            // survivor (fails on the mutant, passes on the real code),
            // evidence-only. Gated by ARBOR_MUTATION_HARDEN=on inside.
            harden_model_port: createNativeTestAmplifierPort({ config: nativeConfig }),
            run_killer_test: (testFilePath) => {
              const contextRoot = contextRootOf(input.worktree_path);
              return { argv: ["node", "--test", testFilePath], network: "enforced_denied", ...(contextRoot === undefined ? {} : { context_root: contextRoot }) };
            },
            signal: input.signal,
          });
          for (const finding of probed) {
            findings.push({ generator: "mutation_probe", note: `Mutation probe: mutant "${finding.mutant_description}" at ${finding.site.file}:${finding.site.line} SURVIVED the declared acceptance command — the tests cannot distinguish that behavior change, so the oracle is weak at this site.` });
          }
        }
        return findings;
      };
      const executor = selected.integration.createExecutor(integrationInput);
      // ADR-069 (X-1): learned fork threshold from this persistence dir's own
      // ledger history; provenance rides the race telemetry.
      const forkThreshold = runtime.persistenceRoot === null ? undefined : (taskCategory: string) => {
        const learned = resolveLearnedForkThresholdMs(runtime.persistenceRoot!, taskCategory, process.env);
        return { thresholdMs: learned.thresholdMs, source: learned.source, observations: learned.observations };
      };
      // ADR-071 (PM-1): none-tie arbitration through the fast native critic —
      // a single bounded comparison call; any failure or non-answer yields
      // null (attempt 1, unchanged). Composed only when the native critic
      // transport is opted in and ready.
      const tiePort = nativeConfig !== undefined && process.env[ARBOR_CRITIC_TRANSPORT_ENV]?.trim() === "native"
        ? createNativeCriticPort({ config: nativeConfig, cwd }) : undefined;
      const raceTieBreaker = tiePort === undefined || !tiePort.ready ? undefined
        : async (a: { output: string }, b: { output: string }, signal?: AbortSignal): Promise<"primary" | "fork" | null> => {
          try {
            const prompt = `Two independent attempts at the same coding task both completed but NEITHER passed machine verification. Choose the attempt more likely to be correct and complete.\n\nATTEMPT PRIMARY:\n${a.output.slice(0, 4_000)}\n\nATTEMPT FORK:\n${b.output.slice(0, 4_000)}\n\nReturn exactly one JSON object: {"choice": "primary"} or {"choice": "fork"}. No prose.`;
            const result = await tiePort.call(prompt, signal);
            if (!result.ok) return null;
            const start = result.text.indexOf("{"); const end = result.text.lastIndexOf("}");
            if (start < 0 || end <= start) return null;
            const parsed = JSON.parse(result.text.slice(start, end + 1)) as { choice?: unknown };
            return parsed.choice === "primary" || parsed.choice === "fork" ? parsed.choice : null;
          } catch { return null; }
        };
      if (onHeartbeat !== undefined) {
        const priorLog = executor.log;
        executor.log = (event) => {
          if (event.type === "dispatch_heartbeat") onHeartbeat();
          priorLog?.(event);
        };
      }
      const report = await runCampaign({ manager: runtime.manager, campaign_id: campaignId, executor, config: { ...config, ...(testAmplifier === undefined ? {} : { test_amplifier: testAmplifier }), ...(forkThreshold === undefined ? {} : { fork_threshold: forkThreshold }), ...(raceTieBreaker === undefined ? {} : { race_tie_breaker: raceTieBreaker }) }, worktrees, signal });
      return { halted: report.halted, halt_reason: report.halt_reason, cancelled: report.cancelled, awaiting_user_input: report.awaiting_user_input };
    },
  };
}


/**
 * Take the single-writer lock (ADR-029) for a long-lived server's persistence
 * directory, or refuse to start.
 *
 * `serve`, `webui`, `remote-serve`, `remote-grant`, `task` (for the duration
 * of a write), and `demomain` (`arbor run`/`arbor demo`, exported for that
 * caller) all acquire it: each is an entry point that holds a directory open
 * indefinitely or drives a campaign against it, and an audit proved two
 * writers on one directory is reachable. Short-lived read commands (`ledger
 * verify`, `governance`, `audit`) deliberately do not, so inspecting a
 * directory a server owns stays possible — the hazard is two WRITERS, not a
 * reader alongside a writer.
 */
export function takeWriterLock(
  dir: string,
  holder: string,
  stderr: { write(text: string): void },
): WriterLockHandle | null {
  const result = acquireWriterLock(dir, { holder });
  if (!result.ok) {
    // Actionable and specific (Q5/B4): name both the exact lock file and the
    // holder identity, not just a generic conflict message, so an operator
    // seeing this on stderr knows exactly what to inspect or kill.
    stderr.write(`arbor-mcp ${holder}: writer lock conflict at ${join(dir, WRITER_LOCK_FILENAME)} — ${result.detail}\n`);
    return null;
  }
  if (result.reclaimed_stale) {
    stderr.write(`arbor-mcp ${holder}: reclaimed a stale writer lock from pid ${result.lock.record.pid}\n`);
  }
  return result.lock;
}

/**
 * Dependency-free machine-verification body run via `node -e ... <paths>`:
 * exits 0 only if every declared output path exists, is a regular file, and is
 * non-empty in the worktree; exits 1 otherwise. This is the generalist default
 * verification — it proves the node produced what its plan declared without
 * needing the worktree's dependencies installed.
 */
const DECLARED_OUTPUTS_CHECK = 'const s=require("node:fs").statSync;for(const p of process.argv.slice(1)){try{const st=s(p);if(!st.isFile()||st.size===0)process.exit(1)}catch{process.exit(1)}}';

/**
 * Shared construction for the declared-outputs machine verifier: the manager
 * is the sole authority for a node's immutable write scope, and this
 * dependency-free `DECLARED_OUTPUTS_CHECK` body is the one generalist
 * verification command derived from it. Both the native executor and the
 * Claude Code connector path use this same construction so neither can drift
 * from the other's notion of what "verified" means.
 */
/**
 * Which acceptance commands verify a node: the plan's authored `command_argv`
 * when it declared one, else the project's configured
 * `verification.acceptance_commands` — operator-authored, so it carries
 * authored provenance on every tier. Returns null only when neither exists.
 */
/**
 * Stamp a session's scope with who stands behind it, and let the project's
 * acceptance commands join a mined one.
 *
 * The 2026-09-03 pilot: a reviewed-tier campaign's scope came from the
 * heuristic arbiter's blast radius (`write_paths: ["src/greeting.ts"]`), was
 * bound by the manager as a "governed-action-scope" because the action
 * carried it, and the host refused the test file the task asked for. The
 * generator cannot tell an arbiter's guess from a planner's declaration;
 * the campaign's governance tier can — exactly the structural rule the
 * verifier's `scopeIsAuthored` uses — so the tier stamps `authority` here.
 *
 * The project's `verification.acceptance_commands` are operator-authored
 * and are exactly what the specialist is asked to run before claiming
 * completion, so they join a mined scope's literal argv set. An authored
 * scope is returned with its authority stamped and nothing else changed:
 * widening a planner/operator declaration would be this composition
 * granting authority the plan withheld.
 *
 * `input.scope_provenance` is the same persisted, node-level fact
 * `task-composer.ts`'s `classifyAndRepairMutatingActions` stamps once and
 * `scopeIsAuthored`/`result_capture` (below, and in this file's
 * `createDeclaredOutputsVerifier`/result-capture wiring) already read —
 * this is a second, tier-derived source of the same fact for a different
 * enforcement boundary (session tool authority vs. write-path/adopt
 * enforcement). Prefer the persisted fact when the caller has one; fall
 * back to the tier heuristic only where genuinely none exists (root
 * actions, pre-composer campaigns).
 */
export function composeSessionScope(scope: NativeHighRiskToolScope | null, input: { readonly tier: string | null | undefined; readonly acceptance: readonly (readonly string[])[]; readonly scope_provenance?: "authored" | "mined" }): NativeHighRiskToolScope | null {
  if (scope === null) return null;
  const authority: "authored" | "mined" = input.scope_provenance ?? (input.tier === undefined || input.tier === null || input.tier === "governed" ? "authored" : "mined");
  const stamped = Object.freeze({ ...scope, authority });
  if (!isMinedHighRiskScope(stamped)) return stamped;
  const known = new Set(stamped.command_argv.map((argv) => JSON.stringify(argv)));
  const added = input.acceptance.filter((argv) => argv.length > 0 && !known.has(JSON.stringify(argv))).map((argv) => Object.freeze([...argv]));
  if (added.length === 0) return stamped;
  return Object.freeze({ ...stamped, command_argv: Object.freeze([...stamped.command_argv, ...added]) });
}

/**
 * Which acceptance command verifies a node (B1, EC-061).
 *
 * An AUTHORED plan declaration wins: that is a planner or operator speaking
 * with authority. A MINED declaration does NOT. The arbiter derives its blast
 * radius from task prose, and a task that merely *mentions* a command yields
 * argv shredded out of the sentence — observed on sonnet asked to "Run npm test
 * and make sure the whole suite passes":
 *
 *     ["npm","test","and","make","sure","the","whole","suite","passes"]
 *
 * npm ignores the trailing arguments, so that exits 0. Preferring it over the
 * operator's `verification.acceptance_commands` meant a meaningless command
 * produced a PASSING verification, upgraded to `command_executed` by
 * `opportunistic_command_for_node`. Only the LLM critic caught it. A model's
 * guess must never outrank the command the operator wrote down, so when the
 * declaration is mined the project's authored commands win.
 */
export function verificationCommandsFor(
  declared: readonly (readonly string[])[] | undefined,
  configured: readonly (readonly string[])[] | undefined,
  options: { readonly declared_authored?: boolean } = {},
): readonly (readonly string[])[] | null {
  const own = (declared ?? []).filter((argv) => argv.length > 0);
  const project = (configured ?? []).filter((argv) => argv.length > 0);
  if (options.declared_authored === false && project.length > 0) return project;
  if (own.length > 0) return own;
  return project.length > 0 ? project : null;
}

/**
 * The production machine verifier shared by every harness integration.
 * Every command it composes runs with no host network (`enforced_denied`)
 * unless its exact argv appears in the operator's `networkEgress` grants
 * (`verification.network_egress`); see `verifierNetworkFor`.
 */
export function createDeclaredOutputsVerifier(runtimeBox: { current: ArborRuntime | null }, configuredAcceptance: readonly (readonly string[])[] = [], networkEgress: readonly VerifierNetworkEgressGrant[] = []): WorktreeMachineVerifier {
  const scopeFor = (input: { campaign_id: string; node_id: string; session_id: string; worktree_path: string }) =>
    runtimeBox.current?.manager.deriveNativeHighRiskToolScope({ campaign_id: input.campaign_id, node_id: input.node_id, session_id: input.session_id, worktree_path: input.worktree_path });
  const compositionFor = (input: { campaign_id: string; node_id: string }) => {
    const persistence = runtimeBox.current?.persistenceRoot;
    return persistence === null || persistence === undefined ? null : readCapturedComposition(persistence, input.campaign_id, input.node_id);
  };
  // ab3 bench S7: authority provenance decides how much the declaration may
  // do. A governed campaign's scopes are AUTHORED (planner/operator) and get
  // teeth — the declared acceptance command runs as machine verification and
  // the write scope binds the worktree diff. A direct/reviewed campaign's
  // scope is HEURISTICALLY MINED from task text (ADR-062 intake); running or
  // enforcing a guess broke legitimate work live (T2's fix lives in lib/ but
  // the mined scope named only the test file), so mined declarations stay
  // advisory: outputs-check verification + critic review, exactly the
  // pre-upgrade posture.
  // The real per-action fact (`task-composer.ts`'s `classifyAndRepairMutatingActions`,
  // the one place that knows whether THIS action's scope arrived declared or
  // was mined) wins when it is known. Absent — a scope constructed outside
  // the task composer (root action, direct `admitCampaignPlan`, a
  // pre-existing persisted campaign) — falls back to the prior tier-based
  // approximation, never widening past what that approximation already
  // granted.
  const scopeIsAuthored = (campaignId: string, nodeId: string): boolean => {
    const provenance = runtimeBox.current?.manager.getNodeInfo(campaignId, nodeId)?.action.high_risk_tool_scope?.scope_provenance;
    if (provenance !== undefined) return provenance === "authored";
    const tier = runtimeBox.current?.manager.getCampaignSnapshot(campaignId)?.governance?.tier;
    return tier === undefined || tier === null || tier === "governed";
  };
  // A project-configured command is authored by the operator, not mined from
  // task text, so it gets teeth on every tier. The plan's own declaration
  // still wins when present.
  const projectAuthored = configuredAcceptance.filter((argv) => argv.length > 0);
  /**
   * Staged verification: an AUTHORED plan may declare MORE than one
   * acceptance command (`command_argv` is `readonly (readonly string[])[]`),
   * e.g. a build step and a test step. Both authoritative and opportunistic
   * verification retain the full sequence rather than only its first step.
   * Run all of them, in the declared order, fail-fast, each on its own
   * `WorktreeMachineVerifier` timeout budget: a single declared command
   * degrades to the bare (unstaged) shape, so
   * every existing single-command caller/test is unaffected.
   */
  const declaredCommandsFor = (input: { campaign_id: string; node_id: string; session_id: string; worktree_path: string }): WorktreeVerificationSpec | null => {
    const planDeclared = (scopeFor(input)?.command_argv ?? []).filter((argv) => argv.length > 0);
    const declaredCommands = verificationCommandsFor(planDeclared, projectAuthored, { declared_authored: scopeIsAuthored(input.campaign_id, input.node_id) }) ?? [];
    if (declaredCommands.length === 0) return null;
    const worktreesIndex = input.worktree_path.lastIndexOf(`${sep}.worktrees${sep}`);
    const contextRoot = worktreesIndex > 0 ? input.worktree_path.slice(0, worktreesIndex) : undefined;
    const dependencyRoots = contextRoot === undefined ? [] : resolveLinkedDependencyRoots(contextRoot);
    const toCommand = (argv: readonly string[]): WorktreeVerificationCommand =>
      ({ argv: [...argv] as [string, ...string[]], ...verifierNetworkFor(argv, networkEgress), timeout_ms: 300_000, check: { kind: "shell_command", breadth: "single" }, ...(contextRoot === undefined ? {} : { context_root: contextRoot }), ...(dependencyRoots.length === 0 ? {} : { dependency_roots: dependencyRoots }) });
    return declaredCommands.length === 1 ? toCommand(declaredCommands[0]) : { stages: declaredCommands.map(toCommand) };
  };
  return new WorktreeMachineVerifier({
    command_for_node: (input) => {
      const scope = scopeFor(input);
      // ab3 bench V1: when an AUTHORED plan declared a real acceptance
      // command, RUN IT — the bench's "verified" was silently the weaker
      // outputs-existence check while the declared `node --test …` never
      // executed, so an incomplete fix earned verified provenance. Every
      // declared command runs, in order, fail-fast, each on its own timeout
      // budget (see `declaredCommandsFor`) — no longer just the first.
      const declaredCommand = declaredCommandsFor(input);
      const planDeclaredOwn = (scope?.command_argv ?? []).some((argv) => argv.length > 0);
      // Authored either by the plan (governed tier) or by the project config (any tier).
      if (declaredCommand !== null && (scopeIsAuthored(input.campaign_id, input.node_id) || !planDeclaredOwn)) return declaredCommand;
      const paths = scope?.write_paths ?? [];
      if (paths.length === 0) return null;
      // `display` keeps the raw declared paths out of the verified provenance
      // (and thus the session projection); the argv still runs against them.
      // This checks only that declared outputs exist and are non-empty — it
      // never runs the plan's verification command, so its provenance must
      // carry the weaker strength.
      return { argv: [process.execPath, "-e", DECLARED_OUTPUTS_CHECK, ...paths], network: "enforced_denied", timeout_ms: 30_000, display: `declared-outputs-check (${paths.length} path${paths.length === 1 ? "" : "s"})`, strength: "outputs_check" };
    },
    // S8 follow-up: on a MINED (non-authored) scope the declared command is
    // tried opportunistically — a clean exit upgrades the evidence to
    // command_executed; any failure falls back to the outputs check above
    // rather than blocking work a guessed command cannot judge.
    opportunistic_command_for_node: (input) => scopeIsAuthored(input.campaign_id, input.node_id) ? null : declaredCommandsFor(input),
    // G-SCOPE (ab3 bench T6), graduated by Y-1: an AUTHORED write scope
    // binds the worktree diff — an out-of-scope write fails verification
    // instead of being silently accepted ("block"). A MINED scope now also
    // binds, but only in the "audit" tier: a mismatch never blocks, it is
    // instead carried on the verified/failed outcome for composition to
    // journal as a scope_observation record. The enforcement tag is derived
    // ONLY from scopeIsAuthored's structural code-path check — never from
    // task text or specialist output — so it cannot be laundered.
    write_scope_for_node: (input) => {
      const basePaths = [...new Set([...(compositionFor(input)?.files ?? []), ...(scopeFor(input)?.write_paths ?? [])])];
      if (basePaths.length === 0) return null;
      // ADR-070 (PM-3): a signed, unrevoked approved widening on this node's
      // lineage extends the declared scope, so a legitimately-approved path
      // does not re-flag on every descendant. Evidence stays decoupled —
      // observations still journal; only this enforcement input widens.
      const mgr = runtimeBox.current?.manager;
      const widened = new Set(basePaths);
      if (mgr) {
        try {
          for (const record of mgr.getScopeDecisions(input.campaign_id)) {
            if (record.decision.decision !== "approved_widening") continue;
            for (const path of record.decision.paths) {
              if (!widened.has(path) && mgr.hasApprovedWideningPrecedent(input.campaign_id, input.node_id, [path])) widened.add(path);
            }
          }
        } catch { /* widening is additive convenience; enforcement falls back to the base scope */ }
      }
      const paths = Array.from(widened);
      // ADR-066 escalation: a mined (audit-tier) scope hardens to block for
      // any path this lineage already had BLOCKED — repeat offense is not
      // re-litigated as advisory.
      const enforcement = scopeIsAuthored(input.campaign_id, input.node_id)
        || (runtimeBox.current?.manager.hasBlockedScopePrecedent(input.campaign_id, input.node_id, paths) ?? false)
        ? "block" as const : "audit" as const;
      return { paths, enforcement };
    },
    // ADR-066 lineage union: the scope check compares the declared scope
    // against the current diff UNIONED with the retry lineage's journaled
    // out-of-scope writes, so a change split across retry nodes cannot
    // evade per-node checks (wrapper-bypass, CAVA 2607.13716).
    lineage_paths_for_node: (input) => runtimeBox.current?.manager.deriveScopeLineagePaths(input.campaign_id, input.node_id) ?? [],
    protected_inherited_paths_for_node: (input) => {
      const composition = compositionFor(input);
      if (composition === null) return [];
      const own = new Set(scopeFor(input)?.write_paths ?? []);
      return composition.files.filter((path) => !own.has(path)).map((path) => ({ path, sha256: composition.baseline_hashes[path] ?? null }));
    },
  });
}


function nativeCapabilities(observedAt: string): readonly CapabilitySupport[] {
  return (["streaming", "interruption", "resumption", "ephemeral_sessions", "structured_output", "tool_policy", "approval_mediation", "usage_reporting"] as const).map((capability) => ({
    capability, grade: "native", evidence: { implementation_id: "revoy2-native-agent-executor", observed_at: observedAt, detail: "owned worker and repository host composition" },
  }));
}

/**
 * Convert an untrusted model request into a bounded, authority-neutral loop
 * signal.  This factory never writes the ledger and never supplies an answer:
 * `runCampaign` remains the sole RequestUserInput transition and derives
 * lead/delegated authority from the selected tree node.
 */
function nativeHumanHandoff(input: { readonly session_id: string; readonly agent: string; readonly request: { readonly request_id: string; readonly question: string } }) {
  return {
    kind: "handoff" as const,
    reason: "model requested governed human input",
    signal: {
      question: boundedNativeQuestion(input.request.question),
      options: [{ id: "provide-answer", text: "Provide an answer", is_other: true }],
      requester_role: input.agent,
      origin_session_id: input.session_id,
      // Session plus request identity makes restart/retry deduplication
      // durable without placing model text or an approver identity in it.
      idempotency_key: `native-human:${stableNativeHandoffHash(`${input.session_id}:${input.request.request_id}`)}`,
    },
  };
}

function boundedNativeQuestion(question: string): string {
  if (Buffer.byteLength(question, "utf8") <= USER_INPUT_MAX_QUESTION_BYTES) return question;
  return Buffer.from(question, "utf8").subarray(0, USER_INPUT_MAX_QUESTION_BYTES).toString("utf8").trimEnd();
}

function stableNativeHandoffHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16_777_619); }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Native executor composition is bound to the startup-assessed opaque overlay.
 * It must not re-read process.env at dispatch time: otherwise an auto-native
 * registry admission could silently drift into a fallback after readiness was
 * already projected to operators.
 */

/**
 * The child→parent bus edge derives only from the node's real `parent_id` in
 * the manager's durable tree — never from the model, never from connector
 * wiring (see `native-bus-thread-contracts.ts`). A root node (no parent) has
 * nobody to talk back to, so it gets no bus tools at all. Exported as its own
 * seam so a test can drive it against a real `ArborRuntime`/`CampaignManager`
 * without reconstructing all of `configuredNativeAgentExecutor`'s provider
 * composition.
 */
export function nativeBusThreadForSession(
  runtimeBox: { current: ArborRuntime | null },
  scope: { readonly campaign_id: string; readonly node_id: string; readonly session_id: string },
): { readonly router: NativeBusThreadRouter; readonly scope: NativeBusThreadScope } | null {
  const runtime = runtimeBox.current;
  if (!runtime) return null;
  let parentNodeId: string | null;
  try {
    parentNodeId = runtime.manager.getNodeInfo(scope.campaign_id, scope.node_id)?.parent_id ?? null;
  } catch {
    return null;
  }
  if (parentNodeId === null) return null;
  return {
    router: new RuntimeCatalogRouter(runtime),
    scope: {
      campaign_id: scope.campaign_id,
      parent_node_id: parentNodeId,
      child_node_id: scope.node_id,
      capability_tier: "specialist",
      provenance: { tag: "generated", generator: "cli/bus-thread-for-session-v1", input_hash: `campaign:${scope.campaign_id}:node:${scope.node_id}:parent:${parentNodeId}` },
    },
  };
}

/**
 * Composition-root wiring for `userinput.ask` (native-tool-host.ts):
 * hands the executor the same `RuntimeCatalogRouter` `nativeBusThreadForSession`
 * uses, so the `userinput.ask` tool dispatches the *already-existing*
 * ADR-019 `RequestUserInput` command exactly like `bus.thread.send` does for
 * its own command kind. Unlike a bus edge, every node — including the root —
 * may ask the operator a question, so there is no parent-lookup gate here.
 */
export function nativeUserInputForSession(
  runtimeBox: { current: ArborRuntime | null },
  _scope: { readonly campaign_id: string; readonly node_id: string; readonly session_id: string },
): { readonly router: NativeBusThreadRouter } | null {
  const runtime = runtimeBox.current;
  if (!runtime) return null;
  return { router: new RuntimeCatalogRouter(runtime) };
}

/** Trusted native-executor seam: provisions only manager-derived sibling grants. */
export function nativePeerToolsForSession(runtimeBox: { current: ArborRuntime | null }, scope: { readonly campaign_id: string; readonly node_id: string; readonly session_id: string }) {
  const runtime = runtimeBox.current; if (runtime === null) return Object.freeze([]);
  return createNativePeerToolPorts({ service: runtime.nativePeerChannels, scope: { ...scope, capability_tier: "specialist" }, provision_from_parent: true });
}

/**
 * decisions/ADR-PENDING-native-structured-scope-pre-authorization-and-auto-approve.md:
 * high-risk repository tools (`shell.execute`, `verification.run`)
 * a `direct`/`reviewed`-tier session is allowed to reach approval for, on
 * top of the base allow-list every tier shares. This is safe to widen
 * beyond `governed`'s posture ONLY because `native-tool-host.ts`'s
 * `preflight` (`NativeHarnessWorker` runs it before `approvals.decide` is
 * ever called — see `native-worker.ts`) has ALREADY refused any call whose
 * target falls outside the action's declared-or-mined `high_risk_tool_scope`
 * for every tier, unconditionally, before this function is ever consulted.
 * By the time an approval decision is needed, the scope check already ran:
 * the declared/mined scope IS this tier's pre-authorization, and the
 * independent critic (still dispatched at `reviewed`, per ADR-062) is the
 * post-review — a per-call human/system approval on top of both would be
 * redundant, not additional safety, which is exactly the blocker chain
 * this decision records. `governed` keeps today's narrower list
 * (file writes/patches and peer messaging only, never command execution)
 * because its own planner intentionally leaves many actions read-only by
 * omission and reserves stricter, explicitly-authored authority — the SAME
 * tier boundary `CampaignManager.deriveNativeHighRiskToolScope`'s mining
 * fallback already draws. `tier === null` (unknown session, e.g. a
 * review/critic dispatch, or a cache eviction) fails to the safer,
 * `governed`-equivalent list — never the wider one.
 */
export function nativeApprovalAllowedTools(tier: GovernanceTier | null, baseTools: readonly string[], organizationAllowedTools?: readonly string[]): readonly string[] {
  const tierTools = tier === "direct" || tier === "reviewed" ? [...baseTools, "shell.execute", "verification.run"] : [...baseTools];
  if (organizationAllowedTools === undefined) return tierTools;
  const floor = new Set(organizationAllowedTools);
  return tierTools.filter((tool) => floor.has(tool));
}

export function resolveCliWebSearchProvider(config: ArborConfig, env: Readonly<Record<string, string | undefined>>): WebSearchProvider | undefined {
  const provider = config.native.web_search?.provider?.trim().toLowerCase();
  const endpoint = env.ARBOR_WEB_SEARCH_ENDPOINT?.trim();
  return provider === "searxng" && endpoint ? createSearxngWebSearchProvider({ endpoint_url: endpoint }) : undefined;
}

export function resolveCliBrowserProvider(env: Readonly<Record<string, string | undefined>>): BrowserAutomationProvider | undefined {
  const endpoint = env.ARBOR_NATIVE_BROWSER_ENDPOINT?.trim();
  return endpoint ? createHttpBrowserAutomationProvider({ endpoint_url: endpoint }) : undefined;
}

/** Native is preferred when an explicit provider is configured; otherwise the connector plugin remains the honest fallback. */
// ADR-142 §2: exported so `demo.ts` builds the native lane from the SAME
// builder rather than a hand-rolled equivalent. A second composition of the
// credential, hook bus, scope and budget boundary is a security difference,
// not a style one — which is exactly what `native-executor-composition.ts`'s
// header exists to prevent.
export function configuredNativeAgentExecutor(cwd: string, config: ArborConfig, runtimeBox: { current: ArborRuntime | null }, composition: NativeExecutorComposition, attachmentStore: TaskAttachmentStore | undefined, repoFlightNativeHook: RepoFlightNativeLifecycleHook | undefined, recoveryLeases: ReturnType<typeof createWorktreeRecoveryLeaseAuthority>): NativeAgentExecutor | null {
  const selection = resolveNativeProviderSelection(config.native);
  const closedProviderRoute = resolveClosedProviderRoute(config, selection);
  const execution = resolveNativeHarnessExecutionReadiness(config.native, composition.credential, composition.adapters, composition.credential_boundary);
  if (execution.kind === "connector_fallback") {
    if (closedProviderRoute !== null) throw new Error("closed provider routing requires a ready native harness; connector fallback is forbidden");
    return null;
  }
  if (execution.kind === "unavailable") throw new Error(`native executor was required but is unavailable: ${execution.reason}`);
  // The strict execution assessment above proves this narrowed config-only
  // selection is native, adapter-backed, and has an opaque credential source.
  if (selection.kind !== "native") throw new Error("native readiness disagreed with provider selection");
  const credentialMechanism = composition.credential.mechanism;
  const credentialBroker = config.native.auth_route === "claude_code_cli" || config.native.auth_route === "openai_codex_cli" ? undefined : composition.credential.inject((secret) => new ScopedNativeCredentialBroker({
    provider_id: selection.provider_id, account_id: "default", read_secret: () => secret,
    credential_available: () => composition.credential.inject(() => true) === true,
    ...(config.native.credential_lease_ttl_ms === undefined ? {} : { lease_ttl_ms: config.native.credential_lease_ttl_ms }),
  }));
  const observedAt = new Date().toISOString();
  // Adapter selection is reference-harness-owned and independent from the
  // provider/account string. This registry has neither discovery nor secret
  // access; an unsupported selection remains a typed unavailable state.
  const configuredBudget = config.native.usage_budget;
  // Per-request completion limit: the estimator's output bound and the
  // `max_tokens` sent to the provider. Omitted, it is 8,000, low enough that
  // the token budget rather than the response byte limit ends a long turn.
  const estimateMaxOutputTokens = configuredBudget?.estimate_max_output_tokens ?? DEFAULT_NATIVE_ESTIMATE_MAX_OUTPUT_TOKENS;
  const configuredPricing = config.native.pricing;
  const usageBudget = configuredBudget === undefined && configuredPricing === undefined ? undefined : {
    limits: {
      ...(configuredBudget?.max_session_input_tokens === undefined ? {} : { max_input_tokens: configuredBudget.max_session_input_tokens }),
      ...(configuredBudget?.max_session_output_tokens === undefined ? {} : { max_output_tokens: configuredBudget.max_session_output_tokens }),
      ...(configuredBudget?.max_session_cache_read_tokens === undefined ? {} : { max_cache_read_tokens: configuredBudget.max_session_cache_read_tokens }),
      ...(configuredBudget?.max_session_cache_write_tokens === undefined ? {} : { max_cache_write_tokens: configuredBudget.max_session_cache_write_tokens }),
      ...(configuredBudget?.max_session_total_tokens === undefined ? {} : { max_total_tokens: configuredBudget.max_session_total_tokens }),
      ...(configuredBudget?.max_session_cost === undefined ? {} : { max_cost: configuredBudget.max_session_cost }),
    },
    ...(configuredBudget === undefined ? {} : { token_estimator: new NativeUtf8UpperBoundTokenEstimator({ authority: configuredBudget.estimate_authority, max_input_tokens: configuredBudget.estimate_max_input_tokens, max_output_tokens: estimateMaxOutputTokens }) }),
    ...(configuredPricing === undefined ? {} : { pricing: new StaticNativeModelPricingAuthority(configuredPricing) }),
  };
  const campaignBudget = runtimeBox.current?.nativeCampaignBudget === undefined || configuredBudget === undefined || (configuredBudget.max_campaign_tokens === undefined && configuredBudget.max_campaign_cost === undefined)
    ? undefined
    : {
      authority: runtimeBox.current.nativeCampaignBudget,
      config: {
        ...(configuredBudget.max_campaign_tokens === undefined ? {} : { max_tokens: configuredBudget.max_campaign_tokens }),
        ...(configuredBudget.max_campaign_cost === undefined || configuredPricing === undefined ? {} : { max_cost: { ...configuredBudget.max_campaign_cost, kind: "priced" as const, price_source_id: configuredPricing.price_source_id } }),
        provenance: { tag: "generated" as const, generator: "native-campaign-budget-config", input_hash: stableNativeHandoffHash(JSON.stringify({ provider: selection.provider_id, model: selection.model, budget: configuredBudget })) },
      },
      max_input_tokens: configuredBudget.estimate_max_input_tokens,
      max_output_tokens: estimateMaxOutputTokens,
      token_estimator: new NativeUtf8UpperBoundTokenEstimator({ authority: configuredBudget.estimate_authority, max_input_tokens: configuredBudget.estimate_max_input_tokens, max_output_tokens: estimateMaxOutputTokens }),
      ...(configuredPricing === undefined ? {} : { pricing: new StaticNativeModelPricingAuthority(configuredPricing) }),
    };
  // Deny-by-default admission for `web.fetch`/`web.search`, the same shape
  // `config.native.capabilities?.image_input` already uses to gate a
  // capability at this composition root rather than exposing an always-on
  // tool. Ports are only constructed (and therefore only ever reach a
  // session's candidate tool set) when explicitly granted.
  const webFetchGranted = config.native.capabilities?.web_fetch === true;
  const webSearchGranted = config.native.capabilities?.web_search === true;
  // Network/domain authority is intentionally not inferred from a provider
  // name or a capability bit. This deployment-only env projection is a
  // conservative bridge until the configuration contract grows an audited
  // domain-policy leaf: no value means no composed egress port.
  const deploymentDomains = (composition.environment.ARBOR_NATIVE_WEB_ALLOWED_DOMAINS ?? "").split(",").map((item) => item.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  const organizationDomains = composition.organization_policy?.network.allowed_domains;
  if (organizationDomains !== undefined && deploymentDomains.some((domain) => !organizationDomains.includes(domain))) {
    throw new Error("ARBOR_NATIVE_WEB_ALLOWED_DOMAINS attempts to widen the organization network policy");
  }
  const webDomains = deploymentDomains.length > 0 ? deploymentDomains : [...(organizationDomains ?? [])];
  const webPolicy: GovernedNetworkPolicy = Object.freeze({ allowed_domains: Object.freeze(webDomains), authorize: (request: Parameters<NonNullable<GovernedNetworkPolicy["authorize"]>>[0]) => request.network_allowed });
  const webSearchProvider = resolveCliWebSearchProvider(config, composition.environment);
  const webTools = createNativeWebToolPorts({
    ...(webFetchGranted && webDomains.length > 0 ? { fetch: { policy: webPolicy } } : {}),
    ...(webSearchGranted && webDomains.length > 0 ? { search: { provider: webSearchProvider, policy: webPolicy } } : {}),
  });
  const browserProvider = resolveCliBrowserProvider(composition.environment);
  const browserGranted = composition.environment.ARBOR_NATIVE_BROWSER === "1";
  const browserTools = browserGranted && webDomains.length > 0
    ? createNativeBrowserToolPorts({ policy: webPolicy, ...(browserProvider ? { provider: browserProvider } : {}) })
    : Object.freeze([]);
  const toolSchemaManifests = new BoundedToolSchemaManifestCache<NativeModelAdapterToolDefinition>({ max_entries: 64, max_schemas_per_manifest: 128 });
  return new NativeAgentExecutor({
    workspace_root: cwd, capabilities: nativeCapabilities(observedAt),
    ...(repoFlightNativeHook === undefined ? {} : { repo_flight_native_hook: repoFlightNativeHook }),
    hook_bus: composition.hook_bus,
    governed_artifacts_for_campaign: (scope) => {
      if (attachmentStore === undefined) throw new Error("native campaign attachment store is unavailable");
      return attachmentStore.resolveCampaign(scope.campaign_id);
    },
    governed_artifacts_allowed: true,
    // Mirrors the exact fact `model_for_role` below reads to decide whether
    // to compose `image_input` on the adapter: the model-callable
    // `image.attach`/`image.list` tools (native-tool-host.ts) are absent
    // whenever this provider was not explicitly granted image capability.
    image_attach_allowed: config.native.capabilities?.image_input === true,
    // Same underlying content-addressed store as `governed_artifacts_for_campaign`
    // above (never a second store) — a distinct resolution point because
    // that resolver auto-delivers on every turn from dispatch, while this
    // one only ever reaches the model when `image.attach` is called.
    governed_image_catalog_for_campaign: (scope) => {
      if (attachmentStore === undefined) throw new Error("native campaign attachment store is unavailable");
      return attachmentStore.resolveCampaign(scope.campaign_id);
    },
    // `config.native.max_turns` is the single reviewable override point for
    // this ceiling (env-overridable as ARBOR_CONFIG__NATIVE__MAX_TURNS); see
    // `NATIVE_MAX_TURNS_DEFAULT`'s doc comment for why 24 is the floor.
    max_turns: config.native.max_turns ?? NATIVE_MAX_TURNS_DEFAULT,
    // The wall-clock ceiling is only ever raised, never lowered: a transport
    // whose per-turn latency is a process spawn needs more seconds for the
    // same turn count. Absent leaves the executor's own 600s default.
    ...(config.native.max_session_wall_clock_ms === undefined ? {} : { max_wall_clock_ms: config.native.max_session_wall_clock_ms }),
    model_for_role: ({ session_id, operation, agent, routing_tier, allow_tools, allow_human_input, allowed_tools = [], extension_tools = [], structured_schema, on_route_selected }) => {
      const routedAgent = operation === "specialize" && routing_tier === "economical" ? "seed" : operation === "specialize" && routing_tier === "capable" ? "heartwood" : agent;
      const identity = resolveNativeRoleModelIdentity(selection, config.agents, routedAgent);
      const admitted = new Set(allowed_tools);
      const eligibleTools = operation === "specialize" && allow_tools !== false ? (agent === "taproot" ? NATIVE_PLANNING_MODEL_TOOLS.filter((tool) => admitted.has(tool.name)) : [...NATIVE_REPOSITORY_MODEL_TOOLS, ...NATIVE_BUS_THREAD_MODEL_TOOLS, ...extension_tools].filter((tool) => admitted.has(tool.name))) : [];
      const schemaManifest = toolSchemaManifests.resolve({
        session_id,
        route: allow_tools === false ? "non_tool" : "tool_capable",
        revision: identity.revision ?? "unversioned",
        eligible_tool_names: eligibleTools.map((tool) => tool.name),
        load: (names) => {
          const eligible = new Set(names);
          return eligibleTools.filter((tool) => eligible.has(tool.name)).map((tool) => ({
            tool_name: tool.name,
            schema_id: `${identity.revision ?? "unversioned"}:${tool.name}`,
            schema: tool,
          }));
        },
      });
      const tools = schemaManifest.entries.map((entry) => entry.schema);
      // The production native path composes this single fixed reviewer
      // contract. It is not a caller-selected general schema surface.
      const structuredSchemas = operation === "review" ? [NATIVE_CRITIC_VERDICT_SCHEMA] : operation === "specialize" && agent === "taproot" ? [NATIVE_TASK_PLAN_SCHEMA] : structured_schema === undefined ? [] : [structured_schema];
      const request = {
      // This is a declared transport convention, not a host tool: it only
      // returns control to the governed campaign loop.
        tools,
        structured_schemas: structuredSchemas,
        ...(allow_tools === false || allow_human_input === false ? {} : { human_input_tool: { name: "request_human_input" } }),
        credential_required: credentialBroker !== undefined,
        credential_mechanism: credentialMechanism,
        ...(config.native.capabilities?.image_input === true ? { image_input: {} } : {}),
        ...(config.native.transport?.timeout_ms === undefined ? {} : { timeout_ms: config.native.transport.timeout_ms }),
        ...(config.native.transport?.max_response_bytes === undefined ? {} : { max_response_bytes: config.native.transport.max_response_bytes }),
        ...(configuredBudget === undefined ? {} : { max_output_tokens: estimateMaxOutputTokens }),
      };
      if (closedProviderRoute !== null) {
        return createClosedProviderRoutedModel({
          adapters: composition.adapters, cwd, observed_at: observedAt,
          selection: { tool_model_id: assertClosedProductionModel(identity.model_id, "tool_capable"), tool_revision: identity.revision, non_tool_model_id: closedProviderRoute.non_tool_model_id },
          tool_request: request,
          non_tool_structured_schemas: structuredSchemas,
          ...(on_route_selected === undefined ? {} : { on_route_selected }),
        });
      }
      const modelRequest = {
        ...request,
        adapter_id: selection.adapter_id, base_url: selection.base_url, provider_id: selection.provider_id,
        model_id: identity.model_id,
        ...(identity.revision === null ? {} : { revision: identity.revision }),
        observed_at: observedAt,
      };
      const primary = config.native.auth_route === "claude_code_cli"
        ? createClaudeCodeNativeModelPort({ request: modelRequest, cwd })
        : config.native.auth_route === "openai_codex_cli"
          ? createOpenAICodexNativeModelPort({ request: modelRequest, cwd, env: composition.environment })
          : composition.adapters.create(modelRequest);
      const fallback = config.native.openrouter_fallback;
      // Cost ceilings require a price authority for the actual alternate
      // model; never apply OpenRouter's price observation to the bridge.
      const costBound = configuredBudget?.max_session_cost !== undefined || configuredBudget?.max_campaign_cost !== undefined;
      return selection.provider_id.toLowerCase() === "openrouter" && fallback?.enabled === true && !costBound
        ? createOpenRouterBridgeFallback({ primary, request: modelRequest, cwd, model: fallback.model,
          ...(on_route_selected === undefined ? {} : { on_route_selected }) })
        : primary;
    },
    ...(credentialBroker === undefined ? {} : { model_credential_for_session: (scope: Parameters<ScopedNativeCredentialBroker["modelCredentialForSession"]>[0]): NativeCredentialLeasePort | undefined => credentialBroker.modelCredentialForSession(scope) }),
    // Context is a separate, bounded provenance surface. It receives no API
    // credential; worker/manager redaction protects retained model/tool text.
    // `config.native.context_compaction` (env-overridable as
    // ARBOR_CONFIG__NATIVE__CONTEXT_COMPACTION__{ENABLED,THRESHOLD_FRACTION})
    // carries only the trigger, never a summarizer — a real model-backed
    // summarizer stays a composition-owned seam, not a config value.
    context_for_session: () => createNativeSessionContext({
      ...(credentialBroker === undefined ? {} : { redactor: credentialBroker.context_redactor }),
      ...(config.native.context_compaction === undefined ? {} : { compaction: config.native.context_compaction }),
    }),
    retrieval_signals_for_session: (scope) => ({
      memory: runtimeBox.current?.manager.repositoryRetrievalMemory(scope.campaign_id, scope.node_id) ?? [],
    }),
    critic_structured_output: NATIVE_CRITIC_VERDICT_CONTRACT,
    task_planning_structured_output: NATIVE_TASK_PLAN_CONTRACT,
    // High-risk writes/commands derive only from the manager's persisted
    // campaign node. The executor deliberately ignores the model-facing
    // action parameter for this authority boundary.
    // A project's `verification.acceptance_commands` are operator-authored,
    // so a specialist may run them itself (the completion-evidence protocol
    // asks it to) — on a MINED scope they are appended to the literal argv
    // set; an authored (governed) declaration is never widened.
    high_risk_scope_for_session: (scope) => composeSessionScope(runtimeBox.current?.manager.deriveNativeHighRiskToolScope(scope) ?? null, {
      // Same persisted node-level fact `result_capture`'s `actionProvenance`
      // reads above; the tier heuristic below is only the fallback for a
      // node the task composer never stamped.
      scope_provenance: runtimeBox.current?.manager.getNodeInfo(scope.campaign_id, scope.node_id)?.action.high_risk_tool_scope?.scope_provenance,
      tier: runtimeBox.current?.manager.getCampaignSnapshot(scope.campaign_id)?.governance?.tier,
      acceptance: config.verification?.acceptance_commands ?? [],
    }),
    // S02: read only after `high_risk_scope_for_session` above has actually
    // called `deriveNativeHighRiskToolScope` for this exact session (the
    // executor only looks this up when that returned null) — the reason
    // cache is a side effect of that same call, keyed by session_id.
    high_risk_scope_denial_reason_for_session: (scope) => runtimeBox.current?.manager.getHighRiskScopeDenialReason(scope.session_id) ?? null,
    bus_thread_for_session: (scope) => nativeBusThreadForSession(runtimeBox, scope),
    user_input_for_session: (scope) => nativeUserInputForSession(runtimeBox, scope),
    specialist_tools: async (scope) => Object.freeze([
      ...nativePeerToolsForSession(runtimeBox, scope),
      ...(await Promise.all(composition.mcp_connectors.map((connector) => connector.toolPortsForSession(scope)))).flat(),
      ...webTools,
      ...browserTools,
    ]),
    skill_catalog: composition.skill_catalog,
    continuation_for_node: (scope) => {
      const runtime = runtimeBox.current;
      if (runtime === null) throw new Error("canonical continuation dispatch has no initialized runtime");
      const node = runtime.manager.getNodeInfo(scope.campaign_id, scope.node_id);
      const authorization = runtime.harnessSessions?.pendingContinuation(scope.campaign_id, scope.node_id) ?? null;
      // A durable retry transition or continuation intent puts a node back
      // into the ordinary tree's pending pool. It must not lose its recovery
      // authority merely because the authorization was cancelled/started, or
      // an old pending record cannot prove current dispatch authority.
      if (authorization === null) {
        const hasDurableRetry = node?.recovery_attempts.some((attempt) => attempt.action === "retry") ?? false;
        const hasContinuationIntent = (runtime.harnessSessions?.continuationIntentHistoryFor(scope.campaign_id, scope.node_id).length ?? 0) > 0;
        if (hasDurableRetry || hasContinuationIntent) {
          throw new Error("durable recovery node cannot run as ordinary work without a live continuation authorization");
        }
        return null;
      }
      if (node === null
        || authorization.campaign_id !== scope.campaign_id || authorization.node_id !== scope.node_id
        || authorization.new_session_id !== `continuation:${authorization.authorization_id}`) {
        throw new Error("continuation authorization is not bound to this canonical node dispatch");
      }
      const worktreeAdmission = authorization.admissions.filter((admission) => admission.kind === "worktree");
      if (worktreeAdmission.length !== 1 || worktreeAdmission[0]?.admitted !== true || !worktreeAdmission[0].evidence_id) {
        throw new Error("continuation authorization has no unique admitted worktree lease");
      }
      const taskKind = authorization.continuation_kind === "fork" ? "recovery.fork" : "recovery.retry";
      const recoveryTasks = runtime.supervisor.list({ scope_id: scope.campaign_id })
        .filter((task) => task.kind === taskKind && task.state === "accepted" && !runtime.supervisor.requiresReconciliation(task.id));
      const currentAdmissions = recoveryTasks.flatMap((task) => {
        const operationId = task.operation_id;
        if (!operationId || task.id !== `recovery:${operationId}`) return [];
        try {
          const isolation = recoveryLeases.checkIsolation({
            campaign_id: scope.campaign_id, node_id: scope.node_id, operation_id: operationId,
            lease_id: worktreeAdmission[0]!.evidence_id,
          });
          return isolation.worktree_isolated && isolation.starting_commit_correct ? [{ task, operationId }] : [];
        } catch {
          return [];
        }
      });
      if (currentAdmissions.length !== 1) {
        throw new Error("continuation authorization has no unique live accepted recovery task with a valid isolated worktree lease");
      }
      const { operationId } = currentAdmissions[0]!;
      if (authorization.continuation_kind !== "fork" && !node.recovery_attempts.some((attempt) => attempt.action === "retry" && attempt.operation_id === operationId)) {
        throw new Error("continuation authorization does not match the node's durable retry transition");
      }
      return authorization;
    },
    replay_for_continuation: (authorization) => runtimeBox.current?.harnessSessionReplay.admit({ kind: authorization.continuation_kind ?? "resume", source_session_id: authorization.source_session_id, new_session_id: authorization.new_session_id }) ?? null,
    record_recovery_operation(checkpoint) {
      const journal = runtimeBox.current?.harnessSessions;
      if (journal === null || journal === undefined || !journal.recordOperationCheckpoint(checkpoint)) throw new HarnessSessionDurabilityError("operation_checkpoint", "native operation checkpoint could not be durably recorded");
    },
    ...(usageBudget === undefined ? {} : { usage_budget: usageBudget }),
    ...(campaignBudget === undefined ? {} : { campaign_budget: campaignBudget }),
    // Accounting (metering/attribution) is default-on regardless of whether
    // an enforcement `usage_budget` is configured above; only an explicit
    // `false` here (config.native.usage_accounting_enabled) turns it off.
    ...(config.native.usage_accounting_enabled === undefined ? {} : { usage_accounting_enabled: config.native.usage_accounting_enabled }),
    human_input_for_session: {
      request: async (input) => nativeHumanHandoff(input),
    },
    approvals: {
      // Peer mutation tools are still absent unless a parent-created grant
      // yields a scoped port for this exact session. This policy merely lets
      // that already-bounded port execute rather than treating it as ambient
      // tool authority.
      //
      // `shell.execute`/`verification.run` join the allow-list ONLY
      // for the session's own governance tier when it is `direct`/`reviewed`
      // (see `nativeApprovalAllowedTools`'s doc for why widening here is
      // safe: `native-tool-host.ts`'s scope preflight already ran, unchanged,
      // for every tier before this decision is ever reached). The tier comes
      // from `CampaignManager.governanceTierForSession`, recorded as a side
      // effect of the SAME `deriveNativeHighRiskToolScope` call every
      // specialize session already makes before any tool dispatch; an
      // unknown session (`null`) fails to `governed`'s narrower list.
      decide: (request, signal) => {
        const tier = runtimeBox.current?.manager.governanceTierForSession(request.session_id) ?? null;
        const baseTools = ["file.write", "file.patch", "peer.query", "peer.reply", ...composition.mcp_connectors.flatMap((connector) => connector.systemApprovedToolNames())];
        const allowed_tools = nativeApprovalAllowedTools(tier, baseTools, composition.organization_policy?.native_approval.allowed_tools);
        const policy_id = tier === "direct" || tier === "reviewed" ? "configured-specialist-tools-reviewed-v1" : "configured-specialist-tools-v1";
        return new NativeSystemPolicyApprovalPort({ policy_id, allowed_tools }).decide(request, signal);
      },
    },
    // Verify the node produced its plan-declared outputs, per node. A static
    // whole-repo `bun run build` could never pass in a dependency-less
    // worktree (so every node stayed `claimed`) and is irrelevant to a
    // non-code task. This runs a dependency-free check that every declared
    // write path exists and is non-empty in the worktree — a real,
    // command-evidenced verification that fits any produce-artifacts task.
    // A node that declared no outputs has nothing to machine-verify here and
    // stays honestly `claimed`.
    specialist_verification: createDeclaredOutputsVerifier(runtimeBox, config.verification?.acceptance_commands, config.verification?.network_egress),
    repository_tools: {
      // No AMBIENT executables. Each specialist session's executable allowlist
      // is derived from its own high-risk scope by `NativeAgentExecutor`
      // (`nativeSessionCommandExecutables`): the plan's declared argv plus the
      // `verification.acceptance_commands` that `composeSessionScope` (above)
      // joins to a mined scope. Before that derivation existed, this empty
      // list refused every shell.execute/verification.run, including the
      // exact authorized acceptance command (2026-10-06 native cohort).
      allowed_commands: [],
      // Thread the operator's sandbox confinement level (config.sandbox.confinement,
      // default os_best_effort) into the broker the tool host builds — otherwise
      // the config leaf is dead and shell.execute always runs at the broker's own
      // default. `os_required` here makes an unattended campaign refuse to run a
      // command it cannot OS-confine, rather than run it unconfined.
      ...(config.sandbox?.confinement === undefined ? {} : { sandbox_confinement_level: config.sandbox.confinement }),
      // The tool host defaults to 64 KiB read/output bounds, sized for unit
      // tests, not real source files: `cli.ts` alone is ~90 KiB, so a
      // specialist cannot read the file it was asked to document and thrashes
      // on failed reads until its token budget dies. 128 KiB admits real files
      // while staying below the 256 KiB context budget so one read cannot fill
      // the whole context.
      max_read_bytes: 128 * 1024,
      max_output_bytes: 128 * 1024,
      max_command_output_bytes: 128 * 1024,
      on_audit(record) {
        composition.hook_bus.observeToolAudit(record);
        const journal = runtimeBox.current?.harnessSessions;
        if (journal === null || journal === undefined || !journal.recordToolAudit(record)) throw new HarnessSessionDurabilityError("tool_audit", "native tool audit could not be durably recorded");
      },
    },
    live_sessions: runtimeBox.current?.nativeSessionRegistry,
    // ADR-104 Decision 1/3 (O3/O4): forward each streamed text delta into
    // the same shared `nativeSessionRegistry` `live_sessions` above already
    // points at, the instant `observeStreamingDelta` yields it -- this is
    // the one seam the interactive path was missing (O3 wired the sink
    // itself; nothing composed it in production). Only `kind: "text"`
    // deltas populate the operator-facing preview: tool_call/usage/final/
    // human_input/thinking deltas are not "what the model is saying right
    // now" and do not belong in this buffer.
    on_model_delta(record) {
      if (record.delta.kind === "text") runtimeBox.current?.nativeSessionRegistry.pushDelta(record.session_id, record.delta.text);
    },
    on_session_started(record) {
      const journal = runtimeBox.current?.harnessSessions;
      if (journal !== null && journal !== undefined && !journal.recordStarted({
        session_id: record.inspection.session_id, campaign_id: record.campaign_id, node_id: record.node_id,
        operation: record.operation, connector_id: record.connector_id, execution_kind: record.execution_kind,
        profile_id: record.profile_id,
        state: record.inspection.state, latest_sequence: record.inspection.latest_sequence,
        lineage: record.inspection.lineage,
      })) throw new HarnessSessionDurabilityError("admission", "native session admission could not be durably recorded");
    },
    on_session_event(record) {
      const journal = runtimeBox.current?.harnessSessions;
      if (journal !== null && journal !== undefined && !journal.recordEvent(record.event)) throw new HarnessSessionDurabilityError("event", "native session event could not be durably recorded");
    },
    on_session_checkpoint(record) {
      const replay = runtimeBox.current?.harnessSessionReplay;
      if (replay === undefined || !replay.record({ campaign_id: record.campaign_id, node_id: record.node_id, operation: record.operation, checkpoint: record.checkpoint })) throw new Error("native session replay checkpoint could not be durably recorded");
    },
    on_session(record) {
      const journal = runtimeBox.current?.harnessSessions;
      if (journal !== null && journal !== undefined && !journal.record(record)) throw new HarnessSessionDurabilityError("completion", "native session completion could not be durably recorded");
      runtimeBox.current?.recordSessionCompletionUx({ session_id: record.inspection.session_id, campaign_id: record.campaign_id, node_id: record.node_id });
    },
  });
}

/**
 * A native selection's revision pin belongs only to its selected model. An
 * agent-level model override therefore deliberately becomes unpinned: copying
 * a fingerprint across model identities would create a false provider claim
 * and cause an unrelated response to fail closed later at the adapter.
 */
export function resolveNativeRoleModelIdentity(
  selection: Extract<NativeProviderSelection, { readonly kind: "native" }>,
  agents: ArborConfig["agents"],
  agent: string,
): Readonly<{ model_id: string; revision: string | null }> {
  const override = agents[agent]?.model;
  const model_id = typeof override === "string" && override !== "auto" ? override : selection.model;
  return Object.freeze({ model_id, revision: model_id === selection.model ? selection.revision : null });
}

/**
 * The closed frontier route is an explicit opt-in (`native.closed_route`),
 * never an inference from the provider id. Keying it on `provider_id ===
 * "openrouter"` meant OpenRouter could not be used as an ordinary native
 * provider at all: any such config was forced into `mode: "native"`, the
 * fixed endpoint, a bridge child and no connector. With the flag set the
 * same admission rules apply: a native OpenRouter selection on the
 * openai-compatible adapter at the fixed endpoint, plus an explicit Lenticel
 * bridge model.
 */
export function resolveClosedProviderRoute(config: ArborConfig, selection: NativeProviderSelection): Readonly<{ non_tool_model_id: string }> | null {
  if (config.native.closed_route !== true) return null;
  if (config.native.provider_id.trim().toLowerCase() !== "openrouter") throw new Error("native.closed_route requires provider_id \"openrouter\"");
  if (config.native.mode !== "native") throw new Error("OpenRouter closed provider routing requires native.mode=\"native\"; auto and fallback are forbidden");
  if (selection.kind !== "native" || selection.adapter_id !== "openai-compatible") {
    throw new Error("OpenRouter closed provider routing requires the openai-compatible native adapter");
  }
  if (selection.base_url.replace(/\/$/, "") !== "https://openrouter.ai/api/v1") {
    throw new Error("OpenRouter closed provider routing requires the fixed https://openrouter.ai/api/v1 endpoint");
  }
  const bridgeModel = config.agents.lenticel?.model;
  if (typeof bridgeModel !== "string" || bridgeModel === "auto") {
    throw new Error("OpenRouter closed provider routing requires an explicit agents.lenticel.model for the Claude bridge no-tool child");
  }
  assertClosedProductionModel(selection.model, "tool_capable");
  return Object.freeze({ non_tool_model_id: assertClosedProductionModel(bridgeModel, "non_tool") });
}

/**
 * Adapt the owned critic worker to the campaign loop's bounded panel port.
 * PanelContext carries the loop's bounded candidate and machine-verification
 * observations. Each reviewer receives its own native session and therefore can
 * neither share a Specialist session nor approve its own action.
 */
// Exported with `configuredNativeAgentExecutor` for the same reason: a
// composition root that registers the native connector must build the reviewer
// from the same native session boundary, not a second one.
export function createNativePanelReviewer(native: NativeAgentExecutor, campaignId: string): ReviewerRunner {
  return async (criticName, context) => {
    const result = await native.review({
      campaign_id: campaignId,
      node_id: `panel:${criticName}:${crypto.randomUUID()}`,
      action: {
        description: context.description,
        category: context.action_category,
        high_stakes: context.high_stakes,
      },
      specialist_output: context.specialist_output ?? "Panel review received no captured specialist output.",
      specialist_agent: "panel-context",
      prompt: [
        `Review this bounded campaign action as the ${criticName} panel critic.`,
        `Category: ${context.action_category}`,
        `High stakes: ${context.high_stakes}`,
        `Description: ${context.description}`,
        `Specialist candidate: ${context.specialist_output ?? "unavailable"}`,
        `Machine verification: ${context.verification_note || "not observed"}`,
        "Return only the required critic verdict JSON. Do not claim independent verification.",
      ].join("\n"),
      critic_agent: criticName,
    });
    return {
      approved: result.approved,
      rationale: result.rationale,
      ...(result.root_cause === undefined ? {} : { root_cause: result.root_cause }),
      ...("kind" in result.token_usage ? {} : { token_usage: result.token_usage }),
      ...(result.usage_cost === undefined ? {} : { usage_cost: result.usage_cost }),
      // TEL-1: the loop journals one critic model-identity record per distinct
      // identity its votes carry, exactly as specialist spans get theirs.
      ...(result.model_identity === undefined ? {} : { model_identity: result.model_identity }),
      ...(result.verdict === undefined ? {} : { verdict: result.verdict }),
      // A reviewer that rendered no verdict (dispatch failure, or output the
      // contract refused as malformed) is not a vote; the panel must see why.
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  };
}

/** One runtime composition root shared by every CLI transport. */
/**
 * Commands that actually dispatch or resume a campaign, and therefore are the
 * ones an execution-mode demotion is relevant to (ADR-099 2).
 */
const CAMPAIGN_DISPATCHING_COMMANDS: ReadonlySet<string> = new Set(["run", "demo", "task", "recover", "resume", "selfhost", "greenfield"]);

export interface CliRuntimeOptions {
  readonly allowPrimaryCheckout?: boolean;
  readonly safeMode?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Refuse composition unless both subprocess and native Flight hooks bind. */
  readonly requireRepoFlight?: boolean;
  /** Externally composed governance issuer ports. The CLI never owns issuer private keys. */
  readonly repoFlightGovernance?: {
    readonly provider: NonNullable<RepoFlightTransportProviderHookOptions["governance_attestation"]>;
    readonly native: NonNullable<RepoFlightTransportNativeHookOptions["governance_attestation"]>;
  };
  /**
   * ADR-099 2: sink for one-line operator notices raised while composing the
   * runtime. It exists so a connector demotion can name its reason at the
   * point of fallback without this factory owning a writer — `serve` speaks
   * JSON-RPC on stdout and a library boundary must not choose a stream for
   * its caller. Omitted by every non-CLI caller, which stays silent.
   */
  readonly onNotice?: (message: string) => void;
  /** Let an interactive TUI paint before replaying large durable audit logs. */
  readonly deferAuditRestore?: boolean;
  /** Optional bounded local runtime timing probe. */
  readonly performanceProbe?: RuntimePerformanceProbe;
}

export function resolveCliOrganizationPolicy(cwd: string, env: Readonly<Record<string, string | undefined>>): OrganizationPolicy | null {
  const organizationPath = env.ARBOR_ORGANIZATION_POLICY?.trim();
  if (!organizationPath) return null;
  const projectPath = env.ARBOR_PROJECT_POLICY?.trim();
  const userPath = env.ARBOR_USER_POLICY?.trim();
  return loadOrganizationPolicyLayers({
    organization_path: resolve(cwd, organizationPath),
    ...(projectPath ? { project_path: resolve(cwd, projectPath) } : {}),
    ...(userPath ? { user_path: resolve(cwd, userPath) } : {}),
  });
}

export function createCliRuntime(cwd: string, persistenceDir?: string, options: CliRuntimeOptions = {}): ArborRuntime {
  const runtimeBox: { current: ArborRuntime | null } = { current: null };
  // The executor's continuation dispatch rechecks this same lease authority
  // after tree selection; authorizations in the session journal are durable
  // records, while the lease and recovery task must still be live now.
  const recoveryLeases = createWorktreeRecoveryLeaseAuthority({ repo_root: cwd });
  const runtimeEnvironment = options.env ?? process.env;
  const organizationPolicy = resolveCliOrganizationPolicy(cwd, runtimeEnvironment);
  const safeMode = options.safeMode === true || runtimeEnvironment.ARBOR_SAFE_MODE === "1" || organizationPolicy?.startup.safe_mode === true;
  // Y-2: shared process-local cache backing the arbiter's structural scope
  // widening (see task_composer_arbiter below) -- the same class the native
  // repository tools already use, so no second parsed-graph cache exists.
  const repositoryGraphIndex = new RepositoryGraphIndex();
  const resolvedPersistenceDir = resolvePersistenceDir(cwd, persistenceDir);
  const environmentGovernance = options.repoFlightGovernance === undefined ? repoFlightGovernanceFromEnvironment(runtimeEnvironment) : null;
  const repoFlightGovernance = options.repoFlightGovernance ?? (environmentGovernance === null ? undefined : { provider: (_context: unknown, planned: unknown) => environmentGovernance.issuer.issue(planned), native: (_context: unknown, planned: unknown) => environmentGovernance.issuer.issue(planned) });
  let repoFlightProviderHook: RepoFlightProviderLifecycleHook | undefined;
  let repoFlightNativeHook: RepoFlightNativeLifecycleHook | undefined;
  let repoFlightCompositionError: unknown;
  // Compose the director hooks ONLY when a governance admission authority
  // exists. A hook composed without one can never admit: its `admit()` returns
  // `{admitted:false, reason:"external governance admission authority is not
  // configured"}` on every call, and `native-agent-executor.ts` invokes it for
  // EVERY `specialize` turn. So a repository holding leftover
  // `.arbor/repo-flight/` state but no configured authority composed a hook
  // that failed every subsequent campaign mid-flight with
  // `internal_error: external governance admission authority is not
  // configured` — a state no operator could diagnose or clear from the
  // message, and which `arbor doctor` reported as healthy.
  //
  // `requireRepoFlight` below is what turns this absence into a hard error, and
  // only for the callers that genuinely require a director (`arbor
  // greenfield`). Everyone else composes no director, exactly as the
  // pre-existing catch intended.
  if (repoFlightGovernance !== undefined) {
    try { repoFlightProviderHook = createRepoFlightTransportProviderHook({ client: createRepoFlightOperatorClient(resolvedPersistenceDir), governance_attestation: repoFlightGovernance.provider }); }
    catch (error) { repoFlightCompositionError = error; /* A non-dispatching runtime may be inspected without a director. */ }
    try { repoFlightNativeHook = createRepoFlightTransportNativeHook({ client: createRepoFlightOperatorClient(resolvedPersistenceDir), governance_attestation: repoFlightGovernance.native }); }
    catch (error) { repoFlightCompositionError ??= error; /* A non-dispatching runtime may be inspected without a director. */ }
  }
  if (options.requireRepoFlight === true && (repoFlightProviderHook === undefined || repoFlightNativeHook === undefined || repoFlightGovernance === undefined)) {
    throw new Error(`required repository Flight Director hooks could not be composed: ${repoFlightGovernance === undefined ? "external governance admission authority is not configured" : repoFlightCompositionError instanceof Error ? repoFlightCompositionError.message : "operator credential is unavailable"}`);
  }
  const taskAttachmentStore = new TaskAttachmentStore(resolvedPersistenceDir);
  const distributedControl = distributedControlFromEnvironment(runtimeEnvironment, cwd);
  const longHorizonScheduler = new LongHorizonScheduler(new DurableScheduleStore(resolvedPersistenceDir), {
    async launch({ schedule, run }) {
      const runtime = runtimeBox.current;
      if (runtime === null) return { kind: "failed", reason: "runtime is not initialized" };
      const jobId = `scheduled:${run.run_id}`;
      const submitted = runtime.jobScheduler.submit({ id: jobId, operation_id: `${jobId}:operation`, kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: schedule.campaign_id, idempotency_key: run.run_id });
      if (!submitted.ok) return { kind: "failed", reason: submitted.error };
      const started = runtime.runCampaignJob(schedule.campaign_id, jobId);
      if (!started.ok) return { kind: "failed", reason: started.reason };
      const settled = await runtime.awaitCampaignRun(schedule.campaign_id);
      return settled.task_state === "completed" ? { kind: "completed" } : { kind: "failed", reason: `scheduled campaign settled ${settled.task_state ?? "without state"}` };
    },
  });
  const harnessIntegrations = new HarnessIntegrationRegistry<CampaignHarnessIntegration>();
  // Loaded once via @arbor/config's single loader; a missing arbor.jsonc is
  // a normal state (loadConfigWithProvenance falls back to DEFAULT_CONFIG),
  // not an error. `effective` (file + env, ADR-020/G-07) is what the
  // runtime actually runs with; `file_only`/`env_overlay` stay separately
  // addressable so config.get can report which layer a leaf came from.
  const { effective: config, file_only, env_overlay, env_overrides } = loadConfigWithProvenance(cwd);
  const configInspection = buildConfigInspectionFromEffective(file_only, env_overrides.length > 0 ? (env_overlay as DeepPartial<ArborConfig>) : null);
  // This overlay exposes only source/presence metadata to the doctor.  Its
  // callback is invoked later, at the session-owned model boundary.
  // `native.credential_source` selects the provider API key, Claude/Codex CLI
  // subscriber diagnostics, or OpenAI API WIF bearer source; see
  // `resolveNativeCredentialOverlay`.
  // ADR-142 §2: composed once, in native-executor-composition.ts, so `arbor
  // run` and `selfhost` build the native lane the same way this runtime does
  // instead of each being structurally unable to reach it.
  const nativeEnvironment = composeNativeExecutorEnvironment({
    cwd, config, environment: runtimeEnvironment, safe_mode: safeMode,
    persistence_dir: resolvedPersistenceDir, organization_policy: organizationPolicy, runtime_box: runtimeBox,
  });
  const nativeCredentialSelection = nativeEnvironment.native_credential_selection;
  const nativeCredential = nativeEnvironment.native_credential;
  const nativeCriticCredential = nativeEnvironment.native_critic_credential;
  const nativeAdapters = nativeEnvironment.native_adapters;
  const skillCatalog = nativeEnvironment.skill_catalog;
  const pluginRegistry = nativeEnvironment.plugin_registry;
  const mcpConnector = nativeEnvironment.mcp_connector;
  const hookBus = nativeEnvironment.hook_bus;
  const nativeExecutorComposition = nativeEnvironment.composition;
  // The connector registry describes a dispatchable direct-native campaign
  // path, not merely the reference protocol package.  When mode is fallback
  // (including the empty default auto selection), registering it would let
  // capability negotiation claim revoy-native before the runner necessarily
  // wraps the OpenCode fallback.  Keep absence explicit instead.
  const nativeCampaignSelection = resolveNativeHarnessExecutionReadiness(config.native, nativeCredential, nativeAdapters, nativeCredentialSelection.boundary);
  if ((config.native.adapter_id === "ollama-native" || ["ollama", "openrouter"].includes(config.native.provider_id.trim().toLowerCase())) && nativeCampaignSelection.kind !== "direct_native") {
    throw new Error(`Direct native provider is unavailable: ${nativeCampaignSelection.reason}. Ollama/OpenRouter cannot fall back to a connector or Claude bridge; correct the native adapter, endpoint, model, or credential configuration.`);
  }
  const recoveryModelSelection = resolveNativeProviderSelection(config.native);
  const closedProviderRoute = resolveClosedProviderRoute(config, recoveryModelSelection);
  if (closedProviderRoute !== null && nativeCampaignSelection.kind !== "direct_native") {
    throw new Error("closed provider routing requires a ready native harness; connector integration cannot substitute");
  }
  const nativeReadiness = new NativeHarnessReadinessService({
    config,
    config_view: configInspection.inspect(),
    credential: nativeCredentialSelection.facts,
    adapters: nativeAdapters,
    ...(nativeCredentialSelection.boundary === undefined ? {} : { credential_boundary: nativeCredentialSelection.boundary }),
  });
  // ADR-099 §2: a connector fallback must name its reason where the demotion
  // actually happens, not only when an operator thinks to run `arbor doctor`.
  // The silent downgrade is what made connector delegation read as the
  // intended default rather than as a degraded mode.
  const nativeDemotionNotice = describeNativeConnectorFallbackDemotion(nativeReadiness.inspect());
  if (nativeDemotionNotice !== null) options.onNotice?.(nativeDemotionNotice);
  const worktrees = new WorktreeManager({ repoRoot: cwd, persistenceDir: resolvedPersistenceDir, operationalPaths: [resolvedPersistenceDir] });
  // Git reads and governed worktree mutations share the campaign lease
  // manager. Invalid or non-repository roots retain typed unavailability.
  let gitWorkspace: GitWorkspaceService | undefined;
  try {
    const adapter = new GitAdapter(cwd);
    gitWorkspace = new GitWorkspaceService(adapter, new GovernedWorktreeOperations(worktrees, adapter));
  } catch { /* no valid repository context; the catalog reports unavailable */ }
  if (nativeCampaignSelection.kind === "direct_native") {
    harnessIntegrations.register(createNativeHarnessConnectorDescriptor(undefined, true), {
      createExecutor() {
        const native = configuredNativeAgentExecutor(cwd, config, runtimeBox, nativeExecutorComposition, taskAttachmentStore, repoFlightNativeHook, recoveryLeases);
        if (native === null) throw new Error("native integration was selected without a native executor");
        return native;
      },
      createReviewer({ campaign_id }) {
        const native = configuredNativeAgentExecutor(cwd, config, runtimeBox, nativeExecutorComposition, taskAttachmentStore, repoFlightNativeHook, recoveryLeases);
        if (native === null) throw new Error("native integration was selected without a native reviewer");
        return createNativePanelReviewer(native, campaign_id);
      },
    });
  }
  // Canopy-only (amends ADR-061): the integration defaults to the native
  // lane, not to a connector. A connector id is a deprecated lane and is
  // refused here, at composition, with a typed ADR-179 remedy unless the
  // operator opted in via `connectors.allow_deprecated`. The admission is
  // handed to the campaign runner, which records it in every campaign that
  // actually runs on the connector.
  const configuredHarnessIntegration = resolveConfiguredHarnessIntegrationId(runtimeEnvironment);
  const configuredOpenCodeBin = runtimeEnvironment.ARBOR_OPENCODE_BIN?.trim() || undefined;
  const configuredCodexBin = runtimeEnvironment.ARBOR_CODEX_BIN?.trim() || undefined;
  if (closedProviderRoute !== null && configuredHarnessIntegration !== "native") {
    throw new Error("closed provider routing permits only ARBOR_HARNESS_INTEGRATION=native; connector integrations are forbidden");
  }
  const deprecatedIntegrationLane = deprecatedLaneForIntegration(configuredHarnessIntegration);
  let deprecatedHarnessAdmission: DeprecatedHarnessAdmission | undefined = deprecatedIntegrationLane === null
    ? undefined
    : admitDeprecatedHarnessLane(deprecatedIntegrationLane, `ARBOR_HARNESS_INTEGRATION=${configuredHarnessIntegration}`, config);
  // `native.mode: "fallback"` exists only to force a connector; it is the
  // same deprecated lane reached through config instead of the env var.
  if (config.native.mode === "fallback") deprecatedHarnessAdmission ??= admitDeprecatedHarnessLane("native_mode_fallback", "native.mode=\"fallback\"", config);
  if (deprecatedHarnessAdmission !== undefined) options.onNotice?.(`[harness] ${describeDeprecatedHarnessAdmission(deprecatedHarnessAdmission)}`);
  if (configuredHarnessIntegration === "native") {
    // The native lane registers itself above when it is ready; when it is
    // not, nothing is registered and a campaign fails closed in the runner
    // rather than falling back to a connector.
  } else if (configuredHarnessIntegration === "claude-code") {
    harnessIntegrations.register(
      createClaudeCodeHarnessConnectorDescriptor(),
      createClaudeCodeCampaignIntegration({
        ...(repoFlightProviderHook === undefined ? {} : { repo_flight_hook: repoFlightProviderHook }),
        specialist_verification: createDeclaredOutputsVerifier(runtimeBox, config.verification?.acceptance_commands, config.verification?.network_egress),
        // PERF: composed unconditionally (construction performs no network
        // I/O and no credential read beyond the already-loaded overlay); the
        // integration itself gates on ARBOR_CRITIC_TRANSPORT=native and
        // `.ready`, falling back to the CLI critic path otherwise.
        native_critic: createNativeCriticPort({ config, credential: nativeCriticCredential, adapters: nativeAdapters, cwd }),
      }),
    );
  } else if (configuredHarnessIntegration === "codex") {
    harnessIntegrations.register(
      createCodexHarnessConnectorDescriptor(),
      createCodexCampaignIntegration({
        ...(repoFlightProviderHook === undefined ? {} : { repo_flight_hook: repoFlightProviderHook }),
        ...(configuredCodexBin === undefined ? {} : { codex_bin: configuredCodexBin }),
        specialist_verification: createDeclaredOutputsVerifier(runtimeBox, config.verification?.acceptance_commands, config.verification?.network_egress),
        // PERF: same construction-is-free, gate-on-dispatch composition as
        // the claude-code branch above.
        native_critic: createNativeCriticPort({ config, credential: nativeCriticCredential, adapters: nativeAdapters, cwd }),
      }),
    );
  } else if (configuredHarnessIntegration === "opencode") {
    harnessIntegrations.register(
      createOpenCodeHarnessConnectorDescriptor(),
      createOpenCodeCampaignIntegration({
        ...(repoFlightProviderHook === undefined ? {} : { repo_flight_hook: repoFlightProviderHook }),
        ...(configuredOpenCodeBin === undefined ? {} : { executor_options: { opencodeBin: configuredOpenCodeBin } }),
        specialist_verification: createDeclaredOutputsVerifier(runtimeBox, config.verification?.acceptance_commands, config.verification?.network_egress),
        on_session_event: (sessionId, event) => hookBus.observeLedgerTransition(sessionId, event),
        on_session_end: (record) => hookBus.lifecycleObserve("session_end", record),
        // The bus itself, not just the two observers: without it every devolved
        // per-session and per-turn hook is inert here while reading as wired.
        hook_bus: hookBus,
        native_critic: createNativeCriticPort({ config, credential: nativeCriticCredential, adapters: nativeAdapters, cwd }),
      }),
    );
  } else {
    throw new Error(`unsupported ARBOR_HARNESS_INTEGRATION: ${configuredHarnessIntegration}`);
  }
  const safeStartup = new SafeStartupController([
    { id: "governance.runtime", kind: "governance", trust: "builtin" },
    { id: "native.mcp", kind: "integration", trust: "builtin", close: () => mcpConnector.close() },
  ], safeMode);
  const runtime = new ArborRuntime({
    ...(options.deferAuditRestore === true ? { defer_audit_restore: true } : {}),
    ...(options.performanceProbe === undefined ? {} : { performance_probe: options.performanceProbe }),
    lifecycle: [
      ...(gitWorkspace === undefined ? [] : [{ name: "git-projection-watcher", start: () => gitWorkspace!.start(), close: () => gitWorkspace!.close() }]),
      safeStartup,
    ],
    persistence_dir: resolvedPersistenceDir,
    distributed_control: distributedControl,
    workspace_root: cwd,
    ...(gitWorkspace === undefined ? {} : { git_workspace: gitWorkspace }),
    long_horizon_scheduler: longHorizonScheduler,
    plugin_registry: pluginRegistry,
    task_composer_planner: nativeCampaignSelection.kind === "direct_native" ? {
      supports_governed_artifacts: true,
      answer_reference: async (input) => {
        const native = configuredNativeAgentExecutor(cwd, config, runtimeBox, nativeExecutorComposition, taskAttachmentStore, repoFlightNativeHook, recoveryLeases);
        if (native === null) throw new Error("native read-only answers are unavailable for the current provider configuration");
        return native.answerReference({ draft_id: input.draft_id, task: input.task, governed_artifacts: taskAttachmentStore.resolve(input.attachments), signal: input.signal });
      },
      plan: async (input) => {
        const native = configuredNativeAgentExecutor(cwd, config, runtimeBox, nativeExecutorComposition, taskAttachmentStore, repoFlightNativeHook, recoveryLeases);
        if (native === null) throw new Error("native task planning is unavailable for the current provider configuration");
        return native.planTask({ draft_id: input.draft_id, prompt: `${taskComposerPlanningPrompt(input)}\n\n${skillCatalogPlanningProjection(skillCatalog)}`, governed_artifacts: taskAttachmentStore.resolve(input.attachments ?? []), signal: input.signal });
      },
    } : configuredHarnessIntegration === "claude-code" ? { ...createClaudeCodeTaskPlanner({
      cwd,
      ...(repoFlightProviderHook === undefined ? {} : { repo_flight_hook: repoFlightProviderHook }),
      repository_graph: repositoryGraphIndex,
      planning_prompt: (input) => `${taskComposerPlanningPrompt(input)}\n\n${skillCatalogPlanningProjection(skillCatalog)}`,
    }), supports_governed_artifacts: false } : configuredHarnessIntegration === "codex" ? { ...createCodexTaskPlanner({
      cwd,
      ...(repoFlightProviderHook === undefined ? {} : { repo_flight_hook: repoFlightProviderHook }),
      repository_graph: repositoryGraphIndex,
      ...(configuredCodexBin === undefined ? {} : { codex_bin: configuredCodexBin }),
      planning_prompt: (input) => `${taskComposerPlanningPrompt(input)}\n\n${skillCatalogPlanningProjection(skillCatalog)}`,
    }), supports_governed_artifacts: false } : configuredHarnessIntegration === "opencode" ? { ...createOpenCodeTaskPlanner({
      cwd,
      ...(repoFlightProviderHook === undefined ? {} : { repo_flight_hook: repoFlightProviderHook }),
      repository_graph: repositoryGraphIndex,
      ...(configuredOpenCodeBin === undefined ? {} : { opencode_bin: configuredOpenCodeBin }),
      planning_prompt: (input) => `${taskComposerPlanningPrompt(input)}\n\n${skillCatalogPlanningProjection(skillCatalog)}`,
    }), supports_governed_artifacts: false } : {
      supports_governed_artifacts: false,
      plan: async () => { throw new Error("task planning requires a ready native provider, the claude-code integration, the codex integration, or the opencode integration; run arbor doctor for remediation"); },
    },
    task_composer_attachment_store: taskAttachmentStore,
    // ADR-062: every `arbor task` submission runs the cheap, zero-cost
    // heuristic arbiter classifier by default (no provider readiness
    // required, unlike the planner above); ARBOR_ARBITER_TRANSPORT=native
    // upgrades intake to a model-backed classifier with heuristic fallback,
    // and ARBOR_ARBITER_TRANSPORT=escalate runs the heuristic first and
    // calls the model only when the heuristic's own decision is ambiguous
    // (`reviewed`) -- ADR-062's disclosed "heuristics + LLM only when
    // ambiguous" composition. `governed` remains the fallback whenever the
    // arbiter itself is bypassed via an explicit `--tier`.
    // Y-2 (least-privilege #3): a mined write scope naming a test file gets
    // its direct non-test imports appended, best-effort, via the same
    // cached import-graph index the native repository tools use. A query
    // failure (non-parseable file, uncached root, etc.) must never affect
    // classification -- the try/catch mirrors createHeuristicArbiterIntakePort's
    // own "silent on error" contract for this seam.
    task_composer_arbiter: composeArbiterIntakePort({
      config,
      structural_paths: (path) => {
        try {
          return repositoryGraphIndex.query(cwd, { path, depth: 1 }).edges
            .filter((edge) => edge.from === path)
            .map((edge) => edge.to);
        } catch {
          return [];
        }
      },
    }),
    // ADR-012 recovery (G-03): a real git-worktree-backed lease authority so
    // recovery.retry/recovery.abandon are genuinely reachable rather than
    // rejected with "recovery service is not configured".
    recovery_leases: recoveryLeases,
    recovery_continuation_admissions: {
      admit(input) {
        const admission = (kind: FreshAdmissionKind, admitted: boolean, evidence_id: string, reason: string): FreshAdmissionResult => Object.freeze({ kind, admitted, evidence_id, reason });
        const connectorAvailable = nativeCampaignSelection.kind !== "unavailable";
        const sourceModel = input.plan.source_model_identity;
        const modelRevisionMatches = recoveryModelSelection.kind === "native" && sourceModel !== null
          && sourceModel.provider_id === recoveryModelSelection.provider_id && sourceModel.model_id === recoveryModelSelection.model
          && sourceModel.configured_revision === recoveryModelSelection.revision;
        return Object.freeze([
          admission("connector", connectorAvailable, `connector:${nativeCampaignSelection.kind}`, connectorAvailable ? "current connector selection is dispatchable" : nativeCampaignSelection.reason),
          admission("credential", connectorAvailable, `credential:fresh-session:${input.new_session_id}`, nativeCampaignSelection.kind === "direct_native" ? "opaque credential lease will be issued only for the fresh session" : "selected connector owns fresh credential admission"),
          admission("budget", true, `budget:fresh-session:${input.new_session_id}`, "campaign budget authority will reserve a new session allocation"),
          admission("worktree", true, input.isolation.lease_id, "fresh lease and starting-commit isolation were checked"),
          admission("policy", true, "policy:native-session-v1", "immutable role and tool policy will be recomposed for the fresh session"),
          admission("approval", true, "approval:system-specialist-tools-v1", "approval policy is freshly bound; no prior approval is inherited"),
          admission("high_risk_scope", true, `scope:manager-node:${input.plan.node_id}`, "manager will rederive the current node action scope for the fresh session"),
          admission("model_revision", modelRevisionMatches, `model:${nativeCampaignSelection.kind}`, modelRevisionMatches ? "configured provider, model, and revision still match the interrupted admission" : "interrupted model identity is absent or its configured revision changed"),
        ]);
      },
    },
    // A-7: real sources for the `config.get`/`agent.list` catalog queries —
    // previously always empty regardless of `arbor.jsonc` or supervisor
    // state on every production MCP/webui invocation.
    config_inspection: configInspection,
    native_harness_readiness: nativeReadiness,
    // Parity gap #4: the standard doctor.get/inspectOperatorDoctor() health
    // check must recognize the native lane too, not just the three
    // subprocess connectors — pass native readiness through so
    // ARBOR_HARNESS_INTEGRATION=native reports real health instead of
    // "unsupported integration id".
    operator_doctor_integration: inspectHarnessIntegrationEnvironment(process.env, undefined, nativeReadiness.inspect()),
    // G-11: the loaded config's kb.backend now genuinely reaches
    // CampaignManagerOptions.kb_backend instead of every real run silently
    // defaulting to jsonl regardless of arbor.jsonc.
    kb_backend: config.kb.backend,
    agent_definitions: buildAgentDefinitionSource(),
    // Wave 1 Lane A (todo 1): CAMPAIGN_RUN_JOB_KIND jobs are genuinely
    // runnable on every CLI transport, not just `arbor run`'s own direct call.
    campaign_runner: createProductionCampaignRunner(runtimeBox, cwd, config.agents, {
      native_selection: nativeCampaignSelection,
      integrations: harnessIntegrations,
      ...(deprecatedHarnessAdmission === undefined ? {} : { deprecated_harness_admission: deprecatedHarnessAdmission }),
      // ADR-066 (Y-3): generated-oracle amplifier composition; inert unless
      // ARBOR_TEST_AMPLIFIER=native (the module gates itself).
      native_config: { native: config.native },
      allow_primary_checkout: options.allowPrimaryCheckout === true,
    }),
    // ADR-038 v1: the only executable descriptor path is an explicit catalog
    // command. It is separately capability-gated and lazy-bound to this one
    // runtime, so ordinary campaigns never gain a hidden spawn path.
    declarative_subagent_executor: createDeclarativeSubagentExecutor({
      context: () => {
        if (!runtimeBox.current) throw new Error("runtime is not initialized");
        return runtimeBox.current.governedContext;
      },
      manager: () => {
        if (!runtimeBox.current) throw new Error("runtime is not initialized");
        return runtimeBox.current.manager;
      },
      native_executor: () => configuredNativeAgentExecutor(cwd, config, runtimeBox, nativeExecutorComposition, taskAttachmentStore, repoFlightNativeHook, recoveryLeases),
      worktrees,
    }),
    // Default, real production evaluator composition. It is deliberately
    // lazy: an unconfigured provider settles a requested run as unmeasured;
    // it never makes CLI startup probe a provider or manufacture an outcome.
    harness_evaluator: new ProductionHarnessEvaluator({
      context: () => {
        if (!runtimeBox.current) throw new Error("runtime is not initialized");
        return runtimeBox.current.governedContext;
      },
      audit_records: (campaignId) => {
        if (!runtimeBox.current) return [];
        try { return runtimeBox.current.manager.getAuditRecords(campaignId); } catch { return []; }
      },
      native_executor: () => configuredNativeAgentExecutor(cwd, config, runtimeBox, nativeExecutorComposition, taskAttachmentStore, repoFlightNativeHook, recoveryLeases),
    }),
    harness_connector_registry: harnessIntegrations.connectors,
    harness_integrations: harnessIntegrations,
    register_native_harness_connector: false,
    agent_config: config.agents,
    // Model-capability evidence is integration-owned. The former global
    // OpenCode probe was dark (the loop supplied no model id) and made the
    // native runtime know about an unrelated upstream process. Honest absence
    // is safer until the selected integration contributes a typed snapshot.
    sibling_spawner: (manager, supervisor) => new SiblingSpawner(manager, supervisor, worktrees),
  });
  runtimeBox.current = runtime;
  distributedControl?.attachIngress(new RemoteRuntimeIngress(new RuntimeCatalogRouter(runtime), runtime.remoteSessionAuthority));
  return runtime;
}

export function taskComposerPlanningPrompt(input: { readonly task: string; readonly answers: Readonly<Record<string, string>>; readonly answered_questions?: readonly { readonly id: string; readonly question: string; readonly answer: string }[]; readonly parent_campaign_id: string | null; readonly evidence_ids: readonly string[]; readonly retry_context?: string; readonly attachments?: readonly { readonly attachment_id: string; readonly media_type: string; readonly byte_length: number; readonly display_name: string }[] }): string {
  return [
    // ADR-117 §3 retries a schema-invalid proposal. That retry only earns its
    // cost if the planner is told what was wrong — without this the re-prompt
    // is byte-identical and re-rolls the same deterministic failure.
    ...(input.retry_context === undefined || input.retry_context.trim().length === 0 ? [] : [
      `Your previous response in this same planning step was rejected and did not reach the operator. Rejection reason: ${input.retry_context.trim().slice(0, 1_024)}. Correct exactly that fault and return the full JSON object again; do not apologize, explain, or emit anything but the object.`,
    ]),
    "You are Taproot, a read-only strategic planner. Use the bounded repository-context capsule supplied by the transport when it is present; do not call tools or inspect the repository live in this pre-campaign step. Do not write files, execute commands, request human input, or claim verification. These restrictions apply to the planner only: never copy them into action constraints. A read-only child may use non-mutating repository inspection commands/tools; it must only be forbidden from writes and mutating commands.",
    "The admitted actions are the executable frontier, not a request for another plan. When repository context identifies plausible implementation, declaration, documentation, or test paths, propose path-bounded mutable actions that complete the operator task. Do not return a discovery-only action whose output is merely a future execution plan; the campaign cannot treat prose as newly authorized code work. If safe write paths genuinely cannot be established from the task and supplied context, ask one concrete blocking question instead of admitting hollow work.",
    "Return exactly one JSON object and no markdown/prose. Its only fields are summary, assumptions, questions, root_action, actions, acceptance_checks, acceptance_mapping, risk_notes.",
    "Use this exact value shape (replace the example values, but preserve every type): {\"summary\":\"non-empty summary\",\"assumptions\":[],\"questions\":[],\"root_action\":{\"description\":\"non-empty action\",\"estimated_gain\":1,\"estimated_cost\":1,\"category\":\"general\",\"delegate_to\":\"seed\",\"constraints\":[],\"execution_role\":null,\"skill_id\":null,\"skill_version\":null,\"high_risk_tool_scope\":null,\"decomposition_depth\":null,\"depends_on\":[]},\"actions\":[{\"description\":\"non-empty action\",\"estimated_gain\":1,\"estimated_cost\":1,\"category\":\"general\",\"delegate_to\":\"seed\",\"constraints\":[],\"execution_role\":null,\"skill_id\":null,\"skill_version\":null,\"high_risk_tool_scope\":null,\"decomposition_depth\":null,\"depends_on\":[]}],\"acceptance_checks\":[],\"acceptance_mapping\":[],\"risk_notes\":[]}. summary is a non-empty string. assumptions, acceptance_checks, and risk_notes are arrays containing only non-empty strings; use [] when empty.",
    "Each question has exactly id and question. root_action and every action require description, estimated_gain, estimated_cost, category, delegate_to. actions must contain 1 through 32 complete action objects. For every action: constraints and depends_on are arrays of non-empty strings (use [] when empty); execution_role is architect, documentation-writer, or null; skill_id and skill_version are either an exact known id + SemVer pair or both null; decomposition_depth is an integer from 0 through 8 or null; high_risk_tool_scope is either null or exactly {write_paths:string[],command_argv:(string[]|{argv_prefix:string[],purpose:string})[]}. A command_argv entry is normally an exact literal argv array. Use the {argv_prefix,purpose} form ONLY when the exact command genuinely cannot be known at plan time because the tool itself chooses part of it -- a scaffolder that appends a generated project name, for example {\"argv_prefix\":[\"npm\",\"create\",\"astro@latest\"],\"purpose\":\"scaffold the site; the exact target name is chosen at runtime\"}. The first matching call binds that slot to the exact argv it ran, and every later call under it must match those bytes exactly, so declare an intent for a scaffold step rather than guessing a literal argv that will be refused. root_action.depends_on must be []. Every actions[].depends_on entry must exactly equal the description of another action in actions; descriptions must be unique, dependencies acyclic, and at least one action must have []. acceptance_checks must contain unique observable criteria. acceptance_mapping must contain exactly one {criterion,action_descriptions} record for every criterion, where criterion exactly matches acceptance_checks and action_descriptions contains one or more exact actions[].description values; do not map criteria to root_action. Use [] for both when there are no acceptance criteria. Never use completion claims, acceptance checks, or desired outcomes as dependency names. Do not use an object or string for constraints. Actions must be safe proposed work, not instructions to bypass governance.",
    "high_risk_tool_scope is how you authorize the action's EXECUTOR (not you) to act. If the executor will create or modify any file, you MUST set high_risk_tool_scope.write_paths to every repository-relative path it will touch (e.g. {\"write_paths\":[\"docs/native-doctor.md\"],\"command_argv\":[]}) — a write to any path not listed there is refused at runtime, and the task will fail. List every state-changing or validation command in command_argv; ordinary non-mutating repository inspection commands are available to read-only actions and do not belong in this high-risk scope. Use null only for a genuinely read-only action. For a test file, authorize its repository test runner (for example [\"bun\",\"test\",\"path/to/file.test.ts\"]), never direct execution of the test source. root_action must contain the union of child write_paths and command_argv because it is the bounded recovery fallback; this union grants nothing beyond the child scopes.",
    "Every mutable action must be independently verifiable within its own write authority: put its relevant acceptance command in that same action's command_argv. Do not postpone all verification to a separate command-only sibling, because a red validator cannot repair an earlier node's bytes. A command-only validation action may repeat a final independent check, but it does not replace verification on the mutable prerequisite.",
    `Task: ${input.task}`,
    "Clarification integrity: each prior answer is bound to the exact question text shown to the operator. Do not reuse a prior question ID for different wording. Remove a resolved question, or preserve both its ID and wording if it still belongs in questions.",
    `Prior question-answer bindings: ${JSON.stringify(input.answered_questions ?? [])}`,
    `Prior answers by ID (compatibility projection only): ${JSON.stringify(input.answers)}`,
    `Linked parent campaign: ${input.parent_campaign_id ?? "none"}`,
    `Operator supplied evidence references: ${JSON.stringify(input.evidence_ids)}`,
    `Governed media attachments: ${JSON.stringify((input.attachments ?? []).map(({ attachment_id, media_type, byte_length, display_name }) => ({ attachment_id, media_type, byte_length, display_name })))}`,
  ].join("\n\n");
}

function skillCatalogPlanningProjection(catalog: SkillCatalog): string {
  const skills = catalog.list().map((skill) => `${skill.skill_id}@${skill.version} (role=${skill.role})`);
  return skills.length === 0 ? "Governed skills available: none. Set skill_id and skill_version to null." : `Governed skills available (select only an exact listed identity): ${skills.join(", ")}`;
}

export interface StdioSession {
  close(): Promise<void>;
}

const REPO_FLIGHT_QUERY_KINDS = Object.freeze({
  status: "repo.flight.status",
  profile: "repo.flight.profile",
  sessions: "repo.flight.sessions",
  clearances: "repo.flight.clearances",
  drains: "repo.flight.drains",
  gates: "repo.flight.gate",
  deliveries: "repo.flight.deliveries",
  effects: "repo.flight.effects",
  runs: "repo.flight.runs",
} as const);

function repoFlightWireSucceeded(response: { readonly ok: boolean; readonly result?: unknown }, requireAccepted = false): boolean {
  if (!response.ok || typeof response.result !== "object" || response.result === null || (response.result as { ok?: unknown }).ok !== true) return false;
  if (!requireAccepted) return true;
  const value = (response.result as { value?: unknown }).value;
  return typeof value === "object" && value !== null && (value as { accepted?: unknown }).accepted === true;
}

async function ensureRepoFlightDirector(cwd: string, persistenceDir: string): Promise<void> {
  const expectedRepositoryId = repoFlightRepositoryId(probeRepoFlightGitCandidate(cwd).git_common_dir);
  const status = async (): Promise<boolean> => {
    let response;
    try {
      response = await createRepoFlightOperatorClient(persistenceDir, 250).query({ schema_version: 1, query_id: `flight-ready:${crypto.randomUUID()}`, query: { kind: "repo.flight.profile" } });
    } catch { return false; }
    if (!repoFlightWireSucceeded(response)) return false;
    const value = (response.result as { value?: unknown }).value;
    const observedRepositoryId = typeof value === "object" && value !== null ? (value as { repository_id?: unknown }).repository_id : null;
    if (observedRepositoryId !== expectedRepositoryId) throw new Error(`the persistence root is already controlled for repository ${String(observedRepositoryId)}, not ${expectedRepositoryId}`);
    return true;
  };
  if (await status()) return;
  const entry = process.argv[1];
  if (!entry) throw new Error("the current Arbor executable cannot be resolved for Flight Director startup");
  const child = spawn(process.execPath, [entry, "flight", "serve", "--repository", resolve(cwd), "--persistence", resolve(persistenceDir)], { cwd, detached: true, stdio: "ignore", shell: false, env: process.env });
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await status()) return;
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error("the repo-local Flight Director did not become ready within 5 seconds");
}

async function repoFlightCommand(
  args: readonly string[],
  environment: { cwd: string; persistence_dir?: string; stdin: Readable; stdout: Writable; stderr: Writable; env?: Readonly<Record<string, string | undefined>> },
  shutdownGate?: ShutdownGate,
): Promise<number> {
  const action = args[0] ?? "status";
  const repositoryAt = args.indexOf("--repository");
  const persistenceAt = args.indexOf("--persistence");
  if ((repositoryAt >= 0 && !args[repositoryAt + 1]) || (persistenceAt >= 0 && !args[persistenceAt + 1])) {
    environment.stderr.write("--repository and --persistence each require a path\n");
    return EXIT_CODES.USAGE;
  }
  const repository = repositoryAt >= 0 ? resolve(args[repositoryAt + 1]!) : resolve(environment.cwd);
  const persistence = persistenceAt >= 0 ? resolve(args[persistenceAt + 1]!) : resolvePersistenceDir(environment.cwd, environment.persistence_dir);
  if (action === "serve") {
    let director: RepoFlightDirector;
    try {
      const runtimeEnvironment = environment.env ?? process.env;
      const configuredHarness = runtimeEnvironment.ARBOR_HARNESS_INTEGRATION?.trim() || "opencode";
      const connectorProvider: RepoFlightProfileProvider = configuredHarness === "claude-code"
        ? "claude"
        : configuredHarness === "codex"
          ? "codex"
          : configuredHarness === "opencode"
            ? "opencode"
            : (() => { throw new Error(`unsupported ARBOR_HARNESS_INTEGRATION: ${configuredHarness}`); })();
      const { effective: config } = loadConfigWithProvenance(repository);
      const credentialSelection = resolveNativeCredentialOverlay({ credential_source: config.native.credential_source, provider_id: config.native.provider_id, adapter_id: config.native.adapter_id, base_url: config.native.base_url, env: runtimeEnvironment });
      const nativeSelection = resolveNativeHarnessExecutionReadiness(config.native, credentialSelection.overlay, createReferenceNativeModelAdapterRegistry(fetch), credentialSelection.boundary);
      // Both lanes are selectable by the campaign executor when direct-native
      // is ready: native is the default and the configured connector remains
      // an explicit operator choice. Deployment truth must cover that whole
      // live choice set rather than whichever lane happens to run first.
      const requiredProviders: RepoFlightProfileProvider[] = nativeSelection.kind === "direct_native" ? ["native", connectorProvider] : [connectorProvider];
      const providers = Object.fromEntries(requiredProviders.map((provider) => [provider, {
        launch_interceptor: true,
        identity_enrollment: provider === "native" ? false : provider === "opencode" ? repoFlightOpenCodeEnrollmentBarrierAvailable() : true,
        mutation_interceptor: false,
      }])) as Partial<Record<RepoFlightProfileProvider, { launch_interceptor: boolean; identity_enrollment: boolean; mutation_interceptor: boolean }>>;
      const governance = repoFlightGovernanceFromEnvironment(runtimeEnvironment);
      director = new RepoFlightDirector({ repository_root: repository, persistence_dir: persistence, required_providers: requiredProviders, deployment: { providers }, ...(governance === null ? {} : { governance_trust: governance.trust }) });
      await director.start();
    }
    catch (error) { environment.stderr.write(`Flight Director refused startup: ${error instanceof Error ? error.message : String(error)}\n`); return EXIT_CODES.CONFLICT; }
    const identity = probeRepoFlightHostProcess(process.pid);
    const ownerRecord = `${JSON.stringify({ schema_version: 1, pid: process.pid, process_start_token: identity.process_start_token, host_boot_id: identity.host_boot_id })}\n`;
    writeFileSync(director.paths.owner_process, ownerRecord, { mode: 0o600 });
    chmodSync(director.paths.owner_process, 0o600);
    environment.stderr.write(`Flight Director ready for ${repository} at ${director.paths.socket}\n`);
    const serviceGate = shutdownGate ?? new ShutdownGate();
    const triggerServiceGate = (): void => serviceGate.trigger();
    if (shutdownGate === undefined) { process.once("SIGINT", triggerServiceGate); process.once("SIGTERM", triggerServiceGate); }
    try { await serviceGate.signal; }
    finally {
      if (shutdownGate === undefined) { process.off("SIGINT", triggerServiceGate); process.off("SIGTERM", triggerServiceGate); }
      await director.close();
      if (existsSync(director.paths.owner_process) && readFileSync(director.paths.owner_process, "utf8") === ownerRecord) unlinkSync(director.paths.owner_process);
    }
    return EXIT_CODES.SUCCESS;
  }
  if (action === "start") {
    try { await ensureRepoFlightDirector(repository, persistence); }
    catch (error) { environment.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return EXIT_CODES.CONFLICT; }
    environment.stdout.write(`${JSON.stringify({ ok: true, repository, ...repoFlightDirectorPaths(persistence) }, null, 2)}\n`);
    return EXIT_CODES.SUCCESS;
  }
  if (action === "stop") {
    const paths = repoFlightDirectorPaths(persistence);
    if (!existsSync(paths.owner_process)) { environment.stderr.write("Flight Director owner record is unavailable\n"); return EXIT_CODES.CONFLICT; }
    try {
      const owner = JSON.parse(readFileSync(paths.owner_process, "utf8")) as { schema_version?: unknown; pid?: unknown; process_start_token?: unknown; host_boot_id?: unknown };
      if (owner.schema_version !== 1 || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || typeof owner.process_start_token !== "string" || typeof owner.host_boot_id !== "string") throw new Error("owner record is malformed");
      const observed = probeRepoFlightHostProcess(owner.pid as number);
      if (observed.process_start_token !== owner.process_start_token || observed.host_boot_id !== owner.host_boot_id) throw new Error("owner PID identity changed; refusing to signal it");
      process.kill(owner.pid as number, "SIGTERM");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && existsSync(paths.socket)) await new Promise<void>((done) => setTimeout(done, 25));
      if (existsSync(paths.socket)) throw new Error("Flight Director did not stop within 5 seconds");
      environment.stdout.write(`${JSON.stringify({ ok: true, stopped_pid: owner.pid })}\n`);
      return EXIT_CODES.SUCCESS;
    } catch (error) { environment.stderr.write(`Flight Director stop refused: ${error instanceof Error ? error.message : String(error)}\n`); return EXIT_CODES.CONFLICT; }
  }
  let client;
  try { client = createRepoFlightOperatorClient(persistence); }
  catch (error) { environment.stderr.write(`Flight Director is unavailable: ${error instanceof Error ? error.message : String(error)}\n`); return EXIT_CODES.CONFLICT; }
  if (action === "command") {
    let input = "";
    for await (const chunk of environment.stdin) {
      input += String(chunk);
      if (Buffer.byteLength(input) > 64 * 1024) { environment.stderr.write("Flight command exceeds 65536 bytes\n"); return EXIT_CODES.USAGE; }
    }
    let envelope: unknown;
    try { envelope = JSON.parse(input); }
    catch { environment.stderr.write("Flight command stdin must contain one JSON envelope\n"); return EXIT_CODES.USAGE; }
    const idempotency = typeof envelope === "object" && envelope !== null && typeof (envelope as { metadata?: { idempotency_key?: unknown } }).metadata?.idempotency_key === "string" ? (envelope as { metadata: { idempotency_key: string } }).metadata.idempotency_key : `flight-command:${crypto.randomUUID()}`;
    const response = await client.command(envelope, idempotency);
    environment.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return repoFlightWireSucceeded(response, true) ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
  }
  const kind = REPO_FLIGHT_QUERY_KINDS[action as keyof typeof REPO_FLIGHT_QUERY_KINDS];
  if (kind === undefined) {
    environment.stderr.write("Usage: arbor flight <start|stop|serve|status|profile|sessions|clearances|drains|gates|deliveries|effects|runs|command>\n");
    return EXIT_CODES.USAGE;
  }
  const runAt = args.indexOf("--run"), planAt = args.indexOf("--plan");
  if (runAt >= 0 && !args[runAt + 1]) { environment.stderr.write("--run requires a repo-run id\n"); return EXIT_CODES.USAGE; }
  if (kind === "repo.flight.gate" && (planAt < 0 || !args[planAt + 1])) { environment.stderr.write("arbor flight gates requires --plan <plan-id>\n"); return EXIT_CODES.USAGE; }
  const queryBody = kind === "repo.flight.gate"
    ? { kind, plan_id: args[planAt + 1]! }
    : (kind === "repo.flight.deliveries" || kind === "repo.flight.effects") && runAt >= 0
      ? { kind, repo_run_id: args[runAt + 1]! }
      : { kind };
  const query = { schema_version: 1 as const, query_id: `flight-query:${crypto.randomUUID()}`, query: queryBody };
  const response = await client.query(query);
  environment.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  return repoFlightWireSucceeded(response) ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
}

/** Attach the JSON-RPC protocol without process-global listeners; useful for deterministic tests. */
export async function startStdioSession(
  server: ArborMCPServer,
  input: Readable,
  output: Writable,
): Promise<StdioSession> {
  const started = await server.start();
  if (!started.ok) throw new Error(started.failures.map((failure) => failure.summary).join("; ") || "runtime did not start");

  let buffer = "";
  let discardingOversizedFrame = false;
  const pending = new Set<Promise<void>>();
  const inFlight = new Map<string | number, AbortController>();
  let nextElicitationId = 0;
  const pendingElicitations = new Map<string, (result: McpOperatorElicitationResult) => void>();
  let closed = false;
  // Stdio has no HTTP Mcp-Session-Id header. Give this transport instance an
  // explicit identity so cancellation/refusal records cannot be confused
  // across sessions that happen to reuse the same request ID.
  const lifecycle: McpStdioLifecycle = { phase: "awaiting_initialize", clientCapabilities: {}, session_id: `stdio-${crypto.randomUUID()}` };
  const operatorElicitationPort: McpOperatorElicitationPort = {
    elicit: (request: McpOperatorElicitationRequest, signal: AbortSignal) => {
      const elicitation = lifecycle.clientCapabilities.elicitation;
      if (lifecycle.phase !== "operating" || !isRecord(elicitation) || !isRecord(elicitation.form)) return Promise.resolve({ action: "unavailable", reason: "initialized client did not advertise elicitation.form" });
      if (pendingElicitations.size >= MCP_MAX_INPUT_REQUESTS) return Promise.resolve({ action: "unavailable", reason: "too many concurrent elicitation requests" });
      if (typeof request.message !== "string" || request.message.trim().length === 0) return Promise.resolve({ action: "unavailable", reason: "elicitation message must be non-empty" });
      if (Buffer.byteLength(request.message, "utf8") > MCP_MAX_ELICIT_MESSAGE_BYTES) return Promise.resolve({ action: "unavailable", reason: "elicitation message exceeds byte bound" });
      let schemaSize: number;
      try { schemaSize = Buffer.byteLength(JSON.stringify(request.requestedSchema), "utf8"); } catch { return Promise.resolve({ action: "unavailable", reason: "elicitation schema is not serializable" }); }
      if (schemaSize > MCP_MAX_FRAME_BYTES) return Promise.resolve({ action: "unavailable", reason: "elicitation schema exceeds frame byte bound" });
      if (signal.aborted) return Promise.resolve({ action: "cancel" });
      const requestId = `arbor-elicitation-${++nextElicitationId}`;
      return new Promise((resolveElicitation) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: McpOperatorElicitationResult): void => {
          pendingElicitations.delete(requestId);
          if (timeout) clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          resolveElicitation(result);
        };
        const onAbort = (): void => {
          output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, sessionId: lifecycle.session_id, reason: "operator request cancelled" } })}\n`);
          finish({ action: "cancel" });
        };
        pendingElicitations.set(requestId, finish);
        timeout = setTimeout(() => finish({ action: "unavailable", reason: "elicitation response timed out" }), MCP_CALL_TIMEOUT_MS);
        signal.addEventListener("abort", onAbort, { once: true });
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "elicitation/create", params: { mode: "form", message: request.message, requestedSchema: request.requestedSchema } })}\n`);
      });
    },
  };
  server.bindOperatorElicitationPort(operatorElicitationPort);
  const unsubscribeToolChanges = server.subscribeToolListChanges(() => {
    if (lifecycle.phase === "operating") output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`);
  });
  const processLine = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as RpcMessage;
      if (msg.method === undefined && (typeof msg.id === "string" || typeof msg.id === "number")) {
        const settle = pendingElicitations.get(String(msg.id));
        if (settle) {
          if (isRecord(msg.error)) settle({ action: "unavailable", reason: "client refused elicitation request" });
          else if (isRecord(msg.result) && (msg.result.action === "accept" || msg.result.action === "decline" || msg.result.action === "cancel")) {
            if (msg.result.action === "accept" && isRecord(msg.result.content)) settle({ action: "accept", content: msg.result.content });
            else if (msg.result.action === "accept") settle({ action: "unavailable", reason: "accepted elicitation response omitted content" });
            else settle({ action: msg.result.action });
          } else settle({ action: "unavailable", reason: "invalid elicitation response" });
          return;
        }
      }
      if (msg.method === "notifications/cancelled") {
        const requestId = msg.params?.requestId;
        // Optional Revoy extension: a delayed cancellation from a closed
        // stdio session must not affect work in a replacement session.
        if (msg.params?.sessionId !== undefined && msg.params.sessionId !== lifecycle.session_id) return;
        const controller = (typeof requestId === "string" || typeof requestId === "number") ? inFlight.get(requestId) : undefined;
        controller?.abort();
        return;
      }
      if (msg.id === undefined) {
        const response = await handleMessage(server, msg, lifecycle);
        if (response) output.write(`${JSON.stringify(response)}\n`);
        return;
      }
      if (msg.method === "initialize") {
        const response = await handleMessage(server, msg, lifecycle);
        if (response) output.write(`${JSON.stringify(response)}\n`);
        return;
      }
      if (inFlight.has(msg.id)) {
        output.write(`${JSON.stringify(rpcError(msg.id, -32600, "Duplicate in-flight request id"))}\n`);
        return;
      }
      const controller = new AbortController();
      inFlight.set(msg.id, controller);
      void (async () => {
        try {
          const work = handleMessage(server, msg, lifecycle, controller.signal);
          const response = await raceWithRequestCancellation(work, controller.signal, () => rpcError(msg.id, -32800, "Request cancelled", { kind: "request_cancelled", session_id: lifecycle.session_id }));
          if (response) output.write(`${JSON.stringify(response)}\n`);
        } finally { if (inFlight.get(msg.id!) === controller) inFlight.delete(msg.id!); }
      })().catch(() => { output.write(`${JSON.stringify(rpcError(msg.id, -32603, "Internal error"))}\n`); });
      return;
    } catch {
      output.write(`${JSON.stringify(parseError())}\n`);
    }
  };
  const onData = (data: Buffer | string): void => {
    let text = data.toString();
    if (discardingOversizedFrame) {
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      text = text.slice(newline + 1);
      discardingOversizedFrame = false;
    }
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > MCP_MAX_FRAME_BYTES) {
        const task = Promise.resolve().then(() => { output.write(`${JSON.stringify(rpcError(undefined, -32600, "MCP stdio request frame exceeds byte bound"))}\n`); }); pending.add(task); void task.finally(() => pending.delete(task));
      } else {
        const task = processLine(line); pending.add(task); void task.finally(() => pending.delete(task));
      }
    }
    if (Buffer.byteLength(buffer, "utf8") > MCP_MAX_FRAME_BYTES) {
      buffer = "";
      discardingOversizedFrame = true;
      const task = Promise.resolve().then(() => { output.write(`${JSON.stringify(rpcError(undefined, -32600, "MCP stdio request frame exceeds byte bound"))}\n`); }); pending.add(task); void task.finally(() => pending.delete(task));
    }
  };
  input.on("data", onData);

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribeToolChanges();
      input.off("data", onData);
      for (const controller of inFlight.values()) controller.abort();
      for (const settle of pendingElicitations.values()) settle({ action: "cancel" });
      server.bindOperatorElicitationPort(null);
      if (input.listenerCount("data") === 0) input.pause();
      await Promise.allSettled([...pending]);
      await boundedClose(server);
    },
  };
}

/** Race request work against cancellation without retaining a listener after settlement. */
function raceWithRequestCancellation<T>(work: Promise<T>, signal: AbortSignal, cancelled: () => T): Promise<T> {
  if (signal.aborted) {
    // The caller starts `work` before entering this helper. If cancellation
    // won that small scheduling window, still observe its settlement so a
    // later rejection cannot become an unhandled promise rejection.
    void work.catch(() => undefined);
    return Promise.resolve(cancelled());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => finish(() => resolve(cancelled()));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    // Abort may race with registration between the initial check and listener attachment.
    if (signal.aborted) onAbort();
  });
}

export async function main(
  args = process.argv.slice(2),
  environment: {
    cwd: string;
    persistence_dir?: string;
    stdin: Readable;
    stdout: Writable;
    stderr: Writable;
    env?: Readonly<Record<string, string | undefined>>;
    execute_integration_probe?: (file: string, args: readonly string[]) => string;
    /** Launch-boundary injection for deterministic production-runtime acceptance tests. */
    runtime_factory?: (cwd: string, persistenceDir?: string) => ArborRuntime;
    /** `session start` test-only seam: how long to wait for a live session to register before reporting `null`. */
    live_session_attach_timeout_ms?: number;
  } = {
    cwd: process.cwd(), persistence_dir: process.env.ARBOR_PERSISTENCE_DIR, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
  },
  shutdownGate?: ShutdownGate,
): Promise<number> {
  if (environment.env === undefined) {
    loadProjectEnvironment(environment.cwd, process.env, resolvePersistenceDir(environment.cwd, environment.persistence_dir));
    // User scope after project scope: a project placeholder must not shadow the operator's key.
    loadUserEnvironment(process.env);
    environment = { ...environment, persistence_dir: environment.persistence_dir ?? process.env.ARBOR_PERSISTENCE_DIR };
  }
  const safeModeRequested = args.includes("--safe-mode");
  if (safeModeRequested) args = args.filter((argument) => argument !== "--safe-mode");
  // ADR-099 2 asks for the connector demotion to be named "at campaign start",
  // not on every invocation. A read-only inspection command that merely builds
  // a runtime must not emit it — `debug prompt-input` asserts an empty stderr,
  // and more generally an operator running `config get` has not chosen an
  // execution mode and does not need to be told one was demoted.
  // A --json invocation emits only machine-readable output. `resume --json`
  // in particular routes its payload to stderr by status, which is the same
  // stream this notice would use, so an unguarded write corrupts the document
  // its caller is about to parse.
  // ADR-107 4: `session start` admits a campaign exactly like `task`/`resume`
  // do, so it is a campaign-dispatching command too — but only that one
  // `session` subcommand; `session availability|resume|fork|identity` never
  // dispatch a campaign and must stay silent, same as every other read/
  // continuation command args[0]-membership alone already excludes.
  const dispatchesCampaign = (CAMPAIGN_DISPATCHING_COMMANDS.has(args[0] ?? "") || (args[0] === "session" && args[1] === "start")) && !args.includes("--json");
  const runtimeOptions: CliRuntimeOptions = {
    safeMode: safeModeRequested,
    env: environment.env ?? process.env,
    ...(dispatchesCampaign ? { onNotice: (message: string) => environment.stderr.write(`${message}\n`) } : {}),
  };
  if (args[0] === "--version" || args[0] === "-V") {
    const packageFile = fileURLToPath(new URL("../package.json", import.meta.url));
    const version = (JSON.parse(readFileSync(packageFile, "utf8")) as { version?: unknown }).version;
    environment.stdout.write(`arbor ${typeof version === "string" ? version : "development"}\n`);
    return EXIT_CODES.SUCCESS;
  }
  if (args[0] === "capabilities") {
    if (args.length > 1 && args[1] !== "--json") {
      environment.stderr.write("Usage: arbor capabilities [--json]\n");
      return EXIT_CODES.USAGE;
    }
    const { CAPABILITY_INDEX } = await import("./capability-index.js");
    environment.stdout.write(`${JSON.stringify(CAPABILITY_INDEX, null, 2)}\n`);
    return EXIT_CODES.SUCCESS;
  }
  if (args[0] === "native-auth" && args[1] === "openrouter" && args[2] === "login") {
    try { await loginOpenRouterOAuth({ output: (message) => environment.stdout.write(`${message}\n`), env: environment.env as NodeJS.ProcessEnv | undefined }); return EXIT_CODES.SUCCESS; }
    catch (error) { environment.stderr.write(`${error instanceof Error ? error.message : "OpenRouter OAuth login failed"}\n`); return EXIT_CODES.USAGE; }
  }
  if (args[0] === "flight") {
    return repoFlightCommand(args.slice(1), environment, shutdownGate);
  }
  if (args[0] === "control") {
    const runtime = createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions);
    shutdownGate?.bind(runtime);
    try {
      return await runDistributedControlCli(args.slice(1), {
        cwd: environment.cwd,
        env: environment.env ?? process.env,
        stdout: environment.stdout,
        stderr: environment.stderr,
        shutdown: shutdownGate?.signal,
        ingress: new RemoteRuntimeIngress(new RuntimeCatalogRouter(runtime), runtime.remoteSessionAuthority),
      });
    } finally {
      await boundedRuntimeClose(runtime);
    }
  }
  if (args[0] === "remote-grant") {
    const persistence = resolvePersistenceDir(environment.cwd, environment.persistence_dir); const lock = takeWriterLock(persistence, "remote-grant", environment.stderr); if (!lock) return EXIT_CODES.CONFLICT;
    try {
      const authority = new RemoteOperationTokenAuthority({ persistence_dir: persistence });
      if (args[1] === "consent") { const grant = flagValue(args.slice(2), "--grant"); if (!grant) return EXIT_CODES.USAGE; environment.stdout.write(`${JSON.stringify(authority.consent(grant))}\n`); return EXIT_CODES.SUCCESS; }
      // WA-45: revoke an outstanding grant before its TTL expires.
      if (args[1] === "revoke") { const grant = flagValue(args.slice(2), "--grant"); const reason = flagValue(args.slice(2), "--reason"); if (!grant || !reason) { environment.stderr.write("Usage: arbor-mcp remote-grant revoke --grant <id> --reason <text>\n"); return EXIT_CODES.USAGE; } environment.stdout.write(`${JSON.stringify(authority.revoke(grant, reason))}\n`); return EXIT_CODES.SUCCESS; }
      if (args[1] !== "issue") { environment.stderr.write("Usage: arbor-mcp remote-grant <issue|consent|revoke> --session <id> --campaign <id> --operation <id> --capability <command.dispatch|result.submit> [--sensitive] [--ttl-ms <30000..300000>]\n"); return EXIT_CODES.USAGE; }
      const rest = args.slice(2); const session = flagValue(rest, "--session"); const campaign = flagValue(rest, "--campaign"); const operation = flagValue(rest, "--operation"); const capability = flagValue(rest, "--capability"); const ttl = Number(flagValue(rest, "--ttl-ms") ?? "60000");
      if (!session || !campaign || !operation || (capability !== "command.dispatch" && capability !== "result.submit")) return EXIT_CODES.USAGE;
      const issued = authority.issue({ session_id: session, campaign_id: campaign, operation_id: operation, capabilities: [capability], sensitive: rest.includes("--sensitive") }, ttl);
      environment.stdout.write(`${JSON.stringify(issued)}\n`); return EXIT_CODES.SUCCESS;
    } finally { lock.release(); }
  }
  if (args[0] === "remote-serve") {
    const hostName = flagValue(args.slice(1), "--host") ?? "127.0.0.1";
    const portValue = Number(flagValue(args.slice(1), "--port") ?? "0");
    if (!Number.isSafeInteger(portValue) || portValue < 0 || portValue > 65535) { environment.stderr.write("Usage: arbor-mcp remote-serve --host <host> --port <port> [--tls-key <path> --tls-cert <path>] [--allow-wildcard]\n"); return EXIT_CODES.USAGE; }
    const persistence = resolvePersistenceDir(environment.cwd, environment.persistence_dir); const lock = takeWriterLock(persistence, "remote-serve", environment.stderr); if (!lock) return EXIT_CODES.CONFLICT;
    try {
      const runtime = createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions); shutdownGate?.bind(runtime);
      const keyPath = flagValue(args.slice(1), "--tls-key"); const certPath = flagValue(args.slice(1), "--tls-cert");
      if ((keyPath === null) !== (certPath === null)) { environment.stderr.write("remote-serve requires both --tls-key and --tls-cert\n"); return EXIT_CODES.USAGE; }
      // ADR-028: this router is handed to a transport that accepts instructions from a
      // party it does not control (the remote-serve HTTP listener) — the exact case
      // ADR-028's caller_tier gate exists for. Every other RuntimeCatalogRouter in this
      // file is a trusted in-process composition root and stays on the "senior" default;
      // only this one is constructed with caller_tier: "junior". RemoteOperationTokenAuthority
      // grants (issued via `remote-grant`) are a transport capability policy layered on top —
      // per ADR-028 O3, a junior-tier caller cannot reach any mutating catalog kind no matter
      // what grants it holds, so a grant can widen which kinds are reachable but can never
      // raise the caller's tier.
      // DECIDED 2026-08-24 — ADR-084 path 3: this transport is senior-only, and
      // the tier gate is NOT what protects it. Authentication is: signed
      // envelopes bound to a verified actor, plus RemoteOperationTokenAuthority
      // grants. Wiring caller_tier: "junior" would refuse 100% of this surface
      // (RemoteRuntimeIngress forwards only commands, catalogActionClass maps
      // every command to preview-confirm, and preview-confirm requires senior),
      // so the senior default here is a decision, not an oversight.
      const remoteRouter = new RuntimeCatalogRouter(runtime);
      const listener = createAuthenticatedRemoteHttpHost(new RemoteRuntimeIngress(remoteRouter, runtime.remoteSessionAuthority), new RemoteOperationTokenAuthority({ persistence_dir: persistence }), new RemoteResultReconciler(new LocalPatchApplicabilityVerifier(environment.cwd), { persistence_dir: persistence }), { enabled: true, host: hostName, port: portValue, allow_wildcard_bind: args.includes("--allow-wildcard"), ...(keyPath && certPath ? { tls: { key: readFileSync(resolve(keyPath)), cert: readFileSync(resolve(certPath)) } } : {}) });
      const address = await listener.start(); environment.stderr.write(`Authenticated remote listener: ${address.protocol}//${address.host}:${address.port}\n`);
      await (shutdownGate?.signal ?? new Promise<void>(() => {})); await listener.stop(); return EXIT_CODES.SUCCESS;
    } finally { lock.release(); }
  }
  if (args[0] === "serve") {
    const serveLock = takeWriterLock(resolvePersistenceDir(environment.cwd, environment.persistence_dir), "serve", environment.stderr);
    if (!serveLock) return EXIT_CODES.CONFLICT;
    try {
    const runtime = environment.runtime_factory?.(environment.cwd, environment.persistence_dir) ?? createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions);
    shutdownGate?.bind(runtime);
    // WA-10/ADR-028: an `arbor serve` stdio client is a party this process
    // does not fully control, unlike every other in-process composition root
    // in this file — so this router defaults to "junior": reads still work,
    // mutating catalog kinds are refused with a typed CapabilityError. Unlike
    // remote-serve (ADR-084), stdio's surface is NOT entirely mutating — 23
    // tools plus arbor_query/arbor_command cover real read kinds — so the
    // junior default degrades rather than disables the transport. Pass
    // --trusted-client (or set ARBOR_MCP_TRUSTED_CLIENT=1) only for an
    // operator-controlled stdio client that should keep full "senior" access.
    const trustedClient = args.includes("--trusted-client") || (environment.env ?? process.env).ARBOR_MCP_TRUSTED_CLIENT === "1";
    const { ArborMCPServer } = await import("./server.js");
    const server = new ArborMCPServer(runtime, trustedClient ? {} : { caller_tier: "junior" });
    const session = await startStdioSession(server, environment.stdin, environment.stdout);
    // S03: EOF (the client hanging up its stdio pipe) used to race the OS
    // shutdown signal with no shared cleanup — whichever settled first just
    // closed the session, so a client disconnect while a campaign was still
    // expanding left that campaign running unattended (the same "durably
    // expanding" defect the historical SIGINT bug had, reached by a
    // different door). `shutdownGate.trigger()` is idempotent (`triggered`
    // guard): if the OS signal already won the race and fired it, the call
    // below is a no-op; if EOF wins first, it runs the SAME owned
    // interrupt-then-ack sweep (`ShutdownGate.execute`) the signal path
    // runs — exactly once, whichever door was used to leave. Which promise
    // actually won is threaded through as the `ShutdownCause`, not
    // hardcoded, so the durable interruption record's `reason`/
    // `operation_id` say which door fired rather than always claiming a
    // SIGINT that may never have happened.
    const raceWinner = await Promise.race([
      new Promise<"eof">((resolveEof) => environment.stdin.once("end", () => resolveEof("eof"))),
      (shutdownGate?.signal ?? new Promise<void>(() => {})).then((): "signal" => "signal"),
    ]);
    if (raceWinner === "eof") shutdownGate?.trigger("client_disconnect");
    await (shutdownGate?.signal ?? Promise.resolve());
    await session.close();
    return EXIT_CODES.SUCCESS;
    } finally { serveLock.release(); }
  }
  if (args[0] === "acp") {
    const acpLock = takeWriterLock(resolvePersistenceDir(environment.cwd, environment.persistence_dir), "acp", environment.stderr);
    if (!acpLock) return EXIT_CODES.CONFLICT;
    const runtime = environment.runtime_factory?.(environment.cwd, environment.persistence_dir) ?? createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions);
    shutdownGate?.bind(runtime);
    const journey = new AcpIdeJourney(createAcpIdeRuntimePort(runtime));
    try {
      const started = await runtime.start();
      if (!started.ok) throw new Error(started.failures.map((failure) => failure.summary).join("; ") || "runtime did not start");
      await runAcpIdeStdio(journey, environment.stdin, environment.stdout);
      return EXIT_CODES.SUCCESS;
    } finally {
      journey.close();
      await boundedRuntimeClose(runtime);
      acpLock.release();
    }
  }
  // ADR-030. A read-only subcommand, so it is safe to run against any
  // checkout: mutating seams are reported as unprobed rather than invoked.
  // This is also what makes the attestation machinery reachable by execution
  // rather than by waiver — `gate:liveness` is a real process entry, but the
  // 6.2 walker's root set is scoped to `packages/*/src` and cannot see a
  // `scripts/` root, so a gate script alone would leave the runner
  // permanently unreachable and needing an allowlist entry it does not
  // deserve.
  if (args[0] === "liveness") {
    const report = await runLiveness({ at: new Date().toISOString(), includeMutating: false });
    environment.stdout.write(`${formatLivenessReport(report)}\n`);
    const broken = report.summary.catalog_unreachable + report.summary.consumers_unreachable;
    return broken > 0 ? EXIT_CODES.CONFLICT : EXIT_CODES.SUCCESS;
  }
  if (args[0] === "flight-control-stress") {
    const workRoot = flagValue(args.slice(1), "--work-root") ?? undefined;
    const report = await runFlightControlStress({
      scenario_id: flagValue(args.slice(1), "--scenario") ?? undefined,
      work_root: workRoot === undefined ? undefined : resolve(environment.cwd, workRoot),
      keep_artifacts: args.includes("--keep-artifacts"),
    });
    environment.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
  }
  if (args[0] === "doctor" && args[1] === "reconcile") {
    const supported = new Set(["--json", "--apply"]);
    const unknown = args.slice(2).find((flag) => !supported.has(flag));
    if (unknown) throw new Error(`Unknown doctor reconcile option: ${unknown}`);
    const plan = planPersistenceReconciliation(resolvePersistenceDir(environment.cwd, environment.persistence_dir));
    const applied = args.includes("--apply") ? applyPersistenceReconciliation(plan) : null;
    environment.stdout.write(`${args.includes("--json") ? JSON.stringify(applied ?? plan, null, 2) : formatReconcilePlan(plan, applied)}\n`);
    return plan.actions.length === 0 || applied !== null ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
  }
  if (args[0] === "doctor") {
    // Q1: never construct a real `ArborRuntime` here — see
    // `createDoctorReadiness`'s doc comment for exactly which constructors
    // that would otherwise trigger `mkdirSync`s a read-only diagnostic must
    // not perform.
    const readiness = createDoctorReadiness(environment.cwd);
    const nativeReadinessProjection = readiness.inspect();
    // Parity gap #4: pass the already-computed native readiness through so
    // ARBOR_HARNESS_INTEGRATION=native reports real native health instead of
    // "unsupported integration id" — see inspectHarnessIntegrationEnvironment's
    // doc comment in doctor.ts.
    const integrationProbe = environment.execute_integration_probe === undefined
      ? inspectHarnessIntegrationEnvironment(environment.env ?? process.env, undefined, nativeReadinessProjection)
      : inspectHarnessIntegrationEnvironment(environment.env ?? process.env, environment.execute_integration_probe, nativeReadinessProjection);
    // Q2: reword native-config remediation as optional once a ready
    // connector makes it a genuine alternative, not a requirement.
    const projection = reflectHarnessIntegrationAlternative(nativeReadinessProjection, integrationProbe);
    const persistenceDirForDoctor = resolvePersistenceDir(environment.cwd, environment.persistence_dir);
    const report = buildUnifiedDoctor({
      cwd: environment.cwd, persistence_dir: persistenceDirForDoctor, config: buildConfigInspection(environment.cwd).inspect(), readiness: projection, integration: integrationProbe,
      connectors: [{ connector_id: projection.adapter.adapter_id ?? "native-unconfigured", status: projection.adapter.availability === "available" ? "ready" : "unavailable", capabilities: projection.adapter.adapter_id === null ? [] : ["model.inference"], detail: projection.adapter.implementation_id ?? projection.adapter.availability }],
      streams: { stdin: (environment.stdin as Readable & { isTTY?: boolean }).isTTY === true, stdout: (environment.stdout as Writable & { isTTY?: boolean }).isTTY === true, stderr: (environment.stderr as Writable & { isTTY?: boolean }).isTTY === true },
    });
    // WA-03: for a project that is already enrolled (its persistence dir
    // already exists), compose `operational.*` through the exact runtime
    // path `doctor.get` uses (`ArborRuntime.inspectOperatorDoctor()`), so the
    // CLI and catalog projections cannot drift. Constructing a full
    // `ArborRuntime` for a project that was never enrolled would itself
    // create `.arbor/` purely from running a diagnostic — see the Q1 comment
    // above — so that case is left exactly as before: `operational.*` reads
    // `unobserved`.
    let finalReport = report;
    if (existsSync(persistenceDirForDoctor)) {
      const doctorRuntime = createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions);
      try {
        const composed = doctorRuntime.inspectOperatorDoctor();
        if (composed !== null) finalReport = { ...report, operational: composed.operational };
      } finally { await closeRuntimeOrThrow(doctorRuntime); }
    }
    const operator = inspectOperatorEnvironment({
      cwd: environment.cwd,
      persistence_dir: resolvePersistenceDir(environment.cwd, environment.persistence_dir),
      streams: { stdin: (environment.stdin as Readable & { isTTY?: boolean }).isTTY === true, stdout: (environment.stdout as Writable & { isTTY?: boolean }).isTTY === true, stderr: (environment.stderr as Writable & { isTTY?: boolean }).isTTY === true },
      env: environment.env ?? process.env,
      native_credential_present: projection.credential.present,
      harness_integration: integrationProbe,
    });
    const humanReport = [
      formatUnifiedDoctor(finalReport),
      "Native execution detail",
      formatNativeHarnessReadiness(projection),
      "Operator environment detail",
      formatOperatorDoctor(operator),
    ].join("\n\n");
    environment.stdout.write(`${args.includes("--json") ? JSON.stringify(finalReport, null, 2) : humanReport}\n`);
    const integrationUnavailable = !report.integration.executable_present || report.integration.authenticated === false;
    return projection.execution.kind === "unavailable" || integrationUnavailable || !report.persistence.inventory_agrees ? EXIT_CODES.CONFLICT : EXIT_CODES.SUCCESS;
  }
  if (args[0] === "migrate") {
    const subcommand = args[1] ?? "inspect"; const rest = args.slice(2); const json = rest.includes("--json");
    const sourceIndex = rest.indexOf("--from"); const sourcePath = sourceIndex >= 0 ? rest[sourceIndex + 1] : undefined;
    try {
      if (subcommand === "inspect") { const report = inspectMigration(environment.cwd); environment.stdout.write(`${json ? JSON.stringify(report, null, 2) : `${report.compatibility.status}: ${report.compatibility.detail}`}\n`); return EXIT_CODES.SUCCESS; }
      if (subcommand === "preview" && sourcePath) { const report = previewMigration({ cwd: environment.cwd, source_path: sourcePath }); environment.stdout.write(`${json ? JSON.stringify(report, null, 2) : `preview ${report.source.kind}: ${report.source.sha256}\nnext: arbor migrate apply --from ${sourcePath} --expected-source-sha256 ${report.source.sha256}${report.target.overwrite_required ? " --overwrite" : ""}`}\n`); return EXIT_CODES.SUCCESS; }
      if (subcommand === "apply" && sourcePath) { const digestIndex = rest.indexOf("--expected-source-sha256"); const digest = digestIndex >= 0 ? rest[digestIndex + 1] : undefined; if (!digest) throw new Error("apply requires --expected-source-sha256 from preview"); const receipt = applyMigration({ cwd: environment.cwd, source_path: sourcePath, expected_source_sha256: digest, overwrite: rest.includes("--overwrite") }); environment.stdout.write(`${json ? JSON.stringify(receipt, null, 2) : `migration applied; rollback receipt: ${receipt.receipt_id}`}\n`); return EXIT_CODES.SUCCESS; }
      if (subcommand === "rollback" && rest[0]) { const receipt = rollbackMigration({ cwd: environment.cwd, receipt_id: rest[0] }); environment.stdout.write(`${json ? JSON.stringify(receipt, null, 2) : `migration rolled back: ${receipt.receipt_id}`}\n`); return EXIT_CODES.SUCCESS; }
      environment.stderr.write("Usage: arbor migrate <inspect|preview|apply|rollback> [--from <path>] [--expected-source-sha256 <sha256>] [--overwrite] [--json]\n"); return EXIT_CODES.USAGE;
    } catch (error) { environment.stderr.write(`migration refused: ${error instanceof Error ? error.message : String(error)}\n`); return EXIT_CODES.CONFLICT; }
  }
  if (args[0] === "integration" || args[0] === "remote") {
    const remote = args[0] === "remote"; const action = remote ? "remote.control" : (args[1] ?? "list"); const rest = remote ? args.slice(1) : args.slice(2); const runtime = createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions); const router = new RuntimeCatalogRouter(runtime);
    try {
      const metadata = (operation_id: string) => ({ operation_id, idempotency_key: operation_id, correlation_id: operation_id, actor_id: "cli-operator", requested_at: new Date().toISOString() });
      if (remote && rest[0] === "revoke" && rest[1]) { const value = await router.dispatchCommand({ schema_version: 1, metadata: metadata(`cli-remote-revoke-${rest[1]}`), command: { kind: "remote.control", action: "revoke", session_id: rest[1], acknowledge_risk: false, provenance: { tag: "claimed", claimant: "cli-operator" } } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
      if (!remote && action === "scheduler" && (["suspend", "resume"] as readonly string[]).includes(rest[0] ?? "") && rest[1]) { const value = await router.dispatchCommand({ schema_version: 1, metadata: metadata(`cli-scheduler-${rest[0]}-${rest[1]}`), command: { kind: "scheduler.control", action: rest[0], schedule_id: rest[1], ...(rest[0] === "suspend" ? { reason: rest.slice(2).join(" ") || "cli operator suspended schedule" } : {}), acknowledge_risk: false, provenance: { tag: "claimed", claimant: "cli-operator" } } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
      if (remote || action === "list" || action === "inspect" || action === "admit" || action === "scheduler") {
        const kind = remote ? "remote.inspect" : action === "list" ? "integration.list" : action === "inspect" ? "integration.inspect" : action === "admit" ? "integration.admit" : "scheduler.inspect";
        const id = rest[0]; const value = router.executeQuery({ schema_version: 1, query_id: `cli-${kind}`, query: { kind, ...(id ? { integration_id: id } : {}), ...(action === "admit" ? { capabilities: rest.slice(1) } : {}) } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
      }
      if (["install", "enable", "disable", "update", "rollback"].includes(action)) {
        const lifecycleAction = action as ExtensionLifecycleAction; const id = rest[0]; const version = lifecycleAction === "update" ? rest[1] : undefined; if (!id) throw new Error("integration id is required"); const operation = `cli-integration-${lifecycleAction}-${id}`;
        const pluginManifestPath = flagValue(rest, "--plugin-manifest"); const pluginRoot = flagValue(rest, "--plugin-root");
        if (id.startsWith("extension.") && (lifecycleAction === "install" || lifecycleAction === "update") && (!pluginManifestPath || !pluginRoot)) throw new Error("extension install/update requires --plugin-manifest <path> and --plugin-root <path>");
        const plugin_manifest = pluginManifestPath === null ? undefined : readFileSync(resolve(environment.cwd, pluginManifestPath), "utf8");
        const value = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: operation, idempotency_key: operation, correlation_id: operation, actor_id: "cli-operator", requested_at: new Date().toISOString() }, command: { kind: INTEGRATION_LIFECYCLE_KIND[lifecycleAction], integration_id: id, ...(version ? { version } : {}), ...(plugin_manifest === undefined ? {} : { plugin_manifest }), ...(pluginRoot === null ? {} : { plugin_root: resolve(environment.cwd, pluginRoot) }), acknowledge_risk: rest.includes("--acknowledge-risk"), provenance: { tag: "claimed", claimant: "cli-operator" } } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok && (value.value as { accepted?: unknown }).accepted === true ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
      }
      environment.stderr.write("Usage: arbor integration <list|inspect|admit|install|enable|disable|update|rollback|scheduler> ... [--plugin-manifest <path> --plugin-root <path>] [--acknowledge-risk]\n"); return EXIT_CODES.USAGE;
    } finally { await closeRuntimeOrThrow(runtime); }
  }
  if (args[0] === "session" && args[1] === "start") {
    return sessionStartCommand(args.slice(2), { ...environment, safe_mode: safeModeRequested });
  }
  if (args[0] === "repo-session") {
    return repoSessionLifecycleCommand(args.slice(1), environment);
  }
  // Internal, and deliberately not verbs: the pre-commit hook needs an exit code
  // rather than a report, and the stranded-window remedy the lifecycle's own
  // messages print has to name a command that exists.
  if (args[0] === "repo-session-assert-window") {
    return repoSessionAssertWindowCommand(environment);
  }
  if (args[0] === "repo-session-reconcile") {
    return repoSessionReconcileCommand(args.slice(1), environment);
  }
  if (args[0] === "session") {
    const action = args[1] ?? "availability";
    const runtime = createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions); const router = new RuntimeCatalogRouter(runtime);
    try {
      if (action === "identity") {
        const identityAction = args[2] ?? "search"; const id = args[3];
        if (identityAction === "get" && id) { const value = router.executeQuery({ schema_version: 1, query_id: `cli-session-identity-${id}`, query: { kind: "session.identity.get", session_id: id } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
        if (identityAction === "search") { const query = args[3]; const value = router.executeQuery({ schema_version: 1, query_id: "cli-session-identity-search", query: { kind: "session.identity.search", ...(query ? { query } : {}), limit: 100 } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
        if (identityAction === "set" && id) { const nameAt = args.indexOf("--name"); const tagsAt = args.indexOf("--tags"); const operation = `cli-session-identity-${id}`; const value = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: operation, idempotency_key: operation, correlation_id: operation, actor_id: "cli-operator", requested_at: new Date().toISOString() }, command: { kind: "session.identity.mutate", session_id: id, ...(nameAt >= 0 ? { display_name: args[nameAt + 1] ?? null } : {}), ...(tagsAt >= 0 ? { tags: (args[tagsAt + 1] ?? "").split(",").filter(Boolean) } : {}), provenance: { tag: "claimed", claimant: "cli-operator" } } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
        environment.stderr.write("Usage: arbor session identity <get|search|set> [session-id] [--name <name>] [--tags a,b]\n"); return EXIT_CODES.USAGE;
      }
      const sessionId = args[2]; if (!sessionId) { environment.stderr.write("Usage: arbor session <availability|resume|fork|respawn> <session-id> [--reason <text>] [--disposition <operation-id>=<decision>]\n"); return EXIT_CODES.USAGE; }
      if (action === "availability") { const value = router.executeQuery({ schema_version: 1, query_id: `cli-session-availability-${sessionId}`, query: { kind: "harness.session.availability", session_id: sessionId } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
      if (!["resume", "fork", "respawn"].includes(action)) { environment.stderr.write("session action must be availability, resume, fork, or respawn\n"); return EXIT_CODES.USAGE; }
      const reasonAt = args.indexOf("--reason"); const reason = reasonAt >= 0 ? args[reasonAt + 1] : "cli operator requested governed session continuation"; if (!reason) { environment.stderr.write("--reason requires text\n"); return EXIT_CODES.USAGE; }
      // WA-33: parsed exactly like `recover`/`resume`'s own `--disposition
      // <operation_id>=<decision>`, instead of hardcoding `dispositions: []`
      // — a continuation whose plan requires a disposition was otherwise
      // unauthorizable from this branch.
      const sessionDispositions = parseRecoveryDispositions(flagValues(args.slice(3), "--disposition"));
      if (!sessionDispositions.ok) { environment.stderr.write(`${sessionDispositions.reason}\n`); return EXIT_CODES.USAGE; }
      const operation = `cli-session-${action}-${sessionId}`;
      const value = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: operation, idempotency_key: operation, correlation_id: operation, actor_id: "cli-operator", requested_at: new Date().toISOString(), session: {} }, command: { kind: `harness.session.${action}`, session_id: sessionId, reason, dispositions: sessionDispositions.value, provenance: { tag: "claimed", claimant: "cli-operator" } } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
    } finally { await closeRuntimeOrThrow(runtime); }
  }
  if (args[0] === "resume") {
    const rest = args.slice(1); const json = rest.includes("--json"); const preview = rest.includes("--preview");
    const supportedFlags = new Set(["--json", "--preview", "--reason", "--actor", "--disposition"]);
    const valueFlags = new Set(["--reason", "--actor", "--disposition"]);
    const positionals = rest.filter((value, index) => !value.startsWith("--") && !valueFlags.has(rest[index - 1] ?? ""));
    const unknown = rest.find((value) => value.startsWith("--") && !supportedFlags.has(value));
    if (unknown !== undefined || positionals.length > 1) {
      environment.stderr.write("Usage: arbor resume [session-id] [--preview] [--disposition <operation>=<decision>] [--reason <text>] [--actor <id>] [--json]\n");
      return EXIT_CODES.USAGE;
    }
    const reason = flagValue(rest, "--reason"); const actor = flagValue(rest, "--actor");
    const dispositions = parseRecoveryDispositions(flagValues(rest, "--disposition"));
    if (!dispositions.ok) { environment.stderr.write(`${dispositions.reason}\n`); return EXIT_CODES.USAGE; }
    if ((rest.includes("--reason") && !reason) || (rest.includes("--actor") && !actor)) {
      environment.stderr.write("--reason and --actor require non-empty values\n"); return EXIT_CODES.USAGE;
    }
    const runtime = environment.runtime_factory?.(environment.cwd, environment.persistence_dir) ?? createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions);
    try {
      // WA-29: without `recovery_service`, every `recovery.retry`/
      // `recovery.abandon` this router might dispatch is rejected
      // "recovery service is not configured" — see how tui.ts/server.ts
      // construct their own routers.
      const router = new RuntimeCatalogRouter(runtime, { recovery_service: runtime.recoveryService ?? undefined });
      const result = await resumeInterruptedWork({
        runtime,
        dispatch: (envelope) => router.dispatchCommand(envelope),
        ...(positionals[0] === undefined ? {} : { requested_session_id: positionals[0] }),
        ...(reason == null ? {} : { reason }),
        ...(actor == null ? {} : { actor_id: actor }),
        preview,
        dispositions: dispositions.value,
      });
      const output = json ? JSON.stringify(result, null, 2) : formatOperatorResume(result);
      (result.status === "ambiguous" || result.status === "unavailable" || result.status === "rejected" ? environment.stderr : environment.stdout).write(`${output}\n`);
      return result.status === "ambiguous" || result.status === "unavailable" || result.status === "rejected" ? EXIT_CODES.CONFLICT : EXIT_CODES.SUCCESS;
    } finally { await closeRuntimeOrThrow(runtime); }
  }
  if (args[0] === "verification" || args[0] === "notification" || args[0] === "followup") {
    const domain = args[0]; const action = args[1] ?? "list"; const subject = args[2]; const runtime = createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions); const router = new RuntimeCatalogRouter(runtime);
    try {
      if (domain === "verification") {
        if (action === "get" && subject && args[3]) { const value = router.executeQuery({ schema_version: 1, query_id: `cli-verification-${subject}-${args[3]}`, query: { kind: "result.verification.get", campaign_id: subject, node_id: args[3] } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
        if (action === "list" && subject) { const value = router.executeQuery({ schema_version: 1, query_id: `cli-verification-${subject}`, query: { kind: "result.verification.list", campaign_id: subject, limit: 100 } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
      }
      if (domain === "notification") {
        if (action === "list") { const value = router.executeQuery({ schema_version: 1, query_id: "cli-notification-list", query: { kind: "notification.list", ...(subject ? { project_id: subject } : {}), unread_only: args.includes("--unread"), limit: 100 } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
        if (action === "read" && subject) { const operation = `cli-notification-read-${subject}`; const value = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: operation, idempotency_key: operation, correlation_id: operation, actor_id: "cli-operator", requested_at: new Date().toISOString() }, command: { kind: "notification.read", notification_id: subject } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
      }
      if (domain === "followup") {
        if (action === "list" && subject) { const value = router.executeQuery({ schema_version: 1, query_id: `cli-followup-${subject}`, query: { kind: "followup.list", parent_campaign_id: subject, limit: 100 } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
        if (action === "create" && subject) { const resultAt = args.indexOf("--source-result"); const nodeAt = args.indexOf("--source-node"); const source = (at: number) => at < 0 ? null : (() => { const [campaign_id, node_id] = (args[at + 1] ?? "").split(":", 2); return campaign_id && node_id ? { campaign_id, node_id } : null; })(); const operation = `cli-followup-${subject}-${args[resultAt + 1] ?? args[nodeAt + 1] ?? "source"}`; const value = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: operation, idempotency_key: operation, correlation_id: operation, actor_id: "cli-operator", requested_at: new Date().toISOString() }, command: { kind: "followup.create", parent_campaign_id: subject, source_result: source(resultAt), source_node: source(nodeAt), provenance: { tag: "claimed", claimant: "cli-operator" } } } as never); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
      }
      // WA-21: state the mandatory campaign id explicitly — every real
      // verification/followup dispatch above requires `subject` (the
      // campaign id) to even attempt the query/command; only `notification`
      // is campaign-optional.
      environment.stderr.write("Usage: arbor verification <get <campaign-id> <node-id>|list <campaign-id>> | notification <list [project-id] [--unread]|read <notification-id>> | followup <list <campaign-id>|create <campaign-id> [--source-result <campaign:node>] [--source-node <campaign:node>]>\n"); return EXIT_CODES.USAGE;
    } finally { await closeRuntimeOrThrow(runtime); }
  }
  if (args[0] === "setup") {
    const supported = new Set(["setup", "--dry-run", "--json"]);
    const unknown = args.find((argument) => !supported.has(argument));
    if (unknown !== undefined) {
      environment.stderr.write(`Unknown setup option: ${unknown}\nUsage: arbor setup [--dry-run] [--json]\n`);
      return EXIT_CODES.USAGE;
    }
    const result = setupProject(environment.cwd, args.includes("--dry-run"), resolvePersistenceDir(environment.cwd, environment.persistence_dir));
    environment.stdout.write(`${args.includes("--json") ? JSON.stringify(result, null, 2) : formatSetupResult(result)}\n`);
    return EXIT_CODES.SUCCESS;
  }
  if (args[0] === "project") {
    const subcommand = args[1] ?? "status";
    const rest = args.slice(2);
    const json = rest.includes("--json");
    const flags = new Set(rest.filter((item) => item.startsWith("--")));
    const path = rest.find((item) => !item.startsWith("--")) ?? environment.cwd;
    try {
      if (subcommand === "status") {
        const supported = new Set(["--json"]);
        const unknown = [...flags].find((flag) => !supported.has(flag));
        if (unknown) throw new Error(`Unknown project status option: ${unknown}`);
        const result = inspectProjectOverlay(path);
        environment.stdout.write(`${json ? JSON.stringify(result, null, 2) : formatProjectLifecycle(result)}\n`);
        return result.state === "ready" ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
      }
      if (subcommand === "enroll") {
        const supported = new Set(["--json", "--dry-run", "--new", "--backfill"]);
        const unknown = [...flags].find((flag) => !supported.has(flag));
        if (unknown) throw new Error(`Unknown project enroll option: ${unknown}`);
        if (flags.has("--new") && flags.has("--backfill")) throw new Error("Project enrollment accepts only one of --new or --backfill.");
        const mode = flags.has("--new") ? "new" : flags.has("--backfill") ? "backfill" : "existing";
        const result = enrollProject(path, { mode, dry_run: flags.has("--dry-run") });
        // Roadmap 23 W2 (ADR-076): a successful, non-preview enrollment
        // records a registry entry with its discharge established at this
        // moment — running conformance now, not asserting it. A dry-run
        // previews the overlay only and never touches the registry, and an
        // overlay that did not reach "ready" has nothing to register.
        // Registration is opportunistic on the profile, not on the overlay:
        // a profile-less enrollment (derivation refused — no .git or no
        // package.json to read) has nothing to hash or discharge, and that
        // is an existing, unrelated outcome the overlay's own "ready" state
        // already covers. Only when a profile actually exists is there a
        // claim worth making, and only then must that claim's discharge
        // succeed for `enroll` to report success.
        let registryOutcome: ReturnType<typeof registerProject> | null = null;
        if (!flags.has("--dry-run") && result.inspection.state === "ready" && result.inspection.manifest && existsSync(join(result.root, "arbor.profile.jsonc"))) {
          const persistenceDir = resolvePersistenceDir(environment.cwd, environment.persistence_dir);
          registryOutcome = registerProject(persistenceDir, result.root, result.inspection.manifest.project_id);
        }
        const humanOutput = registryOutcome ? `${formatProjectLifecycle(result)}\n\n${formatRegisterOutcome(registryOutcome)}` : formatProjectLifecycle(result);
        environment.stdout.write(`${json ? JSON.stringify(registryOutcome ? { ...result, registry: registryOutcome } : result, null, 2) : humanOutput}\n`);
        const overlayOk = flags.has("--dry-run") || result.inspection.state === "ready";
        // Only a FAILED DISCHARGE makes enrollment unsuccessful. A refusal for
        // want of provenance (`no_revision` — the normal state of `--new`
        // against a fresh directory, which has no commits yet) or of a profile
        // means there was no claim to make, not that the claim failed. Exiting
        // non-zero there would report a conformant, correctly enrolled project
        // as broken, and would do so on the single most common first-run path.
        // The refusal is still reported in both output modes either way.
        const registryOk = registryOutcome === null || registryOutcome.registered || registryOutcome.refusal !== "conformance_failed";
        return overlayOk && registryOk ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
      }
      if (subcommand === "repair") {
        const supported = new Set(["--json", "--apply"]);
        const unknown = [...flags].find((flag) => !supported.has(flag));
        if (unknown) throw new Error(`Unknown project repair option: ${unknown}`);
        const result = repairProjectOverlay(path, flags.has("--apply"));
        environment.stdout.write(`${json ? JSON.stringify(result, null, 2) : formatProjectLifecycle(result)}\n`);
        return EXIT_CODES.SUCCESS;
      }
      if (subcommand === "registry") {
        const action = rest[0];
        const registryRest = rest.slice(1);
        const registryJson = registryRest.includes("--json");
        const supported = new Set(["--json"]);
        const unknown = registryRest.find((flag) => flag.startsWith("--") && !supported.has(flag));
        if (unknown) throw new Error(`Unknown project registry option: ${unknown}`);
        const persistenceDir = resolvePersistenceDir(environment.cwd, environment.persistence_dir);
        if (action === "list") {
          const registry = loadProjectRegistry(persistenceDir);
          environment.stdout.write(`${registryJson ? JSON.stringify(registry, null, 2) : formatRegistryList(registry)}\n`);
          return EXIT_CODES.SUCCESS;
        }
        if (action === "verify") {
          const report = evaluateProjectRegistry(persistenceDir);
          environment.stdout.write(`${registryJson ? JSON.stringify(report, null, 2) : formatProjectRegistryReport(report)}\n`);
          return report.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.VIOLATION;
        }
        throw new Error(`Unknown project registry command: ${action ?? "(none)"}`);
      }
      if (subcommand === "manage") {
        const supported = new Set(["--json"]);
        const unknown = [...flags].find((flag) => !supported.has(flag));
        if (unknown) throw new Error(`Unknown project manage option: ${unknown}`);
        const persistenceDir = resolvePersistenceDir(environment.cwd, environment.persistence_dir);
        const report = manageProjects(persistenceDir);
        environment.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatProjectManageReport(report)}\n`);
        return report.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.VIOLATION;
      }
      throw new Error(`Unknown project command: ${subcommand}`);
    } catch (error) {
      environment.stderr.write(`${error instanceof Error ? error.message : String(error)}\nUsage: arbor project status [path] [--json]\n       arbor project enroll [path] [--new|--backfill] [--dry-run] [--json]\n       arbor project repair [path] [--apply] [--json]\n       arbor project registry list [--json]\n       arbor project registry verify [--json]\n       arbor project manage [--json]\n`);
      return EXIT_CODES.USAGE;
    }
  }
  if (args[0] === "debug" && args[1] === "prompt-input") {
    const rest = args.slice(2);
    const campaign = flagValue(rest, "--campaign");
    const node = flagValue(rest, "--node");
    const checkpointAt = flagValue(rest, "--checkpoint-at");
    if (!campaign || !node) {
      environment.stderr.write("Usage: arbor-mcp debug prompt-input --campaign <id> --node <id> [--checkpoint-at <ISO-8601>] [--json]\n");
      return EXIT_CODES.USAGE;
    }
    try {
      const runtime = createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions);
      const dump = await buildPromptInputDebugDump(runtime, {
        campaign_id: campaign,
        node_id: node,
        ...(checkpointAt === null ? {} : { checkpoint_at: checkpointAt }),
      });
      environment.stdout.write(`${JSON.stringify(dump, null, 2)}\n`);
      return EXIT_CODES.SUCCESS;
    } catch (error) {
      environment.stderr.write(`${error instanceof Error ? error.message : "prompt input projection failed"}\n`);
      return EXIT_CODES.FAILURE;
    }
  }
  if (args[0] === "task") {
    return taskComposerCommand(args.slice(1), { ...environment, safe_mode: safeModeRequested }, shutdownGate);
  }
  if (args[0] === "greenfield") {
    return greenfieldCommand(args.slice(1), { ...environment, safe_mode: safeModeRequested }, shutdownGate);
  }
  if (args[0] === "hook") {
    // WA-43/J3-21/J3-23: read-only inspection over the governed hook catalog
    // — the same `.arbor/hooks` directory `HookBus.fromDirectory` composes
    // at runtime (see line ~1405 above) — plus the canonical event catalog
    // derived from the closed contracts, never a hand-typed second list.
    const hookArgs = args.slice(1);
    const hookJson = hookArgs.includes("--json");
    const sub = hookArgs[0] ?? "list";
    if (sub === "events") {
      environment.stdout.write(`${hookJson ? JSON.stringify(HOOK_ALL_EVENTS, null, 2) : HOOK_ALL_EVENTS.join("\n")}\n`);
      return EXIT_CODES.SUCCESS;
    }
    if (sub === "list") {
      const catalog = HookCatalog.fromDirectory(join(environment.cwd, ".arbor", "hooks"));
      const hooks = catalog.list();
      const diagnostics = catalog.diagnostics();
      if (hookJson) { environment.stdout.write(`${JSON.stringify({ hooks, diagnostics }, null, 2)}\n`); return EXIT_CODES.SUCCESS; }
      environment.stdout.write(hooks.length === 0 ? "No valid hooks in .arbor/hooks.\n" : hooks.map((hook) => `${hook.hook_id}@${hook.version}  kind=${hook.kind}  event=${hook.event}  handler=${hook.handler_ref}\n  ${hook.why}\n`).join(""));
      for (const diagnostic of diagnostics) environment.stdout.write(`INVALID ${diagnostic.source}: ${diagnostic.code} — ${diagnostic.message}\n`);
      return EXIT_CODES.SUCCESS;
    }
    if (sub === "validate") {
      const bus = HookBus.fromDirectory(join(environment.cwd, ".arbor", "hooks"));
      const diagnostics = bus.diagnostics();
      const neverFired = bus.neverFired();
      if (hookJson) { environment.stdout.write(`${JSON.stringify({ diagnostics, never_fired: neverFired }, null, 2)}\n`); return diagnostics.length === 0 ? EXIT_CODES.SUCCESS : EXIT_CODES.VIOLATION; }
      for (const diagnostic of diagnostics) environment.stdout.write(`INVALID ${diagnostic.source}: ${diagnostic.code} — ${diagnostic.message}\n`);
      if (diagnostics.length === 0) environment.stdout.write("All hook descriptors are valid.\n");
      for (const hook of neverFired) environment.stdout.write(`NEVER FIRED ${hook.hook_id}@${hook.version} (event=${hook.event})\n`);
      return diagnostics.length === 0 ? EXIT_CODES.SUCCESS : EXIT_CODES.VIOLATION;
    }
    environment.stderr.write("Usage: arbor hook <list|validate|events> [--json]\n");
    return EXIT_CODES.USAGE;
  }
  if (args[0] === "command") {
    const commandArgs = args.slice(1);
    if (commandArgs[0] === "list") {
      const catalog = loadCommandCatalog(environment.cwd, environment.persistence_dir);
      environment.stdout.write(`${JSON.stringify({ commands: catalog.list(), diagnostics: catalog.diagnostics() }, null, 2)}\n`);
      return EXIT_CODES.SUCCESS;
    }
    const name = commandArgs[0];
    if (!name) { environment.stderr.write("Usage: arbor-mcp command <name> [arguments...] | command list\n"); return EXIT_CODES.USAGE; }
    try {
      const hooks = HookBus.fromDirectory(join(environment.cwd, ".arbor", "hooks"));
      const invoked = invokeUserCommand(loadCommandCatalog(environment.cwd, environment.persistence_dir), name, commandArgs.slice(1), hooks);
      const governedTask = `[governed-command:${invoked.command.name} role=${invoked.command.execution_role} tools=${invoked.effective_tools.join(",")} skill=${invoked.command.skill_id ?? "none"}]\n${invoked.rendered_prompt}`;
      const selectedSkillId = invoked.command.skill_version === undefined ? null : invoked.command.skill_id;
      const commandBinding: TaskComposerCommandBinding = {
        name: invoked.command.name,
        execution_role: invoked.command.execution_role,
        allowed_tools: invoked.effective_tools,
        skill_id: selectedSkillId,
        ...(selectedSkillId === null || invoked.command.skill_version === undefined ? {} : { skill_version: invoked.command.skill_version }),
        ...(invoked.skill_inputs_hash === null ? {} : {
          skill_inputs: invoked.skill_inputs,
          skill_inputs_hash: invoked.skill_inputs_hash,
          descriptor_hash: `sha256:${invoked.command.descriptor_hash}`,
        }),
      };
      return taskComposerCommand([governedTask], { ...environment, safe_mode: safeModeRequested }, shutdownGate, commandBinding);
    } catch (error) {
      environment.stderr.write(`${error instanceof Error ? error.message : "command invocation failed"}\n`);
      return EXIT_CODES.VIOLATION;
    }
  }
  if (args[0] === "plugin") {
    try {
      const registry = new PluginRegistry({ trusted_keys: loadPluginTrust(environment.cwd), persistence_dir: resolvePersistenceDir(environment.cwd, environment.persistence_dir) });
      const action = args[1];
      if (action === "list") { environment.stdout.write(`${JSON.stringify(registry.list(), null, 2)}\n`); return EXIT_CODES.SUCCESS; }
      if (action === "inspect" && args[2]) { const plugin = registry.inspect(args[2]); if (plugin === null) return EXIT_CODES.CONFLICT; environment.stdout.write(`${JSON.stringify(plugin, null, 2)}\n`); return EXIT_CODES.SUCCESS; }
      if (["install", "enable", "disable", "update", "rollback"].includes(action ?? "")) { environment.stderr.write("Plugin lifecycle is unified under catalog-routed `arbor integration`; `plugin` is a read-only compatibility view.\n"); return EXIT_CODES.USAGE; }
      environment.stderr.write("Usage: arbor-mcp plugin <list|inspect> ...\n"); return EXIT_CODES.USAGE;
    } catch (error) {
      environment.stderr.write(`${error instanceof Error ? error.message : "plugin installation failed"}\n`);
      return EXIT_CODES.VIOLATION;
    }
  }
  if (args[0] === "extension" || args[0] === "integration-sdk") {
    try {
      const persistence = resolvePersistenceDir(environment.cwd, environment.persistence_dir);
      const sdk = () => new InstallableIntegrationSdk({ registry: new PluginRegistry({ trusted_keys: loadPluginTrust(environment.cwd), persistence_dir: persistence }), persistence_dir: persistence, health_probe: probeInstallableIntegrationHealth, credential_for_integration: environmentIntegrationCredentialLease });
      const action = args[1];
      if (action === "representative-list") { environment.stdout.write(`${JSON.stringify(REPRESENTATIVE_INTEGRATIONS, null, 2)}\n`); return EXIT_CODES.SUCCESS; }
      if (action === "representative-bundle" && args[2]) {
        const spec = REPRESENTATIVE_INTEGRATIONS.find((candidate) => candidate.id === args[2]);
        if (!spec) throw new Error(`unknown representative integration: ${args[2]}`);
        const keyPath = flagValue(args.slice(3), "--private-key");
        const keyId = flagValue(args.slice(3), "--key-id");
        if (!keyPath || !keyId) throw new Error("representative bundle requires --private-key <pem> and --key-id <id>");
        const root = resolve(environment.cwd, flagValue(args.slice(3), "--root") ?? ".");
        const manifest = createRepresentativeIntegrationPackage(spec, root, keyId, createPrivateKey(readFileSync(resolve(environment.cwd, keyPath))), flagValue(args.slice(3), "--bridge-command") ?? process.execPath);
        environment.stdout.write(`${JSON.stringify({ integration_id: spec.id, package_manifest: JSON.parse(manifest), bundle_base64: Buffer.from(createRepresentativeIntegrationBundle(manifest)).toString("base64") }, null, 2)}\n`);
        return EXIT_CODES.SUCCESS;
      }
      if (action === "registry-list" && args[2]) { environment.stdout.write(`${JSON.stringify(new LocalIntegrationRegistry(resolve(environment.cwd, args[2])).list(), null, 2)}\n`); return EXIT_CODES.SUCCESS; }
      if (action === "install-local" && args[2] && args[3]) {
        const prepared = new LocalIntegrationRegistry(resolve(environment.cwd, args[2])).prepare(sdk(), args[3]); const descriptor = sdk().discover(prepared.package_bytes);
        const health = await sdk().probePackage(prepared.package_bytes, prepared.root); if (health.state !== "healthy") throw new Error(`integration health is ${health.state}: ${health.detail}`);
        await dispatchExtensionCatalogLifecycles(environment, [{ action: "install", integration_id: prepared.integration_id, input: { plugin_manifest: JSON.stringify(descriptor.plugin_manifest), plugin_root: prepared.root, acknowledge_risk: args.includes("--acknowledge-risk") } }, { action: "enable", integration_id: prepared.integration_id, input: { acknowledge_risk: args.includes("--acknowledge-risk") } }]);
        sdk().recordCanonicalInstall(prepared.package_bytes, prepared.root, health); environment.stdout.write(`${JSON.stringify(sdk().inspect(prepared.integration_id), null, 2)}\n`); return EXIT_CODES.SUCCESS;
      }
      if ((action === "marketplace-list" || action === "install-remote" || action === "upgrade-remote") && args[2]) {
        const indexUrl = args[2]; const marketplace = new SignedIntegrationMarketplace({ cache_dir: join(persistence, "extension-cache"), install_dir: join(persistence, "extensions"), trust_roots: loadPluginTrust(environment.cwd), fetch: async (url) => { const response = await fetch(url, { redirect: "error", credentials: "omit" }); return { ok: response.ok, bytes: new Uint8Array(await response.arrayBuffer()) }; } }); const index = await marketplace.discover(indexUrl, args.includes("--offline")); if (action === "marketplace-list") { environment.stdout.write(`${JSON.stringify(index.packages, null, 2)}\n`); return EXIT_CODES.SUCCESS; }
        const id = args[3]; if (!id) throw new Error("remote install requires integration id"); const version = flagValue(args.slice(4), "--version") ?? undefined;
        const staged = action === "upgrade-remote" ? await marketplace.stageUpgrade(index, id, version ?? (() => { throw new Error("upgrade requires --version"); })(), args.includes("--offline")) : await marketplace.stageInstall(index, id, version, args.includes("--offline"));
        let catalogCommitted = false;
        try {
          const currentSdk = sdk(); const descriptor = currentSdk.discover(staged.package_manifest); const health = await currentSdk.probePackage(staged.package_manifest, staged.root); if (health.state !== "healthy") throw new Error(`integration health is ${health.state}: ${health.detail}`);
          if (action === "upgrade-remote") { await dispatchExtensionCatalogLifecycle(environment, "update", id, { version: staged.version, plugin_manifest: JSON.stringify(descriptor.plugin_manifest), plugin_root: staged.root, acknowledge_risk: args.includes("--acknowledge-risk") }); catalogCommitted = true; sdk().recordCanonicalUpdate(id, staged.package_manifest, staged.root, health); }
          else { await dispatchExtensionCatalogLifecycles(environment, [{ action: "install", integration_id: id, input: { plugin_manifest: JSON.stringify(descriptor.plugin_manifest), plugin_root: staged.root, acknowledge_risk: args.includes("--acknowledge-risk") } }, { action: "enable", integration_id: id, input: { acknowledge_risk: args.includes("--acknowledge-risk") } }]); catalogCommitted = true; sdk().recordCanonicalInstall(staged.package_manifest, staged.root, health); }
        } catch (error) { if (!catalogCommitted) marketplace.discard(staged); throw error; }
        environment.stdout.write(`${JSON.stringify(sdk().inspect(id), null, 2)}\n`); return EXIT_CODES.SUCCESS;
      }
      if (action === "list") { const value = await queryExtensionCatalog(environment, "integration.list"); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
      if (action === "inspect" && args[2]) { const value = await queryExtensionCatalog(environment, "integration.inspect", args[2]); environment.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return value.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT; }
      if (action === "enable" && args[2]) { const currentSdk = sdk(); const health = await currentSdk.health(args[2]); if (health.state !== "healthy") throw new Error(`integration health is ${health.state}: ${health.detail}`); await dispatchExtensionCatalogLifecycle(environment, "enable", args[2], { acknowledge_risk: args.includes("--acknowledge-risk") }); environment.stdout.write(`${JSON.stringify(sdk().inspect(args[2]), null, 2)}\n`); return EXIT_CODES.SUCCESS; }
      if (action === "disable" && args[2]) { await dispatchExtensionCatalogLifecycle(environment, "disable", args[2], { acknowledge_risk: args.includes("--acknowledge-risk") }); environment.stdout.write(`${JSON.stringify(sdk().inspect(args[2]), null, 2)}\n`); return EXIT_CODES.SUCCESS; }
      if (action === "rollback" && args[2]) { await dispatchExtensionCatalogLifecycle(environment, "rollback", args[2], { acknowledge_risk: args.includes("--acknowledge-risk") }); const currentSdk = sdk(); currentSdk.recordCanonicalRollback(args[2]); environment.stdout.write(`${JSON.stringify(currentSdk.inspect(args[2]), null, 2)}\n`); return EXIT_CODES.SUCCESS; }
      if (action === "run-command" && args[2] && args[3] && args[4]) { environment.stdout.write(`${sdk().executeCommandSkill(args[2], args[3], args[4], args.slice(5))}\n`); return EXIT_CODES.SUCCESS; }
      if (action === "run-mcp" && args[2] && args[3]) { environment.stdout.write(await sdk().executeMcpAdapter(args[2], args[3], flagValue(args.slice(4), "--input") ?? readFileSync(0, "utf8"))); return EXIT_CODES.SUCCESS; }
      environment.stderr.write("Usage: arbor extension <list|inspect|registry-list|marketplace-list|install-local|install-remote|upgrade-remote|enable|disable|rollback|run-command|run-mcp|representative-list|representative-bundle> ...\n"); return EXIT_CODES.USAGE;
    } catch (error) { environment.stderr.write(`${error instanceof Error ? error.message : "integration SDK command failed"}\n`); return EXIT_CODES.VIOLATION; }
  }
  if (args[0] === "report") {
    const rest = args.slice(1);
    const campaign = flagValue(rest, "--campaign");
    if (!campaign) {
      environment.stderr.write("Usage: arbor-mcp report --campaign <id> [--json]\n");
      return EXIT_CODES.USAGE;
    }
    const result = buildRunReport(createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions), campaign);
    // S3a: a raw JSON blob at a TTY names ids and enum strings with no
    // narrative — the same U2 pattern task/confirm already use. --json or a
    // non-TTY invocation (scripts) keeps the exact JSON shape unchanged.
    const tty = (environment.stdout as Writable & { isTTY?: boolean }).isTTY === true;
    if (!rest.includes("--json") && tty) {
      environment.stdout.write(`${formatRunReportSummary(result)}\n`);
    } else {
      environment.stdout.write(`${formatRunReport(result)}\n`);
    }
    return result.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
  }
  if (args[0] === "review") {
    const rest = args.slice(1); const action = rest[0] ?? "inspect";
    const campaign = flagValue(rest, "--campaign"); const node = flagValue(rest, "--node");
    if (!campaign || !node) { environment.stderr.write("Usage: arbor-mcp review <inspect|preflight|comment|request-revision|editor|adopt> --campaign <id> --node <id> [options]\n"); return EXIT_CODES.USAGE; }
    const runtime = environment.runtime_factory
      ? environment.runtime_factory(environment.cwd, environment.persistence_dir)
      : createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions);
    try {
      const started = await runtime.start(); if (!started.ok) throw new Error(started.failures.map((failure) => failure.summary).join("; "));
      const router = new RuntimeCatalogRouter(runtime); const operationId = `cli:result-review:${crypto.randomUUID()}`;
      const files = flagValue(rest, "--files")?.split(",").map((file) => file.trim()).filter(Boolean);
      const queryWorkspace = () => router.executeQuery({ schema_version: 1, query_id: `${operationId}:query`, query: { kind: "result.review.workspace", campaign_id: campaign, node_id: node, ...(files === undefined ? {} : { files }) } } as never);
      if (action === "inspect" || action === "preflight") {
        const response = queryWorkspace();
        if (rest.includes("--json") || action === "preflight") environment.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
        else if (response.ok && typeof response.value === "object" && response.value !== null) {
          const workspace = response.value as { unified?: Array<{ old_line?: number | null; new_line?: number | null; kind?: string; text?: string }>; side_by_side?: Array<{ old_line?: number | null; old_text?: string; new_line?: number | null; new_text?: string }>; conflict_preview?: { status?: string; detail?: string } };
          if (rest.includes("--side-by-side")) for (const line of workspace.side_by_side ?? []) environment.stdout.write(`${line.old_line ?? ""}\t${line.old_text ?? ""}\t│\t${line.new_line ?? ""}\t${line.new_text ?? ""}\n`);
          else for (const line of workspace.unified ?? []) environment.stdout.write(`${line.old_line ?? ""}\t${line.new_line ?? ""}\t${line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}${line.text ?? ""}\n`);
          environment.stdout.write(`Preflight: ${workspace.conflict_preview?.status ?? "blocked"} — ${workspace.conflict_preview?.detail ?? "unavailable"}\n`);
        } else environment.stderr.write(`${JSON.stringify(response)}\n`);
        return response.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
      }
      const workspaceResponse = queryWorkspace();
      if (!workspaceResponse.ok || typeof workspaceResponse.value !== "object" || workspaceResponse.value === null) { environment.stderr.write(`${JSON.stringify(workspaceResponse)}\n`); return EXIT_CODES.CONFLICT; }
      const workspace = workspaceResponse.value as { patch_sha256: string; review_revision: number; conflict_preview?: { status?: string } };
      let command: Record<string, unknown>;
      if (action === "comment") command = { kind: "result.review.comment", campaign_id: campaign, node_id: node, expected_patch_sha256: workspace.patch_sha256, expected_revision: workspace.review_revision, file_path: flagValue(rest, "--file"), line: Number(flagValue(rest, "--line") ?? "1"), side: flagValue(rest, "--side") ?? "new", body: flagValue(rest, "--body"), author_id: flagValue(rest, "--author") ?? "cli-operator" };
      else if (action === "request-revision") command = { kind: "result.review.request_revision", campaign_id: campaign, node_id: node, expected_patch_sha256: workspace.patch_sha256, expected_revision: workspace.review_revision, reason: flagValue(rest, "--reason"), author_id: flagValue(rest, "--author") ?? "cli-operator" };
      else if (action === "editor") command = { kind: "result.review.editor_handoff", campaign_id: campaign, node_id: node, expected_patch_sha256: workspace.patch_sha256, expected_revision: workspace.review_revision, file_path: flagValue(rest, "--file"), line: Number(flagValue(rest, "--line") ?? "1"), editor: flagValue(rest, "--editor") ?? "vscode" };
      else if (action === "adopt") { if (!rest.includes("--confirm") || workspace.conflict_preview?.status !== "clean") { environment.stderr.write("review adopt requires --confirm and a clean exact-subset preflight\n"); return EXIT_CODES.CONFLICT; } command = { kind: "result.adopt", campaign_id: campaign, node_id: node, expected_patch_sha256: workspace.patch_sha256, confirmed: true, ...(files === undefined ? {} : { files }) }; }
      else { environment.stderr.write(`Unknown review action: ${action}\n`); return EXIT_CODES.USAGE; }
      const response = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: operationId, idempotency_key: operationId, correlation_id: operationId, actor_id: "cli-operator", requested_at: new Date().toISOString() }, command } as never);
      environment.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return response.ok && typeof response.value === "object" && response.value !== null && (response.value as { accepted?: boolean }).accepted === true ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
    } catch (error) { environment.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return EXIT_CODES.FAILURE; }
    finally { await boundedRuntimeClose(runtime); }
  }
  if (args[0] === "adopt") {
    const rest = args.slice(1);
    const campaign = flagValue(rest, "--campaign");
    const json = rest.includes("--json");
    if (!campaign) {
      environment.stderr.write("Usage: arbor-mcp adopt --campaign <id> [--node <id>] [--authorize-scope --actor <id> [--authorization-id <id>]] [--apply --scope-authorization <id>] [--expand-scope] [--json]\n");
      return EXIT_CODES.USAGE;
    }
    const persistenceDir = resolvePersistenceDir(environment.cwd, environment.persistence_dir);
    const node = flagValue(rest, "--node");
    const apply = rest.includes("--apply");
    const authorizeScope = rest.includes("--authorize-scope");
    // WA-67: an operator override for a capture refused only because its diff
    // exceeds its declared write scope (`result-adoption.ts`'s
    // `acknowledge_scope_expansion`) — never rescues a genuine verification
    // failure. Kept to flag-parse + pass-through here; the decision of what
    // it may override lives entirely in `adoptCapturedResult`.
    const expandScope = rest.includes("--expand-scope");

    // D6: an empty result here does not mean "nothing to adopt" — a selfhost
    // campaign captures into its own worktree's `.arbor`
    // (`.worktrees/selfhost-<id>/.arbor`), never the target root's. Locate
    // the campaign before reporting emptiness, so root-invoked adopt reports
    // one of three distinguishable states instead of a bare `captures: []`
    // that reads as "adoption is broken" (see `result-adoption.ts`'s
    // `locateCampaign`).
    const location = locateCampaign(environment.cwd, persistenceDir, campaign);
    if (location.resolution === "not_found") {
      const message = `No campaign '${campaign}' found under: ${location.searched.join(", ")}.`;
      if (json) environment.stdout.write(`${JSON.stringify({ ok: true, campaign, resolution: "not_found", captures: [], searched: location.searched }, null, 2)}\n`);
      else environment.stdout.write(`${message}\n`);
      return EXIT_CODES.SUCCESS;
    }
    if (location.resolution === "ambiguous") {
      // Ambiguous: more than one worktree store holds this campaign id.
      // Auto-picking one risks silently adopting the wrong incarnation, so
      // name every candidate and the exact command to disambiguate instead.
      // This is a refusal, not a success: an outer loop must not read it as
      // "nothing to adopt" (blockers doc B6).
      const commands = location.worktree_paths.map((path) => `  cd ${dirname(path)} && arbor-mcp adopt --campaign ${campaign}${apply ? " --apply" : ""}`).join("\n");
      if (json) environment.stdout.write(`${JSON.stringify({ ok: false, campaign, resolution: "ambiguous", worktree_paths: location.worktree_paths, captures: [], searched: location.searched }, null, 2)}\n`);
      else environment.stdout.write(`Campaign '${campaign}' has captures in more than one worktree; ambiguous. Run one of:\n${commands}\n`);
      return EXIT_CODES.CONFLICT;
    }
    const effectivePersistenceDir = location.persistence_dir!;
    const foundElsewhere = location.resolution === "found_in_worktree";

    if (!apply && !authorizeScope) {
      // Default: report what is adoptable. Never mutates the working tree.
      const captures = location.captures;
      const locationNote = foundElsewhere ? ` (found in worktree store ${effectivePersistenceDir}, not ${persistenceDir})` : "";
      if (json) environment.stdout.write(`${JSON.stringify({ ok: true, campaign, resolution: location.resolution, ...(foundElsewhere ? { persistence_dir: effectivePersistenceDir } : {}), captures }, null, 2)}\n`);
      else if (captures.length === 0) environment.stdout.write(`No captured results for campaign ${campaign}${locationNote}.\n`);
      else {
        environment.stdout.write(`Adoptable results for ${campaign}${locationNote} (verified first, best score first):\n`);
        for (const c of captures) environment.stdout.write(`  ${c.verified ? "verified" : "unverified"}  score ${c.score}  node ${c.node_id}  files: ${c.files.join(", ") || "(none)"}\n`);
        environment.stdout.write(`\nApply with: arbor-mcp adopt --campaign ${campaign} --apply [--node <id>]\n`);
      }
      return EXIT_CODES.SUCCESS;
    }

    // --apply: choose the target node (explicit --node, else the best verified),
    // preview that it applies cleanly, then apply it to the working tree.
    const target = node ?? bestVerifiedResult(effectivePersistenceDir, campaign)?.node_id;
    if (!target) {
      environment.stderr.write(json ? `${JSON.stringify({ ok: false, reason: "no verified result to adopt; pass --node to adopt a specific unverified one" })}\n` : `No verified result to adopt for ${campaign}. Pass --node <id> to adopt a specific one.\n`);
      return EXIT_CODES.FAILURE;
    }
    const capture = location.captures.find((item) => item.node_id === target);
    if (authorizeScope) {
      if (apply) {
        environment.stderr.write("Scope authorization and patch adoption are separate audited operations; run --authorize-scope first, then --apply --scope-authorization <id>.\n");
        return EXIT_CODES.USAGE;
      }
      if (capture === undefined) {
        environment.stderr.write(`Cannot authorize scope for node ${target}: captured result was not found.\n`);
        return EXIT_CODES.FAILURE;
      }
      const actor = flagValue(rest, "--actor");
      if (!actor) {
        environment.stderr.write("Scope authorization requires --actor <authenticated-operator-id>.\n");
        return EXIT_CODES.USAGE;
      }
      const authorizationId = flagValue(rest, "--authorization-id") ?? `scope-${crypto.randomUUID()}`;
      const runtime = createCliRuntime(environment.cwd, effectivePersistenceDir, runtimeOptions);
      try {
        const started = await runtime.start();
        if (!started.ok) throw new Error(started.failures.map((failure) => failure.summary).join("; "));
        const router = new RuntimeCatalogRouter(runtime);
        const operationId = `cli:result-scope-authorize:${authorizationId}`;
        const response = await router.dispatchCommand({
          schema_version: 1,
          metadata: { operation_id: operationId, idempotency_key: operationId, correlation_id: operationId, actor_id: actor, requested_at: new Date().toISOString() },
          command: { kind: "result.scope.authorize", campaign_id: campaign, node_id: target, expected_patch_sha256: capture.patch_sha256, authorization_id: authorizationId, authorized_by: actor, confirmed: true },
        });
        const accepted = response.ok && typeof response.value === "object" && response.value !== null && (response.value as { accepted?: boolean }).accepted === true;
        if (json) environment.stdout.write(`${JSON.stringify({ ...response, authorization_id: authorizationId, patch_sha256: capture.patch_sha256 }, null, 2)}\n`);
        else if (accepted) environment.stdout.write(`Authorized scope expansion ${authorizationId} for node ${target} at patch ${capture.patch_sha256}.\nApply separately with: arbor-mcp adopt --campaign ${campaign} --node ${target} --apply --scope-authorization ${authorizationId}\n`);
        else environment.stderr.write(`Scope authorization failed: ${JSON.stringify(response)}\n`);
        return accepted ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
      } catch (error) {
        environment.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_CODES.FAILURE;
      } finally {
        await boundedRuntimeClose(runtime);
      }
    }
    const scopeAuthorizationId = flagValue(rest, "--scope-authorization") ?? undefined;
    const expandScopeArgs = expandScope ? { acknowledge_scope_expansion: true, acknowledged_by: flagValue(rest, "--actor") ?? "cli-operator", expected_patch_sha256: capture?.patch_sha256 } : {};
    const scopeAuthorizationArgs = scopeAuthorizationId === undefined ? {} : { scope_expansion_authorization_id: scopeAuthorizationId, expected_patch_sha256: capture?.patch_sha256 };
    const preview = adoptCapturedResult({ campaign_id: campaign, node_id: target, persistence_dir: effectivePersistenceDir, target_root: environment.cwd, check_only: true, ...expandScopeArgs, ...scopeAuthorizationArgs });
    if (!preview.ok) {
      environment.stderr.write(json ? `${JSON.stringify(preview)}\n` : `Cannot adopt node ${target}: ${preview.reason}\n`);
      return EXIT_CODES.CONFLICT;
    }
    const distributedAdoption = fencedResultAdoptionFromEnvironment(process.env, effectivePersistenceDir);
    const fenced = distributedAdoption === null ? null : await distributedAdoption.adopt({ campaign_id: campaign, node_id: target, target_root: environment.cwd, ...expandScopeArgs, ...scopeAuthorizationArgs, expected_patch_sha256: capture?.patch_sha256 ?? "" });
    const result = fenced === null ? adoptCapturedResult({ campaign_id: campaign, node_id: target, persistence_dir: effectivePersistenceDir, target_root: environment.cwd, ...expandScopeArgs, ...scopeAuthorizationArgs }) : fenced.ok ? { ok: true as const, applied: true as const, node_id: target, files: fenced.entry.selected_files } : { ok: false as const, reason: fenced.reason };
    // E-8: mark this node's waiver-outcome record (if any) adopted. Adoption
    // is the one outcome this cycle wires automatically — it is an observed
    // fact ("this waived result's changes were applied"), not a policy
    // judgment; `later_failed` remains the documented, manually-invoked API
    // (`recordWaiverOutcomeFollowUp`) since whether adopted work later
    // failed is not something `arbor adopt` itself can observe.
    if (result.ok) recordWaiverAdoptionIfWaived(effectivePersistenceDir, campaign, target);
    // A scope expansion is a durable operator decision (WA-67); an adoption
    // that rests on one must say so in its own output, not leave the record
    // discoverable only by reading the store.
    const scopeExpansion = readScopeExpansion(effectivePersistenceDir, campaign, target);
    if (json) environment.stdout.write(`${JSON.stringify({ ...(scopeExpansion === null ? result : { ...result, scope_expansion: scopeExpansion }), resolution: location.resolution, ...(foundElsewhere ? { persistence_dir: effectivePersistenceDir } : {}) }, null, 2)}\n`);
    else if (result.ok) environment.stdout.write(`Adopted node ${result.node_id}${foundElsewhere ? ` (captures found in worktree store ${effectivePersistenceDir}, not ${persistenceDir})` : ""} into the working tree: ${result.files.join(", ") || "(no files)"}\n${scopeExpansion === null ? "" : `Scope expansion acknowledged by ${scopeExpansion.acknowledged_by} at ${scopeExpansion.acknowledged_at} for: ${scopeExpansion.acknowledged_paths.join(", ")}\n`}Review and commit the changes yourself.\n`);
    else environment.stderr.write(`Adoption failed: ${result.reason}\n`);
    return result.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
  }
  if (args[0] === "recover") {
    const rest = args.slice(1);
    const campaign = flagValue(rest, "--campaign");
    const json = rest.includes("--json");
    if (!campaign) {
      environment.stderr.write("Usage: arbor-mcp recover --campaign <id> [--node <id>] [--authorize --disposition <operation>=<decision> --reason <text>] [--resume-review] [--json]\n");
      return EXIT_CODES.USAGE;
    }
    const dispositions = parseRecoveryDispositions(flagValues(rest, "--disposition"));
    if (!dispositions.ok) { environment.stderr.write(`${dispositions.reason}\n`); return EXIT_CODES.USAGE; }
    const runtime = createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions);
    const result = runRecoveryCommand({
      runtime, campaign_id: campaign, node_id: flagValue(rest, "--node") ?? undefined,
      authorize: rest.includes("--authorize"), actor_id: flagValue(rest, "--actor") ?? "operator",
      reason: flagValue(rest, "--reason") ?? "operator-authorized governed crash continuation",
      dispositions: dispositions.value,
    });
    if (json) environment.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else environment.stdout.write(`${formatRecoveryCommandResult(result)}\n`);
    if (result.ok && result.authorized && result.dispatched) await runtime.awaitCampaignRun(campaign);
    // B3: interruption-journal recovery above cannot see a campaign whose run
    // process died mid-review — those nodes sit in "awaiting_review" with a
    // durable candidate and no journal entry. Surface them here, and let the
    // operator explicitly authorize a critic-only resume (the loop's
    // resumeStrandedReviews path) via --resume-review.
    let resumable: string[] = [];
    try {
      resumable = runtime.manager.resumableReviewNodes(campaign);
    } catch { /* unknown campaign: journal-recovery output above already covers it */ }
    if (resumable.length > 0) {
      if (rest.includes("--resume-review")) {
        const resumed = runtime.runPreparedContinuation(campaign, `review-resume:${Date.now()}`);
        if (!resumed.ok) {
          environment.stderr.write(`Review resume could not start: ${resumed.reason}\n`);
          return EXIT_CODES.CONFLICT;
        }
        const settlement = await runtime.awaitCampaignRun(campaign);
        environment.stdout.write(`Review resume dispatched for ${resumable.length} node(s): ${resumable.join(", ")} (run settled: ${settlement.task_state ?? "unknown"})\n`);
        return settlement.task_state === "failed" ? EXIT_CODES.FAILURE : EXIT_CODES.SUCCESS;
      }
      environment.stdout.write(`Campaign has ${resumable.length} node(s) awaiting review with a captured candidate: ${resumable.join(", ")}\n`);
      environment.stdout.write(`Next: arbor recover --campaign ${campaign} --resume-review\n`);
    }
    return result.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT;
  }
  if (args[0] === "webui") {
    const port = Number.parseInt(args[1] ?? "0", 10);
    const validPort = Number.isFinite(port) && port >= 0 && port <= 65535 ? port : 0;
    const webuiLock = takeWriterLock(resolvePersistenceDir(environment.cwd, environment.persistence_dir), "webui", environment.stderr);
    if (!webuiLock) return EXIT_CODES.CONFLICT;
    try {
    const runtime = createCliRuntime(environment.cwd, environment.persistence_dir, runtimeOptions);
    shutdownGate?.bind(runtime);
    const webui = new ArborWebUIServer(runtime);
    const started = await runtime.start();
    if (!started.ok) throw new Error(started.failures.map((failure) => failure.summary).join("; ") || "runtime did not start");
    // Print the URL only once the HTTP server actually reports listening
    // (webui.start's callback), and only once that has genuinely happened —
    // never racing ahead to the shutdown wait below.
    await new Promise<void>((resolveListening) => {
      webui.start(validPort, () => {
        environment.stderr.write(`Arbor web dashboard operator session: ${webui.getOperatorUrl() ?? `http://127.0.0.1:${webui.getPort()}`}\n`);
        resolveListening();
      });
    });
    // B4: stay up until interrupted regardless of whether a ShutdownGate was
    // supplied. Without this fallback, a caller that omits the gate (or any
    // path where it is never bound/triggered) fell straight through to
    // `webui.stop()` the instant the listener opened — a real HTTP server
    // that silently served for zero seconds and exited 0. The SIGINT/SIGTERM
    // fallback here is a second, independent path to the same outcome the
    // gate already gives when one is supplied.
    await (shutdownGate?.signal ?? new Promise<void>((resolveSignal) => {
      process.once("SIGINT", () => resolveSignal());
      process.once("SIGTERM", () => resolveSignal());
    }));
    try {
      await webui.stop();
    } finally {
      // Keep the runtime cleanup paired with WebUI shutdown even if closing
      // the HTTP listener fails. The rejection remains visible to main's
      // existing failure path, and the outer finally still releases the lock.
      await boundedRuntimeClose(runtime);
    }
    return EXIT_CODES.SUCCESS;
    } finally { webuiLock.release(); }
  }
  if (args[0] === "tui") {
    const { tuimain } = await import("./tui.js");
    return tuimain(args.slice(1));
  }
  // `arbor demo` is the only real `runCampaign` caller in the repo, and the
  // "demo" framing overstates nothing but understates everything — it is
  // the genuine autonomous tree-search run. `run` is now the primary name;
  // `demo` stays as an alias so existing scripts/muscle memory keep working.
  if (args[0] === "run" || args[0] === "demo") {
    const { demomain } = await import("./demo.js");
    return demomain(args.slice(1));
  }
  if (args[0] === "devtools" && args[1] === "tail") {
    return devtoolsTail(args.slice(2), environment);
  }
  if (args[0] === "governance") {
    return governanceCommand(args.slice(1), environment);
  }
  if (args[0] === "audit") {
    const { auditCommand } = await import("./audit-command.js");
    return auditCommand(args.slice(1), environment);
  }
  if (args[0] === "ledger") {
    const { ledgerCommand } = await import("./ledger-command.js");
    return ledgerCommand(args.slice(1), environment);
  }
  if (args[0] === "scheduler") {
    const { schedulerCommand } = await import("./scheduler-command.js");
    return schedulerCommand(args.slice(1), { ...environment, shutdown: shutdownGate?.signal });
  }
  if (args[0] === "evidence") {
    return evidenceCommand(args.slice(1), environment);
  }
  if (args[0] === "interview") {
    const { interviewCommand } = await import("./interview-command.js");
    return interviewCommand(args.slice(1), environment);
  }
  if (args[0] === "selfhost") {
    const { selfhostMain } = await import("./selfhost.js");
    return selfhostMain(args.slice(1), environment);
  }
  if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
    // Dynamic, like every other lazily-loaded command below (audit, ledger,
    // selfhost, tui, run/demo): --help must not force ledger-command.ts's
    // module graph (@arbor/audit) to load on every ordinary CLI invocation
    // just to read one constant.
    const { LEDGER_ACTIONS } = await import("./ledger-command.js");
    const output = environment.stdout;
    output.write("Arbor — governed tree-search for autonomous software work\n\n");
    output.write("Usage: arbor <command> [options]\n\n");
    output.write("  arbor --version (`-V`)                        Print the CLI version\n\n");
    output.write("  arbor capabilities [--json]                   Print the revision-bound runtime/tool/role/skill capability index\n\n");
    output.write("Start here\n");
    output.write("  arbor doctor [--json]                         Inspect local readiness and exact remediation\n");
    output.write("  arbor doctor reconcile [--apply] [--json]     Preview, then quarantine orphaned campaign snapshots and ledgers\n");
    output.write("  arbor flight <start|status|profile|...>       Operate the repo-local Flight Director\n");
    output.write("  arbor resume [session-id] [--preview]          Continue interrupted work; preview lists any required effect decisions\n");
    output.write("  arbor flight-control-stress [--scenario <id>] [--work-root <new-dir>] [--keep-artifacts]\n");
    output.write("  arbor migrate <inspect|preview|apply|rollback> Safely inspect/import/update configuration\n");
    output.write("  arbor integration <list|inspect|admit|enable|disable|update> Inspect capability-bound integrations\n");
    output.write("  arbor remote status --json                     Inspect the composed remote control handoff\n");
    output.write("  arbor session <availability|resume|fork|respawn> <id> Governed terminal-session controls\n");
    output.write("  arbor session start <text> [--tier ...] [--json]  Open a live interactive session from a cold prompt\n");
    output.write("  arbor session identity <get|search|set> [id]  Inspect or set governed session identity\n");
    output.write("  arbor repo-session <begin|status|open|close|abort> [options]  Govern the repository-session lifecycle (ADR-160): commits and gates defer to one close\n");
    output.write("  arbor repo-session-reconcile [--session <id>] [--json]  Retire a stranded session window whose actor is gone\n");
    output.write("  arbor repo-session-assert-window              Exit 1 when no commit window is open (the pre-commit hook's check)\n");
    output.write("  arbor setup [--dry-run] [--json]              Create missing local config/secret templates safely\n");
    output.write("  arbor native-auth openrouter login            Authorize OpenRouter in a browser (PKCE) and store the key privately\n");
    output.write("  arbor project status [path] [--json]          Inspect enrollment and overlay consistency\n");
    output.write("  arbor project enroll [path] [--new|--backfill] [--dry-run]\n");
    output.write("  arbor project repair [path] [--apply]          Preview or repair missing/moved overlay structure\n");
    output.write("  arbor project registry <list|verify> [--json] Inspect the multi-project registry and its discharge\n");
    output.write("  arbor project manage [--json]                 Reconcile every enrolled project in one pass\n");
    output.write("  arbor verification <action>                   Inspect durable result-verification evidence\n");
    output.write("  arbor notification <action>                   List and acknowledge operator notifications\n");
    output.write("  arbor followup <action>                       List or create governed campaign follow-ups\n");
    output.write("  arbor extension <action>                      Manage capability-bound extensions\n");
    output.write("  arbor integration-sdk <action>                Discover, inspect, and run SDK integrations\n");
    output.write("  arbor review <action>                         Review, comment on, or adopt captured results\n");
    output.write("  arbor tui [--resume] [--renderer opentui|stdout] Open the interactive operator cockpit\n");
    output.write("  arbor task <text>                             Plan a governed task for review\n");
    output.write("  arbor greenfield <intent> [--tier ...] [--json] Guided flow for a brand-new target (ADR-114): reports every\n");
    output.write("                                                 preflight blocker together, then dispatches like `task`\n");
    output.write("  arbor task confirm <id> <revision> --wait     Approve a --plan draft (a no-op replay if already admitted)\n");
    output.write(`  arbor task <${TASK_SUBCOMMANDS.join("|")}> ...\n`);
    output.write("                                                 Full subcommand list — see `arbor task --help`\n");
    output.write("  arbor report --campaign <id>                  Inspect a completed or interrupted run\n");
    output.write("  arbor adopt --campaign <id> [--apply]         Preview or apply captured verified changes\n\n");
    output.write("Run and supervise\n");
    output.write("  arbor run                                     Run the built-in autonomous campaign (`demo` alias)\n");
    output.write("  arbor recover --campaign <id>                 Preview or authorize governed continuation\n");
    output.write("  arbor devtools tail [campaign]                Follow the durable execution trace\n");
    output.write("  arbor webui [port]                            Start the local web dashboard\n");
    output.write("  arbor serve                                   Start the MCP server on stdio\n");
    output.write("  arbor acp                                     Start the governed ACP IDE bridge on stdio\n");
    output.write("  arbor selfhost --max-iterations <n> --max-seconds <n> [--dry-run]\n\n");
    output.write("Extend and inspect\n");
    output.write("  arbor command <name> [arguments...]           Invoke a governed project/user command\n");
    output.write("  arbor command list                            List available commands\n");
    output.write("  arbor hook <list|validate|events> [--json]    Inspect the governed hook catalog and lifecycle events\n");
    output.write("  arbor plugin <list|inspect>                   Read-only compatibility view for plugins\n");
    output.write("  arbor integration <...>                       Governed catalog backend for extension lifecycle\n");
    output.write("  arbor governance [--json]                     Inspect the governance projection\n");
    output.write("  arbor interview [--dry-run] [--repo <dir>]    Ask owed governance decisions here and record the verbatim answers\n");
    output.write("  arbor liveness                                Exercise registered seams and consumers\n");
    output.write("  arbor debug prompt-input ...                  Inspect a composed prompt input\n");
    output.write("  arbor audit <list|show|prompt|sync>            Work with audit templates\n");
    output.write(`  arbor ledger <${LEDGER_ACTIONS.join("|")}> ...       Verify, repair, or audit an evidence ledger\n`);
    const { SCHEDULER_ACTIONS } = await import("./scheduler-command.js");
    output.write(`  arbor scheduler <${SCHEDULER_ACTIONS.join("|")}> ... Register, list, tick, trigger, or daemon-run durable schedules\n`);
    output.write("  arbor evidence refresh [--scope ...]          Refresh automatic evidence stores; determinism requires explicit scope\n");
    output.write("  arbor remote-serve ...                        Serve authenticated remote ingress\n");
    output.write("  arbor remote-grant ...                        Manage remote-operation grants\n\n");
    output.write("  arbor control <serve|join|status|discover|inbox|lease|adoption> --config <path>\n\n");
    output.write(
      "Exit codes: 0 success · 1 unexpected failure · 2 usage error · 3 partial (some targets failed) · 4 conflict · 5 violation (see exit-codes.ts)\n\n",
    );
    output.write("`arbor-mcp` remains an exact compatibility alias. Use `arbor <command> --help` where available for command details.\n");
    return EXIT_CODES.SUCCESS;
  }
  // Grammar: an unrecognized command is a usage error (ADR-054's registry),
  // never conflated with `FAILURE` — the caller mistyped the invocation,
  // the process did not crash.
  environment.stderr.write(`Unknown command: ${args[0]}\n`);
  return EXIT_CODES.USAGE;
}

export function loadCommandCatalog(cwd: string, persistenceDir?: string): CommandCatalog {
  const catalog = CommandCatalog.fromLocations(join(homedir(), ".arbor", "commands"), join(cwd, ".arbor", "commands"));
  const registry = new PluginRegistry({ trusted_keys: loadPluginTrust(cwd), persistence_dir: resolvePersistenceDir(cwd, persistenceDir) });
  for (const plugin of registry.list()) registry.installComponents(plugin.manifest.plugin_id, { commands: catalog });
  return catalog;
}

type ExtensionLifecycleAction = "install" | "enable" | "disable" | "update" | "rollback";
type ExtensionLifecycleInput = Readonly<{ version?: string; plugin_manifest?: string; plugin_root?: string; acknowledge_risk: boolean }>;
type ExtensionCliEnvironment = Readonly<{ cwd: string; persistence_dir?: string; runtime_factory?: (cwd: string, persistenceDir?: string) => ArborRuntime }>;
const INTEGRATION_LIFECYCLE_KIND: Readonly<Record<ExtensionLifecycleAction, "integration.install" | "integration.enable" | "integration.disable" | "integration.update" | "integration.rollback">> = Object.freeze({ install: "integration.install", enable: "integration.enable", disable: "integration.disable", update: "integration.update", rollback: "integration.rollback" });

/** Compatibility adapter: lifecycle state changes only through `integration.*`. */
async function dispatchExtensionCatalogLifecycle(environment: ExtensionCliEnvironment, action: ExtensionLifecycleAction, integrationId: string, input: ExtensionLifecycleInput): Promise<void> {
  await dispatchExtensionCatalogLifecycles(environment, [{ action, integration_id: integrationId, input }]);
}

async function dispatchExtensionCatalogLifecycles(environment: ExtensionCliEnvironment, requests: readonly Readonly<{ action: ExtensionLifecycleAction; integration_id: string; input: ExtensionLifecycleInput }>[]): Promise<void> {
  const runtime = (environment.runtime_factory ?? createCliRuntime)(environment.cwd, environment.persistence_dir); const router = new RuntimeCatalogRouter(runtime);
  try {
    const started = await runtime.start(); if (!started.ok) throw new Error(started.failures.map((failure) => failure.summary).join("; ") || "runtime did not start");
    for (const { action, integration_id, input } of requests) {
      const operation = `cli-extension-${action}-${integration_id}-${crypto.randomUUID()}`;
      const response = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: operation, idempotency_key: operation, correlation_id: operation, actor_id: "cli-operator", requested_at: new Date().toISOString() }, command: { kind: INTEGRATION_LIFECYCLE_KIND[action], integration_id, ...input, provenance: { tag: "claimed", claimant: "cli-operator" } } } as never);
      if (!response.ok) throw new Error(response.error?.summary ?? "catalog rejected extension lifecycle command");
      const acknowledgement = response.value as { accepted?: unknown; error?: { summary?: unknown } };
      if (acknowledgement.accepted !== true) throw new Error(typeof acknowledgement.error?.summary === "string" ? acknowledgement.error.summary : "catalog refused extension lifecycle command");
    }
  } finally { await closeRuntimeOrThrow(runtime); }
}

async function queryExtensionCatalog(environment: ExtensionCliEnvironment, kind: "integration.list" | "integration.inspect", integrationId?: string): Promise<ReturnType<RuntimeCatalogRouter["executeQuery"]>> {
  const runtime = createCliRuntime(environment.cwd, environment.persistence_dir); const router = new RuntimeCatalogRouter(runtime);
  try { return router.executeQuery({ schema_version: 1, query_id: `cli-extension-${kind}-${crypto.randomUUID()}`, query: { kind, ...(kind === "integration.list" ? { category: "extension" } : {}), ...(integrationId === undefined ? {} : { integration_id: integrationId }) } } as never); }
  finally { await closeRuntimeOrThrow(runtime); }
}


function environmentIntegrationCredentialLease(integrationId: string, credentialEnv: string): NativeCredentialLeasePort | undefined {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(credentialEnv)) return undefined; const secret = process.env[credentialEnv]; if (!secret) return undefined; const broker = new InMemoryCredentialLeaseBroker(); const provider = `extension:${integrationId}`; const session = `extension-cli:${integrationId}`; broker.register({ provider_id: provider, account_id: "default", scopes: ["integration.execute"], secret }); const issued = broker.issue({ provider_id: provider, account_id: "default", scopes: ["integration.execute"], session_id: session, expires_at: new Date(Date.now() + 5 * 60_000).toISOString() }); if (!issued.issued) return undefined; return Object.freeze({ lease_id: issued.lease.lease_id, inject: async <T>(recipient: (value: string) => Promise<T>): Promise<T> => { let invoked: Promise<T> | undefined; const resolution = broker.inject(issued.lease.lease_id, session, (value) => { invoked = recipient(value); }); if (!resolution.available || invoked === undefined) throw new Error("integration credential lease is unavailable"); return invoked; } });
}

/**
 * CLI projection of the canonical task-composer catalog.  It deliberately
 * does not import or call the composer/manager directly: the same router used
 * by MCP, TUI, and Web remains the only surface that can transition a draft.
 *
 * Mutations hold the persistence writer lock for their whole runtime lifetime;
 * this prevents a short CLI decision from racing a live Web/TUI writer. Reads
 * remain lock-free so an operator can inspect a live dashboard's state.
 */
/**
 * D12: the single source of truth for which `arbor task <word>` first
 * arguments are dispatched subcommands rather than free-form task text.
 * Shared by the dispatch check below and by the top-level `arbor --help`
 * summary, so the two can never drift the way the summary line did (it
 * hand-listed only "task <text>" and "task confirm" while the dispatch
 * already handled `list`/`show`/`answer`/`reject`/`follow-up` too).
 */
export const TASK_SUBCOMMANDS = ["list", "show", "answer", "confirm", "retry", "reject", "follow-up"] as const;

/**
 * ADR-116: the single source of truth for `task`'s recognized flags.
 * `taskUsage` renders `usage` as compact `[--flag value]` tokens and
 * `printTaskHelp` renders `help` as the fuller per-flag prose; both read
 * from this one table instead of two independently hand-maintained strings,
 * so a flag added to one and not the other fails at test time. It is also
 * the recognized-flag set the leading-flag dispatch guard below checks
 * against: a leading token starting with `-` is let through to the normal
 * flag-stripping/parsing logic only if its name appears here, otherwise it
 * is refused as an unknown option before ever reaching the planner.
 */
const TASK_FLAGS: readonly { name: string; usage: string; help: string }[] = [
  { name: "--tier", usage: "[--tier direct|reviewed|governed]", help: "(submit, follow-up) Force a governance tier instead of\n              running the arbiter classifier: direct, reviewed, or\n              governed. Recorded as an operator-forced decision." },
  { name: "--json", usage: "[--json]", help: "Always print the raw JSON result, even on a TTY." },
  { name: "--progress", usage: "[--progress]", help: "Stream lifecycle updates to stderr; stdout remains clean JSON." },
  { name: "--plan", usage: "[--plan]", help: "Prepare a reviewable plan without starting work." },
  { name: "--wait", usage: "[--wait]", help: "(confirm only) Block until the started campaign settles." },
  { name: "--allow-primary-checkout", usage: "[--allow-primary-checkout]", help: "Accept the risk of running this campaign's worktrees\n              directly against the current checkout even though it is\n              the primary checkout, a worker checkout, or on a forbidden\n              branch (master/main) — the same guard `arbor selfhost`\n              always enforces. Without it, such a target is refused." },
  { name: "--attach", usage: "[--attach <image>]", help: "Attach up to four PNG, JPEG, GIF, or WebP images. Media\n              uses governed planning and requires an explicitly image-capable native provider." },
  { name: "--help", usage: "[--help]", help: "Show this help and exit 0. (also `-h`)" },
];

/** ADR-116: flag names the leading-position dispatch guard treats as recognized, not an unknown option. */
const TASK_FLAG_NAMES = new Set(TASK_FLAGS.map((flag) => flag.name));

async function taskComposerCommand(
  args: readonly string[],
  environment: { cwd: string; persistence_dir?: string; stdin: Readable; stdout: Writable; stderr: Writable; env?: Readonly<Record<string, string | undefined>>; safe_mode?: boolean; require_repo_flight?: boolean; runtime_factory?: (cwd: string, persistenceDir?: string) => ArborRuntime },
  shutdownGate?: ShutdownGate,
  commandBinding?: TaskComposerCommandBinding,
): Promise<number> {
  const requested = args[0] ?? "";
  // U1: `--help`/`-h` are genuine help requests, and anything else that looks
  // like a flag rather than a recognized subcommand or free-text task must
  // never fall through to `withoutJson.join(" ")` and get dispatched to the
  // paid planner as literal task text (the field-observed `arbor task --help`
  // defect: a real planner call, ~19s and real tokens, for what was plainly a
  // help request). Both branches return before any writer lock or runtime is
  // touched — this is a pure argv classification, not a runtime decision.
  if (requested === "--help" || requested === "-h") {
    printTaskHelp(environment.stdout);
    return EXIT_CODES.SUCCESS;
  }
  const subcommand = (TASK_SUBCOMMANDS as readonly string[]).includes(requested) ? requested : "";
  // ADR-116: a leading flag is refused only when it genuinely isn't one of
  // TASK_FLAGS — `--tier` (and every other recognized flag) falls through to
  // the same flag-stripping/parsing logic below regardless of where in
  // `args` it appears, exactly like `evidence`/`project` already parse their
  // flags position-independently. A flag-shaped token that matches nothing
  // in TASK_FLAGS is still an unknown option, and still refused here rather
  // than being silently dispatched to the planner as literal task text.
  if (subcommand === "" && requested.startsWith("-") && !TASK_FLAG_NAMES.has(requested)) {
    environment.stderr.write(`Unknown task option: ${requested}\n`);
    return taskUsage(environment.stderr);
  }
  const json = args.includes("--json");
  // U7: JSON is a final-result format, not a reason to leave an operator
  // staring at a blank terminal for a multi-minute provider run. TTYs show
  // lifecycle progress by default; --progress explicitly enables the same
  // stderr-only stream for recorders and automation while stdout remains one
  // clean JSON document.
  const progress = args.includes("--progress") || (environment.stderr as Writable & { isTTY?: boolean }).isTTY === true;
  // `--wait` is only meaningful on `confirm` (see below); stripped globally,
  // like `--json`, so it is never mistaken for a positional argument
  // regardless of where an operator places it on the command line.
  const wait = args.includes("--wait");
  const planOnly = args.includes("--plan");
  // Isolation-guard gap: an operator's explicit acceptance of the risk of
  // running a real campaign directly against this checkout — see
  // `createProductionCampaignRunner`'s `allow_primary_checkout`. Stripped
  // globally like `--json`/`--wait` so it is never mistaken for task text.
  const allowPrimaryCheckout = args.includes("--allow-primary-checkout");
  // ADR-062: `--tier <direct|reviewed|governed>` is an operator-forced
  // governance-tier override, meaningful only on a bare submit or
  // `follow-up` (both dispatch `taskcomposer.submit`). Stripped globally
  // like `--json`/`--wait` so its value never gets mistaken for task text.
  const tierFlagIndex = args.indexOf("--tier");
  const tierOverride = tierFlagIndex === -1 ? undefined : args[tierFlagIndex + 1];
  if (tierFlagIndex !== -1 && tierOverride !== "direct" && tierOverride !== "reviewed" && tierOverride !== "governed") {
    environment.stderr.write(`--tier requires one of: direct, reviewed, governed\n`);
    return taskUsage(environment.stderr);
  }
  const attachmentPaths: string[] = [];
  const attachmentIndexes = new Set<number>();
  for (let index = 0; index < args.length; index += 1) if (args[index] === "--attach") {
    const path = args[index + 1];
    if (!path || path.startsWith("--")) { environment.stderr.write("--attach requires an image path\n"); return taskUsage(environment.stderr); }
    attachmentPaths.push(path); attachmentIndexes.add(index); attachmentIndexes.add(index + 1); index += 1;
  }
  if (attachmentPaths.length > 4) { environment.stderr.write("--attach may be supplied at most four times\n"); return taskUsage(environment.stderr); }
  const withoutJson = args.filter((arg, index) => arg !== "--json" && arg !== "--progress" && arg !== "--wait" && arg !== "--plan" && arg !== "--allow-primary-checkout" && !attachmentIndexes.has(index) && (tierFlagIndex === -1 || (index !== tierFlagIndex && index !== tierFlagIndex + 1)));
  const write = subcommand === "" || subcommand === "answer" || subcommand === "confirm" || subcommand === "retry" || subcommand === "reject" || subcommand === "follow-up";
  let lock = write ? takeWriterLock(resolvePersistenceDir(environment.cwd, environment.persistence_dir), "task", environment.stderr) : null;
  if (write && lock === null) return EXIT_CODES.CONFLICT;
  let runtime: ArborRuntime | null = null;
  try {
    runtime = environment.runtime_factory
      ? environment.runtime_factory(environment.cwd, environment.persistence_dir)
      : createCliRuntime(environment.cwd, environment.persistence_dir, { allowPrimaryCheckout, safeMode: environment.safe_mode, env: environment.env ?? process.env, requireRepoFlight: environment.require_repo_flight === true });
    const started = await runtime.start();
    if (!started.ok) {
      environment.stderr.write(`${started.failures.map((failure) => failure.summary).join("; ") || "task runtime failed to start"}\n`);
      return EXIT_CODES.FAILURE;
    }
    const router = new RuntimeCatalogRouter(runtime);
    const stamp = `cli:task:${crypto.randomUUID()}`;
    const dispatch = (command: Record<string, unknown>) => router.dispatchCommand({
      schema_version: 1,
      metadata: { operation_id: stamp, idempotency_key: stamp, correlation_id: stamp, actor_id: "cli-operator", requested_at: new Date().toISOString() },
      command,
    } as never);
    const query = (value: Record<string, unknown>) => router.executeQuery({
      schema_version: 1, query_id: `cli:task-query:${crypto.randomUUID()}`, query: value,
    } as never);
    const attachmentUploads = attachmentPaths.map((path) => {
      const absolute = realpathSync(resolve(environment.cwd, path));
      const fd = openSync(absolute, "r");
      try {
        const size = fstatSync(fd).size;
        if (size <= 0 || size > TASK_ATTACHMENT_MAX_BYTES) throw new Error(`attachment ${path} must be between 1 and ${TASK_ATTACHMENT_MAX_BYTES} bytes`);
        return { display_name: basename(absolute), content_base64: readFileSync(fd).toString("base64") };
      } finally { closeSync(fd); }
    });
    let result: unknown;
    if (subcommand === "") {
      const task = withoutJson.join(" ").trim();
      if (!task) return taskUsage(environment.stderr);
      if (progress) environment.stderr.write("[revoy] planning: governed intake started\n");
      const submission = dispatch({ kind: "taskcomposer.submit", task, source: "cli", idempotency_key: stamp, auto_confirm: !planOnly, ...(commandBinding === undefined ? {} : { command: commandBinding }), ...(attachmentUploads.length === 0 ? {} : { attachment_uploads: attachmentUploads }), ...(tierOverride === undefined ? {} : { tier_override: tierOverride }) });
      if (progress) {
        const created = runtime.taskComposer.query({ kind: "taskcomposer.list", limit: 1 });
        const draft = created !== null && "items" in created ? created.items[0] : undefined;
        if (draft) environment.stderr.write(`[revoy] planning: draft ${draft.id} created\n`);
      }
      result = await submission;
      if (!planOnly) { lock?.release(); lock = null; result = await awaitConfirmedCampaign(runtime, shutdownGate, result, progress ? (line) => environment.stderr.write(`${line}\n`) : undefined); }
    } else if (subcommand === "list") {
      const limit = taskLimit(withoutJson.slice(1));
      if (limit === null) return taskUsage(environment.stderr);
      result = query({ kind: "taskcomposer.list", limit });
    } else if (subcommand === "show") {
      const draftId = withoutJson[1];
      if (!draftId) return taskUsage(environment.stderr);
      result = query({ kind: "taskcomposer.get", draft_id: draftId });
    } else if (subcommand === "answer") {
      const [draftId, revision, questionId, ...answerParts] = withoutJson.slice(1);
      const expected = parseTaskRevision(revision);
      const answer = answerParts.join(" ").trim();
      if (!draftId || expected === null || !questionId || !answer) return taskUsage(environment.stderr);
      result = await dispatch({ kind: "taskcomposer.answer", draft_id: draftId, expected_revision: expected, question_id: questionId, answer });
      // The final clarification answer can auto-admit and start the same
      // supervised campaign as bare `task`/`follow-up`. Keep this CLI process
      // attached to that exact settlement; otherwise boundedRuntimeClose()
      // tears down the only runner after printing "Work started", orphaning a
      // persisted non-halted campaign that can never execute a critic retry.
      lock?.release(); lock = null;
      result = await awaitConfirmedCampaign(runtime, shutdownGate, result, progress ? (line) => environment.stderr.write(`${line}\n`) : undefined);
    } else if (subcommand === "confirm") {
      const [draftId, revision] = withoutJson.slice(1);
      const expected = parseTaskRevision(revision);
      if (!draftId || expected === null) return taskUsage(environment.stderr);
      // WA-37: a random per-process key here would make a re-run of the
      // identical `task confirm <id> <rev>` miss the composer's own
      // `confirm:${idempotency_key}` replay lookup (task-composer.ts:179-186)
      // and instead hit a stale-revision CAS conflict against the campaign
      // the first run already admitted. Deterministic on draft_id + the
      // expected revision alone: the same confirm command always replays.
      const confirmIdempotencyKey = `confirm:${Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${draftId}:${expected}`))).toString("hex")}`;
      result = await dispatch({ kind: "taskcomposer.confirm", draft_id: draftId, expected_revision: expected, idempotency_key: confirmIdempotencyKey });
      // WA-15: this process keeps writing the ledger/snapshot for the whole
      // campaign run below. Releasing the writer lock here (before the wait)
      // let a second `serve`/`webui`/`confirm --wait` acquire it and race
      // this one's still-in-flight writes. Hold it through the wait; it is
      // released in the `finally` below once the campaign has settled.
      if (wait) { result = await awaitConfirmedCampaign(runtime, shutdownGate, result, progress ? (line) => environment.stderr.write(`${line}\n`) : undefined); }
    } else if (subcommand === "retry") {
      const [draftId, revision] = withoutJson.slice(1);
      const expected = parseTaskRevision(revision);
      if (!draftId || expected === null) return taskUsage(environment.stderr);
      result = await dispatch({ kind: "taskcomposer.retry", draft_id: draftId, expected_revision: expected, idempotency_key: stamp });
    } else if (subcommand === "reject") {
      const [draftId, revision, ...reasonParts] = withoutJson.slice(1);
      const expected = parseTaskRevision(revision);
      const reason = reasonParts.join(" ").trim();
      if (!draftId || expected === null || !reason) return taskUsage(environment.stderr);
      result = await dispatch({ kind: "taskcomposer.reject", draft_id: draftId, expected_revision: expected, reason });
    } else if (subcommand === "follow-up") {
      const [campaignId, ...taskParts] = withoutJson.slice(1);
      const task = taskParts.join(" ").trim();
      if (!campaignId || !task) return taskUsage(environment.stderr);
      result = await dispatch({ kind: "taskcomposer.submit", task, source: "cli", idempotency_key: stamp, parent_campaign_id: campaignId, auto_confirm: !planOnly, ...(attachmentUploads.length === 0 ? {} : { attachment_uploads: attachmentUploads }), ...(tierOverride === undefined ? {} : { tier_override: tierOverride }) });
      // WA-15: same reasoning as `confirm --wait` above — hold the writer
      // lock through the whole awaited campaign run, not just the submit.
      if (!planOnly) { result = await awaitConfirmedCampaign(runtime, shutdownGate, result, progress ? (line) => environment.stderr.write(`${line}\n`) : undefined); }
    } else {
      return taskUsage(environment.stderr);
    }
    // U2: preserve the exact current JSON output whenever --json was passed
    // or stdout is not a TTY (scripts depend on this shape unchanged). Only
    // a TTY human invocation of the two subcommands with a real next-action
    // story (bare submit and confirm) gets the friendlier summary.
    const tty = (environment.stdout as Writable & { isTTY?: boolean }).isTTY === true;
    if (!json && tty && subcommand === "") {
      environment.stdout.write(`${formatTaskSubmitSummary(result)}\n`);
    } else if (!json && tty && subcommand === "confirm") {
      environment.stdout.write(`${formatTaskConfirmSummary(result)}\n`);
    } else {
      environment.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    if (tty) {
      const campaignResult = (result as { campaign_result?: { awaiting_user_input?: unknown; campaign_id?: unknown } } | undefined)?.campaign_result;
      if (campaignResult?.awaiting_user_input === true) {
        environment.stderr.write(`Campaign ${String(campaignResult.campaign_id)} is awaiting operator input — answer it with the TUI or the governed command surface, then re-run confirm --wait.\n`);
      }
    }
    return taskResultExitCode(result);
  } finally {
    if (runtime !== null) await boundedRuntimeClose(runtime);
    lock?.release();
  }
}

/**
 * ADR-114 Decision §1: `arbor greenfield <intent>` runs EVERY preflight
 * blocker this ADR named — target isolation safety, the dirty-tree probe,
 * and governance-tier resolution — and reports them TOGETHER before ever
 * dispatching, instead of the fix-one/re-run/hit-the-next cycle the ADR's
 * Context traces through four sequential refusals against `.demo-astro`.
 * Once every blocker clears, it dispatches through the exact same
 * bare-submit path `arbor task <text>` uses (`taskComposerCommand` with
 * subcommand === ""), so `greenfield` never becomes a second campaign-
 * admission code path — only a second, up-front CALLER of checks `task`
 * already pays for lazily, one refusal at a time, deep inside a live run.
 *
 * This intentionally duplicates knowledge of which gates exist (a real cost
 * named in the ADR's Consequences) rather than reaching into
 * `WorktreeManager`'s private dirty-tree check or
 * `createProductionCampaignRunner`'s runtime-scoped isolation call: both
 * fire only once a worktree/runtime is already being constructed, too late
 * to collect into one up-front report without side effects — a real
 * `acquireLease` call installs dependencies and creates a worktree the
 * moment its dirty-tree check passes. `probeGreenfieldDirtyTree` below
 * reissues the identical read-only `git status` `WorktreeManager.acquireLease`
 * runs, ignoring the same `.arbor`/`.worktrees`/persistence-dir roots,
 * purely to report; the real acquire still runs its own check later,
 * unweakened, once the campaign actually starts.
 */
const GREENFIELD_VALUE_FLAGS: ReadonlySet<string> = new Set(["--tier", "--attach"]);
/** Tier validity, target isolation, dirty tree — the three ADR-114 §1 runs together before dispatch. */
const GREENFIELD_PREFLIGHT_CHECKS = 3;

function greenfieldUsage(stderr: Writable): number {
  stderr.write("Usage: arbor greenfield <intent> [--tier direct|reviewed|governed] [--json] [--plan] [--allow-primary-checkout]\n");
  stderr.write("       arbor greenfield --help\n");
  return EXIT_CODES.USAGE;
}

function printGreenfieldHelp(stdout: Writable): void {
  stdout.write([
    "Usage: arbor greenfield <intent> [--tier direct|reviewed|governed] [--json] [--plan] [--allow-primary-checkout]",
    "",
    "One guided flow for a brand-new target (ADR-114). Runs every preflight blocker —",
    "target isolation safety, the dirty-tree probe, and governance-tier resolution — and",
    "reports every failure found TOGETHER, in one pass, before dispatching anything.",
    "Without --tier, greenfield defaults to 'direct' (skipping the arbiter classifier",
    "`arbor task` runs by default) — matching what an operator hand-supplies every run.",
    "Once every blocker clears, dispatches through the same bare-submit campaign path",
    "`arbor task <intent>` uses.",
    "",
    `Flags: ${TASK_FLAGS.map((flag) => flag.usage).join(" ")}`,
  ].join("\n") + "\n");
}

/**
 * Read-only reissue of `WorktreeManager.acquireLease`'s dirty-tree check
 * (`packages/arbor-campaign-support/src/worktree.ts`), reportable ahead of a
 * real acquire per ADR-114 Decision §1. Deliberately NOT a call into
 * `WorktreeManager` itself — see the doc comment above `GREENFIELD_VALUE_FLAGS`.
 * Ownership boundary: this file only; `worktree.ts` is not touched.
 */
function probeGreenfieldDirtyTree(cwd: string, persistenceDir?: string): string | null {
  const repoRoot = resolve(cwd);
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot, stdio: "pipe", encoding: "utf-8" });
  if (status.status !== 0) {
    return `repository status could not be inspected before isolation: ${(status.stderr || status.stdout).trim() || "git status failed"}`;
  }
  let persistenceRoot: string;
  try {
    persistenceRoot = resolvePersistenceDir(cwd, persistenceDir);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const ignoredRoots = [resolve(repoRoot, ".arbor"), resolve(repoRoot, ".worktrees"), persistenceRoot]
    .filter((root, index, all) => root !== repoRoot && all.indexOf(root) === index);
  const dirtyPaths = status.stdout.split("\n").filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1) ?? "")
    .filter((path) => {
      const absolute = resolve(repoRoot, path);
      return !ignoredRoots.some((root) => absolute === root || absolute.startsWith(`${root}${sep}`));
    });
  if (dirtyPaths.length === 0) return null;
  return `repository has uncommitted product changes that are absent from HEAD (${dirtyPaths.slice(0, 8).join(", ")}${dirtyPaths.length > 8 ? ", …" : ""}); commit, stash, or revert them before starting an isolated campaign`;
}

/**
 * ADR-114 Decision §1: the `arbor greenfield <intent>` subcommand. Collects
 * EVERY preflight blocker (isolation safety, dirty tree, tier validity) into
 * one report before dispatch — never fails fast on the first one found —
 * then dispatches through `taskComposerCommand`'s own bare-submit path,
 * unchanged.
 */
export async function greenfieldCommand(
  args: readonly string[],
  environment: {
    cwd: string; persistence_dir?: string; stdin: Readable; stdout: Writable; stderr: Writable;
    env?: Readonly<Record<string, string | undefined>>; safe_mode?: boolean;
    runtime_factory?: (cwd: string, persistenceDir?: string) => ArborRuntime;
    /** Test-only seam, same shape as `createProductionCampaignRunner`'s: overrides harness-source-checkout detection for `checkGenericTargetSafety`. */
    isolation_guard?: { readonly harness_checkout?: string | null };
  },
  shutdownGate?: ShutdownGate,
): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    printGreenfieldHelp(environment.stdout);
    return EXIT_CODES.SUCCESS;
  }

  // Position-independent flag classification, reusing ADR-116's
  // TASK_FLAG_NAMES so an unknown flag is refused BY NAME wherever it
  // appears — not just in leading position like `task`'s own guard — because
  // greenfield's whole point is surfacing every problem at once rather than
  // silently swallowing one it doesn't recognize into free-text intent.
  const valueSlotIndexes = new Set<number>();
  args.forEach((token, index) => {
    if (GREENFIELD_VALUE_FLAGS.has(token)) valueSlotIndexes.add(index + 1);
  });
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (valueSlotIndexes.has(index)) continue;
    if (token.startsWith("-") && !TASK_FLAG_NAMES.has(token)) {
      environment.stderr.write(`Unknown greenfield option: ${token}\n`);
      return greenfieldUsage(environment.stderr);
    }
  }

  const json = args.includes("--json");
  const allowPrimaryCheckout = args.includes("--allow-primary-checkout");
  const tierFlagIndex = args.indexOf("--tier");
  const tierRequested = tierFlagIndex === -1 ? undefined : args[tierFlagIndex + 1];
  const stripIndexes = new Set<number>(valueSlotIndexes);
  args.forEach((token, index) => { if (TASK_FLAG_NAMES.has(token)) stripIndexes.add(index); });
  const intent = args.filter((_token, index) => !stripIndexes.has(index)).join(" ").trim();

  // Collect every blocker before any of them short-circuits the others —
  // the entire point of this command (ADR-114 Decision §1/O3).
  const blockers: string[] = [];

  if (!intent) blockers.push("no intent text supplied — usage: arbor greenfield <intent>");

  // ADR-114 Decision §1: default `direct`, matching what the operator
  // hand-supplied every run in the ADR's Context — never the arbiter
  // classifier `arbor task`'s own bare submit runs by default.
  // `GREENFIELD_DEFAULT_TIER` (task-composer.ts) is the single resolution
  // point this default is read from — the Console input strip's TUI
  // dispatch (tui.ts) reads the same constant so the two surfaces cannot
  // drift onto different defaults for the identical shape of request.
  let resolvedTier: "direct" | "reviewed" | "governed" = GREENFIELD_DEFAULT_TIER;
  if (tierRequested !== undefined) {
    if (tierRequested !== "direct" && tierRequested !== "reviewed" && tierRequested !== "governed") {
      blockers.push(`--tier requires one of: direct, reviewed, governed (got "${tierRequested}")`);
    } else {
      resolvedTier = tierRequested;
    }
  }

  if (!allowPrimaryCheckout) {
    const safety = checkGenericTargetSafety(environment.cwd, environment.isolation_guard?.harness_checkout === undefined ? {} : { harnessCheckout: environment.isolation_guard.harness_checkout });
    if (!safety.ok) blockers.push(`isolation: ${safety.error.message} (pass --allow-primary-checkout to accept this risk)`);
  }

  const dirtyTreeBlocker = probeGreenfieldDirtyTree(environment.cwd, environment.persistence_dir);
  if (dirtyTreeBlocker !== null) blockers.push(`worktree: ${dirtyTreeBlocker}`);

  if (blockers.length > 0) {
    environment.stderr.write(`arbor greenfield found ${blockers.length} blocker${blockers.length === 1 ? "" : "s"} before dispatch:\n`);
    for (const blocker of blockers) environment.stderr.write(`  - ${blocker}\n`);
    // §-json-safety: the human notice above always goes to stderr, --json or
    // not — a stray human-facing write on the --json path is exactly the
    // defect that broke `resume --json` earlier this session. stdout gets
    // only a machine-readable document, and only when --json was requested.
    if (json) environment.stdout.write(`${JSON.stringify({ ok: false, blockers }, null, 2)}\n`);
    return EXIT_CODES.VIOLATION;
  }

  // Production greenfield admission always joins one repo-local authority
  // before planning can launch a provider. Tests that inject a runtime own
  // their process boundary and intentionally do not spawn a background host.
  if (environment.runtime_factory === undefined) {
    try { await ensureRepoFlightDirector(environment.cwd, resolvePersistenceDir(environment.cwd, environment.persistence_dir)); }
    catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      environment.stderr.write(`arbor greenfield refused dispatch: Flight Director unavailable: ${summary}\n`);
      if (json) environment.stdout.write(`${JSON.stringify({ ok: false, blockers: [`flight-control: ${summary}`] }, null, 2)}\n`);
      return EXIT_CODES.CONFLICT;
    }
  }

  // The passing counterpart of the blocker report above. Without it the flow
  // is silent on success, so an operator cannot tell that the preflight ran at
  // all -- the guided flow's whole promise is that it checked everything once,
  // and a promise kept invisibly reads the same as one not made. stderr, so
  // the --json contract above is unaffected.
  environment.stderr.write(`arbor greenfield: ${GREENFIELD_PREFLIGHT_CHECKS} preflight checks passed, dispatching at tier ${resolvedTier}\n`);

  // Every blocker cleared — dispatch through the SAME bare-submit path
  // `arbor task <text>` uses, never a second admission code path.
  const dispatchArgs = tierFlagIndex === -1 ? [...args, "--tier", resolvedTier] : [...args];
  try {
    return await taskComposerCommand(dispatchArgs, { ...environment, require_repo_flight: environment.runtime_factory === undefined }, shutdownGate);
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    environment.stderr.write(`arbor greenfield refused dispatch: Flight Director composition failed: ${summary}\n`);
    if (json) environment.stdout.write(`${JSON.stringify({ ok: false, blockers: [`flight-control: ${summary}`] }, null, 2)}\n`);
    return EXIT_CODES.CONFLICT;
  }
}

function sessionStartUsage(stderr: Writable): number {
  stderr.write("Usage: arbor session start <text> [--tier direct|reviewed|governed] [--json]\n");
  stderr.write("       arbor session start --help\n");
  return EXIT_CODES.USAGE;
}

function printSessionStartHelp(stdout: Writable): void {
  stdout.write([
    "Usage: arbor session start <text> [--tier direct|reviewed|governed] [--json]",
    "",
    "Open a live, turn-by-turn interactive session from a cold terminal prompt (ADR-107).",
    "The first message plans and admits a campaign exactly like `arbor task` does — the",
    "same classification, the same governance gate, the same ledger record. Every later",
    "message you type is steering into that already-admitted campaign's live turn loop,",
    "never a second admission.",
    "",
    "Without --tier, a cheap arbiter classifies the task's governance tier before planning.",
    "--tier records an operator-forced override and skips the arbiter call.",
    "",
    "In a TTY, this attaches to the resulting live session: type a message and press Enter",
    "to steer it, type /interrupt (or press Ctrl+C) to stop it, /quit detaches without",
    "stopping it. --json prints the admission result (and the live session id, if one",
    "appeared within 30s) once and exits without attaching.",
  ].join("\n") + "\n");
}

/**
 * ADR-107 4: `arbor session start` opens an interactive session directly
 * from the terminal — no prior campaign run required. Its first message
 * admits a campaign exactly the way `arbor task`'s bare submit does (ADR-107
 * 1): one `taskcomposer.submit` with `auto_confirm: true`, which plans,
 * classifies mutating actions via `classifyAndRepairMutatingActions`, and
 * calls `admission.admit(...)` — the SAME admission gate, not a second one.
 * This function performs exactly that one admission; everything after it
 * (the interactive loop below) only steers or interrupts the session that
 * admission already started, through the unchanged `harness.session.steer`/
 * `harness.session.interrupt` commands `LiveNativeSessionRegistry` already
 * exposes (ADR-107 2 adds no new approval gate for this).
 */
export async function sessionStartCommand(
  args: readonly string[],
  environment: {
    cwd: string; persistence_dir?: string; stdin: Readable; stdout: Writable; stderr: Writable; env?: Readonly<Record<string, string | undefined>>; safe_mode?: boolean;
    runtime_factory?: (cwd: string, persistenceDir?: string) => ArborRuntime;
    /** Test-only seam: how long to wait for a live session to register before reporting `null`. Defaults to 30s. */
    live_session_attach_timeout_ms?: number;
  },
): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") { printSessionStartHelp(environment.stdout); return EXIT_CODES.SUCCESS; }
  const json = args.includes("--json");
  const tierFlagIndex = args.indexOf("--tier");
  const tierOverride = tierFlagIndex === -1 ? undefined : args[tierFlagIndex + 1];
  if (tierFlagIndex !== -1 && tierOverride !== "direct" && tierOverride !== "reviewed" && tierOverride !== "governed") {
    environment.stderr.write("--tier requires one of: direct, reviewed, governed\n");
    return sessionStartUsage(environment.stderr);
  }
  const withoutFlags = args.filter((value, index) => value !== "--json" && (tierFlagIndex === -1 || (index !== tierFlagIndex && index !== tierFlagIndex + 1)));
  const task = withoutFlags.join(" ").trim();
  if (!task) return sessionStartUsage(environment.stderr);
  const lock = takeWriterLock(resolvePersistenceDir(environment.cwd, environment.persistence_dir), "task", environment.stderr);
  if (lock === null) return EXIT_CODES.CONFLICT;
  const runtime = environment.runtime_factory
    ? environment.runtime_factory(environment.cwd, environment.persistence_dir)
    : createCliRuntime(environment.cwd, environment.persistence_dir, { safeMode: environment.safe_mode, env: environment.env ?? process.env });
  try {
    const started = await runtime.start();
    if (!started.ok) {
      environment.stderr.write(`${started.failures.map((failure) => failure.summary).join("; ") || "session runtime failed to start"}\n`);
      lock.release();
      return EXIT_CODES.FAILURE;
    }
    const router = new RuntimeCatalogRouter(runtime);
    const stamp = `cli:session-start:${crypto.randomUUID()}`;
    const submission = await router.dispatchCommand({
      schema_version: 1,
      metadata: { operation_id: stamp, idempotency_key: stamp, correlation_id: stamp, actor_id: "cli-operator", requested_at: new Date().toISOString() },
      command: { kind: "taskcomposer.submit", task, source: "cli", idempotency_key: stamp, auto_confirm: true, ...(tierOverride === undefined ? {} : { tier_override: tierOverride }) },
    } as never);
    // The admission call above is durably recorded (ledger + campaign/node)
    // by the time it resolves. Nothing this process does past this point can
    // still be racing that write, so the writer lock's job is done.
    lock.release();
    const draft = (submission as { ok?: unknown; value?: { draft?: { status?: unknown; campaign_id?: string | null } } }).value?.draft;
    if ((submission as { ok?: unknown }).ok !== true || draft === undefined || draft.status !== "admitted" || !draft.campaign_id) {
      environment.stdout.write(`${JSON.stringify(submission, null, 2)}\n`);
      return taskResultExitCode(submission);
    }
    const campaignId = draft.campaign_id;
    const liveSessionId = await waitForLiveSession(runtime, campaignId, environment.live_session_attach_timeout_ms ?? 30_000);
    const tty = (environment.stdout as Writable & { isTTY?: boolean }).isTTY === true && !json;
    if (!tty) {
      environment.stdout.write(`${JSON.stringify({ ...(submission as Record<string, unknown>), live_session_id: liveSessionId }, null, 2)}\n`);
      return liveSessionId === null ? EXIT_CODES.PARTIAL : EXIT_CODES.SUCCESS;
    }
    if (liveSessionId === null) {
      environment.stderr.write(`Campaign ${campaignId} was admitted, but no live interactive session appeared within 30s — inspect it with \`arbor session availability ${campaignId}\` or \`arbor tui\`.\n`);
      return EXIT_CODES.PARTIAL;
    }
    return await runInteractiveSessionRepl(router, runtime, liveSessionId, environment);
  } finally {
    await boundedRuntimeClose(runtime);
  }
}

/**
 * Bounded poll for the live session `admission.admit(...)` just started to
 * register in `LiveNativeSessionRegistry` (registration happens inside the
 * native executor once the admitted node actually dispatches — see
 * `native-loop-executor.ts`'s `live_sessions.register(...)`, not inside
 * admission itself). A real deadline, not an unbounded wait: the campaign
 * may fall back to a non-native connector with no live session concept at
 * all, in which case this correctly returns `null` rather than hanging.
 */
async function waitForLiveSession(runtime: ArborRuntime, campaignId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const live = runtime.nativeSessionRegistry.list().find((session) => session.campaign_id === campaignId);
    if (live !== undefined) return live.session_id;
    if (Date.now() >= deadline) return null;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
}

/**
 * The interactive turn-by-turn loop (ADR-107 3's terminal counterpart): every
 * line the operator types dispatches `harness.session.steer` into the
 * already-admitted, already-live session; `/interrupt` or Ctrl+C dispatches
 * `harness.session.interrupt`. Neither ever admits a new campaign — both
 * commands go through the exact same `RuntimeCatalogRouter` dispatch every
 * other CLI/TUI command surface uses, never a direct registry call.
 */
async function runInteractiveSessionRepl(
  router: RuntimeCatalogRouter,
  runtime: ArborRuntime,
  sessionId: string,
  environment: { stdin: Readable; stdout: Writable; stderr: Writable },
): Promise<number> {
  environment.stdout.write(`Attached to live session ${sessionId}. Type a message and press Enter to steer it; /interrupt (or Ctrl+C) stops it; /quit detaches without stopping it.\n`);
  const dispatchSessionCommand = (kind: "harness.session.steer" | "harness.session.interrupt", params: Record<string, unknown>): Promise<unknown> => {
    const stamp = `cli:${kind}:${crypto.randomUUID()}`;
    return router.dispatchCommand({
      schema_version: 1,
      metadata: { operation_id: stamp, idempotency_key: stamp, correlation_id: stamp, actor_id: "cli-operator", requested_at: new Date().toISOString() },
      command: { kind, session_id: sessionId, provenance: { tag: "claimed", claimant: "cli-operator" }, ...params },
    } as never);
  };
  let cursor = 0;
  let stopped = false;
  const printNewEvents = (): void => {
    const events = runtime.nativeSessionRegistry.events(sessionId, cursor) ?? [];
    for (const event of events) {
      cursor = Math.max(cursor, event.sequence);
      environment.stdout.write(`[${event.sequence}] ${event.kind}\n`);
    }
  };
  printNewEvents();
  const rl = createInterface({ input: environment.stdin, output: environment.stdout, prompt: "> " });
  const poller = setInterval(() => {
    printNewEvents();
    const inspection = runtime.nativeSessionRegistry.inspect(sessionId);
    if (inspection !== null && inspection.terminal !== null && !stopped) {
      stopped = true;
      environment.stdout.write(`Session ${sessionId} ended (${inspection.terminal.cause}).\n`);
      rl.close();
    }
  }, 500);
  poller.unref?.();
  rl.prompt();
  return new Promise<number>((resolveExit) => {
    const finish = (code: number): void => {
      clearInterval(poller);
      rl.close();
      resolveExit(code);
    };
    rl.on("line", (line) => {
      const text = line.trim();
      if (stopped) { finish(EXIT_CODES.SUCCESS); return; }
      if (text === "/quit") { finish(EXIT_CODES.SUCCESS); return; }
      if (text === "/interrupt") {
        void dispatchSessionCommand("harness.session.interrupt", { reason: "operator requested stop from arbor session start" });
        rl.prompt();
        return;
      }
      if (!text) { rl.prompt(); return; }
      void dispatchSessionCommand("harness.session.steer", { message: text }).then((result) => {
        if ((result as { ok?: unknown }).ok !== true) environment.stderr.write(`${JSON.stringify(result)}\n`);
        if (!stopped) rl.prompt();
      });
    });
    rl.on("SIGINT", () => {
      void dispatchSessionCommand("harness.session.interrupt", { reason: "operator interrupted from arbor session start (Ctrl+C)" }).finally(() => finish(EXIT_CODES.SUCCESS));
    });
    rl.on("close", () => finish(EXIT_CODES.SUCCESS));
  });
}

/** Genuine `arbor task --help` content — every subcommand, not a one-line stub. */
function printTaskHelp(stdout: Writable): void {
  stdout.write([
    "Usage: arbor task <text> [--json]",
    "",
    "Describe a change in plain language. Revoy plans it, applies its safety checks,",
    "starts the work, and waits for the result by default.",
    "",
    "Commands:",
    "  arbor task <text> [--attach <image>]... [--tier direct|reviewed|governed] [--json]",
    "      Run free-form task text end to end. If one detail is missing, Revoy",
    "      returns a plain-language question and continues after your answer.",
    "      Without --tier, a cheap arbiter classifies the task's governance",
    "      tier (direct/reviewed/governed) before planning. --tier records an",
    "      operator-forced override and skips the arbiter call.",
    "      --attach accepts up to four PNG, JPEG, GIF, or WebP images. Media",
    "      uses governed planning and requires an explicitly image-capable native provider.",
    "  arbor task list [--limit 1..100] [--json]",
    "      List known task drafts, most recent first.",
    "  arbor task show <draft-id> [--json]",
    "      Show one draft's current status and proposal.",
    "  arbor task answer <draft-id> <revision> <question-id> <text> [--json]",
    "      Answer a clarification question the planner raised on a draft.",
    "  arbor task confirm <draft-id> <revision> [--wait] [--json]",
    "      Approve a still-`proposed` draft and start its campaign. --wait",
    "      blocks until the campaign settles and reports its result.",
    "      WA-68: bare `arbor task <text>` (no --plan) already confirms and",
    "      waits for you, for every tier — by the time it returns, the draft",
    "      is already `admitted`. Running confirm again on that draft id is",
    "      then a fast no-op replay of the existing admission, not a fresh",
    "      approve-and-execute; use it to attach --wait to an already-running",
    "      campaign, or to admit a draft created with --plan.",
    "  arbor task retry <draft-id> <revision> [--json]",
    "      Retry an interrupted, cancelled, or failed draft in place.",
    "  arbor task reject <draft-id> <revision> <reason> [--json]",
    "      Reject a proposed draft with a reason.",
    "  arbor task follow-up <campaign-id> <text> [--json]",
    "      Submit a new task linked to a completed campaign.",
    "",
    "Options:",
    // ADR-116: rendered from TASK_FLAGS (shared with `taskUsage`'s compact
    // token line) so the two surfaces can never again independently drift
    // on which flags exist.
    ...TASK_FLAGS.map((flag) => `  ${flag.name}${" ".repeat(Math.max(1, 12 - flag.name.length))}${flag.help}`),
    "",
    "Exit codes: 0 success · 2 usage error · 3 partial (halted with no verified",
    "result) · 4 conflict (draft/campaign refused the request) · 1 unexpected",
    "failure (see exit-codes.ts).",
  ].join("\n"));
}

/** Extract the confirmed/submitted draft from a dispatch acknowledgement, if any. */
function extractTaskDraft(result: unknown): TaskComposerDraft | null {
  const value = (result as { value?: { draft?: TaskComposerDraft } } | undefined)?.value;
  return value?.draft ?? null;
}

/** Extract a human-readable dispatch/admission failure summary, if any. */
/**
 * E-8: after a successful `arbor adopt --apply`, mark that node's waiver
 * outcome record (if it has one — most adopted nodes were never
 * review-waived at all) as adopted. Best-effort and silent on failure: an
 * unreadable/corrupt ledger, or a node with no waiver record, must never
 * turn an otherwise-successful adoption into a reported failure — the patch
 * is already applied to the working tree by the time this runs.
 */
export function recordWaiverAdoptionIfWaived(persistenceDir: string, campaignId: string, nodeId: string): void {
  try {
    const ledger = loadLedger(persistenceDir, campaignId);
    const waiver = ledger.getWaiverOutcomes(campaignId).find((record) => record.node_id === nodeId);
    if (!waiver) return;
    ledger.recordWaiverOutcomeAmendment({
      campaign_id: campaignId, node_id: nodeId,
      waiver_record_id: waiver.id, kind: "adopted", value: true,
      recorded_by: "arbor-adopt", reason: "arbor adopt --apply applied this node's captured changes",
      idempotency_key: `${waiver.id}:adopted`,
    });
    saveLedger(ledger, persistenceDir, campaignId);
  } catch {
    // Best-effort — see doc comment above.
  }
}

function extractTaskDispatchError(result: unknown): string | null {
  const view = result as { ok?: unknown; value?: { accepted?: unknown; error?: { summary?: unknown } }; error?: { summary?: unknown } } | undefined;
  const error = view?.ok === false ? view.error : view?.value?.accepted === false ? view.value.error : null;
  if (!error) return null;
  return typeof error.summary === "string" ? error.summary : JSON.stringify(error);
}

/** U2: human summary for `arbor task <text>` on a TTY without --json. */
function formatTaskSubmitSummary(result: unknown): string {
  const dispatchError = extractTaskDispatchError(result);
  if (dispatchError) return `Task submission refused: ${dispatchError}`;
  const draft = extractTaskDraft(result);
  if (!draft) return JSON.stringify(result, null, 2);
  const campaignResult = (result as { campaign_result?: { campaign_id?: unknown; task_state?: unknown; halted?: unknown; halt_reason?: unknown; best_node_state?: unknown; awaiting_user_input?: unknown; error?: unknown; failure_summary?: unknown } } | undefined)?.campaign_result;
  if (campaignResult) {
    const campaignId = String(campaignResult.campaign_id ?? draft.campaign_id ?? "unknown");
    const lines = [campaignResult.awaiting_user_input === true ? "Revoy needs your input" : campaignResult.best_node_state === "verified" ? "Task completed and verified" : "Task run finished", `Campaign ${campaignId}: ${String(campaignResult.task_state ?? "unknown")}`];
    if (campaignResult.error !== undefined) lines.push(`The run could not be observed cleanly: ${String(campaignResult.error)}`);
    if (campaignResult.halted) lines.push(`Stopped because: ${String(campaignResult.halt_reason ?? "unspecified")}`);
    if (campaignResult.failure_summary) lines.push(`Root cause: ${String(campaignResult.failure_summary)}`);
    lines.push(campaignResult.awaiting_user_input === true
      ? "Next: answer the question shown in the TUI or Web workspace, then continue the task."
      : campaignResult.best_node_state === "verified"
        ? `Next: arbor adopt --campaign ${campaignId} --apply`
        : `Next: arbor report --campaign ${campaignId}`);
    return lines.join("\n");
  }
  const lines = [`${draft.guidance?.headline ?? `Task ${draft.status}`}`, draft.guidance?.detail ?? `Draft ${draft.id} is ${draft.status}.`];
  if (draft.guidance?.recommendation) lines.push(`Next: ${draft.guidance.recommendation}`);
  if (draft.proposal) {
    lines.push(`Proposal: ${draft.proposal.summary.split("\n")[0]}`);
    const unanswered = draft.proposal.questions.filter((question) => question.answer === null);
    if (unanswered.length > 0) {
      lines.push("Clarification needed:");
      for (const question of unanswered) lines.push(`  - [${question.id}] ${question.question}`);
      lines.push(`Next: arbor task answer ${draft.id} ${draft.revision} ${unanswered[0]!.id} "<answer>"`);
    } else if (draft.status === "proposed") {
      lines.push(`Review-only draft: arbor task confirm ${draft.id} ${draft.revision} --wait`);
    }
  } else if (draft.status === "failed" && draft.planner.error) {
    if (!draft.guidance) lines.push(`Planner error: ${draft.planner.error}`, "Next: run `arbor doctor`, then retry the same request.");
  }
  return lines.join("\n");
}

/** U2: human summary for `arbor task confirm ...` on a TTY without --json. */
export function formatTaskConfirmSummary(result: unknown): string {
  const dispatchError = extractTaskDispatchError(result);
  if (dispatchError) return `Confirm refused: ${dispatchError}`;
  const draft = extractTaskDraft(result);
  const campaignResult = (result as { campaign_result?: {
    campaign_id?: unknown; task_state?: unknown; halted?: unknown; halt_reason?: unknown;
    best_node_id?: unknown; best_node_state?: unknown; terminal_outcome?: unknown; error?: unknown;
    run_diagnostic?: { summary?: unknown } | null;
  } } | undefined)?.campaign_result;
  const lines: string[] = [];
  // WA-68: this may be the confirm that actually admitted the draft, or a
  // fast no-op replay of an admission `arbor task <text>` already performed
  // (auto-confirm runs for every tier unless the draft was created with
  // --plan) — "confirm acknowledged" is honest in both cases; "confirmed"
  // alone reads as this call having just approved and started the work.
  if (draft) lines.push(`Draft ${draft.id} confirm acknowledged (status: ${draft.status})`);
  if (draft?.arbiter_decision) lines.push(`Governance tier: ${draft.arbiter_decision.tier} (${draft.arbiter_decision.source}) — ${draft.arbiter_decision.rationale}`);
  if (!campaignResult) {
    if (draft?.campaign_id) {
      lines.push(`Campaign: ${draft.campaign_id}${draft.job_id ? ` (job ${draft.job_id})` : ""}`);
      lines.push(`Next: arbor task confirm ${draft.id} ${draft.revision} --wait   (or arbor devtools tail ${draft.campaign_id})`);
    }
    return lines.length > 0 ? lines.join("\n") : JSON.stringify(result, null, 2);
  }
  const campaignId = String(campaignResult.campaign_id ?? "unknown");
  if (campaignResult.error !== undefined) {
    lines.push(`Campaign: ${campaignId}`, `Error awaiting campaign: ${String(campaignResult.error)}`, `Next: arbor devtools tail ${campaignId}`);
    return lines.join("\n");
  }
  lines.push(`Campaign: ${campaignId}`);
  lines.push(`Task state: ${String(campaignResult.task_state ?? "unknown")}`);
  if (campaignResult.halted) lines.push(`Halted: ${String(campaignResult.halt_reason ?? "unspecified")}`);
  // WA-40: a gate refusal (e.g. the isolation gate) recorded before any
  // specialist ran otherwise left the human summary reading no differently
  // from an ordinary exhaustion halt — the durable diagnostic carries the
  // actual gate detail already recorded in the ledger.
  if (typeof campaignResult.run_diagnostic?.summary === "string") lines.push(`Diagnostic: ${campaignResult.run_diagnostic.summary}`);
  lines.push(`Best node: ${campaignResult.best_node_id ? String(campaignResult.best_node_id) : "none"} (${campaignResult.best_node_state ? String(campaignResult.best_node_state) : "none"})`);
  const next = campaignResult.best_node_state === "verified"
    ? `arbor adopt --campaign ${campaignId} --apply`
    : `arbor report --campaign ${campaignId}`;
  lines.push(`Next: ${next}`);
  return lines.join("\n");
}

/** S3a: human summary for `arbor report --campaign <id>` on a TTY without --json. */
function formatRunReportSummary(result: RunReportResult): string {
  if (!result.ok) return `Report unavailable: ${result.error.summary}`;
  const { value } = result;
  const campaign = value.campaign;
  const lines: string[] = [
    `Campaign ${campaign.id}`,
    `Outcome: ${campaign.halted ? `halted (${campaign.halt_reason})` : "in progress"}, best score ${campaign.best_score}, ${campaign.iterations_completed} iteration(s) completed`,
  ];
  if (campaign.governance) lines.push(`Governance tier: ${campaign.governance.tier} (${campaign.governance.source}) — ${campaign.governance.rationale}`);
  if (value.gate_refusal !== null) {
    const refusal = value.gate_refusal;
    lines.push(`Gate ${refusal.gate} ${refusal.state}: ${refusal.summary}`, `Correcting actor: ${refusal.correcting_actor}; evidence deficit: ${refusal.evidence_deficit}`, `Remedy: ${refusal.remediation}`, `Corrective action: ${refusal.corrective_action}`);
  }
  // E-8: one-line waiver-outcome rollup. Shown even at zero — "0 waived
  // results this campaign" is itself a fact, not noise to suppress.
  const waivers = value.waiver_outcomes;
  lines.push(`Waived outcomes: ${waivers.adopted} adopted, ${waivers.unadjudicated} unadjudicated (${waivers.entries.length} total)`);
  if (campaign.nodes.length === 0) {
    lines.push("Nodes: (none)");
    return lines.join("\n");
  }
  const rows = campaign.nodes.map((node) => ({
    id: node.id,
    state: node.state,
    score: String(node.score),
    root_cause: node.state === "failed" ? runReportNodeRootCause(node) : "",
  }));
  const widths = {
    id: Math.max("ID".length, ...rows.map((r) => r.id.length)),
    state: Math.max("STATE".length, ...rows.map((r) => r.state.length)),
    score: Math.max("SCORE".length, ...rows.map((r) => r.score.length)),
  };
  lines.push("", `${"ID".padEnd(widths.id)}  ${"STATE".padEnd(widths.state)}  ${"SCORE".padEnd(widths.score)}  ROOT CAUSE`);
  for (const row of rows) {
    lines.push(`${row.id.padEnd(widths.id)}  ${row.state.padEnd(widths.state)}  ${row.score.padEnd(widths.score)}  ${row.root_cause || "-"}`);
  }
  // A node that failed on an authority's refusal (e.g. a budget ceiling)
  // carries a typed remedy; name its correcting actor and action here so the
  // operator does not have to open the JSON to learn who can clear it.
  for (const node of campaign.nodes) {
    const remedy = node.outcome?.kind === "error" && (node.outcome.error.kind === "internal_error" || node.outcome.error.kind === "policy_refused") ? node.outcome.error.remedy : undefined;
    if (remedy !== undefined) lines.push(`Node ${node.id} ${remedy.gate} ${remedy.state}: correcting actor ${remedy.correcting_actor}; corrective action ${remedy.corrective_action}. Remedy: ${remedy.remediation}`);
  }
  lines.push("", `Next: arbor report --campaign ${campaign.id} --json   (full evidence, ledger, and thread projections)`);
  return lines.join("\n");
}

/** Best-effort human root-cause text for a failed node: a classified `NodeError` message, else `failNode`'s free-text reason. */
function runReportNodeRootCause(node: Extract<RunReportResult, { ok: true }>["value"]["campaign"]["nodes"][number]): string {
  if (node.outcome?.kind === "error") return node.outcome.error.message;
  if (typeof node.specialist_output === "string" && node.specialist_output.startsWith("FAILED: ")) return node.specialist_output.slice("FAILED: ".length);
  return node.outcome?.kind === "verdict" ? node.outcome.message : "unspecified";
}

function taskLimit(args: readonly string[]): number | null {
  if (args.length === 0) return 50;
  if (args.length !== 2 || args[0] !== "--limit") return null;
  const value = Number(args[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : null;
}

function parseTaskRevision(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function taskUsage(stderr: Writable): number {
  stderr.write("Usage: arbor-mcp task <text> [--attach <image>]... [--json]\n");
  stderr.write("       arbor-mcp task list [--limit 1..100] [--json]\n");
  stderr.write("       arbor-mcp task show <draft-id> [--json]\n");
  stderr.write("       arbor-mcp task answer <draft-id> <revision> <question-id> <text> [--json]\n");
  stderr.write("       arbor-mcp task confirm <draft-id> <revision> [--wait] [--json]\n");
  stderr.write("       arbor-mcp task reject <draft-id> <revision> <reason> [--json]\n");
  stderr.write("       arbor-mcp task follow-up <campaign-id> <text> [--json]\n");
  stderr.write("       arbor-mcp task --help\n");
  // ADR-116: rendered from TASK_FLAGS (shared with printTaskHelp's Options
  // section) so this usage text and `arbor task --help` can never again
  // independently drift on which flags exist — the exact disagreement that
  // let `--tier` be documented in one and absent from the other.
  stderr.write(`Flags: ${TASK_FLAGS.map((flag) => flag.usage).join(" ")}\n`);
  return EXIT_CODES.USAGE;
}

/**
 * Opt-in blocking mode for `task confirm`: await the exact supervised
 * `campaign.run` job the confirm just started — `ArborRuntime.awaitCampaignRun`
 * hands back the same settlement `runCampaignJob`'s fire-and-forget dispatch
 * already computes, so this starts no second run and polls nothing. A
 * confirm that never started a job (a rejected/failed proposal, or an
 * admission-gate or submission failure — see `task-composer-admission.ts`)
 * has no `campaign_id`/`job_id` and is returned unchanged; an already-settled
 * run (e.g. a replayed idempotent re-confirm) resolves immediately because
 * `awaitCampaignRun` hands back an already-resolved promise.
 *
 * U6: once a campaign was genuinely awaited (campaign_id/job_id present),
 * this ALWAYS returns an envelope carrying `campaign_result` — never the
 * bare confirm envelope. `runtime.awaitCampaignRun`/`getCampaignSnapshot`/
 * `listCampaigns` are read paths and not expected to throw, but if one ever
 * does, the throw is caught here and reported as
 * `campaign_result: { campaign_id, job_id, error }` rather than propagating
 * out of `taskComposerCommand` uncaught (which previously meant the CLI
 * crashed with no JSON printed at all instead of reporting what it knew).
 */
export async function awaitConfirmedCampaign(runtime: ArborRuntime, shutdownGate: ShutdownGate | undefined, confirmResult: unknown, onProgress?: (line: string) => void): Promise<unknown> {
  const draft = (confirmResult as { value?: { draft?: { campaign_id: string | null; job_id: string | null } } }).value?.draft;
  if (!draft || draft.campaign_id === null || draft.job_id === null) return confirmResult;
  const campaignId = draft.campaign_id;
  const jobId = draft.job_id;
  let lastProgress = "";
  const publishProgress = (terminal = false): void => {
    if (!onProgress) return;
    const snapshot = runtime.manager.getCampaignSnapshot(campaignId);
    const listed = runtime.manager.listCampaigns().find((campaign) => campaign.id === campaignId);
    const active = snapshot?.nodes.find((node) => node.state === "expanding");
    const verified = listed?.verified_nodes ?? snapshot?.nodes.filter((node) => node.state === "verified").length ?? 0;
    const total = snapshot?.nodes.length ?? 0;
    const phase = terminal ? (verified > 0 ? "verified" : snapshot?.halted ? "halted" : "settled") : active ? "executing" : "reviewing";
    const line = `[revoy] ${phase}: campaign ${campaignId} · nodes ${total} · verified ${verified}${active ? ` · active ${active.id}` : ""}`;
    if (line !== lastProgress) { lastProgress = line; onProgress(line); }
  };
  // Real SIGINT/SIGTERM routing while blocked below, mirroring `serve`/
  // `webui`'s own `shutdownGate.bind`: an operator Ctrl-C reaches the same
  // durable, ledger-recorded `runtime.interrupt()` path, which cancels the
  // actively-expanding node's supervised job — that cancellation is what
  // actually unblocks `awaitCampaignRun` below, not a race against the
  // gate's own ack timer.
  shutdownGate?.bind(runtime);
  publishProgress();
  const progressTimer = onProgress ? setInterval(() => publishProgress(), 1_000) : null;
  progressTimer?.unref?.();
  try {
    const settlement = await runtime.awaitCampaignRun(campaignId);
    if (progressTimer) clearInterval(progressTimer);
    publishProgress(true);
    const snapshot = runtime.manager.getCampaignSnapshot(campaignId);
    const bestNode = snapshot ? bestResultNode(snapshot) : null;
    // `terminal_outcome` (manager.ts's own false-completion remediation) is
    // the authoritative signal for "halted with zero verified nodes and
    // nothing legitimately pending" — the exact B1 shape (a `no_nodes` halt
    // with zero verified results reading as an ordinary "completed" run).
    const listed = runtime.manager.listCampaigns().find((campaign) => campaign.id === campaignId);
    return {
      ...(confirmResult as Record<string, unknown>),
      campaign_result: {
        campaign_id: campaignId,
        job_id: jobId,
        task_state: settlement.task_state,
        job_state: settlement.task_state === "failed" ? "failed" : settlement.task_state === null ? "unknown" : "settled",
        halted: snapshot?.halted ?? null,
        halt_reason: snapshot?.halt_reason ?? null,
        best_score: snapshot?.best_score ?? null,
        iterations_completed: snapshot?.iterations_completed ?? null,
        best_node_id: bestNode?.id ?? null,
        best_node_state: bestNode?.state ?? null,
        // ab3 bench: a read-only investigation's entire deliverable is this
        // text; omitting it made `task confirm --wait` lose the answer.
        best_node_output: bestNode?.output ?? null,
        verified_nodes: listed?.verified_nodes ?? null,
        terminal_outcome: listed?.terminal_outcome ?? null,
        awaiting_user_input: runtime.manager.awaitingUserInput(campaignId),
        run_diagnostic: settlement.diagnostic ?? null,
        failure_summary: campaignFailureSummary(snapshot),
        gate_refusal: latestGateRefusal(snapshot),
      },
    };
  } catch (error) {
    if (progressTimer) clearInterval(progressTimer);
    onProgress?.(`[revoy] failed: campaign ${campaignId} · ${error instanceof Error ? error.message : String(error)}`);
    return {
      ...(confirmResult as Record<string, unknown>),
      campaign_result: {
        campaign_id: campaignId,
        job_id: jobId,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * ADR-118: the versioned gate-refusal counterpart to `campaignFailureSummary`
 * below — the latest recorded admission/isolation/evidence/audit gate
 * fail/bypass across every node in the campaign, projected through the
 * shared, bounded read model instead of leaving `failure_summary`'s free-text
 * node output as the only failure signal `task confirm --wait` reports. Scans
 * every node (not just the root) because a halt can follow a gate recorded on
 * any expanded node. `null` covers both "no snapshot" and "no refusal
 * recorded" — consistent with every other `snapshot?.… ?? null` field this
 * envelope already reports for an unavailable snapshot.
 */
export function latestGateRefusal(snapshot: ReturnType<ArborRuntime["manager"]["getCampaignSnapshot"]>): GateRefusalProjection | null {
  if (!snapshot) return null;
  const latest = [...snapshot.nodes.flatMap((node) => node.gate_records)].reverse().find((record) => record.result !== "pass");
  if (!latest) return null;
  return projectGateRecord(latest, defaultGateRemediation(latest.gate));
}

/** Surface the latest actionable failed-node reason instead of opaque no_nodes. */
export function campaignFailureSummary(snapshot: ReturnType<ArborRuntime["manager"]["getCampaignSnapshot"]>): string | null {
  if (!snapshot) return null;
  const failure = [...snapshot.nodes].reverse().find((node) => node.state === "failed" && typeof node.specialist_output === "string" && node.specialist_output.trim().length > 0);
  if (!failure?.specialist_output) return null;
  const text = failure.specialist_output.trim();
  return text.length <= 1_024 ? text : `${text.slice(0, 1_024)}…`;
}

/** Bench v3 (ab3) finding: keep the answer, cap the envelope. */
const BEST_NODE_OUTPUT_MAX_CHARS = 8_000;

/** Prefer a verified adoptable result, then fall back to the highest score. */
export function bestResultNode(
  snapshot: NonNullable<ReturnType<ArborRuntime["manager"]["getCampaignSnapshot"]>>,
): { id: string; state: string; output: string | null } | null {
  let best: { id: string; state: string; score: number; output: string | null } | null = null;
  const verified = snapshot.nodes.filter((node) => node.state === "verified");
  for (const node of verified.length > 0 ? verified : snapshot.nodes) {
    if (best === null || node.score > best.score) {
      const output = node.specialist_output ?? null;
      best = {
        id: node.id,
        state: node.state,
        score: node.score,
        output: output !== null && output.length > BEST_NODE_OUTPUT_MAX_CHARS
          ? `${output.slice(0, BEST_NODE_OUTPUT_MAX_CHARS)}\n…[truncated ${output.length - BEST_NODE_OUTPUT_MAX_CHARS} chars; full text persists on the node]`
          : output,
      };
    }
  }
  return best;
}

/**
 * B1(cli half): a campaign that halted with zero verified nodes (manager.ts's
 * `terminal_outcome` "failed"/"partial" — see `deriveTerminalOutcome`'s own
 * false-completion doc) must never exit 0 as if the run succeeded. `0` is
 * reserved for a campaign that produced a genuinely verified result
 * (`terminal_outcome: "completed"`) or is legitimately still awaiting
 * operator input — never for a hollow halt.
 */
export function taskResultExitCode(result: unknown): number {
  if (result === null || typeof result !== "object") return EXIT_CODES.SUCCESS;
  const view = result as {
    ok?: unknown;
    value?: { accepted?: unknown; draft?: { status?: unknown } };
    campaign_result?: { task_state?: unknown; error?: unknown; terminal_outcome?: unknown; awaiting_user_input?: unknown };
  };
  if (view.ok === false || view.value?.accepted === false) return EXIT_CODES.CONFLICT;
  if (view.value?.draft?.status === "failed") return EXIT_CODES.FAILURE;
  const campaignResult = view.campaign_result;
  if (campaignResult) {
    // An internal throw while awaiting/inspecting the campaign (U6's catch
    // branch), or the supervised job itself settling `failed` (a genuine
    // operational crash, not a governed halt): an unexpected failure.
    if (campaignResult.error !== undefined || campaignResult.task_state === "failed") return EXIT_CODES.FAILURE;
    // WA-12: a cancelled run (operator interrupt, `job.cancel`, or the
    // caller's own aborted signal) is exactly the "system worked and the
    // answer is [zero verified results]" shape this file's own doc exists
    // to keep off exit 0 — checked ahead of `awaiting_user_input` (a
    // cancelled run is never legitimately still awaiting an answer) and
    // ahead of `terminal_outcome`, since `manager.ts`'s
    // `deriveTerminalOutcome` deliberately never sets `campaign.halted` for
    // a cancelled run (the campaign itself stays resumable), so
    // `terminal_outcome` alone cannot always be trusted to catch this.
    if (campaignResult.task_state === "cancelled" || campaignResult.terminal_outcome === "cancelled") return EXIT_CODES.PARTIAL;
    if (campaignResult.awaiting_user_input === true) return EXIT_CODES.SUCCESS;
    if (campaignResult.terminal_outcome === "failed" || campaignResult.terminal_outcome === "partial") return EXIT_CODES.PARTIAL;
  }
  return EXIT_CODES.SUCCESS;
}

function flagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  return value && !value.startsWith("-") ? value : null;
}

function flagValues(args: readonly string[], flag: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === flag && args[index + 1] !== undefined && !args[index + 1]!.startsWith("-")) values.push(args[index + 1]!);
  return values;
}

function parseRecoveryDispositions(values: readonly string[]): { readonly ok: true; readonly value: readonly RecoveryDisposition[] } | { readonly ok: false; readonly reason: string } {
  const dispositions: RecoveryDisposition[] = [];
  for (const value of values) {
    const separator = value.lastIndexOf("=");
    if (separator <= 0) return { ok: false, reason: `Invalid --disposition ${value}; expected <operation>=retry|accept_observed|compensate|abandon` };
    const operation_id = value.slice(0, separator); const decision = value.slice(separator + 1);
    if (decision !== "retry" && decision !== "accept_observed" && decision !== "compensate" && decision !== "abandon") return { ok: false, reason: `Invalid recovery disposition decision ${decision}` };
    dispositions.push(Object.freeze({ operation_id, decision, reason: `operator disposition: ${decision}` }));
  }
  return { ok: true, value: Object.freeze(dispositions) };
}

function formatRecoveryCommandResult(result: ReturnType<typeof runRecoveryCommand>): string {
  if (!result.ok) return `Recovery blocked: ${result.reason}`;
  if (result.authorized) return `Authorized continuation ${result.authorization_id} as new session ${result.session_id} through supervised task ${result.campaign_task_id}.`;
  if (result.plans.length === 0) return "No interrupted durable sessions matched the recovery target.";
  const lines = [`Crash-continuation preview (${result.plans.length} node${result.plans.length === 1 ? "" : "s"}):`];
  for (const plan of result.plans) {
    lines.push(`  node ${plan.node_id}, source ${plan.source_session_id}@${plan.source_checkpoint}`);
    for (const item of plan.classifications) lines.push(`    ${item.classification}  ${item.operation_id} (${item.operation}) — ${item.reason}`);
    lines.push(`    fresh admissions: ${plan.required_admissions.join(", ")}`);
    if (plan.requires_disposition.length > 0) lines.push(`    explicit disposition required: ${plan.requires_disposition.join(", ")}`);
  }
  lines.push("Authorize with --authorize and one --disposition <operation>=<decision> for every operation listed as requiring disposition.");
  return lines.join("\n");
}

interface RpcMessage { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: unknown; message?: unknown } }
interface McpStdioLifecycle { phase: "awaiting_initialize" | "awaiting_initialized" | "operating"; clientCapabilities: Record<string, unknown>; session_id: string }

function parseError(): object { return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }

async function boundedClose(server: ArborMCPServer): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      server.close(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(serverCloseTimeoutError()), SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    if (result !== undefined && !result.ok) throw runtimeCloseError(result.failures);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function boundedRuntimeClose(runtime: ArborRuntime): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runtime.close(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(runtimeCloseTimeoutError()), SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    if (result !== undefined && !result.ok) throw runtimeCloseError(result.failures);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function runtimeCloseTimeoutError(): Error {
  return new Error(`runtime shutdown failed: timed out after ${SHUTDOWN_TIMEOUT_MS}ms`);
}

function serverCloseTimeoutError(): Error {
  return new Error(`server shutdown failed: timed out after ${SHUTDOWN_TIMEOUT_MS}ms`);
}

function runtimeCloseError(failures: readonly { readonly summary: string }[]): Error {
  return new Error(`runtime shutdown failed: ${failures.map((failure) => failure.summary).join("; ") || "unknown failure"}`);
}

async function closeRuntimeOrThrow(runtime: ArborRuntime): Promise<void> {
  const result = await runtime.close();
  if (!result.ok) throw runtimeCloseError(result.failures);
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

async function handleMessage(server: ArborMCPServer, msg: RpcMessage, lifecycle: McpStdioLifecycle, signal?: AbortSignal): Promise<unknown> {
  const { id, method, params } = msg;
  if (method === "initialize") {
    if (lifecycle.phase !== "awaiting_initialize") return rpcError(id, -32600, "Initialize may only be sent once per stdio session");
    if (!validInitialize(params)) return rpcError(id, -32602, "Initialize requires protocolVersion, capabilities, and clientInfo");
    lifecycle.phase = "awaiting_initialized";
    lifecycle.clientCapabilities = params!.capabilities as Record<string, unknown>;
    // MCP version negotiation is a successful initialize response selecting
    // a server-supported version. A client that cannot speak that version may
    // disconnect; rejecting an otherwise well-formed request with -32602 is
    // not the negotiation behavior.
    return { jsonrpc: "2.0", id, result: initializationNotificationParams(lifecycle.session_id) };
  }
  if (method === "notifications/initialized") {
    if (lifecycle.phase !== "awaiting_initialized") return id === undefined ? null : rpcError(id, -32600, "Initialized notification requires a successful initialize response");
    lifecycle.phase = "operating";
    return null;
  }
  // WA-39/J6-4: a JSON-RPC notification (no `id`) never receives a reply.
  // `notifications/initialized` is the only notification this server
  // understands and it always returns above; every other id-less message —
  // including a method this server doesn't recognize — must be dropped
  // silently here rather than answered, or a conforming client that never
  // expects a reply desyncs its stdio framing waiting for one the
  // notification contract forbids.
  if (method === "notifications/cancelled") return null;
  if (id === undefined) return null;
  // MCP's lifecycle requires capability/version negotiation before normal
  // operation. `ping` is the only harmless pre-initialization request.
  if (method !== "ping" && lifecycle.phase !== "operating") return rpcError(id, -32002, "MCP session is not initialized");
  switch (method) {
    case "ping": return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": return { jsonrpc: "2.0", id, result: { tools: server.listTools() } };
    case "tools/call": {
      if (signal?.aborted) return rpcError(id, -32800, "Request cancelled", { kind: "request_cancelled", session_id: lifecycle.session_id });
      const toolResult = await server.callTool(params?.name as string, (params?.arguments as Record<string, unknown>) ?? {}, signal);
      if (signal?.aborted) return rpcError(id, -32800, "Request cancelled", { kind: "request_cancelled", session_id: lifecycle.session_id });
      const denial = capabilityDenialProjection(toolResult, lifecycle.session_id);
      if (denial !== null) return rpcError(id, -32001, denial.summary, denial);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }], ...(isFailureResult(toolResult) ? { isError: true } : {}) } };
    }
    case "resources/list": return { jsonrpc: "2.0", id, result: { resources: server.listResources() } };
    case "resources/templates/list": return { jsonrpc: "2.0", id, result: { resourceTemplates: server.listResourceTemplates() } };
    case "resources/read": {
      const uri = params?.uri;
      if (typeof uri !== "string" || uri.length === 0) return rpcError(id, -32602, "resources/read requires a non-empty uri");
      const resource = server.readResource(uri);
      if (isUnknownResource(resource)) return rpcError(id, -32002, "Resource not found", { uri });
      return { jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(resource, null, 2) }] } };
    }
    case "arbor_command": {
      if (signal?.aborted) return rpcError(id, -32800, "Request cancelled", { kind: "request_cancelled", session_id: lifecycle.session_id });
      const input = params?.input ?? {};
      const commandResult = await server.dispatchRuntimeCommand(toCliCommandEnvelope(input));
      if (signal?.aborted) return rpcError(id, -32800, "Request cancelled", { kind: "request_cancelled", session_id: lifecycle.session_id });
      const denial = capabilityDenialProjection(commandResult, lifecycle.session_id);
      return denial !== null ? rpcError(id, -32001, denial.summary, denial) : { jsonrpc: "2.0", id, result: commandResult };
    }
    case "arbor_query": {
      if (signal?.aborted) return rpcError(id, -32800, "Request cancelled");
      const input = params?.input ?? {};
      const queryResult = server.executeRuntimeQuery(toCliQueryEnvelope(input));
      const denial = capabilityDenialProjection(queryResult, lifecycle.session_id);
      return denial !== null ? rpcError(id, -32001, denial.summary, denial) : { jsonrpc: "2.0", id, result: queryResult };
    }
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

function rpcError(id: RpcMessage["id"], code: number, message: string, data?: unknown): object {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/**
 * WA-39: a `RuntimeCatalogRouter` capability/tier denial (ADR-028's
 * `enforceAction`, surfaced as `error.code === "permission"`) is a
 * protocol-level authorization failure, not ordinary tool/business-logic
 * failure — it is reported as a JSON-RPC error object rather than embedded
 * in a `result`. Returns the denial summary, or `null` when `result` is not
 * such a denial (including when it is not a router result at all).
 *
 * The denial carries the canonical typed remedy (`gate_refusal`, the same v2
 * contract a process-gate refusal uses) naming who can clear it: the operator
 * for a tier denial — a stdio client cannot raise its own tier — and the
 * client itself for a stale or mismatched session proof. A remedy the router
 * already attached is preserved rather than re-derived — an `output.raw` read
 * refused for want of an approval carries `request_approval`, not
 * `reauthenticate` (ADR-179 amendment 2026-10-06).
 */
function capabilityDenialProjection(result: unknown, sessionId: string): { readonly kind: "authorization_refusal"; readonly code: string; readonly summary: string; readonly source?: string; readonly operation_id?: string; readonly correlation_id?: string; readonly recoverable?: boolean; readonly session_id: string; readonly gate_refusal: GateRefusalProjection } | null {
  if (typeof result !== "object" || result === null) return null;
  const view = result as { ok?: unknown; error?: { code?: unknown; summary?: unknown; source?: unknown; operation_id?: unknown; correlation_id?: unknown; recoverable?: unknown } };
  if (view.ok !== false || typeof view.error !== "object" || view.error === null || view.error.code !== "permission" || typeof view.error.summary !== "string") return null;
  const error = view.error as typeof view.error & { gate_refusal?: unknown };
  const summary: string = typeof error.summary === "string" ? error.summary : "";
  const attached = error.gate_refusal;
  const gate_refusal = isGateRefusalProjection(attached) ? attached : projectCapabilityRefusal(summary, STDIO_CAPABILITY_GRANT_REMEDIATION);
  return {
    kind: "authorization_refusal", code: "permission", summary, session_id: sessionId, gate_refusal,
    ...(typeof error.source === "string" ? { source: error.source } : {}),
    ...(typeof error.operation_id === "string" ? { operation_id: error.operation_id } : {}),
    ...(typeof error.correlation_id === "string" ? { correlation_id: error.correlation_id } : {}),
    ...(typeof error.recoverable === "boolean" ? { recoverable: error.recoverable } : {}),
  };
}

/**
 * `arbor serve` composes an untrusted stdio client at the junior tier; only
 * the operator who launched it can raise that (WA-10/ADR-028).
 */
const STDIO_CAPABILITY_GRANT_REMEDIATION = "This MCP client runs at the junior tier, which cannot perform mutating actions. An operator who controls this client restarts the server with `arbor serve --trusted-client` (or ARBOR_MCP_TRUSTED_CLIENT=1); the client cannot raise its own tier.";

/** True for any other `{ ok: false, ... }`-shaped tool/router failure. */
function isFailureResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
}

function validInitialize(params: Record<string, unknown> | undefined): boolean {
  if (params === undefined || typeof params.protocolVersion !== "string" || params.protocolVersion.trim().length === 0 || !isRecord(params.capabilities) || !isRecord(params.clientInfo)) return false;
  const client = params.clientInfo;
  return typeof client.name === "string" && client.name.trim().length > 0 && typeof client.version === "string" && client.version.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownResource(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== false || typeof value.error !== "string") return false;
  return value.error.startsWith("Unknown resource");
}

function initializationNotificationParams(sessionId: string): object {
  return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: true }, resources: { listChanged: false, subscribe: false } }, serverInfo: { name: "arbor-mcp", version: "0.1.0", session_id: sessionId } };
}

/** Wrap a bare `{ kind, ...params }` MCP command input into the catalog command envelope. */
function toCliCommandEnvelope(input: unknown): unknown {
  if (input !== null && typeof input === "object" && (input as Record<string, unknown>).command !== undefined) return input;
  const { kind, ...params } = (input ?? {}) as Record<string, unknown>;
  const metadata = params.metadata as Record<string, unknown> | undefined;
  const { metadata: _m, ...commandParams } = params;
  return {
    schema_version: 1,
    metadata: metadata ?? { operation_id: `cli:${kind}`, idempotency_key: `cli:${kind}` },
    command: { kind, ...commandParams } as unknown,
  };
}

/** Wrap a bare `{ kind, ...params }` MCP query input into the catalog query envelope. */
function toCliQueryEnvelope(input: unknown): unknown {
  if (input !== null && typeof input === "object" && (input as Record<string, unknown>).query !== undefined) return input;
  const { kind, ...query } = (input ?? {}) as Record<string, unknown>;
  return {
    schema_version: 1,
    query_id: `cli:${kind}:${Date.now().toString(36)}`,
    query: { kind, ...query } as unknown,
  };
}

/**
 * True when this module is the program being run, rather than imported.
 *
 * The previous implementation compared `import.meta.url` against
 * `pathToFileURL(process.argv[1])`. That holds when node runs a bundle
 * directly, but is FALSE under any loader: `vite-node src/cli.ts` leaves
 * argv[1] pointing at `node_modules/.bin/vite-node` while `import.meta.url` is
 * the script. The guard therefore never fired, `main()` never ran, and the CLI
 * exited 0 with NO OUTPUT — a silent success on a plausible invocation, which
 * is worse than a crash and is the "dead entrypoint" defect class the
 * registration-integrity gate exists to catch.
 *
 * Scanning argv for the argument that resolves to this module handles the
 * bundle-under-node shape and loaders that preserve argv (e.g. tsx).
 *
 * It CANNOT handle `vite-node`, which erases the script path from argv
 * entirely — `process.argv` is just `[node, .../bin/vite-node]`, so there is
 * nothing left to match against. That is a genuine limit, not an oversight:
 * under vite-node, direct execution is undetectable from argv. `ARBOR_CLI_MAIN`
 * is the explicit opt-in for that case, so the invocation is stated by the
 * caller rather than guessed at. Verified empirically 2026-08-04.
 */
function isDirectExecution(): boolean {
  // Explicit override, for loaders that erase argv (vite-node). Opt-in so a
  // test importing this module can never trip it by accident.
  if (process.env.ARBOR_CLI_MAIN === "1") return true;

  let self: string;
  try {
    self = realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
  for (const argument of process.argv.slice(1)) {
    if (argument.startsWith("-")) continue; // loader flags, not paths
    try {
      if (realpathSync(resolve(argument)) === self) return true;
    } catch {
      // not a resolvable path (a subcommand like `run`) — keep scanning
    }
  }
  return false;
}

/**
 * `arbor-mcp governance` — the first real, in-repo consumer of `@arbor/governance`
 * (ADR-027 Decision point 4). Builds a snapshot of the real `decisions/`
 * corpus (record/status distribution, obligation coverage, POL-04/SUR-05
 * policy findings, derived repository counts) and prints it — as compact
 * human-readable text by default, or as JSON with `--json`.
 *
 * `--json` emits the real `GovernanceResult<GovernanceSnapshot>` envelope
 * (`contracts.ts`'s `{ok,value,capability}` / `{ok:false,error,capability}`
 * union) verbatim — `result` itself, never just `result.value` — so a
 * consumer (the TUI's governance screen shelling out to this command, per
 * `governance.ts`'s own doc comment) gets the same envelope shape every
 * other CLI/MCP surface in this repo emits, per ADR-054's grammar item 3.
 *
 * The exit code is derived from that same envelope, never guessed
 * separately: `exitCodeForGovernanceError` on the error path (see
 * `exit-codes.ts`), or `escalate()` over the real corpus signals on the
 * success path — a blocker-severity `M-B` finding (`contracts.ts`'s
 * `Severity`, the only severity vocabulary this CLI speaks) outranks an
 * unparseable-record `PARTIAL`, which outranks a clean `SUCCESS`.
 *
 * `at` is read here, once, at the CLI boundary — the projection itself
 * never reads a clock (see governance-projection.ts's module header).
 */
/**
 * POL-05's baseline: every ADR's decision status as it stands on the
 * integration branch.
 *
 * This is the IO half of the lifecycle check, kept out of the projection so
 * that stays a pure function of its inputs. Returns null when the baseline ref
 * is unreachable — a shallow clone, a detached checkout, or a repo with no
 * `master`. The projection then reports `status_baseline_available: false`
 * rather than a clean result it never verified. Silence here would mean an
 * unratified `draft -> accepted` edit reads as "no findings".
 */
function readStatusBaseline(repoRoot: string, ref = "master"): Map<string, DecisionStatus> | null {
  const run = (args: readonly string[]): string | null => {
    try {
      return execFileSync("git", ["-C", repoRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch { return null; }
  };
  if (run(["rev-parse", "--verify", "--quiet", ref]) === null) return null;

  const listing = run(["ls-tree", "--name-only", `${ref}:decisions`]);
  if (listing === null) return null;

  const baseline = new Map<string, DecisionStatus>();
  for (const name of listing.split("\n")) {
    if (!/^ADR-\d{3}.*\.md$/.test(name)) continue;
    const content = run(["show", `${ref}:decisions/${name}`]);
    if (content === null) continue;
    const classified = classifyLegacyRecord(content, `decisions/${name}`);
    if (classified.record) baseline.set(classified.record.id, classified.record.status.decision);
  }
  return baseline;
}

/** The reserved campaign id ADR-027 point 2 names for the governance stream. */
const GOVERNANCE_CAMPAIGN_ID = "governance";

/**
 * Load the governance stream, or start a fresh one.
 *
 * A corrupt or unreadable governance ledger must not stop the snapshot: the
 * corpus scan is the authority for what governance SAYS, and the ledger is a
 * durable witness of what was observed. Losing the witness is reported and
 * degrades to not witnessing, rather than failing a read-only command.
 */
function loadGovernanceLedger(persistenceDir: string, stderr: Writable): EvidenceLedger | null {
  try {
    return loadLedger(persistenceDir, GOVERNANCE_CAMPAIGN_ID);
  } catch (error) {
    stderr.write(`arbor-mcp governance: governance ledger unreadable, continuing without witnessing: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}

/**
 * `evidence refresh` — the CLI verb `evidence.refresh` never had (A8/A1 in
 * `docs/proposals/procedural-knowledge-hooks-vs-skills.md`'s inventory).
 * `evidence.refresh` (`native-tools/evidence-refresh.ts`) is the ONE place
 * that encodes the three evidence-store ordering constraints (graph before
 * stores, suite-green before the determinism baseline, commit before
 * verify). Before this verb existed it was reachable only through the MCP
 * tool surface, so `gate:store-freshness`'s remedy text could not name it
 * and named bare `bun run <store>:refresh` scripts instead — teaching an
 * operator to run the steps by hand, out of order, at a terminal.
 *
 * This wraps `runEvidenceRefresh` directly rather than reimplementing any
 * part of its sequencing: the runner below only spawns the argv `evidence-
 * refresh.ts` hands it and reports back exit code + combined output, exactly
 * the `EvidenceRefreshRunner` contract the native tool host also binds.
 */
function spawnEvidenceRefreshStep(argv: readonly [string, ...string[]], timeoutMs: number, cwd: string): Promise<{ ok: boolean; exit_code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const [command, ...rest] = argv;
    const child = spawn(command, rest, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    trackChild(child);
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolvePromise({ ok: false, exit_code: -1, output: `${output}\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, exit_code: -1, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, exit_code: code ?? -1, output });
    });
  });
}

export function parseEvidenceRefreshScope(raw: string | undefined): EvidenceRefreshScope | null {
  if (raw === undefined || raw === "auto") return "auto";
  if (raw === "all") return "all";
  const names = raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  return names as readonly EvidenceStoreName[];
}

export function formatEvidenceRefreshResult(result: EvidenceRefreshResult): string {
  if (result.error !== null) return `evidence refresh could not run: ${result.error}`;
  const lines = [`evidence refresh (${result.dry_run ? "dry run" : "applied"}, scope=${Array.isArray(result.scope) ? result.scope.join(",") : result.scope}):`];
  if (result.graph_precheck) {
    lines.push(`  graph precheck: ${result.graph_precheck.action} — ${result.graph_precheck.detail}`);
  }
  for (const store of result.stores) {
    lines.push(`  ${store.name}: ${store.action} (stale=${store.stale ?? "unknown"}) — ${store.reason}`);
  }
  if (result.suite_check.ran) {
    lines.push(`  suite check: ${result.suite_check.green ? "green" : "red"} — ${result.suite_check.detail}`);
  }
  if (result.remedy_commands.length > 0) {
    lines.push(`  remedy (in order): ${result.remedy_commands.join(" && ")}`);
  }
  lines.push(`  ${result.commit_before_verify_note}`);
  lines.push(result.ok ? "evidence refresh: ok" : "evidence refresh: NOT ok — see the actions above");
  return lines.join("\n");
}

async function evidenceCommand(
  args: readonly string[],
  environment: { cwd: string; stdout: Writable; stderr: Writable },
): Promise<number> {
  const usage = "Usage: arbor evidence refresh [--scope auto|all|<store[,store...]>] [--dry-run] [--json]\n" +
    "  auto/all refresh automatic stores only; determinism-baseline must be named explicitly.\n"
    + `       known stores: ${EVIDENCE_STORE_NAMES.join(", ")}\n`;
  if (args[0] !== "refresh") {
    environment.stderr.write(usage);
    return EXIT_CODES.USAGE;
  }
  const rest = args.slice(1);
  const supported = new Set(["--json", "--dry-run", "--scope", "--delegated-evidence-transaction"]);
  const unknown = rest.find((argument, index) => argument.startsWith("--") && !supported.has(argument) && rest[index - 1] !== "--scope");
  if (unknown) {
    environment.stderr.write(`Unknown evidence refresh option: ${unknown}\n${usage}`);
    return EXIT_CODES.USAGE;
  }
  const scopeFlagIndex = rest.indexOf("--scope");
  if (scopeFlagIndex >= 0 && (scopeFlagIndex + 1 >= rest.length || rest[scopeFlagIndex + 1].startsWith("--"))) {
    environment.stderr.write(`evidence refresh: --scope requires a value\n${usage}`);
    return EXIT_CODES.USAGE;
  }
  const scope = parseEvidenceRefreshScope(scopeFlagIndex >= 0 ? rest[scopeFlagIndex + 1] : undefined);
  if (scope === null) {
    environment.stderr.write(`evidence refresh: could not parse --scope\n${usage}`);
    return EXIT_CODES.USAGE;
  }
  const json = rest.includes("--json");
  const dryRun = rest.includes("--dry-run");
  const delegated = rest.includes("--delegated-evidence-transaction");
  const transactionSnapshot = delegated && process.env.REVOY_EVIDENCE_SNAPSHOT_MODE === "immutable_source_overlay_v1";

  // A direct CLI refresh acquires the repository-common lease in the small
  // JavaScript control-plane adapter. The delegated marker is intentionally
  // undocumented and only accepted from that adapter; without it, two
  // top-level CLI refreshes could both reach the first writer before any
  // producer-specific guard had a chance to refuse.
  // Invalid explicit scopes only read the freshness instrument before they are
  // rejected by runEvidenceRefresh, so keep that typed USAGE path in-process
  // instead of wrapping it as a writer violation.
  const validExplicitScope = typeof scope === "string" || scope.every((name) => (EVIDENCE_STORE_NAMES as readonly string[]).includes(name));
  if (!dryRun && !delegated && validExplicitScope) {
    // The atomic refresh below buffers its subprocess output and prints it only
    // on completion, and a full-scope refresh (graph + stores + suite + baseline)
    // can run one to two minutes. With no start signal it looks like a hang —
    // the exact reason an earlier run was killed mid-flight, which stranded the
    // transaction lease. Announce it on stderr (stdout stays reserved for the
    // subprocess output written below) and name the ONLY sanctioned recovery so
    // an interrupted run is never "fixed" by removing the lock directory by hand.
    environment.stderr.write(
      "evidence refresh: running atomically (graph → stores → suite → baseline); this can take 1–2 minutes — do not interrupt.\n" +
      "  If it is interrupted, recover the lease with `bun run evidence:recover` (never remove .git/arbor/evidence-refresh/lock by hand).\n",
    );
    const outcome = await spawnEvidenceRefreshStep(
      ["bun", "scripts/evidence-transaction.mjs", "--scope", typeof scope === "string" ? scope : scope.join(",")],
      1_800_000,
      environment.cwd,
    );
    environment.stdout.write(`${outcome.output}\n`);
    if (outcome.ok) return EXIT_CODES.SUCCESS;
    return outcome.exit_code === EXIT_CODES.USAGE ? EXIT_CODES.USAGE : EXIT_CODES.VIOLATION;
  }

  const result = await runEvidenceRefresh(
    { scope, dry_run: dryRun, transaction_snapshot: transactionSnapshot },
    { run: (argv, timeoutMs) => spawnEvidenceRefreshStep(argv, timeoutMs, environment.cwd) },
  );

  environment.stdout.write(`${json ? JSON.stringify(result, null, 2) : formatEvidenceRefreshResult(result)}\n`);
  if (result.error !== null) return result.error.startsWith("scope named unknown") ? EXIT_CODES.USAGE : EXIT_CODES.FAILURE;
  return result.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.VIOLATION;
}

async function governanceCommand(
  args: readonly string[],
  environment: { cwd: string; persistence_dir?: string; stdout: Writable; stderr: Writable },
): Promise<number> {
  const asJson = args.includes("--json");
  // WA-20: a project with no `decisions/` directory has no ADRs — that is a
  // typed absence, not a failure. Without this check, `buildGovernanceSnapshot`
  // -> `scanDecisionsCorpus` surfaces the raw ENOENT as a `"code": "unavailable"`
  // error, which `exitCodeForGovernanceError` maps to `EXIT_CODES.FAILURE`
  // (exit 1) — the same code an unexpected crash would use. `decisions` is
  // resolved exactly like `governance-projection.ts`'s own
  // `resolvePath(repoRoot, "decisions")`.
  const decisionsDir = resolve(environment.cwd, "decisions");
  if (!existsSync(decisionsDir)) {
    const message = `no decisions directory at ${decisionsDir}; this project has no ADRs`;
    environment.stdout.write(`${asJson ? JSON.stringify({ ok: true, absence: true, decisions_dir: decisionsDir, message }, null, 2) : message}\n`);
    return EXIT_CODES.SUCCESS;
  }
  const baseline = readStatusBaseline(environment.cwd);
  // ADR-027 point 2: governance events are witnessed in the EvidenceLedger
  // under the reserved campaign_id "governance". Without this the stream was
  // built but never reached on a real invocation — the Unreached shape this
  // repository's own gate exists to catch. `--no-witness` keeps a pure,
  // read-only snapshot available for anyone who wants one.
  const witness = !args.includes("--no-witness");
  const persistenceDir = witness ? resolvePersistenceDir(environment.cwd, environment.persistence_dir) : null;
  const ledger = persistenceDir === null ? null : loadGovernanceLedger(persistenceDir, environment.stderr);
  const result = buildGovernanceSnapshot({
    repo_root: environment.cwd,
    at: new Date().toISOString(),
    ...(baseline ? { status_baseline: baseline } : {}),
    ...(ledger === null ? {} : { ledger }),
  });
  if (result.ok && ledger !== null && persistenceDir !== null) {
    try {
      saveLedger(ledger, persistenceDir, GOVERNANCE_CAMPAIGN_ID);
    } catch (error) {
      // A snapshot that computed correctly must still be reported even if
      // witnessing it failed; the failure is surfaced, never swallowed.
      environment.stderr.write(`arbor-mcp governance: could not persist governance events: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (!result.ok) {
    if (asJson) environment.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else environment.stderr.write(`arbor-mcp governance failed: ${result.error.message}\n`);
    return exitCodeForGovernanceError(result.error.code);
  }
  if (asJson) {
    environment.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    environment.stdout.write(`${formatGovernanceSnapshot(result.value)}\n`);
  }
  return escalate([
    exitCodeForFindings(result.value.policy_findings),
    result.value.legacy_classification.unparseable > 0 ? EXIT_CODES.PARTIAL : EXIT_CODES.SUCCESS,
  ]);
}

async function devtoolsTail(
  args: readonly string[],
  environment: { cwd: string; persistence_dir?: string; stdin: Readable; stdout: Writable; stderr: Writable },
): Promise<number> {
  const campaignFilter = args[0];
  const persistenceDir = environment.persistence_dir ?? join(environment.cwd, ".arbor");
  const logPath = join(persistenceDir, "devtools", "devtools.log");
  if (!existsSync(logPath)) {
    environment.stderr.write(`No DevTools log at ${logPath}\n`);
    environment.stderr.write("Start a campaign with persistence_dir set to begin streaming (ADR-021).\n");
    return EXIT_CODES.FAILURE;
  }
  let lastSize = 0;
  const flush = () => {
    const fd = openSync(logPath, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= lastSize) { lastSize = size; return; }
      const length = size - lastSize;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, lastSize);
      lastSize = size;
      for (const raw of buffer.toString("utf8").split("\n")) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        try {
          const line = JSON.parse(trimmed) as { ts?: string; campaign_id?: string | null; event_kind?: string; event?: { kind?: string }; synthetic?: boolean };
          if (campaignFilter && line.campaign_id !== campaignFilter) continue;
          const marker = line.synthetic ? " [truncated]" : "";
          const campaign = line.campaign_id ?? "-";
          environment.stdout.write(`${line.ts ?? "?"}  ${campaign}  ${line.event_kind ?? "?"}${marker}\n`);
        } catch {
          environment.stdout.write(`${raw}\n`);
        }
      }
    } finally {
      closeSync(fd);
    }
  };
  flush();
  const watcher = watch(logPath, { persistent: true }, () => flush());
  environment.stderr.write(`Tailing ${logPath}${campaignFilter ? ` (campaign: ${campaignFilter})` : ""} — Ctrl-C to stop.\n`);
  await new Promise<void>((resolve) => {
    environment.stdin.once("end", resolve);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  watcher.close();
  return EXIT_CODES.SUCCESS;
}

if (isDirectExecution()) {
  const gate = new ShutdownGate();
  process.once("SIGINT", () => gate.trigger());
  process.once("SIGTERM", () => gate.trigger());
  void main(undefined, undefined, gate).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`arbor-mcp failed: ${error instanceof Error ? error.message : String(error)}\n`);
    // An uncaught exception is, by definition, the FAILURE case — never a
    // reported violation/conflict/partial result. See exit-codes.ts.
    process.exitCode = EXIT_CODES.FAILURE;
  });
}
