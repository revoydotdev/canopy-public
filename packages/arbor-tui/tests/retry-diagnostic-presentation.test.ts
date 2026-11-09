import { describe, expect, it } from "vitest";
import { consoleScreen } from "../src/screens/console.js";

describe("Console retry diagnostic presentation", () => {
  it("renders content-free retry facts received through the session projection", () => {
    const size = { width: 120, height: 24 };
    const projection = consoleScreen.project({
      captured_at: "2026-09-05T09:00:00.000Z", sidebar_visibility: "hidden",
      session_attach: { live: true, session: { session_id: "retry-proof" }, events: [{
        session_id: "retry-proof", sequence: 1, occurred_at: "2026-09-05T09:00:00.000Z",
        kind: "diagnostic", payload: { code: "model_retry", retry: {
          attempt: 1, max_attempts: 3, delay_ms: 50, failure_kind: "timeout",
        } },
      }] },
    }, size);
    const rendered = consoleScreen.render({ projection, ...size }).join("\n");
    expect(rendered).toContain("Attempt 1/3 failed (timeout); retrying in 50 ms.");
  });

  it("renders the typed terminal provider reason, never a raw diagnostic message", () => {
    const size = { width: 160, height: 24 };
    const projection = consoleScreen.project({
      captured_at: "2026-10-06T00:00:00.000Z", sidebar_visibility: "hidden",
      session_attach: { live: false, session: { session_id: "reason-proof" }, events: [{
        session_id: "reason-proof", sequence: 3, occurred_at: "2026-10-06T00:00:00.000Z",
        kind: "diagnostic", payload: { code: "model_failure", provider_failure: {
          error_class: "OpenAICompatibleAdapterError", failure_kind: "http", http_status: 402,
          provider_code: "insufficient_quota", message: "OpenAI-compatible provider returned HTTP 402",
        } },
      }] },
    }, size);
    const rendered = consoleScreen.render({ projection, ...size }).join("\n");
    expect(rendered).toContain("OpenAICompatibleAdapterError (http) HTTP 402 insufficient_quota: OpenAI-compatible provider returned HTTP 402");
  });
});
