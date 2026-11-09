/**
 * scripts/tests/tui-catalog-parity-waivers.test.mjs — CRUD wiring for
 * `gate:tui-catalog-parity`'s waiver store (governance-walk item 7).
 *
 * `scripts/tui-catalog-parity.mjs` had no disposition-suppression mechanism
 * of its own before this migration — unlike `scripts/branch-accounting.mjs`,
 * whose `dispositions.json` doubles as a waiver store through
 * `scripts/lib/waiver-store.mjs`. This gate's own
 * `scripts/tui-catalog-parity/dispositions.json` is NOT that: it is the
 * gate's mandatory per-kind TUI-surface declaration (every supported catalog
 * kind must have one), not an optional, dated exception. The new store —
 * `scripts/tui-catalog-parity/waivers.json`, schema name
 * `"tui-catalog-parity"` in `WAIVER_SCHEMAS` — is the actual waiver
 * mechanism, keyed on `kind`, following branch-accounting's exact
 * active/expired split (`loadWaiverFile` / `validateWaiverEntry` /
 * `isWaiverExpired`).
 *
 * These tests drive the real gate (`run()` from tui-catalog-parity.mjs)
 * against the REAL runtime catalog and a REAL (temporarily incomplete) copy
 * of the dispositions document, so the property under test is the gate's
 * observable behavior, not an isolated predicate.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import { run } from "../tui-catalog-parity.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_DISPOSITIONS_PATH = resolve(REPO_ROOT, "scripts/tui-catalog-parity/dispositions.json");

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A copy of the real dispositions document with one kind's entry removed. */
function dispositionsMissingKind(kind) {
  const real = JSON.parse(readFileSync(REAL_DISPOSITIONS_PATH, "utf8"));
  return { ...real, entries: real.entries.filter((entry) => entry.kind !== kind) };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function runGate(dispositions, waivers) {
  dir = mkdtempSync(join(tmpdir(), "tui-catalog-parity-waivers-"));
  const dispositionsPath = join(dir, "dispositions.json");
  const waiversPath = join(dir, "waivers.json");
  writeJson(dispositionsPath, dispositions);
  writeJson(waiversPath, waivers ?? { entries: [] });
  return run(["--root", REPO_ROOT, "--dispositions", dispositionsPath, "--waivers", waiversPath, "--json"]);
}

describe("gate:tui-catalog-parity waiver store", () => {
  it("a missing disposition is a blocker with no waiver in play", () => {
    const { code, report } = runGate(dispositionsMissingKind("campaign.start"));
    expect(code).toBe(1);
    expect(report.errors).toContain("supported command campaign.start has no TUI disposition");
    expect(report.waived).toEqual([]);
  });

  it("an active waiver suppresses the finding and reports it under 'waived' instead of 'errors'", () => {
    const { code, report } = runGate(dispositionsMissingKind("campaign.start"), {
      entries: [{ kind: "campaign.start", reason: "TUI parity migration in flight", expires: "2999-01-01" }],
    });
    expect(code).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.waived).toHaveLength(1);
    expect(report.waived[0]).toMatchObject({ kind: "campaign.start", reason: "TUI parity migration in flight", expires: "2999-01-01" });
  });

  it("an EXPIRED waiver stops suppressing the finding and is itself a blocker", () => {
    const { code, report } = runGate(dispositionsMissingKind("campaign.start"), {
      entries: [{ kind: "campaign.start", reason: "stale", expires: "2000-01-01" }],
    });
    expect(code).toBe(1);
    // The underlying finding resurfaces...
    expect(report.errors).toContain("supported command campaign.start has no TUI disposition");
    // ...AND the lapsed waiver is a separate blocker, not silently dropped.
    expect(report.errors.some((e) => e.includes("waiver for campaign.start") && e.includes("expired 2000-01-01"))).toBe(true);
    expect(report.expired_waivers).toHaveLength(1);
    expect(report.waived).toEqual([]);
  });

  it("an incomplete waiver entry (no reason/expiry) is a blocker, not a silent no-op", () => {
    const { code, report } = runGate(dispositionsMissingKind("campaign.start"), {
      entries: [{ kind: "campaign.start" }],
    });
    expect(code).toBe(1);
    expect(report.expired_waivers[0].why).toMatch(/incomplete entry/);
  });

  it("a waiver for a kind with NO active finding is simply inert — real tree stays green", () => {
    const { code, report } = runGate(JSON.parse(readFileSync(REAL_DISPOSITIONS_PATH, "utf8")), {
      entries: [{ kind: "campaign.start", reason: "pre-emptive, nothing wrong today", expires: "2999-01-01" }],
    });
    expect(code).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.waived).toEqual([]);
  });

  it("an unparseable waiver store fails closed", () => {
    dir = mkdtempSync(join(tmpdir(), "tui-catalog-parity-waivers-"));
    const dispositionsPath = join(dir, "dispositions.json");
    const waiversPath = join(dir, "waivers.json");
    writeJson(dispositionsPath, dispositionsMissingKind("campaign.start"));
    writeFileSync(waiversPath, "{ not json", "utf8");
    const { code, report } = run(["--root", REPO_ROOT, "--dispositions", dispositionsPath, "--waivers", waiversPath, "--json"]);
    expect(code).toBe(1);
    expect(report.waiver_file_error).toMatch(/unparseable/);
    expect(report.errors).toContain(report.waiver_file_error);
  });
});
