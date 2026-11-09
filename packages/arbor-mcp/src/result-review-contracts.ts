export type ResultReviewQuery =
  | { readonly kind: "result.list"; readonly campaign_id: string }
  | { readonly kind: "result.inspect"; readonly campaign_id: string; readonly node_id: string; readonly max_patch_bytes?: number }
  | { readonly kind: "result.review.workspace"; readonly campaign_id: string; readonly node_id?: string; readonly files?: readonly string[]; readonly max_patch_bytes?: number };

export interface ResultReviewQueryEnvelope {
  readonly schema_version: 1;
  readonly query_id: string;
  readonly query: ResultReviewQuery;
}

export interface ResultAdoptCommand {
  readonly kind: "result.adopt";
  readonly campaign_id: string;
  readonly node_id: string;
  readonly expected_patch_sha256: string;
  readonly confirmed: true;
  readonly files?: readonly string[];
  readonly scope_expansion_authorization_id?: string;
}

export interface ResultScopeAuthorizeCommand {
  readonly kind: "result.scope.authorize";
  readonly campaign_id: string;
  readonly node_id: string;
  readonly expected_patch_sha256: string;
  readonly authorization_id: string;
  readonly authorized_by: string;
  readonly authorized_paths?: readonly string[];
  readonly confirmed: true;
}

export interface ResultRevertCommand {
  readonly kind: "result.revert";
  readonly adoption_operation_id: string;
  readonly expected_patch_sha256: string;
  readonly confirmed: true;
}

export type ResultReviewMutationCommand =
  | { readonly kind: "result.review.comment"; readonly campaign_id: string; readonly node_id: string; readonly expected_patch_sha256: string; readonly expected_revision: number; readonly file_path: string; readonly line: number; readonly side: "old" | "new" | "file"; readonly body: string; readonly author_id: string }
  | { readonly kind: "result.review.request_revision"; readonly campaign_id: string; readonly node_id: string; readonly expected_patch_sha256: string; readonly expected_revision: number; readonly reason: string; readonly author_id: string; readonly comment_ids?: readonly string[] }
  | { readonly kind: "result.review.editor_handoff"; readonly campaign_id: string; readonly node_id: string; readonly expected_patch_sha256: string; readonly expected_revision: number; readonly file_path: string; readonly line: number; readonly editor: "vscode" | "cursor" };

export interface ResultReviewMutationAcknowledgement { readonly accepted: boolean; readonly operation_id: string; readonly review?: unknown; readonly error?: unknown; }

export type ResultReviewValidation =
  | { readonly ok: true; readonly value: ResultReviewQueryEnvelope }
  | { readonly ok: false; readonly error: string };

const safeId = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value !== "." && value !== "..";

export function isResultReviewQueryEnvelope(value: unknown): value is ResultReviewQueryEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const query = (value as { query?: unknown }).query;
  return typeof query === "object" && query !== null && ["result.list", "result.inspect", "result.review.workspace"].includes(String((query as { kind?: unknown }).kind));
}

export function isResultAdoptCommandEnvelope(value: unknown): value is { readonly command: ResultAdoptCommand } {
  if (typeof value !== "object" || value === null) return false;
  const command = (value as { command?: unknown }).command;
  return typeof command === "object" && command !== null && (command as { kind?: unknown }).kind === "result.adopt";
}

export function isResultScopeAuthorizeCommandEnvelope(value: unknown): value is { readonly command: ResultScopeAuthorizeCommand } {
  if (typeof value !== "object" || value === null) return false;
  const command = (value as { command?: unknown }).command;
  return typeof command === "object" && command !== null && (command as { kind?: unknown }).kind === "result.scope.authorize";
}

export function isResultRevertCommandEnvelope(value: unknown): value is { readonly command: ResultRevertCommand } {
  if (typeof value !== "object" || value === null) return false;
  const command = (value as { command?: unknown }).command;
  return typeof command === "object" && command !== null && (command as { kind?: unknown }).kind === "result.revert";
}

export function isResultReviewMutationEnvelope(value: unknown): value is { readonly command: ResultReviewMutationCommand } {
  if (typeof value !== "object" || value === null) return false;
  const command = (value as { command?: unknown }).command;
  return typeof command === "object" && command !== null && ["result.review.comment", "result.review.request_revision", "result.review.editor_handoff"].includes(String((command as { kind?: unknown }).kind));
}

const safePath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.includes("\0") && !value.split("/").includes("..");
const validReviewIdentity = (command: { campaign_id?: unknown; node_id?: unknown; expected_patch_sha256?: unknown; expected_revision?: unknown }): boolean => safeId(command.campaign_id) && safeId(command.node_id) && typeof command.expected_patch_sha256 === "string" && /^[a-f0-9]{64}$/.test(command.expected_patch_sha256) && Number.isSafeInteger(command.expected_revision) && Number(command.expected_revision) >= 1;

export function validateResultReviewMutation(value: unknown): { readonly ok: true; readonly value: ResultReviewMutationCommand } | { readonly ok: false; readonly error: string } {
  if (typeof value !== "object" || value === null || !["result.review.comment", "result.review.request_revision", "result.review.editor_handoff"].includes(String((value as { kind?: unknown }).kind))) return { ok: false, error: "result review mutation is invalid" };
  const command = value as { kind: ResultReviewMutationCommand["kind"]; campaign_id?: unknown; node_id?: unknown; expected_patch_sha256?: unknown; expected_revision?: unknown };
  if (!validReviewIdentity(command)) return { ok: false, error: "result review mutation requires the inspected patch identity and review revision" };
  if (command.kind === "result.review.comment") {
    const command = value as Partial<Extract<ResultReviewMutationCommand, { kind: "result.review.comment" }>>;
    if (!safePath(command.file_path) || !Number.isSafeInteger(command.line) || Number(command.line) < 1 || !["old", "new", "file"].includes(String(command.side)) || typeof command.body !== "string" || command.body.trim().length < 1 || command.body.length > 4_096 || !safeId(command.author_id)) return { ok: false, error: "inline review comment fields are invalid" };
  } else if (command.kind === "result.review.request_revision") {
    const command = value as Partial<Extract<ResultReviewMutationCommand, { kind: "result.review.request_revision" }>>;
    if (typeof command.reason !== "string" || command.reason.trim().length < 1 || command.reason.length > 4_096 || !safeId(command.author_id) || (command.comment_ids !== undefined && (!Array.isArray(command.comment_ids) || command.comment_ids.length > 200 || command.comment_ids.some((id) => !safeId(id))))) return { ok: false, error: "revision request fields are invalid" };
  } else {
    const command = value as Partial<Extract<ResultReviewMutationCommand, { kind: "result.review.editor_handoff" }>>;
    if (!safePath(command.file_path) || !Number.isSafeInteger(command.line) || Number(command.line) < 1 || !["vscode", "cursor"].includes(String(command.editor))) return { ok: false, error: "editor handoff fields are invalid" };
  }
  return { ok: true, value: command as ResultReviewMutationCommand };
}

export function validateResultAdoptCommand(value: unknown): { readonly ok: true; readonly value: ResultAdoptCommand } | { readonly ok: false; readonly error: string } {
  if (typeof value !== "object" || value === null || (value as { kind?: unknown }).kind !== "result.adopt") return { ok: false, error: "result adoption command is invalid" };
  const command = value as Partial<ResultAdoptCommand>;
  if (!safeId(command.campaign_id) || !safeId(command.node_id)) return { ok: false, error: "result adoption requires safe campaign_id and node_id values" };
  if (typeof command.expected_patch_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(command.expected_patch_sha256)) return { ok: false, error: "result adoption requires the inspected patch sha256" };
  if (command.confirmed !== true) return { ok: false, error: "result adoption requires explicit confirmation" };
  if (command.scope_expansion_authorization_id !== undefined && !safeId(command.scope_expansion_authorization_id)) return { ok: false, error: "result adoption scope authorization id must be safe" };
  if (command.files !== undefined) {
    if (!Array.isArray(command.files) || command.files.length < 1 || command.files.length > 200) return { ok: false, error: "result adoption files must contain from 1 to 200 paths" };
    if (command.files.some((path) => typeof path !== "string" || path.length < 1 || path.length > 512 || path.startsWith("/") || path.includes("\0") || path.split("/").includes(".."))) return { ok: false, error: "result adoption files must be bounded repository-relative paths" };
    if (new Set(command.files).size !== command.files.length) return { ok: false, error: "result adoption files must not contain duplicates" };
  }
  return { ok: true, value: command as ResultAdoptCommand };
}

export function validateResultScopeAuthorizeCommand(value: unknown): { readonly ok: true; readonly value: ResultScopeAuthorizeCommand } | { readonly ok: false; readonly error: string } {
  if (typeof value !== "object" || value === null || (value as { kind?: unknown }).kind !== "result.scope.authorize") return { ok: false, error: "result scope authorization command is invalid" };
  const command = value as Partial<ResultScopeAuthorizeCommand>;
  if (!safeId(command.campaign_id) || !safeId(command.node_id) || !safeId(command.authorization_id)) return { ok: false, error: "result scope authorization requires safe campaign, node, and authorization ids" };
  if (typeof command.expected_patch_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(command.expected_patch_sha256)) return { ok: false, error: "result scope authorization requires the inspected patch sha256" };
  if (!safeId(command.authorized_by)) return { ok: false, error: "result scope authorization requires a bounded authenticated actor id" };
  if (command.confirmed !== true) return { ok: false, error: "result scope authorization requires explicit confirmation" };
  if (command.authorized_paths !== undefined && (!Array.isArray(command.authorized_paths) || command.authorized_paths.length < 1 || command.authorized_paths.length > 200 || command.authorized_paths.some((path) => !safePath(path)) || new Set(command.authorized_paths).size !== command.authorized_paths.length)) return { ok: false, error: "authorized paths must be a unique bounded repository-relative list" };
  return { ok: true, value: command as ResultScopeAuthorizeCommand };
}

export function validateResultRevertCommand(value: unknown): { readonly ok: true; readonly value: ResultRevertCommand } | { readonly ok: false; readonly error: string } {
  if (typeof value !== "object" || value === null || (value as { kind?: unknown }).kind !== "result.revert") return { ok: false, error: "result revert command is invalid" };
  const command = value as Partial<ResultRevertCommand>;
  if (!safeId(command.adoption_operation_id)) return { ok: false, error: "result revert requires a safe adoption_operation_id" };
  if (typeof command.expected_patch_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(command.expected_patch_sha256)) return { ok: false, error: "result revert requires the adopted patch sha256" };
  if (command.confirmed !== true) return { ok: false, error: "result revert requires explicit confirmation" };
  return { ok: true, value: command as ResultRevertCommand };
}

export function parseResultAdoptFingerprint(value: string): ReturnType<typeof validateResultAdoptCommand> {
  try { return validateResultAdoptCommand(JSON.parse(value)); }
  catch { return { ok: false, error: "result adoption fingerprint is not valid JSON" }; }
}

export function parseResultRevertFingerprint(value: string): ReturnType<typeof validateResultRevertCommand> {
  try { return validateResultRevertCommand(JSON.parse(value)); }
  catch { return { ok: false, error: "result revert fingerprint is not valid JSON" }; }
}

export function validateResultReviewQuery(value: unknown): ResultReviewValidation {
  if (!isResultReviewQueryEnvelope(value)) return { ok: false, error: "result review query envelope is invalid" };
  if (value.schema_version !== 1 || !safeId(value.query_id)) return { ok: false, error: "result review query requires schema_version 1 and a bounded query_id" };
  const query = value.query;
  if (!safeId(query.campaign_id)) return { ok: false, error: "result review query requires a safe campaign_id" };
  if (query.kind === "result.list") return { ok: true, value };
  if (query.kind === "result.inspect" && !safeId(query.node_id)) return { ok: false, error: "result inspection requires a safe node_id" };
  if (query.kind === "result.review.workspace" && query.node_id !== undefined && !safeId(query.node_id)) return { ok: false, error: "result review node_id must be safe when supplied" };
  if (query.kind === "result.review.workspace" && query.files !== undefined && (!Array.isArray(query.files) || query.files.length < 1 || query.files.length > 200 || query.files.some((path) => !safePath(path)) || new Set(query.files).size !== query.files.length)) return { ok: false, error: "result review files must be a unique bounded subset" };
  if (query.max_patch_bytes !== undefined && (!Number.isSafeInteger(query.max_patch_bytes) || query.max_patch_bytes < 1 || query.max_patch_bytes > 1_048_576)) {
    return { ok: false, error: "max_patch_bytes must be from 1 to 1048576" };
  }
  return { ok: true, value };
}
