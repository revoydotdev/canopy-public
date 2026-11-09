import { describe, expect, it } from "vitest";
import { loadConfig, loadConfigFromString } from "../src/index.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("safe validated config loading", () => {
  it("rejects a structurally invalid value rather than returning it as ArborConfig", () => {
    expect(() => loadConfigFromString(JSON.stringify({ tree_search: { max_seconds: "not-a-number" } }))).toThrow("Invalid Arbor config");
  });

  it("rejects prototype-mutating JSON keys", () => {
    expect(() => loadConfigFromString('{"__proto__":{"polluted":true}}')).toThrow("Unsafe config key");
  });
});

describe("a malformed config names the file that is malformed (EC-041)", () => {
  // Three scopes are all called `arbor.jsonc` (organization, user, project).
  // A bare "JSON Parse error: Expected '}'" told an operator who mis-edited
  // one nothing about WHICH to open, and the crash screen showed only that
  // sentence plus a parser stack frame.
  it("includes the path and the underlying parse error", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-cfg-"));
    const file = join(dir, "arbor.jsonc");
    writeFileSync(file, '{\n  "kb": { "backend": "jsonl", },\n  "tui": { "theme": "moss-agate"\n}\n', "utf-8");
    let caught: unknown;
    try { loadConfig(dir); } catch (error) { caught = error; }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain(file);
    expect(message).toContain("not valid JSON");
  });

  it("still rejects a non-object config by naming the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-cfg-"));
    writeFileSync(join(dir, "arbor.jsonc"), "[1,2,3]", "utf-8");
    expect(() => loadConfig(dir)).toThrow(join(dir, "arbor.jsonc"));
  });
});
