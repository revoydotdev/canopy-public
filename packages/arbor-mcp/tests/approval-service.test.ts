import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalService, isApprovalAction, verifyApprovedAuthority } from "../src/approval-service.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { ArborRuntime } from "../src/runtime.js";
import { CampaignManager } from "../src/manager.js";
import { TaskSupervisor } from "@arbor/core";

let clockMs = 1_700_000_000_000;
const clock = () => new Date(clockMs).toISOString();
const t = (ms: number) => { clockMs = ms; return new Date(ms).toISOString(); };

function makeService() {
  return new ApprovalService({ clock });
}

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
function reqInput(requestId = "r-1", proposer = "alice", expiresAt = FAR_FUTURE) {
  return { request_id: requestId, idempotency_key: `ik-${requestId}`, action: "campaign.halt" as const, subject: "halt campaign c1", resource_id: "c1", proposer, rationale: "stuck", expires_at: expiresAt };
}

describe("ApprovalService", () => {
  it("authorizes only approved, unexpired, independent decisions for the exact action/resource", async () => {
    const svc = makeService();
    t(1_700_000_100_000);
    const requested = svc.request(reqInput("authority", "alice", FAR_FUTURE));
    if (!requested.ok) throw new Error(requested.error);
    expect(verifyApprovedAuthority(svc.get("authority"), { action: "campaign.halt", resource_id: "c1" }, clock()).ok).toBe(false);
    const self = svc.approve({ request_id: "authority", actor: "alice", clock: clock() });
    expect(self.ok).toBe(false);
    const approved = svc.approve({ request_id: "authority", actor: "bob", clock: clock() });
    if (!approved.ok) throw new Error(approved.error);
    expect(verifyApprovedAuthority(svc.get("authority"), { action: "campaign.halt", resource_id: "c1" }, clock()).ok).toBe(true);
    expect(verifyApprovedAuthority(svc.get("authority"), { action: "output.raw", resource_id: "c1" }, clock()).ok).toBe(false);
    expect(verifyApprovedAuthority(svc.get("authority"), { action: "campaign.halt", resource_id: "other" }, clock()).ok).toBe(false);
    expect(verifyApprovedAuthority(svc.get("authority"), { action: "campaign.halt", resource_id: "c1" }, "2100-01-01T00:00:00.000Z").ok).toBe(false);
  });

  it("persists approved authority records with the runtime persistence directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-approval-persist-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: dir });
      const requested = runtime.approvals.request(reqInput("persisted", "alice", FAR_FUTURE));
      if (!requested.ok) throw new Error(requested.error);
      const approved = runtime.approvals.approve({ request_id: "persisted", actor: "bob", clock: runtime.approvals.now() });
      if (!approved.ok) throw new Error(approved.error);
      await runtime.close();
      const restarted = new ArborRuntime({ persistence_dir: dir });
      expect(verifyApprovedAuthority(restarted.approvals.get("persisted"), { action: "campaign.halt", resource_id: "c1" }, restarted.approvals.now()).ok).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("canonicalizes approvable actions and rejects unknown ones", async () => {
    expect(isApprovalAction("campaign.halt")).toBe(true);
    expect(isApprovalAction("recovery.abandon")).toBe(true);
    expect(isApprovalAction("output.raw")).toBe(true);
    expect(isApprovalAction("permission.grant")).toBe(true);
    expect(isApprovalAction("random.action")).toBe(false);
    const svc = makeService();
    t(1_700_000_100_000);
    const bad = svc.request({ ...reqInput("r-x", "alice", FAR_FUTURE), action: "random.action" as never });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/not an approvable action/);
  });

  it("requests and approves/rejects with a distinct actor", async () => {
    const svc = makeService();
    t(1_700_000_100_000);
    const requested = svc.request(reqInput("r-1", "alice", FAR_FUTURE));
    expect(requested.ok).toBe(true);
    if (requested.ok) expect(requested.record.status).toBe("pending");
    const approved = svc.approve({ request_id: "r-1", actor: "bob", clock: t(1_700_000_200_000) });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.record.status).toBe("approved");
      expect(approved.record.decided_by).toBe("bob");
    }
    const rejected = svc.reject({ request_id: "r-1", actor: "carol", clock: t(1_700_000_300_000) });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toMatch(/not pending/);
  });

  it("forbids self-approval and self-rejection (checks-and-balances)", async () => {
    const svc = makeService();
    t(1_700_000_100_000);
    svc.request(reqInput("r-self", "alice", FAR_FUTURE));
    const selfApprove = svc.approve({ request_id: "r-self", actor: "alice", clock: t(1_700_000_200_000) });
    expect(selfApprove.ok).toBe(false);
    if (!selfApprove.ok) {
      expect(selfApprove.code).toBe("permission");
      expect(selfApprove.error).toMatch(/self-approval is forbidden/);
    }
    const selfReject = svc.reject({ request_id: "r-self", actor: "alice", clock: t(1_700_000_250_000) });
    expect(selfReject.ok).toBe(false);
    if (!selfReject.ok) expect(selfReject.error).toMatch(/self-approval is forbidden/);
  });

  it("is idempotent on replay and conflicts on different payload", async () => {
    const svc = makeService();
    t(1_700_000_100_000);
    const first = svc.request(reqInput("r-1", "alice", FAR_FUTURE));
    const replay = svc.request(reqInput("r-1", "alice", FAR_FUTURE));
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.record.status).toBe("pending");
    const conflict = svc.request({ ...reqInput("r-1"), proposer: "mallory", rationale: "different" });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toMatch(/conflicts|different/);
  });

  it("binds approval to a canonical action lease, not its rendered description", () => {
    const svc = makeService();
    t(1_700_000_100_000);
    const input = {
      ...reqInput("lease", "alice", FAR_FUTURE),
      lease_scope: { operation: "campaign.halt" as const, capability: "campaign.halt", target: "c1", reversible: true, systems_touched: ["campaign:c1"], policy_version: "policy/v2", actor: "alice", session_id: "session-1" },
    };
    const first = svc.request(input);
    const rerendered = svc.request({ ...input, subject: "Stop campaign c1 now", rationale: "new display prose" });
    expect(first.ok).toBe(true);
    expect(rerendered.ok).toBe(true);
    if (!first.ok || !rerendered.ok) return;
    expect(rerendered.record.action_fingerprint).toBe(first.record.action_fingerprint);
    svc.approve({ request_id: "lease", actor: "bob", clock: clock() });
    expect(verifyApprovedAuthority(svc.get("lease"), { action: "campaign.halt", resource_id: "c1", policy_version: "policy/v2", actor: "alice", session_id: "session-1" }, clock()).ok).toBe(true);
    expect(verifyApprovedAuthority(svc.get("lease"), { action: "campaign.halt", resource_id: "other" }, clock()).ok).toBe(false);
    expect(verifyApprovedAuthority(svc.get("lease"), { action: "campaign.halt", resource_id: "c1", policy_version: "policy/v3" }, clock()).ok).toBe(false);
    expect(verifyApprovedAuthority(svc.get("lease"), { action: "campaign.halt", resource_id: "c1", actor: "mallory" }, clock()).ok).toBe(false);
    expect(verifyApprovedAuthority(svc.get("lease"), { action: "campaign.halt", resource_id: "c1", session_id: "session-2" }, clock()).ok).toBe(false);
  });

  it("expires when the decision clock is past expires_at", async () => {
    const svc = makeService();
    t(1_700_000_100_000);
    svc.request(reqInput("r-exp", "alice", new Date(1_700_000_500_000).toISOString()));
    // decide after expiry → auto-expire + conflict
    const late = svc.approve({ request_id: "r-exp", actor: "bob", clock: t(1_700_000_900_000) });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error).toMatch(/expired/);
    const listed = svc.list({ status: "expired" });
    expect(listed.some((r) => r.request_id === "r-exp")).toBe(true);
  });

  it("explicitly expires a pending request and marks it terminal", async () => {
    const svc = makeService();
    t(1_700_000_100_000);
    svc.request(reqInput("r-exp2", "alice", FAR_FUTURE));
    const expired = svc.expire("r-exp2", t(1_700_000_700_000));
    expect(expired.ok).toBe(true);
    if (expired.ok) expect(expired.record.status).toBe("expired");
    const redecide = svc.approve({ request_id: "r-exp2", actor: "bob", clock: t(1_700_000_800_000) });
    expect(redecide.ok).toBe(false);
    if (!redecide.ok) expect(redecide.error).toMatch(/expired, not pending/);
  });

  it("remembers matching canonical approvals for the session only until restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-approval-session-"));
    try {
      const service = new ApprovalService({ clock, persistence_dir: dir });
      t(1_700_000_100_000);
      service.request(reqInput("session-source", "alice", FAR_FUTURE));
      const decision = service.approve({ request_id: "session-source", actor: "bob", clock: clock(), memory_scope: "session" });
      expect(decision.ok).toBe(true);
      const remembered = service.request(reqInput("session-match", "alice", FAR_FUTURE));
      expect(remembered).toMatchObject({ ok: true, record: { status: "approved", decided_by: "bob", decision_scope: "session", remembered_from: "session-source" } });
      const restarted = new ApprovalService({ clock, persistence_dir: dir });
      expect(restarted.request(reqInput("session-after-restart", "alice", FAR_FUTURE))).toMatchObject({ ok: true, record: { status: "pending" } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("persists canonical approval memory across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-approval-memory-"));
    try {
      const service = new ApprovalService({ clock, persistence_dir: dir });
      t(1_700_000_100_000);
      service.request(reqInput("persistent-source", "alice", FAR_FUTURE));
      expect(service.approve({ request_id: "persistent-source", actor: "bob", clock: clock(), memory_scope: "persistent" })).toMatchObject({ ok: true });
      const restarted = new ApprovalService({ clock, persistence_dir: dir });
      expect(restarted.request(reqInput("persistent-match", "alice", FAR_FUTURE))).toMatchObject({ ok: true, record: { status: "approved", decision_scope: "persistent", remembered_from: "persistent-source" } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps rejection target-only and never cascades other pending requests", () => {
    const service = makeService();
    t(1_700_000_100_000);
    service.request(reqInput("reject-one", "alice", FAR_FUTURE));
    service.request(reqInput("reject-two", "alice", FAR_FUTURE));
    expect(service.reject({ request_id: "reject-one", actor: "bob", clock: clock() })).toMatchObject({ ok: true });
    expect(service.get("reject-two")?.status).toBe("pending");
  });

  it("rejects requests with future-past expires_at and unknown request ids", async () => {
    const svc = makeService();
    t(1_700_000_100_000);
    const past = svc.request(reqInput("r-past", "alice", t(1_700_000_050_000)));
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error).toMatch(/future/);
    expect(svc.approve({ request_id: "nope", actor: "bob", clock: t(1_700_000_200_000) }).ok).toBe(false);
    expect(svc.expire("nope").ok).toBe(false);
  });

  it("bounds retained records", async () => {
    const svc = new ApprovalService({ clock, max_records: 3 });
    t(1_700_000_100_000);
    for (let i = 0; i < 10; i += 1) svc.request(reqInput(`r-${i}`, "alice", FAR_FUTURE));
    expect(svc.list({ limit: 100 }).length).toBeLessThanOrEqual(3);
    expect(svc.request(reqInput("r-0", "alice", FAR_FUTURE))).toMatchObject({ ok: true });
  });

  it("uses the service clock for expiry and rejects malformed decision timestamps", () => {
    const svc = makeService();
    t(1_700_000_100_000);
    svc.request(reqInput("clock-bound", "alice", new Date(1_700_000_200_000).toISOString()));
    t(1_700_000_300_000);
    expect(svc.approve({ request_id: "clock-bound", actor: "bob", clock: new Date(1_600_000_000_000).toISOString() })).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    svc.request(reqInput("bad-clock", "alice", FAR_FUTURE));
    expect(svc.approve({ request_id: "bad-clock", actor: "bob", clock: "not-a-time" })).toMatchObject({ ok: false, code: "validation" });
  });
});

describe("catalog approval surface", () => {
  const md = (op: string) => ({ operation_id: op, idempotency_key: `ik-${op}`, actor_id: "bob", correlation_id: "c", requested_at: t(1_700_000_100_000) });

  it("does not treat caller-supplied approval actors as authenticated identities", async () => {
    const runtime = new ArborRuntime({ manager: new CampaignManager(), supervisor: new TaskSupervisor(), approvals: new ApprovalService({ clock }) });
    const router = new RuntimeCatalogRouter(runtime);
    t(1_700_000_200_000);
    const request = await router.dispatchCommand({ schema_version: 1, metadata: md("req1"), command: { kind: "approval.request", request_id: "ap-1", idempotency_key: "ik-ap-1", action: "campaign.halt", subject: "halt", resource_id: "c1", proposer: "alice", rationale: "stuck", expires_at: FAR_FUTURE } });
    expect(request.ok).toBe(true);
    if (request.ok) expect(request.value).toMatchObject({ accepted: false, error: { code: "permission", summary: "approval commands require an authenticated identity" } });

    const list = router.executeQuery({ schema_version: 1, query_id: "apps", query: { kind: "approval.list", status: "approved" } });
    expect(list.ok).toBe(true);
    if (list.ok) expect((list.value as { records: { request_id: string }[] }).records).toEqual([]);
  });

  it("enforces capability gates", async () => {
    const runtime = new ArborRuntime({ manager: new CampaignManager(), supervisor: new TaskSupervisor(), approvals: new ApprovalService({ clock }) });
    const router = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["campaign.read"]) });
    t(1_700_000_300_000);
    const request = await router.dispatchCommand({ schema_version: 1, metadata: md("req-gate"), command: { kind: "approval.request", request_id: "ap-g", idempotency_key: "ik-g", action: "campaign.halt", subject: "s", resource_id: "c", proposer: "a", rationale: "r", expires_at: FAR_FUTURE } });
    expect(request.ok).toBe(true);
    if (request.ok && "accepted" in request.value) expect(request.value.accepted).toBe(false);
    const list = router.executeQuery({ schema_version: 1, query_id: "apps", query: { kind: "approval.list" } });
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.error.code).toBe("permission");
  });

  it("rejects malformed approval envelopes", async () => {
    const runtime = new ArborRuntime({ manager: new CampaignManager(), supervisor: new TaskSupervisor(), approvals: new ApprovalService({ clock }) });
    const router = new RuntimeCatalogRouter(runtime);
    const bad = await router.dispatchCommand({ schema_version: 1, metadata: md("bad"), command: { kind: "approval.request", request_id: "", idempotency_key: "", action: "", subject: "", resource_id: "", proposer: "", expires_at: "" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("validation");
  });
});
