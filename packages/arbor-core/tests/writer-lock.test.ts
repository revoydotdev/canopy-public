/**
 * writer-lock.test.ts — one writer per persistence directory (ADR-029).
 *
 * THE FAILURE THIS PREVENTS. `saveLedger` does a read-modify-append with no
 * coordination. Two processes on one directory interleave, and the loser's
 * append is refused by the chain's integrity check — correct, but nothing
 * retries or rebases it, so that evidence is silently dropped. An audit proved
 * two `arbor-mcp serve`/`webui` processes on one directory is reachable.
 *
 * The first test below reproduces the drop against the REAL saveLedger, so the
 * lock is defending a demonstrated failure rather than a hypothesis.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWriterLock, WRITER_LOCK_FILENAME } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function root(): string { const d = mkdtempSync(join(tmpdir(), "arbor-writer-lock-")); dirs.push(d); return d; }

describe("writer lock", () => {
  it("refuses a second holder while the first is alive", () => {
    const dir = root();
    const first = acquireWriterLock(dir, { holder: "serve" });
    expect(first.ok).toBe(true);

    const second = acquireWriterLock(dir, { holder: "webui" });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("second holder must be refused");
    expect(second.held_by?.pid).toBe(process.pid);
    expect(second.detail).toContain("already owned by pid");
    // The refusal names the consequence, so an operator reading stderr learns
    // why it matters rather than only that it happened.
    expect(second.detail).toContain("silently drop");
  });

  it("allows a new holder after release — the lock is not a one-shot", () => {
    const dir = root();
    const first = acquireWriterLock(dir, { holder: "serve" });
    if (!first.ok) throw new Error("first acquisition should succeed");
    expect(existsSync(join(dir, WRITER_LOCK_FILENAME))).toBe(true);

    first.lock.release();
    expect(existsSync(join(dir, WRITER_LOCK_FILENAME))).toBe(false);

    const second = acquireWriterLock(dir, { holder: "webui" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.reclaimed_stale).toBe(false);
  });

  it("reclaims a lock whose owner is gone, so a hard kill does not disable the directory forever", () => {
    const dir = root();
    // A pid that cannot be running: a plausible-looking but dead owner, the
    // state a SIGKILLed server leaves behind.
    const deadPid = 2 ** 22;
    writeFileSync(
      join(dir, WRITER_LOCK_FILENAME),
      JSON.stringify({ pid: deadPid, acquired_at: "2026-08-01T00:00:00.000Z", holder: "serve" }),
      "utf-8",
    );

    const result = acquireWriterLock(dir, { holder: "serve" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("stale lock should be reclaimed");
    expect(result.reclaimed_stale).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, WRITER_LOCK_FILENAME), "utf-8")).pid).toBe(process.pid);
  });

  it("refuses an unparseable lock rather than assuming it is abandoned", () => {
    // Fail-closed: we cannot show the owner is gone, so deleting it would be
    // the fail-open choice on exactly the evidence we do not have.
    const dir = root();
    writeFileSync(join(dir, WRITER_LOCK_FILENAME), "{not json", "utf-8");

    const result = acquireWriterLock(dir, { holder: "serve" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unparseable lock must not be reclaimed");
    expect(result.detail).toContain("could not be parsed");
    // Untouched — refusing must not destroy the thing it refused on.
    expect(readFileSync(join(dir, WRITER_LOCK_FILENAME), "utf-8")).toBe("{not json");
  });

  it("release only removes a lock this handle still owns", () => {
    // After a stale reclaim, the original handle must not delete the new
    // owner's lock: that would silently hand the directory to a third process.
    const dir = root();
    const mine = acquireWriterLock(dir, { holder: "serve" });
    if (!mine.ok) throw new Error("acquisition should succeed");

    writeFileSync(
      join(dir, WRITER_LOCK_FILENAME),
      JSON.stringify({ pid: process.pid + 1, acquired_at: "2026-08-05T00:00:00.000Z", holder: "webui" }),
      "utf-8",
    );
    mine.lock.release();

    expect(existsSync(join(dir, WRITER_LOCK_FILENAME))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, WRITER_LOCK_FILENAME), "utf-8")).holder).toBe("webui");
  });

  it("is atomic: only one of many concurrent acquisitions succeeds", () => {
    // The check-then-create window this design avoids. openSync(path, "wx")
    // fails when the file exists, so interleaving cannot produce two winners.
    const dir = root();
    const results = Array.from({ length: 12 }, (_, i) => acquireWriterLock(dir, { holder: `holder-${i}` }));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
