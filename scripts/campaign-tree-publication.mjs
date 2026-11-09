#!/usr/bin/env bun
/**
 * Fail-closed publication projection for a campaign-tree replay. The input
 * remains private: this script writes only topology, timestamps, closed node
 * states, reduced event kinds, source hashes, and the source revision.
 *
 * Usage:
 *   bun scripts/campaign-tree-publication.mjs \
 *     --tree /private/campaign-tree.json --audit /private/audit.jsonl \
 *     --source-revision <40-hex-sha> --out /mnt/sda2/revoy2/campaigns/<run-id>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSecretFree, publicationSecretPatternCodes } from "./lib/sizzle-redaction.mjs";
import { sha256Bytes, writeManifestAndChecksums } from "./lib/sizzle-manifest.mjs";
import { renderCampaignTreeHero } from "./render-campaign-tree-hero.mjs";
import { canonicalizeForHash } from "@arbor/core";

const HASH = /^(?:sha256:)?[a-f0-9]{64}$/i;
const REVISION = /^[a-f0-9]{40}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATES = new Set(["pending", "expanding", "verified", "claimed", "failed", "pruned", "interrupted", "abandoned", "awaiting_review", "awaiting_user_input"]);
const EVENT_ORDER = new Map(["campaign_started", "branch_created", "selected", "gate_confirmed", "claimed", "backtracked", "rejected", "interrupted"].map((kind, index) => [kind, index]));
const RUNTIME_GENERATOR_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safeId(value, label) { if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} must be a publication-safe identifier`); return value; }
function timestamp(value, label) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`); return value; }
function sourceHash(value, label) { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a SHA-256 hash`); return value.startsWith("sha256:") ? value.toLowerCase() : `sha256:${value.toLowerCase()}`; }
function canonicalSha256(value) { return `sha256:${createHash("sha256").update(canonicalizeForHash(value)).digest("hex")}`; }

function auditRecords(value) {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.records)) return value.records;
  throw new Error("audit input must be a JSON array or an object with records");
}

export function parseAuditInput(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("audit input is empty");
  if (trimmed.startsWith("[")) return auditRecords(JSON.parse(trimmed));
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed) && Array.isArray(parsed.records)) return parsed.records;
      if (isRecord(parsed) && typeof parsed.campaign_id === "string") return [parsed];
    } catch { /* multi-line JSONL falls through */ }
  }
  return trimmed.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`audit JSONL line ${index + 1} is invalid`); }
  });
}

function treeNodes(tree, campaignId, rootId) {
  const raw = Array.isArray(tree.nodes) ? tree.nodes : Array.isArray(tree.tree?.nodes) ? tree.tree.nodes : null;
  if (!raw?.length) throw new Error("tree input must contain a non-empty nodes array");
  const nodes = raw.map((node) => {
    if (!isRecord(node)) throw new Error("tree node must be an object");
    const id = safeId(node.id, "tree node id");
    const parentId = node.parent_id ?? node.parentId ?? null;
    if (parentId !== null) safeId(parentId, "tree parent id");
    const createdAt = timestamp(node.created_at ?? node.createdAt, "tree node created_at");
    if (typeof node.state !== "string" || !STATES.has(node.state)) throw new Error("tree node state is not public-safe");
    return { id, parent_id: parentId, created_at: createdAt, final_state: node.state };
  });
  const ids = new Set(nodes.map((node) => node.id));
  if (!ids.has(rootId)) throw new Error(`tree root ${rootId} is absent`);
  for (const node of nodes) if (node.id !== rootId && (node.parent_id === null || !ids.has(node.parent_id))) throw new Error(`tree node ${node.id} has an unknown parent`);
  return nodes.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
}

function validateAudit(records, campaignId, nodeIds) {
  if (!records.length) throw new Error("audit input must contain campaign records");
  let previous = null;
  return records.map((record, index) => {
    if (!isRecord(record)) throw new Error(`audit record ${index + 1} must be an object`);
    if (record.campaign_id !== campaignId) throw new Error(`audit record ${index + 1} does not belong to campaign ${campaignId}`);
    safeId(record.id, `audit record ${index + 1} id`);
    safeId(record.node_id, `audit record ${index + 1} node_id`);
    if (!nodeIds.has(record.node_id)) throw new Error(`audit record ${record.id} references an unknown tree node`);
    timestamp(record.timestamp, `audit record ${record.id} timestamp`);
    const content = sourceHash(record.content_hash, `audit record ${record.id} content_hash`);
    const prior = record.previous_hash === null ? null : sourceHash(record.previous_hash, `audit record ${record.id} previous_hash`);
    if (previous !== prior) throw new Error(`audit hash chain breaks at ${record.id}`);
    const { content_hash: _contentHash, ...unhashed } = record;
    if (content !== canonicalSha256(unhashed)) throw new Error(`audit record ${record.id} content hash does not match canonical bytes`);
    previous = content;
    return record;
  });
}

export function validateAuditTip(tip, records, campaignId) {
  if (!isRecord(tip) || tip.kind !== "arbor_audit_tip_sentinel" || (tip.version !== 1 && tip.version !== 2)) throw new Error("audit tip has an invalid or unrecognized shape");
  if (tip.campaign_id !== campaignId) throw new Error(`audit tip is for campaign ${String(tip.campaign_id)}, expected ${campaignId}`);
  if (!Number.isSafeInteger(tip.record_count) || tip.record_count < 0 || tip.record_count !== records.length) throw new Error(`audit tip record_count ${String(tip.record_count)} does not match ${records.length} audit records`);
  const expectedTip = records.length === 0 ? null : sourceHash(records.at(-1).content_hash, "last audit content_hash");
  if ((tip.record_count === 0) !== (tip.tip_hash === null)) throw new Error("audit tip tip_hash must be null if and only if record_count is 0");
  if (expectedTip !== (tip.tip_hash === null ? null : sourceHash(tip.tip_hash, "audit tip tip_hash"))) throw new Error("audit tip hash does not match the audit chain head");
  const { content_hash: _contentHash, ...unhashed } = tip;
  if (sourceHash(tip.content_hash, "audit tip content_hash") !== canonicalSha256(unhashed)) throw new Error("audit tip content hash does not match canonical bytes");
  return {
    record_count: tip.record_count,
    tip_hash: expectedTip,
    content_hash: sourceHash(tip.content_hash, "audit tip content_hash"),
  };
}

export function validateGeneratorWorktree(worktreePath, sourceRevision, runtimeWorktree = RUNTIME_GENERATOR_ROOT) {
  if (typeof worktreePath !== "string" || !worktreePath) throw new Error("generator worktree is required");
  const worktree = realpathSync(resolve(worktreePath));
  const runtime = realpathSync(resolve(runtimeWorktree));
  if (runtime !== worktree) throw new Error("generator worktree must be the repository executing the publication code");
  const git = (args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) throw new Error("generator worktree has tracked changes; publish from a clean worktree");
  const generatorRevision = git(["rev-parse", "HEAD"]);
  if (!REVISION.test(generatorRevision)) throw new Error("generator worktree HEAD is not a 40-character commit SHA");
  try {
    git(["cat-file", "-e", `${sourceRevision}^{commit}`]);
  } catch {
    throw new Error(`source revision ${sourceRevision} does not resolve to a commit in the generator repository`);
  }
  return { generator_revision: generatorRevision.toLowerCase() };
}

function reducedAuditEvent(record) {
  const base = { at: record.timestamp, node_id: record.node_id, source_hash: record.content_hash === undefined ? null : sourceHash(record.content_hash, `audit record ${record.id} content_hash`) };
  if ((record.kind === "trace" || record.kind === undefined) && typeof record.node_state_after === "string") {
    if (record.node_state_before === "pending" && record.node_state_after === "expanding") return { ...base, kind: "selected", source_kind: "audit.trace" };
    if (record.node_state_after === "verified") return { ...base, kind: "gate_confirmed", source_kind: "audit.trace" };
    if (record.node_state_before === "awaiting_review" && record.node_state_after === "claimed") return { ...base, kind: "claimed", source_kind: "audit.trace", final_state: "claimed" };
    if (record.node_state_after === "failed" || record.node_state_after === "pruned" || record.node_state_after === "abandoned") return { ...base, kind: "rejected", source_kind: "audit.trace", final_state: record.node_state_after };
    if (record.node_state_after === "interrupted") return { ...base, kind: "interrupted", source_kind: "audit.trace", final_state: "interrupted" };
  }
  if (record.kind === "gate_checkpoint" && record.checkpoint?.transition === "node_expansion" && record.checkpoint?.gate?.result === "pass") return { ...base, kind: "gate_confirmed", source_kind: "audit.gate_checkpoint" };
  if (record.kind === "interruption") return { ...base, kind: "interrupted", source_kind: "audit.interruption", final_state: "interrupted" };
  if (record.kind === "telemetry_observation" && record.observation?.type === "phase_timing" && record.observation?.phase === "select" && record.observation?.outcome === "success") return { ...base, kind: "selected", source_kind: "audit.telemetry_observation" };
  if (record.kind === "telemetry_observation" && record.observation?.phase === "backtrack") return { ...base, kind: "backtracked", source_kind: "audit.telemetry_observation", outcome: "observed_backtrack" };
  return null;
}

export function projectCampaignTreePublication(tree, audit, auditTip, sourceRevision, source = {}) {
  if (!isRecord(tree)) throw new Error("tree input must be an object");
  const campaignId = safeId(tree.campaign_id ?? tree.id, "campaign_id");
  const rootId = safeId(tree.root_id ?? tree.root?.id, "root_id");
  if (typeof sourceRevision !== "string" || !REVISION.test(sourceRevision)) throw new Error("source revision must be a 40-character git SHA");
  const allNodes = treeNodes(tree, campaignId, rootId);
  const root = allNodes.find((node) => node.id === rootId);
  const nodeIds = new Set(allNodes.map((node) => node.id));
  const records = validateAudit(auditRecords(audit), campaignId, nodeIds);
  const tip = validateAuditTip(auditTip, records, campaignId);
  if (typeof source.generator_revision !== "string" || !REVISION.test(source.generator_revision)) throw new Error("generator revision must be a 40-character git SHA");
  const auditEvents = records.map(reducedAuditEvent).filter(Boolean);
  const events = [
    { at: root.created_at, kind: "campaign_started", node_id: rootId, source_kind: "tree_snapshot", source_hash: source.tree_sha256 ?? null },
    ...allNodes.filter((node) => node.id !== rootId).map((node) => ({ at: node.created_at, kind: "branch_created", node_id: node.id, source_kind: "tree_snapshot", source_hash: source.tree_sha256 ?? null, final_state: node.final_state })),
    ...auditEvents,
  ].sort((left, right) => left.at.localeCompare(right.at) || (EVENT_ORDER.get(left.kind) ?? 99) - (EVENT_ORDER.get(right.kind) ?? 99) || left.node_id.localeCompare(right.node_id));
  if (!events.some((event) => event.kind === "selected" || event.kind === "gate_confirmed" || event.kind === "rejected" || event.kind === "interrupted")) throw new Error("audit input has no publishable tree transition");
  const auditHashes = records.filter((record) => record.content_hash !== undefined).map((record) => sourceHash(record.content_hash, `audit record ${record.id} content_hash`));
  const fixture = {
    schema_version: 1,
    kind: "revoy2.campaign-tree-hero-events",
    campaign_id: campaignId,
    source_revision: sourceRevision.toLowerCase(),
    generator_revision: source.generator_revision.toLowerCase(),
    source: {
      tree_campaign_id: campaignId,
      audit_campaign_id: campaignId,
      tree_root_id: rootId,
      source_node_ids: allNodes.map((node) => node.id),
      ...(source.tree_sha256 ? { tree_snapshot_sha256: source.tree_sha256 } : {}),
      ...(source.audit_sha256 ? { audit_input_sha256: source.audit_sha256 } : {}),
      ...(source.audit_tip_sha256 ? { audit_tip_file_sha256: source.audit_tip_sha256 } : {}),
      audit_tip_hash: tip.tip_hash,
      audit_tip_content_hash: tip.content_hash,
      audit_record_count: tip.record_count,
      ...(auditHashes.length ? { audit_chain_head: auditHashes.at(-1), audit_record_hashes: auditHashes } : {}),
      constraint: "Public projection contains only observed campaign topology, timestamps, closed states, reduced audit transitions, source hashes, and source revision. It omits task text, actions, paths, payloads, prompts, model output, credentials, and environment data.",
    },
    root: { id: root.id, created_at: root.created_at },
    nodes: allNodes.filter((node) => node.id !== rootId),
    events,
  };
  assertSecretFree(JSON.stringify(fixture), "campaign-tree public projection");
  return fixture;
}

export function safeOutputRoot(path) {
  const requested = resolve(path);
  const lexicalRoot = resolve("/mnt/sda2");
  if (requested !== lexicalRoot && !requested.startsWith(`${lexicalRoot}${sep}`)) throw new Error("campaign-tree publication output must remain under /mnt/sda2");
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const actual = realpathSync(requested);
  const canonicalRoot = realpathSync(lexicalRoot);
  if (actual !== canonicalRoot && !actual.startsWith(`${canonicalRoot}${sep}`)) throw new Error("campaign-tree publication output resolved outside /mnt/sda2");
  return actual;
}

function verifyWebm(path) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height", "-of", "json", path], { encoding: "utf8" }));
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  if (!video || video.codec_name !== "vp9" || video.width !== 1600 || video.height !== 600 || !(Number(probe.format?.duration) > 0)) throw new Error("campaign-tree WebM failed media verification");
  return probe;
}

export function mp4FfmpegArgs(webmPath, mp4Path) {
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", webmPath, "-map", "0:v:0", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4Path];
}

function renderMp4Derivative(webmPath, mp4Path) {
  execFileSync("ffmpeg", mp4FfmpegArgs(webmPath, mp4Path), { stdio: "inherit" });
}

function verifyMp4(path) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,pix_fmt", "-of", "json", path], { encoding: "utf8" }));
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  if (!video || video.codec_name !== "h264" || video.pix_fmt !== "yuv420p" || video.width !== 1600 || video.height !== 600 || !(Number(probe.format?.duration) > 0)) throw new Error("campaign-tree MP4 failed media verification");
  return probe;
}

export function sealCampaignTreePublication({ tree_path, audit_path, audit_tip_path, source_revision, generator_worktree, output_directory, render = false }) {
  if (!audit_tip_path) throw new Error("audit tip is required");
  const generator = validateGeneratorWorktree(generator_worktree, source_revision);
  const treeBytes = readFileSync(resolve(tree_path));
  const auditBytes = readFileSync(resolve(audit_path));
  const auditTipBytes = readFileSync(resolve(audit_tip_path));
  const fixture = projectCampaignTreePublication(JSON.parse(String(treeBytes)), parseAuditInput(String(auditBytes)), JSON.parse(String(auditTipBytes)), source_revision, {
    tree_sha256: sha256Bytes(treeBytes), audit_sha256: sha256Bytes(auditBytes), audit_tip_sha256: sha256Bytes(auditTipBytes), ...generator,
  });
  const output = safeOutputRoot(resolve(output_directory));
  if (existsSync(join(output, "manifest.json")) || existsSync(join(output, "SHA256SUMS")) || existsSync(join(output, ".incomplete"))) throw new Error("publication output already contains a sealed or incomplete run");
  writeFileSync(join(output, ".incomplete"), "campaign-tree publication is incomplete\n", { mode: 0o600, flag: "wx" });
  try {
    const fixturePath = join(output, "campaign-tree-events.json");
    const privacyPath = join(output, "privacy-report.json");
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const privacy = { schema_version: 1, kind: "campaign_tree_publication", source_records_published: false, bound_inputs: ["tree_snapshot_sha256", "audit_input_sha256", "audit_tip_file_sha256", "audit_tip_hash", "audit_tip_content_hash", "source_revision", "generator_revision"], public_fields: ["campaign_id", "node_id", "parent_id", "timestamps", "closed_node_state", "reduced_event_kind", "source_hash", "source_revision", "generator_revision"], omitted_fields: ["task", "action_description", "paths", "payloads", "prompts", "model_output", "credentials", "environment"], secret_pattern_codes: publicationSecretPatternCodes, findings: 0 };
    writeFileSync(privacyPath, `${JSON.stringify(privacy, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const assets = [fixturePath, privacyPath];
    let media = null;
    if (render) {
      const webmPath = join(output, "campaign-tree.webm");
      const mp4Path = join(output, "campaign-tree.mp4");
      renderCampaignTreeHero(fixturePath, webmPath);
      renderMp4Derivative(webmPath, mp4Path);
      media = { webm: verifyWebm(webmPath), mp4: verifyMp4(mp4Path) };
      assets.push(webmPath, mp4Path);
    }
    for (const path of assets.filter((path) => path.endsWith(".json"))) assertSecretFree(readFileSync(path, "utf8"), `public ${path}`);
    const sealed = writeManifestAndChecksums(output, { schema_version: 1, product: "revoy2", artifact_kind: "campaign_tree_publication", run_id: fixture.campaign_id, source_revision: fixture.source_revision, generator_revision: fixture.generator_revision, campaign_id: fixture.campaign_id, tree_snapshot_sha256: fixture.source.tree_snapshot_sha256, audit_input_sha256: fixture.source.audit_input_sha256, audit_tip_file_sha256: fixture.source.audit_tip_file_sha256, audit_tip_hash: fixture.source.audit_tip_hash, audit_tip_content_hash: fixture.source.audit_tip_content_hash, audit_chain_head: fixture.source.audit_chain_head ?? null, media }, assets);
    rmSync(join(output, ".incomplete"));
    return { output_directory: output, fixture: fixturePath, ...(render ? { webm: join(output, "campaign-tree.webm"), mp4: join(output, "campaign-tree.mp4") } : {}), manifest: sealed.manifest_path, checksums: sealed.checksums_path };
  } catch (error) { throw error; }
}

function option(args, name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function main(args) {
  const tree = option(args, "--tree"), audit = option(args, "--audit"), auditTip = option(args, "--audit-tip"), revision = option(args, "--source-revision"), generatorWorktree = option(args, "--generator-worktree"), output = option(args, "--out");
  if (!tree || !audit || !auditTip || !revision || !generatorWorktree || !output) throw new Error("usage: bun scripts/campaign-tree-publication.mjs --tree <campaign-tree.json> --audit <audit.jsonl> --audit-tip <tip.json> --source-revision <40-hex-sha> --generator-worktree <clean-repository> --out <sda2-directory> [--render]");
  const result = sealCampaignTreePublication({ tree_path: tree, audit_path: audit, audit_tip_path: auditTip, source_revision: revision, generator_worktree: generatorWorktree, output_directory: output, render: args.includes("--render") });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
