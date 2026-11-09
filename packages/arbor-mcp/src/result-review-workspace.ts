import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import type { ResultVerificationRecord } from "./result-verification-service.js";
import { readUxStore, uxClone, uxId, uxText, writeUxStore } from "./durable-ux-store.js";
import { adoptCapturedResult, inspectCapturedResult, listCapturedResults, type CapturedResultInspection } from "./result-adoption.js";

export type ReviewDiffKind = "context" | "addition" | "deletion" | "header" | "binary";
export type ReviewSide = "old" | "new" | "file";
export interface ReviewDiffLine { readonly patch_line: number; readonly file_path: string | null; readonly old_line: number | null; readonly new_line: number | null; readonly kind: ReviewDiffKind; readonly text: string; }
export interface SideBySideRow { readonly file_path: string; readonly old_line: number | null; readonly old_text: string; readonly new_line: number | null; readonly new_text: string; readonly kind: "context" | "changed" | "deletion" | "addition"; }
export interface ReviewFile { readonly path: string; readonly status: "added" | "modified" | "deleted" | "renamed" | "binary"; readonly additions: number; readonly deletions: number; readonly binary: boolean; readonly tree_depth: number; readonly parent_path: string; }
export interface ReviewComment { readonly id: string; readonly file_path: string; readonly line: number; readonly side: ReviewSide; readonly body: string; readonly author_id: string; readonly created_at: string; readonly patch_sha256: string; }
export interface RevisionRequest { readonly id: string; readonly reason: string; readonly author_id: string; readonly comment_ids: readonly string[]; readonly created_at: string; readonly patch_sha256: string; }
export interface EditorReviewSession { readonly id: string; readonly editor: "vscode" | "cursor"; readonly file_path: string; readonly line: number; readonly uri: string; readonly patch_sha256: string; readonly created_at: string; readonly resume_token: string; }
interface ReviewState { readonly campaign_id: string; readonly node_id: string; readonly patch_sha256: string; readonly files: readonly string[]; readonly revision: number; readonly comments: readonly ReviewComment[]; readonly revision_requests: readonly RevisionRequest[]; readonly editor_sessions: readonly EditorReviewSession[]; readonly updated_at: string; }
type Store = { schema_version: 1; reviews: ReviewState[] };

export interface ResultReviewWorkspace {
  readonly schema_version: 1;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly patch_sha256: string;
  readonly review_revision: number;
  readonly capture: CapturedResultInspection["record"];
  readonly files: readonly ReviewFile[];
  readonly file_tree: readonly { readonly path: string; readonly kind: "directory" | "file"; readonly depth: number; readonly additions: number; readonly deletions: number }[];
  readonly counts: { readonly files: number; readonly additions: number; readonly deletions: number; readonly comments: number; readonly revision_requests: number };
  readonly unified: readonly ReviewDiffLine[];
  readonly side_by_side: readonly SideBySideRow[];
  readonly truncated: boolean;
  readonly conflict_preview: { readonly status: "clean" | "conflict" | "blocked"; readonly selected_files: readonly string[]; readonly detail: string };
  readonly relationships: {
    readonly capture: { readonly verified: boolean; readonly score: number; readonly patch_sha256: string; readonly captured_at: string; readonly declared_write_paths: readonly string[] | null; readonly scope_violations: readonly string[] };
    readonly critic: { readonly status: "available" | "unavailable"; readonly detail: string; readonly verdict: unknown | null };
    readonly verification: ResultVerificationRecord | null;
    readonly provenance: { readonly capture: "verified" | "claimed"; readonly verification: string | null; readonly adoption_requires_verified_capture: true };
  };
  readonly comments: readonly ReviewComment[];
  readonly revision_requests: readonly RevisionRequest[];
  readonly editor_sessions: readonly EditorReviewSession[];
}

const key = (campaignId: string, nodeId: string): string => `${campaignId}:${nodeId}`;
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const safePath = (value: string): boolean => value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.includes("\0") && !value.split("/").includes("..");
const nowDefault = (): string => new Date().toISOString();

export class ResultReviewWorkspaceService {
  private readonly states = new Map<string, ReviewState>();
  private readonly path: string | null;
  private readonly clock: () => string;
  private readonly persistenceDir: string | null;
  constructor(options: { readonly persistence_dir?: string; readonly clock?: () => string } = {}) {
    this.persistenceDir = options.persistence_dir === undefined ? null : resolve(options.persistence_dir);
    this.path = options.persistence_dir === undefined ? null : resolve(options.persistence_dir, "result-review", "reviews.json");
    this.clock = options.clock ?? nowDefault;
    const stored = readUxStore<Store>(this.path, { schema_version: 1, reviews: [] }, validStore);
    for (const review of stored.reviews) this.states.set(key(review.campaign_id, review.node_id), review);
  }

  inspect(input: { readonly persistence_dir: string; readonly workspace_root: string | null; readonly campaign_id: string; readonly node_id?: string; readonly selected_files?: readonly string[]; readonly max_patch_bytes?: number; readonly verification?: ResultVerificationRecord | null; readonly critic_verdict?: unknown | null; readonly scope_expansion_authorization_id?: string }): ResultReviewWorkspace {
    const nodeId = input.node_id ?? bestNode(input.persistence_dir, input.campaign_id);
    if (nodeId === null) throw new Error(`campaign ${input.campaign_id} has no captured result to review`);
    const inspection = inspectCapturedResult({ persistence_dir: input.persistence_dir, campaign_id: input.campaign_id, node_id: nodeId, max_patch_bytes: input.max_patch_bytes ?? 1_048_576 });
    const reviewKey = key(input.campaign_id, nodeId);
    const state = this.stateFor(inspection, reviewKey);
    const parsed = parsePatch(inspection.record.files, inspection.patch.content);
    const selected = input.selected_files === undefined ? [...inspection.record.files] : [...input.selected_files];
    if (selected.length < 1 || new Set(selected).size !== selected.length || selected.some((file) => !inspection.record.files.includes(file))) throw new Error("review selected_files must be a unique non-empty subset of the captured files");
    const conflict = previewConflict(input, inspection, nodeId, selected);
    const additions = parsed.files.reduce((total, file) => total + file.additions, 0);
    const deletions = parsed.files.reduce((total, file) => total + file.deletions, 0);
    const verification = input.verification ?? null;
    return uxClone({
      schema_version: 1, campaign_id: input.campaign_id, node_id: nodeId, patch_sha256: inspection.record.patch_sha256, review_revision: state.revision,
      capture: inspection.record, files: parsed.files, file_tree: buildTree(parsed.files),
      counts: { files: parsed.files.length, additions, deletions, comments: state.comments.length, revision_requests: state.revision_requests.length },
      unified: parsed.unified, side_by_side: parsed.sideBySide, truncated: inspection.patch.truncated, conflict_preview: conflict,
      relationships: {
        capture: { verified: inspection.record.verified, score: inspection.record.score, patch_sha256: inspection.record.patch_sha256, captured_at: inspection.record.captured_at, declared_write_paths: inspection.record.declared_write_paths ? [...inspection.record.declared_write_paths] : null, scope_violations: [...(inspection.record.scope_violations ?? [])] },
        critic: input.critic_verdict == null
          ? { status: "unavailable", detail: "No canonical critic verdict is retained for this campaign node; verification is reported separately and never fabricated.", verdict: null }
          : { status: "available", detail: "Canonical critic verdict retained on the captured campaign node.", verdict: uxClone(input.critic_verdict) },
        verification,
        provenance: { capture: inspection.record.verified ? "verified" : "claimed", verification: verification?.provenance.tag ?? null, adoption_requires_verified_capture: true },
      },
      comments: state.comments, revision_requests: state.revision_requests, editor_sessions: state.editor_sessions,
    } satisfies ResultReviewWorkspace);
  }

  addComment(input: { readonly campaign_id: string; readonly node_id: string; readonly expected_patch_sha256: string; readonly expected_revision: number; readonly file_path: string; readonly line: number; readonly side: ReviewSide; readonly body: string; readonly author_id: string }): ReviewState {
    const state = this.requireMutable(input);
    if (!safePath(input.file_path) || !state.files.includes(input.file_path) || !Number.isSafeInteger(input.line) || input.line < 1 || input.line > 1_000_000 || !["old", "new", "file"].includes(input.side) || !uxText(input.body, 4_096) || !uxId(input.author_id)) throw new Error("inline review comment must target a captured file and contain valid bounded fields");
    const createdAt = this.clock();
    const id = `review-comment-${hash(`${key(input.campaign_id, input.node_id)}:${state.revision}:${input.file_path}:${input.line}:${input.side}:${input.body}`).slice(0, 20)}`;
    return this.replace(state, { comments: [...state.comments, { id, file_path: input.file_path, line: input.line, side: input.side, body: input.body.trim(), author_id: input.author_id, created_at: createdAt, patch_sha256: state.patch_sha256 }], updated_at: createdAt });
  }

  requestRevision(input: { readonly campaign_id: string; readonly node_id: string; readonly expected_patch_sha256: string; readonly expected_revision: number; readonly reason: string; readonly author_id: string; readonly comment_ids?: readonly string[] }): ReviewState {
    const state = this.requireMutable(input);
    const commentIds = input.comment_ids === undefined ? state.comments.map((comment) => comment.id) : [...input.comment_ids];
    if (!uxText(input.reason, 4_096) || !uxId(input.author_id) || commentIds.length > 200 || commentIds.some((id) => !state.comments.some((comment) => comment.id === id))) throw new Error("revision request is invalid or references an unknown comment");
    const createdAt = this.clock();
    const id = `revision-request-${hash(`${key(input.campaign_id, input.node_id)}:${state.revision}:${input.reason}`).slice(0, 20)}`;
    return this.replace(state, { revision_requests: [...state.revision_requests, { id, reason: input.reason.trim(), author_id: input.author_id, comment_ids: commentIds, created_at: createdAt, patch_sha256: state.patch_sha256 }], updated_at: createdAt });
  }

  createEditorHandoff(input: { readonly campaign_id: string; readonly node_id: string; readonly expected_patch_sha256: string; readonly expected_revision: number; readonly workspace_root: string; readonly file_path: string; readonly line: number; readonly editor: "vscode" | "cursor" }): ReviewState {
    const state = this.requireMutable(input);
    if (!safePath(input.file_path) || !state.files.includes(input.file_path) || !Number.isSafeInteger(input.line) || input.line < 1 || input.line > 1_000_000 || !["vscode", "cursor"].includes(input.editor)) throw new Error("editor handoff must target a captured file and contain valid bounded fields");
    const root = resolve(input.workspace_root); const target = resolve(root, input.file_path);
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("editor handoff path escapes the operator workspace");
    const createdAt = this.clock();
    const id = `editor-review-${hash(`${key(input.campaign_id, input.node_id)}:${state.revision}:${input.file_path}:${input.line}:${input.editor}`).slice(0, 20)}`;
    const resumeToken = hash(`${id}:${state.patch_sha256}:${createdAt}`);
    const uri = `${input.editor}://file/${encodeURI(target)}:${input.line}?revoyReview=${resumeToken}`;
    return this.replace(state, { editor_sessions: [...state.editor_sessions.slice(-19), { id, editor: input.editor, file_path: input.file_path, line: input.line, uri, patch_sha256: state.patch_sha256, created_at: createdAt, resume_token: resumeToken }], updated_at: createdAt });
  }

  private stateFor(inspection: CapturedResultInspection, reviewKey: string): ReviewState {
    const existing = this.states.get(reviewKey);
    if (existing?.patch_sha256 === inspection.record.patch_sha256) return existing;
    const fresh: ReviewState = { campaign_id: inspection.record.campaign_id, node_id: inspection.record.node_id, patch_sha256: inspection.record.patch_sha256, files: [...inspection.record.files], revision: 1, comments: [], revision_requests: [], editor_sessions: [], updated_at: inspection.record.captured_at };
    this.states.set(reviewKey, fresh); this.persist(); return fresh;
  }
  private requireMutable(input: { campaign_id: string; node_id: string; expected_patch_sha256: string; expected_revision: number }): ReviewState {
    if (!uxId(input.campaign_id) || !uxId(input.node_id) || !/^[a-f0-9]{64}$/.test(input.expected_patch_sha256) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) throw new Error("review mutation identity is invalid");
    const state = this.states.get(key(input.campaign_id, input.node_id));
    if (!state) throw new Error("review workspace must be inspected before it can be changed");
    if (this.persistenceDir === null) throw new Error("durable capture manifest is required before review mutation");
    const live = inspectCapturedResult({ persistence_dir: this.persistenceDir, campaign_id: input.campaign_id, node_id: input.node_id, max_patch_bytes: 1 });
    if (live.record.patch_sha256 !== state.patch_sha256 || live.record.files.length !== state.files.length || live.record.files.some((file) => !state.files.includes(file))) throw new Error("captured manifest changed since the review was opened");
    if (state.patch_sha256 !== input.expected_patch_sha256) throw new Error("captured patch changed since the review was opened");
    if (state.revision !== input.expected_revision) throw new Error(`review revision changed from ${input.expected_revision} to ${state.revision}`);
    return state;
  }
  private replace(state: ReviewState, changes: Partial<ReviewState>): ReviewState {
    const next: ReviewState = { ...state, ...changes, revision: state.revision + 1 };
    this.states.set(key(next.campaign_id, next.node_id), next); this.persist(); return uxClone(next);
  }
  private persist(): void { writeUxStore(this.path, { schema_version: 1, reviews: [...this.states.values()] } satisfies Store); }
}

function bestNode(persistenceDir: string, campaignId: string): string | null {
  return listCapturedResults(persistenceDir, campaignId)[0]?.node_id ?? null;
}

function previewConflict(input: { persistence_dir: string; workspace_root: string | null; campaign_id: string; scope_expansion_authorization_id?: string }, inspection: CapturedResultInspection, nodeId: string, selected: readonly string[]): ResultReviewWorkspace["conflict_preview"] {
  if (input.workspace_root === null) return { status: "blocked", selected_files: selected, detail: "No operator workspace is configured; conflict preview and adoption are unavailable." };
  const outcome = adoptCapturedResult({ persistence_dir: input.persistence_dir, target_root: input.workspace_root, campaign_id: input.campaign_id, node_id: nodeId, expected_patch_sha256: inspection.record.patch_sha256, files: selected, check_only: true, ...(input.scope_expansion_authorization_id === undefined ? {} : { scope_expansion_authorization_id: input.scope_expansion_authorization_id }) });
  if (outcome.ok) return { status: "clean", selected_files: selected, detail: "The exact selected patch subset passes git apply --check against the current operator workspace." };
  return { status: inspection.record.verified ? "conflict" : "blocked", selected_files: selected, detail: outcome.reason };
}

function parsePatch(paths: readonly string[], content: string): { files: ReviewFile[]; unified: ReviewDiffLine[]; sideBySide: SideBySideRow[] } {
  const stats = new Map(paths.map((path) => [path, { additions: 0, deletions: 0, binary: false, status: "modified" as ReviewFile["status"] }]));
  const unified: ReviewDiffLine[] = []; const sideBySide: SideBySideRow[] = [];
  let current: string | null = paths[0] ?? null; let oldLine = 0; let newLine = 0; let pendingDeletion: ReviewDiffLine | null = null;
  const flushDeletion = (): void => { if (!pendingDeletion || !pendingDeletion.file_path) return; sideBySide.push({ file_path: pendingDeletion.file_path, old_line: pendingDeletion.old_line, old_text: pendingDeletion.text, new_line: null, new_text: "", kind: "deletion" }); pendingDeletion = null; };
  const identify = (line: string): string | null => paths.find((path) => line.includes(`a/${path}`) || line.includes(`b/${path}`)) ?? null;
  for (const [index, line] of content.split("\n").entries()) {
    if (line.startsWith("diff --git ")) { flushDeletion(); current = identify(line) ?? current; }
    if (line.startsWith("new file mode ") && current) stats.get(current)!.status = "added";
    if (line.startsWith("deleted file mode ") && current) stats.get(current)!.status = "deleted";
    if (line.startsWith("rename from ") && current) stats.get(current)!.status = "renamed";
    if ((line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) && current) { stats.get(current)!.binary = true; stats.get(current)!.status = "binary"; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { flushDeletion(); oldLine = Number(hunk[1]); newLine = Number(hunk[2]); unified.push({ patch_line: index + 1, file_path: current, old_line: null, new_line: null, kind: "header", text: line }); continue; }
    let item: ReviewDiffLine;
    if (hunk === null && line.startsWith("+") && !line.startsWith("+++")) { item = { patch_line: index + 1, file_path: current, old_line: null, new_line: newLine, kind: "addition", text: line.slice(1) }; if (current) stats.get(current)!.additions += 1; newLine += 1; if (pendingDeletion && current) { sideBySide.push({ file_path: current, old_line: pendingDeletion.old_line, old_text: pendingDeletion.text, new_line: item.new_line, new_text: item.text, kind: "changed" }); pendingDeletion = null; } else if (current) sideBySide.push({ file_path: current, old_line: null, old_text: "", new_line: item.new_line, new_text: item.text, kind: "addition" }); }
    else if (line.startsWith("-") && !line.startsWith("---")) { flushDeletion(); item = { patch_line: index + 1, file_path: current, old_line: oldLine, new_line: null, kind: "deletion", text: line.slice(1) }; if (current) stats.get(current)!.deletions += 1; oldLine += 1; pendingDeletion = item; }
    else if (line.startsWith(" ")) { flushDeletion(); item = { patch_line: index + 1, file_path: current, old_line: oldLine, new_line: newLine, kind: "context", text: line.slice(1) }; if (current) sideBySide.push({ file_path: current, old_line: oldLine, old_text: item.text, new_line: newLine, new_text: item.text, kind: "context" }); oldLine += 1; newLine += 1; }
    else { flushDeletion(); item = { patch_line: index + 1, file_path: current, old_line: null, new_line: null, kind: line.includes("binary") ? "binary" : "header", text: line }; }
    unified.push(item);
  }
  flushDeletion();
  const files = paths.map((path): ReviewFile => { const stat = stats.get(path)!; return { path, status: stat.status, additions: stat.additions, deletions: stat.deletions, binary: stat.binary, tree_depth: path.split("/").length - 1, parent_path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" }; });
  return { files, unified, sideBySide };
}

function buildTree(files: readonly ReviewFile[]): ResultReviewWorkspace["file_tree"] {
  const directories = new Set<string>(); for (const file of files) { const parts = file.path.split("/"); for (let i = 1; i < parts.length; i += 1) directories.add(parts.slice(0, i).join("/")); }
  return [...[...directories].sort().map((path) => ({ path, kind: "directory" as const, depth: path.split("/").length - 1, additions: 0, deletions: 0 })), ...files.map((file) => ({ path: file.path, kind: "file" as const, depth: file.tree_depth, additions: file.additions, deletions: file.deletions }))].sort((a, b) => a.path.localeCompare(b.path));
}

function validStore(value: unknown): value is Store { return typeof value === "object" && value !== null && (value as { schema_version?: unknown }).schema_version === 1 && Array.isArray((value as { reviews?: unknown }).reviews); }
