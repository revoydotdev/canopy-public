/**
 * Explicit host policy for high-risk native repository tools.
 *
 * This is a system policy port, not an agent or model callback. It exists so
 * direct-native composition cannot accidentally turn a Specialist into its
 * own approver merely by closing over an always-true function.
 */
import type { NativeApprovalPort, NativeApprovalRequest, NativeApprovalResolution } from "@arbor/harness";

export interface NativeSystemPolicyApprovalOptions {
  /** Finite high-risk tool allow-list owned by composition. Empty denies all. */
  readonly allowed_tools: readonly string[];
  /** Stable policy identity rendered only as a non-secret audit rationale. */
  readonly policy_id: string;
}

export class NativeSystemPolicyApprovalPort implements NativeApprovalPort {
  private readonly allowed: ReadonlySet<string>;
  private readonly policyId: string;

  constructor(options: NativeSystemPolicyApprovalOptions) {
    if (!options.policy_id.trim()) throw new Error("policy_id must be non-empty");
    if (options.allowed_tools.some((tool) => !tool.trim()) || new Set(options.allowed_tools).size !== options.allowed_tools.length) throw new Error("allowed_tools must be non-empty and unique");
    this.allowed = new Set(options.allowed_tools);
    this.policyId = options.policy_id;
  }

  async decide(request: NativeApprovalRequest, signal: AbortSignal): Promise<NativeApprovalResolution> {
    if (signal.aborted) throw new Error("system policy approval was aborted");
    const approved = this.allowed.has(request.tool);
    return Object.freeze({
      approved,
      rationale: approved
        ? `approved by system policy ${this.policyId}; no agent supplied this decision`
        : `denied by system policy ${this.policyId}; tool is not in the approved high-risk allow-list`,
    });
  }
}
