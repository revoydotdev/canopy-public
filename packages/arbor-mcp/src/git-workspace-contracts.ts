import type { RuntimeError } from "@arbor/core";
import type { GitWorkspaceProjection, GovernedWorktreeResult } from "./git-workspace-projection.js";

export type GitWorkspaceQuery = { readonly kind: "git.workspace"; readonly path?: string; readonly ancestry_limit?: number; readonly cached_diff?: boolean };
export type GitWorkspaceCommand =
  | { readonly kind: "git.worktree.create"; readonly campaign_id: string; readonly node_id: string; readonly specialist: string }
  | { readonly kind: "git.worktree.switch"; readonly path: string; readonly active_run?: boolean }
  | { readonly kind: "git.worktree.cleanup"; readonly node_id: string; readonly authorized?: boolean; readonly active_run?: boolean };
export interface GitWorkspaceMetadata { readonly operation_id: string; readonly idempotency_key: string; readonly correlation_id: string; readonly actor_id: string; readonly requested_at: string }
export interface GitWorkspaceQueryEnvelope { readonly schema_version: 1; readonly query_id: string; readonly query: GitWorkspaceQuery }
export interface GitWorkspaceCommandEnvelope { readonly schema_version: 1; readonly metadata: GitWorkspaceMetadata; readonly command: GitWorkspaceCommand }
export type GitWorkspaceResult = { readonly ok: true; readonly capability: "git.read" | "git.worktree.write"; readonly value: GitWorkspaceProjection | GovernedWorktreeResult } | { readonly ok: false; readonly capability: "git.read" | "git.worktree.write" | null; readonly error: RuntimeError };

export function isGitWorkspaceQueryEnvelope(value: unknown): value is GitWorkspaceQueryEnvelope { const envelope = record(value); const query = record(envelope?.query); return envelope?.schema_version === 1 && typeof envelope?.query_id === "string" && query?.kind === "git.workspace" && (query.path === undefined || typeof query.path === "string") && (query.ancestry_limit === undefined || Number.isInteger(query.ancestry_limit)) && (query.cached_diff === undefined || typeof query.cached_diff === "boolean"); }
export function isGitWorkspaceCommandEnvelope(value: unknown): value is GitWorkspaceCommandEnvelope { const envelope = record(value); const command = record(envelope?.command); const kind = command?.kind; return envelope?.schema_version === 1 && validMetadata(envelope?.metadata) && (kind === "git.worktree.create" ? nonEmpty(command?.campaign_id) && nonEmpty(command?.node_id) && nonEmpty(command?.specialist) : kind === "git.worktree.switch" ? nonEmpty(command?.path) && (command?.active_run === undefined || typeof command.active_run === "boolean") : kind === "git.worktree.cleanup" ? nonEmpty(command?.node_id) && (command?.authorized === undefined || typeof command.authorized === "boolean") && (command?.active_run === undefined || typeof command.active_run === "boolean") : false); }
function record(value: unknown): Record<string, any> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : null; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 512; }
function validMetadata(value: unknown): boolean { const metadata = record(value); return metadata !== null && nonEmpty(metadata.operation_id) && nonEmpty(metadata.idempotency_key) && nonEmpty(metadata.correlation_id) && nonEmpty(metadata.actor_id) && typeof metadata.requested_at === "string"; }
