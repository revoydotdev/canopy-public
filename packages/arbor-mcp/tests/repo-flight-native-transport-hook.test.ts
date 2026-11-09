import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RepoFlightDirector } from "../src/repo-flight-director.js";
import { createRepoFlightTransportNativeHook } from "../src/repo-flight-native-transport-hook.js";
import type { RepoFlightNativeSessionContext } from "../src/integrations/repo-flight-native-hook.js";
import { governanceTrust, warrantForDirector } from "./helpers/repo-flight-governance.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-flight-native-hook-")); roots.push(root);
  for (const argv of [["init", "-q"], ["config", "user.email", "flight@example.invalid"], ["config", "user.name", "Flight"]]) {
    const result = spawnSync("git", argv, { cwd: root, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr);
  }
  writeFileSync(join(root, "file.txt"), "one\n");
  spawnSync("git", ["add", "file.txt"], { cwd: root }); spawnSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

function context(root: string): RepoFlightNativeSessionContext {
  return { session_id: "native-session-one", campaign_id: "campaign:one", node_id: "node:one", operation: "specialize", workspace_root: root, access: "tool_hosted" };
}

describe("direct native lifecycle hook to the elected Flight Director", () => {
  it("correlates the real harness session without fabricating a child PID or enrollment", async () => {
    const root = repository(), director = new RepoFlightDirector({ repository_root: root, persistence_dir: join(root, ".arbor"), required_providers: ["native"], governance_trust: governanceTrust });
    await director.start();
    try {
      const hook = createRepoFlightTransportNativeHook({ client: director.client(), governance_attestation: (_context, planned) => warrantForDirector(director, (planned as { repo_run_id: string }).repo_run_id) }), session = context(root);
      await expect(hook.admit?.(session)).resolves.toEqual({ admitted: true });
      await hook.terminal?.({ ...session, outcome: "completed" });
      const run = director.controller.lifecycle.inspect("repo-run:native:native-session-one");
      expect(run).toMatchObject({ phase: "candidate_ready", bindings: { session_id: "native-session:native-session-one", worktree_path: root, evidence_refs: ["native-in-process:tool_hosted"] } });
      expect(director.controller.enrollment.projections()).toEqual([]);
      expect(director.controller.profile.provider_coverage.find((provider) => provider.provider === "native")).toMatchObject({ launch_interceptor: false, identity_enrollment: false, mutation_interceptor: false });
    } finally { await director.close(); }
  });

  it("moves an admitted in-process turn to interrupted on cancellation", async () => {
    const root = repository(), director = new RepoFlightDirector({ repository_root: root, persistence_dir: join(root, ".arbor"), required_providers: ["native"], governance_trust: governanceTrust });
    await director.start();
    try {
      const hook = createRepoFlightTransportNativeHook({ client: director.client(), governance_attestation: (_context, planned) => warrantForDirector(director, (planned as { repo_run_id: string }).repo_run_id) }), session = { ...context(root), session_id: "native-session-cancel" };
      await hook.admit?.(session);
      await hook.abort?.(session);
      await hook.terminal?.({ ...session, outcome: "interrupted" });
      expect(director.controller.lifecycle.inspect("repo-run:native:native-session-cancel")?.phase).toBe("interrupted");
    } finally { await director.close(); }
  });
});
