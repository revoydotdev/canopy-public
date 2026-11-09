import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionCampaignLoopConfig } from "../src/cli.js";
import { ArborRuntime } from "../src/runtime.js";

const temporaryDirectories: string[] = [];
afterEach(() => { while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

describe("production result verification capture", () => {
  it("persists exact authorized argv with trusted verified provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-production-verification-"));
    const persistence = mkdtempSync(join(tmpdir(), "arbor-production-verification-store-"));
    temporaryDirectories.push(root, persistence);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Verification test"], { cwd: root });
    writeFileSync(join(root, "seed.txt"), "seed\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "result.md"), "# verified\n", "utf8");

    const runtime = new ArborRuntime({ persistence_dir: persistence });
    runtime.manager.startCampaign("campaign-verified", "plan.md", { description: "verify result", estimated_gain: 1, estimated_cost: 1, category: "test", delegate_to: "seed" });
    const config = createProductionCampaignLoopConfig(runtime, "campaign-verified", async () => ({ approved: true, rationale: "approved" }));
    const provenance = { tag: "verified", cmd: "bun vitest run focused.test.ts", exit: 0, stdout_hash: `sha256:${"a".repeat(64)}`, check: { kind: "shell_command", breadth: "single" }, strength: "command_executed" } as const;
    config.result_capture?.capture({
      campaign_id: "campaign-verified",
      node_id: "node-verified",
      worktree_path: root,
      verified: true,
      score: 1,
      verification_provenance: provenance,
      verification_command_argv: ["bun", "vitest", "run", "focused.test.ts"],
      declared_write_paths: ["docs/result.md"],
    });

    expect(runtime.resultVerification.get("campaign-verified", "node-verified")).toMatchObject({
      confidence: "verified",
      files: ["docs/result.md"],
      checks: [{ command: ["bun", "vitest", "run", "focused.test.ts"], exit_status: 0, provenance }],
      provenance,
    });
  });
});
