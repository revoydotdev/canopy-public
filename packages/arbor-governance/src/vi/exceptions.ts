/**
 * vi/exceptions.ts — port of the revoy2-visual-intelligence skill's
 * `extract-exceptions.mjs` into `@arbor/governance`.
 *
 * revoy2 already has a real, dated, expiring exception mechanism:
 * `scripts/reachability/allowlist.json`, whose expiry is enforced at
 * `reachability.mjs`. This module MIRRORS it — it never creates a second
 * store. Two stores means two truths, and the older one silently wins.
 *
 * It also checks the one property that store lacks. The repository's own
 * gap taxonomy names it M-G, "unresolvable waiver authority": a waiver whose
 * gap/ADR reference does not resolve to a known G-id (from ROADMAP.md) or
 * ADR (from decisions/). A waiver citing nothing grants nothing. The
 * allowlist also has no `owner` field, so every entry is reported as
 * unowned in the summary below — the concrete, mechanical form of a gap
 * prose audits have already identified.
 *
 * Computation only: this module never writes exceptions.jsonl to disk (the
 * original script did). The integrator owns the write side, so this stays
 * testable without touching the filesystem beyond reading the allowlist and
 * the repository's authority sources.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactIdentity, GovernanceResult, PolicyFinding, Severity } from "../contracts.js";
import { contentHashOfString, createArtifactIdentity, symbolId } from "../artifact/identity.js";

export const EXCEPTION_EXTRACT_CAPABILITY = "vi.exceptions.extract";
export const EXCEPTION_EXTRACT_PRODUCER = "arbor-governance/vi/exceptions@1";

/** Mismatch class ids from this repository's own gap taxonomy (see the module header). */
export const RULE_UNRESOLVED_AUTHORITY = "M-G";
export const RULE_EXPIRY = "M-H";

/**
 * Default allowlist path and decisions directory — revoy2's own convention,
 * and `DEFAULT_PROFILE`'s values (`scripts/lib/project-profile.mjs`). Both
 * are overridable per-call via `ExtractExceptionsOptions` so a foreign
 * project whose `arbor.profile.jsonc` names a different waiver store or
 * decisions directory is honored rather than silently ignored (see this
 * module's `extractExceptions`).
 */
export const ALLOWLIST_PATH = "scripts/reachability/allowlist.json";
/**
 * Default ROADMAP.md path, overridable via `ExtractExceptionsOptions.roadmapPath`.
 *
 * Deliberately NOT threaded from `arbor.profile.jsonc` the way `allowlistPath`
 * and `decisionsDir` are. Those two are structural governance facts every
 * ADR-073-conformant project has by definition (a waiver store, a decisions
 * directory) — the profile just names where. A roadmap is not that kind of
 * fact: a foreign project may have no roadmap document at all, so there is
 * nothing universal to schematize. Making this an option (rather than a
 * profile field) still removes the hardcoding — a caller with an unusually
 * named roadmap can point at it — without asserting every governed project
 * has one. See this module's `knownAuthorityIds`: a missing ROADMAP.md at
 * this path already degrades honestly today (no G-ids contribute to the
 * resolution set, so citations to them correctly report unresolved rather
 * than silently resolving) — that behavior is what makes (b) safe here, vs.
 * a probe that would fabricate a zero.
 */
const ROADMAP_PATH = "ROADMAP.md";
const DECISIONS_DIR = "decisions";
const WARN_DAYS = 14;
const DAY_MS = 86_400_000;

/** The shape `scripts/reachability/allowlist.json`'s `.entries` array actually has today. */
export interface AllowlistEntry {
  readonly symbol: string;
  readonly file: string;
  readonly reason?: string;
  readonly gap?: string;
  readonly adr?: string;
  readonly owner?: string;
  readonly created?: string;
  readonly expires?: string;
  readonly remediation?: string;
}

/** One mirrored waiver, addressable independent of the allowlist's own array index staying stable. */
export interface ExceptionRecord {
  readonly id: string;
  readonly invariant: "INV-02";
  /** `sym:<file>::<symbol>` — the waived artifact this exception scopes to. */
  readonly scope: string;
  readonly reason: string;
  readonly owner: string | null;
  /** `gap ?? adr ?? null` — whichever authority reference the entry cited, if any. */
  readonly authority: string | null;
  /** Whether `authority` resolves to a real G-id (ROADMAP.md) or ADR (decisions/). */
  readonly authority_resolves: boolean;
  readonly created: string | null;
  readonly expires: string | null;
  readonly linked_issue: string | null;
  readonly remediation: string;
  /** Link, never duplicate: the allowlist stays the store of record. */
  readonly mirrors: string;
}

export interface ExceptionExtractionSummary {
  readonly source: string;
  readonly total: number;
  readonly unresolved_authority: number;
  readonly unowned: number;
  readonly expired: number;
  readonly expiring_within_days: { readonly days: number; readonly count: number };
  readonly no_expiry: number;
}

export interface ExceptionExtraction {
  readonly records: readonly ExceptionRecord[];
  readonly summary: ExceptionExtractionSummary;
  readonly findings: readonly PolicyFinding[];
}

export interface ExtractExceptionsOptions {
  /** "YYYY-MM-DD". Expiry comparisons are relative to this — this module reads no clock of its own. */
  readonly today: string;
  /** ISO-8601 timestamp stamped on every finding's EvidenceRef.at. */
  readonly at: string;
  /**
   * Repo-relative path to the waiver store this module mirrors. Defaults to
   * `ALLOWLIST_PATH` (`scripts/reachability/allowlist.json`, revoy2's own
   * convention and `arbor.profile.jsonc`'s `governance.allowlist_path`
   * default), so an omitted option behaves exactly as before this option
   * existed.
   */
  readonly allowlistPath?: string;
  /**
   * Repo-relative directory holding this project's ADR/decision records —
   * `arbor.profile.jsonc`'s `governance.decisions_dir`. Defaults to
   * `"decisions"`, matching `DEFAULT_PROFILE`.
   */
  readonly decisionsDir?: string;
  /**
   * Repo-relative path to the roadmap document `knownAuthorityIds` mines for
   * `G-\d{2}` ids. Defaults to `ROADMAP_PATH` (`"ROADMAP.md"`), so an omitted
   * option behaves exactly as before this option existed. Deliberately NOT a
   * profile field — see `ROADMAP_PATH`'s doc comment for why.
   */
  readonly roadmapPath?: string;
}

function readAllowlistEntries(repoRoot: string, allowlistPath: string): GovernanceResult<readonly AllowlistEntry[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(repoRoot, allowlistPath), "utf8"));
  } catch (err) {
    return {
      ok: false,
      error: { code: "unavailable", message: `cannot read ${allowlistPath}: ${(err as Error).message}`, at: allowlistPath },
      capability: EXCEPTION_EXTRACT_CAPABILITY,
    };
  }
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    return {
      ok: false,
      error: { code: "validation", message: `${allowlistPath} has no .entries array`, at: allowlistPath },
      capability: EXCEPTION_EXTRACT_CAPABILITY,
    };
  }
  return { ok: true, value: entries as AllowlistEntry[], capability: EXCEPTION_EXTRACT_CAPABILITY };
}

/**
 * Authority resolution set: every gap id and ADR id this waiver mechanism
 * can cite. Sourced from ROADMAP.md (G-ids, exactly two digits — the
 * original script's own pattern) and decisions/ (ADR-ids, exactly three
 * digits) — deliberately the SAME two sources `extract-exceptions.mjs` used,
 * not `baseline.mjs`'s sibling probe (decisions/ + audit/10-gap-register.md),
 * because the two scripts answer different questions: this one asks "does
 * this waiver's citation resolve to anything real", baseline.ts asks "is the
 * gap register itself internally consistent". Keeping the sources distinct
 * is a deliberate port decision, not an oversight — see this package's
 * final report for the cross-script disagreement this produces.
 */
function knownAuthorityIds(repoRoot: string, decisionsDir: string, roadmapPath: string): ReadonlySet<string> {
  const known = new Set<string>();
  try {
    const roadmap = readFileSync(join(repoRoot, roadmapPath), "utf8");
    for (const m of roadmap.matchAll(/\bG-\d{2}\b/g)) known.add(m[0]);
  } catch {
    // no ROADMAP.md — nothing to add; every waiver's gap citation reports unresolved
  }
  try {
    for (const name of readdirSync(join(repoRoot, decisionsDir))) {
      const m = /^ADR-(\d{3})/.exec(name);
      if (m) known.add(`ADR-${m[1]}`);
    }
  } catch {
    // no decisions/ — nothing to add
  }
  return known;
}

/** Mirrors scan.ts's own convention for deriving a package name from a repo-relative src path. */
function packageNameFromFilePath(relPath: string): string | null {
  const match = /^packages\/([^/]+)\/src\//.exec(relPath);
  return match ? match[1] : null;
}

/**
 * Build the ArtifactIdentity a finding about this waiver attaches to.
 * Hashes the real file bytes when the referenced file still exists;
 * otherwise falls back to hashing the scope string itself (a stale waiver
 * referencing a deleted file is exactly the kind of drift a finding should
 * surface, not one that should throw before the finding can be built).
 */
function buildSubjectIdentity(repoRoot: string, file: string, symbol: string): ArtifactIdentity {
  const scope = `sym:${file}::${symbol}`;
  let contentHash: string;
  try {
    contentHash = contentHashOfString(readFileSync(join(repoRoot, file), "utf8"));
  } catch {
    contentHash = contentHashOfString(scope);
  }
  const pkg = packageNameFromFilePath(file);
  return createArtifactIdentity({
    kind: "symbol",
    path: file,
    symbol_id: pkg ? symbolId(pkg, symbol) : null,
    content_hash: contentHash,
  });
}

function toSeverity(original: "critical" | "high" | "medium"): Severity {
  // PolicyFinding's Severity has no "critical"/"medium" — collapse onto the
  // three-level scale contracts.ts defines. An expired waiver is the one
  // case treated as a blocker; everything else here is a warning, matching
  // this module's is_legacy_debt: true framing (existing debt to resolve,
  // not a new violation to gate on).
  return original === "critical" ? "blocker" : "warning";
}

/**
 * Mirror every entry in `scripts/reachability/allowlist.json` into an
 * `ExceptionRecord`, and flag every waiver whose authority citation does not
 * resolve (M-G) or whose expiry is missing/past (M-H) as a `PolicyFinding`.
 * Pure function of `repoRoot`'s on-disk content plus the supplied
 * `today`/`at` — no clock, no write.
 */
export function extractExceptions(
  repoRoot: string,
  options: ExtractExceptionsOptions,
): GovernanceResult<ExceptionExtraction> {
  const allowlistPath = options.allowlistPath ?? ALLOWLIST_PATH;
  const decisionsDir = options.decisionsDir ?? DECISIONS_DIR;
  const roadmapPath = options.roadmapPath ?? ROADMAP_PATH;
  const entriesResult = readAllowlistEntries(repoRoot, allowlistPath);
  if (!entriesResult.ok) return entriesResult;
  const entries = entriesResult.value;

  const known = knownAuthorityIds(repoRoot, decisionsDir, roadmapPath);
  const records: ExceptionRecord[] = [];
  const findings: PolicyFinding[] = [];
  let unresolvedAuthority = 0;
  let unowned = 0;
  let expired = 0;
  let expiringSoon = 0;
  let noExpiry = 0;

  entries.forEach((e, i) => {
    const authority = e.gap ?? e.adr ?? null;
    const resolves = authority !== null && known.has(authority);
    const subject = buildSubjectIdentity(repoRoot, e.file, e.symbol);
    const evidenceRef = `${allowlistPath} entry ${i} (${e.file}::${e.symbol})`;

    if (!authority || !resolves) {
      unresolvedAuthority++;
      findings.push({
        rule_id: RULE_UNRESOLVED_AUTHORITY,
        severity: toSeverity(authority ? "medium" : "high"),
        subject,
        detail: authority
          ? `waiver authority '${authority}' does not resolve to any known G-id or ADR`
          : `waiver has no authority reference at all`,
        remediation: `Cite a real G-id (ROADMAP.md) or ADR (decisions/) as this waiver's authority, or remove the waiver.`,
        evidence: [{ kind: "code_location", ref: evidenceRef, producer: EXCEPTION_EXTRACT_PRODUCER, at: options.at }],
        waiver_eligible: false,
        is_legacy_debt: true,
      });
    }

    if (!e.owner) unowned++;

    if (!e.expires) {
      noExpiry++;
      findings.push({
        rule_id: RULE_EXPIRY,
        severity: toSeverity("high"),
        subject,
        detail: `waiver has no expiry — a permanent exception is an invariant change, not an exception`,
        remediation: `Add an "expires" date to this waiver, or promote it to a real invariant change.`,
        evidence: [{ kind: "code_location", ref: evidenceRef, producer: EXCEPTION_EXTRACT_PRODUCER, at: options.at }],
        waiver_eligible: false,
        is_legacy_debt: true,
      });
    } else {
      const days = Math.round((Date.parse(e.expires) - Date.parse(options.today)) / DAY_MS);
      if (days < 0) {
        expired++;
        findings.push({
          rule_id: RULE_EXPIRY,
          severity: toSeverity("critical"),
          subject,
          detail: `waiver EXPIRED ${-days} day(s) ago (${e.expires})`,
          remediation: `Renew this waiver's expiry, resolve the underlying gap, or remove the waiver.`,
          evidence: [{ kind: "code_location", ref: evidenceRef, producer: EXCEPTION_EXTRACT_PRODUCER, at: options.at }],
          waiver_eligible: false,
          is_legacy_debt: true,
        });
      } else if (days <= WARN_DAYS) {
        expiringSoon++;
      }
    }

    records.push({
      id: `exc-${String(i + 1).padStart(4, "0")}`,
      invariant: "INV-02",
      scope: `sym:${e.file}::${e.symbol}`,
      reason: e.reason ?? "(none recorded)",
      owner: e.owner ?? null,
      authority,
      authority_resolves: resolves,
      created: e.created ?? null,
      expires: e.expires ?? null,
      linked_issue: e.gap ?? null,
      remediation: e.remediation ?? "(none recorded)",
      mirrors: allowlistPath,
    });
  });

  return {
    ok: true,
    value: {
      records,
      summary: {
        source: allowlistPath,
        total: entries.length,
        unresolved_authority: unresolvedAuthority,
        unowned,
        expired,
        expiring_within_days: { days: WARN_DAYS, count: expiringSoon },
        no_expiry: noExpiry,
      },
      findings,
    },
    capability: EXCEPTION_EXTRACT_CAPABILITY,
  };
}
