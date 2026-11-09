/**
 * Process-level proof for the child registry.
 *
 * This deliberately kills a separate Node parent instead of reaching into the
 * registry with an `_xForTest` export.  The child is real, the signal is real,
 * and the only passing outcome is that the tracked child is gone before it can
 * become a PPID-1 orphan.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const registryUrl = pathToFileURL(join(packageRoot, "dist", "child-registry.js")).href;
const spawned: number[] = [];

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* child already exited */ }
  }
});

function exits(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

function firstLine(child: ReturnType<typeof spawn>, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(
      `timed out waiting for child-registry fixture readiness after ${timeoutMs}ms${stderr ? `: ${stderr.trim()}` : ""}`,
    )), timeoutMs);
    const finish = (error?: Error, line?: string) => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(line!);
    };
    const onStdout = (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) finish(undefined, stdout.slice(0, newline).trim());
    };
    const onStderr = (chunk: string) => { stderr += chunk; };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(
      `child-registry fixture exited before readiness (code=${code}, signal=${signal})${stderr ? `: ${stderr.trim()}` : ""}`,
    ));
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!existsSync(`/proc/${pid}`)) return true;
    // A Linux zombie has exited and cannot keep doing work.  It is awaiting
    // init's reap, so `kill(pid, 0)` alone would incorrectly call it alive.
    try {
      if (/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"))) return true;
    } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe.skipIf(process.platform !== "linux")("child-registry process-exit reaping", () => {
  it("SIGTERM reaps a real tracked child before the parent exits", async () => {
    const parentProgram = [
      'import { spawn } from "node:child_process";',
      `import { trackChild } from ${JSON.stringify(registryUrl)};`,
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'trackChild(child);',
      'process.stdout.write(`${child.pid}\\n`);',
      'setInterval(() => {}, 1000);',
    ].join("\n");
    const parent = spawn(process.execPath, ["--input-type=module", "--eval", parentProgram], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (parent.pid !== undefined) spawned.push(parent.pid);
    const childPid = Number(await firstLine(parent));
    expect(Number.isSafeInteger(childPid)).toBe(true);
    spawned.push(childPid);

    const parentExit = exits(parent);
    process.kill(parent.pid!, "SIGTERM");
    await expect(parentExit).resolves.toMatchObject({ signal: "SIGTERM" });
    expect(await waitForGone(childPid)).toBe(true);
  });
});
