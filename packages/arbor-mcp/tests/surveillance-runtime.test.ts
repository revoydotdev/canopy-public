import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskSupervisor, type Action } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const root: Action = { description: "root", category: "plan", delegate_to: "seed", estimated_gain: 1, estimated_cost: 1 };
const metadata = (operation_id: string, idempotency_key = operation_id) => ({ operation_id, idempotency_key, correlation_id: "corr", actor_id: "operator", requested_at: "2026-08-01T12:00:00.000Z" });
const scan = (operation = "scan-1") => ({ schema_version: 1, metadata: metadata(operation), command: { kind: "surveillance.scan", campaign_id: "campaign", as_of: "2026-08-01T12:00:00.000Z" } });
const query = (limit = 10) => ({ schema_version: 1, query_id: "query-1", query: { kind: "surveillance.findings", campaign_id: "campaign", limit } });

describe("runtime surveillance composition", () => {
  it("uses canonical manager/supervisor facts and publishes only after durable dedup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-surveillance-runtime-")); directories.push(directory);
    const manager = new CampaignManager({ persistence_dir: directory });
    manager.startCampaign("campaign", "PLAN.md", root);
    const supervisor = new TaskSupervisor();
    supervisor.register({ id: "ghost", operation_id: "work", kind: "node_expansion:ghost", owner_scope_id: "campaign" });
    supervisor.start("ghost");
    const runtime = new ArborRuntime({ manager, supervisor, persistence_dir: directory });
    const events: string[] = [];
    runtime.subscribeSurveillance((event) => events.push(event.dedup_key));
    const router = new RuntimeCatalogRouter(runtime);

    expect(await router.dispatchCommand(scan())).toMatchObject({ ok: true, value: { accepted: true, newly_recorded_count: 1 }, capability: "surveillance.scan" });
    expect(await router.dispatchCommand(scan())).toMatchObject({ ok: true, value: { accepted: true } });
    expect(events).toHaveLength(1);
    expect(router.executeQuery(query())).toMatchObject({ ok: true, value: { findings: [expect.objectContaining({ kind: "orphaned_work" })] } });
    expect(manager.getCampaignSnapshot("campaign")?.nodes).toHaveLength(1);
  });

  it("restores dedup and query state without replaying finding events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-surveillance-restart-")); directories.push(directory);
    const manager = new CampaignManager({ persistence_dir: directory });
    manager.startCampaign("campaign", "PLAN.md", root);
    const supervisor = new TaskSupervisor();
    supervisor.register({ id: "ghost", operation_id: "work", kind: "node_expansion:ghost", owner_scope_id: "campaign" }); supervisor.start("ghost");
    await new RuntimeCatalogRouter(new ArborRuntime({ manager, supervisor, persistence_dir: directory })).dispatchCommand(scan());

    const restarted = new ArborRuntime({ manager: new CampaignManager({ persistence_dir: directory }), supervisor, persistence_dir: directory });
    const events: string[] = []; restarted.subscribeSurveillance((event) => events.push(event.dedup_key));
    expect(await new RuntimeCatalogRouter(restarted).dispatchCommand(scan("scan-2"))).toMatchObject({ ok: true, value: { newly_recorded_count: 0 } });
    expect(restarted.surveillance.query("campaign", 10)).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("enforces scan and read capabilities and validates bounded limits", async () => {
    const manager = new CampaignManager(); manager.startCampaign("campaign", "PLAN.md", root);
    const runtime = new ArborRuntime({ manager });
    expect(await new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["surveillance.read"]) }).dispatchCommand(scan())).toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission" } } });
    expect(new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["surveillance.scan"]) }).executeQuery(query())).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(new RuntimeCatalogRouter(runtime).executeQuery(query(1025))).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await new RuntimeCatalogRouter(runtime).dispatchCommand({ ...scan(), metadata: { ...metadata("bad"), actor_id: "" } })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("runs scans at successful mutating-command durability boundaries without timers", async () => {
    const manager = new CampaignManager(); manager.startCampaign("campaign", "PLAN.md", root);
    let projections = 0;
    const runtime = new ArborRuntime({ manager, surveillance: new (class {
      scan(_campaign: string, asOf = "2026-08-01T12:00:00.000Z") { projections += 1; return { campaign_id: "campaign", scanned_at: asOf, findings: [], newly_recorded: [] }; }
      query() { return []; }
    })() as unknown as ArborRuntime["surveillance"] });
    const router = new RuntimeCatalogRouter(runtime);
    await router.dispatchCommand({ schema_version: 1, metadata: metadata("branch"), command: { kind: "tree.branch", campaign_id: "campaign", node_id: manager.getCampaignSnapshot("campaign")!.root_id, actions: [root] } });
    expect(projections).toBe(1);
  });
});
