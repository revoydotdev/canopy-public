#!/usr/bin/env bun
/**
 * Publish every canonical tree in a lineage-linked campaign result.
 *
 * The campaign result supplies identity and ordering only. Each visual is
 * independently derived from the durable tree snapshot, hash-chained audit
 * ledger, and external audit-tip sentinel by campaign-tree-publication.mjs.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertSecretFree } from "./lib/sizzle-redaction.mjs";
import { writeManifestAndChecksums } from "./lib/sizzle-manifest.mjs";
import { sealCampaignTreePublication, validateGeneratorWorktree } from "./campaign-tree-publication.mjs";

const REVISION = /^[a-f0-9]{40}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function campaignIdentity(turn) {
  if (!record(turn)) return null;
  const id = turn.campaign_id ?? turn.campaign_result?.campaign_id;
  if (typeof id !== "string" || !SAFE_ID.test(id)) return null;
  const args = Array.isArray(turn.args) ? turn.args : [];
  const followupAt = args.indexOf("follow-up");
  const parent = followupAt >= 0 && typeof args[followupAt + 1] === "string"
    ? args[followupAt + 1]
    : turn.parent_campaign_id ?? null;
  return { campaign_id: id, parent_campaign_id: parent };
}

export function collectLifecycleCampaigns(result) {
  if (!record(result)) throw new Error("campaign result must be an object");
  const candidates = [
    ...(Array.isArray(result.task_turns) ? result.task_turns : []),
    ...(Array.isArray(result.followup_task_turns) ? result.followup_task_turns : []),
    ...(Array.isArray(result.followups) ? result.followups : []),
  ].map(campaignIdentity).filter(Boolean);
  const direct = campaignIdentity(result);
  if (direct) candidates.unshift(direct);

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.campaign_id)) continue;
    if (candidate.parent_campaign_id !== null && !SAFE_ID.test(candidate.parent_campaign_id)) {
      throw new Error(`campaign ${candidate.campaign_id} has an unsafe parent identity`);
    }
    seen.add(candidate.campaign_id);
    unique.push(candidate);
  }
  if (!unique.length) throw new Error("campaign result has no campaign identities");
  for (let index = 1; index < unique.length; index += 1) {
    const expected = unique[index - 1].campaign_id;
    const observed = unique[index].parent_campaign_id;
    if (observed !== expected) {
      throw new Error(`campaign ${unique[index].campaign_id} is not lineage-linked to ${expected}`);
    }
  }
  unique[0] = { ...unique[0], parent_campaign_id: null };
  return unique;
}

function required(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  return path;
}

export function publishLifecycleTrees(options) {
  const resultPath = resolve(options.result_path);
  const persistence = resolve(options.persistence_directory);
  const output = resolve(options.output_directory);
  const sourceRevision = String(options.source_revision ?? "").toLowerCase();
  if (!REVISION.test(sourceRevision)) throw new Error("source revision must be a 40-character commit SHA");
  if (existsSync(output)) throw new Error(`output already exists: ${output}`);

  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const campaigns = collectLifecycleCampaigns(result);
  const generator = validateGeneratorWorktree(options.generator_worktree, sourceRevision);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(join(output, ".incomplete"), "publication incomplete\n", { mode: 0o600, flag: "wx" });
  try {
    const chapters = campaigns.map((campaign, index) => {
      const id = campaign.campaign_id;
      const chapter = join(output, `campaign-${String(index + 1).padStart(2, "0")}`);
      const sealed = sealCampaignTreePublication({
        tree_path: required(join(persistence, "tree", `${id}.json`), "tree snapshot"),
        audit_path: required(join(persistence, "audit", `${id}.jsonl`), "audit ledger"),
        audit_tip_path: required(join(persistence, "audit-tips", `${id}.json`), "audit-tip sentinel"),
        source_revision: sourceRevision,
        generator_worktree: options.generator_worktree,
        output_directory: chapter,
        render: true,
      });
      return {
        sequence: index + 1,
        campaign_id: id,
        parent_campaign_id: campaign.parent_campaign_id,
        directory: `campaign-${String(index + 1).padStart(2, "0")}`,
        manifest: sealed.manifest,
      };
    });
    const lineage = {
      schema_version: 1,
      kind: "revoy2.lifecycle-tree-lineage",
      source_revision: sourceRevision,
      generator_revision: generator.generator_revision,
      campaign_count: chapters.length,
      root_campaign_id: chapters[0].campaign_id,
      terminal_campaign_id: chapters.at(-1).campaign_id,
      chapters: chapters.map(({ sequence, campaign_id, parent_campaign_id, directory }) => ({ sequence, campaign_id, parent_campaign_id, directory })),
    };
    const lineagePath = join(output, "lineage.json");
    assertSecretFree(JSON.stringify(lineage), "lifecycle tree lineage");
    writeFileSync(lineagePath, `${JSON.stringify(lineage, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const assets = [lineagePath, ...chapters.flatMap((chapter) => [
      join(output, chapter.directory, "manifest.json"),
      join(output, chapter.directory, "SHA256SUMS"),
      join(output, chapter.directory, "campaign-tree-events.json"),
      join(output, chapter.directory, "campaign-tree.webm"),
      join(output, chapter.directory, "campaign-tree.mp4"),
      join(output, chapter.directory, "privacy-report.json"),
    ])];
    const sealed = writeManifestAndChecksums(output, {
      schema_version: 1,
      product: "revoy2",
      artifact_kind: "lineage_linked_campaign_tree_publication",
      run_id: chapters[0].campaign_id,
      source_revision: sourceRevision,
      generator_revision: generator.generator_revision,
      campaign_count: chapters.length,
      root_campaign_id: chapters[0].campaign_id,
      terminal_campaign_id: chapters.at(-1).campaign_id,
    }, assets);
    rmSync(join(output, ".incomplete"));
    return { output_directory: output, lineage: lineagePath, manifest: sealed.manifest_path, checksums: sealed.checksums_path };
  } catch (error) {
    throw error;
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function main(args) {
  const result = option(args, "--result");
  const persistence = option(args, "--persistence");
  const revision = option(args, "--source-revision");
  const generatorWorktree = option(args, "--generator-worktree");
  const output = option(args, "--out");
  if (!result || !persistence || !revision || !generatorWorktree || !output) {
    throw new Error("usage: bun scripts/lifecycle-tree-publication.mjs --result <campaign-result.json> --persistence <.arbor-evidence> --source-revision <revoy-sha> --generator-worktree <clean-revoy-worktree> --out </mnt/sda2/...>");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...publishLifecycleTrees({ result_path: result, persistence_directory: persistence, source_revision: revision, generator_worktree: generatorWorktree, output_directory: output }) })}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
