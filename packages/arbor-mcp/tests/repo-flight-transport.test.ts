import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoFlightOperatorService } from "../src/repo-flight-operator.js";
import { RepoFlightClient, RepoFlightTransportServer, type RepoFlightWireResponse } from "../src/repo-flight-transport.js";

const directories: string[] = [];
const controllers: RepoFlightTransportServer[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory(): string { const value = mkdtempSync(join(tmpdir(), "repo-flight-transport-")); directories.push(value); return value; }

const agentId = `agent:v1:${"a".repeat(64)}`;
const otherAgentId = `agent:v1:${"b".repeat(64)}`;
const operatorActor = "human:flight-director";
const now = () => new Date("2026-08-28T14:00:00.000Z");
const metadata = { operation_id: "transport-operation:1", idempotency_key: "operator-command:1", correlation_id: "transport-correlation:1", actor_id: agentId, requested_at: now().toISOString() };
const statusQuery = { schema_version: 1 as const, query_id: "transport-status:1", query: { kind: "repo.flight.status" as const } };
const agentBinding = (instanceId: string) => instanceId === agentId ? { instance_id: agentId, repository_id: `repo:v1:${"c".repeat(64)}`, repo_run_id: "run:agent", provider_session_ref: "provider:agent", process_identity_ref: "process:agent", revocation_epoch: 1, active: true } : null;

function fakeOperator() {
  return {
    executeQuery: vi.fn((input: any) => {
      if (input.query.kind === "repo.flight.sessions") return { ok: true, capability: "repo.flight.read", value: [{ instance_id: agentId }, { instance_id: otherAgentId }] };
      if (input.query.kind === "repo.flight.deliveries") return { ok: true, capability: "repo.flight.read", value: [{ delivery_id: "d1", target_instance_id: agentId }, { delivery_id: "d2", target_instance_id: otherAgentId }] };
      return { ok: true, capability: "repo.flight.read", value: { status: "ready" } };
    }),
    executeCommand: vi.fn(() => ({ ok: true, capability: "repo.flight.write", value: { accepted: true, operation_id: "transport-operation:1", projection: { state: "acknowledged", protected_token: "must-not-return" } } })),
  };
}

async function setup(timeoutMs = 500) {
  const root = directory(), operator = fakeOperator();
  const controller = new RepoFlightTransportServer({ persistence_dir: root, operator: operator as unknown as RepoFlightOperatorService, authenticated_operator_actor: operatorActor, agent_credential_binding: agentBinding, now, max_frame_bytes: 4096 });
  controllers.push(controller); await controller.start();
  const operatorClient = new RepoFlightClient({ socket_path: controller.socket_path, credential_path: controller.operator_credential_path, now, max_frame_bytes: 4096, timeout_ms: timeoutMs });
  const agentCredential = controller.provisionAgentCredential(agentId);
  const agentClient = new RepoFlightClient({ socket_path: controller.socket_path, credential_path: agentCredential, now, max_frame_bytes: 4096, timeout_ms: timeoutMs });
  return { root, operator, controller, operatorClient, agentClient, agentCredential };
}

describe("RepoFlightTransportServer", () => {
  it("elects one owner and creates private socket and credential files", async () => {
    const { root, controller, agentCredential } = await setup();
    expect(statSync(join(root, "repo-flight-transport")).mode & 0o777).toBe(0o700);
    expect(statSync(controller.socket_path).mode & 0o777).toBe(0o600);
    expect(statSync(controller.operator_credential_path).mode & 0o777).toBe(0o600);
    expect(statSync(agentCredential).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(agentCredential, "utf8"))).toMatchObject({ version: 2, instance_id: agentId, repo_run_id: "run:agent", operations: ["query.self", "session.drain", "delivery.receipt"], revocation_epoch: 1 });
    expect(() => new RepoFlightTransportServer({ persistence_dir: root, operator: fakeOperator() as unknown as RepoFlightOperatorService, authenticated_operator_actor: operatorActor, now })).toThrow("controller unavailable");
  });

  it("serves concurrent authenticated clients without crossing responses", async () => {
    // Draining 20 concurrent socket round trips takes ~800ms, so the shared
    // 500ms client deadline would fail this on throughput, not correctness.
    const { operatorClient, operator } = await setup(5_000);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => operatorClient.query({ ...statusQuery, query_id: `status:${index}` }, `status-idem:${index}`, `nonce:${index}`)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.request_id)).size).toBe(20);
    expect(operator.executeQuery).toHaveBeenCalledTimes(20);
  });

  it("rejects nonce replay and makes idempotent retry non-executing across restart", async () => {
    const { root, controller, operatorClient, operator } = await setup();
    expect(await operatorClient.query(statusQuery, "status-once", "nonce-once")).toMatchObject({ ok: true });
    expect(await operatorClient.query(statusQuery, "status-once", "nonce-once")).toMatchObject({ ok: false, error: { code: "replay" } });
    expect(await operatorClient.query(statusQuery, "status-once", "nonce-twice")).toMatchObject({ ok: true });
    expect(operator.executeQuery).toHaveBeenCalledTimes(1);

    await controller.close(); controllers.splice(controllers.indexOf(controller), 1);
    const restartedOperator = fakeOperator();
    const restarted = new RepoFlightTransportServer({ persistence_dir: root, operator: restartedOperator as unknown as RepoFlightOperatorService, authenticated_operator_actor: operatorActor, now, max_frame_bytes: 4096 });
    controllers.push(restarted); await restarted.start();
    const client = new RepoFlightClient({ socket_path: restarted.socket_path, credential_path: restarted.operator_credential_path, now, max_frame_bytes: 4096, timeout_ms: 500 });
    expect(await client.query(statusQuery, "status-once", "nonce-after-restart")).toMatchObject({ ok: true });
    expect(restartedOperator.executeQuery).not.toHaveBeenCalled();
  });

  it("enforces enrolled-agent scope and filters agent projections", async () => {
    const { agentClient, operator } = await setup();
    const sessions = await agentClient.query({ schema_version: 1, query_id: "sessions:1", query: { kind: "repo.flight.sessions" } }, "sessions:1", "nonce:sessions");
    expect(sessions).toMatchObject({ ok: true, result: { value: [{ instance_id: agentId }] } });
    const deniedQuery = await agentClient.query({ schema_version: 1, query_id: "clearances:1", query: { kind: "repo.flight.clearances" } }, "clearances:1", "nonce:clearances");
    expect(deniedQuery).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(await agentClient.query(statusQuery, "agent-status:1", "nonce:agent-status")).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(await agentClient.query({ schema_version: 1, query_id: "profile:1", query: { kind: "repo.flight.profile" } }, "agent-profile:1", "nonce:agent-profile")).toMatchObject({ ok: false, error: { code: "unauthorized" } });

    const applied = { schema_version: 1, metadata, command: { kind: "repo.flight.delivery.transition", request: { event_id: "e1", idempotency_key: "e1", occurred_at: now().toISOString(), delivery_id: "d1", expected_state: "acknowledged", to: "applied", actor_instance_id: agentId } } };
    expect(await agentClient.command(applied, "applied:1", "nonce:applied")).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    const acknowledged = { ...applied, command: { ...applied.command, request: { ...applied.command.request, expected_state: "delivered", to: "acknowledged" } } };
    expect(await agentClient.command(acknowledged, "ack:1", "nonce:ack")).toMatchObject({ ok: true });
    expect(operator.executeCommand).toHaveBeenCalledTimes(1);
    expect(operator.executeCommand).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ actor_id: agentId }) }));
  });

  it("revokes an agent credential immediately when its current repository binding changes", async () => {
    const root = directory(), operator = fakeOperator();
    let current = agentBinding(agentId);
    const controller = new RepoFlightTransportServer({ persistence_dir: root, operator: operator as unknown as RepoFlightOperatorService, authenticated_operator_actor: operatorActor, agent_credential_binding: () => current, now, max_frame_bytes: 4096 });
    controllers.push(controller); await controller.start();
    const credential = controller.provisionAgentCredential(agentId);
    const client = new RepoFlightClient({ socket_path: controller.socket_path, credential_path: credential, now, max_frame_bytes: 4096, timeout_ms: 500 });
    current = { ...current!, repository_id: `repo:v1:${"d".repeat(64)}` };
    expect(await client.query({ schema_version: 1, query_id: "sessions:cross-repo", query: { kind: "repo.flight.sessions" } }, "sessions:cross-repo", "nonce:cross-repo")).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(operator.executeQuery).not.toHaveBeenCalled();
  });

  it("binds operator commands to the authenticated credential actor", async () => {
    const { operatorClient, operator } = await setup();
    const command = { schema_version: 1, metadata, command: { kind: "repo.flight.clearance.request", request: { request_id: "actor-binding:1" } } };
    expect(await operatorClient.command(command, "actor-binding:1", "nonce:actor-binding")).toMatchObject({ ok: true });
    expect(operator.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ actor_id: operatorActor }) }));
  });

  it("preserves an interrupted executing checkpoint as indeterminate across restart", async () => {
    class InterruptingTransportServer extends RepoFlightTransportServer {
      protected override afterExecutionCheckpoint(): void { throw new Error("simulated process interruption"); }
    }
    const root = directory(), interruptedOperator = fakeOperator();
    const interrupted = new InterruptingTransportServer({ persistence_dir: root, operator: interruptedOperator as unknown as RepoFlightOperatorService, authenticated_operator_actor: operatorActor, now, max_frame_bytes: 4096 });
    controllers.push(interrupted); await interrupted.start();
    const client = new RepoFlightClient({ socket_path: interrupted.socket_path, credential_path: interrupted.operator_credential_path, now, max_frame_bytes: 4096, timeout_ms: 100 });
    expect(await client.query(statusQuery, "interrupted:1", "nonce:interrupted-before")).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(interruptedOperator.executeQuery).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "repo-flight-transport", "replay.json"), "utf8")).toContain('"phase":"executing"');

    await interrupted.close(); controllers.splice(controllers.indexOf(interrupted), 1);
    const restartedOperator = fakeOperator();
    const restarted = new RepoFlightTransportServer({ persistence_dir: root, operator: restartedOperator as unknown as RepoFlightOperatorService, authenticated_operator_actor: operatorActor, now, max_frame_bytes: 4096 });
    controllers.push(restarted); await restarted.start();
    const retry = new RepoFlightClient({ socket_path: restarted.socket_path, credential_path: restarted.operator_credential_path, now, max_frame_bytes: 4096, timeout_ms: 500 });
    expect(await retry.query(statusQuery, "interrupted:1", "nonce:interrupted-after")).toMatchObject({ ok: false, error: { code: "indeterminate" } });
    expect(restartedOperator.executeQuery).not.toHaveBeenCalled();
  });

  it("rejects malformed, multiple, and oversized frames", async () => {
    const { controller } = await setup();
    expect(await raw(controller.socket_path, "not-json\n")).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await raw(controller.socket_path, "{}\n{}\n")).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await raw(controller.socket_path, `${"x".repeat(5000)}\n`)).toMatchObject({ ok: false, error: { code: "oversized" } });
  });

  it("returns explicit unavailable and timeout outcomes", async () => {
    const root = directory();
    const unavailableCredentialRoot = directory();
    const credentialController = new RepoFlightTransportServer({ persistence_dir: unavailableCredentialRoot, operator: fakeOperator() as unknown as RepoFlightOperatorService, authenticated_operator_actor: operatorActor, now }); controllers.push(credentialController);
    const unavailable = new RepoFlightClient({ socket_path: join(root, "missing.sock"), credential_path: credentialController.operator_credential_path, now, timeout_ms: 50 });
    expect(await unavailable.query(statusQuery)).toMatchObject({ ok: false, error: { code: "unavailable" } });

    const socketPath = join(root, "silent.sock");
    const silent = createServer((socket) => setTimeout(() => socket.destroy(), 100)); servers.push(silent); await new Promise<void>((resolve) => silent.listen(socketPath, resolve));
    const timed = new RepoFlightClient({ socket_path: socketPath, credential_path: credentialController.operator_credential_path, now, timeout_ms: 25 });
    expect(await timed.query(statusQuery)).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("rejects trailing data after a valid controller response", async () => {
    const credentialRoot = directory();
    const credentialServer = new RepoFlightTransportServer({ persistence_dir: credentialRoot, operator: fakeOperator() as unknown as RepoFlightOperatorService, authenticated_operator_actor: operatorActor, now });
    controllers.push(credentialServer);
    const socketPath = join(directory(), "trailing.sock");
    const trailing = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string) => {
        const request = JSON.parse(chunk.slice(0, chunk.indexOf("\n"))) as { request_id: string };
        socket.end(`${JSON.stringify({ version: 1, request_id: request.request_id, ok: true, result: {} })}\n{}\n`);
      });
    });
    servers.push(trailing); await new Promise<void>((resolve) => trailing.listen(socketPath, resolve));
    const client = new RepoFlightClient({ socket_path: socketPath, credential_path: credentialServer.operator_credential_path, now, timeout_ms: 500 });
    expect(await client.query(statusQuery)).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("removes its socket on shutdown and restarts cleanly", async () => {
    const { root, controller } = await setup();
    expect(statSync(controller.socket_path).isSocket()).toBe(true);
    await controller.close(); controllers.splice(controllers.indexOf(controller), 1);
    expect(() => statSync(controller.socket_path)).toThrow();
    const restarted = new RepoFlightTransportServer({ persistence_dir: root, operator: fakeOperator() as unknown as RepoFlightOperatorService, authenticated_operator_actor: operatorActor, now }); controllers.push(restarted);
    await expect(restarted.start()).resolves.toBe(restarted.socket_path);
  });

  it("uses one private bounded UDS path for deeply nested persistence roots", async () => {
    const longRoot = join(directory(), "nested-".repeat(20));
    const controller = new RepoFlightTransportServer({ persistence_dir: longRoot, operator: fakeOperator() as unknown as RepoFlightOperatorService, authenticated_operator_actor: operatorActor, now }); controllers.push(controller);
    expect(Buffer.byteLength(controller.socket_path)).toBeLessThanOrEqual(100);
    await controller.start();
    const client = new RepoFlightClient({ socket_path: controller.socket_path, credential_path: controller.operator_credential_path, now, timeout_ms: 500 });
    await expect(client.query(statusQuery, "long-path")).resolves.toMatchObject({ ok: true });
  });

  it("never returns or journals protected tokens and raw payloads", async () => {
    const { root, operatorClient } = await setup();
    const command = { schema_version: 1, metadata, command: { kind: "repo.flight.clearance.request", request: { request_id: "raw-marker-must-not-persist" } } };
    const response = await operatorClient.command(command, "secret-check:1", "nonce:secret-check");
    expect(JSON.stringify(response)).not.toContain("must-not-return");
    const replay = readFileSync(join(root, "repo-flight-transport", "replay.json"), "utf8");
    expect(replay).not.toContain("raw-marker-must-not-persist");
    expect(replay).not.toContain("must-not-return");
  });
});

function raw(socketPath: string, frame: string): Promise<RepoFlightWireResponse> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath); let response = "";
    socket.setEncoding("utf8"); socket.on("connect", () => socket.end(frame)); socket.on("data", (chunk: string) => { response += chunk; if (response.includes("\n")) resolve(JSON.parse(response.slice(0, response.indexOf("\n"))) as RepoFlightWireResponse); });
  });
}
