/**
 * Which product-integration lifecycle transitions have a real effect.
 *
 * The control plane may only report a transition it can actually perform.
 * A signed `extension.*` integration is backed by the plugin registry: install
 * admits a verified manifest, enable/disable gates its components' activation
 * predicate, update swaps the component snapshot and rollback restores the
 * prior one. A browser integration's enabled state is consumed by
 * `integration.admit`. Every other built-in descriptor (IDE and GitHub
 * handoffs, the remote and scheduler control descriptors) is a disclosure of
 * an operator-controlled installation outside this process: there is no
 * artifact to install, update or roll back, and nothing in the runtime reads
 * its enabled state, so recording such a transition would be a false success.
 */
import type { ProductIntegrationView } from "../product-integrations.js";

export type ProductIntegrationLifecycleKind = "integration.install" | "integration.enable" | "integration.disable" | "integration.update" | "integration.rollback";

export const EXTENSION_INTEGRATION_PREFIX = "extension.";

/** Returns the refusal reason, or `null` when the transition reaches a real effect. */
export function productIntegrationLifecycleRefusal(input: {
  readonly kind: ProductIntegrationLifecycleKind;
  readonly integration_id: string;
  readonly view: ProductIntegrationView | null;
  readonly version?: string;
  readonly plugin_manifest?: string;
}): string | null {
  if (input.integration_id.startsWith(EXTENSION_INTEGRATION_PREFIX)) return extensionRefusal(input);
  // An uncomposed id is refused by the control plane itself with its own reason.
  if (input.view === null) return null;
  if (input.kind === "integration.install" || input.kind === "integration.update" || input.kind === "integration.rollback") {
    return `${input.integration_id} is a composed ${input.view.kind} descriptor with no installable artifact; install, update and rollback apply only to signed extension integrations`;
  }
  if (input.view.kind !== "browser") {
    return `${input.integration_id} activation is operator-controlled outside this runtime and no runtime consumer reads its state; use its handoff (${input.view.handoff.value ?? "none"})`;
  }
  return null;
}

function extensionRefusal(input: { readonly kind: ProductIntegrationLifecycleKind; readonly integration_id: string; readonly version?: string; readonly plugin_manifest?: string }): string | null {
  if (input.kind !== "integration.install" && input.kind !== "integration.update") return null;
  if (input.plugin_manifest === undefined) return null; // contract validation already requires it
  let manifest: unknown;
  try { manifest = JSON.parse(input.plugin_manifest); } catch { return "plugin manifest is not valid JSON"; }
  const declared = typeof manifest === "object" && manifest !== null ? manifest as { plugin_id?: unknown; version?: unknown } : {};
  // Checked before admission: the registry persists an admitted plugin, so a
  // mismatched id must never reach it.
  if (declared.plugin_id !== input.integration_id.slice(EXTENSION_INTEGRATION_PREFIX.length)) return "integration id must match the signed plugin manifest id";
  // The projected version must be the signed manifest's, never a free label.
  if (input.kind === "integration.update" && declared.version !== input.version) return "update version must equal the signed plugin manifest version";
  return null;
}
