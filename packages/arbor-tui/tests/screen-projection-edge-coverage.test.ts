import { describe, expect, it } from "vitest";
import { agentsScreen } from "../src/screens/agents.js";
import { auditScreen } from "../src/screens/audit.js";
import { compactionScreen } from "../src/screens/compaction.js";
import { harnessReadinessScreen } from "../src/screens/harness-readiness.js";
import { jobsScreen } from "../src/screens/jobs.js";

const context = { width: 100, height: 20 } as const;

describe("screen projection edge contracts", () => {
  it("keeps agent definition/live precedence and malformed fields visible", () => {
    const definitions = agentsScreen.project({ definitions: [{ name: "Seed", tier: "worker", description: "isolated" }, { name: 42 }] }, context);
    expect(definitions).toMatchObject({ variant: "definitions", caption: "Agent definitions (2)" });
    expect(definitions.rows[1]).toMatchObject({ name: "?", tier: "?", description: "—" });
    expect(definitions.row_ids).toEqual([{ id: "Seed" }, null]);

    const live = agentsScreen.project({ definitions: [], live: [{ agent: "Seed", task_id: "task-1", state: "running", owner_scope_id: "campaign" }, { agent: 42 }] }, context);
    expect(live).toMatchObject({ variant: "live", caption: "Live agent instances (2) · canonical agent.list" });
    expect(live.rows[1]).toMatchObject({ agent: "?", task_id: "?", state: "state unavailable", owner: "?" });
    expect(live.row_ids).toEqual([{ id: "task-1" }, null]);
    expect(agentsScreen.project({ definitions: [] }, context).caption).toBe("no agent definitions");
    expect(agentsScreen.project(null, context).caption).toContain("Agent registry not loaded");
    expect(agentsScreen.project({ definitions: "wrong" }, context).caption).toContain("unrecognised");
  });

  it("renders every job lifecycle icon, paused truth, selection, and unknown fields", () => {
    const states = ["queued", "started", "retrying", "cancel_requested", "cancelled", "failed", "completed", "timed_out", "novel"];
    const projection = jobsScreen.project({
      queue_paused: true,
      jobs: [
        ...states.map((state, index) => ({ id: `job-${index}`, kind: "task", state, owner_scope_id: "owner", progress: index / 10 })),
        { id: 42, kind: 42, state: 42, owner_scope_id: 42 },
      ],
    }, context);
    expect(projection.caption).toContain("QUEUE PAUSED");
    expect(projection.rows.map((row) => row.state)).toEqual(expect.arrayContaining(["○ queued", "▶ started", "↻ retrying", "◼ cancel requested", "⊘ cancelled", "✗ failed", "✓ completed", "⏱ timed out", "? novel", "? state unavailable"]));
    expect(projection.rows.at(-1)).toMatchObject({ id: "?", kind: "?", owner: "?", progress: "—" });
    expect(projection.row_ids?.at(-1)).toBeNull();
    expect(jobsScreen.render({ projection, ...context, selected_id: "job-0" }).join("\n")).toContain("› job-0");
    expect(jobsScreen.project({ jobs: [] }, context).caption).toBe("no jobs · canonical job.list");
  });

  it("projects setup readiness without secrets and bounds missing requirements", () => {
    const projection = harnessReadinessScreen.project({
      execution: { kind: "native", reason: "policy" },
      adapter: {}, credential: { present: false }, model_revision: {}, pricing: {}, budget: {},
      missing_requirements: Array.from({ length: 22 }, (_, index) => index === 0 ? {} : { code: `missing-${index}`, action: `fix-${index}` }),
    }, context);
    expect(projection.rows).toHaveLength(26);
    expect(projection.rows[0]).toMatchObject({ status: "native / policy" });
    expect(projection.rows[1]).toMatchObject({ status: "not selected (?)" });
    expect(projection.rows[2]).toMatchObject({ status: "absent", action: expect.stringContaining("ARBOR_NATIVE_API_KEY") });
    expect(projection.rows[6]).toMatchObject({ concern: "missing requirement", action: "unreported" });

    const present = harnessReadinessScreen.project({
      execution: { kind: "native", selected_by: "profile" }, adapter: { adapter_id: "a", availability: "ready" },
      credential: { present: true }, model_revision: { readiness: "ready" }, pricing: { readiness: "ready" }, budget: { readiness: "ready" }, missing_requirements: [],
    }, context);
    expect(present.rows[2]).toMatchObject({ status: "present", action: "" });
    const broken = { ...present, columns: undefined } as never;
    expect(harnessReadinessScreen.render({ projection: broken, ...context })).toEqual(["(render error)"]);
  });

  it("makes every compaction recovery state explicit", () => {
    const projection = compactionScreen.project({ records: [
      { id: "c1", node_id: "n1", lifecycle: { status: "completed", strategy: "summary", pre_evidence_id: "e1" } },
      { id: "c2", lifecycle: { status: "completed" } },
      { id: "c3", lifecycle: { status: "interrupted", reason: "operator stop" } },
      { lifecycle: null },
    ] }, context);
    expect(projection.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ rollback: "restore anchor e1" }),
      expect.objectContaining({ rollback: "pre-fold anchor unavailable" }),
      expect.objectContaining({ rollback: "operator stop" }),
      expect.objectContaining({ node: "?", status: "?", strategy: "?", rollback: "interrupted before fold completed" }),
    ]));
    expect(projection.row_ids).toEqual([{ id: "c1" }, { id: "c2" }, { id: "c3" }, null]);
    // EC-012: empty captions name their subject and what creates a record.
    expect(compactionScreen.project({ records: [] }, context).caption).toContain("No compaction records yet");
    const broken = { ...projection, columns: undefined } as never;
    expect(compactionScreen.render({ projection: broken, ...context })).toEqual(["(render error)"]);
  });

  it("describes every durable audit record kind and exposes unknown kinds", () => {
    const base = { campaign_id: "campaign" };
    const records = [
      { ...base, id: "trace", action_description: "expand", node_state_before: "pending", node_state_after: "verified", score_before: 1, score_after: 2 },
      { ...base, id: "gate", kind: "gate_checkpoint", checkpoint: { transition: "admit", gate: { gate: "evidence", result: "bypass", bypass_evidence_deficit: "missing proof" } } },
      { ...base, id: "recovery", kind: "recovery_decision", decision: { decision: "retry", actor: "Crown", outcome: "accepted" } },
      { ...base, id: "interrupt", kind: "interruption", interruption: { scope: "node", phase: "run", reason: "operator" } },
      { ...base, id: "local", kind: "node_communication", communication: { kind: "message", author_node_id: "a", recipient_node_id: "b" } },
      { ...base, id: "remote", kind: "node_communication", communication: { kind: "message", author_node_id: "a", recipient_node_id: "b", remote_attribution: { integrity: "verified", session_id: "s", key_id: "k", certificate_id: "c" } } },
      { ...base, id: "fact", kind: "memory_fact", fact: { type: "failure", content: "timeout" } },
      { ...base, id: "telemetry", kind: "telemetry_observation", observation: { type: "latency", phase: "render", outcome: "ok" } },
      { ...base, id: "phase", kind: "phase_message", message: { phase: "review", content: "ready" } },
      { ...base, id: "compact", kind: "compaction_lifecycle", lifecycle: { trigger: "budget", strategy: "summary", status: "completed" } },
      { ...base, id: "question", kind: "request_user_input", status: "awaiting", question: { question: "Proceed?" } },
      { ...base, id: "answer", kind: "user_input_answer", answer: { answered_by: "operator", custom_text: "yes", option_id: "fallback" } },
      { ...base, id: "answer-option", kind: "user_input_answer", answer: { answered_by: "operator", option_id: "yes" } },
      { ...base, id: "unknown", kind: "future_kind" },
      { ...base, id: 42, kind: 42, node_id: 42 },
    ];
    const projection = auditScreen.project(records, context);
    const details = projection.rows.map((row) => String(row.detail)).join("\n");
    expect(details).toContain("expand: pending -> verified (score 1->2)");
    expect(details).toContain("bypass: missing proof");
    expect(details).toContain("remote verified session=s key=k cert=c");
    expect(details).toContain("answered by operator: yes");
    expect(details).toContain("unhandled record kind: future_kind");
    expect(projection.rows.at(-1)).toMatchObject({ id: "?", kind: "trace", node_id: "-" });
    expect(projection.row_ids?.at(-1)).toBeNull();
    expect(auditScreen.project([], context).caption).toBe("no evidence records");
    expect(auditScreen.project([{ id: "only" }], context).caption).toContain("unavailable");
    const broken = { ...projection, columns: undefined } as never;
    expect(auditScreen.render({ projection: broken, ...context })).toEqual(["(render error)"]);
  });
});
