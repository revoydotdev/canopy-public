import { describe, expect, it } from "vitest";
import { isHarnessSessionContinuationEnvelope, isHarnessSessionQueryEnvelope, validateHarnessSessionContinuation, validateHarnessSessionQuery } from "../src/harness-session-contracts.js";

const metadata = { operation_id: "session-op", idempotency_key: "session-key", actor_id: "operator", requested_at: "2026-08-20T00:00:00.000Z", session: {} };
const provenance = { tag: "claimed" as const, claimant: "operator" };

describe("public harness-session continuation contracts", () => {
  it("exposes availability separately from mutating continuation authority", () => {
    const availability = { schema_version: 1 as const, query_id: "availability", query: { kind: "harness.session.availability" as const, session_id: "terminal-session" } };
    expect(isHarnessSessionQueryEnvelope(availability)).toBe(true);
    expect(validateHarnessSessionQuery(availability)).toEqual([]);
  });

  it("requires an operation-bound, provenance-bearing resume/fork/respawn request without transcript fields", () => {
    for (const kind of ["harness.session.resume", "harness.session.fork", "harness.session.respawn"] as const) {
      const envelope = { schema_version: 1 as const, metadata, command: { kind, session_id: "terminal-session", reason: "operator reviewed fresh admission", dispositions: [], provenance } };
      expect(isHarnessSessionContinuationEnvelope(envelope)).toBe(true);
      expect(validateHarnessSessionContinuation(envelope)).toEqual([]);
      expect(JSON.stringify(envelope)).not.toContain("history");
      expect(JSON.stringify(envelope)).not.toContain("credential");
    }
  });
});
