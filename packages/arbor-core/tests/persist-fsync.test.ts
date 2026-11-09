/**
 * WA-38 (audit/2026-08-23-50-defects.md; packet X-4 in
 * audit/2026-08-23-55-crosscuts.md): `saveCampaign` wrote+renamed its
 * snapshot with no fsync at all, unlike `packages/arbor-audit/src/atomic-
 * write.ts`'s canonical `atomicOverwriteFile` (temp write -> fsync file ->
 * rename -> fsync parent dir). A crash between the rename and the next real
 * fsync of that directory (by an unrelated write) could lose the just-
 * "durably" saved snapshot entirely, or leave the directory entry for it
 * unflushed.
 *
 * `node:fs` is partially mocked so `fsyncSync` is a spy wrapping the real
 * implementation — the write must still land on disk (verified via
 * `loadCampaignResult` in this same test), and the spy proves fsync was
 * genuinely invoked for both the temp file and the parent directory, not
 * merely that the code compiles a call that never runs.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

import { fsyncSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, saveCampaign, loadCampaignResult } from "../src/index.js";

afterEach(() => {
  vi.mocked(fsyncSync).mockClear();
});

describe("WA-38: saveCampaign fsyncs the temp file before rename and the parent directory after", () => {
  it("calls fsyncSync at least once for the written file and once for the tree directory (POSIX)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-core-persist-fsync-"));
    try {
      const campaign = createCampaign("camp-fsync", "plan.md", {
        description: "root", estimated_gain: 10, estimated_cost: 1, category: "root", delegate_to: "crown",
      });

      saveCampaign(campaign, dir);

      // The write must genuinely have landed — fsync proof is worthless if
      // it were paired with a broken save.
      const loaded = loadCampaignResult("camp-fsync", dir).value;
      expect(loaded?.id).toBe("camp-fsync");

      // On POSIX (this test's platform) saveCampaign's atomic-write helper
      // fsyncs exactly twice: the temp file's descriptor before the rename,
      // and the tree directory's descriptor after it, so the rename itself
      // is durable across a crash.
      expect(fsyncSync).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second saveCampaign (overwrite) fsyncs again — not just the first write", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-core-persist-fsync-overwrite-"));
    try {
      const campaign = createCampaign("camp-fsync-2", "plan.md", {
        description: "root", estimated_gain: 10, estimated_cost: 1, category: "root", delegate_to: "crown",
      });
      saveCampaign(campaign, dir);
      vi.mocked(fsyncSync).mockClear();

      campaign.iterations_completed = 1;
      saveCampaign(campaign, dir);

      expect(fsyncSync).toHaveBeenCalledTimes(2);
      const loaded = loadCampaignResult("camp-fsync-2", dir).value;
      expect(loaded?.iterations_completed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
