/**
 * Governance screen (ADR governance control plane, ADR-027 draft).
 *
 * Renders the ADR governance snapshot `@arbor/mcp`'s
 * `governance-projection.ts` builds from `@arbor/governance` over the real
 * `decisions/` corpus: total records and their decision-status distribution,
 * obligation coverage, POL-04/SUR-05 policy findings, derived repository
 * counts, and the legacy-classification breakdown.
 *
 * This is a LEAF module: it never imports `@arbor/governance` or
 * `@arbor/mcp` (ADR-011). `GovernanceSnapshotShape` below is a structural
 * mirror of `governance-projection.ts`'s real, already-landed
 * `GovernanceSnapshot` type — exactly the pattern `player-piano.ts`'s header
 * states for the devtools.stream contract: the field names below
 * (`decision_status_distribution`, `legacy_classification`,
 * `obligation_coverage`, `policy_findings`, `repository_counts`) are copied
 * from that real, tested type, not guessed. `arbor-mcp`'s `cli.ts` names this
 * screen directly as `governance --json`'s intended consumer. Every nested
 * field is still re-validated with `typeof`/`Array.isArray` at read time
 * regardless of what the mirror type claims, the same discipline
 * `campaigns.ts`/`tasks.ts` apply to their own real-caller shapes, so a
 * malformed or future-shape input degrades a single field rather than
 * throwing or fabricating a value.
 *
 * `arbor-mcp governance --json` (C2, ADR-054's `--json` grammar item) emits
 * the real `GovernanceResult<GovernanceSnapshot>` ENVELOPE
 * (`contracts.ts`'s `{ok:true,value,capability}` / `{ok:false,error,
 * capability}` union), not a bare snapshot — `project()` below recognizes
 * both that envelope (`envelope-ok`/`envelope-error` variants) and a bare
 * `GovernanceSnapshotShape` passed directly (`snapshot` variant, for an
 * in-process caller that already unwrapped `.value` itself). `{ok:false}`
 * renders an explicit failure state, never the generic "no data yet" —
 * `errorProjection` below.
 *
 * Render honestly: zero obligation coverage or zero findings are REAL,
 * informative facts (never blanked into a generic empty panel) as long as
 * the projection actually reported the field; a field the projection never
 * reported is simply not shown — never a fabricated placeholder value.
 */

import { ANSI, clipAnsi } from "../player-piano.js";
import { clipDisplay, renderTable } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";

// ── cardinality bounds ───────────────────────────────────────────────────────

const MAX_FINDING_ROWS = 200;

// ── structural mirror of governance-projection.ts's real GovernanceSnapshot ─

/** Mirrors `contracts.ts`'s `DecisionStatus` union, in its declared order. */
const DECISION_ORDER = ["draft", "proposed", "accepted", "rejected", "superseded"] as const;

/**
 * Subset of `contracts.ts`'s `PolicyFinding` this screen renders. `subject`
 * is `ArtifactIdentity | {record_id}` there; mirrored loosely here and
 * resolved to a display string by `findingSubject` below, exactly matching
 * `governance-projection.ts`'s own `formatGovernanceSnapshot`'s logic (never
 * assuming either shape is authoritative over the other).
 */
export interface GovernancePolicyFindingShape {
  readonly rule_id?: string;
  readonly severity?: string;
  readonly detail?: string;
  readonly subject?: { readonly record_id?: string } | { readonly kind?: string; readonly path?: string };
}

/** Mirrors `counts/derive.ts`'s `RepositoryCounts`, re-exported as `GovernanceSnapshot.repository_counts`. */
export interface GovernanceRepositoryCountsShape {
  readonly adr_total?: number;
  readonly catalog_kinds?: number;
  readonly src_files?: number;
  readonly packages?: number;
  readonly test_files?: number;
  readonly allowlist_entries?: number;
}

/** Mirrors `GovernanceSnapshot.legacy_classification`. */
export interface GovernanceLegacyClassificationShape {
  readonly total?: number;
  readonly parsed?: number;
  readonly parsed_with_warnings?: number;
  readonly unparseable?: number;
}

/** Mirrors `GovernanceSnapshot.obligation_coverage`. */
export interface GovernanceObligationCoverageShape {
  readonly total_records?: number;
  readonly total_obligations?: number;
  readonly records_with_obligations_section?: number;
  readonly records_fully_covered?: number;
}

/** The composed governance snapshot this screen consumes — mirrors `governance-projection.ts`'s `GovernanceSnapshot`, field for field. */
export interface GovernanceSnapshotShape {
  readonly decision_status_distribution?: Readonly<Record<string, number>>;
  readonly legacy_classification?: GovernanceLegacyClassificationShape;
  readonly obligation_coverage?: GovernanceObligationCoverageShape;
  readonly policy_findings?: readonly GovernancePolicyFindingShape[];
  readonly repository_counts?: GovernanceRepositoryCountsShape;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A governance snapshot is recognized by the presence of ANY of its five
 * facets — never by requiring all of them, since a partial projection is
 * still real data, not "no data".
 */
export function isGovernanceSnapshotShape(result: unknown): result is GovernanceSnapshotShape {
  if (!isRecord(result)) return false;
  return (
    isRecord(result.decision_status_distribution) ||
    isRecord(result.legacy_classification) ||
    isRecord(result.obligation_coverage) ||
    Array.isArray(result.policy_findings) ||
    isRecord(result.repository_counts)
  );
}

/**
 * `arbor-mcp governance --json` (C2, ADR-054's `--json` grammar item) emits
 * the real `GovernanceResult<GovernanceSnapshot>` envelope
 * (`contracts.ts`'s `{ok:true,value,capability}` / `{ok:false,error,
 * capability}` union) — not a bare `GovernanceSnapshot` — so a consumer
 * parsing that output must unwrap `.value` first. Recognizing ONLY the bare
 * shape here (the pre-C2 assumption) would mean this screen's `match`
 * silently fails against its own real, documented producer and every real
 * snapshot falls through to `emptyProjection()` — a plausible-looking "no
 * data yet" that is actually "the wiring doesn't match the contract",
 * exactly the S3-class defect this repo's audit exists to catch. Structural
 * only, like every other shape check in this file: re-validated field by
 * field, never assumed.
 */
interface GovernanceResultEnvelopeShape {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly message?: unknown; readonly code?: unknown };
  readonly capability?: unknown;
}

function isGovernanceResultEnvelopeShape(result: unknown): result is GovernanceResultEnvelopeShape {
  return isRecord(result) && typeof result.ok === "boolean";
}

function isGovernanceAbsenceShape(result: unknown): result is { governance_absence: true; message?: unknown } {
  return isRecord(result) && result.governance_absence === true;
}

/** `{ok:true, value: <real GovernanceSnapshot>}` — the success half of the envelope. */
function isGovernanceOkEnvelopeShape(result: unknown): result is { ok: true; value: GovernanceSnapshotShape } {
  return isGovernanceResultEnvelopeShape(result) && result.ok === true && isGovernanceSnapshotShape(result.value);
}

/** `{ok:false, error}` — the failure half. Matched on `ok===false` alone; `error`'s
 *  own fields are re-validated inside `errorProjection`, not trusted from this predicate. */
function isGovernanceErrorEnvelopeShape(result: unknown): result is { ok: false; error?: unknown } {
  return isGovernanceResultEnvelopeShape(result) && result.ok === false;
}

// ── per-facet row builders (each defensively re-validates its own fields) ──

interface GovernanceRow {
  readonly [key: string]: unknown;
  readonly section: "records" | "obligations" | "finding" | "counts" | "legacy";
  readonly label: string;
  readonly value: string;
  readonly rule_id?: string;
  readonly severity?: string;
}

function decisionDistributionRows(distribution: unknown): GovernanceRow[] {
  if (!isRecord(distribution)) return [];
  const rows: GovernanceRow[] = [];
  const seen = new Set<string>();
  for (const key of DECISION_ORDER) {
    const value = distribution[key];
    if (!isFiniteNumber(value)) continue;
    seen.add(key);
    rows.push({ section: "records", label: key, value: String(value) });
  }
  for (const key of Object.keys(distribution).sort()) {
    if (seen.has(key)) continue;
    const value = distribution[key];
    if (!isFiniteNumber(value)) continue;
    rows.push({ section: "records", label: key, value: String(value) });
  }
  return rows;
}

/** "{total_obligations} obligations across {total_records} records (...)" — same wording as `formatGovernanceSnapshot`. */
function obligationCoverageRows(coverage: unknown): GovernanceRow[] {
  if (!isRecord(coverage)) return [];
  const totalObligations = coverage.total_obligations;
  const totalRecords = coverage.total_records;
  if (!isFiniteNumber(totalObligations) || !isFiniteNumber(totalRecords)) return [];
  const withSection = isFiniteNumber(coverage.records_with_obligations_section) ? coverage.records_with_obligations_section : undefined;
  const fullyCovered = isFiniteNumber(coverage.records_fully_covered) ? coverage.records_fully_covered : undefined;
  const detail = withSection !== undefined && fullyCovered !== undefined
    ? `${totalObligations} obligation${totalObligations === 1 ? "" : "s"} across ${totalRecords} record${totalRecords === 1 ? "" : "s"} (${withSection} declare an Obligations section, ${fullyCovered} fully covered)`
    : `${totalObligations} obligation${totalObligations === 1 ? "" : "s"} across ${totalRecords} record${totalRecords === 1 ? "" : "s"}`;
  return [{ section: "obligations", label: "Coverage", value: detail }];
}

/** Mirrors `formatGovernanceSnapshot`'s subject resolution: never assumes either PolicyFinding.subject shape is authoritative over the other. */
function findingSubject(subject: unknown): string {
  if (!isRecord(subject)) return "?";
  if (typeof subject.record_id === "string") return subject.record_id;
  if (typeof subject.kind === "string" && typeof subject.path === "string") return `${subject.kind}:${subject.path}`;
  return "?";
}

function policyFindingRows(findings: unknown, limit: number): GovernanceRow[] {
  if (!Array.isArray(findings)) return [];
  const rows: GovernanceRow[] = [];
  for (const entry of findings.slice(0, limit)) {
    if (!isRecord(entry)) continue;
    const ruleId = typeof entry.rule_id === "string" ? entry.rule_id : "?";
    const detail = typeof entry.detail === "string" ? entry.detail : "?";
    const subject = findingSubject(entry.subject);
    rows.push({
      section: "finding",
      rule_id: ruleId,
      severity: typeof entry.severity === "string" ? entry.severity : "?",
      label: ruleId,
      value: subject === "?" ? detail : `${subject}: ${detail}`,
    });
  }
  return rows;
}

const COUNT_LABELS: readonly [keyof GovernanceRepositoryCountsShape, string][] = [
  ["adr_total", "ADRs"],
  ["catalog_kinds", "Catalog kinds"],
  ["src_files", "Src files"],
  ["packages", "Packages"],
  ["test_files", "Test files"],
  ["allowlist_entries", "Allowlist entries"],
];

function repositoryCountsRows(counts: unknown): GovernanceRow[] {
  if (!isRecord(counts)) return [];
  const rows: GovernanceRow[] = [];
  for (const [key, label] of COUNT_LABELS) {
    const value = counts[key as string];
    if (!isFiniteNumber(value)) continue;
    rows.push({ section: "counts", label, value: String(value) });
  }
  return rows;
}

const LEGACY_LABELS: readonly [keyof GovernanceLegacyClassificationShape, string][] = [
  ["total", "total"],
  ["parsed", "parsed"],
  ["parsed_with_warnings", "parsed_with_warnings"],
  ["unparseable", "unparseable"],
];

function legacyClassificationRows(legacy: unknown): GovernanceRow[] {
  if (!isRecord(legacy)) return [];
  const rows: GovernanceRow[] = [];
  for (const [key, label] of LEGACY_LABELS) {
    const value = legacy[key as string];
    if (!isFiniteNumber(value)) continue;
    rows.push({ section: "legacy", label, value: String(value) });
  }
  return rows;
}

function buildCaption(
  totalRecords: number | undefined,
  totalObligations: number | undefined,
  findingCount: number | undefined,
  findingsTruncated: boolean,
): string {
  const parts: string[] = [];
  if (totalRecords !== undefined) parts.push(`${totalRecords} record${totalRecords === 1 ? "" : "s"}`);
  if (totalObligations !== undefined) parts.push(`${totalObligations} obligation${totalObligations === 1 ? "" : "s"}`);
  if (findingCount !== undefined) {
    // A bare "N findings" reads as the complete count. When the real
    // snapshot reported more findings than MAX_FINDING_ROWS bounds this
    // screen to, `findingCount` is the shown/truncated count, not the true
    // total, and rendering it unqualified would overstate completeness —
    // exactly the defect class this screen exists to avoid. `+` (same idiom
    // `control.ts`'s host/inbox captions use for `truncated === true`) makes
    // the truncation visible instead of silently dropping it.
    const suffix = findingsTruncated ? "+" : "";
    parts.push(`${findingCount}${suffix} finding${findingCount === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? `Governance: ${parts.join(" · ")}` : "Governance";
}

// ── projection ───────────────────────────────────────────────────────────────

function projectGovernance(shape: GovernanceSnapshotShape, limit: number): Omit<ScreenProjection, "variant"> {
  const totalRecords = isRecord(shape.legacy_classification) && isFiniteNumber(shape.legacy_classification.total)
    ? shape.legacy_classification.total
    : undefined;
  const totalObligations = isRecord(shape.obligation_coverage) && isFiniteNumber(shape.obligation_coverage.total_obligations)
    ? shape.obligation_coverage.total_obligations
    : undefined;
  const findingsPresent = Array.isArray(shape.policy_findings);
  const totalFindings = Array.isArray(shape.policy_findings) ? shape.policy_findings.length : undefined;

  const bounded = policyFindingRows(shape.policy_findings, Math.min(limit, MAX_FINDING_ROWS));
  const findingsTruncated = totalFindings !== undefined && totalFindings > bounded.length;

  const rows: GovernanceRow[] = [
    ...decisionDistributionRows(shape.decision_status_distribution),
    ...obligationCoverageRows(shape.obligation_coverage),
    ...bounded,
    ...repositoryCountsRows(shape.repository_counts),
    ...legacyClassificationRows(shape.legacy_classification),
  ];

  // `row_ids` (screen.ts's `ScreenProjection`) is deliberately omitted: every
  // row here is an aggregated facet (a decision-status count, an obligation
  // summary, a repository count) joined from five different sources into one
  // flat display list, never one-to-one with a single backend record. There
  // is no id to state — this is the explicit "no meaningful per-row
  // identity" case the field's own doc comment names, not an oversight.
  return {
    screen: "governance",
    rows,
    columns: [
      { key: "label", title: "Item", width: 28 },
      { key: "value", title: "Detail", width: 44 },
    ],
    caption: buildCaption(totalRecords, totalObligations, findingsPresent ? bounded.length : undefined, findingsTruncated),
  };
}

// ── render ───────────────────────────────────────────────────────────────────

function bySection(
  rows: readonly Readonly<Record<string, unknown>>[],
  section: GovernanceRow["section"],
): Readonly<Record<string, unknown>>[] {
  return rows.filter((row) => row.section === section);
}

function severityColor(severity: string): string {
  switch (severity) {
    case "blocker":
      return ANSI.red;
    case "warning":
      return ANSI.yellow;
    case "informational":
      return ANSI.dim;
    default:
      return "";
  }
}

function renderKeyValueSection(
  title: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  width: number,
  valueTitle: string,
): readonly string[] {
  if (rows.length === 0) return [];
  const labelWidth = Math.max(1, Math.min(28, Math.max(6, width - 10)));
  const valueWidth = Math.max(1, width - labelWidth - 1);
  const cols: TableColumn[] = [
    { key: "label", title: "Item", width: labelWidth },
    { key: "value", title: valueTitle, width: valueWidth },
  ];
  try {
    return [clipDisplay(title, width), ...renderTable(rows, cols, { height: rows.length + 1 })];
  } catch {
    return [clipDisplay(title, width), clipDisplay("(render error)", width)];
  }
}

function renderFindingsSection(
  rows: readonly Readonly<Record<string, unknown>>[],
  width: number,
  color: boolean,
): readonly string[] {
  if (rows.length === 0) return [];
  const ruleWidth = Math.max(1, Math.min(8, width));
  const sevWidth = Math.max(1, Math.min(14, Math.max(1, width - ruleWidth - 2)));
  const detailWidth = Math.max(1, width - ruleWidth - sevWidth - 2);
  const cols: TableColumn[] = [
    { key: "rule_id", title: "Rule", width: ruleWidth },
    { key: "severity", title: "Sev", width: sevWidth },
    { key: "value", title: "Detail", width: detailWidth },
  ];
  try {
    const lines = renderTable(rows, cols, { height: rows.length + 1 });
    if (!color) return [clipDisplay("Findings", width), ...lines];
    const styled = lines.map((line, index) => {
      if (index === 0) return line; // header row: never colored
      const row = rows[index - 1];
      const severity = typeof row?.severity === "string" ? row.severity : "";
      const code = severityColor(severity);
      return code === "" ? line : clipAnsi(`${code}${line}${ANSI.reset}`, width);
    });
    return [clipDisplay("Findings", width), ...styled];
  } catch {
    return [clipDisplay("Findings", width), clipDisplay("(render error)", width)];
  }
}

function renderGovernance(
  projection: ScreenProjection,
  width: number,
  height: number,
  color: boolean,
): readonly string[] {
  const rows = projection.rows;
  const records = bySection(rows, "records");
  const obligations = bySection(rows, "obligations");
  const findings = bySection(rows, "finding");
  const counts = bySection(rows, "counts");
  const legacy = bySection(rows, "legacy");

  const lines: string[] = [clipDisplay(projection.caption ?? "Governance", width)];

  if (records.length > 0) lines.push("", ...renderKeyValueSection("Records by decision", records, width, "Count"));
  if (obligations.length > 0) lines.push("", ...renderKeyValueSection("Obligation coverage", obligations, width, "Detail"));
  if (findings.length > 0) lines.push("", ...renderFindingsSection(findings, width, color));
  if (counts.length > 0) lines.push("", ...renderKeyValueSection("Repository counts", counts, width, "Count"));
  if (legacy.length > 0) lines.push("", ...renderKeyValueSection("Legacy classification", legacy, width, "Count"));

  return lines.slice(0, Math.max(1, height)).map((line) => clipDisplay(line, width));
}

// ── {ok:false} envelope: a real reported failure, never rendered as "no data" ─

/**
 * `arbor-mcp governance --json`'s `{ok:false,error,capability}` half of the
 * envelope. Rendered as an explicit failure state — distinct from
 * `emptyProjection()`'s "awaiting first projection" — because a governance
 * command that ran and reported a real error is a materially different fact
 * from one that has simply never run yet. `error` is `unknown` here on
 * purpose: `isGovernanceErrorEnvelopeShape`'s match only proved `ok===false`,
 * not that `error` itself is well-formed, so every field is re-validated
 * here, matching this file's own discipline everywhere else.
 */
function errorProjection(error: unknown): Omit<ScreenProjection, "variant"> {
  const message = isRecord(error) && typeof error.message === "string" ? error.message : "governance snapshot failed";
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "unknown";
  return {
    screen: "governance",
    rows: [{ section: "error", label: "error", value: message }],
    columns: [
      { key: "label", title: "Item", width: 28 },
      { key: "value", title: "Detail", width: 44 },
    ],
    caption: `Governance: FAILED (${code})`,
  };
}

function renderGovernanceError(projection: ScreenProjection, width: number, height: number): readonly string[] {
  const lines: string[] = [clipDisplay(projection.caption ?? "Governance: FAILED", width)];
  const detail = projection.rows[0]?.value;
  if (typeof detail === "string" && detail.length > 0) lines.push("", clipDisplay(detail, width));
  return lines.slice(0, Math.max(1, height)).map((line) => clipDisplay(line, width));
}

// ── empty / fallback ─────────────────────────────────────────────────────────

/**
 * `null`/not-yet-issued ("empty") and a real, non-null result matching none
 * of this screen's recognized shapes ("unrecognised") are different facts —
 * the first is "nothing has run yet", the second is a real response that
 * arrived and could not be read, e.g. a future schema change or a
 * `governance-projection.ts` bug. Collapsing both into "awaiting first
 * projection... has never been produced" would tell an operator that
 * nothing has happened when something did happen and this screen simply
 * failed to parse it — silently hiding a real wiring defect behind a
 * message that reads as "everything is normal, just early" (WA-59; see
 * `empty-state.ts`, and every other screen in this pipeline that already
 * distinguishes the two: `jobs.ts`, `tasks.ts`, `config.ts`, `backlog.ts`,
 * `communications.ts`, `operations.ts`, `agents.ts`, `devtools.ts`, `kb.ts`).
 */
function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "governance",
    rows: [],
    columns: [
      { key: "label", title: "Item", width: 28 },
      { key: "value", title: "Detail", width: 44 },
    ],
    caption: reason === "empty"
      ? emptyCaption({ what: "No ADR governance snapshot has been produced yet — awaiting first projection", how: "run `arbor-mcp governance --json`" })
      : unrecognisedCaption("Governance"),
  };
}

// ── variant + exported module ───────────────────────────────────────────────

const GOVERNANCE_VARIANTS = [
  defineVariant({
    tag: "greenfield-absence",
    match: isGovernanceAbsenceShape,
    project: (shape) => ({
      screen: "governance" as ScreenId,
      rows: [],
      columns: [{ key: "label", title: "Item", width: 28 }],
      caption: typeof shape.message === "string" ? shape.message : "No canonical ADRs yet.",
    }),
    render: (projection, ctx) => {
      const caption = projection.caption ?? "No canonical ADRs yet.";
      // Keep the producer's explanatory message, but turn its common
      // headline/em-dash form into compact rows. A single clipped sentence
      // is hard to scan in the 80-column compact viewport and leaves the
      // operator without a clear next-state explanation.
      const [headline, detail] = caption.split(" — ", 2);
      return [
        clipDisplay(headline || caption, ctx.width),
        ...(detail ? [clipDisplay(detail, ctx.width)] : []),
        clipDisplay("Normal greenfield absence; no ADR state is inferred from a missing store.", ctx.width),
      ].slice(0, Math.max(1, ctx.height));
    },
  }),
  // `arbor-mcp governance --json`'s real, current output shape (C2): the
  // `GovernanceResult<GovernanceSnapshot>` envelope. Tried before the bare
  // "snapshot" variant below so a real envelope is never mistaken for "no
  // data" just because its top-level keys are `ok`/`value`/`capability`
  // rather than the snapshot's own facet keys.
  defineVariant({
    tag: "envelope-ok",
    match: isGovernanceOkEnvelopeShape,
    // Truncation is bounded by the screen's own MAX_FINDING_ROWS, not the
    // current viewport height (wave2/tui-input-model; same defect jobs.ts's
    // identical comment describes). Note: this screen composes several
    // fixed-size dashboard sections into one flat output rather than a
    // single paginated list (`renderGovernance` always requests
    // `height: rows.length + 1`, i.e. "show everything," relying on the
    // outer pane's own clip) — real per-section scroll offset threading is
    // out of scope for this pass; only the height-coupling defect is fixed
    // here, matching every other screen.
    project: (shape) => projectGovernance(shape.value, MAX_FINDING_ROWS),
    render: (projection, ctx) => renderGovernance(projection, ctx.width, ctx.height, ctx.color === true),
  }),
  defineVariant({
    tag: "envelope-error",
    match: isGovernanceErrorEnvelopeShape,
    project: (shape) => errorProjection(shape.error),
    render: (projection, ctx) => renderGovernanceError(projection, ctx.width, ctx.height),
  }),
  // Legacy/direct shape: a bare `GovernanceSnapshot` passed straight through
  // (e.g. an in-process caller that already unwrapped `.value` itself,
  // never round-tripping through `--json`'s JSON text at all).
  defineVariant({
    tag: "snapshot",
    match: isGovernanceSnapshotShape,
    // See the "envelope-ok" variant above for why this is decoupled from height.
    project: (shape) => projectGovernance(shape, MAX_FINDING_ROWS),
    render: (projection, ctx) => renderGovernance(projection, ctx.width, ctx.height, ctx.color === true),
  }),
];

export const governanceScreen: ScreenModule = {
  id: "governance" as ScreenId,
  title: "Governance",
  required_capabilities: ["governance.read"],

  surface: {
    commands: [],
    queries: ["governance.snapshot"],
  },

  // The greenfield absence is a matched, truthful state with its own
  // headline/detail rendering. Do not let the shared zero-row short-circuit
  // collapse it back to one clipped producer sentence in compact view.
  ...buildScreenPipeline(GOVERNANCE_VARIANTS, { emptyProjection, shortCircuitEmptyRows: false }),
};
