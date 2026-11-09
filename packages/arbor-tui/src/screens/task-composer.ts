/**
 * Governed task-composer screen.
 *
 * This leaf is deliberately only a bounded projection over the canonical
 * `taskcomposer.list`/`taskcomposer.get` values. It has no model/provider,
 * campaign-manager, or connector import and therefore cannot turn a task,
 * proposal, or question into execution authority by itself. The composition
 * root dispatches its declared commands through RuntimePort.
 */
import { clipDisplay } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";

const MAX_ROWS = 100;
const MAX_ACTIONS = 8;
const MAX_RISKS = 4;

type UnknownRecord = Readonly<Record<string, unknown>>;
function record(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown, fallback = "—"): string {
  return typeof value === "string" && !!value.trim() ? value : fallback;
}
function strings(value: unknown, maximum: number): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, maximum) : [];
}

interface ComposerDraft {
  readonly id: string;
  readonly revision: number;
  readonly status: string;
  readonly task: string;
  readonly source: string;
  readonly parent_campaign_id: string | null;
  readonly evidence_ids: readonly string[];
  readonly proposal: UnknownRecord | null;
  readonly answered_questions: readonly UnknownRecord[];
  readonly planner: UnknownRecord | null;
  readonly campaign_id: string | null;
  readonly job_id: string | null;
  readonly guidance: UnknownRecord | null;
  readonly updated_at: string;
}

function draft(value: unknown): ComposerDraft | null {
  if (!record(value) || typeof value.id !== "string" || !value.id.trim() || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.status !== "string" || !value.status.trim() || typeof value.task !== "string") return null;
  return {
    id: value.id,
    revision: value.revision,
    status: value.status,
    task: value.task,
    source: string(value.source, "unknown"),
    parent_campaign_id: typeof value.parent_campaign_id === "string" ? value.parent_campaign_id : null,
    evidence_ids: strings(value.evidence_ids, 32),
    proposal: record(value.proposal) ? value.proposal : null,
    answered_questions: Array.isArray(value.answered_questions) ? value.answered_questions.filter(record) : [],
    planner: record(value.planner) ? value.planner : null,
    campaign_id: typeof value.campaign_id === "string" ? value.campaign_id : null,
    job_id: typeof value.job_id === "string" ? value.job_id : null,
    guidance: record(value.guidance) ? value.guidance : null,
    updated_at: string(value.updated_at),
  };
}

function listShape(value: unknown): value is { readonly items: readonly unknown[] } {
  return record(value) && Array.isArray(value.items);
}
function getShape(value: unknown): value is { readonly draft: unknown } {
  return record(value) && "draft" in value;
}

function pendingQuestion(input: ComposerDraft): { readonly id: string; readonly question: string } | null {
  const questions = input.proposal !== null && Array.isArray(input.proposal.questions) ? input.proposal.questions.filter(record) : [];
  for (const item of questions) {
    if (item.answer !== null || typeof item.id !== "string" || !item.id.trim()) continue;
    return { id: item.id, question: string(item.question) };
  }
  return null;
}

function actionScope(proposal: UnknownRecord | null): string {
  if (proposal === null) return "awaiting plan";
  const actions = Array.isArray(proposal.actions) ? proposal.actions.filter(record).slice(0, MAX_ACTIONS) : [];
  if (actions.length === 0) return "no actions proposed";
  return actions.map((action) => string(action.description, string(action.category, "action"))).join("; ");
}

function risks(proposal: UnknownRecord | null): string {
  if (proposal === null) return "—";
  const notes = strings(proposal.risk_notes, MAX_RISKS);
  return notes.length ? notes.join("; ") : "none stated";
}

function interviewHistory(item: ComposerDraft): string {
  if (item.answered_questions.length === 0) return "none recorded";
  return item.answered_questions.map((answer) => `${string(answer.question)} → ${string(answer.answer)} (${string(answer.answered_at)})`).join("; ");
}

function plannerStatus(planner: UnknownRecord | null): string {
  if (planner === null) return "not planned";
  const kind = string(planner.kind, "unknown");
  const error = typeof planner.error === "string" && planner.error.trim() ? `: ${planner.error}` : "";
  return `${kind}${error}`;
}

/**
 * The list is an attention queue, not an export of every draft field.  Keep
 * the lifecycle-specific detail in the dossier and make the first screen
 * answer the three questions an operator has at a glance: what is this, what
 * needs attention, and how fresh is it?
 */
function attention(item: ComposerDraft, question: { readonly id: string; readonly question: string } | null): string {
  if (question !== null) return "Needs answer";
  const status = item.status.toLowerCase();
  if (status === "answered") return "Answered (claimed)";
  if (status === "cancelled") return "Stopped";
  if (status.includes("reject")) return "Needs revision";
  if (status.includes("fail")) return "Failed";
  if (status.includes("complete") || status.includes("verified")) return "Complete";
  if (item.campaign_id !== null || item.job_id !== null || status.includes("running") || status.includes("active")) return "Working";
  if (item.proposal === null) return "Planning";
  if (status.includes("propos")) return "Ready to confirm";
  return item.status;
}

function shortPlan(item: ComposerDraft): string {
  return string(item.guidance?.headline, string(item.proposal?.summary, plannerStatus(item.planner)));
}

function projectDrafts(drafts: readonly ComposerDraft[]): Omit<ScreenProjection, "variant"> {
  const rows = drafts.slice(0, MAX_ROWS).map((item) => {
    const question = pendingQuestion(item);
    const proposal = item.proposal;
    return {
      id: item.id,
      revision: String(item.revision),
      status: item.status,
      task: clipDisplay(item.task, 42),
      attention: attention(item, question),
      plan: clipDisplay(shortPlan(item), 36),
      proposal: clipDisplay(string(proposal?.summary, plannerStatus(item.planner)), 32),
      scope: clipDisplay(actionScope(proposal), 36),
      risk: clipDisplay(risks(proposal), 26),
      question: clipDisplay(question?.question ?? "—", 26),
      answered: interviewHistory(item),
      lineage: item.parent_campaign_id ?? "new task",
      run: item.campaign_id ?? item.job_id ?? "not admitted",
      evidence: item.evidence_ids.length ? `${item.evidence_ids.length} selected` : "none",
      updated: item.updated_at,
    };
  });
  return {
    screen: "task-composer",
    caption: "Describe the outcome you want. Revoy plans, checks, and starts safe work automatically; questions appear here when human input is needed. · canonical taskcomposer.list",
    rows,
    columns: [
      { key: "task", title: "Task", width: 30 },
      { key: "attention", title: "Attention", width: 17 },
      { key: "plan", title: "Plan", width: 21 },
      { key: "updated", title: "Updated", width: 13 },
    ],
    row_ids: drafts.slice(0, MAX_ROWS).map((item): RowIdentity => {
      const question = pendingQuestion(item);
      return {
        id: item.id,
        context: {
          expected_revision: String(item.revision),
          ...(question === null ? {} : { question_id: question.id }),
          ...(item.campaign_id === null ? {} : { campaign_id: item.campaign_id }),
          evidence_ids_json: JSON.stringify(item.evidence_ids),
        },
      };
    }),
  };
}

interface ListLayout {
  readonly task: number;
  readonly attention: number;
  readonly plan: number;
  readonly updated: number;
}

function listLayout(width: number): ListLayout {
  // Three separators consume nine columns. The remaining widths always sum to
  // the viewport, so the queue has no hidden horizontal content at 80x24.
  const available = Math.max(4, width - 9);
  const task = Math.max(1, Math.floor(available * 0.36));
  const attention = Math.max(1, Math.floor(available * 0.22));
  const plan = Math.max(1, Math.floor(available * 0.27));
  return { task, attention, plan, updated: Math.max(1, available - task - attention - plan) };
}

function cell(value: unknown, width: number): string {
  return clipDisplay(String(value ?? "—"), width).padEnd(width, " ");
}

function listLine(row: Readonly<Record<string, unknown>>, layout: ListLayout): string {
  return [
    cell(row.task, layout.task),
    cell(row.attention, layout.attention),
    cell(row.plan, layout.plan),
    cell(row.updated, layout.updated),
  ].join(" | ");
}

function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  if (projection.rows.length === 0) return [clipDisplay(projection.caption ?? "Task composer", width), clipDisplay("(no task drafts — use New Task to create a governed draft)", width)];
  const layout = listLayout(width);
  const header = listLine({ task: "Task", attention: "Attention", plan: "Plan", updated: "Updated" }, layout);
  const rule = "-".repeat(Math.max(1, Math.min(width, header.length)));
  const start = Math.max(0, offset ?? 0);
  const visible = projection.rows.slice(start, start + Math.max(1, height - 3));
  return [header, rule, ...visible.map((row) => clipDisplay(listLine(row, layout), width))];
}

/** Single-draft inspection is a readable dossier, not the one-row list again. */
function renderDetail(projection: ScreenProjection, width: number, height: number): readonly string[] {
  const row = projection.rows[0];
  if (row === undefined) return [clipDisplay("(task draft not found)", width)];
  const lines: string[] = [
    `DRAFT ${String(row.id)} | ${String(row.attention)} | REV ${String(row.revision)}`,
    "",
  ];
  const section = (title: string, value: unknown): void => {
    lines.push(title);
    lines.push(...wrapDisplay(String(value ?? "—"), width));
    lines.push("");
  };
  section("Task", row.task);
  section("Plan", row.proposal);
  section("Requested scope", row.scope);
  section("Risks", row.risk);
  section("Clarification", row.question);
  section("Interview history", row.answered);
  section("What happens next", row.guidance);
  section("Run and evidence", `${String(row.run)} | ${String(row.evidence)} | Updated ${String(row.updated)}`);
  const hint = String(row.question) === "—"
    ? "Ctrl+T list | Ctrl+N new task | Ctrl+Y start a review-only proposal"
    : "Ctrl+A answer clarification | Ctrl+T list | Ctrl+N new task | Ctrl+Y start a review-only proposal";
  const contentHeight = Math.max(0, height - 1);
  return [...lines.slice(0, contentHeight), hint].slice(0, Math.max(1, height)).map((line) => clipDisplay(line, width));
}

function wrapDisplay(value: string, width: number): readonly string[] {
  const limit = Math.max(1, width);
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ["—"];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= limit) {
      current = `${current} ${word}`;
    } else {
      lines.push(clipDisplay(current, limit));
      current = word;
    }
  }
  if (current) lines.push(clipDisplay(current, limit));
  return lines;
}

function emptyProjection(): Omit<ScreenProjection, "variant"> {
  return { screen: "task-composer", rows: [], columns: [{ key: "status", title: "State", width: 20 }], caption: "No tasks yet — choose New Task and describe what you want changed" };
}

export const taskComposerScreen: ScreenModule = {
  id: "task-composer" as ScreenId,
  title: "Task Composer",
  required_capabilities: ["taskcomposer.read", "taskcomposer.write"],
  surface: {
    commands: ["taskcomposer.submit", "taskcomposer.answer", "taskcomposer.confirm", "taskcomposer.cancel", "taskcomposer.retry", "taskcomposer.reject"],
    queries: ["taskcomposer.list", "taskcomposer.get"],
  },
  ...buildScreenPipeline([
    defineVariant({ tag: "list", match: listShape, project: (value) => projectDrafts(value.items.map(draft).filter((item): item is ComposerDraft => item !== null)), render: (value, context) => render(value, context.width, context.height, context.scroll_offset) }),
    defineVariant({ tag: "get", match: getShape, project: (value) => {
      const item = draft(value.draft);
      if (item === null) return projectDrafts([]);
      const projected = projectDrafts([item]);
      return {
        ...projected,
        rows: projected.rows.map((row) => ({
          ...row,
          task: item.task,
          proposal: item.proposal === null ? plannerStatus(item.planner) : string(item.proposal.summary),
          scope: actionScope(item.proposal),
          risk: risks(item.proposal),
          question: pendingQuestion(item)?.question ?? "—",
          guidance: item.guidance === null ? "—" : `${string(item.guidance.headline)} — ${string(item.guidance.recommendation)}`,
        })),
      };
    }, render: (value, context) => renderDetail(value, context.width, context.height) }),
  ], { emptyProjection, shortCircuitEmptyRows: false }),
};
