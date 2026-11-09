/**
 * packages/arbor-mcp/src/project-registry-projection.ts — Roadmap 23,
 * TUI-facing catalog envelopes over the real ADR-076 project registry
 * (`project-registry.ts`) and its W6 management fold (`project-manage.ts`).
 *
 * Both `project.registry.list` and `project.manage` are modeled as QUERIES,
 * not commands: neither one writes `project-registry.json`.
 * `verifyRegistryEntry` recomputes discharge fresh on every call (path
 * existence, profile-hash drift, a real `project-conform.mjs` subprocess run)
 * without persisting anything, and `manageProjects` runs the real per-entry
 * gate battery and reports without mutating the registry either. This is the
 * same "a query that performs real work and reports, but stores nothing"
 * shape `harness.native.readiness` already uses for its own doctor probe —
 * so re-issuing `project.registry.list` (whole registry or one scoped
 * `project_id`) IS the "re-check this entry" operator action, and
 * `project.manage` IS the "trigger the reconcile pass" operator action.
 *
 * `buildProjectRegistryListProjection` intentionally re-derives a richer
 * shape than `formatProjectRegistryReport`'s own `ProjectRegistryReport`:
 * that report's `RegistryEntryVerification` only carries `ok`/`failures`,
 * losing the raw entry fields (`path`, `verified_at_revision`, `expires`,
 * ...) a registry SCREEN needs to render (revision, staleness) without
 * scraping them back out of a failure's free-text `detail` string. It calls
 * `loadProjectRegistry` + `verifyRegistryEntry` directly (the same discharge
 * function `evaluateProjectRegistry` itself calls) rather than reusing
 * `evaluateProjectRegistry`, so a real conformance subprocess is not run
 * twice per entry for one query.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadProjectRegistry,
  verifyRegistryEntry,
  PROJECT_REGISTRY_FILENAME,
  type RegistryEntryFailureCode,
} from "./project-registry.js";

export interface ProjectRegistryEntryProjection {
  readonly project_id: string;
  readonly path: string;
  readonly profile_hash: string;
  readonly verified_at_revision: string;
  readonly verified_at: string;
  readonly expires: string;
  readonly ok: boolean;
  readonly failures: readonly { readonly code: RegistryEntryFailureCode; readonly detail: string }[];
}

export interface ProjectRegistryListProjection {
  /** Whether `<persistenceDir>/project-registry.json` exists at all — a
   * fresh checkout with zero entries is not evidence of anything wrong; see
   * `ProjectRegistryReport.present`'s own doc comment (project-registry.ts). */
  readonly present: boolean;
  readonly entry_count: number;
  readonly ok: boolean;
  readonly entries: readonly ProjectRegistryEntryProjection[];
}

export function buildProjectRegistryListProjection(
  persistenceDir: string,
  options: { readonly project_id?: string; readonly now?: string } = {},
): ProjectRegistryListProjection {
  const present = existsSync(join(persistenceDir, PROJECT_REGISTRY_FILENAME));
  const registry = loadProjectRegistry(persistenceDir);
  const scoped = options.project_id === undefined
    ? registry.entries
    : registry.entries.filter((entry) => entry.project_id === options.project_id);
  const entries = scoped.map((entry) => {
    const verification = verifyRegistryEntry(entry, options.now === undefined ? {} : { now: options.now });
    return {
      project_id: entry.project_id,
      path: entry.path,
      profile_hash: entry.profile_hash,
      verified_at_revision: entry.verified_at_revision,
      verified_at: entry.verified_at,
      expires: entry.expires,
      ok: verification.ok,
      failures: verification.failures,
    };
  });
  return { present, entry_count: entries.length, ok: entries.every((entry) => entry.ok), entries };
}

export interface ProjectRegistryListQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "project.registry.list"; project_id?: string };
}

export function isProjectRegistryListQueryEnvelope(value: unknown): value is ProjectRegistryListQueryEnvelope {
  return typeof value === "object" && value !== null
    && typeof (value as { query?: unknown }).query === "object"
    && (value as { query: { kind?: unknown } }).query !== null
    && (value as { query: { kind?: unknown } }).query.kind === "project.registry.list";
}

export function validateProjectRegistryListQuery(envelope: ProjectRegistryListQueryEnvelope): string[] {
  const failures: string[] = [];
  if (envelope.schema_version !== 1) failures.push("schema_version must be 1");
  if (typeof envelope.query_id !== "string" || envelope.query_id.trim().length === 0) {
    failures.push("query_id must be non-empty");
  }
  const { project_id } = envelope.query;
  if (project_id !== undefined && (typeof project_id !== "string" || project_id.trim().length === 0)) {
    failures.push("query.project_id must be a non-empty string when supplied");
  }
  return failures;
}

export interface ProjectManageQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "project.manage" };
}

export function isProjectManageQueryEnvelope(value: unknown): value is ProjectManageQueryEnvelope {
  return typeof value === "object" && value !== null
    && typeof (value as { query?: unknown }).query === "object"
    && (value as { query: { kind?: unknown } }).query !== null
    && (value as { query: { kind?: unknown } }).query.kind === "project.manage";
}

export function validateProjectManageQuery(envelope: ProjectManageQueryEnvelope): string[] {
  const failures: string[] = [];
  if (envelope.schema_version !== 1) failures.push("schema_version must be 1");
  if (typeof envelope.query_id !== "string" || envelope.query_id.trim().length === 0) {
    failures.push("query_id must be non-empty");
  }
  return failures;
}
