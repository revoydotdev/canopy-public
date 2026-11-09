/**
 * G-29 residual: A2A end-to-end through the real composition roots.
 *
 * The gap register recorded `a2a.send`/`a2a.receive` as "reachable-but-
 * unconfigured, not exercised end-to-end", on the basis that nothing
 * constructed and injected `RuntimeRouterOptions.a2a_bridge`. That claim is
 * stale: `server.ts`, `webui.ts` and `tui.ts` all inject it. What was genuinely
 * missing is evidence — every existing A2A test hands a bridge config directly
 * to a `RuntimeCatalogRouter` it constructs itself, so nothing proved that a
 * *real* composition root, reading a *real* environment, produces a router on
 * which A2A actually works.
 *
 * That is the same distinction G-03 turned on (a `RecoveryService` that existed
 * but which no composition root ever built), and it is closed the same way:
 * `recovery-roundtrip.test.ts` drives recovery through the real
 * `ArborMCPServer`/`ArborWebUIServer`, and this drives A2A through them.
 *
 * Both directions are asserted, because a fail-closed default is only a safety
 * property if the open path demonstrably works — otherwise "rejects when unset"
 * is indistinguishable from "rejects always".
 */
import { afterEach, describe, expect, it } from "vitest";
import type { NodeCommunication } from "@arbor/audit";
import { ArborMCPServer } from "../src/server.js";
import { ArborWebUIServer } from "../src/webui.js";
import { ArborRuntime } from "../src/runtime.js";
import { a2aBridgeFromEnvironment, a2aBridgeOption } from "../src/a2a-bridge.js";

const SECRET = "test-a2a-signing-secret";

const root = {
  description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
} as const;

function metadata(overrides: Record<string, string> = {}) {
  return {
    operation_id: "op-a2a", idempotency_key: "a2a:msg-1", correlation_id: "correlation-1",
    actor_id: "operator", requested_at: "2026-08-01T00:00:00.000Z", ...overrides,
  };
}

function communication(): NodeCommunication {
  return {
    author_node_id: "root", recipient_node_id: "external-agent", other_recipient_node_ids: [],
    kind: "report", payload: { content: "done", provenance: { tag: "claimed", claimant: "root" } },
    capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-01T00:00:00.000Z",
    correlation_id: "a2a:task-1", idempotency_key: "a2a:msg-1",
    acknowledges_communication_id: null, retracts_communication_id: null,
  };
}

function sendEnvelope() {
  return {
    schema_version: 1,
    metadata: metadata(),
    command: { kind: "a2a.send", campaign_id: "campaign", node_id: "root", communication: communication() },
  };
}

function receiveEnvelope() {
  return {
    schema_version: 1,
    metadata: metadata({ operation_id: "op-a2a-in", idempotency_key: "a2a:msg-in" }),
    command: {
      kind: "a2a.receive", campaign_id: "campaign", node_id: "root",
      message: {
        id: "msg-in", task_id: "task-in", author_node_ref: "external-agent",
        recipient_node_refs: ["root"], parts: [{ kind: "text", text: "hello" }],
        as_of: "2026-08-01T00:00:00.000Z",
      },
    },
  };
}

/** The router a composition root actually built, reached the way a transport reaches it. */
function serverRouter(): { dispatch: (input: unknown) => unknown } {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("campaign", "plan.md", root);
  const server = new ArborMCPServer(runtime);
  const router = (server as unknown as { runtimeCatalog: { dispatchCommand(input: unknown): unknown } }).runtimeCatalog;
  return { dispatch: (input) => router.dispatchCommand(input) };
}

function webRouter(): { dispatch: (input: unknown) => unknown } {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("campaign", "plan.md", root);
  const web = new ArborWebUIServer(runtime);
  const router = (web as unknown as { operatorCatalog: { dispatchCommand(input: unknown): unknown } }).operatorCatalog;
  return { dispatch: (input) => router.dispatchCommand(input) };
}

/** A permission/availability refusal, whichever shape the path reports it in. */
function refusal(result: unknown): { code?: string; summary?: string } | null {
  const outer = result as { ok?: boolean; error?: { code?: string; summary?: string }; value?: unknown };
  if (outer.ok === false) return outer.error ?? null;
  const value = outer.value as { accepted?: boolean; error?: { code?: string; summary?: string } } | undefined;
  if (value && value.accepted === false) return value.error ?? null;
  return null;
}

const originalSecret = process.env.ARBOR_A2A_SIGNING_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.ARBOR_A2A_SIGNING_SECRET;
  else process.env.ARBOR_A2A_SIGNING_SECRET = originalSecret;
});

describe("a2aBridgeOption — one environment read, no non-null assertion", () => {
  it("returns an empty slice when no secret is set, so the router option stays absent", () => {
    expect(a2aBridgeOption({})).toEqual({});
    expect(a2aBridgeFromEnvironment({})).toBeNull();
  });

  it("returns the configured bridge when a secret is set", () => {
    const option = a2aBridgeOption({ ARBOR_A2A_SIGNING_SECRET: SECRET });
    expect(option.a2a_bridge?.signing_secret).toBe(SECRET);
    expect(option.a2a_bridge?.default_recipient_tier).toBe("specialist");
  });

  it("honours an explicit recipient tier and rejects an invalid one by falling back", () => {
    expect(a2aBridgeOption({ ARBOR_A2A_SIGNING_SECRET: SECRET, ARBOR_A2A_DEFAULT_RECIPIENT_TIER: "auditor" })
      .a2a_bridge?.default_recipient_tier).toBe("auditor");
    expect(a2aBridgeOption({ ARBOR_A2A_SIGNING_SECRET: SECRET, ARBOR_A2A_DEFAULT_RECIPIENT_TIER: "nonsense" })
      .a2a_bridge?.default_recipient_tier).toBe("specialist");
  });

  it("treats a blank or whitespace secret as unset — a fail-closed gate cannot be opened with an empty string", () => {
    expect(a2aBridgeOption({ ARBOR_A2A_SIGNING_SECRET: "" })).toEqual({});
    expect(a2aBridgeOption({ ARBOR_A2A_SIGNING_SECRET: "   " })).toEqual({});
  });
});

describe("G-29 residual — A2A through the real composition roots", () => {
  it("MCP server: a2a.send is refused as unavailable when no secret is in the environment", async () => {
    delete process.env.ARBOR_A2A_SIGNING_SECRET;

    const denial = refusal(await serverRouter().dispatch(sendEnvelope()));
    expect(denial?.code).toBe("unavailable");
    expect(denial?.summary).toContain("a2a bridge is not configured");
  });

  it("MCP server: a2a.send genuinely succeeds when the environment configures a secret", async () => {
    process.env.ARBOR_A2A_SIGNING_SECRET = SECRET;

    const result = await serverRouter().dispatch(sendEnvelope()) as {
      ok: boolean;
      value: { accepted: boolean; message?: { task_id?: string }; wire?: unknown };
    };

    expect(result.ok).toBe(true);
    expect(result.value.accepted).toBe(true);
    // A real projection, not merely an acceptance: the outbound message and its
    // wire rendering are what an A2A peer would actually receive.
    expect(result.value.message?.task_id).toBe("task-1");
    expect(result.value.wire).toBeDefined();
  });

  it("MCP server: a2a.receive genuinely succeeds and records the inbound communication", async () => {
    process.env.ARBOR_A2A_SIGNING_SECRET = SECRET;

    const result = await webRouter().dispatch(receiveEnvelope()) as { ok: boolean; value: { accepted: boolean } };
    expect(result.ok).toBe(true);
    expect(result.value.accepted).toBe(true);
  });

  it("web server: the same fail-closed default holds on the other composition root", async () => {
    delete process.env.ARBOR_A2A_SIGNING_SECRET;

    const denial = refusal(await webRouter().dispatch(sendEnvelope()));
    expect(denial?.code).toBe("unavailable");
    expect(denial?.summary).toContain("a2a bridge is not configured");
  });

  it("web server: a2a.send succeeds once the environment configures a secret", async () => {
    process.env.ARBOR_A2A_SIGNING_SECRET = SECRET;

    const result = await webRouter().dispatch(sendEnvelope()) as { ok: boolean; value: { accepted: boolean } };
    expect(result.ok).toBe(true);
    expect(result.value.accepted).toBe(true);
  });
});
