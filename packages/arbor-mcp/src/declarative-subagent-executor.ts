/**
 * The only executable interpretation of a governed subagent descriptor.
 *
 * It is intentionally narrow: a separately authorized catalog command may
 * run one active descriptor as a fresh native child session.  The descriptor
 * supplies bounded objective/context references only.  It never supplies a
 * command, tool, plugin, child action, capability, or recursive dispatch.
 */
import { createHash } from "node:crypto";
import type { CampaignManager } from "./manager.js";
import type { GovernedContextService } from "./governed-context-service.js";
import type { NativeAgentExecutor } from "./native-agent-executor.js";
import type { Provenance } from "@arbor/core";

export interface DeclarativeSubagentExecutionPort {
  execute(input: {
    readonly execution_id: string;
    readonly campaign_id: string;
    readonly parent_node_id: string;
    readonly revision_id: string;
    readonly child_session_id: string;
    readonly worktree_node_id: string;
  }): Promise<{ readonly result_artifact_id: string; readonly result_provenance: Provenance; readonly evidence_ids: readonly string[] }>;
}

export interface DeclarativeSubagentExecutorOptions {
  /** Lazy forms allow the CLI composition root to bind the canonical runtime once. */
  readonly context: GovernedContextService | (() => GovernedContextService);
  readonly manager: CampaignManager | (() => CampaignManager);
  readonly native_executor: () => NativeAgentExecutor | null;
  readonly worktrees: { acquireLease(input: { campaign_id: string; node_id: string; specialist: string }): { active: boolean; path: string } | null; releaseLease(node_id: string): boolean };
}

const EXECUTABLE_ROLES = new Set(["seed", "heartwood", "architect", "documentation-writer"]);

/**
 * Build the production adapter.  It has no ambient fallback: a missing native
 * executor or worktree lease fails closed, leaving a durable failed execution
 * record rather than routing a descriptor into OpenCode or a plugin.
 */
export function createDeclarativeSubagentExecutor(options: DeclarativeSubagentExecutorOptions): DeclarativeSubagentExecutionPort {
  return {
    async execute(input) {
      const context = typeof options.context === "function" ? options.context() : options.context;
      const manager = typeof options.manager === "function" ? options.manager() : options.manager;
      const revision = context.list(input.campaign_id).revisions.find((item) => item.id === input.revision_id);
      if (!revision || revision.component !== "subagent_descriptor" || revision.status !== "active") throw new Error("descriptor revision is not active");
      const descriptor = revision.patch.descriptor as { role?: unknown; objective?: unknown; allowed_context_artifact_ids?: unknown };
      if (typeof descriptor.role !== "string" || !EXECUTABLE_ROLES.has(descriptor.role) || typeof descriptor.objective !== "string" || !Array.isArray(descriptor.allowed_context_artifact_ids)) {
        throw new Error("descriptor role or bounded context is not eligible for native execution");
      }
      const parent = manager.getNodeInfo(input.campaign_id, input.parent_node_id);
      if (!parent) throw new Error("parent tree node was not found");
      const native = options.native_executor();
      if (!native) throw new Error("native declarative-subagent executor is unavailable");
      const lease = options.worktrees.acquireLease({ campaign_id: input.campaign_id, node_id: input.worktree_node_id, specialist: "governed-subagent" });
      if (!lease?.active) throw new Error("isolated worktree lease is unavailable");
      try {
        const boundedContext = descriptor.allowed_context_artifact_ids.slice(0, 16).map((id) => {
          if (typeof id !== "string") throw new Error("descriptor context reference is malformed");
          return context.readWorkspace({ artifact_id: id, visibility: "campaign", max_bytes: 8_192 }).content;
        });
        const result = await native.specialize({
          campaign_id: input.campaign_id,
          node_id: input.worktree_node_id,
          // This fixed data is not a branch action.  In particular it carries
          // no high-risk scope or execution-role authority from the parent.
          action: { description: descriptor.objective, category: "governed-declarative-subagent", delegate_to: descriptor.role },
          prompt: [
            "Perform this bounded read-only declarative subagent task.",
            `Objective: ${descriptor.objective}`,
            `Parent tree node: ${input.parent_node_id}`,
            "Do not delegate, create child tasks, request tools, write files, run commands, or claim verification.",
            boundedContext.length ? `Approved context references:\n${boundedContext.join("\n\n")}` : "No additional context references were approved.",
          ].join("\n\n"),
          worktree_path: lease.path,
          specialist_agent: descriptor.role,
          ...(descriptor.role === "architect" || descriptor.role === "documentation-writer" ? { execution_role: descriptor.role } : {}),
          tools_mode: "none",
          session_id: input.child_session_id,
        });
        const evidence = context.captureArtifact({
          campaign_id: input.campaign_id,
          media_type: "text/plain",
          producer: `governed-subagent:${descriptor.role}`,
          visibility: "campaign",
          provenance: result.provenance,
          content: result.output.slice(0, 65_536),
        });
        // The content-addressed result and the revision's existing source
        // events are evidence.  A session id is lineage metadata, not an
        // evidence id, so it is deliberately not smuggled into this list.
        return { result_artifact_id: evidence.id, result_provenance: result.provenance, evidence_ids: [evidence.id, ...revision.source_event_ids] };
      } finally {
        options.worktrees.releaseLease(input.worktree_node_id);
      }
    },
  };
}

/** Stable opaque child identities; no caller-provided filesystem/branch name. */
export function declarativeSubagentIdentity(input: { campaign_id: string; parent_node_id: string; revision_id: string; operation_id: string }): { execution_id: string; child_session_id: string; worktree_node_id: string } {
  const digest = createHash("sha256").update(`${input.campaign_id}\u0000${input.parent_node_id}\u0000${input.revision_id}\u0000${input.operation_id}`).digest("hex").slice(0, 24);
  return { execution_id: `subagent-execution:${digest}`, child_session_id: `native:subagent:${digest}`, worktree_node_id: `subagent-${digest}` };
}
