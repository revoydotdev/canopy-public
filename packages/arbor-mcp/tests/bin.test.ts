import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");
const binPath = join(packageRoot, "bin", "arbor-mcp.mjs");

describe("arbor development launcher", () => {
  it("runs help directly under Bun and writes conventional help to stdout", async () => {
    const { stdout, stderr } = await execFileAsync("bun", [binPath, "--help"], {
      cwd: repoRoot,
      timeout: 30_000,
    });
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: arbor <command> [options]");
    expect(stdout).toContain("arbor tui");
  });

  it("reports the package version", async () => {
    const { stdout } = await execFileAsync("bun", [binPath, "--version"], {
      cwd: repoRoot,
      timeout: 30_000,
    });
    expect(stdout).toMatch(/^arbor \d+\.\d+\.\d+\n$/);
  });

  it("runs a real subcommand and prints genuine JSON", async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), "arbor-bin-ledger-"));
    try {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          "bun",
          [binPath, "ledger", "verify", "--dir", ledgerDir, "--campaign", "bin-test-campaign", "--json"],
          { cwd: repoRoot, timeout: 30_000 },
        ));
      } catch (error) {
        stdout = (error as { stdout?: string }).stdout ?? "";
      }
      const parsed = JSON.parse(stdout) as { campaign: string; valid: boolean };
      expect(parsed.campaign).toBe("bin-test-campaign");
      expect(typeof parsed.valid).toBe("boolean");
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid TUI renderer without entering the event loop", async () => {
    await expect(execFileAsync("bun", [binPath, "tui", "--renderer", "invalid"], {
      cwd: repoRoot,
      timeout: 30_000,
    })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("--renderer opentui|stdout"),
    });
  });

  it("installs idempotent PATH links and refuses to overwrite a foreign command", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "arbor-dev-bin-"));
    try {
      const installer = join(repoRoot, "scripts", "install-dev-cli.mjs");
      await execFileAsync("bun", [installer, "--bin-dir", binDir], { cwd: repoRoot, timeout: 30_000 });
      await execFileAsync("bun", [installer, "--bin-dir", binDir], { cwd: repoRoot, timeout: 30_000 });
      expect(resolve(binDir, readlinkSync(join(binDir, "arbor")))).toBe(binPath);
      const { stdout } = await execFileAsync(join(binDir, "arbor"), ["--version"], { cwd: repoRoot, timeout: 30_000 });
      expect(stdout).toMatch(/^arbor \d+\.\d+\.\d+\n$/);

      rmSync(join(binDir, "arbor"));
      writeFileSync(join(binDir, "arbor"), "foreign command\n");
      await expect(execFileAsync("bun", [installer, "--bin-dir", binDir], { cwd: repoRoot, timeout: 30_000 }))
        .rejects.toMatchObject({ stderr: expect.stringContaining("refusing to replace it") });
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
