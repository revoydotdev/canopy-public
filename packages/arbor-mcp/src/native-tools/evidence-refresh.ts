/**
 * evidence-refresh.ts — mechanizes the three ordering constraints an operator
 * previously carried only in their head when refreshing the repository's
 * committed evidence stores (`.visual-intelligence/observed/`,
 * `.claim-ledger/`, `.completion-depth/`, `.determinism-baseline/`).
 *
 * THE PROBLEM THIS EXISTS FOR. `bun run gate:store-freshness`
 * (`scripts/store-freshness-gate.mjs`) tells an operator which stores are
 * stale and the exact refresh command for each, but the refresh sequence
 * itself has three non-obvious rules. On 2026-08-15 an operator ran the
 * sequence by hand roughly ten times and broke all three, each costing a
 * confusing debug cycle (constraint 3 is documented at
 * `EvidenceGraphPrecheck`, where the mechanism it guards against lives):
 *
 *   1. `determinism:refresh` (`scripts/determinism-baseline.ts --refresh`)
 *      runs real tests and bakes whatever it observes into the committed
 *      baseline. Refreshing while a test is red records the failure as a
 *      legitimate recorded flake, which then fails `gate:determinism` later
 *      and looks like a brand-new regression. Fix red tests FIRST, capture
 *      the determinism baseline SECOND.
 *   2. `gate:store-freshness` compares the working tree against COMMITTED
 *      stores (git-tracked bytes), so refresh-then-verify without an
 *      intervening commit always reports stale. Verification before commit
 *      is meaningless.
 *
 * Neither rule was encoded anywhere; this module encodes both — routine
 * `auto`/`all` closure never selects determinism, while an explicitly requested
 * determinism refresh refuses unless it has just observed the suite green.
 * Rule 2 is surfaced plainly in every result
 * (it never runs `git commit` itself; committing a refreshed store is the
 * operator's authority, not this tool's).
 *
 * WHY A SINGLE-PASS SUITE RUN, NOT THE FULL REPEATED DETERMINISM MEASURE.
 * `determinism:refresh` itself runs vitest three times per cited seam to
 * measure flake rate (see `scripts/determinism-baseline.ts`) — that
 * triple-repeat is its own job, not this gate's. Proving "is the suite red
 * right now" only needs one pass. Running the WHOLE suite once (`bun run
 * test`) rather than only the seams the existing baseline happens to cite is
 * the deliberately more expensive but strictly more honest choice: a newly
 * red test outside the current citation set would otherwise sail through
 * undetected and still get baked in as soon as `determinism-baseline.ts`
 * expands its own seam discovery. The tradeoff is one real vitest run
 * (documented, not free) traded for not silently laundering a red test into
 * committed evidence.
 *
 * This module is intentionally pure with respect to process execution: the
 * caller supplies a `run` function, so the core planning/sequencing logic
 * (which is the part with the two constraints worth testing) can be
 * exercised without spawning real child processes. The native tool host
 * (`../native-tool-host.ts`) wires `run` to its sandbox broker.
 */

export type EvidenceStoreName = "claim-ledger" | "completion-depth" | "vi-observed" | "determinism-baseline";

export const EVIDENCE_STORE_NAMES: readonly EvidenceStoreName[] = Object.freeze([
  // Execution order is dependency order. Runtime observations are inputs to
  // the claim and completion projections, so writing them later would make a
  // successful refresh stale on arrival.
  "vi-observed",
  "claim-ledger",
  "completion-depth",
  "determinism-baseline",
]);

/** ADR-034: determinism is manual measurement, never automatic closure. */
export const AUTOMATED_EVIDENCE_STORE_NAMES: readonly EvidenceStoreName[] = Object.freeze([
  "vi-observed",
  "claim-ledger",
  "completion-depth",
]);

/** The exact human remedy command for each store, mirroring package.json's own script names. */
const REFRESH_ARGV: Record<EvidenceStoreName, readonly [string, ...string[]]> = {
  "claim-ledger": ["bun", "run", "claims:refresh"],
  "completion-depth": ["bun", "run", "completion-depth:refresh"],
  "vi-observed": ["bun", "run", "vi:observe"],
  "determinism-baseline": ["bun", "run", "determinism:refresh"],
};

const REFRESH_COMMAND_LABEL: Record<EvidenceStoreName, string> = {
  "claim-ledger": "bun run claims:refresh",
  "completion-depth": "bun run completion-depth:refresh",
  "vi-observed": "bun run vi:observe",
  "determinism-baseline": "bun run determinism:refresh",
};

/** The single-pass suite-green check gating `determinism:refresh` (see module header for why single-pass). */
const SUITE_CHECK_ARGV: readonly [string, ...string[]] = ["bun", "run", "test"];

/**
 * ADR-079: assertions this action is structurally incapable of clearing, and
 * which therefore must not gate it.
 *
 * A precondition may only include assertions the gated action can satisfy. An
 * assertion it cannot satisfy is not a safety check — it is a deadlock.
 *
 * `gate-failure-modes.test.mjs` asserts that `store-freshness-gate` exits 0
 * against the **committed** stores. This tool deliberately never commits
 * (constraint 2 — committing a refreshed store is the operator's authority),
 * so that assertion stays red until a human commits, no matter how many times
 * the refresh runs. On 2026-08-18 that deadlocked twice in one session: the
 * determinism baseline was stale, which made this test red, which refused the
 * refresh that would have fixed it. Both times the operator broke the cycle
 * with the documented per-store fallback — and a guard whose escape hatch is
 * used every time it fires is a toll, not a protection.
 *
 * The whole suite still runs, and every other red test still refuses. Only the
 * FAILURE SET is filtered, never the collection set — narrowing collection was
 * rejected because vitest's CLI `--exclude` REPLACES the config's exclude list
 * (verified: it pulls the `bun:test` files back in), which would force this
 * module to duplicate `vitest.config.ts`'s excludes and drift from them.
 *
 * Declared, not inferred. Each member states why the action cannot clear it.
 * Growth here is a signal to re-examine, not a routine edit.
 *
 * DESIGN CHOICE RECORDED FOR REGISTER ITEM 11 (2026-08-24, reproduced again
 * after two more packages/ commits landed without an intervening evidence
 * rebind). Re-evaluated the three options against the same 2026-08-18
 * incident:
 *   (a) make `gate-failure-modes.test.mjs` itself transaction-aware (assert
 *       against the transaction's refreshed working-tree stores when
 *       `REVOY_EVIDENCE_TRANSACTION_ID` is present) — REJECTED. It would
 *       require the self-test to trust an env var to change what "clean"
 *       means, and the self-test's whole point (module header, above) is
 *       that a gate that can be talked out of failing is asleep. Softening
 *       its own assertion is exactly that.
 *   (b) exclude the one self-test from the orchestrator's suite-green gate,
 *       by file name, with the reasoning on record — CHOSEN (already in
 *       place; this item hardens its legibility, see
 *       `POST_COMMIT_RECOVERY_NOTE` below, and adds `bun run evidence:rebind`
 *       as the one command an agent can always reach for instead of the
 *       five-producer sequence).
 *   (c) tolerate staleness only for inputs changed since the last store
 *       commit, inside a transaction — REJECTED as strictly more complex
 *       than (b) for the same outcome: it would require this module to
 *       reconstruct "which inputs changed since the last store commit,"
 *       which is exactly what `store-freshness-gate.mjs`'s content hash
 *       already answers authoritatively (see its module header) — a second,
 *       parallel staleness computation here would be a second definition to
 *       keep in sync, the same anti-pattern `citedSeams()` in
 *       `determinism-baseline.ts` was written to avoid.
 * Outside this orchestrator, `gate-failure-modes.test.mjs` is untouched and
 * stays exactly as strict as it always was — verified in
 * `evidence-refresh.test.ts`'s "design choice" describe block, which asserts
 * the exclusion's behavior is identical whether or not `transaction_snapshot`
 * is set (it reads no transaction state at all).
 */
export const SUITE_CHECK_EXCLUSIONS: readonly { readonly match: string; readonly why: string }[] = Object.freeze([
  Object.freeze({
    match: "gate-failure-modes.test.mjs",
    why: "asserts committed-store freshness; clearing it requires a commit, and this tool holds no commit authority (constraint 2)",
  }),
]);

/**
 * The FILE paths of failing suites, which is the only form that can be matched
 * against the exclusion set.
 *
 * Vitest renders each failure TWICE: a `×` line carrying just the
 * describe/test name, and a `FAIL` line carrying `<file> > <test>`. Only the
 * latter names the file. Matching the exclusion against the combined set (as
 * the first draft of this did) therefore always failed — the `×` lines are a
 * second rendering of the same failures, not additional ones, and they can
 * never contain a filename. That bug shipped because the test double fed only
 * `FAIL`-shaped lines; real output has both.
 *
 * ANSI is stripped first, and that is not cosmetic. Vitest colorizes its
 * summary depending on how the subprocess was spawned, and a coloured `FAIL`
 * line begins with an escape sequence rather than whitespace — so the anchored
 * match found nothing, `failuresAreAllUnclearable([])` returned false, and this
 * action REFUSED over a red set consisting entirely of assertions it cannot
 * clear. That is precisely the deadlock ADR-079 exists to prevent, reintroduced
 * by a parser that only handled the uncoloured rendering. The same
 * double-does-not-match-the-real-contract mistake as the `×`-line bug above,
 * one layer down.
 */
const ANSI = /\u001B\[[0-9;]*m/g;

export function extractFailingFiles(output: string): readonly string[] {
  const files = new Set<string>();
  for (const line of output.replace(ANSI, "").split("\n")) {
    const match = /^\s*FAIL\s+(\S+)/.exec(line);
    if (match?.[1]) files.add(match[1].trim());
  }
  return Object.freeze([...files]);
}

/**
 * True when every failing FILE is one this action cannot clear, so refusing
 * would deadlock rather than protect. An empty set is NOT unclearable — a
 * suite that failed without naming a file is unparsed, not excused.
 */
export function failuresAreAllUnclearable(failingFiles: readonly string[]): boolean {
  if (failingFiles.length === 0) return false;
  return failingFiles.every((file) => SUITE_CHECK_EXCLUSIONS.some((entry) => file.includes(entry.match)));
}

/** The one instrument this module trusts for current staleness — never re-derived here. */
const FRESHNESS_GATE_ARGV: readonly [string, ...string[]] = ["bun", "scripts/store-freshness-gate.mjs", "--json"];

/** Constraint 3: the graph's own staleness instrument, and its remedy. */
const VI_FRESHNESS_GATE_ARGV: readonly [string, ...string[]] = ["bun", "run", "gate:vi-freshness"];
const VI_REPRODUCIBLE_GATE_ARGV: readonly [string, ...string[]] = ["bun", "run", "gate:vi-reproducible"];
const VI_GRAPH_REFRESH_ARGV: readonly [string, ...string[]] = ["bun", "run", "vi:refresh"];
const VI_GRAPH_REFRESH_LABEL = "bun run vi:refresh";

/**
 * LEGIBILITY (register item 11, 2026-08-24). Both refusal paths below —
 * graph_precheck failing and the suite-check refusing determinism-baseline —
 * are commonly hit for the exact same mundane reason: a source commit just
 * landed, so every downstream store is definitionally stale until rebound.
 * A generic "exited 1, see diagnostic" message sends an operator spelunking
 * through subprocess output for something that isn't a bug. Naming the
 * situation and the exact ordered recovery inline (not only in
 * `remedy_commands`, which nothing prints unless a caller already knows to
 * look) is what actually gets an agent unstuck without rediscovering the
 * sequence by trial and error, as happened on 2026-08-15 and 2026-08-18.
 */
const POST_COMMIT_RECOVERY_NOTE =
  "This commonly happens right after a source commit: the stores are stale because they reflect the PRIOR commit, " +
  "not because anything is broken. If that is the situation here, the sanctioned recovery is the producer chain, " +
  "in order (or `bun run evidence:rebind`, which runs the same automatic chain): " +
  `${VI_GRAPH_REFRESH_LABEL} && ${AUTOMATED_EVIDENCE_STORE_NAMES.map((name) => REFRESH_COMMAND_LABEL[name]).join(" && ")} — then commit the refreshed stores. ` +
  "Determinism measurement is a separate explicit operator action (ADR-034).";

/**
 * Regenerate the VI graph before any store refresh, because graph bytes are
 * inside the stores' content hash (see `EvidenceGraphPrecheck`).
 *
 * Commit-distance staleness and byte reproducibility are distinct questions,
 * so skipping requires both authoritative instruments to pass. A green
 * freshness budget alone cannot see uncommitted source changes and previously
 * allowed dependent stores to be refreshed against a graph that would fail
 * `vi:refresh --check` immediately after commit.
 */
async function runGraphPrecheck(options: {
  readonly anyStorePlanned: boolean;
  readonly dryRun: boolean;
  readonly transactionSnapshot: boolean;
  readonly run: EvidenceRefreshRunner;
  readonly timeoutMs: number;
  readonly freshnessGateTimeoutMs: number;
}): Promise<EvidenceGraphPrecheck> {
  if (!options.anyStorePlanned) {
    return Object.freeze({
      ran: false,
      stale: null,
      action: "skipped" as const,
      detail: "no store in scope, so no graph/store ordering hazard exists",
      duration_ms: null,
    });
  }

  const freshnessGate = await options.run(VI_FRESHNESS_GATE_ARGV, options.freshnessGateTimeoutMs);
  const reproducibleGate = freshnessGate.ok
    ? await options.run(VI_REPRODUCIBLE_GATE_ARGV, options.timeoutMs)
    : null;
  const stale = !freshnessGate.ok || reproducibleGate?.ok !== true;
  if (!stale) {
    return Object.freeze({
      ran: true,
      stale: false,
      action: "skipped" as const,
      detail: "gate:vi-freshness and gate:vi-reproducible are green — the graph is current and byte-reproducible",
      duration_ms: null,
    });
  }

  if (options.dryRun) {
    return Object.freeze({
      ran: true,
      stale: true,
      action: "would_refresh" as const,
      detail: `graph is stale or non-reproducible; would run \`${VI_GRAPH_REFRESH_LABEL}\` FIRST, because regenerating it afterwards would re-stale every store refreshed by this call`,
      duration_ms: null,
    });
  }

  const started = Date.now();
  const result = await options.run(VI_GRAPH_REFRESH_ARGV, options.timeoutMs);
  const durationMs = Date.now() - started;
  if (!result.ok) {
    return Object.freeze({
      ran: true,
      stale: true,
      action: "failed" as const,
      detail: `\`${VI_GRAPH_REFRESH_LABEL}\` exited ${result.exit_code}; stores were blocked. ${POST_COMMIT_RECOVERY_NOTE} Producer diagnostic:\n${preview(result.output)}`,
      duration_ms: durationMs,
    });
  }
  // A zero exit only proves that the producer completed. The graph becomes a
  // valid input to downstream stores only after both independent VI checks
  // accept the newly generated bytes. This rejects a graph built from dirty
  // inputs even when vi:refresh itself exits successfully.
  // A transaction-owned immutable source overlay is not a generic dirty-tree
  // exception. The outer lease validates its candidate/input digest before
  // staging and again before publication, then records a binding with the
  // generated evidence. `vi:refresh --check` remains required here. Running
  // the ordinary commit-distance gate inside that overlay would reject solely
  // because the snapshot intentionally carries uncommitted source bytes.
  const postFreshnessGate = options.transactionSnapshot
    ? { ok: true, exit_code: 0, output: "snapshot-bound freshness is verified by the owning evidence transaction" }
    : await options.run(VI_FRESHNESS_GATE_ARGV, options.freshnessGateTimeoutMs);
  const postReproducibleGate = await options.run(VI_REPRODUCIBLE_GATE_ARGV, options.timeoutMs);
  const postconditionsOk = postFreshnessGate.ok && postReproducibleGate.ok;
  return Object.freeze({
    ran: true,
    stale: true,
    action: postconditionsOk ? ("refreshed" as const) : ("failed" as const),
    detail: postconditionsOk
      ? options.transactionSnapshot
        ? `\`${VI_GRAPH_REFRESH_LABEL}\` reproduced from the immutable transaction snapshot before any store refresh; the outer transaction validates and publishes its bound input identity`
        : `\`${VI_GRAPH_REFRESH_LABEL}\` and both post-refresh VI gates passed before any store refresh`
      : `\`${VI_GRAPH_REFRESH_LABEL}\` exited 0, but post-refresh VI validation failed (freshness=${postFreshnessGate.exit_code}, reproducibility=${postReproducibleGate.exit_code}); refusing dependent store refreshes. ${POST_COMMIT_RECOVERY_NOTE} Diagnostics:\n${preview(`${postFreshnessGate.output}\n${postReproducibleGate.output}`)}`,
    duration_ms: durationMs,
  });
}

export type EvidenceRefreshScope = "auto" | "all" | readonly EvidenceStoreName[];

export interface EvidenceRefreshInput {
  readonly scope?: EvidenceRefreshScope;
  readonly dry_run?: boolean;
  /** Set only by the evidence-transaction adapter after it owns a source-overlay lease. */
  readonly transaction_snapshot?: boolean;
}

export type EvidenceRefreshAction = "refreshed" | "would_refresh" | "skipped" | "refused" | "failed";

export interface EvidenceStoreOutcome {
  readonly name: EvidenceStoreName;
  /** This store's freshness WAS assessed via `store-freshness-gate.mjs --json` before any decision was made. */
  readonly checked: true;
  /** Mirrors the gate's own pass/fail verdict for this store; null only when the gate itself could not be read. */
  readonly stale: boolean | null;
  readonly freshness_detail: string;
  readonly action: EvidenceRefreshAction;
  readonly remedy_command: string;
  readonly reason: string;
  readonly duration_ms: number | null;
  /** Truncated combined stdout+stderr from the refresh command, when one ran. */
  readonly output: string | null;
  /** Populated only for a "refused" determinism-baseline outcome, best-effort parsed from the suite run. */
  readonly failing_tests?: readonly string[];
}

export interface EvidenceRefreshSuiteCheck {
  readonly ran: boolean;
  readonly green: boolean | null;
  readonly detail: string;
  readonly duration_ms: number | null;
}

export interface EvidenceRefreshResult {
  readonly ok: boolean;
  readonly dry_run: boolean;
  readonly scope: EvidenceRefreshScope;
  readonly stores: readonly EvidenceStoreOutcome[];
  readonly suite_check: EvidenceRefreshSuiteCheck;
  /**
   * Constraint 3. Absent on the early-error paths, which never reach the
   * refresh phase at all.
   */
  readonly graph_precheck?: EvidenceGraphPrecheck;
  /** Rule 2, spelled out every time so it cannot be forgotten between sessions. */
  readonly commit_before_verify_note: string;
  readonly remedy_commands: readonly string[];
  /** Set only when the freshness gate itself could not be read; nothing else in the result can be trusted then. */
  readonly error: string | null;
}

/**
 * CONSTRAINT 3 — the visual-intelligence GRAPH must be regenerated BEFORE the
 * four stores, never after.
 *
 * `scripts/lib/store-provenance.mjs` excludes `.claim-ledger/`,
 * `.determinism-baseline/`, `.completion-depth/` and
 * `.visual-intelligence/observed/` from the evidence content hash — but NOT
 * `.visual-intelligence/graph/`. So regenerating the graph changes bytes that
 * every store hashes, and instantly re-stales all four stores that were just
 * refreshed.
 *
 * Learned the expensive way on 2026-08-15: a refresh-then-commit cycle came
 * back red with a clean working tree, because `vi:refresh` had run after the
 * stores rather than before them. The failure is silent and looks exactly
 * like a store bug.
 *
 * Deliberately expressed as ORDERING rather than by adding the graph to the
 * exclusion list: whether generated graph bytes are evidence inputs is an
 * ADR-055 question about hash semantics, not something a refresh tool may
 * decide unilaterally. `vi-observed` genuinely does derive from the graph.
 */
export interface EvidenceGraphPrecheck {
  /** False when no store was in scope, so no ordering hazard existed. */
  readonly ran: boolean;
  /** Null when the freshness gate could not be read. */
  readonly stale: boolean | null;
  readonly action: "refreshed" | "would_refresh" | "skipped" | "failed";
  readonly detail: string;
  readonly duration_ms: number | null;
}

export interface CommandOutcome {
  readonly ok: boolean;
  readonly exit_code: number;
  readonly output: string;
}

/** Signature the native tool host binds to its sandbox broker; injected here so planning logic is testable without spawning processes. */
export type EvidenceRefreshRunner = (argv: readonly [string, ...string[]], timeoutMs: number) => Promise<CommandOutcome>;

export interface EvidenceRefreshDeps {
  readonly run: EvidenceRefreshRunner;
  /** ms budgets, injectable so tests never wait on real timeouts. */
  readonly freshnessGateTimeoutMs?: number;
  readonly refreshTimeoutMs?: number;
  readonly suiteCheckTimeoutMs?: number;
}

const OUTPUT_PREVIEW_BYTES = 4_000;
const COMMIT_BEFORE_VERIFY_NOTE =
  "gate:store-freshness compares the working tree against COMMITTED stores (git-tracked bytes), not the working tree alone. " +
  "Any store this call refreshed will still be reported stale by `bun run gate:store-freshness` until it is committed. " +
  "This tool does not commit — committing a refreshed store is the operator's decision, not this tool's.";

interface FreshnessGateStoreEntry {
  readonly name: string;
  readonly state: string;
  readonly detail: string;
  readonly refresh?: string;
}

interface FreshnessGateReport {
  readonly ok: boolean;
  readonly stores: readonly FreshnessGateStoreEntry[];
}

function preview(text: string): string {
  return text.length <= OUTPUT_PREVIEW_BYTES ? text : `${text.slice(0, OUTPUT_PREVIEW_BYTES)}\n…[truncated ${text.length - OUTPUT_PREVIEW_BYTES} bytes]`;
}

function isEvidenceStoreName(value: string): value is EvidenceStoreName {
  return (EVIDENCE_STORE_NAMES as readonly string[]).includes(value);
}

/**
 * Parses `store-freshness-gate.mjs --json`'s stdout. The gate is the sole
 * authority on staleness (content-hash-derived; see `scripts/lib/
 * store-provenance.mjs`) — this function only reads its verdict, never
 * recomputes one.
 */
function parseFreshnessReport(output: string): FreshnessGateReport {
  const parsed: unknown = JSON.parse(output);
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { stores?: unknown }).stores)) {
    throw new Error("store-freshness-gate.mjs --json produced an unrecognized shape");
  }
  const stores = (parsed as { stores: unknown[] }).stores.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("store-freshness-gate.mjs --json produced a malformed store entry");
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.state !== "string" || typeof record.detail !== "string") {
      throw new Error("store-freshness-gate.mjs --json produced a store entry missing name/state/detail");
    }
    return { name: record.name, state: record.state, detail: record.detail, refresh: typeof record.refresh === "string" ? record.refresh : undefined };
  });
  return { ok: (parsed as { ok?: unknown }).ok === true, stores };
}

/** Best-effort extraction of failing test identifiers from vitest's default reporter output; absence never blocks the refusal itself. */
function extractFailingTests(output: string): readonly string[] {
  const names = new Set<string>();
  // Same ANSI strip as extractFailingFiles: this feeds the human-readable
  // detail, and escape sequences would otherwise be embedded in the reported
  // test names as well as defeating the anchored match.
  for (const line of output.replace(ANSI, "").split("\n")) {
    const failMatch = /^\s*(?:FAIL|×|✗)\s+(.+?)\s*$/.exec(line);
    if (failMatch?.[1]) names.add(failMatch[1].trim());
  }
  return Object.freeze([...names]);
}

function resolvePlannedNames(scope: EvidenceRefreshScope, report: FreshnessGateReport): { readonly planned: ReadonlySet<EvidenceStoreName>; readonly invalid: readonly string[] } {
  if (scope === "all") return { planned: new Set(AUTOMATED_EVIDENCE_STORE_NAMES), invalid: [] };
  if (scope === "auto") {
    const stale = report.stores
      .filter((entry) => entry.state === "fail" && (AUTOMATED_EVIDENCE_STORE_NAMES as readonly string[]).includes(entry.name))
      .map((entry) => entry.name as EvidenceStoreName);
    return { planned: new Set(stale), invalid: [] };
  }
  const invalid = scope.filter((name) => !isEvidenceStoreName(name));
  const planned = new Set(scope.filter(isEvidenceStoreName));
  return { planned, invalid };
}

/**
 * Plans and (unless `dry_run`) executes the evidence-store refresh sequence,
 * enforcing constraint 1 (never bake a red suite into the determinism
 * baseline) mechanically and surfacing constraint 2 (commit before
 * verifying) in every result.
 */
export async function runEvidenceRefresh(input: EvidenceRefreshInput, deps: EvidenceRefreshDeps): Promise<EvidenceRefreshResult> {
  const scope = input.scope ?? "auto";
  const dryRun = input.dry_run ?? false;
  const transactionSnapshot = input.transaction_snapshot === true;
  const freshnessGateTimeoutMs = deps.freshnessGateTimeoutMs ?? 30_000;
  const refreshTimeoutMs = deps.refreshTimeoutMs ?? 300_000;
  // The native sandbox broker adds substantial process and filesystem
  // isolation overhead to the 5k-test suite. Ten minutes produced a silent
  // timeout (`exit_code: -1`) on a suite that completes successfully when
  // invoked directly, so give the safety preflight enough room to report a
  // real verdict instead of manufacturing a red one from its own deadline.
  const suiteCheckTimeoutMs = deps.suiteCheckTimeoutMs ?? 1_800_000;

  // An explicit scope is closed data and can be validated without consulting
  // repository state. Reject typos before invoking freshness: otherwise a
  // stale or temporarily unreadable store masks a deterministic usage error
  // and makes the operator repair evidence that this request could never use.
  if (Array.isArray(scope)) {
    const invalid = scope.filter((name) => !isEvidenceStoreName(name));
    if (invalid.length > 0) {
      return Object.freeze({
        ok: false,
        dry_run: dryRun,
        scope,
        stores: [],
        suite_check: Object.freeze({ ran: false, green: null, detail: "not run: scope was invalid", duration_ms: null }),
        commit_before_verify_note: COMMIT_BEFORE_VERIFY_NOTE,
        remedy_commands: [],
        error: `scope named unknown store(s): ${invalid.join(", ")}. Known stores: ${EVIDENCE_STORE_NAMES.join(", ")}.`,
      });
    }
  }

  const gateResult = await deps.run(FRESHNESS_GATE_ARGV, freshnessGateTimeoutMs);
  let report: FreshnessGateReport;
  try {
    report = parseFreshnessReport(gateResult.output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      ok: false,
      dry_run: dryRun,
      scope,
      stores: [],
      suite_check: Object.freeze({ ran: false, green: null, detail: "not run: freshness gate could not be read", duration_ms: null }),
      commit_before_verify_note: COMMIT_BEFORE_VERIFY_NOTE,
      remedy_commands: [],
      error: `store-freshness-gate.mjs --json could not be read: ${detail}. gate exit_code=${gateResult.exit_code}, ok=${gateResult.ok}.`,
    });
  }

  const { planned, invalid } = resolvePlannedNames(scope, report);
  if (invalid.length > 0) {
    return Object.freeze({
      ok: false,
      dry_run: dryRun,
      scope,
      stores: [],
      suite_check: Object.freeze({ ran: false, green: null, detail: "not run: scope was invalid", duration_ms: null }),
      commit_before_verify_note: COMMIT_BEFORE_VERIFY_NOTE,
      remedy_commands: [],
      error: `scope named unknown store(s): ${invalid.join(", ")}. Known stores: ${EVIDENCE_STORE_NAMES.join(", ")}.`,
    });
  }

  const byName = new Map(report.stores.map((entry) => [entry.name, entry] as const));
  const stores: EvidenceStoreOutcome[] = [];
  let suiteCheck: EvidenceRefreshSuiteCheck = Object.freeze({ ran: false, green: null, detail: "not run: determinism-baseline was not in scope", duration_ms: null });

  // CONSTRAINT 3, before any store runs: regenerate the VI graph first, or
  // it will re-stale every store this call is about to refresh.
  const graphPrecheck = await runGraphPrecheck({
    anyStorePlanned: planned.size > 0,
    dryRun,
    transactionSnapshot,
    run: deps.run,
    timeoutMs: refreshTimeoutMs,
    freshnessGateTimeoutMs,
  });
  // A successful graph rewrite changes an input to every committed evidence
  // store. The freshness report was captured BEFORE that rewrite, so its
  // per-store verdicts can no longer justify skipping any dependent store.
  // Expand the effective scope mechanically rather than asking the operator
  // to notice and run this command a second time. Dry-run mirrors the same
  // dependency closure as a plan. A failed graph precondition blocks store
  // writes altogether; refreshing against a graph known not to be current
  // would create evidence that is stale on arrival.
  const effectivePlanned = new Set(planned);
  if (graphPrecheck.action === "refreshed" || graphPrecheck.action === "would_refresh") {
    for (const name of AUTOMATED_EVIDENCE_STORE_NAMES) effectivePlanned.add(name);
  }
  const graphBlocked = graphPrecheck.action === "failed";

  // Non-determinism stores next, in dependency order: observations first,
  // then the projections that include those observed bytes in their content
  // identity. This ordering is load-bearing, not presentation preference.
  for (const name of EVIDENCE_STORE_NAMES) {
    if (name === "determinism-baseline") continue;
    const entry = byName.get(name);
    const stale = entry === undefined ? null : entry.state === "fail";
    const freshnessDetail = entry?.detail ?? "not reported by store-freshness-gate.mjs";
    const remedy = REFRESH_COMMAND_LABEL[name];
    const forcedByGraph = effectivePlanned.has(name) && !planned.has(name);
    if (!effectivePlanned.has(name)) {
      stores.push(Object.freeze({ name, checked: true, stale, freshness_detail: freshnessDetail, action: "skipped", remedy_command: remedy, reason: "not in scope", duration_ms: null, output: null }));
      continue;
    }
    if (graphBlocked) {
      stores.push(Object.freeze({ name, checked: true, stale, freshness_detail: freshnessDetail, action: "refused", remedy_command: remedy, reason: `refusing to run \`${remedy}\`: the required graph refresh failed`, duration_ms: null, output: null }));
      continue;
    }
    if (dryRun) {
      stores.push(Object.freeze({ name, checked: true, stale, freshness_detail: freshnessDetail, action: "would_refresh", remedy_command: remedy, reason: forcedByGraph ? `would run \`${remedy}\` because the planned graph rewrite invalidates its earlier freshness verdict` : `would run \`${remedy}\``, duration_ms: null, output: null }));
      continue;
    }
    const started = Date.now();
    const result = await deps.run(REFRESH_ARGV[name], refreshTimeoutMs);
    const durationMs = Date.now() - started;
    if (result.ok) {
      stores.push(Object.freeze({ name, checked: true, stale, freshness_detail: freshnessDetail, action: "refreshed", remedy_command: remedy, reason: forcedByGraph ? `\`${remedy}\` exited 0 after the graph rewrite invalidated its earlier freshness verdict` : `\`${remedy}\` exited 0`, duration_ms: durationMs, output: preview(result.output) }));
    } else {
      stores.push(Object.freeze({ name, checked: true, stale, freshness_detail: freshnessDetail, action: "failed", remedy_command: remedy, reason: `\`${remedy}\` exited ${result.exit_code}`, duration_ms: durationMs, output: preview(result.output) }));
    }
  }

  // determinism-baseline last, and only after the mechanical suite-green check.
  {
    const name: EvidenceStoreName = "determinism-baseline";
    const entry = byName.get(name);
    const stale = entry === undefined ? null : entry.state === "fail";
    const freshnessDetail = entry?.detail ?? "not reported by store-freshness-gate.mjs";
    const remedy = REFRESH_COMMAND_LABEL[name];
    const forcedByGraph = effectivePlanned.has(name) && !planned.has(name);
    if (!effectivePlanned.has(name)) {
      stores.push(Object.freeze({ name, checked: true, stale, freshness_detail: freshnessDetail, action: "skipped", remedy_command: remedy, reason: "not in scope", duration_ms: null, output: null }));
    } else if (graphBlocked) {
      stores.push(Object.freeze({
        name, checked: true, stale, freshness_detail: freshnessDetail, action: "refused", remedy_command: remedy,
        reason: `refusing to run \`${remedy}\`: the required graph refresh failed`, duration_ms: null, output: null,
      }));
    } else if (dryRun) {
      stores.push(Object.freeze({
        name, checked: true, stale, freshness_detail: freshnessDetail, action: "would_refresh", remedy_command: remedy,
        reason: `${forcedByGraph ? "the planned graph rewrite invalidates its earlier freshness verdict; " : ""}would first run \`${SUITE_CHECK_ARGV.join(" ")}\` once to confirm the suite is green, then \`${remedy}\` only if it is`,
        duration_ms: null, output: null,
      }));
    } else {
      const started = Date.now();
      const suiteResult = await deps.run(SUITE_CHECK_ARGV, suiteCheckTimeoutMs);
      const suiteDurationMs = Date.now() - started;
      const failingTests = suiteResult.ok ? [] : extractFailingTests(suiteResult.output);
      // Decided on FILE paths, not test names — see extractFailingFiles.
      const failingFiles = suiteResult.ok ? [] : extractFailingFiles(suiteResult.output);
      const unclearable = !suiteResult.ok && failuresAreAllUnclearable(failingFiles);
      // A MIXED failure set (the self-test alongside a genuine, clearable
      // failure) is not unclearable overall, but the self-test's presence is
      // still worth naming: it is not part of what needs fixing here.
      const includesUnclearableSelfTest = !suiteResult.ok && failingFiles.some((file) => SUITE_CHECK_EXCLUSIONS.some((entry) => file.includes(entry.match)));
      // `green` reports what the suite actually did. A red suite that proceeds
      // under ADR-079 stays `green: false` and says so — reporting it as green
      // would be the tool lying about its own precondition to justify itself.
      suiteCheck = Object.freeze({
        ran: true, green: suiteResult.ok, duration_ms: suiteDurationMs,
        detail: suiteResult.ok
          ? `\`${SUITE_CHECK_ARGV.join(" ")}\` passed (single pass; see module header for why single-pass is sufficient here)`
          : unclearable
            ? `\`${SUITE_CHECK_ARGV.join(" ")}\` exited ${suiteResult.exit_code}, but every failing test is one this action cannot clear (ADR-079): ${failingTests.join(", ")}. Proceeding — refusing here would deadlock, not protect.`
            : `\`${SUITE_CHECK_ARGV.join(" ")}\` exited ${suiteResult.exit_code}`,
      });
      if (!suiteResult.ok && !unclearable) {
        stores.push(Object.freeze({
          name, checked: true, stale, freshness_detail: freshnessDetail, action: "refused", remedy_command: remedy,
          reason: `refusing to run \`${remedy}\`: the test suite is red (\`${SUITE_CHECK_ARGV.join(" ")}\` exited ${suiteResult.exit_code}). ` +
            "Refreshing the determinism baseline against a red suite would record the failure as a legitimate recorded flake. Fix the failing test(s) first, then retry." +
            (includesUnclearableSelfTest
              ? ` (Note: the store-freshness self-test is among the failures — that part is not itself a bug; see below. But at least one OTHER failure is real and must be fixed before this can proceed.) ${POST_COMMIT_RECOVERY_NOTE}`
              : ""),
          duration_ms: null, output: preview(suiteResult.output), failing_tests: failingTests,
        }));
      } else {
        const refreshStarted = Date.now();
        const result = await deps.run(REFRESH_ARGV[name], refreshTimeoutMs);
        const durationMs = Date.now() - refreshStarted;
        if (result.ok) {
          stores.push(Object.freeze({ name, checked: true, stale, freshness_detail: freshnessDetail, action: "refreshed", remedy_command: remedy, reason: `\`${remedy}\` exited 0`, duration_ms: durationMs, output: preview(result.output) }));
        } else {
          stores.push(Object.freeze({ name, checked: true, stale, freshness_detail: freshnessDetail, action: "failed", remedy_command: remedy, reason: `\`${remedy}\` exited ${result.exit_code}`, duration_ms: durationMs, output: preview(result.output) }));
        }
      }
    }
  }

  // Canonical order for the reported list, independent of execution order above.
  const orderedStores = EVIDENCE_STORE_NAMES.map((name) => stores.find((entry) => entry.name === name)!);
  const storeRemedies = orderedStores.filter((entry) => entry.action === "failed" || entry.action === "refused" || (entry.action === "skipped" && entry.stale === true)).map((entry) => entry.remedy_command);
  // The graph remedy leads, because it must be run BEFORE the store remedies
  // for them to stick — the remedy list is an ordered script, not a set.
  const remedyCommands = graphPrecheck.action === "failed" ? [VI_GRAPH_REFRESH_LABEL, ...storeRemedies] : storeRemedies;
  // A failed graph pre-step is a real failure: every store refreshed after it
  // may already be stale, so reporting `ok` would be a false green.
  const requestedStoreFailed = orderedStores.some((entry) => effectivePlanned.has(entry.name) && (entry.action === "failed" || entry.action === "refused"));
  const ok = !requestedStoreFailed && graphPrecheck.action !== "failed";

  return Object.freeze({
    ok,
    dry_run: dryRun,
    scope,
    stores: orderedStores,
    graph_precheck: graphPrecheck,
    suite_check: suiteCheck,
    commit_before_verify_note: COMMIT_BEFORE_VERIFY_NOTE,
    remedy_commands: Object.freeze([...new Set(remedyCommands)]),
    error: null,
  });
}
