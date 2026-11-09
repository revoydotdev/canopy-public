import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { Action } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { ArborWebUIServer } from "../src/webui.js";

const servers: ArborWebUIServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); });

const root: Action = {
  description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
};

function request(port: number, path: string, method: "GET" | "POST", payload?: unknown, headers: Readonly<Record<string, string>> = {}): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request({
      hostname: "127.0.0.1", port, path, method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function webWithCampaign() {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("campaign", "plan.md", root);
  const server = new ArborWebUIServer(runtime);
  servers.push(server);
  await new Promise<void>((resolve) => server.start(0, resolve));
  return { runtime, port: server.getPort()! };
}

describe("D40 anonymous Web caller tier", () => {
  it("exchanges the bootstrap token once and requires the resulting opaque session for mutation authority", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("campaign", "plan.md", root);
    const server = new ArborWebUIServer(runtime, { bootstrap_token: "one-use-bootstrap", operator_session_token: "opaque-session" });
    servers.push(server);
    await new Promise<void>((resolve) => server.start(0, resolve));
    const port = server.getPort()!;

    const exchange = await request(port, "/?operator_token=one-use-bootstrap", "GET");
    expect(exchange.status).toBe(303);
    expect(exchange.headers.location).toBe("/");
    expect(exchange.headers["referrer-policy"]).toBe("no-referrer");
    expect(exchange.headers["set-cookie"]?.[0]).toBe("arbor_operator=opaque-session; HttpOnly; SameSite=Strict; Path=/");

    const replay = await request(port, "/?operator_token=one-use-bootstrap", "GET");
    expect(replay.status).toBe(403);

    const command = {
      kind: "tree.prune", campaign_id: "campaign", node_id: "root",
      metadata: {
        operation_id: "operator-session-prune", idempotency_key: "operator-session-prune:key", correlation_id: "operator-session-prune",
        actor_id: "webui-operator", requested_at: "2026-08-24T00:00:00.000Z",
      },
    };
    const forged = await request(port, "/api/runtime/command", "POST", command, { cookie: "arbor_operator=forged" });
    expect(forged.body).toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission" } } });

    const authorized = await request(port, "/api/runtime/command", "POST", {
      ...command,
      metadata: {
        ...command.metadata,
        operation_id: "authorized-operator-session-prune",
        idempotency_key: "authorized-operator-session-prune:key",
        correlation_id: "authorized-operator-session-prune",
      },
    }, { cookie: "arbor_operator=opaque-session" });
    expect(authorized.body).toMatchObject({ ok: true, value: { accepted: true } });
    expect(runtime.manager.getNodeInfo("campaign", "root")?.state).toBe("pruned");
  });

  it("refuses a durable mutation through enforceAction even when a caller supplies senior-looking fields", async () => {
    const { runtime, port } = await webWithCampaign();
    const response = await request(port, "/api/runtime/command", "POST", {
      kind: "tree.prune", campaign_id: "campaign", node_id: "root",
      // These are untrusted request text.  The transport's tier is composed
      // by the server, never selected by JSON input.
      caller_tier: "senior",
      metadata: {
        operation_id: "forged-web-tier", idempotency_key: "forged-web-tier:key", correlation_id: "forged-web-tier",
        actor_id: "forged-web-operator", requested_at: "2026-08-24T00:00:00.000Z",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission" } } });
    expect(JSON.stringify(response.body)).toContain("junior");
    expect(runtime.manager.getNodeInfo("campaign", "root")?.state).not.toBe("pruned");
  });

  it("keeps the catalog read surface usable for the same anonymous ingress", async () => {
    const { port } = await webWithCampaign();
    const response = await request(port, "/api/runtime/query", "POST", {
      kind: "campaign.list", limit: 10, caller_tier: "senior",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, capability: "campaign.read", value: { items: [expect.objectContaining({ id: "campaign" })] } });
  });

  it("does not leave the legacy interrupt convenience route as a direct-runtime bypass", async () => {
    const { runtime, port } = await webWithCampaign();
    const [child] = runtime.manager.branch("campaign", "root", [{ ...root, description: "child", delegate_to: "seed" }]);
    runtime.manager.expandNode("campaign", child!, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });

    const response = await request(port, "/api/campaigns/campaign/interrupt", "POST", {
      caller_tier: "senior", actor_id: "forged-web-operator",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(JSON.stringify(response.body)).toContain("junior");
    expect(runtime.manager.getNodeInfo("campaign", child!)?.state).toBe("expanding");
  });
});
