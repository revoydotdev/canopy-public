import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ProductIntegrationKind = "browser" | "ide" | "github" | "extension" | "remote" | "scheduler";
export type ProductIntegrationState = "discovered" | "installed" | "enabled" | "disabled" | "unavailable";
export interface ProductIntegrationDescriptor {
  readonly id: string;
  readonly kind: ProductIntegrationKind;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly permissions: readonly string[];
  readonly dependencies: readonly string[];
  readonly handoff: { readonly kind: "deep_link" | "command" | "none"; readonly value: string | null };
  readonly health: { readonly status: "ready" | "unavailable" | "unknown"; readonly detail: string };
}
export interface ProductIntegrationView extends ProductIntegrationDescriptor { readonly state: ProductIntegrationState; readonly activation_requires_acknowledgement: boolean; }
interface ProductIntegrationOverride { readonly state: ProductIntegrationState; readonly version: string | null; readonly rollback: { readonly state: ProductIntegrationState; readonly version: string | null } | null; }
export interface ProductIntegrationStore { readonly schema_version: 1; readonly states: Readonly<Record<string, ProductIntegrationState>>; readonly overrides?: Readonly<Record<string, ProductIntegrationOverride>>; }

const HIGH_RISK = new Set(["network", "computer_use", "repository_write", "oauth", "external_publish"]);

/**
 * Product-facing integration registry. This is deliberately an admission and
 * handoff layer, never an ambient browser/provider launcher: composing a
 * descriptor is the only way an integration becomes selectable.
 */
export class ProductIntegrationControlPlane {
  private readonly descriptors = new Map<string, ProductIntegrationDescriptor>();
  private readonly states = new Map<string, ProductIntegrationState>();
  private readonly versions = new Map<string, string>();
  private readonly rollbacks = new Map<string, { readonly state: ProductIntegrationState; readonly version: string | null }>();
  constructor(private readonly options: { readonly persistence_dir?: string } = {}) { this.load(); }

  register(descriptor: ProductIntegrationDescriptor, initialState?: ProductIntegrationState): ProductIntegrationView {
    validateDescriptor(descriptor); if (this.descriptors.has(descriptor.id)) throw new Error(`integration ${descriptor.id} is already registered`);
    this.descriptors.set(descriptor.id, freezeDescriptor(descriptor)); if (!this.states.has(descriptor.id)) this.states.set(descriptor.id, initialState ?? (descriptor.health.status === "unavailable" ? "unavailable" : "discovered")); this.persist(); return this.inspectRequired(descriptor.id);
  }
  /** Refreshes an explicitly composed descriptor while preserving durable operator state. */
  discover(descriptor: ProductIntegrationDescriptor, initialState?: ProductIntegrationState): ProductIntegrationView {
    validateDescriptor(descriptor); if (!this.descriptors.has(descriptor.id)) return this.register(descriptor, initialState);
    this.descriptors.set(descriptor.id, freezeDescriptor(descriptor)); return this.inspectRequired(descriptor.id);
  }
  list(kind?: ProductIntegrationKind): readonly ProductIntegrationView[] { return Object.freeze([...this.descriptors.values()].filter((item) => kind === undefined || item.kind === kind).map((item) => this.inspectRequired(item.id)).sort((a, b) => a.id.localeCompare(b.id))); }
  inspect(id: string): ProductIntegrationView | null { return this.descriptors.has(id) ? this.inspectRequired(id) : null; }
  /** Browser/research admission is capability-bound and cannot manufacture a host. */
  admit(id: string, capabilities: readonly string[]): { readonly admitted: boolean; readonly reason: string; readonly integration: ProductIntegrationView | null } {
    const view = this.inspect(id); if (!view) return { admitted: false, reason: "integration is not composed", integration: null };
    if (view.kind !== "browser") return { admitted: false, reason: "only browser integrations can admit browser/research capabilities", integration: view };
    if (view.state !== "enabled" || view.health.status !== "ready") return { admitted: false, reason: "browser integration is not enabled and ready", integration: view };
    const requested = new Set(capabilities); if ([...requested].some((capability) => !view.capabilities.includes(capability))) return { admitted: false, reason: "requested capability is not declared by this browser integration", integration: view };
    return { admitted: true, reason: "capabilities admitted by the composed browser integration", integration: view };
  }
  setState(id: string, state: Extract<ProductIntegrationState, "installed" | "enabled" | "disabled">, acknowledgement = false): ProductIntegrationView {
    const descriptor = this.descriptors.get(id); if (!descriptor) throw new Error("integration is not composed"); if (descriptor.health.status === "unavailable") throw new Error("integration health is unavailable");
    if (state === "enabled" && needsAcknowledgement(descriptor) && !acknowledgement) throw new Error("risky activation requires explicit acknowledgement");
    return this.transaction(() => { this.states.set(id, state); return this.inspectRequired(id); });
  }
  update(id: string, version: string, acknowledgement = false): ProductIntegrationView {
    const descriptor = this.descriptors.get(id); if (!descriptor) throw new Error("integration is not composed"); if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("integration update requires an exact SemVer version"); if (needsAcknowledgement(descriptor) && !acknowledgement) throw new Error("risky update requires explicit acknowledgement");
    return this.transaction(() => {
      this.rollbacks.set(id, { state: this.states.get(id) ?? "discovered", version: this.versions.get(id) ?? null });
      this.versions.set(id, version);
      return this.inspectRequired(id);
    });
  }
  rollback(id: string, acknowledgement = false): ProductIntegrationView {
    const descriptor = this.descriptors.get(id); if (!descriptor) throw new Error("integration is not composed"); if (needsAcknowledgement(descriptor) && !acknowledgement) throw new Error("risky rollback requires explicit acknowledgement");
    const prior = this.rollbacks.get(id); if (!prior) throw new Error("integration has no durable rollback point");
    return this.transaction(() => { this.states.set(id, prior.state); if (prior.version === null) this.versions.delete(id); else this.versions.set(id, prior.version); this.rollbacks.delete(id); return this.inspectRequired(id); });
  }
  private inspectRequired(id: string): ProductIntegrationView { const descriptor = this.descriptors.get(id)!; return Object.freeze({ ...descriptor, version: this.versions.get(id) ?? descriptor.version, capabilities: Object.freeze([...descriptor.capabilities]), permissions: Object.freeze([...descriptor.permissions]), dependencies: Object.freeze([...descriptor.dependencies]), handoff: Object.freeze({ ...descriptor.handoff }), health: Object.freeze({ ...descriptor.health }), state: this.states.get(id) ?? "discovered", activation_requires_acknowledgement: needsAcknowledgement(descriptor) }); }
  private file(): string | null { return this.options.persistence_dir ? join(this.options.persistence_dir, "product-integrations.json") : null; }
  private transaction<T>(operation: () => T): T { const states = new Map(this.states); const versions = new Map(this.versions); const rollbacks = new Map(this.rollbacks); try { const value = operation(); this.persist(); return value; } catch (error) { this.states.clear(); this.versions.clear(); this.rollbacks.clear(); for (const [id, state] of states) this.states.set(id, state); for (const [id, version] of versions) this.versions.set(id, version); for (const [id, rollback] of rollbacks) this.rollbacks.set(id, rollback); throw error; } }
  private load(): void { const file = this.file(); if (!file || !existsSync(file)) return; const parsed = JSON.parse(readFileSync(file, "utf8")) as ProductIntegrationStore; if (parsed.schema_version !== 1 || !parsed.states || typeof parsed.states !== "object") throw new Error("product integration state is malformed"); for (const [id, state] of Object.entries(parsed.states)) if (["discovered", "installed", "enabled", "disabled", "unavailable"].includes(state)) this.states.set(id, state as ProductIntegrationState); for (const [id, override] of Object.entries(parsed.overrides ?? {})) { if (!validOverride(override)) throw new Error("product integration override is malformed"); this.states.set(id, override.state); if (override.version !== null) this.versions.set(id, override.version); if (override.rollback !== null) this.rollbacks.set(id, override.rollback); } }
  private persist(): void { const file = this.file(); if (!file) return; mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); const overrides = Object.fromEntries([...this.states.keys()].sort().map((id) => [id, { state: this.states.get(id)!, version: this.versions.get(id) ?? null, rollback: this.rollbacks.get(id) ?? null }])); const payload: ProductIntegrationStore = { schema_version: 1, states: Object.fromEntries([...this.states.entries()].sort(([a], [b]) => a.localeCompare(b))), overrides }; const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "w" }); renameSync(temp, file); }
}

export function builtinProductIntegrations(input: { readonly remote_ready: boolean; readonly scheduler_ready: boolean }): readonly ProductIntegrationDescriptor[] {
  return Object.freeze([
    { id: "browser.uncomposed", kind: "browser", version: "0.0.0", capabilities: [], permissions: [], dependencies: ["compose a governed browser integration"], handoff: { kind: "none", value: null }, health: { status: "unavailable", detail: "no browser/computer-use host is composed; no ambient browser is available" } },
    { id: "ide.vscode", kind: "ide", version: "1.0.0", capabilities: ["handoff"], permissions: [], dependencies: ["VS Code extension installation"], handoff: { kind: "deep_link", value: "vscode://revoy.open-handoff" }, health: { status: "unknown", detail: "machine-readable handoff only; extension installation remains operator-controlled" } },
    { id: "github.app", kind: "github", version: "1.0.0", capabilities: ["pull_request_handoff", "check_handoff"], permissions: ["oauth", "external_publish"], dependencies: ["GitHub App installation", "repository authorization"], handoff: { kind: "command", value: "arbor integration inspect github.app --json" }, health: { status: "unknown", detail: "no GitHub credential is inspected or published from this process" } },
    { id: "remote.control", kind: "remote", version: "1.0.0", capabilities: ["session_inspect", "token_authority"], permissions: ["network"], dependencies: ["authenticated listener composition"], handoff: { kind: "command", value: "arbor remote status --json" }, health: { status: input.remote_ready ? "ready" : "unavailable", detail: input.remote_ready ? "remote authority is composed; listener deployment remains explicit" : "no remote listener is composed" } },
    { id: "scheduler.control", kind: "scheduler", version: "1.0.0", capabilities: ["schedule_inspect", "schedule_trigger"], permissions: [], dependencies: ["LongHorizonScheduler composition"], handoff: { kind: "command", value: "arbor scheduler list --json" }, health: { status: input.scheduler_ready ? "ready" : "unavailable", detail: input.scheduler_ready ? "durable scheduler is composed" : "no scheduler is composed" } },
  ]);
}

function needsAcknowledgement(descriptor: ProductIntegrationDescriptor): boolean { return descriptor.permissions.some((permission) => HIGH_RISK.has(permission)); }
function validOverride(value: unknown): value is ProductIntegrationOverride { return typeof value === "object" && value !== null && ["discovered", "installed", "enabled", "disabled", "unavailable"].includes((value as { state?: string }).state ?? "") && (((value as { version?: unknown }).version === null) || /^\d+\.\d+\.\d+$/.test(String((value as { version?: unknown }).version))) && (((value as { rollback?: unknown }).rollback === null) || validRollback((value as { rollback?: unknown }).rollback)); }
function validRollback(value: unknown): value is { readonly state: ProductIntegrationState; readonly version: string | null } { return typeof value === "object" && value !== null && ["discovered", "installed", "enabled", "disabled", "unavailable"].includes((value as { state?: string }).state ?? "") && (((value as { version?: unknown }).version === null) || /^\d+\.\d+\.\d+$/.test(String((value as { version?: unknown }).version))); }
function validateDescriptor(value: ProductIntegrationDescriptor): void { if (!/^[a-z0-9][a-z0-9.-]{1,127}$/.test(value.id) || !/^\d+\.\d+\.\d+$/.test(value.version) || value.capabilities.length > 64 || value.permissions.length > 32 || value.dependencies.length > 32) throw new Error("integration descriptor is invalid"); }
function freezeDescriptor(value: ProductIntegrationDescriptor): ProductIntegrationDescriptor { return Object.freeze({ ...value, capabilities: Object.freeze([...value.capabilities]), permissions: Object.freeze([...value.permissions]), dependencies: Object.freeze([...value.dependencies]), handoff: Object.freeze({ ...value.handoff }), health: Object.freeze({ ...value.health }) }); }
