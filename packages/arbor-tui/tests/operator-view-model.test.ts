import { describe, expect, it } from "vitest";
import { buildOperatorViewModel } from "../src/operator-view-model.js";

const input = (overrides: Partial<Parameters<typeof buildOperatorViewModel>[0]> = {}) => ({
  viewport: { columns: 100, rows: 30 },
  now_ms: 1_000,
  ...overrides,
});

describe("operator view model", () => {
  it("treats a null session attachment as an ordinary no-session state", () => {
    const view = buildOperatorViewModel(input({ session_attach: null }));
    expect(view.document).toEqual([]);
    expect(view.attention).toEqual([]);
  });

  it("projects the actual task-composer clarification question", () => {
    const view = buildOperatorViewModel(input({
      taskcomposer_projection: { items: [{
        id: "draft-question", task: "Build something", status: "awaiting_clarification",
        proposal: { questions: [{ id: "q1", question: "Which runtime should this target?", reason: "The target changes the package shape." }] },
      }] },
    }));
    expect(view.document).toContainEqual(expect.objectContaining({
      event_kind: "taskcomposer.question",
      summary: "Which runtime should this target?",
      detail: "The target changes the package shape.",
      lifecycle: "pending",
    }));
  });

  it("keeps canonical session facts distinct from supplemental devtools activity", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1", campaign_id: "c1", node_id: "n1" },
        events: [{ sequence: 2, occurred_at: "2026-08-30T00:00:02Z", kind: "model_text", payload: { text: "canonical work" } }],
      },
      devtools_stream: {
        campaign_id: "c1",
        lines: [{ seq: 1, ts: "2026-08-30T00:00:01Z", event_kind: "loop.tool_call", campaign_id: "c1", node_id: "n1", loop_event: { command: "rg source" } }],
      },
    }));

    expect(view.document.map((row) => [row.source, row.truth, row.source_id, row.summary])).toEqual([
      ["canonical_session", "canonical", "s1", "canonical work"],
      ["devtools", "supplemental", "c1", "$ rg source"],
    ]);
    expect(view.freshness.cross_source_order).toBe("source_grouped");
  });

  it("projects durable user-input and task-intake facts through the canonical grammar without creating a shared timestamp order", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "native-1", campaign_id: "c1", node_id: "n1" },
        events: [{ sequence: 1, kind: "model_text", payload: { text: "canonical session work" } }],
      },
      userinput_projection: {
        campaign_id: "c1", node_id: "n1", answered_record_ids: ["withheld"],
        records: [
          { id: "open", timestamp: "2026-08-30T00:00:01Z", question: { question: "Choose a target", requester_role: "taproot", origin_session_id: "native-1" } },
          { id: "withheld", timestamp: "2026-08-30T00:00:02Z", question: { question: "Approve deployment?", origin_session_id: "native-1" } },
        ],
      },
      taskcomposer_projection: { items: [{
        id: "draft-1", campaign_id: "c1", task: "Implement the canonical document", status: "failed",
        created_at: "2026-08-30T00:00:03Z", updated_at: "2026-08-30T00:00:04Z",
        guidance: { headline: "Task intake failed", recommendation: "Name the affected files." },
      }] },
      devtools_stream: { campaign_id: "c1", lines: [{ seq: 1, event_kind: "loop.tool_call", loop_event: { command: "rg canonical" } }] },
    }));

    expect(view.document.map((row) => [row.source, row.truth, row.summary, row.lifecycle])).toEqual([
      ["canonical_session", "canonical", "canonical session work", "observed"],
      ["userinput", "canonical", "Choose a target", "pending"],
      ["userinput", "canonical", "Approve deployment?", "completed"],
      ["userinput", "canonical", "answer recorded", "completed"],
      ["taskcomposer", "canonical", "Implement the canonical document", "observed"],
      ["taskcomposer", "canonical", "Task intake failed", "failed"],
      ["devtools", "supplemental", "$ rg canonical", "observed"],
    ]);
    expect(view.document.find((row) => row.summary === "answer recorded")).toMatchObject({
      detail: null, correlation: { session_id: "native-1", campaign_id: "c1", node_id: "n1" },
    });
    expect(view.attention.map((row) => row.summary)).toEqual(["Choose a target", "Task intake failed"]);
    expect(view.selected_attention).toEqual({ event_id: "userinput:open:question:0", summary: "Choose a target", lifecycle: "pending" });
    expect(view.freshness).toMatchObject({ canonical_rows: 6, supplemental_rows: 1, cross_source_order: "source_grouped" });
  });

  it("keeps governed lifecycle narration, tests, diffs, stale failures, and attention precedence in the canonical document", () => {
    const view = buildOperatorViewModel(input({
      userinput_projection: { requests: [{ record_id: "approval-like-input", campaign_id: "c1", node_id: "n1", question: "Approve the release?" }] },
      devtools_stream: { campaign_id: "c1", lines: [
        { seq: 1, ts: "2026-08-30T00:00:01Z", event_kind: "loop.campaign_start", campaign_id: "c1", loop_event: {} },
        { seq: 2, ts: "2026-08-30T00:00:02Z", event_kind: "loop.decomposed", campaign_id: "c1", node_id: "node-root", loop_event: {} },
        { seq: 3, ts: "2026-08-30T00:00:03Z", event_kind: "loop.specialist_dispatched", campaign_id: "c1", node_id: "n1", loop_event: { agent: "Heartwood" } },
        { seq: 4, ts: "2026-08-30T00:00:04Z", event_kind: "loop.node_failed", campaign_id: "c1", node_id: "n1", loop_event: { reason: "test failed" } },
        { seq: 5, ts: "2026-08-30T00:00:05Z", event_kind: "loop.node_claimed", campaign_id: "c1", node_id: "n1", loop_event: {} },
        { seq: 6, ts: "2026-08-30T00:00:06Z", event_kind: "loop.tool_call", campaign_id: "c1", node_id: "n1", loop_event: { command: "bun run test:all", ok: true } },
        { seq: 7, ts: "2026-08-30T00:00:07Z", event_kind: "loop.tool_call", campaign_id: "c1", node_id: "n2", loop_event: { command: "./node_modules/.bin/vitest run focused", ok: false } },
        { seq: 8, ts: "2026-08-30T00:00:08Z", event_kind: "loop.diff", campaign_id: "c1", node_id: "n1", loop_event: { path: "console.ts", additions: 3, deletions: 1 } },
        { seq: 9, ts: "2026-08-30T00:00:09Z", event_kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", loop_event: {} },
      ] },
    }));

    expect(view.document.map((row) => [row.event_kind, row.kind, row.summary, row.lifecycle])).toEqual([
      ["request_user_input", "permission_gate", "Approve the release?", "pending"],
      ["loop.campaign_start", "status", "starting governed campaign", "observed"],
      ["loop.decomposed", "status", "expanding plan into tasks", "observed"],
      ["loop.specialist_dispatched", "status", "dispatching Heartwood through flight control", "observed"],
      ["loop.node_failed", "diagnostic", "Lenticel rejected node", "failed"],
      ["loop.node_claimed", "status", "claim recorded", "observed"],
      ["loop.tool_call", "test", "tests passed: bun run test:all", "completed"],
      ["loop.tool_call", "test", "tests failed: ./node_modules/.bin/vitest run focused", "failed"],
      ["loop.diff", "artifact", "diff captured: console.ts", "observed"],
    ]);
    expect(view.document.find((row) => row.event_kind === "loop.node_failed")).toMatchObject({ stale: true, visual: { emphasis: "muted" } });
    expect(view.document.find((row) => row.summary.includes("vitest run focused"))).toMatchObject({ stale: false, importance: "attention" });
    expect(view.selected_attention).toEqual({ event_id: "userinput:approval-like-input:awaiting:0", summary: "Approve the release?", lifecycle: "pending" });
  });

  it("uses only a valid canonical terminal state and never fabricates completion", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          { sequence: 1, kind: "model_text", payload: { text: "still working", phase: "commentary" } },
          { sequence: 2, kind: "terminal", payload: { state: "failed", result: "verified", message: "real failure" } },
          { sequence: 3, kind: "model_text", payload: { text: "late text" } },
        ],
      },
    }));

    expect(view.document.map((row) => [row.kind, row.lifecycle, row.summary])).toEqual([
      ["agent_narrative", "observed", "still working"],
      ["terminal", "failed", "session failed"],
      ["diagnostic", "unknown", "event received after canonical terminal state"],
    ]);
    expect(view.freshness.canonical_terminal_sessions).toEqual(["s1"]);
    expect(view.document.some((row) => row.lifecycle === "completed")).toBe(false);
  });

  it("orders a source by sequence before folding terminal lifecycle", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          { sequence: 3, kind: "terminal", payload: { state: "completed", message: "done" } },
          { sequence: 1, kind: "model_text", payload: { text: "pre-terminal work" } },
        ],
      },
    }));

    expect(view.document.map((row) => [row.sequence, row.kind, row.lifecycle])).toEqual([
      [1, "agent_narrative", "observed"],
      [3, "terminal", "completed"],
    ]);
  });

  it("keeps the canonical final answer adjacent to its terminal outcome instead of replacing it with a result-review surrogate", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s-complete", campaign_id: "c1", node_id: "n-final" },
        events: [
          { sequence: 4, kind: "model_text", payload: { phase: "final", text: "Implemented the streaming manifest and verified the focused suite." } },
          { sequence: 5, kind: "terminal", payload: { state: "completed", message: "worker completed" } },
        ],
      },
    }));

    expect(view.document.map((row) => [row.kind, row.summary, row.lifecycle, row.truth])).toEqual([
      ["final_answer", "Implemented the streaming manifest and verified the focused suite.", "observed", "canonical"],
      ["terminal", "session completed", "completed", "canonical"],
    ]);
  });

  it("projects canonical tool and gate lifecycles without deriving authority from supplemental events", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          { sequence: 0, kind: "model_route", payload: { route: "tool_capable", provider_id: "openrouter", model_id: "tool-model" } },
          { sequence: 1, kind: "tool_intent", payload: { tool: "shell", operation_id: "op1" } },
          { sequence: 2, kind: "tool_result", payload: { tool: "shell", operation_id: "op1", ok: true } },
          { sequence: 3, kind: "approval_requested", payload: { operation_id: "op2", subject: "publish" } },
          { sequence: 4, kind: "approval_resolved", payload: { operation_id: "op2", approved: false } },
          { sequence: 5, kind: "tool_result", payload: { tool: "shell", operation_id: "op3", ok: false, error: "exit 1" } },
        ],
      },
      devtools_stream: { lines: [{ seq: 1, event_kind: "loop.tool_call", loop_event: { command: "bun test", ok: true } }] },
    }));

    expect(view.document.map((row) => [row.truth, row.event_kind, row.lifecycle])).toEqual([
      ["canonical", "model_route", "observed"],
      ["canonical", "tool_intent", "active"],
      ["canonical", "tool_result", "completed"],
      ["canonical", "approval_requested", "pending"],
      ["canonical", "approval_resolved", "completed"],
      ["canonical", "tool_result", "failed"],
      ["supplemental", "loop.tool_call", "completed"],
    ]);
    expect(view.document[0]).toMatchObject({ summary: "model route: tool_capable", detail: "openrouter/tool-model" });
    expect(view.foreground?.event_id).toContain(":3");
  });

  it("preserves ordered stdout and stderr channel identity in operator-visible summaries", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          { sequence: 1, kind: "tool_result", payload: { tool: "shell", channel: "stdout", ok: true, result_summary: "ordinary output" } },
          { sequence: 2, kind: "tool_result", payload: { tool: "shell", channel: "stderr", ok: false, result_summary: "actionable failure" } },
        ],
      },
    }));

    expect(view.document.map((row) => [row.sequence, row.summary, row.lifecycle])).toEqual([
      [1, "stdout: shell", "completed"],
      [2, "stderr: shell", "failed"],
    ]);
  });

  it("renders a retry as a linked attempt while retaining the failed original", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          { sequence: 1, kind: "tool_result", payload: { tool: "shell", operation_id: "attempt-1", ok: false, result_summary: "first failed" } },
          { sequence: 2, kind: "tool_intent", payload: { tool: "shell", operation_id: "attempt-2", parent_id: "attempt-1", retry_of: "attempt-1", attempt: 2, input_summary: "run again" } },
        ],
      },
    }));

    expect(view.document[0]).toMatchObject({ lifecycle: "failed", correlation: { operation_id: "attempt-1" } });
    expect(view.document[1]).toMatchObject({
      summary: "retry: shell (attempt 2)",
      detail: "run again · retry of attempt-1",
      parent_id: "attempt-1",
      correlation: { operation_id: "attempt-2" },
    });
  });

  it("represents bounded multiline command output and pairs it only by an exact canonical operation identity", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          { sequence: 1, kind: "tool_intent", payload: { tool: "shell", operation_id: "command-1", input_summary: "printf '%s\\n' one two" } },
          { sequence: 2, kind: "tool_result", payload: { tool: "shell", operation_id: "command-1", parent_id: "command-1", channel: "stdout", ok: true, result_summary: "one\ntwo\nthree" } },
        ],
      },
    }));

    expect(view.document[0]).toMatchObject({
      summary: "tool: shell",
      command: { role: "invocation", canonical_operation_id: "command-1", paired_event_id: "canonical:s1:2" },
    });
    expect(view.document[1]).toMatchObject({
      summary: "3 lines · stdout · result: shell",
      parent_id: "command-1",
      command: {
        role: "result",
        canonical_operation_id: "command-1",
        paired_event_id: "canonical:s1:1",
        output: { channel: "stdout", line_count: 3, lines: ["one", "two", "three"] },
      },
    });
  });

  it("does not guess a command/result pair from sequence or tool name when canonical identity is missing or ambiguous", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          { sequence: 1, kind: "tool_intent", payload: { tool: "shell", input_summary: "first" } },
          { sequence: 2, kind: "tool_result", payload: { tool: "shell", result_summary: "first complete" } },
          { sequence: 3, kind: "tool_intent", payload: { tool: "shell", operation_id: "ambiguous", input_summary: "second" } },
          { sequence: 4, kind: "tool_intent", payload: { tool: "shell", operation_id: "ambiguous", input_summary: "duplicate" } },
          { sequence: 5, kind: "tool_result", payload: { tool: "shell", operation_id: "ambiguous", result_summary: "ambiguous complete" } },
          { sequence: 6, kind: "tool_intent", payload: { tool: "shell", operation_id: "ambiguous", input_summary: "third duplicate" } },
        ],
      },
    }));

    expect(view.document.filter((row) => row.kind === "tool" || row.kind === "tool_result").every((row) => row.command?.paired_event_id === null)).toBe(true);
    expect(view.command_groups).toEqual([]);
  });

  it("collates an explicitly grouped command series without merging its canonical rows", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          { sequence: 1, kind: "tool_intent", payload: { tool: "shell", operation_id: "one", command_group_id: "series", input_summary: "first" } },
          { sequence: 2, kind: "tool_result", payload: { tool: "shell", operation_id: "one", command_group_id: "series", parent_id: "one", ok: true, result_summary: "first result" } },
          { sequence: 3, kind: "tool_intent", payload: { tool: "shell", operation_id: "two", command_group_id: "series", input_summary: "second" } },
          { sequence: 4, kind: "tool_result", payload: { tool: "shell", operation_id: "two", command_group_id: "series", parent_id: "two", ok: true, result_summary: "second result" } },
        ],
      },
    }));

    expect(view.document).toHaveLength(4);
    expect(view.document.map((row) => row.summary)).toEqual([
      "1/2 command: shell", "1/2 done: shell", "2/2 command: shell", "2/2 done: shell",
    ]);
    expect(view.command_groups).toEqual([{
      id: "series", source: "canonical_session", source_id: "s1",
      command_count: 2, paired_count: 2, unpaired_count: 0, completed_count: 2, failed_count: 0,
    }]);
  });

  it("scopes identical operation ids by canonical session so concurrent commands cannot cross-pair", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "root" },
        events: [
          { sequence: 1, kind: "tool_intent", payload: { session_id: "agent-a", tool: "shell", operation_id: "shared" } },
          { sequence: 2, kind: "tool_intent", payload: { session_id: "agent-b", tool: "shell", operation_id: "shared" } },
          { sequence: 3, kind: "tool_result", payload: { session_id: "agent-a", tool: "shell", operation_id: "shared", ok: true } },
          { sequence: 4, kind: "tool_result", payload: { session_id: "agent-b", tool: "shell", operation_id: "shared", ok: true } },
        ],
      },
    }));

    for (const row of view.document) {
      expect(row.command?.paired_event_id).toMatch(new RegExp(`^canonical:${row.source_id}:`, "u"));
    }
  });

  it("deduplicates an exact replay but surfaces a conflicting canonical sequence", () => {
    const repeated = { sequence: 2, occurred_at: "T", kind: "model_text", payload: { text: "same" } };
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          repeated,
          structuredClone(repeated),
          { sequence: 3, occurred_at: "T", kind: "model_text", payload: { text: "first" } },
          { sequence: 3, occurred_at: "T", kind: "model_text", payload: { text: "conflict" } },
        ],
      },
    }));

    expect(view.bounds.deduplicated_rows).toBe(1);
    expect(view.document.filter((row) => row.summary === "same")).toHaveLength(1);
    expect(view.document).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "diagnostic", summary: "conflicting replay for canonical sequence 3" }),
    ]));
  });

  it("turns malformed source material into bounded unavailable diagnostics", () => {
    const view = buildOperatorViewModel(input({
      session_attach: { session: { session_id: "s1" }, events: [{ sequence: 1, payload: {} }, null] },
      devtools_stream: { lines: [{ seq: 1 }, "not-a-line"] },
      limits: { max_rows: 20, max_detail_chars: 24, max_attention: 20 },
    }));

    expect(view.document).toHaveLength(4);
    expect(view.document.every((row) => row.kind === "diagnostic" && row.truth === "unavailable")).toBe(true);
    expect(view.document.every((row) => row.summary.length <= 24)).toBe(true);
  });

  it("keeps malformed durable projections unavailable while resolving only complete durable answers", () => {
    const malformed = buildOperatorViewModel(input({
      userinput_projection: "not a user-input ledger",
      taskcomposer_projection: ["not a task projection"],
    }));
    expect(malformed.document.map((row) => [row.source, row.truth, row.summary])).toEqual([
      ["userinput", "unavailable", "userinput projection is not an object"],
      ["taskcomposer", "unavailable", "taskcomposer projection is not an object"],
    ]);

    const resolved = buildOperatorViewModel(input({
      userinput_projection: {
        campaign_id: "c1",
        records: [
          { id: "with-answer", question: { question: "Choose destination", reason: "release" }, answer: { option_id: "production", answered_by: "operator", answered_at: "2026-08-30T00:00:02Z" } },
          { id: "explicit-answer", kind: "user_input_answer", question_record_id: "with-answer", answer: { custom_text: "confirmed", answered_by: "operator" } },
          { id: "incomplete-answer", kind: "user_input_answer", answer: { custom_text: "must not appear" } },
          { question: { question: "missing stable record id" } },
        ],
      },
      taskcomposer_projection: { items: [
        { id: "admitted", task: "Admit task", status: "admitted" },
        { id: "planning", status: "planning" },
        { id: "clarify", status: "awaiting_clarification" },
        { id: "unknown", status: "queued" },
        { status: "failed" },
      ] },
    }));

    expect(resolved.document.map((row) => [row.summary, row.lifecycle, row.importance, row.truth])).toEqual([
      ["Choose destination", "completed", "supporting", "canonical"],
      ["production", "completed", "ordinary", "canonical"],
      ["confirmed", "completed", "ordinary", "canonical"],
      ["Admit task", "observed", "ordinary", "canonical"],
      ["campaign admitted", "completed", "supporting", "canonical"],
      ["planning task", "pending", "supporting", "canonical"],
      ["task awaiting clarification", "pending", "supporting", "canonical"],
      ["task queued", "observed", "supporting", "canonical"],
    ]);
    expect(resolved.document.find((row) => row.summary === "Choose destination")).toMatchObject({ detail: "release" });
    expect(resolved.attention).toEqual([]);
    expect(resolved.selected_attention).toEqual({
      event_id: "taskcomposer:clarify:status:2", summary: "task awaiting clarification", lifecycle: "pending",
    });
  });

  it("projects direct canonical lifecycle forms without changing their source truth", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          { sequence: 1, kind: "human_input_question", payload: { text: "Need an override?", reason: "policy" } },
          { sequence: 2, kind: "human_input_answer", payload: { response: "override denied", answered_by: "operator" } },
          { sequence: 3, kind: "artifact", payload: { artifact_id: "outcome-1" } },
          { sequence: 4, kind: "interrupt_requested", payload: { message: "operator requested stop" } },
          { sequence: 5, kind: "tool_result", payload: { tool: "shell", success: false, error: "exit 1" } },
          { sequence: 6, kind: "approval_resolved", payload: { rationale: "policy denied" } },
          { sequence: 7, kind: "terminal", payload: { state: "interrupted", message: "settled" } },
        ],
      },
    }));

    expect(view.document.map((row) => [row.kind, row.summary, row.detail, row.lifecycle, row.truth])).toEqual([
      ["permission_gate", "Need an override?", "policy", "pending", "canonical"],
      ["operator", "override denied", "operator", "completed", "canonical"],
      ["artifact", "artifact: outcome-1", null, "observed", "canonical"],
      ["cancellation", "interrupt requested", "operator requested stop", "pending", "canonical"],
      ["tool_result", "tool result: shell", null, "failed", "canonical"],
      ["permission_gate", "approval resolved", "policy denied", "completed", "canonical"],
      ["terminal", "session interrupted", "settled", "interrupted", "canonical"],
    ]);
    expect(view.selected_attention).toEqual({ event_id: "canonical:s1:1", summary: "Need an override?", lifecycle: "pending" });
  });

  it("bounds rows and details while exposing elision counts", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          { sequence: 1, kind: "tool_intent", payload: { tool: "shell", input_summary: "a".repeat(20) } },
          { sequence: 2, kind: "tool_intent", payload: { tool: "shell", input_summary: "b".repeat(20) } },
          { sequence: 3, kind: "tool_intent", payload: { tool: "shell", input_summary: "c".repeat(20) } },
        ],
      },
      limits: { max_rows: 2, max_detail_chars: 8, max_attention: 2 },
    }));

    expect(view.document.map((row) => row.sequence)).toEqual([2, 3]);
    expect(view.document.every((row) => (row.detail?.length ?? 0) <= 8)).toBe(true);
    expect(view.bounds).toMatchObject({ input_rows: 3, retained_rows: 2, elided_rows: 1 });
    expect(view.bounds.elided_detail_chars).toBeGreaterThan(0);
    expect(view.bounds.retained_detail_chars).toBe(16);
  });

  it("retains canonical rows before filling bounded capacity with a supplemental tail", () => {
    const view = buildOperatorViewModel(input({
      session_attach: { session: { session_id: "s1" }, events: [{ sequence: 1, kind: "terminal", payload: { state: "completed", message: "done" } }] },
      devtools_stream: { campaign_id: "c1", lines: Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, event_kind: "loop.tool_call", loop_event: { command: `cmd-${index + 1}` } })) },
      limits: { max_rows: 2, max_detail_chars: 100, max_attention: 2 },
    }));

    expect(view.document.map((row) => [row.source, row.sequence, row.lifecycle])).toEqual([
      ["canonical_session", 1, "completed"],
      ["devtools", 10, "observed"],
    ]);
    expect(view.bounds.elided_rows).toBe(9);
  });

  it("leaves objective null until an explicit canonical objective source exists", () => {
    const view = buildOperatorViewModel(input({
      session_attach: { session: { session_id: "s1" }, events: [{ sequence: 1, kind: "model_text", payload: { text: "I will migrate the TUI" } }] },
    }));

    expect(view.objective).toBeNull();
  });

  it("projects the exact campaign-tree root as objective and inspects canonical attention", () => {
    const view = buildOperatorViewModel(input({
      campaign_tree: { campaign_id: "c1", nodes: [
        { id: "root", parent_id: null, action_description: "Ship the frontier operator interface" },
        { id: "child", parent_id: "root", action_description: "Implement the inspector" },
      ] },
      session_attach: { session: { session_id: "s1", campaign_id: "c1", node_id: "child" }, events: [
        { sequence: 1, kind: "model_text", payload: { text: "working", phase: "commentary" } },
        { sequence: 2, kind: "diagnostic", payload: { code: "blocked", message: "credential missing" } },
      ] },
    }));

    expect(view.objective).toEqual({
      summary: "Ship the frontier operator interface",
      correlation: { session_id: null, campaign_id: "c1", node_id: "root", operation_id: null, command_group_id: null },
    });
    expect(view.inspector).toMatchObject({
      event_id: "canonical:s1:2", title: "credential missing", lifecycle: "observed",
      actor: "system", source: "canonical_session", source_id: "s1",
    });
  });

  it("keeps the newest canonical attention rows within the configured cap", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1" },
        events: [
          { sequence: 1, kind: "diagnostic", payload: { code: "old", message: "old" } },
          { sequence: 2, kind: "diagnostic", payload: { code: "middle", message: "middle" } },
          { sequence: 3, kind: "diagnostic", payload: { code: "new", message: "new" } },
        ],
      },
      limits: { max_rows: 10, max_detail_chars: 100, max_attention: 2 },
    }));

    expect(view.attention.map((item) => item.summary)).toEqual(["middle", "new"]);
  });

  it("preserves sequence order inside each source and correlation/parent identities", () => {
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1", campaign_id: "c1", node_id: "n1" },
        events: [
          { sequence: 4, kind: "tool_result", payload: { tool: "shell", parent_id: "op-1", operation_id: "op-2", result_summary: "done" } },
          { sequence: 2, kind: "tool_intent", payload: { tool: "shell", parent_id: "op-1" } },
        ],
      },
      devtools_stream: { campaign_id: "c1", lines: [
        { seq: 5, event_kind: "loop.tool_call", campaign_id: "c1", node_id: "n1", loop_event: { command: "later" } },
        { seq: 1, event_kind: "loop.tool_call", campaign_id: "c1", node_id: "n1", loop_event: { command: "earlier" } },
      ] },
    }));

    expect(view.document.map((row) => [row.source, row.sequence])).toEqual([
      ["canonical_session", 2], ["canonical_session", 4], ["devtools", 1], ["devtools", 5],
    ]);
    expect(view.document[1]).toMatchObject({ parent_id: "op-1", correlation: { session_id: "s1", campaign_id: "c1", node_id: "n1", operation_id: "op-2" } });
  });

  it("keeps concurrent sessions distinct and excludes the selected foreground session", () => {
    const view = buildOperatorViewModel(input({
      selected_session_id: "s1",
      session_list: { sessions: [
        { session_id: "s1", campaign_id: "c1", node_id: "n1", state: "running", terminal: null },
        { session_id: "s2", campaign_id: "c1", node_id: "n2", state: "running", terminal: null, pending_steering: 2 },
        { session_id: "s3", campaign_id: "c1", node_id: "n3", state: "failed", terminal: { state: "failed" } },
      ] },
    }));

    expect(view.background).toEqual([{
      source: "session", id: "s2", session_id: "s2", campaign_id: "c1", node_id: "n2",
      parent_id: null, operation_id: null, owner: null,
      state: "running", lifecycle: "active", pending_steering: 2,
    }]);
  });

  it("projects canonical work, approval, and supervision facts with exact ownership and safe job deduplication", () => {
    const view = buildOperatorViewModel(input({
      task_projection: { items: [
        { id: "task-parent", operation_id: "op-parent", kind: "plan", owner_scope_id: "c1", parent_id: null, state: "accepted", progress: null, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null },
        { id: "task-child", operation_id: "op-child", kind: "specialist.expand", owner_scope_id: "c1", parent_id: "task-parent", state: "retrying", progress: 0.5, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 2, cleanup: "pending" },
        { id: "task-cancelled", operation_id: "op-cancelled", kind: "cleanup", owner_scope_id: "c1", parent_id: null, state: "cancelled", progress: null, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: "completed" },
      ] },
      // Same id is not enough to prove one work item. Only the exact shared
      // operation id suppresses the scheduler projection from supervision.
      job_projection: { jobs: [
        { id: "task-child", operation_id: "op-distinct-job", kind: "queue", owner_scope_id: "c1", state: "started", progress: 0.25 },
        { id: "job-same-operation", operation_id: "op-child", kind: "queue", owner_scope_id: "c1", state: "started", progress: 0.5 },
      ] },
      approval_projection: { records: [
        { request_id: "approval-1", action: "permission.grant", subject: "deploy", resource_id: "resource-1", proposer: "seed", status: "pending", expires_at: "2026-08-30T01:00:00Z" },
      ] },
    }));

    expect(view.document.filter((row) => ["task", "job", "approval"].includes(row.source)).map((row) => [row.source, row.source_id, row.parent_id, row.lifecycle, row.summary])).toEqual([
      ["task", "task-parent", null, "pending", "task accepted: plan"],
      ["task", "task-child", "task-parent", "active", "task retrying: specialist.expand"],
      ["task", "task-cancelled", null, "interrupted", "task cancelled: cleanup"],
      ["job", "task-child", "op-distinct-job", "active", "job started: queue"],
      ["job", "job-same-operation", "op-child", "active", "job started: queue"],
      ["approval", "approval-1", "resource-1", "pending", "approval pending: permission.grant · deploy"],
    ]);
    expect(view.document.find((row) => row.source_id === "task-child" && row.source === "task")).toMatchObject({ detail: expect.stringContaining("parent task-parent") });
    expect(view.background.map((row) => [row.source, row.id, row.operation_id])).toEqual([
      ["task", "task-parent", "op-parent"],
      ["task", "task-child", "op-child"],
      ["job", "task-child", "op-distinct-job"],
    ]);
    expect(view.selected_attention).toEqual({ event_id: "approval:approval-1:0", summary: "approval pending: permission.grant · deploy", lifecycle: "pending" });
  });

  it("joins bounded output descriptors to exact canonical correlations without projecting raw bytes", () => {
    const matchingId = `out_${"a".repeat(64)}`;
    const sessionScopedId = `out_${"b".repeat(64)}`;
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1", campaign_id: "c1", node_id: "n1" },
        events: [{ sequence: 1, kind: "tool_result", payload: { tool: "shell", operation_id: "op1", result_summary: "done" } }],
      },
      output_list: [
        { status: "ok", record: { id: matchingId, campaign_id: "c1", node_id: "n1", operation_id: "op1", stream: "stdout", raw_content: "secret raw bytes" } },
        { status: "in_progress", record: { id: sessionScopedId, campaign_id: "c1", node_id: "n1", operation_id: "op1", session_id: "s1", stream: "model", content: "another secret" } },
        { status: "ok", record: { id: `out_${"c".repeat(64)}`, campaign_id: "c1", node_id: "n1", operation_id: "op1", session_id: "s2" } },
      ],
    }));

    expect(view.document[0]?.actions).toEqual([
      { id: `output.descriptor:${matchingId}`, label: "Inspect output descriptor", enabled: true },
      { id: `output.descriptor:${sessionScopedId}`, label: "Inspect output descriptor", enabled: true },
    ]);
    expect(JSON.stringify(view)).not.toContain("secret raw bytes");
    expect(JSON.stringify(view)).not.toContain("another secret");
  });

  it("withholds descriptor actions for mismatched, corrupt, malformed, and out-of-bound output rows", () => {
    const matchingId = `out_${"d".repeat(64)}`;
    const view = buildOperatorViewModel(input({
      session_attach: {
        session: { session_id: "s1", campaign_id: "c1", node_id: "n1" },
        events: [{ sequence: 1, kind: "tool_result", payload: { tool: "shell", operation_id: "op1" } }],
      },
      output_list: [
        { status: "ok", record: { id: `out_${"e".repeat(64)}`, campaign_id: "c1", node_id: "n1", operation_id: "other-operation" } },
        { status: "corrupt", id: matchingId, error: "tampered descriptor" },
        { status: "ok", record: { id: "not-a-descriptor-id", campaign_id: "c1", node_id: "n1", operation_id: "op1" } },
        { status: "ok", record: { id: matchingId, campaign_id: "c1", node_id: "n1", operation_id: "op1" } },
      ],
      limits: { max_rows: 10, max_detail_chars: 100, max_attention: 2, max_output_records: 3 },
    }));

    expect(view.document[0]?.actions).toEqual([]);
  });

  it("does not mutate its source input and returns frozen snapshots", () => {
    const source = {
      session_attach: { session: { session_id: "s1" }, events: [{ sequence: 1, kind: "model_text", payload: { text: "original" } }] },
    };
    const view = buildOperatorViewModel(input(source));
    source.session_attach.events[0]!.payload.text = "changed after projection";

    expect(view.document[0]?.summary).toBe("original");
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.document)).toBe(true);
    expect(Object.isFrozen(view.document[0]!)).toBe(true);
    expect(Object.isFrozen(view.document[0]!.correlation)).toBe(true);
  });
});
