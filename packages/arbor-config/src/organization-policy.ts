import { existsSync, readFileSync } from "node:fs";
import { stripJsonc } from "./loader.js";

/**
 * Checked-in organization policy.  This is deliberately a separate document
 * from `arbor.jsonc`: the latter is a project preference file, whereas this
 * document is an authority floor that project and user overlays may only make
 * stricter.  It contains no credentials or ambient machine state, so it is
 * suitable for review and commit.
 *
 * ADR-110 Decision 3: this floor and `loader.ts`'s `resolveConfigScopes`
 * precedence chain are two different mechanisms over two different knob
 * sets, deliberately kept apart rather than merged. A precedence chain
 * answers "what value wins" — `arbor.jsonc`'s general preference knobs stay
 * pure precedence, so a project can freely override an organization-scope
 * `arbor.jsonc` value (e.g. turn on a debug flag the org config left off).
 * A floor answers "what value may a lower scope not weaken" — the three
 * `OrganizationPolicy` knobs (`network.allowed_domains`,
 * `native_approval.allowed_tools`, `startup.safe_mode`) stay under
 * `narrowList`'s ratchet below, unreachable by `loadConfig`'s ordinary
 * override path. `ArborConfig` (`types.ts`) has no `network`/
 * `native_approval`/`startup` leaves of its own, so the two mechanisms
 * cannot collide on the same dotted path even by accident — see
 * `organization-policy.test.ts`'s coexistence test for the round-trip
 * proof. `resolveCliOrganizationPolicy` (`packages/arbor-mcp/src/cli.ts`)
 * continues to load this document separately from `loadConfig`'s scope
 * chain; collapsing them would let an `arbor.jsonc` project override
 * silently narrow-or-widen a floor knob depending on merge order, which is
 * exactly the ambiguity a floor exists to prevent.
 */
export const ORGANIZATION_POLICY_FILENAME = "arbor.organization-policy.jsonc";
export const ORGANIZATION_POLICY_SCHEMA_VERSION = 1 as const;

export interface OrganizationPolicy {
  readonly schema_version: typeof ORGANIZATION_POLICY_SCHEMA_VERSION;
  readonly policy_id: string;
  readonly network: {
    /** Exact, normalized DNS host names. An empty list means deny all. */
    readonly allowed_domains: readonly string[];
  };
  readonly native_approval: {
    /** High-risk native tools a system policy may approve. Empty denies all. */
    readonly allowed_tools: readonly string[];
  };
  readonly startup: {
    /** A floor: once true, no lower-precedence layer may turn it off. */
    readonly safe_mode: boolean;
  };
}

/** A project/user contribution can only narrow a checked-in organization policy. */
export interface OrganizationPolicyOverlay {
  readonly network?: { readonly allowed_domains?: readonly string[] };
  readonly native_approval?: { readonly allowed_tools?: readonly string[] };
  readonly startup?: { readonly safe_mode?: boolean };
}

export interface OrganizationPolicyLayers {
  readonly organization: OrganizationPolicy;
  readonly project?: OrganizationPolicyOverlay;
  readonly user?: OrganizationPolicyOverlay;
}

export const ORGANIZATION_POLICY_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Arbor Organization Policy",
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: { const: ORGANIZATION_POLICY_SCHEMA_VERSION },
    policy_id: { type: "string", minLength: 1, maxLength: 128 },
    network: {
      type: "object", additionalProperties: false,
      properties: { allowed_domains: { type: "array", maxItems: 128, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 253 } } },
      required: ["allowed_domains"],
    },
    native_approval: {
      type: "object", additionalProperties: false,
      properties: { allowed_tools: { type: "array", maxItems: 128, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 } } },
      required: ["allowed_tools"],
    },
    startup: {
      type: "object", additionalProperties: false,
      properties: { safe_mode: { type: "boolean" } },
      required: ["safe_mode"],
    },
  },
  required: ["schema_version", "policy_id", "network", "native_approval", "startup"],
} as const;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOOL = /^[a-z][a-z0-9_.-]{0,127}$/;

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${path} has unknown field(s): ${unknown.join(", ")}`);
}

function required(value: Record<string, unknown>, path: string, key: string): unknown {
  if (!(key in value)) throw new Error(`${path}.${key} is required`);
  return value[key];
}

function normalizedList(value: unknown, path: string, normalize: (entry: string) => string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error(`${path} must be an array with at most 128 entries`);
  const normalized = value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`${path}[${index}] must be a string`);
    return normalize(entry);
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`${path} contains duplicate entries after normalization`);
  return Object.freeze(normalized.sort());
}

/** Normalizes an exact DNS name; wildcards, URLs, IPs, and local names are not policy domains. */
export function normalizePolicyDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN.test(normalized)) throw new Error(`invalid policy domain: ${value}`);
  return normalized;
}

function normalizeTool(value: string): string {
  const normalized = value.trim();
  if (!TOOL.test(normalized)) throw new Error(`invalid native approval tool: ${value}`);
  return normalized;
}

function parseJsoncObject(input: string, source: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stripJsonc(input.trim()));
    return object(parsed, source);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(source)) throw error;
    throw new Error(`${source} is malformed: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

export function loadOrganizationPolicyFromString(input: string, source = "organization policy"): OrganizationPolicy {
  const root = parseJsoncObject(input, source);
  onlyKeys(root, source, ["schema_version", "policy_id", "network", "native_approval", "startup"]);
  if (required(root, source, "schema_version") !== ORGANIZATION_POLICY_SCHEMA_VERSION) throw new Error(`${source}.schema_version must be ${ORGANIZATION_POLICY_SCHEMA_VERSION}`);
  const policyId = required(root, source, "policy_id");
  if (typeof policyId !== "string" || policyId.trim() === "" || policyId.length > 128) throw new Error(`${source}.policy_id must be a non-empty string of at most 128 characters`);
  const network = object(required(root, source, "network"), `${source}.network`);
  const approval = object(required(root, source, "native_approval"), `${source}.native_approval`);
  const startup = object(required(root, source, "startup"), `${source}.startup`);
  onlyKeys(network, `${source}.network`, ["allowed_domains"]);
  onlyKeys(approval, `${source}.native_approval`, ["allowed_tools"]);
  onlyKeys(startup, `${source}.startup`, ["safe_mode"]);
  const safeMode = required(startup, `${source}.startup`, "safe_mode");
  if (typeof safeMode !== "boolean") throw new Error(`${source}.startup.safe_mode must be boolean`);
  return Object.freeze({
    schema_version: ORGANIZATION_POLICY_SCHEMA_VERSION,
    policy_id: policyId.trim(),
    network: Object.freeze({ allowed_domains: normalizedList(required(network, `${source}.network`, "allowed_domains"), `${source}.network.allowed_domains`, normalizePolicyDomain) }),
    native_approval: Object.freeze({ allowed_tools: normalizedList(required(approval, `${source}.native_approval`, "allowed_tools"), `${source}.native_approval.allowed_tools`, normalizeTool) }),
    startup: Object.freeze({ safe_mode: safeMode }),
  });
}

export function loadOrganizationPolicyFile(path: string): OrganizationPolicy {
  if (!existsSync(path)) throw new Error(`organization policy is required but missing: ${path}`);
  return loadOrganizationPolicyFromString(readFileSync(path, "utf8"), path);
}

export function loadOrganizationPolicyOverlayFromString(input: string, source = "organization policy overlay"): OrganizationPolicyOverlay {
  const root = parseJsoncObject(input, source);
  onlyKeys(root, source, ["network", "native_approval", "startup"]);
  const overlay: { network?: { allowed_domains?: readonly string[] }; native_approval?: { allowed_tools?: readonly string[] }; startup?: { safe_mode?: boolean } } = {};
  if (root.network !== undefined) {
    const network = object(root.network, `${source}.network`); onlyKeys(network, `${source}.network`, ["allowed_domains"]);
    overlay.network = network.allowed_domains === undefined ? {} : { allowed_domains: normalizedList(network.allowed_domains, `${source}.network.allowed_domains`, normalizePolicyDomain) };
  }
  if (root.native_approval !== undefined) {
    const approval = object(root.native_approval, `${source}.native_approval`); onlyKeys(approval, `${source}.native_approval`, ["allowed_tools"]);
    overlay.native_approval = approval.allowed_tools === undefined ? {} : { allowed_tools: normalizedList(approval.allowed_tools, `${source}.native_approval.allowed_tools`, normalizeTool) };
  }
  if (root.startup !== undefined) {
    const startup = object(root.startup, `${source}.startup`); onlyKeys(startup, `${source}.startup`, ["safe_mode"]);
    if (startup.safe_mode !== undefined && typeof startup.safe_mode !== "boolean") throw new Error(`${source}.startup.safe_mode must be boolean`);
    overlay.startup = startup.safe_mode === undefined ? {} : { safe_mode: startup.safe_mode };
  }
  return Object.freeze(overlay);
}

function narrowList(current: readonly string[], proposed: readonly string[] | undefined, source: string, path: string): readonly string[] {
  if (proposed === undefined) return current;
  const currentSet = new Set(current);
  const widening = proposed.filter((entry) => !currentSet.has(entry));
  if (widening.length > 0) throw new Error(`${source} weakens organization policy at ${path}: ${widening.join(", ")}`);
  return proposed;
}

/** Applies project then user overlays. Each attempted widening is an error, never silently intersected away. */
export function composeOrganizationPolicy(layers: OrganizationPolicyLayers): OrganizationPolicy {
  let domains = layers.organization.network.allowed_domains;
  let tools = layers.organization.native_approval.allowed_tools;
  let safeMode = layers.organization.startup.safe_mode;
  for (const [source, overlay] of [["project policy", layers.project], ["user policy", layers.user]] as const) {
    if (overlay === undefined) continue;
    domains = narrowList(domains, overlay.network?.allowed_domains, source, "network.allowed_domains");
    tools = narrowList(tools, overlay.native_approval?.allowed_tools, source, "native_approval.allowed_tools");
    if (safeMode && overlay.startup?.safe_mode === false) throw new Error(`${source} weakens organization policy at startup.safe_mode`);
    safeMode = safeMode || overlay.startup?.safe_mode === true;
  }
  return Object.freeze({
    ...layers.organization,
    network: Object.freeze({ allowed_domains: domains }),
    native_approval: Object.freeze({ allowed_tools: tools }),
    startup: Object.freeze({ safe_mode: safeMode }),
  });
}

export function loadOrganizationPolicyLayers(paths: { readonly organization_path: string; readonly project_path?: string; readonly user_path?: string }): OrganizationPolicy {
  const organization = loadOrganizationPolicyFile(paths.organization_path);
  const optionalOverlay = (path: string | undefined, label: string): OrganizationPolicyOverlay | undefined => {
    if (path === undefined || !existsSync(path)) return undefined;
    return loadOrganizationPolicyOverlayFromString(readFileSync(path, "utf8"), label);
  };
  return composeOrganizationPolicy({ organization, project: optionalOverlay(paths.project_path, "project policy"), user: optionalOverlay(paths.user_path, "user policy") });
}

/** Exact-domain check used by a D47 network port; absent from a policy means deny all. */
export function isPolicyDomainAllowed(policy: Pick<OrganizationPolicy, "network">, hostname: string): boolean {
  try { return policy.network.allowed_domains.includes(normalizePolicyDomain(hostname)); } catch { return false; }
}
