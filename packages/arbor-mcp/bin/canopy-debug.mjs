#!/usr/bin/env bun
/** Source-bound instrumented TUI launcher. */
import { join, resolve } from "node:path";
import { main, ShutdownGate } from "../src/cli.ts";

const args = process.argv.slice(2);
function defaultStateDir() {
  const configured = process.env.CANOPY_DEBUG_STATE_DIR?.trim();
  if (configured) return resolve(configured);
  return resolve(join(process.cwd(), ".arbor", "canopy-debug"));
}
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`canopy-debug — instrumented Revoy TUI\nUsage: canopy-debug [tui options]\nCapture root: ${defaultStateDir()}\n`);
  process.exit(0);
}
const shutdown = new ShutdownGate();
// The ordinary `arbor tui` product path stays free of persistent debug capture.
process.env.CANOPY_DEBUG_ENABLED = "1";
const interrupt = () => shutdown.trigger();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const hasPersistence = args.some((arg) => arg === "--persistence-dir" || arg.startsWith("--persistence-dir="));
  const tuiArgs = hasPersistence ? ["tui", ...args] : ["tui", "--persistence-dir", defaultStateDir(), ...args];
  process.exitCode = await main(tuiArgs, undefined, shutdown);
} catch (error) {
  process.stderr.write(`canopy-debug: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
