/**
 * scripts/tests/interview-attestation.test.mjs — ADR-158.
 *
 * The property under test is the one the interview skill named and could not
 * enforce: a record that did not come from the recorder must not be able to
 * silence the decision queue. Both directions matter. A gate that cannot fail
 * on a hand-written record proves nothing; a gate that fails on an honest one
 * teaches people to widen the baseline until it stops talking.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const {
  auditInterviewAttestation, canonicalRecordDigest, mintInterviewReceipt,
  readInterviewReceipts, receiptStorePath, attestedRecordDigests, importedRecordDigests,
} = await import(join(ROOT, "scripts", "lib", "interview-receipts.mjs"));
const { coverageIndex, interviewAttestation, readInterviews } = await import(join(ROOT, "scripts", "decision-queue.mjs"));
const { readBaseline } = await import(join(ROOT, "scripts", "interview-attestation-gate.mjs"));
const { recordInterviewAnswer } = await import(join(ROOT, "scripts", "lib", "discharge-store.mjs"));

let repo;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "revoy2-interview-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, "decisions"), { recursive: true });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const record = (over = {}) => ({ held_at: "2026-09-03", covered: ["ADR-900"], outcomes: { "ADR-900": "accept" }, ...over });

describe("canonicalRecordDigest", () => {
  it("is stable under key reordering, so a formatter cannot orphan a record", () => {
    const a = { held_at: "2026-09-03", covered: ["X"], outcomes: { X: "accept" } };
    const b = { outcomes: { X: "accept" }, covered: ["X"], held_at: "2026-09-03" };
    expect(canonicalRecordDigest(a)).toBe(canonicalRecordDigest(b));
  });

  it("ignores receipt_id, which the record cannot know before it is minted", () => {
    const bare = record();
    expect(canonicalRecordDigest({ ...bare, receipt_id: "abc" })).toBe(canonicalRecordDigest(bare));
  });

  it("changes when a recorded answer is edited after the fact", () => {
    // The receipt attests to specific content, not to the fact that some record
    // once existed. Flipping an outcome must orphan it.
    const before = canonicalRecordDigest(record());
    const after = canonicalRecordDigest(record({ outcomes: { "ADR-900": "reject" } }));
    expect(after).not.toBe(before);
  });
});

describe("the receipt store", () => {
  it("round-trips a minted receipt and binds it to the record's content", () => {
    const r = record();
    const id = mintInterviewReceipt(repo, r);
    const store = readInterviewReceipts(repo);
    expect(store.present).toBe(true);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0].receipt_id).toBe(id);
    expect(store.receipts[0].record_digest).toBe(canonicalRecordDigest(r));
  });

  it("lives outside the working tree, so a repo edit cannot produce one", () => {
    expect(receiptStorePath(repo)).toContain(".git");
    expect(receiptStorePath(repo)).not.toContain(join(repo, "decisions"));
  });

  it("reports a malformed line rather than reading it as 'never attested'", () => {
    mintInterviewReceipt(repo, record());
    const path = receiptStorePath(repo);
    writeFileSync(path, `${readFileSync(path, "utf8")}not json\n`);
    const store = readInterviewReceipts(repo);
    expect(store.ok).toBe(false);
    expect(store.malformed).toEqual([2]);
  });

  it("is absent, not broken, on a clone that never recorded an interview", () => {
    expect(readInterviewReceipts(repo)).toMatchObject({ ok: true, present: false, receipts: [] });
  });
});

describe("auditInterviewAttestation", () => {
  const baselineThrough = "2026-08-31";

  it("grandfathers records held on or before the baseline", () => {
    const records = [record({ held_at: "2026-08-30" }), record({ held_at: "2026-08-31" })];
    const result = auditInterviewAttestation({ records, receipts: [], baselineThrough });
    expect(result.ok).toBe(true);
    expect(result.summary.historical).toBe(2);
  });

  it("FAILS a post-baseline record with no receipt — the hand-written case", () => {
    const result = auditInterviewAttestation({ records: [record()], receipts: [], baselineThrough });
    expect(result.ok).toBe(false);
    expect(result.unattested[0]).toMatchObject({ line: 1, held_at: "2026-09-03" });
    expect(result.unattested[0].reason).toMatch(/no receipt/);
  });

  it("passes a post-baseline record that matches a receipt", () => {
    const r = record();
    const receipts = [{ record_digest: canonicalRecordDigest(r) }];
    expect(auditInterviewAttestation({ records: [r], receipts, baselineThrough }).ok).toBe(true);
  });

  it("FAILS a record edited after it was recorded, even though a receipt exists", () => {
    const receipts = [{ record_digest: canonicalRecordDigest(record()) }];
    const tampered = record({ outcomes: { "ADR-900": "reject" } });
    expect(auditInterviewAttestation({ records: [tampered], receipts, baselineThrough }).ok).toBe(false);
  });

  it("reports an undated record rather than waving it through on a missing field", () => {
    const result = auditInterviewAttestation({ records: [record({ held_at: undefined })], receipts: [], baselineThrough });
    expect(result.ok).toBe(false);
    expect(result.unattested[0].reason).toMatch(/no held_at/);
  });
});

describe("recordInterviewAnswer — the sanctioned writer attests its own record", () => {
  it("mints a receipt that matches the ledger line it wrote", () => {
    const { interviewRecord } = recordInterviewAnswer(repo, {
      heldAt: "2026-09-03",
      answers: [{ itemId: "ADR-900", itemKind: "proposed_record", option: "accept", outcome: "accept it" }],
    });
    expect(interviewRecord.receipt_id).toBeTypeOf("string");

    const written = readFileSync(join(repo, "decisions", "interviews.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const store = readInterviewReceipts(repo);
    const result = auditInterviewAttestation({ records: written, receipts: store.receipts, baselineThrough: "2026-01-01" });
    expect(result.ok, JSON.stringify(result.unattested)).toBe(true);
    expect(result.summary.attested).toBe(1);
  });
});

describe("coverageIndex refuses to be silenced by an unattested record", () => {
  const today = "2026-09-03";

  it("covers when the record is attested", () => {
    const r = record();
    const digests = attestedRecordDigests({ receipts: [{ record_digest: canonicalRecordDigest(r) }] });
    const covered = coverageIndex([r], today, { isAttested: (rec) => digests.has(canonicalRecordDigest(rec)) });
    expect(covered.has("ADR-900")).toBe(true);
  });

  it("does NOT cover when the record is unattested", () => {
    // The whole point: a hand-written line must not silence the queue.
    const covered = coverageIndex([record()], today, { isAttested: () => false });
    expect(covered.has("ADR-900")).toBe(false);
  });

  it("keeps prior behaviour when no predicate is supplied", () => {
    expect(coverageIndex([record()], today).has("ADR-900")).toBe(true);
  });
});

describe("the committed baseline", () => {
  it("parses and carries a real date", () => {
    const b = readBaseline();
    expect(b.ok).toBe(true);
    expect(b.through).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(b.raw.adr).toBe(158);
  });

  it("is a blocker when unreadable, never a permissive default", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy2-interview-baseline-"));
    try {
      const p = join(dir, "b.json");
      writeFileSync(p, "{ not json");
      expect(readBaseline(p).ok).toBe(false);
      writeFileSync(p, JSON.stringify({ records_historical_through: "whenever" }));
      expect(readBaseline(p).ok).toBe(false);
      expect(readBaseline(join(dir, "absent.json")).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recording outside a git repository", () => {
  it("refuses, rather than writing a ledger line with no receipt", () => {
    // The silent alternative is the dangerous one: a record with no receipt is
    // indistinguishable from a hand-written one, and nothing would say so.
    const plain = mkdtempSync(join(tmpdir(), "revoy2-interview-nogit-"));
    try {
      mkdirSync(join(plain, "decisions"), { recursive: true });
      expect(() => recordInterviewAnswer(plain, {
        heldAt: "2026-09-03",
        answers: [{ itemId: "ADR-900", itemKind: "proposed_record", option: "accept", outcome: "accept it" }],
      })).toThrow(/require a git repository/);
      expect(existsSync(join(plain, "decisions", "interviews.jsonl"))).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("a fresh clone keeps the coverage its history already has (ADR-158 amendment)", () => {
  // The defect: receipts are per clone. A clone with no store used to treat every
  // record as attested; its FIRST recorded interview created the store, and every
  // earlier post-baseline record then matched no receipt and stopped covering
  // anything at once. Reproduced on this repository's own history in a temp
  // clone on 2026-10-06: 63 covered queue items lost, 9 of them blocking.
  const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
  const answer = (id) => [{ itemId: id, itemKind: "proposed_record", option: "accept", outcome: `accept ${id}` }];
  const workdirs = [];
  afterEach(() => { while (workdirs.length) rmSync(workdirs.pop(), { recursive: true, force: true }); });

  /** A bare "remote" seeded with one post-baseline record recorded in some other clone. */
  function remoteWithHistory() {
    const root = mkdtempSync(join(tmpdir(), "revoy2-interview-clones-"));
    workdirs.push(root);
    const seed = join(root, "seed");
    mkdirSync(join(seed, "decisions"), { recursive: true });
    mkdirSync(join(seed, "scripts", "interview"), { recursive: true });
    g(root, "init", "-q", "-b", "main", seed);
    writeFileSync(join(seed, "scripts", "interview", "baseline.json"), JSON.stringify({ records_historical_through: "2026-08-31" }));
    recordInterviewAnswer(seed, { heldAt: "2026-09-03", answers: answer("ADR-900") });
    writeFileSync(join(seed, "decisions", "discharge-obligations.jsonl"), "");
    g(seed, "add", "-A");
    g(seed, "commit", "-q", "-m", "seed");
    g(root, "clone", "-q", "--bare", seed, join(root, "remote.git"));
    return root;
  }
  const cloneOf = (root, name) => { g(root, "clone", "-q", join(root, "remote.git"), join(root, name)); return join(root, name); };
  const coveredIn = (repo) => {
    const records = readInterviews(repo);
    return [...coverageIndex(records, "2026-09-10", { isAttested: interviewAttestation(repo, records).isAttested }).keys()].sort();
  };

  it("TEETH: recording the clone's first interview leaves earlier records covering", () => {
    const clone = cloneOf(remoteWithHistory(), "fresh");
    expect(readInterviewReceipts(clone).present).toBe(false);
    expect(coveredIn(clone)).toEqual(["ADR-900"]);

    recordInterviewAnswer(clone, { heldAt: "2026-09-05", answers: answer("ADR-901") });
    expect(readInterviewReceipts(clone).present).toBe(true);
    // Before the fix this was ["ADR-901"]: the store's birth un-covered ADR-900.
    expect(coveredIn(clone)).toEqual(["ADR-900", "ADR-901"]);
  });

  it("still refuses a hand-written line, even in a clone whose history is imported", () => {
    const clone = cloneOf(remoteWithHistory(), "fresh");
    const ledger = join(clone, "decisions", "interviews.jsonl");
    writeFileSync(ledger, `${readFileSync(ledger, "utf8")}${JSON.stringify(record({ covered: ["ADR-902"], outcomes: { "ADR-902": "accept" } }))}\n`);
    expect(coveredIn(clone)).toEqual(["ADR-900"]);
  });

  it("does not launder a hand-written line through this clone's own push", () => {
    const root = remoteWithHistory();
    const clone = cloneOf(root, "pusher");
    const ledger = join(clone, "decisions", "interviews.jsonl");
    writeFileSync(ledger, `${readFileSync(ledger, "utf8")}${JSON.stringify(record({ covered: ["ADR-902"], outcomes: { "ADR-902": "accept" } }))}\n`);
    g(clone, "commit", "-q", "-am", "hand-written");
    g(clone, "push", "-q", "origin", "main");
    // The remote-tracking ref now holds the line, but only because THIS clone pushed it.
    expect(coveredIn(clone)).toEqual(["ADR-900"]);
    // A different clone that FETCHED it did receive it through git transport.
    expect(coveredIn(cloneOf(root, "other"))).toEqual(["ADR-900", "ADR-902"]);
  });

  it("names the fetched ref positions it imported from, and imports nothing outside a repository", () => {
    const clone = cloneOf(remoteWithHistory(), "fresh");
    const imported = importedRecordDigests(clone);
    expect(imported.digests.size).toBe(1);
    expect(imported.refs.map((r) => r.ref)).toContain("refs/remotes/origin/HEAD");
    const plain = mkdtempSync(join(tmpdir(), "revoy2-interview-nogit-"));
    workdirs.push(plain);
    expect(importedRecordDigests(plain).digests.size).toBe(0);
  });

  it("the gate counts imported records as attested and says so", () => {
    const clone = cloneOf(remoteWithHistory(), "fresh");
    const records = readInterviews(clone);
    const result = auditInterviewAttestation({ records, receipts: [], baselineThrough: "2026-08-31", imported: importedRecordDigests(clone).digests });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ attested: 0, imported: 1, unattested: 0 });
  });
});
