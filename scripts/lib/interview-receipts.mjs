/**
 * scripts/lib/interview-receipts.mjs — proof that an interview record came
 * from the sanctioned recorder rather than from a text editor.
 *
 * WHY THIS EXISTS. `decisions/interviews.jsonl` is the artifact that silences
 * `gate:decision-queue`, and until now it was a plain JSONL file any agent
 * could append a line to. The interview skill says so out loud rather than
 * hiding it: "An agent can write that file. That is not a loophole to route
 * around — it is the reason this skill exists." Prose was the only thing
 * standing between a real operator answer and a fabricated one, and a
 * fabricated interview is worse than a red gate, because the red gate is
 * still true.
 *
 * WHAT A RECEIPT IS. `recordInterviewAnswer` mints one every time it writes a
 * ledger record, into the git COMMON dir alongside the evidence-transaction
 * receipts and the stop-guard release journal — outside the working tree, so
 * ordinary repository edits cannot produce one as a side effect. The receipt
 * carries a digest of the exact record bytes. A ledger record whose digest
 * matches no receipt was not written by the recorder.
 *
 * WHAT THIS DOES AND DOES NOT BUY. It does not make forgery impossible: the
 * store is a file on the same disk, and an agent that knows this mechanism
 * exists could write both halves. It changes forgery from "append one line,
 * silently" into "append one line AND mint a matching receipt in a git-internal
 * store," and — the part that actually matters — it makes the mismatch VISIBLE
 * to a gate instead of invisible to everyone. Detection, not prevention.
 *
 * RECORDS THAT ARRIVED FROM ANOTHER CLONE. The receipt store is per-clone, so a
 * record written on one machine has no receipt on another. That used to be
 * papered over by treating a clone with NO store as fully attested — which
 * meant the first interview recorded in a fresh clone flipped attestation on
 * and every earlier post-baseline record stopped covering anything at once
 * (63 covered queue items, 9 of them then blocking, in one step in a fresh
 * clone on 2026-10-06). `importedRecordDigests` closes it
 * without moving the store into the tree: a record is also attested when it is
 * present in the ledger at a remote-tracking ref's last FETCHED position. Such a
 * record was written in some other clone — where its own receipt, and the
 * pre-push `gate:decision-queue` that ignores unattested records, applied — and
 * reached this one through git transport, not through this clone's editor.
 * Positions this clone itself PUSHED are excluded (the reflog says "update by
 * push"), so pushing a hand-written line does not launder it here.
 *
 * WHY IT IS STILL LOCAL-ONLY. Cross-machine proof that a human
 * really answered needs a trusted third party — a signature over a key the
 * agent does not hold, or a CI-side attestation of the kind
 * `enforcement-attestation.mjs` already builds against the GitHub API. That is
 * a strictly larger mechanism and this module does not pretend to it. The
 * verification here is scoped to the machine the agent is running on, which is
 * the machine where a fabrication would happen; importing from a remote trusts
 * that the clone which pushed it ran its own gates.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { canonicalJson } from "../enforcement-control-plane.mjs";

export const RECEIPT_SCHEMA_VERSION = 1;
export const RECEIPT_KIND = "revoy2.interview_receipt";

/** The git common dir, so linked worktrees share one receipt store. */
function commonDir(repo) {
  let out;
  try {
    out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    // Fail closed, loudly. Recording an interview outside a repository would
    // write a ledger line with no receipt -- indistinguishable from a
    // hand-written one, and silently so. Refusing is the honest outcome.
    throw new Error(
      `interview receipts require a git repository (none at ${repo}); ` +
        "the receipt store lives in the git common dir so an ordinary repository edit cannot forge one",
    );
  }
  return isAbsolute(out) ? out : resolvePath(repo, out);
}

/** The git common dir, or null outside a repository (callers that only READ fall back rather than throw). */
function commonDirOrNull(repo) {
  try { return commonDir(repo); } catch { return null; }
}

export function receiptStorePath(repo) {
  return join(commonDir(repo), "arbor", "interviews", "receipts.jsonl");
}

/**
 * The digest a receipt attests to.
 *
 * Computed over the record with `receipt_id` REMOVED and keys sorted, so the
 * value is stable regardless of key order and cannot depend on the receipt id
 * it is about to carry. Any edit to a recorded answer — an outcome flipped, an
 * item added to `covered` — changes this digest and orphans the record from its
 * receipt, which is the point: the receipt attests to specific content, not to
 * the mere fact that some record once existed.
 */
export function canonicalRecordDigest(record) {
  const { receipt_id: _ignored, ...rest } = record ?? {};
  // `canonicalJson` recurses. An earlier version used JSON.stringify's ARRAY
  // replacer to sort keys, which silently filters NESTED keys by the same
  // top-level list -- `outcomes` serialized as `{}`, so flipping a recorded
  // answer from accept to reject left the digest unchanged and tampering was
  // invisible. The tamper test in scripts/tests/interview-attestation.test.mjs
  // is what caught it; it stays as the regression pin.
  return `sha256:${createHash("sha256").update(canonicalJson(rest)).digest("hex")}`;
}

/** Append a receipt for one ledger record and return its id. */
export function mintInterviewReceipt(repo, record, { now = () => new Date().toISOString() } = {}) {
  const path = receiptStorePath(repo);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    receipt_id: randomUUID(),
    recorded_at: now(),
    held_at: record?.held_at ?? null,
    covered: Array.isArray(record?.covered) ? [...record.covered] : [],
    record_digest: canonicalRecordDigest(record),
    writer: { pid: process.pid },
  };
  appendFileSync(path, `${JSON.stringify(receipt)}\n`);
  return receipt.receipt_id;
}

export function readInterviewReceipts(repo) {
  const path = receiptStorePath(repo);
  if (!existsSync(path)) return { ok: true, receipts: [], present: false, malformed: [] };
  const receipts = [];
  const malformed = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    try { receipts.push(JSON.parse(line)); } catch { malformed.push(index + 1); }
  }
  // A malformed receipt line is reported, never skipped: silently dropping one
  // would turn a corrupted store into "this record was never attested".
  return { ok: malformed.length === 0, receipts, present: true, malformed };
}

/**
 * The commit a remote-tracking ref was last FETCHED at, from its reflog: the
 * newest entry not written by this clone's own push. Null when the ref has no
 * reflog or only push entries — provenance this clone cannot establish is not
 * provenance, so such a ref contributes nothing.
 */
function lastFetchedCommit(common, ref) {
  const logPath = join(common, "logs", ref);
  if (!existsSync(logPath)) return null;
  const lines = readFileSync(logPath, "utf8").split("\n").filter((line) => line.trim() !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const [head, message = ""] = lines[index].split("\t");
    if (message.startsWith("update by push")) continue;
    const commit = head.split(" ")[1];
    if (/^[0-9a-f]{40,64}$/.test(commit ?? "") && !/^0+$/.test(commit)) return commit;
  }
  return null;
}

function git(repo, args, input) {
  return execFileSync("git", args, { cwd: repo, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Digests of every ledger record present at a remote-tracking ref's last
 * fetched position — records that reached this clone through git transport.
 *
 * Returns `{ digests, refs }`; `refs` names the ref/commit pairs that
 * contributed, so a gate can say where an attestation came from. Never throws:
 * outside a repository, with no remotes, or on any git failure it returns an
 * empty set, which only ever makes attestation STRICTER.
 */
export function importedRecordDigests(repo, ledgerPath = "decisions/interviews.jsonl") {
  const empty = { digests: new Set(), refs: [] };
  const common = commonDirOrNull(repo);
  if (!common) return empty;
  let refNames;
  try {
    refNames = git(repo, ["for-each-ref", "--format=%(refname)", "refs/remotes/"]).toString("utf8").split("\n").filter(Boolean);
  } catch { return empty; }
  const refs = [];
  for (const ref of refNames) {
    const commit = lastFetchedCommit(common, ref);
    if (commit) refs.push({ ref, commit });
  }
  if (refs.length === 0) return empty;

  // Two git calls however many refs: resolve each commit's ledger blob, then
  // read the distinct blobs. Remote branches mostly share a handful of them.
  const commits = [...new Set(refs.map((r) => r.commit))];
  let blobs;
  try {
    const checked = git(repo, ["cat-file", "--batch-check"], commits.map((c) => `${c}:${ledgerPath}`).join("\n") + "\n").toString("utf8");
    blobs = [...new Set(checked.split("\n").map((line) => line.split(" ")).filter((parts) => parts[1] === "blob").map((parts) => parts[0]))];
  } catch { return empty; }
  if (blobs.length === 0) return { digests: new Set(), refs };
  let raw;
  try { raw = git(repo, ["cat-file", "--batch"], blobs.join("\n") + "\n"); } catch { return empty; }

  const digests = new Set();
  let offset = 0;
  while (offset < raw.length) {
    const headerEnd = raw.indexOf(0x0a, offset);
    if (headerEnd < 0) break;
    const [, type, size] = raw.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (type !== "blob") { offset = headerEnd + 1; continue; }
    const length = Number(size);
    const content = raw.subarray(headerEnd + 1, headerEnd + 1 + length).toString("utf8");
    offset = headerEnd + 1 + length + 1;
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      try { digests.add(canonicalRecordDigest(JSON.parse(line))); } catch { /* a malformed historical line attests nothing */ }
    }
  }
  return { digests, refs };
}

/**
 * Which ledger records are attested, as a pure function.
 *
 * Records at or before `baselineThrough` are HISTORICAL: they predate the
 * recorder minting receipts at all, and rejecting them would fail every clone
 * forever over records nobody can retroactively attest. Records after it must
 * match a receipt by digest, or — when `imported` (a digest set from
 * `importedRecordDigests`) is supplied — have arrived from another clone.
 */
export function auditInterviewAttestation({ records, receipts, baselineThrough, imported = null }) {
  const byDigest = new Map();
  for (const receipt of receipts ?? []) {
    if (typeof receipt?.record_digest === "string") byDigest.set(receipt.record_digest, receipt);
  }
  const unattested = [];
  let historical = 0;
  let attested = 0;
  let importedCount = 0;
  for (const [index, record] of (records ?? []).entries()) {
    const heldAt = record?.held_at ?? "";
    if (heldAt && heldAt <= baselineThrough) { historical += 1; continue; }
    const digest = canonicalRecordDigest(record);
    if (byDigest.has(digest)) { attested += 1; continue; }
    if (imported?.has(digest)) { importedCount += 1; continue; }
    unattested.push({
      line: index + 1,
      held_at: record?.held_at ?? null,
      covered: Array.isArray(record?.covered) ? record.covered : [],
      record_digest: digest,
      // An undated record cannot be placed against the baseline at all, so it
      // is reported rather than waved through on a missing field.
      reason: heldAt ? "no receipt matches this record's content" : "record carries no held_at, so it cannot be dated against the baseline",
    });
  }
  return {
    ok: unattested.length === 0,
    unattested,
    summary: { total: (records ?? []).length, historical, attested, imported: importedCount, unattested: unattested.length },
  };
}

/** Digests of every attested record, for callers that must ignore the rest. */
export function attestedRecordDigests({ receipts }) {
  return new Set((receipts ?? []).map((r) => r?.record_digest).filter((d) => typeof d === "string"));
}
