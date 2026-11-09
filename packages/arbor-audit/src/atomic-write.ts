// arbor-audit — shared atomic-overwrite primitive for auxiliary ledger
// artifacts (D1's tip sentinel, D2's repair log's ledger-replace step).
//
// `saveLedger` in persist.ts already has its own append+fsync discipline for
// the ledger JSONL itself (never overwritten, only appended). The artifacts
// this file supports are different: the tip sentinel is a single small
// pointer that must be REPLACED wholesale every time the ledger grows, and a
// sanctioned repair legitimately replaces a campaign's ledger file outright.
// Both need the same crash-safe, concurrency-safe recipe: write to a
// uniquely-named temp file in the target directory, fsync it, atomically
// rename it onto the target path (POSIX rename is atomic — no reader ever
// observes a partially-written file), then fsync the directory entry so the
// rename itself is durable.
//
// This deliberately always overwrites. `OutputEvidenceStore`'s content-
// addressed blob store (output-evidence.ts's `atomicWrite`) instead treats
// "already exists" as done-and-idempotent, which is correct for immutable,
// content-addressed blobs but wrong here — both callers of this module need
// every write to actually land.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export function atomicOverwriteFile(path: string, contents: string | Uint8Array): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  const directoryDescriptor = openSync(directory, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}
