/**
 * The loopback web dashboard withholds critic-only and approved-raw material
 * from anonymous callers (security review and operator decision 2026-10-06).
 *
 * Any local process can reach the dashboard's port, including a specialist's
 * verification command when its sandbox shares the host network. Without the
 * operator session cookie a caller therefore reads at most what a specialist
 * may read: the KB at specialist visibility, no `kb.list` (which reads at
 * critic tier), no critic_only context artifact, and no `output.raw` even
 * with a valid approval. With the cookie, behaviour is unchanged. Each case
 * drives the real HTTP server, anonymous and logged in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceLedger } from "@arbor/audit";
import type { Action, Provenance } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { ArborWebUIServer } from "../src/webui.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const EXPIRY = "2099-01-01T00:00:00.000Z";
const CRITIC_SECRET = "critic-only reasoning the specialist must not read";
const verified: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" };
const root: Action = { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" };

interface Reply { status: number; headers: http.IncomingHttpHeaders; json: unknown }

function request(port: number, method: string, path: string, body?: unknown, cookie?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) } }, (response) => {
      let output = "";
      response.on("data", (chunk) => { output += String(chunk); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, json: /^\s*[[{]/.test(output) ? JSON.parse(output) : null }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("loopback web dashboard: anonymous callers never read critic-only or approved-raw material", () => {
  let dir: string;
  let runtime: ArborRuntime;
  let web: ArborWebUIServer;
  let port: number;
  let cookie: string;
  let evidenceId: string;
  let criticArtifactId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "arbor-webui-disclosure-"));
    runtime = new ArborRuntime({ persistence_dir: join(dir, ".arbor") });
    const manager = runtime.manager;
    manager.startCampaign("camp", "plan.md", root);
    const [child] = manager.branch("camp", "root", [{ ...root, description: "child", category: "refactor", delegate_to: "seed" }]);
    manager.expandNode("camp", child!, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    manager.recordResult("camp", child!, {
      specialist_output: "done", specialist_agent: "seed", provenance: verified,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "ok",
      score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 1 },
    });
    // The manager journals every fact it learns as specialist_visible; a
    // critic_only fact is written to the same ledger the projection reads.
    const ledger = (manager as unknown as { ledger: EvidenceLedger }).ledger;
    ledger.recordMemoryFact({
      campaign_id: "camp", node_id: child!, scope: { kind: "campaign" }, type: "failure_mode", content: CRITIC_SECRET,
      provenance: verified, tier: "critic_only", source_evidence_id: ledger.getCampaign("camp")[0]!.id,
      idempotency_key: "critic-secret", tags: ["critic"], timestamp: "2026-10-06T00:00:00.000Z",
    });
    criticArtifactId = runtime.governedContext.captureArtifact({ campaign_id: "camp", media_type: "text/plain", producer: "lenticel", visibility: "critic_only", provenance: verified, content: CRITIC_SECRET }).id;

    const captured = await new RuntimeCatalogRouter(runtime).dispatchCommand({
      schema_version: 1,
      metadata: { operation_id: "capture", idempotency_key: "capture:key", correlation_id: "capture", actor_id: "seed", requested_at: "2026-10-06T00:00:00.000Z" },
      command: { kind: "output.capture", artifact: { campaign_id: "camp", node_id: child!, stream: "stdout", media_type: "text/plain", provenance: { tag: "claimed", claimant: "seed" } }, content: "approved raw material" },
    });
    if (!captured.ok || !captured.value.accepted || !("output" in captured.value)) throw new Error("capture failed");
    evidenceId = captured.value.output.descriptor.id;
    const requested = runtime.approvals.request({ request_id: "raw", idempotency_key: "raw", action: "output.raw", subject: "review", resource_id: evidenceId, proposer: "operator-a", rationale: "incident review", expires_at: EXPIRY });
    if (!requested.ok) throw new Error(requested.error);
    const approved = runtime.approvals.approve({ request_id: "raw", actor: "auditor-b", clock: runtime.approvals.now() });
    if (!approved.ok) throw new Error(approved.error);

    web = new ArborWebUIServer(runtime);
    await new Promise<void>((resolve) => web.start(0, resolve));
    port = web.getPort()!;
    const operatorUrl = new URL(web.getOperatorUrl()!);
    const bootstrap = await request(port, "GET", operatorUrl.pathname + operatorUrl.search);
    cookie = String(bootstrap.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    expect(cookie).toMatch(/^arbor_operator=/);
  });

  afterAll(async () => {
    await web.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/campaigns/:id/kb: anonymous gets specialist visibility; the operator session gets critic visibility", async () => {
    const anonymous = await request(port, "GET", "/api/campaigns/camp/kb");
    expect(anonymous.status).toBe(200);
    expect(Array.isArray(anonymous.json)).toBe(true);
    expect((anonymous.json as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(anonymous.json)).not.toContain(CRITIC_SECRET);

    const operator = await request(port, "GET", "/api/campaigns/camp/kb", undefined, cookie);
    expect(operator.status).toBe(200);
    expect(JSON.stringify(operator.json)).toContain(CRITIC_SECRET);
  });

  it("kb.list (critic tier) is refused anonymously and unchanged behind the operator session", async () => {
    for (const [method, path, body] of [["POST", "/api/runtime/query", { kind: "kb.list", campaign_id: "camp" }], ["GET", "/api/runtime/query?kind=kb.list&campaign_id=camp", undefined]] as const) {
      const anonymous = await request(port, method, path, body);
      expect(anonymous.json).toMatchObject({ ok: false, error: { code: "permission", summary: expect.stringContaining("operator session"), gate_refusal: { gate: "capability", correcting_actor: "caller", corrective_action: "reauthenticate" } } });
      expect(JSON.stringify(anonymous.json)).not.toContain(CRITIC_SECRET);
    }
    const operator = await request(port, "POST", "/api/runtime/query", { kind: "kb.list", campaign_id: "camp" }, cookie);
    expect(operator.json).toMatchObject({ ok: true });
    expect(JSON.stringify(operator.json)).toContain(CRITIC_SECRET);
  });

  it("a critic_only context artifact is refused anonymously; campaign visibility is not affected", async () => {
    const anonymous = await request(port, "POST", "/api/runtime/query", { kind: "context.workspace", artifact_id: criticArtifactId, visibility: "critic_only" });
    expect(anonymous.json).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(JSON.stringify(anonymous.json)).not.toContain(CRITIC_SECRET);
    // Asking at campaign visibility is still answered by the service's own gate.
    const asCampaign = await request(port, "POST", "/api/runtime/query", { kind: "context.workspace", artifact_id: criticArtifactId, visibility: "campaign" });
    expect(JSON.stringify(asCampaign.json)).not.toContain(CRITIC_SECRET);
    const operator = await request(port, "POST", "/api/runtime/query", { kind: "context.workspace", artifact_id: criticArtifactId, visibility: "critic_only" }, cookie);
    expect(operator.json).toMatchObject({ ok: true, value: { content: CRITIC_SECRET } });
  });

  it("output.raw with a valid approval is refused anonymously and served behind the operator session; approval listing carries no content", async () => {
    const query = { kind: "output.raw", evidence_id: evidenceId, approval_id: "raw" };
    const anonymous = await request(port, "POST", "/api/runtime/query", query);
    expect(anonymous.json).toMatchObject({ ok: false, error: { code: "permission", summary: "raw output disclosure requires the authenticated operator session" } });
    expect(JSON.stringify(anonymous.json)).not.toContain("approved raw material");
    const viaGet = await request(port, "GET", `/api/runtime/query?kind=output.raw&evidence_id=${evidenceId}&approval_id=raw`);
    expect(viaGet.json).toMatchObject({ ok: false, error: { code: "permission" } });

    const operator = await request(port, "POST", "/api/runtime/query", query, cookie);
    expect(operator.json).toMatchObject({ ok: true, value: { evidence_id: evidenceId, content: "approved raw material" } });

    const approvals = await request(port, "POST", "/api/runtime/query", { kind: "approval.list", status: "approved" });
    expect(approvals.json).toMatchObject({ ok: true, value: { records: [expect.objectContaining({ request_id: "raw", resource_id: evidenceId })] } });
    expect(JSON.stringify(approvals.json)).not.toContain("approved raw material");
  });
});
