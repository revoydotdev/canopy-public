/**
 * A ProductSurfaceSnapshot-shaped fixture carrying every field the retired
 * Dashboard and Projects screens read, so their absorbed facts can be asserted
 * against real numbers rather than an empty projection.
 */
export const absorbedSurfaceFixture = {
  captured_at: "2026-08-29T00:00:00Z",
  campaigns: { total: 7, items: [
    { id: "c1", halted: false, root_node_state: "expanding", verified_nodes: 3, total_nodes: 9 },
    { id: "c2", halted: true, terminal_outcome: "verified", root_node_state: "verified", verified_nodes: 2 },
    { id: "c3", halted: false, root_node_state: "awaiting_review", verified_nodes: 1 },
  ] },
  approvals: { records: [{ status: "pending" }, { status: "pending" }, { status: "granted" }] },
  jobs: { jobs: [{ status: "running" }, { status: "completed" }, { status: "queued" }] },
  sessions: { sessions: [{ id: "s1" }] },
  backlog: { items: [{ id: "b1", title: "Close the gap register" }, { id: "b2" }] },
  drafts: { items: [{ campaign_id: "c1", task: "do the thing" }] },
  agents: { definitions: [{ id: "a" }, { id: "b" }] },
  extensions: { commands: 4, skills: 12 },
  governance: {}, project: {}, readiness: {}, connector: {},
};
