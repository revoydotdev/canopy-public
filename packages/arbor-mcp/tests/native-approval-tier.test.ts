import { describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { nativeApprovalAllowedTools } from "../src/cli.js";
import { CampaignManager } from "../src/manager.js";
import { NativeSystemPolicyApprovalPort } from "../src/native-system-policy-approval.js";

// decisions/ADR-PENDING-native-structured-scope-pre-authorization-and-auto-approve.md:
// the auto-approve widening lives in cli.ts's approval composition
// (~"approvals: { decide: ... }"), keyed off `CampaignManager.governanceTierForSession`.
// This exercises the pure decision function that composition calls into --
// `manager.test.ts` covers the session/tier recording it's fed from, and
// `native-tool-host.test.ts` covers the unchanged, unconditional scope
// preflight that runs before any approval decision is ever reached.
describe("nativeApprovalAllowedTools (scope pre-authorization + auto-approve)", () => {
  const base = ["file.write", "file.patch", "peer.query", "peer.reply"];

  it("widens the allow-list with shell.execute/verification.run at reviewed and direct tier", () => {
    expect(nativeApprovalAllowedTools("reviewed", base)).toEqual([...base, "shell.execute", "verification.run"]);
    expect(nativeApprovalAllowedTools("direct", base)).toEqual([...base, "shell.execute", "verification.run"]);
  });

  it("preserves governed tier's narrower posture unchanged", () => {
    expect(nativeApprovalAllowedTools("governed", base)).toEqual(base);
  });

  it("fails safe to the narrower list for an unknown (null) session tier", () => {
    expect(nativeApprovalAllowedTools(null, base)).toEqual(base);
  });
});

/**
 * Reproduces `cli.ts`'s exact approval composition (`governanceTierForSession`
 * + `nativeApprovalAllowedTools` + `NativeSystemPolicyApprovalPort`) against a
 * real `CampaignManager`, closing the loop the native-parity register's BENCH
 * 5 blocker names: a reviewed-tier high-risk action whose scope is present
 * and whose command is authorized used to still refuse with "tool action was
 * not approved". `native-tool-host.test.ts` separately proves the scope
 * preflight itself (command argv exact-match, out-of-scope refusal)
 * unchanged; this proves the layer above it now clears for the same session.
 */
function decideApproval(manager: CampaignManager, sessionId: string, tool: string) {
  const tier = manager.governanceTierForSession(sessionId);
  const baseTools = ["file.write", "file.patch", "peer.query", "peer.reply"];
  const allowed_tools = nativeApprovalAllowedTools(tier, baseTools);
  const policy_id = tier === "direct" || tier === "reviewed" ? "configured-specialist-tools-reviewed-v1" : "configured-specialist-tools-v1";
  return new NativeSystemPolicyApprovalPort({ policy_id, allowed_tools }).decide(
    { session_id: sessionId, request_id: "req-1", tool, input_summary: "test", risk: "high" },
    new AbortController().signal,
  );
}

describe("scope pre-authorization end-to-end: reviewed-tier command execution reaches approval", () => {
  it("approves shell.execute for a reviewed-tier session once its scope was derived, where it previously refused", async () => {
    const manager = new CampaignManager();
    const action: Action = {
      description: "Run the declared verification command",
      estimated_gain: 1, estimated_cost: 1, category: "verify", delegate_to: "seed",
      high_risk_tool_scope: { write_paths: [], command_argv: [["bun", "test"]] },
    };
    const admitted = manager.admitCampaignPlan({
      id: "adr088-e2e-approve", plan_path: "plan.md", root_action: action,
      actions: [{ ...action, description: "noop placeholder" }],
      governance: { tier: "reviewed", rationale: "test", blast_radius: { reversibility: "reversible" }, source: "arbiter", decided_at: "2026-08-24T00:00:00.000Z" },
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const sessionId = "adr088-e2e-session";
    // Before any scope has been derived for this session (the pre-fix chain
    // state), the tier is unknown and the wider tool set is never granted.
    expect((await decideApproval(manager, sessionId, "shell.execute")).approved).toBe(false);
    // The specialist's tool host derives the scope before its first tool
    // dispatch (the same `deriveNativeHighRiskToolScope` call `high_risk_scope_for_session`
    // makes in `cli.ts`), which now also records this session's governance tier.
    const scope = manager.deriveNativeHighRiskToolScope({ campaign_id: "adr088-e2e-approve", node_id: admitted.root_id, session_id: sessionId, worktree_path: "/worktree/e2e" });
    expect(scope).toMatchObject({ command_argv: [["bun", "test"]] });
    const resolution = await decideApproval(manager, sessionId, "shell.execute");
    expect(resolution).toMatchObject({ approved: true });
  });

  it("keeps governed tier on the narrower approved-tool list even once a scope was derived", async () => {
    const manager = new CampaignManager();
    const action: Action = {
      description: "Run the declared verification command",
      estimated_gain: 1, estimated_cost: 1, category: "verify", delegate_to: "seed",
      high_risk_tool_scope: { write_paths: [], command_argv: [["bun", "test"]] },
    };
    const admitted = manager.admitCampaignPlan({
      id: "adr088-e2e-governed", plan_path: "plan.md", root_action: action,
      actions: [{ ...action, description: "noop placeholder" }],
      governance: { tier: "governed", rationale: "test", blast_radius: { reversibility: "unknown" }, source: "arbiter", decided_at: "2026-08-24T00:00:00.000Z" },
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const sessionId = "adr088-e2e-governed-session";
    manager.deriveNativeHighRiskToolScope({ campaign_id: "adr088-e2e-governed", node_id: admitted.root_id, session_id: sessionId, worktree_path: "/worktree/e2e" });
    expect(manager.governanceTierForSession(sessionId)).toBe("governed");
    expect((await decideApproval(manager, sessionId, "shell.execute")).approved).toBe(false);
    expect((await decideApproval(manager, sessionId, "file.write")).approved).toBe(true);
  });
});
