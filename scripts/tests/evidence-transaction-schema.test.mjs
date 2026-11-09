/**
 * ADR-101 O2 — an unknown-but-higher `schema_version` with a valid envelope
 * resolves as `unsupported_schema_version` ("held by a newer writer, wait"),
 * distinctly from a genuinely malformed lock.
 *
 * The live incident this closes: a ~70-worktree checkout shares one lock
 * path across branches running different revisions of
 * `evidence-transaction.mjs`. `readState` used to hard-fail any
 * `schema_version !== LOCK_SCHEMA_VERSION` as `ambiguous_lock` ("malformed"),
 * which made a perfectly healthy schema-2 writer's lock indistinguishable
 * from a truncated file. These tests construct synthetic lock state.json
 * files directly (never touching this repo's real
 * `.git/arbor/evidence-refresh/`) and assert `readState` tells the two
 * cases apart.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceTransactionRefusal,
  evidenceTransactionPaths,
  evidenceTransactionStatus,
  readState,
} from "../evidence-transaction.mjs";

function makeLockDir() {
  const commonDir = mkdtempSync(join(tmpdir(), "arbor-evidence-schema-test-"));
  const paths = evidenceTransactionPaths("/unused-repo-root", commonDir);
  mkdirSync(paths.lock, { recursive: true, mode: 0o700 });
  return paths;
}

function validEnvelope(overrides = {}) {
  return {
    schema_version: 99,
    transaction_id: "txn-schema-99",
    owner: {
      pid: process.pid,
      owner_id: `pid:${process.pid}`,
      acquired_at: new Date(Date.now() - 5_000).toISOString(),
      process_start_identity: null,
    },
    heartbeat_at: new Date(Date.now() - 1_000).toISOString(),
    phase: "producer_running",
    // A future-schema-specific field a schema-1 reader has never heard of —
    // must remain opaque, never interpreted, never required.
    lifecycle: { heartbeat: { sequence: 3, at: new Date().toISOString() }, deadline: { status: "armed", at: new Date(Date.now() + 60_000).toISOString() } },
    ...overrides,
  };
}

describe("ADR-101 O2 — readState distinguishes an unsupported schema version from a malformed lock", () => {
  it("schema_version 99 with a complete, correctly-typed envelope raises unsupported_schema_version, not ambiguous_lock", () => {
    const paths = makeLockDir();
    try {
      writeFileSync(paths.state, JSON.stringify(validEnvelope()));
      let caught;
      try { readState(paths); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(EvidenceTransactionRefusal);
      expect(caught.code).toBe("unsupported_schema_version");
      expect(caught.message).not.toMatch(/malformed/i);
      expect(caught.message).toMatch(/newer or older writer/i);
      // ownerLiveness and message construction can still run against the
      // envelope's owner fields even though schema 99 is otherwise opaque.
      expect(caught.state.owner.pid).toBe(process.pid);
      expect(caught.state.schema_version).toBe(99);
    } finally {
      rmSync(paths.common_dir, { recursive: true, force: true });
    }
  });

  it("schema_version 99 with a missing owner still raises ambiguous_lock", () => {
    const paths = makeLockDir();
    try {
      const broken = validEnvelope();
      delete broken.owner;
      writeFileSync(paths.state, JSON.stringify(broken));
      let caught;
      try { readState(paths); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(EvidenceTransactionRefusal);
      expect(caught.code).toBe("ambiguous_lock");
      expect(caught.message).toMatch(/malformed/i);
    } finally {
      rmSync(paths.common_dir, { recursive: true, force: true });
    }
  });

  it("schema_version 99 with a mistyped owner.pid still raises ambiguous_lock", () => {
    const paths = makeLockDir();
    try {
      const broken = validEnvelope({ owner: { pid: "not-a-number", owner_id: "x", acquired_at: new Date().toISOString(), process_start_identity: null } });
      writeFileSync(paths.state, JSON.stringify(broken));
      let caught;
      try { readState(paths); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(EvidenceTransactionRefusal);
      expect(caught.code).toBe("ambiguous_lock");
    } finally {
      rmSync(paths.common_dir, { recursive: true, force: true });
    }
  });

  it("a genuinely truncated/non-JSON lock file still raises ambiguous_lock", () => {
    const paths = makeLockDir();
    try {
      writeFileSync(paths.state, '{"schema_version": 1, "transaction_id": "tr');
      let caught;
      try { readState(paths); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(EvidenceTransactionRefusal);
      expect(caught.code).toBe("ambiguous_lock");
    } finally {
      rmSync(paths.common_dir, { recursive: true, force: true });
    }
  });

  it("evidenceTransactionStatus reports an unsupported schema version as held, waitable, and names the owner and heartbeat age — never as malformed", () => {
    const paths = makeLockDir();
    try {
      writeFileSync(paths.state, JSON.stringify(validEnvelope()));
      const status = evidenceTransactionStatus({ repo: "/unused-repo-root", commonDir: paths.common_dir });
      expect(status.held).toBe(true);
      expect(status.liveness).toBe("unsupported_schema_version");
      expect(status.schema_supported).toBe(false);
      expect(status.owner.pid).toBe(process.pid);
      expect(status.message).toMatch(new RegExp(`pid ${process.pid}`));
      expect(status.message).not.toMatch(/malformed/i);
    } finally {
      rmSync(paths.common_dir, { recursive: true, force: true });
    }
  });
});
