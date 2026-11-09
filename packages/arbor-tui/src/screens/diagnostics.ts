/**
 * Diagnostics screen (roadmap 4C, item 20).
 *
 * Renders a bounded event / trace timeline derived from `event.resume`.
 * Causal ordering by the event stream's own monotonic cursor sequence,
 * never a raw log dump. Typed trace records are kept separate from
 * evidence — no conflating logs with evidence entries.
 *
 * The real `event.resume` contract (`runtime-catalog.ts`'s
 * `executeQueryValue`, `event.resume` case) is
 * `RuntimeEventStream.resume()`'s literal return value:
 * `{ kind: "events"; cursor: RuntimeCursor; events: RuntimeEventEnvelope[] }`
 * (or `{ kind: "snapshot"; snapshot }` on a cursor gap — not a timeline, and
 * not handled here, matching `webui.ts`'s own dispatch on `resumed.kind`).
 * Each `RuntimeEventEnvelope` (`arbor-core/src/runtime-contracts.ts`) nests
 * its actual payload under `.event` (`{ kind, ...fields }`, a discriminated
 * `RuntimeEvent` variant) and carries `occurred_at` (ISO 8601) and
 * `cursor.sequence` (a monotonic integer) at the envelope level — never a
 * flat `{at, kind, node_id, details}` record.
 *
 * `RuntimePortAdapter.query` (`arbor-mcp/src/tui-adapter.ts`) is this
 * screen's only real caller for `event.resume`: it forwards
 * `RuntimeCatalogRouter.executeQuery`'s `.value` straight through with no
 * reshaping. There is exactly one real shape reaching this screen — checked
 * before collapsing to a single variant, unlike `campaigns.ts`, which
 * genuinely has two real callers feeding two different shapes.
 *
 * This is a leaf module. It depends only on @arbor/core (via widgets)
 * and the runtime-port/screen contracts — never @arbor/mcp, @arbor/kb,
 * @arbor/audit, or @arbor/gate.
 */

import { clipDisplay, wrapDisplay } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";

// ── cardinality bounds ───────────────────────────────────────────────────────

const MAX_EVENT_ROWS = 500;
const MAX_CAPTION_LENGTH = 80;

// ── duck-typing helpers (never importing @arbor/core's RuntimeEvent types) ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "?";
}

// ── shape detection ──────────────────────────────────────────────────────────

interface EventResumeShape {
  readonly events: readonly Record<string, unknown>[];
}

/**
 * The real `event.resume` shape: `{kind: "events", cursor, events: RuntimeEventEnvelope[]}`.
 *
 * A genuinely empty timeline (a freshly booted runtime with no events
 * published yet) is a real result, not an edge case to special-case away —
 * the same bug already found and fixed in `screens/operations.ts`'s
 * `isOperationListShape` and `screens/output.ts`'s `isCaptureListShape`:
 * requiring `events.length > 0` makes a real, successful, empty dispatch
 * indistinguishable from a query that was never issued at all (both fall
 * through to `emptyProjection()`'s "No events"). Dropping the length check
 * routes a real empty result to `projectTimeline`'s own "Events: 0" caption
 * instead, so the two cases render different text.
 */
function isEventResumeShape(result: unknown): result is EventResumeShape {
  return isRecord(result) && result.kind === "events" && Array.isArray(result.events);
}

// ── causal ordering (by the stream's own monotonic cursor sequence) ─────────

function sequenceOf(envelope: Record<string, unknown>): number {
  const cursor = isRecord(envelope.cursor) ? envelope.cursor : {};
  return typeof cursor.sequence === "number" ? cursor.sequence : Number.MAX_SAFE_INTEGER;
}

function causalCompare(
  a: Record<string, unknown> & { _idx: number },
  b: Record<string, unknown> & { _idx: number },
): number {
  const seqA = sequenceOf(a);
  const seqB = sequenceOf(b);
  if (seqA !== seqB) return seqA - seqB;

  // fallback: index within the result (stable sort)
  return a._idx - b._idx;
}

// ── per-kind event payload → display fields ──────────────────────────────────

/**
 * `RuntimeEvent` (`arbor-core/src/runtime-contracts.ts`) is a discriminated
 * union with no shared `node_id`/`details` fields — each kind carries
 * different, kind-specific data. This derives a factual summary/detail pair
 * for the source-labelled diagnostic document, duck-typed per this module's
 * @arbor/core-via-widgets-only constraint.
 */
function describeEvent(payload: Record<string, unknown>): { node_id: string; details: string } {
  switch (payload.kind) {
    case "campaign.changed":
      return { node_id: "-", details: `${str(payload.campaign_id)} ${str(payload.change)}` };
    case "tree.node_changed":
      return { node_id: str(payload.node_id), details: `-> ${str(payload.state)}` };
    case "gate.recorded": {
      const bypassDeficit = typeof payload.bypass_evidence_deficit === "string" ? payload.bypass_evidence_deficit : null;
      return {
        node_id: payload.node_id === null || payload.node_id === undefined ? "-" : str(payload.node_id),
        details: bypassDeficit
          ? `${str(payload.gate)}: ${str(payload.result)} (bypass: ${bypassDeficit})`
          : `${str(payload.gate)}: ${str(payload.result)}`,
      };
    }
    case "kb.entry_added":
      return { node_id: "-", details: `entry ${str(payload.entry_id)}` };
    case "audit.evidence_recorded":
      return { node_id: "-", details: `evidence ${str(payload.evidence_id)}` };
    case "operation.accepted":
      return { node_id: "-", details: `op ${str(payload.accepted_operation_id)} accepted` };
    case "operation.rejected": {
      const error = isRecord(payload.error) ? payload.error : {};
      const refusal = isRecord(error.gate_refusal) ? error.gate_refusal : null;
      const remedy = refusal === null ? "" : `; owner=${str(refusal.correcting_actor)}; ${str(refusal.remediation)}; ${refusal.corrective_action === undefined ? `next: ${str(refusal.next_command)}` : `action: ${str(refusal.corrective_action)}`}`;
      return { node_id: "-", details: `${str(error.code)}: ${str(error.summary)}${remedy}` };
    }
    case "task.changed": {
      const task = isRecord(payload.task) ? payload.task : {};
      return { node_id: "-", details: `task ${str(task.id)} -> ${str(task.state)}` };
    }
    case "taskcomposer.changed":
      return { node_id: "-", details: `draft ${str(payload.draft_id)} -> ${str(payload.status)} (revision ${str(payload.revision)})` };
    case "stream.truncated":
      return { node_id: "-", details: `${str(payload.stream_id)} dropped=${str(payload.dropped_records)}` };
    case "tree.decomposed":
      return {
        node_id: str(payload.parent_id),
        details: `decomposed -> ${Array.isArray(payload.children_ids) ? payload.children_ids.length : 0} child(ren), depth ${str(payload.depth)}`,
      };
    default:
      // A kind this switch has no case for — either malformed input, or (the
      // real risk) `RuntimeEvent` gained a new discriminant this leaf module
      // was never updated to know about. This module deliberately duck-types
      // rather than importing `RuntimeEvent` (so it can't ask TypeScript for
      // compile-time exhaustiveness without breaking that isolation —
      // `screens-diagnostics-exhaustiveness.test.ts` carries an
      // import-`@arbor/core`-only-in-the-test canary that fails
      // `npm run build` the moment the real union outpaces this list), so
      // the runtime fallback must at least be VISIBLE: naming the unhandled
      // kind, never rendering the same blank `{node_id:"-", details:""}` a
      // legitimately detail-less real event (e.g. `operation.accepted`)
      // would also produce — that blank was indistinguishable from "this
      // event kind is unknown to the screen."
      return {
        node_id: "-",
        details: typeof payload.kind === "string" && payload.kind.length > 0
          ? `unhandled event kind: ${payload.kind}`
          : "unhandled event kind",
      };
  }
}

type DiagnosticState = "observed" | "attention" | "failed" | "interrupted";

/**
 * This is a presentation classification over a durable event, not a new
 * lifecycle. Only terminal states which the producer has already named are
 * given terminal treatment. Attention marks an inspectable condition without
 * pretending the underlying campaign/node has settled.
 */
function diagnosticState(payload: Record<string, unknown>): DiagnosticState {
  if (payload.kind === "tree.node_changed") {
    if (payload.state === "failed") return "failed";
    if (payload.state === "interrupted") return "interrupted";
  }
  if (payload.kind === "task.changed") {
    const task = isRecord(payload.task) ? payload.task : {};
    if (task.state === "failed") return "failed";
    if (task.state === "cancelled") return "interrupted";
  }
  if (payload.kind === "operation.rejected") return "failed";
  if (payload.kind === "gate.recorded" && (payload.result === "fail" || payload.result === "blocked")) return "attention";
  if (payload.kind === "stream.truncated") return "attention";
  return "observed";
}

function diagnosticGlyph(state: DiagnosticState): string {
  switch (state) {
    case "failed": return "!";
    case "interrupted": return "×";
    case "attention": return "!";
    case "observed": return "·";
  }
}

// ── projection ───────────────────────────────────────────────────────────────

/** The envelope's own `id` (`RuntimeEventEnvelope.id`) when present, else the cursor's monotonic `sequence` — both real, stable per-event identities. */
function envelopeId(envelope: Record<string, unknown>): string | null {
  if (typeof envelope.id === "string" && envelope.id.length > 0) return envelope.id;
  const cursor = isRecord(envelope.cursor) ? envelope.cursor : {};
  if (typeof cursor.sequence === "number") return String(cursor.sequence);
  return null;
}

function projectTimeline(
  raw: readonly Record<string, unknown>[],
  limit: number,
): Omit<ScreenProjection, "variant"> {
  // Tag each entry with its original position for stable fallback sort
  const tagged: (Record<string, unknown> & { _idx: number })[] = raw.map(
    (e, i) => Object.assign({}, e, { _idx: i }) as Record<string, unknown> & { _idx: number },
  );
  tagged.sort(causalCompare);
  const sliced = tagged.slice(0, limit);

  const rows: readonly Readonly<Record<string, unknown>>[] = sliced
    .map((envelope) => {
      const payload = isRecord(envelope.event) ? envelope.event : {};
      const { node_id, details } = describeEvent(payload);
      const kind = typeof payload.kind === "string" ? payload.kind : "unhandled event kind";
      const state = diagnosticState(payload);
      return {
        at: typeof envelope.occurred_at === "string" ? formatOccurredAt(envelope.occurred_at) : "?",
        kind,
        node_id,
        source: "canonical/event.resume",
        state,
        summary: node_id === "-" ? kind : `${kind} · node ${node_id}`,
        detail: details,
      };
    });

  return {
    screen: "diagnostics",
    rows,
    columns: [
      { key: "summary", title: "Diagnostic event", width: 44 },
      { key: "state", title: "State", width: 12 },
      { key: "source", title: "Source", width: 24 },
    ],
    row_ids: sliced.map((envelope): RowIdentity | null => {
      const id = envelopeId(envelope);
      return id === null ? null : { id };
    }),
    caption: clipDisplay(
      `Events: ${rows.length}`,
      MAX_CAPTION_LENGTH,
    ),
  };
}

// ── timestamp formatting (ISO 8601 occurred_at → wall-clock HH:MM:SS, UTC) ──

function formatOccurredAt(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// ── render ───────────────────────────────────────────────────────────────────

function renderTimeline(
  projection: ScreenProjection,
  width: number,
  height: number,
  offset?: number,
  selectedId?: string,
): readonly string[] {
  const rows = projection.rows;

  // The caption already distinguishes a real, empty timeline ("Events: 0",
  // set by `projectTimeline`) from the "No events" fallback used when no
  // dispatch has happened at all (`emptyProjection`) — render it rather than
  // a fixed string that would collapse both cases back to the same text.
  if (rows.length === 0) {
    return [clipDisplay(projection.caption ?? "(no events)", width)];
  }

  const header = clipDisplay(`${projection.caption ?? "Timeline"} · canonical/event.resume · cursor ordered`, width);
  const start = Math.min(Math.max(0, offset ?? 0), rows.length);
  const lines: string[] = [];
  for (const row of rows.slice(start)) {
    const state: DiagnosticState = row.state === "failed" || row.state === "interrupted" || row.state === "attention"
      ? row.state
      : "observed";
    const selected = typeof row.id === "string" && row.id === selectedId ? "›" : " ";
    const summary = `${selected}${diagnosticGlyph(state)} ${String(row.at ?? "?")} ${String(row.summary ?? "diagnostic event")} · ${state}`;
    const detail = `  ${String(row.source ?? "canonical/event.resume")} · ${String(row.detail ?? "detail unavailable")}`;
    lines.push(...wrapDisplay(summary, width).slice(0, 2));
    // An attention or terminal condition must keep its actionable explanation
    // in the primary document; ordinary chronology gets the same bounded,
    // inspectable detail without a second opaque table path.
    lines.push(...wrapDisplay(detail, Math.max(1, width)).slice(0, state === "observed" ? 1 : 2));
    if (lines.length >= Math.max(0, height - 1)) break;
  }
  return [header, ...lines.slice(0, Math.max(0, height - 1))];
}

// ── empty / fallback ─────────────────────────────────────────────────────────

function emptyProjection(): Omit<ScreenProjection, "variant"> {
  return {
    screen: "diagnostics",
    rows: [],
    columns: [
      { key: "summary", title: "Diagnostic event", width: 44 },
    ],
    caption: "No events",
  };
}

// ── variants (roadmap 4F.8) ──────────────────────────────────────────────────

const DIAGNOSTICS_VARIANTS = [
  defineVariant({
    tag: "timeline",
    match: isEventResumeShape,
    project: (shape) => {
      const effective = Math.min(shape.events.length, MAX_EVENT_ROWS);
      return projectTimeline(shape.events, effective);
    },
    render: (projection, ctx) => renderTimeline(projection, ctx.width, ctx.height, ctx.scroll_offset, ctx.selected_id),
  }),
];

// ── exported module ──────────────────────────────────────────────────────────

export const diagnosticsScreen: ScreenModule = {
  id: "diagnostics" as ScreenId,
  title: "Diagnostics",
  required_capabilities: ["event.read"],

  surface: {
    commands: [],
    queries: ["event.resume"],
  },

  ...buildScreenPipeline(DIAGNOSTICS_VARIANTS, { emptyProjection, shortCircuitEmptyRows: false }),
};
