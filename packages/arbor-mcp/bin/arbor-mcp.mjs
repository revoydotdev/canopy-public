#!/usr/bin/env bun
/**
 * Development CLI entry point.
 *
 * revoy2 is a Bun workspace and its package exports intentionally point at
 * TypeScript source. Running that source directly keeps the installed
 * development command on the exact checkout the operator is editing, avoids
 * a per-invocation bundle, and preserves Bun for the native OpenTUI renderer.
 */
import { main, ShutdownGate } from "../src/cli.ts";

const shutdown = new ShutdownGate();
const interrupt = () => shutdown.trigger();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  process.exitCode = await main(process.argv.slice(2), undefined, shutdown);
} catch (error) {
  process.stderr.write(
    `arbor: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
