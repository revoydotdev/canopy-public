#!/usr/bin/env bun
/**
 * Start the Claude bridge.
 *
 *   ARBOR_BRIDGE_API_KEY=<secret> bun packages/arbor-claude-bridge/bin/arbor-claude-bridge.mjs [--port 8787]
 *
 * Point arbor at it with `native.base_url = "http://127.0.0.1:8787/v1"`,
 * `native.adapter_id = "openai-compatible"`, and ARBOR_NATIVE_API_KEY set to
 * the same secret.
 */
import { startBridge } from "../src/server.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const apiKey = process.env.ARBOR_BRIDGE_API_KEY ?? "";
if (apiKey.trim() === "") {
  console.error("ARBOR_BRIDGE_API_KEY must be set to a non-empty shared secret");
  process.exit(1);
}

const port = Number(flag("port", process.env.ARBOR_BRIDGE_PORT ?? "8787"));
const bridge = startBridge({
  apiKey,
  port,
  host: flag("host", "127.0.0.1"),
  cwd: flag("cwd", process.cwd()),
  ...(process.env.ARBOR_BRIDGE_TRACE_DIR ? { traceDir: process.env.ARBOR_BRIDGE_TRACE_DIR } : {}),
});

console.log(`arbor claude-bridge listening on http://127.0.0.1:${bridge.port}/v1`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { bridge.stop().finally(() => process.exit(0)); });
}
