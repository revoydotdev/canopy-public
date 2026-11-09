/**
 * Proves — with the real runtime, a real on-disk ledger, and no mocked bus —
 * which of the three believed agent-communication axes actually work today:
 *
 *   1. agent <-> agent      (`bus.thread.send` / `bus.thread.history`)
 *   3. intra-session        (`bus.record` / `bus.history`, conversation-addressed)
 *   4. ack semantics        (`bus.thread.send{ack_required}` + `bus.thread.ack`)
 *   + `a2a.*` honesty       (fails closed with no bridge composed)
 *
 * Axis 2 (agent -> sub-agent, specifically the child -> parent direction) is
 * NOT exercised here. It is being built by a sibling agent in this same
 * session; this file makes no claim about it either way.
 *
 * Every test drives `RuntimeCatalogRouter.dispatchCommand`/`executeQuery` —
 * the same single command/query authority `tools.ts`'s `arbor_command`/
 * `arbor_query` MCP tools call directly with no extra logic in between
 * (packages/arbor-mcp/src/tools.ts:591,613: the handler is literally
 * `(args) => runtimeCatalog.dispatchCommand(toArborCommandEnvelope(args))`
 * / `executeQuery(...)`). Dispatching straight through the router is
 * therefore the same authority an MCP client reaches, matching the existing
 * precedent in tests/bus-a2a-sibling-runtime.test.ts.
 *
 * The runtime itself is the real CLI composition root, `createCliRuntime`
 * (packages/arbor-mcp/src/cli.ts:1169) — the same constructor `arbor-mcp
 * serve`/`tui`/`webui` use — pointed at a real temp-directory git repo, so
 * `CampaignManager`'s persistence (SQLite KB + ledger files under
 * `<repo>/.arbor`) is genuinely on disk, not the in-memory `EvidenceLedger`
 * fallback.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { createCliRuntime } from "../src/cli.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { parentChildThreadId } from "../src/conversation-bus.js";

// --- fixture repo plumbing (mirrors tests/recovery-roundtrip.test.ts) ---

const GIT_SCOPE_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"] as const;
function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_SCOPE_ENV_VARS) delete env[key];
  return env;
}
function initRepo(dir: string): void {
  const opts = { cwd: dir, env: sanitizedGitEnv() } as const;
  execFileSync("git", ["init", "-q"], opts);
  execFileSync("git", ["config", "user.email", "test@example.com"], opts);
  execFileSync("git", ["config", "user.name", "Test"], opts);
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], opts);
}

const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const childAction: Action = { description: "child agent", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "worker" };

let opCounter = 0;
function metadata(overrides: Partial<Record<string, string>> = {}) {
  opCounter += 1;
  return {
    operation_id: `op-${opCounter}`, idempotency_key: `key-${opCounter}`, correlation_id: `corr-${opCounter}`,
    actor_id: "operator", requested_at: "2026-08-01T00:00:00.000Z", ...overrides,
  };
}

describe("A2A communication axes (proof, not claim)", () => {
  it("axis 1 (agent <-> agent): a bus.thread.send dispatched through the catalog router survives a fresh projection over the same persistence dir", async () => {
    const repo = mkdtempSync(join(tmpdir(), "a2a-axes-agent-agent-"));
    try {
      initRepo(repo);
      const runtimeA = createCliRuntime(repo);
      const routerA = new RuntimeCatalogRouter(runtimeA);
      runtimeA.manager.startCampaign("campaign", "plan.md", rootAction);
      const rootId = runtimeA.manager.getCampaignSnapshot("campaign")!.root_id;
      const [childId] = runtimeA.manager.branch("campaign", rootId, [childAction]);

      const send = {
        schema_version: 1 as const,
        metadata: metadata({ operation_id: "op-agent-send" }),
        command: {
          kind: "bus.thread.send" as const,
          campaign_id: "campaign", parent_node_id: rootId, child_node_id: childId!, from_node_id: rootId,
          expected_thread_version: "origin",
          message_kind: "delegate" as const, content: "agent A to agent B: begin work",
          provenance: { tag: "claimed" as const, claimant: rootId }, capability_tier: "specialist" as const,
        },
      };
      const sendResult = await routerA.dispatchCommand(send);
      expect(sendResult).toMatchObject({
        ok: true, capability: "bus.write",
        value: { accepted: true, delivery: "durable", thread_id: parentChildThreadId(rootId, childId!) },
      });
      const messageId = sendResult.ok && sendResult.value.accepted ? (sendResult.value as unknown as { message_id: string }).message_id : "";
      expect(messageId).toBeTruthy();

      const historyA = routerA.executeQuery({
        schema_version: 1, query_id: "hist-a",
        query: { kind: "bus.thread.history" as const, campaign_id: "campaign", parent_node_id: rootId, child_node_id: childId! },
      });
      // ack_required was not set on the send, so delivery projects as
      // "acknowledged" by construction (conversation-bus.ts:159 — delivery
      // is only ever "pending"/"timed_out" for a message that actually
      // requires acknowledgement); the dedicated ack-semantics test below
      // exercises the ack_required: true path.
      expect(historyA).toMatchObject({
        ok: true, capability: "bus.read",
        value: { messages: [{ id: messageId, kind: "delegate", author_node_id: rootId, delivery: "acknowledged" }] },
      });

      // Durability, not in-memory state: a SECOND runtime + router built
      // fresh over the same on-disk persistence dir (CampaignManager's
      // constructor calls restoreCampaigns() when a persistence_dir is
      // supplied — manager.ts:281) must see the same durable message.
      const runtimeB = createCliRuntime(repo);
      const routerB = new RuntimeCatalogRouter(runtimeB);
      const historyB = routerB.executeQuery({
        schema_version: 1, query_id: "hist-b",
        query: { kind: "bus.thread.history" as const, campaign_id: "campaign", parent_node_id: rootId, child_node_id: childId! },
      });
      expect(historyB).toMatchObject({
        ok: true,
        value: { messages: [{ id: messageId, payload_preview: { content: "agent A to agent B: begin work" } }] },
      });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("axis 3 (intra-session): bus.record/bus.history is the SAME ledger mechanism as bus.thread.send, addressed by an explicit conversation_id instead of a parent/child pair", async () => {
    const repo = mkdtempSync(join(tmpdir(), "a2a-axes-intra-session-"));
    try {
      initRepo(repo);
      const runtime = createCliRuntime(repo);
      const router = new RuntimeCatalogRouter(runtime);
      runtime.manager.startCampaign("campaign", "plan.md", rootAction);
      const rootId = runtime.manager.getCampaignSnapshot("campaign")!.root_id;
      const [childId] = runtime.manager.branch("campaign", rootId, [childAction]);

      // First, a bus.thread.send between the same parent/child pair as axis 1.
      const send = {
        schema_version: 1 as const,
        metadata: metadata({ operation_id: "op-thread-send" }),
        command: {
          kind: "bus.thread.send" as const,
          campaign_id: "campaign", parent_node_id: rootId, child_node_id: childId!, from_node_id: rootId,
          expected_thread_version: "origin",
          message_kind: "delegate" as const, content: "thread-addressed message",
          provenance: { tag: "claimed" as const, claimant: rootId }, capability_tier: "specialist" as const,
        },
      };
      const sendResult = await router.dispatchCommand(send);
      const messageId = sendResult.ok && (sendResult.value as { accepted: boolean }).accepted
        ? (sendResult.value as unknown as { message_id: string }).message_id : "";
      expect(messageId).toBeTruthy();

      // Manager.recordParentChildThreadMessage (manager.ts:2469-2507), the
      // backend behind bus.thread.send, appends via
      // `this.recordBusMessage({ ...input, conversation_id: thread_id })` —
      // i.e. bus.thread.send is bus.record with conversation_id synthesized
      // as `parentChildThreadId(parent, child)`. This is not two mechanisms;
      // it is one ledger append under two different addressing facades. We
      // assert that structurally rather than duplicating axis 1's test:
      // the SAME message the thread query returned must also be visible
      // through the generic conversation-addressed bus.history query, using
      // that synthesized conversation_id.
      const viaConversationAddressing = router.executeQuery({
        schema_version: 1, query_id: "conv-view",
        query: { kind: "bus.history" as const, campaign_id: "campaign", conversation_id: parentChildThreadId(rootId, childId!) },
      });
      expect(viaConversationAddressing).toMatchObject({ ok: true, capability: "bus.read" });
      if (viaConversationAddressing.ok) {
        const projection = viaConversationAddressing.value as { conversations: Map<string, { id: string; payload_preview: { content: string } }[]> };
        const bucket = projection.conversations.get(parentChildThreadId(rootId, childId!));
        expect(bucket).toHaveLength(1);
        expect(bucket![0]).toMatchObject({ id: messageId, payload_preview: { content: "thread-addressed message" } });
      }

      // What bus.record adds beyond bus.thread.send: a conversation is not
      // restricted to one parent/child pair. Address a THIRD node into the
      // same session-scoped conversation — something bus.thread.send cannot
      // do, since its endpoints must be a direct parent/child in the tree
      // (manager.ts:2472-2476 rejects any other pairing).
      const [siblingId] = runtime.manager.branch("campaign", rootId, [childAction]);
      const broadcast = {
        schema_version: 1 as const,
        metadata: metadata({ operation_id: "op-bus-record", idempotency_key: "broadcast-1" }),
        command: {
          kind: "bus.record" as const, campaign_id: "campaign", node_id: rootId,
          communication: {
            author_node_id: rootId, recipient_node_id: childId!, other_recipient_node_ids: [siblingId!],
            kind: "clarify" as const, payload: { content: "session-wide note", provenance: { tag: "claimed" as const, claimant: rootId } },
            capability_tier: "specialist" as const, trigger_turn: false, as_of: "2026-08-01T00:00:02.000Z",
            correlation_id: "corr-broadcast", idempotency_key: "broadcast-1",
            acknowledges_communication_id: null, retracts_communication_id: null,
            conversation_id: "session-standup",
          },
        },
      };
      await expect(router.dispatchCommand(broadcast)).resolves.toMatchObject({ ok: true, value: { accepted: true }, capability: "bus.write" });
      const standup = router.executeQuery({
        schema_version: 1, query_id: "standup",
        query: { kind: "bus.history" as const, campaign_id: "campaign", conversation_id: "session-standup" },
      });
      if (standup.ok) {
        const projection = standup.value as { conversations: Map<string, { recipient_node_ids: string[] }[]> };
        expect(projection.conversations.get("session-standup")![0]!.recipient_node_ids).toEqual([childId, siblingId]);
      }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("ack semantics: an ack_required bus.thread.send projects as pending until a matching bus.thread.ack is durably recorded", async () => {
    const repo = mkdtempSync(join(tmpdir(), "a2a-axes-ack-"));
    try {
      initRepo(repo);
      const runtime = createCliRuntime(repo);
      const router = new RuntimeCatalogRouter(runtime);
      runtime.manager.startCampaign("campaign", "plan.md", rootAction);
      const rootId = runtime.manager.getCampaignSnapshot("campaign")!.root_id;
      const [childId] = runtime.manager.branch("campaign", rootId, [childAction]);

      const send = {
        schema_version: 1 as const,
        metadata: metadata({ operation_id: "op-ack-send" }),
        command: {
          kind: "bus.thread.send" as const,
          campaign_id: "campaign", parent_node_id: rootId, child_node_id: childId!, from_node_id: rootId,
          expected_thread_version: "origin",
          message_kind: "delegate" as const, content: "please confirm receipt",
          provenance: { tag: "claimed" as const, claimant: rootId }, capability_tier: "specialist" as const,
          ack_required: true,
        },
      };
      const sendResult = await router.dispatchCommand(send);
      expect(sendResult.ok && (sendResult.value as { accepted: boolean }).accepted).toBe(true);
      const messageId = (sendResult as unknown as { value: { message_id: string } }).value.message_id;

      const beforeAck = router.executeQuery({
        schema_version: 1, query_id: "before-ack",
        query: { kind: "bus.thread.history" as const, campaign_id: "campaign", parent_node_id: rootId, child_node_id: childId! },
      });
      expect(beforeAck).toMatchObject({ ok: true, value: { messages: [{ id: messageId, ack_required: true, delivery: "pending" }] } });

      const ack = {
        schema_version: 1 as const,
        metadata: metadata({ operation_id: "op-ack" }),
        command: {
          kind: "bus.thread.ack" as const,
          campaign_id: "campaign", parent_node_id: rootId, child_node_id: childId!, from_node_id: childId!,
          expected_thread_version: messageId, message_id: messageId,
          provenance: { tag: "claimed" as const, claimant: childId! }, capability_tier: "specialist" as const,
        },
      };
      const ackResult = await router.dispatchCommand(ack);
      expect(ackResult).toMatchObject({ ok: true, capability: "bus.write", value: { accepted: true, delivery: "durable" } });

      const afterAck = router.executeQuery({
        schema_version: 1, query_id: "after-ack",
        query: { kind: "bus.thread.history" as const, campaign_id: "campaign", parent_node_id: rootId, child_node_id: childId! },
      });
      expect(afterAck).toMatchObject({
        ok: true,
        value: { messages: [{ id: messageId, ack_required: true, delivery: "acknowledged" }, { kind: "reply", author_node_id: childId }] },
      });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  describe("a2a.* honesty", () => {
    it("returns an `unavailable` refusal for a2a.send when no bridge is composed — the router's actual, exact behavior, not an assumed one", async () => {
      // No a2a_bridge option is passed here, reproducing exactly what
      // `packages/arbor-mcp/src/cli.ts`'s `remote-serve` subcommand does at
      // ~1501-1506 (`new RuntimeCatalogRouter(runtime)` with zero options —
      // the only composition root in this package that never calls
      // a2aBridgeOption()/a2aBridgeFromEnvironment()).
      //
      // IMPORTANT CORRECTION to the believed-true premise handed into this
      // test file: it is NOT true that "the only thing that ever composes
      // an A2ABridgeConfig is tui.ts". Read closely:
      //   - server.ts:41-43 (`ArborMCPServer`, used by cli.ts's plain
      //     `serve` at ~1512) composes `...a2aBridgeOption()` unconditionally
      //     in its own constructor.
      //   - webui.ts:32-35 (`ArborWebUIServer`) does the same.
      //   - tui.ts:415-418 does the same via `a2aBridgeFromEnvironment()`
      //     directly.
      // All three funnel through the identical env-gated helper
      // (`a2aBridgeFromEnvironment`, a2a-bridge.ts:22-35): a2a.* is
      // unavailable on EVERY one of them precisely when
      // `ARBOR_A2A_SIGNING_SECRET` is unset, and available on all three
      // alike once it is set. So `arbor-mcp serve` is not structurally
      // different from `tui` here — both are env-gated, not "unwired".
      // The one composition root that is genuinely unwired regardless of
      // env is `remote-serve` (cli.ts ~1501-1506), which builds its
      // `RuntimeCatalogRouter` with no options at all. THAT is the real gap,
      // not "serve vs tui". If a future change threads `a2aBridgeOption()`
      // into `remote-serve` too, or removes the env gate from any of the
      // other three, this test's premise changes and must be revisited —
      // that revisit is the point: this assertion is meant to force the
      // question, not to silently keep passing.
      const repo = mkdtempSync(join(tmpdir(), "a2a-axes-unavailable-"));
      try {
        initRepo(repo);
        const runtime = createCliRuntime(repo);
        const router = new RuntimeCatalogRouter(runtime); // no a2a_bridge — matches remote-serve exactly
        runtime.manager.startCampaign("campaign", "plan.md", rootAction);

        const receive = {
          schema_version: 1 as const,
          metadata: metadata({ operation_id: "op-a2a-recv" }),
          command: {
            kind: "a2a.receive" as const, campaign_id: "campaign", node_id: runtime.manager.getCampaignSnapshot("campaign")!.root_id,
            message: {
              id: "msg-in", task_id: "task-in", author_node_ref: "external-agent", recipient_node_refs: ["root"],
              parts: [{ kind: "text" as const, text: "external request" }], as_of: "2026-08-01T00:00:00.000Z",
            },
          },
        };
        const receiveResult = await router.dispatchCommand(receive);
        expect(receiveResult).toMatchObject({
          ok: true,
          value: { accepted: false, error: { code: "unavailable", summary: "a2a bridge is not configured" } },
        });

        const send = {
          schema_version: 1 as const,
          metadata: metadata({ operation_id: "op-a2a-send" }),
          command: {
            kind: "a2a.send" as const, campaign_id: "campaign", node_id: runtime.manager.getCampaignSnapshot("campaign")!.root_id,
            communication: {
              author_node_id: "root", recipient_node_id: "external-agent", other_recipient_node_ids: [], kind: "report" as const,
              payload: { content: "internal result", provenance: { tag: "claimed" as const, claimant: "root" } }, capability_tier: "specialist" as const,
              trigger_turn: false, as_of: "2026-08-01T00:00:02.000Z", correlation_id: "task", idempotency_key: "key-send", acknowledges_communication_id: null, retracts_communication_id: null,
            },
          },
        };
        const sendResult = await router.dispatchCommand(send);
        expect(sendResult).toMatchObject({
          ok: true,
          value: { accepted: false, error: { code: "unavailable", summary: "a2a bridge is not configured" } },
        });
      } finally { rmSync(repo, { recursive: true, force: true }); }
    });
  });
});
