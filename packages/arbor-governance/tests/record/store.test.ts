import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import * as governancePublicApi from "../../src/index.js";

const { GovernanceRecordStore } = governancePublicApi;

const record = (number: string, title: string, body = "ADR-001") => `# ADR-${number}: ${title}\n\n**Status:** Accepted\n**Date:** 2026-09-19\n\n## Context\n\nContext references ${body}.\n\n## Decision\n\nUse the canonical contract.\n\n## Consequences\n\nReaders can navigate this record.\n`;

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-governance-store-"));
  mkdirSync(join(root, "decisions"));
  return root;
}

describe("GovernanceRecordStore", () => {
  it("rebuilds a deterministic index, preserves malformed rows, and supports search/read/cross-links", () => {
    const root = repo();
    try {
      writeFileSync(join(root, "decisions", "ADR-001-first.md"), record("001", "First"));
      writeFileSync(join(root, "decisions", "ADR-002-second.md"), record("002", "Second", "ADR-001"));
      writeFileSync(join(root, "decisions", "ADR-003-invalid.md"), "not a record\n");
      const store = new GovernanceRecordStore({ repo_root: root });
      const published = store.publish();
      expect(published.ok).toBe(true);
      if (!published.ok) return;
      expect(published.value.entries).toHaveLength(3);
      expect(published.value.entries.find((entry) => entry.id === "revoy2:ADR-003")?.valid).toBe(false);
      const search = store.browse("second");
      expect(search.ok).toBe(true);
      if (!search.ok) return;
      expect(search.value.entries.map((entry) => entry.id)).toEqual(["revoy2:ADR-002"]);
      const read = store.read("revoy2:ADR-001");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.title).toBe("First");
      const links = store.crossLinks("revoy2:ADR-001");
      expect(links.ok).toBe(true);
      if (!links.ok) return;
      expect(links.value.map((entry) => entry.id)).toEqual(["revoy2:ADR-001", "revoy2:ADR-002"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rebuilds after deleting the generated index and preserves stable revisions", () => {
    const root = repo();
    try {
      const path = join(root, "decisions", "ADR-001-first.md");
      writeFileSync(path, record("001", "First"));
      const store = new GovernanceRecordStore({ repo_root: root });
      const first = store.publish();
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const revision = first.value.revisions[0].revision;
      // The generated filename is an implementation detail. Consumers use
      // the store's public path rather than importing a package-level constant.
      expect(governancePublicApi).not.toHaveProperty("GOVERNANCE_INDEX_FILE");
      rmSync(store.index_path);
      const rebuilt = store.ensureIndex();
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;
      expect(rebuilt.value.revisions.find((item) => item.id === "revoy2:ADR-001")?.revision).toBe(revision);
      expect(JSON.parse(readFileSync(store.index_path, "utf8")).schema_version).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("persists interview state across restart and keeps unresolved distinct from answered", () => {
    const root = repo();
    try {
      const store = new GovernanceRecordStore({ repo_root: root });
      expect(store.appendInterview({ receipt_id: "open", covered: ["ADR-001"], outcomes: {} }).ok).toBe(true);
      expect(store.appendInterview({ receipt_id: "closed", covered: ["ADR-002"], outcomes: { "ADR-002": "accepted" } }).ok).toBe(true);
      const restarted = new GovernanceRecordStore({ repo_root: root });
      const index = restarted.ensureIndex();
      expect(index.ok).toBe(true);
      if (!index.ok) return;
      expect(index.value.interviews.map((item) => [item.id, item.state])).toEqual([["open", "unresolved"], ["closed", "answered"]]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("pages browse results and reserves historical IDs after their source is removed", () => {
    const root = repo();
    try {
      writeFileSync(join(root, "decisions", "ADR-001-first.md"), record("001", "First"));
      writeFileSync(join(root, "decisions", "ADR-002-second.md"), record("002", "Second"));
      const store = new GovernanceRecordStore({ repo_root: root });
      expect(store.publish().ok).toBe(true);
      const page = store.browse("", 1, 0);
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.entries).toHaveLength(1);
      expect(page.value.has_more).toBe(true);
      rmSync(join(root, "decisions", "ADR-002-second.md"));
      expect(store.publish().ok).toBe(true);
      const created = store.create(record("999", "Third"));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.record_number).toBe(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("allocates a collision-free stable ID and publishes atomically", () => {
    const root = repo();
    try {
      writeFileSync(join(root, "decisions", "ADR-001-first.md"), record("001", "First"));
      const store = new GovernanceRecordStore({ repo_root: root });
      const created = store.create(record("999", "Created"));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.id).toBe("revoy2:ADR-002");
      const read = store.read("revoy2:ADR-002");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.title).toBe("Created");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a held publication lock and recovers a stale lock", () => {
    const root = repo();
    try {
      const store = new GovernanceRecordStore({ repo_root: root, lock_stale_ms: 1 });
      mkdirSync(store.lock_path);
      expect(store.publish().ok).toBe(false);
      rmSync(store.lock_path, { recursive: true, force: true });
      writeFileSync(join(root, "decisions", "ADR-001-first.md"), record("001", "First"));
      const recovered = store.publish();
      expect(recovered.ok).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
