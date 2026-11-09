import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { acquireWriterLock } from "@arbor/core";
import { adoptCapturedResult, inspectCapturedResult, revertCapturedResult } from "./result-adoption.js";
import { canonicalResourceIdentity, DistributedControlClient, type AdoptionRecord } from "./distributed-control-plane.js";

export type FencedAdoptionState = "prepared" | "globally_committed" | "applied" | "finalized" | "quarantined";
export interface FencedAdoptionJournalEntry {
  schema_version: 1; operation_id: string; transaction_id: string; lease_id: string; resource_id: string; fencing_token: number;
  action: "adopt" | "revert";
  campaign_id: string; node_id: string; repository_id: string; patch_sha256: string; selected_files: string[];
  base_head: string; base_workspace_digest: string; result_head: string | null; result_workspace_digest: string | null;
  state: FencedAdoptionState; created_at: string; updated_at: string; last_error: string | null;
}
export type FencedAdoptionOutcome = { ok: true; entry: FencedAdoptionJournalEntry } | { ok: false; reason: string; entry?: FencedAdoptionJournalEntry };

export class FencedResultAdoptionService {
  private readonly journalDir: string;
  private readonly mutationLockDir: string;
  constructor(private readonly options: { client: DistributedControlClient; persistence_dir: string; repository_id: string; lease_ttl_ms?: number; now?: () => string; /** Deterministic crash seam for recovery tests only. */ fault_after?: "commit" | "apply" }) {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(options.repository_id)) throw new Error("fenced adoption repository_id must be a canonical lowercase atom");
    const ttl = options.lease_ttl_ms ?? 60_000; if (!Number.isSafeInteger(ttl) || ttl < 5_000 || ttl > 3_600_000) throw new Error("fenced adoption lease_ttl_ms must be 5000 through 3600000");
    this.journalDir = join(options.persistence_dir, "distributed-adoption-journal"); this.mutationLockDir = join(options.persistence_dir, "distributed-adoption-mutation"); mkdirSync(this.journalDir, { recursive: true });
  }

  /**
   * WA-67: `acknowledge_scope_expansion` (+ `acknowledged_by`) mirrors the
   * local `adoptCapturedResult` remedy for a command-verified capture whose
   * diff exceeds its declared write scope. It is bound to `expected_patch_sha256`
   * — the same digest used to fence this whole mutation against a changed
   * capture — so an operator's acknowledgment can never silently apply to a
   * different patch than the one they reviewed. Adoption-only: revert never
   * accepts it, since a captured result is only ever adopted (never reverted)
   * on the strength of a scope-expansion acknowledgment.
   */
  async adopt(input: { campaign_id: string; node_id: string; target_root: string; expected_patch_sha256: string; files?: readonly string[]; acknowledge_scope_expansion?: boolean; acknowledged_by?: string; scope_expansion_authorization_id?: string }): Promise<FencedAdoptionOutcome> {
    return this.mutate("adopt", input);
  }

  async revert(input: { campaign_id: string; node_id: string; target_root: string; expected_patch_sha256: string; files?: readonly string[] }): Promise<FencedAdoptionOutcome> {
    return this.mutate("revert", input);
  }

  private async mutate(action: "adopt" | "revert", input: { campaign_id: string; node_id: string; target_root: string; expected_patch_sha256: string; files?: readonly string[]; acknowledge_scope_expansion?: boolean; acknowledged_by?: string; scope_expansion_authorization_id?: string }): Promise<FencedAdoptionOutcome> {
    const inspection = inspectCapturedResult({ persistence_dir: this.options.persistence_dir, campaign_id: input.campaign_id, node_id: input.node_id, max_patch_bytes: 1 });
    if (!inspection.record.verified) {
      // Same structural distinction `adoptCapturedResult` makes (WA-67): a
      // capture that is unverified ONLY because its diff exceeds a
      // command-verified declared write scope is the one case an explicit,
      // digest-bound acknowledgment may rescue — for `adopt` only. Any other
      // unverified reason (including this same scope violation on `revert`,
      // or a genuine command/critic failure) still refuses outright.
      const scopeViolations = Array.isArray(inspection.record.scope_violations) ? inspection.record.scope_violations : [];
      const scopeOnlyFailure = action === "adopt" && scopeViolations.length > 0 && inspection.record.command_verified === true;
      if (!scopeOnlyFailure || (input.acknowledge_scope_expansion !== true && input.scope_expansion_authorization_id === undefined)) {
        return { ok: false, reason: scopeOnlyFailure
          ? `distributed adoption requires a verified captured result (no scope authorization: changed files exceed its declared write scope: ${scopeViolations.join(", ")}; record a separate scope authorization or pass the legacy acknowledge_scope_expansion, both bound to the reviewed patch digest)`
          : "distributed adoption requires a verified captured result" };
      }
    }
    if (inspection.record.patch_sha256 !== input.expected_patch_sha256) return { ok: false, reason: "captured result changed since review" };
    const selected = input.files === undefined ? [...inspection.record.files] : [...input.files];
    if (selected.length === 0 || new Set(selected).size !== selected.length || selected.some((file) => !inspection.record.files.includes(file))) return { ok: false, reason: "selected files must be a unique non-empty subset of the capture" };
    selected.sort();
    const resourceId = canonicalResourceIdentity({ namespace: "repository", repository: this.options.repository_id, kind: "result", key: shortHash(`${input.campaign_id}\0${input.node_id}`) });
    const operationId = `fenced-${action}:${randomUUID()}`; const ttl = this.options.lease_ttl_ms ?? 60_000;
    const lease = await this.options.client.request<{ lease_id: string; fencing_token: number }>("POST", "/v1/leases/acquire", { request_id: `${operationId}:lease`, resource_id: resourceId, ttl_ms: ttl });
    if (!lease.ok) return { ok: false, reason: `distributed lease refused: ${lease.summary}` };
    const baseHead = headDigest(input.target_root); const baseWorkspace = workspaceDigest(input.target_root); const selectionDigest = exactDigest(selected.join("\0"));
    const prepared = await this.options.client.request<AdoptionRecord>("POST", "/v1/adoptions/prepare", { request_id: `${operationId}:prepare`, resource_id: resourceId, fencing_token: lease.value.fencing_token, artifact_hash: `sha256:${inspection.record.patch_sha256}`, base_head: baseHead, selection_digest: selectionDigest });
    if (!prepared.ok) { await this.release(operationId, lease.value); return { ok: false, reason: `distributed adoption preparation refused: ${prepared.summary}` }; }
    let entry: FencedAdoptionJournalEntry = { schema_version: 1, operation_id: operationId, transaction_id: prepared.value.transaction_id, lease_id: lease.value.lease_id, resource_id: resourceId, fencing_token: lease.value.fencing_token, action, campaign_id: input.campaign_id, node_id: input.node_id, repository_id: this.options.repository_id, patch_sha256: inspection.record.patch_sha256, selected_files: selected, base_head: baseHead, base_workspace_digest: baseWorkspace, result_head: null, result_workspace_digest: null, state: "prepared", created_at: this.now(), updated_at: this.now(), last_error: null };
    this.write(entry);
    const committed = await this.options.client.request<AdoptionRecord>("POST", "/v1/adoptions/commit", { request_id: `${operationId}:commit`, transaction_id: entry.transaction_id });
    if (!committed.ok) { await this.options.client.request("POST", "/v1/adoptions/abort", { request_id: `${operationId}:abort`, transaction_id: entry.transaction_id }); await this.release(operationId, lease.value); entry = this.transition(entry, "quarantined", committed.summary); return { ok: false, reason: `distributed adoption commit refused: ${committed.summary}`, entry }; }
    entry = this.transition(entry, "globally_committed");
    if (this.options.fault_after === "commit") throw new Error("injected crash after distributed commit");
    const lock = acquireWriterLock(this.mutationLockDir, { holder: operationId });
    if (!lock.ok) { await this.quarantine(entry, `local mutation lock unavailable: ${lock.detail}`); entry = this.transition(entry, "quarantined", lock.detail); return { ok: false, reason: lock.detail, entry }; }
    try {
      if (headDigest(input.target_root) !== entry.base_head || workspaceDigest(input.target_root) !== entry.base_workspace_digest) { const reason = "target workspace changed after distributed preparation"; await this.quarantine(entry, reason); entry = this.transition(entry, "quarantined", reason); return { ok: false, reason, entry }; }
      const outcome = action === "adopt"
        ? adoptCapturedResult({ campaign_id: input.campaign_id, node_id: input.node_id, persistence_dir: this.options.persistence_dir, target_root: input.target_root, expected_patch_sha256: input.expected_patch_sha256, files: selected, ...(input.acknowledge_scope_expansion === true ? { acknowledge_scope_expansion: true as const, acknowledged_by: input.acknowledged_by } : {}), ...(input.scope_expansion_authorization_id === undefined ? {} : { scope_expansion_authorization_id: input.scope_expansion_authorization_id }) })
        : revertCapturedResult({ campaign_id: input.campaign_id, node_id: input.node_id, persistence_dir: this.options.persistence_dir, target_root: input.target_root, expected_patch_sha256: input.expected_patch_sha256, files: selected });
      if (!outcome.ok) { await this.quarantine(entry, outcome.reason); entry = this.transition(entry, "quarantined", outcome.reason); return { ok: false, reason: outcome.reason, entry }; }
      entry = { ...entry, result_head: headDigest(input.target_root), result_workspace_digest: workspaceDigest(input.target_root) }; entry = this.transition(entry, "applied");
      if (this.options.fault_after === "apply") throw new Error("injected crash after local apply");
      const finalized = await this.options.client.request<AdoptionRecord>("POST", "/v1/adoptions/finalize", { request_id: `${operationId}:finalize`, transaction_id: entry.transaction_id, result_head: entry.result_head, tree_digest: entry.result_workspace_digest });
      if (!finalized.ok) { entry = this.transition(entry, "applied", `finalization pending: ${finalized.summary}`); return { ok: false, reason: "patch applied but distributed finalization requires recovery", entry }; }
      entry = this.transition(entry, "finalized"); await this.release(operationId, lease.value); return { ok: true, entry };
    } finally { lock.lock.release(); }
  }

  list(): FencedAdoptionJournalEntry[] { if (!existsSync(this.journalDir)) return []; return readdirSync(this.journalDir).filter((name) => name.endsWith(".json")).flatMap((name) => { try { const stored = JSON.parse(readFileSync(join(this.journalDir, name), "utf8")) as FencedAdoptionJournalEntry | (Omit<FencedAdoptionJournalEntry, "action"> & { action?: undefined }); if (!validEntry(stored)) return []; return [{ ...stored, action: stored.action ?? "adopt" }]; } catch { return []; } }).sort((a, b) => a.created_at.localeCompare(b.created_at)); }

  async recover(targetRoot: string): Promise<Array<{ operation_id: string; outcome: "finalized" | "quarantined" | "unchanged"; detail: string }>> {
    const results: Array<{ operation_id: string; outcome: "finalized" | "quarantined" | "unchanged"; detail: string }> = [];
    for (let entry of this.list().filter((item) => !["finalized", "quarantined"].includes(item.state))) {
      const remote = await this.options.client.request<AdoptionRecord>("GET", `/v1/adoptions/${encodeURIComponent(entry.transaction_id)}`);
      if (!remote.ok) { results.push({ operation_id: entry.operation_id, outcome: "unchanged", detail: remote.summary }); continue; }
      const currentHead = headDigest(targetRoot); const currentWorkspace = workspaceDigest(targetRoot);
      if (remote.value.state === "finalized") { entry = this.transition(entry, "finalized"); results.push({ operation_id: entry.operation_id, outcome: "finalized", detail: "coordinator was already finalized" }); continue; }
      if (remote.value.state !== "committed") { entry = this.transition(entry, "quarantined", `coordinator state is ${remote.value.state}`); results.push({ operation_id: entry.operation_id, outcome: "quarantined", detail: entry.last_error! }); continue; }
      if (entry.result_head && entry.result_workspace_digest && currentHead === entry.result_head && currentWorkspace === entry.result_workspace_digest) {
        const finalized = await this.options.client.request<AdoptionRecord>("POST", "/v1/adoptions/reconcile", { request_id: `${entry.operation_id}:recover-finalize`, transaction_id: entry.transaction_id, resolution: "finalize", result_head: currentHead, tree_digest: currentWorkspace });
        if (finalized.ok) { entry = this.transition(entry, "finalized"); results.push({ operation_id: entry.operation_id, outcome: "finalized", detail: "observed applied tree and finalized" }); continue; }
      }
      const detail = currentHead === entry.base_head && currentWorkspace === entry.base_workspace_digest ? "committed transaction has no observed local apply" : "workspace diverged from both recorded pre- and post-adoption states";
      await this.quarantine(entry, detail); entry = this.transition(entry, "quarantined", detail); results.push({ operation_id: entry.operation_id, outcome: "quarantined", detail });
    }
    return results;
  }

  private async release(operationId: string, lease: { lease_id: string; fencing_token: number }): Promise<void> { await this.options.client.request("POST", "/v1/leases/release", { request_id: `${operationId}:release`, lease_id: lease.lease_id, fencing_token: lease.fencing_token }); }
  private async quarantine(entry: FencedAdoptionJournalEntry, reason: string): Promise<void> { await this.options.client.request("POST", "/v1/adoptions/reconcile", { request_id: `${entry.operation_id}:quarantine`, transaction_id: entry.transaction_id, resolution: "quarantine", reason: reason.slice(0, 512) }); }
  private transition(entry: FencedAdoptionJournalEntry, state: FencedAdoptionState, error: string | null = null): FencedAdoptionJournalEntry { const next = { ...entry, state, updated_at: this.now(), last_error: error }; this.write(next); return next; }
  private write(entry: FencedAdoptionJournalEntry): void { durableWrite(join(this.journalDir, `${entry.operation_id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), `${JSON.stringify(entry)}\n`); }
  private now(): string { return (this.options.now ?? (() => new Date().toISOString()))(); }
}

export function fencedResultAdoptionFromEnvironment(env: NodeJS.ProcessEnv, persistenceDir: string): FencedResultAdoptionService | null {
  const values = [env.ARBOR_CONTROL_URL, env.ARBOR_CONTROL_HOST_ID, env.ARBOR_CONTROL_HOST_SECRET, env.ARBOR_CONTROL_REPOSITORY_ID];
  if (values.every((value) => value === undefined)) return null;
  if (values.some((value) => value === undefined || value.length === 0)) throw new Error("distributed adoption requires ARBOR_CONTROL_URL, ARBOR_CONTROL_HOST_ID, ARBOR_CONTROL_HOST_SECRET, and ARBOR_CONTROL_REPOSITORY_ID together");
  return new FencedResultAdoptionService({ client: new DistributedControlClient({ base_url: values[0]!, host_id: values[1]!, secret: values[2]! }), persistence_dir: persistenceDir, repository_id: values[3]! });
}

function git(root: string, args: string[]): string { const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe", env: cleanGitEnv() }); if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`); return result.stdout.trim(); }
function cleanGitEnv(): NodeJS.ProcessEnv { const env = { ...process.env }; for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[key]; return env; }
function headDigest(root: string): string { return exactDigest(git(root, ["rev-parse", "HEAD"])); }
function workspaceDigest(root: string): string { return exactDigest(git(root, ["status", "--porcelain=v2", "-z"]) + "\0" + git(root, ["diff", "--binary", "HEAD"])); }
function exactDigest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function shortHash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
function validEntry(value: unknown): value is FencedAdoptionJournalEntry | (Omit<FencedAdoptionJournalEntry, "action"> & { action?: undefined }) { if (typeof value !== "object" || value === null) return false; const item = value as Partial<FencedAdoptionJournalEntry>; return item.schema_version === 1 && typeof item.operation_id === "string" && typeof item.transaction_id === "string" && typeof item.resource_id === "string" && typeof item.fencing_token === "number" && (item.action === undefined || item.action === "adopt" || item.action === "revert") && Array.isArray(item.selected_files) && typeof item.state === "string"; }
function durableWrite(path: string, data: string): void { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; let file: number | null = null; try { file = openSync(temporary, "wx", 0o600); writeFileSync(file, data); fsyncSync(file); closeSync(file); file = null; renameSync(temporary, path); const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } } finally { if (file !== null) closeSync(file); } }
