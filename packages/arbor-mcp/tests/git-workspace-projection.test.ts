import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "@arbor/campaign-support";
import { createCliRuntime } from "../src/cli.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { LocalSessionAuthority } from "../src/local-session.js";
import { loadOperationSnapshot } from "../src/operation-persist.js";
import { CAMPAIGN_RUN_JOB_KIND } from "../src/runtime.js";
import { GitAdapter, GitProjectionWatcher, GovernedWorktreeOperations, GitWorkspaceService, gitWorkspaceIdentity } from "../src/git-workspace-projection.js";
import { runTui } from "../src/tui.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo(): string { const root = mkdtempSync(join(tmpdir(), "arbor-git-projection-")); roots.push(root); git(root, ["init", "-q"]); git(root, ["config", "user.email", "test@example.invalid"]); git(root, ["config", "user.name", "Projection Test"]); writeFileSync(join(root, "tracked.txt"), "one\n"); git(root, ["add", "."]); git(root, ["commit", "-qm", "initial"]); return root; }
function repoWithNestedTrackedFile(): string { const root = repo(); mkdirSync(join(root, "nested")); writeFileSync(join(root, "nested", "live-watched.txt"), "nested baseline\n"); git(root, ["add", "."]); git(root, ["commit", "-qm", "nested baseline"]); return root; }
function stripAnsi(text: string): string { return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""); }
function git(root: string, args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8" }); }

describe("bounded Git workspace projection", () => {
  it("refreshes subscribed projections after a successful routed mutation and tears down with the runtime", async () => {
    const root = repoWithNestedTrackedFile(); const runtime = createCliRuntime(root); const router = new RuntimeCatalogRouter(runtime); const identity = new LocalSessionAuthority().identity();
    const service = runtime.gitWorkspace;
    if (service === null) throw new Error("Git workspace service was not composed");
    const seen: Array<{ worktrees: readonly unknown[]; changedPaths: readonly string[] }> = [];
    const unsubscribe = service.subscribe((projection) => seen.push({ worktrees: projection.worktrees, changedPaths: projection.status.changes.map((change) => change.path) }));
    const command = async (operation: string, value: Record<string, unknown>) => {
      const metadata = { operation_id: operation, idempotency_key: `key-${operation}`, correlation_id: operation, actor_id: identity.actor_id, requested_at: new Date().toISOString() };
      const { kind, ...params } = value;
      return router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, session: identity.signCommand({ kind: String(kind), metadata, params }) }, command: value });
    };
    try {
      expect((await runtime.start()).ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      seen.length = 0;
      const unsigned = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: "watch-unsigned", idempotency_key: "key-watch-unsigned", correlation_id: "watch-unsigned", actor_id: "operator", requested_at: new Date().toISOString() }, command: { kind: "git.worktree.create", campaign_id: "watch", node_id: "unsigned-node", specialist: "seed" } });
      expect(unsigned).toMatchObject({ ok: false, error: { code: "permission" } });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(seen.every((projection) => projection.worktrees.length === 1)).toBe(true);
      expect(await command("watch-create", { kind: "git.worktree.create", campaign_id: "watch", node_id: "watch-node", specialist: "seed" }))
        .toMatchObject({ ok: true, value: { accepted: true } });
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(seen.some((projection) => projection.worktrees.length === 2)).toBe(true);
      seen.length = 0;
      writeFileSync(join(root, "nested", "live-watched.txt"), "external nested edit\n");
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(seen.some((projection) => projection.changedPaths.includes("nested/live-watched.txt"))).toBe(true);
      const count = seen.length;
      unsubscribe();
      expect(await command("watch-cleanup", { kind: "git.worktree.cleanup", node_id: "watch-node", authorized: true }))
        .toMatchObject({ ok: true, value: { accepted: true } });
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(seen).toHaveLength(count);
    } finally { unsubscribe(); await runtime.close(); }
    const countAfterClose = seen.length;
    writeFileSync(join(root, "after-close.txt"), "no observer remains\n");
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(seen).toHaveLength(countAfterClose);
  });

  it("composes through the production CLI runtime and routes governed Git commands", async () => {
    const root = repo(); const runtime = createCliRuntime(root); const router = new RuntimeCatalogRouter(runtime); const identity = new LocalSessionAuthority().identity();
    const command = async (operation: string, value: Record<string, unknown>) => {
      const metadata = { operation_id: operation, idempotency_key: `key-${operation}`, correlation_id: operation, actor_id: identity.actor_id, requested_at: new Date().toISOString() };
      const { kind, ...params } = value;
      const session = identity.signCommand({ kind: String(kind), metadata, params });
      return router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, session }, command: value });
    };
    try {
      const read = router.executeQuery({ schema_version: 1, query_id: "git-read", query: { kind: "git.workspace" } });
      expect(read).toMatchObject({ ok: true, capability: "git.read", value: { repository_root: root, inspected_path: root, status: { dirty: expect.any(Boolean) } } });

      const unsigned = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: "git-create-unsigned", idempotency_key: "key-git-create-unsigned", correlation_id: "git-create-unsigned", actor_id: "operator", requested_at: new Date().toISOString() }, command: { kind: "git.worktree.create", campaign_id: "campaign", node_id: "unsigned-node", specialist: "seed" } });
      expect(unsigned).toMatchObject({ ok: false, error: { code: "permission" } });
      expect(runtime.operations.get("git-create-unsigned")).toBeUndefined();

      expect(await command("git-create", { kind: "git.worktree.create", campaign_id: "campaign", node_id: "node", specialist: "seed" }))
        .toMatchObject({ ok: true, value: { accepted: true } });
      const afterCreate = router.executeQuery({ schema_version: 1, query_id: "git-read-created", query: { kind: "git.workspace" } });
      expect(afterCreate.ok).toBe(true);
      if (!afterCreate.ok) throw new Error("Git workspace read was refused");
      const projection = afterCreate.value as { inspected_path: string; worktrees: readonly { path: string }[] };
      const leasePath = projection.worktrees.find((worktree) => worktree.path !== projection.inspected_path)?.path;
      expect(leasePath).toBeDefined();
      if (!leasePath) throw new Error("governed worktree was not projected");

      expect(await command("git-switch", { kind: "git.worktree.switch", path: leasePath, active_run: false }))
        .toMatchObject({ ok: true, value: { accepted: true } });
      expect(router.executeQuery({ schema_version: 1, query_id: "git-read-switched", query: { kind: "git.workspace" } }))
        .toMatchObject({ ok: true, value: { inspected_path: leasePath } });
      const active = runtime.supervisor.register({ id: "active-campaign-run", operation_id: "active-campaign-run-operation", kind: "campaign.run", owner_scope_id: "campaign" });
      runtime.supervisor.start(active.id);
      expect(await command("git-switch-active", { kind: "git.worktree.switch", path: root, active_run: false }))
        .toMatchObject({ ok: true, value: { accepted: false } });
      expect(await command("git-cleanup-active", { kind: "git.worktree.cleanup", node_id: "node", authorized: false, active_run: false }))
        .toMatchObject({ ok: true, value: { accepted: false } });

      runtime.supervisor.complete(active.id);
      writeFileSync(join(leasePath, "preserve.txt"), "preserve until reviewed\n");
      expect(await command("git-cleanup-dirty", { kind: "git.worktree.cleanup", node_id: "node", authorized: false }))
        .toMatchObject({ ok: true, value: { accepted: false } });
      expect(await command("git-cleanup-authorized", { kind: "git.worktree.cleanup", node_id: "node", authorized: true }))
        .toMatchObject({ ok: true, value: { accepted: true } });
    } finally { await runtime.close(); }
  });

  it("repaints the real Console Git tab after an external nested tracked-file edit", async () => {
    const root = repoWithNestedTrackedFile();
    const stdin = new PassThrough(); let output = "";
    const stdout = new PassThrough(); stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    Object.assign(stdout, { rows: 80, columns: 180, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const done = runTui({ cwd: root, stdin, stdout, stderr, frame_interval_ms: 10, on_ready: markReady });
    try {
      await ready;
      await expect.poll(() => stripAnsi(output), { timeout: 12_000 }).toContain("LIVE FILE TREE");
      writeFileSync(join(root, "nested", "live-watched.txt"), "edited outside the runtime\n");
      await expect.poll(() => stripAnsi(output), { timeout: 12_000 }).toContain("live-watched.txt · modified");
    } finally {
      stdin.end();
      await done;
    }
  }, 20_000);

  it("keeps Git capability typed unavailable outside repository contexts", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-git-nonrepo-")); roots.push(root);
    const runtime = createCliRuntime(root);
    try {
      expect(runtime.gitWorkspace).toBeNull();
      expect(new RuntimeCatalogRouter(runtime).executeQuery({ schema_version: 1, query_id: "git-unavailable", query: { kind: "git.workspace" } }))
        .toMatchObject({ ok: false, error: { code: "unavailable" } });
    } finally { await runtime.close(); }
  });

  it("requires a signed local session before Git mutation and records idempotent outcomes", async () => {
    const root = repo(); const runtime = createCliRuntime(root); const sessions = new LocalSessionAuthority(); const identity = sessions.identity();
    const router = new RuntimeCatalogRouter(runtime, { require_local_session: true });
    const command = { kind: "git.worktree.create" as const, campaign_id: "campaign", node_id: "signed-node", specialist: "seed" };
    const metadata = { operation_id: "signed-git-create", idempotency_key: "signed-git-key", correlation_id: "signed-git-correlation", actor_id: identity.actor_id, requested_at: new Date().toISOString() };
    const { kind, ...params } = command;
    const proof = identity.signCommand({ kind, metadata, params });
    const request = { schema_version: 1 as const, metadata: { ...metadata, session: proof }, command };
    try {
      const unsigned = await router.dispatchCommand({ ...request, metadata: { ...metadata } });
      expect(unsigned).toMatchObject({ ok: false, error: { code: "permission" } });
      expect(runtime.operations.list()).toHaveLength(0);

      const tampered = await router.dispatchCommand({ ...request, command: { ...command, node_id: "tampered-node" } });
      expect(tampered).toMatchObject({ ok: false, error: { code: "permission" } });
      expect(runtime.operations.list()).toHaveLength(0);

      const first = await router.dispatchCommand(request);
      expect(first).toMatchObject({ ok: true, capability: "git.worktree.write", value: { accepted: true, operation_id: "signed-git-create" } });
      expect(runtime.operations.list(true)).toMatchObject([{ operation_id: "signed-git-create", idempotency_key: "signed-git-key", state: "completed" }]);
      expect(await router.dispatchCommand(request)).toEqual(first);

      const replayMetadata = { ...metadata, operation_id: "signed-git-create-replay" };
      const sameIdempotency = { schema_version: 1 as const, metadata: { ...replayMetadata, session: identity.signCommand({ kind, metadata: replayMetadata, params }) }, command };
      expect(await router.dispatchCommand(sameIdempotency)).toEqual(first);

      const conflicting = { ...request, metadata: { ...request.metadata, idempotency_key: "different-signed-key" } };
      const conflictProof = identity.signCommand({ kind, metadata: { ...metadata, idempotency_key: "different-signed-key" }, params });
      conflicting.metadata.session = conflictProof;
      expect(await router.dispatchCommand(conflicting)).toMatchObject({ ok: false, error: { code: "conflict" } });
      const state = router.executeQuery({ schema_version: 1, query_id: "signed-git-state", query: { kind: "git.workspace" } });
      expect(state.ok).toBe(true);
      if (state.ok) expect((state.value as { worktrees: readonly unknown[] }).worktrees).toHaveLength(2);
    } finally { await runtime.close(); }
  });

  it("settles a thrown Git service error so idempotent replay cannot repeat its side effect", async () => {
    const root = repo(); const runtime = createCliRuntime(root); let calls = 0;
    const throwingService = { operations: { create() { calls += 1; throw new Error("lease backend failed"); } } } as unknown as GitWorkspaceService;
    const router = new RuntimeCatalogRouter(runtime, { git_workspace: throwingService });
    const request = gitCreateRequest("throwing-git-create", "throwing-git-key", "throwing-node");
    try {
      const first = await router.dispatchCommand(request);
      expect(first).toMatchObject({ ok: true, capability: "git.worktree.write", value: { accepted: false, operation_id: "throwing-git-create" } });
      expect(runtime.operations.get("throwing-git-create")).toMatchObject({ state: "rejected" });
      expect(await router.dispatchCommand(request)).toEqual(first);
      expect(calls).toBe(1);
    } finally { await runtime.close(); }
  });

  it("acknowledges an already-running Git operation without repeating its side effect", async () => {
    const root = repo(); const runtime = createCliRuntime(root); let calls = 0;
    const service = { operations: { create() { calls += 1; return { ok: true }; } } } as unknown as GitWorkspaceService;
    const router = new RuntimeCatalogRouter(runtime, { git_workspace: service });
    const request = gitCreateRequest("running-git-create", "running-git-key", "running-node");
    runtime.operations.accept({ metadata: request.metadata, capability: "git.worktree.write", fingerprint: JSON.stringify(request.command) });
    runtime.operations.start(request.metadata.operation_id, "task-running-git");
    try {
      expect(await router.dispatchCommand(request)).toMatchObject({ ok: true, capability: "git.worktree.write", value: { accepted: true, operation_id: request.metadata.operation_id } });
      expect(runtime.operations.get(request.metadata.operation_id)).toMatchObject({ state: "running" });
      expect(calls).toBe(0);
    } finally { await runtime.close(); }
  });

  it("does not let signed caller authorization override the active campaign cleanup fence", async () => {
    const root = repo(); const runtime = createCliRuntime(root); const sessions = new LocalSessionAuthority(); const identity = sessions.identity();
    const lease = runtime.gitWorkspace!.operations.create({ campaign_id: "campaign", node_id: "active-cleanup-node", specialist: "seed" });
    expect(lease.ok).toBe(true);
    runtime.supervisor.register({ id: "active-campaign-run", operation_id: "active-campaign-run-operation", kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: "campaign" });
    runtime.supervisor.start("active-campaign-run");
    const command = { kind: "git.worktree.cleanup" as const, node_id: "active-cleanup-node", authorized: true, active_run: false };
    const metadata = { operation_id: "active-cleanup", idempotency_key: "active-cleanup-key", correlation_id: "active-cleanup-correlation", actor_id: identity.actor_id, requested_at: new Date().toISOString() };
    const { kind, ...params } = command;
    const request = { schema_version: 1 as const, metadata: { ...metadata, session: identity.signCommand({ kind, metadata, params }) }, command };
    try {
      const result = await new RuntimeCatalogRouter(runtime, { require_local_session: true }).dispatchCommand(request);
      expect(result).toMatchObject({ ok: true, capability: "git.worktree.write", value: { accepted: false, error: { code: "conflict", summary: expect.stringContaining("campaign.run") } } });
      expect(new GitAdapter(root).worktrees()).toHaveLength(2);
      expect(runtime.operations.get(metadata.operation_id)).toMatchObject({ state: "rejected" });
    } finally { await runtime.close(); }
  });

  it("fails closed when the accepted operation identity cannot be persisted before mutation", async () => {
    const root = repo(); const persistence = join(root, ".arbor-test"); const runtime = createCliRuntime(root, persistence); let calls = 0; let checkpoints = 0;
    const service = { operations: { create() { calls += 1; return { ok: true }; } } } as unknown as GitWorkspaceService;
    const router = new RuntimeCatalogRouter(runtime, { git_workspace: service });
    const request = gitCreateRequest("precheck-git-create", "precheck-git-key", "precheck-node");
    const checkpoint = runtime.checkpointOperations.bind(runtime);
    runtime.checkpointOperations = () => { checkpoints += 1; return checkpoints === 1 ? { ok: false, value: null, failures: [] } : checkpoint(); };
    try {
      expect(await router.dispatchCommand(request)).toMatchObject({ ok: true, value: { accepted: false, operation_id: request.metadata.operation_id } });
      expect(calls).toBe(0);
      expect(runtime.operations.get(request.metadata.operation_id)).toMatchObject({ state: "rejected" });
    } finally { await runtime.close(); }
    const restarted = createCliRuntime(root, persistence);
    try {
      expect(await new RuntimeCatalogRouter(restarted, { git_workspace: service }).dispatchCommand(request)).toMatchObject({ ok: true, value: { accepted: false, operation_id: request.metadata.operation_id } });
      expect(calls).toBe(0);
    } finally { await restarted.close(); }
  });

  it("retains an accepted reconciliation marker after post-mutation persistence failure and never replays after restart", async () => {
    const root = repo(); const persistence = join(root, ".arbor-test"); const runtime = createCliRuntime(root, persistence); let calls = 0; let checkpoints = 0;
    const service = { operations: { create() { calls += 1; return { ok: true }; } } } as unknown as GitWorkspaceService;
    const router = new RuntimeCatalogRouter(runtime, { git_workspace: service });
    const request = gitCreateRequest("postcheck-git-create", "postcheck-git-key", "postcheck-node");
    const checkpoint = runtime.checkpointOperations.bind(runtime);
    runtime.checkpointOperations = () => { checkpoints += 1; return checkpoints >= 2 ? { ok: false, value: null, failures: [] } : checkpoint(); };
    try {
      expect(await router.dispatchCommand(request)).toMatchObject({ ok: false, error: { code: "internal" } });
      expect(calls).toBe(1);
      expect(loadOperationSnapshot(persistence).value?.operations).toMatchObject([{ operation_id: request.metadata.operation_id, state: "accepted" }]);
    } finally { await runtime.close(); }
    const restarted = createCliRuntime(root, persistence); let replayCalls = 0;
    const replayService = { operations: { create() { replayCalls += 1; return { ok: true }; } } } as unknown as GitWorkspaceService;
    try {
      expect(restarted.operations.requiresReconciliation(request.metadata.operation_id)).toBe(true);
      expect(await new RuntimeCatalogRouter(restarted, { git_workspace: replayService }).dispatchCommand(request)).toMatchObject({ ok: true, value: { accepted: true, operation_id: request.metadata.operation_id } });
      expect(replayCalls).toBe(0);
      expect(restarted.operations.get(request.metadata.operation_id)).toMatchObject({ state: "accepted" });
    } finally { await restarted.close(); }
  });

  it("resolves linked worktrees, detached HEAD, staging, conflicts, renames, and Unicode paths", () => {
    const root = repo(); const linked = join(root, "linked"); git(root, ["worktree", "add", "-q", "-b", "linked-branch", linked]);
    const linkedAdapter = new GitAdapter(linked); expect(linkedAdapter.worktrees()).toHaveLength(2); expect(linkedAdapter.status().branch).toBe("linked-branch");
    writeFileSync(join(linked, "café name.txt"), "new\n"); git(linked, ["add", "."]); expect(linkedAdapter.status().changes.some((change) => change.path === "café name.txt")).toBe(true);
    git(linked, ["mv", "tracked.txt", "renamed file.txt"]); expect(linkedAdapter.status().changes.some((change) => change.kind === "renamed")).toBe(true);
    git(linked, ["checkout", "--detach", "HEAD"]); expect(new GitAdapter(linked).status().detached).toBe(true);
    git(root, ["worktree", "remove", "--force", linked]); writeFileSync(join(root, "tracked.txt"), "main\n"); git(root, ["commit", "-qam", "main change"]); git(root, ["branch", "conflict-branch", "HEAD~1"]); git(root, ["checkout", "conflict-branch"]); writeFileSync(join(root, "tracked.txt"), "side\n"); git(root, ["commit", "-qam", "side change"]); git(root, ["checkout", "master"]); writeFileSync(join(root, "tracked.txt"), "other\n"); git(root, ["commit", "-qam", "other change"]); const conflictAdapter = new GitAdapter(root); const merge = spawnSync("git", ["merge", "conflict-branch"], { cwd: root, encoding: "utf8" }); expect(merge.status).not.toBe(0); expect(conflictAdapter.status().conflicted).toBe(true); git(root, ["merge", "--abort"]);
  });

  it("keeps stable identity and exposes bounded ancestry and diff projections", () => {
    const root = repo(); const adapter = new GitAdapter(root); writeFileSync(join(root, "tracked.txt"), "two\n"); writeFileSync(join(root, "untracked Ω.txt"), "u\n"); const snapshot = adapter.snapshot({ ancestry_limit: 1 }); expect(snapshot.identity).toBe(gitWorkspaceIdentity(root, root)); expect(snapshot.status.dirty).toBe(true); expect(snapshot.status.changes.map((change) => change.path)).toContain("untracked Ω.txt"); expect(snapshot.ancestry).toHaveLength(1); expect(snapshot.diff.files.some((file) => file.path === "tracked.txt")).toBe(true);
  });

  it("debounces refreshes to one pending callback and closes cleanly", async () => {
    const root = repo(); const adapter = new GitAdapter(root); const seen: string[] = []; const watcher = new GitProjectionWatcher(adapter, (projection) => seen.push(projection.identity), 10); watcher.notify(); watcher.notify(); watcher.notify(); await new Promise((resolve) => setTimeout(resolve, 40)); expect(seen).toHaveLength(1); watcher.close(); watcher.notify(); await new Promise((resolve) => setTimeout(resolve, 30)); expect(seen).toHaveLength(1);
  });

  it("refuses dirty or active cleanup until an explicit authorized workflow", () => {
    const root = repo(); const manager = new WorktreeManager({ repoRoot: root }); const operations = new GovernedWorktreeOperations(manager, new GitAdapter(root)); const created = operations.create({ campaign_id: "campaign", node_id: "node", specialist: "seed" }); expect(created.ok).toBe(true); if (!created.lease) throw new Error("lease missing"); writeFileSync(join(created.lease.path, "dirty.txt"), "preserve\n"); expect(operations.cleanup("node")).toMatchObject({ ok: false, reason: "dirty_worktree" }); expect(operations.cleanup("node", { active_run: true })).toMatchObject({ ok: false, reason: "active_worktree" }); expect(operations.cleanup("node", { authorized: true })).toMatchObject({ ok: true });
  });

  it("switches the inspected linked worktree through a governed seam without retargeting an active run", () => {
    const root = repo(); const linked = join(root, "linked"); git(root, ["worktree", "add", "-q", "-b", "linked-branch", linked]); const service = new GitWorkspaceService(new GitAdapter(root));
    expect(service.switch(linked, true)).toMatchObject({ ok: false, reason: "active_worktree" });
    expect(service.switch(linked)).toMatchObject({ ok: true }); expect(service.inspect().inspected_path).toBe(linked);
    expect(service.switch(join(root, "missing"))).toMatchObject({ ok: false, reason: "not_found" });
  });
});

function gitCreateRequest(operation_id: string, idempotency_key: string, node_id: string) {
  const identity = new LocalSessionAuthority().identity();
  const metadata = { operation_id, idempotency_key, correlation_id: operation_id, actor_id: identity.actor_id, requested_at: new Date().toISOString() };
  const command = { kind: "git.worktree.create" as const, campaign_id: "campaign", node_id, specialist: "seed" };
  const { kind, ...params } = command;
  return {
    schema_version: 1 as const,
    metadata: { ...metadata, session: identity.signCommand({ kind, metadata, params }) },
    command,
  };
}
