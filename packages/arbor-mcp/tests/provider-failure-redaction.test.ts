/**
 * A06 redaction boundary: a terminal model-port failure is persisted as a
 * typed, bounded, redacted provider reason, never as raw provider text.
 * The outermost restart proof is `recovery/provider-failure-restart.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveHarnessSessionFailure, HarnessSessionJournal, redactHarnessSessionEvent } from "../src/harness-session-journal.js";

const PLANTED = ["sk-ant-api03-PLANTEDsecretVALUE0123456789", "ghp_PLANTEDgithubTOKEN0123456789abcdef", "eyJPLANTEDhdr.eyJPLANTEDpayload.PLANTEDsignature", "PLANTED-TOKEN-VALUE", "PLANTED-RAW-BODY", "AKIAPLANTED000000000", "PLANTEDopaque0123456789abcdefABCDEF0123456789"];
const message = `model port failed: AnthropicMessagesAdapterError (http): Anthropic provider returned HTTP 401: authentication_error: invalid x-api-key ${PLANTED[0]} retry with ${PLANTED[1]} or ${PLANTED[2]} token=${PLANTED[3]} ${PLANTED[5]} ${PLANTED[6]} {"raw_body":"${PLANTED[4]}"}`;

function diagnostic(code: string, text: string, sequence = 1) {
  return redactHarnessSessionEvent({ session_id: "provider-failure", sequence, occurred_at: "2026-10-06T00:00:00.000Z", kind: "diagnostic", payload: { code, message: text } });
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("typed terminal provider reason", () => {
  it("keeps class, kind, status and code, and a redacted message cut before any body", () => {
    const payload = diagnostic("model_failure", message).payload;
    expect(payload).toMatchObject({
      code: "model_failure",
      provider_failure: { error_class: "AnthropicMessagesAdapterError", failure_kind: "http", http_status: 401, provider_code: "authentication_error" },
    });
    const reason = (payload.provider_failure as { message: string }).message;
    expect(reason).toContain("Anthropic provider returned HTTP 401: authentication_error: invalid x-api-key [REDACTED]");
    expect(reason).not.toMatch(/[{}<>]/);
    const serialized = JSON.stringify(payload);
    for (const secret of PLANTED) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("raw_body");
  });

  it("bounds the message and applies only to the worker's terminal model-port failure codes", () => {
    const long = diagnostic("model_retry_exhausted", `model port failed: Error: ${"quota exceeded ".repeat(100)}`).payload.provider_failure as { message: string; failure_kind: string; http_status: number | null };
    expect(long.message.length).toBeLessThanOrEqual(257);
    expect(long).toMatchObject({ failure_kind: "unknown", http_status: null });
    expect(diagnostic("steering_invalid", message).payload).toEqual({ code: "steering_invalid" });
    expect(diagnostic("model_failure", "provider said no").payload).toEqual({ code: "model_failure" });
    expect(diagnostic("model_failure", "model port failed: not a class shape").payload).toEqual({ code: "model_failure" });
  });

  it("derives the failure only for a failed terminal, from the canonical diagnostic before it", () => {
    const events = [
      redactHarnessSessionEvent({ session_id: "s", sequence: 1, occurred_at: "2026-10-06T00:00:00.000Z", kind: "diagnostic", payload: { code: "model_retry", message: "x", retry: { attempt: 1, max_attempts: 3, delay_ms: 10, failure_kind: "http" } } }),
      redactHarnessSessionEvent({ session_id: "s", sequence: 2, occurred_at: "2026-10-06T00:00:01.000Z", kind: "diagnostic", payload: { code: "model_retry", message: "x", retry: { attempt: 2, max_attempts: 3, delay_ms: 20, failure_kind: "timeout" } } }),
      diagnostic("model_retry_exhausted", "model port failed: OpenAICompatibleAdapterError (http): OpenAI-compatible provider returned HTTP 503", 3),
      redactHarnessSessionEvent({ session_id: "s", sequence: 4, occurred_at: "2026-10-06T00:00:02.000Z", kind: "terminal", payload: { state: "failed", cause: "failed", message: "raw" } }),
    ];
    const failure = deriveHarnessSessionFailure(events);
    expect(failure?.retries.map((retry) => [retry.sequence, retry.attempt, retry.failure_kind])).toEqual([[1, 1, "http"], [2, 2, "timeout"]]);
    expect(failure?.reason).toMatchObject({ sequence: 3, code: "model_retry_exhausted", provider: { http_status: 503, provider_code: null } });
    expect(failure?.terminal_sequence).toBe(4);
    const completed = [...events.slice(0, 3), redactHarnessSessionEvent({ ...events[3]!, payload: { state: "completed", cause: "completed", message: "done" } })];
    expect(deriveHarnessSessionFailure(completed)).toBeNull();
  });

  it("refuses to replay a forged journal line whose provider reason carries a raw body or extra field", () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-provider-failure-redaction-"));
    directories.push(directory);
    const journal = new HarnessSessionJournal({ persistence_dir: directory });
    expect(journal.recordStarted({ session_id: "forged", campaign_id: "c", node_id: "n", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "p", state: "running", latest_sequence: 0 })).toBe(true);
    expect(journal.recordEvent({ session_id: "forged", sequence: 1, occurred_at: "2026-10-06T00:00:00.000Z", kind: "lifecycle", payload: { state: "started", ephemeral: false } })).toBe(true);
    const forged = { error_class: "Error", failure_kind: "http", http_status: 402, provider_code: null, message: `{"raw":"${PLANTED[4]}"}` };
    appendFileSync(join(directory, "harness-sessions.ndjson"), `${JSON.stringify({ version: 1, kind: "event", event: { session_id: "forged", sequence: 2, occurred_at: "2026-10-06T00:00:01.000Z", kind: "diagnostic", payload: { code: "model_failure", provider_failure: forged } } })}\n`);
    appendFileSync(join(directory, "harness-sessions.ndjson"), `${JSON.stringify({ version: 1, kind: "event", event: { session_id: "forged", sequence: 2, occurred_at: "2026-10-06T00:00:01.000Z", kind: "diagnostic", payload: { code: "model_failure", provider_failure: { ...forged, message: "ok", body: PLANTED[4] } } } })}\n`);
    const replayed = new HarnessSessionJournal({ persistence_dir: directory });
    expect(replayed.events("forged").map((event) => event.sequence)).toEqual([1]);
    expect(replayed.replayDiagnostics().filter((entry) => entry.code === "invalid_entry")).toHaveLength(2);
  });
});
