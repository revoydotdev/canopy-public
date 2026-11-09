import { createPublicKey } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GovernanceAdmissionTrustState } from "@arbor/governance";

export interface RepoFlightGovernanceIssuerConfiguration { readonly command_argv: readonly string[]; readonly timeout_ms: number }

export function loadRepoFlightGovernanceTrustFile(path: string): GovernanceAdmissionTrustState {
  const value = readJsonFile(path, 1024 * 1024);
  if (!exact(value, ["schema_version", "trust_root_ref", "separation_policy_version", "separation_policy_digest", "revocation_epoch", "revoked_key_ids", "public_keys"]) || value.schema_version !== 1 || !identifier(value.trust_root_ref) || !identifier(value.separation_policy_version) || !digest(value.separation_policy_digest) || !Number.isSafeInteger(value.revocation_epoch) || (value.revocation_epoch as number) < 0 || !Array.isArray(value.revoked_key_ids) || !Array.isArray(value.public_keys)) throw new Error("Flight governance trust file has an invalid closed schema");
  const revoked = value.revoked_key_ids;
  if (revoked.some((item) => !identifier(item)) || new Set(revoked).size !== revoked.length) throw new Error("Flight governance revoked-key set is invalid");
  const publicKeys = new Map<string, string>();
  for (const item of value.public_keys) {
    if (!exact(item, ["key_id", "public_key_pem"]) || !identifier(item.key_id) || typeof item.public_key_pem !== "string" || Buffer.byteLength(item.public_key_pem) > 16 * 1024) throw new Error("Flight governance public-key entry is invalid");
    if (publicKeys.has(item.key_id)) throw new Error("Flight governance trust file repeats a key id");
    const key = createPublicKey(item.public_key_pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Flight governance trust keys must be Ed25519");
    publicKeys.set(item.key_id, item.public_key_pem);
  }
  if (publicKeys.size === 0) throw new Error("Flight governance trust file has no public keys");
  return Object.freeze({ trust_root_ref: value.trust_root_ref, separation_policy_version: value.separation_policy_version, separation_policy_digest: value.separation_policy_digest, revocation_epoch: value.revocation_epoch as number, revoked_key_ids: new Set(revoked as string[]), public_keys: publicKeys });
}

export function loadRepoFlightGovernanceIssuerConfiguration(path: string): RepoFlightGovernanceIssuerConfiguration {
  const value = readJsonFile(path, 64 * 1024);
  if (!exact(value, ["schema_version", "command_argv", "timeout_ms"]) || value.schema_version !== 1 || !Array.isArray(value.command_argv) || value.command_argv.length < 1 || value.command_argv.length > 32 || value.command_argv.some((item) => typeof item !== "string" || item.length === 0 || Buffer.byteLength(item) > 4096 || item.includes("\0")) || !Number.isSafeInteger(value.timeout_ms) || (value.timeout_ms as number) < 100 || (value.timeout_ms as number) > 300_000) throw new Error("Flight governance issuer config has an invalid closed schema");
  return Object.freeze({ command_argv: Object.freeze(value.command_argv as string[]), timeout_ms: value.timeout_ms as number });
}

export function parseRepoFlightGovernanceIssuerResponse(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new Error("external governance issuer returned malformed JSON"); }
}

function readJsonFile(path: string, maxBytes: number): unknown { const resolved = resolve(path), stat = lstatSync(resolved); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Flight governance configuration must be a bounded regular file"); return JSON.parse(readFileSync(resolved, "utf8")); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(value); }
function digest(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
