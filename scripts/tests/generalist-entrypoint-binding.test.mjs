import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const driver = readFileSync(resolve(root, "scripts/generalist-campaign-driver.mjs"), "utf8");

describe("generalist campaign harness binding", () => {
  it("invokes the arbor entrypoint from the recorder checkout rather than PATH", () => {
    expect(driver).toContain('const ARBOR_ENTRYPOINT = resolve(HARNESS_ROOT, "packages/arbor-mcp/bin/arbor-mcp.mjs")');
    expect(driver).toContain("await run(ARBOR_ENTRYPOINT, args, options)");
    expect(driver).not.toContain('run("arbor"');
    expect(driver).toContain("harness_entrypoint: ARBOR_ENTRYPOINT");
  });
});
