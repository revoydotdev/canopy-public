import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteKbStore } from "../src/index.js";

const entry = (value: string) => ({
  campaign_id: "campaign",
  type: "success_pattern" as const,
  value,
  provenance: { tag: "verified" as const, cmd: "test", exit: 0 as const, stdout_hash: "hash" },
  as_of: "2026-01-01T00:00:00.000Z",
  tier: "specialist_visible" as const,
  tags: [],
});

describe("SqliteKbStore persisted counter", () => {
  it("continues base-36 IDs after reopening a database past z", () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-kb-counter-"));
    const path = join(directory, "kb.sqlite");
    try {
      const first = new SqliteKbStore(path);
      for (let index = 0; index < 36; index += 1) first.write(entry(`entry-${index}`));
      first.close();
      const reopened = new SqliteKbStore(path);
      expect(reopened.write(entry("after-reopen"))).toBe("kb_11");
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
