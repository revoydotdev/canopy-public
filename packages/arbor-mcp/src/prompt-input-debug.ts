import { createHash } from "node:crypto";
import {
  DEFAULT_LOOP_CONFIG,
  composeSpecialistPrompt,
  projectTokenDispatchPrompt,
} from "@arbor/opencode";
import type { ArborRuntime } from "./runtime.js";
import { composeLoopConfigPorts } from "./loop-ports-helper.js";

export interface PromptInputDebugRequest {
  readonly campaign_id: string;
  readonly node_id: string;
  /** Fixes every time-sensitive projection to the same selection checkpoint. */
  readonly checkpoint_at?: string;
}

export interface PromptInputDebugDump {
  readonly schema: "arbor.prompt-input/v1";
  readonly scope: {
    readonly campaign_id: string;
    readonly node_id: string;
    readonly checkpoint_at: string;
    readonly capability_tier: "specialist";
    readonly specialist_agent: string;
  };
  readonly model_input: {
    readonly interface: "LoopExecutor.specialize";
    readonly messages: readonly { readonly role: "user"; readonly content: string }[];
  };
  readonly integrity: { readonly sha256: string; readonly bytes: number };
  readonly included_sources: {
    readonly action: "campaign_node";
    readonly foreground: "agent_catalog";
    readonly governed_overlay_ids: readonly string[];
    readonly communication_ids: readonly string[];
    readonly memory: "campaign_node_ancestry";
    readonly structural_context: "campaign_node_compaction_and_communications";
  };
  readonly excluded_sources: readonly {
    readonly source: "approval_memory" | "credential_leases" | "cross_campaign_state";
    readonly disposition: "excluded_by_construction" | "excluded_by_campaign_scoped_ports";
  }[];
}

/**
 * Render the exact prompt value the production loop passes to
 * `LoopExecutor.specialize`, at one immutable selection checkpoint.
 *
 * The dependency list is deliberately an allowlist.  ApprovalService and
 * credential brokers are not accepted as inputs and therefore cannot leak
 * unrelated durable state into this diagnostic projection.
 */
export async function buildPromptInputDebugDump(
  runtime: ArborRuntime,
  request: PromptInputDebugRequest,
): Promise<PromptInputDebugDump> {
  const checkpointAt = request.checkpoint_at ?? new Date().toISOString();
  if (!request.campaign_id.trim() || !request.node_id.trim()) throw new Error("prompt input requires non-empty campaign and node ids");
  if (!Number.isFinite(Date.parse(checkpointAt))) throw new Error("prompt input checkpoint must be ISO-parseable");
  const node = runtime.manager.getNodeInfo(request.campaign_id, request.node_id);
  if (!node) throw new Error(`Node ${request.node_id} was not found in campaign ${request.campaign_id}`);

  const ports = composeLoopConfigPorts(runtime, runtime.agentConfig);
  const governed = ports.governed_context.checkpoint({
    campaign_id: request.campaign_id,
    node_id: request.node_id,
    as_of: checkpointAt,
  });
  const communications = ports.communications?.projectSelection({
    campaign_id: request.campaign_id,
    node_id: request.node_id,
    tier: "specialist",
    limit: 20,
    as_of: checkpointAt,
  }) ?? [];
  const foreground = ports.foreground.derive({
    campaign_id: request.campaign_id,
    node_id: request.node_id,
    agent: node.action.delegate_to,
    capability: "specialist",
  }).prompt_fragment;
  const composed = composeSpecialistPrompt({
    base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
    foreground,
    action: node.action,
    governed_checkpoint: governed,
    checkpoint_at: checkpointAt,
    communications,
    inject_memory: (prompt) => runtime.manager.kbInject(prompt, request.campaign_id, { tier: "specialist" }, request.node_id),
  });
  const prompt = ports.token_economy
    ? await projectTokenDispatchPrompt({
      campaign_id: request.campaign_id,
      node_id: request.node_id,
      prompt: composed,
      capability: "specialist",
      config: ports.token_economy,
    })
    : composed;
  const bytes = Buffer.byteLength(prompt, "utf8");

  return Object.freeze({
    schema: "arbor.prompt-input/v1",
    scope: Object.freeze({
      campaign_id: request.campaign_id,
      node_id: request.node_id,
      checkpoint_at: checkpointAt,
      capability_tier: "specialist",
      specialist_agent: node.action.delegate_to,
    }),
    model_input: Object.freeze({
      interface: "LoopExecutor.specialize",
      messages: Object.freeze([Object.freeze({ role: "user", content: prompt })]),
    }),
    integrity: Object.freeze({ sha256: `sha256:${createHash("sha256").update(prompt).digest("hex")}`, bytes }),
    included_sources: Object.freeze({
      action: "campaign_node",
      foreground: "agent_catalog",
      governed_overlay_ids: Object.freeze([...governed.applied_overlay_ids]),
      communication_ids: Object.freeze(communications.map((record) => record.id)),
      memory: "campaign_node_ancestry",
      structural_context: "campaign_node_compaction_and_communications",
    }),
    excluded_sources: Object.freeze([
      Object.freeze({ source: "approval_memory", disposition: "excluded_by_construction" }),
      Object.freeze({ source: "credential_leases", disposition: "excluded_by_construction" }),
      Object.freeze({ source: "cross_campaign_state", disposition: "excluded_by_campaign_scoped_ports" }),
    ]),
  });
}
