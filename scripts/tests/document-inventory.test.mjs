import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInventory } from '../document-inventory.mjs';

const roots = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'durable-inventory-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'inventory-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Inventory Test'], { cwd: root });
  mkdirSync(path.join(root, 'decisions'), { recursive: true });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, 'audit'), { recursive: true });
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  mkdirSync(path.join(root, '.agents/skills/example'), { recursive: true });
  mkdirSync(path.join(root, 'packages/example'), { recursive: true });
  writeFileSync(path.join(root, 'decisions/ADR-001-example.md'), '# Example\n\n**Status:** Accepted\n');
  writeFileSync(path.join(root, 'docs/plan.md'), '# Plan\n\nArtifact kind: roadmap\nStatus: active\n\n- [ ] Remaining work\n- [x] Finished work\n');
  writeFileSync(path.join(root, 'docs/old-roadmap.md'), '# Old plan\n\nStatus: superseded\n');
  writeFileSync(path.join(root, 'audit/run.json'), '{"ok":true}\n');
  writeFileSync(path.join(root, 'artifacts/image.bin'), Buffer.from([0, 1, 2, 255]));
  writeFileSync(path.join(root, '.agents/skills/example/SKILL.md'), '# Skill\n');
  writeFileSync(path.join(root, 'packages/example/README.md'), '# Package\n');
  writeFileSync(path.join(root, 'packages/example/index.ts'), 'export {};\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable corpus inventory', () => {
  it('is deterministic for the same source revision and classifies tracked scope', () => {
    const root = fixture();
    const first = buildInventory(root);
    const second = buildInventory(root);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.generated_from_revision).toMatch(/^[0-9a-f]{40}$/);
    expect(first.freshness.status).toBe('current');
    expect(first.items.map((item) => item.path)).toEqual([
      '.agents/skills/example/SKILL.md',
      'artifacts/image.bin',
      'audit/run.json',
      'decisions/ADR-001-example.md',
      'docs/old-roadmap.md',
      'docs/plan.md',
      'packages/example/README.md',
    ]);
    expect(first.items.find((item) => item.path.startsWith('decisions/'))).toMatchObject({
      kind: 'architecture-decision', declared_status: 'Accepted', status_basis: 'document-header',
    });
    expect(first.items.find((item) => item.path === 'artifacts/image.bin')).toMatchObject({ bytes: 4, kind: 'published-artifact-supporting-file' });
    expect(first.items.find((item) => item.path === 'docs/plan.md')).toMatchObject({
      declared_kind: 'roadmap', declared_status: 'active', lifecycle_classification: 'active',
      planning_items: [
        { source_line: 6, checklist_status: 'open', text: 'Remaining work' },
        { source_line: 7, checklist_status: 'complete', text: 'Finished work' },
      ],
    });
    expect(first.items.find((item) => item.path === 'docs/old-roadmap.md')).toMatchObject({ lifecycle_classification: 'historical' });
    expect(first.items.some((item) => item.path.endsWith('index.ts'))).toBe(false);
    expect(first.summary.item_count).toBe(7);
    expect(first.summary.by_lifecycle_classification).toMatchObject({ active: 1, historical: 1, undeclared: 4, declared_other: 1 });
    expect(first.summary.by_checklist_status).toEqual({ complete: 1, open: 1 });
  });

  it('reports untracked corpus files as stale without pretending they are inventoried', () => {
    const root = fixture();
    writeFileSync(path.join(root, 'docs/new-draft.md'), '# Untracked\n');
    const inventory = buildInventory(root);
    expect(inventory.freshness.status).toBe('dirty');
    expect(inventory.freshness.dirty_corpus_paths).toEqual(['docs/new-draft.md']);
    expect(inventory.items.some((item) => item.path === 'docs/new-draft.md')).toBe(false);
  });

  it('reports edits to tracked corpus sources as stale', () => {
    const root = fixture();
    writeFileSync(path.join(root, 'docs/plan.md'), '# Changed\n');
    const inventory = buildInventory(root);
    expect(inventory.freshness.status).toBe('dirty');
    expect(inventory.freshness.dirty_corpus_paths).toContain('docs/plan.md');
  });
});
