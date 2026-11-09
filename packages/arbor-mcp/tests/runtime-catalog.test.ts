import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { RUNTIME_CATALOG_MANIFEST, RUNTIME_CONTRACT_VERSION, RuntimeEventStream, TaskSupervisor, type Action } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import { ArborMCPServer } from "../src/server.js";
import type { RecoveryResult, RecoveryService } from "../src/recovery-service.js";
import { RUNTIME_CATALOG, RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { captureWorktreeResult } from "../src/result-adoption.js";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const metadata = { operation_id: "op-1", idempotency_key: "key-1", correlation_id: "correlation-1", actor_id: "operator", requested_at: "2026-08-01T00:00:00.000Z" };

function makeRouter(): { manager: CampaignManager; supervisor: TaskSupervisor; events: RuntimeEventStream; router: RuntimeCatalogRouter } {
  const manager = new CampaignManager();
  const supervisor = new TaskSupervisor();
  const events = new RuntimeEventStream("runtime");
  manager.startCampaign("campaign", "plan.md", root);
  return { manager, supervisor, events, router: new RuntimeCatalogRouter(new ArborRuntime({ manager, supervisor, event_stream: events })) };
}

describe("runtime catalog parity", () => {
  it("declares every closed core command and query exactly once", async () => {
    const governedContextKinds = [
      "context.artifact.capture", "context.workspace", "context.overlays", "context.governance",
      "fold.propose", "fold.approve", "fold.rollback", "playbook.propose", "playbook.approve",
      "harness.propose", "harness.approve", "harness.rollback", "harness.evaluate", "harness.promote", "subagent.execute", "subagent.executions",
      "harness.evaluation.start", "harness.evaluation.candidates", "harness.evaluation.runs", "harness.evaluation.detail", "harness.quarantine",
    ];
    const productExtensionEntries = [
      "command:followup.create", "command:git.worktree.cleanup", "command:git.worktree.create", "command:git.worktree.switch", "command:harness.session.fork", "command:harness.session.respawn", "command:harness.session.resume", "command:integration.disable", "command:integration.enable", "command:integration.install", "command:integration.rollback", "command:integration.update", "command:migration.apply", "command:migration.rollback", "command:notification.read", "command:remote.control", "command:scheduler.control", "command:session.identity.mutate",
      "query:doctor.get", "query:followup.list", "query:git.workspace", "query:governance.record.read", "query:governance.record.search", "query:harness.session.availability", "query:integration.admit", "query:integration.inspect", "query:integration.list", "query:migration.inspect", "query:migration.preview", "query:notification.list", "query:remote.inspect", "query:result.verification.get", "query:result.verification.list", "query:scheduler.inspect", "query:session.identity.get", "query:session.identity.search",
    ] as const;
    expect(RUNTIME_CATALOG.map((entry) => `${entry.direction}:${entry.kind}`).sort()).toEqual([
      "command:a2a.receive", "command:a2a.send", "command:approval.approve", "command:approval.expire", "command:approval.reject", "command:approval.request", "command:bus.record", "command:bus.thread.ack", "command:bus.thread.send", "command:campaign.halt", "command:campaign.start", "command:communication.record", "command:compaction.record", "command:harness.session.interrupt", "command:harness.session.steer", "command:job.cancel", "command:job.pause", "command:job.resume", "command:job.retry", "command:job.submit", "command:operation.cancel", "command:output.capture", "command:peer.grant", "command:peer.query", "command:peer.reply", "command:recovery.abandon", "command:recovery.retry", "command:result.adopt", "command:result.revert", "command:result.scope.authorize", "command:result.review.comment", "command:result.review.editor_handoff", "command:result.review.request_revision", "command:sibling.spawn", "command:surveillance.scan", "command:task.retry", "command:tree.branch", "command:tree.interrupt", "command:tree.prune", "command:trust.session.enroll", "command:trust.session.revoke", "command:trust.session.rotate", "command:userinput.answer", "command:userinput.ask", "command:taskcomposer.answer", "command:taskcomposer.cancel", "command:taskcomposer.confirm", "command:taskcomposer.reject", "command:taskcomposer.retry", "command:taskcomposer.submit",
      "query:a2a.cards", "query:agent.list", "query:approval.list", "query:audit.list", "query:bus.history", "query:bus.thread.history", "query:campaign.list", "query:campaign.snapshot", "query:campaign.tree", "query:capability.introspect", "query:communication.history", "query:communication.selection", "query:compaction.guard", "query:compaction.list", "query:config.get", "query:control.discover", "query:control.inbox", "query:control.status", "query:event.resume", "query:foreground.derive", "query:governance.backlog", "query:governance.snapshot", "query:harness.connector.inventory", "query:harness.native.readiness", "query:harness.session.attach", "query:harness.session.events", "query:harness.session.inspect", "query:harness.session.list", "query:inspect.action", "query:job.list", "query:kb.list", "query:native.budget.get", "query:nodecard.resolve", "query:operation.get", "query:operation.list", "query:output.descriptor", "query:output.list", "query:output.raw", "query:peer.grants", "query:peer.history", "query:phase_message.list", "query:project.manage", "query:project.registry.list", "query:recovery.pending", "query:result.inspect", "query:result.list", "query:result.review.workspace", "query:sibling.status", "query:surveillance.findings", "query:task.list", "query:taskcomposer.get", "query:taskcomposer.list", "query:trust.session.list", "query:trust.session.status", "query:userinput.awaiting", "query:userinput.list",
      ...governedContextKinds.map((kind) => `${["context.workspace", "context.overlays", "context.governance", "subagent.executions", "harness.evaluation.candidates", "harness.evaluation.runs", "harness.evaluation.detail"].includes(kind) ? "query" : "command"}:${kind}`),
      ...productExtensionEntries,
      ...RUNTIME_CATALOG_MANIFEST.filter((entry) => entry.kind.startsWith("repo.flight.")).map((entry) => `${entry.direction}:${entry.kind}`),
    ].sort());
    expect(RUNTIME_CATALOG.filter((entry) => entry.supported).map((entry) => entry.kind).sort())
      .toEqual(["a2a.cards", "a2a.receive", "a2a.send", "agent.list", "approval.approve", "approval.expire", "approval.list", "approval.reject", "approval.request", "audit.list", "bus.history", "bus.record", "bus.thread.ack", "bus.thread.history", "bus.thread.send", "campaign.halt", "campaign.list", "campaign.snapshot", "campaign.start", "campaign.tree", "capability.introspect", "communication.history", "communication.record", "communication.selection", "compaction.guard", "compaction.list", "compaction.record", "config.get", "control.discover", "control.inbox", "control.status", "event.resume", "foreground.derive", "governance.backlog", "governance.snapshot", "harness.connector.inventory", "harness.native.readiness", "harness.session.attach", "harness.session.events", "harness.session.inspect", "harness.session.interrupt", "harness.session.list", "harness.session.steer", "inspect.action", "job.cancel", "job.list", "job.pause", "job.resume", "job.retry", "job.submit", "kb.list", "native.budget.get", "nodecard.resolve", "operation.cancel", "operation.get", "operation.list", "output.capture", "output.descriptor", "output.list", "output.raw", "peer.grant", "peer.grants", "peer.history", "peer.query", "peer.reply", "phase_message.list", "project.manage", "project.registry.list", "recovery.abandon", "recovery.pending", "recovery.retry", "result.adopt", "result.inspect", "result.list", "result.revert", "result.scope.authorize", "result.review.comment", "result.review.editor_handoff", "result.review.request_revision", "result.review.workspace", "sibling.spawn", "sibling.status", "surveillance.findings", "surveillance.scan", "task.list", "task.retry", "taskcomposer.answer", "taskcomposer.cancel", "taskcomposer.confirm", "taskcomposer.get", "taskcomposer.list", "taskcomposer.reject", "taskcomposer.retry", "taskcomposer.submit", "tree.branch", "tree.interrupt", "tree.prune", "trust.session.enroll", "trust.session.list", "trust.session.revoke", "trust.session.rotate", "trust.session.status", "userinput.answer", "userinput.ask", "userinput.awaiting", "userinput.list", ...governedContextKinds, ...productExtensionEntries.map((entry) => entry.slice(entry.indexOf(":") + 1)), ...RUNTIME_CATALOG_MANIFEST.filter((entry) => entry.kind.startsWith("repo.flight.") && entry.supported).map((entry) => entry.kind)].sort());
  });

  it("declares the live snapshot projections supported (G-29)", async () => {
    for (const kind of ["a2a.cards", "foreground.derive", "nodecard.resolve"] as const) {
      const entry = RUNTIME_CATALOG.find((e) => e.kind === kind && e.direction === "query");
      expect(entry, `${kind} must remain declared in the catalog`).toMatchObject({ supported: true });
    }
  });
});

describe("RuntimeCatalogRouter", () => {
  it("reviews and adopts an exact verified capture through the canonical router", async () => {
    const target = mkdtempSync(join(tmpdir(), "arbor-result-target-"));
    const worktree = mkdtempSync(join(tmpdir(), "arbor-result-worktree-"));
    const persistence = mkdtempSync(join(tmpdir(), "arbor-result-persistence-"));
    try {
      for (const repo of [target, worktree]) {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Result router test"], { cwd: repo });
        writeFileSync(join(repo, "seed.txt"), "seed\n", "utf8");
        execFileSync("git", ["add", "-A"], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
      }
      mkdirSync(join(worktree, "docs"));
      writeFileSync(join(worktree, "docs", "adopted.md"), "# Adopted\n", "utf8");
      const captured = captureWorktreeResult({ campaign_id: "result-campaign", node_id: "result-node", worktree_path: worktree, verified: true, score: 0.9, persistence_dir: persistence });
      if (captured === null) throw new Error("result fixture did not capture a patch");

      const router = new RuntimeCatalogRouter(new ArborRuntime({ persistence_dir: persistence, workspace_root: target }));
      expect(router.executeQuery({ schema_version: 1, query_id: "result-list", query: { kind: "result.list", campaign_id: "result-campaign" } }))
        .toMatchObject({ ok: true, capability: "result.read", value: { campaign_id: "result-campaign", items: [{ node_id: "result-node", verified: true, files: ["docs/adopted.md"], patch_sha256: captured.patch_sha256 }] } });
      expect(router.executeQuery({ schema_version: 1, query_id: "result-inspect", query: { kind: "result.inspect", campaign_id: "result-campaign", node_id: "result-node" } }))
        .toMatchObject({ ok: true, capability: "result.read", value: { record: { patch_sha256: captured.patch_sha256, verified: true }, patch: { sha256: captured.patch_sha256, content: expect.stringContaining("docs/adopted.md") } } });
      const workspace = router.executeQuery({ schema_version: 1, query_id: "result-workspace", query: { kind: "result.review.workspace", campaign_id: "result-campaign", node_id: "result-node" } });
      expect(workspace).toMatchObject({ ok: true, capability: "result.read", value: { counts: { files: 1, additions: 1, comments: 0 }, files: [{ path: "docs/adopted.md", status: "added" }], conflict_preview: { status: "clean" }, relationships: { critic: { status: "unavailable" }, provenance: { capture: "verified" } }, review_revision: 1 } });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "result-comment", idempotency_key: "result-comment" }, command: { kind: "result.review.comment", campaign_id: "result-campaign", node_id: "result-node", expected_patch_sha256: captured.patch_sha256, expected_revision: 1, file_path: "docs/adopted.md", line: 1, side: "new", body: "Keep this heading specific.", author_id: "web-reviewer" } })).toMatchObject({ ok: true, capability: "result.adopt", value: { accepted: true, review: { review_revision: 2, comments: [{ body: "Keep this heading specific." }] } } });

      const adopt = {
        schema_version: 1 as const,
        metadata: { ...metadata, operation_id: "result-adopt", idempotency_key: "result-adopt" },
        command: { kind: "result.adopt" as const, campaign_id: "result-campaign", node_id: "result-node", expected_patch_sha256: captured.patch_sha256, confirmed: true as const },
      };
      expect(await router.dispatchCommand(adopt)).toMatchObject({ ok: true, capability: "result.adopt", value: { accepted: true, operation_id: "result-adopt" } });
      expect(readFileSync(join(target, "docs", "adopted.md"), "utf8")).toBe("# Adopted\n");
      expect(await router.dispatchCommand(adopt)).toMatchObject({ ok: true, capability: "result.adopt", value: { accepted: true, operation_id: "result-adopt" } });

      // A restarted runtime restores the completed adoption operation before
      // dispatch. Replaying its idempotency key must acknowledge, never apply
      // the patch a second time.
      const restartedAfterAdopt = new RuntimeCatalogRouter(new ArborRuntime({ persistence_dir: persistence, workspace_root: target }));
      expect(await restartedAfterAdopt.dispatchCommand(adopt)).toMatchObject({ ok: true, capability: "result.adopt", value: { accepted: true, operation_id: "result-adopt" } });
      expect(readFileSync(join(target, "docs", "adopted.md"), "utf8")).toBe("# Adopted\n");

      const revert = {
        schema_version: 1 as const,
        metadata: { ...metadata, operation_id: "result-revert", idempotency_key: "result-revert" },
        command: { kind: "result.revert" as const, adoption_operation_id: "result-adopt", expected_patch_sha256: captured.patch_sha256, confirmed: true as const },
      };
      expect(await restartedAfterAdopt.dispatchCommand(revert)).toMatchObject({ ok: true, capability: "result.revert", value: { accepted: true, operation_id: "result-revert" } });
      expect(existsSync(join(target, "docs", "adopted.md"))).toBe(false);

      // The durable revert acknowledgement is also stable across a restart;
      // a distinct second revert remains conflict-safe after restoration.
      const restartedAfterRevert = new RuntimeCatalogRouter(new ArborRuntime({ persistence_dir: persistence, workspace_root: target }));
      expect(await restartedAfterRevert.dispatchCommand(revert)).toMatchObject({ ok: true, capability: "result.revert", value: { accepted: true, operation_id: "result-revert" } });
      expect(existsSync(join(target, "docs", "adopted.md"))).toBe(false);
      expect(await restartedAfterRevert.dispatchCommand({ ...revert, metadata: { ...revert.metadata, operation_id: "result-revert-again", idempotency_key: "result-revert-again" } }))
        .toMatchObject({ ok: true, capability: "result.revert", value: { accepted: false, error: { code: "conflict", summary: expect.stringContaining("already been reverted") } } });

      const divergentAdoption = { ...adopt, metadata: { ...adopt.metadata, operation_id: "result-adopt-divergent", idempotency_key: "result-adopt-divergent" } };
      expect(await restartedAfterRevert.dispatchCommand(divergentAdoption)).toMatchObject({ ok: true, capability: "result.adopt", value: { accepted: true, operation_id: "result-adopt-divergent" } });
      writeFileSync(join(target, "docs", "adopted.md"), "# Operator change\n", "utf8");
      const restartedWithDivergence = new RuntimeCatalogRouter(new ArborRuntime({ persistence_dir: persistence, workspace_root: target }));
      expect(await restartedWithDivergence.dispatchCommand({
        ...revert,
        metadata: { ...revert.metadata, operation_id: "result-revert-divergent", idempotency_key: "result-revert-divergent" },
        command: { ...revert.command, adoption_operation_id: "result-adopt-divergent" },
      })).toMatchObject({ ok: true, capability: "result.revert", value: { accepted: false, error: { code: "conflict" } } });

      expect(await router.dispatchCommand({
        ...adopt,
        metadata: { ...adopt.metadata, operation_id: "result-adopt-stale", idempotency_key: "result-adopt-stale" },
        command: { ...adopt.command, expected_patch_sha256: "0".repeat(64) },
      })).toMatchObject({ ok: true, capability: "result.adopt", value: { accepted: false, error: { code: "conflict", summary: expect.stringContaining("changed since it was inspected") } } });

      const noWorkspace = new RuntimeCatalogRouter(new ArborRuntime({ persistence_dir: persistence }));
      expect(await noWorkspace.dispatchCommand({ ...adopt, metadata: { ...adopt.metadata, operation_id: "result-adopt-unavailable", idempotency_key: "result-adopt-unavailable" } }))
        .toMatchObject({ ok: true, capability: "result.adopt", value: { accepted: false, error: { code: "unavailable" } } });
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
      rmSync(persistence, { recursive: true, force: true });
    }
  });

  it("retains the campaign node's exact machine verification when adopting its patch", async () => {
    const target = mkdtempSync(join(tmpdir(), "arbor-verified-target-"));
    const worktree = mkdtempSync(join(tmpdir(), "arbor-verified-worktree-"));
    const persistence = mkdtempSync(join(tmpdir(), "arbor-verified-persistence-"));
    try {
      for (const repo of [target, worktree]) {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Result router test"], { cwd: repo });
        writeFileSync(join(repo, "seed.txt"), "seed\n", "utf8");
        execFileSync("git", ["add", "-A"], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
      }
      writeFileSync(join(worktree, "verified.txt"), "verified bytes\n", "utf8");
      const manager = new CampaignManager({ persistence_dir: persistence });
      manager.startCampaign("verified-campaign", "plan.md", root);
      const action: Action = { ...root, description: "write verified.txt", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["verified.txt"], command_argv: [["node", "--test", "tests/site.test.mjs"]] } };
      const nodeId = manager.branch("verified-campaign", "root", [action])[0]!;
      manager.expandNode("verified-campaign", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
      manager.recordResult("verified-campaign", nodeId, {
        specialist_output: "implemented and checked", specialist_agent: "seed",
        provenance: { tag: "verified", cmd: "node --test tests/site.test.mjs", exit: 0, stdout_hash: `sha256:${"a".repeat(64)}`, check: { kind: "shell_command", breadth: "single" }, strength: "command_executed" },
        critic_agent: "panel", critic_approved: true, critic_rationale: "independently approved",
        score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 1, total_visits: 1 },
      });
      const captured = captureWorktreeResult({ campaign_id: "verified-campaign", node_id: nodeId, worktree_path: worktree, verified: true, score: 1, persistence_dir: persistence, declared_write_paths: ["verified.txt"] });
      if (captured === null) throw new Error("verified fixture did not capture a patch");
      const router = new RuntimeCatalogRouter(new ArborRuntime({ manager, persistence_dir: persistence, workspace_root: target }));
      const adopted = await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "verified-adopt", idempotency_key: "verified-adopt" }, command: { kind: "result.adopt", campaign_id: "verified-campaign", node_id: nodeId, expected_patch_sha256: captured.patch_sha256, confirmed: true } });
      expect(adopted).toMatchObject({ ok: true, value: { accepted: true } });
      expect(router.executeQuery({ schema_version: 1, query_id: "verified-record", query: { kind: "result.verification.get", campaign_id: "verified-campaign", node_id: nodeId } } as never)).toMatchObject({
        ok: true,
        value: { confidence: "verified", absence_reason: null, files: ["verified.txt"], checks: [{ command: ["node", "--test", "tests/site.test.mjs"], exit_status: 0, provenance: { tag: "verified" } }] },
      });
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
      rmSync(persistence, { recursive: true, force: true });
    }
  });

  it("authorizes an exact out-of-scope capture separately before canonical adoption", async () => {
    const target = mkdtempSync(join(tmpdir(), "arbor-rescope-target-"));
    const worktree = mkdtempSync(join(tmpdir(), "arbor-rescope-worktree-"));
    const persistence = mkdtempSync(join(tmpdir(), "arbor-rescope-persistence-"));
    try {
      for (const repo of [target, worktree]) {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Result router test"], { cwd: repo });
        writeFileSync(join(repo, "seed.txt"), "seed\n", "utf8");
        execFileSync("git", ["add", "-A"], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
      }
      writeFileSync(join(worktree, "outside.txt"), "reviewed widening\n", "utf8");
      const captured = captureWorktreeResult({ campaign_id: "scope-campaign", node_id: "root", worktree_path: worktree, verified: true, score: 0.9, persistence_dir: persistence, declared_write_paths: ["allowed.txt"] });
      if (captured === null) throw new Error("scope fixture did not capture a patch");
      const manager = new CampaignManager({ persistence_dir: persistence });
      manager.startCampaign("scope-campaign", "plan.md", root);
      const router = new RuntimeCatalogRouter(new ArborRuntime({ manager, persistence_dir: persistence, workspace_root: target }));
      const authorization = await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "scope-authorize", idempotency_key: "scope-authorize" }, command: { kind: "result.scope.authorize", campaign_id: "scope-campaign", node_id: "root", expected_patch_sha256: captured.patch_sha256, authorization_id: "scope-auth-1", authorized_by: "operator", confirmed: true } });
      expect(authorization).toMatchObject({ ok: true, capability: "result.adopt", value: { accepted: true, operation_id: "scope-authorize" } });
      const adoption = await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "scope-adopt", idempotency_key: "scope-adopt" }, command: { kind: "result.adopt", campaign_id: "scope-campaign", node_id: "root", expected_patch_sha256: captured.patch_sha256, scope_expansion_authorization_id: "scope-auth-1", confirmed: true } });
      expect(adoption, JSON.stringify(adoption)).toMatchObject({ ok: true, capability: "result.adopt", value: { accepted: true, operation_id: "scope-adopt" } });
      expect(readFileSync(join(target, "outside.txt"), "utf8")).toBe("reviewed widening\n");
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
      rmSync(persistence, { recursive: true, force: true });
    }
  });

  it("derives foregrounds and node cards from live node state and only publishes A2A cards with a configured secret", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "plan.md", root);
    const nodeId = manager.branch("campaign", "root", [{ ...root, description: "visual task", category: "visual", delegate_to: "seed" }])[0]!;
    const runtime = new ArborRuntime({ manager, agent_config: { seed: { model: "configured-seed", foreground: { inputs: ["repo"], outputs: ["patch"] } } } });
    const router = new RuntimeCatalogRouter(runtime);
    expect(router.executeQuery({ schema_version: 1, query_id: "card", query: { kind: "nodecard.resolve", campaign_id: "campaign", node_id: nodeId } }))
      .toMatchObject({ ok: true, capability: "nodecard.read", value: { card: { node_id: nodeId, skills: ["leaf-visual", "visual", "seed"] } } });
    const foreground = router.executeQuery({ schema_version: 1, query_id: "foreground", query: { kind: "foreground.derive", campaign_id: "campaign", node_id: nodeId } });
    expect(foreground).toMatchObject({ ok: true, capability: "foreground.read", value: { foreground: { card: { node_id: nodeId, inputs: ["repo"], outputs: ["patch"] }, prompt_fragment: expect.stringContaining("configured-seed") } } });
    expect(router.executeQuery({ schema_version: 1, query_id: "cards", query: { kind: "a2a.cards", campaign_id: "campaign" } }))
      .toMatchObject({ ok: false, error: { code: "unavailable" } });
    const published = new RuntimeCatalogRouter(runtime, { a2a_bridge: { signing_secret: "test-secret", default_recipient_tier: "specialist" } })
      .executeQuery({ schema_version: 1, query_id: "cards", query: { kind: "a2a.cards", campaign_id: "campaign" } });
    expect(published).toMatchObject({ ok: true, capability: "a2a.read", value: { cards: [{ node_ref: "root" }, { node_ref: nodeId }] } });
  });

  it("projects recovery.pending from the durable manager view with its CAS revision", async () => {
    const { manager, router } = makeRouter();
    const node = manager.branch("campaign", "root", [{ ...root, description: "recover" }])[0];
    manager.expandNode("campaign", node, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    manager.interrupt({
      campaign_id: "campaign", node_id: node, operation_id: "interrupt-1", scope: "node", reason: "test",
      expected_version: manager.getCampaignVersion("campaign"), provenance: { tag: "claimed", claimant: "operator" }, acknowledge: () => {},
    });
    expect(router.executeQuery({ schema_version: RUNTIME_CONTRACT_VERSION, query_id: "pending", query: { kind: "recovery.pending", campaign_id: "campaign", limit: 1 } })).toMatchObject({
      ok: true, capability: "recovery.read", value: {
        campaign_id: "campaign",
        nodes: [{ node_id: node, state: "interrupted", prior_operation_id: "interrupt-1", expected_version: manager.getCampaignVersion("campaign") }],
      },
    });
  });

  it("durably records idempotent communications, emits afterward, and restores selection projections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-communication-runtime-"));
    try {
      const manager = new CampaignManager({ persistence_dir: dir });
      manager.startCampaign("campaign", "plan.md", root);
      const runtime = new ArborRuntime({ manager });
      const router = new RuntimeCatalogRouter(runtime);
      const request = communicationCommand("specialist", "message-key");
      const before = runtime.eventStream.cursor().sequence;
      expect(await router.dispatchCommand(request)).toMatchObject({ ok: true, value: { accepted: true }, capability: "communication.write" });
      expect(await router.dispatchCommand(request)).toMatchObject({ ok: true, value: { accepted: true } });
      expect(runtime.eventStream.resume({ stream_id: runtime.eventStream.streamId, sequence: before }, {})).toMatchObject({
        kind: "events", events: [{ event: { kind: "audit.evidence_recorded", campaign_id: "campaign" } }],
      });

      const restarted = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager({ persistence_dir: dir }) }));
      expect(restarted.executeQuery(selectionQuery())).toMatchObject({
        ok: true,
        value: { communications: [{ communication: { idempotency_key: "message-key", payload: { content: "bounded report" } } }] },
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("projects communication sensitivity by adapter tier and does not expose an inbox count", async () => {
    const { manager } = makeRouter();
    const writer = new RuntimeCatalogRouter(new ArborRuntime({ manager }), { communication_tier: "orchestrator" });
    expect(await writer.dispatchCommand(communicationCommand("specialist", "public-key"))).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await writer.dispatchCommand(communicationCommand("critic", "critic-key", "critic note"))).toMatchObject({ ok: true, value: { accepted: true } });
    const specialist = new RuntimeCatalogRouter(new ArborRuntime({ manager }), { communication_tier: "specialist" });
    const result = specialist.executeQuery(selectionQuery());
    expect(result).toMatchObject({ ok: true, value: { communications: [{ communication: { idempotency_key: "public-key" } }] } });
    if (result.ok) {
      expect(result.value).not.toHaveProperty("pending_count");
      expect((result.value as { communications: unknown[] }).communications).toHaveLength(1);
    }
  });
  it("routes only the currently safe prune command and honors idempotency", async () => {
    const { manager, router } = makeRouter();
    const child = manager.branch("campaign", "root", [{ ...root, description: "child" }])[0];
    const request = { schema_version: RUNTIME_CONTRACT_VERSION, metadata, command: { kind: "tree.prune" as const, campaign_id: "campaign", node_id: child } };

    expect(await router.dispatchCommand(request)).toMatchObject({ ok: true, value: { accepted: true, operation_id: "op-1" }, capability: "tree.write" });
    expect(await router.dispatchCommand(request)).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await router.dispatchCommand({ ...request, command: { ...request.command, node_id: "root" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(router.executeQuery({ schema_version: 1, query_id: "operation", query: { kind: "operation.get", operation_id: "op-1" } }))
      .toMatchObject({ ok: true, value: { operation_id: "op-1", state: "completed", capability: "tree.write" } });
  });

  it("returns structured errors for invalid, unsupported, denied, and manager-conflict commands", async () => {
    const { router } = makeRouter();
    expect(await router.dispatchCommand({ schema_version: 1, metadata, command: { kind: "tree.prune" } })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await router.dispatchCommand({ schema_version: 1, metadata, command: { kind: "campaign.start", campaign_id: "new", plan_path: "x" } })).toMatchObject({ ok: false, error: { code: "validation" } });
    const denied = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager() }), { granted_capabilities: new Set(["campaign.read"]) });
    expect(await denied.dispatchCommand({ schema_version: 1, metadata, command: { kind: "tree.prune", campaign_id: "x", node_id: "n" } })).toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission" } } });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, idempotency_key: "new-key" }, command: { kind: "tree.prune", campaign_id: "missing", node_id: "n" } })).toMatchObject({
      ok: true,
      value: { accepted: false, error: { code: "conflict" } },
    });
  });

  it("routes validated campaign start, branch, and independently-audited halt with idempotency", async () => {
    const manager = new CampaignManager();
    const runtime = new ArborRuntime({ manager });
    const router = new RuntimeCatalogRouter(runtime);
    const start = { schema_version: 1, metadata, command: { kind: "campaign.start" as const, campaign_id: "new", plan_path: "new.md", root_action: root } };
    expect(await router.dispatchCommand(start)).toMatchObject({ ok: true, value: { accepted: true, operation_id: "op-1" } });
    expect(await router.dispatchCommand(start)).toMatchObject({ ok: true, value: { accepted: true } });
    expect(manager.listCampaigns()).toHaveLength(1);

    const branch = { schema_version: 1, metadata: { ...metadata, operation_id: "op-branch", idempotency_key: "branch-key" }, command: { kind: "tree.branch" as const, campaign_id: "new", node_id: "root", actions: [{ ...root, description: "child" }] } };
    expect(await router.dispatchCommand(branch)).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await router.dispatchCommand(branch)).toMatchObject({ ok: true, value: { accepted: true } });
    expect(manager.getCampaignSnapshot("new")?.nodes).toHaveLength(2);

    const version = manager.getCampaignVersion("new");
    runtime.approvals.request({ request_id: "halt-approval", idempotency_key: "halt-approval", action: "campaign.halt", subject: "halt new", resource_id: "new", proposer: "operator", rationale: "operator requested", expires_at: "2099-01-01T00:00:00.000Z" });
    runtime.approvals.approve({ request_id: "halt-approval", actor: "auditor", clock: runtime.approvals.now() });
    const halt = { schema_version: 1, metadata: { ...metadata, operation_id: "op-halt", idempotency_key: "halt-key", expected_version: version }, command: { kind: "campaign.halt" as const, campaign_id: "new", reason: "manual" as const, approval_id: "halt-approval" } };
    expect(await router.dispatchCommand(halt)).toMatchObject({ ok: true, value: { accepted: true } });
    expect(manager.getCampaignSnapshot("new")).toMatchObject({ halted: true, halt_reason: "manual" });
  });

  it("returns a governed rejection for stale manual halt and does not mutate campaign state", async () => {
    const manager = new CampaignManager(); manager.startCampaign("campaign", "plan.md", root);
    const runtime = new ArborRuntime({ manager });
    runtime.approvals.request({ request_id: "stale-approval", idempotency_key: "stale-approval", action: "campaign.halt", subject: "halt campaign", resource_id: "campaign", proposer: "operator", rationale: "necessary", expires_at: "2099-01-01T00:00:00.000Z" });
    runtime.approvals.approve({ request_id: "stale-approval", actor: "auditor", clock: runtime.approvals.now() });
    const router = new RuntimeCatalogRouter(runtime);
    const halt = { schema_version: 1, metadata: { ...metadata, idempotency_key: "stale-halt", expected_version: "stale" }, command: { kind: "campaign.halt" as const, campaign_id: "campaign", reason: "manual" as const, approval_id: "stale-approval" } };
    expect(await router.dispatchCommand(halt)).toMatchObject({ ok: true, value: { accepted: false, error: { code: "conflict" } } });
    expect(manager.getCampaignSnapshot("campaign")).toMatchObject({ halted: false });
  });

  it("does not let optional admission inputs be laundered by the legacy manager default", async () => {
    const manager = new CampaignManager();
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager }));
    const start = { schema_version: 1, metadata, command: { kind: "campaign.start" as const, campaign_id: "unreviewed", plan_path: "plan.md", root_action: root, plan_review: { plan_reviewed: false, resources_available: true } } };
    expect(await router.dispatchCommand(start)).toMatchObject({ ok: true, value: { accepted: false, error: { code: "conflict" } } });
    expect(manager.getCampaignSnapshot("unreviewed")).toBeNull();
  });

  it("ADR-118: ArborRuntime.getGateRefusalProjection wraps a real admission-gate fail/bypass GateRecord in the versioned, freshness-bounded envelope campaign.start/campaign.halt route their command-result text through", () => {
    // `manager.startCampaign`/`manualHalt` hardcode `plan_reviewed`,
    // `resources_available`, and `auditor_agrees` to `true`, and
    // `validateRuntimeCommand` already rejects a negative `max_seconds`
    // before a command reaches the manager — so no *validated* command
    // envelope can drive `checkAdmission`/`checkAudit` itself to fail.
    // This exercises the real projection method those two command handlers
    // call with an admission-gate `GateRecord` shaped exactly like the one
    // `checkAdmission` produces, proving the envelope/remediation wiring
    // those handlers depend on without depending on an unreachable
    // validated-command path to also fail the gate.
    const runtime = new ArborRuntime({ manager: new CampaignManager() });
    const clock = { now: () => "2026-09-18T00:00:00.000Z" };
    const failing = runtime.getGateRefusalProjection(
      { available: true, record: { gate: "admission", result: "fail", checked_at: "2026-09-18T00:00:00.000Z", detail: "campaign config invalid" } },
      "Resolve the admission gate's failing precondition (plan review, resource availability, or a valid config) and retry.",
      clock,
    );
    // `gate.refusal`'s freshness budget is `fresh_for_ms: 0` (ADR-094's
    // "immediate expiry for authority-sensitive state") — a value observed
    // and read at the identical instant is already `stale`, never `ready`,
    // by design: a caller must always re-request before treating a gate
    // refusal as current.
    expect(failing.lifecycle).toBe("stale");
    expect(failing.value).toMatchObject({ schema_version: 2, kind: "gate.refusal", state: "refused", gate: "admission", correcting_actor: "campaign_planner", corrective_action: "repair_plan_or_config" });
    expect(failing.value?.remediation).toContain("admission gate");

    const passing = runtime.getGateRefusalProjection({ available: true, record: null }, "unused", clock);
    expect(passing.lifecycle).toBe("stale");
    expect(passing.value).toBeNull();

    const unavailable = runtime.getGateRefusalProjection(
      { available: false, gate: "audit", code: "audit_source_unavailable", reason: "no audit authority is composed for this call" },
      "Compose an audit authority and retry.",
      clock,
    );
    expect(unavailable.lifecycle).toBe("unavailable");
    expect(unavailable.value).toBeNull();
  });

  it("retains the last campaign status as stale when a refresh fails", () => {
    const runtime = new ArborRuntime({ manager: new CampaignManager() });
    const clock = { now: () => "2026-09-18T00:00:00.000Z" };
    const ready = runtime.getCampaignRunStatusProjection(undefined, clock);
    expect(ready.lifecycle).toBe("ready");

    runtime.getCampaignRunStatus = () => { throw new Error("temporary projection read failure"); };
    const stale = runtime.getCampaignRunStatusProjection(undefined, clock, ready);
    expect(stale.lifecycle).toBe("stale");
    expect(stale.value).toBe(ready.value);
    expect(stale.last_failure).toMatchObject({ code: "campaign_run_status_read_failed" });
  });

  it("keeps recovery commands unavailable until a complete recovery service is injected", async () => {
    const { router } = makeRouter();
    expect(await router.dispatchCommand(recoveryCommand("recovery.retry"))).toMatchObject({ ok: true, value: { accepted: false, error: { code: "unavailable" } } });
  });

  it("maps injected recovery ready/planned/blocked/conflict outcomes into acknowledgements without throwing", async () => {
    const outcomes: RecoveryResult[] = [
      { status: "ready", operation_id: "op-1", lease_id: "lease", task_id: "task" },
      { status: "planned", reason: "missing transition", required_integration: "persistRetryTransition" },
      { status: "blocked", reason: "ambiguous old lease" },
      { status: "conflict", reason: "stale snapshot" },
    ];
    for (const outcome of outcomes) {
      const service = { execute: () => outcome } as unknown as RecoveryService;
      const router = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager() }), { recovery_service: service });
      const result = await router.dispatchCommand(recoveryCommand("recovery.retry", `key-${outcome.status}`));
      expect(result).toMatchObject({ ok: true, value: { recovery: outcome } });
      if (result.ok) {
        expect(result.value.accepted).toBe(outcome.status === "ready" || outcome.status === "abandoned");
        if (!result.value.accepted) expect(result.value).toHaveProperty("error");
      }
    }
  });

  it("dispatches recovery.retry end-to-end with no lease supplied — the real lease is always server-minted", async () => {
    let observed: unknown;
    const service = { execute: (request: unknown) => { observed = request; return { status: "ready", operation_id: "op-1", lease_id: "fresh-lease", task_id: "task-1" } satisfies RecoveryResult; } } as unknown as RecoveryService;
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager() }), { recovery_service: service });
    const command = { schema_version: 1 as const, metadata: { ...metadata, operation_id: "op-1", idempotency_key: "no-lease-key", expected_version: "revision-1" }, command: { kind: "recovery.retry" as const, campaign_id: "campaign", node_id: "node", prior_operation_id: "prior", reason: "restart" } };
    expect(await router.dispatchCommand(command)).toMatchObject({ ok: true, value: { accepted: true, recovery: { status: "ready", lease_id: "fresh-lease" } } });
    expect(observed).not.toHaveProperty("lease");
  });

  it("maps abandonment authorization from the validated command into the injected service", async () => {
    let observed: unknown;
    const service = { execute: (request: unknown) => { observed = request; return { status: "abandoned", operation_id: "op-1" } satisfies RecoveryResult; } } as unknown as RecoveryService;
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager() }), { recovery_service: service });
    expect(await router.dispatchCommand(recoveryCommand("recovery.abandon", "abandon-key"))).toMatchObject({ ok: true, value: { accepted: true, recovery: { status: "abandoned" } } });
    expect(observed).toMatchObject({ action: "abandon", actor_role: "operator", actor_id: "operator", expected_version: "revision-1" });
  });

  it("routes bounded snapshot/list/tree queries and pages via cursor", async () => {
    const { manager, router } = makeRouter();
    manager.startCampaign("campaign-2", "two.md", root);
    const firstPage = router.executeQuery({ schema_version: 1, query_id: "list", query: { kind: "campaign.list", limit: 1 } });
    expect(firstPage).toMatchObject({ ok: true, value: { items: [{ id: expect.stringMatching(/^campaign(?:-2)?$/) }], total: 2 } });
    expect(router.executeQuery({ schema_version: 1, query_id: "snapshot", query: { kind: "campaign.snapshot", campaign_id: "campaign" } })).toMatchObject({
      ok: true,
      value: {
        id: "campaign",
        campaign_run_status: {
          schema_version: 1,
          projection_id: "campaign.run.status",
          lifecycle: "ready",
          transport: "connected",
          resync: "not_required",
          value: { attempts: [], latest: [], integrity_errors: [], ephemeral: true },
        },
      },
    });
    const tree = router.executeQuery({ schema_version: 1, query_id: "tree", query: { kind: "campaign.tree", campaign_id: "campaign", limit: 1 } });
    expect(tree).toMatchObject({ ok: true, value: { nodes: [{ id: "root" }], event_cursor: router.eventStream.cursor() } });
    expect(router.executeQuery({ schema_version: 1, query_id: "res", query: { kind: "event.resume", cursor: { stream_id: "runtime", sequence: 0 } } })).toMatchObject({
      ok: true,
      value: {
        kind: "events",
        events: [
          { event: { kind: "gate.recorded", campaign_id: "campaign-2" } },
          { event: { kind: "campaign.changed", campaign_id: "campaign-2", change: "created" } },
        ],
      },
    });
    // cursor pagination is now wired: limit 1 with a real stream cursor returns
    // the second record + a null next_cursor (page consumed).
    const paged = router.executeQuery({ schema_version: 1, query_id: "cursor", query: { kind: "campaign.list", limit: 1, cursor: { stream_id: "campaigns", sequence: 1 } } });
    expect(paged.ok).toBe(true);
    if (paged.ok && firstPage.ok) {
      const firstId = (firstPage.value as { items: { id: string }[] }).items[0]!.id;
      const secondId = (paged.value as { items: { id: string }[] }).items[0]!.id;
      expect(new Set([firstId, secondId])).toEqual(new Set(["campaign", "campaign-2"]));
      expect((paged.value as { next_cursor: unknown }).next_cursor).toBeNull();
    }
  });

  it("retains the last campaign-run status as stale when a snapshot refresh fails", () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign-stale-status", "plan.md", root);
    const runtime = new ArborRuntime({ manager });
    const router = new RuntimeCatalogRouter(runtime);
    const query = { schema_version: 1, query_id: "campaign-status", query: { kind: "campaign.snapshot", campaign_id: "campaign-stale-status" } };

    const first = router.executeQuery(query);
    expect(first).toMatchObject({ ok: true, value: { campaign_run_status: { lifecycle: "ready", value: { attempts: [], latest: [] } } } });
    if (!first.ok) throw new Error("initial campaign snapshot failed");
    const previousStatus = (first.value as { campaign_run_status: { lifecycle: string; value: unknown } }).campaign_run_status;

    runtime.getCampaignRunStatus = () => { throw new Error("simulated status read failure"); };
    const refreshed = router.executeQuery({ ...query, query_id: "campaign-status-refresh" });

    expect(refreshed).toMatchObject({
      ok: true,
      value: {
        campaign_run_status: {
          lifecycle: "stale",
          value: previousStatus.value,
          last_failure: { code: "campaign_run_status_read_failed" },
        },
      },
    });
  });

  it("never throws across either router boundary", async () => {
    const { router } = makeRouter();
    await expect(router.dispatchCommand(null)).resolves.toBeDefined();
    expect(() => router.executeQuery({ nope: true })).not.toThrow();
  });

  // G-32 closure: operation.list backs the `operations` TUI screen's
  // enumeration query. Asserts a REAL round trip against the
  // OperationRegistry — accepted/completed operations actually reflect the
  // dispatches issued above, terminal records are excluded by default and
  // included on request, and invalid queries are rejected — never a static
  // accepted:true or a fabricated row.
  it("dispatches operation.list against the real OperationRegistry — active/terminal filtering and validation", async () => {
    const { manager, router } = makeRouter();
    const child = manager.branch("campaign", "root", [{ ...root, description: "child" }])[0];
    const prune = { schema_version: 1 as const, metadata, command: { kind: "tree.prune" as const, campaign_id: "campaign", node_id: child } };
    expect(await router.dispatchCommand(prune)).toMatchObject({ ok: true, value: { accepted: true, operation_id: "op-1" } });

    // Default (include_terminal omitted/false): the just-completed prune
    // operation is terminal, so it must NOT appear.
    const active = router.executeQuery({ schema_version: 1, query_id: "ops-active", query: { kind: "operation.list" } });
    expect(active).toMatchObject({ ok: true, capability: "operation.read" });
    if (active.ok) {
      expect(Array.isArray(active.value)).toBe(true);
      expect((active.value as { operation_id: string }[]).some((record) => record.operation_id === "op-1")).toBe(false);
    }

    // include_terminal: true surfaces the real completed record with its
    // actual capability/state — not a placeholder.
    const withTerminal = router.executeQuery({ schema_version: 1, query_id: "ops-all", query: { kind: "operation.list", include_terminal: true } });
    expect(withTerminal).toMatchObject({
      ok: true,
      capability: "operation.read",
      value: [{ operation_id: "op-1", state: "completed", capability: "tree.write" }],
    });

    // A malformed include_terminal is a real validation rejection, not a
    // silent coercion.
    const invalid = router.executeQuery({ schema_version: 1, query_id: "ops-bad", query: { kind: "operation.list", include_terminal: "yes" } });
    expect(invalid).toMatchObject({ ok: false, error: { code: "validation" } });

    // Capability gating is real: a caller without operation.read is denied.
    const denied = new RuntimeCatalogRouter(new ArborRuntime({ manager }), { granted_capabilities: new Set(["campaign.read"]) });
    expect(denied.executeQuery({ schema_version: 1, query_id: "ops-denied", query: { kind: "operation.list" } })).toMatchObject({ ok: false, error: { code: "permission" } });
  });

  it("routes inspect.action through the canonical operation snapshot", async () => {
    const { manager, router } = makeRouter();
    const child = manager.branch("campaign", "root", [{ ...root, description: "inspectable" }])[0];
    const prune = { schema_version: 1 as const, metadata, command: { kind: "tree.prune" as const, campaign_id: "campaign", node_id: child } };
    expect(await router.dispatchCommand(prune)).toMatchObject({ ok: true, value: { accepted: true, operation_id: "op-1" } });
    expect(router.executeQuery({ schema_version: 1, query_id: "inspect-1", query: { kind: "inspect.action", action_id: "op-1" } })).toMatchObject({
      ok: true, capability: "operation.read", value: { action_id: "op-1", lifecycle: "completed", snapshot_id: expect.stringContaining("operation:op-1:") },
    });
    expect(router.executeQuery({ schema_version: 1, query_id: "inspect-bad", query: { kind: "inspect.action", action_id: "missing" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  // Closes the governance screen's empty surface.queries. The snapshot
  // builder was already real and already drove `arbor-mcp governance --json`;
  // only the round trip was missing, so on the live pane the screen would
  // have read "awaiting first projection" forever.
  it("dispatches governance.snapshot against the real decisions/ corpus", async () => {
    const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    const { router } = makeRouter();

    const result = router.executeQuery({
      schema_version: 1, query_id: "gov-1", query: { kind: "governance.snapshot", repo_root: repoRoot },
    });
    expect(result).toMatchObject({ ok: true, capability: "governance.read" });
    if (!result.ok) throw new Error("expected governance.snapshot to succeed");

    // Substance: the projected record count is the real number of ADR files
    // on disk, so these rows demonstrably came from the corpus.
    // The scanner reads ADR records, not every markdown file (decisions/README.md
    // is an index, not a decision) — so count what the corpus actually contains.
    const onDisk = readdirSync(join(repoRoot, "decisions"))
      .filter((name: string) => /^ADR-\d{3}-.*\.md$/.test(name)).length;
    const snapshot = result.value as { records: readonly unknown[] };
    expect(onDisk).toBeGreaterThan(0);
    expect(snapshot.records).toHaveLength(onDisk);

    // A nonexistent root must report `unavailable`, never an empty snapshot:
    // "nothing to govern" and "could not look" are different answers, and
    // collapsing them is the fail-open shape this audit prohibits.
    const missing = router.executeQuery({
      schema_version: 1, query_id: "gov-2", query: { kind: "governance.snapshot", repo_root: join(tmpdir(), "arbor-no-such-repo") },
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "unavailable" } });

    // Capability gating is real.
    const denied = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager() }), {
      granted_capabilities: new Set(["campaign.read"]),
    });
    expect(denied.executeQuery({ schema_version: 1, query_id: "gov-3", query: { kind: "governance.snapshot" } }))
      .toMatchObject({ ok: false, error: { code: "permission" } });

    // A malformed bound is a validation rejection, not a silent coercion.
    expect(router.executeQuery({ schema_version: 1, query_id: "gov-4", query: { kind: "governance.snapshot", max_records: 0 } }))
      .toMatchObject({ ok: false, error: { code: "validation" } });
  });

  // Finding 15 (TUI-vs-backend observability gap audit): governance.backlog
  // closes the backlog TUI screen's surface — the same real decisions/
  // corpus governance.snapshot reads, projected through
  // deriveBacklog/selectNextBacklogItem instead.
  it("dispatches governance.backlog against a real decisions/ corpus", async () => {
    // The real repo corpus's backlog is empty today — every accepted record
    // already declares obligations
    // (packages/arbor-governance/tests/backlog/derive.test.ts's "the real
    // corpus has an empty backlog" case) — so an "is it nonzero" assertion
    // against the live corpus would be vacuous. Reuses
    // arbor-governance's own fixture corpus (ADR-901/902/903: a buildable
    // record, a reasoned non-goal, and a buildable record with Test
    // implications) instead, the same fixture that package's own
    // `derive.test.ts` uses for the identical reason: real POL-04 findings
    // that do not empty out as the live corpus improves.
    const fixtureRepoRoot = resolve(fileURLToPath(new URL("../../arbor-governance/tests/backlog/fixtures", import.meta.url)));
    const { router } = makeRouter();

    const result = router.executeQuery({
      schema_version: 1, query_id: "backlog-1",
      query: { kind: "governance.backlog", repo_root: fixtureRepoRoot, at: "2026-08-01T00:00:00.000Z" },
    });
    expect(result).toMatchObject({ ok: true, capability: "governance.backlog.read" });
    if (!result.ok) throw new Error("expected governance.backlog to succeed");

    // Substance: the fixture's real, on-disk POL-04 items come through, and
    // `selected` is the real next author_obligations item — never a
    // fabricated shape.
    const projection = result.value as {
      backlog: { total_records_scanned: number; items: readonly { record_id: string; file_path: string; classification: string }[] };
      selected: { record_id: string } | null;
    };
    expect(projection.backlog.total_records_scanned).toBeGreaterThan(0);
    expect(projection.backlog.items.length).toBeGreaterThan(0);
    for (const item of projection.backlog.items) {
      expect(existsSync(join(fixtureRepoRoot, item.file_path))).toBe(true);
    }
    expect(projection.selected).not.toBeNull();
    expect(projection.backlog.items.some((item) => item.record_id === projection.selected!.record_id)).toBe(true);
    expect(projection.selected!.record_id).not.toContain("ADR-902"); // the reasoned non-goal is never selected

    // A nonexistent root must report `unavailable`, never an empty backlog.
    const missing = router.executeQuery({
      schema_version: 1, query_id: "backlog-2",
      query: { kind: "governance.backlog", repo_root: join(tmpdir(), "arbor-no-such-repo"), at: "2026-08-01T00:00:00.000Z" },
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "unavailable" } });

    // Capability gating is real.
    const denied = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager() }), {
      granted_capabilities: new Set(["campaign.read"]),
    });
    expect(denied.executeQuery({ schema_version: 1, query_id: "backlog-3", query: { kind: "governance.backlog" } }))
      .toMatchObject({ ok: false, error: { code: "permission" } });

    // A malformed timestamp is a real validation rejection, not silently ignored.
    expect(router.executeQuery({ schema_version: 1, query_id: "backlog-4", query: { kind: "governance.backlog", at: "not-a-date" } }))
      .toMatchObject({ ok: false, error: { code: "validation" } });
  });

  // Finding 8: kb.list closes the KB screen's surface. Asserts a REAL round
  // trip — the entry's failure_mode/root_cause content comes from a real
  // rejected result, never a fabricated shape, and the specialist-tier
  // gating still redacts a critic_only entry rather than dropping it.
  it("dispatches kb.list against real KB entries — content, filtering, bounds, and tier gating", async () => {
    const { manager, router } = makeRouter();
    const [childId] = manager.branch("campaign", "root", [{ ...root, description: "child" }]);
    manager.expandNode("campaign", childId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    manager.recordResult("campaign", childId, {
      specialist_output: "boom", specialist_agent: "seed",
      provenance: { tag: "claimed", claimant: "seed" },
      critic_agent: "lenticel", critic_approved: false, critic_rationale: "regression",
      score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 1, total_visits: 1 },
    });

    const listed = router.executeQuery({ schema_version: 1, query_id: "kb-1", query: { kind: "kb.list", campaign_id: "campaign" } });
    expect(listed).toMatchObject({ ok: true, capability: "kb.read" });
    if (!listed.ok) throw new Error("expected kb.list to succeed");
    const entries = listed.value as readonly { id: string; value: { type: string; failure_mode?: string } | null }[];
    expect(entries.length).toBeGreaterThan(0);
    const failure = entries.find((e) => e.value?.type === "failure_mode");
    expect(failure).toBeDefined();
    expect(failure!.value!.failure_mode).toBeTruthy();

    // type filter genuinely narrows the result.
    const filtered = router.executeQuery({
      schema_version: 1, query_id: "kb-2", query: { kind: "kb.list", campaign_id: "campaign", type: "success_pattern" },
    });
    if (!filtered.ok) throw new Error("expected filtered kb.list to succeed");
    expect((filtered.value as readonly unknown[]).every((e) => (e as { value: { type: string } | null }).value?.type !== "failure_mode")).toBe(true);

    // limit genuinely bounds the result.
    const bounded = router.executeQuery({
      schema_version: 1, query_id: "kb-3", query: { kind: "kb.list", campaign_id: "campaign", limit: 0 },
    });
    expect(bounded).toMatchObject({ ok: false, error: { code: "validation" } });

    // A malformed campaign_id is a real validation rejection.
    expect(router.executeQuery({ schema_version: 1, query_id: "kb-4", query: { kind: "kb.list", campaign_id: "" } }))
      .toMatchObject({ ok: false, error: { code: "validation" } });

    // Capability gating is real.
    const denied = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager() }), {
      granted_capabilities: new Set(["campaign.read"]),
    });
    expect(denied.executeQuery({ schema_version: 1, query_id: "kb-5", query: { kind: "kb.list", campaign_id: "campaign" } }))
      .toMatchObject({ ok: false, error: { code: "permission" } });
  });

  // Finding 9: audit.list closes the evidence-ledger screen's surface.
  // Asserts a REAL round trip against the real per-campaign ledger
  // CampaignManager.getAuditRecords already exposes to in-process observers.
  it("dispatches audit.list against the real evidence ledger — content, bounds, and gating", async () => {
    const { manager, router } = makeRouter();
    const [childId] = manager.branch("campaign", "root", [{ ...root, description: "child" }]);
    manager.expandNode("campaign", childId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    manager.recordResult("campaign", childId, {
      specialist_output: "done", specialist_agent: "seed",
      provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" },
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 },
    });

    const listed = router.executeQuery({ schema_version: 1, query_id: "audit-1", query: { kind: "audit.list", campaign_id: "campaign" } });
    expect(listed).toMatchObject({ ok: true, capability: "audit.read" });
    if (!listed.ok) throw new Error("expected audit.list to succeed");
    const records = listed.value as readonly { id: string; kind?: string; campaign_id: string; node_id: string; action_description?: string }[];
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.campaign_id === "campaign")).toBe(true);
    // A real trace packet carries the real action description recordResult
    // was called with, not a placeholder.
    const trace = records.find((r) => r.kind === undefined || r.kind === "trace");
    expect(trace).toBeDefined();
    expect(trace!.action_description).toBe("child");

    // limit genuinely bounds the result.
    const bounded = router.executeQuery({
      schema_version: 1, query_id: "audit-2", query: { kind: "audit.list", campaign_id: "campaign", limit: 1 },
    });
    if (!bounded.ok) throw new Error("expected bounded audit.list to succeed");
    expect(bounded.value as readonly unknown[]).toHaveLength(1);

    // A malformed campaign_id is a real validation rejection.
    expect(router.executeQuery({ schema_version: 1, query_id: "audit-3", query: { kind: "audit.list", campaign_id: "" } }))
      .toMatchObject({ ok: false, error: { code: "validation" } });

    // An unknown campaign is a real error, not a silently empty list.
    expect(router.executeQuery({ schema_version: 1, query_id: "audit-4", query: { kind: "audit.list", campaign_id: "no-such-campaign" } }))
      .toMatchObject({ ok: false, error: { code: "conflict" } });

    // Capability gating is real.
    const denied = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager() }), {
      granted_capabilities: new Set(["campaign.read"]),
    });
    expect(denied.executeQuery({ schema_version: 1, query_id: "audit-5", query: { kind: "audit.list", campaign_id: "campaign" } }))
      .toMatchObject({ ok: false, error: { code: "permission" } });
  });

  // G-32's last residual: output.list backs the `output` TUI screen's
  // enumeration query. Asserts a REAL round trip against a real on-disk
  // OutputEvidenceStore — the rows come from artifacts actually written to
  // disk, never a fabricated shape.
  it("dispatches output.list against a real OutputEvidenceStore — ordering, bounds, gating, and unconfigured persistence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-output-list-"));
    try {
      const manager = new CampaignManager();
      manager.startCampaign("campaign", "plan.md", root);
      const runtime = new ArborRuntime({ manager, persistence_dir: dir });
      const store = runtime.outputEvidence;
      if (!store) throw new Error("persistence_dir must configure an output evidence store");

      const artifact = (nodeId: string, stream: "stdout" | "stderr") => ({
        campaign_id: "campaign", node_id: nodeId, operation_id: `op-${nodeId}`,
        stream, media_type: "text/plain",
        provenance: { tag: "claimed" as const, claimant: "test-specialist" },
      });
      const first = store.put(artifact("n1", "stdout"), "first output");
      const second = store.put(artifact("n2", "stderr"), "second output");

      const router = new RuntimeCatalogRouter(runtime);
      const listed = router.executeQuery({ schema_version: 1, query_id: "out-1", query: { kind: "output.list" } });
      expect(listed).toMatchObject({ ok: true, capability: "output.read" });
      if (!listed.ok) throw new Error("expected output.list to succeed");

      const entries = listed.value as readonly { status: string; record: { id: string; byte_count: number; stream: string } }[];
      expect(entries).toHaveLength(2);
      expect(entries.every((entry) => entry.status === "ok")).toBe(true);
      // Both ids are real store ids, and the byte counts are the real content
      // lengths — proving these rows came from disk, not from the query.
      expect(entries.map((entry) => entry.record.id).sort()).toEqual([first.id, second.id].sort());
      expect(entries.map((entry) => entry.record.byte_count).sort()).toEqual(
        ["first output".length, "second output".length].sort(),
      );

      // limit genuinely bounds the result.
      const bounded = router.executeQuery({ schema_version: 1, query_id: "out-2", query: { kind: "output.list", limit: 1 } });
      if (!bounded.ok) throw new Error("expected bounded output.list to succeed");
      expect(bounded.value as readonly unknown[]).toHaveLength(1);

      // A malformed limit is a real validation rejection, not a silent coercion.
      expect(router.executeQuery({ schema_version: 1, query_id: "out-3", query: { kind: "output.list", limit: 0 } }))
        .toMatchObject({ ok: false, error: { code: "validation" } });

      // Capability gating is real: output.read is required.
      const denied = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["campaign.read"]) });
      expect(denied.executeQuery({ schema_version: 1, query_id: "out-4", query: { kind: "output.list" } }))
        .toMatchObject({ ok: false, error: { code: "permission" } });

      // With no persistence configured the query reports `unavailable` rather
      // than an empty list — "not configured" must not read as "no outputs".
      const unconfigured = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager() }));
      expect(unconfigured.executeQuery({ schema_version: 1, query_id: "out-5", query: { kind: "output.list" } }))
        .toMatchObject({ ok: false, error: { code: "unavailable" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes task cancellation, retry, listing, and bounded event recovery through ArborRuntime", async () => {
    const { supervisor, events, router } = makeRouter();
    supervisor.register({ id: "task-1", operation_id: "target-op", kind: "expand", owner_scope_id: "campaign" });
    supervisor.start("task-1");
    const cancel = await router.dispatchCommand({ schema_version: 1, metadata, command: { kind: "operation.cancel", target_operation_id: "target-op" } });
    expect(cancel).toMatchObject({ ok: true, value: { accepted: true } });
    expect(supervisor.get("task-1")?.state).toBe("cancel_requested");
    supervisor.acknowledgeCancellation("task-1");
    supervisor.completeCleanup("task-1");
    expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "op-2", idempotency_key: "key-2" }, command: { kind: "task.retry", task_id: "task-1" } })).toMatchObject({ ok: true, value: { accepted: true } });
    expect(router.executeQuery({ schema_version: 1, query_id: "tasks", query: { kind: "task.list", scope_id: "campaign", limit: 4 } })).toMatchObject({ ok: true, value: { items: [{ id: "task-1", state: "retrying" }] } });

    events.publish({ id: "event-1", occurred_at: "2026-08-01T00:00:00.000Z", correlation_id: "c", redacted: false, event: { kind: "campaign.changed", campaign_id: "campaign", change: "created" } });
    expect(router.executeQuery({ schema_version: 1, query_id: "resume", query: { kind: "event.resume", cursor: { stream_id: "runtime", sequence: 0 } } })).toMatchObject({ ok: true, value: { kind: "events", events: [{ id: "event-1" }] } });
    expect(router.executeQuery({ schema_version: 1, query_id: "gap", query: { kind: "event.resume", cursor: { stream_id: "other", sequence: 0 } } })).toMatchObject({ ok: true, value: { kind: "resync", reason: "wrong_stream" } });
  });
});

function recoveryCommand(kind: "recovery.retry" | "recovery.abandon", idempotency_key = "recovery-key") {
  const base = {
    schema_version: 1 as const,
    metadata: { ...metadata, operation_id: "op-1", idempotency_key, expected_version: "revision-1" },
  };
  return kind === "recovery.retry"
    ? { ...base, command: { kind, campaign_id: "campaign", node_id: "node", prior_operation_id: "prior", reason: "restart", lease: { lease_id: "stale", worktree_id: "worktree", expires_at: "2026-08-02T00:00:00.000Z" } } }
    : { ...base, command: { kind, campaign_id: "campaign", node_id: "node", prior_operation_id: "prior", reason: "abandon", authorization: { authority: "operator" as const, authorized_by: "operator", rationale: "operator decision" } } };
}

function communicationCommand(tier: "specialist" | "critic", idempotencyKey: string, content = "bounded report") {
  return {
    schema_version: 1 as const,
    metadata: { ...metadata, operation_id: `op-${idempotencyKey}`, idempotency_key: idempotencyKey },
    command: {
      kind: "communication.record" as const,
      campaign_id: "campaign",
      node_id: "root",
      communication: {
        author_node_id: "worker",
        recipient_node_id: "root",
        other_recipient_node_ids: [],
        kind: "report" as const,
        payload: { content, provenance: { tag: "claimed" as const, claimant: "worker" } },
        capability_tier: tier,
        trigger_turn: false,
        as_of: "2026-08-01T00:00:00.000Z",
        correlation_id: "correlation-1",
        idempotency_key: idempotencyKey,
        acknowledges_communication_id: null,
        retracts_communication_id: null,
      },
    },
  };
}

function selectionQuery() {
  return {
    schema_version: 1 as const,
    query_id: "selection",
    query: { kind: "communication.selection" as const, campaign_id: "campaign", node_id: "root", limit: 10, as_of: "2026-08-02T00:00:00.000Z" },
  };
}

describe("no command validator throws on a malformed payload (EC-034)", () => {
  // Ten of 77 command kinds crashed with an unhandled TypeError when a
  // required field was absent -- validators dereferenced `command.session_id`,
  // `c.proposal.id`, `c.artifact.campaign_id` and friends BEFORE checking they
  // existed. A malformed command from any client (MCP peer, remote control,
  // operator form) reached the boundary and threw instead of being rejected.
  // The query plane never had this: 0 throws across 76 kinds.
  const KINDS = [
    "context.artifact.capture", "fold.propose", "harness.propose", "playbook.propose",
    "harness.session.fork", "harness.session.interrupt", "harness.session.respawn",
    "harness.session.resume", "harness.session.steer", "migration.apply",
  ] as const;

  it("rejects a payload missing every required field instead of throwing", async () => {
    const router = new RuntimeCatalogRouter(new ArborRuntime({ persistence_dir: mkdtempSync(join(tmpdir(), "arbor-cmdguard-")) }));
    for (const kind of KINDS) {
      const id = `guard-${kind}`;
      const envelope = {
        schema_version: 1,
        metadata: { operation_id: id, idempotency_key: id, correlation_id: id, actor_id: "test", requested_at: new Date().toISOString() },
        command: { kind },
      };
      const result = await router.dispatchCommand(envelope as never) as { ok: boolean };
      expect(result.ok, `${kind} must reject, not throw`).toBe(false);
    }
  });
});

describe("a supported query kind with a malformed payload is not reported as unsupported", () => {
  const router = () => new RuntimeCatalogRouter(new ArborRuntime({ persistence_dir: mkdtempSync(join(tmpdir(), "arbor-diag-")) }));

  it("names the payload, not the kind, when a supported query fails its shape predicate", () => {
    // `output.raw` IS in the catalog as a supported query. Sent without its
    // required evidence_id/approval_id it matches no family shape predicate
    // and falls through to core's deliberately smaller union, which used to
    // answer `query.kind: unsupported query kind "output.raw"` -- telling an
    // integrator the capability does not exist when it does.
    const result = router().executeQuery({ schema_version: 1, query_id: "diag", query: { kind: "output.raw", campaign_id: "c", limit: 50 } } as never) as { ok: boolean; error?: { code?: string; diagnostic?: string; summary?: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
    expect(`${result.error?.summary} ${result.error?.diagnostic}`).toContain("output.raw");
    expect(`${result.error?.summary} ${result.error?.diagnostic}`).not.toContain("unsupported query kind");
  });

  it("still reports a genuinely unknown query kind as unsupported", () => {
    const result = router().executeQuery({ schema_version: 1, query_id: "diag", query: { kind: "not.a.real.kind", limit: 50 } } as never) as { ok: boolean; error?: { diagnostic?: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.diagnostic ?? "").toContain("unsupported query kind");
  });
});

describe("catalog surface convergence parity", () => {
  it("dispatches identical campaign.start through catalog router and MCP server", async () => {
    const manager = new CampaignManager();
    const runtime = new ArborRuntime({ manager });
    const catalog = new RuntimeCatalogRouter(runtime);
    const server = new ArborMCPServer(runtime);

    const command = {
      schema_version: 1 as const,
      metadata: { operation_id: "op-cmp", idempotency_key: "ik-cmp", correlation_id: "co-cmp", actor_id: "operator", requested_at: "2026-08-01T00:00:00.000Z" },
      command: { kind: "campaign.start" as const, campaign_id: "cmp1", plan_path: "plan.md", root_action: root },
    };

    const catalogResult = await catalog.dispatchCommand(command);
    expect(catalogResult.ok).toBe(true);
    expect((catalogResult as { ok: true; value: { accepted: boolean } }).value).toMatchObject({ accepted: true });

    // Same command re-dispatched through the MCP server wrapper (same runtime,
    // same idempotency key) must observe the identical accepted replay.
    const serverResult = await server.dispatchRuntimeCommand(command);
    expect(serverResult).toEqual(catalogResult);

    const manager2 = new CampaignManager();
    const runtime2 = new ArborRuntime({ manager: manager2 });
    const catalog2 = new RuntimeCatalogRouter(runtime2);

    const secondResult = await catalog2.dispatchCommand(command);
    expect(secondResult.ok).toBe(true);
    expect((secondResult as { ok: true; value: { accepted: boolean } }).value).toMatchObject({ accepted: true });

    const query = { schema_version: 1 as const, query_id: "cq", query: { kind: "campaign.snapshot" as const, campaign_id: "cmp1" } };
    expect(catalog.executeQuery(query)).toMatchObject({ ok: true, value: { id: "cmp1" } });
    expect(catalog2.executeQuery(query)).toMatchObject({ ok: true, value: { id: "cmp1" } });
  });

  it("preserves idempotency and structured error shape across catalog command re-dispatch", async () => {
    const { router } = makeRouter();
    const cmd = {
      schema_version: 1 as const,
      metadata: { ...metadata, operation_id: "dup-op-1" },
      command: { kind: "campaign.start" as const, campaign_id: "dup1", plan_path: "plan.md", root_action: root },
    };
    const first = await router.dispatchCommand(cmd);
    expect(first).toMatchObject({ ok: true, value: { accepted: true } });

    // Same operation + idempotency key = replay.
    const second = await router.dispatchCommand(cmd);
    expect(second).toMatchObject({ ok: true, value: { accepted: true } });

    // Different idempotency key on same operation = conflict (ok:false at router level).
    const conflictCmd = { ...cmd, metadata: { ...cmd.metadata, idempotency_key: "different-key" } };
    const conflict = await router.dispatchCommand(conflictCmd);
    expect(conflict.ok).toBe(false);
    expect((conflict as { ok: false; error: { code: string } }).error.code).toBe("conflict");
  });

  it("routes the same query through MCP server and catalog, returning identical shapes", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("webcmp", "plan.md", root);
    const runtime = new ArborRuntime({ manager });
    const server = new ArborMCPServer(runtime);
    const catalog = new RuntimeCatalogRouter(runtime);

    const queryEnvelope = { schema_version: 1 as const, query_id: "ql", query: { kind: "campaign.list" as const, limit: 10 } };

    const viaServer = server.executeRuntimeQuery(queryEnvelope);
    const viaCatalog = catalog.executeQuery(queryEnvelope);

    expect(viaServer).toMatchObject({ ok: true, capability: "campaign.read" });
    expect(viaCatalog).toMatchObject({ ok: true, capability: "campaign.read" });
    expect(Array.isArray((viaServer as { ok: true; value: { items: unknown[] } }).value.items)).toBe(true);
    expect(Array.isArray((viaCatalog as { ok: true; value: { items: unknown[] } }).value.items)).toBe(true);
  });

  it("rejects commands from a restricted capability set and surfaces the capability name", async () => {
    const { manager } = makeRouter();
    const restricted = new RuntimeCatalogRouter(new ArborRuntime({ manager }), {
      granted_capabilities: new Set(["campaign.read"]),
    });
    const cmd = {
      schema_version: 1 as const,
      metadata: { ...metadata, operation_id: "no-perm-op" },
      command: { kind: "campaign.start" as const, campaign_id: "no-perm", plan_path: "plan.md", root_action: root },
    };
    const result = await restricted.dispatchCommand(cmd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ack = result.value as { accepted: boolean; error?: { code: string } };
      expect(ack.accepted).toBe(false);
      expect(ack.error?.code).toBe("permission");
    }
  });
});
