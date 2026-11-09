import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { willManageContext } from "@arbor/core";
import { TokenEpochService } from "../src/token-epoch-service.js";

const capability = { provider_id: "provider", model_id: "model", context_capacity: 100, max_output_tokens: 20, source: "runtime" as const };
function temp(run: (directory: string) => void): void { const directory = mkdtempSync(join(tmpdir(), "arbor-epoch-")); try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); } }
function ensure(service: TokenEpochService, expansion = "attempt-1") {
  return service.ensure({ campaign_id: "campaign", node_id: "node", expansion_id: expansion, capability, reserved_output_tokens: 20, requested_output_tokens: 20, prefill: { tokens: 75, source: "provider_counter", counter_id: "counter" } });
}

describe("TokenEpochService", () => {
  it("survives restart and does not double-claim warning or management", () => temp((directory) => {
    const first = new TokenEpochService(directory);
    let epoch = ensure(first);
    epoch = first.claimWarning("campaign", "node", "attempt-1", epoch.revision).epoch;
    const prediction = willManageContext(epoch, 70);
    expect(first.claimManagement("campaign", "node", "attempt-1", prediction, "claim-1").status).toBe("claimed");

    const restarted = new TokenEpochService(directory);
    const recovered = ensure(restarted);
    expect(recovered.management_claim?.claim_id).toBe("claim-1");
    expect(restarted.claimWarning("campaign", "node", "attempt-1", recovered.revision).status).toBe("idempotent");
    expect(restarted.claimManagement("campaign", "node", "attempt-1", willManageContext(recovered, 70), "claim-1").status).toBe("idempotent");
  }));

  it("retains distinct epochs for retry attempts while replay is idempotent", () => temp((directory) => {
    const service = new TokenEpochService(directory);
    const first = ensure(service, "attempt-1");
    expect(ensure(service, "attempt-1")).toEqual(first);
    const retry = ensure(service, "attempt-2");
    expect(retry.epoch_id).not.toBe(first.epoch_id);
    expect(readdirSync(directory).filter((name) => name.endsWith(".json"))).toHaveLength(2);
  }));

  it("persists provider cache usage idempotently", () => temp((directory) => {
    const service = new TokenEpochService(directory);
    ensure(service);
    const usage = { input_tokens: 40, output_tokens: 9, cached_input_tokens: 31, cache_write_input_tokens: 7, counter_source: "provider_counter" as const };
    expect(service.recordUsage("campaign", "node", "attempt-1", usage).status).toBe("recorded");
    expect(service.recordUsage("campaign", "node", "attempt-1", usage).status).toBe("idempotent");
    expect(new TokenEpochService(directory).get("campaign", "node", "attempt-1")?.usage.cached_input_tokens).toBe(31);
  }));

  it("recovers a mid-attempt epoch across restart with usage intact and no double warning", () => temp((directory) => {
    const first = new TokenEpochService(directory);
    ensure(first);
    const usage = { input_tokens: 75, output_tokens: 12, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" as const };
    const recorded = first.recordUsage("campaign", "node", "attempt-1", usage);
    expect(recorded.status).toBe("recorded");

    // Crash/restart before the warning is claimed: usage and revision survive.
    const restarted = new TokenEpochService(directory);
    const recovered = restarted.get("campaign", "node", "attempt-1");
    expect(recovered?.usage).toEqual(usage);
    expect(recovered?.revision).toBe(1);
    expect(recovered?.warning_delivered).toBe(false);
    expect(restarted.claimWarning("campaign", "node", "attempt-1", recovered!.revision).status).toBe("claimed");

    // Second restart: the warning is one-shot, the epoch is unchanged.
    const again = new TokenEpochService(directory);
    const reread = again.get("campaign", "node", "attempt-1");
    expect(reread?.warning_delivered).toBe(true);
    expect(again.claimWarning("campaign", "node", "attempt-1", reread!.revision).status).toBe("idempotent");
    expect(again.get("campaign", "node", "attempt-1")).toEqual(reread);
  }));

  it("quarantines checksummed but structurally invalid nested state", () => temp((directory) => {
    const service = new TokenEpochService(directory);
    ensure(service);
    const path = join(directory, readdirSync(directory).find((name) => name.endsWith(".json"))!);
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.epoch.usage.cached_input_tokens = -1;
    // A malformed writer can recompute checksums; structural validation is independent.
    const { checksum: _old, ...body } = envelope;
    envelope.checksum = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    writeFileSync(path, JSON.stringify(envelope));
    expect(new TokenEpochService(directory).get("campaign", "node", "attempt-1")).toBeUndefined();
    expect(readdirSync(directory).some((name) => name.includes(".corrupt-"))).toBe(true);
  }));
});
