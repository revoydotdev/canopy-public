import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { PersistenceDiagnostic, PersistenceDiagnosticCode, PersistenceLoadResult } from "./persist.js";

export interface BoulderState {
  active_plan: string;
  active_campaign: string;
  session_ids: string[];
  started_at: string;
  plan_name: string;
}

function quarantine(path: string, dir: string, artifact: PersistenceDiagnostic["artifact"], code: PersistenceDiagnosticCode, message: string): PersistenceDiagnostic {
  const quarantineDir = join(dir, "quarantine");
  let diagnostic: PersistenceDiagnostic = { artifact, code, path, message };
  try {
    mkdirSync(quarantineDir, { recursive: true });
    const stem = `${basename(path)}.${new Date().toISOString().replace(/[:.]/g, "-")}.${process.pid}`;
    let destination = join(quarantineDir, `${stem}.corrupt`);
    let suffix = 1;
    while (existsSync(destination)) destination = join(quarantineDir, `${stem}.${suffix++}.corrupt`);
    renameSync(path, destination);
    diagnostic = { ...diagnostic, quarantined_path: destination };
  } catch (error) {
    diagnostic = {
      artifact,
      code: "quarantine_failed",
      path,
      message: `${message}; quarantine failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return diagnostic;
}

function validateBoulder(value: unknown): BoulderState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("boulder must be a JSON object");
  const boulder = value as Record<string, unknown>;
  if (typeof boulder.active_plan !== "string" || typeof boulder.active_campaign !== "string"
    || typeof boulder.started_at !== "string" || typeof boulder.plan_name !== "string"
    || !Array.isArray(boulder.session_ids) || !boulder.session_ids.every((id) => typeof id === "string")) {
    throw new Error("boulder is missing required fields");
  }
  return boulder as unknown as BoulderState;
}

/** Preserve abandoned pointer writes as evidence; never delete them during recovery. */
export function reconcileBoulderTemporaryFiles(dir: string): PersistenceDiagnostic[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.startsWith(".boulder.") && file.endsWith(".tmp"))
    .map((file) => quarantine(join(dir, file), dir, "temporary_file", "invalid_shape", "abandoned boulder write temporary file"));
}

export function writeBoulder(dir: string, boulder: BoulderState): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "boulder.json");
  const temporary = join(dir, `.boulder.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(boulder, null, 2));
  renameSync(temporary, target);
}

export function readBoulderResult(dir: string): PersistenceLoadResult<BoulderState> {
  const filePath = join(dir, "boulder.json");
  const diagnostics = reconcileBoulderTemporaryFiles(dir);
  if (!existsSync(filePath)) return { value: null, diagnostics };
  try {
    return { value: validateBoulder(JSON.parse(readFileSync(filePath, "utf-8")) as unknown), diagnostics };
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    diagnostics.push(quarantine(filePath, dir, "boulder", syntax ? "invalid_json" : "invalid_shape", syntax
      ? "boulder is not valid JSON"
      : `boulder failed validation: ${error instanceof Error ? error.message : String(error)}`));
    return { value: null, diagnostics };
  }
}
