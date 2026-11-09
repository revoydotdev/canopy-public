import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createCliRuntime } from "../src/cli.js";
import { runTui } from "../src/tui.js";

describe("TUI startup refusal input ownership", () => {
  it("restores raw mode and releases input on a non-throwing runtime refusal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "arbor-startup-refusal-"));
    const runtime = createCliRuntime(cwd);
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(mode: boolean) { this.isRaw = mode; return this; },
    });
    const start = vi.spyOn(runtime, "start").mockResolvedValue({ ok: false, value: null, failures: [] });
    try {
      const code = await runTui({
        cwd, stdin, stdout: new PassThrough(), stderr: new PassThrough(),
        runtime_factory: () => runtime,
      });
      expect(code).toBe(1);
      expect(start).toHaveBeenCalledOnce();
      expect(stdin.listenerCount("data")).toBe(0);
      expect(stdin.isRaw).toBe(false);
      expect(stdin.isPaused()).toBe(true);
    } finally {
      start.mockRestore();
      await runtime.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
