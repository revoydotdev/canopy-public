import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RemoteRuntimeIngress } from "../src/remote-ingress.js";
import { RemoteSessionAuthority, createRemoteSessionIdentity } from "../src/remote-session.js";
import { RemoteOperationTokenAuthority } from "../src/remote/ephemeral-token.js";
import { RemoteResultReconciler, LocalPatchApplicabilityVerifier } from "../src/remote/remote-reconcile.js";
import { AuthenticatedRemoteHttpHost } from "../src/remote/http-listener.js";
import { listCapturedResults } from "../src/result-adoption.js";
import { main } from "../src/cli.js";

// WA-14: `remote-serve`'s reconciler used a verifier that always returned
// null and never persisted anything — a remote worker's claimed result was
// echoed once and then vanished the moment its single-use grant token was
// consumed. This proves the real fix end-to-end: HTTP submit through the
// real listener -> the durable adoption store `arbor adopt` reads -> the
// verifier's honest outcome is recorded on the persisted record.
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repoWithPatch(): { repoRoot: string; patch: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "arbor-remote-repo-"));
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "test"]);
  writeFileSync(join(repoRoot, "README.md"), "before\n");
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "initial"]);
  writeFileSync(join(repoRoot, "README.md"), "before\nafter\n");
  const patch = git(repoRoot, ["diff"]);
  // Restore the worktree to a clean state — the patch text itself is what we submit remotely.
  git(repoRoot, ["checkout", "--", "README.md"]);
  return { repoRoot, patch };
}

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function setup(repoRoot: string, persistenceDir: string) {
  const now = () => new Date("2026-08-12T00:00:00.000Z");
  const sessionAuthority = new RemoteSessionAuthority({ persistence_dir: persistenceDir, now });
  const runtime = new ArborRuntime({ persistence_dir: persistenceDir, remote_session_authority: sessionAuthority });
  runtime.manager.startCampaign("campaign", "plan", root);
  const [child] = runtime.manager.branch("campaign", "root", [{ ...root, description: "child", delegate_to: "seed" }]);
  const identity = createRemoteSessionIdentity({ session_id: "worker-1", actor_id: "remote:worker", expires_at: "2026-08-13T00:00:00.000Z", thread_audiences: [{ campaign_id: "campaign", parent_node_id: "root", child_node_id: child!, author_node_id: "root" }] });
  sessionAuthority.register(identity.registration);
  const tokens = new RemoteOperationTokenAuthority({ persistence_dir: persistenceDir, now });
  const reconciler = new RemoteResultReconciler(new LocalPatchApplicabilityVerifier(repoRoot), { persistence_dir: persistenceDir });
  const host = new AuthenticatedRemoteHttpHost(new RemoteRuntimeIngress(new RuntimeCatalogRouter(runtime), sessionAuthority), tokens, reconciler, { enabled: true, host: "127.0.0.1", port: 0 });
  return { runtime, tokens, host, child: child! };
}

describe("remote result reconciliation persistence", () => {
  it("persists a real HTTP-submitted patch into the adoption store with the verifier outcome recorded", async () => {
    const { repoRoot, patch } = repoWithPatch(); dirs.push(repoRoot);
    const persistenceDir = join(repoRoot, ".arbor-persist");
    const input = setup(repoRoot, persistenceDir);
    const address = await input.host.start();
    try {
      const grant = input.tokens.issue({ session_id: "worker-1", campaign_id: "campaign", operation_id: "remote-result-1", capabilities: ["result.submit"], sensitive: false });
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/sessions/worker-1/results`, {
        method: "POST",
        headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
        body: JSON.stringify({ campaign_id: "campaign", node_id: input.child, operation_id: "remote-result-1", output: patch, provenance: { tag: "claimed", claimant: "worker" } }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { value: { locally_verified: boolean; verification_reason: string } };
      expect(body.value.locally_verified).toBe(false);
      expect(body.value.verification_reason).toContain("applies cleanly");

      // Proof: the real durable store `arbor adopt` reads now lists it.
      const captured = listCapturedResults(persistenceDir, "campaign");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ campaign_id: "campaign", node_id: input.child, verified: false, files: ["README.md"] });

      const stdout = new PassThrough(); const stderr = new PassThrough();
      let out = ""; stdout.on("data", (chunk) => { out += String(chunk); });
      const code = await main(["adopt", "--campaign", "campaign", "--json"], { cwd: repoRoot, persistence_dir: persistenceDir, stdin: new PassThrough(), stdout, stderr, env: {} });
      expect(code).toBe(0);
      const listed = JSON.parse(out) as { ok: boolean; captures: Array<{ node_id: string; verified: boolean }> };
      expect(listed.captures).toContainEqual(expect.objectContaining({ node_id: input.child, verified: false }));
    } finally { await input.host.stop(); }
  });

  it("records a non-applying patch as unverified with a specific reason, without crashing the listener", async () => {
    const { repoRoot } = repoWithPatch(); dirs.push(repoRoot);
    const persistenceDir = join(repoRoot, ".arbor-persist");
    const input = setup(repoRoot, persistenceDir);
    const address = await input.host.start();
    try {
      const grant = input.tokens.issue({ session_id: "worker-1", campaign_id: "campaign", operation_id: "remote-result-bad", capabilities: ["result.submit"], sensitive: false });
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/sessions/worker-1/results`, {
        method: "POST",
        headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
        body: JSON.stringify({ campaign_id: "campaign", node_id: input.child, operation_id: "remote-result-bad", output: "not a real diff", provenance: { tag: "claimed", claimant: "worker" } }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { value: { locally_verified: boolean; verification_reason: string } };
      expect(body.value.locally_verified).toBe(false);
      expect(body.value.verification_reason).toContain("does not apply cleanly");
      const captured = listCapturedResults(persistenceDir, "campaign");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ verified: false, files: [] });
    } finally { await input.host.stop(); }
  });
});
