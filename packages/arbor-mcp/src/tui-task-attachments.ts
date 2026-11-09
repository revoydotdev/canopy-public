import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { inspectTaskAttachment, TASK_ATTACHMENT_MAX_BYTES, TASK_ATTACHMENT_MAX_COUNT, TASK_DOCUMENT_MAX_BYTES } from "./task-attachment-store.js";
import type { TaskAttachmentUpload } from "./task-composer-contracts.js";

/** MCP-owned boundary: path-only TUI effects become the existing upload payload. */
export function resolveTuiTaskAttachmentUploads(cwd: string, attachmentPaths: readonly string[]): readonly TaskAttachmentUpload[] {
  if (attachmentPaths.length > TASK_ATTACHMENT_MAX_COUNT) throw new Error(`task attachments are limited to ${TASK_ATTACHMENT_MAX_COUNT} files`);
  return attachmentPaths.map((path) => {
    if (!path.trim()) throw new Error("task attachment path must not be empty");
    const absolute = realpathSync(resolve(cwd, path));
    const fd = openSync(absolute, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= 0 || size > TASK_ATTACHMENT_MAX_BYTES) throw new Error(`task attachment ${path} must contain between 1 and ${TASK_ATTACHMENT_MAX_BYTES} bytes`);
      const bytes = readFileSync(fd);
      const mediaType = inspectTaskAttachment(path, bytes);
      if (!mediaType.startsWith("image/") && size > TASK_DOCUMENT_MAX_BYTES) throw new Error(`text attachment ${path} exceeds ${TASK_DOCUMENT_MAX_BYTES} bytes`);
      return Object.freeze({ display_name: basename(absolute), content_base64: bytes.toString("base64") });
    } finally { closeSync(fd); }
  });
}
