import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProofMatrix, gallery, ingestSealedCampaignTreeArtifact, publicTreeCaptions, sealShippedPackage } from "../commercial-demo-suite.mjs";
import { renderTmuxFrame } from "../tmux-demo-record.mjs";
import { writeManifestAndChecksums } from "../lib/sizzle-manifest.mjs";

const REVISION = "a".repeat(40);
const GENERATOR_REVISION = "b".repeat(40);
const HASH = `sha256:${"c".repeat(64)}`;

function sealedCampaignTreeFixture(directory, options = {}) {
  mkdirSync(directory, { recursive: true });
  const fixture = {
    schema_version: 1,
    campaign_id: "campaign-proof",
    source_revision: REVISION,
    generator_revision: GENERATOR_REVISION,
    source: { audit_tip_file_sha256: HASH, audit_tip_hash: HASH, audit_tip_content_hash: HASH },
    events: [
      { at: "2026-08-22T12:00:00.000Z", kind: "campaign_started", node_id: "root" },
      { at: "2026-08-22T12:00:01.000Z", kind: "branch_created", node_id: "branch-1" },
      { at: "2026-08-22T12:00:02.000Z", kind: "selected", node_id: "branch-1" },
      { at: "2026-08-22T12:00:03.000Z", kind: "rejected", node_id: "branch-1", final_state: "failed" },
      { at: "2026-08-22T12:00:04.000Z", kind: "backtracked", node_id: "root" },
    ],
  };
  writeFileSync(join(directory, "campaign-tree.mp4"), "mp4 bytes");
  writeFileSync(join(directory, "campaign-tree.webm"), "webm bytes");
  writeFileSync(join(directory, "campaign-tree-events.json"), `${JSON.stringify(fixture)}\n`);
  writeFileSync(join(directory, "privacy-report.json"), `${JSON.stringify({ kind: "campaign_tree_publication", source_records_published: false })}\n`);
  writeManifestAndChecksums(directory, {
    schema_version: 1,
    artifact_kind: "campaign_tree_publication",
    campaign_id: fixture.campaign_id,
    source_revision: REVISION,
    generator_revision: GENERATOR_REVISION,
    audit_tip_file_sha256: HASH,
    audit_tip_hash: HASH,
    audit_tip_content_hash: HASH,
    ...(options.adoption ? { adoption: options.adoption } : {}),
    ...(options.controlled_fixture ? { controlled_fixture: true } : {}),
  }, ["campaign-tree.mp4", "campaign-tree.webm", "campaign-tree-events.json", "privacy-report.json"].map((name) => join(directory, name)));
}

describe("commercial empirical demo suite", () => {
  it("refuses a dossier whose visual headline lacks empirical evidence", () => {
    expect(() => buildProofMatrix({ flight_report: { ok: false }, flight_events: [], cockpit: { checks: {} }, hero: { events: [] } })).toThrow(/proof matrix incomplete/);
  });

  it("renders terminal text as escaped, branded 1920x1080 SVG", () => {
    const svg = renderTmuxFrame({ at_ms: 500, left: "Crown <selects>", right: "loop.node_claimed" }, { run_id: "demo", duration_ms: 1000 });
    expect(svg).toContain('viewBox="0 0 1920 1080"');
    expect(svg).toContain("LIVE GOVERNED OPERATOR COCKPIT");
    expect(svg).toContain("Crown &lt;selects&gt;");
    expect(svg).not.toContain("Crown <selects>");
  });

  it("clips and marks overlong text independently inside both cockpit panels", () => {
    const long = "x".repeat(1_000);
    const svg = renderTmuxFrame({ at_ms: 500, left: long, right: long }, { duration_ms: 1_000 });
    expect(svg).toContain('clipPath id="left-panel-clip"');
    expect(svg).toContain('clipPath id="right-panel-clip"');
    expect(svg).toContain('<g clip-path="url(#left-panel-clip)">');
    expect(svg).toContain('<g clip-path="url(#right-panel-clip)">');
    expect(svg).toContain("…</text>");
    expect(svg).not.toContain(long);
  });

  it("reseals copied chapters against only the files the commercial package ships", () => {
    const dir = mkdtempSync(join(tmpdir(), "commercial-seal-"));
    try {
      const asset = join(dir, "proof.webm");
      writeFileSync(asset, "published bytes");
      sealShippedPackage(dir, { schema_version: 1, assets: [{ path: "private-master.mkv", sha256: "stale" }] }, [asset]);
      const manifest = readFileSync(join(dir, "manifest.json"), "utf8");
      const checksums = readFileSync(join(dir, "package-SHA256SUMS"), "utf8");
      expect(manifest).toContain('"path": "proof.webm"');
      expect(checksums).toContain("  proof.webm");
      expect(manifest).not.toContain("private-master.mkv");
      expect(checksums).not.toContain("private-master.mkv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ingests only a sealed tree package and creates public captions and transcript from reduced events", () => {
    const source = mkdtempSync(join(tmpdir(), "commercial-tree-source-"));
    const target = join(source, "imported");
    try {
      sealedCampaignTreeFixture(source);
      const imported = ingestSealedCampaignTreeArtifact(source, target, "failure_backtracking");
      expect(imported.outcome_label).toBe("Observed failure and backtracking");
      expect(imported.missing_provenance).toEqual([]);
      expect(readFileSync(join(target, "campaign-tree-captions.vtt"), "utf8")).toContain("WEBVTT");
      expect(readFileSync(join(target, "campaign-tree-transcript.txt"), "utf8")).toContain("backtracked: root");
      const captions = publicTreeCaptions(imported.fixture.events, imported.outcome);
      expect(captions.transcript).not.toContain("payload");
    } finally { rmSync(source, { recursive: true, force: true }); }
  });

  it("rejects tampered, incomplete, and unknown-outcome campaign-tree packages", () => {
    const source = mkdtempSync(join(tmpdir(), "commercial-tree-reject-"));
    try {
      sealedCampaignTreeFixture(source);
      writeFileSync(join(source, "campaign-tree.webm"), "tampered bytes");
      expect(() => ingestSealedCampaignTreeArtifact(source, join(source, "tampered"), "failure_backtracking")).toThrow(/checksum verification failed/);
      sealedCampaignTreeFixture(join(source, "second"));
      rmSync(join(source, "second", "campaign-tree.mp4"));
      expect(() => ingestSealedCampaignTreeArtifact(join(source, "second"), join(source, "missing-codec"), "failure_backtracking")).toThrow(/campaign-tree campaign-tree.mp4 is required/);
      sealedCampaignTreeFixture(join(source, "third"));
      expect(() => ingestSealedCampaignTreeArtifact(join(source, "third"), join(source, "unknown"), "not-an-outcome")).toThrow(/outcome must be one of/);
    } finally { rmSync(source, { recursive: true, force: true }); }
  });

  it("rejects a success label without sealed adoption evidence and renders caption tracks for every gallery video", () => {
    const source = mkdtempSync(join(tmpdir(), "commercial-tree-adoption-"));
    try {
      sealedCampaignTreeFixture(source);
      expect(() => ingestSealedCampaignTreeArtifact(source, join(source, "success"), "verified_adopted")).toThrow(/requires sealed adoption evidence/);
      const html = gallery("demo", { claims: [], limitations: [], campaign_cognition: { outcome_label: "Observed failure and backtracking" } });
      expect((html.match(/kind="captions"/g) ?? []).length).toBe(3);
      expect(html).toContain("Observed failure and backtracking");
    } finally { rmSync(source, { recursive: true, force: true }); }
  });
});
