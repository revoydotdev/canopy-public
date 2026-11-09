/**
 * Contracts for the native bus-thread tool ports — the child→parent half of
 * revoy2's agent-to-agent communication.
 *
 * Parent→child dispatch already exists (`NativeAgentExecutor.specialize`).
 * A dispatched native child's only return path used to be its single
 * terminal result; it could not post a message, acknowledge one, or ask a
 * clarifying question mid-execution. `createNativeBusThreadToolPorts` (in
 * `native-tool-host.ts`) closes that gap by exposing the *already-existing*
 * `bus.thread.send` / `bus.thread.ack` / `sibling.status` runtime-catalog
 * kinds (`parent-child-thread-contracts.ts`, `sibling-contracts.ts`,
 * dispatched by `RuntimeCatalogRouter`) as native tool ports — not a second
 * message path, not a new store, and not the recursive `sibling.spawn` /
 * `subagent.execute` surface.
 */
import { createHash, randomUUID } from "node:crypto";
import type { NodeCommunication } from "@arbor/audit";
import type { Provenance } from "@arbor/core";
import { RuntimeCatalogRouter, type RuntimeRouterResult } from "./runtime-catalog.js";
import type { ArborRuntime } from "./runtime.js";

/**
 * The trusted, host-resolved parent/child edge one dispatched native child
 * session may act on. This is a fact about *how the child was dispatched*
 * (the campaign graph's `parent_id` relationship), never something derived
 * from tool-call input — the same non-negotiable pattern
 * `resolve_high_risk_scope` already uses in `native-tool-host.ts` for
 * `write_paths`/`command_argv`. Exactly one edge exists per session.
 */
export interface NativeBusThreadScope {
  readonly campaign_id: string;
  readonly parent_node_id: string;
  /** The dispatched child's own node id; this session always acts as this endpoint. */
  readonly child_node_id: string;
  readonly capability_tier: NodeCommunication["capability_tier"];
  readonly provenance: Provenance;
}

/** Host-owned session→scope resolver; mirrors `resolve_high_risk_scope`. Returns `null` to deny every bus-thread tool for this session. */
export type ResolveNativeBusThreadScope = (request: { readonly session_id: string }) => NativeBusThreadScope | null;

/** Narrow dependency surface: only the two catalog entrypoints these ports drive. */
export type NativeBusThreadRouter = Pick<RuntimeCatalogRouter, "dispatchCommand" | "executeQuery">;

export interface NativeBusThreadToolOptions {
  readonly router: NativeBusThreadRouter;
  readonly resolve_scope: ResolveNativeBusThreadScope;
  /** Injected for deterministic operation/idempotency identity in tests; defaults to wall-clock/random. */
  readonly now?: () => Date;
  readonly random_id?: () => string;
}

export type { RuntimeRouterResult };

/**
 * ADR-083 extended across lanes (see decisions/ADR-083). A campaign-tree
 * edge (parent_id in `CampaignManager`'s durable tree) is a fact about the
 * tree, not about which lane — native or connector-subprocess — either
 * endpoint happens to run in. `createNativeBusThreadToolPorts` above is how
 * a *native* child reaches its own edge; a connector-hosted child (Claude
 * Code, Codex, OpenCode subprocess campaigns, see
 * `integrations/claude-code-campaign.ts` and `integrations/opencode-campaign.ts`)
 * cannot call native tool ports at all — it is a subprocess, not a session
 * inside this process's `NativeHarnessWorker`. `resolveConnectorBusThreadEdge`
 * / `postConnectorBusThreadReport` are the connector-lane counterpart: the
 * campaign loop itself (host code, never model input, never the subprocess)
 * resolves the SAME trusted edge and relays onto the SAME ledger at its
 * dispatch boundary, after a specialist call completes.
 *
 * O2 still holds, restated for this direction: the edge resolved here is
 * derived only from `manager.getNodeInfo(campaign_id, node_id).parent_id` —
 * the real tree, never a value the connector subprocess's stdout could
 * influence. Cross-LANE (a connector child reporting to a native parent) is
 * not cross-SCOPE; the scoping is per campaign-tree edge, not per lane, so a
 * genuine parent/child edge is in-scope here exactly as it is for
 * `createNativeBusThreadToolPorts`. There is no facility here for naming a
 * different edge at all — this path never reads a target edge from
 * connector output — so the "foreign edge" failure mode O2 forbids has no
 * surface to violate in this direction. A future parent→connector-child
 * relay (steer/delegate in) is the follow-up this comment does not cover:
 * it would need to re-introduce exactly that scope check, symmetrically,
 * against whatever the connector subprocess is told to relay downstream.
 */
export function resolveConnectorBusThreadEdge(
  runtime: ArborRuntime,
  input: { readonly campaign_id: string; readonly node_id: string },
  connector_identity_namespace: string,
): { readonly router: NativeBusThreadRouter; readonly scope: NativeBusThreadScope } | null {
  let parentNodeId: string | null;
  try {
    parentNodeId = runtime.manager.getNodeInfo(input.campaign_id, input.node_id)?.parent_id ?? null;
  } catch {
    return null;
  }
  if (parentNodeId === null) return null;
  return {
    router: new RuntimeCatalogRouter(runtime),
    scope: {
      campaign_id: input.campaign_id,
      parent_node_id: parentNodeId,
      child_node_id: input.node_id,
      capability_tier: "specialist",
      provenance: {
        tag: "generated",
        generator: `${connector_identity_namespace}/bus-thread-edge-v1`,
        input_hash: `campaign:${input.campaign_id}:node:${input.node_id}:parent:${parentNodeId}`,
      },
    },
  };
}

const CONNECTOR_BUS_REPORT_CONTENT_MAX_BYTES = 8_192;

export interface ConnectorBusThreadReportInput {
  readonly message_kind: NodeCommunication["kind"];
  readonly content: string;
  readonly ack_required?: boolean;
  /** Correlation identity for the ledger record; need not be globally unique. */
  readonly correlation_id: string;
  readonly now?: () => Date;
  readonly random_id?: () => string;
}

export type ConnectorBusThreadReportResult =
  | { readonly ok: true; readonly message_id: string; readonly thread_id: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Relays one message from a connector-hosted campaign child onto its real
 * parent edge in the same append-only ledger `bus.thread.send` already
 * writes to — never a second store, never an in-memory echo. Reads the
 * thread's current `expected_thread_version` immediately before dispatch
 * (the same compare-and-swap contract `bus.thread.send` enforces for a
 * native child) so a concurrent parent write is honestly rejected rather
 * than silently overwritten. Best-effort by design: a failure here is
 * reported to the caller to log, never thrown, so a bus-relay problem never
 * fails the specialist call whose result it is reporting.
 */
export async function postConnectorBusThreadReport(
  runtime: ArborRuntime,
  edge: { readonly router: NativeBusThreadRouter; readonly scope: NativeBusThreadScope },
  input: ConnectorBusThreadReportInput,
): Promise<ConnectorBusThreadReportResult> {
  const now = input.now ?? (() => new Date());
  const randomId = input.random_id ?? (() => randomUUID());
  try {
    const thread = runtime.manager.getParentChildThread(edge.scope.campaign_id, edge.scope.parent_node_id, edge.scope.child_node_id);
    // `correlation_id` is per node (`<ns>:<campaign>:<node>`), so on its own the
    // key was identical for every attempt of a retried node: the ledger either
    // answered with the FIRST attempt's record (same text) or threw a
    // different-content conflict, and the retry's report was lost either way.
    // The content digest is the attempt identity that survives a restart: a
    // genuinely replayed report still dedupes, a new attempt's report is new.
    const body = input.content.slice(0, CONNECTOR_BUS_REPORT_CONTENT_MAX_BYTES);
    const attemptDigest = createHash("sha256").update(`${input.message_kind}\0${body}`).digest("hex").slice(0, 16);
    const callKey = `connector-bus-thread-report:${input.correlation_id}:${attemptDigest}`;
    const envelope = {
      schema_version: 1 as const,
      metadata: {
        operation_id: `${callKey}:${randomId()}`.slice(0, 200),
        idempotency_key: callKey,
        correlation_id: input.correlation_id,
        actor_id: edge.scope.child_node_id,
        requested_at: now().toISOString(),
      },
      command: {
        kind: "bus.thread.send" as const,
        campaign_id: edge.scope.campaign_id,
        parent_node_id: edge.scope.parent_node_id,
        child_node_id: edge.scope.child_node_id,
        from_node_id: edge.scope.child_node_id,
        expected_thread_version: thread.version,
        message_kind: input.message_kind,
        content: body,
        provenance: edge.scope.provenance,
        capability_tier: edge.scope.capability_tier,
        ack_required: input.ack_required ?? false,
        acknowledges_communication_id: null,
        retracts_communication_id: null,
        parent_communication_id: null,
        reply_to_communication_id: null,
        deadline_at: null,
      },
    };
    const result = await edge.router.dispatchCommand(envelope);
    if (!result.ok) return { ok: false, reason: result.error.summary };
    const outcome = result.value as { accepted: boolean; message_id?: string; thread_id?: string; error?: { summary?: string } };
    if (!outcome.accepted || outcome.message_id === undefined || outcome.thread_id === undefined) {
      return { ok: false, reason: outcome.error?.summary ?? "bus thread report was not accepted" };
    }
    return { ok: true, message_id: outcome.message_id, thread_id: outcome.thread_id };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
