import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const provenance = { tag: "claimed" as const, claimant: "budget-policy" };

describe("native.budget.get", () => {
  it("returns typed unconfigured absence rather than an invented zero allocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-budget-projection-"));
    try {
      const router = new RuntimeCatalogRouter(new ArborRuntime({ persistence_dir: directory }));
      expect(router.executeQuery({ schema_version: 1, query_id: "none", query: { kind: "native.budget.get", campaign_id: "campaign" } }))
        .toEqual({ ok: true, capability: "campaign.read", value: { availability: "unconfigured", campaign_id: "campaign" } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("projects the durable authority snapshot, including reservations, through the canonical query", () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-budget-projection-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: directory });
      const initialized = runtime.nativeCampaignBudget.initialize("campaign", {
        max_tokens: 100,
        max_cost: { kind: "priced", currency: "USD", minor_units: 99, minor_unit_exponent: 2, price_source_id: "static-test" },
        provenance,
      });
      const reserved = runtime.nativeCampaignBudget.reserve({
        campaign_id: "campaign", expected_revision: initialized.revision, reservation_id: "r1", session_id: "session-1",
        estimate: { tokens: { kind: "measured", input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0 }, cost: { kind: "priced", currency: "USD", minor_units: 30, minor_unit_exponent: 2, price_source_id: "static-test" } },
        provenance,
      });
      expect(reserved.status).toBe("reserved");
      const result = new RuntimeCatalogRouter(runtime).executeQuery({ schema_version: 1, query_id: "configured", query: { kind: "native.budget.get", campaign_id: "campaign" } });
      expect(result).toMatchObject({
        ok: true, capability: "campaign.read", value: {
          availability: "configured", campaign_id: "campaign", revision: 1,
          consumed_tokens: 0, reserved_tokens: 30, remaining_tokens: 70,
          reservations: [{ reservation_id: "r1", session_id: "session-1", state: "reserved" }],
        },
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects an empty campaign identity before reading the durable store", () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-budget-projection-"));
    try {
      const router = new RuntimeCatalogRouter(new ArborRuntime({ persistence_dir: directory }));
      expect(router.executeQuery({ schema_version: 1, query_id: "invalid", query: { kind: "native.budget.get", campaign_id: " " } }))
        .toMatchObject({ ok: false, capability: "campaign.read", error: { code: "validation" } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
