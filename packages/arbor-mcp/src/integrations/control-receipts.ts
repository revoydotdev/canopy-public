/**
 * Durable receipts for the product integration control plane.
 *
 * Every authorized-or-refused `integration.*` lifecycle command and every
 * `remote.control` / `scheduler.control` command appends exactly one receipt
 * naming the operation, the actor, the governed target, the observed state
 * before and after, and — for a refusal — the bounded reason. Receipts form a
 * hash chain so a rewritten or truncated history is detected on replay rather
 * than silently projected. The journal is a record of what the control plane
 * did; it grants no authority and is never consulted to decide a command.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactNativeText } from "@arbor/harness";

export type IntegrationControlKind =
  | "integration.install" | "integration.enable" | "integration.disable" | "integration.update" | "integration.rollback"
  | "remote.control" | "scheduler.control";

/** Review-safe scalar facts about the governed target; never credentials or key material. */
export type IntegrationControlSnapshot = Readonly<Record<string, string | number | boolean | null>>;

export interface IntegrationControlReceipt {
  readonly schema_version: 1;
  readonly sequence: number;
  readonly receipt_id: string;
  readonly kind: IntegrationControlKind;
  /** The governed integration: the integration id, or `remote.control` / `scheduler.control`. */
  readonly integration_id: string;
  /** The exact object acted on: the integration id, remote session id, or schedule id. */
  readonly target_id: string;
  readonly action: string | null;
  readonly operation_id: string;
  readonly actor_id: string;
  readonly outcome: "applied" | "refused";
  readonly refusal: { readonly code: string; readonly summary: string } | null;
  readonly before: IntegrationControlSnapshot | null;
  readonly after: IntegrationControlSnapshot | null;
  readonly at: string;
  readonly previous_hash: string | null;
  readonly content_hash: string;
}

export type IntegrationControlReceiptInput = Omit<IntegrationControlReceipt, "schema_version" | "sequence" | "receipt_id" | "at" | "previous_hash" | "content_hash">;

export const INTEGRATION_CONTROL_RECEIPT_FILE = "integration-control-receipts.ndjson";
const MAX_PROJECTED_RECEIPTS = 50;

export class IntegrationControlReceiptJournal {
  private receipts: IntegrationControlReceipt[] = [];
  private readonly file: string | null;
  private readonly clock: () => Date;

  constructor(options: { readonly persistence_dir?: string | null; readonly clock?: () => Date } = {}) {
    this.file = options.persistence_dir ? join(options.persistence_dir, INTEGRATION_CONTROL_RECEIPT_FILE) : null;
    this.clock = options.clock ?? (() => new Date());
    this.reload();
  }

  /**
   * Appends one receipt. The durable file is re-read first so a second
   * process (each `arbor integration` CLI call is its own runtime) extends
   * the same chain instead of forking it.
   */
  append(input: IntegrationControlReceiptInput): IntegrationControlReceipt {
    this.reload();
    const refusal = input.refusal === null ? null : { code: input.refusal.code, summary: redactNativeText(input.refusal.summary).slice(0, 512) };
    const base = {
      schema_version: 1 as const,
      sequence: this.receipts.length + 1,
      kind: input.kind,
      integration_id: input.integration_id.slice(0, 128),
      target_id: input.target_id.slice(0, 128),
      action: input.action,
      operation_id: input.operation_id.slice(0, 256),
      actor_id: input.actor_id.slice(0, 256),
      outcome: input.outcome,
      refusal,
      before: input.before,
      after: input.after,
      at: this.clock().toISOString(),
      previous_hash: this.receipts.at(-1)?.content_hash ?? null,
    };
    const content_hash = sha256(JSON.stringify(base));
    const receipt: IntegrationControlReceipt = Object.freeze({ ...base, receipt_id: `icr:${content_hash.slice("sha256:".length, "sha256:".length + 24)}`, content_hash });
    if (this.file !== null) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    }
    this.receipts.push(receipt);
    return receipt;
  }

  /** The most recent receipts for one governed integration, oldest first. */
  list(integrationId?: string): readonly IntegrationControlReceipt[] {
    this.reload();
    const matching = integrationId === undefined ? this.receipts : this.receipts.filter((receipt) => receipt.integration_id === integrationId);
    return Object.freeze(matching.slice(-MAX_PROJECTED_RECEIPTS));
  }

  private reload(): void {
    if (this.file === null || !existsSync(this.file)) return;
    const replayed: IntegrationControlReceipt[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n").filter(Boolean)) {
      const receipt = JSON.parse(line) as IntegrationControlReceipt;
      const { receipt_id, content_hash, ...rest } = receipt;
      const base = {
        schema_version: rest.schema_version, sequence: rest.sequence, kind: rest.kind, integration_id: rest.integration_id, target_id: rest.target_id,
        action: rest.action, operation_id: rest.operation_id, actor_id: rest.actor_id, outcome: rest.outcome, refusal: rest.refusal,
        before: rest.before, after: rest.after, at: rest.at, previous_hash: rest.previous_hash,
      };
      if (receipt.schema_version !== 1 || receipt.sequence !== replayed.length + 1 || receipt.previous_hash !== (replayed.at(-1)?.content_hash ?? null)
        || sha256(JSON.stringify(base)) !== content_hash || receipt_id !== `icr:${content_hash.slice("sha256:".length, "sha256:".length + 24)}`) {
        throw new Error("integration control receipt journal integrity failure");
      }
      replayed.push(Object.freeze(receipt));
    }
    this.receipts = replayed;
  }
}

function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
