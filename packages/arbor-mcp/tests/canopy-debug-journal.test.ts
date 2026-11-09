import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanopyDebugJournal, defaultCanopyDebugPersistenceDir } from "../src/canopy-debug-journal.js";
import { isCanopyDebugEnabled } from "../src/canopy-debug-launch.js";

describe("canopy-debug SQLite journal", () => {
  it("resolves a durable default without coupling telemetry to the checkout", () => {
    expect(defaultCanopyDebugPersistenceDir({ CANOPY_DEBUG_STATE_DIR: "/tmp/canopy-state" }, "/home/operator")).toBe("/tmp/canopy-state");
    expect(defaultCanopyDebugPersistenceDir({}, "/home/operator")).toBe("/home/operator/.arbor/canopy-debug");
  });

  it("enables persistent capture only for the dedicated launcher", () => {
    expect(isCanopyDebugEnabled({})).toBe(false);
    expect(isCanopyDebugEnabled({ CANOPY_DEBUG_ENABLED: "0" })).toBe(false);
    expect(isCanopyDebugEnabled({ CANOPY_DEBUG_ENABLED: "1" })).toBe(true);
  });

  it("indexes events and exports the same machine-readable envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-debug-journal-"));
    const path = join(root, "journal.sqlite");
    const journal = createCanopyDebugJournal({ path, session_id: "session-a", clock: () => new Date("2026-09-20T12:00:00.000Z"), monotonic: () => 42n });
    const input = journal.append({ kind: "input", level: "info", correlation_id: "turn-1", payload: { text: "hello", api_key: "do-not-store-this-value" } });
    journal.append({ kind: "api_request", correlation_id: "turn-1", payload: { model: "demo", token: "secret-token-value" } });
    expect(input.monotonic_ns).toBe("42");
    expect(journal.query({ kind: "input" })).toHaveLength(1);
    expect(journal.query({ correlation_id: "turn-1", limit: 1 })).toHaveLength(1);
    expect(journal.exportNdjson({ kind: "input" })).toContain('"kind":"input"');
    expect(journal.exportNdjson()).not.toContain("do-not-store-this-value");
    journal.close();
    expect((await readFile(path)).byteLength).toBeGreaterThan(0);
  });

  it("records artifact metadata and recovers an abandoned prior session", async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-debug-journal-"));
    const path = join(root, "journal.sqlite");
    const first = createCanopyDebugJournal({ path, session_id: "crashed", clock: () => new Date("2026-09-20T12:00:00.000Z") });
    first.append({ kind: "output", payload: { text: "partial" } });
    const artifact = first.recordArtifact({ path: "artifacts/shot.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]), width: 10, height: 20 });
    expect(artifact.sha256).toMatch(/^sha256:/);
    // Intentionally leave `first` open to model a process crash.
    const second = createCanopyDebugJournal({ path, session_id: "restarted", clock: () => new Date("2026-09-20T12:01:00.000Z") });
    expect(second.artifacts()).toHaveLength(0);
    second.close();
    // Reopening the DB proves recovery did not erase the prior rows.
    first.close();
    const verify = createCanopyDebugJournal({ path, session_id: "verified", clock: () => new Date("2026-09-20T12:02:00.000Z") });
    expect(verify.query({ session_id: "crashed", kind: "output" })).toHaveLength(1);
    verify.close();
  });
});
