import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RepoFlightDirector, createRepoFlightOperatorClient } from "../src/repo-flight-director.js";
import { main, ShutdownGate } from "../src/cli.js";
import { PassThrough } from "node:stream";
import { governanceTrust, warrantForDirector } from "./helpers/repo-flight-governance.js";

const roots: string[] = [];
const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "../bin/arbor-mcp.mjs");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(label: string): string { const root = mkdtempSync(join(tmpdir(), `repo-flight-director-${label}-`)); roots.push(root); return root; }
function repository(): string { const root = temp("repo"); for (const argv of [["init", "-q"], ["config", "user.email", "flight@example.invalid"], ["config", "user.name", "Flight"]]) { const result = spawnSync("git", argv, { cwd: root, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); } writeFileSync(join(root, "file.txt"), "one\n"); spawnSync("git", ["add", "file.txt"], { cwd: root }); spawnSync("git", ["commit", "-qm", "initial"], { cwd: root }); return root; }

describe("repo-local Flight Director composition", () => {
  it("elects one authority, serves an authenticated operator, and restarts durably", async () => {
    const repo = repository(), persistence = temp("state");
    const first = new RepoFlightDirector({ repository_root: repo, persistence_dir: persistence, required_providers: ["claude"] });
    await first.start();
    expect(statSync(first.paths.signing_secret).mode & 0o777).toBe(0o600);
    const client = createRepoFlightOperatorClient(persistence, 500);
    const status = await client.query({ schema_version: 1, query_id: "director-status:1", query: { kind: "repo.flight.status" } }, "director-status:1");
    expect(status).toMatchObject({ ok: true, result: { ok: true, value: { deployment: { status: "observed_only" } } } });
    expect(() => new RepoFlightDirector({ repository_root: repo, persistence_dir: persistence, required_providers: ["claude"] })).toThrow();
    await first.close();
    const restarted = new RepoFlightDirector({ repository_root: repo, persistence_dir: persistence, required_providers: ["claude"] });
    try { await restarted.start(); expect((await restarted.client().query({ schema_version: 1, query_id: "director-status:2", query: { kind: "repo.flight.status" } }, "director-status:2")).ok).toBe(true); }
    finally { await restarted.close(); }
  });

  it("exposes the real operator query through arbor flight", async () => {
    const repo = repository(), persistence = join(repo, ".arbor"), director = new RepoFlightDirector({ repository_root: repo, persistence_dir: persistence });
    await director.start();
    try {
      const stdout = new PassThrough(); let text = ""; stdout.on("data", (chunk) => { text += String(chunk); });
      const code = await main(["flight", "profile"], { cwd: repo, persistence_dir: persistence, stdin: new PassThrough(), stdout, stderr: new PassThrough(), env: {} });
      expect(code).toBe(0);
      expect(JSON.parse(text)).toMatchObject({ ok: true, result: { ok: true, value: { status: "observed_only" } } });
    } finally { await director.close(); }
  });

  it("refuses to reuse a persistence authority for a different repository", async () => {
    const firstRepo = repository(), secondRepo = repository(), persistence = temp("shared-state");
    const director = new RepoFlightDirector({ repository_root: firstRepo, persistence_dir: persistence, required_providers: ["codex"] });
    await director.start();
    try {
      const stderr = new PassThrough(); let diagnostic = ""; stderr.on("data", (chunk) => { diagnostic += String(chunk); });
      const code = await main(["flight", "start", "--repository", secondRepo, "--persistence", persistence], { cwd: secondRepo, persistence_dir: persistence, stdin: new PassThrough(), stdout: new PassThrough(), stderr, env: {} });
      expect(code).not.toBe(0);
      expect(diagnostic).toContain("already controlled for repository");
    } finally { await director.close(); }
  });

  it("fails CLI query misuse and propagates domain-level query failure", async () => {
    const repo = repository(), persistence = join(repo, ".arbor"), director = new RepoFlightDirector({ repository_root: repo, persistence_dir: persistence });
    await director.start();
    try {
      const missingPlanErr = new PassThrough(); let missingPlanText = ""; missingPlanErr.on("data", (chunk) => { missingPlanText += String(chunk); });
      expect(await main(["flight", "gates"], { cwd: repo, persistence_dir: persistence, stdin: new PassThrough(), stdout: new PassThrough(), stderr: missingPlanErr, env: {} })).not.toBe(0);
      expect(missingPlanText).toContain("--plan");

      const absentOut = new PassThrough(); let absentText = ""; absentOut.on("data", (chunk) => { absentText += String(chunk); });
      expect(await main(["flight", "gates", "--plan", "gate:absent"], { cwd: repo, persistence_dir: persistence, stdin: new PassThrough(), stdout: absentOut, stderr: new PassThrough(), env: {} })).not.toBe(0);
      expect(JSON.parse(absentText)).toMatchObject({ ok: true, result: { ok: false, error: { code: "not_found" } } });

      const statusOut = new PassThrough(); let statusText = ""; statusOut.on("data", (chunk) => { statusText += String(chunk); });
      expect(await main(["flight", "status", "--run", "run:ignored"], { cwd: repo, persistence_dir: persistence, stdin: new PassThrough(), stdout: statusOut, stderr: new PassThrough(), env: {} })).toBe(0);
      expect(JSON.parse(statusText)).toMatchObject({ result: { ok: true } });
    } finally { await director.close(); }
  });

  it("admits and PID-enrolls a provider through the authenticated transport", async () => {
    const repo = repository(), persistence = join(repo, ".arbor"), director = new RepoFlightDirector({ repository_root: repo, persistence_dir: persistence, required_providers: ["codex"], governance_trust: governanceTrust });
    await director.start();
    const client = director.client(), timestamp = new Date().toISOString();
    const command = (operation: string, body: unknown) => client.command({ schema_version: 1, metadata: { operation_id: operation, idempotency_key: operation, correlation_id: "flight-provider-test", actor_id: "untrusted-assertion", requested_at: timestamp }, command: body }, operation);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      expect(await command("flight-run-create", { kind: "repo.flight.run.create", repo_run_id: "run:transport-provider" })).toMatchObject({ ok: true, result: { value: { accepted: true } } });
      expect(await command("flight-run-authorize", { kind: "repo.flight.run.authorize", repo_run_id: "run:transport-provider", attestation: warrantForDirector(director, "run:transport-provider") })).toMatchObject({ ok: true, result: { value: { accepted: true, projection: { phase: "admitted" } } } });
      if (!child.pid) throw new Error("test provider did not receive a PID");
      const enrolled = await command("flight-session-enroll", { kind: "repo.flight.session.enroll", request: { repo_run_id: "run:transport-provider", provider: "codex", provider_session_id: "codex:test", revoy_session_id: "revoy:test", pid: child.pid, campaign_id: "campaign:test", node_id: "node:test", task_id: "task:test", adapter_version: "1", worktree_root: repo, write_intents: [{ operation: "modify", path: "file.txt", purpose: "test" }], gate_intents: [] } });
      expect(enrolled).toMatchObject({ ok: true, result: { value: { accepted: true, projection: { provider: "codex", pid: child.pid, state: "live" } } } });
    } finally { child.kill("SIGKILL"); await new Promise<void>((done) => child.once("close", () => done())); await director.close(); }
  });

  it("serves under a process-bound owner record and removes it on governed shutdown", async () => {
    const repo = repository(), persistence = join(repo, ".arbor"), gate = new ShutdownGate(10);
    const stdout = new PassThrough(), stderr = new PassThrough();
    const serving = main(["flight", "serve"], { cwd: repo, persistence_dir: persistence, stdin: new PassThrough(), stdout, stderr, env: { ARBOR_HARNESS_INTEGRATION: "codex" } }, gate);
    const servedOwner = join(persistence, "repo-flight", "director.owner.json");
    const servedSocket = join(persistence, "repo-flight", "repo-flight-transport", "flight-director.sock");
    const deadline = Date.now() + 2_000;
    while ((!existsSync(servedOwner) || !existsSync(servedSocket)) && Date.now() < deadline) await new Promise<void>((done) => setTimeout(done, 10));
    expect(existsSync(servedOwner)).toBe(true);
    const status = await createRepoFlightOperatorClient(persistence).query({ schema_version: 1, query_id: "serve-profile", query: { kind: "repo.flight.profile" } }, "serve-profile");
    expect(status).toMatchObject({ ok: true, result: { ok: true, value: { required_providers: ["codex"] } } });
    const profile = (status as { result: { value: { provider_coverage: Array<Record<string, unknown>> } } }).result.value;
    expect(profile.provider_coverage.find((provider) => provider.provider === "codex")).toMatchObject({ launch_interceptor: true, identity_enrollment: true, mutation_interceptor: false });
    gate.trigger();
    expect(await serving).toBe(0);
    expect(existsSync(servedOwner)).toBe(false);
    expect(existsSync(servedSocket)).toBe(false);
  });

  it("fails closed before the real greenfield Codex launch when external governance is unavailable", async () => {
    const repo = repository(), persistence = join(repo, ".arbor"), tools = temp("fake-codex"), binary = join(tools, "codex");
    writeFileSync(binary, `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 1.0.0\\n"); process.exit(0); }
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const critic = prompt.includes("Return only the required critic verdict JSON");
  if (!critic) require("node:fs").appendFileSync("file.txt", "flight controlled\\n");
  const text = critic
    ? JSON.stringify({ approved: true, rationale: "fixture approved", root_cause: null, measurement_validated: true })
    : "flight-controlled provider completed";
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-flight-thread" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
});
`);
    chmodSync(binary, 0o755);
    const director = new RepoFlightDirector({ repository_root: repo, persistence_dir: persistence, required_providers: ["codex"], deployment: { providers: { codex: { launch_interceptor: true, identity_enrollment: true, mutation_interceptor: false } }, unmanaged_sessions_present: false } });
    await director.start();
    try {
      const stdout = new PassThrough(), stderr = new PassThrough(); let text = "", diagnostics = ""; stdout.on("data", (chunk) => { text += String(chunk); }); stderr.on("data", (chunk) => { diagnostics += String(chunk); });
      const code = await main(["greenfield", "edit file.txt to prepare the flight test", "--json"], { cwd: repo, persistence_dir: persistence, stdin: new PassThrough(), stdout, stderr, env: { ARBOR_HARNESS_INTEGRATION: "codex", ARBOR_CODEX_BIN: binary } });
      // No external governance issuer is configured. ADR-152 therefore
      // requires Flight to refuse the provider before it receives a process
      // identity or can mutate the repository.
      expect(code, `${diagnostics}\n${text}`).toBe(4);
      expect(JSON.parse(text)).toMatchObject({ ok: false, blockers: [expect.stringContaining("external governance admission authority is not configured")] });
      expect(director.controller.enrollment.projections(), `${diagnostics}\n${text}`).toEqual([]);
      expect(director.controller.lifecycle.snapshot().runs).toEqual([]);
      expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("one\n");
    } finally { await director.close(); }
  });

  it("automatically starts the durable director and refuses an ungoverned production greenfield provider dispatch", async () => {
    const repo = repository(), persistence = join(repo, ".arbor"), tools = temp("auto-flight-codex"), binary = join(tools, "codex");
    writeFileSync(binary, `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 1.0.0\\n"); process.exit(0); }
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const critic = prompt.includes("Return only the required critic verdict JSON");
  if (!critic) require("node:fs").appendFileSync("file.txt", "auto flight controlled\\n");
  const text = critic ? JSON.stringify({ approved: true, rationale: "fixture approved", root_cause: null, measurement_validated: true }) : "auto-flight provider completed";
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-auto-flight-thread" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
});
`);
    chmodSync(binary, 0o755);
    const env = { ...process.env, ARBOR_HARNESS_INTEGRATION: "codex", ARBOR_CODEX_BIN: binary };
    let stopped = false;
    try {
      const result = spawnSync("bun", [cliEntry, "greenfield", "edit file.txt under automatic flight control", "--json"], { cwd: repo, env, encoding: "utf8", timeout: 30_000 });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, blockers: [expect.stringContaining("external governance admission authority is not configured")] });
      const client = createRepoFlightOperatorClient(persistence, 1_000);
      const profile = await client.query({ schema_version: 1, query_id: "auto-flight-profile", query: { kind: "repo.flight.profile" } }, "auto-flight-profile");
      expect(profile).toMatchObject({ ok: true, result: { ok: true, value: { required_providers: ["codex"], status: "cooperative" } } });
      const sessions = await client.query({ schema_version: 1, query_id: "auto-flight-sessions", query: { kind: "repo.flight.sessions" } }, "auto-flight-sessions");
      const runs = await client.query({ schema_version: 1, query_id: "auto-flight-runs", query: { kind: "repo.flight.runs" } }, "auto-flight-runs");
      expect(sessions, JSON.stringify({ sessions, runs, command: { status: result.status, stdout: result.stdout, stderr: result.stderr } })).toMatchObject({ ok: true, result: { ok: true, value: [] } });
      expect(runs).toMatchObject({ ok: true, result: { ok: true, value: [] } });
      expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("one\n");
      const stop = spawnSync("bun", [cliEntry, "flight", "stop", "--repository", repo, "--persistence", persistence], { cwd: repo, env, encoding: "utf8", timeout: 10_000 });
      expect(stop.status, `${stop.stderr}\n${stop.stdout}`).toBe(0);
      expect(existsSync(join(persistence, "repo-flight", "director.owner.json"))).toBe(false);
      expect(existsSync(join(persistence, "repo-flight", "repo-flight-transport", "flight-director.sock"))).toBe(false);
      stopped = true;
    } finally {
      if (!stopped) spawnSync("bun", [cliEntry, "flight", "stop", "--repository", repo, "--persistence", persistence], { cwd: repo, env, encoding: "utf8", timeout: 10_000 });
    }
  }, 45_000);
});
