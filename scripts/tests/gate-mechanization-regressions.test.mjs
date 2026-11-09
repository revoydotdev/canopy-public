import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assess } from "../store-freshness-gate.mjs";
import { evaluateConformance } from "../project-conform.mjs";
import { restoreCheckPlane } from "../vi-refresh.mjs";

const temporary = [];

function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(() => {
  delete process.env.REVOY2_CLAIM_LEDGER_DIR;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("required evidence stores", () => {
  it("fails when a required store directory is absent", () => {
    const root = temp("missing-required-store-");
    process.env.REVOY2_CLAIM_LEDGER_DIR = join(root, ".claim-ledger");
    const result = assess({
      name: "claim-ledger",
      dir: ".claim-ledger",
      manifest: ".claim-ledger/manifest.json",
      env: "REVOY2_CLAIM_LEDGER_DIR",
      refresh: "bun run claims:refresh",
      budget: 1,
    }, "0".repeat(40), "content");
    expect(result.state).toBe("fail");
    expect(result.detail).toContain("required store directory does not exist");
  });
});

describe("strict conformance profile", () => {
  it("reports invalid JSONC instead of evaluating against defaults", () => {
    const root = temp("invalid-conformance-profile-");
    writeFileSync(join(root, "arbor.profile.jsonc"), "{ this is not jsonc");
    const results = evaluateConformance(root);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("project-profile-validity");
    expect(results[0].ok).toBe(false);
    expect(results[0].failures[0].reason).toMatch(/invalid JSONC/i);
  });
});

describe("VI reproducibility restoration", () => {
  it("removes a plane generated from an initially absent state", () => {
    const root = temp("vi-check-absent-");
    const plane = join(root, ".visual-intelligence");
    const backup = temp("vi-check-backup-");
    mkdirSync(join(plane, "graph"), { recursive: true });
    writeFileSync(join(plane, "graph/nodes.jsonl"), "generated\n");

    restoreCheckPlane({
      check: true,
      backup,
      backupVisualIntelligence: join(backup, ".visual-intelligence"),
      visualIntelligenceDir: plane,
      visualIntelligenceDirExisted: false,
    });

    expect(existsSync(plane)).toBe(false);
    expect(existsSync(backup)).toBe(false);
  });

  it("restores the prior complete plane after a partial regeneration", () => {
    const root = temp("vi-check-existing-");
    const plane = join(root, ".visual-intelligence");
    const backup = temp("vi-check-backup-");
    const backupPlane = join(backup, ".visual-intelligence");
    mkdirSync(join(plane, "graph"), { recursive: true });
    mkdirSync(join(backupPlane, "graph"), { recursive: true });
    writeFileSync(join(plane, "graph/nodes.jsonl"), "partial\n");
    writeFileSync(join(backupPlane, "graph/nodes.jsonl"), "original\n");

    restoreCheckPlane({
      check: true,
      backup,
      backupVisualIntelligence: backupPlane,
      visualIntelligenceDir: plane,
      visualIntelligenceDirExisted: true,
    });

    expect(readFileSync(join(plane, "graph/nodes.jsonl"), "utf8")).toBe("original\n");
    expect(existsSync(backup)).toBe(false);
  });
});
