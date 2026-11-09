import { describe, expect, it } from "vitest"; import { mkdtempSync, readFileSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { RemoteOperationTokenAuthority } from "../src/remote/ephemeral-token.js";

describe("ephemeral remote operation grants", () => {
  it("expires, is single-use, exact-scope, and persists no bearer secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-grant-")); let time = Date.parse("2026-08-12T00:00:00.000Z"); const now = () => new Date(time);
    try {
      const authority = new RemoteOperationTokenAuthority({ persistence_dir: dir, now });
      const issued = authority.issue({ session_id: "s", campaign_id: "c", operation_id: "o", capabilities: ["command.dispatch"], sensitive: false }, 30_000);
      expect(readFileSync(join(dir, "remote-operation-grants.json"), "utf8")).not.toContain(issued.token);
      expect(() => authority.verifyAndConsume(issued.token, { session_id: "s", campaign_id: "other", operation_id: "o", capability: "command.dispatch" })).toThrow("scope");
      const replacement = authority.issue({ session_id: "s", campaign_id: "c", operation_id: "o2", capabilities: ["command.dispatch"], sensitive: false }, 30_000);
      time += 30_001; expect(() => authority.verifyAndConsume(replacement.token, { session_id: "s", campaign_id: "c", operation_id: "o2", capability: "command.dispatch" })).toThrow("expired");
      const one = authority.issue({ session_id: "s", campaign_id: "c", operation_id: "o3", capabilities: ["result.submit"], sensitive: false }, 30_000);
      authority.verifyAndConsume(one.token, { session_id: "s", campaign_id: "c", operation_id: "o3", capability: "result.submit" });
      expect(() => authority.verifyAndConsume(one.token, { session_id: "s", campaign_id: "c", operation_id: "o3", capability: "result.submit" })).toThrow("already consumed");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
