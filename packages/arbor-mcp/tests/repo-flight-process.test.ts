import { describe, expect, it } from "vitest";
import { observeRepoFlightHostProcess, probeRepoFlightHostProcess } from "../src/repo-flight-process.js";

describe("repo flight host process identity", () => {
  it("binds the live process to boot identity, start ticks, and process group", () => {
    const identity = probeRepoFlightHostProcess(process.pid);
    expect(identity).toMatchObject({ pid: process.pid, process_start_token: expect.stringMatching(/^linux-proc-start:\d+$/), host_boot_id: expect.stringMatching(/^linux-boot:/), pgid: expect.any(Number) });
    expect(identity.child_pids).not.toContain(process.pid);
    expect(observeRepoFlightHostProcess(process.pid, "2026-08-28T12:00:00.000Z", "connected")).toMatchObject({ pid_exists: true, process_start_token: identity.process_start_token, host_boot_id: identity.host_boot_id, control_channel: "connected" });
  });

  it("reports a host-bound absent PID without fabricating a process start identity", () => {
    expect(observeRepoFlightHostProcess(2_000_000_000, "2026-08-28T12:00:00.000Z")).toMatchObject({ pid_exists: false, process_start_token: null, host_boot_id: expect.stringMatching(/^linux-boot:/) });
  });
});
