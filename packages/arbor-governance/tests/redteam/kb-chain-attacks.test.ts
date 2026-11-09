/**
 * tests/redteam/kb-chain-attacks.test.ts — adversarial probes against
 * arbor-kb's sealed stream format, exercised through its REAL production
 * persistence path (`saveKBProjection` / `loadKBResult` from `@arbor/kb`,
 * which internally call `serializeKBStream`/`parseKBStream`), run against
 * the SAME attack classes as tests/redteam/audit-ledger-attacks.test.ts so
 * the two chains' guarantees can be compared directly.
 *
 * WHY THE PERSISTENCE PATH RATHER THAN THE STREAM FUNCTIONS DIRECTLY: those
 * functions (`serializeKBStream`/`parseKBStream`) live in arbor-kb/src/kb.ts
 * and are NOT re-exported from `@arbor/kb`'s package index — only
 * `saveKB`/`saveKBProjection`/`loadKB`/`loadKBResult` (persist.ts) and the
 * in-memory `KnowledgeBase` are public. Going through the real persistence
 * functions instead of a private, unexported internal is not a workaround —
 * it is a MORE realistic probe: it exercises the exact path a real caller
 * uses (write to disk, corrupt the file, reload), including the
 * quarantine-on-integrity-failure behavior `loadKBResult` layers on top of
 * `parseKBStream`. All I/O here targets a per-test `mkdtempSync` scratch
 * directory — never `.arbor/` or any real ledger.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { KnowledgeBase, KBIntegrityError, saveKBProjection, loadKBResult, type KBEntry } from "@arbor/kb";
import { canonicalizeForHash } from "@arbor/core";
import type { Provenance } from "@arbor/core";

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" };

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-governance-redteam-kb-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function entryInput(type: KBEntry["type"], value: string): Omit<KBEntry, "id" | "created_at"> {
  return {
    campaign_id: "camp1",
    type,
    value,
    provenance: verifiedProv,
    as_of: "iter:1",
    tier: "specialist_visible",
    tags: [],
  };
}

function failureModesFile(): string {
  return join(tempDir, "kb", "failure-modes.jsonl");
}

/** Mirrors kb.ts's private hashKBRecord recipe using only public exports. */
function hashKBRecord(record: object): string {
  return createHash("sha256").update(canonicalizeForHash(record)).digest("hex");
}

describe("redteam/kb-chain: attack 9 — mutate a record's content after seal", () => {
  it("HELD: mutating a persisted entry's content on disk is detected on reload and the file is quarantined", () => {
    const kb = new KnowledgeBase();
    kb.write(entryInput("failure_mode", "original value"));
    kb.write(entryInput("failure_mode", "second value"));
    saveKBProjection(kb, tempDir);

    const filePath = failureModesFile();
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(4); // header + 2 entries + seal
    const record = JSON.parse(lines[2]) as { entry: KBEntry };
    record.entry.value = "TAMPERED";
    lines[2] = JSON.stringify(record);
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const result = loadKBResult(tempDir);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: "integrity_failure", artifact: "knowledge_base" });
    expect(result.diagnostics[0].message).toMatch(/content hash does not match/);
    // The corrupted file is moved aside, never silently trusted as-is.
    expect(existsSync(filePath)).toBe(false);
    expect(result.diagnostics[0].quarantined_path).toBeDefined();
  });
});

describe("redteam/kb-chain: attack 10 — reorder two records", () => {
  it("HELD: swapping two entries on disk is caught by the sequence/predecessor-hash check on reload", () => {
    const kb = new KnowledgeBase();
    kb.write(entryInput("failure_mode", "a"));
    kb.write(entryInput("failure_mode", "b"));
    kb.write(entryInput("failure_mode", "c"));
    saveKBProjection(kb, tempDir);

    const filePath = failureModesFile();
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    [lines[2], lines[3]] = [lines[3], lines[2]];
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const result = loadKBResult(tempDir);
    expect(result.diagnostics[0]?.message).toMatch(/invalid sequence or predecessor hash/);
  });
});

describe("redteam/kb-chain: attack 11 — delete a middle record", () => {
  it("HELD: removing a middle entry on disk is caught on reload", () => {
    const kb = new KnowledgeBase();
    kb.write(entryInput("failure_mode", "a"));
    kb.write(entryInput("failure_mode", "b"));
    kb.write(entryInput("failure_mode", "c"));
    saveKBProjection(kb, tempDir);

    const filePath = failureModesFile();
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    lines.splice(2, 1); // delete the 2nd entry record
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const result = loadKBResult(tempDir);
    expect(result.diagnostics[0]?.message).toMatch(/invalid sequence or predecessor hash/);
  });
});

describe("redteam/kb-chain: attack 12 — truncate the tail (THE key comparison point)", () => {
  it("HELD, unlike the audit ledger: naive tail truncation destroys the terminal seal, and reload refuses to trust the file", () => {
    // This is the crucial structural contrast with EvidenceLedger. The audit
    // ledger's per-record previous_hash/content_hash chain proves nothing
    // about completeness on its own (see audit-ledger-attacks.test.ts attack
    // 12: verifyIntegrity() returns valid:true on a truncated chain). KB's
    // sealed stream format closes that gap for NAIVE truncation (chop bytes
    // off the end of the file) because the seal is the LAST line and
    // carries entry_count + tip_hash for the whole stream: cutting the tail
    // removes the seal itself, so the last remaining line is no longer a
    // valid seal record.
    const kb = new KnowledgeBase();
    for (let i = 0; i < 5; i++) kb.write(entryInput("failure_mode", `entry ${i}`));
    saveKBProjection(kb, tempDir);

    const filePath = failureModesFile();
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1 + 5 + 1); // header + 5 entries + seal

    const truncated = lines.slice(0, -2); // drop the last entry AND the seal
    writeFileSync(filePath, `${truncated.join("\n")}\n`);

    const result = loadKBResult(tempDir);
    expect(result.diagnostics[0]).toMatchObject({ code: "integrity_failure" });
    expect(result.diagnostics[0].message).toMatch(/missing its terminal seal \(possible truncation\)/);
    expect(existsSync(filePath)).toBe(false); // quarantined, not silently loaded
  });

  it("STRUCTURAL LIMIT (shared with the audit ledger): a legitimately re-derived shorter stream is indistinguishable from a truncated-then-resealed one", () => {
    // If an attacker doesn't merely chop bytes but fully re-derives a valid
    // stream for a genuine subset of the original entries, the result is a
    // 100% legitimate-looking sealed file — indistinguishable from a
    // campaign that legitimately only ever had 3 entries. Same fundamental
    // limit as the audit ledger's attack 13 (an unsigned hash chain cannot
    // prove completeness against an attacker who controls the full
        // export/import path): KB's seal defeats naive truncation, not
    // deliberate re-sealing.
    const fewer = new KnowledgeBase();
    fewer.write(entryInput("failure_mode", "entry 0"));
    fewer.write(entryInput("failure_mode", "entry 1"));
    fewer.write(entryInput("failure_mode", "entry 2"));
    saveKBProjection(fewer, tempDir);

    const result = loadKBResult(tempDir);
    expect(result.diagnostics).toHaveLength(0); // no error, no signal of the missing 2 entries
    expect(result.value?.getEntries().filter((e) => e.campaign_id === "camp1" && e.type === "failure_mode")).toHaveLength(3);
  });
});

describe("redteam/kb-chain: attack 13 — splice a record from another stream/type", () => {
  it("HELD: an entry whose recomputed hash is internally valid but whose `type` disagrees with its stream is still rejected", () => {
    // Build a record whose content_hash is HONESTLY recomputed (not just
    // mutated-without-rehashing, which would only prove attack 9 again) but
    // whose entry.type has been switched to a different KB stream's type.
    // This proves the type-consistency check is a REAL, independent guard,
    // not something that only happens to be caught by the hash check.
    const kb = new KnowledgeBase();
    kb.write(entryInput("failure_mode", "the real failure mode"));
    saveKBProjection(kb, tempDir);

    const filePath = failureModesFile();
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    const record = JSON.parse(lines[1]) as { entry: KBEntry; content_hash: string };
    record.entry = { ...record.entry, type: "success_pattern" };
    const { content_hash: _drop, ...unhashed } = record;
    record.content_hash = hashKBRecord(unhashed); // honestly recomputed for the forged type
    lines[1] = JSON.stringify(record);
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const result = loadKBResult(tempDir);
    expect(result.diagnostics[0]).toMatchObject({ code: "integrity_failure" });
    expect(result.diagnostics[0].message).toMatch(/contains an invalid entry/);
  });
});

describe("redteam/kb-chain: attack 14 — previous_hash points at a nonexistent parent", () => {
  it("HELD: a forged (but honestly re-hashed) previous_hash is caught by the sequence/predecessor check", () => {
    const kb = new KnowledgeBase();
    kb.write(entryInput("failure_mode", "a"));
    kb.write(entryInput("failure_mode", "b"));
    kb.write(entryInput("failure_mode", "c"));
    saveKBProjection(kb, tempDir);

    const filePath = failureModesFile();
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    const record = JSON.parse(lines[2]) as { previous_hash: string | null; content_hash: string };
    record.previous_hash = "sha256-orphan-parent-does-not-exist";
    const { content_hash: _drop, ...unhashed } = record;
    record.content_hash = hashKBRecord(unhashed);
    lines[2] = JSON.stringify(record);
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const result = loadKBResult(tempDir);
    expect(result.diagnostics[0]).toMatchObject({ code: "integrity_failure" });
    expect(result.diagnostics[0].message).toMatch(/invalid sequence or predecessor hash/);
  });
});

describe("redteam/kb-chain: attack 15 — replay / duplicate entries", () => {
  it("HELD: a fully chain-valid but duplicate-id record appended to the stream is explicitly rejected, unlike the audit ledger's silent fromJSONL skip", () => {
    const kb = new KnowledgeBase();
    kb.write(entryInput("failure_mode", "a"));
    kb.write(entryInput("failure_mode", "b"));
    saveKBProjection(kb, tempDir);

    const filePath = failureModesFile();
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    // lines: [header, entry1, entry2, seal]
    const entry1 = (JSON.parse(lines[1]) as { entry: KBEntry }).entry;
    const priorTip = (JSON.parse(lines[2]) as { content_hash: string }).content_hash;

    // Forge a THIRD, chain-valid record whose entry.id duplicates entry1's id.
    const forgedUnhashed = { kind: "kb_entry" as const, version: 1, sequence: 3, previous_hash: priorTip, entry: entry1 };
    const forgedRecord = { ...forgedUnhashed, content_hash: hashKBRecord(forgedUnhashed) };

    const seal = JSON.parse(lines[3]) as { kind: string; version: number; stream: string; entry_count: number; tip_hash: string | null };
    const resealedUnhashed = { ...seal, entry_count: 3, tip_hash: forgedRecord.content_hash };
    const { content_hash: _dropSeal, ...resealedRest } = resealedUnhashed as typeof resealedUnhashed & { content_hash?: string };
    const resealed = { ...resealedRest, content_hash: hashKBRecord(resealedRest) };

    const rebuilt = [lines[0], lines[1], lines[2], JSON.stringify(forgedRecord), JSON.stringify(resealed)];
    writeFileSync(filePath, `${rebuilt.join("\n")}\n`);

    const result = loadKBResult(tempDir);
    expect(result.diagnostics[0]).toMatchObject({ code: "integrity_failure" });
    expect(result.diagnostics[0].message).toMatch(/duplicate KB entry id/);
  });

  it("HELD: KnowledgeBase.fromJSONL (in-memory API) throws on conflicting duplicate ids, unlike EvidenceLedger.fromJSONL", () => {
    const kb = new KnowledgeBase();
    const line = JSON.stringify({ ...entryInput("failure_mode", "original"), id: "kb_dup", created_at: "2026-08-01T00:00:00.000Z" });
    const poisoned = JSON.stringify({ ...entryInput("failure_mode", "poisoned"), id: "kb_dup", created_at: "2026-08-01T00:00:00.000Z" });
    expect(kb.fromJSONL(line)).toBe(1);
    expect(() => kb.fromJSONL(poisoned)).toThrow(KBIntegrityError);
    expect(() => kb.fromJSONL(poisoned)).toThrow(/conflicting KB entry for id/);
  });
});

describe("redteam/kb-chain vs audit-ledger: explicit guarantee comparison", () => {
  it("documents the comparison as an executable assertion: KB's sealed format rejects naive tail-truncation on real disk reload; the audit ledger's unsealed chain does not", () => {
    // This exists purely to make the comparison load-bearing in CI, not just
    // prose in a report: if either side's behavior regresses (e.g. someone
    // adds a seal to EvidenceLedger, or removes KB's), this assertion should
    // be revisited.
    const kb = new KnowledgeBase();
    kb.write(entryInput("failure_mode", "a"));
    kb.write(entryInput("failure_mode", "b"));
    saveKBProjection(kb, tempDir);

    const filePath = failureModesFile();
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    const withoutSeal = lines.slice(0, -1); // drop only the seal, keep every entry intact
    writeFileSync(filePath, `${withoutSeal.join("\n")}\n`);

    const result = loadKBResult(tempDir);
    expect(result.diagnostics[0]?.message).toMatch(/possible truncation/);
    // (The audit-ledger equivalent — tail truncation validating as `valid:
    // true` — is asserted directly in audit-ledger-attacks.test.ts's attack
    // 12; it is not re-imported here to keep each redteam file an
    // independent, self-contained probe set.)
  });
});
