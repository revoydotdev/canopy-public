import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { findingContentHash, normalizeTitle, stableFindingId } from "../vi-finding-id.mjs";
import { evaluateFindingTriage, findingNeedsTriageDecision } from "../vi-findings.mjs";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

const TMP = [];
function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `revoy2-${prefix}-`));
  TMP.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

function runViFindings({ env = {}, args = [] } = {}) {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "vi-findings.mjs"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const sampleFinding = (over = {}) => ({
  id: "VI-0001",
  severity: "medium",
  category: "dead_code",
  title: "orphans-no-inbound: 6 record(s)",
  claim: "x", affected_nodes: ["sym:a", "sym:b"], affected_edges: [], missing_edges: [],
  expected_model: "x", observed_model: "x", evidence: [], confidence: "high",
  corroborating_heuristics: [], impact: "x", likely_cause: null,
  remediation: "x", validation_method: "x", adr_refs: [], owner: null,
  found_at_revision: "abc123", status: "open", exception_id: null,
  ...over,
});

// ---------------------------------------------------------------------------
// vi-finding-id.mjs — the shared stable-id function
// ---------------------------------------------------------------------------

describe("vi-finding-id.mjs", () => {
  it("normalizeTitle strips digits so a count change does not change identity", () => {
    expect(normalizeTitle("orphans-no-inbound: 6 record(s)")).toBe(normalizeTitle("orphans-no-inbound: 7 record(s)"));
  });

  it("stableFindingId is unaffected by a count-only title change", () => {
    const a = stableFindingId(sampleFinding({ title: "orphans-no-inbound: 6 record(s)" }));
    const b = stableFindingId(sampleFinding({ title: "orphans-no-inbound: 7 record(s)" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^vi:[0-9a-f]{16}$/);
  });

  it("stableFindingId stays fixed when affected_nodes changes — symbol drift is a re-attestation concern, not a new question", () => {
    const a = stableFindingId(sampleFinding({ affected_nodes: ["sym:a", "sym:b"] }));
    const b = stableFindingId(sampleFinding({ affected_nodes: ["sym:a", "sym:c"] }));
    expect(a).toBe(b);
  });

  it("stableFindingId is order-independent over affected_nodes (sorted before hashing)", () => {
    const a = stableFindingId(sampleFinding({ affected_nodes: ["sym:b", "sym:a"] }));
    const b = stableFindingId(sampleFinding({ affected_nodes: ["sym:a", "sym:b"] }));
    expect(a).toBe(b);
  });

  it("findingContentHash is NOT sensitive to a count-only change (B1) — a moving record count must not reopen a verdict", () => {
    const a = findingContentHash(sampleFinding({ title: "orphans-no-inbound: 6 record(s)", observed_model: "651 record(s) match." }));
    const b = findingContentHash(sampleFinding({ title: "orphans-no-inbound: 7 record(s)", observed_model: "760 record(s) match." }));
    expect(a).toBe(b);
  });

  it("REGRESSION: a MULTI-WORD unit phrase normalizes too — the real bodies say \"visible symbol(s)\"", () => {
    // The first implementation looked ahead for a single word before "(s)",
    // so it normalized "1 file(s)" but not "1 visible symbol(s)". Every real
    // catalog_gap body carries both, so a symbol-count change alone still
    // reopened the verdict — the exact churn B1 exists to stop, surviving in
    // the half of the string the fixtures did not cover.
    const real = (files, symbols) =>
      `${files} file(s) (${symbols} visible symbol(s)) in arbor-audit loaded under a production ` +
      "scenario but had zero invocations (declared scenario catalog hash 8786946d8f9a2309).";
    const a = findingContentHash(sampleFinding({ observed_model: real(1, 1) }));
    const b = findingContentHash(sampleFinding({ observed_model: real(1, 9) }));
    expect(a).toBe(b);
    // And the catalog hash in that same string is still load-bearing.
    const c = findingContentHash(sampleFinding({
      observed_model: real(1, 1).replace("8786946d8f9a2309", "ffffffffffffffff"),
    }));
    expect(a).not.toBe(c);
  });

  it("findingContentHash IS still sensitive to a catalog hash change inside observed_model — surgical, not blunt", () => {
    const a = findingContentHash(sampleFinding({
      observed_model: "3 symbol(s) never invoked (declared scenario catalog hash 7dbf7d1c2a6976ec).",
    }));
    const b = findingContentHash(sampleFinding({
      observed_model: "3 symbol(s) never invoked (declared scenario catalog hash aaaaaaaaaaaaaaaa).",
    }));
    expect(a).not.toBe(b);
  });

  it("findingContentHash IS still sensitive to a genuine substance change (not just a count)", () => {
    const a = findingContentHash(sampleFinding({ observed_model: "affects module A" }));
    const b = findingContentHash(sampleFinding({ observed_model: "affects module B" }));
    expect(a).not.toBe(b);
  });

  it("findingContentHash is NOT sensitive to run-stamp fields — a refresh alone must not reopen every verdict", () => {
    // Regression: hashing found_at_revision reopened all 63 findings on the
    // first post-rebase regeneration, defeating ADR-042 O4.
    const a = findingContentHash(sampleFinding({ found_at_revision: "aaaa111122223333" }));
    const b = findingContentHash(sampleFinding({ found_at_revision: "bbbb444455556666" }));
    expect(a).toBe(b);
    const c = findingContentHash(sampleFinding({ id: "vi:0000000000000000" }));
    const d = findingContentHash(sampleFinding({ id: "vi:ffffffffffffffff" }));
    expect(c).toBe(d);
  });
});

// ---------------------------------------------------------------------------
// vi-findings.mjs --rewrite-ids
// ---------------------------------------------------------------------------

describe("vi-findings.mjs --rewrite-ids", () => {
  it("rewrites sequential VI-000X ids to stable content-addressed ids", () => {
    const dir = fixture("rewrite");
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(sampleFinding())}\n`);
    const { code } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--rewrite-ids"] });
    expect(code).toBe(0);
    const findings = readFileSync(join(dir, "findings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(findings[0].id).toMatch(/^vi:[0-9a-f]{16}$/);
  });

  it("is idempotent — a second run produces the identical id", () => {
    const dir = fixture("rewrite-idempotent");
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(sampleFinding())}\n`);
    runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--rewrite-ids"] });
    const first = JSON.parse(readFileSync(join(dir, "findings.jsonl"), "utf8").trim()).id;
    runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--rewrite-ids"] });
    const second = JSON.parse(readFileSync(join(dir, "findings.jsonl"), "utf8").trim()).id;
    expect(second).toBe(first);
  });

  it("rekeys a matching triage row during the one-time id migration without changing its verdict", () => {
    const dir = fixture("rewrite-rekeys-triage");
    const old = sampleFinding({ id: "VI-0001", affected_nodes: ["sym:a"] });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(old)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify({
      finding_id: old.id, verdict: "accepted_tradeoff", reason: "human verdict",
      first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
      content_hash: findingContentHash(old), symbol_set: ["sym:a"],
    })}\n`);

    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--rewrite-ids"] });
    expect(code).toBe(0);
    expect(out).toContain("1 triage row(s) rekeyed");
    const rewritten = JSON.parse(readFileSync(join(dir, "findings.jsonl"), "utf8"));
    const row = JSON.parse(readFileSync(join(dir, "triage.jsonl"), "utf8"));
    expect(row.finding_id).toBe(rewritten.id);
    expect(row.verdict).toBe("accepted_tradeoff");
    expect(row.reason).toBe("human verdict");
    expect(row.prior_finding_ids).toEqual(["VI-0001"]);
  });

  it("narrows the ask to the ADDED symbols instead of voiding the whole verdict", () => {
    const dir = fixture("grown-symbol-set");
    const before = sampleFinding({ id: "VI-0001", affected_nodes: ["sym:a", "sym:b"] });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(before)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify({
      finding_id: before.id, verdict: "accepted_tradeoff", reason: "human verdict",
      first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
      content_hash: findingContentHash(before), symbol_set: ["sym:a", "sym:b"],
    })}\n`);
    const grown = { ...before, affected_nodes: ["sym:a", "sym:b", "sym:c"], body: "different body text" };
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(grown)}\n`);

    const { out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: [] });
    // Still needs a human decision — a genuinely new member was never triaged.
    expect(out).toContain("sym:c");
    // But the operator is told their prior verdict still stands for what they
    // already decided, and is asked only about the addition. "the prior verdict
    // no longer applies" over an unrelated addition is what trains a careless
    // answer.
    expect(out).not.toContain("the prior verdict no longer applies");
    expect(out).toContain("2 already-triaged");
  });

  it("keeps the same id when a refreshed finding changes symbols, then reopens the prior verdict instead of creating an orphan", () => {
    const dir = fixture("rewrite-symbol-drift");
    const before = sampleFinding({ id: "VI-0001", affected_nodes: ["sym:a"] });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(before)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify({
      finding_id: before.id, verdict: "accepted_tradeoff", reason: "human verdict",
      first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
      content_hash: findingContentHash(before), symbol_set: ["sym:a"],
    })}\n`);
    expect(runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--rewrite-ids"] }).code).toBe(0);

    const stable = JSON.parse(readFileSync(join(dir, "findings.jsonl"), "utf8"));
    const after = { ...stable, affected_nodes: ["sym:a", "sym:b"] };
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(after)}\n`);
    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--rewrite-ids"] });
    expect(code).toBe(0);
    expect(out).toContain("0 triage row(s) rekeyed");
    const { code: gateCode, out: gateOut } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--json"] });
    expect(gateCode).toBe(1);
    const report = JSON.parse(gateOut);
    expect(report.orphaned_triage_rows).toBe(0);
    expect(report.violation_ids).toEqual([stable.id]);
  });

  it("rekeys a historical row on pure count/content drift only when its exact normalized symbol set uniquely identifies the current finding", () => {
    const dir = fixture("rewrite-historical-exact-set");
    const current = sampleFinding({ id: "vi:current00000000", title: "orphans-no-inbound: 9 record(s)", affected_nodes: ["sym:b", "sym:a"], observed_model: "new catalog evidence" });
    const historical = sampleFinding({ id: "vi:historical0000", title: "orphans-no-inbound: 2 record(s)", affected_nodes: ["sym:a", "sym:b"], observed_model: "old catalog evidence" });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(current)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify({
      finding_id: historical.id, verdict: "accepted_tradeoff", reason: "human verdict",
      first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
      content_hash: findingContentHash(historical), symbol_set: ["sym:a", "sym:b"],
    })}\n`);

    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--rewrite-ids"] });
    expect(code).toBe(0);
    expect(out).toContain(`${historical.id} -> ${stableFindingId(current)}`);
    const row = JSON.parse(readFileSync(join(dir, "triage.jsonl"), "utf8"));
    expect(row.finding_id).toBe(stableFindingId(current));
    expect(row.reason).toBe("human verdict");

    // The rekey did not rewrite the human evidence. The gate, not the rewrite,
    // applies D31's unchanged-symbol carry-forward rule.
    const { code: gateCode, out: gateOut } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--json"] });
    expect(gateCode).toBe(0);
    expect(JSON.parse(gateOut).carried_forward).toBe(1);
  });

  it("fails closed on an exact-set collision: retains the row and never selects a target finding", () => {
    const dir = fixture("rewrite-historical-collision");
    const first = sampleFinding({ id: "vi:first000000000", category: "dead_code", title: "first: 1 record(s)", affected_nodes: ["sym:a"] });
    const second = sampleFinding({ id: "vi:second00000000", category: "catalog_gap", title: "second: 1 record(s)", affected_nodes: ["sym:a"] });
    const historicalId = "vi:historical0000";
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify({
      finding_id: historicalId, verdict: "accepted_tradeoff", reason: "human verdict",
      first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
      content_hash: "old", symbol_set: ["sym:a"],
    })}\n`);

    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--rewrite-ids"] });
    expect(code).toBe(0);
    expect(out).toContain("0 triage row(s) rekeyed");
    expect(out).toContain("1 triage row(s) retained");
    expect(JSON.parse(readFileSync(join(dir, "triage.jsonl"), "utf8")).finding_id).toBe(historicalId);

    // An ambiguous row is evidence awaiting a person, not a true orphan to delete.
    const { code: pruneCode, out: pruneOut } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--prune-orphans"] });
    expect(pruneCode).toBe(0);
    expect(pruneOut).toContain("removed 0 orphaned triage row(s)");
    const { out: gateOut } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--json"] });
    const report = JSON.parse(gateOut);
    expect(report.ambiguous_triage_rows).toBe(1);
    expect(report.orphaned_triage_rows).toBe(0);
  });

  it("REFUSES to merge two historical human verdicts that uniquely target the same current finding", () => {
    const dir = fixture("rewrite-human-verdict-collision");
    const current = sampleFinding({ id: "vi:current00000000", affected_nodes: ["sym:a"] });
    const first = {
      finding_id: "vi:historical-one", verdict: "accepted_tradeoff", reason: "first human verdict",
      first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31", content_hash: "old", symbol_set: ["sym:a"],
    };
    const second = { ...first, finding_id: "vi:historical-two", reason: "second human verdict" };
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(current)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);

    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--rewrite-ids"] });
    expect(code).toBe(1);
    expect(out).toContain("triage rekey collision");
    const rows = readFileSync(join(dir, "triage.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(rows.map((row) => row.finding_id)).toEqual([first.finding_id, second.finding_id]);
  });

  it("FAILS loudly on an id collision between two distinct findings", () => {
    const dir = fixture("rewrite-collision");
    const a = sampleFinding({ id: "VI-0001", category: "dead_code", title: "x: 1 record(s)", affected_nodes: ["sym:a"] });
    const b = sampleFinding({ id: "VI-0002", category: "dead_code", title: "x: 2 record(s)", affected_nodes: ["sym:a"] });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);
    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--rewrite-ids"] });
    expect(code).toBe(1);
    expect(out).toContain("id collision");
  });
});

// ---------------------------------------------------------------------------
// vi-findings.mjs --triage
// ---------------------------------------------------------------------------

describe("vi-findings.mjs --triage", () => {
  it("writes a triage row with a computed content_hash and default 30-day expiry", () => {
    const dir = fixture("triage-write");
    const finding = sampleFinding({ id: "vi:aaaa000000000000" });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(finding)}\n`);
    const { code } = runViFindings({
      env: { REVOY2_VI_FINDINGS_DIR: dir },
      args: ["--triage", "vi:aaaa000000000000", "--verdict", "false_positive", "--reason", "test reason"],
    });
    expect(code).toBe(0);
    const row = JSON.parse(readFileSync(join(dir, "triage.jsonl"), "utf8").trim());
    expect(row.verdict).toBe("false_positive");
    expect(row.content_hash).toBe(findingContentHash(finding));
    expect(row.triage_expires > row.first_seen_date).toBe(true);
  });

  it("REFUSES an invalid verdict", () => {
    const dir = fixture("triage-bad-verdict");
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(sampleFinding({ id: "vi:bbbb" }))}\n`);
    const { code, out } = runViFindings({
      env: { REVOY2_VI_FINDINGS_DIR: dir },
      args: ["--triage", "vi:bbbb", "--verdict", "not_a_real_verdict", "--reason", "x"],
    });
    expect(code).toBe(2);
    expect(out).toContain("invalid verdict");
  });
});

// ---------------------------------------------------------------------------
// vi-findings.mjs gate — can it actually fail? (all three violation modes)
// ---------------------------------------------------------------------------

describe("vi-findings.mjs gate — can it actually fail?", () => {
  it("FAILS when a finding has no triage row", () => {
    const dir = fixture("gate-untriaged");
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(sampleFinding({ id: "vi:cccc" }))}\n`);
    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(1);
    expect(out).toContain("untriaged");
  });

  it("FAILS when a triage row is expired", () => {
    const dir = fixture("gate-expired");
    const finding = sampleFinding({ id: "vi:dddd" });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(finding)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify({
      finding_id: "vi:dddd", verdict: "accepted_tradeoff", reason: "x",
      first_seen: "abc", first_seen_date: "2020-01-01", triage_expires: "2020-01-31",
      content_hash: findingContentHash(finding),
    })}\n`);
    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(1);
    expect(out).toContain("expired");
  });

  it("FAILS when a triage row's content_hash no longer matches its finding — reopened", () => {
    const dir = fixture("gate-hash-mismatch");
    const finding = sampleFinding({ id: "vi:eeee", title: "orphans-no-inbound: 6 record(s)" });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(finding)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify({
      finding_id: "vi:eeee", verdict: "false_positive", reason: "x",
      first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
      content_hash: "0000000000000000",
    })}\n`);
    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(1);
    expect(out).toContain("REOPENED");
  });

  it("passes a finding that is triaged, unexpired, and hash-matched", () => {
    const dir = fixture("gate-pass");
    const finding = sampleFinding({ id: "vi:ffff" });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(finding)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify({
      finding_id: "vi:ffff", verdict: "accepted_tradeoff", reason: "x",
      first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
      content_hash: findingContentHash(finding),
    })}\n`);
    const { code } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(0);
  });

  it("passes trivially against an empty findings store", () => {
    const dir = fixture("gate-empty");
    writeFileSync(join(dir, "findings.jsonl"), "");
    const { code } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// vi-findings.mjs — default output vs --explain
// ---------------------------------------------------------------------------

describe("vi-findings.mjs — default output is the count, ids, and the --triage hint only", () => {
  function untriagedFixture(dir, n) {
    const findings = Array.from({ length: n }, (_, i) =>
      sampleFinding({ id: `vi:untriaged${i}`, title: `finding number ${i}: 1 record(s)`, affected_nodes: [`sym:${i}`] }));
    writeFileSync(join(dir, "findings.jsonl"), findings.map((f) => JSON.stringify(f)).join("\n") + "\n");
    return findings;
  }

  it("the default (no --explain) run omits the strength/convergence rationale", () => {
    const dir = fixture("explain-default");
    const findings = untriagedFixture(dir, 6);
    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(1);
    // The count and every finding id/title are present.
    expect(out).toContain("6 finding(s)");
    for (const f of findings) {
      expect(out).toContain(f.id);
      expect(out).toContain(f.title);
    }
    expect(out).toContain("--triage");
    // The 40-line rationale is gone from the default run.
    expect(out).not.toContain("Strength:");
    expect(out).not.toContain("Convergence:");
    expect(out).not.toContain("RED IS THIS GATE'S NORMAL STATE");
  });

  it("--explain prints the full rationale in addition to the default output", () => {
    const dir = fixture("explain-flag");
    untriagedFixture(dir, 6);
    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--explain"] });
    expect(code).toBe(1);
    expect(out).toContain("Strength:");
    expect(out).toContain("Convergence:");
    expect(out).toContain("RED IS THIS GATE'S NORMAL STATE");
    expect(out).toContain("--triage");
  });
});

// ---------------------------------------------------------------------------
// vi-findings.mjs — B2: orphaned triage rows (gate reports, --prune-orphans removes)
// ---------------------------------------------------------------------------

describe("vi-findings.mjs — B2 orphaned triage rows", () => {
  function seedOneLiveFindingPlusOneOrphanTriageRow(dir) {
    const live = sampleFinding({ id: "vi:live0000000000" });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(live)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), [
      JSON.stringify({
        finding_id: "vi:live0000000000", verdict: "accepted_tradeoff", reason: "x",
        first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
        content_hash: findingContentHash(live),
      }),
      // orphan: no finding with this id exists (its affected_nodes rotated the id away)
      JSON.stringify({
        finding_id: "vi:orphan00000000", verdict: "false_positive", reason: "stale",
        first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
        content_hash: "deadbeefdeadbeef",
      }),
    ].join("\n") + "\n");
    return live;
  }

  it("gate REPORTS the orphan count but does not prune or fail on it alone", () => {
    const dir = fixture("gate-orphan-report");
    seedOneLiveFindingPlusOneOrphanTriageRow(dir);
    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--json"] });
    expect(code).toBe(0); // the live finding is validly triaged — an orphan elsewhere must not fail the gate
    const report = JSON.parse(out);
    expect(report.orphaned_triage_rows).toBe(1);
    expect(report.orphaned_triage_ids).toEqual(["vi:orphan00000000"]);
    // triage.jsonl itself is untouched by a mere gate run
    const rows = readFileSync(join(dir, "triage.jsonl"), "utf8").trim().split("\n");
    expect(rows).toHaveLength(2);
  });

  it("gate's human-readable output surfaces the orphan count too", () => {
    const dir = fixture("gate-orphan-text");
    seedOneLiveFindingPlusOneOrphanTriageRow(dir);
    const { out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(out).toContain("orphaned triage rows: 1");
    expect(out).toContain("--prune-orphans");
  });

  it("--prune-orphans removes only the orphaned row(s), preserving the live one", () => {
    const dir = fixture("prune-orphans");
    seedOneLiveFindingPlusOneOrphanTriageRow(dir);
    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--prune-orphans"] });
    expect(code).toBe(0);
    expect(out).toContain("removed 1 orphaned triage row(s)");
    const rows = readFileSync(join(dir, "triage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].finding_id).toBe("vi:live0000000000");

    // and the gate now reports zero orphans
    const { out: gateOut } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--json"] });
    expect(JSON.parse(gateOut).orphaned_triage_rows).toBe(0);
  });

  it("--prune-orphans is a no-op (0 removed) when nothing is orphaned", () => {
    const dir = fixture("prune-orphans-noop");
    const finding = sampleFinding({ id: "vi:clean0000000000" });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(finding)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify({
      finding_id: "vi:clean0000000000", verdict: "fixed", reason: "x",
      first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
      content_hash: findingContentHash(finding),
    })}\n`);
    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--prune-orphans"] });
    expect(code).toBe(0);
    expect(out).toContain("removed 0 orphaned triage row(s)");
    const rows = readFileSync(join(dir, "triage.jsonl"), "utf8").trim().split("\n");
    expect(rows).toHaveLength(1);
  });

  it("--prune-orphans removes a historical row only when its exact recorded symbol set has no current match", () => {
    const dir = fixture("prune-true-orphan");
    const current = sampleFinding({ id: "vi:current00000000", affected_nodes: ["sym:current"] });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(current)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify({
      finding_id: "vi:gone0000000000", verdict: "fixed", reason: "human verdict",
      first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
      content_hash: "old", symbol_set: ["sym:removed"],
    })}\n`);

    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--prune-orphans"] });
    expect(code).toBe(0);
    expect(out).toContain("removed 1 orphaned triage row(s)");
    expect(readFileSync(join(dir, "triage.jsonl"), "utf8")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// vi-findings.mjs gate — symbol-set carry-forward
//
// A verdict is bound to WHAT the finding is about (its symbols), not to the
// exact prose that happened to describe it that day. When the content hash
// moves but affected_nodes does not, the prior verdict still applies and the
// gate must say so instead of demanding a fresh human decision.
// ---------------------------------------------------------------------------

describe("vi-findings.mjs gate — symbol-set carry-forward", () => {
  function triageRow(finding, over = {}) {
    return {
      finding_id: finding.id, verdict: "accepted_tradeoff", reason: "x",
      first_seen: "abc", first_seen_date: "2099-01-01", triage_expires: "2099-12-31",
      content_hash: findingContentHash(finding),
      symbol_set: [...(finding.affected_nodes ?? [])].sort(),
      ...over,
    };
  }

  it("CARRIES FORWARD when the symbol set is unchanged but the content hash moved — gate passes and REPORTS the carry", () => {
    const dir = fixture("carry-forward");
    const triaged = sampleFinding({ id: "vi:carry0000000000", affected_nodes: ["sym:a", "sym:b"], observed_model: "5 record(s) match." });
    // Same finding id, same symbols, drifted prose -> different content hash.
    const drifted = sampleFinding({ id: "vi:carry0000000000", affected_nodes: ["sym:a", "sym:b"], observed_model: "affects a wider surface now" });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(drifted)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify(triageRow(triaged))}\n`);

    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(0); // no fresh decision demanded
    // Default output reports the carry as a collapsed count (unchanged carry-forwards
    // are the steady state and are not listed per-finding unless --explain is passed).
    expect(out).toContain("carried forward: 1");
    expect(out).toContain("carried forward on an unchanged symbol set");
    expect(out).not.toContain("verdict carried forward");

    // --explain lists each carried-forward finding with its per-finding detail.
    const { out: explained } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--explain"] });
    expect(explained).toContain("verdict carried forward");
    expect(explained).toContain("symbol set is unchanged (2 symbol(s))");

    const { out: jsonOut } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir }, args: ["--json"] });
    const report = JSON.parse(jsonOut);
    expect(report.ok).toBe(true);
    expect(report.carried_forward).toBe(1);
    expect(report.carried_forward_ids).toEqual(["vi:carry0000000000"]);
  });

  it("still demands a decision when the finding gains a symbol, naming the addition", () => {
    const dir = fixture("carry-gain");
    const triaged = sampleFinding({ id: "vi:gain0000000000", affected_nodes: ["sym:a"] });
    const grown = sampleFinding({ id: "vi:gain0000000000", affected_nodes: ["sym:a", "sym:b"] });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(grown)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify(triageRow(triaged))}\n`);

    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    // The VERDICT is unchanged from when this asserted the older wording: an
    // untriaged member still fails the gate and still needs a human decision.
    // What changed is the ASK — the operator is told which member is new and
    // that their prior verdict still covers the rest, rather than being told
    // the whole verdict no longer applies.
    expect(code).toBe(1);
    expect(out).toContain("sym:b");
    expect(out).toContain("never been triaged");
    expect(out).toContain("already-triaged");
    expect(out).toContain("need a triage decision");
  });

  it("REOPENS when the finding loses a symbol", () => {
    const dir = fixture("carry-lose");
    const triaged = sampleFinding({ id: "vi:lose0000000000", affected_nodes: ["sym:a", "sym:b"] });
    const shrunk = sampleFinding({ id: "vi:lose0000000000", affected_nodes: ["sym:a"] });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(shrunk)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify(triageRow(triaged))}\n`);

    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(1);
    expect(out).toContain("symbol set changed since triage");
    expect(out).toContain("lost sym:b");
    expect(out).toContain("REOPENED");
  });

  it("does NOT reopen on symbol order alone — normalization makes {c,a,b} equal {b,c,a}", () => {
    const dir = fixture("carry-order");
    // Triaged with nodes recorded in one (non-alphabetical) order; the finding
    // now emits the SAME three symbols in a DIFFERENT non-alphabetical order
    // (and prose drifted too, to force a hash mismatch). Neither ordering is
    // pre-sorted, so this only passes if normalization actually sorts both
    // sides rather than happening to agree by coincidence.
    const triaged = sampleFinding({ id: "vi:order0000000000", affected_nodes: ["sym:c", "sym:a", "sym:b"], observed_model: "order A" });
    const reordered = sampleFinding({ id: "vi:order0000000000", affected_nodes: ["sym:b", "sym:c", "sym:a"], observed_model: "order B" });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(reordered)}\n`);
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify(triageRow(triaged))}\n`);

    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(0);
    // Carried forward (order-only change is not a reopen); reported as the
    // collapsed count in default output, per-finding under --explain.
    expect(out).toContain("carried forward: 1");
    expect(out).toContain("carried forward on an unchanged symbol set");
  });

  it("a LEGACY row with no recorded symbol_set falls back to hash-only behavior — REOPENED, never silently carried", () => {
    const dir = fixture("carry-legacy");
    const triaged = sampleFinding({ id: "vi:legacy0000000000", affected_nodes: ["sym:a", "sym:b"], observed_model: "old text" });
    const drifted = sampleFinding({ id: "vi:legacy0000000000", affected_nodes: ["sym:a", "sym:b"], observed_model: "new text" });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(drifted)}\n`);
    const legacyRow = triageRow(triaged);
    delete legacyRow.symbol_set; // simulate a row written before this change
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify(legacyRow)}\n`);

    const { code, out } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(1);
    expect(out).toContain("REOPENED");
    expect(out).toContain("legacy triage row has no recorded symbol set");
    expect(out).not.toContain("carried forward: 1");
  });

  it("a carried-forward verdict's expiry is NOT extended — gate never rewrites triage.jsonl", () => {
    const dir = fixture("carry-expiry");
    const triaged = sampleFinding({ id: "vi:expiry0000000000", affected_nodes: ["sym:a"], observed_model: "old" });
    const drifted = sampleFinding({ id: "vi:expiry0000000000", affected_nodes: ["sym:a"], observed_model: "new" });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(drifted)}\n`);
    const row = triageRow(triaged, { triage_expires: "2099-06-15" });
    writeFileSync(join(dir, "triage.jsonl"), `${JSON.stringify(row)}\n`);
    const before = readFileSync(join(dir, "triage.jsonl"), "utf8");

    const { code } = runViFindings({ env: { REVOY2_VI_FINDINGS_DIR: dir } });
    expect(code).toBe(0);

    const after = readFileSync(join(dir, "triage.jsonl"), "utf8");
    expect(after).toBe(before); // untouched — no rewritten expiry, no rewrite at all
    expect(JSON.parse(after.trim()).triage_expires).toBe("2099-06-15");
  });

  it("--triage writes a normalized (sorted, deduped) symbol_set on the row", () => {
    const dir = fixture("carry-triage-writes-set");
    const finding = sampleFinding({ id: "vi:writes0000000000", affected_nodes: ["sym:b", "sym:a", "sym:a"] });
    writeFileSync(join(dir, "findings.jsonl"), `${JSON.stringify(finding)}\n`);
    runViFindings({
      env: { REVOY2_VI_FINDINGS_DIR: dir },
      args: ["--triage", "vi:writes0000000000", "--verdict", "fixed", "--reason", "x"],
    });
    const row = JSON.parse(readFileSync(join(dir, "triage.jsonl"), "utf8").trim());
    expect(row.symbol_set).toEqual(["sym:a", "sym:b"]);
  });
});

// ---------------------------------------------------------------------------
// findingNeedsTriageDecision / evaluateFindingTriage — the reusable
// per-finding evaluation discharge-catalog.mjs's vi_triage.fix predicate
// consumes, so a "fix" answer discharges on exactly the gate's own pass
// condition rather than a narrower, separately-invented one.
// ---------------------------------------------------------------------------

describe("findingNeedsTriageDecision — the gate's per-finding rule, reusable outside the CLI", () => {
  /** A REPO-shaped fixture (.visual-intelligence/findings/*), distinct from
   * this file's own `fixture()` helper (which IS the findings dir itself, via
   * REVOY2_VI_FINDINGS_DIR) — findingNeedsTriageDecision takes a real repo
   * path, the same shape discharge-catalog.mjs's predicates receive. */
  function repoFixture({ findings = [], triage = [] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "vi-repo-"));
    TMP.push(dir);
    const findingsDir = join(dir, ".visual-intelligence", "findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(join(findingsDir, "findings.jsonl"), findings.map((f) => JSON.stringify(f)).join("\n"));
    writeFileSync(join(findingsDir, "triage.jsonl"), triage.map((r) => JSON.stringify(r)).join("\n"));
    return dir;
  }

  it("returns false when the finding is absent — that is findingClosed's job, not this function's", () => {
    const repo = repoFixture({ findings: [], triage: [] });
    expect(findingNeedsTriageDecision(repo, "vi:gone")).toBe(false);
  });

  it("returns false for a MULTI-SYMBOL finding whose targeted symbol left the set and whose remaining symbols carry a valid verdict", () => {
    // The exact shape of vi:09a11e41a63c075b and vi:73b536233ef07008: the
    // finding is still present (other symbols keep it alive), but the row
    // triaged against the CURRENT symbol set is a real, unexpired,
    // content-hash-matching verdict — the gate itself would not flag it.
    const finding = sampleFinding({
      id: "vi:multi0000000000",
      affected_nodes: ["sym:a", "sym:b", "sym:c"],
    });
    const row = {
      finding_id: finding.id,
      verdict: "false_positive",
      reason: "the remaining symbols are a real false positive",
      triage_expires: "2099-12-31",
      content_hash: findingContentHash(finding),
      symbol_set: ["sym:a", "sym:b", "sym:c"],
    };
    const repo = repoFixture({ findings: [finding], triage: [row] });
    expect(findingNeedsTriageDecision(repo, finding.id)).toBe(false);
  });

  it("returns true for a finding that still needs a decision (untriaged)", () => {
    const finding = sampleFinding({ id: "vi:needs0000000000", affected_nodes: ["sym:a"] });
    const repo = repoFixture({ findings: [finding], triage: [] });
    expect(findingNeedsTriageDecision(repo, finding.id)).toBe(true);
  });

  it("returns true when the finding gained a symbol nobody has triaged", () => {
    const triagedAgainst = sampleFinding({ id: "vi:grown0000000000", affected_nodes: ["sym:a"] });
    const grown = sampleFinding({ id: "vi:grown0000000000", affected_nodes: ["sym:a", "sym:b"] });
    const row = {
      finding_id: grown.id, verdict: "accepted_tradeoff", reason: "x",
      triage_expires: "2099-12-31", content_hash: findingContentHash(triagedAgainst), symbol_set: ["sym:a"],
    };
    const repo = repoFixture({ findings: [grown], triage: [row] });
    expect(findingNeedsTriageDecision(repo, grown.id)).toBe(true);
  });

  it("returns true when the recorded verdict has expired", () => {
    const finding = sampleFinding({ id: "vi:expired0000000000", affected_nodes: ["sym:a"] });
    const row = {
      finding_id: finding.id, verdict: "accepted_tradeoff", reason: "x",
      triage_expires: "2000-01-01", content_hash: findingContentHash(finding), symbol_set: ["sym:a"],
    };
    const repo = repoFixture({ findings: [finding], triage: [row] });
    expect(findingNeedsTriageDecision(repo, finding.id, "2026-01-01")).toBe(true);
  });
});
