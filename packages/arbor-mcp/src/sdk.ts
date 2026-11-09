/**
 * Public, data-only integration authoring boundary.
 *
 * This entrypoint intentionally does not export registries, credential leases,
 * sandbox brokers, runtime services, or an authority that can install/enable
 * anything. Hosts retain those capabilities behind their own signed lifecycle.
 */
export const PUBLIC_INTEGRATION_SDK_VERSION = "revoy.public-sdk.v1" as const;
export interface PublicIntegrationDefinition {
  readonly schema_version: 1;
  readonly sdk_version: typeof PUBLIC_INTEGRATION_SDK_VERSION;
  readonly integration_id: string;
  readonly version: string;
  readonly display_name: string;
  readonly capabilities: readonly ("tools" | "network" | "filesystem_write" | "code_execution")[];
}

export function defineIntegration(input: PublicIntegrationDefinition): Readonly<PublicIntegrationDefinition> {
  if (input.schema_version !== 1 || input.sdk_version !== PUBLIC_INTEGRATION_SDK_VERSION) throw new Error("unsupported public SDK schema");
  if (typeof input.integration_id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(input.integration_id)) throw new Error("integration_id must be a stable public identifier");
  if (typeof input.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) throw new Error("version must be semantic versioning");
  if (typeof input.display_name !== "string" || input.display_name.trim().length === 0 || input.display_name.length > 120) throw new Error("display_name must be present and bounded");
  const allowed = new Set(["tools", "network", "filesystem_write", "code_execution"]);
  if (!Array.isArray(input.capabilities) || input.capabilities.length > 4 || input.capabilities.some((capability) => !allowed.has(capability))) throw new Error("public SDK capability is not recognized");
  return Object.freeze({ ...input, capabilities: Object.freeze([...new Set(input.capabilities)].sort()) });
}
