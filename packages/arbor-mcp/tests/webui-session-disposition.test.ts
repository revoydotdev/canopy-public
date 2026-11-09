/**
 * WA-33: the Web continuation form used to hardcode `dispositions: []` and
 * send the free-text field only as `reason`, so a continuation whose plan
 * required an explicit disposition could never be authorized from the
 * dashboard. This proves two things: (1) the served page's client script now
 * renders a per-operation decision select and forwards a real `dispositions`
 * array instead of `[]`, and (2) posting a real `harness.session.resume`
 * command with a populated `dispositions` array through the same
 * `/api/runtime/command` endpoint the page's `runtimeCommand()` helper calls
 * clears the "requires an explicit disposition" gate -- the exact rejection
 * the reactive form now discovers and resubmits against.
 */
import { describe, expect, it } from "vitest";
import * as http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliRuntime } from "../src/cli.js";
import { ArborWebUIServer } from "../src/webui.js";

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

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}
function httpPost(port: number, path: string, payload: unknown, headers: Readonly<Record<string, string>> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: "localhost", port, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("webui session continuation form — dispositions (WA-33)", () => {
  it("serves a client script that renders a per-operation decision select and forwards real dispositions", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-webui-disposition-served-"));
    try {
      const webui = new ArborWebUIServer(createCliRuntime(repo));
      const port = await new Promise<number>((resolvePort) => webui.start(0, () => resolvePort(webui.getPort()!)));
      try {
        const { body } = await httpGet(port, "/");
        expect(body).toContain('name="disposition-op"');
        expect(body).toContain("RECOVERY_DISPOSITION_DECISIONS");
        expect(body).toContain("requires an explicit disposition");
        // The old hardcoded empty array is gone from the submit handler --
        // dispositions is now built from the rendered selects.
        expect(body).not.toContain("reason:disposition, dispositions:[]");
      } finally { await webui.stop(); }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("clears the disposition gate when a populated dispositions array is posted, the way the reactive form's resubmission does", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-webui-disposition-roundtrip-"));
    try {
      initRepo(repo);
      const runtime = createCliRuntime(repo);
      runtime.manager.startCampaign("campaign", "plan.md", action);
      const rootId = runtime.manager.getCampaignSnapshot("campaign")!.root_id;
      const [nodeId] = runtime.manager.branch("campaign", rootId, [action]);
      const expectedVersion = runtime.manager.getCampaignVersion("campaign");
      runtime.manager.interrupt({
        campaign_id: "campaign", node_id: nodeId, operation_id: "crashed-op", scope: "node",
        reason: "process crashed mid-tool-call", expected_version: expectedVersion,
        provenance: { tag: "claimed", claimant: "test" }, acknowledge: () => {},
      });
      const sessionId = "webui-indeterminate-session";
      expect(runtime.harnessSessions!.recordStarted({
        session_id: sessionId, campaign_id: "campaign", node_id: nodeId, operation: "specialize",
        connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "specialist", state: "running", latest_sequence: 1,
      })).toBe(true);
      expect(runtime.harnessSessions!.recordEvent({
        session_id: sessionId, sequence: 1, occurred_at: new Date().toISOString(), kind: "tool_intent",
        payload: { tool: "shell-exec" },
      })).toBe(true);
      runtime.harnessSessions!.reconcileOrphanedSessions();

      const webui = new ArborWebUIServer(runtime);
      const port = await new Promise<number>((resolvePort) => webui.start(0, () => resolvePort(webui.getPort()!)));
      try {
        const provenance = { tag: "generated", generator: "webui-disposition-test", input_hash: `sha256:${sessionId}` };
        const bareStamp = "webui-disposition-bare";
        const bare = await httpPost(port, "/api/runtime/command", {
          kind: "harness.session.resume", session_id: sessionId, reason: "operator reviewed", dispositions: [], provenance,
          metadata: { operation_id: bareStamp, idempotency_key: bareStamp, correlation_id: bareStamp, actor_id: "webui-operator", requested_at: new Date().toISOString() },
        }, webui.operatorRequestHeaders());
        const bareParsed = JSON.parse(bare.body) as { ok: boolean; error?: { summary: string } };
        expect(bareParsed.ok).toBe(false);
        expect(bareParsed.error?.summary).toMatch(/requires an explicit disposition/);
        const operationId = bareParsed.error!.summary.match(/^operation (\S+) requires/)![1]!;

        // Two indeterminate operations, not one: the seeded tool_intent has no
        // terminal audit, and the session has no provider checkpoint, so the
        // classifier keeps the pre-dispatch uncertainty visible too
        // (effect-classifier.ts). Satisfying only the first leaves the second
        // demanding one, so resolve them in turn.
        const supplied = new Map<string, string>([[operationId, "accept_observed"]]);
        let summary = "";
        for (let round = 0; round < 4; round++) {
          const stamp = `webui-disposition-round-${round}`;
          const response = await httpPost(port, "/api/runtime/command", {
            kind: "harness.session.resume", session_id: sessionId, reason: "operator reviewed",
            dispositions: [...supplied].map(([id, decision]) => ({ operation_id: id, decision, reason: "operator reviewed" })), provenance,
            metadata: { operation_id: stamp, idempotency_key: stamp, correlation_id: stamp, actor_id: "webui-operator", requested_at: new Date().toISOString() },
          }, webui.operatorRequestHeaders());
          summary = (JSON.parse(response.body) as { error?: { summary: string } }).error?.summary ?? "";
          const next = /^operation (\S+) requires an explicit disposition/.exec(summary);
          if (next === null) break;
          supplied.set(next[1]!, "accept_observed");
        }
        expect(summary).not.toMatch(/requires an explicit disposition/);
        expect(supplied.size).toBeGreaterThanOrEqual(2);
      } finally { await webui.stop(); }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
