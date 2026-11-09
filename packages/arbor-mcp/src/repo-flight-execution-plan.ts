/**
 * A closed, profile-derived execution plan for Flight scheduling.
 *
 * The execution profile remains the policy source.  This module accepts the
 * profile structure itself (never a caller-selected command list or digest),
 * derives an immutable plan, and lets Flight verify a signature made by a
 * separately trusted adapter.  Flight may use `runnableRepoFlightPlanGates`
 * to choose timing only within a derived read-only wave.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const CONTEXTS = ["stop", "precommit", "prepush", "trunk_submit", "ci"] as const;
const FAILURE_POLICIES = ["fail_fast", "complete_all"] as const;
const MUTABILITIES = ["read_only", "verification_sandbox", "evidence_writer"] as const;
const COST_CLASSES = ["stop", "fast", "full"] as const;
const SCOPES = ["self", "target", "both"] as const;
const TERMINAL_STATUSES = ["passed", "failed", "timed_out", "cancelled", "blocked_by_prerequisite", "identity_mismatch", "cached"] as const;

export type RepoFlightExecutionContext = typeof CONTEXTS[number];
export type RepoFlightPlanMutability = typeof MUTABILITIES[number];
export type RepoFlightPlanTerminalStatus = typeof TERMINAL_STATUSES[number];

export class RepoFlightExecutionPlanError extends Error {
  constructor(readonly code: "malformed" | "dependency" | "signature" | "tampered", message: string) { super(message); }
}

export interface RepoFlightExecutionPlanInput {
  readonly schema_version: 1;
  readonly profile: unknown;
  readonly context: RepoFlightExecutionContext;
  readonly candidate: Readonly<{ readonly candidate_oid: string; readonly input_digest: `sha256:${string}` }>;
  readonly toolchain: Readonly<{ readonly runtime_id: string; readonly runtime_version: string; readonly platform: string; readonly architecture: string; readonly lockfile_digest: `sha256:${string}` }>;
}

export interface RepoFlightPlanGate {
  readonly gate_id: string;
  readonly argv: readonly string[];
  readonly prerequisites: readonly string[];
  readonly wave: number;
  readonly reporting_ordinal: number;
  readonly timeout_ms: number;
  readonly cost_class: "stop" | "fast" | "full";
  readonly mutability: RepoFlightPlanMutability;
  readonly required: boolean;
  readonly scope: "self" | "target" | "both";
  readonly resources: readonly Readonly<{ readonly kind: "candidate.snapshot" | "workspace.verification" | "evidence.publication"; readonly key: string; readonly mode: "shared" | "exclusive" }>[];
}

export interface RepoFlightUnsignedExecutionPlan {
  readonly schema_version: 1;
  readonly kind: "revoy2.flight_execution_plan";
  readonly profile: Readonly<{ readonly schema_version: 1; readonly profile_version: string; readonly profile_digest: `sha256:${string}`; readonly context: RepoFlightExecutionContext; readonly max_readers: number; readonly failure_policy: "fail_fast" | "complete_all" }>;
  readonly candidate: RepoFlightExecutionPlanInput["candidate"];
  readonly toolchain: RepoFlightExecutionPlanInput["toolchain"];
  readonly terminal_semantics: Readonly<{ readonly failure_policy: "fail_fast" | "complete_all"; readonly terminal_statuses: readonly RepoFlightPlanTerminalStatus[] }>;
  readonly gates: readonly RepoFlightPlanGate[];
  readonly reporting_order: readonly string[];
  readonly plan_digest: `sha256:${string}`;
}

export interface RepoFlightSignedExecutionPlan extends RepoFlightUnsignedExecutionPlan {
  readonly signature: Readonly<{ readonly algorithm: "ed25519"; readonly issuer_id: string; readonly value: string }>;
}

export interface RepoFlightExecutionPlanSigner {
  readonly issuer_id: string;
  readonly private_key_pem: string;
}

export interface RepoFlightShadowMismatch { readonly code: "profile" | "candidate" | "toolchain" | "gate_set" | "argv" | "prerequisites" | "wave" | "mutability" | "timeout" | "resources" | "terminal_semantics" | "reporting_order"; readonly path: string; readonly expected: string; readonly actual: string; }
export interface RepoFlightShadowParity { readonly ok: boolean; readonly findings: readonly RepoFlightShadowMismatch[]; }

/** Derive a plan only from a complete canonical-profile-shaped input. */
export function createRepoFlightExecutionPlan(input: unknown): RepoFlightUnsignedExecutionPlan {
  const value = parseInput(input);
  const profile = parseProfile(value.profile);
  const context = value.context;
  const contextConfig = profile.execution.contexts[context];
  const selected = new Map(Object.entries(profile.gates).filter(([, gate]) => gate.contexts[context]).map(([id, gate]) => [id, gate]));
  if (selected.size === 0) throw malformed("profile selects no gates for execution context");
  for (const [id, gate] of selected) for (const prerequisite of gate.prerequisites) {
    if (!selected.has(prerequisite)) throw dependency(`${id} selects ${context} but prerequisite ${prerequisite} is not selected`);
  }
  const ranks = gateRanks(profile.execution.gate_order);
  const waves = deriveWaves(selected, ranks, contextConfig.max_readers);
  const planGates = waves.flatMap((wave) => wave.gates.map((id) => {
    const gate = selected.get(id)!;
    return freeze({
      gate_id: id, argv: freeze(normalizeProfileCommand(gate.command, id)), prerequisites: freeze([...gate.prerequisites]), wave: wave.wave,
      reporting_ordinal: 0, timeout_ms: gate.timeout_ms, cost_class: gate.cost_class, mutability: gate.mutability,
      required: gate.required, scope: gate.scope, resources: freeze(resourcesFor(id, gate.mutability)),
    });
  }));
  const ordered = planGates.map((gate, index) => freeze({ ...gate, reporting_ordinal: index + 1 }));
  const profileDigest = digest(canonical(profile.source));
  const unsigned = {
    schema_version: 1 as const,
    kind: "revoy2.flight_execution_plan" as const,
    profile: freeze({ schema_version: 1 as const, profile_version: profile.profile_version, profile_digest: profileDigest, context, max_readers: contextConfig.max_readers, failure_policy: contextConfig.failure_policy }),
    candidate: freeze({ ...value.candidate }), toolchain: freeze({ ...value.toolchain }),
    terminal_semantics: freeze({ failure_policy: contextConfig.failure_policy, terminal_statuses: freeze([...TERMINAL_STATUSES]) }),
    gates: freeze(ordered), reporting_order: freeze(ordered.map((gate) => gate.gate_id)), plan_digest: "sha256:" as `sha256:${string}`,
  };
  const planDigest = digest(canonical(unsignedWithoutDigest(unsigned)));
  return freeze({ ...unsigned, plan_digest: planDigest });
}

/** External adapters sign a fully-derived plan; Flight only needs the verifier below. */
export function signRepoFlightExecutionPlan(plan: RepoFlightUnsignedExecutionPlan, signer: RepoFlightExecutionPlanSigner): RepoFlightSignedExecutionPlan {
  const parsed = parseUnsignedPlan(plan);
  if (!identifier(signer.issuer_id) || typeof signer.private_key_pem !== "string" || signer.private_key_pem.length > 16_384) throw malformed("execution-plan signer is malformed");
  let signature: Buffer;
  try { signature = sign(null, canonicalPlanBytes(parsed), createPrivateKey(signer.private_key_pem)); }
  catch { throw new RepoFlightExecutionPlanError("signature", "execution-plan signer key is invalid"); }
  if (signature.byteLength !== 64) throw new RepoFlightExecutionPlanError("signature", "execution-plan signer is not Ed25519");
  return freeze({ ...parsed, signature: freeze({ algorithm: "ed25519" as const, issuer_id: signer.issuer_id, value: signature.toString("base64") }) });
}

/** Verify both structural/digest integrity and an independently configured issuer trust root. */
export function verifyRepoFlightExecutionPlan(value: unknown, trustedIssuers: ReadonlyMap<string, string>): RepoFlightSignedExecutionPlan {
  const plan = parseSignedPlan(value);
  const trustedPem = trustedIssuers.get(plan.signature.issuer_id);
  if (trustedPem === undefined) throw new RepoFlightExecutionPlanError("signature", "execution-plan issuer is not trusted");
  let signature: Buffer;
  try { signature = Buffer.from(plan.signature.value, "base64"); } catch { throw new RepoFlightExecutionPlanError("signature", "execution-plan signature is malformed"); }
  if (signature.byteLength !== 64) throw new RepoFlightExecutionPlanError("signature", "execution-plan signature must be Ed25519");
  try { if (!verify(null, canonicalPlanBytes(plan), createPublicKey(trustedPem), signature)) throw new RepoFlightExecutionPlanError("signature", "execution-plan signature verification failed"); }
  catch (error) { if (error instanceof RepoFlightExecutionPlanError) throw error; throw new RepoFlightExecutionPlanError("signature", "execution-plan issuer key is invalid"); }
  return plan;
}

/** Compare a signed/shadow plan against a fresh independent profile derivation. */
export function compareRepoFlightExecutionPlanShadow(input: unknown, actualValue: unknown): RepoFlightShadowParity {
  const expected = createRepoFlightExecutionPlan(input);
  const actual = parseUnsignedPlan(actualValue);
  const findings: RepoFlightShadowMismatch[] = [];
  compare(findings, "profile", "profile", expected.profile, actual.profile);
  compare(findings, "candidate", "candidate", expected.candidate, actual.candidate);
  compare(findings, "toolchain", "toolchain", expected.toolchain, actual.toolchain);
  compare(findings, "terminal_semantics", "terminal_semantics", expected.terminal_semantics, actual.terminal_semantics);
  compare(findings, "reporting_order", "reporting_order", expected.reporting_order, actual.reporting_order);
  const expectedIds = expected.gates.map((gate) => gate.gate_id), actualIds = actual.gates.map((gate) => gate.gate_id);
  compare(findings, "gate_set", "gates", [...expectedIds].sort(), [...actualIds].sort());
  for (const id of [...new Set([...expectedIds, ...actualIds])].sort()) {
    const left = expected.gates.find((gate) => gate.gate_id === id), right = actual.gates.find((gate) => gate.gate_id === id);
    if (!left || !right) continue;
    compare(findings, "argv", `gates.${id}.argv`, left.argv, right.argv);
    compare(findings, "prerequisites", `gates.${id}.prerequisites`, left.prerequisites, right.prerequisites);
    compare(findings, "wave", `gates.${id}.wave`, left.wave, right.wave);
    compare(findings, "mutability", `gates.${id}.mutability`, left.mutability, right.mutability);
    compare(findings, "timeout", `gates.${id}.timeout_ms`, left.timeout_ms, right.timeout_ms);
    compare(findings, "resources", `gates.${id}.resources`, left.resources, right.resources);
  }
  return freeze({ ok: findings.length === 0, findings: freeze(findings) });
}

/** Only simultaneously runnable, read-only gates in the same derived wave may be timed independently. */
export function runnableRepoFlightPlanGates(value: unknown, completed: ReadonlySet<string>): readonly RepoFlightPlanGate[] {
  const plan = parseUnsignedPlan(value);
  const candidate = plan.gates.filter((gate) => !completed.has(gate.gate_id) && gate.mutability === "read_only" && gate.prerequisites.every((id) => completed.has(id)));
  if (candidate.length === 0) return freeze([]);
  const firstWave = Math.min(...candidate.map((gate) => gate.wave));
  return freeze(candidate.filter((gate) => gate.wave === firstWave).sort((a, b) => a.reporting_ordinal - b.reporting_ordinal));
}

interface ProfileGate { readonly command: string; readonly prerequisites: readonly string[]; readonly contexts: Readonly<Record<RepoFlightExecutionContext, boolean>>; readonly timeout_ms: number; readonly cost_class: "stop" | "fast" | "full"; readonly mutability: RepoFlightPlanMutability; readonly required: boolean; readonly scope: "self" | "target" | "both"; }
interface ParsedProfile { readonly source: Record<string, unknown>; readonly profile_version: string; readonly execution: { readonly contexts: Readonly<Record<RepoFlightExecutionContext, { readonly max_readers: number; readonly failure_policy: "fail_fast" | "complete_all" }>>; readonly gate_order: readonly { readonly id: string; readonly gates: readonly string[] }[] }; readonly gates: Readonly<Record<string, ProfileGate>>; }

function parseInput(value: unknown): RepoFlightExecutionPlanInput {
  if (!exact(value, ["schema_version", "profile", "context", "candidate", "toolchain"]) || value.schema_version !== 1 || !context(value.context) || !candidate(value.candidate) || !toolchain(value.toolchain)) throw malformed("execution-plan input uses an unknown or invalid schema");
  return value as RepoFlightExecutionPlanInput;
}

function parseProfile(value: unknown): ParsedProfile {
  if (!exact(value, ["schema_version", "profile_version", "execution", "gates"]) || value.schema_version !== 1 || !identifier(value.profile_version) || !plain(value.execution) || !plain(value.gates)) throw malformed("canonical execution profile is malformed");
  const execution = value.execution;
  if (!exact(execution, ["contexts", "gate_order", "finalization", "managed_hooks"]) || !plain(execution.contexts) || !Array.isArray(execution.gate_order) || !Array.isArray(execution.finalization?.phases) || !plain(execution.managed_hooks)) throw malformed("canonical execution profile execution block is malformed");
  const contexts = {} as Record<RepoFlightExecutionContext, { max_readers: number; failure_policy: "fail_fast" | "complete_all" }>;
  for (const name of CONTEXTS) {
    const entry = execution.contexts[name];
    if (!exact(entry, ["max_readers", "failure_policy"]) || !positive(entry.max_readers, 256) || !failurePolicy(entry.failure_policy)) throw malformed(`execution context ${name} is malformed`);
    contexts[name] = freeze({ max_readers: entry.max_readers, failure_policy: entry.failure_policy });
  }
  if (Object.keys(execution.contexts).some((name) => !CONTEXTS.includes(name as RepoFlightExecutionContext))) throw malformed("execution profile has an unknown context");
  const gateOrder = execution.gate_order.map((group) => {
    if (!exact(group, ["id", "gates"]) || !identifier(group.id) || !uniqueIds(group.gates)) throw malformed("execution profile gate_order group is malformed");
    return freeze({ id: group.id, gates: freeze([...group.gates]) });
  });
  if (gateOrder.length === 0 || new Set(gateOrder.map((group) => group.id)).size !== gateOrder.length) throw malformed("execution profile gate_order is empty or duplicated");
  const gates: Record<string, ProfileGate> = {};
  for (const [id, entry] of Object.entries(value.gates)) {
    if (!identifier(id) || !exact(entry, ["command", "prerequisites", "contexts", "excluded_contexts", "timeout_ms", "cost_class", "mutability", "required", "scope"], ["remote_receipt", "advisory_reason"]) || typeof entry.command !== "string" || !uniqueIds(entry.prerequisites) || !plain(entry.contexts) || !positive(entry.timeout_ms, 3_600_000) || !costClass(entry.cost_class) || !mutability(entry.mutability) || typeof entry.required !== "boolean" || !scope(entry.scope)) throw malformed(`execution profile gate ${id} is malformed`);
    const selected: Record<RepoFlightExecutionContext, boolean> = {} as Record<RepoFlightExecutionContext, boolean>;
    for (const name of CONTEXTS) { if (typeof entry.contexts[name] !== "boolean") throw malformed(`execution profile gate ${id} lacks context ${name}`); selected[name] = entry.contexts[name]; }
    if (Object.keys(entry.contexts).some((name) => !CONTEXTS.includes(name as RepoFlightExecutionContext))) throw malformed(`execution profile gate ${id} has unknown context`);
    gates[id] = freeze({ command: entry.command, prerequisites: freeze([...entry.prerequisites]), contexts: freeze(selected), timeout_ms: entry.timeout_ms, cost_class: entry.cost_class, mutability: entry.mutability, required: entry.required, scope: entry.scope });
  }
  const ordered = gateOrder.flatMap((group) => group.gates);
  if (Object.keys(gates).length === 0 || new Set(ordered).size !== ordered.length || ordered.length !== Object.keys(gates).length || ordered.some((id) => gates[id] === undefined)) throw malformed("execution profile gate_order must enumerate every gate exactly once");
  const ranks = gateRanks(gateOrder);
  for (const [id, gate] of Object.entries(gates)) for (const prerequisite of gate.prerequisites) {
    if (gates[prerequisite] === undefined) throw dependency(`${id} names unknown prerequisite ${prerequisite}`);
    if (ranks.get(prerequisite)! >= ranks.get(id)!) throw dependency(`${id} prerequisite ${prerequisite} must occur in an earlier execution group`);
  }
  return freeze({ source: structuredClone(value), profile_version: value.profile_version, execution: freeze({ contexts: freeze(contexts), gate_order: freeze(gateOrder) }), gates: freeze(gates) });
}

function deriveWaves(gates: ReadonlyMap<string, ProfileGate>, ranks: ReadonlyMap<string, number>, maxReaders: number): readonly { readonly wave: number; readonly gates: readonly string[] }[] {
  const planned = new Set<string>(), waves: { wave: number; gates: readonly string[] }[] = [];
  while (planned.size < gates.size) {
    const ready = [...gates.entries()].filter(([id, gate]) => !planned.has(id) && gate.prerequisites.every((dependency) => planned.has(dependency))).sort(([left], [right]) => (ranks.get(left)! - ranks.get(right)!) || left.localeCompare(right));
    if (ready.length === 0) throw dependency(`execution profile dependency cycle: ${[...gates.keys()].filter((id) => !planned.has(id)).sort().join(", ")}`);
    const rank = ranks.get(ready[0]![0])!;
    const sameRank = ready.filter(([id]) => ranks.get(id) === rank);
    const writers = sameRank.filter(([, gate]) => gate.mutability !== "read_only");
    const scheduled = writers.length > 0 ? [writers[0]!] : sameRank.slice(0, maxReaders);
    waves.push(freeze({ wave: waves.length + 1, gates: freeze(scheduled.map(([id]) => id)) }));
    for (const [id] of scheduled) planned.add(id);
  }
  return freeze(waves);
}

function gateRanks(groups: readonly { readonly id: string; readonly gates: readonly string[] }[]): ReadonlyMap<string, number> { return new Map(groups.flatMap((group, rank) => group.gates.map((id) => [id, rank] as const))); }
function resourcesFor(gateId: string, mutabilityValue: RepoFlightPlanMutability): readonly RepoFlightPlanGate["resources"][number][] {
  if (mutabilityValue === "read_only") return [freeze({ kind: "candidate.snapshot" as const, key: "candidate", mode: "shared" as const })];
  if (mutabilityValue === "verification_sandbox") return [freeze({ kind: "workspace.verification" as const, key: `workspace:${gateId}`, mode: "exclusive" as const })];
  return [freeze({ kind: "evidence.publication" as const, key: "evidence", mode: "exclusive" as const })];
}
function normalizeProfileCommand(command: string, gateId: string): string[] {
  if (!/^bun run gate:[a-z0-9][a-z0-9:_-]*$/u.test(command) || command !== `bun run ${gateId}`) throw malformed(`gate ${gateId} command is not the canonical argv-only bun invocation`);
  return ["bun", "run", gateId];
}
function parseUnsignedPlan(value: unknown): RepoFlightUnsignedExecutionPlan {
  if (!plain(value) || Object.keys(value).some((key) => !["schema_version", "kind", "profile", "candidate", "toolchain", "terminal_semantics", "gates", "reporting_order", "plan_digest", "signature"].includes(key))) throw malformed("execution plan has an unknown schema");
  const { signature: _signature, ...unsigned } = value;
  if (!exact(unsigned, ["schema_version", "kind", "profile", "candidate", "toolchain", "terminal_semantics", "gates", "reporting_order", "plan_digest"]) || unsigned.schema_version !== 1 || unsigned.kind !== "revoy2.flight_execution_plan" || !planProfile(unsigned.profile) || !candidate(unsigned.candidate) || !toolchain(unsigned.toolchain) || !terminalSemantics(unsigned.terminal_semantics) || !Array.isArray(unsigned.gates) || !uniqueIds(unsigned.reporting_order) || !digestValue(unsigned.plan_digest)) throw malformed("execution plan is malformed");
  const gates = unsigned.gates.map(parsePlanGate);
  if (gates.length === 0 || new Set(gates.map((gate) => gate.gate_id)).size !== gates.length || canonical(gates.map((gate) => gate.gate_id)) !== canonical(unsigned.reporting_order) || gates.some((gate, index) => gate.reporting_ordinal !== index + 1)) throw malformed("execution plan reporting order is malformed");
  const byId = new Map(gates.map((gate) => [gate.gate_id, gate]));
  for (const gate of gates) for (const prerequisite of gate.prerequisites) {
    const dependencyGate = byId.get(prerequisite);
    if (dependencyGate === undefined || dependencyGate.wave >= gate.wave) throw dependency(`execution plan gate ${gate.gate_id} has an absent or non-prior prerequisite ${prerequisite}`);
  }
  const waveNumbers = [...new Set(gates.map((gate) => gate.wave))].sort((left, right) => left - right);
  if (waveNumbers.some((wave, index) => wave !== index + 1)) throw dependency("execution plan waves must be contiguous from one");
  for (const wave of waveNumbers) {
    const members = gates.filter((gate) => gate.wave === wave);
    if (members.length > 1 && members.some((gate) => gate.mutability !== "read_only")) throw dependency(`execution plan wave ${wave} mixes or duplicates exclusive work`);
  }
  const expectedDigest = digest(canonical(unsignedWithoutDigest(unsigned as Omit<RepoFlightUnsignedExecutionPlan, "plan_digest"> & { plan_digest: `sha256:${string}` })));
  if (expectedDigest !== unsigned.plan_digest) throw new RepoFlightExecutionPlanError("tampered", "execution plan digest does not match its canonical content");
  return freeze({ ...unsigned, profile: freeze({ ...unsigned.profile }), candidate: freeze({ ...unsigned.candidate }), toolchain: freeze({ ...unsigned.toolchain }), terminal_semantics: freeze({ ...unsigned.terminal_semantics, terminal_statuses: freeze([...unsigned.terminal_semantics.terminal_statuses]) }), gates: freeze(gates), reporting_order: freeze([...unsigned.reporting_order]) }) as unknown as RepoFlightUnsignedExecutionPlan;
}
function parseSignedPlan(value: unknown): RepoFlightSignedExecutionPlan {
  const unsigned = parseUnsignedPlan(value);
  if (!plain(value) || !signature(value.signature)) throw new RepoFlightExecutionPlanError("signature", "execution plan signature is malformed");
  return freeze({ ...unsigned, signature: freeze({ ...value.signature }) });
}
function parsePlanGate(value: unknown): RepoFlightPlanGate {
  if (!exact(value, ["gate_id", "argv", "prerequisites", "wave", "reporting_ordinal", "timeout_ms", "cost_class", "mutability", "required", "scope", "resources"]) || !identifier(value.gate_id) || !argv(value.argv) || !uniqueIds(value.prerequisites) || !positive(value.wave, 100_000) || !positive(value.reporting_ordinal, 100_000) || !positive(value.timeout_ms, 3_600_000) || !costClass(value.cost_class) || !mutability(value.mutability) || typeof value.required !== "boolean" || !scope(value.scope) || !Array.isArray(value.resources) || value.resources.length !== 1 || !resource(value.resources[0])) throw malformed("execution plan gate is malformed");
  if (canonical(value.argv) !== canonical(["bun", "run", value.gate_id])) throw malformed("execution plan gate argv is not normalized from its gate id");
  const expected = resourcesFor(value.gate_id, value.mutability);
  if (canonical(value.resources) !== canonical(expected)) throw malformed("execution plan gate resources are not derived from mutability");
  return freeze({ ...value, argv: freeze([...value.argv]), prerequisites: freeze([...value.prerequisites]), resources: freeze(value.resources.map((item) => freeze({ ...item }))) }) as unknown as RepoFlightPlanGate;
}
function planProfile(value: unknown): value is RepoFlightUnsignedExecutionPlan["profile"] { return exact(value, ["schema_version", "profile_version", "profile_digest", "context", "max_readers", "failure_policy"]) && value.schema_version === 1 && identifier(value.profile_version) && digestValue(value.profile_digest) && context(value.context) && positive(value.max_readers, 256) && failurePolicy(value.failure_policy); }
function terminalSemantics(value: unknown): value is RepoFlightUnsignedExecutionPlan["terminal_semantics"] { return exact(value, ["failure_policy", "terminal_statuses"]) && failurePolicy(value.failure_policy) && Array.isArray(value.terminal_statuses) && canonical(value.terminal_statuses) === canonical(TERMINAL_STATUSES); }
function signature(value: unknown): value is RepoFlightSignedExecutionPlan["signature"] { return exact(value, ["algorithm", "issuer_id", "value"]) && value.algorithm === "ed25519" && identifier(value.issuer_id) && typeof value.value === "string" && value.value.length >= 80 && value.value.length <= 128; }
function candidate(value: unknown): value is RepoFlightExecutionPlanInput["candidate"] { return exact(value, ["candidate_oid", "input_digest"]) && oid(value.candidate_oid) && digestValue(value.input_digest); }
function toolchain(value: unknown): value is RepoFlightExecutionPlanInput["toolchain"] { return exact(value, ["runtime_id", "runtime_version", "platform", "architecture", "lockfile_digest"]) && [value.runtime_id, value.runtime_version, value.platform, value.architecture].every(identifier) && digestValue(value.lockfile_digest); }
function resource(value: unknown): boolean { return exact(value, ["kind", "key", "mode"]) && ["candidate.snapshot", "workspace.verification", "evidence.publication"].includes(String(value.kind)) && identifier(value.key) && (value.mode === "shared" || value.mode === "exclusive"); }
function argv(value: unknown): value is string[] { return Array.isArray(value) && value.length === 3 && value.every(identifier); }
function compare(findings: RepoFlightShadowMismatch[], code: RepoFlightShadowMismatch["code"], path: string, expected: unknown, actual: unknown): void { if (canonical(expected) !== canonical(actual)) findings.push(freeze({ code, path, expected: canonical(expected), actual: canonical(actual) })); }
function unsignedWithoutDigest<T extends { readonly plan_digest: `sha256:${string}` }>(value: T): Omit<T, "plan_digest"> { const { plan_digest: _digest, ...unsigned } = value; return unsigned; }
function canonicalPlanBytes(value: RepoFlightUnsignedExecutionPlan | RepoFlightSignedExecutionPlan): Buffer { const { signature: _signature, ...unsigned } = value as RepoFlightSignedExecutionPlan; return Buffer.from(canonical(unsigned), "utf8"); }
function canonical(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; }
function digest(value: string): `sha256:${string}` { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function digestValue(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value); }
function oid(value: unknown): value is string { return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value); }
function context(value: unknown): value is RepoFlightExecutionContext { return typeof value === "string" && (CONTEXTS as readonly string[]).includes(value); }
function failurePolicy(value: unknown): value is "fail_fast" | "complete_all" { return typeof value === "string" && (FAILURE_POLICIES as readonly string[]).includes(value); }
function mutability(value: unknown): value is RepoFlightPlanMutability { return typeof value === "string" && (MUTABILITIES as readonly string[]).includes(value); }
function costClass(value: unknown): value is "stop" | "fast" | "full" { return typeof value === "string" && (COST_CLASSES as readonly string[]).includes(value); }
function scope(value: unknown): value is "self" | "target" | "both" { return typeof value === "string" && (SCOPES as readonly string[]).includes(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value); }
function positive(value: unknown, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum; }
function uniqueIds(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 2_000 && value.every(identifier) && new Set(value).size === value.length; }
function plain(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, any> { return plain(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)); }
function malformed(message: string): RepoFlightExecutionPlanError { return new RepoFlightExecutionPlanError("malformed", message); }
function dependency(message: string): RepoFlightExecutionPlanError { return new RepoFlightExecutionPlanError("dependency", message); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
