import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRepoFlightGovernanceIssuerClient, loadRepoFlightGovernanceTrustState, repoFlightGovernanceFromEnvironment, REPO_FLIGHT_GOVERNANCE_ISSUER_ENV, REPO_FLIGHT_GOVERNANCE_TRUST_ENV } from "../src/repo-flight-governance-adapter.js";

const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

describe("external repository Flight governance adapter", () => {
  it("loads only public Ed25519 trust state and invokes a bounded no-shell issuer", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-flight-governance-adapter-"));
    const keys = generateKeyPairSync("ed25519");
    const trustPath = join(root, "trust.json"), issuerPath = join(root, "issuer.json");
    writeFileSync(trustPath, JSON.stringify({ schema_version: 1, trust_root_ref: "trust:1", separation_policy_version: "separation:1", separation_policy_digest: sha("a"), revocation_epoch: 2, revoked_key_ids: ["key:old"], public_keys: [{ key_id: "key:current", public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }] }));
    writeFileSync(issuerPath, JSON.stringify({ schema_version: 1, command_argv: [process.execPath, "-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({attestation_for:JSON.parse(s).planned_run.repo_run_id})))"], timeout_ms: 5_000 }));
    expect(loadRepoFlightGovernanceTrustState(trustPath)).toMatchObject({ trust_root_ref: "trust:1", revocation_epoch: 2 });
    expect(await createRepoFlightGovernanceIssuerClient(issuerPath, () => new Date("2026-08-28T12:00:00.000Z")).issue({ repo_run_id: "run:one" })).toEqual({ attestation_for: "run:one" });
    const composed = repoFlightGovernanceFromEnvironment({ [REPO_FLIGHT_GOVERNANCE_TRUST_ENV]: trustPath, [REPO_FLIGHT_GOVERNANCE_ISSUER_ENV]: issuerPath });
    expect(composed?.trust()).toMatchObject({ trust_root_ref: "trust:1" });
  });

  it("fails closed for partial configuration, private-key-shaped fields, and issuer failure", async () => {
    expect(() => repoFlightGovernanceFromEnvironment({ [REPO_FLIGHT_GOVERNANCE_TRUST_ENV]: "/missing" })).toThrow(/both/);
    const root = mkdtempSync(join(tmpdir(), "repo-flight-governance-adapter-"));
    const malformed = join(root, "malformed.json"), issuer = join(root, "issuer.json");
    writeFileSync(malformed, JSON.stringify({ schema_version: 1, private_key: "forbidden" }));
    expect(() => loadRepoFlightGovernanceTrustState(malformed)).toThrow(/closed schema/);
    writeFileSync(issuer, JSON.stringify({ schema_version: 1, command_argv: [process.execPath, "-e", "process.exit(7)"], timeout_ms: 5_000 }));
    await expect(createRepoFlightGovernanceIssuerClient(issuer).issue({ repo_run_id: "run:one" })).rejects.toThrow(/exit 7/);
  });
});
