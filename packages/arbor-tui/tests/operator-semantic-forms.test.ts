import { describe, expect, it } from "vitest";
import { renderOperatorEvent } from "../src/operator-event-render.js";
import { buildOperatorViewModel, consoleOperatorProjectionInput } from "../src/operator-view-model.js";

function view(events: readonly unknown[]) {
  return buildOperatorViewModel({
    viewport: { columns: 120, rows: 30 }, now_ms: 1,
    session_attach: { session: { session_id: "native-1" }, events },
  });
}

describe("operator semantic event forms", () => {
  it("derives file, patch, search, shell, and verification forms solely from exact native tool identifiers", () => {
    const document = view([
      { sequence: 1, kind: "tool_intent", payload: { tool: "file.read", input_summary: "src/a.ts" } },
      { sequence: 2, kind: "tool_intent", payload: { tool: "file.write", input_summary: "src/a.ts" } },
      { sequence: 3, kind: "tool_result", payload: { tool: "file.patch", result_summary: "applied" } },
      { sequence: 4, kind: "tool_result", payload: { tool: "git.diff", result_summary: "one file" } },
      { sequence: 5, kind: "tool_result", payload: { tool: "repository.search", result_summary: "2 matches" } },
      { sequence: 6, kind: "tool_intent", payload: { tool: "shell", input_summary: "read file and search" } },
      { sequence: 7, kind: "tool_intent", payload: { tool: "shell.execute", input_summary: "run verifier" } },
      { sequence: 8, kind: "tool_result", payload: { tool: "verification.run", result_summary: "16 checks passed", success: true } },
    ]).document;

    expect(document.map((row) => row.form)).toEqual(["file_read", "file_write", "patch_diff", "patch_diff", "search_results", "generic", "shell_command", "verification_result"]);
    expect(renderOperatorEvent(document[4]!, 120, false).join("\n")).toContain("search results");
    expect(renderOperatorEvent(document[6]!, 120, false).join("\n")).toContain("shell command");
    expect(renderOperatorEvent(document[7]!, 120, false).join("\n")).toContain("verification result");
  });

  it("keeps retries as an explicit relation and does not convert unrecognised handoff text into a handoff form", () => {
    const document = view([
      { sequence: 1, kind: "tool_intent", payload: { tool: "file.write", operation_id: "attempt-2", retry_of: "attempt-1", attempt: 2 } },
      { sequence: 2, kind: "tool_intent", payload: { tool: "shell", input_summary: "handoff this task" } },
    ]).document;

    expect(document[0]).toMatchObject({ form: "retry", retry: { previous_operation_id: "attempt-1", attempt: 2 } });
    expect(renderOperatorEvent(document[0]!, 120, false).join("\n")).toContain("retry #2 of attempt-1");
    expect(document[1]).toMatchObject({ form: "generic" });
  });

  it("renders producer-backed durable inbox records as session notifications and leaves read state actionable", () => {
    const projection = consoleOperatorProjectionInput({
      product_operations: { notifications: { notifications: [{
        id: "notice-1", severity: "warning", title: "Session requires attention", body: "Reconnect before continuing",
        project_id: "campaign-1", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:01:00Z", read_at: null, occurrences: 2,
      }] } },
    }, { viewport: { columns: 120, rows: 30 }, now_ms: 1 });
    expect(projection).not.toBeNull();
    const notification = buildOperatorViewModel(projection!).document[0]!;

    expect(notification).toMatchObject({
      form: "session_notification", source: "notification", truth: "canonical", importance: "attention",
      actions: [{ id: "notification.read:notice-1", enabled: true }],
    });
    expect(renderOperatorEvent(notification, 120, false).join("\n")).toContain("session notification");
  });

  it("projects exact failure level and evidence without inventing retry safety", () => {
    const document = view([
      { sequence: 1, kind: "tool_result", payload: { tool: "shell.execute", success: false, result_summary: "exit 2", evidence: { outcome: "failed", stage: "execution", code: "nonzero_exit", effect: "none", action_scope: { status: "not_required" } } } },
      { sequence: 2, kind: "terminal", payload: { state: "failed", cause: "failed", message: "worker failed" } },
    ]).document;

    expect(document[0]?.failure).toEqual({ level: "operation", classification: "nonzero_exit", stage: "execution", effect: "none", retry_safe: null, wider_task_running: null });
    expect(document[1]?.failure).toEqual({ level: "session", classification: "failed", stage: "terminal", effect: null, retry_safe: null, wider_task_running: false });
    expect(renderOperatorEvent(document[0]!, 160, false).join("\n")).toContain("retry safety not reported");
    expect(view([
      { sequence: 1, kind: "tool_result", payload: { tool: "shell.execute", success: false, evidence: { outcome: "failed", stage: "execution", code: "nonzero_exit", effect: "none", action_scope: { status: "not_required" } } } },
    ]).inspector?.failure?.classification).toBe("nonzero_exit");
  });
});
