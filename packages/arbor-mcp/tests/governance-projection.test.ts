import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "@arbor/audit";
import {
  buildGovernanceSnapshot,
  formatGovernanceSnapshot,
  deriveGovernanceEvents,
  witnessGovernanceEvents,
  getGovernanceEvents,
  projectGovernanceGraph,
  type GovernanceEvent,
  type GovernanceSnapshot,
} from "../src/governance-projection.js";

// packages/arbor-mcp/tests/governance-projection.test.ts -> repo root is three
// directories up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AT = "2026-08-04T00:00:00.000Z";

/**
 * Counts here are DERIVED from the snapshot's own `repository_counts.adr_total`
 * rather than written as literals. Every literal in this file broke when
 * ADR-030 was added — the fourth time this session that a corpus-pinned number
 * turned a routine addition into a test failure. A record count is a fact about
 * the repository, not a property of the projection; what the projection owes us
 * is internal consistency with it.
 */
describe("buildGovernanceSnapshot — the real decisions/ corpus", () => {
  it("reports the real record count and legacy-classification breakdown", () => {
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const total = result.value.repository_counts.adr_total;
    expect(result.value.records).toHaveLength(total);
    expect(result.value.legacy_classification).toEqual({
      total,
      parsed: result.value.legacy_classification.parsed,
      parsed_with_warnings: result.value.legacy_classification.parsed_with_warnings,
      unparseable: 0,
    });
    expect(result.value.legacy_classification.parsed + result.value.legacy_classification.parsed_with_warnings).toBe(total);
    // Every parsed/parsed_with_warnings record must resolve real fields — no
    // null standing in where a value should be, no fabricated placeholder.
    for (const record of result.value.records) {
      expect(record.classification).not.toBe("unparseable");
      expect(record.decision).not.toBeNull();
      expect(record.content_hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("reports a decision-status distribution that accounts for every record", () => {
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Only the shape is asserted, plus the accounting identity below. Pinning
    // `accepted: 29` made authoring a new Proposed record a failure, which
    // punished exactly the behaviour the lifecycle asks for.
    // `rejected` and `superseded` were pinned to 0 for the same reason
    // `accepted: 29` once was, and it went stale the same way: the corpus
    // rejected three records on 2026-08-18 (ADR-039/040/041, the remote
    // surface, closed by removal), and a test asserting that never happens
    // punishes a legal lifecycle transition. Only the shape and the
    // accounting identity below are asserted.
    const distribution = result.value.decision_status_distribution;
    for (const [status, count] of Object.entries(distribution)) {
      expect(Number.isInteger(count), `${status} must be an integer count`).toBe(true);
      expect(count, `${status} must not be negative`).toBeGreaterThanOrEqual(0);
    }
    expect(distribution.accepted).toBeGreaterThan(0);
    // The buckets must account for every record — a projection that silently
    // dropped a status would otherwise satisfy the assertions above.
    const total = Object.values(distribution).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(result.value.repository_counts.adr_total);
  });

  it("reports obligation coverage consistently with the records it derived it from", () => {
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // This used to assert a literal zero for every field — the honest state
    // when written, but it made the first genuinely witnessed record a test
    // failure. The rollup must instead agree with the per-record data it
    // summarises, whatever that data currently says.
    const coverage = result.value.obligation_coverage;
    const records = result.value.records;

    expect(coverage.total_records).toBe(records.length);
    // `obligation_count` is nullable: null means the record could not be
    // parsed, which is a different fact from "declares zero". Treated
    // separately rather than coerced, since collapsing them is the exact
    // absence-as-zero mistake this repository treats as a defect.
    expect(coverage.total_obligations).toBe(
      records.reduce((sum, record) => sum + (record.obligation_count ?? 0), 0),
    );
    expect(coverage.records_with_obligations_section).toBe(
      records.filter((record) => (record.obligation_count ?? 0) > 0).length,
    );
    expect(coverage.records_fully_covered).toBeLessThanOrEqual(coverage.records_with_obligations_section);

    for (const record of records) {
      if (record.classification === "unparseable") continue;
      if ((record.obligation_count ?? 0) === 0) expect(record.implementation).toBe("none");
    }
  });

  it("emits exactly one POL-04 finding per accepted, zero-obligation record — derived, not pinned", () => {
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pol04 = result.value.policy_findings.filter((f) => f.rule_id === "POL-04");
    // Derived from the corpus: the count legitimately falls as records gain
    // obligations, and a literal here would break on every improvement.
    // POL-04 fires on `accepted` AND zero-obligation. Filtering on
    // obligation_count alone silently assumed every zero-obligation record was
    // accepted -- true only by coincidence, and false the moment a Proposed
    // record is added whose mechanism is not built yet. `decision` is on the
    // summary already, so this reads the same fact the rule reads.
    const zeroObligation = result.value.records.filter((r) => (r.obligation_count ?? 0) === 0 && r.decision === "accepted");
    expect(pol04).toHaveLength(zeroObligation.length);
    expect(pol04.every((f) => f.is_legacy_debt)).toBe(true);

    const subjectIds = new Set(pol04.map((f) => (f.subject as { record_id: string }).record_id));
    for (const record of zeroObligation) expect(subjectIds.has(record.id)).toBe(true);
    for (const record of result.value.records) {
      if ((record.obligation_count ?? 0) > 0 || record.decision !== "accepted") expect(subjectIds.has(record.id)).toBe(false);
    }
  });

  it("reports real, non-fabricated derived repository counts", () => {
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.repository_counts.adr_total).toBeGreaterThan(0);
    expect(result.value.repository_counts.packages).toBeGreaterThan(0);
    expect(result.value.repository_counts.src_files).toBeGreaterThan(0);
  });

  it("flags the real, currently-drifted SUR-05 documents named in @arbor/governance's own test suite", () => {
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sur05 = result.value.policy_findings.filter((f) => f.rule_id === "SUR-05");
    // The document set is now derived rather than hand-picked, and every
    // drifted claim it surfaced on 2026-08-06 was either corrected or
    // explicitly marked historical. Zero is therefore the correct, defended
    // state — not an absence of checking. The companion assertion below
    // proves the check still fires, so this cannot pass vacuously.
    expect(sur05).toEqual([]);
  });

  it("reports the exempted historical lines, so 'no drift' is distinguishable from 'not checked'", () => {
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exemptions = result.value.count_claim_exemptions;
    expect(exemptions.length).toBeGreaterThan(0);
    // The gap register's audit-condition line is the canonical example: a
    // dated measurement inside an otherwise-live document.
    expect(exemptions.some((e) => e.document === "ROADMAP.md")).toBe(true);
    for (const e of exemptions) {
      expect(e.line).toBeGreaterThan(0);
      expect(e.text.length).toBeGreaterThan(0);
    }
  });

  it("renders the exemptions in the human-readable report", () => {
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rendered = formatGovernanceSnapshot(result.value);
    expect(rendered).toContain("Count-claim exemptions");
    expect(rendered).toContain("ROADMAP.md:");
  });

  it("still reports SUR-05 drift when a checked document disagrees with the counts", () => {
    // Guards the assertion above against the G-24 shape: zero findings must
    // mean "the documents agree", never "nothing was checked". The fixture is
    // deliberately drifted, so a working checker cannot return [] for it.
    const result = buildGovernanceSnapshot({
      repo_root: REPO_ROOT,
      at: AT,
      count_drift_documents: [
        "packages/arbor-governance/tests/counts/fixtures/drifted-claims.md",
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sur05 = result.value.policy_findings.filter((f) => f.rule_id === "SUR-05");
    expect(sur05.length).toBeGreaterThan(0);
  });

  it("determinism: same input => byte-identical snapshot", () => {
    const first = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    const second = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
  });

  it("formatGovernanceSnapshot renders a non-empty human-readable summary containing the real record count", () => {
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = formatGovernanceSnapshot(result.value);
    expect(text).toContain(`${result.value.repository_counts.adr_total} total`);
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("buildGovernanceSnapshot — malformed/adverse input never throws", () => {
  it("returns a typed error for a repo root with no decisions/ directory, instead of throwing", () => {
    expect(() => buildGovernanceSnapshot({ repo_root: "/definitely/does/not/exist/anywhere", at: AT })).not.toThrow();
    const result = buildGovernanceSnapshot({ repo_root: "/definitely/does/not/exist/anywhere", at: AT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unavailable");
  });

  it("returns a typed validation error, not a throw, when the corpus exceeds max_records", () => {
    expect(() => buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, max_records: 1 })).not.toThrow();
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, max_records: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
  });
});

describe("ADR-027 Decision point 2 — buildGovernanceSnapshot stays pure when no ledger is supplied", () => {
  it("governance_events_witnessed and graph are null, and the snapshot is unchanged from before this feature existed", () => {
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.governance_events_witnessed).toBeNull();
    expect(result.value.graph).toBeNull();
    // E-8: waiver_outcome_totals is null under the exact same no-ledger
    // condition — the same purity boundary applies to it as to
    // governance_events_witnessed/graph.
    expect(result.value.waiver_outcome_totals).toBeNull();
  });
});

describe("E-8 — waiver_outcome_totals (ledger-supplied)", () => {
  it("is a zeroed, non-null total when a ledger is supplied but holds no waiver outcomes", () => {
    const ledger = new EvidenceLedger();
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, ledger });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.waiver_outcome_totals).toEqual({ total: 0, adopted: 0, unadjudicated: 0 });
  });

  it("counts waiver outcomes across every campaign the ledger holds, folded with their amendments", () => {
    const ledger = new EvidenceLedger();
    // camp-a: one waiver, later marked adopted.
    ledger.recordWaiverOutcome({
      campaign_id: "camp-a", node_id: "n1", task_category: "test",
      waived_by: "arbiter", waived_reason: "low-risk", waived_at: AT, idempotency_key: "n1:waiver",
    });
    const waiverA = ledger.getWaiverOutcomes("camp-a")[0];
    ledger.recordWaiverOutcomeAmendment({
      campaign_id: "camp-a", node_id: "n1", waiver_record_id: waiverA.id, kind: "adopted", value: true,
      recorded_by: "arbor-adopt", reason: "applied", idempotency_key: `${waiverA.id}:adopted`,
    });
    // camp-b: one waiver, never adopted or adjudicated.
    ledger.recordWaiverOutcome({
      campaign_id: "camp-b", node_id: "n2", task_category: "docs",
      waived_by: "arbiter", waived_reason: "trivial", waived_at: AT, idempotency_key: "n2:waiver",
    });

    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, ledger });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.waiver_outcome_totals).toEqual({ total: 2, adopted: 1, unadjudicated: 2 });
    expect(formatGovernanceSnapshot(result.value)).toContain("Waived outcomes: 1 adopted, 2 unadjudicated (2 total)");
  });
});

describe("ADR-027 Decision point 2 — buildGovernanceSnapshot(ledger) witnesses real governance events", () => {
  it("witnesses a real, non-zero number of events into the ledger's reserved \"governance\" campaign", () => {
    const ledger = new EvidenceLedger();
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, ledger });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.governance_events_witnessed).toBeGreaterThan(0);
    const campaign = ledger.getCampaign("governance");
    expect(campaign.length).toBe(result.value.governance_events_witnessed);
    // Every real decision status observed becomes its own event.
    const recordStatusEvents = campaign.filter((r) => r.action_category === "record_status_observed");
    expect(recordStatusEvents.length).toBe(result.value.records.filter((r) => r.decision !== null).length);
    // Every real policy finding (POL-04 etc.) becomes its own event.
    const findingEvents = campaign.filter((r) => r.action_category === "policy_finding_observed");
    expect(findingEvents.length).toBe(result.value.policy_findings.length);
  });

  it("is idempotent: a second call against the SAME ledger witnesses zero new events", () => {
    const ledger = new EvidenceLedger();
    const first = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, ledger });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const countAfterFirst = ledger.getCampaign("governance").length;

    const second = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, ledger });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.governance_events_witnessed).toBe(0);
    expect(ledger.getCampaign("governance").length).toBe(countAfterFirst);
  });

  it("getGovernanceEvents reads back typed events, round-tripping through the ledger", () => {
    const ledger = new EvidenceLedger();
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, ledger });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events = getGovernanceEvents(ledger);
    expect(events.length).toBe(result.value.governance_events_witnessed);
    // Always present: every record yields a status observation, and the
    // corpus's proof comments yield citations.
    expect(events.some((e) => e.kind === "record_status_observed")).toBe(true);
    expect(events.some((e) => e.kind === "citation_observed")).toBe(true);
    // Conditional, and derived rather than assumed: this used to assert a
    // policy_finding_observed event unconditionally, which only held while the
    // corpus still had findings. With POL-04, M-B and SUR-05 all clean, zero
    // findings is the success state — so the assertion follows the snapshot
    // instead of contradicting it.
    expect(events.some((e) => e.kind === "policy_finding_observed"))
      .toBe(result.value.policy_findings.length > 0);
  });

  it("does not corrupt or shrink the governance ledger's hash chain", () => {
    const ledger = new EvidenceLedger();
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, ledger });
    expect(result.ok).toBe(true);
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });
});

describe("ADR-027 Decision point 2 — deriveGovernanceEvents (pure, synthetic input)", () => {
  const baseRecord = {
    id: "revoy2:ADR-999", record_number: 999, title: "t", source_path: "decisions/ADR-999-t.md",
    classification: "parsed" as const, decision: "accepted" as const,
    content_hash: "a".repeat(64), obligation_count: 0, implementation: "none" as const,
    verification: "unverified" as const, parse_warnings: [], unparseable_reasons: [],
  };

  it("derives a record_status_observed and obligation_coverage_observed event per record with a resolved decision", () => {
    const snapshot: Pick<GovernanceSnapshot, "records" | "policy_findings"> = {
      records: [baseRecord], policy_findings: [],
    };
    const events = deriveGovernanceEvents(snapshot, []);
    expect(events.filter((e) => e.kind === "record_status_observed")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "obligation_coverage_observed")).toHaveLength(1);
  });

  it("skips a record with no resolved decision (unparseable) — nothing fabricated for it", () => {
    const snapshot: Pick<GovernanceSnapshot, "records" | "policy_findings"> = {
      records: [{ ...baseRecord, decision: null, content_hash: null, obligation_count: null, implementation: null, verification: null }],
      policy_findings: [],
    };
    expect(deriveGovernanceEvents(snapshot, [])).toHaveLength(0);
  });

  it("derives one policy_finding_observed event per finding, regardless of rule id", () => {
    const snapshot: Pick<GovernanceSnapshot, "records" | "policy_findings"> = {
      records: [],
      policy_findings: [
        { rule_id: "POL-04", severity: "warning", subject: { record_id: "revoy2:ADR-999" }, detail: "d", remediation: "r", evidence: [], waiver_eligible: true, is_legacy_debt: true },
        { rule_id: "SUR-05", severity: "warning", subject: { kind: "doc", path: "x.md", symbol_id: null, content_hash: "h", schema_version: 1 }, detail: "d2", remediation: "r2", evidence: [], waiver_eligible: false, is_legacy_debt: false },
      ],
    };
    const events = deriveGovernanceEvents(snapshot, []);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === "policy_finding_observed")).toBe(true);
  });

  it("derives a citation_observed event only for resolved facts, never for method: \"none\"", () => {
    const snapshot: Pick<GovernanceSnapshot, "records" | "policy_findings"> = { records: [], policy_findings: [] };
    const events = deriveGovernanceEvents(snapshot, [
      { source_record_id: "revoy2:ADR-001", citation_token: "ADR-002", method: "derived", confidence: "medium", target: "revoy2:ADR-002" },
      { source_record_id: "revoy2:ADR-001", citation_token: "ADR-999", method: "none", confidence: null, target: null },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "citation_observed", source_record_id: "revoy2:ADR-001", target_record_id: "revoy2:ADR-002" });
  });

  it("is deterministic: identical input derives byte-identical events", () => {
    const snapshot: Pick<GovernanceSnapshot, "records" | "policy_findings"> = { records: [baseRecord], policy_findings: [] };
    const a = deriveGovernanceEvents(snapshot, []);
    const b = deriveGovernanceEvents(snapshot, []);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("ADR-027 Decision point 2 — witnessGovernanceEvents idempotency (pure unit, synthetic events)", () => {
  function findingEvent(detail: string): GovernanceEvent {
    return {
      kind: "policy_finding_observed",
      finding: { rule_id: "POL-04", severity: "warning", subject: { record_id: "revoy2:ADR-999" }, detail, remediation: "r", evidence: [], waiver_eligible: true, is_legacy_debt: true },
    };
  }

  it("re-witnessing byte-identical events is a no-op — no duplicate records", () => {
    const ledger = new EvidenceLedger();
    const events = [findingEvent("same")];
    const first = witnessGovernanceEvents(ledger, events, { at: AT });
    const second = witnessGovernanceEvents(ledger, events, { at: "2026-08-05T00:00:00.000Z" });
    expect(first.recorded).toBe(1);
    expect(second.recorded).toBe(0); // dedup-aware: nothing NEW was appended
    expect(second.ids).toEqual(first.ids); // the id is still returned for every input event, new or not
    expect(ledger.getCampaign("governance")).toHaveLength(1);
  });

  it("witnessing a genuinely different event never collides with an existing one", () => {
    const ledger = new EvidenceLedger();
    witnessGovernanceEvents(ledger, [findingEvent("first")], { at: AT });
    witnessGovernanceEvents(ledger, [findingEvent("second")], { at: AT });
    expect(ledger.getCampaign("governance")).toHaveLength(2);
  });
});

describe("ADR-027 Decision point 3 — projectGovernanceGraph (integrity-gated, deterministic, cursor-paginated)", () => {
  it("projects real DEPENDS_ON edges from the real corpus's witnessed citation_observed events", () => {
    const ledger = new EvidenceLedger();
    const snapshot = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, ledger });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;

    expect(snapshot.value.graph).not.toBeNull();
    const graph = snapshot.value.graph!;
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const edge of graph.edges) {
      expect(edge.type).toBe("DEPENDS_ON");
      expect(edge.plane).toBe("derived");
      expect(edge.first_seen_event).toMatch(/^trace_/);
    }
  });

  it("refuses to project a ledger whose hash chain does not verify", () => {
    const ledger = new EvidenceLedger();
    ledger.recordGovernanceEvent({
      node_id: "revoy2:ADR-001", timestamp: AT, idempotency_key: "k1",
      action_description: "d", action_category: "citation_observed", specialist_agent: "test", critic_agent: null,
      node_state_before: "pending", node_state_after: "verified",
      provenance: { tag: "generated", generator: "test", input_hash: "h" },
      specialist_output: JSON.stringify({ kind: "citation_observed", source_record_id: "revoy2:ADR-001", target_record_id: "revoy2:ADR-002", citation_token: "ADR-002", confidence: "medium" }),
      critic_verdict_approved: null, critic_root_cause: null, score_before: 0, score_after: 0, gates: [], kb_entries_written: [],
    });
    // Tamper with the persisted record directly, bypassing the ledger API.
    const records = ledger.getRecords();
    (records[0] as unknown as { content_hash: string }).content_hash = "tampered";
    const tampered = new EvidenceLedger();
    tampered.fromJSONL(records.map((r) => JSON.stringify(r)).join("\n"));

    expect(() => projectGovernanceGraph(tampered, {})).toThrow();
  });

  it("is deterministic and sorted (source, target, first_seen_event) via code-unit comparison", () => {
    const ledger = new EvidenceLedger();
    buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, ledger });
    const first = projectGovernanceGraph(ledger, {});
    const second = projectGovernanceGraph(ledger, {});
    expect(JSON.stringify(second.edges)).toBe(JSON.stringify(first.edges));
    const sourceKeys = first.edges.map((e) => `${e.source}|${e.target}|${e.first_seen_event}`);
    expect(sourceKeys).toEqual([...sourceKeys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("paginates via a snapshot-bound cursor, never mixing pages across a changed snapshot", () => {
    const ledger = new EvidenceLedger();
    buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, ledger });
    const full = projectGovernanceGraph(ledger, {});
    expect(full.edges.length).toBeGreaterThan(1);

    const page1 = projectGovernanceGraph(ledger, { limit: 1 });
    expect(page1.edges).toHaveLength(1);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = projectGovernanceGraph(ledger, { limit: 1, cursor: page1.next_cursor! });
    expect(page2.edges).toHaveLength(1);
    expect(page2.edges[0]).not.toEqual(page1.edges[0]);

    expect(() => projectGovernanceGraph(ledger, { cursor: "not-a-real-snapshot:0" })).toThrow();
  });

  it("is never authoritative: losing the ledger's governance campaign is a non-event, it rebuilds from an empty stream", () => {
    const empty = new EvidenceLedger();
    const graph = projectGovernanceGraph(empty, {});
    expect(graph.edges).toEqual([]);
    expect(graph.source_event_count).toBe(0);
  });
});

describe("ADR-134 — a witnessed governance event must not overstate its own verification", () => {
  it("witnesses generated-provenance events as claimed, never verified (arbor-core's own invariant: generated provenance cannot retire a node as verified)", () => {
    const ledger = new EvidenceLedger();
    const snapshot = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT, ledger });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;

    const records = ledger.getCampaign("governance");
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.provenance).toEqual(
        expect.objectContaining({ tag: "generated" }),
      );
      expect(record.node_state_after).not.toBe("verified");
    }
  });
});

describe("formatGovernanceSnapshot — repository counts must not print an UNMEASURED field as a real zero", () => {
  it("renders 'UNMEASURED' for a repository-count field derive.ts could not read, never a bare 0", () => {
    const result = buildGovernanceSnapshot({ repo_root: REPO_ROOT, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snapshotWithUnmeasuredCatalog: GovernanceSnapshot = {
      ...result.value,
      repository_counts: {
        ...result.value.repository_counts,
        unmeasured: ["catalog_kinds"],
        catalog_kinds: 0,
      },
    };

    const rendered = formatGovernanceSnapshot(snapshotWithUnmeasuredCatalog);
    expect(rendered).not.toContain("0 catalog kinds");
    expect(rendered).toMatch(/catalog kinds.*UNMEASURED|UNMEASURED.*catalog kinds/i);
  });
});
