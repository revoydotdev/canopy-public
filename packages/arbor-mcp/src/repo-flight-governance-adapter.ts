import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { GovernanceAdmissionTrustState } from "@arbor/governance";
import { loadRepoFlightGovernanceIssuerConfiguration, loadRepoFlightGovernanceTrustFile, parseRepoFlightGovernanceIssuerResponse } from "./repo-flight-governance-codec.js";

export const REPO_FLIGHT_GOVERNANCE_TRUST_ENV = "ARBOR_REPO_FLIGHT_GOVERNANCE_TRUST";
export const REPO_FLIGHT_GOVERNANCE_ISSUER_ENV = "ARBOR_REPO_FLIGHT_GOVERNANCE_ISSUER";

export interface RepoFlightGovernanceIssuerClient {
  readonly issue: (plannedRun: unknown) => Promise<unknown>;
}

/** Load public verification state only; issuer private material is rejected by the closed schema. */
export function loadRepoFlightGovernanceTrustState(path: string): GovernanceAdmissionTrustState {
  return loadRepoFlightGovernanceTrustFile(path);
}

/** Invoke a governance-owned executable over bounded JSON stdio; no shell and no private key enters Flight. */
export function createRepoFlightGovernanceIssuerClient(path: string, now: () => Date = () => new Date()): RepoFlightGovernanceIssuerClient {
  const configuration = loadRepoFlightGovernanceIssuerConfiguration(path);
  const [executable, ...argv] = configuration.command_argv;
  return Object.freeze({ issue: async (plannedRun: unknown): Promise<unknown> => {
    const observed = now();
    if (!Number.isFinite(observed.getTime())) throw new Error("Flight governance issuer clock is invalid");
    const result = spawnSync(executable!, argv, { input: `${JSON.stringify({ schema_version: 1, kind: "revoy2.governance_admission.request", requested_at: observed.toISOString(), planned_run: plannedRun })}\n`, encoding: "utf8", timeout: configuration.timeout_ms, maxBuffer: 1024 * 1024, shell: false, windowsHide: true });
    if (result.error) throw new Error(`external governance issuer failed: ${result.error.message.slice(0, 512)}`);
    if (result.status !== 0) throw new Error(`external governance issuer refused admission with exit ${result.status ?? "unknown"}`);
    return parseRepoFlightGovernanceIssuerResponse(result.stdout);
  } });
}

export function repoFlightGovernanceFromEnvironment(env: Readonly<Record<string, string | undefined>>): { readonly trust: () => GovernanceAdmissionTrustState; readonly issuer: RepoFlightGovernanceIssuerClient } | null {
  const trustPath = env[REPO_FLIGHT_GOVERNANCE_TRUST_ENV]?.trim();
  const issuerPath = env[REPO_FLIGHT_GOVERNANCE_ISSUER_ENV]?.trim();
  if (!trustPath && !issuerPath) return null;
  if (!trustPath || !issuerPath) throw new Error(`both ${REPO_FLIGHT_GOVERNANCE_TRUST_ENV} and ${REPO_FLIGHT_GOVERNANCE_ISSUER_ENV} are required`);
  const resolvedTrust = resolve(trustPath), resolvedIssuer = resolve(issuerPath);
  return Object.freeze({ trust: () => loadRepoFlightGovernanceTrustState(resolvedTrust), issuer: createRepoFlightGovernanceIssuerClient(resolvedIssuer) });
}
