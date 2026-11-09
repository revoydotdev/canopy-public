/**
 * T3.2 — `arbor hook <list|validate|events>` (WA-43, J3-21/J3-23).
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { HOOK_ALL_EVENTS } from "../src/hooks/contracts.js";

function collect(stream: PassThrough): { text(): string } {
  let buf = "";
  stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { text: () => buf };
}

const validDescriptor = JSON.stringify({
  schema_version: 1, hook_id: "deny-shell", version: "1.0.0", kind: "veto", event: "tool_preflight",
  handler_ref: "veto.deny-shell-execute", why: "block shell execution regardless of approval policy",
});

describe("arbor hook events", () => {
  it("prints the canonical event catalog derived from the closed contracts", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-hook-cli-events-"));
    try {
      const stdout = new PassThrough(); const text = collect(stdout);
      const code = await main(["hook", "events", "--json"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(JSON.parse(text.text())).toEqual(HOOK_ALL_EVENTS);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("arbor hook list", () => {
  it("lists every valid descriptor under .arbor/hooks and surfaces diagnostics for malformed ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-hook-cli-list-"));
    const hooksDir = join(root, ".arbor", "hooks"); mkdirSync(hooksDir, { recursive: true });
    try {
      writeFileSync(join(hooksDir, "deny-shell@1.0.0.json"), validDescriptor);
      writeFileSync(join(hooksDir, "broken@1.0.0.json"), "{not-json");
      const stdout = new PassThrough(); const text = collect(stdout);
      const code = await main(["hook", "list", "--json"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      expect(code).toBe(EXIT_CODES.SUCCESS);
      const report = JSON.parse(text.text());
      expect(report.hooks).toMatchObject([{ hook_id: "deny-shell", version: "1.0.0", event: "tool_preflight" }]);
      expect(report.diagnostics).toMatchObject([{ source: "broken@1.0.0.json", code: "malformed" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("arbor hook validate", () => {
  it("exits non-zero and names the path and reason for a malformed descriptor", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-hook-cli-validate-"));
    const hooksDir = join(root, ".arbor", "hooks"); mkdirSync(hooksDir, { recursive: true });
    try {
      writeFileSync(join(hooksDir, "wrong-name.json"), validDescriptor);
      const stdout = new PassThrough(); const text = collect(stdout);
      const code = await main(["hook", "validate", "--json"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      expect(code).toBe(EXIT_CODES.VIOLATION);
      const report = JSON.parse(text.text());
      expect(report.diagnostics).toMatchObject([{ source: "wrong-name.json", code: "identity" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("exits success and surfaces never-fired declared hooks for a valid, unfired catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-hook-cli-validate-ok-"));
    const hooksDir = join(root, ".arbor", "hooks"); mkdirSync(hooksDir, { recursive: true });
    try {
      writeFileSync(join(hooksDir, "deny-shell@1.0.0.json"), validDescriptor);
      const stdout = new PassThrough(); const text = collect(stdout);
      const code = await main(["hook", "validate", "--json"], { cwd: root, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      expect(code).toBe(EXIT_CODES.SUCCESS);
      const report = JSON.parse(text.text());
      expect(report.diagnostics).toEqual([]);
      expect(report.never_fired).toMatchObject([{ hook_id: "deny-shell", version: "1.0.0" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
