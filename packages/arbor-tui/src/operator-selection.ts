/**
 * Pure record-selection helpers for the operator command surface (A-3
 * remediation). Given the raw, already-fetched query result sitting in
 * `AppModel.screens.get(screenId)`, pick the one record a single-key
 * operator control (answer / approve / reject) should act on.
 *
 * Deliberately conservative: these read the exact shapes the real
 * `userinput.list` / `approval.list` queries return (verified against
 * `packages/arbor-mcp/src/userinput-contracts.ts` and `approval-contracts.ts`)
 * and return `null` on anything unexpected rather than guessing.
 */
import { compareCodeUnits } from "@arbor/core";
import type { ScreenId } from "./screens/screen.js";

export interface InterviewTarget {
  readonly record_id: string;
  readonly question: string;
  readonly options?: readonly { readonly id: string; readonly text: string; readonly is_other: boolean }[];
}

export interface ApprovalTarget {
  readonly request_id: string;
  readonly action: string;
  readonly action_fingerprint: string | null;
}

function approvalTarget(item: Record<string, unknown>): ApprovalTarget | null {
  return typeof item.request_id === "string" ? {
    request_id: item.request_id,
    action: typeof item.action === "string" ? item.action : "unknown",
    action_fingerprint: typeof item.action_fingerprint === "string" ? item.action_fingerprint : null,
  } : null;
}

/**
 * A per-screen operator row selection (wave2/tui-input-model), generalizing
 * the Tree screen's previously tree-only `TreeSelection` so any screen can
 * key `AppModel.selection` by its own row id. `context` carries whatever
 * compound key a screen's selection needs beyond a bare row id — the Tree
 * screen stores `{campaign_id}` there, the same value `TreeSelection`'s
 * dedicated `campaign_id` field used to hold directly.
 */
export interface ScreenSelection {
  readonly id: string;
  readonly context?: Readonly<Record<string, string>>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Tree identities in row order. Parent identity stays bound to the row so a
 * parent/child action cannot later be retargeted by a second lookup. */
function treeNodeIds(raw: unknown): { campaign_id: string; nodes: readonly { id: string; parent_node_id?: string }[] } | null {
  if (!record(raw) || typeof raw.campaign_id !== "string" || !Array.isArray(raw.nodes)) return null;
  const nodes = (raw.nodes as readonly unknown[])
    .filter(record)
    .flatMap((n) => typeof n.id === "string" ? [{ id: n.id, ...(typeof n.parent_id === "string" ? { parent_node_id: n.parent_id } : {}) }] : []);
  return { campaign_id: raw.campaign_id, nodes };
}

function treeSelection(campaign_id: string, node: { id: string; parent_node_id?: string }): ScreenSelection {
  return { id: node.id, context: { campaign_id, ...(node.parent_node_id === undefined ? {} : { parent_node_id: node.parent_node_id }) } };
}

/**
 * The latest interview an operator is actually still on the hook for.
 *
 * A question's own `status` field never advances past `"awaiting"`: ADR-019
 * appends the answer as a separate record rather than mutating a hash-covered
 * packet, so `status === "awaiting"` selects EVERY record, answered or not.
 * This used to compensate by taking the most recent question outright, on the
 * reasoning that a serialized loop blocks on its newest one — which is right
 * only while something is genuinely pending. Once the newest question was
 * answered, the screen kept presenting it as the live target, so an operator
 * with nothing to do was shown a question they had already answered.
 *
 * `userinput.list` now carries `answered_record_ids`, the ledger's own
 * reconciliation against the answer stream, so the newest UNANSWERED question
 * can be selected directly. Null means nothing is pending, which is a real
 * answer rather than an empty list.
 *
 * A missing `answered_record_ids` is treated as "nothing answered yet" so an
 * older projection degrades to the previous behaviour rather than blanking the
 * screen.
 */
export function latestInterview(raw: unknown, preferredRecordId?: string): InterviewTarget | null {
  if (!record(raw) || !Array.isArray(raw.records)) return null;
  const answered = new Set(
    Array.isArray(raw.answered_record_ids)
      ? raw.answered_record_ids.filter((id): id is string => typeof id === "string")
      : [],
  );
  const targetFor = (candidate: unknown): InterviewTarget | null => {
    if (!record(candidate) || typeof candidate.id !== "string" || answered.has(candidate.id)) return null;
    const candidateQuestion = record(candidate.question) ? candidate.question : null;
    const question = candidateQuestion !== null && typeof candidateQuestion.question === "string"
      ? candidateQuestion.question
      : "";
    const options = candidateQuestion !== null && Array.isArray(candidateQuestion.options)
      ? candidateQuestion.options.flatMap((option) => record(option) && typeof option.id === "string" && typeof option.is_other === "boolean"
        ? [{ id: option.id, text: typeof option.text === "string" ? option.text : option.id, is_other: option.is_other }]
        : [])
      : undefined;
    return { record_id: candidate.id, question, ...(options === undefined ? {} : { options }) };
  };
  if (preferredRecordId !== undefined) {
    const selected = raw.records.find((candidate) => record(candidate) && candidate.id === preferredRecordId);
    const target = targetFor(selected);
    if (target !== null) return target;
  }
  for (let index = raw.records.length - 1; index >= 0; index -= 1) {
    const target = targetFor(raw.records[index]);
    if (target !== null) return target;
  }
  return null;
}

/**
 * The oldest still-pending approval request — the next one an operator would
 * triage. `ApprovalRecord` has no `created_at`; `expires_at` is the only
 * timestamp, so "oldest" means soonest-to-expire, found directly by
 * comparison rather than assumed from array order — `ApprovalService.list()`
 * (approval-service.ts) actually returns `records` sorted DESCENDING by
 * `expires_at` (furthest-from-expiring first), so trusting position 0 would
 * select the LEAST urgent pending request.
 */
export function oldestPendingApproval(raw: unknown): ApprovalTarget | null {
  if (!record(raw) || !Array.isArray(raw.records)) return null;
  let soonest: Record<string, unknown> | null = null;
  let firstPending: Record<string, unknown> | null = null;
  for (const item of raw.records) {
    if (!record(item) || item.status !== "pending" || typeof item.request_id !== "string") continue;
    if (firstPending === null) firstPending = item;
    // `expires_at` is the only ordering signal, but it is not guaranteed
    // present on every record shape this function accepts. A record without
    // one carries no urgency information — it must not be DROPPED for that,
    // or a pending request becomes invisible to the operator entirely, which
    // is a worse failure than ordering it imprecisely.
    if (typeof item.expires_at !== "string") continue;
    if (soonest === null || compareCodeUnits(item.expires_at, soonest.expires_at as string) < 0) soonest = item;
  }
  const chosen = soonest ?? firstPending;
  return chosen === null ? null : approvalTarget(chosen);
}

/** A selected approval is actionable only while its durable record is pending. */
export function selectedPendingApproval(raw: unknown, requestId: string | undefined): ApprovalTarget | null {
  if (requestId === undefined || !record(raw) || !Array.isArray(raw.records)) return null;
  const found = raw.records.find((item) => record(item) && item.request_id === requestId && item.status === "pending");
  return record(found) ? approvalTarget(found) : null;
}

/**
 * Recompute the Tree screen's selection after a fresh `campaign.tree` fetch.
 * Sticky: the current selection survives a refresh as long as its node still
 * exists in the same campaign's node list. Otherwise defaults to the first
 * node (typically the root), or null when the tree is empty/unrecognized —
 * never silently keeps a selection that no longer resolves to a real node.
 */
export function stickyTreeSelection(current: ScreenSelection | null, raw: unknown): ScreenSelection | null {
  const parsed = treeNodeIds(raw);
  if (parsed === null) return current;
  const { campaign_id, nodes } = parsed;
  if (nodes.length === 0) return null;
  const selected = current !== null && current.context?.campaign_id === campaign_id ? nodes.find((node) => node.id === current.id) : undefined;
  return treeSelection(campaign_id, selected ?? nodes[0]!);
}

/**
 * Move the Tree screen's selection to the next (`direction: 1`) or previous
 * (`direction: -1`) node in the currently fetched tree's row order, wrapping
 * at the ends. Returns `current` unchanged if there is no selection, no tree
 * data for the selected campaign, or an empty node list — never guesses.
 */
/**
 * Resolve an absolute index into the tree's ordered node list to a selection —
 * the seam a pointer click needs, where `stepTreeSelection` serves a keypress.
 *
 * The index is absolute (already scroll-adjusted by the caller), NOT a
 * viewport row: this function has no idea what is on screen, and inventing a
 * viewport-relative meaning here would silently select the wrong node whenever
 * the list was scrolled. Out-of-range returns `null` rather than clamping to
 * the nearest node — a click on a blank row below the last node hit nothing,
 * and reporting that as "selected the last node" would be a false positive of
 * exactly the kind `hitTestFrame` refuses to make.
 */
export function selectTreeRow(raw: unknown, index: number): ScreenSelection | null {
  const parsed = treeNodeIds(raw);
  if (parsed === null || index < 0 || index >= parsed.nodes.length) return null;
  return treeSelection(parsed.campaign_id, parsed.nodes[index]!);
}

export function stepTreeSelection(
  current: ScreenSelection | null,
  raw: unknown,
  direction: 1 | -1,
): ScreenSelection | null {
  if (current === null) return current;
  const parsed = treeNodeIds(raw);
  if (parsed === null || parsed.campaign_id !== current.context?.campaign_id || parsed.nodes.length === 0) return current;
  const { campaign_id, nodes } = parsed;
  const index = nodes.findIndex((node) => node.id === current.id);
  if (index === -1) return treeSelection(campaign_id, nodes[0]!);
  const nextIndex = (index + direction + nodes.length) % nodes.length;
  return treeSelection(campaign_id, nodes[nextIndex]!);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Row ids (in row order) for screens whose raw query result is a simple
 * list the operator can select a single row from — generalizing
 * `treeNodeIds` to the command-surface expansion (job.cancel/retry,
 * operation.cancel, task.retry). Reads the exact live shapes each query
 * returns:
 *   - "jobs": `job.list` -> `JobQueueView` (`job-contracts.ts`), `{jobs: Job[], ...}`.
 *   - "operations": `operation.list` -> `OperationListProjection`
 *     (`operation-list-contracts.ts`), an `OperationRecord[]` directly.
 *   - "tasks": `task.list` -> a cursor page `{items: SupervisorTask[], ...}`
 *     over the live wire (`runtime-catalog.ts`'s `executeQueryValue`), or a
 *     pre-unwrapped `SupervisorTask[]` from `demo.ts` (mirrors tasks.ts's own
 *     two projection variants).
 *   - "recovery": `recovery.pending` -> `{campaign_id, nodes}`, but only
 *     nodes carrying the prior operation and snapshot version the mutation
 *     contract requires are selectable.
 * Returns `null` for a screen/shape this function doesn't recognize (never
 * guesses); `[]` is a real "no rows yet" answer, not an unrecognized shape.
 */
function screenRowIds(screen: ScreenId, raw: unknown): readonly string[] | null {
  switch (screen) {
    case "tree": {
      const parsed = treeNodeIds(raw);
      return parsed === null ? null : parsed.nodes.map((node) => node.id);
    }
    case "jobs": {
      if (!record(raw) || !Array.isArray(raw.jobs)) return null;
      return (raw.jobs as readonly unknown[]).filter(record).map((j) => (typeof j.id === "string" ? j.id : null)).filter(isString);
    }
    case "operations": {
      if (!Array.isArray(raw)) return null;
      return (raw as readonly unknown[]).filter(record).map((o) => (
        typeof o.operation_id === "string" && typeof o.state === "string" && typeof o.capability === "string"
          ? o.operation_id
          : null
      )).filter(isString);
    }
    case "tasks": {
      const items = record(raw) && Array.isArray(raw.items) ? (raw.items as readonly unknown[]) : Array.isArray(raw) ? raw : null;
      if (items === null) return null;
      return items.filter(record).map((t) => (typeof t.id === "string" ? t.id : null)).filter(isString);
    }
    case "recovery":
      return recoverySelections(raw)?.map((selection) => selection.id) ?? null;
    case "output": {
      if (!Array.isArray(raw)) return null;
      return raw.filter(record).map((entry) => {
        const source = record(entry.record) ? entry.record : entry;
        return typeof source.id === "string" ? source.id : null;
      }).filter(isString);
    }
    case "approvals": {
      if (!record(raw) || !Array.isArray(raw.records)) return null;
      return raw.records.filter(record).map((record) => typeof record.request_id === "string" ? record.request_id : null).filter(isString);
    }
    case "interviews": {
      if (!record(raw) || !Array.isArray(raw.records)) return null;
      const answered = new Set(Array.isArray(raw.answered_record_ids) ? raw.answered_record_ids.filter(isString) : []);
      return raw.records.filter(record).map((record) => typeof record.id === "string" && !answered.has(record.id) ? record.id : null).filter(isString);
    }
    case "communications":
      return communicationSelections(raw)?.map((selection) => selection.id) ?? null;
    case "overlays": {
      return overlaySelections(raw)?.map((selection) => selection.id) ?? null;
    }
    case "harness-sessions":
    case "live-session": {
      if (!record(raw) || !Array.isArray(raw.sessions)) return null;
      return raw.sessions.filter(record).map((session) => typeof session.session_id === "string" ? session.session_id : null).filter(isString);
    }
    case "harness-evaluations":
      return evaluationSelections(raw)?.map((selection) => selection.id) ?? null;
    case "task-composer":
      return taskComposerSelections(raw)?.map((selection) => selection.id) ?? null;
    // Console inherits the task-composer draft selection that the retired
    // Cockpit and Projects screens carried (ADR-149 Decision 7). It receives
    // the same `drafts` field, so `taskComposerSelections` reads it unchanged.
    case "console":
      return taskComposerSelections(raw)?.map((selection) => selection.id) ?? null;
    case "project-registry": {
      // Shared by both project.registry.list and project.manage's
      // projections (project-registry-projection.ts / project-manage.ts) —
      // both report one `entries[].project_id` array, just with different
      // sibling fields per entry.
      if (!record(raw) || !Array.isArray(raw.entries)) return null;
      return raw.entries.filter(record).map((entry) => typeof entry.project_id === "string" ? entry.project_id : null).filter(isString);
    }
    case "campaigns": {
      // campaign.list projects `{items:[{id}]}`; the Campaigns screen had no
      // row-id shape here, so j/k/arrows never selected a campaign while a
      // click (select_row_absolute via the projection's row_ids) did —
      // audit 2026-08-23 lane T2.3b.
      const items = record(raw) && Array.isArray(raw.items) ? (raw.items as readonly unknown[]) : null;
      if (items === null) return null;
      return items.filter(record).map((item) => (typeof item.id === "string" ? item.id : null)).filter(isString);
    }
    default:
      return null;
  }
}

function communicationSelections(raw: unknown): readonly ScreenSelection[] | null {
  if (!record(raw) || typeof raw.campaign_id !== "string" || typeof raw.node_id !== "string" || !Array.isArray(raw.communications)) return null;
  const campaign_id = raw.campaign_id;
  const node_id = raw.node_id;
  return raw.communications.filter(record).flatMap((communication): ScreenSelection[] =>
    typeof communication.id === "string" ? [{ id: communication.id, context: { campaign_id, node_id } }] : []);
}

/** Overlay selection retains its durable type and closed component discriminator
 * so rollback/execute controls can never guess fold vs revision/descriptor. */
function overlaySelections(raw: unknown): readonly ScreenSelection[] | null {
  if (!record(raw) || typeof raw.campaign_id !== "string") return null;
  const campaign_id = raw.campaign_id;
  const rows = [
    ...(Array.isArray(raw.active_folds) ? raw.active_folds : []).map((item) => ({ item, overlay_type: "fold" })),
    ...(Array.isArray(raw.active_harness_revisions) ? raw.active_harness_revisions : []).map((item) => ({ item, overlay_type: "harness" })),
  ];
  return rows.flatMap(({ item, overlay_type }): ScreenSelection[] => record(item) && typeof item.id === "string"
    ? [{
      id: item.id,
      context: {
        campaign_id,
        overlay_type,
        ...(typeof item.component === "string" ? { component: item.component } : {}),
        ...(typeof item.status === "string" ? { status: item.status } : {}),
        ...(record(item.evaluation) && typeof item.evaluation.outcome === "string" ? { evaluation_outcome: item.evaluation.outcome } : {}),
      },
    }] : []);
}

/** Evaluation-run rows carry the server-projected eligibility facts used only
 * to prefill forms.  The catalog/service re-checks every authority condition. */
function evaluationSelections(raw: unknown): readonly ScreenSelection[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter(record).flatMap((run): ScreenSelection[] => {
    if (typeof run.id !== "string" || typeof run.revision_id !== "string" || typeof run.state !== "string") return [];
    const evaluation = record(run.evaluation) ? run.evaluation : null;
    return [{ id: run.id, context: {
      revision_id: run.revision_id,
      state: run.state,
      outcome: typeof evaluation?.outcome === "string" ? evaluation.outcome : "",
      regression_detected: evaluation?.regression_detected === true ? "true" : "false",
      evidence_ids_json: JSON.stringify(Array.isArray(run.evidence_ids) ? run.evidence_ids : []),
    } }];
  });
}

/**
 * Composer rows carry the manager-issued draft revision and (when present)
 * its outstanding question/campaign lineage. These are only projection hints:
 * taskcomposer commands still make the canonical service re-check the CAS
 * revision and all admission authority. Never synthesize a revision from a
 * display row or an array index.
 */
function taskComposerSelections(raw: unknown): readonly ScreenSelection[] | null {
  if (!record(raw)) return null;
  const source = record(raw.drafts) ? raw.drafts : raw;
  const values = Array.isArray(source.items) ? source.items : "draft" in source ? [source.draft] : null;
  if (values === null) return null;
  return values.filter(record).flatMap((item): ScreenSelection[] => {
    if (typeof item.id !== "string" || !item.id || typeof item.revision !== "number" || !Number.isSafeInteger(item.revision) || item.revision < 1) return [];
    const proposal = record(item.proposal) ? item.proposal : null;
    const questions = proposal !== null && Array.isArray(proposal.questions) ? proposal.questions.filter(record) : [];
    const question = questions.find((candidate) => candidate.answer === null && typeof candidate.id === "string" && !!candidate.id);
    const evidence_ids = Array.isArray(item.evidence_ids)
      ? item.evidence_ids.filter((value): value is string => typeof value === "string" && !!value.trim()).slice(0, 32)
      : [];
    return [{ id: item.id, context: {
      expected_revision: String(item.revision),
      ...(question && typeof question.id === "string" ? { question_id: question.id } : {}),
      ...(typeof item.campaign_id === "string" && item.campaign_id ? { campaign_id: item.campaign_id } : {}),
      evidence_ids_json: JSON.stringify(evidence_ids),
    } }];
  });
}

/**
 * Harness session rows carry whether the session can still be interrupted.
 * `update.ts`'s `cancel_selected_row` reads `context.interruptible === "no"`
 * to WARN instead of dispatching `harness.session.interrupt` at a session
 * that already recorded a terminal cause — mirrors
 * `screens/harness-sessions.ts`'s own `row_ids` computation exactly.
 * `live-session` additionally only ever shows still-live rows
 * (`screens/live-session.ts`'s `isLiveRow`: `attachable === true` and no
 * `terminal`) — filtered here too, so a keyboard cursor can never land on a
 * session id that screen itself never displays.
 */
function harnessSessionSelections(screen: ScreenId, raw: unknown): readonly ScreenSelection[] | null {
  if (!record(raw) || !Array.isArray(raw.sessions)) return null;
  const sessions = (raw.sessions as readonly unknown[]).filter(record);
  const eligible = screen === "live-session"
    ? sessions.filter((session) => session.attachable === true && (session.terminal === null || session.terminal === undefined))
    : sessions;
  return eligible.flatMap((session): ScreenSelection[] => {
    if (typeof session.session_id !== "string") return [];
    const terminal = record(session.terminal) && typeof session.terminal.cause === "string";
    return [{ id: session.session_id, context: { interruptible: terminal ? "no" : "yes" } }];
  });
}

/** Thread message rows carry the parent/child CAS scope plus the author/ack
 * facts `threadAckFormContext` needs to pick the acknowledging endpoint —
 * the same compound-context shape `communicationSelections` uses. */
function threadSelections(raw: unknown): readonly ScreenSelection[] | null {
  if (!record(raw) || typeof raw.parent_node_id !== "string" || typeof raw.child_node_id !== "string" || typeof raw.version !== "string" || !Array.isArray(raw.messages)) return null;
  const parent_node_id = raw.parent_node_id;
  const child_node_id = raw.child_node_id;
  const expected_thread_version = raw.version;
  return raw.messages.filter(record).flatMap((message): ScreenSelection[] => typeof message.id === "string"
    ? [{
      id: message.id,
      context: {
        parent_node_id,
        child_node_id,
        expected_thread_version,
        author_node_id: typeof message.author_node_id === "string" ? message.author_node_id : "",
        ack_required: message.ack_required === true ? "true" : "false",
      },
    }] : []);
}

/** Recovery actions use a compound, CAS-protected durable target. */
function recoverySelections(raw: unknown): readonly ScreenSelection[] | null {
  if (!record(raw) || typeof raw.campaign_id !== "string" || !Array.isArray(raw.nodes)) return null;
  const campaign_id = raw.campaign_id;
  return raw.nodes.filter(record).flatMap((node): ScreenSelection[] => (
    typeof node.node_id === "string" && typeof node.prior_operation_id === "string" && typeof node.expected_version === "string"
      ? [{ id: node.node_id, context: { campaign_id, prior_operation_id: node.prior_operation_id, expected_version: node.expected_version } }]
      : []
  ));
}

/**
 * Generalizes `selectTreeRow` to any screen with recognized row ids
 * (wave2/tui-input-model command-surface expansion). Resolves an absolute,
 * already scroll-adjusted row index into a selection, or `null` when the
 * index is out of range or the screen's row shape isn't recognized yet.
 * Tree keeps its own dedicated `selectTreeRow` (compound `context.campaign_id`
 * key); every other screen selects a bare row id.
 */
export function selectScreenRow(screen: ScreenId, raw: unknown, index: number): ScreenSelection | null {
  if (screen === "tree") return selectTreeRow(raw, index);
  if (screen === "recovery") {
    const selections = recoverySelections(raw);
    return selections === null || index < 0 || index >= selections.length ? null : selections[index];
  }
  if (screen === "communications") {
    const selections = communicationSelections(raw);
    return selections === null || index < 0 || index >= selections.length ? null : selections[index];
  }
  if (screen === "threads") {
    const selections = threadSelections(raw);
    return selections === null || index < 0 || index >= selections.length ? null : selections[index];
  }
  if (screen === "harness-sessions" || screen === "live-session") {
    const selections = harnessSessionSelections(screen, raw);
    return selections === null || index < 0 || index >= selections.length ? null : selections[index];
  }
  if (screen === "overlays") {
    const selections = overlaySelections(raw);
    return selections === null || index < 0 || index >= selections.length ? null : selections[index];
  }
  if (screen === "harness-evaluations") {
    const selections = evaluationSelections(raw);
    return selections === null || index < 0 || index >= selections.length ? null : selections[index];
  }
  if (screen === "task-composer" || screen === "console") {
    const selections = taskComposerSelections(raw);
    return selections === null || index < 0 || index >= selections.length ? null : selections[index];
  }
  const ids = screenRowIds(screen, raw);
  if (ids === null || index < 0 || index >= ids.length) return null;
  return { id: ids[index] };
}

/** Select the first or last concrete row without depending on repeated key timing. */
export function selectScreenEndpoint(screen: ScreenId, raw: unknown, endpoint: "first" | "last"): ScreenSelection | null {
  const selections = screen === "recovery" ? recoverySelections(raw)
    : screen === "communications" ? communicationSelections(raw)
    : screen === "threads" ? threadSelections(raw)
    : screen === "harness-sessions" || screen === "live-session" ? harnessSessionSelections(screen, raw)
    : screen === "overlays" ? overlaySelections(raw)
    : screen === "harness-evaluations" ? evaluationSelections(raw)
    : screen === "task-composer" || screen === "console" ? taskComposerSelections(raw)
    : null;
  if (selections !== null) return selections.length === 0 ? null : selections[endpoint === "first" ? 0 : selections.length - 1]!;
  const ids = screenRowIds(screen, raw);
  if (ids === null || ids.length === 0) return null;
  return { id: ids[endpoint === "first" ? 0 : ids.length - 1]! };
}

/**
 * Generalizes `stepTreeSelection`: move the given screen's selection to the
 * next (`direction: 1`) or previous (`direction: -1`) row in its currently
 * fetched row order, wrapping at the ends. Returns `current` unchanged when
 * there is no selection yet, the screen's row data isn't recognized, or the
 * row list is empty — never guesses a new selection.
 */

/**
 * A first keypress with nothing selected lands on the first row (Down/j) or
 * the last row (Up/k). Before this, every branch returned early on a null
 * selection, so keyboard selection could never START on any screen — only a
 * click or a sticky refresh could seed it (audit 2026-08-23 lane T2.3b).
 */
function seedSelection<T>(selections: readonly T[], direction: 1 | -1): T | null {
  if (selections.length === 0) return null;
  return direction === 1 ? selections[0]! : selections[selections.length - 1]!;
}
export function stepScreenSelection(
  screen: ScreenId,
  current: ScreenSelection | null,
  raw: unknown,
  direction: 1 | -1,
): ScreenSelection | null {
  if (screen === "tree") return stepTreeSelection(current, raw, direction);
  if (screen === "recovery") {
    const selections = recoverySelections(raw);
    if (selections === null || selections.length === 0) return current;
    if (current === null) return seedSelection(selections, direction);
    const index = selections.findIndex((selection) => selection.id === current.id && selection.context?.expected_version === current.context?.expected_version);
    return index === -1 ? selections[0] : selections[(index + direction + selections.length) % selections.length];
  }
  if (screen === "communications") {
    const selections = communicationSelections(raw);
    if (selections === null || selections.length === 0) return current;
    if (current === null) return seedSelection(selections, direction);
    const index = selections.findIndex((selection) => selection.id === current.id);
    return index === -1 ? selections[0] : selections[(index + direction + selections.length) % selections.length];
  }
  if (screen === "threads") {
    const selections = threadSelections(raw);
    if (selections === null || selections.length === 0) return current;
    if (current === null) return seedSelection(selections, direction);
    const index = selections.findIndex((selection) => selection.id === current.id);
    return index === -1 ? selections[0] : selections[(index + direction + selections.length) % selections.length];
  }
  if (screen === "harness-sessions" || screen === "live-session") {
    const selections = harnessSessionSelections(screen, raw);
    if (selections === null || selections.length === 0) return current;
    if (current === null) return seedSelection(selections, direction);
    const index = selections.findIndex((selection) => selection.id === current.id);
    return index === -1 ? selections[0] : selections[(index + direction + selections.length) % selections.length];
  }
  if (screen === "overlays") {
    const selections = overlaySelections(raw);
    if (selections === null || selections.length === 0) return current;
    if (current === null) return seedSelection(selections, direction);
    const index = selections.findIndex((selection) => selection.id === current.id && selection.context?.overlay_type === current.context?.overlay_type);
    return index === -1 ? selections[0] : selections[(index + direction + selections.length) % selections.length];
  }
  if (screen === "harness-evaluations") {
    const selections = evaluationSelections(raw);
    if (selections === null || selections.length === 0) return current;
    if (current === null) return seedSelection(selections, direction);
    const index = selections.findIndex((selection) => selection.id === current.id);
    return index === -1 ? selections[0] : selections[(index + direction + selections.length) % selections.length];
  }
  if (screen === "task-composer" || screen === "console") {
    const selections = taskComposerSelections(raw);
    if (selections === null || selections.length === 0) return current;
    if (current === null) return seedSelection(selections, direction);
    const index = selections.findIndex((selection) => selection.id === current.id && selection.context?.expected_revision === current.context?.expected_revision);
    return index === -1 ? selections[0] : selections[(index + direction + selections.length) % selections.length];
  }
  const ids = screenRowIds(screen, raw);
  if (ids === null || ids.length === 0) return current;
  if (current === null) return { id: direction === 1 ? ids[0]! : ids[ids.length - 1]! };
  const index = ids.indexOf(current.id);
  if (index === -1) return { id: ids[0] };
  return { id: ids[(index + direction + ids.length) % ids.length] };
}

/**
 * Generalizes `stickyTreeSelection`: recompute a screen's selection after a
 * fresh fetch of its row data. Sticky — the current selection survives a
 * refresh as long as its row id is still present — defaulting to the first
 * row otherwise, or `null` when the screen has no rows. Returns `current`
 * unchanged when the fetched shape isn't recognized (never blanks a good
 * selection because of an unrelated query result).
 */
export function stickyScreenSelection(screen: ScreenId, current: ScreenSelection | null, raw: unknown): ScreenSelection | null {
  if (screen === "tree") return stickyTreeSelection(current, raw);
  if (screen === "recovery") {
    const selections = recoverySelections(raw);
    if (selections === null) return current;
    if (selections.length === 0) return null;
    return selections.find((selection) => selection.id === current?.id && selection.context?.expected_version === current.context?.expected_version) ?? selections[0];
  }
  if (screen === "communications") {
    const selections = communicationSelections(raw);
    if (selections === null) return current;
    if (selections.length === 0) return null;
    return selections.find((selection) => selection.id === current?.id) ?? selections[0];
  }
  if (screen === "threads") {
    const selections = threadSelections(raw);
    if (selections === null) return current;
    if (selections.length === 0) return null;
    return selections.find((selection) => selection.id === current?.id) ?? selections[0];
  }
  if (screen === "harness-sessions" || screen === "live-session") {
    const selections = harnessSessionSelections(screen, raw);
    if (selections === null) return current;
    if (selections.length === 0) return null;
    return selections.find((selection) => selection.id === current?.id) ?? selections[0];
  }
  if (screen === "overlays") {
    const selections = overlaySelections(raw);
    if (selections === null) return current;
    if (selections.length === 0) return null;
    return selections.find((selection) => selection.id === current?.id && selection.context?.overlay_type === current.context?.overlay_type) ?? selections[0];
  }
  if (screen === "harness-evaluations") {
    const selections = evaluationSelections(raw);
    if (selections === null) return current;
    if (selections.length === 0) return null;
    return selections.find((selection) => selection.id === current?.id) ?? selections[0];
  }
  if (screen === "task-composer" || screen === "console") {
    const selections = taskComposerSelections(raw);
    if (selections === null) return current;
    if (selections.length === 0) return null;
    return selections.find((selection) => selection.id === current?.id && selection.context?.expected_revision === current.context?.expected_revision) ?? selections[0];
  }
  const ids = screenRowIds(screen, raw);
  if (ids === null) return current;
  if (ids.length === 0) return null;
  if (current !== null && ids.includes(current.id)) return current;
  // Interviews historically answer the newest pending question by default.
  // Preserve that safe fallback while still keeping an explicit keyboard
  // selection sticky across refreshes; other operational lists retain their
  // oldest/first-row default.
  return { id: screen === "interviews" ? ids[ids.length - 1]! : ids[0]! };
}
