import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { loadProjectEnvironment, loadUserEnvironment, userEnvironmentPath } from "../src/project-env.js";
import { main } from "../src/cli.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = mkdtempSync(join(tmpdir(), "arbor-project-env-")); roots.push(value); return value; }

describe("project-local environment loading", () => {
  it("loads only documented Arbor/provider names and never overrides ambient authority", () => {
    const cwd = root();
    writeFileSync(join(cwd, ".env"), "ARBOR_NATIVE_API_KEY=file-secret\nOPENROUTER_API_KEY='router-secret'\nPATH=/hostile\nNODE_OPTIONS=--require=bad\n");
    const target: NodeJS.ProcessEnv = { ARBOR_NATIVE_API_KEY: "ambient-secret" };
    const result = loadProjectEnvironment(cwd, target);
    expect(result.loaded_names).toEqual(["OPENROUTER_API_KEY"]);
    expect(target).toEqual({ ARBOR_NATIVE_API_KEY: "ambient-secret", OPENROUTER_API_KEY: "router-secret" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("makes the documented setup .env visible to the real doctor without projecting its value", async () => {
    const cwd = root();
    const previous = process.env.ARBOR_NATIVE_API_KEY;
    delete process.env.ARBOR_NATIVE_API_KEY;
    try {
      writeFileSync(join(cwd, ".env"), "ARBOR_NATIVE_API_KEY=never-project-this\n");
      writeFileSync(join(cwd, "arbor.jsonc"), JSON.stringify({ native: { mode: "native", adapter_id: "openai-compatible", provider_id: "openrouter", base_url: "https://openrouter.ai/api/v1", model: "fixture/model" } }));
      const stdout = new PassThrough(); let text = ""; stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      const code = await main(["doctor", "--json"], { cwd, stdin: new PassThrough(), stdout, stderr: new PassThrough(), execute_integration_probe: () => "fixture" });
      expect(code).toBe(0);
      expect(JSON.parse(text)).toMatchObject({ credentials: { native: { present: true, env_var: "ARBOR_NATIVE_API_KEY" } } });
      expect(text).not.toContain("never-project-this");
    } finally {
      if (previous === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previous;
    }
  });
});

describe("user-scope environment file", () => {
  it("resolves under XDG_CONFIG_HOME, else ~/.config", () => {
    expect(userEnvironmentPath({ XDG_CONFIG_HOME: "/x/cfg" })).toBe("/x/cfg/revoy/revoy.env");
    expect(userEnvironmentPath({ HOME: "/home/u" })).toBe("/home/u/.config/revoy/revoy.env");
  });

  it("loads after the project file, fills empty placeholders, and never overrides a real value", () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const cfg = mkdtempSync(join(tmpdir(), "revoy-user-env-"));
    try {
      mkdirSync(join(cfg, "revoy"), { recursive: true });
      writeFileSync(join(cfg, "revoy", "revoy.env"), "OPENROUTER_API_KEY=user-key\nANTHROPIC_API_KEY=user-anthropic\nNOT_ALLOWED=x\nARBOR_NATIVE_API_KEY=\n", "utf8");
      const target: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: cfg, OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "already-set" };
      const result = loadUserEnvironment(target);
      expect(result.present).toBe(true);
      expect(result.loaded_names).toEqual(["OPENROUTER_API_KEY"]);
      expect(target.OPENROUTER_API_KEY).toBe("user-key");   // empty placeholder filled
      expect(target.ANTHROPIC_API_KEY).toBe("already-set"); // real value kept
      expect(target.NOT_ALLOWED).toBeUndefined();
      expect(target.ARBOR_NATIVE_API_KEY).toBeUndefined();  // empty in file: not a credential
    } finally { rmSync(cfg, { recursive: true, force: true }); }
  });

  it("reports absence without throwing when the file does not exist", () => {
    expect(loadUserEnvironment({ XDG_CONFIG_HOME: "/nonexistent/for/revoy" }).present).toBe(false);
  });
});
