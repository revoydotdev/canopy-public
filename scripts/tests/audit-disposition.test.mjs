import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAuditDisposition, auditDocuments, dispositionedPaths } from "../audit-disposition.mjs";

/**
 * scripts/tests/audit-disposition.test.mjs — an audit must be answered for.
 *
 * The gap this closes: five audits ran on 2026-08-19 and their findings lived
 * only in a chat transcript, while `gate:decision-queue` reported PASS —
 * because none of the queue's six sources is "an audit produced findings
 * nobody dispositioned". A mechanism that forces dispositions on recorded
 * commitments was busy generating unrecorded ones.
 *
 * The properties worth protecting, in order:
 *   1. An undispositioned audit BLOCKS. Without this the gate is decoration.
 *   2. `none-required` is a real answer. Some audits are censuses or reference
 *      captures; forcing a decision record for those manufactures the
 *      volume-without-signal that trains a reader to skim.
 *   3. The link is DECLARED, never inferred. Guessing which decision answers
 *      which audit from prose similarity would be an unwitnessed claim.
 */

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function fixture({ audits = {}, decisions = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "audit-disposition-"));
  dirs.push(dir);
  mkdirSync(join(dir, "audit"), { recursive: true });
  for (const [name, body] of Object.entries(audits)) writeFileSync(join(dir, "audit", name), body);
  if (Object.keys(decisions).length > 0) {
    mkdirSync(join(dir, "docs/proposals"), { recursive: true });
    for (const [name, body] of Object.entries(decisions)) writeFileSync(join(dir, "docs/proposals", name), body);
  }
  return dir;
}

describe("an audit nobody answered for blocks", () => {
  it("FAILS on an audit document with no decision and no declaration", () => {
    const repo = fixture({ audits: { "findings.md": "# Findings\n\nSomething is wrong.\n" } });
    const report = analyzeAuditDisposition({ repo });
    expect(report.ok).toBe(false);
    expect(report.undispositioned.map((d) => d.path)).toEqual(["audit/findings.md"]);
  });

  it("PASSES once a decisions file declares it arose from that audit", () => {
    const repo = fixture({
      audits: { "findings.md": "# Findings\n" },
      decisions: {
        "operator-decisions-2026-08-19.md":
          "# Operator decisions\n\n<!-- arises-from: audit/findings.md -->\n\n## D1 — do the thing\n",
      },
    });
    const report = analyzeAuditDisposition({ repo });
    expect(report.ok).toBe(true);
    expect(report.dispositioned[0].by).toEqual(["docs/proposals/operator-decisions-2026-08-19.md"]);
  });

  it("PASSES when the document declares it needs no decision, with a reason", () => {
    // A census or a reference capture genuinely produces no decision. Forcing
    // one would manufacture noise, which is how a queue gets ignored.
    const repo = fixture({
      audits: { "census.md": "# Census\n\n<!-- audit-disposition: none-required — a count, not a finding -->\n" },
    });
    const report = analyzeAuditDisposition({ repo });
    expect(report.ok).toBe(true);
    expect(report.none_required[0].none_required_reason).toBe("a count, not a finding");
  });
});

describe("the link is declared, never inferred", () => {
  it("does NOT credit a decisions file that merely mentions the audit's name", () => {
    // Prose similarity is not a disposition. Inferring the link would let a
    // passing mention masquerade as an answer.
    const repo = fixture({
      audits: { "findings.md": "# Findings\n" },
      decisions: { "operator-decisions-2026-08-19.md": "# Decisions\n\nSee audit/findings.md for context.\n" },
    });
    expect(analyzeAuditDisposition({ repo }).ok).toBe(false);
  });

  it("TEETH: reports a decisions file citing an audit that does not exist", () => {
    // This points the WRONG way — it makes a document look answered for when
    // nothing answers for it, so it must be louder than silence.
    const repo = fixture({
      audits: {},
      decisions: { "operator-decisions-2026-08-19.md": "<!-- arises-from: audit/ghost.md -->\n" },
    });
    const report = analyzeAuditDisposition({ repo });
    expect(report.ok).toBe(false);
    expect(report.dangling.map((d) => d.path)).toEqual(["audit/ghost.md"]);
  });

  it("one decisions file can answer for several audits", () => {
    const repo = fixture({
      audits: { "a.md": "# A\n", "b.md": "# B\n" },
      decisions: { "operator-decisions-2026-08-19.md": "<!-- arises-from: audit/a.md audit/b.md -->\n" },
    });
    expect(analyzeAuditDisposition({ repo }).ok).toBe(true);
  });
});

describe("the readers are honest about what they read", () => {
  it("auditDocuments finds only markdown under audit/", () => {
    const repo = fixture({ audits: { "real.md": "# R\n", "notes.txt": "ignored" } });
    expect(auditDocuments(repo).map((d) => d.path)).toEqual(["audit/real.md"]);
  });

  it("dispositionedPaths reads only operator-decisions files", () => {
    const repo = fixture({
      audits: { "a.md": "# A\n" },
      decisions: {
        "operator-decisions-2026-08-19.md": "<!-- arises-from: audit/a.md -->\n",
        "some-other-proposal.md": "<!-- arises-from: audit/ignored.md -->\n",
      },
    });
    const claimed = dispositionedPaths(repo);
    expect([...claimed.keys()]).toEqual(["audit/a.md"]);
  });

  it("an empty repository passes rather than erroring", () => {
    const repo = fixture({});
    expect(analyzeAuditDisposition({ repo }).ok).toBe(true);
  });
});
