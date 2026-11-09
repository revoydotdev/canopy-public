import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_ATTACHMENT_MAX_BYTES } from "../src/task-attachment-store.js";
import { resolveTuiTaskAttachmentUploads } from "../src/tui-task-attachments.js";

describe("TUI task attachment bridge", () => {
  it("creates the canonical upload payload from supported image paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-tui-attachments-"));
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
      const gif = Buffer.from("GIF89a\0", "binary");
      const gif87 = Buffer.from("GIF87a\0", "binary");
      const webp = Buffer.from("RIFF\0\0\0\0WEBP", "binary");
      writeFileSync(join(dir, "screen.png"), png);
      writeFileSync(join(dir, "photo.jpg"), jpeg);
      writeFileSync(join(dir, "motion.gif"), gif);
      writeFileSync(join(dir, "capture.webp"), webp);
      expect(resolveTuiTaskAttachmentUploads(dir, ["screen.png", "photo.jpg", "motion.gif", "capture.webp"])).toEqual([
        { display_name: "screen.png", content_base64: png.toString("base64") },
        { display_name: "photo.jpg", content_base64: jpeg.toString("base64") },
        { display_name: "motion.gif", content_base64: gif.toString("base64") },
        { display_name: "capture.webp", content_base64: webp.toString("base64") },
      ]);
      writeFileSync(join(dir, "legacy.gif"), gif87);
      expect(resolveTuiTaskAttachmentUploads(dir, ["legacy.gif"])).toEqual([
        { display_name: "legacy.gif", content_base64: gif87.toString("base64") },
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects count, size, and unsupported-media violations before dispatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-tui-attachments-"));
    try {
      writeFileSync(join(dir, "bad.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
      writeFileSync(join(dir, "short.bin"), Buffer.from([0x01]));
      writeFileSync(join(dir, "riff.bin"), Buffer.from("RIFF\0\0\0\0NOPE", "binary"));
      writeFileSync(join(dir, "empty.png"), "");
      writeFileSync(join(dir, "large.png"), Buffer.alloc(TASK_ATTACHMENT_MAX_BYTES + 1, 0));
      expect(() => resolveTuiTaskAttachmentUploads(dir, ["   "])).toThrow(/must not be empty/);
      expect(() => resolveTuiTaskAttachmentUploads(dir, ["empty.png"])).toThrow(/between 1 and/);
      expect(() => resolveTuiTaskAttachmentUploads(dir, ["short.bin"])).toThrow(/supported image or bounded text document/);
      expect(() => resolveTuiTaskAttachmentUploads(dir, ["riff.bin"])).toThrow(/supported image or bounded text document/);
      expect(() => resolveTuiTaskAttachmentUploads(dir, ["bad.txt"])).toThrow(/valid UTF-8/);
      expect(() => resolveTuiTaskAttachmentUploads(dir, ["large.png"])).toThrow(/between 1 and/);
      expect(() => resolveTuiTaskAttachmentUploads(dir, ["a.png", "b.png", "c.png", "d.png", "e.png"])).toThrow(/limited to 4/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
