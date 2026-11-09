import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicOverwriteFile } from "../src/atomic-write.js";

let directory = "";
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = ""; });

describe("atomicOverwriteFile failure cleanup", () => {
  it("removes the temporary file when the final rename cannot replace a directory", () => {
    directory = mkdtempSync(join(tmpdir(), "atomic-overwrite-"));
    const target = join(directory, "occupied");
    mkdirSync(target);
    expect(() => atomicOverwriteFile(target, "value")).toThrow();
    expect(readdirSync(directory).filter((entry) => entry.startsWith("occupied.tmp-"))).toEqual([]);
  });
});
