import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("development entry shutdown wiring", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("passes %s through the supplied shutdown gate", async (signal) => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-entry-signal-"));
    const entry = readFileSync(fileURLToPath(new URL("../bin/arbor-mcp.mjs", import.meta.url)), "utf8");
    // Execute the shipped entry source, replacing only its CLI dependency.
    // Runtime interruption semantics are covered separately; this catches a
    // launcher which imports main but omits the existing gate entirely.
    writeFileSync(join(directory, "entry.mjs"), entry.replace('"../src/cli.ts"', '"./cli.mjs"'));
    writeFileSync(join(directory, "cli.mjs"), `
      export class ShutdownGate {
        constructor() { this.signal = new Promise(resolve => { this.resolve = resolve; }); }
        trigger() { this.resolve(); }
      }
      export async function main(args, environment, gate) {
        if (!gate) { process.stdout.write("MISSING_GATE\\n"); return 42; }
        process.stdout.write("READY\\n");
        await gate.signal;
        process.stdout.write("INTERRUPTED\\n");
        return 0;
      }
    `);
    const child = spawn("bun", [join(directory, "entry.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let sent = false;
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`entry did not settle: ${output}`)); }, 5_000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          if (!sent && output.includes("READY")) { sent = true; child.kill(signal); }
        });
        child.stderr.on("data", (chunk) => { output += chunk.toString(); });
        child.once("close", (exit) => { clearTimeout(timer); resolve(exit); });
      });
      expect(sent).toBe(true);
      expect(code).toBe(0);
      expect(output).toContain("INTERRUPTED");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
