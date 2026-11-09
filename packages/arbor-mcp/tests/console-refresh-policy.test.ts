import { describe, expect, it } from "vitest";
import { shouldRefreshConsoleSession } from "../src/console-refresh-policy.js";

const idle = { screen: "console", campaign_id: null, live_session_count: 0, console_data: null } as const;

describe("Console session refresh eligibility", () => {
  it("refreshes a campaign's session tail", () => {
    expect(shouldRefreshConsoleSession({ ...idle, campaign_id: "campaign" })).toBe(true);
  });
  it("refreshes a native session before campaign admission", () => {
    expect(shouldRefreshConsoleSession({ ...idle, live_session_count: 1 })).toBe(true);
  });
  it("refreshes clarification replanning before session registration", () => {
    expect(shouldRefreshConsoleSession({ ...idle, console_data: { drafts: { items: [{ status: "planning" }] } } })).toBe(true);
  });
  it.each(["failed", "cancelled", "awaiting_clarification", "admitted"])("does not poll an idle %s draft", (status) => {
    expect(shouldRefreshConsoleSession({ ...idle, console_data: { drafts: { items: [{ status }] } } })).toBe(false);
  });
  it("does not poll a hidden Console", () => {
    expect(shouldRefreshConsoleSession({ ...idle, screen: "tree", campaign_id: "campaign", live_session_count: 1 })).toBe(false);
  });
  it.each([null, {}, { drafts: null }, { drafts: { items: [null, 42, {}] } }])("handles incomplete data %j", (console_data) => {
    expect(shouldRefreshConsoleSession({ ...idle, console_data })).toBe(false);
  });
});
