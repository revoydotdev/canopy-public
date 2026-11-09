#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUTPUT = 'docs/durable-corpus-inventory.json';
const SELF_PATHS = new Set([DEFAULT_OUTPUT]);
const ROOTS = [
  { prefix: 'decisions/', scope: 'decisions' },
  { prefix: 'docs/', scope: 'docs' },
  { prefix: 'audit/', scope: 'audit' },
  { prefix: 'artifacts/', scope: 'artifacts' },
  { prefix: '.agents/skills/', scope: 'skills' },
  { prefix: '.claude/skills/', scope: 'skills' },
];

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'buffer' });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function scopeFor(file) {
  const root = ROOTS.find(({ prefix }) => file.startsWith(prefix));
  if (root) return root.scope;
  if (file.startsWith('packages/') && file.toLowerCase().endsWith('.md')) return 'package-facing-markdown';
  return null;
}

function kindFor(file, scope) {
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);
  const ext = path.posix.extname(lower);
  if (scope === 'decisions' && /^adr-\d+/.test(base)) return 'architecture-decision';
  if (scope === 'skills') return base === 'skill.md' ? 'agent-skill' : 'skill-resource';
  if (scope === 'package-facing-markdown') return base === 'readme.md' ? 'package-guide' : 'package-documentation';
  if (scope === 'docs') {
    if (lower.includes('/handoffs/')) return 'roadmap-handoff';
    if (lower.includes('roadmap')) return 'roadmap';
    if (lower.includes('/research/') || lower.includes('/comparative-analysis/')) return 'research-record';
    if (base === 'readme.md') return 'documentation-index';
    if (/plan|proposal/.test(base)) return 'plan-or-proposal';
    return ext === '.md' ? 'documentation' : 'documentation-supporting-asset';
  }
  if (scope === 'audit') {
    if (['.png', '.jpg', '.jpeg', '.svg', '.mp4', '.webm', '.cast', '.html'].includes(ext)) return 'audit-media-evidence';
    if (['.json', '.jsonl', '.csv', '.yaml', '.yml'].includes(ext)) return 'audit-structured-evidence';
    if (['.log', '.err', '.out', '.sse', '.txt'].includes(ext)) return 'audit-run-record';
    return 'audit-report-or-supporting-file';
  }
  if (scope === 'artifacts') {
    if (['.png', '.jpg', '.jpeg', '.svg', '.mp4', '.webm', '.cast', '.html'].includes(ext)) return 'published-artifact-media';
    if (['.json', '.jsonl', '.csv', '.yaml', '.yml'].includes(ext)) return 'published-artifact-metadata';
    if (['.log', '.err', '.out', '.sse', '.txt'].includes(ext)) return 'published-artifact-record';
    return 'published-artifact-supporting-file';
  }
  return 'decision-supporting-file';
}

function markdownMetadata(file, bytes) {
  if (!file.toLowerCase().endsWith('.md')) return { status: null, statusBasis: 'not_applicable', declaredKind: null, planningItems: [] };
  const lines = bytes.toString('utf8').split(/\r?\n/);
  const header = lines.slice(0, 20);
  let status = null;
  let statusBasis = 'not_declared';
  let declaredKind = null;
  for (let index = 0; index < header.length; index += 1) {
    const line = header[index];
    const statusMatch = line.match(/^\s*(?:\*\*Status:\*\*\s*|\*\*Status\*\*\s*:\s*|Status\s*:\s*|status\s*:\s*)["']?(.+?)["']?\s*$/i);
    if (status === null && statusMatch) {
      status = statusMatch[1].trim();
      statusBasis = index < 12 ? 'document-header' : 'early-document-label';
    }
    const kindMatch = line.match(/^\s*(?:\*\*Artifact kind:\*\*|Artifact kind)\s*:?\s*(.+?)\s*$/i);
    if (declaredKind === null && kindMatch) declaredKind = kindMatch[1].trim();
  }
  const planningItems = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (match) planningItems.push({ source_line: index + 1, checklist_status: match[1].trim() ? 'complete' : 'open', text: match[2] });
  }
  return { status, statusBasis, declaredKind, planningItems };
}

function lifecycleClassification(status) {
  if (status === null) return 'undeclared';
  if (/^(active|current|open|in[ -]progress|pending|proposed|planned|incomplete|under[ -]review)\b/i.test(status)) return 'active';
  if (/^(superseded|retired|deprecated|archived|historical|completed|complete|closed|cancelled|canceled|withdrawn|obsolete|replaced)\b/i.test(status)) return 'historical';
  return 'declared_other';
}

function currentBytes(root, file) {
  const absolute = path.join(root, file);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(absolute));
  return readFileSync(absolute);
}

function isInInventoryScope(file) {
  return scopeFor(file) !== null;
}

function dirtyCorpusPaths(root, outputPath) {
  const changed = git(root, ['diff', '--name-only', '-z', 'HEAD', '--']).toString().split('\0').filter(Boolean);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  return [...new Set([...changed, ...untracked])]
    .filter((file) => file !== outputPath && isInInventoryScope(file))
    .sort();
}

export function buildInventory(root, outputPath = DEFAULT_OUTPUT) {
  const revision = git(root, ['rev-parse', 'HEAD']).toString().trim();
  const tracked = git(root, [
    'ls-files', '-z', '--',
    'decisions/', 'docs/', 'audit/', 'artifacts/', '.agents/skills/', '.claude/skills/',
    'packages/*.md', 'packages/**/*.md',
  ]).toString().split('\0').filter(Boolean);
  const files = [...new Set(tracked)]
    .filter((file) => !SELF_PATHS.has(file) && file !== outputPath && isInInventoryScope(file))
    .sort(compareStrings);

  const items = files.map((file) => {
    const scope = scopeFor(file);
    const bytes = currentBytes(root, file);
    const metadata = markdownMetadata(file, bytes);
    return {
      path: file,
      scope,
      kind: kindFor(file, scope),
      kind_basis: 'path_and_extension_rules',
      declared_kind: metadata.declaredKind,
      declared_status: metadata.status,
      lifecycle_classification: lifecycleClassification(metadata.status),
      status_basis: metadata.statusBasis,
      planning_items: metadata.planningItems,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  const digestInput = items.map(({ path: file, sha256: digest }) => `${file}\0${digest}\n`).join('');
  const dirtyPaths = dirtyCorpusPaths(root, outputPath);
  const counts = {};
  const kinds = {};
  const statuses = {};
  const lifecycle = {};
  const checklist = {};
  let planningItemCount = 0;
  for (const item of items) {
    counts[item.scope] = (counts[item.scope] ?? 0) + 1;
    kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
    const statusKey = item.declared_status ?? 'not_declared';
    statuses[statusKey] = (statuses[statusKey] ?? 0) + 1;
    lifecycle[item.lifecycle_classification] = (lifecycle[item.lifecycle_classification] ?? 0) + 1;
    for (const planningItem of item.planning_items) {
      planningItemCount += 1;
      checklist[planningItem.checklist_status] = (checklist[planningItem.checklist_status] ?? 0) + 1;
    }
  }

  return {
    schema: 'revoy.durable-corpus-inventory/v1',
    generated_from_revision: revision,
    freshness: {
      status: dirtyPaths.length === 0 ? 'current' : 'dirty',
      checked_against_revision: revision,
      dirty_corpus_paths: dirtyPaths,
      rule: 'Current means every tracked in-scope file matches its working-tree content and no untracked in-scope file exists; the inventory output is excluded.',
    },
    coverage: {
      basis: 'Git-tracked authored files under the named scopes; package coverage is Markdown only.',
      scopes: ['decisions', 'docs', 'audit', 'artifacts', 'skills', 'package-facing-markdown'],
      excluded: ['untracked files are listed only in freshness.dirty_corpus_paths, not as inventory items', 'ignored files', 'package files other than Markdown', 'the inventory output itself'],
      binary_files: 'Included and hashed as bytes; symlinks are represented and hashed by their link target text.',
      status_semantics: 'declared_status is copied from a recognized early Markdown status label only. lifecycle_classification is an explicit-label-only mechanical bucket: active or historical when those terms are recognized, declared_other for other declared labels, and undeclared when no label exists.',
      planning_semantics: 'Markdown checkbox items are extracted with line number and literal open/complete state. An open checkbox is not evidence that a superseded or undeclared document remains authoritative.',
    },
    summary: {
      item_count: items.length,
      by_scope: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compareStrings(a, b))),
      by_kind: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => compareStrings(a, b))),
      by_declared_status: Object.fromEntries(Object.entries(statuses).sort(([a], [b]) => compareStrings(a, b))),
      by_lifecycle_classification: Object.fromEntries(Object.entries(lifecycle).sort(([a], [b]) => compareStrings(a, b))),
      planning_item_count: planningItemCount,
      by_checklist_status: Object.fromEntries(Object.entries(checklist).sort(([a], [b]) => compareStrings(a, b))),
      input_sha256: sha256(Buffer.from(digestInput)),
    },
    items,
  };
}

function parseArgs(argv) {
  const options = { root: process.cwd(), output: DEFAULT_OUTPUT, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index]);
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--check') options.check = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: bun scripts/document-inventory.mjs [--root REPO] [--output PATH] [--check]\n');
    return;
  }
  const outputPath = options.output.replaceAll('\\', '/');
  const inventory = buildInventory(options.root, outputPath);
  const output = `${JSON.stringify(inventory, null, 2)}\n`;
  const target = path.join(options.root, outputPath);
  if (options.check) {
    if (!existsSync(target)) throw new Error(`Inventory does not exist: ${outputPath}`);
    const committed = JSON.parse(readFileSync(target, 'utf8'));
    if (committed.schema !== inventory.schema || committed.summary?.input_sha256 !== inventory.summary.input_sha256) {
      throw new Error('Durable corpus inventory is stale; run `bun run docs:inventory` and review the generated diff.');
    }
    if (inventory.freshness.status !== 'current') throw new Error(`Corpus has ${inventory.freshness.dirty_corpus_paths.length} dirty or untracked in-scope paths.`);
    process.stdout.write(`durable corpus inventory current: ${inventory.summary.item_count} items (${inventory.summary.input_sha256})\n`);
    return;
  }
  writeFileSync(target, output);
  process.stdout.write(`wrote ${outputPath}: ${inventory.summary.item_count} items; ${inventory.freshness.status}; ${inventory.summary.input_sha256}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
