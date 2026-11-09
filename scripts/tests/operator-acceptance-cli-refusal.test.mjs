import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

describe("operator acceptance command boundaries", () => {
  it("refuses a narrow-terminal capture without an explicit external output directory", () => {
    const result = spawnSync("bun", ["scripts/record-narrow-tui-acceptance.mjs"], { cwd: ROOT, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: acceptance:tui:narrow -- --out-dir");
  });

  it("refuses a short pre-push A/B run instead of labelling an incomplete sample as acceptance evidence", () => {
    const result = spawnSync("bun", ["scripts/benchmark-prepush-ab.mjs", "--runs", "2", "--output", "/tmp/revoy2-incomplete-prepush-ab.json"], { cwd: ROOT, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires exactly --runs 3");
  });
});
