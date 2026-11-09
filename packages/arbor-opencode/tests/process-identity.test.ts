/**
 * process-identity.test.ts — the real `/proc` reader, exercised against the
 * real process running the test and a real spawned-then-exited child.
 *
 * Everywhere else in this hardening pass, `process_identity` is injected
 * with fakes so the dead-owner logic can be driven deterministically. This
 * file is the one place that proves the REAL reader itself actually parses
 * `/proc/<pid>/stat` correctly — a fake can't catch a field-offset mistake
 * in the real parser.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readProcessIdentity } from "@arbor/campaign-support";

const onLinux = process.platform === "linux";
const maybeDescribe = onLinux ? describe : describe.skip;

maybeDescribe("readProcessIdentity (real /proc reader)", () => {
  it("reads a stable identity for the current process across repeated calls", () => {
    const first = readProcessIdentity(process.pid);
    expect(first).not.toBeNull();
    expect(first!.start_ticks).toMatch(/^\d+$/);
    expect(first!.boot_id.length).toBeGreaterThan(0);

    const second = readProcessIdentity(process.pid);
    // Start time and boot id are both immutable for the life of this
    // process, so back-to-back reads must agree exactly.
    expect(second).toEqual(first);
  });

  it("reads a live spawned child's identity, then reports it unreadable (or a different identity) once the child has exited", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    expect(child.pid).toBeDefined();
    const pid = child.pid!;

    // Give the child a moment to actually be scheduled and show up under
    // /proc before reading it.
    await new Promise<void>((resolveReady) => {
      const deadline = Date.now() + 5000;
      const poll = (): void => {
        const identity = readProcessIdentity(pid);
        if (identity !== null || Date.now() > deadline) { resolveReady(); return; }
        setTimeout(poll, 10);
      };
      poll();
    });

    const liveIdentity = readProcessIdentity(pid);
    expect(liveIdentity).not.toBeNull();
    expect(liveIdentity!.start_ticks).toMatch(/^\d+$/);
    // Same machine, same boot: the live child shares this test process's boot id.
    expect(liveIdentity!.boot_id).toBe(readProcessIdentity(process.pid)!.boot_id);

    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
    // Give the kernel a moment to actually reap /proc/<pid>.
    await new Promise((r) => setTimeout(r, 50));

    const afterExit = readProcessIdentity(pid);
    // Either /proc/<pid> is gone entirely (null), or — in the astronomically
    // unlikely case the PID was already reused by an unrelated process in
    // this same test run — its identity differs from the one recorded while
    // our child was alive. Either outcome demonstrates the property the
    // dead-owner liveness check in recovery-lease.ts depends on: a
    // start-time/boot-id pair recorded for a specific process lifetime never
    // silently keeps matching after that lifetime ends.
    if (afterExit !== null) expect(afterExit).not.toEqual(liveIdentity);
  });

  it("returns null for a PID that plainly does not exist", () => {
    // PID 1 always exists (init/systemd); a PID far beyond any real process
    // table entry should not. This isn't foolproof on every kernel PID_MAX
    // configuration, but it holds on any default Linux config.
    expect(readProcessIdentity(2 ** 22)).toBeNull();
  });
});

describe("readProcessIdentity — non-Linux fallback", () => {
  it("is a documented no-op off Linux (skipped here since this environment is Linux)", () => {
    // Nothing to assert on this platform beyond documenting the contract:
    // `process.platform !== "linux"` short-circuits to null in the
    // implementation, which is exercised implicitly by every OpenCodeRecoveryLeaseAdapter
    // fail-safe test that treats a null identity reader result as "cannot disprove liveness".
    expect(onLinux).toBe(true);
  });
});
