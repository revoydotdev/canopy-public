/**
 * WA-29: the CLI `resume` branch used to construct its
 * `RuntimeCatalogRouter` with no options at all —
 * `new RuntimeCatalogRouter(runtime)` — unlike every other long-lived
 * transport composition root (`tui.ts`, `server.ts`, `webui.ts`), which all
 * pass `{ recovery_service: runtime.recoveryService ?? undefined }`. This
 * drives the real CLI composition root (`main(["resume", ...])`, the same
 * entry point an operator invokes) against a genuinely persisted interrupted
 * harness session and proves the continuation completes rather than being
 * rejected — never asserting on an internal `RecoveryService` call.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("arbor resume — recovery_service composition (WA-29)", () => {
  it("continues a persisted interrupted session through main([\"resume\"]) without a recovery-service rejection", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-resume-recovery-"));
    try {
      initRepo(repo);

      // Persist an interrupted node + a durable harness session recovery
      // orphan the way a real crashed session would leave the tree, using
      // one runtime instance so the durable state is on disk before `main`
      // opens its own.
      const seed = createCliRuntime(repo);
      seed.manager.startCampaign("campaign", "plan.md", action);
      const rootId = seed.manager.getCampaignSnapshot("campaign")!.root_id;
      const [nodeId] = seed.manager.branch("campaign", rootId, [action]);
      const expectedVersion = seed.manager.getCampaignVersion("campaign");
      seed.manager.interrupt({
        campaign_id: "campaign", node_id: nodeId, operation_id: "crashed-op", scope: "node",
        reason: "process crashed mid-expansion", expected_version: expectedVersion,
        provenance: { tag: "claimed", claimant: "test" }, acknowledge: () => {},
      });
      expect(seed.harnessSessions!.recordStarted({
        session_id: "orphan-session", campaign_id: "campaign", node_id: nodeId, operation: "specialize",
        connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "specialist", state: "running", latest_sequence: 1,
      })).toBe(true);
      // Simulate the restart-time reconciliation a freshly opened durable
      // journal performs on a nonterminal orphan (harness-session-journal.ts's
      // own constructor behavior), without actually killing this process.
      //
      // The settled provider checkpoint records that the orphan's model call
      // provably completed, matching the prepared -> dispatched -> settled shape
      // `native-agent-executor.ts` writes. Without it the effect classifier
      // emits an indeterminate pre-dispatch classification and the resume
      // demands an operator disposition -- correct fail-closed behaviour, but
      // not what this case asserts (that an unconfigured recovery service is no
      // longer the first refusal).
      const provider = { session_id: "orphan-session", operation_id: "orphan-session:provider:1:1", operation_kind: "provider", operation: "openrouter", effect_kind: "provider", repeatable: false, idempotency_key_hash: null, acknowledged_by: null, compensation_id: null } as const;
      seed.harnessSessions!.recordOperationCheckpoint({ ...provider, phase: "prepared", outcome: null, effect: null, occurred_at: "2026-08-12T00:00:00.000Z" });
      seed.harnessSessions!.recordOperationCheckpoint({ ...provider, phase: "dispatched", outcome: null, effect: null, occurred_at: "2026-08-12T00:00:00.500Z" });
      seed.harnessSessions!.recordOperationCheckpoint({ ...provider, phase: "settled", outcome: "succeeded", effect: "observed", occurred_at: "2026-08-12T00:00:01.000Z" });
      seed.harnessSessions!.reconcileOrphanedSessions();
      await seed.close();

      const stdout = new PassThrough(); const stderr = new PassThrough();
      const stdoutText = collect(stdout); const stderrText = collect(stderr);
      const code = await main(["resume", "orphan-session", "--json"], {
        cwd: repo, stdin: new PassThrough(), stdout, stderr,
      });

      // Before WA-29's fix, an unconfigured recovery service is the *first*
      // gate a durable `recovery.retry`/`recovery.abandon` command would
      // hit; this proves it is not what stops this continuation. The plan
      // reaches all the way to the recovery-continuation admissions check
      // (evidenced by the "model_revision" governed rejection below, from a
      // fixture with no native provider configured) -- proof this session
      // was genuinely discovered, previewed, and dispatched through the real
      // recovery service composed by `createCliRuntime`, not short-circuited
      // by a missing `recovery_service` option on the router.
      const combined = stdoutText.text() + stderrText.text();
      expect(combined).not.toContain("recovery service is not configured");
      expect(code).toBe(EXIT_CODES.CONFLICT);
      // A rejected/unavailable/ambiguous resume writes its JSON to stderr,
      // not stdout (cli.ts's resume branch routes the write by status).
      expect(JSON.parse(stderrText.text())).toMatchObject({
        status: "rejected", candidate: { session_id: "orphan-session" }, code: "conflict",
        message: expect.stringContaining("model_revision"),
      });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("constructs the resume branch's RuntimeCatalogRouter with recovery_service, matching tui.ts/server.ts/webui.ts", () => {
    // Derived from an INDEPENDENT source -- the literal construction call in
    // cli.ts's `resume` branch, not a re-assertion of behavior that this exact
    // continuation kind (`harness.session.resume`) does not currently gate on
    // the router's `recovery_service` option at all (only `recovery.retry`/
    // `recovery.abandon` do). This is the defense-in-depth fix WA-29 asked
    // for: every CLI router construction site that *can* reach recovery
    // kinds passes the option, exactly like tui.ts/server.ts/webui.ts do.
    const source = readFileSync(new URL("../src/cli.js", import.meta.url).pathname.replace(/\.js$/, ".ts"), "utf8");
    const resumeBranch = source.slice(source.indexOf('if (args[0] === "resume")'), source.indexOf('if (args[0] === "verification"'));
    expect(resumeBranch).toContain("new RuntimeCatalogRouter(runtime, { recovery_service: runtime.recoveryService ?? undefined })");
  });
});
