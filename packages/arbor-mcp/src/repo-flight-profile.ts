import { createHash } from "node:crypto";

const REPO_FLIGHT_PROFILE_SCHEMA_VERSION = 1 as const;
export const REPO_FLIGHT_PROVIDERS = ["claude", "codex", "opencode", "native"] as const;

export type RepoFlightProfileStatus = "enforced" | "cooperative" | "observed_only" | "degraded";
export type RepoFlightProfileProvider = (typeof REPO_FLIGHT_PROVIDERS)[number];
export type RepoFlightCheckoutProtection = "mechanical_read_only" | "advisory" | "none";

export interface RepoFlightProviderInterceptorFacts {
  readonly launch_interceptor: boolean;
  readonly identity_enrollment: boolean;
  readonly mutation_interceptor: boolean;
}

export interface RepoFlightStoreFacts {
  readonly authority: boolean;
  readonly enrollment: boolean;
  readonly lifecycle: boolean;
}

export interface RepoFlightControlFacts {
  readonly stores: RepoFlightStoreFacts;
  readonly canonical_shared_checkout: RepoFlightCheckoutProtection;
  readonly unmanaged_sessions_present: boolean;
  readonly raw_shell_mutation_interceptor: boolean;
  readonly gate_broker: boolean;
  readonly effect_interceptor: boolean;
  readonly approval_closure: boolean;
  readonly a2a_receipt_adapter: boolean;
  readonly adoption_fencing: boolean;
}

export interface RepoFlightFederationFacts {
  readonly enabled: boolean;
  readonly authenticated: boolean;
  readonly fenced: boolean;
}

export interface RepoFlightProfileInput {
  readonly schema_version: typeof REPO_FLIGHT_PROFILE_SCHEMA_VERSION;
  readonly repository_id: `repo:v1:${string}`;
  readonly required_providers: readonly RepoFlightProfileProvider[];
  readonly providers: Readonly<Record<RepoFlightProfileProvider, RepoFlightProviderInterceptorFacts>>;
  readonly controls: RepoFlightControlFacts;
  readonly federation?: RepoFlightFederationFacts;
}

export interface RepoFlightMissingControl {
  readonly control: string;
  readonly remediation: string;
}

export interface RepoFlightProviderCoverage extends RepoFlightProviderInterceptorFacts {
  readonly provider: RepoFlightProfileProvider;
  readonly required: boolean;
  readonly fully_intercepted: boolean;
}

export interface RepoFlightProfile {
  readonly schema_version: typeof REPO_FLIGHT_PROFILE_SCHEMA_VERSION;
  readonly repository_id: `repo:v1:${string}`;
  readonly status: RepoFlightProfileStatus;
  readonly profile_digest: `sha256:${string}`;
  readonly required_providers: readonly RepoFlightProfileProvider[];
  readonly provider_coverage: readonly RepoFlightProviderCoverage[];
  readonly controls: RepoFlightControlFacts;
  readonly federation: RepoFlightFederationFacts;
  readonly missing_controls: readonly RepoFlightMissingControl[];
}

const REMEDIATIONS: Readonly<Record<string, string>> = Object.freeze({
  "store.authority": "Configure the durable repository authority store.",
  "store.enrollment": "Configure the durable process-enrollment store.",
  "store.lifecycle": "Configure the durable repo-run lifecycle store.",
  "checkout.shared_read_only": "Mechanically make the canonical shared checkout read-only to governed workers.",
  "session.unmanaged": "Enroll, drain, or terminate every unmanaged repository-writing session.",
  "shell.raw_mutation_interceptor": "Route raw-shell repository mutations through an enforcing interceptor.",
  "gate.broker": "Configure the gate broker for snapshot and quiescent verification.",
  "effect.interceptor": "Install commit-time interception and state revalidation for protected effects.",
  "approval.closure": "Bind approvals to the candidate, policy revision, actor, and current effect.",
  "a2a.receipt_adapter": "Configure durable delivery, acknowledgement, and applied-action receipts.",
  "adoption.fencing": "Require the current adoption fence at result publication and integration.",
  "federation.authenticated": "Authenticate every enabled federation peer and delegation chain.",
  "federation.fenced": "Require repository-local fencing for every federated effect.",
});

/**
 * Derive deployment truth solely from closed control facts. This function does
 * not accept a desired/caller-supplied status and rejects unknown fields.
 */
export function evaluateRepoFlightProfile(value: unknown): RepoFlightProfile {
  const input = validateProfileInput(value);
  const missing = new Map<string, RepoFlightMissingControl>();
  const add = (control: string, remediation = REMEDIATIONS[control]): void => {
    if (!remediation) throw new Error(`no remediation is registered for ${control}`);
    missing.set(control, Object.freeze({ control, remediation }));
  };

  if (!input.controls.stores.authority) add("store.authority");
  if (!input.controls.stores.enrollment) add("store.enrollment");
  if (!input.controls.stores.lifecycle) add("store.lifecycle");
  if (input.controls.canonical_shared_checkout !== "mechanical_read_only") add("checkout.shared_read_only");
  if (input.controls.unmanaged_sessions_present) add("session.unmanaged");
  if (!input.controls.raw_shell_mutation_interceptor) add("shell.raw_mutation_interceptor");
  if (!input.controls.gate_broker) add("gate.broker");
  if (!input.controls.effect_interceptor) add("effect.interceptor");
  if (!input.controls.approval_closure) add("approval.closure");
  if (!input.controls.a2a_receipt_adapter) add("a2a.receipt_adapter");
  if (!input.controls.adoption_fencing) add("adoption.fencing");
  if (input.federation.enabled && !input.federation.authenticated) add("federation.authenticated");
  if (input.federation.enabled && !input.federation.fenced) add("federation.fenced");

  const required = new Set(input.required_providers);
  const coverage = REPO_FLIGHT_PROVIDERS.map((provider): RepoFlightProviderCoverage => {
    const facts = input.providers[provider], isRequired = required.has(provider);
    if (isRequired && !facts.launch_interceptor) add(`provider.${provider}.launch`, `Install the ${provider} launch admission interceptor.`);
    if (isRequired && !facts.identity_enrollment) add(`provider.${provider}.enrollment`, `Bind every ${provider} process to durable identity enrollment.`);
    if (isRequired && !facts.mutation_interceptor) add(`provider.${provider}.mutation`, `Route every ${provider} repository mutation through the effect interceptor.`);
    return Object.freeze({ provider, required: isRequired, ...facts, fully_intercepted: facts.launch_interceptor && facts.identity_enrollment && facts.mutation_interceptor });
  });

  const missingControls = Object.freeze([...missing.values()].sort((a, b) => a.control.localeCompare(b.control)));
  const observationCore = input.controls.stores.authority && input.controls.stores.enrollment && input.controls.stores.lifecycle && input.controls.a2a_receipt_adapter;
  const admissionCore = input.required_providers.every((provider) => input.providers[provider].launch_interceptor && input.providers[provider].identity_enrollment);
  const federationHealthy = !input.federation.enabled || (input.federation.authenticated && input.federation.fenced);
  const status: RepoFlightProfileStatus = missingControls.length === 0
    ? "enforced"
    : !observationCore || !federationHealthy
      ? "degraded"
      : admissionCore
        ? "cooperative"
        : "observed_only";
  const digestInput = { schema_version: 1, repository_id: input.repository_id, required_providers: input.required_providers, providers: input.providers, controls: input.controls, federation: input.federation };
  return Object.freeze({ schema_version: 1, repository_id: input.repository_id, status, profile_digest: `sha256:${sha256(canonicalJson(digestInput))}`, required_providers: input.required_providers, provider_coverage: Object.freeze(coverage), controls: input.controls, federation: input.federation, missing_controls: missingControls });
}

function validateProfileInput(value: unknown): Required<RepoFlightProfileInput> {
  const input = exactRecord(value, ["schema_version", "repository_id", "required_providers", "providers", "controls"], ["federation"], "flight profile input");
  if (input.schema_version !== 1 || typeof input.repository_id !== "string" || !/^repo:v1:[a-f0-9]{64}$/.test(input.repository_id)) throw new Error("flight profile schema or repository identity is malformed");
  if (!Array.isArray(input.required_providers) || input.required_providers.length < 1 || input.required_providers.length > REPO_FLIGHT_PROVIDERS.length || input.required_providers.some((provider) => typeof provider !== "string" || !(REPO_FLIGHT_PROVIDERS as readonly string[]).includes(provider)) || new Set(input.required_providers).size !== input.required_providers.length) throw new Error("required_providers must be a unique, nonempty subset of the closed provider vocabulary");
  const providersRaw = exactRecord(input.providers, [...REPO_FLIGHT_PROVIDERS], [], "provider interceptor facts");
  const providers = Object.fromEntries(REPO_FLIGHT_PROVIDERS.map((provider) => [provider, providerFacts(providersRaw[provider], provider)])) as unknown as Record<RepoFlightProfileProvider, RepoFlightProviderInterceptorFacts>;
  const controlsRaw = exactRecord(input.controls, ["stores", "canonical_shared_checkout", "unmanaged_sessions_present", "raw_shell_mutation_interceptor", "gate_broker", "effect_interceptor", "approval_closure", "a2a_receipt_adapter", "adoption_fencing"], [], "control facts");
  const storesRaw = exactRecord(controlsRaw.stores, ["authority", "enrollment", "lifecycle"], [], "store facts");
  const stores = Object.freeze({ authority: bool(storesRaw.authority, "stores.authority"), enrollment: bool(storesRaw.enrollment, "stores.enrollment"), lifecycle: bool(storesRaw.lifecycle, "stores.lifecycle") });
  if (typeof controlsRaw.canonical_shared_checkout !== "string" || !["mechanical_read_only", "advisory", "none"].includes(controlsRaw.canonical_shared_checkout)) throw new Error("canonical_shared_checkout uses an unknown protection mode");
  const controls: RepoFlightControlFacts = Object.freeze({ stores, canonical_shared_checkout: controlsRaw.canonical_shared_checkout as RepoFlightCheckoutProtection, unmanaged_sessions_present: bool(controlsRaw.unmanaged_sessions_present, "unmanaged_sessions_present"), raw_shell_mutation_interceptor: bool(controlsRaw.raw_shell_mutation_interceptor, "raw_shell_mutation_interceptor"), gate_broker: bool(controlsRaw.gate_broker, "gate_broker"), effect_interceptor: bool(controlsRaw.effect_interceptor, "effect_interceptor"), approval_closure: bool(controlsRaw.approval_closure, "approval_closure"), a2a_receipt_adapter: bool(controlsRaw.a2a_receipt_adapter, "a2a_receipt_adapter"), adoption_fencing: bool(controlsRaw.adoption_fencing, "adoption_fencing") });
  const federation = input.federation === undefined
    ? Object.freeze({ enabled: false, authenticated: false, fenced: false })
    : federationFacts(input.federation);
  return Object.freeze({ schema_version: 1, repository_id: input.repository_id as `repo:v1:${string}`, required_providers: Object.freeze([...(input.required_providers as RepoFlightProfileProvider[])].sort()), providers: Object.freeze(providers), controls, federation });
}

function providerFacts(value: unknown, provider: string): RepoFlightProviderInterceptorFacts {
  const raw = exactRecord(value, ["launch_interceptor", "identity_enrollment", "mutation_interceptor"], [], `${provider} interceptor facts`);
  return Object.freeze({ launch_interceptor: bool(raw.launch_interceptor, `${provider}.launch_interceptor`), identity_enrollment: bool(raw.identity_enrollment, `${provider}.identity_enrollment`), mutation_interceptor: bool(raw.mutation_interceptor, `${provider}.mutation_interceptor`) });
}
function federationFacts(value: unknown): RepoFlightFederationFacts { const raw = exactRecord(value, ["enabled", "authenticated", "fenced"], [], "federation facts"); return Object.freeze({ enabled: bool(raw.enabled, "federation.enabled"), authenticated: bool(raw.authenticated, "federation.authenticated"), fenced: bool(raw.fenced, "federation.fenced") }); }
function bool(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new Error(`${name} must be boolean`); return value; }
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], name: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`); const record = value as Record<string, unknown>, admitted = new Set([...required, ...optional]); if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !admitted.has(key))) throw new Error(`${name} uses unknown or missing fields`); return record; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`; }
