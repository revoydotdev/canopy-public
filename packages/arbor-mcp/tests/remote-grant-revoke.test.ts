import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteOperationTokenAuthority } from "../src/remote/ephemeral-token.js";
import { main } from "../src/cli.js";
import { PassThrough } from "node:stream";

// WA-45: ephemeral grant tokens could not be revoked before their TTL. A
// compromised or mis-issued remote grant had to be waited out.
describe("remote grant revocation", () => {
  it("fails verifyAndConsume for a revoked grant even before its TTL, and revoking twice is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-grant-revoke-")); let time = Date.parse("2026-08-12T00:00:00.000Z"); const now = () => new Date(time);
    try {
      const authority = new RemoteOperationTokenAuthority({ persistence_dir: dir, now });
      const issued = authority.issue({ session_id: "s", campaign_id: "c", operation_id: "o", capabilities: ["command.dispatch"], sensitive: false }, 60_000);
      const revoked = authority.revoke(issued.grant.grant_id, "operator compromise response");
      expect(revoked).toMatchObject({ state: "revoked", revoked_reason: "operator compromise response" });
      expect(() => authority.verifyAndConsume(issued.token, { session_id: "s", campaign_id: "c", operation_id: "o", capability: "command.dispatch" })).toThrow("revoked");
      // Revoking again is a no-op, not an error.
      expect(authority.revoke(issued.grant.grant_id, "second attempt")).toMatchObject({ state: "revoked", revoked_reason: "operator compromise response" });
      // A revoked state survives TTL expiry rather than being reclassified "expired".
      time += 61_000;
      expect(authority.inspect(issued.grant.grant_id).state).toBe("revoked");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("requires a reason and refuses to revoke an already-consumed grant", () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-grant-revoke-2-")); const now = () => new Date("2026-08-12T00:00:00.000Z");
    try {
      const authority = new RemoteOperationTokenAuthority({ persistence_dir: dir, now });
      const issued = authority.issue({ session_id: "s", campaign_id: "c", operation_id: "o", capabilities: ["result.submit"], sensitive: false }, 60_000);
      expect(() => authority.revoke(issued.grant.grant_id, "")).toThrow("reason");
      authority.verifyAndConsume(issued.token, { session_id: "s", campaign_id: "c", operation_id: "o", capability: "result.submit" });
      expect(() => authority.revoke(issued.grant.grant_id, "too late")).toThrow("consumed");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("arbor-mcp remote-grant revoke CLI verb revokes a real issued grant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-grant-revoke-cli-")); const stdout = new PassThrough(); const stderr = new PassThrough();
    let out = ""; let err = ""; stdout.on("data", (chunk) => { out += String(chunk); }); stderr.on("data", (chunk) => { err += String(chunk); });
    try {
      const issueCode = await main(["remote-grant", "issue", "--session", "s", "--campaign", "c", "--operation", "o", "--capability", "command.dispatch"], { cwd: dir, persistence_dir: dir, stdin: new PassThrough(), stdout, stderr, env: {} });
      expect(issueCode).toBe(0);
      const issued = JSON.parse(out.trim().split("\n").pop()!) as { grant: { grant_id: string } };
      out = "";
      const revokeCode = await main(["remote-grant", "revoke", "--grant", issued.grant.grant_id, "--reason", "cli revoke test"], { cwd: dir, persistence_dir: dir, stdin: new PassThrough(), stdout, stderr, env: {} });
      expect(revokeCode).toBe(0);
      const revoked = JSON.parse(out.trim().split("\n").pop()!) as { state: string; revoked_reason: string };
      expect(revoked).toMatchObject({ state: "revoked", revoked_reason: "cli revoke test" });
      expect(err).toBe("");
      const missingArgsCode = await main(["remote-grant", "revoke", "--grant", issued.grant.grant_id], { cwd: dir, persistence_dir: dir, stdin: new PassThrough(), stdout, stderr, env: {} });
      expect(missingArgsCode).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
