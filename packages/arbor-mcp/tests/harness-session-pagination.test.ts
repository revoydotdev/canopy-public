import { describe, expect, it } from "vitest";
import { validateHarnessSessionQuery } from "../src/harness-session-contracts.js";

describe("harness session list cursor contract", () => {
  it("accepts a bounded opaque list cursor and rejects cursor use on non-list queries", () => {
    expect(validateHarnessSessionQuery({ schema_version: 1, query_id: "page-2", query: { kind: "harness.session.list", cursor: "session-001", limit: 25 } })).toEqual([]);
    expect(validateHarnessSessionQuery({ schema_version: 1, query_id: "wrong-route", query: { kind: "harness.session.inspect", session_id: "session-002", cursor: "session-001" } })).toContain("cursor is only valid for session list");
  });
});
