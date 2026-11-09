import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCodexAuthStoreLock } from "../src/codex-auth-store-lock.js";

describe("Codex auth store lock", () => {
  it("serializes refresh writes so concurrent CLI calls cannot lose a rotated token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-codex-auth-lock-"));
    const authPath = join(directory, "auth.json");
    await writeFile(authPath, JSON.stringify({ tokens: { access_token: "access-0", refresh_token: "refresh-0" } }), { mode: 0o600 });
    const refresh = (suffix: string) => withCodexAuthStoreLock(authPath, new AbortController().signal, async () => {
      const auth = JSON.parse(await readFile(authPath, "utf8")) as { tokens: { access_token: string; refresh_token: string } };
      await new Promise((resolve) => setTimeout(resolve, 10));
      auth.tokens.access_token = `access-${suffix}`;
      auth.tokens.refresh_token = `refresh-${suffix}`;
      await writeFile(authPath, JSON.stringify(auth), { mode: 0o600 });
    });
    try {
      await Promise.all([refresh("one"), refresh("two")]);
      const persisted = JSON.parse(await readFile(authPath, "utf8")) as { tokens: { access_token: string; refresh_token: string } };
      expect(persisted.tokens.access_token).toMatch(/^access-(one|two)$/);
      expect(persisted.tokens.refresh_token).toMatch(/^refresh-(one|two)$/);
      expect(persisted.tokens.refresh_token.slice("refresh-".length)).toBe(persisted.tokens.access_token.slice("access-".length));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reclaims an atomically published lock whose recorded process is dead", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-codex-dead-lock-"));
    const authPath = join(directory, "auth.json");
    const lockPath = `${authPath}.canopy-lock`;
    await writeFile(authPath, "{}", { mode: 0o600 });
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "stale-test-token" }), { mode: 0o600 });
    try {
      await expect(withCodexAuthStoreLock(authPath, new AbortController().signal, async () => "acquired")).resolves.toBe("acquired");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("does not rename or unlink a newer live reaper observed after a stale auth lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-codex-reaper-race-"));
    const authPath = join(directory, "auth.json");
    const lockPath = `${authPath}.canopy-lock`;
    const reaperPath = `${lockPath}.reaper`;
    const staleOwner = { pid: 2_147_483_647, token: "R0-dead-owner" };
    const liveReaper = { pid: process.pid, token: "R1-live-reaper" };
    await writeFile(authPath, "{}", { mode: 0o600 });
    await writeFile(lockPath, JSON.stringify(staleOwner), { mode: 0o600 });
    // This is the state after contender A observed dead R0, while contender B
    // has already atomically published live R1 at the reaper path.
    await writeFile(reaperPath, JSON.stringify(liveReaper), { mode: 0o600 });
    try {
      await expect(withCodexAuthStoreLock(authPath, new AbortController().signal, async () => "must not acquire", { max_wait_ms: 10 }))
        .rejects.toThrow(`recovery lock ${reaperPath} is held by pid ${process.pid} (live)`);
      expect(JSON.parse(await readFile(reaperPath, "utf8"))).toEqual(liveReaper);
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(staleOwner);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reports a dead reaper path and PID without removing its record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-codex-dead-reaper-"));
    const authPath = join(directory, "auth.json");
    const lockPath = `${authPath}.canopy-lock`;
    const reaperPath = `${lockPath}.reaper`;
    const staleOwner = { pid: 2_147_483_647, token: "stale-auth-owner" };
    const staleReaper = { pid: 2_147_483_646, token: "stale-reaper-owner" };
    await writeFile(authPath, "{}", { mode: 0o600 });
    await writeFile(lockPath, JSON.stringify(staleOwner), { mode: 0o600 });
    await writeFile(reaperPath, JSON.stringify(staleReaper), { mode: 0o600 });
    try {
      await expect(withCodexAuthStoreLock(authPath, new AbortController().signal, async () => "must not acquire", { max_wait_ms: 10 }))
        .rejects.toThrow(`recovery lock ${reaperPath} is held by pid ${staleReaper.pid} (confirmed dead; manual recovery required)`);
      expect(JSON.parse(await readFile(reaperPath, "utf8"))).toEqual(staleReaper);
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(staleOwner);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
