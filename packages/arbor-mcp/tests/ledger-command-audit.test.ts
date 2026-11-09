/**
 * Y-2 (ADR-068): `arbor ledger audit` — the CLI surface for
 * `sweepLedgerAudit`. See `ledger-audit-sweep.test.ts` (arbor-audit) for the
 * five checks themselves; this file proves the CLI plumbing: single-campaign
 * vs `--all`, JSON/human output, and the exit code.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceLedger, saveLedger } from "@arbor/audit";
import { ledgerCommand } from "../src/ledger-command.js";
import { EXIT_CODES } from "../src/exit-codes.js";

function environment(): { env: { stdout: { write(t: string): void }; stderr: { write(t: string): void } }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { env: { stdout: { write: (t) => { out.push(t); } }, stderr: { write: (t) => { err.push(t); } } }, out, err };
}

/** A campaign with exactly one clean trace — no findings on any of the five checks. */
function seedCleanCampaign(dir: string, campaign: string): void {
  const ledger = new EvidenceLedger();
  ledger.record({
    campaign_id: campaign, node_id: "node-a", timestamp: "2026-08-01T00:00:00.000Z",
    action_description: "do it", action_category: "test", specialist_agent: "seed", critic_agent: null,
    node_state_before: "expanding", node_state_after: "verified",
    provenance: { tag: "verified", cmd: "declared-outputs-check", exit: 0, stdout_hash: "sha256:test", strength: "outputs_check" },
    specialist_output: "done", critic_verdict_approved: true, critic_root_cause: null,
    score_before: 0, score_after: 1, gates: [], kb_entries_written: [],
  });
  saveLedger(ledger, dir, campaign);
}

/** A campaign whose race_outcome cancels a loser with only one specialist usage_cost row and no honest reason — check (a). */
function seedFindingCampaign(dir: string, campaign: string): void {
  const ledger = new EvidenceLedger();
  const traceId = ledger.record({
    campaign_id: campaign, node_id: "node-a", timestamp: "2026-08-01T00:00:00.000Z",
    action_description: "do it", action_category: "test", specialist_agent: "seed", critic_agent: null,
    node_state_before: "expanding", node_state_after: "verified",
    provenance: { tag: "claimed", claimant: "seed" },
    specialist_output: "done", critic_verdict_approved: null, critic_root_cause: null,
    score_before: 0, score_after: 1, gates: [], kb_entries_written: [],
  });
  ledger.recordTelemetryObservation({
    campaign_id: campaign, node_id: "node-a", type: "usage_cost", operation_id: "op:specialist", epoch: 1,
    phase: "expand", outcome: "success", source_evidence_id: traceId, idempotency_key: "cost:1",
    provenance: { tag: "generated", generator: "test", input_hash: "h" },
    provider: "other", model_family: "other", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0,
    cost: { kind: "unpriced", reason: "test" },
  });
  ledger.recordTelemetryObservation({
    campaign_id: campaign, node_id: "node-a", type: "race_outcome", operation_id: "op:race", epoch: 1,
    phase: "expand", outcome: "success", source_evidence_id: traceId, idempotency_key: "race:1",
    provenance: { tag: "generated", generator: "test", input_hash: "h" },
    forked_at_ms: 20000, winner: "primary", loser_wall_ms: 10000, cancelled: true,
  });
  saveLedger(ledger, dir, campaign);
}

describe("arbor-mcp ledger audit (Y-2, ADR-068)", () => {
  it("reports SUCCESS with zero findings for a clean campaign", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-audit-"));
    try {
      seedCleanCampaign(dir, "camp-clean");
      const { env, out } = environment();
      const code = ledgerCommand(["audit", "camp-clean", "--dir", dir, "--json"], env);
      expect(code).toBe(EXIT_CODES.SUCCESS);
      const payload = JSON.parse(out.join("")) as { campaigns: { campaign_id: string; findings: unknown[] }[] };
      expect(payload.campaigns).toHaveLength(1);
      expect(payload.campaigns[0]!.findings).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports VIOLATION with the finding for a campaign with an unaccounted race loser", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-audit-"));
    try {
      seedFindingCampaign(dir, "camp-finding");
      const { env, out } = environment();
      const code = ledgerCommand(["audit", "camp-finding", "--dir", dir, "--json"], env);
      expect(code).toBe(EXIT_CODES.VIOLATION);
      const payload = JSON.parse(out.join("")) as { campaigns: { findings: { check: string }[] }[] };
      expect(payload.campaigns[0]!.findings.map((f) => f.check)).toContain("unaccounted_race_loser");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("--all sweeps every campaign in the persistence dir and escalates to VIOLATION if any has a finding", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-audit-"));
    try {
      seedCleanCampaign(dir, "camp-clean");
      seedFindingCampaign(dir, "camp-finding");
      const { env, out } = environment();
      const code = ledgerCommand(["audit", "--all", "--dir", dir, "--json"], env);
      expect(code).toBe(EXIT_CODES.VIOLATION);
      const payload = JSON.parse(out.join("")) as { campaigns: { campaign_id: string }[] };
      expect(payload.campaigns.map((c) => c.campaign_id).sort()).toEqual(["camp-clean", "camp-finding"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("--all excludes the reserved governance stream", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-audit-"));
    try {
      seedCleanCampaign(dir, "camp-clean");
      const ledger = new EvidenceLedger();
      ledger.recordGovernanceEvent({
        campaign_id: "governance", node_id: "root", timestamp: "2026-08-01T00:00:00.000Z",
        action_description: "governance event", action_category: "test", specialist_agent: "seed", critic_agent: null,
        node_state_before: "expanding", node_state_after: "verified", provenance: null,
        specialist_output: null, critic_verdict_approved: null, critic_root_cause: null,
        score_before: 0, score_after: 0, gates: [], kb_entries_written: [],
      } as never);
      saveLedger(ledger, dir, "governance");
      const { env, out } = environment();
      const code = ledgerCommand(["audit", "--all", "--dir", dir, "--json"], env);
      expect(code).toBe(EXIT_CODES.SUCCESS);
      const payload = JSON.parse(out.join("")) as { campaigns: { campaign_id: string }[] };
      expect(payload.campaigns.map((c) => c.campaign_id)).toEqual(["camp-clean"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("usage error when neither a campaign id nor --all is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-audit-"));
    try {
      const { env, err } = environment();
      const code = ledgerCommand(["audit", "--dir", dir], env);
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(err.join("")).toMatch(/Usage/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("prints a human summary without --json", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-audit-"));
    try {
      seedCleanCampaign(dir, "camp-clean");
      const { env, out } = environment();
      const code = ledgerCommand(["audit", "camp-clean", "--dir", dir], env);
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(out.join("")).toMatch(/campaign: camp-clean/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * Absence-reads-as-clean. `results.every(r => r.findings.length === 0)` is
 * vacuously true over an empty array, so `--all` against a persistence dir
 * with no `audit/` printed `clean: no cross-record findings` and exited
 * SUCCESS. `.arbor/audit/` does not exist in this repository, and
 * `gate:ledger-audit` is `required: true` / `effect: blocking` in CI.
 */
describe("arbor-mcp ledger audit — no corpus is not a clean corpus", () => {
  it("--all reports FAILURE, never \"clean\", when the persistence dir has no audit/ directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-nocorpus-"));
    try {
      const { env, out } = environment();
      const code = ledgerCommand(["audit", "--all", "--dir", dir], env);
      expect(code).toBe(EXIT_CODES.FAILURE);
      const text = out.join("");
      expect(text).not.toContain("clean: no cross-record findings");
      expect(text).toContain("UNMEASURED, not clean");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("--all reports FAILURE for an audit/ directory holding no campaign ledgers", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-emptyaudit-"));
    try {
      mkdirSync(join(dir, "audit"));
      const { env, out } = environment();
      const code = ledgerCommand(["audit", "--all", "--dir", dir], env);
      expect(code).toBe(EXIT_CODES.FAILURE);
      expect(out.join("")).toContain("no campaign ledgers");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("names the corpus state in --json so a consumer cannot read an empty array as a pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-corpusjson-"));
    try {
      const { env, out } = environment();
      expect(ledgerCommand(["audit", "--all", "--dir", dir, "--json"], env)).toBe(EXIT_CODES.FAILURE);
      const payload = JSON.parse(out.join("")) as { corpus: string; campaigns: unknown[] };
      expect(payload.corpus).toBe("absent");
      expect(payload.campaigns).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("still says clean — and only for a real corpus — when every campaign is intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-reallyclean-"));
    try {
      seedCleanCampaign(dir, "camp-clean");
      const { env, out } = environment();
      expect(ledgerCommand(["audit", "--all", "--dir", dir], env)).toBe(EXIT_CODES.SUCCESS);
      expect(out.join("")).toContain("clean: no cross-record findings");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a named campaign with no ledger file is VIOLATION, not a vacuous pass", () => {
    // `loadLedgerCore` returns an EMPTY ledger with no diagnostics and
    // `valid: true` for a campaign that was never recorded, so the sweep has
    // nothing to find and zero findings is the only possible outcome.
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-norecord-"));
    try {
      const { env, out } = environment();
      expect(ledgerCommand(["audit", "never-ran", "--dir", dir], env)).toBe(EXIT_CODES.VIOLATION);
      const text = out.join("");
      expect(text).not.toContain("clean: no cross-record findings");
      expect(text).toContain("not the same as being clean");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a broken hash chain drives the exit code even when the sweep finds nothing", () => {
    // The "perfectly intact but merely incomplete" case that `audit` was
    // documented as exempting is `tip_status: "sentinel_missing"`, which
    // `loadLedgerResult` deliberately keeps OUT of `valid` (persist.ts). So
    // `valid === false` is a quarantined chain or a deleted/truncated sentinel,
    // and it must reach the exit code.
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-brokenchain-"));
    try {
      seedCleanCampaign(dir, "camp-broken");
      const path = join(dir, "audit", "camp-broken.jsonl");
      const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const first = rows[0]!;
      rows.push({ ...first, id: "forged-2", node_id: "node-b", previous_hash: "0".repeat(64) });
      writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

      const { env, out } = environment();
      const code = ledgerCommand(["audit", "--all", "--dir", dir], env);
      const text = out.join("");
      expect(text).toContain("ledger_valid=false");
      expect(text).not.toContain("clean: no cross-record findings");
      expect(code).toBe(EXIT_CODES.VIOLATION);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
