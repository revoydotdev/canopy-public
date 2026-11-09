#!/usr/bin/env bun
/**
 * evidence-heartbeat-sidecar — beat a lease on behalf of a producer that
 * cannot beat it itself.
 *
 * WHY THIS EXISTS. `evidence:status` distinguishes a wedged owner from a slow
 * one by heartbeat age, with a 30-second staleness threshold. That works only
 * if the owner can actually beat. Two of this repository's producers cannot:
 * `determinism-baseline` is a synchronous `spawnSync` loop, and `vi-refresh`
 * was observed printing progress with a 149-second-stale heartbeat. A timer in
 * their own process can never fire, because their own event loop is blocked.
 *
 * The consequence was not cosmetic. Every long producer reported "LIVE but
 * heartbeat is STALE (no confirmed progress)" — the exact phrase that also
 * describes a hung process — so the only way to decide whether recovery was
 * safe was to run `ps -p <pid>` by hand. That happened five times in one
 * session, and a status line that cries wolf on every healthy run teaches its
 * reader to ignore it.
 *
 * WHY IT CANNOT BE USED TO FAKE LIVENESS. It beats only while the owner
 * process is still alive, checked every tick with `process.kill(pid, 0)`, and
 * exits the moment that fails. It also holds no authority of its own: the beat
 * goes through `heartbeatEvidenceTransaction`, which runs the same
 * `assertOwner` as every other mutation, so without the transaction's real
 * delegation token it is refused. If this process dies, the heartbeat simply
 * goes stale again — the pre-existing behaviour, and a fail-safe one.
 *
 * The credentials arrive by environment, never argv, so they do not appear in
 * another user's `ps` output.
 */
import { heartbeatEvidenceTransaction } from "./evidence-transaction.mjs";

// Overridable only for the integration test (scripts/tests/evidence-heartbeat-sidecar.test.mjs),
// which cannot wait 10s per tick and drive real subprocess liveness/recovery
// deterministically without a much shorter tick; production always gets the
// default.
const BEAT_INTERVAL_MS = Number.parseInt(process.env.REVOY_HEARTBEAT_INTERVAL_MS ?? "", 10) || 10_000;

const repo = process.env.REVOY_HEARTBEAT_REPO;
const transactionId = process.env.REVOY_EVIDENCE_TRANSACTION_ID;
const delegationToken = process.env.REVOY_EVIDENCE_DELEGATION_TOKEN;
const ownerPid = Number.parseInt(process.env.REVOY_HEARTBEAT_OWNER_PID ?? "", 10);

if (!repo || !transactionId || !delegationToken || !Number.isInteger(ownerPid)) {
  // Refuse rather than beat something unidentified: a sidecar that guesses its
  // target is exactly the thing that could keep a dead lease looking alive.
  process.stderr.write("evidence-heartbeat-sidecar: refusing to start without repo, transaction, token and owner pid\n");
  process.exit(2);
}

/** True while the producer this sidecar serves is still running. */
function ownerAlive() {
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch {
    return false;
  }
}

const timer = setInterval(() => {
  if (!ownerAlive()) {
    clearInterval(timer);
    process.exit(0);
  }
  try {
    heartbeatEvidenceTransaction({ repo, transactionId, delegationToken });
  } catch {
    // The lease moved on — recovered, released, or taken over. Beating it
    // further would be asserting something this process cannot know is true.
    clearInterval(timer);
    process.exit(0);
  }
}, BEAT_INTERVAL_MS);
