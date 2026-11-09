import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoFlightDirector } from "../src/repo-flight-director.js";
import { createRepoFlightTransportProviderHook } from "../src/repo-flight-provider-transport-hook.js";
import type { RepoFlightProviderHookLaunchContext } from "../src/integrations/repo-flight-provider-hook.js";
import { governanceTrust, warrantForDirector } from "./helpers/repo-flight-governance.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repository(): string { const root = mkdtempSync(join(tmpdir(), "repo-flight-hook-")); roots.push(root); for (const argv of [["init", "-q"], ["config", "user.email", "flight@example.invalid"], ["config", "user.name", "Flight"]]) { const result = spawnSync("git", argv, { cwd: root, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); } writeFileSync(join(root, "file.txt"), "one\n"); spawnSync("git", ["add", "file.txt"], { cwd: root }); spawnSync("git", ["commit", "-qm", "initial"], { cwd: root }); return root; }
function context(root: string): RepoFlightProviderHookLaunchContext { return { launch_id: "00000000-0000-4000-8000-000000000001", provider: "codex", mode: "specialist", scope: "read_write", cwd: root, model: "test", resumed_provider_session_id: null, governance: { campaign_id: "campaign:1", node_id: "node:1", task_id: "task:1", write_paths: ["file.txt"], command_argv: [] } }; }

describe("provider hook to elected Flight Director transport", () => {
  it("creates a run, enrolls the actual child identity, and terminally reconciles it", async () => {
    const root = repository(), director = new RepoFlightDirector({ repository_root: root, persistence_dir: join(root, ".arbor"), required_providers: ["codex"], governance_trust: governanceTrust });
    await director.start();
    const hook = createRepoFlightTransportProviderHook({ client: director.client(), governance_attestation: (_context, planned) => warrantForDirector(director, (planned as { repo_run_id: string }).repo_run_id) }), launch = context(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await expect(hook.admit?.(launch)).resolves.toEqual({ admitted: true });
      if (!child.pid) throw new Error("test child lacks a PID");
      await hook.enroll_child?.({ ...launch, pid: child.pid });
      const enrolled = director.controller.enrollment.projections()[0]!;
      const agentClient = director.provisionAgentClient(enrolled.instance_id);
      await expect(agentClient.query({ schema_version: 1, query_id: "agent-sessions", query: { kind: "repo.flight.sessions", limit: 10 } }, "agent-sessions")).resolves.toMatchObject({ ok: true, result: { value: [expect.objectContaining({ instance_id: enrolled.instance_id })] } });
      child.kill("SIGKILL");
      const terminal = await new Promise<{ code: number | null; signal: string | null }>((done) => child.once("close", (code, signal) => done({ code, signal })));
      await hook.terminal?.({ ...launch, pid: child.pid, ...terminal });
      await expect(agentClient.query({ schema_version: 1, query_id: "agent-revoked", query: { kind: "repo.flight.sessions", limit: 10 } }, "agent-revoked")).resolves.toMatchObject({ ok: false, error: { code: "unauthorized" } });
      expect(director.controller.lifecycle.inspect(`repo-run:provider:${launch.launch_id}`)?.phase).toBe("interrupted");
      expect(director.controller.enrollment.projections()).toEqual([expect.objectContaining({ provider: "codex", pid: child.pid, state: "dead_confirmed", fenced: true, write_intents: [{ operation: "modify", path: "file.txt", purpose: "declared codex provider scope" }] })]);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await director.close(); }
  });

  it("refuses unresolved command authority before any repo run is created", async () => {
    const root = repository(), director = new RepoFlightDirector({ repository_root: root, persistence_dir: join(root, ".arbor"), governance_trust: governanceTrust });
    await director.start();
    try {
      const hook = createRepoFlightTransportProviderHook({ client: director.client(), governance_attestation: (_context, planned) => warrantForDirector(director, (planned as { repo_run_id: string }).repo_run_id) });
      await expect(hook.admit?.({ ...context(root), governance: { ...context(root).governance, command_argv: null } })).resolves.toMatchObject({ admitted: false });
      expect(director.controller.lifecycle.snapshot().runs).toEqual([]);
    } finally { await director.close(); }
  });

  it("durably fails a child that terminates before PID enrollment completes", async () => {
    const root = repository(), director = new RepoFlightDirector({ repository_root: root, persistence_dir: join(root, ".arbor"), governance_trust: governanceTrust });
    await director.start();
    try {
      const hook = createRepoFlightTransportProviderHook({ client: director.client(), governance_attestation: (_context, planned) => warrantForDirector(director, (planned as { repo_run_id: string }).repo_run_id) }), launch = { ...context(root), launch_id: "00000000-0000-4000-8000-000000000002" };
      await expect(hook.admit?.(launch)).resolves.toEqual({ admitted: true });
      await hook.terminal?.({ ...launch, pid: process.pid, code: 1, signal: null });
      expect(director.controller.lifecycle.inspect(`repo-run:provider:${launch.launch_id}`)?.phase).toBe("failed");
      expect(director.controller.enrollment.projections()).toEqual([]);
    } finally { await director.close(); }
  });
});
