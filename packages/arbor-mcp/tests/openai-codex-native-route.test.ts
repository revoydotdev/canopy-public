import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSecureCodexAuthStore, buildCodexCliArgs, codexCliEnvironment, codexCliRuntimeEnvironment, waitForCodexChild } from "../src/openai-codex-native-route.js";

describe("OpenAI Codex native inference route controls", () => {
  it("disables the CLI tool and extension surfaces and constrains filesystem access", () => {
    const args = buildCodexCliArgs({ model: "gpt-test", cwd: "/tmp/codex-scratch", schema_path: "/tmp/schema.json", output_path: "/tmp/last.json" });
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain("features.unified_exec=false");
    expect(args).toContain("features.multi_agent=false");
    expect(args).toContain("features.hooks=false");
    expect(args).toContain("mcp_servers={}");
    expect(args).toContain("plugins={}");
    expect(args).toContain("--strict-config");
  });

  it("does not pass provider API secrets or unrelated process env into codex", () => {
    expect(codexCliEnvironment({ PATH: "/bin", HOME: "/home/user", OPENAI_API_KEY: "never-forward", ARBOR_NATIVE_API_KEY: "never-forward", AWS_SECRET_ACCESS_KEY: "never-forward" })).toEqual({ PATH: "/bin", HOME: "/home/user" });
  });

  it("keeps the durable first-party auth store while isolating HOME config and state", () => {
    expect(codexCliRuntimeEnvironment({ PATH: "/bin", HOME: "/home/user", CODEX_HOME: "/home/user/.codex", OPENAI_API_KEY: "never-forward" }, "/home/user/.codex/auth.json", "/tmp/canopy/home"))
      .toEqual({ PATH: "/bin", HOME: "/tmp/canopy/home", CODEX_HOME: "/home/user/.codex" });
  });

  it("accepts only a private, owned, non-symlink auth store", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-codex-auth-mode-"));
    const home = join(root, "codex-home");
    const auth = join(home, "auth.json");
    const target = join(home, "target.json");
    const symlinkAuth = join(home, "symlink-auth.json");
    try {
      mkdirSync(home, { mode: 0o700 });
      writeFileSync(auth, "{}", { mode: 0o600 });
      await expect(assertSecureCodexAuthStore(auth)).resolves.toBeUndefined();
      chmodSync(auth, 0o644);
      await expect(assertSecureCodexAuthStore(auth)).rejects.toThrow("auth.json must be an owned, non-symlink file");
      chmodSync(auth, 0o600);
      writeFileSync(target, "{}", { mode: 0o600 });
      symlinkSync(target, symlinkAuth);
      await expect(assertSecureCodexAuthStore(symlinkAuth)).rejects.toThrow("auth.json must be an owned, non-symlink file");
      chmodSync(home, 0o755);
      await expect(assertSecureCodexAuthStore(auth)).resolves.toBeUndefined();
      chmodSync(home, 0o777);
      await expect(assertSecureCodexAuthStore(auth)).rejects.toThrow("CODEX_HOME must be an owned");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("escalates abort to SIGKILL and retains completion until the process closes", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn(() => true);
    const controller = new AbortController();
    try {
      const completion = waitForCodexChild(child as unknown as ReturnType<typeof spawn>, controller.signal);
      controller.abort();
      expect(child.kill).toHaveBeenLastCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
      child.emit("close", null, "SIGKILL");
      await expect(completion).rejects.toThrow("request was aborted");
    } finally { vi.useRealTimers(); }
  });
});
