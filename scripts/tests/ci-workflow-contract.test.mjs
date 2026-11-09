import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const workflow = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");

describe("CI authority topology", () => {
  it("has exactly one Linux authority and no replayed standalone Linux gates", () => {
    expect(workflow.match(/runs-on: \[self-hosted, Linux, X64\]/g)).toHaveLength(1);
    expect(workflow).toContain("enforcement-control-plane:");
    expect(workflow).toContain("run: bun run enforcement:ci .arbor/enforcement/aggregate-report.json");
    for (const removed of ["build-test-gate:", "coverage-floor-gate:", "anti-stub-lint:", "vi-freshness-gate:", "determinism-baseline-gate:"]) {
      expect(workflow).not.toContain(removed);
    }
  });

  it("retains Windows and macOS evidence that the Linux aggregate cannot reproduce", () => {
    expect(workflow).toContain("runs-on: [self-hosted, Windows, X64]");
    expect(workflow).toContain("bun scripts/platform-smoke.mjs --expect-platform win32");
    expect(workflow).toContain("runs-on: [self-hosted, macOS, X64]");
    expect(workflow).toContain("bun scripts/platform-smoke.mjs --expect-platform darwin");
  });

  it("publishes the failed-or-green aggregate receipt before returning the final verdict", () => {
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("attestation:emit");
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain("if: steps.battery.outcome == 'failure'");
  });
});
