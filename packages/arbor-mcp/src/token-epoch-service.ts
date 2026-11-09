import {
  claimBudgetWarning,
  claimOverflowRetry,
  createExpansionTokenEpoch,
  manageContext,
  recordTokenUsage,
  recordTokenPrefill,
  type ExpansionTokenEpoch,
  type ManageContextResult,
  type ManagementPrediction,
  type ProviderTokenCapability,
  type TokenCount,
  type TokenUsage,
} from "@arbor/core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, closeSync, fsyncSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const FORMAT = "arbor-token-epoch";
const VERSION = 1;

interface EpochEnvelope {
  readonly format: typeof FORMAT;
  readonly version: typeof VERSION;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly expansion_id: string;
  readonly epoch: ExpansionTokenEpoch;
  readonly checksum: string;
}

export interface TokenEpochDiagnostic {
  readonly kind: "corrupt_epoch_quarantined" | "quarantine_failed";
  readonly path: string;
  readonly quarantine_path: string;
  readonly detail: string;
}

export interface EnsureTokenEpochInput {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly expansion_id: string;
  readonly capability: ProviderTokenCapability;
  readonly reserved_output_tokens: number;
  readonly requested_output_tokens: number;
  readonly prefill: TokenCount;
}

/** Durable, optimistic-revision repository for one immutable epoch per node expansion. */
export class TokenEpochService {
  readonly #directory: string;
  readonly #diagnostics: TokenEpochDiagnostic[] = [];

  constructor(directory: string) {
    if (!directory.trim()) throw new Error("token epoch directory must be non-empty");
    this.#directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  diagnostics(): readonly TokenEpochDiagnostic[] {
    return this.#diagnostics.map((item) => ({ ...item }));
  }

  get(campaignId: string, nodeId: string, expansionId: string): ExpansionTokenEpoch | undefined {
    return this.#read(campaignId, nodeId, expansionId);
  }

  ensure(input: EnsureTokenEpochInput): ExpansionTokenEpoch {
    assertIdentity(input.expansion_id, "expansion_id");
    const existing = this.#read(input.campaign_id, input.node_id, input.expansion_id);
    if (existing) return existing;
    const epoch = createExpansionTokenEpoch({
      epoch_id: epochId(input.campaign_id, input.node_id, input.expansion_id),
      capability: input.capability,
      reserved_output_tokens: input.reserved_output_tokens,
      requested_output_tokens: input.requested_output_tokens,
      prefill: input.prefill,
    });
    this.#write(input.campaign_id, input.node_id, input.expansion_id, epoch);
    return epoch;
  }

  claimWarning(campaignId: string, nodeId: string, expansionId: string, expectedRevision: number): { status: "claimed" | "idempotent" | "conflict"; epoch: ExpansionTokenEpoch } {
    const epoch = this.#required(campaignId, nodeId, expansionId);
    if (epoch.warning_delivered) return { status: "idempotent", epoch };
    if (epoch.revision !== expectedRevision) return { status: "conflict", epoch };
    const next = claimBudgetWarning(epoch);
    this.#write(campaignId, nodeId, expansionId, next);
    return { status: "claimed", epoch: next };
  }

  claimOverflowRetry(campaignId: string, nodeId: string, expansionId: string): { status: "claimed" | "exhausted"; epoch: ExpansionTokenEpoch } {
    const epoch = this.#required(campaignId, nodeId, expansionId);
    const result = claimOverflowRetry(epoch);
    if (result.status === "claimed") this.#write(campaignId, nodeId, expansionId, result.epoch);
    return result;
  }

  recordPrefill(campaignId: string, nodeId: string, expansionId: string, prefill: TokenCount): { status: "recorded" | "idempotent"; epoch: ExpansionTokenEpoch } {
    const epoch = this.#required(campaignId, nodeId, expansionId);
    const next = recordTokenPrefill(epoch, prefill);
    if (next === epoch) return { status: "idempotent", epoch };
    this.#write(campaignId, nodeId, expansionId, next);
    return { status: "recorded", epoch: next };
  }

  claimManagement(campaignId: string, nodeId: string, expansionId: string, prediction: ManagementPrediction, claimId: string): ManageContextResult {
    const epoch = this.#required(campaignId, nodeId, expansionId);
    const result = manageContext(epoch, prediction, claimId);
    if (result.status === "claimed") this.#write(campaignId, nodeId, expansionId, result.epoch);
    return result;
  }

  recordUsage(campaignId: string, nodeId: string, expansionId: string, usage: TokenUsage, expectedRevision?: number): { status: "recorded" | "idempotent" | "conflict"; epoch: ExpansionTokenEpoch } {
    const epoch = this.#required(campaignId, nodeId, expansionId);
    if (expectedRevision !== undefined && epoch.revision !== expectedRevision) return { status: "conflict", epoch };
    const next = recordTokenUsage(epoch, usage);
    if (next === epoch) return { status: "idempotent", epoch };
    this.#write(campaignId, nodeId, expansionId, next);
    return { status: "recorded", epoch: next };
  }

  #required(campaignId: string, nodeId: string, expansionId: string): ExpansionTokenEpoch {
    const epoch = this.#read(campaignId, nodeId, expansionId);
    if (!epoch) throw new Error(`token epoch not found for ${campaignId}/${nodeId}`);
    return epoch;
  }

  #read(campaignId: string, nodeId: string, expansionId: string): ExpansionTokenEpoch | undefined {
    const path = this.#path(campaignId, nodeId, expansionId);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as EpochEnvelope;
      validateEnvelope(parsed, campaignId, nodeId, expansionId);
      return freezeEpoch(parsed.epoch);
    } catch (error) {
      const quarantine = `${path}.corrupt-${Date.now()}-${process.pid}`;
      try {
        renameSync(path, quarantine);
        this.#diagnostics.push({ kind: "corrupt_epoch_quarantined", path, quarantine_path: quarantine, detail: error instanceof Error ? error.message : String(error) });
      } catch (quarantineError) {
        this.#diagnostics.push({ kind: "quarantine_failed", path, quarantine_path: quarantine, detail: quarantineError instanceof Error ? quarantineError.message : String(quarantineError) });
      }
      return undefined;
    }
  }

  #write(campaignId: string, nodeId: string, expansionId: string, epoch: ExpansionTokenEpoch): void {
    const path = this.#path(campaignId, nodeId, expansionId);
    const body: Omit<EpochEnvelope, "checksum"> = { format: FORMAT, version: VERSION, campaign_id: campaignId, node_id: nodeId, expansion_id: expansionId, epoch };
    const envelope: EpochEnvelope = { ...body, checksum: digest(body) };
    atomicWrite(path, `${JSON.stringify(envelope)}\n`);
  }

  #path(campaignId: string, nodeId: string, expansionId: string): string {
    const key = createHash("sha256").update(`${campaignId}\0${nodeId}\0${expansionId}`).digest("hex");
    return join(this.#directory, `${key}.json`);
  }
}

function epochId(campaignId: string, nodeId: string, expansionId: string): string {
  return `expansion:${campaignId}:${nodeId}:${expansionId}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateEnvelope(value: EpochEnvelope, campaignId: string, nodeId: string, expansionId: string): void {
  if (!value || value.format !== FORMAT || value.version !== VERSION) throw new Error("unsupported token epoch envelope");
  if (value.campaign_id !== campaignId || value.node_id !== nodeId || value.expansion_id !== expansionId) throw new Error("token epoch identity mismatch");
  const { checksum: _checksum, ...body } = value;
  if (value.checksum !== digest(body)) throw new Error("token epoch checksum mismatch");
  const epoch = value.epoch;
  if (!epoch || typeof epoch.epoch_id !== "string" || !nonNegative(epoch.revision)) throw new Error("invalid token epoch payload");
  if (epoch.epoch_id !== epochId(campaignId, nodeId, expansionId)) throw new Error("token epoch id mismatch");
  if (!["runtime", "snapshot", "configured"].includes(epoch.capability_source)) throw new Error("invalid capability source");
  if (!["requested", "provider_capability"].includes(epoch.output_limit_source)) throw new Error("invalid output limit source");
  if (!positive(epoch.context_capacity) || !nonNegative(epoch.reserved_output_tokens) || !nonNegative(epoch.eligible_input_tokens) || epoch.reserved_output_tokens + epoch.eligible_input_tokens !== epoch.context_capacity) throw new Error("invalid context capacity invariant");
  if (!nonNegative(epoch.applied_output_tokens) || epoch.applied_output_tokens > epoch.reserved_output_tokens) throw new Error("invalid output budget invariant");
  if (typeof epoch.provider_id !== "string" || !epoch.provider_id.trim() || typeof epoch.model_id !== "string" || !epoch.model_id.trim()) throw new Error("invalid provider identity");
  if (!epoch.prefill || !nonNegative(epoch.prefill.tokens) || !["provider_counter", "character_fallback"].includes(epoch.prefill.source)) throw new Error("invalid prefill count");
  if (epoch.prefill.source === "provider_counter" && !("counter_id" in epoch.prefill && typeof epoch.prefill.counter_id === "string" && epoch.prefill.counter_id.trim())) throw new Error("invalid provider counter");
  if (epoch.prefill.source === "character_fallback" && !("characters_per_token" in epoch.prefill && typeof epoch.prefill.characters_per_token === "number" && epoch.prefill.characters_per_token > 0)) throw new Error("invalid fallback counter");
  if (!epoch.usage || !nonNegative(epoch.usage.input_tokens) || !nonNegative(epoch.usage.output_tokens) || !nonNegative(epoch.usage.cached_input_tokens) || !nonNegative(epoch.usage.cache_write_input_tokens) || !["provider_counter", "character_fallback"].includes(epoch.usage.counter_source)) throw new Error("invalid token usage");
  if (typeof epoch.warning_delivered !== "boolean") throw new Error("invalid warning marker");
  if (epoch.overflow_retry_claimed !== undefined && typeof epoch.overflow_retry_claimed !== "boolean") throw new Error("invalid overflow retry marker");
  if (epoch.management_claim && (typeof epoch.management_claim.claim_id !== "string" || !epoch.management_claim.claim_id.trim() || !nonNegative(epoch.management_claim.epoch_revision) || !nonNegative(epoch.management_claim.active_tokens_before) || epoch.management_claim.epoch_revision >= epoch.revision)) throw new Error("invalid management claim");
}

function assertIdentity(value: string, label: string): void { if (!value.trim()) throw new Error(`${label} must be non-empty`); }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }

function freezeEpoch(epoch: ExpansionTokenEpoch): ExpansionTokenEpoch {
  return Object.freeze({
    ...epoch,
    prefill: Object.freeze({ ...epoch.prefill }),
    usage: Object.freeze({ ...epoch.usage }),
    ...(epoch.management_claim ? { management_claim: Object.freeze({ ...epoch.management_claim }) } : {}),
  });
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  const file = openSync(temporary, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
