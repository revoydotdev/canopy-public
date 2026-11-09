/**
 * A provider error message carrying key-SHAPED credentials must not survive
 * into any durable or model-bound surface of a real campaign.
 *
 * The campaign runs through the production `createCliRuntime` composition
 * (runtime catalog, supervised campaign job, NativeAgentExecutor, native
 * worker, OpenAI-compatible adapter). Only `fetch` is replaced, by an offline
 * provider that answers every specialist request with a terminal HTTP 402
 * whose typed error message embeds one planted credential of every shape the
 * shared harness scrubber names. Two sibling nodes run: the first failure's
 * failure_mode KB entry is injected into the second specialist's prompt, so
 * the second request body is the KB-injection sink.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAMPAIGN_RUN_JOB_KIND } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { createCliRuntime } from "../src/cli.js";
import { buildRunReport } from "../src/run-report.js";

/** One planted value per scrubbed key shape. None is a real credential. */
const PLANTED = Object.freeze({
  openai_project: "sk-proj-PLANTEDa1b2c3d4e5f6g7h8i9j0kLmN",
  anthropic: "sk-ant-api03-PLANTED0123456789abcdefGHIJ",
  stripe_publishable: "pk_live_PLANTED0123456789abcdefGH",
  aws_access: "AKIAPLANTED012345678",
  aws_session: "ASIAPLANTED012345678",
  github_classic: "ghp_PLANTED0123456789abcdefghijklmnopqr",
  github_fine: "github_pat_11PLANTED0123456789_abcdefghijklmnopqrstuv",
  slack: "xoxb-1234567890-PLANTED-abcdefghij",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJQTEFOVEVEIn0.PLANTEDsignature0123456789",
  google: "AIzaSyPLANTED0123456789abcdefghijklmnop",
  generic: "Zq8PLANTEDx7Kp2Lm9Nb4Vc6Xz1Wq3Er5Ty0Ui",
});

const repos: string[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const repo of repos.splice(0)) {
    spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
    rmSync(repo, { recursive: true, force: true });
  }
});

function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "arbor-provider-key-redaction-"));
  repos.push(repo);
  writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({
    native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "default-native-model" },
  }), "utf8");
  writeFileSync(join(repo, "plan.md"), "# Provider key redaction fixture\n", "utf8");
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "Key redaction test"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "fixture"], { stdio: "ignore" });
  return repo;
}

/** Every regular file under `dir` except git internals, as text. */
function filesUnder(dir: string): readonly { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...filesUnder(path));
    else if (stat.isFile()) out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

/**
 * The worker bounds a model error detail to 256 characters, so one message
 * carrying all eleven shapes would truncate most of them away before any sink
 * and the test would prove nothing about them. Each failure instead carries
 * one labelled shape, one sibling node per shape, and the test asserts the
 * label reached every sink with `[REDACTED]` after it.
 */
const SHAPES = Object.entries(PLANTED);
/** The planted message for the node whose action the request names. */
const plantedMessage = (requestBody: string): string => {
  const match = /Action: Plan key redaction step ([a-z_]+)/.exec(requestBody);
  const shape = match?.[1] ?? "openai_project";
  return `You exceeded your current quota; planted-${shape} ${label(shape)} ${PLANTED[shape as keyof typeof PLANTED]} rejected`;
};
/** Only the generic run sits after a key-ish label; every vendor shape must be caught by its shape alone. */
const label = (shape: string): string => shape === "generic" ? "credential" : "value";

describe("provider error key-shape redaction across campaign sinks", () => {
  it("keeps every planted key shape out of the snapshot, ledger, KB, report and the next specialist's prompt", async () => {
    const repo = fixtureRepo();
    const campaignId = "provider-key-redaction";
    const specialistBodies: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = String(init?.body);
      const body = JSON.parse(raw) as { messages?: readonly { role: string; content: unknown }[] };
      const system = String(body.messages?.find((message) => message.role === "system")?.content ?? "");
      if (system.includes("Role: critic-reviewer")) return new Response("critic must not be reached", { status: 500 });
      specialistBodies.push(raw);
      return new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota", message: plantedMessage(raw) } }), { status: 402, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    process.env.ARBOR_NATIVE_API_KEY = "native-test-secret-key-redaction";
    const runtime = createCliRuntime(repo);
    delete process.env.ARBOR_NATIVE_API_KEY;
    const router = new RuntimeCatalogRouter(runtime);
    const meta = (id: string) => ({ operation_id: id, idempotency_key: id, actor_id: "operator", correlation_id: id, requested_at: "2026-10-06T00:00:00.000Z", session: {} });
    const command = async (id: string, payload: Record<string, unknown>): Promise<unknown> => {
      const result = await router.dispatchCommand({ schema_version: 1, metadata: meta(id), command: payload } as never) as { ok: boolean };
      if (!result.ok) throw new Error(`${id} failed: ${JSON.stringify(result)}`);
      return result;
    };
    const query = <T>(payload: Record<string, unknown>): T => {
      const result = router.executeQuery({ schema_version: 1, query_id: `q-${String(payload.kind)}`, query: payload } as never);
      if (!result.ok) throw new Error(`${String(payload.kind)} failed: ${JSON.stringify(result)}`);
      return result.value as T;
    };

    await command(`${campaignId}-start`, { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: { description: "Key redaction fixture root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" } });
    await command(`${campaignId}-branch`, { kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions: SHAPES.map(([shape], index) => (
      { description: `Plan key redaction step ${shape}`, estimated_gain: SHAPES.length + 1 - index, estimated_cost: 1, category: "architecture", delegate_to: "seed", execution_role: "architect" }
    )) });
    await command(`${campaignId}-job`, { kind: "job.submit", id: `${campaignId}-job`, operation_id: `${campaignId}-job`, job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: `${campaignId}-job` });

    const deadline = Date.now() + 45_000;
    for (;;) {
      const job = query<{ jobs: readonly { id: string; state: string }[] }>({ kind: "job.list", include_terminal: true }).jobs.find((entry) => entry.id === `${campaignId}-job`);
      if (job !== undefined && ["completed", "failed", "cancelled"].includes(job.state)) break;
      if (Date.now() > deadline) throw new Error("campaign job did not settle");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // The provider failure really reached the campaign: every shape's node
    // ran and failed, and later specialists' prompts carried earlier nodes'
    // failure_mode KB entries (the injection sink this test guards).
    expect(specialistBodies.length).toBeGreaterThanOrEqual(SHAPES.length);
    const injected = specialistBodies.slice(1).filter((body) => body.includes("exceeded your current quota"));
    expect(injected.length).toBeGreaterThanOrEqual(1);
    expect(injected.join("\n")).toMatch(/planted-[a-z_]+ (?:value|credential) \[REDACTED\]/);

    const report = buildRunReport(runtime, campaignId);
    expect(report.ok).toBe(true);
    const snapshot = query<unknown>({ kind: "campaign.snapshot", campaign_id: campaignId });
    const durable = filesUnder(repo);
    const failureText = durable.filter((file) => file.text.includes("exceeded your current quota"));
    // Snapshot, ledger and KB all carry the failure text, so their absence of
    // the planted values is a real redaction, not a missing record.
    expect(failureText.length).toBeGreaterThanOrEqual(2);
    const surfaces = JSON.stringify({ report, snapshot });
    const durableText = durable.map((file) => file.text).join("\n");
    for (const [shape, secret] of SHAPES) {
      // The labelled value reached the durable sinks and the snapshot, redacted.
      expect(durableText, `${shape} never reached a durable sink`).toContain(`planted-${shape} ${label(shape)} [REDACTED] rejected`);
      expect(surfaces, `${shape} never reached the snapshot`).toContain(`planted-${shape} ${label(shape)} [REDACTED] rejected`);
      for (const file of durable) expect(file.text, `${shape} in ${file.path}`).not.toContain(secret);
      expect(surfaces, `${shape} in report/snapshot`).not.toContain(secret);
      for (const body of specialistBodies) expect(body, `${shape} in a specialist prompt`).not.toContain(secret);
    }
  }, 60_000);
});
