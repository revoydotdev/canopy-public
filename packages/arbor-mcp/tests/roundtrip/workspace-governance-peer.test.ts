/**
 * Phase 6.3 roundtrips for the git workspace/worktree kinds, the governance
 * record kinds, and the peer.grants enumeration. Each drives the production
 * runtime composition (`createCliRuntime` / `ArborRuntime` behind a
 * `RuntimeCatalogRouter`) and asserts on the projected result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { createCliRuntime } from "../../src/cli.js";
import { LocalSessionAuthority } from "../../src/local-session.js";
import { CampaignManager } from "../../src/manager.js";
import { ArborRuntime } from "../../src/runtime.js";
import { RuntimeCatalogRouter } from "../../src/runtime-catalog.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tmp(prefix: string): string { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; }
function git(root: string, args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8" }); }

describe("git workspace / governance record / peer grant roundtrips", () => {
  it("creates, projects, switches, refuses dirty cleanup, and cleans up a governed worktree through git.workspace", async () => {
    const root = tmp("arbor-rt-git-");
    git(root, ["init", "-q"]); git(root, ["config", "user.email", "t@example.invalid"]); git(root, ["config", "user.name", "RT"]);
    writeFileSync(join(root, "tracked.txt"), "one\n"); git(root, ["add", "."]); git(root, ["commit", "-qm", "initial"]);
    const runtime = createCliRuntime(root); const router = new RuntimeCatalogRouter(runtime); const identity = new LocalSessionAuthority().identity();
    const command = (operation: string, value: Record<string, unknown>) => {
      const metadata = { operation_id: operation, idempotency_key: `key-${operation}`, correlation_id: operation, actor_id: identity.actor_id, requested_at: new Date().toISOString() };
      const { kind, ...params } = value;
      return router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, session: identity.signCommand({ kind: String(kind), metadata, params }) }, command: value });
    };
    const workspace = (id: string) => {
      const result = router.executeQuery({ schema_version: 1, query_id: id, query: { kind: "git.workspace" } });
      if (!result.ok) throw new Error(`git.workspace refused: ${JSON.stringify(result.error)}`);
      return result.value as { inspected_path: string; worktrees: readonly { path: string }[] };
    };
    try {
      expect(workspace("rt-before").worktrees).toHaveLength(1);
      await expect(command("rt-create", { kind: "git.worktree.create", campaign_id: "rt", node_id: "rt-node", specialist: "seed" })).resolves.toMatchObject({ ok: true, value: { accepted: true } });
      const created = workspace("rt-after-create");
      expect(created.worktrees).toHaveLength(2);
      const lease = created.worktrees.find((worktree) => worktree.path !== created.inspected_path)?.path;
      if (!lease) throw new Error("created worktree was not projected");
      expect(existsSync(lease)).toBe(true);
      expect(git(root, ["worktree", "list", "--porcelain"])).toContain(lease);

      await expect(command("rt-switch", { kind: "git.worktree.switch", path: lease, active_run: false })).resolves.toMatchObject({ ok: true, value: { accepted: true } });
      expect(workspace("rt-after-switch").inspected_path).toBe(lease);

      writeFileSync(join(lease, "dirty.txt"), "unreviewed\n");
      await expect(command("rt-cleanup-dirty", { kind: "git.worktree.cleanup", node_id: "rt-node", authorized: false })).resolves.toMatchObject({ ok: true, value: { accepted: false } });
      expect(existsSync(lease)).toBe(true);
      await expect(command("rt-cleanup", { kind: "git.worktree.cleanup", node_id: "rt-node", authorized: true })).resolves.toMatchObject({ ok: true, value: { accepted: true } });
      expect(existsSync(lease)).toBe(false);
      expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(lease);
    } finally { await runtime.close(); }
  });

  it("searches and reads ADR records through governance.record.search and governance.record.read", () => {
    const root = tmp("arbor-rt-gov-");
    mkdirSync(join(root, "decisions"));
    const adr = (n: string, title: string, body: string) => `# ADR-${n}: ${title}\n\n**Status:** Accepted\n**Date:** 2026-09-19\n\n## Context\n\n${body}\n\n## Decision\n\nKeep it.\n\n## Consequences\n\nNone.\n`;
    writeFileSync(join(root, "decisions", "ADR-001-first.md"), adr("001", "First record", "The repository needs a durable reader."));
    writeFileSync(join(root, "decisions", "ADR-002-second.md"), adr("002", "Second record", "Unrelated topic entirely."));
    const router = new RuntimeCatalogRouter(createCliRuntime(root));
    const search = router.executeQuery({ schema_version: 1, query_id: "rt-search", query: { kind: "governance.record.search", repo_root: root, query: "durable" } });
    expect(search).toMatchObject({ ok: true, capability: "governance.read" });
    if (!search.ok) throw new Error("search refused");
    expect((search.value as { entries: { id: string }[] }).entries.map((entry) => entry.id)).toEqual(["revoy2:ADR-001"]);
    const all = router.executeQuery({ schema_version: 1, query_id: "rt-all", query: { kind: "governance.record.search", repo_root: root } });
    expect(all.ok && (all.value as { entries: unknown[] }).entries.length).toBe(2);
    const read = router.executeQuery({ schema_version: 1, query_id: "rt-read", query: { kind: "governance.record.read", repo_root: root, id: "revoy2:ADR-002" } });
    expect(read).toMatchObject({ ok: true, capability: "governance.read", value: { record: { ok: true, value: { title: "Second record" } } } });
    expect(router.executeQuery({ schema_version: 1, query_id: "rt-bad", query: { kind: "governance.record.read", repo_root: root, id: "" } })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("enumerates the durable grant collection through peer.grants with caller scoping and restart replay", async () => {
    const persistence = tmp("arbor-rt-peer-");
    const action: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
    const manager = new CampaignManager({ persistence_dir: persistence }); manager.startCampaign("campaign", "plan.md", action);
    const [left, right, outsider] = manager.branch("campaign", "root", ["left", "right", "outsider"].map((description) => ({ ...action, description, delegate_to: "seed" as const })));
    if (!left || !right || !outsider) throw new Error("missing fixture nodes");
    const runtime = new ArborRuntime({ manager, persistence_dir: persistence });
    const as = (node_id: string, parent = false) => new RuntimeCatalogRouter(runtime, { peer_caller: parent
      ? { kind: "parent", actor_id: "parent-authority", campaign_id: "campaign", node_id, capability_tier: "orchestrator" }
      : { kind: "peer", actor_id: node_id, campaign_id: "campaign", node_id, capability_tier: "critic" } });
    const grant = (grant_id: string, l: string, r: string) => as("root", true).dispatchCommand({ schema_version: 1, metadata: { operation_id: grant_id, idempotency_key: grant_id, correlation_id: grant_id, actor_id: "parent-authority", requested_at: "2026-08-20T00:00:00.000Z" }, command: { kind: "peer.grant", grant_id, campaign_id: "campaign", parent_node_id: "root", left_node_id: l, right_node_id: r, capabilities: ["query", "reply"], capability_tier: "critic", max_disclosure_bytes: 96, expires_at: "2099-08-21T00:00:00.000Z", provenance: { tag: "claimed", claimant: "operator" } } });
    const grants = (router: RuntimeCatalogRouter, id: string) => {
      const result = router.executeQuery({ schema_version: 1, query_id: id, query: { kind: "peer.grants" } });
      if (!result.ok) throw new Error(`peer.grants refused: ${JSON.stringify(result.error)}`);
      return (result.value as { grants: { grant_id: string; left_node_id: string; right_node_id: string; max_disclosure_bytes: number }[] }).grants;
    };
    expect(grants(as("root", true), "rt-empty")).toEqual([]);
    await expect(grant("g-left-right", left, right)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    await expect(grant("g-right-outsider", right, outsider)).resolves.toMatchObject({ ok: true, value: { accepted: true } });

    expect(grants(as("root", true), "rt-parent").map((g) => g.grant_id)).toEqual(["g-left-right", "g-right-outsider"]);
    expect(grants(as("root", true), "rt-parent")[0]).toMatchObject({ left_node_id: left, right_node_id: right, max_disclosure_bytes: 96 });
    expect(grants(as(left), "rt-left").map((g) => g.grant_id)).toEqual(["g-left-right"]);
    expect(grants(as(right), "rt-right").map((g) => g.grant_id)).toEqual(["g-left-right", "g-right-outsider"]);
    expect(grants(as(outsider), "rt-outsider").map((g) => g.grant_id)).toEqual(["g-right-outsider"]);
    expect(new RuntimeCatalogRouter(runtime).executeQuery({ schema_version: 1, query_id: "rt-anon", query: { kind: "peer.grants" } })).toMatchObject({ ok: false, error: { code: "permission" } });

    const restarted = new ArborRuntime({ manager: new CampaignManager({ persistence_dir: persistence }), persistence_dir: persistence });
    const replay = new RuntimeCatalogRouter(restarted, { peer_caller: { kind: "parent", actor_id: "parent-authority", campaign_id: "campaign", node_id: "root", capability_tier: "orchestrator" } });
    expect(grants(replay, "rt-restart").map((g) => g.grant_id)).toEqual(["g-left-right", "g-right-outsider"]);
  });
});
