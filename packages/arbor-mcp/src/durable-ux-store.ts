import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const UX_MAX_ID = 128;
export function uxText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
export function uxId(value: unknown): value is string { return uxText(value, UX_MAX_ID) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value !== "." && value !== ".."; }
export function uxHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function uxClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function readUxStore<T>(path: string | null, fallback: T, valid: (value: unknown) => value is T): T { if (path === null || !existsSync(path)) return fallback; try { const parsed = JSON.parse(readFileSync(path, "utf8")); return valid(parsed) ? parsed : fallback; } catch { return fallback; } }
export function writeUxStore(path: string | null, value: unknown): void { if (path === null) return; mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(temporary, path); }
/** Never let a durable operator inbox become a secret/transcript store. */
export function redactUxText(value: string, max = 2_048): string { return value.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu, "$1=[redacted]").replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ").slice(0, max); }
