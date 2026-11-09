/**
 * WA-38 (audit/2026-08-23-50-defects.md; packet X-5 in
 * audit/2026-08-23-55-crosscuts.md): `operator-maintenance.ts`'s `atomicWrite`
 * (used for migration backups, the rewritten `arbor.jsonc`, and receipts)
 * wrote a temp file and renamed it with no fsync at all — a third hand-
 * rolled atomic write missing the same durability step `packages/arbor-audit/
 * src/atomic-write.ts`'s canonical primitive already has.
 *
 * `node:fs` is partially mocked so `fsyncSync` is a spy wrapping the real
 * implementation — the migration must still genuinely apply (verified via
 * the rewritten `arbor.jsonc` content, exactly like the existing "safe
 * migration authority" describe block in operator-maintenance.test.ts), and
 * the spy proves fsync is genuinely invoked for both the temp file and the
 * parent directory on every `atomicWrite` call `applyMigration` makes
 * (backup, target, receipt — three when an existing target is overwritten).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

import { fsyncSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigration, previewMigration } from "../src/operator-maintenance.js";

const roots: string[] = [];
const root = (): string => { const value = mkdtempSync(join(tmpdir(), "arbor-maintenance-fsync-")); roots.push(value); return value; };
afterEach(() => {
  vi.mocked(fsyncSync).mockClear();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("WA-38: operator-maintenance atomicWrite fsyncs the temp file before rename and the parent directory after", () => {
  it("fsyncs twice (file + directory) for each real write applyMigration makes — backup, target, and receipt when an existing target is overwritten", () => {
    const cwd = root();
    const source = join(cwd, "opencode.json");
    const target = join(cwd, "arbor.jsonc");
    writeFileSync(source, JSON.stringify({ provider: "openrouter", model: "example/model" }));
    writeFileSync(target, "operator-owned", "utf8");
    const preview = previewMigration({ cwd, source_path: "opencode.json" });

    const receipt = applyMigration({ cwd, source_path: "opencode.json", expected_source_sha256: preview.source.sha256, overwrite: true });

    // The migration must have genuinely applied — fsync proof is worthless
    // paired with a broken write.
    expect(readFileSync(target, "utf8")).toContain("openrouter");
    expect(receipt.backup_path).not.toBeNull();

    // Three atomicWrite calls here (backup, rewritten target, receipt) at
    // two fsyncSync calls each (temp file, then parent directory on POSIX).
    expect(fsyncSync).toHaveBeenCalledTimes(6);
  });

  it("fsyncs twice for a migration with no pre-existing target (target + receipt, no backup)", () => {
    const cwd = root();
    const source = join(cwd, "source.json");
    writeFileSync(source, JSON.stringify({ provider: "p", model: "m" }));
    const preview = previewMigration({ cwd, source_path: "source.json" });

    applyMigration({ cwd, source_path: "source.json", expected_source_sha256: preview.source.sha256, overwrite: false });

    // Two atomicWrite calls (rewritten target, receipt) — no backup exists
    // to write, since there was no pre-existing arbor.jsonc.
    expect(fsyncSync).toHaveBeenCalledTimes(4);
  });
});
