import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskAttachmentStore, TASK_ATTACHMENT_MAX_BYTES, TASK_DOCUMENT_MAX_BYTES } from "../src/task-attachment-store.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("TaskAttachmentStore", () => {
  it("captures immutable content-addressed media and resolves governed artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-attachments-"));
    try {
      const store = new TaskAttachmentStore(dir);
      const refs = store.capture([{ display_name: "screen.png", content_base64: PNG.toString("base64") }], "cli");
      expect(refs[0]).toMatchObject({ attachment_id: `attachment:${refs[0]!.sha256}`, media_type: "image/png", byte_length: PNG.byteLength, provenance: { tag: "claimed", claimant: "operator:cli" } });
      expect(store.resolve(refs)).toEqual([{ artifact_id: refs[0]!.attachment_id, media_type: "image/png", encoding: "base64", content: PNG.toString("base64"), provenance: { tag: "claimed", claimant: "operator:cli" } }]);
      expect(readFileSync(join(dir, "task-attachments", "objects", refs[0]!.sha256))).toEqual(PNG);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects extension spoofing and detects persisted-object corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-attachments-"));
    try {
      const store = new TaskAttachmentStore(dir);
      expect(() => store.capture([{ display_name: "fake.png", content_base64: Buffer.from("not an image").toString("base64") }], "web")).toThrow(/not a supported/);
      const refs = store.capture([{ display_name: "screen.png", content_base64: PNG.toString("base64") }], "tui");
      writeFileSync(join(dir, "task-attachments", "objects", refs[0]!.sha256), "corrupt");
      expect(() => store.resolve(refs)).toThrow(/integrity verification/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("binds immutable campaign refs across restart and verifies them again on replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-attachments-"));
    try {
      const store = new TaskAttachmentStore(dir);
      const refs = store.capture([{ display_name: "screen.png", content_base64: PNG.toString("base64") }], "cli");
      store.bindCampaign("campaign-attachment-replay", refs);
      const restarted = new TaskAttachmentStore(dir);
      expect(restarted.resolveCampaign("campaign-attachment-replay")).toEqual(store.resolve(refs));
      const other = store.capture([{ display_name: "other.png", content_base64: Buffer.from([...PNG, 1]).toString("base64") }], "cli");
      expect(() => restarted.bindCampaign("campaign-attachment-replay", other)).toThrow(/immutable/);
      writeFileSync(join(dir, "task-attachments", "objects", refs[0]!.sha256), "corrupt");
      expect(() => restarted.resolveCampaign("campaign-attachment-replay")).toThrow(/integrity verification/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("enforces count, size, canonical-encoding, missing-object, and media-identity boundaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-attachments-"));
    try {
      const store = new TaskAttachmentStore(dir);
      const upload = { display_name: "screen.png", content_base64: PNG.toString("base64") };
      expect(() => store.capture(Array.from({ length: 5 }, () => upload), "cli")).toThrow(/limited to 4/);
      expect(() => store.capture([{ display_name: "empty.png", content_base64: "" }], "cli")).toThrow(/canonical base64/);
      expect(() => store.capture([{ display_name: "bad.png", content_base64: "a===" }], "cli")).toThrow(/canonical base64/);
      const oversized = Buffer.alloc(TASK_ATTACHMENT_MAX_BYTES + 1, 0xff);
      expect(() => store.capture([{ display_name: "large.jpg", content_base64: oversized.toString("base64") }], "cli")).toThrow(/limited to/);

      const refs = store.capture([upload], "cli");
      expect(store.capture([upload], "cli")[0]?.attachment_id).toBe(refs[0]?.attachment_id);
      expect(() => store.resolve(Array.from({ length: 5 }, () => refs[0]!))).toThrow(/count exceeds/);
      expect(() => store.resolve([{ ...refs[0]!, sha256: "0".repeat(64), attachment_id: `attachment:${"0".repeat(64)}` }])).toThrow(/is missing/);
      expect(() => store.resolve([{ ...refs[0]!, media_type: "image/jpeg" }])).toThrow(/media identity changed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("derives every provider-supported raster media type from bytes, not names", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-attachments-"));
    try {
      const store = new TaskAttachmentStore(dir);
      const refs = store.capture([
        { display_name: "a.bin", content_base64: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64") },
        { display_name: "b.bin", content_base64: Buffer.from("GIF89a0").toString("base64") },
        { display_name: "c.bin", content_base64: Buffer.from("RIFF0000WEBP").toString("base64") },
      ], "web");
      expect(refs.map((ref) => ref.media_type)).toEqual(["image/jpeg", "image/gif", "image/webp"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("captures bounded UTF-8 documents and rejects binary, invalid JSON, and oversize text", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-attachments-"));
    try {
      const store = new TaskAttachmentStore(dir);
      const refs = store.capture([{ display_name: "requirements.md", content_base64: Buffer.from("# Requirement\nDo the safe thing.\n").toString("base64") }, { display_name: "config.json", content_base64: Buffer.from('{"enabled":true}').toString("base64") }], "web");
      expect(refs.map((ref) => ref.media_type)).toEqual(["text/markdown", "application/json"]);
      expect(store.resolve(refs).map((artifact) => artifact.encoding)).toEqual(["utf8", "utf8"]);
      expect(() => store.capture([{ display_name: "bad.txt", content_base64: Buffer.from([0xff, 0xfe]).toString("base64") }], "cli")).toThrow(/valid UTF-8/);
      expect(() => store.capture([{ display_name: "bad.json", content_base64: Buffer.from("{bad").toString("base64") }], "cli")).toThrow(/valid JSON/);
      expect(() => store.capture([{ display_name: "large.md", content_base64: Buffer.alloc(TASK_DOCUMENT_MAX_BYTES + 1, 97).toString("base64") }], "cli")).toThrow(/text task attachment/);
      expect(() => store.capture([{ display_name: "payload.bin", content_base64: Buffer.from("plain text").toString("base64") }], "cli")).toThrow(/supported image or bounded text document/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
