import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCrashBoundary, runTui, type TuiLaunchOptions } from "../src/tui.js";

function fixture(tty = true, raw = false) {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: tty,
    isRaw: raw,
    setRawMode(mode: boolean) { this.isRaw = mode; return this; },
  });
  const stdout = new PassThrough();
  const options: TuiLaunchOptions = { stdin, stdout, stderr: new PassThrough(), cwd: "/tmp" };
  return { stdin, options };
}

describe("startup crash terminal ownership", () => {
  it("releases the real startup input owner when configuration loading fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "arbor-crash-owner-"));
    try {
      writeFileSync(join(cwd, "arbor.jsonc"), "{invalid json");
      const { stdin, options } = fixture();
      const result = runTui({ ...options, cwd });
      await Promise.resolve();
      stdin.write("q");
      expect(await result).toBe(1);
      expect(stdin.listenerCount("data")).toBe(0);
      expect(stdin.isRaw).toBe(false);
      expect(stdin.isPaused()).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("releases input that was not flowing before the crash", async () => {
    const { stdin, options } = fixture();
    expect(stdin.readableFlowing).toBeNull();
    const result = runCrashBoundary(new Error("startup failed"), options);
    stdin.write("q");
    expect(await result).toBe(1);
    expect(stdin.isPaused()).toBe(true);
    expect(stdin.listenerCount("data")).toBe(0);
  });
  it("accepts q without Enter and restores input mode and listeners", async () => {
    const { stdin, options } = fixture();
    stdin.pause();
    const result = runCrashBoundary(new Error("bad configuration"), options);
    expect(stdin.isRaw).toBe(true);
    stdin.write("q");
    expect(await result).toBe(1);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.isPaused()).toBe(true);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("does not wait for keyboard input on a pipe", async () => {
    const { stdin, options } = fixture(false);
    expect(await runCrashBoundary(new Error("bad configuration"), options)).toBe(1);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("exits on Ctrl+C and preserves an already raw terminal", async () => {
    const { stdin, options } = fixture(true, true);
    const result = runCrashBoundary(new Error("startup failed"), options);
    stdin.write("\u0003");
    expect(await result).toBe(1);
    expect(stdin.isRaw).toBe(true);
  });

  it("settles when the terminal closes", async () => {
    const { stdin, options } = fixture();
    const result = runCrashBoundary(new Error("startup failed"), options);
    stdin.emit("close");
    expect(await result).toBe(1);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.isRaw).toBe(false);
  });
});
