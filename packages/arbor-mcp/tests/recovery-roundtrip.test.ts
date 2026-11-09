/**
 * G-03 roundtrip (Phase 6.3): proves recovery is genuinely wired, not just
 * statically reachable. Drives the real CLI composition root
 * (`createCliRuntime`) — the same one `arbor-mcp serve`/`webui` use — through
 * the real `ArborMCPServer`, and asserts on the projected ledger/tree state a
 * client would observe, never on an internal RecoveryService call.
 *
 * Before this wave, every recovery.retry/recovery.abandon command rejected
 * with "recovery service is not configured" (runtime-catalog.ts:190) because
 * nothing ever constructed a RecoveryService and wired it into
 * RuntimeRouterOptions.recovery_service. This test fails loudly against that
 * prior state and passes now that createCliRuntime composes a real
 * git-worktree-backed RecoveryLeaseAuthority.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { createCliRuntime } from "../src/cli.js";
import { ArborMCPServer } from "../src/server.js";
import { ArborWebUIServer } from "../src/webui.js";

const action = { description: "recover me", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" };

// A leaked GIT_DIR/GIT_WORK_TREE inherited from a parent process overrides
// `cwd` scoping for every git command below, which would silently point
// "init" at some other repo's HEAD instead of creating a fresh, isolated
// one here. Stripping these from the child env is what actually makes this
// fixture repo isolated.
const GIT_SCOPE_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"] as const;
function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_SCOPE_ENV_VARS) delete env[key];
  return env;
}

function initRepo(dir: string): void {
  const opts = { cwd: dir, env: sanitizedGitEnv() } as const;
  execFileSync("git", ["init", "-q"], opts);
  execFileSync("git", ["config", "user.email", "test@example.com"], opts);
  execFileSync("git", ["config", "user.name", "Test"], opts);
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], opts);
}

function retryCommand(nodeId: string, expectedVersion: string) {
  return {
    schema_version: 1 as const,
    metadata: {
      operation_id: "recover-op", idempotency_key: "recover-key", correlation_id: "corr-1",
      actor_id: "crown-agent", requested_at: new Date().toISOString(), expected_version: expectedVersion,
    },
    command: {
      kind: "recovery.retry" as const, campaign_id: "campaign", node_id: nodeId, prior_operation_id: "crashed-op",
      reason: "process crashed mid-expansion",
      // Contract requires a lease reference on the wire; RecoveryService
      // resolves the real old-lease disposition itself (ADR-012) rather than
      // trusting the client's claim, so these values are inert placeholders.
      lease: { lease_id: "stale-lease", worktree_id: "stale-worktree", expires_at: new Date().toISOString() },
    },
  };
}

describe("recovery composition roundtrip (G-03)", () => {
  it("reaches a ledger-witnessed ready outcome through the real ArborMCPServer built by createCliRuntime", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-recovery-roundtrip-"));
    try {
      initRepo(repo);
      const runtime = createCliRuntime(repo);
      const server = new ArborMCPServer(runtime);

      runtime.manager.startCampaign("campaign", "plan.md", action);
      const rootId = runtime.manager.getCampaignSnapshot("campaign")!.root_id;
      const [nodeId] = runtime.manager.branch("campaign", rootId, [action]);
      const expectedVersion = runtime.manager.getCampaignVersion("campaign");

      const result = await server.runtimeCatalog.dispatchCommand(retryCommand(nodeId, expectedVersion));

      expect(result).toMatchObject({ ok: true, value: { accepted: true, recovery: { status: "ready", operation_id: "recover-op" } } });

      // Projected outcomes a client actually observes — never the internal
      // RecoveryService.execute() call.
      expect(runtime.manager.getNodeInfo("campaign", nodeId)?.state).toBe("pending");
      const recoveryDecisions = runtime.manager.getAuditRecords("campaign").filter((record) => record.kind === "recovery_decision");
      expect(recoveryDecisions).toHaveLength(1);
      expect(recoveryDecisions[0]).toMatchObject({
        node_id: nodeId,
        decision: { decision: "retry", outcome: "authorized", new_operation_id: "recover-op", prior_operation_id: "crashed-op" },
      });
      // A real supervised task exists — the canonical bounded supervisor,
      // not a synthetic marker.
      expect(runtime.supervisor.get("recovery:recover-op")).toMatchObject({ state: "accepted", kind: "recovery.retry" });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("rejects a second recovery attempt on the same node while the fresh lease is still active (ADR-012 no double-dispatch)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-recovery-roundtrip-conflict-"));
    try {
      initRepo(repo);
      const runtime = createCliRuntime(repo);
      const server = new ArborMCPServer(runtime);
      runtime.manager.startCampaign("campaign", "plan.md", action);
      const rootId = runtime.manager.getCampaignSnapshot("campaign")!.root_id;
      const [nodeId] = runtime.manager.branch("campaign", rootId, [action]);
      const expectedVersion = runtime.manager.getCampaignVersion("campaign");

      const first = await server.runtimeCatalog.dispatchCommand(retryCommand(nodeId, expectedVersion));
      expect(first).toMatchObject({ ok: true, value: { accepted: true, recovery: { status: "ready" } } });

      // Node is now "pending" again with a fresh lease held; the version has
      // advanced, so a second recovery submitted against the stale expected
      // version is a real durable conflict, not a synthesized one.
      const second = await server.runtimeCatalog.dispatchCommand({
        ...retryCommand(nodeId, expectedVersion),
        metadata: { ...retryCommand(nodeId, expectedVersion).metadata, operation_id: "recover-op-2", idempotency_key: "recover-key-2" },
      });
      expect(second).toMatchObject({ ok: true, value: { accepted: false, error: { code: "conflict" } } });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("rejects a client-supplied prior operation id that differs from the durable interruption at the real CLI route", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-recovery-roundtrip-prior-id-"));
    try {
      initRepo(repo);
      const runtime = createCliRuntime(repo);
      const server = new ArborMCPServer(runtime);
      runtime.manager.startCampaign("campaign", "plan.md", action);
      const rootId = runtime.manager.getCampaignSnapshot("campaign")!.root_id;
      const [nodeId] = runtime.manager.branch("campaign", rootId, [action]);
      runtime.manager.expandNode("campaign", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
      runtime.manager.interrupt({
        campaign_id: "campaign", node_id: nodeId, operation_id: "durable-prior-op", scope: "node",
        reason: "worker disconnected", expected_version: runtime.manager.getCampaignVersion("campaign"),
        provenance: { tag: "claimed", claimant: "operator" }, acknowledge: () => {},
      });
      const expectedVersion = runtime.manager.getCampaignVersion("campaign");
      const result = await server.runtimeCatalog.dispatchCommand({
        ...retryCommand(nodeId, expectedVersion),
        command: { ...retryCommand(nodeId, expectedVersion).command, prior_operation_id: "client-prior-op" },
      });

      expect(result).toMatchObject({
        ok: true,
        value: { accepted: false, error: { code: "conflict", summary: expect.stringContaining("prior_operation_id does not match") } },
      });
      expect(runtime.manager.getNodeInfo("campaign", nodeId)?.state).toBe("interrupted");
      expect(runtime.manager.getAuditRecords("campaign").filter((record) => record.kind === "recovery_decision")).toEqual([]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("reaches the real recovery service over a live HTTP POST to ArborWebUIServer's /api/runtime/command", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-recovery-roundtrip-webui-"));
    try {
      initRepo(repo);
      const webui = new ArborWebUIServer(createCliRuntime(repo));
      const { runtime } = webui;
      runtime.manager.startCampaign("campaign", "plan.md", action);
      const rootId = runtime.manager.getCampaignSnapshot("campaign")!.root_id;
      const [nodeId] = runtime.manager.branch("campaign", rootId, [action]);
      const expectedVersion = runtime.manager.getCampaignVersion("campaign");

      const port = await new Promise<number>((resolve) => webui.start(0, () => resolve(webui.getPort()!)));
      try {
        const abandonCommand = {
          schema_version: 1 as const,
          metadata: {
            operation_id: "abandon-op", idempotency_key: "abandon-key", correlation_id: "corr-2",
            actor_id: "operator-1", requested_at: new Date().toISOString(), expected_version: expectedVersion,
          },
          command: {
            kind: "recovery.abandon" as const, campaign_id: "campaign", node_id: nodeId, prior_operation_id: "crashed-op",
            reason: "operator gave up on this branch",
            authorization: { authority: "operator" as const, authorized_by: "operator-1", rationale: "not worth retrying" },
          },
        };
        const { status, body } = await httpPost(port, "/api/runtime/command", abandonCommand, webui.operatorRequestHeaders());
        expect(status).toBe(200);
        const parsed = JSON.parse(body) as { ok: boolean; value: { accepted: boolean; recovery: { status: string } } };
        // Before this wave: { ok: true, value: { accepted: false, error: { code: "unavailable", summary: "recovery service is not configured" } } }.
        expect(parsed).toMatchObject({ ok: true, value: { accepted: true, recovery: { status: "abandoned", operation_id: "abandon-op" } } });
      } finally { await webui.stop(); }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

function httpPost(port: number, path: string, payload: unknown, headers: Readonly<Record<string, string>> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: "localhost", port, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => { resolve({ status: res.statusCode ?? 0, body: data }); });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
