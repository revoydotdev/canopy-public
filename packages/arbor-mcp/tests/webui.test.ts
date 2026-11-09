import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignManager } from "../src/manager.js";
import { ArborWebUIServer } from "../src/webui.js";
import { ArborRuntime } from "../src/runtime.js";
import type { Action, ScoreContext, Provenance } from "@arbor/core";
import type { SessionEvent, SessionInspection } from "@arbor/harness";
import type { RecoveryLeaseAuthority } from "../src/recovery-service.js";
import { RepoFlightDirector } from "../src/repo-flight-director.js";

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

const refactorAction: Action = {
  description: "refactor auth module",
  estimated_gain: 50,
  estimated_cost: 10,
  category: "refactor",
  delegate_to: "seed",
};

const ctx: ScoreContext = {
  accuracy_regression_rate: 0,
  crash_regression_rate: 0,
  best_known: 100,
  total_visits: 5,
};

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"};

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: data });
      });
    }).on("error", reject);
  });
}

describe("ArborWebUIServer", () => {
  const manager = new CampaignManager();
  const persistenceDir = mkdtempSync(join(tmpdir(), "arbor-webui-"));
  const runtime = new ArborRuntime({ manager, persistence_dir: persistenceDir });
  let webui: ArborWebUIServer;
  let flightDirector: RepoFlightDirector;
  let port: number;

  beforeAll(async () => {
    // Pre-populate a campaign via the manager
    manager.startCampaign("camp-demo", "plan.md", rootAction);
    const [childId] = manager.branch("camp-demo", "root", [refactorAction]);
    manager.expandNode("camp-demo", childId, {
      worktree_isolated: true, starting_commit_correct: true, lease_acquired: true,
    });
    manager.recordResult("camp-demo", childId, {
      specialist_output: "refactored successfully, all tests pass",
      specialist_agent: "seed",
      provenance: verifiedProv,
      critic_agent: "lenticel",
      critic_approved: true,
      critic_rationale: "tests pass, code is clean",
      score_ctx: ctx,
    });

    webui = new ArborWebUIServer(runtime);
    flightDirector = new RepoFlightDirector({ repository_root: process.cwd(), persistence_dir: persistenceDir });
    await flightDirector.start();
    await new Promise<void>((resolve) => {
      webui.start(0, resolve);
    });
    port = webui.getPort()!;
    defaultOperatorHeaders = { ...webui.operatorRequestHeaders() };
  });

  afterAll(async () => {
    await webui.stop();
    await flightDirector.close();
    rmSync(persistenceDir, { recursive: true, force: true });
  });

  describe("HTML dashboard", () => {
    it("serves the index page at GET /", async () => {
      const { status, body } = await httpGet(port, "/");
      expect(status).toBe(200);
      expect(body).toContain("<!DOCTYPE html>");
      expect(body).toContain("Arbor Dashboard");
      expect(body).toContain("Native Harness");
      expect(body).toContain("Native Setup Doctor");
      expect(body).toContain("harness.native.readiness");
      expect(body).toContain("does not read credential values or probe endpoints");
      expect(body).toContain("Session policy:");
      expect(body).toContain("Native campaign budget");
      expect(body).toContain("native.budget.get");
      expect(body).toContain("durable allocation authority snapshot");
      expect(body).toContain("Harness Connectors");
      expect(body).toContain("harness.connector.inventory");
      expect(body).toContain("fallback is never presented as an upstream health check");
      expect(body).toContain("Harness session history");
      expect(body).toContain("harness.session.interrupt");
      expect(body).toContain("harness.session.events");
      expect(body).toContain("Live session");
      expect(body).toContain("harness.session.attach");
      expect(body).toContain("harness.session.steer");
      expect(body).toContain("This session is terminal. Its tail remains available, but steering is disabled.");
      expect(body).toContain('aria-live="polite"');
      expect(body).toContain("@media (max-width: 700px)");
      expect(body).toContain("session.terminal === null");
      expect(body).toContain("Controlled Overlay Evaluation");
      expect(body).toContain("may contact a configured provider");
      expect(body).toContain("durable replay and one holdout scenario");
      expect(body).not.toContain("it cannot invoke a provider");
      expect(body).toContain("harness.evaluation.runs");
      expect(body).toContain("harness.evaluation.detail");
      expect(body).toContain("unobserved until a response carries it");
      expect(body).toContain("Provider/model");
      expect(body).toContain("decodeURIComponent(\\'");
      expect(body).toContain("Governed Interviews");
      expect(body).toContain("userinput.list");
      expect(body).toContain("userinput.answer");
      expect(body).not.toContain("userinput.ask',");
      expect(body).toContain("System operations");
      expect(body).toContain("doctor.get");
      expect(body).toContain("doctor?.migration");
      expect(body).toContain("migration.preview");
      expect(body).toContain("migration.apply");
      expect(body).toContain("migration.rollback");
      expect(body).toContain("doctor?.operational");
      expect(body).toContain("integration.inspect");
      expect(body).toContain("integration.admit");
      expect(body).toContain("integration.install");
      expect(body).toContain("integration.enable");
      expect(body).toContain("integration.disable");
      expect(body).toContain("integration.update");
      expect(body).toContain("remote.control");
      expect(body).toContain("scheduler.control");
      expect(body).toContain("Filter by session, state, tag, or name");
      expect(body).toContain("Result evidence metrics");
      expect(body).toContain("result.review.workspace");
      expect(body).toContain("result.review.comment");
      expect(body).toContain("result.review.request_revision");
      expect(body).toContain("result.review.editor_handoff");
      expect(body).toContain("Side by side");
      expect(body).toContain("Conflict preview:");
      expect(body).toContain("files:selectedFiles");
      expect(body).toContain("selected-subset preflight");
      expect(body).toContain("Editor handoff with continuity");
      expect(body).toContain("window.confirm(prompt)");
      expect(body).toContain("const idJson = esc(JSON.stringify(id));");
      expect(body).toContain("inspectIntegration('+idJson+')");
      expect(body).toContain("Continuation availability");
      expect(body).toContain("harness.session.resume");
      expect(body).toContain("harness.session.fork");
      expect(body).toContain("harness.session.respawn");
      expect(body).toContain("Type '+kind.toUpperCase()+' to confirm");
      expect(body).toContain("State the governed operator disposition");
      expect(body).toContain("Live cognition topology");
      expect(body).toContain("kineticTreeMarkup");
      expect(body).toContain("Why work stopped");
      expect(body).toContain("nodeFailureSummary");
      expect(body).toContain("Describe a change in the task workspace above");
      expect(body).toContain("activeTreePath");
      expect(body).toContain("refreshSelectedCampaignDetail");
      expect(body).toContain("prefers-reduced-motion: reduce");
      expect(body).toContain('aria-label="Accessible node trajectory"');
      expect(body).toContain("node-arrive");
      expect(body).toContain("edge-reverse");
      expect(body).toContain("deepLinkedCampaign");
      expect(body).toContain("encodeURIComponent(selectedCampaignDetailId)");
      const embeddedScript = body.split("<script>")[1]?.split("</script>")[0];
      expect(embeddedScript).toBeDefined();
      expect(() => new Function(embeddedScript!)).not.toThrow();
    });

    // Audit 2026-08-23 WA-28: the scheduler Resume/Pause and remote
    // Enable/Disable buttons sent payloads the runtime validator rejected on
    // every click. Evaluate the served client-side control builders in a
    // sandbox, click every rendered button, and feed each payload through
    // the REAL validator the router applies.
    it("every remote/scheduler operation button produces a payload the runtime validator accepts", async () => {
      const { body } = await httpGet(port, "/");
      const script = body.split("<script>")[1]?.split("</script>")[0] ?? "";
      const pick = (name: string): string => {
        const start = script.indexOf(`function ${name}(`);
        expect(start, name).toBeGreaterThanOrEqual(0);
        let depth = 0; let i = script.indexOf("{", start);
        for (; i < script.length; i++) { if (script[i] === "{") depth++; else if (script[i] === "}") { depth--; if (depth === 0) break; } }
        return script.slice(start, i + 1);
      };
      const escLine = script.split("\n").find((line) => line.startsWith("const esc = "));
      const provLine = script.split("\n").find((line) => line.startsWith("const operatorProvenance = "));
      const dispatched: Array<{ kind: string; params: Record<string, unknown> }> = [];
      const clicks: string[] = [];
      const sandbox = {
        window: { confirm: () => true, prompt: () => "operator review" },
        runtimeCommand: (kind: string, params: Record<string, unknown>) => { dispatched.push({ kind, params }); return Promise.resolve({}); },
        operationStatus: () => {},
        refreshSystemOperations: () => {},
        operationButton: (_label: string, handler: string) => { clicks.push(handler); return ""; },
        JSON, String, Array, Promise,
        // Each captured `handler` is the exact text webui.ts would place
        // inside an onclick="..." HTML attribute. A real browser HTML-decodes
        // that attribute value (per the HTML5 spec) before running it as
        // script; `esc()` only ever emits these five character references, so
        // decoding just this set reproduces that step deterministically
        // without a DOM.
        decodeHtmlAttributeEntities: (value: string): string => value
          .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
      };
      const source = [escLine, provLine, pick("remoteSessionControls"), pick("scheduleControls"), pick("suspendSchedule"), pick("confirmOperation"),
        "remoteSessionControls([{session_id:'remote-1', state:'active'}]); scheduleControls([{schedule_id:'schedule-1', state:'active'}, {schedule_id:'schedule-2', state:'paused'}]);",
        "for (const handler of clicks) new Function(decodeHtmlAttributeEntities(handler))();"].join("\n");
      const vm = await import("node:vm");
      vm.runInNewContext(source, { ...sandbox, clicks });
      expect(clicks.length).toBe(3);
      expect(dispatched.map((d) => d.kind).sort()).toEqual(["remote.control", "scheduler.control", "scheduler.control"]);
      const { validateProductIntegrationCommand } = await import("../src/product-integration-contracts.js");
      for (const { kind, params } of dispatched) {
        const envelope = { schema_version: 1 as const, metadata: { operation_id: "op", idempotency_key: "op", actor_id: "webui-operator", requested_at: new Date().toISOString() }, command: { kind, ...params } };
        expect(validateProductIntegrationCommand(envelope as never), `${kind} ${JSON.stringify(params)}`).toEqual([]);
      }
    });

    // S2: a field-test QA pass on the served dashboard found raw snake_case
    // enum values ("awaiting_clarification", "connector_fallback", ...)
    // rendered verbatim instead of human copy. `badge()` and the other
    // enum-displaying call sites now route through a shared `humanizeEnum`
    // helper (underscores -> spaces) before escaping.
    it("humanizes snake_case status/state/reason enums instead of rendering the raw wire value", async () => {
      const { body } = await httpGet(port, "/");
      expect(body).toContain("const humanizeEnum = (s) => String(s ?? '').replace(/_/g, ' ');");
      expect(body).toContain("esc(humanizeEnum(s))");
      expect(body).toContain("esc(humanizeEnum(draft?.status))");
      expect(body).toContain("esc(humanizeEnum(snap.halt_reason))");
      expect(body).toContain("esc(humanizeEnum(execution.kind))");
      expect(body).toContain("esc(humanizeEnum(session.execution_kind))");
      expect(body).toContain("esc(humanizeEnum(run.state))");
    });
  });

  it("uses the injected canonical runtime identity", () => {
    expect(webui.runtime).toBe(runtime);
    expect(webui.runtime.manager).toBe(manager);
  });

  it("rejects a cross-origin browser command before it reaches the unauthenticated local catalog", async () => {
    const result = await httpPost(port, "/api/runtime/command", {
      kind: "campaign.start", campaign_id: "cross-origin-command", plan_path: "plan.md", root_action: rootAction,
      metadata: { operation_id: "cross-origin-command", idempotency_key: "cross-origin-command", correlation_id: "cross-origin-command", actor_id: "attacker", requested_at: "2030-01-01T00:00:00.000Z" },
    }, { Origin: "https://attacker.invalid" });

    expect(result).toMatchObject({ status: 403, body: expect.stringContaining("cross-origin") });
    expect(manager.getCampaignSnapshot("cross-origin-command")).toBeNull();
  });

  describe("GET /api/campaigns", () => {
    it("returns campaign list as JSON", async () => {
      const { status, body } = await httpGet(port, "/api/campaigns");
      expect(status).toBe(200);
      const data = JSON.parse(body);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].id).toBe("camp-demo");
      expect(data[0].halted).toBe(false);
      expect(data[0].total_nodes).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /api/campaigns/:id", () => {
    it("returns full campaign snapshot", async () => {
      const { status, body } = await httpGet(port, "/api/campaigns/camp-demo");
      expect(status).toBe(200);
      const data = JSON.parse(body);
      expect(data.id).toBe("camp-demo");
      expect(data.plan_path).toBe("plan.md");
      expect(Array.isArray(data.nodes)).toBe(true);
      expect(data.nodes.length).toBeGreaterThanOrEqual(1);
      const refactored = data.nodes.find((n: { action_description: string }) =>
        n.action_description === "refactor auth module",
      );
      expect(refactored).toBeDefined();
      expect(refactored.state).toBe("verified");
      expect(refactored.provenance_tag).toBe("verified");
    });

    it("returns 404 for unknown campaign", async () => {
      const { status, body } = await httpGet(port, "/api/campaigns/nonexistent");
      expect(status).toBe(404);
      const data = JSON.parse(body);
      expect(data.error).toContain("not found");
    });
  });

  describe("GET /api/campaigns/:id/kb", () => {
    it("returns KB entries for a campaign", async () => {
      const { status, body } = await httpGet(port, "/api/campaigns/camp-demo/kb");
      expect(status).toBe(200);
      const data = JSON.parse(body);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
      const successEntry = data.find((e: { value: { value: string } | null }) =>
        e.value !== null && e.value.value?.includes("refactor auth module"),
      );
      expect(successEntry).toBeDefined();
      // Verified campaign memory retains the verification provenance required
      // by the explicit cross-campaign import boundary; it is not downgraded
      // to a generated extraction wrapper.
      expect(successEntry.value.provenance.tag).toBe("verified");
    });
  });

  describe("GET /api/campaigns/:id/audit", () => {
    it("returns audit trail", async () => {
      const { status, body } = await httpGet(port, "/api/campaigns/camp-demo/audit");
      expect(status).toBe(200);
      const data = JSON.parse(body);
      expect(data).toHaveProperty("stats");
      expect(data).toHaveProperty("bypasses");
      expect(data.stats.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe("SSE endpoint", () => {
    it("establishes SSE stream and receives the initial canonical snapshot", () =>
      new Promise<void>((resolve, reject) => {
        const req = http.request(`http://localhost:${port}/api/stream`, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toContain("text/event-stream");
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
            // Once we have enough to verify the SSE frame, destroy the connection
            if (data.includes("event: snapshot") && data.includes("data: ")) {
              const dataLine = data.split("\n").find((l) => l.startsWith("data: "));
              expect(dataLine).toBeDefined();
              const parsed = JSON.parse(dataLine!.replace("data: ", ""));
              expect(parsed).toHaveProperty("cursor");
              expect(parsed.value).toHaveProperty("campaigns");
              req.destroy();
              resolve();
            }
          });
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      }), 10000);

    it("forwards canonical runtime events without polling manager state", () =>
      new Promise<void>((resolve, reject) => {
        let published = false;
        const req = http.request(`http://localhost:${port}/api/stream`, (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
            if (data.includes("event: snapshot") && !published) {
              published = true;
              runtime.eventStream.publish({
                id: "webui-event-1", occurred_at: "2026-08-01T12:00:00.000Z", correlation_id: "webui-test",
                redacted: false, event: { kind: "campaign.changed", campaign_id: "camp-demo", change: "restored" },
              });
            }
            if (data.includes("event: runtime") && data.includes("webui-event-1")) {
              req.destroy();
              resolve();
            }
          });
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      }), 10000);

    it("resumes missed runtime events from Last-Event-ID", () =>
      new Promise<void>((resolve, reject) => {
        const cursor = runtime.eventStream.cursor();
        runtime.eventStream.publish({
          id: "webui-event-resume", occurred_at: "2026-08-01T12:01:00.000Z", correlation_id: "webui-resume",
          redacted: false, event: { kind: "campaign.changed", campaign_id: "camp-demo", change: "restored" },
        });
        const req = http.request(`http://localhost:${port}/api/stream`, { headers: { "Last-Event-ID": String(cursor.sequence) } }, (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
            if (!data.includes("webui-event-resume")) return;
            try {
              expect(data).toContain("event: runtime");
              expect(data).not.toContain("event: snapshot");
              req.destroy();
              resolve();
            } catch (error) { reject(error); }
          });
          res.on("error", () => undefined);
        });
        req.on("error", () => undefined);
        req.end();
      }), 10000);

    it("4F.5: pushes the same canonical Frame as arbor://frame, via SsePainter", () =>
      new Promise<void>((resolve, reject) => {
        const req = http.request(`http://localhost:${port}/api/stream`, (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
            if (!data.includes("event: frame")) return;
            const idx = data.indexOf("event: frame");
            const after = data.slice(idx);
            const dataLine = after.split("\n").find((l) => l.startsWith("data: "));
            expect(dataLine).toBeDefined();
            const frame = JSON.parse(dataLine!.slice("data: ".length));
            expect(typeof frame.columns).toBe("number");
            expect(Array.isArray(frame.rows)).toBe(true);
            expect(frame.rows.join("\n")).toContain("camp-demo");
            req.destroy();
            resolve();
          });
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      }), 10000);

    it("releases the bounded event subscription on disconnect", () =>
      new Promise<void>((resolve, reject) => {
        let disconnected = false;
        const req = http.request(`http://localhost:${port}/api/stream`, (res) => {
          res.once("data", () => {
            expect(webui.getSSEClientCount()).toBe(1);
            disconnected = true;
            req.destroy();
            setTimeout(() => {
              try {
                expect(webui.getSSEClientCount()).toBe(0);
                resolve();
              } catch (error) { reject(error); }
            }, 20);
          });
          res.on("error", (error) => { if (!disconnected) reject(error); });
        });
        req.on("error", (error) => { if (!disconnected) reject(error); });
        req.end();
      }), 10000);
  });

  describe("manager introspection methods", () => {
    it("listCampaigns returns summary including halted state", () => {
      const list = manager.listCampaigns();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("camp-demo");
      expect(list[0].halted).toBe(false);
    });

    it("getCampaignSnapshot returns full tree", () => {
      const snap = manager.getCampaignSnapshot("camp-demo");
      expect(snap).not.toBeNull();
      expect(snap!.nodes.length).toBeGreaterThanOrEqual(1);
    });

    it("getCampaignSnapshot returns null for unknown campaign", () => {
      expect(manager.getCampaignSnapshot("ghost")).toBeNull();
    });
  });

  describe("404 for unknown routes", () => {
    it("returns 404 for unmapped paths", async () => {
      const { status, body } = await httpGet(port, "/api/unknown");
      expect(status).toBe(404);
      expect(JSON.parse(body)).toHaveProperty("error");
    });
  });

  describe("runtime catalog endpoints", () => {
    it("dispatches a campaign.list query through /api/runtime/query", async () => {
      const { status, body } = await httpPost(port, "/api/runtime/query", { kind: "campaign.list", limit: 100 });
      expect(status).toBe(200);
      const parsed = JSON.parse(body);
      expect(parsed.ok).toBe(true);
      expect(parsed.value).toBeDefined();
    });

    it("proxies repo-flight through the authenticated operator session only", async () => {
      const anonymous = await httpPost(port, "/api/repo-flight/query", { kind: "repo.flight.status" }, {});
      expect(anonymous.status).toBe(403);
      const authorized = await httpPost(port, "/api/repo-flight/query", { kind: "repo.flight.status" });
      expect(authorized.status).toBe(200);
      expect(JSON.parse(authorized.body)).toMatchObject({ ok: true, result: { ok: true, value: { deployment: { status: "observed_only" } } } });
    });

    it("dispatches the dashboard's canonical native budget query without deriving one from telemetry", async () => {
      const parsed = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "native.budget.get", campaign_id: "camp-demo" })).body);
      expect(parsed).toEqual({ ok: true, capability: "campaign.read", value: { availability: "unconfigured", campaign_id: "camp-demo" } });
    });

    it("dispatches a generic command through /api/runtime/command", async () => {
      const { status, body } = await httpPost(port, "/api/runtime/command", {
        kind: "tree.prune",
        campaign_id: "camp-demo",
        node_id: "root",
        printer_id: "webui-test",
      });
      expect(status).toBe(200);
      const parsed = JSON.parse(body);
      // The router is live: it reaches the catalog and returns a typed result.
      expect(parsed).toHaveProperty("ok");
      expect(parsed).toHaveProperty("capability");
    });

    it("submits and projects a task-composer draft only through canonical HTTP routes", async () => {
      const submitted = JSON.parse((await httpPost(port, "/api/runtime/command", {
        kind: "taskcomposer.submit",
        task: "compose a governed web task",
        source: "web",
        idempotency_key: "webui-task-draft",
        metadata: { operation_id: "webui-task-draft", idempotency_key: "webui-task-draft", correlation_id: "webui-task-draft", actor_id: "webui-operator", requested_at: "2026-08-09T00:00:00.000Z" },
      })).body);
      expect(submitted).toMatchObject({ ok: true, capability: "taskcomposer.write", value: { accepted: true, draft: { task: "compose a governed web task", source: "web", status: "failed" } } });

      const listed = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "taskcomposer.list", limit: 10 })).body);
      expect(listed).toMatchObject({ ok: true, capability: "taskcomposer.read", value: { items: [expect.objectContaining({ task: "compose a governed web task", source: "web" })] } });
    });

    it("serves the plain-language run-first workspace with human recovery narration", async () => {
      const page = await httpGet(port, "/");
      expect(page.body).toContain("What should Revoy change?");
      expect(page.body).toContain("start task");
      expect(page.body).toContain("auto_confirm:true");
      expect(page.body).toContain('id="task-composer-tier"');
      expect(page.body).toContain("tier_override:tier");
      expect(page.body).toContain("Governed - planned tree search");
      expect(page.body).toContain("selectedConnector?.health === 'healthy'");
      expect(page.body).toContain("What happens next");
      expect(page.body).not.toContain("Plan a governed task");
    });

    it("offers bounded governed image and text attachments through the task-composer command", async () => {
      const page = await httpGet(port, "/");
      expect(page.body).toContain('id="task-composer-attachments"');
      expect(page.body).toContain('accept="image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,application/json');
      expect(page.body).toContain("TASK_COMPOSER_MAX_ATTACHMENT_FILES = 4");
      expect(page.body).toContain("TASK_COMPOSER_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024");
      expect(page.body).toContain("TASK_COMPOSER_MAX_DOCUMENT_BYTES = 256 * 1024");
      expect(page.body).toContain('id="task-composer-attachment-selection"');
      expect(page.body).toContain('id="task-composer-attachment-error"');
      expect(page.body).toContain("taskComposerTier = 'governed'");
      expect(page.body).toContain("Promise.all(attachmentFiles.map((file) => encodeTaskComposerAttachment(file)))");
      expect(page.body).toContain("...(attachment_uploads.length ? {attachment_uploads} : {})");
      expect(page.body).not.toContain("/api/task-composer/attachments");
    });

    it("uses the canonical interview ledger query and answer command that the web control invokes", async () => {
      const recordId = manager.askForUserInput({
        campaign_id: "camp-demo", node_id: "root", operation_id: "webui-native-human",
        question: "Which bounded scope should proceed?", options: [{ id: "answer", text: "Provide answer", is_other: true }],
        authority: "lead", blocking: "blocking", requester_role: "seed", origin_session_id: "webui-native-session",
        idempotency_key: "webui-native-human", as_of: "2026-08-09T00:00:00.000Z",
      });
      const listed = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "userinput.list", campaign_id: "camp-demo", limit: 10 })).body);
      expect(listed).toMatchObject({ ok: true, value: { records: [expect.objectContaining({ id: recordId, question: expect.objectContaining({ origin_session_id: "webui-native-session", authority: "lead" }) })] } });
      const answered = JSON.parse((await httpPost(port, "/api/runtime/command", {
        kind: "userinput.answer", record_id: recordId,
        answer: { option_id: null, custom_text: "Use the bounded scope.", answered_by: "webui-operator", answered_at: "2026-08-09T00:00:01.000Z" },
        metadata: { operation_id: "webui-answer", idempotency_key: "webui-answer", correlation_id: "webui-answer", actor_id: "webui-operator", requested_at: "2026-08-09T00:00:01.000Z" },
      })).body);
      expect(answered).toMatchObject({ ok: true, value: { accepted: true } });
      const after = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "userinput.list", campaign_id: "camp-demo", limit: 10 })).body);
      expect(after.value.answered_record_ids).toContain(recordId);
    });

    it("separates canonical authority interviews from runtime capability faults", async () => {
      const page = await httpGet(port, "/");
      expect(page.body).toContain("isGovernedInterviewRecord");
      expect(page.body).toContain("record?.kind === 'request_user_input'");
      expect(page.body).toContain("Runtime capability issue");
      expect(page.body).toContain("No operator answer is requested for this condition.");
      expect(page.body).toContain("malformed input record was withheld from the answer flow");
      expect(page.body).toContain("interview_access_error");
      expect(page.body).toContain("This is not a new authority request.");
    });

    it("drives native status, redacted detail/events, and a session-scoped interrupt through the same web runtime routes the dashboard uses", async () => {
      const controller = new AbortController();
      const inspection: SessionInspection = {
        session_id: "webui-native-session", state: "running", latest_sequence: 1, terminal: null, ephemeral: true,
        policy: { filesystem: "read_only", approvals: "never", tool_allow: [], tool_deny: [], workspace_roots: ["/workspace"], max_wall_clock_ms: 10_000, max_events: 16, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
        capabilities: [], lineage: { kind: "new" },
      };
      const events: readonly SessionEvent[] = [{ protocol_version: "1", session_id: "webui-native-session", sequence: 1, occurred_at: "2026-08-09T00:00:00.000Z", kind: "lifecycle", payload: { state: "started", lineage: { kind: "new" }, ephemeral: true, model_identity: { provider_id: "fixture", model_id: "native-model", configured_revision: "fp-configured", revision: "fp-observed" } } }];
      runtime.nativeSessionRegistry.register({ session_id: "webui-native-session", campaign_id: "camp-demo", node_id: "root", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", controller, inspect: () => inspection, events: (after = 0) => events.filter((event) => event.sequence > after) });

      const config = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "config.get" })).body);
      expect(config.ok).toBe(true);
      expect(config.value).toHaveProperty("native_selection");
      const listed = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "harness.session.list", limit: 20 })).body);
      expect(listed).toMatchObject({ ok: true, value: { sessions: [expect.objectContaining({ session_id: "webui-native-session", profile_id: "architect", execution_kind: "direct_native", model_identity: { provider_id: "fixture", model_id: "native-model", configured_revision: "fp-configured", revision: "fp-observed" }, recovery: { kind: "not_required" } })] } });
      const detail = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "harness.session.inspect", session_id: "webui-native-session" })).body);
      expect(detail).toMatchObject({ ok: true, value: { session_id: "webui-native-session", profile_id: "architect", model_identity: { provider_id: "fixture", model_id: "native-model", configured_revision: "fp-configured", revision: "fp-observed" }, recovery: { kind: "not_required" } } });
      const eventView = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "harness.session.events", session_id: "webui-native-session", limit: 20 })).body);
      expect(eventView).toMatchObject({ ok: true, value: { events: [{ payload: { model_identity: { provider_id: "fixture", model_id: "native-model", configured_revision: "fp-configured", revision: "fp-observed" } } }] } });

      const attached = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "harness.session.attach", session_id: "webui-native-session", after_sequence: 0, limit: 20 })).body);
      expect(attached).toMatchObject({ ok: true, capability: "harness.session.read", value: { live: true, pending_steering: 0, next_after_sequence: 1, session: { session_id: "webui-native-session" }, events: [{ sequence: 1 }] } });
      const steered = JSON.parse((await httpPost(port, "/api/runtime/command", {
        kind: "harness.session.steer", session_id: "webui-native-session", message: "Use the bounded web-session scope.",
        provenance: { tag: "claimed", claimant: "webui-operator" },
        metadata: { operation_id: "webui-native-steer", idempotency_key: "webui-native-steer", correlation_id: "webui-native-steer", actor_id: "webui-operator", requested_at: "2026-08-09T00:00:00.000Z" },
      })).body);
      expect(steered).toMatchObject({ ok: true, capability: "harness.session.write", value: { accepted: true, operation_id: "webui-native-steer" } });
      const queued = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "harness.session.attach", session_id: "webui-native-session", after_sequence: 1, limit: 20 })).body);
      expect(queued).toMatchObject({ ok: true, value: { live: true, pending_steering: 1, events: [] } });

      const interrupted = JSON.parse((await httpPost(port, "/api/runtime/command", {
        kind: "harness.session.interrupt", session_id: "webui-native-session", reason: "web UI operator stop",
        provenance: { tag: "generated", generator: "webui-test", input_hash: "webui-native-session" },
        metadata: { operation_id: "webui-native-stop", idempotency_key: "webui-native-stop", correlation_id: "webui-native-stop", actor_id: "webui-operator", requested_at: "2026-08-09T00:00:00.000Z" },
      })).body);
      expect(interrupted).toMatchObject({ ok: true, value: { accepted: true } });
      expect(controller.signal.aborted).toBe(true);
      const terminalSteer = JSON.parse((await httpPost(port, "/api/runtime/command", {
        kind: "harness.session.steer", session_id: "webui-native-session", message: "This must not be queued.",
        provenance: { tag: "claimed", claimant: "webui-operator" },
        metadata: { operation_id: "webui-native-steer-terminal", idempotency_key: "webui-native-steer-terminal", correlation_id: "webui-native-steer-terminal", actor_id: "webui-operator", requested_at: "2026-08-09T00:00:01.000Z" },
      })).body);
      expect(terminalSteer).toMatchObject({ ok: false, capability: "harness.session.write", error: { code: "conflict" } });
    });

    it("round-trips measured evaluation status/detail and a multi-evidence quarantine through the exact web catalog routes", async () => {
      const messageKey = `webui-evaluation-message-${Date.now()}`;
      manager.recordBusMessage({ campaign_id: "camp-demo", node_id: "root", author_node_id: "root", recipient_node_id: "child", other_recipient_node_ids: [], kind: "delegate", payload: { content: "bounded evaluation source", provenance: { tag: "claimed", claimant: "seed" } }, capability_tier: "specialist", trigger_turn: false, as_of: "2030-01-01T00:00:00.000Z", correlation_id: messageKey, idempotency_key: messageKey, acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "webui-evaluation" });
      const source = manager.getAuditRecords("camp-demo").filter((record) => record.kind === "node_communication").at(-1); if (!source) throw new Error("missing durable evaluation source");
      const revisionId = `webui-evaluation-${Date.now()}`;
      runtime.governedContext.proposeRevision({ id: revisionId, campaign_id: "camp-demo", task_id: "webui-evaluation", component: "supplemental_prompt", patch: { guidance: "bounded" }, source_event_ids: [source.id], source_message_ranges: [{ context_id: "webui-evaluation", thread_id: "root", start_communication_id: source.id, end_communication_id: source.id, start_byte: 0, end_byte: 1 }], expected_benefit: "test canonical UI route", proposed_by: "seed", provenance: { tag: "claimed", claimant: "seed" }, created_at: "2030-01-01T00:00:00.000Z", expires_at: "2031-01-01T00:00:00.000Z" });
      runtime.governedContext.approveRevision(revisionId, "lenticel");
      const run = runtime.governedContext.startEvaluation({ id: `run:${revisionId}`, revision_id: revisionId, requested_by: "webui-requester", evaluator_id: "webui-hermetic" });
      const evidence = (["replay", "holdout"] as const).map((partition) => { const content = JSON.stringify({ schema_version: 1, evaluation_run_id: run.id, revision_id: revisionId, scenario_id: `webui <${partition}> & \"quoted\"`, partition }); return runtime.governedContext.captureArtifact({ campaign_id: "camp-demo", media_type: "application/vnd.arbor.overlay-evaluation+json", producer: "arbor-eval/governed-overlay", visibility: "critic_only", provenance: { tag: "generated", generator: "arbor-eval/governed-overlay", input_hash: `sha256:${partition}:${revisionId}:${run.id}` }, content }); });
      runtime.governedContext.settleEvaluation(run.id, { kind: "measured", evidence_ids: evidence.map((item) => item.id), evaluation: { outcome: "regressed", fidelity_ratio: 1, main_model_tokens: 1, child_model_tokens: 1, latency_ms: 1, regression_detected: true, rollback_count: 0, replay_evidence_ids: [evidence[0]!.id], holdout_evidence_ids: [evidence[1]!.id] }, detail: [{ summary: "redacted <detail> & quote \"" }] });
      const listed = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "harness.evaluation.runs", campaign_id: "camp-demo" })).body);
      expect(listed).toMatchObject({ ok: true, value: [expect.objectContaining({ id: run.id, revision_id: revisionId, evidence_ids: evidence.map((item) => item.id) })] });
      const detail = JSON.parse((await httpPost(port, "/api/runtime/query", { kind: "harness.evaluation.detail", run_id: run.id })).body);
      expect(detail).toMatchObject({ ok: true, value: { id: run.id, detail: [{ summary: "redacted <detail> & quote \"" }] } });
      const quarantined = JSON.parse((await httpPost(port, "/api/runtime/command", { kind: "harness.quarantine", revision_id: revisionId, reason: "observed <script> & \"quotes\"", evidence_ids: evidence.map((item) => item.id), metadata: { operation_id: `webui-quarantine:${revisionId}`, idempotency_key: `webui-quarantine:${revisionId}`, correlation_id: `webui-quarantine:${revisionId}`, actor_id: "webui-operator", requested_at: "2030-01-01T00:00:01.000Z" } })).body);
      expect(quarantined).toMatchObject({ ok: true, value: { accepted: true } });
      expect(runtime.governedContext.getRevision(revisionId)).toMatchObject({ status: "quarantined", quarantine: { reason: "observed <script> & \"quotes\"", evidence_ids: evidence.map((item) => item.id) } });
    });

    it("rejects malformed command with a structured result", async () => {
      const { status, body } = await httpPost(port, "/api/runtime/command", { kind: "nope" });
      expect(status).toBe(200);
      const parsed = JSON.parse(body);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBeDefined();
    });

    it("GET /api/runtime/query with real query-string params dispatches the same as a POST body (readQueryParams)", async () => {
      // agent.list takes no params, so a bare `?kind=` round-trips cleanly —
      // readQueryParams's string-only decoding (query strings have no
      // number/boolean type) is exercised without a param-type mismatch.
      const { status, body } = await httpGet(port, "/api/runtime/query?kind=agent.list");
      expect(status).toBe(200);
      const parsed = JSON.parse(body);
      expect(parsed.ok).toBe(true);
      expect(parsed.value).toBeDefined();
    });

    it("GET /api/runtime/query with no query string at all still dispatches — readQueryParams returns an empty object, not a throw", async () => {
      const { status, body } = await httpGet(port, "/api/runtime/query");
      expect(status).toBe(200);
      const parsed = JSON.parse(body);
      // No `kind` at all — the catalog rejects it as a structured failure, not a 500.
      expect(parsed.ok).toBe(false);
    });

    it("GET /api/campaigns/:id/interrupt lists the currently interruptible nodes for a real campaign", async () => {
      const { status, body } = await httpGet(port, "/api/campaigns/camp-demo/interrupt");
      expect(status).toBe(200);
      const parsed = JSON.parse(body);
      expect(parsed.campaign_id).toBe("camp-demo");
      expect(Array.isArray(parsed.interruptible_node_ids)).toBe(true);
    });

    it("GET /api/campaigns/:id/interrupt for an unknown campaign returns a real 404", async () => {
      const { status, body } = await httpGet(port, "/api/campaigns/does-not-exist/interrupt");
      expect(status).toBe(404);
      expect(JSON.parse(body)).toHaveProperty("error");
    });

    it("POST /api/campaigns/:id/interrupt with no node_id sweeps every expanding/pending node — an already-quiesced campaign affects nothing but still succeeds", async () => {
      const { status, body } = await httpPost(port, "/api/campaigns/camp-demo/interrupt", {});
      expect(status).toBe(200);
      const parsed = JSON.parse(body);
      expect(parsed.ok).toBe(true);
      expect(parsed.affected_node_ids).toEqual([]);
    });

    it("POST /api/campaigns/:id/interrupt sweeps and interrupts a real expanding node when one exists", async () => {
      const localManager = new CampaignManager();
      const localRuntime = new ArborRuntime({ manager: localManager });
      const localWebui = new ArborWebUIServer(localRuntime);
      await new Promise<void>((resolve) => localWebui.start(0, resolve));
      const localPort = localWebui.getPort()!;
      try {
        localManager.startCampaign("camp-interrupt", "plan.md", rootAction);
        const [childId] = localManager.branch("camp-interrupt", "root", [refactorAction]);
        localManager.expandNode("camp-interrupt", childId, {
          worktree_isolated: true, starting_commit_correct: true, lease_acquired: true,
        });
        const res = await httpPost(localPort, "/api/campaigns/camp-interrupt/interrupt", {}, { ...localWebui.operatorRequestHeaders() });
        expect(res.status, res.body).toBe(202);
        const parsed = JSON.parse(res.body);
        expect(parsed.ok).toBe(true);
        expect(parsed.affected_node_ids.length).toBeGreaterThan(0);
      } finally {
        await localWebui.stop();
      }
    });

    it("POST /api/campaigns/:id/interrupt with an explicit node_id interrupts just that node", async () => {
      const localManager = new CampaignManager();
      const localRuntime = new ArborRuntime({ manager: localManager });
      const localWebui = new ArborWebUIServer(localRuntime);
      await new Promise<void>((resolve) => localWebui.start(0, resolve));
      const localPort = localWebui.getPort()!;
      try {
        localManager.startCampaign("camp-interrupt-2", "plan.md", rootAction);
        const [childId] = localManager.branch("camp-interrupt-2", "root", [refactorAction]);
        localManager.expandNode("camp-interrupt-2", childId, {
          worktree_isolated: true, starting_commit_correct: true, lease_acquired: true,
        });
        const res = await httpPost(localPort, "/api/campaigns/camp-interrupt-2/interrupt", { node_id: childId, reason: "webui-test" }, { ...localWebui.operatorRequestHeaders() });
        expect(res.status, res.body).toBe(202);
        const parsed = JSON.parse(res.body);
        expect(parsed.ok).toBe(true);
        expect(parsed.affected_node_ids).toContain(childId);
      } finally {
        await localWebui.stop();
      }
    });

    it("POST /api/campaigns/:id/interrupt with an invalid JSON body answers 400 (client error), not a hang", async () => {
      const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { hostname: "localhost", port, path: "/api/campaigns/camp-demo/interrupt", method: "POST", headers: { "Content-Type": "application/json" } },
          (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
          },
        );
        req.on("error", reject);
        req.write("not valid json {{{");
        req.end();
      });
      expect(raw.status).toBe(400);
      expect(JSON.parse(raw.body)).toHaveProperty("error");
    });

    // Audit 2026-08-23 WA-22/WA-23: an unknown campaign used to answer 500
    // with a stringified exception on /kb and 200 with all-zero stats on
    // /audit and /telemetry — absence rendered as zero.
    it("answers 404 for every sub-resource of a campaign that does not exist", async () => {
      for (const sub of ["kb", "audit", "telemetry"]) {
        const response = await fetch(`http://localhost:${port}/api/campaigns/does-not-exist/${sub}`);
        expect(response.status, sub).toBe(404);
        const body = await response.json() as { error?: unknown; stats?: unknown };
        expect(typeof body.error, sub).toBe("string");
        expect(body).not.toHaveProperty("stats");
      }
    });

    // loadDetail()'s api() promises had no .catch(): a 404 on a stale/deep-linked
    // campaign id silently left whatever was previously rendered in the detail
    // panes, instead of surfacing the not-found state honestly. Drive the SAME
    // served client function against the real server (WA-28/C-03 vm-sandbox
    // pattern) with a real 404 (does-not-exist is never seeded here).
    it("loadDetail() renders 'not found' in the detail/KB/audit panes for a campaign that does not exist, instead of leaving them silently unchanged", async () => {
      const { body } = await httpGet(port, "/");
      const script = body.split("<script>")[1]?.split("</script>")[0] ?? "";
      const pick = (name: string): string => {
        const start = script.indexOf(`function ${name}(`);
        expect(start, name).toBeGreaterThanOrEqual(0);
        let depth = 0; let i = script.indexOf("{", start);
        for (; i < script.length; i++) { if (script[i] === "{") depth++; else if (script[i] === "}") { depth--; if (depth === 0) break; } }
        return script.slice(start, i + 1);
      };
      const constLine = (name: string): string => {
        const line = script.split("\n").find((l) => l.startsWith(`const ${name} = `) || l.startsWith(`let ${name} = `));
        expect(line, name).toBeDefined();
        return line!;
      };
      const elements = new Map<string, { innerHTML: string; classList: { remove: () => void } }>();
      const getElementById = (id: string) => {
        if (!elements.has(id)) elements.set(id, { innerHTML: "", classList: { remove: () => {} } });
        return elements.get(id)!;
      };
      const sandbox = {
        document: { getElementById },
        fetch: (...args: Parameters<typeof fetch>) => fetch(`http://127.0.0.1:${port}${String(args[0])}`, args[1]),
        JSON, String, Array, Promise, console,
        refreshOperatorReadPanels: () => {},
        renderCampaignDetail: () => {},
      };
      const source = [constLine("api"), constLine("esc"), pick("loadDetail"), "loadDetail('does-not-exist');"].join("\n");
      const vm = await import("node:vm");
      vm.createContext(sandbox);
      vm.runInContext(source, sandbox);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(getElementById("detail").innerHTML).toContain("Campaign not found.");
      expect(getElementById("detail-kb").innerHTML).toContain("Campaign not found.");
      expect(getElementById("detail-audit").innerHTML).toContain("Campaign not found.");
    });

    it("exposes a ledger-derived telemetry projection at /api/campaigns/:id/telemetry", async () => {
      const witness = manager.getLatestEvidenceId("camp-demo")!;
      manager.recordTelemetryObservation({
        campaign_id: "camp-demo", node_id: "root", operation_id: "webui-proj:1", epoch: 1,
        type: "phase_timing", phase: "select", outcome: "success", duration_ms: 5,
        source_evidence_id: witness, idempotency_key: "webui-proj:phase:1",
        provenance: { tag: "generated", generator: "test", input_hash: "h" },
      });
      const { status, body } = await httpGet(port, "/api/campaigns/camp-demo/telemetry");
      expect(status).toBe(200);
      const parsed = JSON.parse(body);
      expect(parsed.campaign_id).toBe("camp-demo");
      expect(parsed.source_record_count).toBeGreaterThan(0);
      expect(parsed.phase_histograms).toBeDefined();
      expect(parsed.counters).toBeDefined();
    });
  });
});

let defaultOperatorHeaders: Record<string, string> = {};
function httpPost(port: number, path: string, payload: unknown, extraHeaders: Record<string, string> = defaultOperatorHeaders): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: "127.0.0.1", port, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...extraHeaders },
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

describe("ArborWebUIServer recovery wiring (G-03)", () => {
  it("leaves recovery unavailable through /api/runtime/command when the runtime has no recoveryService", async () => {
    const webui = new ArborWebUIServer(new ArborRuntime());
    await new Promise<void>((resolve) => webui.start(0, resolve));
    try {
      const port = webui.getPort()!;
      const { status, body } = await httpPost(port, "/api/runtime/command", recoveryRetryCommand("root"), { ...webui.operatorRequestHeaders() });
      expect(status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({ ok: true, value: { accepted: false, error: { code: "unavailable" } } });
    } finally { await webui.stop(); }
  });

  it("reaches the real RecoveryService over HTTP once runtime.recoveryService is wired", async () => {
    const manager = new CampaignManager();
    const leases: RecoveryLeaseAuthority = {
      resolveOldLease: () => "inactive",
      acquireFresh: () => ({ ok: true, lease_id: "fresh-lease" }),
      checkIsolation: () => ({ worktree_isolated: true, starting_commit_correct: true }),
      releaseFresh: () => {},
    };
    manager.startCampaign("campaign", "plan.md", rootAction);
    const [node] = manager.branch("campaign", "root", [rootAction]);
    const runtime = new ArborRuntime({ manager, recovery_leases: leases });
    const webui = new ArborWebUIServer(runtime);
    await new Promise<void>((resolve) => webui.start(0, resolve));
    try {
      const port = webui.getPort()!;
      const { status, body } = await httpPost(port, "/api/runtime/command", recoveryRetryCommand(node, manager.getCampaignVersion("campaign")), { ...webui.operatorRequestHeaders() });
      expect(status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({ ok: true, value: { accepted: true, recovery: { status: "ready" } } });
      expect(manager.getNodeInfo("campaign", node)?.state).toBe("pending");
    } finally { await webui.stop(); }
  });
});

function recoveryRetryCommand(nodeId: string, expectedVersion = "revision-1") {
  return {
    schema_version: 1 as const,
    metadata: {
      operation_id: "recover-op", idempotency_key: "recover-key", correlation_id: "corr-1",
      actor_id: "crown-agent", requested_at: "2026-08-04T00:00:00.000Z", expected_version: expectedVersion,
    },
    command: {
      kind: "recovery.retry" as const, campaign_id: "campaign", node_id: nodeId, prior_operation_id: "crashed-op",
      reason: "process crashed mid-expansion",
      lease: { lease_id: "stale-lease", worktree_id: "stale-worktree", expires_at: "2026-08-05T00:00:00.000Z" },
    },
  };
}
