// arbor-audit — external ledger-head attestation (E-6, CAVA arXiv 2607.13716).
//
// WHY THIS EXISTS. `tip-sentinel.ts` already defends each campaign's OWN
// ledger against truncation with a sentinel file living beside it
// (`audit-tips/<campaign>.json`). That is real protection, but it shares a
// structural weakness CAVA's "receipt integrity"/"attestation substrate"
// decomposition names directly: the sentinel lives INSIDE the same
// persistence tree the ledger does, sealed by the same process that writes
// the ledger. An attacker (or a bug) with write access to that tree can
// remove or rewrite BOTH the ledger and its sentinel together — documented
// as `audit-ledger-attacks.test.ts`'s own acknowledged structural limit ("no
// anchor outside the store").
//
// This file is a SEPARATE, append-only record — `attestation/heads.jsonl`,
// outside `audit/` and `audit-tips/` — written once per campaign settle
// (`manager.ts`'s `manualHalt`/`completeAutoHalt`). It does not claim to be
// unbreakable either (an attacker with write access to the whole
// persistence tree can still rewrite this file too), but it raises the cost
// of a silent, undetected rewrite from "edit two co-located files" to "edit
// three files, one of which is a chronological log whose earlier entries an
// attacker must also reproduce or explain away" — and it is the seam a
// FUTURE external anchor (a signed remote, a commit) would attach to,
// exactly as `tip-sentinel.ts`'s own header names as this repository's real
// ceiling (ADR-025: report, not prevent).
//
// SHAPE. Every settle appends one row: `{campaign_id, ledger_head_hash,
// entry_count, at}`. Unlike the tip sentinel (one current value per
// campaign, overwritten in place), this is a growing history — a campaign
// halted and later recovered/resumed and re-halted accumulates multiple
// rows, and `arbor ledger verify` cross-checks against the NEWEST matching
// row for that campaign. `classifyLedgerAttestation` proves the ledger's
// state at the attested record index actually matches what was attested —
// not merely that the CURRENT tip matches, which would go blind the moment
// the ledger grows past an attested point.

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalizeForHash as canonicalJson } from "@arbor/core";

export const LEDGER_HEAD_ATTESTATION_KIND = "arbor_ledger_head_attestation" as const;

export interface LedgerHeadAttestation {
  kind: typeof LEDGER_HEAD_ATTESTATION_KIND;
  campaign_id: string;
  /** content_hash of the ledger's last record as of this attestation, or null iff entry_count is 0. */
  ledger_head_hash: string | null;
  /** Number of records this campaign's ledger held as of this attestation. */
  entry_count: number;
  /** ISO 8601 — when the attestation was taken (campaign settle time). */
  at: string;
  /** SHA-256 over every field above. */
  content_hash: string;
}

function attestationDir(dir: string): string {
  return join(dir, "attestation");
}

function attestationPath(dir: string): string {
  return join(attestationDir(dir), "heads.jsonl");
}

function hashAttestation(record: object): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

/**
 * Append one durable attestation row. Fsynced before returning, matching
 * this codebase's "durable before observable" discipline (see
 * `persist.ts`'s header) — a caller that observes a successful return may
 * treat the attestation as surviving a crash.
 */
export function appendLedgerHeadAttestation(
  dir: string,
  campaignId: string,
  ledgerHeadHash: string | null,
  entryCount: number,
  at: string = new Date().toISOString(),
): LedgerHeadAttestation {
  if (typeof campaignId !== "string" || campaignId.trim().length === 0) {
    throw new Error("ledger head attestation requires a non-empty campaign_id");
  }
  if (!Number.isSafeInteger(entryCount) || entryCount < 0) {
    throw new Error("ledger head attestation entry_count must be a non-negative safe integer");
  }
  if ((entryCount === 0) !== (ledgerHeadHash === null)) {
    throw new Error("ledger head attestation ledger_head_hash must be null if and only if entry_count is 0");
  }
  if (Number.isNaN(Date.parse(at))) throw new Error("ledger head attestation 'at' must be ISO-parseable");

  const unhashed = {
    kind: LEDGER_HEAD_ATTESTATION_KIND,
    campaign_id: campaignId,
    ledger_head_hash: ledgerHeadHash,
    entry_count: entryCount,
    at,
  };
  const record: LedgerHeadAttestation = { ...unhashed, content_hash: hashAttestation(unhashed) };

  mkdirSync(attestationDir(dir), { recursive: true });
  const path = attestationPath(dir);
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAttestation(raw: unknown): LedgerHeadAttestation | null {
  if (
    !isRecord(raw)
    || raw.kind !== LEDGER_HEAD_ATTESTATION_KIND
    || typeof raw.campaign_id !== "string"
    || raw.campaign_id.length === 0
    || typeof raw.entry_count !== "number"
    || !Number.isSafeInteger(raw.entry_count)
    || raw.entry_count < 0
    || (typeof raw.ledger_head_hash !== "string" && raw.ledger_head_hash !== null)
    || (raw.entry_count === 0) !== (raw.ledger_head_hash === null)
    || typeof raw.at !== "string"
    || Number.isNaN(Date.parse(raw.at))
    || typeof raw.content_hash !== "string"
  ) {
    return null;
  }
  const { content_hash, ...unhashed } = raw as { content_hash: string } & Record<string, unknown>;
  if (content_hash !== hashAttestation(unhashed)) return null;
  return raw as unknown as LedgerHeadAttestation;
}

export interface AttestationReadResult {
  /** Every valid row for this campaign, in file (append) order. */
  readonly rows: readonly LedgerHeadAttestation[];
  /** Count of lines that failed to parse or validate — never silently dropped. */
  readonly corrupt_lines: number;
}

/** Read every attestation row for one campaign, in append order. Never throws — corruption is reported, not raised. */
export function readLedgerHeadAttestations(dir: string, campaignId: string): AttestationReadResult {
  const path = attestationPath(dir);
  if (!existsSync(path)) return { rows: [], corrupt_lines: 0 };
  const data = readFileSync(path, "utf-8");
  const rows: LedgerHeadAttestation[] = [];
  let corrupt = 0;
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      corrupt += 1;
      continue;
    }
    const attestation = validateAttestation(parsed);
    if (!attestation) {
      corrupt += 1;
      continue;
    }
    if (attestation.campaign_id === campaignId) rows.push(attestation);
  }
  return { rows, corrupt_lines: corrupt };
}

/** The newest attestation row for a campaign, or null if none exist (or the file could not produce one). */
export function latestLedgerHeadAttestation(dir: string, campaignId: string): LedgerHeadAttestation | null {
  const { rows } = readLedgerHeadAttestations(dir, campaignId);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

export type AttestationStatus = "attested" | "unattested" | "attestation_mismatch";

export interface AttestationClassification {
  readonly status: AttestationStatus;
  readonly detail: string | null;
  /** The attestation row this classification was checked against, or null when unattested. */
  readonly attestation: LedgerHeadAttestation | null;
}

/**
 * Cross-check a ledger's actual records against its newest attestation.
 * Unlike a bare tip comparison, this checks the ledger's content_hash AT THE
 * ATTESTED RECORD INDEX — so a ledger that has legitimately grown since its
 * last attestation (a resumed, later re-halted campaign) still verifies,
 * while a ledger truncated or rewritten anywhere at or before that index is
 * caught even if its current tip happens to look plausible.
 */
export function classifyLedgerAttestation(
  dir: string,
  campaignId: string,
  actualRecords: readonly { readonly content_hash: string }[],
): AttestationClassification {
  const attestation = latestLedgerHeadAttestation(dir, campaignId);
  if (!attestation) return { status: "unattested", detail: null, attestation: null };

  if (attestation.entry_count === 0) {
    // An attested empty ledger trivially matches any subsequent prefix.
    return { status: "attested", detail: null, attestation };
  }
  if (actualRecords.length < attestation.entry_count) {
    return {
      status: "attestation_mismatch",
      detail: `ledger has ${actualRecords.length} record(s) but was attested with ${attestation.entry_count} `
        + `at ${attestation.at} (head ${attestation.ledger_head_hash}) — the ledger has fewer records than it `
        + "did when it was durably attested at campaign settle",
      attestation,
    };
  }
  const attestedRecord = actualRecords[attestation.entry_count - 1];
  if (attestedRecord.content_hash !== attestation.ledger_head_hash) {
    return {
      status: "attestation_mismatch",
      detail: `ledger record ${attestation.entry_count} has content hash ${attestedRecord.content_hash} but was `
        + `attested as ${attestation.ledger_head_hash} at ${attestation.at} — the ledger has been rewritten `
        + "since it was durably attested",
      attestation,
    };
  }
  return { status: "attested", detail: null, attestation };
}
