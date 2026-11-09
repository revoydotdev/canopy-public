import { describe, expect, it } from "vitest";
import { TaskSupervisor } from "@arbor/core";
import { RecoveryService, type RecoveryCampaignPort, type RecoveryLeaseAuthority, type RecoveryRequest } from "../src/recovery-service.js";

const request: RecoveryRequest = {
  operation_id: "recovery-1", idempotency_key: "key-1", campaign_id: "campaign", node_id: "node",
  prior_operation_id: "old-operation", expected_version: "revision-1", action: "retry", actor_id: "crown", actor_role: "crown", reason: "restart",
};

function campaign(log: string[], mutation = true): RecoveryCampaignPort {
  return {
    readNode: () => ({ campaign_id: "campaign", node_id: "node", state: "expanding", prior_operation_id: null, version: "revision-1" }),
    ...(mutation ? { persistRetryTransition: () => { log.push("persist"); return { ok: true as const }; } } : {}),
  };
}

function leases(log: string[], old: ReturnType<RecoveryLeaseAuthority["resolveOldLease"]> = "inactive", isolation = true): RecoveryLeaseAuthority {
  return {
    resolveOldLease: () => { log.push("resolve-old"); return old; },
    acquireFresh: () => { log.push("acquire"); return { ok: true, lease_id: "fresh-lease" }; },
    checkIsolation: () => { log.push("isolation"); return { worktree_isolated: isolation, starting_commit_correct: isolation }; },
    releaseFresh: () => { log.push("release"); },
  };
}

describe("RecoveryService", () => {
  it("orders old-lease resolution, fresh lease, fresh isolation, durable transition, then supervised readiness", () => {
    const log: string[] = [];
    const supervisor = new TaskSupervisor();
    const service = new RecoveryService(campaign(log), supervisor, leases(log));
    const result = service.execute(request);

    expect(result).toEqual({ status: "ready", operation_id: "recovery-1", lease_id: "fresh-lease", task_id: "recovery:recovery-1" });
    expect(log).toEqual(["resolve-old", "acquire", "isolation", "persist"]);
    expect(supervisor.get("recovery:recovery-1")).toMatchObject({ state: "accepted", operation_id: "recovery-1" });
  });

  it("is idempotent, detects a changed decision, and bounds duplicate lease acquisition", () => {
    const log: string[] = [];
    const service = new RecoveryService(campaign(log), new TaskSupervisor(), leases(log));
    expect(service.execute(request).status).toBe("ready");
    expect(service.execute(request).status).toBe("ready");
    expect(log.filter((step) => step === "acquire")).toHaveLength(1);
    expect(service.execute({ ...request, action: "abandon", actor_role: "operator" })).toEqual({ status: "conflict", reason: "idempotency key names a different recovery decision" });
  });

  it("blocks unauthorized, stale, ambiguous, or failed-isolation recovery without synthesizing outcomes", () => {
    const log: string[] = [];
    const service = new RecoveryService(campaign(log), new TaskSupervisor(), leases(log, "ambiguous"));
    expect(service.execute({ ...request, actor_role: "specialist", idempotency_key: "unauth" })).toMatchObject({ status: "blocked" });
    expect(service.execute({ ...request, expected_version: "old", idempotency_key: "stale" })).toMatchObject({ status: "conflict" });
    expect(service.execute({ ...request, idempotency_key: "ambiguous" })).toMatchObject({ status: "blocked", reason: expect.stringContaining("ambiguous") });
    const failedLog: string[] = [];
    expect(new RecoveryService(campaign(failedLog), new TaskSupervisor(), leases(failedLog, "inactive", false)).execute({ ...request, idempotency_key: "isolation" })).toMatchObject({ status: "blocked", reason: "fresh isolation check failed" });
    expect(failedLog).toEqual(["resolve-old", "acquire", "isolation", "release"]);
  });

  it("rejects a mismatched interrupted operation before touching leases", () => {
    const log: string[] = [];
    const port = {
      ...campaign(log),
      readNode: () => ({ campaign_id: "campaign", node_id: "node", state: "interrupted" as const, prior_operation_id: "durable-operation", version: "revision-1" }),
    };
    const result = new RecoveryService(port, new TaskSupervisor(), leases(log)).execute(request);
    expect(result).toEqual({ status: "conflict", reason: "prior_operation_id does not match the interrupted node outcome" });
    expect(log).toEqual([]);
  });

  it("reports a planned non-mutation when the manager integration cannot durably transition", () => {
    const log: string[] = [];
    const service = new RecoveryService(campaign(log, false), new TaskSupervisor(), leases(log));
    expect(service.execute(request)).toMatchObject({ status: "planned", required_integration: "persistRetryTransition" });
    expect(log).toEqual([]);
  });

  it("requires operator/auditor abandonment and does not create terminal task or result evidence", () => {
    const log: string[] = [];
    const port: RecoveryCampaignPort = {
      ...campaign(log),
      persistAbandonment: () => { log.push("abandon"); return { ok: true }; },
    };
    const supervisor = new TaskSupervisor();
    const service = new RecoveryService(port, supervisor, leases(log, "released"));
    expect(service.execute({ ...request, action: "abandon", actor_role: "operator", idempotency_key: "abandon" })).toEqual({ status: "abandoned", operation_id: "recovery-1" });
    expect(log).toEqual(["resolve-old", "abandon"]);
    expect(supervisor.list({ include_terminal: true })).toEqual([]);
  });
});
