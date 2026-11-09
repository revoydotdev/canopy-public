import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { verifyRetryContextCapsule, type CampaignRetryContextPort, type RetryContextCapsule } from "@arbor/opencode";

/**
 * Atomic node-scoped persistence for bounded retry capsules. Filenames are
 * digests so campaign/node identifiers can never escape the private store.
 */
export class RetryContextStore implements CampaignRetryContextPort {
  private readonly memory = new Map<string, RetryContextCapsule>();

  constructor(private readonly persistenceDir: string | null) {}

  load(input: { campaign_id: string; node_id: string }): RetryContextCapsule | null {
    const key = this.key(input.campaign_id, input.node_id);
    const cached = this.memory.get(key);
    if (cached) return structuredClone(cached);
    if (this.persistenceDir === null) return null;
    const path = this.path(key);
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!verifyRetryContextCapsule(parsed)) throw new Error("retry-context capsule failed integrity validation");
    if (parsed.identity.campaignId !== input.campaign_id || parsed.identity.nodeId !== input.node_id) {
      throw new Error("retry-context capsule identity does not match its lookup key");
    }
    this.memory.set(key, parsed);
    return structuredClone(parsed);
  }

  save(input: { campaign_id: string; node_id: string; capsule: RetryContextCapsule }): void {
    if (!verifyRetryContextCapsule(input.capsule)) throw new Error("refusing to persist an invalid retry-context capsule");
    if (input.capsule.identity.campaignId !== input.campaign_id || input.capsule.identity.nodeId !== input.node_id) {
      throw new Error("retry-context capsule identity does not match its storage key");
    }
    const key = this.key(input.campaign_id, input.node_id);
    const copy = structuredClone(input.capsule);
    this.memory.set(key, copy);
    if (this.persistenceDir === null) return;
    const directory = join(this.persistenceDir, "retry-context");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = this.path(key);
    const temporary = join(directory, `.${key}.${process.pid}.tmp`);
    writeFileSync(temporary, JSON.stringify(copy), { mode: 0o600 });
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, destination);
  }

  private key(campaignId: string, nodeId: string): string {
    return createHash("sha256").update(`${campaignId}\0${nodeId}`, "utf8").digest("hex");
  }

  private path(key: string): string {
    return join(this.persistenceDir!, "retry-context", `${key}.json`);
  }
}
