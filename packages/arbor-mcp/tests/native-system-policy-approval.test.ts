import { describe, expect, it } from "vitest";
import { NativeSystemPolicyApprovalPort } from "../src/native-system-policy-approval.js";

const request = { session_id: "session", request_id: "request", tool: "file.write", input_summary: "write a file", risk: "high" } as const;

describe("NativeSystemPolicyApprovalPort", () => {
  it("makes a composition-owned policy decision rather than accepting an agent decision", async () => {
    const policy = new NativeSystemPolicyApprovalPort({ policy_id: "native-worktree-v1", allowed_tools: ["file.write", "file.patch"] });
    await expect(policy.decide(request, new AbortController().signal)).resolves.toEqual({
      approved: true,
      rationale: "approved by system policy native-worktree-v1; no agent supplied this decision",
    });
    await expect(policy.decide({ ...request, tool: "shell.execute" }, new AbortController().signal)).resolves.toMatchObject({ approved: false });
  });

  it("does not approve after cancellation", async () => {
    const policy = new NativeSystemPolicyApprovalPort({ policy_id: "native-worktree-v1", allowed_tools: ["file.write"] });
    const controller = new AbortController(); controller.abort();
    await expect(policy.decide(request, controller.signal)).rejects.toThrow("aborted");
  });
});
