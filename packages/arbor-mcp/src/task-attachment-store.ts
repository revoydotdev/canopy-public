import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeGovernedArtifact } from "@arbor/harness";
import type { TaskAttachmentRef, TaskAttachmentUpload, TaskComposerSource } from "./task-composer-contracts.js";

export const TASK_ATTACHMENT_MAX_COUNT = 4;
export const TASK_ATTACHMENT_MAX_BYTES = 5_242_880;
export const TASK_DOCUMENT_MAX_BYTES = 262_144;
export const TASK_ATTACHMENT_MAX_TOTAL_BYTES = TASK_ATTACHMENT_MAX_COUNT * TASK_ATTACHMENT_MAX_BYTES;
const IMAGE_MEDIA_TYPES = new Set<TaskAttachmentRef["media_type"]>(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const DOCUMENT_MEDIA_TYPES = new Set<TaskAttachmentRef["media_type"]>(["text/plain", "text/markdown", "application/json"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".xml", ".html", ".css", ".js", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".sh", ".sql", ".graphql", ".gql"]);

/** Immutable, content-addressed pre-campaign media. Drafts retain refs, never raw payloads. */
export class TaskAttachmentStore {
  private readonly objectsDir: string;
  private readonly campaignsDir: string;

  constructor(persistenceDir: string) {
    const root = join(persistenceDir, "task-attachments");
    this.objectsDir = join(root, "objects");
    this.campaignsDir = join(root, "campaigns");
    mkdirSync(this.objectsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.campaignsDir, { recursive: true, mode: 0o700 });
  }

  capture(uploads: readonly TaskAttachmentUpload[], source: TaskComposerSource): readonly TaskAttachmentRef[] {
    if (uploads.length > TASK_ATTACHMENT_MAX_COUNT) throw new Error(`task attachments are limited to ${TASK_ATTACHMENT_MAX_COUNT} files`);
    const decoded = uploads.map((upload) => ({ upload, bytes: decodeCanonicalBase64(upload.content_base64) }));
    if (decoded.some(({ bytes }) => bytes.byteLength > TASK_ATTACHMENT_MAX_BYTES)) throw new Error(`each task attachment is limited to ${TASK_ATTACHMENT_MAX_BYTES} bytes`);
    if (decoded.reduce((total, item) => total + item.bytes.byteLength, 0) > TASK_ATTACHMENT_MAX_TOTAL_BYTES) throw new Error(`task attachments exceed the ${TASK_ATTACHMENT_MAX_TOTAL_BYTES}-byte aggregate limit`);
    return Object.freeze(decoded.map(({ upload, bytes }) => {
      const mediaType = inspectTaskAttachment(upload.display_name, bytes);
      if (DOCUMENT_MEDIA_TYPES.has(mediaType) && bytes.byteLength > TASK_DOCUMENT_MAX_BYTES) throw new Error(`text task attachment ${upload.display_name} is limited to ${TASK_DOCUMENT_MAX_BYTES} bytes`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const objectPath = join(this.objectsDir, sha256);
      if (existsSync(objectPath)) verifyObject(objectPath, sha256, bytes.byteLength);
      else {
        const temporary = `${objectPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
          renameSync(temporary, objectPath);
        } finally { rmSync(temporary, { force: true }); }
      }
      return Object.freeze({
        attachment_id: `attachment:${sha256}`,
        sha256,
        media_type: mediaType,
        byte_length: bytes.byteLength,
        display_name: upload.display_name,
        provenance: Object.freeze({ tag: "claimed" as const, claimant: `operator:${source}` }),
      });
    }));
  }

  resolve(refs: readonly TaskAttachmentRef[]): readonly NativeGovernedArtifact[] {
    if (refs.length > TASK_ATTACHMENT_MAX_COUNT) throw new Error("persisted task attachment count exceeds the governed limit");
    return Object.freeze(refs.map((ref) => {
      const path = join(this.objectsDir, ref.sha256);
      verifyObject(path, ref.sha256, ref.byte_length);
      const bytes = readFileSync(path);
      const mediaType = inspectTaskAttachment(ref.display_name, bytes);
      if (mediaType !== ref.media_type) throw new Error(`task attachment ${ref.attachment_id} media identity changed`);
      return Object.freeze({ artifact_id: ref.attachment_id, media_type: ref.media_type, encoding: IMAGE_MEDIA_TYPES.has(ref.media_type) ? "base64" as const : "utf8" as const, content: IMAGE_MEDIA_TYPES.has(ref.media_type) ? bytes.toString("base64") : bytes.toString("utf8"), provenance: Object.freeze({ ...ref.provenance }) });
    }));
  }

  /**
   * Persist the exact references admitted for one campaign. The payload is
   * deliberately metadata-only: image bytes remain solely in the immutable,
   * content-addressed object store. A campaign cannot later replace its media.
   */
  bindCampaign(campaignId: string, refs: readonly TaskAttachmentRef[]): void {
    const normalized = normalizeRefs(refs);
    // Verify before admitting the reference manifest. This rejects a missing
    // or altered object before any later specialist can observe a downgrade.
    this.resolve(normalized);
    const path = this.campaignPath(campaignId);
    if (existsSync(path)) {
      const existing = this.readCampaignRecord(path, campaignId);
      if (JSON.stringify(existing) !== JSON.stringify(normalized)) throw new Error(`campaign ${campaignId} attachment references are immutable`);
      return;
    }
    const record = { schema_version: 1, campaign_id: campaignId, attachments: normalized };
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }

  /** Resolve the immutable campaign binding on every native dispatch/replay. */
  resolveCampaign(campaignId: string): readonly NativeGovernedArtifact[] {
    const path = this.campaignPath(campaignId);
    if (!existsSync(path)) return Object.freeze([]);
    return this.resolve(this.readCampaignRecord(path, campaignId));
  }

  private campaignPath(campaignId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(campaignId)) throw new Error("campaign attachment binding has an invalid campaign id");
    return join(this.campaignsDir, `${createHash("sha256").update(campaignId).digest("hex")}.json`);
  }

  private readCampaignRecord(path: string, campaignId: string): readonly TaskAttachmentRef[] {
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error(`campaign ${campaignId} attachment binding is corrupt`); }
    if (typeof value !== "object" || value === null) throw new Error(`campaign ${campaignId} attachment binding is corrupt`);
    const record = value as { schema_version?: unknown; campaign_id?: unknown; attachments?: unknown };
    if (record.schema_version !== 1 || record.campaign_id !== campaignId || !Array.isArray(record.attachments)) throw new Error(`campaign ${campaignId} attachment binding is corrupt`);
    try { return normalizeRefs(record.attachments as readonly TaskAttachmentRef[]); }
    catch { throw new Error(`campaign ${campaignId} attachment binding is corrupt`); }
  }
}

function normalizeRefs(refs: readonly TaskAttachmentRef[]): readonly TaskAttachmentRef[] {
  if (refs.length > TASK_ATTACHMENT_MAX_COUNT) throw new Error("persisted task attachment count exceeds the governed limit");
  return Object.freeze(refs.map((ref) => {
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.attachment_id !== `attachment:${ref.sha256}` || !Number.isSafeInteger(ref.byte_length) || ref.byte_length <= 0 || ref.byte_length > TASK_ATTACHMENT_MAX_BYTES || (!IMAGE_MEDIA_TYPES.has(ref.media_type) && !DOCUMENT_MEDIA_TYPES.has(ref.media_type)) || (DOCUMENT_MEDIA_TYPES.has(ref.media_type) && ref.byte_length > TASK_DOCUMENT_MAX_BYTES) || typeof ref.display_name !== "string" || ref.display_name.length === 0 || ref.display_name.length > 255 || ref.provenance.tag !== "claimed" || typeof ref.provenance.claimant !== "string" || ref.provenance.claimant.length === 0) throw new Error("invalid persisted task attachment reference");
    return Object.freeze({ attachment_id: ref.attachment_id, sha256: ref.sha256, media_type: ref.media_type, byte_length: ref.byte_length, display_name: ref.display_name, provenance: Object.freeze({ tag: "claimed" as const, claimant: ref.provenance.claimant }) });
  }));
}

function decodeCanonicalBase64(value: string): Buffer {
  if (value.length === 0 || value.length > Math.ceil(TASK_ATTACHMENT_MAX_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("task attachment content must be bounded canonical base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("task attachment content must be canonical base64");
  return bytes;
}

function verifyObject(path: string, sha256: string, byteLength: number): void {
  if (!existsSync(path)) throw new Error(`task attachment object ${sha256} is missing`);
  const bytes = readFileSync(path);
  if (bytes.byteLength !== byteLength || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`task attachment object ${sha256} failed integrity verification`);
}

function sniffImageMediaType(bytes: Buffer): TaskAttachmentRef["media_type"] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function inspectTaskAttachment(displayName: string, bytes: Buffer): TaskAttachmentRef["media_type"] {
  const image = sniffImageMediaType(bytes);
  if (image !== null) return image;
  const lower = displayName.toLowerCase();
  const extension = [...TEXT_EXTENSIONS].find((candidate) => lower.endsWith(candidate));
  if (extension === undefined) throw new Error(`task attachment ${displayName} is not a supported image or bounded text document`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`task attachment ${displayName} must contain valid UTF-8 text`); }
  if (/[^\t\n\r\x20-\x7e\u0080-\uffff]/u.test(text)) throw new Error(`task attachment ${displayName} contains binary control bytes`);
  if (extension === ".json") {
    try { JSON.parse(text); } catch { throw new Error(`task attachment ${displayName} must contain valid JSON`); }
    return "application/json";
  }
  return extension === ".md" || extension === ".markdown" ? "text/markdown" : "text/plain";
}
