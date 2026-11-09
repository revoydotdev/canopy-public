/**
 * ledger-command.ts — the operator surface for Track D1/D2's ledger integrity.
 *
 * WHY THIS EXISTS. `performSanctionedRepair` (arbor-audit/src/repair-log.ts) is
 * the only sanctioned way to replace an existing ledger file, and it refuses an
 * unattributed repair. Landed without a caller, it was substrate no operator
 * could reach — the "Unreached" defect shape, and `gate:reachability`'s only
 * violation. It is wired here rather than allowlisted, because the roadmap's own
 * rule is to retire waivers by wiring, not by renewal.
 *
 * Two actions, following ADR-054's positional-action grammar:
 *
 *   ledger verify --dir <d> --campaign <id> [--json]
 *   ledger repair --dir <d> --campaign <id> --reason <r> --actor <a> [--json]
 *
 * `repair` implements §13.5's truncate-and-replay recovery, with the piece that
 * was missing: the repair is impossible without a reason and an actor, and the
 * attempt is journalled before the ledger moves.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  classifyLedgerAttestation, loadLedgerResult, performSanctionedRepair, sweepLedgerAudit,
  type AttestationClassification, type LedgerAuditFinding, type LedgerLoadResult,
} from "@arbor/audit";
import { EXIT_CODES, escalate } from "./exit-codes.js";

export interface LedgerCommandEnvironment {
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
}

interface ParsedFlags {
  readonly values: Readonly<Record<string, string>>;
  readonly json: boolean;
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const values: Record<string, string> = {};
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") { json = true; continue; }
    if (!argument.startsWith("--")) continue;
    const name = argument.slice(2);
    const next = args[index + 1];
    // A flag whose value is missing or is itself a flag records the empty
    // string rather than swallowing the next flag as its value. The caller
    // then rejects it as a usage error instead of proceeding on a wrong value.
    values[name] = next === undefined || next.startsWith("--") ? "" : next;
    if (values[name] !== "") index += 1;
  }
  return { values, json };
}

/**
 * The real commit this repair is attributed to. Never synthesized: an
 * unattributable repair must fail rather than record a placeholder, since the
 * whole purpose of `git_head` is to pin the repair to a reviewable tree state.
 */
function resolveGitHead(cwd: string): string | null {
  try {
    // stdio pipes git's own stderr rather than letting it leak to the
    // operator's terminal: "not a git repository" is an expected outcome here
    // (the persistence dir often is not one), handled by the null return.
    return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function emit(environment: LedgerCommandEnvironment, json: boolean, payload: unknown, human: readonly string[]): void {
  if (json) {
    environment.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  for (const line of human) environment.stdout.write(`${line}\n`);
}

/**
 * `verify` exit codes follow the registry's meaning rather than a boolean:
 *   intact                  -> SUCCESS
 *   sentinel_missing        -> PARTIAL   (verification is incomplete, not failed)
 *   truncated/inconsistent  -> VIOLATION (a real integrity violation was found)
 * A crash is FAILURE, and remains distinguishable from all of the above.
 *
 * E-6 (CAVA 2607.13716): `attestation` is a SECOND, independent axis on top
 * of the tip sentinel — a distinct external anchor written once per campaign
 * settle, outside both `audit/` and `audit-tips/`. `attestation_mismatch` is
 * reported as its own VIOLATION even when the tip sentinel alone reports
 * intact, because the two mechanisms are deliberately not the same file: an
 * attacker (or bug) that only reaches `audit/` and `audit-tips/` but not
 * `attestation/` is exactly the case this second axis exists to catch.
 */
function exitCodeForVerify(result: LedgerLoadResult, attestation: AttestationClassification): number {
  if (attestation.status === "attestation_mismatch") return EXIT_CODES.VIOLATION;
  if (!result.valid) return EXIT_CODES.VIOLATION;
  if (result.tip_status === "sentinel_missing" || attestation.status === "unattested") return EXIT_CODES.PARTIAL;
  return EXIT_CODES.SUCCESS;
}

/**
 * Every campaign ledger file the persistence dir currently holds, excluding
 * ADR-027's reserved `governance` stream (which is not an ordinary campaign
 * and `sweepLedgerAudit` was never designed to read). Mirrors exactly how
 * `saveLedger`/`loadLedgerCore` (arbor-audit/src/persist.ts) name campaign
 * files: `<dir>/audit/<campaign_id>.jsonl`.
 *
 * `corpus` is returned rather than collapsed to a list, because "no campaign
 * ledgers here" and "every campaign ledger here is clean" were the same value
 * here — `[]` — and a caller running `results.every(r => r.findings.length === 0)`
 * over it printed `clean: no cross-record findings` and exited 0. Live in this
 * repository: `.arbor/audit/` does not exist, `gate:ledger-audit` is
 * `required: true` / `effect: blocking` in CI, and it was reporting a passing
 * gate for zero campaigns.
 */
function listCampaignIds(resolvedDir: string): { corpus: "present" | "empty" | "absent"; campaignIds: string[] } {
  const auditDir = join(resolvedDir, "audit");
  if (!existsSync(auditDir)) return { corpus: "absent", campaignIds: [] };
  const campaignIds = readdirSync(auditDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .filter((campaignId) => campaignId !== "governance")
    .sort();
  return { corpus: campaignIds.length > 0 ? "present" : "empty", campaignIds };
}

interface CampaignAuditResult {
  readonly campaign_id: string;
  readonly ledger_valid: boolean;
  readonly record_count: number;
  readonly findings: readonly LedgerAuditFinding[];
}

/**
 * Y-2 (ADR-068): run the deterministic cross-record sweep over one
 * campaign's already-loaded records.
 *
 * `record_count` exists because `loadLedgerCore` returns an EMPTY ledger — no
 * diagnostics, `valid: true`, `tip_status: "sentinel_missing"` — for a campaign
 * whose file does not exist. A sweep over zero records yields zero findings,
 * so `audit <name>` for a campaign that was never recorded reported "clean".
 * Zero records is the absence of evidence to audit, not evidence of integrity.
 *
 * `ledger_valid` DOES drive this command's exit code, which it previously did
 * not. The justification recorded against that decision was that `audit` should
 * not fail on "ledgers that are perfectly intact but merely incomplete for
 * D1/D2 reasons" — but that condition is `tip_status: "sentinel_missing"`,
 * which `loadLedgerResult` documents and implements as deliberately NOT
 * flipping `valid` (persist.ts:218-227, so a legacy ledger keeps verifying).
 * `valid === false` therefore means a quarantined/unparseable chain or a
 * deleted/truncated tip sentinel: real integrity loss. A gate that prints
 * `clean` for it is the same absence-as-clean defect one layer up.
 */
function auditOneCampaign(resolvedDir: string, campaignId: string): CampaignAuditResult {
  const result = loadLedgerResult(resolvedDir, campaignId);
  const records = result.value?.getRecords(campaignId) ?? [];
  return {
    campaign_id: campaignId,
    ledger_valid: result.valid,
    record_count: records.length,
    findings: sweepLedgerAudit(records, campaignId),
  };
}

function humanSummaryLines(results: readonly CampaignAuditResult[], corpus: string): string[] {
  const lines: string[] = [];
  for (const result of results) {
    const blockers = result.findings.filter((finding) => finding.severity === "finding");
    const info = result.findings.filter((finding) => finding.severity === "info");
    lines.push(`campaign: ${result.campaign_id}  ledger_valid=${result.ledger_valid}  records=${result.record_count}  findings=${blockers.length}  info=${info.length}`);
    for (const finding of result.findings) {
      lines.push(`  [${finding.severity}] ${finding.check} (${finding.record_id}): ${finding.detail}`);
    }
  }
  if (corpus !== "present") {
    lines.push(`no campaign corpus: the persistence dir holds ${corpus === "absent" ? "no audit/ directory" : "an audit/ directory with no campaign ledgers"}. `
      + "Nothing was audited — that is UNMEASURED, not clean.");
  } else if (results.some((result) => result.record_count === 0)) {
    lines.push(`unmeasured: ${results.filter((r) => r.record_count === 0).map((r) => r.campaign_id).join(", ")} hold no evidence records — there is nothing to audit, which is not the same as being clean`);
  } else if (results.every((result) => result.findings.length === 0)) {
    lines.push("clean: no cross-record findings");
  }
  return lines;
}

/**
 * D12: the single source of truth for `arbor ledger`'s dispatched actions.
 * Exported so the top-level `arbor --help` summary (cli.ts) can derive its
 * one-line ledger summary from the same list the dispatch below checks,
 * rather than hand-maintaining a second copy that can silently omit a verb
 * (as it did for `audit` — the exact subcommand `gate:ledger-audit` runs).
 */
export const LEDGER_ACTIONS = ["verify", "repair", "audit"] as const;

export function ledgerCommand(args: readonly string[], environment: LedgerCommandEnvironment): number {
  const action = args[0];
  if (!(LEDGER_ACTIONS as readonly string[]).includes(action ?? "")) {
    environment.stderr.write(`Usage: arbor-mcp ledger <${LEDGER_ACTIONS.join("|")}> --dir <persistence-dir> [--campaign <id>|--json]\n`);
    return EXIT_CODES.USAGE;
  }

  if (action === "audit") {
    const rest = args.slice(1);
    const all = rest.includes("--all");
    const { values, json } = parseFlags(rest);
    const dir = values.dir;
    if (!dir) {
      environment.stderr.write("ledger audit: --dir is required\n");
      return EXIT_CODES.USAGE;
    }
    // The campaign id, when present, is always the first token (ADR-054
    // positional-action grammar: `ledger audit <campaign-id> --dir ...`) --
    // never inferred from scanning past flag values, which would risk
    // mistaking a flag's own value for a positional argument.
    const positionalCampaign = rest[0] !== undefined && !rest[0].startsWith("--") ? rest[0] : undefined;
    if (!all && !positionalCampaign) {
      environment.stderr.write("Usage: arbor-mcp ledger audit <campaign-id> --dir <persistence-dir> [--json]\n"
        + "       arbor-mcp ledger audit --all --dir <persistence-dir> [--json]\n");
      return EXIT_CODES.USAGE;
    }
    const resolvedDir = resolve(dir);
    if (!existsSync(resolvedDir)) {
      environment.stderr.write(`ledger audit: persistence directory does not exist: ${resolvedDir}\n`);
      return EXIT_CODES.FAILURE;
    }
    const { corpus, campaignIds } = all ? listCampaignIds(resolvedDir) : { corpus: "present" as const, campaignIds: [positionalCampaign!] };
    const results = campaignIds.map((campaignId) => auditOneCampaign(resolvedDir, campaignId));
    const totalFindings = results.flatMap((result) => result.findings);
    const anyBlocker = totalFindings.some((finding) => finding.severity === "finding");
    const anyInvalid = results.some((result) => !result.ledger_valid);
    const anyUnmeasured = results.some((result) => result.record_count === 0);
    // The JSON payload carries the same verdict the human path states, because a
    // machine reading `ledger_valid: true` with `findings: []` would otherwise
    // read a clean campaign that was in fact never measured.
    const unmeasured = results.filter((result) => result.record_count === 0).map((result) => result.campaign_id);
    const measured = corpus === "present" && unmeasured.length === 0;
    emit(
      environment,
      json,
      {
        dir: resolvedDir,
        all,
        corpus,
        // `false` for an absent corpus or a campaign holding no evidence
        // records. This is the one field a consumer can branch on; the exit
        // code alone already said so, but the payload did not.
        measured,
        unmeasured_campaigns: unmeasured,
        campaigns: results,
      },
      humanSummaryLines(results, corpus),
    );
    // FAILURE, not SUCCESS: `--dir <missing>` returns FAILURE two lines above
    // for the same fact (nothing here to inspect), and SUCCESS is `escalate`'s
    // floor — so defaulting to it here would assert an answer never obtained.
    if (corpus !== "present" && all) return EXIT_CODES.FAILURE;
    return escalate([
      anyBlocker || anyInvalid || anyUnmeasured ? EXIT_CODES.VIOLATION : EXIT_CODES.SUCCESS,
    ]);
  }

  const { values, json } = parseFlags(args.slice(1));
  const dir = values.dir;
  const campaign = values.campaign;
  if (!dir || !campaign) {
    environment.stderr.write("ledger: --dir and --campaign are both required\n");
    return EXIT_CODES.USAGE;
  }
  // `--dir` deliberately is NOT run through `resolvePersistenceDir` (cli.ts),
  // the containment check `run`/`serve`/`webui` apply to their OWN persistence
  // root. That check exists because those entrypoints construct a runtime that
  // OWNS a persistence tree — an implicit/absolute/`..`-escaping value there
  // would make the process write its working state somewhere the operator
  // never declared. `--dir` here names a different kind of thing: an EXISTING
  // ledger this command is pointed AT to inspect or repair — legitimately a
  // backup, or another campaign's persistence tree, anywhere on disk (`ledger
  // verify --dir /var/backups/arbor --campaign c`). Hard-containing it to the
  // working directory would break that real recovery workflow for no security
  // benefit: `verify` only reads, and `repair` already carries its own
  // ledger-specific integrity guard — a repair is refused outright without an
  // attributed `--reason`/`--actor` and a resolvable git HEAD (below), and
  // refused as a CONFLICT if the ledger isn't actually broken. Path containment
  // would be the wrong guard for the wrong resource here. See
  // ledger-command.test.ts's "outside the repo — by design" cases: an absolute
  // path outside `process.cwd()` is exercised and asserted to succeed, so this
  // is a tested exemption, not an unexamined gap.
  const resolvedDir = resolve(dir);
  if (!existsSync(resolvedDir)) {
    environment.stderr.write(`ledger: persistence directory does not exist: ${resolvedDir}\n`);
    return EXIT_CODES.FAILURE;
  }

  let result: LedgerLoadResult;
  try {
    result = loadLedgerResult(resolvedDir, campaign);
  } catch (error) {
    environment.stderr.write(`ledger: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.FAILURE;
  }

  if (action === "verify") {
    const attestation = classifyLedgerAttestation(resolvedDir, campaign, result.value?.getRecords(campaign) ?? []);
    emit(environment, json, {
      campaign, valid: result.valid, tip_status: result.tip_status,
      tip_detail: result.tip_detail, repairs_recorded: result.repairs_recorded, summary: result.summary,
      attestation_status: attestation.status, attestation_detail: attestation.detail,
    }, [
      `campaign:          ${campaign}`,
      `status:            ${result.summary}`,
      `tip sentinel:      ${result.tip_status}${result.tip_detail ? ` — ${result.tip_detail}` : ""}`,
      `recorded repairs:  ${result.repairs_recorded}`,
      `attestation:       ${attestation.status}${attestation.detail ? ` — ${attestation.detail}` : ""}`,
    ]);
    return exitCodeForVerify(result, attestation);
  }

  // --- repair -------------------------------------------------------------
  // Explicit rather than an unnamed implicit tail. Two things depended on
  // this: the parity test derives the handled-action set from these
  // `action === "..."` branches and cannot see a fallthrough, and an action
  // added to LEDGER_ACTIONS with no handler used to land here and run the
  // repair path instead of being refused.
  if (action !== "repair") {
    environment.stderr.write(`ledger: no handler for action "${action}" — this is a dispatch bug, not operator error\n`);
    return EXIT_CODES.USAGE;
  }


  const reason = values.reason;
  const actor = values.actor;
  if (!reason || !actor) {
    // Enforced here as well as in the sanctioned API, so the operator gets a
    // usage error rather than an integrity exception. The API's own refusal is
    // the load-bearing one; this is only a better message.
    environment.stderr.write("ledger repair: --reason and --actor are both required — an unattributed repair is refused\n");
    return EXIT_CODES.USAGE;
  }

  // Refusing to "repair" a ledger that is not broken is a genuine state
  // conflict: the operator's view of the ledger disagrees with what is on
  // disk, and proceeding would journal a repair that repaired nothing.
  if (result.valid && result.tip_status !== "sentinel_missing") {
    environment.stderr.write(
      `ledger repair: refusing — ${campaign} is ${result.summary}. There is nothing to repair, `
      + "so this request and the on-disk state disagree.\n",
    );
    return EXIT_CODES.CONFLICT;
  }

  const surviving = result.value;
  if (!surviving) {
    environment.stderr.write(`ledger repair: ${campaign} has no recoverable records to replay\n`);
    return EXIT_CODES.FAILURE;
  }

  const gitHead = resolveGitHead(resolvedDir) ?? resolveGitHead(process.cwd());
  if (!gitHead) {
    environment.stderr.write(
      "ledger repair: could not resolve git HEAD — refusing rather than recording an unattributable repair\n",
    );
    return EXIT_CODES.FAILURE;
  }

  try {
    const record = performSanctionedRepair(resolvedDir, campaign, surviving, { reason, actor, git_head: gitHead });
    emit(environment, json, { campaign, repaired: true, record }, [
      `repaired:   ${campaign}`,
      `reason:     ${reason}`,
      `actor:      ${actor}`,
      `git_head:   ${gitHead}`,
      "",
      "The repair is journalled in the chained repair log; this ledger will",
      "no longer verify as pristine, and will report its recorded repairs.",
    ]);
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    environment.stderr.write(`ledger repair: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.FAILURE;
  }
}
