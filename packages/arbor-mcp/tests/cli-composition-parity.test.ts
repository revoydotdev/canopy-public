/**
 * T1.1 — CLI composition parity (WA-03, WA-20, WA-21).
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createCliRuntime, main } from "../src/cli.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { EXIT_CODES } from "../src/exit-codes.js";

function collect(stream: PassThrough): { text(): string } {
  let buf = "";
  stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { text: () => buf };
}

describe("arbor doctor — operational composition parity (WA-03)", () => {
  it("shows no unobserved operational blocks for an already-enrolled project, and matches doctor.get exactly", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-parity-"));
    try {
      // "Enrolled" means the persistence dir already exists -- exactly the
      // condition the CLI doctor branch gates its runtime composition on
      // (see the Q1 comment in cli.ts) so a never-enrolled repo is still
      // left untouched.
      mkdirSync(join(root, ".arbor"), { recursive: true });

      const stdout = new PassThrough(); const stdoutText = collect(stdout);
      const code = await main(["doctor", "--json"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      const report = JSON.parse(stdoutText.text());

      // "extensions" legitimately reads "unobserved" with zero plugins
      // composed -- that is the real doctor.get value too (asserted by the
      // deep-equal below), not a routing defect. remote/scheduler/sessions
      // are always composed by createCliRuntime, so those three must never
      // read "unobserved" once the CLI routes through the real composition.
      for (const block of ["remote", "scheduler", "sessions"] as const) {
        expect(report.operational[block].status, `operational.${block}.status`).not.toBe("unobserved");
      }

      // Deep-equal against the exact same composition doctor.get returns,
      // proving the CLI did not reimplement or drift from it.
      const runtime = createCliRuntime(root);
      try {
        const router = new RuntimeCatalogRouter(runtime);
        const doctorGet = router.executeQuery({ schema_version: 1, query_id: "parity", query: { kind: "doctor.get" } } as never) as { ok: true; value: { operational: unknown } };
        expect(doctorGet.ok).toBe(true);
        expect(report.operational).toEqual(doctorGet.value.operational);
      } finally { await runtime.close(); }

      expect(code === EXIT_CODES.SUCCESS || code === EXIT_CODES.CONFLICT).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("still leaves a never-enrolled repo untouched (Q1 unchanged) with operational.* unobserved", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-parity-unenrolled-"));
    try {
      const stdout = new PassThrough(); const stdoutText = collect(stdout);
      await main(["doctor", "--json"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      const report = JSON.parse(stdoutText.text());
      expect(report.operational.extensions.status).toBe("unobserved");
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(root, ".arbor"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("arbor governance — typed absence for a missing decisions/ directory (WA-20)", () => {
  it("returns a typed absence, not a raw ENOENT failure, when decisions/ does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-governance-absence-"));
    try {
      const stdout = new PassThrough(); const stdoutText = collect(stdout);
      const stderr = new PassThrough(); const stderrText = collect(stderr);
      const code = await main(["governance", "--json"], { cwd: root, persistence_dir: ".arbor", stdin: new PassThrough(), stdout, stderr });
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(stderrText.text()).toBe("");
      const parsed = JSON.parse(stdoutText.text());
      expect(parsed).toMatchObject({ ok: true, absence: true, message: expect.stringContaining("no decisions directory at") });
      expect(parsed.message).toContain("this project has no ADRs");
      expect(parsed.message).not.toContain("ENOENT");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("still runs the real projection when decisions/ exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-governance-present-"));
    try {
      mkdirSync(join(root, "decisions"), { recursive: true });
      const stdout = new PassThrough(); const stdoutText = collect(stdout);
      const code = await main(["governance", "--json", "--no-witness"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      const parsed = JSON.parse(stdoutText.text());
      expect(parsed.ok).toBe(true);
      expect(parsed.absence).toBeUndefined();
      expect(code === EXIT_CODES.SUCCESS || code === EXIT_CODES.PARTIAL || code === EXIT_CODES.VIOLATION).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("arbor --help — advertised subcommands match dispatch (WA-21)", () => {
  it("advertises scheduler's real actions, not the retired 'inspect' verb", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-help-scheduler-"));
    try {
      const stdout = new PassThrough(); const stdoutText = collect(stdout);
      await main(["--help"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      const text = stdoutText.text();
      expect(text).toContain("arbor scheduler <register|list|tick|trigger|daemon>");
      expect(text).not.toMatch(/arbor scheduler <[^>]*\binspect\b[^>]*>/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("advertises session identity's real subcommands", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-help-session-identity-"));
    try {
      const stdout = new PassThrough(); const stdoutText = collect(stdout);
      await main(["--help"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      expect(stdoutText.text()).toContain("arbor session identity <get|search|set>");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("states the mandatory campaign id for verification/followup usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-usage-campaign-"));
    try {
      for (const args of [["verification"], ["followup"]]) {
        const stderr = new PassThrough(); const stderrText = collect(stderr);
        const code = await main(args, { cwd: root, stdin: new PassThrough(), stdout: new PassThrough(), stderr });
        expect(code).toBe(EXIT_CODES.USAGE);
        expect(stderrText.text()).toContain("campaign-id");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
