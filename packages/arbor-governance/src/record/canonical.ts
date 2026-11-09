/**
 * canonical.ts — the canonical hashable form of a CanonicalRecord.
 *
 * `canonicalizeForHash` (from `@arbor/core`) is the ONLY canonical
 * serializer in this repository (see its own header comment on the four
 * divergent implementations it replaced). This module adds no second one —
 * it only decides *which fields* of a record are "content" for hashing
 * purposes, then hands the resulting plain object to `canonicalizeForHash`.
 *
 * CRITICAL field split (mission-specified):
 *   - EXCLUDED: `implementation`, `verification`, `compliance` — the three
 *     COMPUTED StatusVector fields (status.ts). A status flip alone (e.g. a
 *     new test making `verification` go from "unverified" to "verified")
 *     must NOT change a record's content identity.
 *   - INCLUDED: `decision` — an actual decision-status change (e.g.
 *     accepted -> superseded) is a real content change and must change the
 *     hash.
 *   - ALSO EXCLUDED: `source_path` and `source_content_hash`. Both are
 *     provenance/location metadata about *how this record was read*, not
 *     part of its semantic content — including them would make the "same
 *     content, re-saved under a different byte-identical-content path"
 *     case (or the round-trip test's synthesized record, which has no real
 *     `source_path`) spuriously change hash, and would make the round-trip
 *     property ("parse -> canonical form -> parse again yields an equal
 *     record") unprovable, since regenerated markdown never reproduces the
 *     original byte-for-byte source hash.
 *   - ALSO EXCLUDED: `parse_warnings` — an artifact of how parsing went,
 *     not of what the record says.
 */

import { createHash } from "node:crypto";
import { canonicalizeForHash } from "@arbor/core";
import type { CanonicalRecord } from "./schema.js";

/** The subset of a CanonicalRecord that participates in content identity. */
export interface HashableRecordView {
  readonly schema_version: 1;
  readonly record_class: string;
  readonly id: string;
  readonly record_number: number;
  readonly title: string;
  readonly decision: string;
  readonly authored_date: CanonicalRecord["authored_date"];
  readonly accepted_date: CanonicalRecord["accepted_date"];
  readonly authors: CanonicalRecord["authors"];
  readonly sections: CanonicalRecord["sections"];
  readonly obligations: readonly string[];
  readonly amendments: CanonicalRecord["amendments"];
}

/** Projects a CanonicalRecord down to its content-identity view. Pure, no I/O. */
export function canonicalRecordView(record: CanonicalRecord): HashableRecordView {
  return {
    schema_version: record.schema_version,
    record_class: record.record_class,
    id: record.id,
    record_number: record.record_number,
    title: record.title,
    decision: record.status.decision,
    authored_date: record.authored_date,
    accepted_date: record.accepted_date,
    authors: record.authors,
    sections: record.sections,
    obligations: record.obligations,
    amendments: record.amendments,
  };
}

/** sha256 hex digest of a byte/text payload, following this repo's existing hash-packet convention (arbor-audit/src/audit.ts's hashPacket). */
export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * The record's content-identity hash: sha256 of `canonicalizeForHash` applied
 * to `canonicalRecordView(record)`. Stable across repeated calls on the same
 * record; unchanged when only a computed status field differs; changed when
 * `decision` or any section text changes.
 */
export function recordContentHash(record: CanonicalRecord): string {
  return sha256Hex(canonicalizeForHash(canonicalRecordView(record)));
}
