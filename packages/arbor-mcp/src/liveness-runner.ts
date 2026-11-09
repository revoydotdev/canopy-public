/**
 * liveness-runner.ts — build a real composition root and probe it.
 *
 * The separation from `liveness.ts` is deliberate: that module is pure over a
 * router it is handed, so it can be tested against any runtime. This one owns
 * the decision that makes the whole exercise mean anything — **which router**.
 *
 * It must be a router a composition root actually built. Every A2A test in this
 * repository constructed its own `RuntimeCatalogRouter` and handed it a bridge
 * config, which proved the conversion functions worked and proved nothing about
 * whether a real server produced a working router; closing G-29 meant driving
 * `ArborMCPServer` itself. Probing a hand-assembled router here would recreate
 * that mistake at the scale of the whole catalog: it would attest to a system
 * nobody runs.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeEventStream, TaskSupervisor, type Action } from "@arbor/core";
import { CampaignManager } from "./manager.js";
import { ArborRuntime } from "./runtime.js";
import { ArborMCPServer } from "./server.js";
import type { RuntimeCatalogRouter } from "./runtime-catalog.js";
import { createRemoteSessionIdentity } from "./remote-session.js";
import { captureWorktreeResult } from "./result-adoption.js";
import { buildLivenessReport, type LivenessProbeContext, type LivenessReport } from "./liveness.js";
import { TUI_SCREEN_CONSUMERS, consumersCoverScreens } from "./liveness-consumers.js";

const PROBE_CAMPAIGN = "liveness-probe";

const PROBE_ROOT_ACTION: Action = {
  description: "liveness probe root",
  estimated_gain: 1,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

export interface LivenessRunOptions {
  readonly at: string;
  /** Probe mutating kinds. Requires accepting that they take effect on the throwaway runtime. */
  readonly includeMutating?: boolean;
  /** Probe declared consumers as well as the catalog. Default true. */
  readonly includeConsumers?: boolean;
}

/**
 * The router an `ArborMCPServer` built, reached the way a transport reaches it.
 *
 * Read off the constructed server rather than assembled here, so what gets
 * probed is what the composition root produced — including any option it wires
 * that a hand-built router would silently omit.
 */
export async function livenessRouterFromCompositionRoot(): Promise<{
  router: RuntimeCatalogRouter;
  context: LivenessProbeContext;
  dispose: () => Promise<void>;
}> {
  // A real persistence directory, because the fixture has to resemble a
  // deployment or the run measures the fixture instead of the system. The
  // first version of this omitted it, and `output.list` duly reported
  // "output evidence persistence is not configured" — a true statement about
  // a runtime nobody ships. `ArborRuntime` only constructs an
  // `OutputEvidenceStore` when given `persistence_dir`, and every real
  // composition root supplies one via `createCliRuntime`.
  const persistenceDir = mkdtempSync(join(tmpdir(), "arbor-liveness-"));
  let runtime: ArborRuntime | undefined;
  let disposal: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = [];
    if (runtime) {
      try {
        const result = await runtime.close();
        if (!result.ok) {
          const details = result.failures.map((failure) => `${failure.source}: ${failure.summary}`).join("; ");
          failures.push(new Error(`liveness runtime failed to close${details ? `: ${details}` : ""}`));
        }
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      rmSync(persistenceDir, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "liveness runtime cleanup failed");
  };
  const dispose = (): Promise<void> => {
    disposal ??= cleanup();
    return disposal;
  };
  try {
    // Governance search refreshes its disposable JSON index under the supplied
    // repository root. Probe a tracked copy so a liveness run never creates or
    // refreshes generated files in the operator's checkout.
    const governanceRepoRoot = join(persistenceDir, "governance-repo");
    mkdirSync(governanceRepoRoot, { recursive: true });
    // A cwd without decisions/ is a real absent state: the governance probe
    // refuses on it rather than aborting the whole attestation.
    const decisionsDir = join(process.cwd(), "decisions");
    if (existsSync(decisionsDir)) cpSync(decisionsDir, join(governanceRepoRoot, "decisions"), { recursive: true, filter: (path) => !path.endsWith(".governance-index.json") && !path.endsWith(".governance-publish.lock") });
    const manager = new CampaignManager({ persistence_dir: persistenceDir });
    const supervisor = new TaskSupervisor();
    const events = new RuntimeEventStream("liveness");
    runtime = new ArborRuntime({ manager, supervisor, event_stream: events, persistence_dir: persistenceDir });

    // A seeded campaign, so kinds whose answer depends on domain state have
    // something real to answer about. Without it, half the catalog would report a
    // conflict refusal and the run would say more about the empty fixture than
    // about the seams.
    manager.startCampaign(PROBE_CAMPAIGN, "plan.md", PROBE_ROOT_ACTION);
    const [childNodeId] = manager.branch(PROBE_CAMPAIGN, "root", [{ ...PROBE_ROOT_ACTION, description: "liveness probe child", delegate_to: "seed" }]);
    if (!childNodeId) throw new Error("liveness probe did not create its direct child");

    // Seed concrete identities for the read-only detail seams. This setup is
    // confined to the throwaway composition root; the probes below only query
    // those records. It prevents a made-up id from being mistaken for proof a
    // detail path works, while never granting raw-output approval.
    const operationId = "liveness-detail-operation";
    runtime.operations.accept({
      metadata: {
        operation_id: operationId,
        idempotency_key: operationId,
        correlation_id: operationId,
        actor_id: "liveness-prober",
        requested_at: "2026-01-01T00:00:00.000Z",
      },
      capability: "operation.read",
      fingerprint: "liveness-detail-operation",
    });
    const output = runtime.outputEvidence?.put({
      campaign_id: PROBE_CAMPAIGN,
      node_id: "root",
      operation_id: operationId,
      stream: "other",
      media_type: "text/plain",
      provenance: { tag: "generated", generator: "liveness-runner", input_hash: "sha256:liveness" },
    }, "liveness descriptor payload");
    if (!output) throw new Error("liveness composition root did not configure output evidence");
    const contextArtifact = runtime.governedContext.captureArtifact({
      campaign_id: PROBE_CAMPAIGN,
      producer: "liveness-runner",
      media_type: "text/plain",
      visibility: "campaign",
      provenance: { tag: "generated", generator: "liveness-runner", input_hash: "sha256:liveness" },
      content: "liveness workspace payload",
    });
    // Seed a complete, revision-bound hermetic run so the read-only detail
    // probe observes the actual per-run boundary rather than a fabricated id.
    // This is fixture setup on the disposable composition root, never an
    // evaluator invocation: no provider/tool/network/scenario port is present.
    manager.recordBusMessage({
      campaign_id: PROBE_CAMPAIGN, node_id: "root", author_node_id: "root", recipient_node_id: childNodeId, other_recipient_node_ids: [],
      kind: "delegate", payload: { content: "liveness evaluation source", provenance: { tag: "claimed", claimant: "liveness-runner" } }, capability_tier: "specialist", trigger_turn: false,
      as_of: "2026-01-01T00:00:00.000Z", correlation_id: "liveness-evaluation-source", idempotency_key: "liveness-evaluation-source", acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "liveness-evaluation",
    });
    const evaluationSource = manager.getAuditRecords(PROBE_CAMPAIGN).filter((record) => record.kind === "node_communication").at(-1);
    if (!evaluationSource) throw new Error("liveness composition root did not retain evaluation source evidence");
    const evaluationRevisionId = "liveness-evaluation-revision";
    runtime.governedContext.proposeRevision({ id: evaluationRevisionId, campaign_id: PROBE_CAMPAIGN, task_id: "liveness-evaluation", component: "supplemental_prompt", patch: { guidance: "bounded fixture" }, source_event_ids: [evaluationSource.id], source_message_ranges: [{ context_id: "liveness-evaluation", thread_id: "root", start_communication_id: evaluationSource.id, end_communication_id: evaluationSource.id, start_byte: 0, end_byte: 1 }], expected_benefit: "probe redacted run detail", proposed_by: "seed", provenance: { tag: "claimed", claimant: "seed" }, created_at: "2026-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z" });
    runtime.governedContext.approveRevision(evaluationRevisionId, "lenticel");
    const evaluationRun = runtime.governedContext.startEvaluation({ id: "liveness-evaluation-run", revision_id: evaluationRevisionId, requested_by: "liveness-requester", evaluator_id: "liveness-hermetic" });
    const governedContext = runtime.governedContext;
    const evaluationEvidence = (["replay", "holdout"] as const).map((partition) => {
      const content = JSON.stringify({ schema_version: 1, evaluation_run_id: evaluationRun.id, revision_id: evaluationRevisionId, scenario_id: `liveness:${partition}`, partition });
      return governedContext.captureArtifact({ campaign_id: PROBE_CAMPAIGN, media_type: "application/vnd.arbor.overlay-evaluation+json", producer: "arbor-eval/governed-overlay", visibility: "critic_only", provenance: { tag: "generated", generator: "arbor-eval/governed-overlay", input_hash: `sha256:liveness:${partition}` }, content });
    });
    runtime.governedContext.settleEvaluation(evaluationRun.id, { kind: "measured", evidence_ids: evaluationEvidence.map((item) => item.id), evaluation: { outcome: "unchanged", fidelity_ratio: 1, main_model_tokens: 1, child_model_tokens: 1, latency_ms: 1, regression_detected: false, rollback_count: 0, replay_evidence_ids: [evaluationEvidence[0]!.id], holdout_evidence_ids: [evaluationEvidence[1]!.id] }, detail: [{ summary: "redacted liveness fixture" }] });
    // The read probes must observe a genuine authority record rather than a
    // fabricated status object. This is a fixture setup mutation on the same
    // disposable persisted authority that production composition creates.
    const seededRemoteSession = createRemoteSessionIdentity({
      session_id: "liveness-seeded-remote-session",
      actor_id: "remote:liveness-seeded",
      expires_at: "2099-01-01T00:00:00.000Z",
      thread_audiences: [{ campaign_id: PROBE_CAMPAIGN, parent_node_id: "root", child_node_id: childNodeId, author_node_id: "root" }],
    });
    runtime.remoteSessionAuthority.register(seededRemoteSession.registration);

    // Result review is a data-dependent read surface, so seed an actual verified
    // worktree capture rather than accepting an "unavailable" response as proof
    // that the screen's request shape works. The repository and capture are both
    // confined to this disposable composition root.
    const resultWorktree = join(persistenceDir, "result-worktree");
    execFileSync("git", ["init", "-q", resultWorktree]);
    execFileSync("git", ["config", "user.email", "liveness@example.invalid"], { cwd: resultWorktree });
    execFileSync("git", ["config", "user.name", "Liveness prober"], { cwd: resultWorktree });
    writeFileSync(join(resultWorktree, "result.txt"), "before\n", "utf8");
    execFileSync("git", ["add", "result.txt"], { cwd: resultWorktree });
    execFileSync("git", ["commit", "-qm", "fixture base"], { cwd: resultWorktree });
    writeFileSync(join(resultWorktree, "result.txt"), "after\n", "utf8");
    const capturedResult = captureWorktreeResult({
      campaign_id: PROBE_CAMPAIGN,
      node_id: "root",
      worktree_path: resultWorktree,
      verified: true,
      score: 1,
      persistence_dir: persistenceDir,
    });
    if (!capturedResult) throw new Error("liveness composition root did not capture a reviewable result");

    const server = new ArborMCPServer(runtime);
    const router = (server as unknown as { runtimeCatalog: RuntimeCatalogRouter }).runtimeCatalog;

    return {
      router,
      context: {
        campaign_id: PROBE_CAMPAIGN,
        node_id: "root",
        child_node_id: childNodeId,
        stream_id: runtime.eventStream.streamId,
        operation_id: operationId,
        output_evidence_id: output.id,
        context_artifact_id: contextArtifact.id,
        remote_session_id: seededRemoteSession.registration.session_id,
        evaluation_run_id: evaluationRun.id,
        governance_repo_root: governanceRepoRoot,
      },
      dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "liveness composition setup and cleanup both failed");
    }
    throw error;
  }
}

/**
 * Screens that dispatch with nothing attesting to them, or `null` when the
 * check could not run.
 *
 * `tui.ts` is resolved relative to this module rather than `process.cwd()`, so
 * the answer does not depend on where the CLI was invoked from. A missing file
 * yields `null` — the honest "not determined" — never an empty array, which
 * would read as "checked, all clear".
 */
function detectConsumerDrift(): readonly string[] | null {
  const tuiPath = join(dirname(fileURLToPath(import.meta.url)), "tui.ts");
  if (!existsSync(tuiPath)) return null;
  try {
    return consumersCoverScreens(readFileSync(tuiPath, "utf8"));
  } catch {
    return null;
  }
}

/** Probe a freshly built composition root and return the report. */
export async function runLiveness(options: LivenessRunOptions): Promise<LivenessReport> {
  const { router, context, dispose } = await livenessRouterFromCompositionRoot();
  let report: LivenessReport | undefined;
  let probeError: unknown;
  let probeFailed = false;
  try {
    report = await buildLivenessReport({
      router,
      context,
      at: options.at,
      includeMutating: options.includeMutating,
      mutatingProbes: options.includeMutating ? disposableMutatingTrajectories(router, context) : undefined,
      consumers: options.includeConsumers === false ? [] : TUI_SCREEN_CONSUMERS,
      consumerDrift: detectConsumerDrift(),
    });
  } catch (error) {
    probeFailed = true;
    probeError = error;
  } finally {
    try {
      await dispose();
    } catch (disposeError) {
      if (probeFailed) throw new AggregateError([probeError, disposeError], "liveness probe and cleanup both failed");
      throw disposeError;
    }
  }
  if (probeFailed) throw probeError;
  return report!;
}

/**
 * These intentionally form a small real scenario, not synthetic success
 * payloads: each command mutates the throwaway composition root and verifies
 * the corresponding durable/read projection before it is counted answered.
 */
function disposableMutatingTrajectories(router: RuntimeCatalogRouter, context: LivenessProbeContext): Partial<Record<import("./runtime-catalog.js").RuntimeCatalogKind, () => unknown | Promise<unknown>>> {
  let sequence = 0;
  const metadata = (name: string, extra: Record<string, unknown> = {}) => ({ operation_id: `liveness-mutate-${name}-${++sequence}`, idempotency_key: `liveness-mutate-${name}-${sequence}`, correlation_id: `liveness-mutate-${name}`, actor_id: "liveness-prober", requested_at: "2026-08-08T00:00:00.000Z", ...extra });
  const root: Action = { ...PROBE_ROOT_ACTION, description: "disposable mutating probe" };
  const claimed = { tag: "claimed" as const, claimant: "liveness-prober" };
  const accepted = async (result: unknown | Promise<unknown>, assertion: () => void) => {
    const settled = await result;
    const shaped = settled as { ok?: boolean; value?: { accepted?: boolean } };
    if (shaped.ok !== true || shaped.value?.accepted !== true) return settled;
    assertion();
    return settled;
  };
  /**
   * Command-local data which is meant to be idempotent must use the envelope's
   * idempotency key.  Keeping that relationship in this helper prevents this
   * liveness runner from accidentally testing a deliberately-invalid request
   * (the exact failure the first draft had for bus and communication).
   */
  const envelope = (name: string, build: (m: ReturnType<typeof metadata>) => Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const m = metadata(name, extra);
    return { schema_version: 1 as const, metadata: m, command: build(m) };
  };
  const directVersion = () => {
    const history = router.executeQuery({ schema_version: 1, query_id: `liveness-thread-${sequence}`, query: { kind: "bus.thread.history", campaign_id: context.campaign_id, parent_node_id: context.node_id, child_node_id: context.child_node_id, limit: 10 } }) as { ok: boolean; value?: { version?: string } };
    if (!history.ok || typeof history.value?.version !== "string") throw new Error("direct thread projection was unavailable"); return history.value.version;
  };
  let branchChild: string | null = null;
  let askedRecord: string | null = null;
  let directMessage: string | null = null;
  const trustIdentity = createRemoteSessionIdentity({
    session_id: "liveness-mutating-remote-session",
    actor_id: "remote:liveness-mutating",
    expires_at: "2099-01-01T00:00:00.000Z",
    thread_audiences: [{ campaign_id: context.campaign_id, parent_node_id: context.node_id, child_node_id: context.child_node_id, author_node_id: context.node_id }],
  });
  const trustReplacement = createRemoteSessionIdentity({
    session_id: trustIdentity.registration.session_id,
    actor_id: trustIdentity.registration.actor_id,
    expires_at: trustIdentity.registration.expires_at,
    thread_audiences: trustIdentity.registration.thread_audiences,
  });
  let trustEnrolled = false;
  let trustRotated = false;
  const livenessJob = "liveness-disposable-job";
  return {
    "campaign.halt": () => router.dispatchCommand(envelope("halt-absent", () => ({ kind: "campaign.halt", campaign_id: "liveness-absent-campaign", reason: "disposable liveness probe" }))),
    "tree.interrupt": () => router.dispatchCommand(envelope("interrupt-absent", () => ({ kind: "tree.interrupt", campaign_id: context.campaign_id, node_id: "liveness-absent-node", reason: "disposable liveness probe", scope: "node", provenance: claimed }), { expected_version: "1" })),
    "operation.cancel": () => router.dispatchCommand(envelope("operation-cancel-absent", () => ({ kind: "operation.cancel", target_operation_id: "liveness-absent-operation", reason: "disposable liveness probe" }))),
    "recovery.retry": () => router.dispatchCommand(envelope("recovery-retry-absent", () => ({ kind: "recovery.retry", campaign_id: context.campaign_id, node_id: "liveness-absent-node", prior_operation_id: context.operation_id ?? "liveness-absent-operation", reason: "disposable liveness probe" }), { expected_version: "1" })),
    "recovery.abandon": () => router.dispatchCommand(envelope("recovery-abandon-absent", () => ({ kind: "recovery.abandon", campaign_id: context.campaign_id, node_id: "liveness-absent-node", reason: "disposable liveness probe" }))),
    "migration.apply": () => router.dispatchCommand(envelope("migration-apply-absent", () => ({ kind: "migration.apply", source_path: "liveness-absent.json", expected_source_sha256: "0".repeat(64), overwrite: false }))),
    "migration.rollback": () => router.dispatchCommand(envelope("migration-rollback-absent", () => ({ kind: "migration.rollback", receipt_id: "migration-receipt-liveness-absent", provenance: claimed }))),
    "integration.install": () => router.dispatchCommand(envelope("integration-install-absent", () => ({ kind: "integration.install", integration_id: "browser.uncomposed", acknowledge_risk: true, provenance: claimed }))),
    "integration.enable": () => router.dispatchCommand(envelope("integration-enable-absent", () => ({ kind: "integration.enable", integration_id: "browser.uncomposed", acknowledge_risk: true, provenance: claimed }))),
    "integration.disable": () => router.dispatchCommand(envelope("integration-disable-absent", () => ({ kind: "integration.disable", integration_id: "browser.uncomposed", acknowledge_risk: true, provenance: claimed }))),
    "integration.update": () => router.dispatchCommand(envelope("integration-update-absent", () => ({ kind: "integration.update", integration_id: "browser.uncomposed", version: "0.0.0", acknowledge_risk: true, provenance: claimed }))),
    "integration.rollback": () => router.dispatchCommand(envelope("integration-rollback-absent", () => ({ kind: "integration.rollback", integration_id: "browser.uncomposed", acknowledge_risk: true, provenance: claimed }))),
    "remote.control": () => router.dispatchCommand(envelope("remote-control-absent", () => ({ kind: "remote.control", session_id: "liveness-absent-session", action: "revoke", acknowledge_risk: true, provenance: claimed }))),
    "scheduler.control": () => router.dispatchCommand(envelope("scheduler-control-absent", () => ({ kind: "scheduler.control", schedule_id: "liveness-absent-schedule", action: "suspend", reason: "disposable liveness probe", acknowledge_risk: true, provenance: claimed }))),
    "session.identity.mutate": () => router.dispatchCommand(envelope("identity-mutate", () => ({ kind: "session.identity.mutate", session_id: "liveness-session", display_name: "Liveness", tags: ["disposable"], provenance: { tag: "claimed", claimant: "liveness-prober" } }))),
    "notification.read": () => router.dispatchCommand(envelope("notification-read-absent", () => ({ kind: "notification.read", notification_id: "liveness-absent-notification" }))),
    "followup.create": () => router.dispatchCommand(envelope("followup-create", () => ({ kind: "followup.create", id: "liveness-followup", parent_campaign_id: context.campaign_id, source_result: "liveness result", source_node: context.node_id, provenance: { tag: "claimed", claimant: "liveness-prober" } }))),
    "job.retry": () => router.dispatchCommand(envelope("job-retry-absent", () => ({ kind: "job.retry", job_id: "liveness-absent-job" }))),
    "harness.session.interrupt": () => router.dispatchCommand(envelope("session-interrupt-absent", () => ({ kind: "harness.session.interrupt", session_id: "liveness-absent-session", reason: "disposable liveness probe", provenance: claimed }))),
    "harness.session.steer": () => router.dispatchCommand(envelope("session-steer-absent", () => ({ kind: "harness.session.steer", session_id: "liveness-absent-session", message: "disposable liveness probe", provenance: claimed }))),
    "harness.session.resume": () => router.dispatchCommand(envelope("session-resume-absent", () => ({ kind: "harness.session.resume", session_id: "liveness-absent-session", reason: "disposable liveness probe", dispositions: [], provenance: claimed }))),
    "harness.session.fork": () => router.dispatchCommand(envelope("session-fork-absent", () => ({ kind: "harness.session.fork", session_id: "liveness-absent-session", reason: "disposable liveness probe", dispositions: [], provenance: claimed }))),
    "harness.session.respawn": () => router.dispatchCommand(envelope("session-respawn-absent", () => ({ kind: "harness.session.respawn", session_id: "liveness-absent-session", reason: "disposable liveness probe", dispositions: [], provenance: claimed }))),
    "campaign.start": () => accepted(router.dispatchCommand(envelope("start", () => ({ kind: "campaign.start", campaign_id: "liveness-started", plan_path: "liveness.md", root_action: root }))), () => { const probe = router.executeQuery({ schema_version: 1, query_id: "liveness-started", query: { kind: "campaign.snapshot", campaign_id: "liveness-started" } }) as { ok: boolean }; if (!probe.ok) throw new Error("campaign start did not become queryable"); }),
    // The production liveness composition intentionally has no host Git
    // workspace manager. These well-formed commands must reach that boundary
    // and return a typed unavailable refusal without touching the checkout.
    "git.worktree.create": () => router.dispatchCommand(envelope("git-worktree-create", () => ({ kind: "git.worktree.create", campaign_id: context.campaign_id, node_id: context.node_id, specialist: "liveness-prober" }))),
    "git.worktree.switch": () => router.dispatchCommand(envelope("git-worktree-switch", () => ({ kind: "git.worktree.switch", path: "/liveness/absent-worktree", active_run: false }))),
    "git.worktree.cleanup": () => router.dispatchCommand(envelope("git-worktree-cleanup", () => ({ kind: "git.worktree.cleanup", node_id: "liveness-absent-node", authorized: false, active_run: false }))),
    "tree.branch": () => accepted(router.dispatchCommand(envelope("branch", () => ({ kind: "tree.branch", campaign_id: context.campaign_id, node_id: context.node_id, actions: [{ ...root, description: "liveness branch child", delegate_to: "seed" }] }))), () => { const tree = router.executeQuery({ schema_version: 1, query_id: "liveness-tree", query: { kind: "campaign.snapshot", campaign_id: context.campaign_id } }) as { ok: boolean; value?: { nodes?: Array<{ id: string; action_description: string }> } }; branchChild = tree.value?.nodes?.find((node) => node.action_description === "liveness branch child")?.id ?? null; if (!tree.ok || branchChild === null) throw new Error("tree branch did not persist child"); }),
    "tree.prune": () => { if (branchChild === null) throw new Error("tree.prune trajectory requires branch trajectory"); return accepted(router.dispatchCommand(envelope("prune", () => ({ kind: "tree.prune", campaign_id: context.campaign_id, node_id: branchChild! }))), () => { const snapshot = router.executeQuery({ schema_version: 1, query_id: "liveness-prune", query: { kind: "campaign.snapshot", campaign_id: context.campaign_id } }) as { ok: boolean; value?: { nodes?: Array<{ id: string; state: string }> } }; if (!snapshot.ok || snapshot.value?.nodes?.find((node) => node.id === branchChild)?.state !== "pruned") throw new Error("tree prune did not persist state"); }); },
    "communication.record": () => accepted(router.dispatchCommand(envelope("communication", (m) => ({ kind: "communication.record", campaign_id: context.campaign_id, node_id: context.node_id, communication: { author_node_id: context.node_id, recipient_node_id: context.child_node_id, other_recipient_node_ids: [], kind: "delegate", payload: { content: "liveness communication", provenance: { tag: "claimed", claimant: "liveness-prober" } }, capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-08T00:00:00.000Z", correlation_id: m.correlation_id, idempotency_key: m.idempotency_key, acknowledges_communication_id: null, retracts_communication_id: null } }))), () => { const history = router.executeQuery({ schema_version: 1, query_id: "liveness-communication", query: { kind: "communication.history", campaign_id: context.campaign_id, node_id: context.child_node_id, limit: 10 } }) as { ok: boolean; value?: { communications?: unknown[] } }; if (!history.ok || !history.value?.communications?.length) throw new Error("communication did not project"); }),
    "output.capture": () => accepted(router.dispatchCommand(envelope("output", () => ({ kind: "output.capture", artifact: { campaign_id: context.campaign_id, node_id: context.node_id, stream: "stdout", media_type: "text/plain", provenance: { tag: "claimed", claimant: "liveness-prober" } }, content: "liveness output" }))), () => { const outputs = router.executeQuery({ schema_version: 1, query_id: "liveness-output", query: { kind: "output.list" } }) as { ok: boolean; value?: unknown[] }; if (!outputs.ok || !Array.isArray(outputs.value) || outputs.value.length === 0) throw new Error("output capture did not project"); }),
    "surveillance.scan": () => accepted(router.dispatchCommand(envelope("scan", () => ({ kind: "surveillance.scan", campaign_id: context.campaign_id, as_of: "2026-08-08T00:00:00.000Z" }))), () => { const findings = router.executeQuery({ schema_version: 1, query_id: "liveness-findings", query: { kind: "surveillance.findings", campaign_id: context.campaign_id, limit: 10 } }) as { ok: boolean }; if (!findings.ok) throw new Error("surveillance result did not project"); }),
    "approval.request": () => accepted(router.dispatchCommand(envelope("approval-request", (m) => ({ kind: "approval.request", request_id: "liveness-approval", idempotency_key: m.idempotency_key, action: "campaign.halt", subject: "liveness campaign", resource_id: context.campaign_id, proposer: "liveness-proposer", rationale: "disposable halt authority", expires_at: "2030-01-01T00:00:00.000Z" }), { actor_id: "liveness-proposer" })), () => {}),
    "job.submit": () => accepted(router.dispatchCommand(envelope("job-submit", (m) => ({ kind: "job.submit", id: livenessJob, operation_id: m.operation_id, job_kind: "liveness.noop", owner_scope_id: context.campaign_id, idempotency_key: m.idempotency_key }))), () => {}),
    "job.cancel": () => accepted(router.dispatchCommand(envelope("job-cancel", () => ({ kind: "job.cancel", job_id: livenessJob }))), () => {}),
    "job.pause": () => accepted(router.dispatchCommand(envelope("job-pause", () => ({ kind: "job.pause" }))), () => {}),
    "job.resume": () => accepted(router.dispatchCommand(envelope("job-resume", () => ({ kind: "job.resume" }))), () => {}),
    "approval.approve": () => router.dispatchCommand(envelope("approval-approve", () => ({ kind: "approval.approve", request_id: "liveness-approval", actor: "liveness-decider" }), { actor_id: "liveness-decider" })),
    "approval.expire": () => router.dispatchCommand(envelope("approval-expire-absent", () => ({ kind: "approval.expire", request_id: "liveness-absent-approval" }))),
    "approval.reject": async () => {
      const requested = await router.dispatchCommand(envelope("approval-reject-request", (m) => ({ kind: "approval.request", request_id: "liveness-reject", idempotency_key: m.idempotency_key, action: "campaign.halt", subject: "liveness campaign", resource_id: context.campaign_id, proposer: "liveness-proposer", rationale: "disposable reject authority", expires_at: "2030-01-01T00:00:00.000Z" }), { actor_id: "liveness-proposer" }));
      const shape = requested as { ok?: boolean; value?: { accepted?: boolean } };
      if (shape.ok !== true || shape.value?.accepted !== true) return requested;
      return accepted(router.dispatchCommand(envelope("approval-reject", () => ({ kind: "approval.reject", request_id: "liveness-reject", actor: "liveness-decider", reason: "liveness rejection" }), { actor_id: "liveness-decider" })), () => {});
    },
    "trust.session.enroll": () => accepted(router.dispatchCommand(envelope("trust-enroll", () => ({ kind: "trust.session.enroll", registration: trustIdentity.registration }))), () => {
      const status = router.executeQuery({ schema_version: 1, query_id: "liveness-trust-enroll", query: { kind: "trust.session.status", session_id: trustIdentity.registration.session_id } }) as { ok: boolean; value?: { state?: string; key_id?: string; thread_audiences?: unknown[] } };
      if (!status.ok || status.value?.state !== "active" || status.value.key_id !== trustIdentity.registration.key_id || status.value.thread_audiences?.length !== 1) throw new Error("remote-session enrollment did not persist bounded authority state");
      trustEnrolled = true;
    }),
    "trust.session.rotate": () => {
      if (!trustEnrolled) throw new Error("remote-session rotation trajectory requires enrollment");
      return accepted(router.dispatchCommand(envelope("trust-rotate", () => ({ kind: "trust.session.rotate", session_id: trustIdentity.registration.session_id, key_id: trustReplacement.registration.key_id, public_key_pem: trustReplacement.registration.public_key_pem, certificate_id: trustReplacement.registration.certificate_id }))), () => {
        const status = router.executeQuery({ schema_version: 1, query_id: "liveness-trust-rotate", query: { kind: "trust.session.status", session_id: trustIdentity.registration.session_id } }) as { ok: boolean; value?: { key_id?: string; revoked_key_ids?: string[]; state?: string } };
        if (!status.ok || status.value?.state !== "active" || status.value.key_id !== trustReplacement.registration.key_id || !status.value.revoked_key_ids?.includes(trustIdentity.registration.key_id)) throw new Error("remote-session rotation did not revoke prior key in persisted authority state");
        trustRotated = true;
      });
    },
    "trust.session.revoke": () => {
      if (!trustRotated) throw new Error("remote-session revocation trajectory requires rotation");
      return accepted(router.dispatchCommand(envelope("trust-revoke", () => ({ kind: "trust.session.revoke", session_id: trustIdentity.registration.session_id }))), () => {
        const status = router.executeQuery({ schema_version: 1, query_id: "liveness-trust-revoke", query: { kind: "trust.session.status", session_id: trustIdentity.registration.session_id } }) as { ok: boolean; value?: { state?: string; revoked_at?: string | null } };
        if (!status.ok || status.value?.state !== "revoked" || typeof status.value.revoked_at !== "string") throw new Error("remote-session revocation did not persist lifecycle state");
      });
    },
    "compaction.record": () => accepted(router.dispatchCommand(envelope("compaction", () => ({ kind: "compaction.record", campaign_id: context.campaign_id, node_id: context.node_id, lifecycle: { operation_id: "liveness-compaction", trigger: "auto", strategy: "local_model", status: "completed", pre_evidence_id: "liveness-pre", post_evidence_id: "liveness-post", anchor_summary_id: "liveness-anchor", reason: "disposable liveness", partial_evidence_ids: [], idempotency_key: "liveness-compaction", as_of: "seq:1" } }))), () => { const list = router.executeQuery({ schema_version: 1, query_id: "liveness-compaction", query: { kind: "compaction.list", campaign_id: context.campaign_id } }) as { ok: boolean; value?: { records?: unknown[] } }; if (!list.ok || !list.value?.records?.length) throw new Error("compaction did not project"); }),
    "userinput.ask": () => accepted(router.dispatchCommand(envelope("ask", () => ({ kind: "userinput.ask", campaign_id: context.campaign_id, node_id: context.node_id, question: { operation_id: "liveness-ask", question: "Continue?", options: [{ id: "yes", text: "Yes", is_other: false }], authority: "lead", blocking: "blocking", requester_role: "taproot", idempotency_key: "liveness-ask", as_of: "seq:1" } }))), () => { const list = router.executeQuery({ schema_version: 1, query_id: "liveness-ask", query: { kind: "userinput.list", campaign_id: context.campaign_id, limit: 10 } }) as { ok: boolean; value?: { records?: Array<{ id: string }> } }; askedRecord = list.value?.records?.at(-1)?.id ?? null; if (!list.ok || askedRecord === null) throw new Error("user question did not persist"); }),
    "bus.record": () => accepted(router.dispatchCommand(envelope("bus", (m) => ({ kind: "bus.record", campaign_id: context.campaign_id, node_id: context.node_id, communication: { author_node_id: context.node_id, recipient_node_id: context.child_node_id, other_recipient_node_ids: [], kind: "report", payload: { content: "liveness bus", provenance: { tag: "claimed", claimant: "liveness-prober" } }, capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-08T00:00:00.000Z", correlation_id: m.correlation_id, idempotency_key: m.idempotency_key, acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "liveness-bus" } }))), () => { const history = router.executeQuery({ schema_version: 1, query_id: "liveness-bus", query: { kind: "bus.history", campaign_id: context.campaign_id, limit: 10 } }) as { ok: boolean; value?: { conversations?: Map<string, unknown[]> } }; if (!history.ok || !(history.value?.conversations instanceof Map) || !history.value.conversations.has("liveness-bus")) throw new Error("bus record did not project"); }),
    "bus.thread.send": () => accepted(router.dispatchCommand(envelope("thread-send", () => ({ kind: "bus.thread.send", campaign_id: context.campaign_id, parent_node_id: context.node_id, child_node_id: context.child_node_id, from_node_id: context.node_id, expected_thread_version: directVersion(), message_kind: "delegate", content: "liveness direct message", provenance: { tag: "claimed", claimant: "liveness-prober" }, capability_tier: "specialist", ack_required: true }))), () => { const thread = router.executeQuery({ schema_version: 1, query_id: "liveness-thread-after-send", query: { kind: "bus.thread.history", campaign_id: context.campaign_id, parent_node_id: context.node_id, child_node_id: context.child_node_id, limit: 10 } }) as { ok: boolean; value?: { messages?: Array<{ id: string }> } }; directMessage = thread.value?.messages?.at(-1)?.id ?? null; if (!thread.ok || directMessage === null) throw new Error("direct message did not persist"); }),
    "bus.thread.ack": () => { if (directMessage === null) throw new Error("thread acknowledgement trajectory requires direct message"); return accepted(router.dispatchCommand(envelope("thread-ack", () => ({ kind: "bus.thread.ack", campaign_id: context.campaign_id, parent_node_id: context.node_id, child_node_id: context.child_node_id, from_node_id: context.child_node_id, expected_thread_version: directVersion(), message_id: directMessage!, provenance: { tag: "claimed", claimant: "liveness-prober" }, capability_tier: "specialist" }))), () => { const thread = router.executeQuery({ schema_version: 1, query_id: "liveness-thread-after-ack", query: { kind: "bus.thread.history", campaign_id: context.campaign_id, parent_node_id: context.node_id, child_node_id: context.child_node_id, limit: 10 } }) as { ok: boolean; value?: { messages?: Array<{ id: string; delivery: string }> } }; if (!thread.ok || thread.value?.messages?.find((message) => message.id === directMessage)?.delivery !== "acknowledged") throw new Error("direct acknowledgement did not project"); }); },
    "a2a.send": () => router.dispatchCommand(envelope("a2a-send-unconfigured", (m) => ({ kind: "a2a.send", campaign_id: context.campaign_id, node_id: context.node_id, communication: { author_node_id: context.node_id, recipient_node_id: context.child_node_id, other_recipient_node_ids: [], kind: "delegate", payload: { content: "liveness a2a", provenance: claimed }, capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-08T00:00:00.000Z", correlation_id: m.correlation_id, idempotency_key: m.idempotency_key, acknowledges_communication_id: null, retracts_communication_id: null } }))),
    "peer.grant": () => router.dispatchCommand(envelope("peer-grant-absent", () => ({ kind: "peer.grant", grant_id: "liveness-peer-grant", campaign_id: context.campaign_id, parent_node_id: context.node_id, left_node_id: context.node_id, right_node_id: context.child_node_id, capabilities: ["query"], capability_tier: "specialist", max_disclosure_bytes: 128, expires_at: "2030-01-01T00:00:00.000Z", provenance: claimed }))),
    "harness.approve": () => router.dispatchCommand(envelope("harness-approve-absent", () => ({ kind: "harness.approve", revision_id: "liveness-absent-revision" }))),
    "harness.rollback": () => router.dispatchCommand(envelope("harness-rollback-absent", () => ({ kind: "harness.rollback", revision_id: "liveness-absent-revision" }))),
    "harness.evaluate": () => router.dispatchCommand(envelope("harness-evaluate-absent", () => ({ kind: "harness.evaluate", revision_id: "liveness-absent-revision" }))),
    "harness.promote": () => router.dispatchCommand(envelope("harness-promote-absent", () => ({ kind: "harness.promote", revision_id: "liveness-absent-revision", human_approver: "liveness-human" }))),
    "harness.quarantine": () => router.dispatchCommand(envelope("harness-quarantine-absent", () => ({ kind: "harness.quarantine", revision_id: "liveness-absent-revision", reason: "disposable liveness probe", evidence_ids: ["liveness-evidence"] }))),
    "context.artifact.capture": () => accepted(router.dispatchCommand(envelope("context-artifact", () => ({ kind: "context.artifact.capture", artifact: { campaign_id: context.campaign_id, media_type: "text/plain", producer: "liveness-prober", visibility: "campaign", provenance: { tag: "claimed", claimant: "liveness-prober" } }, content: "liveness context" }))), () => { const governance = router.executeQuery({ schema_version: 1, query_id: "liveness-context", query: { kind: "context.governance", campaign_id: context.campaign_id } }) as { ok: boolean }; if (!governance.ok) throw new Error("context artifact did not remain queryable"); }),
  };
}

/** Human-readable rendering, used by the gate and the devtools tool alike. */
export function formatLivenessReport(report: LivenessReport): string {
  const lines: string[] = [];
  const s = report.summary;
  lines.push(`Liveness attestation — ${report.at}`);
  lines.push("");
  lines.push(
    `Catalog: ${s.catalog_total} seam(s) — ${s.catalog_answered} answered, ${s.catalog_refused} refused, ` +
    `${s.catalog_unreachable} unreachable, ${s.catalog_indeterminate} indeterminate`,
  );
  lines.push(
    `Consumers: ${s.consumers_total} declared — ${s.consumers_answered} answered, ${s.consumers_refused} refused, ` +
    `${s.consumers_unreachable} unreachable, ${s.consumers_indeterminate} indeterminate`,
  );

  const unreachable = report.catalog.filter((p) => p.outcome === "unreachable");
  if (unreachable.length > 0) {
    lines.push("");
    lines.push("UNREACHABLE seams (declared, well-posed request, no working handler):");
    for (const probe of unreachable) lines.push(`  ${probe.direction} ${probe.kind} — ${probe.detail}`);
  }

  if (report.consumer_drift === null) {
    lines.push("");
    lines.push("Consumer drift: NOT DETERMINED (the screen source could not be read)");
  } else if (report.consumer_drift.length > 0) {
    lines.push("");
    lines.push(`DRIFT — ${report.consumer_drift.length} screen(s) dispatch with no declared consumer:`);
    for (const screen of report.consumer_drift) lines.push(`  ${screen}`);
  }

  const badConsumers = report.consumers.filter((p) => p.outcome === "unreachable" || p.outcome === "indeterminate");
  if (badConsumers.length > 0) {
    lines.push("");
    lines.push("CONSUMERS whose own request did not produce a result:");
    for (const probe of badConsumers) lines.push(`  ${probe.consumer} -> ${probe.kind} [${probe.outcome}] ${probe.detail}`);
  }

  const refused = report.catalog.filter((p) => p.outcome === "refused");
  if (refused.length > 0) {
    lines.push("");
    lines.push("Refused (a working seam declining — typed absence, not a failure):");
    for (const probe of refused) lines.push(`  ${probe.kind} — ${probe.error_code ?? "?"}: ${probe.detail}`);
  }

  return lines.join("\n");
}
