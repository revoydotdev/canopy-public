#!/usr/bin/env node
// Stands in for the `claude` CLI: emits the same stream-json NDJSON frames the
// real binary does, so the bridge's parsing and SSE translation are exercised
// end-to-end without an API call. Echoes its argv so tests can assert the
// composed command line.
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
let stdin = "";
try { stdin = readFileSync(0, "utf8"); } catch { /* no stdin */ }
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
emit({ type: "system", subtype: "init", argv, stdin });
if (process.env.FAKE_CLAUDE_MODE === "error") {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_MODE === "crash") { process.exit(3); }
// Structured output: the real CLI (2.1.259, verified 2026-09-03) streams no
// text_delta for a --json-schema run; the value arrives only in the result
// frame as `structured_output` plus its JSON text in `result`.
if (process.env.FAKE_CLAUDE_MODE === "structured") {
  const value = JSON.parse(process.env.FAKE_CLAUDE_STRUCTURED ?? "{}");
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "SHOULD-NOT-LEAK" } } });
  // The real CLI narrates before calling StructuredOutput ("Let me assess…");
  // that narration is a text_delta and must never reach a structured caller.
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "NARRATION-MUST-NOT-LEAK " } } });
  emit({
    type: "result", subtype: "success", is_error: false, total_cost_usd: 0.001, result: JSON.stringify(value), structured_output: value,
    usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  process.exit(0);
}
emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "SHOULD-NOT-LEAK" } } });
for (const piece of ["Hello", ", ", "world"]) {
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } } });
}
emit({
  type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0037,
  usage: { input_tokens: 9, output_tokens: 41, cache_read_input_tokens: 8811, cache_creation_input_tokens: 803 },
});
