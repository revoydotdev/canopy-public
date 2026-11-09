/**
 * Diff Review screen (T2.3a / FP-20 / RV-TUI-10): a real inline diff viewer
 * — unified/split modes, hunk navigation, file navigation — over the
 * `result.review.workspace` query's already-tokenized `files`/`unified`
 * arrays, rendered through diff-view.ts's pure parser/renderers. The file
 * table (row selection, comment/revision/editor-handoff/adopt command
 * context) is unchanged from before this lane; the diff panel below it is
 * new.
 */
import { clipDisplay, renderTable } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { fromReviewLines, renderDiffFile, type DiffFile, type ReviewDiffLineLike, type ReviewFileLike } from "../diff-view.js";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

interface WorkspaceShape extends Record<string, unknown> {
  readonly files: readonly unknown[];
  readonly unified: readonly unknown[];
}

function shape(value: unknown): value is WorkspaceShape {
  return record(value) && Array.isArray(value.files) && Array.isArray(value.unified) && record(value.counts) && record(value.relationships) && record(value.conflict_preview);
}

const isReviewFileLike = (value: unknown): value is ReviewFileLike =>
  record(value) && typeof value.path === "string" && typeof value.status === "string" && typeof value.additions === "number" && typeof value.deletions === "number";
const isReviewDiffLineLike = (value: unknown): value is ReviewDiffLineLike =>
  record(value) && typeof value.kind === "string" && typeof value.text === "string";

/** Every projected screen-specific field lives behind this cast, same idiom the previous single-shot implementation already used for `review_mode`/`review_side_by_side`. */
interface ReviewProjectionExtra {
  readonly review_mode: "unified" | "side-by-side";
  readonly review_files: readonly DiffFile[];
  readonly review_file_index: number;
  readonly review_hunk_index: number;
  readonly review_truncated: boolean;
}

function project(value: WorkspaceShape): Omit<ScreenProjection, "variant"> & ReviewProjectionExtra {
  const counts = value.counts as Record<string, unknown>;
  const conflict = value.conflict_preview as Record<string, unknown>;
  const relationships = value.relationships as Record<string, unknown>;
  const provenance = record(relationships.provenance) ? relationships.provenance : {};
  const capture = record(relationships.capture) ? relationships.capture : {};
  const scopeViolations = Array.isArray(capture.scope_violations) ? capture.scope_violations.filter((path): path is string => typeof path === "string") : [];
  const declaredWritePaths = Array.isArray(capture.declared_write_paths) ? capture.declared_write_paths.filter((path): path is string => typeof path === "string") : null;

  const files = value.files.filter(record).slice(0, 200).map((file) => ({ path: String(file.path ?? "?"), state: String(file.status ?? "modified"), delta: `+${String(file.additions ?? 0)} -${String(file.deletions ?? 0)}`, conflict: String(conflict.status ?? "blocked"), provenance: String(provenance.capture ?? "unknown") }));

  const rawFiles = value.files.filter(isReviewFileLike);
  const rawLines = value.unified.filter(isReviewDiffLineLike);
  const reviewFiles = fromReviewLines(rawFiles, rawLines).files;
  const fileIndex = clampIndex(Number(value.review_file_index ?? 0), reviewFiles.length);
  const hunkIndex = clampIndex(Number(value.review_hunk_index ?? 0), reviewFiles[fileIndex]?.hunks.length ?? 0);
  const mode = value.view_mode === "side-by-side" ? "side-by-side" : "unified";
  const truncated = value.truncated === true;

  const scopeLine = scopeViolations.length > 0 ? `⚠ scope violations: ${scopeViolations.slice(0, 6).join(", ")}${scopeViolations.length > 6 ? ` (+${scopeViolations.length - 6} more)` : ""}` : null;
  const declaredLine = declaredWritePaths ? `declared write scope: ${declaredWritePaths.length} path(s)` : "declared write scope: unavailable";
  const cursorLine = reviewFiles.length > 0 ? `file ${fileIndex + 1}/${reviewFiles.length} · hunk ${(reviewFiles[fileIndex]?.hunks.length ?? 0) > 0 ? `${hunkIndex + 1}/${reviewFiles[fileIndex]!.hunks.length}` : "—"}` : "no changed files";
  const captionLines = [
    `Diff review · ${String(value.campaign_id ?? "?")} / ${String(value.node_id ?? "?")} · ${String(counts.files ?? files.length)} files +${String(counts.additions ?? 0)} -${String(counts.deletions ?? 0)} · review r${String(value.review_revision ?? "?")} · ${String(conflict.status ?? "blocked")} · ${mode} · canonical/result-review`,
    `${cursorLine} · ${declaredLine}`,
    ...(scopeLine ? [scopeLine] : []),
    ...(truncated ? ["Diff detail is bounded by the review query; use editor handoff on the selected file for complete source context."] : []),
    "Ctrl+Shift+U toggles unified/split; Shift+J/Shift+K next/prev hunk; Shift+N/Shift+P next/prev file; comments and revision requests are durable; adoption remains explicit.",
  ];

  return {
    screen: "result-review",
    caption: captionLines.join("\n"),
    rows: files,
    columns: [{ key: "path", title: "Changed file tree", width: 46 }, { key: "state", title: "State", width: 9 }, { key: "delta", title: "Δ", width: 12 }, { key: "conflict", title: "Apply", width: 10 }, { key: "provenance", title: "Prov", width: 10 }],
    row_ids: files.map((file) => ({ id: file.path, context: { campaign_id: String(value.campaign_id ?? ""), node_id: String(value.node_id ?? ""), expected_patch_sha256: String(value.patch_sha256 ?? ""), expected_revision: String(value.review_revision ?? "") } })),
    review_mode: mode,
    review_files: reviewFiles,
    review_file_index: fileIndex,
    review_hunk_index: hunkIndex,
    review_truncated: truncated,
  };
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || length <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), length - 1);
}

function render(projection: ScreenProjection, width: number, height: number, offset: number, color: boolean): readonly string[] {
  const review = projection as ScreenProjection & Partial<ReviewProjectionExtra>;
  const captionLines = String(projection.caption ?? "Diff review").split("\n").slice(0, Math.max(1, Math.min(6, height - 3))).map((line) => clipDisplay(line, width));

  const files = review.review_files ?? [];
  const fileIndex = review.review_file_index ?? 0;
  const currentFile = files[fileIndex];

  const fileTableHeight = Math.max(1, Math.min(files.length > 0 ? files.length + 1 : 2, 6, height - captionLines.length - 2));
  let lines: string[];
  try {
    lines = [...captionLines, ...renderTable(projection.rows, projection.columns.map((column) => ({ ...column })) as TableColumn[], { height: fileTableHeight, offset })];
  } catch {
    return [clipDisplay("Diff review render error", width)];
  }

  const diffHeight = Math.max(0, height - lines.length);
  if (diffHeight === 0) return lines.slice(0, height);
  if (currentFile === undefined) {
    lines.push(clipDisplay("No changed files to review.", width));
    return lines.slice(0, height);
  }
  // 72, not the pre-M2 90: ui-spec §2.3's own invariant is "the main region
  // is always >= 72 cols" (the docked rail at cols>=120 -- ui-spec §2.1's
  // D-02 fix -- now takes width the old >120-only dock never did, so the
  // main pane can legitimately sit at exactly 72). Gating split mode on a
  // width the layout contract does not actually promise silently drops an
  // operator's explicit toggle back to unified with no visible reason.
  const useSplit = (review.review_mode ?? "unified") === "side-by-side" && width >= 72;
  if (useSplit) lines.push(clipDisplay(`${"OLD".padEnd(Math.max(1, Math.floor((width - 3) / 2)))} │ NEW`, width));
  const diffLines = renderDiffFile(currentFile, {
    width,
    height: Math.max(0, height - lines.length),
    mode: useSplit ? "split" : "unified",
    current_hunk: review.review_hunk_index ?? null,
    color,
  });
  lines.push(...diffLines);
  return lines.slice(0, height);
}

export const resultReviewScreen: ScreenModule = {
  id: "result-review" as ScreenId,
  title: "Diff Review",
  required_capabilities: ["result.read", "result.adopt"],
  surface: { commands: ["result.review.comment", "result.review.request_revision", "result.review.editor_handoff", "result.scope.authorize", "result.adopt"], queries: ["result.review.workspace"] },
  project: (value) => {
    if (shape(value)) return { variant: "workspace", ...project(value) };
    const columns = [{ key: "path", title: "Changed file tree", width: 46 }];
    if (value == null) return { variant: "empty", screen: "result-review", rows: [], columns, caption: emptyCaption({ what: "No diff review workspace loaded yet", how: "select an active campaign with a captured result" }) };
    return { variant: "empty", screen: "result-review", rows: [], columns, caption: unrecognisedCaption("Diff Review") };
  },
  render: ({ projection, width, height, scroll_offset = 0, color = false }) => render(projection, width, height, scroll_offset, color),
};
