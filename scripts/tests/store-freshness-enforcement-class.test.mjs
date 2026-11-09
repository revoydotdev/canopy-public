import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENFORCEMENT_CLASS, STORES, assess, applyStoreFreshnessPolicy } from "../store-freshness-gate.mjs";

// governance-walk item 9: store-freshness-gate.mjs must annotate each store's
// enforcement class (does a stale/wrong store block the build outright, or
// only once a finding sits untriaged) instead of printing an identical FAIL
// for every store regardless of what that FAIL actually puts at risk.

describe("store-freshness-gate enforcement class", () => {
  it("declares exactly one class, from the closed set, for every registered store", () => {
    const validClasses = new Set(["blocking", "blocking-on-untriaged", "report-only", "advisory"]);
    expect(STORES.length).toBeGreaterThan(0);
    for (const store of STORES) {
      expect(typeof store.enforcement_class).toBe("string");
      expect(validClasses.has(store.enforcement_class)).toBe(true);
      // ENFORCEMENT_CLASS is the single source of truth cited in the module
      // header (ADR-034/ADR-035 lineage); each store's own field must not
      // drift from it independently.
      expect(store.enforcement_class).toBe(ENFORCEMENT_CLASS[store.name]);
    }
  });

  it("classifies claim-ledger and determinism-baseline as blocking (no triage escape)", () => {
    expect(ENFORCEMENT_CLASS["claim-ledger"]).toBe("blocking");
    expect(ENFORCEMENT_CLASS["determinism-baseline"]).toBe("blocking");
  });

  it("classifies completion-depth and vi-observed as blocking-on-untriaged, per ADR-035 O4", () => {
    expect(ENFORCEMENT_CLASS["completion-depth"]).toBe("blocking-on-untriaged");
    expect(ENFORCEMENT_CLASS["vi-observed"]).toBe("blocking-on-untriaged");
  });

  it("carries enforcement_class through assess() on every outcome shape, without changing pass/fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-freshness-class-"));
    try {
      const store = {
        name: "claim-ledger",
        dir: "irrelevant",
        manifest: "irrelevant/manifest.json",
        env: "REVOY2_TEST_STORE_DIR",
        refresh: "bun run claims:refresh",
        budget: 10,
        enforcement_class: ENFORCEMENT_CLASS["claim-ledger"],
      };

      // 1. Missing store directory entirely -> fail, class still present.
      process.env.REVOY2_TEST_STORE_DIR = join(dir, "does-not-exist");
      let result = assess(store, "deadbeef", "sha256:x");
      expect(result.state).toBe("fail");
      expect(result.enforcement_class).toBe("blocking");

      // 2. Store exists but has no manifest -> fail, class still present.
      const existsNoManifest = join(dir, "exists-no-manifest");
      mkdirSync(existsNoManifest, { recursive: true });
      process.env.REVOY2_TEST_STORE_DIR = existsNoManifest;
      result = assess(store, "deadbeef", "sha256:x");
      expect(result.state).toBe("fail");
      expect(result.enforcement_class).toBe("blocking");

      // 3. Manifest present, with a matching content hash AND a resolvable
      // revision -> ok, class still present. The revision must be a real
      // commit: a manifest naming `deadbeef` is now refused rather than read as
      // an advisory, because an unresolvable coordinate is not a passing one.
      const realHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
      const withManifest = join(dir, "with-manifest");
      mkdirSync(withManifest, { recursive: true });
      writeFileSync(
        join(withManifest, "manifest.json"),
        JSON.stringify({ scanned_up_to_revision: realHead, content_hash: "sha256:x" }),
      );
      process.env.REVOY2_TEST_STORE_DIR = withManifest;
      result = assess(store, realHead, "sha256:x");
      expect(result.state).toBe("ok");
      expect(result.enforcement_class).toBe("blocking");
      expect(result.store_bytes).toBe("unmeasured");
    } finally {
      delete process.env.REVOY2_TEST_STORE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let enforcement_class change which stores fail: blocking-on-untriaged stores fail the same as blocking ones on a content-hash mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-freshness-class-"));
    try {
      const store = {
        name: "completion-depth",
        dir: "irrelevant",
        manifest: "irrelevant/manifest.json",
        env: "REVOY2_TEST_STORE_DIR_2",
        refresh: "bun run completion-depth:refresh",
        budget: 25,
        enforcement_class: ENFORCEMENT_CLASS["completion-depth"],
      };
      const withManifest = join(dir, "with-manifest");
      mkdirSync(withManifest, { recursive: true });
      writeFileSync(
        join(withManifest, "manifest.json"),
        JSON.stringify({ scanned_up_to_revision: "deadbeef", content_hash: "sha256:stale" }),
      );
      process.env.REVOY2_TEST_STORE_DIR_2 = withManifest;
      const result = assess(store, "deadbeef", "sha256:fresh");
      expect(result.state).toBe("fail");
      expect(result.enforcement_class).toBe("blocking-on-untriaged");
    } finally {
      delete process.env.REVOY2_TEST_STORE_DIR_2;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports determinism source drift without forcing an automatic measurement", () => {
    const determinism = STORES.find((store) => store.name === "determinism-baseline");
    const result = applyStoreFreshnessPolicy(determinism, { state: "fail", detail: "content hash differs from the working tree" });
    expect(result).toMatchObject({ state: "advisory" });
    expect(result.detail).toContain("ADR-034");
    expect(applyStoreFreshnessPolicy(determinism, { state: "fail", detail: "manifest is unparseable" })).toEqual({ state: "fail", detail: "manifest is unparseable" });
  });
});
