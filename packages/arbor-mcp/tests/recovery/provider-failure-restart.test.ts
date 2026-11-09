/**
 * Remediation A02 + A06 (audit/2026-09-06-remediation/manifest.md): the
 * final failure/retry chronology and the canonical, redacted provider reason
 * of a failed native session survive a real process death.
 *
 * `fixtures/provider-failure-campaign-worker.ts` runs a real campaign in a
 * separate `bun` process through the production `createCliRuntime`
 * composition (runtime catalog, supervised campaign job, NativeAgentExecutor,
 * native worker, OpenAI-compatible adapter). Only `fetch` is replaced, by an
 * offline provider that answers HTTP 503 (retryable) then HTTP 402 with
 * planted credentials in its typed error message and in untyped body
 * fields. The worker prints what `harness.session.attach`/`.inspect` and the
 * run report showed, then is SIGKILLed. A fresh runtime in this process,
 * holding nothing but the durable records, must reproduce the same ordered
 * chronology and reason through the same surfaces, and the TUI Console must
 * render them, with no planted credential in any durable journal byte.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { consoleScreen } from "@arbor/tui";
import { createCliRuntime } from "../../src/cli.js";
import { RuntimeCatalogRouter } from "../../src/runtime-catalog.js";
import { buildRunReport } from "../../src/run-report.js";
import type { HarnessSessionFailureChronology } from "../../src/harness-session-journal.js";
import { PLANTED } from "./fixtures/provider-failure-planted.js";

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "fixtures", "provider-failure-campaign-worker.ts");
type Worker = ChildProcessByStdio<null, Readable, Readable>;

interface Surface { readonly session_id: string; readonly attach: { readonly live: boolean; readonly session: { readonly failure?: HarnessSessionFailureChronology; readonly terminal: unknown }; readonly events: readonly { sequence: number; kind: string; payload: Record<string, unknown> }[] }; readonly inspect: { readonly failure?: HarnessSessionFailureChronology } }
interface Settled { readonly specialist_calls: number; readonly surfaces: readonly Surface[]; readonly session_failures: readonly { session_id: string; failure: HarnessSessionFailureChronology }[] | null }

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) {
    spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
    rmSync(repo, { recursive: true, force: true });
  }
});

function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "arbor-provider-failure-restart-"));
  repos.push(repo);
  writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({
    native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "default-native-model" },
  }), "utf8");
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "Provider failure test"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "fixture"], { stdio: "ignore" });
  return repo;
}

function settledOutput(child: Worker): Promise<Settled> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("settled:"));
      if (!settled && line !== undefined && stdout.includes("\n", stdout.indexOf(line))) { settled = true; resolve(JSON.parse(line.slice("settled:".length)) as Settled); }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { if (!settled) { settled = true; reject(error); } });
    child.once("exit", (code) => { if (!settled) { settled = true; reject(new Error(`worker exited (code ${code}) before settling; stderr: ${stderr.slice(-4_000)}`)); } });
  });
}

/** Every file under `dir`, recursively, as text. */
function filesUnder(dir: string): readonly { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === name) return path;
    if (statSync(path).isDirectory() && entry !== ".git") { const found = findFile(path, name); if (found !== null) return found; }
  }
  return null;
}

describe("A02/A06 — failure chronology and redacted provider reason survive a real SIGKILL and restart", () => {
  it("reproduces the ordered retry chronology and canonical reason through attach, inspect, the run report and the Console", async () => {
    const repo = fixtureRepo();
    const campaignId = "provider-failure-restart";
    const child = spawn("bun", ["run", worker, repo, campaignId], { stdio: ["ignore", "pipe", "pipe"] }) as Worker;
    let before: Settled;
    try {
      before = await settledOutput(child);
    } finally {
      const exited = new Promise<NodeJS.Signals | null>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(child.signalCode); else child.once("exit", (_code, signal) => resolve(signal)); });
      child.kill("SIGKILL");
      expect(await exited).toBe("SIGKILL");
    }

    // The writer really failed through the provider: a retryable 503, then
    // the terminal 402, for each failed specialist session.
    const failedBefore = before.surfaces.filter((surface) => surface.attach.session.failure !== undefined);
    expect(failedBefore.length).toBeGreaterThanOrEqual(1);
    expect(before.specialist_calls).toBe(failedBefore.length * 2);
    for (const surface of failedBefore) {
      const failure = surface.attach.session.failure!;
      expect(failure.retries).toEqual([expect.objectContaining({ attempt: 1, max_attempts: 2, failure_kind: "http" })]);
      expect(failure.reason).toMatchObject({
        code: "model_failure",
        provider: { error_class: "OpenAICompatibleAdapterError", failure_kind: "http", http_status: 402, provider_code: "insufficient_quota" },
      });
      expect(failure.reason!.provider!.message).toContain("OpenAI-compatible provider returned HTTP 402");
      expect(failure.retries[0]!.sequence).toBeLessThan(failure.reason!.sequence);
      expect(failure.reason!.sequence).toBeLessThan(failure.terminal_sequence);
    }

    // Restart: a fresh runtime that only has the durable records.
    const runtime = createCliRuntime(repo);
    const router = new RuntimeCatalogRouter(runtime);
    const query = <T>(payload: Record<string, unknown>): T => {
      const result = router.executeQuery({ schema_version: 1, query_id: `q-${String(payload.kind)}`, query: payload } as never);
      if (!result.ok) throw new Error(`${String(payload.kind)} failed: ${JSON.stringify(result)}`);
      return result.value as T;
    };
    for (const surface of failedBefore) {
      const attached = query<Surface["attach"]>({ kind: "harness.session.attach", session_id: surface.session_id, after_sequence: 0, limit: 200 });
      expect(attached.live).toBe(false);
      // The same ordered events, the same chronology, the same reason.
      expect(attached.events).toEqual(surface.attach.events);
      expect(attached.session.failure).toEqual(surface.attach.session.failure);
      expect(query<Surface["inspect"]>({ kind: "harness.session.inspect", session_id: surface.session_id }).failure).toEqual(surface.inspect.failure);

      // The Console renders the chronology then the reason, in order, from
      // the post-restart attach projection.
      const size = { width: 220, height: 60 };
      const projection = consoleScreen.project({ captured_at: "2026-10-06T00:00:00.000Z", sidebar_visibility: "hidden", session_attach: attached }, size);
      const rendered = consoleScreen.render({ projection, ...size }).join("\n");
      const retryAt = rendered.indexOf("Attempt 1/2 failed (http); retrying in");
      const reasonAt = rendered.indexOf("OpenAICompatibleAdapterError (http) HTTP 402 insufficient_quota");
      expect(retryAt).toBeGreaterThanOrEqual(0);
      expect(reasonAt).toBeGreaterThan(retryAt);
    }
    const report = buildRunReport(runtime, campaignId);
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.value.session_failures).toEqual(before.session_failures);

    // A06: no planted credential or raw body field in any durable journal
    // byte (journal plus content-addressed evidence manifests), nor in the
    // session projections and report section read before or after restart.
    // The campaign snapshot, ledger and KB carry the worker's own node
    // failure message, which is a separate boundary and not asserted here.
    const journal = findFile(repo, "harness-sessions.ndjson");
    expect(journal).not.toBeNull();
    const durable = [{ path: journal!, text: readFileSync(journal!, "utf8") }, ...filesUnder(join(dirname(journal!), "harness-session-artifacts"))];
    expect(durable.length).toBeGreaterThan(1);
    const surfaces = JSON.stringify({ before, after: report.ok ? report.value.session_failures : null });
    for (const secret of Object.values(PLANTED)) {
      for (const file of durable) expect(file.text, file.path).not.toContain(secret);
      expect(surfaces).not.toContain(secret);
    }
    expect(readFileSync(journal!, "utf8")).toContain("\"provider_failure\"");
  }, 60_000);
});
