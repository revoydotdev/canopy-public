/**
 * scripts/tests/preflight-push.test.mjs — teeth for scripts/preflight-push.mjs.
 *
 * `preflight-push.mjs` wraps `runImmutableBattery({ context: "prepush" })`
 * from scripts/enforcement-control-plane.mjs — the SAME function
 * `bun run enforcement:prepush` (and the real `scripts/hooks/pre-push`) call.
 * That function creates a fresh detached snapshot worktree, runs `bun install
 * --frozen-lockfile` + `bun run build`, then executes ~15 gates — a couple of
 * minutes end to end. This file deliberately does NOT run that battery (per
 * this repository's own convention against heavy loads in a unit test): it
 * tests the pure `formatReport()` reporting logic against synthetic battery
 * reports shaped exactly like `runImmutableBattery`'s real return value, plus
 * one case that feeds it a REAL gate's output (`store-freshness-gate.mjs
 * --json`, ~100ms) so the "surfaces the gate's own remedy text verbatim"
 * property is proven against real text, not an invented fixture.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatExecutionPlan, formatReport } from "../preflight-push.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

describe("preflight-push.mjs — formatReport (pure)", () => {
  it("prints the candidate-bound execution waves in their real order", () => {
    expect(formatExecutionPlan({
      context: "prepush",
      max_readers: 4,
      waves: [
        { wave: 1, mutability: "read_only", gates: ["gate:a", "gate:b"] },
        { wave: 2, mutability: "verification_sandbox", gates: ["gate:writer"] },
      ],
    })).toEqual([
      "gate execution plan (prepush; reader width 4)",
      "  wave 01 [read_only] gate:a, gate:b",
      "  wave 02 [verification_sandbox] gate:writer",
    ]);
  });

  it("reports PASS — safe to push when every gate passes or is cached", () => {
    const report = {
      ok: true,
      status: "passed",
      candidate_oid: "abc123def456abc123def456abc123def456abc",
      gates: [
        { gate: "gate:reachability", status: "passed", output: "" },
        { gate: "gate:store-freshness", status: "cached", output: "" },
      ],
    };
    const { lines, ok } = formatReport(report);
    expect(ok).toBe(true);
    expect(lines.join("\n")).toMatch(/ok\s+gate:reachability/);
    expect(lines.join("\n")).toMatch(/ok\s+gate:store-freshness/);
    expect(lines.join("\n")).toMatch(/PASS — safe to push\./);
  });

  it("reports FAIL per failing gate with that gate's own output tailed underneath", () => {
    const report = {
      ok: false,
      status: "failed",
      candidate_oid: "abc123def456abc123def456abc123def456abc",
      gates: [
        { gate: "gate:reachability", status: "passed", output: "" },
        {
          gate: "gate:typecheck-tests",
          status: "failed",
          exit_code: 1,
          output: "packages/arbor-mcp/tests/foo.test.ts(10,3): error TS2322: bogus\n",
        },
      ],
    };
    const { lines, ok } = formatReport(report);
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).toMatch(/ok\s+gate:reachability/);
    expect(text).toMatch(/FAIL gate:typecheck-tests \(failed\)/);
    // The gate's OWN remedy text passes through verbatim — not re-derived.
    expect(text).toMatch(/error TS2322: bogus/);
    expect(text).toMatch(/FAIL — 1 gate\(s\) would block `git push`: gate:typecheck-tests\./);
    expect(text).toMatch(/bun run preflight-push/);
  });

  it("reports a setup failure (snapshot install/build) distinctly from a gate failure", () => {
    const report = {
      ok: false,
      status: "snapshot_setup_failed",
      candidate_oid: "abc123",
      detail: "bun install failed: lockfile out of date",
      gates: [],
    };
    const { lines, ok } = formatReport(report);
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).toMatch(/FAIL — could not even prepare the candidate: snapshot_setup_failed/);
    expect(text).toMatch(/lockfile out of date/);
  });

  it("reports an identity_mismatch battery as a failure with its own explanatory line", () => {
    const report = {
      ok: false,
      status: "identity_mismatch",
      candidate_oid: "abc123",
      gates: [{ gate: "gate:reachability", status: "passed", output: "" }],
    };
    const { lines, ok } = formatReport(report);
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).toMatch(/identity_mismatch/);
  });

  it("surfaces a REAL gate's own remedy text verbatim (store-freshness-gate.mjs)", () => {
    // Force one real, isolated failure by pointing only the claim-ledger store
    // at an empty directory. The repository's committed stores remain untouched,
    // while both invocations exercise the actual gate and its actual remedy.
    const missingStore = mkdtempSync(join(tmpdir(), "revoy2-preflight-stale-store-"));
    try {
      const env = { ...process.env, REVOY2_CLAIM_LEDGER_DIR: missingStore };
      const parsed = JSON.parse(
        spawnSync("bun", [join(REPO_ROOT, "scripts", "store-freshness-gate.mjs"), "--json"], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          env,
        }).stdout,
      );
      const real = spawnSync("bun", [join(REPO_ROOT, "scripts", "store-freshness-gate.mjs")], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env,
      });
      const syntheticBattery = {
        ok: parsed.ok,
        status: parsed.ok ? "passed" : "failed",
        candidate_oid: parsed.head,
        gates: [
          {
            gate: "gate:store-freshness",
            status: parsed.ok ? "passed" : "failed",
            exit_code: real.status,
            output: real.stdout,
          },
        ],
      };
      const { lines, ok } = formatReport(syntheticBattery);
      const text = lines.join("\n");
      expect(parsed.ok).toBe(false);
      expect(ok).toBe(false);
      // The real gate's own human-readable output is present verbatim.
      expect(text).toMatch(/store-freshness gate/);
      expect(text).toMatch(/FAIL gate:store-freshness/);
      expect(text).toMatch(/enforcement_class/);
    } finally {
      rmSync(missingStore, { recursive: true, force: true });
    }
  });
});
