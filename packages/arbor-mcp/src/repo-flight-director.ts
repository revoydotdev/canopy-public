import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RepoFlightController, type RepoFlightDeploymentProbe } from "./repo-flight-controller.js";
import { REPO_FLIGHT_PROVIDERS, type RepoFlightProfileProvider } from "./repo-flight-profile.js";
import { RepoFlightClient, RepoFlightTransportServer, repoFlightTransportSocketPath } from "./repo-flight-transport.js";
import type { GovernanceAdmissionTrustState } from "@arbor/governance";
import type { RepoFlightValidationTrustRoots } from "./repo-flight-validation-cache.js";

export const REPO_FLIGHT_POLICY_VERSION = "repo-flight-policy-v1";

export interface RepoFlightDirectorPaths {
  readonly root: string;
  readonly signing_secret: string;
  readonly socket: string;
  readonly operator_credential: string;
  readonly owner_process: string;
}

export function repoFlightDirectorPaths(persistenceDir: string): RepoFlightDirectorPaths {
  const root = join(resolve(persistenceDir), "repo-flight");
  const transport = join(root, "repo-flight-transport");
  return Object.freeze({ root, signing_secret: join(root, "director.signing-secret"), socket: repoFlightTransportSocketPath(root), operator_credential: join(transport, "operator.credential.json"), owner_process: join(root, "director.owner.json") });
}

export interface RepoFlightDirectorOptions {
  readonly repository_root: string;
  readonly persistence_dir: string;
  readonly required_providers?: readonly RepoFlightProfileProvider[];
  readonly deployment?: Partial<RepoFlightDeploymentProbe>;
  readonly policy_version?: string;
  readonly now?: () => Date;
  readonly governance_trust?: () => GovernanceAdmissionTrustState;
  readonly execution_profile?: unknown;
  readonly execution_plan_trust?: ReadonlyMap<string, string>;
  readonly validation_trust_roots?: RepoFlightValidationTrustRoots;
}

/** Owns the only writable repo-local authority and its authenticated UDS. */
export class RepoFlightDirector {
  readonly paths: RepoFlightDirectorPaths;
  readonly controller: RepoFlightController;
  readonly transport: RepoFlightTransportServer;
  private closed = false;

  constructor(options: RepoFlightDirectorOptions) {
    this.paths = repoFlightDirectorPaths(options.persistence_dir);
    mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    chmodSync(this.paths.root, 0o700);
    const signingSecret = loadOrCreateSecret(this.paths.signing_secret);
    const required = options.required_providers ?? REPO_FLIGHT_PROVIDERS;
    const deployment: RepoFlightDeploymentProbe = {
      canonical_shared_checkout: options.deployment?.canonical_shared_checkout ?? "advisory",
      unmanaged_sessions_present: options.deployment?.unmanaged_sessions_present ?? true,
      raw_shell_mutation_interceptor: options.deployment?.raw_shell_mutation_interceptor ?? false,
      effect_interceptor: options.deployment?.effect_interceptor ?? false,
      adoption_fencing: options.deployment?.adoption_fencing ?? false,
      ...(options.deployment?.providers === undefined ? {} : { providers: options.deployment.providers }),
      ...(options.deployment?.federation === undefined ? {} : { federation: options.deployment.federation }),
    };
    let controller: RepoFlightController | null = null;
    try {
      controller = new RepoFlightController({ repository_root: options.repository_root, persistence_dir: this.paths.root, policy_version: options.policy_version ?? REPO_FLIGHT_POLICY_VERSION, signing_secret: signingSecret, required_providers: required, deployment, ...(options.now === undefined ? {} : { now: options.now }), ...(options.governance_trust === undefined ? {} : { governance_trust: options.governance_trust }), ...(options.execution_profile === undefined ? {} : { execution_profile: options.execution_profile }), ...(options.execution_plan_trust === undefined ? {} : { execution_plan_trust: options.execution_plan_trust }), ...(options.validation_trust_roots === undefined ? {} : { validation_trust_roots: options.validation_trust_roots }) });
      this.controller = controller;
      this.transport = new RepoFlightTransportServer({ persistence_dir: this.paths.root, operator: controller.operator, authenticated_operator_actor: controller.director_instance_id, agent_credential_binding: (instanceId) => controller!.agentCredentialBinding(instanceId), ...(options.now === undefined ? {} : { now: options.now }) });
    } catch (error) {
      try { controller?.close(); } catch { /* preserve the construction failure */ }
      throw error;
    }
  }

  async start(): Promise<string> { return this.transport.start(); }

  client(): RepoFlightClient {
    return new RepoFlightClient({ socket_path: this.paths.socket, credential_path: this.paths.operator_credential });
  }

  /** Issue a short-lived client only after enrollment and current-warrant checks. */
  provisionAgentClient(instanceId: string): RepoFlightClient {
    const credentialPath = this.transport.provisionAgentCredential(instanceId);
    return new RepoFlightClient({ socket_path: this.paths.socket, credential_path: credentialPath });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.transport.close();
    this.controller.close();
  }
}

export function createRepoFlightOperatorClient(persistenceDir: string, timeoutMs = 5_000): RepoFlightClient {
  const paths = repoFlightDirectorPaths(persistenceDir);
  return new RepoFlightClient({ socket_path: paths.socket, credential_path: paths.operator_credential, timeout_ms: timeoutMs });
}

function loadOrCreateSecret(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, `${randomBytes(48).toString("base64url")}\n`, "utf8");
      fsyncSync(descriptor);
    } catch (error) {
      if (!existsSync(path)) throw error;
    } finally { if (descriptor !== null) closeSync(descriptor); }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("repo-flight signing secret must be a private regular file");
  chmodSync(path, 0o600);
  const value = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{64}$/.test(value)) throw new Error("repo-flight signing secret is malformed");
  return value;
}
