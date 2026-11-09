import { randomUUID } from "node:crypto";
import type { ServerTool } from "./server.js";
import type { CampaignManager } from "./manager.js";
import { isVerificationCheck, validateRuntimeQuery, enforceAction, CapabilityError, OPERATOR_VOCABULARY, type Provenance, type CapabilityTier, type GateType } from "@arbor/core";
import { RUNTIME_CATALOG, runtimeOperationHints, type RuntimeCatalogRouter } from "./runtime-catalog.js";
import { defaultGateRemediation, isGateRefusalProjection, projectGateRecord, projectGateUnavailable } from "./gate-refusal-projection.js";
import { MCP_SERVER_OPERATIONS } from "./mcp-operation-manifest.js";

/** A real sha256 content anchor: `sha256:` followed by 64 lowercase hex digits. */
const SHA256_ANCHOR_RE = /^sha256:[0-9a-f]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Boundary shape/format gate for `arbor_record_result`'s `provenance` field (A-1).
 *
 * The MCP tool schema can only declare `provenance: { type: "object" }` for
 * discovery purposes — a full JSON Schema `oneOf` isn't enforced by this
 * server (`inputSchema` is descriptive only, see `server.ts#listTools`). This
 * function is the actual enforcement: it rejects any object that isn't a
 * well-formed member of the `Provenance` union, closing the "any object
 * passes through an unchecked cast" gap.
 *
 * Shape only: for `tag: "verified"` this checks that `stdout_hash` is
 * well-formed (`sha256:<64 hex>`) — well-formedness, not authenticity. That a
 * caller-supplied hash was actually produced by running `cmd` cannot be
 * checked here (no command runs on this path). Every `tag: "verified"` result
 * this function returns is downgraded before it can reach `recordResult` —
 * see `refuseUnauthenticatedVerified` below, the function that actually
 * closes A-1's residual risk.
 */
function validateProvenance(value: unknown): Provenance {
  if (typeof value !== "object" || value === null) {
    throw new Error("provenance must be an object");
  }
  const v = value as Record<string, unknown>;
  switch (v.tag) {
    case "verified": {
      if (!isNonEmptyString(v.cmd)) throw new Error("provenance(tag=verified) requires a non-empty cmd");
      if (v.exit !== 0) throw new Error("provenance(tag=verified) requires exit code 0");
      if (typeof v.stdout_hash !== "string" || !SHA256_ANCHOR_RE.test(v.stdout_hash)) {
        throw new Error("provenance(tag=verified) requires stdout_hash matching sha256:<64 lowercase hex chars>");
      }
      if (v.check !== undefined && !isVerificationCheck(v.check)) {
        throw new Error("provenance(tag=verified) check must use a closed kind and breadth");
      }
      return { tag: "verified", cmd: v.cmd, exit: v.exit, stdout_hash: v.stdout_hash, ...(v.check === undefined ? {} : { check: v.check }) };
    }
    case "claimed": {
      if (!isNonEmptyString(v.claimant)) throw new Error("provenance(tag=claimed) requires a non-empty claimant");
      return { tag: "claimed", claimant: v.claimant };
    }
    case "critic_approved": {
      if (!isNonEmptyString(v.critic)) throw new Error("provenance(tag=critic_approved) requires a non-empty critic");
      if (!isNonEmptyString(v.rationale)) throw new Error("provenance(tag=critic_approved) requires a non-empty rationale");
      return { tag: "critic_approved", critic: v.critic, rationale: v.rationale };
    }
    case "generated": {
      if (!isNonEmptyString(v.generator)) throw new Error("provenance(tag=generated) requires a non-empty generator");
      if (!isNonEmptyString(v.input_hash)) throw new Error("provenance(tag=generated) requires a non-empty input_hash");
      return { tag: "generated", generator: v.generator, input_hash: v.input_hash };
    }
    default:
      throw new Error(`provenance.tag must be one of ${Object.keys(OPERATOR_VOCABULARY.provenance_tag).join("|")}, got ${JSON.stringify(v.tag)}`);
  }
}

/**
 * Closes A-1's residual risk: refuses caller-asserted `verified` provenance
 * at the external MCP boundary. Design (b) from the remediation brief —
 * downgrade, don't re-verify server-side.
 *
 * Rejected: design (a), the server running the verification command itself
 * (mirroring `opencode-executor.ts`'s real `runVerification`). The only
 * candidate command to run here is the caller-supplied `provenance.cmd` —
 * there is no other one in scope at this boundary — so "the server runs the
 * verification" would mean executing an external caller's shell command
 * inside this process on the strength of an MCP call. That trades a
 * forgeable-hash problem for a strictly worse one (remote command execution
 * triggered by an untrusted MCP client) and was rejected on that basis. The
 * internal path that legitimately produces `verified` provenance
 * (`opencode-executor.ts`'s `runVerification`, and
 * `opencode-server-executor.ts`'s equivalent) already runs a *server-chosen*
 * command inside a worktree the process itself created and hashes real
 * captured output, then calls `CampaignManager.recordResult` directly —
 * never through `arbor_record_result` — so it is untouched by this refusal.
 *
 * Invariant established: a `verified` TreeNode's `stdout_hash` was derived by
 * this process from real output it observed. This boundary cannot establish
 * that for anything a caller sends it, so `tag: "verified"` supplied via
 * `arbor_record_result` is downgraded to `tag: "claimed"` unconditionally —
 * regardless of how well-formed the hash is — before it reaches
 * `recordResult`. A forged-but-well-formed hash can no longer produce a
 * `verified` node through this path, because no hash supplied through this
 * path can, ever.
 *
 * Residual, stated plainly: this closes *this* boundary. It does not
 * authenticate the internal path's own inputs (the specialist's real command
 * still runs unsandboxed inside the worktree it's given — a separate trust
 * boundary, ADR-024's, not this one) and it does not stop a caller from
 * spamming `claimed` results; `claimed` was never the strongest tier and
 * carries no such invariant to forge.
 */
function refuseUnauthenticatedVerified(provenance: Provenance, claimant: string): Provenance {
  if (provenance.tag !== "verified") return provenance;
  if (!isNonEmptyString(claimant)) {
    throw new Error("specialist_agent must be a non-empty string (needed as the claimant for a downgraded verified→claimed provenance)");
  }
  return { tag: "claimed", claimant };
}

/**
 * S04 (audit/2026-09-06-remediation/manifest.md): `arbor_select_node`,
 * `arbor_expand_node`, `arbor_record_result` and `arbor_interrupt_campaign`
 * call `CampaignManager` directly — unlike `arbor_start_campaign`/
 * `arbor_branch`/`arbor_prune`, none of them go through
 * `RuntimeCatalogRouter.dispatchCommand`, so none of them inherited its
 * ADR-028 tier gate. For selection, expansion and result-recording there is
 * no canonical `RuntimeCatalogRouter` command kind to alias in the first
 * place (`campaign.tree` is the only catalog entry in that neighborhood, and
 * it is a read) — `CampaignManager` itself must stay callable by the
 * in-process orchestrator loop (`opencode-executor.ts`) with no tier check,
 * since these are its core scheduling primitives, not a caller-facing
 * authorization surface. `arbor_interrupt_campaign` DOES have a canonical
 * `tree.interrupt` command kind, but routing it through `dispatchCommand`
 * would change its result shape from `manager.interrupt`'s own
 * `{affected_node_ids, version}`/`{error}` shape to the router's
 * `{accepted, operation_id, error?}` acknowledgement — a breaking change to
 * `server.test.ts`'s pinned contract, which is outside this fix's file
 * ownership. So every one of these four tools is gated the same way: here,
 * at the external MCP tool boundary, using the same `enforceAction`
 * primitive `RuntimeCatalogRouter` itself uses (ADR-028), without changing
 * any tool's result shape.
 *
 * `callerTier` defaults to `"senior"`, matching `RuntimeRouterOptions.
 * caller_tier`'s own omit-to-grant convention, so every existing caller of
 * `defineTools` keeps its current behavior unless it explicitly threads a
 * tier through.
 */
function tierDenial(callerTier: CapabilityTier, action: string): { ok: false; error: string } | null {
  try {
    enforceAction("preview-confirm", callerTier, action);
    return null;
  } catch (e) {
    if (e instanceof CapabilityError) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * A-4 (audit/30-hollow-and-traceability.md), closed: most
 * `RuntimeCatalogRouter` command/query kinds (job.submit,
 * approval.approve/reject, campaign.halt, task.retry, recovery.retry/abandon,
 * userinput.answer, surveillance.scan, bus.record, compaction.record, ...)
 * are real, tested dispatch handlers that used to have no
 * standard-MCP-client-discoverable tool — reachable only through the bespoke
 * `arbor_command`/`arbor_query` JSON-RPC methods in `cli.ts` (and the
 * `/api/runtime/command`/`/api/runtime/query` HTTP routes in `webui.ts`),
 * neither of which `tools/list` ever enumerated.
 *
 * Design chosen: two generic pass-through tools (`arbor_command`,
 * `arbor_query`) plus a catalog-search tool over hand-written per-kind tools. Per-kind tools would
 * mean re-declaring, in JSON Schema, the exact field contract each
 * `*-contracts.ts` file (and `@arbor/core`'s `ApplicationCommand`/
 * `ApplicationQuery` unions) already owns — a second, drift-prone copy of a
 * contract this package already has one source of truth for (DRY). A generic
 * envelope keeps `RuntimeCatalogRouter` the single command/query authority
 * (never a second one, per this project's standing rule) and needs no
 * per-kind maintenance when a new kind is added to `RUNTIME_CATALOG`.
 *
 * `inputSchema` for both tools is honest about what it verifies: it can only
 * advertise the `kind` discriminator (enumerated live from `RUNTIME_CATALOG`,
 * so it can't drift) plus a generic envelope shape — nothing at the MCP
 * framework layer enforces per-kind field shapes (`inputSchema` is
 * descriptive only, see `server.ts#listTools`). Real validation for every
 * kind already happens one layer down, inside `dispatchCommand`/
 * `executeQuery` themselves (`validateRuntimeCommand`, `validateJobCommand`,
 * `validateApprovalRequest`, ... — the same per-kind validators the bespoke
 * cli.ts/webui.ts callers already relied on), so nothing here is a fresh,
 * unvalidated cast — it mirrors `validateProvenance`'s role for
 * `arbor_record_result` above, one layer further out.
 *
 * Trust boundary, spelled out once here so it isn't re-conflated: this file's
 * `arbor_command`/`arbor_query` are BROAD — their `kind` enum is generated
 * live from every `RUNTIME_CATALOG` entry, so any external MCP client
 * driving `arbor serve` can dispatch ANY catalog kind (project.*, task.*,
 * bus.*, campaign.*, ...) subject only to the per-kind validators and the
 * caller's own capability/tier, same as cli.ts's JSON-RPC methods and
 * webui.ts's HTTP routes. `native-tool-host.ts` is a SEPARATE, deliberately
 * NARROW surface: it hands a dispatched native sub-agent only 12 sandboxed
 * repository/file/shell/git/evidence tools, not this catalog. Do not read
 * native-tool-host.ts's narrow tool list as evidence that MCP clients can't
 * reach `project.*`/`task.*`/`bus.*` — they can, through the tools defined
 * in this file; the two surfaces have different callers and different trust
 * boundaries.
 */
export function defineTools(manager: CampaignManager, runtimeCatalog: RuntimeCatalogRouter, callerTier: CapabilityTier = "senior"): ServerTool[] {
  const commandKinds = RUNTIME_CATALOG.filter((entry) => entry.direction === "command").map((entry) => entry.kind);
  const queryKinds = RUNTIME_CATALOG.filter((entry) => entry.direction === "query").map((entry) => entry.kind);
  return [
    {
      name: MCP_SERVER_OPERATIONS.start_campaign,
      annotations: { title: "arbor_start_campaign", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "Deprecated: use arbor_command with kind=campaign.start and campaign_id instead of id. This compatibility alias uses the same command authority and returns its canonical acknowledgement; inspect value.accepted for the outcome.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Unique campaign ID" },
          plan_path: { type: "string", description: "Path to the plan file" },
          root_action: {
            type: "object",
            properties: {
              description: { type: "string" },
              estimated_gain: { type: "number" },
              estimated_cost: { type: "number" },
              category: { type: "string" },
              delegate_to: { type: "string" },
              constraints: { type: "array", items: { type: "string" } },
              skill_id: { type: "string", description: "Optional governed skill id; requires skill_version" },
              skill_version: { type: "string", description: "Exact immutable SemVer for skill_id" },
            },
            required: ["description", "estimated_gain", "estimated_cost", "category", "delegate_to"],
          },
          config: {
            type: "object",
            properties: {
              max_seconds: { type: "number" },
              min_score: { type: "number" },
              convergence_iterations: { type: "number" },
              exploration_constant: { type: "number" },
            },
          },
        },
        required: ["id", "plan_path", "root_action"],
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          return runtimeCatalog.dispatchCommand(toArborCommandEnvelope({
            kind: "campaign.start",
            campaign_id: args.id,
            plan_path: args.plan_path,
            root_action: args.root_action,
            ...(args.config === undefined ? {} : { config: args.config }),
          }));
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.select_node,
      annotations: { title: "arbor_select_node", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "Select the next node to expand via UCT scoring. Requires senior capability; a junior caller is refused.",
      inputSchema: {
        type: "object" as const,
        properties: {
          campaign_id: { type: "string" },
          ctx: {
            type: "object",
            properties: {
              accuracy_regression_rate: { type: "number" },
              crash_regression_rate: { type: "number" },
              best_known: { type: "number" },
              total_visits: { type: "number" },
            },
            required: ["accuracy_regression_rate", "crash_regression_rate", "best_known", "total_visits"],
          },
        },
        required: ["campaign_id", "ctx"],
      },
      handler: async (args: Record<string, unknown>) => {
        const denial = tierDenial(callerTier, "arbor_select_node");
        if (denial) return denial;
        try {
          const nodeId = manager.selectNode(
            args.campaign_id as string,
            args.ctx as Parameters<CampaignManager["selectNode"]>[1],
          );
          return { node_id: nodeId };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.expand_node,
      annotations: { title: "arbor_expand_node", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "Expand a node: run isolation gate, mark expanding. Requires senior capability; a junior caller is refused.",
      inputSchema: {
        type: "object" as const,
        properties: {
          campaign_id: { type: "string" },
          node_id: { type: "string" },
          isolation_check: {
            type: "object",
            properties: {
              worktree_isolated: { type: "boolean" },
              starting_commit_correct: { type: "boolean" },
              lease_acquired: { type: "boolean" },
            },
            required: ["worktree_isolated", "starting_commit_correct", "lease_acquired"],
          },
        },
        required: ["campaign_id", "node_id", "isolation_check"],
      },
      handler: async (args: Record<string, unknown>) => {
        const denial = tierDenial(callerTier, "arbor_expand_node");
        if (denial) return denial;
        try {
          const result = manager.expandNode(
            args.campaign_id as string,
            args.node_id as string,
            args.isolation_check as Parameters<CampaignManager["expandNode"]>[2],
          );
          if (result.ok) return result;
          // ADR-118: attach the versioned isolation-gate refusal projection
          // alongside the existing `gate` field (unchanged, for any caller
          // already reading it) so an MCP caller gets the owning gate,
          // evidence deficit, and remediation without re-deriving them from
          // the raw `GateResult`.
          const refusal = projectGateRecord(result.gate, defaultGateRemediation(result.gate.gate));
          if (refusal !== null && !isGateRefusalProjection(refusal)) {
            throw new Error("isolation gate refusal projection failed its own boundary validation");
          }
          return { ...result, refusal };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.record_result,
      annotations: { title: "arbor_record_result", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Record a Specialist's result with Critic verdict. Determines verified vs claimed. " +
        "A 'verified' provenance tag submitted here is always downgraded to 'claimed': " +
        "this external boundary cannot authenticate that a caller-supplied stdout_hash came " +
        "from a real command it ran, so it never grants the 'verified' tier on its own say-so. " +
        "Requires senior capability; a junior caller is refused.",
      inputSchema: {
        type: "object" as const,
        properties: {
          campaign_id: { type: "string" },
          node_id: { type: "string" },
          specialist_output: { type: "string" },
          specialist_agent: { type: "string" },
          provenance: {
            description:
              "One member of the Provenance union. A well-formed 'verified' entry is accepted " +
              "syntactically but downgraded to 'claimed' before it reaches the manager — this " +
              "boundary cannot verify the hash's authenticity, so it never retires a branch as " +
              "verified from a caller's claim alone.",
            oneOf: [
              {
                type: "object",
                properties: {
                  tag: { const: "verified" }, cmd: { type: "string" }, exit: { const: 0 }, stdout_hash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
                  check: {
                    type: "object",
                    properties: {
                      kind: { enum: ["shell_command", "internal_integrity"] },
                      breadth: { enum: ["suite", "subset", "single"] },
                    },
                    required: ["kind", "breadth"],
                  },
                },
                required: ["tag", "cmd", "exit", "stdout_hash"],
              },
              {
                type: "object",
                properties: { tag: { const: "claimed" }, claimant: { type: "string" } },
                required: ["tag", "claimant"],
              },
              {
                type: "object",
                properties: { tag: { const: "critic_approved" }, critic: { type: "string" }, rationale: { type: "string" } },
                required: ["tag", "critic", "rationale"],
              },
              {
                type: "object",
                properties: { tag: { const: "generated" }, generator: { type: "string" }, input_hash: { type: "string" } },
                required: ["tag", "generator", "input_hash"],
              },
            ],
          },
          critic_agent: { type: "string" },
          critic_approved: { type: "boolean" },
          critic_rationale: { type: "string" },
          critic_root_cause: { type: "string" },
          score_ctx: { type: "object" },
        },
        required: ["campaign_id", "node_id", "specialist_output", "specialist_agent", "provenance", "critic_agent", "critic_approved", "critic_rationale", "score_ctx"],
      },
      handler: async (args: Record<string, unknown>) => {
        const denial = tierDenial(callerTier, "arbor_record_result");
        if (denial) return denial;
        try {
          const result = manager.recordResult(
            args.campaign_id as string,
            args.node_id as string,
            {
              specialist_output: args.specialist_output as string,
              specialist_agent: args.specialist_agent as string,
              provenance: refuseUnauthenticatedVerified(validateProvenance(args.provenance), args.specialist_agent as string),
              critic_agent: args.critic_agent as string,
              critic_approved: args.critic_approved as boolean,
              critic_rationale: args.critic_rationale as string,
              critic_root_cause: args.critic_root_cause as string | undefined,
              score_ctx: args.score_ctx as Parameters<CampaignManager["recordResult"]>[2]["score_ctx"],
            },
          );
          return result;
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.branch,
      annotations: { title: "arbor_branch", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: "Deprecated: use arbor_command with kind=tree.branch and node_id instead of parent_id. This compatibility alias uses the same command authority and returns its canonical acknowledgement, not child_ids; query campaign.tree to inspect children.",
      inputSchema: {
        type: "object" as const,
        properties: {
          campaign_id: { type: "string" },
          parent_id: { type: "string" },
          actions: { type: "array", items: { type: "object" } },
        },
        required: ["campaign_id", "parent_id", "actions"],
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          return runtimeCatalog.dispatchCommand(toArborCommandEnvelope({
            kind: "tree.branch",
            campaign_id: args.campaign_id,
            node_id: args.parent_id,
            actions: args.actions,
          }));
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.prune,
      annotations: { title: "arbor_prune", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description: "Deprecated: use arbor_command with kind=tree.prune. This compatibility alias uses the same command authority and returns its canonical acknowledgement; inspect value.accepted for the outcome.",
      inputSchema: {
        type: "object" as const,
        properties: {
          campaign_id: { type: "string" },
          node_id: { type: "string" },
        },
        required: ["campaign_id", "node_id"],
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          return runtimeCatalog.dispatchCommand(toArborCommandEnvelope({
            kind: "tree.prune",
            campaign_id: args.campaign_id,
            node_id: args.node_id,
          }));
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.halt_check,
      annotations: { title: "arbor_halt_check", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Check whether the campaign should halt",
      inputSchema: {
        type: "object" as const,
        properties: {
          campaign_id: { type: "string" },
        },
        required: ["campaign_id"],
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          return { ...manager.haltStatus(args.campaign_id as string), halt: manager.recordedHalt(args.campaign_id as string) };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.gate_status,
      annotations: { title: "arbor_gate_status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Read the latest recorded outcome of one process gate (admission, isolation, evidence, or audit) for a campaign as " +
        "a versioned refusal projection (ADR-118): owning gate, evidence deficit, and remediation. `projection: null` means " +
        "the gate has recorded no refusal (a pass, or not yet checked) — never returned when the campaign itself could not " +
        "be read, which is reported as an explicit `unavailable` projection instead.",
      inputSchema: {
        type: "object" as const,
        properties: {
          campaign_id: { type: "string" },
          gate: { type: "string", enum: Object.keys(OPERATOR_VOCABULARY.gate) },
        },
        required: ["campaign_id", "gate"],
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          const campaignId = args.campaign_id as string;
          const gate = args.gate as GateType;
          const snapshot = manager.getCampaignSnapshot(campaignId);
          const remediation = defaultGateRemediation(gate);
          if (snapshot === null) {
            const projection = projectGateUnavailable({
              gate,
              code: "campaign_source_unavailable",
              reason: `campaign ${campaignId} is not composed in this runtime; its ${gate} gate history cannot be read`,
              remediation: "Verify the campaign id and that it was admitted in this runtime instance, then retry.",
            });
            if (!isGateRefusalProjection(projection)) throw new Error("gate unavailable projection failed its own boundary validation");
            return { ok: true, projection };
          }
          const latest = [...snapshot.nodes.flatMap((node) => node.gate_records)].reverse()
            .find((record) => record.gate === gate && record.result !== "pass") ?? null;
          const projection = latest === null ? null : projectGateRecord(latest, remediation);
          if (projection !== null && !isGateRefusalProjection(projection)) throw new Error("gate refusal projection failed its own boundary validation");
          return { ok: true, projection };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.kb_read,
      annotations: { title: "arbor_kb_read", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Read a single KB entry by ID (envelope-wrapped, capability-gated)",
      inputSchema: {
        type: "object" as const,
        properties: {
          campaign_id: { type: "string" },
          entry_id: { type: "string" },
          tier: { type: "string", enum: ["orchestrator", "specialist", "critic", "auditor"] },
        },
        required: ["campaign_id", "entry_id", "tier"],
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          return manager.kbRead(
            args.campaign_id as string,
            args.entry_id as string,
            { tier: args.tier as "orchestrator" | "specialist" | "critic" | "auditor" },
          );
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.kb_query,
      annotations: { title: "arbor_kb_query", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Query KB entries by campaign and filter",
      inputSchema: {
        type: "object" as const,
        properties: {
          campaign_id: { type: ["string", "null"] },
          filter: { type: "object" },
          tier: { type: "string", enum: ["orchestrator", "specialist", "critic", "auditor"] },
        },
        required: ["tier"],
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          return manager.kbQuery(
            (args.campaign_id as string | null) ?? null,
            (args.filter as Parameters<CampaignManager["kbQuery"]>[1]) ?? null,
            { tier: args.tier as "orchestrator" | "specialist" | "critic" | "auditor" },
          );
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.kb_inject,
      annotations: { title: "arbor_kb_inject", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Inject relevant KB entries into a prompt string",
      inputSchema: {
        type: "object" as const,
        properties: {
          prompt: { type: "string" },
          campaign_id: { type: "string" },
          tier: { type: "string", enum: ["orchestrator", "specialist", "critic", "auditor"] },
        },
        required: ["prompt", "campaign_id", "tier"],
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          const result = manager.kbInject(
            args.prompt as string,
            args.campaign_id as string,
            { tier: args.tier as "orchestrator" | "specialist" | "critic" | "auditor" },
          );
          return { prompt: result };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.interrupt_campaign,
      annotations: { title: "arbor_interrupt_campaign", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description: "Interrupt a node or owned subtree, routing through the canonical tree.interrupt command with durable request/ack/state evidence",
      inputSchema: {
        type: "object" as const,
        properties: {
          campaign_id: { type: "string" },
          node_id: { type: "string" },
          scope: { type: "string", enum: ["node", "subtree"], description: "node (single) or subtree (owned descendants)" },
          reason: { type: "string", description: "Human-readable interruption reason" },
          operation_id: { type: "string", description: "Optional stable interruption operation identity" },
          expected_version: { type: "string", description: "Expected campaign snapshot version" },
        },
        required: ["campaign_id", "node_id", "scope"],
      },
      handler: async (args: Record<string, unknown>) => {
        const denial = tierDenial(callerTier, "arbor_interrupt_campaign");
        if (denial) return denial;
        try {
          const campaignId = args.campaign_id as string;
          const nodeId = args.node_id as string;
          const scope = args.scope as "node" | "subtree";
          const expected = (args.expected_version as string) ?? manager.getCampaignVersion(campaignId);
          return manager.interrupt({
            campaign_id: campaignId,
            node_id: nodeId,
            operation_id: (args.operation_id as string) ?? `mcp-interrupt-${campaignId}-${nodeId}`,
            scope,
            reason: (args.reason as string) ?? "mcp_operator",
            expected_version: expected,
            provenance: { tag: "generated", generator: "arbor-mcp-tool", input_hash: `interrupt:${campaignId}:${nodeId}:${scope}` },
            acknowledge: () => {},
          });
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.get_state,
      annotations: { title: "arbor_get_state", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Get the current state of a campaign",
      inputSchema: {
        type: "object" as const,
        properties: {
          campaign_id: { type: "string" },
        },
        required: ["campaign_id"],
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          const status = manager.haltStatus(args.campaign_id as string);
          const halt = manager.recordedHalt(args.campaign_id as string);
          const stats = manager.auditCampaign(args.campaign_id as string);
          return { status, halt, stats };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.catalog_search,
      annotations: { title: "arbor_catalog_search", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Search the closed runtime catalog by kind or capability. Returns complete catalog records derived directly from RUNTIME_CATALOG; use a returned kind with arbor_command or arbor_query.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 256, description: "Whitespace-separated kind or capability terms." },
          direction: { type: "string", enum: ["command", "query"], description: "Optional catalog direction filter." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.query !== "string" || !args.query.trim() || Buffer.byteLength(args.query, "utf8") > 256) return { ok: false, error: "query must be a non-empty string no larger than 256 bytes" };
        if (args.direction !== undefined && args.direction !== "command" && args.direction !== "query") return { ok: false, error: "direction must be command or query" };
        const terms = args.query.toLowerCase().trim().split(/\s+/u);
        const matches = RUNTIME_CATALOG
          .filter((entry) => args.direction === undefined || entry.direction === args.direction)
          .filter((entry) => {
            const unavailableReason = entry.supported ? "" : ((entry as { unavailable_reason?: string }).unavailable_reason ?? "");
            const searchable = [entry.kind, entry.capability, entry.idempotency, entry.supported ? "supported" : "unsupported", unavailableReason].join(" ").toLowerCase();
            return terms.every((term) => searchable.includes(term));
          })
          .map((entry) => Object.freeze({ ...entry, operation_hints: runtimeOperationHints(entry) }));
        return Object.freeze({ ok: true, matches: Object.freeze(matches), total: matches.length });
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.command,
      annotations: { title: "arbor_command", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        "Dispatch a typed runtime command through RuntimeCatalogRouter.dispatchCommand (A-4) — " +
        "the same single command authority cli.ts's bespoke arbor_command JSON-RPC method and " +
        "webui.ts's /api/runtime/command HTTP route already use. Accepts `{kind, ...command_fields}` " +
        "plus an optional `metadata` object; any missing metadata sub-field (operation_id, " +
        "idempotency_key, correlation_id, actor_id, requested_at) is synthesized. `kind` selects the " +
        "ApplicationCommand/typed-envelope variant to dispatch — see @arbor/core's ApplicationCommand " +
        "union and this package's *-contracts.ts files for the authoritative per-kind field contract; " +
        "this schema only advertises the discriminator, real per-kind validation runs inside " +
        "dispatchCommand itself. Use arbor_catalog_search with direction=command to find kinds and their catalog contracts. " +
        "Known caveat: recovery.retry's `lease` field is validated for shape by @arbor/core but never " +
        "read by executeRecovery — the real lease is minted server-side by " +
        "RecoveryLeaseAuthority.acquireFresh. Supply any well-formed lease object; its contents are " +
        "ignored (tracked as a schema defect outside this package's ownership, see runtime-catalog.ts).",
      inputSchema: {
        type: "object" as const,
        properties: {
          kind: { type: "string", enum: [...commandKinds], description: "Selects the ApplicationCommand/typed-envelope variant to dispatch." },
          metadata: {
            type: "object",
            description: "Optional OperationMetadata (operation_id, idempotency_key, correlation_id, actor_id, requested_at, expected_version). Missing sub-fields are synthesized.",
          },
        },
        required: ["kind"],
        additionalProperties: true,
      },
      handler: async (args: Record<string, unknown>) => runtimeCatalog.dispatchCommand(toArborCommandEnvelope(args)),
    },
    {
      name: MCP_SERVER_OPERATIONS.query,
      annotations: { title: "arbor_query", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Execute a typed runtime query through RuntimeCatalogRouter.executeQuery (A-4) — the same " +
        "single query authority cli.ts's bespoke arbor_query JSON-RPC method and webui.ts's " +
        "/api/runtime/query HTTP route already use. Accepts `{kind, ...query_fields}` plus an optional " +
        "`query_id`; a query_id is synthesized when omitted. `kind` selects the ApplicationQuery/typed- " +
        "envelope variant to execute — see @arbor/core's ApplicationQuery union and this package's " +
        "*-contracts.ts files for the authoritative per-kind field contract; this schema only advertises " +
        "the discriminator, real per-kind validation runs inside executeQuery itself. Use " +
        "arbor_catalog_search with direction=query to find kinds and their catalog contracts. This " +
        "heterogeneous query tool may read external state; its hints describe the broad query surface " +
        "and do not replace per-kind contract review.",
      inputSchema: {
        type: "object" as const,
        properties: {
          kind: { type: "string", enum: [...queryKinds], description: "Selects the ApplicationQuery/typed-envelope variant to execute." },
          query_id: { type: "string", description: "Optional stable query identity. Synthesized when omitted." },
        },
        required: ["kind"],
        additionalProperties: true,
      },
      handler: async (args: Record<string, unknown>) => {
        const envelope = toArborQueryEnvelope(args);
        const result = await runtimeCatalog.executeQuery(envelope);
        if (!result.ok && result.error.code === "validation") {
          const validation = validateRuntimeQuery(envelope);
          // Extension kinds have their own validators. Preserve their diagnostics;
          // only restore details from the canonical core contract it recognizes.
          if (!validation.ok && !validation.violations.some((violation) => violation.path === "query.kind")) {
            return {
              ...result,
              error: {
                ...result.error,
                diagnostic: validation.violations.map((violation) => `${violation.path}: ${violation.message}`).join("; "),
              },
            };
          }
        }
        return result;
      },
    },
  ];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * A caller-supplied `metadata` is honored field-by-field; any missing
 * sub-field is synthesized so a minimal `{kind, ...fields}` call still
 * reaches a real dispatch instead of failing `validateMetadata`'s
 * completeness check (arbor-core/src/runtime-contracts.ts) on an
 * MCP-ergonomics gap cli.ts's/webui.ts's own partial synthesis
 * (`{operation_id, idempotency_key}` only) does not close.
 */
function synthesizedMetadata(supplied: unknown, kind: string): Record<string, unknown> {
  const base = isPlainRecord(supplied) ? supplied : {};
  const tag = `mcp:${kind}:${randomUUID()}`;
  const metadata: Record<string, unknown> = {
    operation_id: nonEmptyString(base.operation_id) ? base.operation_id : tag,
    idempotency_key: nonEmptyString(base.idempotency_key) ? base.idempotency_key : tag,
    correlation_id: nonEmptyString(base.correlation_id) ? base.correlation_id : tag,
    actor_id: nonEmptyString(base.actor_id) ? base.actor_id : "mcp-client",
    requested_at: nonEmptyString(base.requested_at) ? base.requested_at : new Date().toISOString(),
  };
  if (nonEmptyString(base.expected_version)) metadata.expected_version = base.expected_version;
  return metadata;
}

/** Wraps a bare `{kind, metadata?, ...command_fields}` tool call into a RuntimeCommandEnvelope-shaped input. */
function toArborCommandEnvelope(args: Record<string, unknown>): unknown {
  const { kind, metadata, ...commandFields } = args;
  return {
    schema_version: 1,
    metadata: synthesizedMetadata(metadata, typeof kind === "string" ? kind : "command"),
    command: { kind, ...commandFields },
  };
}

/** Wraps a bare `{kind, query_id?, ...query_fields}` tool call into a RuntimeQueryEnvelope-shaped input. */
function toArborQueryEnvelope(args: Record<string, unknown>): unknown {
  const { kind, query_id, ...queryFields } = args;
  return {
    schema_version: 1,
    query_id: nonEmptyString(query_id) ? query_id : `mcp:${typeof kind === "string" ? kind : "query"}:${randomUUID()}`,
    query: { kind, ...queryFields },
  };
}
