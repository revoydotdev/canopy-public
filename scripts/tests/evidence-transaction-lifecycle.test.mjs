/**
 * ADR-092 Decision §5 — the acceptance-blocking fixture suite for
 * `gate:evidence-transaction-observability`.
 *
 * Every test here builds its own throwaway git repo under the OS tmp dir
 * (ADR-078: a real-entrypoint driver gets its own throwaway cwd, never this
 * checkout's real `.git/arbor/evidence-refresh/`). Deadlines/commands are
 * injected so the suite runs in milliseconds instead of invoking a real
 * `bun install`/`bun run build`.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EVIDENCE_HEARTBEAT_STALE_MS,
  EvidenceTransactionRefusal,
  acquireEvidenceTransaction,
  assertEvidenceProducerAuthority,
  heartbeatEvidenceTransaction,
  evidenceTransactionPaths,
  evidenceTransactionStatus,
  recoverEvidenceTransaction,
  runEvidenceRefreshTransaction,
  runEvidenceStagingSetup,
} from "../evidence-transaction.mjs";

const dirs = [];
function temporary(prefix) { const path = mkdtempSync(join(tmpdir(), prefix)); dirs.push(path); return path; }
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
function hash(value) { return createHash("sha256").update(value).digest("hex"); }

/**
 * Wait for a real observable condition instead of sleeping a fixed interval.
 * The abort test below previously slept 200ms hoping the producer had spawned;
 * under a loaded parallel run that spawn regularly takes longer, the abort
 * lands before there is anything to cancel, and the assertion flips. That made
 * this suite 2-in-3 flaky and put it over gate:determinism's 20% ceiling.
 */
async function waitFor(predicate, { timeoutMs = 10_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** True once the lock records the producer as actually running. */
function producerIsRunning(repo) {
  // `paths.lock` is the lock DIRECTORY; the state document is `paths.state`.
  const { state: statePath } = evidenceTransactionPaths(repo);
  if (!existsSync(statePath)) return false;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return state?.lifecycle?.children?.producer?.status === "running" || state?.phase === "producer_running";
  } catch { return false; }
}

describe("out-of-process heartbeat", () => {
  it("a separate process holding the owner's credentials can beat the lease, which is what a synchronous producer needs", () => {
    const repo = fixtureRepo();
    // The in-process interval added alongside this cannot help a producer that
    // blocks its own event loop -- determinism-baseline is a spawnSync loop,
    // and vi-refresh was observed printing progress with a 149s-stale
    // heartbeat. A beat must therefore be reachable from OUTSIDE the owner,
    // which means it cannot live in the owner's closure.
    const authority = assertEvidenceProducerAuthority(repo, {});
    const { state: statePath } = evidenceTransactionPaths(repo);
    const before = JSON.parse(readFileSync(statePath, "utf8"));

    heartbeatEvidenceTransaction({
      repo,
      transactionId: authority.transaction_id,
      delegationToken: authority.delegation_token,
    });

    const after = JSON.parse(readFileSync(statePath, "utf8"));
    expect(after.lifecycle.heartbeat.sequence).toBeGreaterThan(before.lifecycle.heartbeat.sequence);
  });

  it("refuses to beat a lease it does not hold the credentials for -- a beat must never make a foreign or dead owner look alive", () => {
    const repo = fixtureRepo();
    const authority = assertEvidenceProducerAuthority(repo, {});
    expect(() => heartbeatEvidenceTransaction({
      repo,
      transactionId: authority.transaction_id,
      delegationToken: "not-the-real-token",
    })).toThrow();
  });
});

describe("direct-owner producer heartbeat", () => {
  it("a producer that owns its own lease can beat it, so a long run is not indistinguishable from a wedged one", () => {
    const repo = fixtureRepo();
    // No lock exists, so this takes the DIRECT-OWNER branch: the producer
    // becomes the transaction owner itself. `evidence:rebind` spawns each
    // producer separately, so this — not the composite path — is what every
    // real producer run takes, and it recorded no progress at all: observed
    // heartbeat ages of 383s, 450s and 497s on healthy owners against a
    // 30s staleness threshold, which made `evidence:status` unable to tell a
    // slow producer from a stuck one.
    const authority = assertEvidenceProducerAuthority(repo, {});
    expect(authority.direct_owner).toBe(true);

    const { state: statePath } = evidenceTransactionPaths(repo);
    const before = JSON.parse(readFileSync(statePath, "utf8"));
    expect(typeof authority.heartbeat).toBe("function");

    authority.heartbeat();
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    expect(after.lifecycle.heartbeat.sequence).toBeGreaterThan(before.lifecycle.heartbeat.sequence);
  });
});

function fixtureRepo() {
  const repo = temporary("revoy2-evtx-lifecycle-");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return repo;
}

// A raw scan of every JSON-shaped surface for the forbidden classes of data
// (Decision §5 bullet 5): argv, environment, tokens/digests as secrets,
// paths outside the redacted set, and producer output bytes.
function assertNoRawSensitiveData(value) {
  const text = JSON.stringify(value);
  expect(text).not.toMatch(/frozen-lockfile/); // argv fragment
  expect(text).not.toMatch(/REVOY_EVIDENCE_DELEGATION_TOKEN/);
  expect(text).not.toMatch(/delegation_token_digest/);
  expect(text).not.toMatch(/source_patch/);
  expect(text).not.toMatch(/"cwd"/);
  expect(text).not.toMatch(/"env"/);
}

describe("ADR-092 O1 — status distinguishes owner liveness from heartbeat progress with redacted lifecycle identity", () => {
  it("a live owner with a fresh heartbeat reports active phase, phase-entered age, source identity, and no recovery command", async () => {
    const repo = fixtureRepo();
    const lease = acquireEvidenceTransaction({ repo, transactionId: "fresh-tx" });
    try {
      lease.transition("dependency_install");
      lease.child("setup", "running", { command_id: "setup", pid: 123456, process_group_id: 123456, started_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 60_000).toISOString(), deadline_ms: 60_000 });
      const status = evidenceTransactionStatus({ repo });
      expect(status).toMatchObject({
        held: true,
        transaction_id: "fresh-tx",
        phase: "dependency_install",
        schema_version: 2,
        schema_supported: true,
        projection: "v2",
        owner_liveness: "live",
        progress_liveness: "fresh",
        recovery_command: null,
      });
      expect(status.phase_entered_at).toBeTruthy();
      expect(typeof status.phase_age_ms).toBe("number");
      expect(status.source).toEqual({ candidate_oid: expect.any(String), input_digest: expect.any(String) });
      expect(status.children.setup).toMatchObject({ status: "running", pid: 123456, process_group_id: 123456 });
      expect(status.message).not.toMatch(/evidence:recover/);
    } finally {
      lease.release();
    }
  });

  it("a live owner with an old heartbeat reports stale/no-progress honestly, without a recovery command", async () => {
    const repo = fixtureRepo();
    const lease = acquireEvidenceTransaction({ repo, transactionId: "stale-tx" });
    try {
      const injectedClock = () => Date.now() + EVIDENCE_HEARTBEAT_STALE_MS + 5_000;
      const status = evidenceTransactionStatus({ repo, clock: injectedClock });
      expect(status).toMatchObject({ held: true, owner_liveness: "live", progress_liveness: "stale", recovery_command: null, recommended_action: "wait_stale" });
      expect(status.message).toMatch(/STALE/);
      expect(status.message).not.toMatch(/evidence:recover/);
    } finally {
      lease.release();
    }
  });

  it("dead and ambiguous owners remain distinguishable; recovery is offered only for a proven-dead legacy transaction and archives rather than deletes", () => {
    const repo = fixtureRepo();
    const paths = evidenceTransactionPaths(repo);
    mkdirSync(paths.lock, { recursive: true });
    const deadState = {
      schema_version: 1,
      transaction_id: "dead-legacy-tx",
      owner: { owner_id: "dead", pid: 999999, process_start_identity: "linux-proc-start:0", acquired_at: "2020-01-01T00:00:00.000Z" },
      expected_candidate_oid: "a".repeat(40),
      expected_input_digest: "b".repeat(64),
      phase: "stalled",
      heartbeat_at: "2020-01-01T00:00:00.000Z",
      delegation_token_digest: hash("dead-token"),
    };
    writeFileSync(paths.state, JSON.stringify(deadState));
    const deadStatus = evidenceTransactionStatus({ repo });
    expect(deadStatus).toMatchObject({ owner_liveness: "dead", archive_eligible: true, recovery_command: `bun run evidence:recover -- --transaction dead-legacy-tx` });
    const recovered = recoverEvidenceTransaction({ repo, transactionId: "dead-legacy-tx" });
    expect(recovered.ok).toBe(true);
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(recovered.archive)).toBe(true); // archived, not deleted
    expect(JSON.parse(readFileSync(join(recovered.archive, "recovery.json"), "utf8")).source_state.transaction_id).toBe("dead-legacy-tx");

    mkdirSync(paths.lock, { recursive: true });
    writeFileSync(paths.state, JSON.stringify({ ...deadState, transaction_id: "ambiguous-tx", owner: { owner_id: "ambiguous", pid: process.pid, process_start_identity: null } }));
    const ambiguousStatus = evidenceTransactionStatus({ repo });
    expect(ambiguousStatus.owner_liveness).toBe("ambiguous");
    expect(ambiguousStatus.recovery_command).toBeNull();
    expect(() => recoverEvidenceTransaction({ repo, transactionId: "ambiguous-tx" })).toThrow(/cannot be proven dead/);
  });

  it("a dead v2 transaction without a terminal-success receipt requires explicit review before recovery, and archives once reviewed", () => {
    const repo = fixtureRepo();
    const lease = acquireEvidenceTransaction({ repo, transactionId: "crashed-tx" });
    const paths = lease.paths;
    // Simulate the owner process dying mid-flight: never released, never
    // wrote a terminal receipt. The pid below does not exist.
    const crashedState = JSON.parse(readFileSync(paths.state, "utf8"));
    crashedState.owner = { ...crashedState.owner, pid: 999999, process_start_identity: "linux-proc-start:0" };
    writeFileSync(paths.state, JSON.stringify(crashedState));
    expect(() => recoverEvidenceTransaction({ repo, transactionId: "crashed-tx" })).toThrow(/recovery_review_required|requires `--reviewed/);
    const reviewed = recoverEvidenceTransaction({ repo, transactionId: "crashed-tx", reviewed: true, review_reason: "confirmed process death via journal" });
    expect(reviewed.ok).toBe(true);
    expect(reviewed.reviewed).toBe(true);
  });
});

describe("ADR-092 O2 — every long lifecycle phase heartbeats, and timeout/cancellation reach durable terminal state without lease theft", () => {
  it("dependency_install and candidate_build heartbeat while active because the async runner never blocks the owner's timer", async () => {
    const repo = fixtureRepo();
    const lease = acquireEvidenceTransaction({ repo, transactionId: "heartbeat-tx" });
    try {
      const sequencesSeen = [];
      const poll = setInterval(() => {
        try { sequencesSeen.push(lease.heartbeat().lifecycle.heartbeat.sequence); } catch { /* ignore races */ }
      }, 15);
      await runEvidenceStagingSetup({
        cwd: repo,
        environment: {},
        lease,
        setupCommand: { command: "node", args: ["-e", "setTimeout(() => {}, 120)"] },
        buildCommand: { command: "node", args: ["-e", "setTimeout(() => {}, 120)"] },
        setupDeadlineMs: 10_000,
        buildDeadlineMs: 10_000,
      });
      clearInterval(poll);
      // The owner's own heartbeat poll advanced multiple times DURING the
      // ~240ms of child execution — proof the event loop was never blocked.
      expect(sequencesSeen.length).toBeGreaterThan(2);
      const distinctSequences = new Set(sequencesSeen);
      expect(distinctSequences.size).toBeGreaterThan(1);
      const finalState = JSON.parse(readFileSync(lease.paths.state, "utf8"));
      expect(finalState.lifecycle.children.setup).toMatchObject({ status: "succeeded" });
      expect(finalState.lifecycle.children.build).toMatchObject({ status: "succeeded" });
      expect(finalState.phase).toBe("candidate_build");
    } finally {
      lease.release();
    }
  });

  it("a producer that exceeds its deadline is killed, reported timed_out, and reaches a durable terminal receipt before cleanup/release", async () => {
    const repo = fixtureRepo();
    const marker = join(temporary("revoy2-evtx-marker-"), "marker.txt");
    const result = await runEvidenceRefreshTransaction({
      repo,
      producerDeadlineMs: 150,
      producerCommand: { command: "node", args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "started"); setInterval(() => {}, 1000);`] },
      stagingSetup: {
        setupCommand: { command: "node", args: ["-e", ""] },
        buildCommand: { command: "node", args: ["-e", ""] },
        setupDeadlineMs: 5_000,
        buildDeadlineMs: 5_000,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("timed_out");
    expect(existsSync(marker)).toBe(true); // the child really started…
    // …and really was killed: no lock left behind, and the lease was
    // released rather than left dangling for a future contender to inherit.
    const paths = evidenceTransactionPaths(repo);
    expect(existsSync(paths.lock)).toBe(false);
    const receiptPath = join(paths.receipts, `${result.transaction_id}.terminal.json`);
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.outcome).toBe("timed_out");
    expect(receipt.failure_code).toBe("producer_deadline_exceeded");
  });

  it("an owner-originated abort signal cancels the running producer and records a cancelled terminal outcome, never granting a waiting contender authority", async () => {
    const repo = fixtureRepo();
    const controller = new AbortController();
    const runPromise = runEvidenceRefreshTransaction({
      repo,
      abortSignal: controller.signal,
      producerDeadlineMs: 30_000,
      producerCommand: { command: "node", args: ["-e", "setInterval(() => {}, 1000)"] },
      stagingSetup: {
        setupCommand: { command: "node", args: ["-e", ""] },
        buildCommand: { command: "node", args: ["-e", ""] },
        setupDeadlineMs: 5_000,
        buildDeadlineMs: 5_000,
      },
    });
    // Abort only once the producer is genuinely running: a fixed sleep races
    // the spawn under load, and cancelling nothing is not the property here.
    await waitFor(() => producerIsRunning(repo), { label: "the producer to report running" });
    controller.abort();
    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("cancelled");
    const paths = evidenceTransactionPaths(repo);
    expect(existsSync(paths.lock)).toBe(false);
    // A contender may now acquire cleanly — the lease was released, not stolen.
    const next = acquireEvidenceTransaction({ repo, transactionId: "post-cancel-tx" });
    next.release();
  });
});

describe("ADR-092 O3 boundary — redaction never leaks argv, environment, tokens, source patches, or producer output", () => {
  it("status, receipts, and the human message never contain forbidden raw process/credential data", async () => {
    const repo = fixtureRepo();
    const secretLikeOutput = "REVOY_EVIDENCE_DELEGATION_TOKEN=super-secret-should-never-appear";
    const result = await runEvidenceRefreshTransaction({
      repo,
      producer: async () => ({ output: secretLikeOutput, exit_code: 0 }),
    });
    expect(result.ok).toBe(true);
    const paths = evidenceTransactionPaths(repo);
    const receiptPath = join(paths.receipts, `${result.transaction_id}.terminal.json`);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assertNoRawSensitiveData(receipt);
    expect(JSON.stringify(receipt)).not.toMatch(/super-secret-should-never-appear/);

    const status = evidenceTransactionStatus({ repo });
    assertNoRawSensitiveData(status);
  });
});
