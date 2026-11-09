import { describe, expect, it } from "vitest";
import { redactHarnessSessionEvent } from "../src/harness-session-journal.js";

const retry = { attempt: 1, max_attempts: 3, delay_ms: 50, failure_kind: "timeout" };
function redact(value: unknown) {
  return redactHarnessSessionEvent({ session_id: "retry-proof", sequence: 1,
    occurred_at: "2026-09-05T09:00:00.000Z", kind: "diagnostic",
    payload: { code: "model_retry", message: "private provider response", retry: value },
  }).payload;
}

describe("content-free retry diagnostics", () => {
  it("retains only validated retry facts, never provider messages or extra fields", () => {
    expect(redact({ ...retry, prompt: "private prompt", credential: "private credential" }))
      .toEqual({ code: "model_retry", retry });
  });

  it.each([
    { ...retry, attempt: 0 }, { ...retry, attempt: 3 },
    { ...retry, max_attempts: Infinity }, { ...retry, delay_ms: -1 },
    { ...retry, failure_kind: "private provider text" }, null,
  ])("drops malformed metadata rather than laundering it into operator detail", (value) => {
    expect(redact(value)).toEqual({ code: "model_retry" });
  });
});
