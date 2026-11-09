import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crownPrompt, cambiumPrompt, taprootPrompt, resolveRepoInstructions } from "../src/index.js";
import { EvidenceLedger, type MemoryFactInput } from "@arbor/audit";

/**
 * ADR-022 (G-10) "Test implications" fast-follow: the roundtrip proof that
 * checked-in repo instructions never reach the ledger as a `MemoryFact` or
 * any other witnessed record. Until this file, the property held only by
 * code-path inspection (repo-instructions.ts imports nothing ledger-related);
 * this makes it a regression-guarded assertion, per the operator's
 * acceptance of ADR-022 with the test as a fast-follow, not a precondition.
 *
 * Two independent guards:
 *  1. Static — the composing source files never import or reference the
 *     ledger surface at all, so no code path in this package *can* record
 *     repo-instruction content even accidentally.
 *  2. Behavioral — real repo-instruction content, resolved from actual
 *     AGENTS.md/CLAUDE.md files and composed into a real plan-level agent
 *     prompt, never appears anywhere in a realistic campaign ledger's
 *     persisted output, and composing the prompt appends zero packets to a
 *     ledger that exists concurrently in scope.
 */

const MARKER = "REPO-INSTRUCTION-MARKER-f7a2c9-do-not-leak-into-the-ledger";

function sourceText(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf-8");
}

describe("ADR-022 (G-10) ledger-exclusion roundtrip", () => {
  it("static guard: repo-instructions.ts and index.ts never import the ledger package or call a ledger recording API", () => {
    // Doc comments in these files legitimately *discuss* EvidenceLedger/
    // MemoryFact (that is ADR-022's whole point) — the guard checks for an
    // actual import or call site, not the word appearing in prose.
    for (const file of ["../src/repo-instructions.ts", "../src/index.ts"]) {
      const text = sourceText(file);
      const importLines = text.split("\n").filter((line) => /^\s*import\b/.test(line));
      expect(importLines.some((line) => line.includes("@arbor/audit")), `${file} must not import @arbor/audit`).toBe(false);
      expect(text, `${file} must not instantiate EvidenceLedger`).not.toMatch(/new\s+EvidenceLedger/);
      expect(text, `${file} must not call a ledger recording method`).not.toMatch(/\.record(MemoryFact|GateCheckpoint|NodeCommunication|PhaseMessage|TelemetryObservation|RecoveryDecision|Interruption|RequestUserInput|UserInputAnswer)?\(/);
    }
  });

  it("behavioral guard: real repo-instruction content composes into a plan-level prompt but never appears in a realistic campaign ledger", () => {
    // 1. Real filesystem content, resolved by the real function — not a stub.
    const root = mkdtempSync(join(tmpdir(), "arbor-ledger-exclusion-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), `Operator convention: ${MARKER}`, "utf8");
      writeFileSync(join(root, "CLAUDE.md"), "Use conventional commits.", "utf8");
      const scope = resolveRepoInstructions(root);
      expect(scope.content).toContain(MARKER);

      // 2. Compose real dispatch prompts for every root/plan-level agent
      // (the only ones ADR-022 wires this scope into) — proving the marker
      // genuinely flows into a live dispatch prompt, not a mock of one.
      const ctx = { campaignId: "camp_ledger_exclusion", taskDescription: "prove the negative space", repoInstructions: scope };
      const composedPrompts = [crownPrompt(ctx), cambiumPrompt(ctx), taprootPrompt(ctx)];
      for (const prompt of composedPrompts) expect(prompt).toContain(MARKER);

      // 3. A ledger exists concurrently in scope while the prompts above are
      // composed. Composing a prompt is a pure string operation — it must
      // append nothing to any ledger, not even implicitly.
      const ledger = new EvidenceLedger();
      expect(ledger.getRecords().length).toBe(0);

      // 4. Populate the ledger the way a real campaign around this dispatch
      // would: a gate checkpoint before expansion, a trace packet for the
      // node's expansion, a memory fact witnessed by that trace, a node
      // communication, a phase message, and a telemetry observation — every
      // record kind the ledger supports, using realistic-but-distinct
      // content that never includes the marker or the composed prompts.
      const campaign_id = ctx.campaignId;
      const node_id = "node_crown_root";

      ledger.recordGateCheckpoint({
        campaign_id, node_id, transition: "node_expansion", operation_id: "op-1",
        gate: { gate: "isolation", result: "pass", checked_at: "2026-08-04T00:00:00.000Z", detail: "worktree isolated" },
      });

      const traceId = ledger.record({
        campaign_id, node_id, timestamp: "2026-08-04T00:00:00.000Z",
        action_description: "Crown dispatched Cambium for task decomposition",
        action_category: "delegate", specialist_agent: "crown", critic_agent: "lenticel",
        node_state_before: "pending", node_state_after: "expanding",
        provenance: { tag: "claimed", claimant: "crown" },
        specialist_output: "Delegated to Cambium; awaiting decomposition.",
        critic_verdict_approved: null, critic_root_cause: null,
        score_before: 0, score_after: 0, gates: [], kb_entries_written: [],
      });

      const factInput: MemoryFactInput = {
        campaign_id, node_id, scope: { kind: "campaign" }, type: "success_pattern",
        content: "Delegating decomposition to Cambium before scoring keeps nodes small.",
        provenance: { tag: "claimed", claimant: "crown" }, tier: "specialist_visible",
        source_evidence_id: traceId, idempotency_key: "fact-ledger-exclusion-1", tags: ["delegation"],
        timestamp: "2026-08-04T00:00:01.000Z",
      };
      ledger.recordMemoryFact(factInput);

      ledger.recordNodeCommunication({
        campaign_id, node_id, author_node_id: "crown", recipient_node_id: "cambium",
        other_recipient_node_ids: [], kind: "delegate",
        payload: { content: "Decompose the task into candidate actions.", provenance: { tag: "claimed", claimant: "crown" } },
        capability_tier: "orchestrator", trigger_turn: true, as_of: "iter:1", correlation_id: "delegate-1",
        idempotency_key: "comm-ledger-exclusion-1", acknowledges_communication_id: null, retracts_communication_id: null,
      });

      ledger.recordPhaseMessage({
        campaign_id, node_id, operation_id: "op-1", phase: "commentary",
        content: "Cambium is decomposing the task.", content_length_bytes: Buffer.byteLength("Cambium is decomposing the task.", "utf-8"),
        provenance: { tag: "claimed", claimant: "crown" }, idempotency_key: "phase-ledger-exclusion-1",
      });

      ledger.recordTelemetryObservation({
        campaign_id, node_id, type: "phase_timing", operation_id: "op-1", epoch: 1, phase: "expand",
        outcome: "success", source_evidence_id: traceId, idempotency_key: "telemetry-ledger-exclusion-1",
        provenance: { tag: "claimed", claimant: "crown" }, duration_ms: 42,
      });

      // 5. The negative-space proof: none of the marker, nor either composed
      // plan-level prompt in full, ever appears anywhere in the ledger's
      // persisted JSONL output or its in-memory record snapshot.
      const jsonl = ledger.toJSONL();
      expect(jsonl).not.toContain(MARKER);
      for (const prompt of composedPrompts) expect(jsonl).not.toContain(prompt);

      const recordsDump = JSON.stringify(ledger.getRecords());
      expect(recordsDump).not.toContain(MARKER);
      for (const prompt of composedPrompts) expect(recordsDump).not.toContain(prompt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
