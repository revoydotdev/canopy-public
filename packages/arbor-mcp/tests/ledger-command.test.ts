import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { EvidenceLedger, appendLedgerHeadAttestation, loadLedgerResult, saveLedger } from "@arbor/audit";
import { ledgerCommand } from "../src/ledger-command.js";
import { EXIT_CODES } from "../src/exit-codes.js";

function environment(): { env: { stdout: { write(t: string): void }; stderr: { write(t: string): void } }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { env: { stdout: { write: (t) => { out.push(t); } }, stderr: { write: (t) => { err.push(t); } } }, out, err };
}

/** Build a real 5-record ledger on disk, sealed by a real tip sentinel. */
function seedLedger(dir: string, campaign: string): string {
  const ledger = new EvidenceLedger();
  for (let index = 0; index < 5; index += 1) {
    ledger.record({
      campaign_id: campaign,
      node_id: `node-${index}`,
      timestamp: `2026-08-0${index + 1}T00:00:00.000Z`,
      action_description: `action ${index}`,
      action_category: "test",
      specialist_agent: "seed",
      critic_agent: null,
      node_state_before: "expanding",
      node_state_after: "verified",
      provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" },
      specialist_output: "done",
      critic_verdict_approved: true,
      critic_root_cause: null,
      score_before: 0,
      score_after: index,
      gates: [],
      kb_entries_written: [],
    });
  }
  saveLedger(ledger, dir, campaign);
  return join(dir, "audit", `${campaign}.jsonl`);
}

/** E-6: append a matching ledger-head attestation for the ledger `seedLedger` just wrote — as `manager.ts`'s `attestLedgerHead` does on a real campaign settle. */
function attestSeededLedger(dir: string, campaign: string): void {
  const records = loadLedgerResult(dir, campaign).value?.getRecords(campaign) ?? [];
  appendLedgerHeadAttestation(dir, campaign, records.length > 0 ? records[records.length - 1].content_hash : null, records.length);
}

describe("arbor-mcp ledger — the operator surface for D1/D2", () => {
  it("verify reports an intact sealed ledger as SUCCESS", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-cmd-"));
    try {
      seedLedger(dir, "camp");
      attestSeededLedger(dir, "camp");
      const { env, out } = environment();
      const code = ledgerCommand(["verify", "--dir", dir, "--campaign", "camp", "--json"], env);
      expect(code).toBe(EXIT_CODES.SUCCESS);
      const payload = JSON.parse(out.join("")) as { tip_status: string; valid: boolean; repairs_recorded: number; attestation_status: string };
      expect(payload).toMatchObject({ tip_status: "intact", valid: true, repairs_recorded: 0, attestation_status: "attested" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("verify reports an intact but never-attested sealed ledger as PARTIAL, distinct from a crash or a violation", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-cmd-"));
    try {
      seedLedger(dir, "camp");
      const { env, out } = environment();
      const code = ledgerCommand(["verify", "--dir", dir, "--campaign", "camp", "--json"], env);
      expect(code).toBe(EXIT_CODES.PARTIAL);
      const payload = JSON.parse(out.join("")) as { tip_status: string; valid: boolean; attestation_status: string };
      expect(payload).toMatchObject({ tip_status: "intact", valid: true, attestation_status: "unattested" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("E-6: verify FAILS a truncated ledger that carries a durable attestation of its original, longer state", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-cmd-"));
    try {
      const file = seedLedger(dir, "camp");
      attestSeededLedger(dir, "camp");
      // Truncate AFTER attesting — the attack this cycle's E-6 item exists to catch.
      const lines = readFileSync(file, "utf-8").trim().split("\n");
      writeFileSync(file, `${lines.slice(0, 3).join("\n")}\n`, "utf-8");
      const { env, out } = environment();
      const code = ledgerCommand(["verify", "--dir", dir, "--campaign", "camp", "--json"], env);
      expect(code).toBe(EXIT_CODES.VIOLATION);
      const payload = JSON.parse(out.join("")) as { attestation_status: string; attestation_detail: string };
      expect(payload.attestation_status).toBe("attestation_mismatch");
      expect(payload.attestation_detail).toMatch(/fewer records/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("verify reports a tail-truncated ledger as VIOLATION — not as a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-cmd-"));
    try {
      const file = seedLedger(dir, "camp");
      // The attack: drop the last two records. The surviving chain is still
      // internally valid, which is exactly why the external sentinel is needed.
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      writeFileSync(file, `${lines.slice(0, 3).join("\n")}\n`, "utf8");

      const { env, out } = environment();
      const code = ledgerCommand(["verify", "--dir", dir, "--campaign", "camp", "--json"], env);
      expect(code).toBe(EXIT_CODES.VIOLATION);
      expect(code).not.toBe(EXIT_CODES.FAILURE);
      expect(JSON.parse(out.join("")) as { tip_status: string }).toMatchObject({ tip_status: "tail_truncated" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("repair refuses an unattributed request with USAGE, before touching anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-cmd-"));
    try {
      const file = seedLedger(dir, "camp");
      const before = readFileSync(file, "utf8");
      const { env, err } = environment();
      expect(ledgerCommand(["repair", "--dir", dir, "--campaign", "camp", "--actor", "someone"], env))
        .toBe(EXIT_CODES.USAGE);
      expect(err.join("")).toContain("unattributed repair is refused");
      // The ledger is untouched — a refused repair must not be a partial one.
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("repair of an intact ledger is a CONFLICT — the request disagrees with disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-cmd-"));
    try {
      seedLedger(dir, "camp");
      const { env, err } = environment();
      const code = ledgerCommand(
        ["repair", "--dir", dir, "--campaign", "camp", "--reason", "spurious", "--actor", "operator"],
        env,
      );
      // This is the registry's CONFLICT code reached from a real invocation.
      expect(code).toBe(EXIT_CODES.CONFLICT);
      expect(err.join("")).toContain("nothing to repair");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("repair replays a truncated ledger under attribution, and it never verifies as pristine again", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-cmd-"));
    try {
      const file = seedLedger(dir, "camp");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      writeFileSync(file, `${lines.slice(0, 3).join("\n")}\n`, "utf8");
      expect(loadLedgerResult(dir, "camp").tip_status).toBe("tail_truncated");

      const { env } = environment();
      const code = ledgerCommand([
        "repair", "--dir", dir, "--campaign", "camp",
        "--reason", "tail lost to an interrupted write", "--actor", "operator",
      ], env);
      expect(code).toBe(EXIT_CODES.SUCCESS);

      const after = loadLedgerResult(dir, "camp");
      expect(after.valid).toBe(true);
      expect(after.tip_status).toBe("intact");
      // The substance: the repair is visible forever after. A repaired chain
      // that reported as pristine would defeat the entire point of D2.
      expect(after.repairs_recorded).toBe(1);
      expect(after.summary).toContain("1 recorded repair");
      expect(after.summary).not.toBe("intact");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects a missing action and missing required flags as USAGE, not FAILURE", () => {
    const { env } = environment();
    expect(ledgerCommand([], env)).toBe(EXIT_CODES.USAGE);
    expect(ledgerCommand(["frobnicate"], env)).toBe(EXIT_CODES.USAGE);
    expect(ledgerCommand(["verify", "--dir"], env)).toBe(EXIT_CODES.USAGE);
  });

  // ==========================================================
  // `--dir` outside the repo — by design, not by oversight. `resolvePersistenceDir`
  // (cli.ts) contains `run`/`serve`/`webui`'s OWN persistence root to the working
  // directory; `--dir` here names a ledger this command is pointed AT (a backup,
  // another campaign's tree elsewhere on disk), which is a different resource with
  // a different threat model — see this file's own comment above `resolvedDir`.
  // These prove the exemption is real and exercised, not merely an unwritten check:
  // every other test in this file already uses an absolute `tmpdir()` path (outside
  // this repo) for `--dir`; these two assert that fact explicitly and would fail
  // loudly if containment were ever accidentally added here.
  // ==========================================================
  it("verify succeeds on a ledger directory that is genuinely outside the repo — by design", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-cmd-outside-"));
    try {
      expect(relative(process.cwd(), dir).startsWith("..")).toBe(true);
      seedLedger(dir, "camp");
      attestSeededLedger(dir, "camp");
      const { env, out } = environment();
      const code = ledgerCommand(["verify", "--dir", dir, "--campaign", "camp", "--json"], env);
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(JSON.parse(out.join(""))).toMatchObject({ valid: true, tip_status: "intact", attestation_status: "attested" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("repair succeeds on a ledger directory that is genuinely outside the repo — by design", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ledger-cmd-outside-"));
    try {
      expect(relative(process.cwd(), dir).startsWith("..")).toBe(true);
      const file = seedLedger(dir, "camp");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      writeFileSync(file, `${lines.slice(0, 3).join("\n")}\n`, "utf8");

      const { env } = environment();
      const code = ledgerCommand(
        ["repair", "--dir", dir, "--campaign", "camp", "--reason", "outside-repo recovery drill", "--actor", "operator"],
        env,
      );
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(loadLedgerResult(dir, "camp").tip_status).toBe("intact");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
