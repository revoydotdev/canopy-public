import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";

function output(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough(); let captured = "";
  stream.on("data", (chunk) => { captured += chunk.toString(); });
  return { stream, text: () => captured };
}

describe("arbor project CLI", () => {
  it("supports status, preview-first enrollment, JSON, and repair", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-project-cli-"));
    try {
      const statusOut = output();
      expect(await main(["project", "status", root], { cwd: root, stdin: new PassThrough(), stdout: statusOut.stream, stderr: new PassThrough() })).toBe(EXIT_CODES.CONFLICT);
      expect(statusOut.text()).toContain("not enrolled");

      const previewOut = output();
      expect(await main(["project", "enroll", root, "--dry-run", "--json"], { cwd: root, stdin: new PassThrough(), stdout: previewOut.stream, stderr: new PassThrough() })).toBe(EXIT_CODES.SUCCESS);
      expect(JSON.parse(previewOut.text()).dry_run).toBe(true);

      expect(await main(["project", "enroll", root], { cwd: root, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })).toBe(EXIT_CODES.SUCCESS);
      const readyOut = output();
      expect(await main(["project", "status", root, "--json"], { cwd: root, stdin: new PassThrough(), stdout: readyOut.stream, stderr: new PassThrough() })).toBe(EXIT_CODES.SUCCESS);
      expect(JSON.parse(readyOut.text()).state).toBe("ready");

      expect(await main(["project", "repair", root], { cwd: root, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })).toBe(EXIT_CODES.SUCCESS);
      expect(await main(["project", "repair", root, "--apply"], { cwd: root, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })).toBe(EXIT_CODES.SUCCESS);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports invalid project grammar as usage errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-project-cli-error-"));
    try {
      for (const args of [
        ["project", "unknown"],
        ["project", "status", "--wat"],
        ["project", "enroll", "--wat"],
        ["project", "enroll", "--new", "--backfill"],
        ["project", "repair", "--wat"],
      ]) {
        const error = output();
        expect(await main(args, { cwd: root, stdin: new PassThrough(), stdout: new PassThrough(), stderr: error.stream })).toBe(EXIT_CODES.USAGE);
        expect(error.text()).toContain("Usage: arbor project");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
