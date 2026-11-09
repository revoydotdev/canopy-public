/**
 * ADR-101 O3 — recovery proven against a real process death, not an
 * in-process replay.
 *
 * `saveCampaign` (packages/arbor-core/src/persist.ts) writes atomically —
 * temp file, fsync, rename, fsync the parent directory — and
 * `persist-fsync.test.ts` proves those syscalls genuinely fire. But every
 * recovery test in this repository (recovery-roundtrip.test.ts,
 * recovery-service.test.ts, recovery-lease-adapter.test.ts, this package's
 * own continuation tests) replays state inside the same process that wrote
 * it. None of them has ever handed a real campaign writer to the OS and
 * pulled the plug.
 *
 * This test does: it spawns `kill-restart-worker.ts` as a genuine, separate
 * `bun` process that repeatedly calls the real, unmodified `saveCampaign`,
 * waits for real forward progress, sends a real `SIGKILL`, then spawns a
 * second fresh process that calls the real `loadCampaignResult` against the
 * same directory. The invariant under test: whatever a process that has
 * never seen the writer's in-memory state finds on disk is either the
 * complete previous snapshot or the complete latest one — atomic-rename
 * durability holding up against an uncooperative kill, not merely a mocked
 * fsync call count.
 *
 * ADR-078 scope: this is a real-entrypoint driver (spawns a process,
 * persists to disk), not a broad-state repo scanner — it needs only its own
 * throwaway persistence directory, never this repo's real `.arbor/`, which
 * `mkdtempSync` below provides. The worker resolves `@arbor/core` from this
 * package's own `node_modules`, identically to every other test in this
 * suite (e.g. persist-fsync.test.ts's own `../src/index.js` import); it is
 * not a wide scan of repository state that a sibling's concurrent commit
 * could flip, so no frozen git snapshot is required for it specifically.
 */
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

// stdio is ["ignore","pipe","pipe"], so stdin really is null. Naming that
// exactly lets this handle typecheck without an unsound cast through
// ChildProcessWithoutNullStreams, whose stdin is Writable.
type KillRestartWorker = ChildProcessByStdio<null, Readable, Readable>;
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "fixtures", "kill-restart-worker.ts");

interface LoadResult {
  value: { id: string; iterations_completed: number } | null;
  diagnostics: ReadonlyArray<{ artifact: string; code: string }>;
}

function spawnWorker(args: readonly string[]): KillRestartWorker {
  return spawn("bun", ["run", worker, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

/** Waits for the first `progress:<n>` line, proving at least one real durable write landed before the kill. */
function firstProgress(child: KillRestartWorker): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString();
      const match = /^progress:(\d+)/m.exec(buffer);
      if (match) { settled = true; resolve(Number.parseInt(match[1], 10)); }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { if (!settled) { settled = true; reject(error); } });
    child.once("exit", (code) => {
      if (!settled) { settled = true; reject(new Error(`worker exited (code ${code}) before any durable write; stderr: ${stderr}`)); }
    });
  });
}

function waitForExit(child: KillRestartWorker): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function runReader(dir: string, campaignId: string): Promise<LoadResult> {
  return new Promise((resolve, reject) => {
    const child = spawnWorker(["read", dir, campaignId]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) { reject(new Error(`reader exited ${code}: ${stderr}`)); return; }
      const line = stdout.trim().split("\n").pop();
      if (!line) { reject(new Error("reader produced no output")); return; }
      resolve(JSON.parse(line) as LoadResult);
    });
  });
}

describe("ADR-101 O3 — a real SIGKILL-and-restart proves campaign resume from durable state", () => {
  it("kills a real writer mid-campaign and a fresh process loads the last durably saved snapshot cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-kill-restart-"));
    const campaignId = `kill-restart-${Date.now().toString(36)}`;
    try {
      const writer = spawnWorker(["write", dir, campaignId, "5000"]);
      const observedProgress = await firstProgress(writer);
      expect(observedProgress).toBeGreaterThanOrEqual(1);

      const exited = waitForExit(writer);
      writer.kill("SIGKILL");
      const exitInfo = await exited;
      // A real, unrecoverable kill — not a graceful shutdown the writer
      // could have flushed state around. This is the process-death
      // boundary the ADR requires; a signal of "SIGTERM" or a clean exit
      // would not exercise it.
      expect(exitInfo.signal).toBe("SIGKILL");

      const result = await runReader(dir, campaignId);

      // The atomic-write invariant under real process death: the campaign
      // snapshot itself is never found corrupt. A leftover, mid-flight
      // temp file is legitimate (the kill can land before its rename) and
      // is quarantined as a "temporary_file" diagnostic by
      // reconcileCampaignTemporaryFiles — but the campaign snapshot
      // (`campaign_snapshot`) itself must never appear among the
      // diagnostics: it is either the previous complete write or the
      // latest complete write, never a torn one.
      for (const diagnostic of result.diagnostics) {
        expect(diagnostic.artifact).toBe("temporary_file");
      }
      expect(result.value).not.toBeNull();
      expect(result.value?.id).toBe(campaignId);
      expect(Number.isInteger(result.value?.iterations_completed)).toBe(true);
      expect(result.value!.iterations_completed).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
