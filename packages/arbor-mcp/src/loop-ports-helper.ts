/**
 * Port-mapping helper that reads the real CanonicalLoopPorts from the
 * canonical runtime and maps them to CampaignLoopConfig field names.
 *
 * The caller spreads the result into their CampaignLoopConfig. Lives in
 * @arbor/mcp (allowed dependency direction) and imports @arbor/opencode at
 * this CLI-leaf boundary — the same pattern recovery-lease-adapter.ts and
 * demo.ts already use — because `token_economy` cannot be a structural
 * match: `TokenEconomyConfig` is a composed value (an epoch port plus a
 * live provider bridge plus budget defaults), not a single port with a
 * matching shape elsewhere in this package.
 *
 * @example
 *   const config: CampaignLoopConfig = {
 *     max_iterations: 50,
 *     ...composeLoopConfigPorts(runtime),
 *   };
 */
import type { ArborRuntime } from "./runtime.js";
import { createHash } from "node:crypto";
import { foldStructuralContext, type ContextCapability, type StructuralContextEntry, type StructuralFoldPolicy, CAPABILITY_TIER } from "@arbor/core";
import { buildAllAgents, deriveDispatchForeground, modelCapabilityTokenBridge, type TokenEconomyConfig, type GovernedOverlayCheckpointPort, type CampaignRetryContextPort } from "@arbor/opencode";
import { isAgentRole, type AgentDefinition, type AgentDefinitionSource } from "./agent-registry.js";
import type { AgentConfig } from "@arbor/config";
import { RetryContextStore } from "./retry-context-store.js";

const retryStores = new WeakMap<ArborRuntime, RetryContextStore>();

function retryStore(runtime: ArborRuntime): RetryContextStore {
  const existing = retryStores.get(runtime);
  if (existing) return existing;
  const created = new RetryContextStore(runtime.persistenceRoot);
  retryStores.set(runtime, created);
  return created;
}

/**
 * The fields extracted from CanonicalLoopPorts, mapped to the names
 * CampaignLoopConfig expects. Spreading this into a CampaignLoopConfig
 * literal wires all five real ports: telemetry, interruptions,
 * output_evidence (from outputCapture), token_economy (a full
 * TokenEconomyConfig built from tokenEpochs + the runtime's live model
 * capability adapter), and communications (from selectionCommunications).
 */
export interface LoopConfigPorts {
  readonly telemetry?: import("./loop-adapters.js").ManagerTelemetryPort;
  readonly interruptions?: import("./loop-adapters.js").CanonicalLoopPorts["interruptions"];
  readonly output_evidence?: import("./loop-adapters.js").ManagerOutputEvidenceCapturePort;
  readonly token_economy?: TokenEconomyConfig;
  readonly communications?: import("./loop-adapters.js").ManagerSelectionCommunicationPort;
  /** Durable campaign-local governed overlay checkpoint for the production loop. */
  readonly governed_context: GovernedOverlayCheckpointPort;
  readonly retry_context: CampaignRetryContextPort;
  readonly foreground: {
    derive(input: { campaign_id: string; node_id: string; agent: string; capability: "specialist" | "critic" }): { readonly prompt_fragment: string };
  };
  readonly structural_compaction: {
    compact(input: { campaign_id: string; node_id: string; iteration: number; signal?: AbortSignal }): Promise<
      | { status: "completed"; pre_evidence_id: string; post_evidence_id: string; anchor_summary_id: string }
      | { status: "skipped" | "interrupted" | "failed"; reason: string }
    >;
  };
}

/**
 * G-30 (originally identified under G-09): `CampaignLoopConfig.token_economy`
 * is a full `TokenEconomyConfig` — `{epochs, provider, fallback_capability,
 * reserved_output_tokens, requested_output_tokens, expansion_id, ...}` — not
 * the bare `TokenEpochService` this helper used to hand back as
 * `token_economy`. Every real dispatch calls `prepareTokenDispatch`, which
 * reads `config.token_economy.provider`; with only the bare epoch service
 * that was `undefined` and dispatch threw before any specialist ran, on
 * every real call site, silently swallowed by callers' bare `catch` blocks.
 *
 * This composes the real thing: the epoch service nests under `.epochs`,
 * `.provider` comes from the runtime's own live model-capability adapter via
 * `modelCapabilityTokenBridge` (falls back to `fallback_capability`'s
 * operational defaults when no live provider capability is attached — not a
 * price schedule; pricing stays out of scope), and `expansion_id` derives a
 * stable, replay-safe identity from campaign/node/phase.
 */
interface StructuralContextSnapshot {
  readonly entries: readonly StructuralContextEntry[];
  /** Every durable communication identity represented by the committed anchor. */
  readonly covered_communication_ids: readonly string[];
}

function structuralEntries(runtime: ArborRuntime, campaignId: string, nodeId: string): StructuralContextEntry[] {
  return [...structuralSnapshot(runtime, campaignId, nodeId).entries];
}

function structuralSnapshot(runtime: ArborRuntime, campaignId: string, nodeId: string): StructuralContextSnapshot {
  let lifecycles: ReturnType<ArborRuntime["manager"]["getCompactionLifecycles"]>;
  try {
    lifecycles = runtime.manager.getCompactionLifecycles(campaignId, nodeId);
  } catch {
    // Token preparation is also used by standalone adapters before a campaign
    // exists. Typed absence means no structural entries, never a fabricated
    // anchor and never a failure in an otherwise valid dispatch preparation.
    return Object.freeze({ entries: Object.freeze([]), covered_communication_ids: Object.freeze([]) });
  }
  // A later interrupted/failed attempt cannot erase the last usable anchor.
  // The ledger record still supplies the guard; the effective-history cutoff
  // is specifically the newest *completed* lifecycle.
  const latest = [...lifecycles].reverse().find((record) => record.lifecycle.status === "completed");
  const anchor = latest?.lifecycle.anchor_summary_id
    ? readCommittedAnchor(runtime, campaignId, nodeId, latest.id, latest.lifecycle)
    : null;
  const covered = new Set(anchor?.covered_communication_ids ?? []);
  const communications = runtime.manager.getNodeCommunications(campaignId, nodeId, "critic", 100)
    // Never use caller-controlled message timestamps as the losslessness
    // boundary. The anchor names the exact durable records it covers, so a
    // record appended during capture (even with an older timestamp) remains
    // an unambiguously uncovered live-tail entry on replay.
    .filter((record) => !covered.has(record.id))
    .map((record): StructuralContextEntry => ({
      identity: record.id,
      content_hash: record.content_hash,
      evidence_pointer: `audit://communications/${record.id}`,
      provenance: structuredClone(record.communication.payload.provenance),
      visibility: record.communication.capability_tier === "specialist" ? "specialist" : "critic",
      content: record.communication.payload.content,
    }));
  return Object.freeze({
    entries: Object.freeze([...(anchor === null ? [] : [anchor.entry]), ...communications]),
    covered_communication_ids: Object.freeze([...covered]),
  });
}

function readCommittedAnchor(
  runtime: ArborRuntime,
  campaignId: string,
  nodeId: string,
  lifecycleId: string,
  lifecycle: { anchor_summary_id: string | null; pre_evidence_id: string; as_of: string },
): { entry: StructuralContextEntry; covered_communication_ids: readonly string[] } {
  const pointer = lifecycle.anchor_summary_id;
  const artifactId = pointer?.match(/^audit:\/\/output-artifacts\/(.+)$/)?.[1];
  if (!artifactId || !runtime.outputEvidence) throw new Error("completed structural-compaction anchor is unavailable for replay");
  try {
    const record = runtime.outputEvidence.verify(artifactId);
    if (record.campaign_id !== campaignId || record.node_id !== nodeId) throw new Error("completed structural-compaction anchor identity does not match its node");
    const content = Buffer.from(runtime.outputEvidence.readRaw(artifactId, {
      actor: "campaign-runtime", capability: "orchestrator", reason: "rebuild committed structural-compaction anchor",
    })).toString("utf8");
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || (parsed as { kind?: unknown }).kind !== "structural_compaction_anchor/v1"
      || !Array.isArray((parsed as { covered_communication_ids?: unknown }).covered_communication_ids)
      || (parsed as { covered_communication_ids: unknown[] }).covered_communication_ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("completed structural-compaction anchor lacks a valid covered-message identity set");
    }
    const covered = (parsed as { covered_communication_ids: string[] }).covered_communication_ids;
    if (new Set(covered).size !== covered.length || covered.length > 100) throw new Error("completed structural-compaction anchor has an invalid covered-message identity set");
    return {
      entry: {
      identity: `anchor:${lifecycleId}`,
      content_hash: record.sha256,
      evidence_pointer: pointer,
      provenance: { tag: "generated", generator: "structural-compaction", input_hash: lifecycle.pre_evidence_id },
      visibility: "specialist",
      content,
      },
      covered_communication_ids: Object.freeze([...covered]),
    };
  } catch (error) {
    // A missing/corrupt/unauthorized artifact cannot be reconstructed into
    // live context. Do not silently continue with only newer messages: that
    // would drop established facts. The durable lifecycle remains inspectable
    // while the affected dispatch fails closed.
    throw new Error(`completed structural-compaction anchor cannot be replayed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The provider/model identity the token economy plans against.
 *
 * These two fields used to be the literals "arbor-runtime"/"default", which
 * made every epoch indistinguishable: `resolveProviderTokenCapability` looks up
 * by provider and model, so the lookup could only ever miss, `fallback_capability`
 * was always what answered, and a per-model token breakdown was impossible.
 * Observed on the verified campaign: the epoch for a `claude-sonnet-4-6` turn
 * recorded `provider_id: "arbor-runtime", model_id: "default"`.
 */
export interface TokenEconomyModelIdentity {
  readonly provider_id: string;
  readonly model_id: string;
}

function buildTokenEconomy(runtime: ArborRuntime, identity: TokenEconomyModelIdentity | undefined): TokenEconomyConfig {
  const provider_id = identity?.provider_id ?? "arbor-runtime";
  const model_id = identity?.model_id ?? "default";
  const provider = modelCapabilityTokenBridge(runtime.modelCapabilities, provider_id, model_id);
  const structuralContext = { entries: ({ campaign_id, node_id }: { campaign_id: string; node_id: string }) => structuralEntries(runtime, campaign_id, node_id) };
  const structuralPolicy: StructuralFoldPolicy = { max_entries: 50, recent_tail: 5, max_rendered_characters: 12_000 };
  return {
    epochs: runtime.loopPorts.token_epochs,
    provider,
    fallback_capability: {
      provider_id,
      model_id,
      context_capacity: 224_000,
      max_output_tokens: 128_000,
      source: "configured",
    },
    reserved_output_tokens: 4_000,
    requested_output_tokens: 128_000,
    structural_context: structuralContext,
    structural_policy: structuralPolicy,
    overflow_retry_budget: 1,
    overflow_recovery: async ({ prompt, base_prompt, campaign_id, node_id, capability, eligible_input_tokens, count_prompt }) => {
      const entries = structuralContext.entries({ campaign_id, node_id });
      return recoverStructuralOverflowPrompt({ prompt, basePrompt: base_prompt, entries, capability, eligibleInputTokens: eligible_input_tokens, policy: structuralPolicy, countPrompt: count_prompt });
    },
    expansion_id: ({ campaign_id, node_id, phase, attempt_id }) => `${campaign_id}:${node_id}:${attempt_id ?? "unscoped"}:${phase}`,
  };
}

/**
 * Reduces only the optional, explicitly marked structural-context projection.
 * The complete task/system/user prompt stays byte-identical. Candidate folds
 * retain the normal identity/hash/evidence-pointer representation and count
 * omitted entries; each candidate is remeasured by the same provider counter
 * used for admission. The bounded search can return a smaller candidate only
 * when it fits; otherwise dispatch remains suppressed.
 */
async function recoverStructuralOverflowPrompt(input: {
  readonly prompt: string;
  readonly basePrompt: string;
  readonly entries: readonly StructuralContextEntry[];
  readonly capability: ContextCapability;
  readonly eligibleInputTokens: number;
  readonly policy: StructuralFoldPolicy;
  readonly countPrompt: (text: string) => Promise<number>;
}): Promise<string | null> {
  const separator = "\n\nStructural context:\n";
  const projectedLength = input.prompt.length - input.basePrompt.length - separator.length;
  if (projectedLength < 17 || input.entries.length === 0) return null;
  const highestLimit = Math.min(input.policy.max_rendered_characters, projectedLength - 1);
  const attempts = 24;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidateLimit = Math.max(16, Math.floor(highestLimit - ((highestLimit - 16) * (attempt + 1)) / attempts));
    const folded = foldStructuralContext(input.entries, input.capability, { ...input.policy, max_rendered_characters: candidateLimit });
    const candidate = `${input.basePrompt}${separator}${folded.rendered}`;
    if (candidate.length < input.prompt.length && await input.countPrompt(candidate) <= input.eligibleInputTokens) return candidate;
  }
  return null;
}

/**
 * Read the real ports already composed on `runtime.loopPorts` and map them
 * to CampaignLoopConfig field names. Returns non-undefined values for all
 * five fields when the runtime provides them.
 */
export function composeLoopConfigPorts(runtime: ArborRuntime, agentConfig: Readonly<Record<string, AgentConfig>> = {}, modelIdentity?: TokenEconomyModelIdentity): LoopConfigPorts {
  return {
    telemetry: runtime.loopPorts.telemetry,
    interruptions: runtime.loopPorts.interruptions,
    output_evidence: runtime.loopPorts.output_evidence,
    token_economy: buildTokenEconomy(runtime, modelIdentity),
    communications: runtime.loopPorts.communications,
    governed_context: {
      checkpoint: (input) => runtime.governedContext.checkpoint(input),
    },
    retry_context: retryStore(runtime),
    foreground: {
      derive: ({ node_id, agent }) => {
        if (!isAgentRole(agent)) throw new Error(`unknown foreground agent ${agent}`);
        const configured = agentConfig[agent];
        const foreground = configured?.foreground;
        const overrides = foreground ? {
          ...(foreground.modes ? { modes: new Set(foreground.modes) } : {}),
          ...(foreground.inputs ? { inputs: foreground.inputs } : {}),
          ...(foreground.outputs ? { outputs: foreground.outputs } : {}),
        } : undefined;
        const modelOverrides = Object.fromEntries(Object.entries(agentConfig).map(([name, value]) => [name, value.model]));
        return deriveDispatchForeground(agent, node_id, overrides, undefined, modelOverrides);
      },
    },
    structural_compaction: {
      compact: async ({ campaign_id, node_id, iteration, signal }) => {
        // Establish the preimage boundary before any asynchronous capture.
        // Messages arriving during capture stay in the post-anchor live tail.
        const snapshotAsOf = new Date().toISOString();
        const snapshot = structuralSnapshot(runtime, campaign_id, node_id);
        const entries = snapshot.entries;
        if (entries.length === 0) return { status: "skipped", reason: "no durable structural context entries are available" };
        if (entries.every((entry) => entry.identity.startsWith("anchor:"))) {
          return { status: "skipped", reason: "no uncovered durable structural context entries are available" };
        }
        const pre = JSON.stringify({ kind: "structural_context_preimage", entries });
        const inputHash = createHash("sha256").update(pre).digest("hex");
        const provenance = { tag: "generated" as const, generator: "structural-compaction", input_hash: inputHash };
        const preEvidence = await runtime.loopPorts.output_evidence.capture({ campaign_id, node_id, kind: "tool", content: pre, provenance });
        const recordInterrupted = (reason: string, partial_evidence_ids: string[] = [preEvidence.evidence_pointer]) => {
          runtime.manager.recordCompactionLifecycle({
            campaign_id, node_id, operation_id: `structural-fold:${campaign_id}:${node_id}:${iteration}`,
            trigger: "auto", strategy: "structural_folding", status: "interrupted",
            pre_evidence_id: preEvidence.evidence_pointer, post_evidence_id: null, anchor_summary_id: null,
            reason, partial_evidence_ids,
            idempotency_key: `structural-fold:${campaign_id}:${node_id}:${iteration}:${inputHash}`, as_of: snapshotAsOf,
          });
          return { status: "interrupted" as const, reason };
        };
        if (signal?.aborted) return recordInterrupted(cancellationReason(signal));
        try {
          const folded = foldStructuralContext(entries, "specialist", { max_entries: 50, recent_tail: 5, max_rendered_characters: 12_000 });
          if (signal?.aborted) return recordInterrupted(cancellationReason(signal));
          const covered = new Set(snapshot.covered_communication_ids);
          for (const entry of entries) if (!entry.identity.startsWith("anchor:")) covered.add(entry.identity);
          // The postimage is the anchor plus the exact durable coverage set;
          // it is intentionally bounded by the 100-entry structural read.
          const postimage = JSON.stringify({
            kind: "structural_compaction_anchor/v1",
            // Structural reads are bounded to 100 records. Keep exactly that
            // trailing identity window too, or two legitimate folds could
            // grow the postimage beyond the replay validator's hard cap.
            covered_communication_ids: [...covered].slice(-100),
            fold: JSON.parse(folded.rendered),
          });
          const postEvidence = await runtime.loopPorts.output_evidence.capture({ campaign_id, node_id, kind: "tool", content: postimage, provenance });
          if (signal?.aborted) return recordInterrupted(cancellationReason(signal), [preEvidence.evidence_pointer, postEvidence.evidence_pointer]);
          runtime.manager.recordCompactionLifecycle({
            campaign_id, node_id, operation_id: `structural-fold:${campaign_id}:${node_id}:${iteration}`,
            trigger: "auto", strategy: "structural_folding", status: "completed",
            pre_evidence_id: preEvidence.evidence_pointer, post_evidence_id: postEvidence.evidence_pointer,
            anchor_summary_id: postEvidence.evidence_pointer, reason: "", partial_evidence_ids: [],
            idempotency_key: `structural-fold:${campaign_id}:${node_id}:${iteration}:${inputHash}`, as_of: snapshotAsOf,
          });
          return { status: "completed", pre_evidence_id: preEvidence.evidence_pointer, post_evidence_id: postEvidence.evidence_pointer, anchor_summary_id: postEvidence.evidence_pointer };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          runtime.manager.recordCompactionLifecycle({
            campaign_id, node_id, operation_id: `structural-fold:${campaign_id}:${node_id}:${iteration}`,
            trigger: "auto", strategy: "structural_folding", status: "failed",
            pre_evidence_id: preEvidence.evidence_pointer, post_evidence_id: null, anchor_summary_id: null,
            reason, partial_evidence_ids: [preEvidence.evidence_pointer],
            idempotency_key: `structural-fold:${campaign_id}:${node_id}:${iteration}:${inputHash}`, as_of: snapshotAsOf,
          });
          return { status: "failed", reason };
        }
      },
    },
  };
}

function cancellationReason(signal: AbortSignal): string {
  if (signal.reason instanceof Error && signal.reason.message) return signal.reason.message;
  if (typeof signal.reason === "string" && signal.reason) return signal.reason;
  return "structural compaction cancelled";
}

/**
 * A real `AgentDefinitionSource` (A-7) built from the same botanical agent
 * catalog `@arbor/opencode` uses to register the 11 live agents with
 * opencode (`buildAllAgents`) and to gate KB tiers (`CAPABILITY_TIER`) — not
 * a hand-authored second copy of agent metadata. `runtime.ts`'s
 * `AgentDefinitionSource` interface is deliberately shaped so `@arbor/mcp`'s
 * core (`runtime.ts`, `agent-registry.ts`) never imports `@arbor/opencode`
 * directly; this function is the concrete implementation, composed only at
 * this CLI-leaf boundary (same pattern as `composeLoopConfigPorts` above and
 * `recovery-lease-adapter.ts`).
 */
export function buildAgentDefinitionSource(): AgentDefinitionSource {
  const configs = buildAllAgents();
  const definitions: AgentDefinition[] = Object.keys(configs)
    .filter(isAgentRole)
    .map((name) => ({
      name,
      tier: CAPABILITY_TIER[name],
      description: configs[name].description,
    }));
  return { definitions: () => definitions };
}
