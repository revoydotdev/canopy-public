/**
 * Integration coverage for scripts/evidence-heartbeat-sidecar.mjs, which had
 * none. This is the process that ADR-092's direct-owner branch of
 * `assertEvidenceProducerAuthority` spawns detached so a synchronous producer
 * (determinism-baseline, vi-refresh) that blocks its own event loop can still
 * beat its lease. The property that must hold: a beat must never make a dead
 * or foreign owner look alive.
 *
 * Every test drives the real sidecar script as a real child process against a
 * real (separate) "owner" child process, per this repo's real-surface testing
 * discipline — no mocking of `heartbeatEvidenceTransaction` or `process.kill`.
 * `REVOY_HEARTBEAT_INTERVAL_MS` shortens the sidecar's 10s production tick
 * for these tests only (see the sidecar's own comment on that constant).
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { evidenceTransactionPaths, recoverEvidenceTransaction } from "../evidence-transaction.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR = join(HERE, "..", "evidence-heartbeat-sidecar.mjs");
const TEST_TICK_MS = 150;

const dirs = [];
const children = [];
function temporary(prefix) { const path = mkdtempSync(join(tmpdir(), prefix)); dirs.push(path); return path; }
function track(child) { children.push(child); return child; }
afterEach(() => {
  while (children.length) {
    const child = children.pop();
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

async function waitFor(predicate, { timeoutMs = 5_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function fixtureRepo() {
  const repo = temporary("revoy2-evtx-sidecar-");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return repo;
}

function readState(repo) {
  const { state } = evidenceTransactionPaths(repo);
  return JSON.parse(readFileSync(state, "utf8"));
}

/**
 * Spawns a real, separate "owner" process that acquires a direct-owner
 * transaction lease on `repo` (its own pid, its own process_start_identity —
 * exactly what acquireEvidenceTransaction records for a real producer) and
 * then idles until killed. Its lease credentials are written to `credsPath`
 * once acquired so the test can hand them to a sidecar.
 */
function spawnOwner(repo, credsPath) {
  const script = `
    import { acquireEvidenceTransaction } from ${JSON.stringify(join(HERE, "..", "evidence-transaction.mjs"))};
    import { writeFileSync } from "node:fs";
    const lease = acquireEvidenceTransaction({ repo: ${JSON.stringify(repo)} });
    writeFileSync(${JSON.stringify(credsPath)}, JSON.stringify({
      transaction_id: lease.transaction_id,
      delegation_token: lease.delegation_token,
      pid: process.pid,
    }));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore", detached: true });
  return track(child);
}

function spawnSidecar(repo, creds, { transactionId = creds.transaction_id, delegationToken = creds.delegation_token, ownerPid = creds.pid } = {}) {
  const child = spawn(process.execPath, [SIDECAR], {
    stdio: "ignore",
    detached: true,
    env: {
      ...process.env,
      REVOY_HEARTBEAT_REPO: repo,
      REVOY_HEARTBEAT_OWNER_PID: String(ownerPid),
      REVOY_EVIDENCE_TRANSACTION_ID: transactionId,
      REVOY_EVIDENCE_DELEGATION_TOKEN: delegationToken,
      REVOY_HEARTBEAT_INTERVAL_MS: String(TEST_TICK_MS),
    },
  });
  return track(child);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireOwnerCreds(repo) {
  const credsPath = join(temporary("revoy2-evtx-sidecar-creds-"), "creds.json");
  const owner = spawnOwner(repo, credsPath);
  await waitFor(() => existsSync(credsPath), { label: "owner to acquire its lease and report credentials" });
  const creds = JSON.parse(readFileSync(credsPath, "utf8"));
  return { owner, creds };
}

describe("evidence-heartbeat-sidecar", () => {
  it("beats the real owner's lease from a separate process while the owner is alive", async () => {
    const repo = fixtureRepo();
    const { creds } = await acquireOwnerCreds(repo);
    const before = readState(repo).lifecycle.heartbeat.sequence;
    spawnSidecar(repo, creds);
    await waitFor(() => readState(repo).lifecycle.heartbeat.sequence > before, { label: "sidecar to beat the lease" });
  });

  it("self-terminates once the owner it serves is gone, instead of continuing to beat a dead owner's lease", async () => {
    const repo = fixtureRepo();
    const { owner, creds } = await acquireOwnerCreds(repo);
    const sidecar = spawnSidecar(repo, creds);
    const beforeKill = readState(repo).lifecycle.heartbeat.sequence;
    await waitFor(() => readState(repo).lifecycle.heartbeat.sequence > beforeKill, { label: "sidecar to beat at least once" });

    // Kill the owner the way an abnormal exit really would: no exit handler
    // runs in the owner (SIGKILL cannot be caught), so only the sidecar's own
    // independent `ownerAlive()` poll can stop it.
    process.kill(owner.pid, "SIGKILL");
    await waitFor(() => !pidAlive(owner.pid), { label: "owner process to actually exit" });

    // The sidecar must notice on its own and exit -- it must not be left
    // running, beating a lease whose real owner no longer exists.
    await waitFor(() => !pidAlive(sidecar.pid), { timeoutMs: 3_000, label: "sidecar to self-exit after its owner dies" });

    const sequenceAtSidecarExit = readState(repo).lifecycle.heartbeat.sequence;
    await new Promise((r) => setTimeout(r, TEST_TICK_MS * 4));
    expect(readState(repo).lifecycle.heartbeat.sequence).toBe(sequenceAtSidecarExit); // no further beats landed
  });

  it("refuses to beat, and does not keep running, when handed the wrong delegation token", async () => {
    const repo = fixtureRepo();
    const { creds } = await acquireOwnerCreds(repo);
    const before = readState(repo).lifecycle.heartbeat.sequence;
    const sidecar = spawnSidecar(repo, creds, { delegationToken: "not-the-real-token" });
    await waitFor(() => !pidAlive(sidecar.pid), { timeoutMs: 3_000, label: "sidecar to exit after a refused beat" });
    expect(readState(repo).lifecycle.heartbeat.sequence).toBe(before); // never beat even once
  });

  it("never beats a lease that has been explicitly recovered out from under its dead owner", async () => {
    const repo = fixtureRepo();
    const { owner, creds } = await acquireOwnerCreds(repo);
    process.kill(owner.pid, "SIGKILL");
    await waitFor(() => !pidAlive(owner.pid), { label: "owner process to actually exit" });

    const recovered = recoverEvidenceTransaction({ repo, transactionId: creds.transaction_id, reviewed: true, review_reason: "test: owner killed for recovery test" });
    expect(recovered.ok).toBe(true);
    expect(existsSync(evidenceTransactionPaths(repo).lock)).toBe(false);

    // A sidecar spawned against the now-recovered (archived) transaction's
    // original credentials must never resurrect it.
    const sidecar = spawnSidecar(repo, creds);
    await waitFor(() => !pidAlive(sidecar.pid), { timeoutMs: 3_000, label: "sidecar to exit rather than beat a recovered lease" });
    expect(existsSync(evidenceTransactionPaths(repo).lock)).toBe(false); // still not held by anyone
  });

  it("the delegation token reaches the sidecar only via environment, never argv or a logged/receipted surface", async () => {
    const repo = fixtureRepo();
    const { creds } = await acquireOwnerCreds(repo);
    const sidecar = spawnSidecar(repo, creds);
    await waitFor(() => readState(repo).lifecycle.heartbeat.sequence > 0, { label: "sidecar to be running" });
    // /proc/<pid>/cmdline is exactly what `ps` reads argv from.
    const cmdline = readFileSync(`/proc/${sidecar.pid}/cmdline`, "utf8");
    expect(cmdline).not.toContain(creds.delegation_token);
    const state = readState(repo);
    expect(JSON.stringify(state)).not.toContain(creds.delegation_token);
  });
});
