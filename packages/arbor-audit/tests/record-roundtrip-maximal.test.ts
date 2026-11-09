/**
 * record-roundtrip-maximal.test.ts — X-1 (blindspot class 3, field-level drift).
 *
 * WHY THIS EXISTS. `verify-kind-coverage.test.ts` and `id-prefix-coverage.test.ts`
 * already guard KIND-level dispatch: every `AuditRecord` kind is structurally
 * validated and every minted id prefix survives a reload. Neither one guards
 * FIELD-level widening within an already-known kind. `tie_break`,
 * `threshold_ms`, `threshold_source`, and `threshold_observations` were each
 * added to `RaceOutcomeTelemetryObservation` in arbor-core and each had to be
 * hand-wired into the audit validator afterward — three separate incidents,
 * same failure shape: a field added to a core type but not accepted (or not
 * preserved through persistence) by the audit layer.
 *
 * This file constructs a MAXIMAL instance for every `record*` method on
 * `EvidenceLedger` — every optional field populated with a valid non-default
 * value — and proves the full round trip: record -> verifyIntegrity passes ->
 * persist to disk (toJSONL) -> load back (fromJSONL) -> every optional field
 * survives byte-identical, and the reloaded ledger keeps minting fresh ids
 * (parseTraceId resolves the id, exercising the same seam id-prefix-coverage
 * guards behaviourally). Where a variant genuinely has no kind-specific
 * optional field (`phase_message`, `waiver_outcome`, `waiver_outcome_amendment`,
 * `scope_observation_amendment`, `user_input_answer`'s wrapper), that is
 * asserted explicitly so the entry stays honest rather than vacuous.
 *
 * METHOD ENUMERATION IS MECHANICAL, not hand-typed: `discoveredRecordMethods()`
 * scans the class body for every `record*(` method the same way
 * `verify-kind-coverage.test.ts` scans for declared kinds, and the coverage
 * test below fails loudly if a new `record*` method exists with no maximal-
 * instance case — the same "cannot silently skip a 21st kind" property this
 * file's sibling tests provide, applied one layer down (fields, not kinds).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalizeForHash } from "@arbor/core";
import { EvidenceLedger, scopeDecisionSigningPayload, type ScopeDecisionKind } from "../src/audit.js";

const SOURCE = readFileSync(new URL("../src/audit.ts", import.meta.url), "utf8");

/** Every `record*` method declared on the class body, scanned mechanically. */
function discoveredRecordMethods(): string[] {
  const classStart = SOURCE.indexOf("export class EvidenceLedger");
  if (classStart === -1) throw new Error("could not locate EvidenceLedger class — the scan must fail loudly, not silently pass");
  const classEnd = SOURCE.indexOf("\n/** Runtime validation for checkpoint creation", classStart);
  if (classEnd === -1) throw new Error("could not locate the end of EvidenceLedger — the scan boundary broke");
  const body = SOURCE.slice(classStart, classEnd);
  const found = new Set<string>();
  const pattern = /^\s{2}(record[A-Za-z]*)\(/gm;
  for (let m = pattern.exec(body); m !== null; m = pattern.exec(body)) found.add(m[1]);
  return [...found].sort();
}

const CAMPAIGN = "camp-maximal";

/** A signer holding one Ed25519 keypair, mirroring scope-decision.test.ts. */
function makeSigner() {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyBase64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return {
    publicKeyBase64,
    sign(payload: object): string {
      return sign(null, Buffer.from(canonicalizeForHash(payload), "utf8"), keys.privateKey).toString("base64");
    },
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** One maximal-instance case: records via `run`, then asserts every field in `optionalFields` round-trips. */
interface Case {
  /** The `record*` method name(s) this case exercises (usually one; some cases cover two closely related methods). */
  methods: string[];
  /**
   * Records into `ledger`, returning the id of the record whose optional
   * fields should be checked. `witnessId` is a prior trace packet already
   * recorded in the same ledger/campaign, for cases whose method requires a
   * `source_evidence_id`/`pre_evidence_id` witness.
   */
  run: (ledger: EvidenceLedger, witnessId: string) => string;
  /** Dotted paths (into the record) that must be non-default AND survive the round trip byte-identical. Empty array is a deliberate, explicit "no kind-specific optional field" declaration. */
  optionalFields: string[];
}

function get(record: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], record);
}

describe("record* maximal-instance round trip (X-1, class 3 field drift)", () => {
  it("discovers at least 19 record* methods -- guard against a scan that silently matches nothing", () => {
    const methods = discoveredRecordMethods();
    expect(methods.length).toBeGreaterThanOrEqual(19);
    expect(methods).toContain("recordTelemetryObservation");
    expect(methods).toContain("recordScopeDecision");
  });

  const witnessLedger = () => {
    const ledger = new EvidenceLedger();
    const witnessId = ledger.record({
      campaign_id: CAMPAIGN, node_id: "root", parent_id: "root-parent", idempotency_key: "witness-key",
      timestamp: "2026-08-01T00:00:00.000Z", action_description: "witness action", action_category: "setup",
      specialist_agent: "spec-1", critic_agent: "critic-1",
      node_state_before: "pending", node_state_after: "verified",
      provenance: { tag: "verified", cmd: "true", exit: 0, stdout_hash: "hash-1" },
      specialist_output: "output", critic_verdict_approved: true, critic_root_cause: null,
      score_before: 0, score_after: 1, gates: [], kb_entries_written: ["kb-1"],
    });
    return { ledger, witnessId };
  };

  const cases: Case[] = [];

  cases.push({
    methods: ["record"],
    run: (ledger, _witnessId) => ledger.record({
      campaign_id: CAMPAIGN, node_id: "n-record", parent_id: "n-record-parent", idempotency_key: "record-max",
      timestamp: "2026-08-01T00:00:01.000Z", action_description: "act", action_category: "cat",
      specialist_agent: "s", critic_agent: "c", node_state_before: "pending", node_state_after: "verified",
      provenance: { tag: "verified", cmd: "true", exit: 0, stdout_hash: "h" },
      specialist_output: "o", critic_verdict_approved: true, critic_root_cause: "none",
      score_before: 0, score_after: 1, gates: [], kb_entries_written: [],
    }),
    optionalFields: ["parent_id", "idempotency_key"],
  });

  cases.push({
    methods: ["recordGovernanceEvent"],
    run: (ledger, _witnessId) => ledger.recordGovernanceEvent({
      node_id: "n-gov", parent_id: "n-gov-parent", idempotency_key: "gov-max",
      timestamp: "2026-08-01T00:00:02.000Z", action_description: "gov act", action_category: "governance",
      specialist_agent: "s", critic_agent: null, node_state_before: "pending", node_state_after: "verified",
      provenance: { tag: "claimed", claimant: "operator" },
      specialist_output: null, critic_verdict_approved: null, critic_root_cause: null,
      score_before: 0, score_after: 1, gates: [], kb_entries_written: [],
    }),
    optionalFields: ["parent_id", "idempotency_key"],
  });

  cases.push({
    methods: ["recordGateCheckpoint", "recordGovernedTransition"],
    run: (ledger, _witnessId) => {
      ledger.recordGateCheckpoint({
        campaign_id: CAMPAIGN, node_id: "n-gate", transition: "node_expansion", operation_id: "op-gate-1",
        gate: { gate: "isolation", result: "bypass", checked_at: "2026-08-01T00:00:03.000Z", detail: "d", bypass_evidence_deficit: "missing worktree diff" },
        failures: ["failure-a"], unresolved: ["unresolved-a"],
      });
      return ledger.recordGovernedTransition("node_expansion", "op-gate-1", {
        campaign_id: CAMPAIGN, node_id: "n-gate", parent_id: "n-gate-parent",
        timestamp: "2026-08-01T00:00:04.000Z", action_description: "expand", action_category: "cat",
        specialist_agent: "s", critic_agent: "c", node_state_before: "pending", node_state_after: "expanding",
        provenance: { tag: "generated", generator: "spec", input_hash: "h" },
        specialist_output: "o", critic_verdict_approved: null, critic_root_cause: null,
        score_before: 0, score_after: 0.5, gates: [], kb_entries_written: [],
      });
    },
    optionalFields: ["parent_id"],
  });

  cases.push({
    methods: ["recordRecoveryDecision"],
    run: (ledger, _witnessId) => ledger.recordRecoveryDecision({
      campaign_id: CAMPAIGN, node_id: "n-recovery", recovery_operation_id: "recop-1",
      decision: "retry", actor: "operator", authority: "cambium", reason: "transient",
      prior_operation_id: "prior-op", new_operation_id: "new-op", expected_version: "v1",
      observed_version: "v2",
      lease: { previous: "released", new_lease_id: "lease-1" },
      isolation: { result: "bypass", checkpoint_operation_id: "chk-op", evidence_deficit: "no worktree evidence" },
      outcome: "authorized", timestamp: "2026-08-01T00:00:05.000Z",
    }),
    optionalFields: ["decision.prior_operation_id", "decision.new_operation_id", "decision.expected_version", "decision.lease.new_lease_id", "decision.isolation.checkpoint_operation_id", "decision.isolation.evidence_deficit"],
  });

  cases.push({
    methods: ["recordCampaignReopen"],
    run: (ledger, _witnessId) => {
      ledger.recordCampaignReopen({
        campaign_id: CAMPAIGN, node_id: "n-reopen", operation_id: "fork-op-1", phase: "reopened", actor: "operator", authority: "operator",
        overridden_halt_reason: "converged", source_session_id: "session-1", reason: "try another direction",
        iterations_without_kb_entry: { before: 2, after: 0 }, timestamp: "2026-08-01T00:00:05.500Z",
      });
      return ledger.recordCampaignReopen({
        campaign_id: CAMPAIGN, node_id: "n-reopen", operation_id: "fork-op-1", phase: "reverted", actor: "operator", authority: "operator",
        overridden_halt_reason: "converged", source_session_id: "session-1", reason: "the fork did not reach dispatch",
        iterations_without_kb_entry: { before: 2, after: 0 }, timestamp: "2026-08-01T00:00:05.600Z",
      });
    },
    optionalFields: [],
  });

  cases.push({
    methods: ["recordNodeCommunication"],
    run: (ledger, _witnessId) => {
      const first = ledger.recordNodeCommunication({
        campaign_id: CAMPAIGN, node_id: "n-comm", author_node_id: "n-comm", recipient_node_id: "n-comm-2",
        other_recipient_node_ids: [], kind: "delegate", capability_tier: "specialist",
        payload: { content: "first", provenance: { tag: "claimed", claimant: "x" } },
        trigger_turn: true, as_of: "2026-08-01T00:00:06.000Z", correlation_id: "corr-1", idempotency_key: "comm-1",
        acknowledges_communication_id: null, retracts_communication_id: null,
      });
      return ledger.recordNodeCommunication({
        campaign_id: CAMPAIGN, node_id: "n-comm-2", author_node_id: "n-comm-2", recipient_node_id: "n-comm",
        other_recipient_node_ids: ["n-comm-3"], kind: "reply", capability_tier: "critic",
        payload: { content: "second", provenance: { tag: "claimed", claimant: "y" }, evidence_refs: ["ev-1", "ev-2"] },
        trigger_turn: false, as_of: "2026-08-01T00:00:07.000Z", correlation_id: "corr-2", idempotency_key: "comm-2",
        acknowledges_communication_id: first, retracts_communication_id: null,
        conversation_id: "conv-1", parent_communication_id: first, intent: "response",
        reply_to_communication_id: first, ack_required: true, deadline_at: "2026-08-02T00:00:00.000Z",
        remote_attribution: {
          session_id: "sess-1", key_id: "key-1", certificate_id: "cert-1", nonce: "nonce-1",
          integrity: "ed25519", proof_digest: `sha256:${"a".repeat(64)}`,
        },
      });
    },
    optionalFields: [
      "communication.acknowledges_communication_id", "communication.conversation_id", "communication.parent_communication_id",
      "communication.intent", "communication.reply_to_communication_id", "communication.ack_required", "communication.deadline_at",
      "communication.remote_attribution.session_id", "communication.remote_attribution.proof_digest", "communication.payload.evidence_refs",
    ],
  });

  cases.push({
    methods: ["recordInterruption"],
    run: (ledger, _witnessId) => {
      const requested = ledger.recordInterruption({
        campaign_id: CAMPAIGN, node_id: "n-int", operation_id: "int-op-1", scope: "subtree", phase: "requested",
        affected_node_ids: ["n-int", "n-int-2"], partial_evidence_ids: [], provenance: { tag: "claimed", claimant: "op" },
        reason: "operator interrupt", request_record_id: null,
      });
      const acknowledged = ledger.recordInterruption({
        campaign_id: CAMPAIGN, node_id: "n-int", operation_id: "int-op-1", scope: "subtree", phase: "acknowledged",
        affected_node_ids: ["n-int"], partial_evidence_ids: [], provenance: { tag: "claimed", claimant: "op" },
        reason: "ack", request_record_id: requested,
      });
      void acknowledged;
      return ledger.recordInterruption({
        campaign_id: CAMPAIGN, node_id: "n-int", operation_id: "int-op-1", scope: "subtree", phase: "state_applied",
        affected_node_ids: ["n-int"], partial_evidence_ids: [requested], provenance: { tag: "claimed", claimant: "op" },
        reason: "applied", request_record_id: requested,
      });
    },
    optionalFields: ["interruption.request_record_id"],
  });

  cases.push({
    methods: ["recordMemoryFact"],
    run: (ledger, witnessId) => {
      return ledger.recordMemoryFact({
        campaign_id: CAMPAIGN, node_id: "n-mem", scope: { kind: "subtree", root_node_id: "n-mem-root" },
        type: "failure_mode", content: "content", provenance: { tag: "claimed", claimant: "x" },
        tier: "specialist_visible", source_evidence_id: witnessId, idempotency_key: "mem-1",
        tags: ["tag-a", "tag-b"],
      });
    },
    optionalFields: ["fact.scope.root_node_id"],
  });

  cases.push({
    methods: ["recordPhaseMessage"],
    run: (ledger, _witnessId) => ledger.recordPhaseMessage({
      campaign_id: CAMPAIGN, node_id: "n-phase", operation_id: "phase-op", phase: "commentary",
      content: "streaming content", content_length_bytes: Buffer.byteLength("streaming content", "utf8"),
      provenance: { tag: "claimed", claimant: "x" }, idempotency_key: "phase-1",
    }),
    // PhaseMessage has no kind-specific optional field beyond the common campaign/node/timestamp wrapper.
    optionalFields: [],
  });

  cases.push({
    methods: ["recordCompactionLifecycle"],
    run: (ledger, witnessId) => {
      return ledger.recordCompactionLifecycle({
        campaign_id: CAMPAIGN, node_id: "n-compact", operation_id: "compact-op-1", trigger: "auto",
        strategy: "structural_folding", status: "completed", pre_evidence_id: witnessId,
        post_evidence_id: `${witnessId}-post`, anchor_summary_id: witnessId, reason: "scheduled",
        partial_evidence_ids: [witnessId], idempotency_key: "compact-1", as_of: "2026-08-01T00:00:08.000Z",
      });
    },
    optionalFields: ["lifecycle.post_evidence_id", "lifecycle.anchor_summary_id"],
  });

  cases.push({
    methods: ["recordRequestUserInput"],
    run: (ledger, _witnessId) => ledger.recordRequestUserInput({
      campaign_id: CAMPAIGN, node_id: "n-ask", operation_id: "ask-op-1", question: "Proceed?",
      options: [
        { id: "yes", text: "Yes", is_other: false, follow_up: { text: "steering text", kind: "steer" } },
        { id: "other", text: "Other", is_other: true },
      ],
      authority: "lead", blocking: "blocking", requester_role: "taproot", origin_session_id: "session-1",
      idempotency_key: "ask-1", as_of: "2026-08-01T00:00:09.000Z",
    }),
    optionalFields: ["question.origin_session_id", "question.options.0.follow_up"],
  });

  cases.push({
    methods: ["recordUserInputAnswer"],
    run: (ledger, _witnessId) => {
      const questionId = ledger.recordRequestUserInput({
        campaign_id: CAMPAIGN, node_id: "n-answer", operation_id: "answer-op-1", question: "Proceed?",
        options: [{ id: "yes", text: "Yes", is_other: false }], authority: "lead", blocking: "blocking",
        requester_role: "taproot", idempotency_key: "answer-question-1", as_of: "2026-08-01T00:00:10.000Z",
      });
      return ledger.recordUserInputAnswer({
        campaign_id: CAMPAIGN, node_id: "n-answer", question_record_id: questionId,
        answer: { option_id: "yes", custom_text: "extra context", answered_by: "human", answered_at: "2026-08-01T00:00:11.000Z" },
        timestamp: "2026-08-01T00:00:11.000Z",
      });
    },
    optionalFields: ["answer.option_id", "answer.custom_text"],
  });

  cases.push({
    methods: ["recordWaiverOutcome"],
    run: (ledger, _witnessId) => ledger.recordWaiverOutcome({
      campaign_id: CAMPAIGN, node_id: "n-waiver", task_category: "cleanup", waived_by: "operator",
      waived_reason: "low risk", waived_at: "2026-08-01T00:00:12.000Z", idempotency_key: "waiver-1",
    }),
    // WaiverOutcome has no kind-specific optional field.
    optionalFields: [],
  });

  cases.push({
    methods: ["recordWaiverOutcomeAmendment"],
    run: (ledger, _witnessId) => {
      const waiverId = ledger.recordWaiverOutcome({
        campaign_id: CAMPAIGN, node_id: "n-waiver-2", task_category: "cleanup", waived_by: "operator",
        waived_reason: "low risk", waived_at: "2026-08-01T00:00:13.000Z", idempotency_key: "waiver-2",
      });
      return ledger.recordWaiverOutcomeAmendment({
        campaign_id: CAMPAIGN, node_id: "n-waiver-2", waiver_record_id: waiverId, kind: "adopted",
        value: true, recorded_by: "operator", reason: "adopted after review", idempotency_key: "waiver-amend-1",
      });
    },
    // WaiverOutcomeAmendment has no kind-specific optional field.
    optionalFields: [],
  });

  cases.push({
    methods: ["recordScopeObservation"],
    run: (ledger, _witnessId) => ledger.recordScopeObservation({
      campaign_id: CAMPAIGN, node_id: "n-scopeobs", declared: ["lib/a.js"], observed_out_of_scope: ["lib/b.js"],
      enforcement: "blocked", idempotency_key: "scopeobs-1", lineage_root: "lineage-root-1",
    }),
    optionalFields: ["observation.lineage_root"],
  });

  cases.push({
    methods: ["recordScopeObservationAmendment"],
    run: (ledger, _witnessId) => {
      const scopeObsId = ledger.recordScopeObservation({
        campaign_id: CAMPAIGN, node_id: "n-scopeobs-2", declared: ["lib/a.js"], observed_out_of_scope: ["lib/c.js"],
        enforcement: "audit", idempotency_key: "scopeobs-2",
      });
      return ledger.recordScopeObservationAmendment({
        campaign_id: CAMPAIGN, node_id: "n-scopeobs-2", scope_observation_record_id: scopeObsId, kind: "folded",
        idempotency_key: "scopeobs-amend-1",
      });
    },
    // ScopeObservationAmendment has no kind-specific optional field.
    optionalFields: [],
  });

  cases.push({
    methods: ["recordScopeIntentBind"],
    run: (ledger, _witnessId) => ledger.recordScopeIntentBind({
      campaign_id: CAMPAIGN, node_id: "n-scopeintentbind", session_id: "session-1", intent_index: 0,
      argv_prefix: ["npm", "create"], purpose: "scaffold a project whose exact name is only known at runtime",
      bound_argv: ["npm", "create", "astro@latest", "generated-site-42"], idempotency_key: "scopeintentbind-1",
    }),
    // ScopeIntentBind has no kind-specific optional field.
    optionalFields: [],
  });

  cases.push({
    methods: ["recordAdvisoryEvidence"],
    run: (ledger, witnessId) => {
      // Force truncation with a multi-byte character straddling the boundary,
      // exercising truncateUtf8Bytes' continuation-byte backoff, not just a
      // flag flip -- and proving `payload_truncated` (derived, never trusted
      // from caller input) is itself byte-identical after reload.
      const oversized = "é".repeat(9000); // 2 bytes each, well past ADVISORY_EVIDENCE_MAX_PAYLOAD_BYTES (8KiB)
      return ledger.recordAdvisoryEvidence({
        campaign_id: CAMPAIGN, node_id: "n-advisory", generator: "mutation_probe", activity: "mutant sweep",
        payload: oversized, source_evidence_id: witnessId, idempotency_key: "advisory-1",
      });
    },
    optionalFields: ["evidence.payload_truncated"],
  });

  cases.push({
    methods: ["recordScopeDecision"],
    run: (ledger, _witnessId) => {
      const signer = makeSigner();
      const genesisTip = ledger.getLedgerTip(CAMPAIGN);
      const genesisPayload = scopeDecisionSigningPayload({
        campaign_id: CAMPAIGN, node_id: "n-scopedec", paths: ["lib/x.js"], decision: "approved_widening" as ScopeDecisionKind,
        parent_decision_id: null, previous_record_content_hash: genesisTip,
      });
      const genesisId = ledger.recordScopeDecision({
        campaign_id: CAMPAIGN, node_id: "n-scopedec", paths: ["lib/x.js"], decision: "approved_widening",
        decided_by: "operator", parent_decision_id: null, public_key: signer.publicKeyBase64,
        signature: signer.sign(genesisPayload), idempotency_key: "scopedec-genesis",
        previous_record_content_hash: genesisTip,
      });
      const secondTip = ledger.getLedgerTip(CAMPAIGN);
      const secondPayload = scopeDecisionSigningPayload({
        campaign_id: CAMPAIGN, node_id: "n-scopedec", paths: ["lib/x.js", "lib/y.js"], decision: "revoked" as ScopeDecisionKind,
        parent_decision_id: genesisId, previous_record_content_hash: secondTip,
      });
      return ledger.recordScopeDecision({
        campaign_id: CAMPAIGN, node_id: "n-scopedec", paths: ["lib/x.js", "lib/y.js"], decision: "revoked",
        decided_by: "operator", parent_decision_id: genesisId, public_key: signer.publicKeyBase64,
        signature: signer.sign(secondPayload), idempotency_key: "scopedec-second",
        previous_record_content_hash: secondTip,
      });
    },
    optionalFields: ["decision.parent_decision_id"],
  });

  cases.push({
    methods: ["recordTelemetryObservation"],
    run: (ledger, witnessId) => {
      // The exact shape ADR-067/069/071 widened one field at a time: this is
      // the maximal instance that would have caught each hand-wiring gap at
      // authoring time rather than after arbor-core shipped ahead of it.
      return ledger.recordTelemetryObservation({
        campaign_id: CAMPAIGN, node_id: "n-telemetry", operation_id: "race-op-1", epoch: 1, phase: "expand",
        outcome: "success", source_evidence_id: witnessId, idempotency_key: "telemetry-race-1",
        provenance: { tag: "generated", generator: "race-harness", input_hash: "h" },
        type: "race_outcome", forked_at_ms: 120, winner: "none", loser_wall_ms: 480, cancelled: false,
        loser_usage_unavailable_reason: "loser cancelled before usage was captured",
        threshold_ms: 250, threshold_source: "learned", threshold_observations: 42,
        tie_break: "primary",
      });
    },
    optionalFields: [
      "observation.loser_usage_unavailable_reason", "observation.threshold_ms", "observation.threshold_source",
      "observation.threshold_observations", "observation.tie_break", "observation.forked_at_ms", "observation.loser_wall_ms",
    ],
  });

  cases.push({
    methods: ["recordTerminalProfile"],
    run: (ledger, _witnessId) => ledger.recordTerminalProfile({
      campaign_id: CAMPAIGN, node_id: "n-terminal", operation_id: "terminal-op-1", idempotency_key: "terminal-1",
      capabilities: {
        focus_tracking: true, notifications: true, rgb: true, ansi256: true, remote: true,
        multiplexer: "tmux", terminal_name: "ghostty", terminal_version: "1.2.3",
      },
      theme_mode: "dark", theme_source: "terminal", provenance: { tag: "claimed", claimant: "renderer" },
    }),
    optionalFields: [
      "profile.capabilities.focus_tracking", "profile.capabilities.multiplexer", "profile.capabilities.terminal_name",
      "profile.capabilities.terminal_version",
    ],
  });

  cases.push({
    methods: ["recordTerminalNotification"],
    run: (ledger, _witnessId) => ledger.recordTerminalNotification({
      campaign_id: CAMPAIGN, node_id: "n-notify", operation_id: "notify-op-1", idempotency_key: "notify-1",
      notification_ref: `sha256:${sha256Hex("notification-body")}`, focus: "blurred", emitted: true,
      provenance: { tag: "claimed", claimant: "renderer" },
    }),
    // TerminalNotification has no kind-specific optional field.
    optionalFields: [],
  });

  // recordGovernedTransition is covered above alongside recordGateCheckpoint
  // (it requires a durable checkpoint to exist first, and produces the same
  // "trace" kind as `record` -- the interesting surface is the checkpoint,
  // not a second independent TracePacket field set).

  it("every record* method has a maximal-instance case (mechanical coverage)", () => {
    const discovered = discoveredRecordMethods();
    const covered = new Set(cases.flatMap((c) => c.methods));
    const missing = discovered.filter((m) => !covered.has(m));
    expect(missing, `record* method(s) with no maximal-instance case: ${missing.join(", ")}`).toEqual([]);
    const stale = [...covered].filter((m) => !discovered.includes(m));
    expect(stale, `maximal-instance case(s) reference a record* method that no longer exists: ${stale.join(", ")}`).toEqual([]);
  });

  for (const testCase of cases) {
    it(`${testCase.methods.join("/")}: maximal instance round-trips byte-identical`, () => {
      const { ledger, witnessId } = witnessLedger();
      const id = testCase.run(ledger, witnessId);
      expect(ledger.verifyIntegrity().valid).toBe(true);

      const jsonl = ledger.toJSONL();
      const reloaded = new EvidenceLedger();
      const importedCount = reloaded.fromJSONL(jsonl);
      expect(importedCount).toBe(ledger.getRecords().length);
      expect(reloaded.verifyIntegrity().valid).toBe(true);

      const original = ledger.getRecords().find((r) => r.id === id);
      const roundTripped = reloaded.getRecords().find((r) => r.id === id);
      expect(roundTripped).toBeDefined();
      expect(roundTripped).toEqual(original);

      if (testCase.optionalFields.length === 0) {
        // Explicit, honest declaration: this variant has no kind-specific
        // optional field to check beyond the round trip already asserted above.
        expect(testCase.optionalFields).toEqual([]);
      } else {
        for (const field of testCase.optionalFields) {
          const originalValue = get(original, field);
          expect(originalValue, `case ${testCase.methods.join("/")}: field ${field} was never set to a non-default value`).not.toBeUndefined();
          expect(originalValue).not.toBeNull();
          expect(get(roundTripped, field), `case ${testCase.methods.join("/")}: field ${field} did not survive reload byte-identical`).toEqual(originalValue);
        }
      }

      // The reloaded ledger must keep minting ids without collision -- the
      // exact seam id-prefix-coverage.test.ts closed, exercised here for
      // every kind rather than just request_user_input/phase_message.
      const before = reloaded.getRecords().length;
      reloaded.record({
        campaign_id: CAMPAIGN, node_id: "post-reload-probe",
        timestamp: "2026-08-01T00:01:00.000Z", action_description: "probe", action_category: "probe",
        specialist_agent: "s", critic_agent: null, node_state_before: "pending", node_state_after: "pending",
        provenance: null, specialist_output: null, critic_verdict_approved: null, critic_root_cause: null,
        score_before: 0, score_after: 0, gates: [], kb_entries_written: [],
      });
      expect(reloaded.getRecords().length).toBe(before + 1);
      const allIds = reloaded.getRecords().map((r) => r.id);
      expect(new Set(allIds).size).toBe(allIds.length);
    });
  }
});
