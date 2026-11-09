/**
 * WA-33: `arbor session resume|fork|respawn <id>` hardcoded `dispositions:
 * []`, so a continuation whose plan required an explicit disposition
 * (EffectClassifier's "indeterminate"/"compensatable" cases) could never be
 * authorized from this branch. Drives the real CLI composition root
 * (`main(["session", ...])`) against a session with a genuine indeterminate
 * effect (a durable `tool_intent` event with no matching terminal audit),
 * proving the continuation is rejected without `--disposition` and succeeds
 * once it is supplied.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createCliRuntime, main } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";

const action = { description: "resume me", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" };

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

function collect(stream: PassThrough): { text(): string } {
  let buf = "";
  stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { text: () => buf };
}

/** Persists an interrupted session whose sole effect is a durable tool_intent with no terminal audit -- EffectClassifier's "indeterminate" case, which forces plan.requires_disposition. */
async function seedIndeterminateSession(repo: string): Promise<{ sessionId: string }> {
  const seed = createCliRuntime(repo);
  seed.manager.startCampaign("campaign", "plan.md", action);
  const rootId = seed.manager.getCampaignSnapshot("campaign")!.root_id;
  const [nodeId] = seed.manager.branch("campaign", rootId, [action]);
  const expectedVersion = seed.manager.getCampaignVersion("campaign");
  seed.manager.interrupt({
    campaign_id: "campaign", node_id: nodeId, operation_id: "crashed-op", scope: "node",
    reason: "process crashed mid-tool-call", expected_version: expectedVersion,
    provenance: { tag: "claimed", claimant: "test" }, acknowledge: () => {},
  });
  const sessionId = "indeterminate-session";
  expect(seed.harnessSessions!.recordStarted({
    session_id: sessionId, campaign_id: "campaign", node_id: nodeId, operation: "specialize",
    connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "specialist", state: "running", latest_sequence: 1,
  })).toBe(true);
  expect(seed.harnessSessions!.recordEvent({
    session_id: sessionId, sequence: 1, occurred_at: new Date().toISOString(), kind: "tool_intent",
    payload: { tool: "shell-exec" },
  })).toBe(true);
  seed.harnessSessions!.reconcileOrphanedSessions();
  await seed.close();
  return { sessionId };
}

describe("arbor session resume — --disposition (WA-33)", () => {
  it("rejects an indeterminate continuation with no --disposition, and authorizes it once one is supplied", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-session-disposition-"));
    try {
      initRepo(repo);
      const { sessionId } = await seedIndeterminateSession(repo);

      const bareStdout = new PassThrough(); const bareStdoutText = collect(bareStdout);
      const bareCode = await main(["session", "resume", sessionId, "--reason", "operator reviewed"], {
        cwd: repo, stdin: new PassThrough(), stdout: bareStdout, stderr: new PassThrough(),
      });
      expect(bareCode).not.toBe(EXIT_CODES.SUCCESS);
      const bareResult = JSON.parse(bareStdoutText.text());
      expect(bareResult).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(bareResult.error.summary).toMatch(/requires an explicit disposition/);
      const operationId: string = bareResult.error.summary.match(/^operation (\S+) requires/)[1];

      // Two indeterminate operations, not one: the seeded tool_intent has no
      // terminal audit, and the session has no provider checkpoint, so the
      // classifier keeps the pre-dispatch uncertainty visible too
      // (effect-classifier.ts). Satisfying only the first leaves the second
      // demanding one, so resolve them in turn.
      const supplied = new Map<string, string>([[operationId, "accept_observed"]]);
      let summary = "";
      for (let round = 0; round < 4; round++) {
        const dispositionArgs: string[] = [];
        for (const [id, decision] of supplied) dispositionArgs.push("--disposition", `${id}=${decision}`);
        const stdout = new PassThrough(); const text = collect(stdout);
        await main([
          "session", "resume", sessionId, "--reason", "operator reviewed", ...dispositionArgs,
        ], { cwd: repo, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
        summary = JSON.parse(text.text()).error?.summary ?? "";
        const next = /^operation (\S+) requires an explicit disposition/.exec(summary);
        if (next === null) break;
        supplied.set(next[1]!, "accept_observed");
      }
      expect(summary).not.toMatch(/requires an explicit disposition/);
      expect(supplied.size).toBeGreaterThanOrEqual(2);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("refuses a malformed --disposition value before dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-session-disposition-usage-"));
    try {
      const stderr = new PassThrough(); const stderrText = collect(stderr);
      const code = await main(["session", "resume", "any-session", "--disposition", "not-a-valid-value"], {
        cwd: root, stdin: new PassThrough(), stdout: new PassThrough(), stderr,
      });
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(stderrText.text()).toContain("Invalid --disposition");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
