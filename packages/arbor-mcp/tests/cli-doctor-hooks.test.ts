/**
 * T3.2 — hook diagnostics surfaced in the doctor projection (WA-43, J3-21).
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";

function collect(stream: PassThrough): { text(): string } {
  let buf = "";
  stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { text: () => buf };
}

describe("arbor doctor — hook diagnostics (WA-43/J3-21)", () => {
  it("reports a malformed hook descriptor as an unhealthy 'hooks' extension", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-hooks-bad-"));
    try {
      mkdirSync(join(root, ".arbor"), { recursive: true });
      const hooksDir = join(root, ".arbor", "hooks"); mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, "broken@1.0.0.json"), "{not-json");

      const stdout = new PassThrough(); const text = collect(stdout);
      const code = await main(["doctor", "--json"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      expect(code === EXIT_CODES.SUCCESS || code === EXIT_CODES.CONFLICT).toBe(true);
      const report = JSON.parse(text.text());

      expect(report.operational.extensions.status).toBe("attention");
      expect(report.operational.extensions.unhealthy).toBeGreaterThanOrEqual(1);
      const hooksEntry = report.operational.integrations.find((item: { id: string }) => item.id === "hooks");
      expect(hooksEntry).toMatchObject({ health: "attention" });
      expect(hooksEntry.detail).toContain("broken@1.0.0.json");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports a clean, unpopulated hooks directory as a ready 'hooks' extension", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-doctor-hooks-clean-"));
    try {
      mkdirSync(join(root, ".arbor"), { recursive: true });
      const stdout = new PassThrough(); const text = collect(stdout);
      await main(["doctor", "--json"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      const report = JSON.parse(text.text());
      const hooksEntry = report.operational.integrations.find((item: { id: string }) => item.id === "hooks");
      expect(hooksEntry).toMatchObject({ health: "ready" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
