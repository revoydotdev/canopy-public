/**
 * ADR-028: capability enforcement at revoy2-owned mutating surfaces.
 *
 * ADR-024 ratified the *host* tool-dispatch boundary and explicitly refused to
 * let that answer cover revoy2's own mutating catalog surfaces, recording them
 * as "a deferred decision, not a ratified non-goal". The decision was taken on
 * 2026-08-06: wire `enforceAction` into `RuntimeCatalogRouter`.
 *
 * These tests exist because the defect ADR-028 closes (G-14) was precisely a
 * gate that was built, tested in isolation, and never consulted by the thing it
 * was meant to protect. Re-asserting `enforceAction`'s own behaviour here would
 * reproduce that mistake, so the enforcement cases all go through a real router
 * dispatch and observe the decision the router actually made.
 *
 * The claim has two halves, checked separately because they fail differently:
 *  - *totality* — every mutating kind maps to a gated action class. Structural,
 *    checked against the real catalog.
 *  - *enforcement* — the router consults that mapping before acting. Behavioural,
 *    checked end-to-end on both command dispatch paths.
 */
import { describe, expect, it } from "vitest";
import { isMutating, RuntimeEventStream, TaskSupervisor, type Action } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import { RUNTIME_CATALOG, RuntimeCatalogRouter, catalogActionClass } from "../src/runtime-catalog.js";
import type { RuntimeRouterOptions } from "../src/runtime-catalog.js";

const root: Action = {
  description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
};

const metadata = {
  operation_id: "op-1",
  idempotency_key: "key-1",
  correlation_id: "correlation-1",
  actor_id: "operator",
  requested_at: "2026-08-01T00:00:00.000Z",
};

function makeRouter(options: RuntimeRouterOptions = {}): RuntimeCatalogRouter {
  const manager = new CampaignManager();
  const supervisor = new TaskSupervisor();
  const events = new RuntimeEventStream("runtime");
  manager.startCampaign("campaign", "plan.md", root);
  return new RuntimeCatalogRouter(
    new ArborRuntime({ manager, supervisor, event_stream: events }),
    options,
  );
}

/**
 * A permission refusal reaches the caller two different ways: `dispatchCommand`
 * returns a rejected *acknowledgement* (`ok: true`, `accepted: false`), while
 * `dispatchInterruption` returns a failed *result* (`ok: false`). Normalizing
 * here keeps each test asserting on the refusal itself rather than on which
 * path happened to produce it.
 */
function refusal(result: unknown): { code?: string; summary?: string } | null {
  const outer = result as { ok?: boolean; error?: { code?: string; summary?: string }; value?: unknown };
  if (outer.ok === false) return outer.error ?? null;
  const value = outer.value as { accepted?: boolean; error?: { code?: string; summary?: string } } | undefined;
  if (value && value.accepted === false) return value.error ?? null;
  return null;
}


/**
 * A well-formed mutating command. Shape matters: validation runs before the
 * tier gate, so a malformed payload would produce a `validation` refusal and
 * silently prove nothing about enforcement.
 */
function pruneCommand() {
  return {
    schema_version: 1,
    metadata,
    command: { kind: "tree.prune" as const, campaign_id: "campaign", node_id: "root" },
  };
}

describe("ADR-028 totality — every mutating kind maps to a gated action class", () => {
  it("classifies every supported command as the mutating class, with none exempt", async () => {
    const commands = RUNTIME_CATALOG.filter((entry) => entry.direction === "command" && entry.supported);
    expect(commands.length).toBeGreaterThan(20);

    for (const entry of commands) {
      const actionClass = catalogActionClass(entry);
      expect(actionClass, `${entry.kind} must be a mutating class`).toBe("preview-confirm");
      expect(isMutating(actionClass), `${entry.kind} must be gated as mutating`).toBe(true);
    }
  });

  it("classifies every query as a read, so the gate does not lock out reading", async () => {
    for (const entry of RUNTIME_CATALOG.filter((e) => e.direction === "query")) {
      expect(catalogActionClass(entry), `${entry.kind} must be a read`).toBe("read");
      expect(isMutating(catalogActionClass(entry))).toBe(false);
    }
  });

  it("covers the whole catalog — no entry falls outside the mapping", async () => {
    for (const entry of RUNTIME_CATALOG) {
      expect(["read", "preview-confirm"]).toContain(catalogActionClass(entry));
    }
  });
});

describe("ADR-028 enforcement — the router consults the gate before acting", () => {
  it("refuses a junior caller's mutating command, blaming the tier rather than a capability", async () => {
    const denial = refusal(await makeRouter({ caller_tier: "junior" }).dispatchCommand(pruneCommand()));

    expect(denial).not.toBeNull();
    expect(denial?.code).toBe("permission");
    // The distinction matters: a junior caller holding every capability in the
    // catalog must still be refused, so the message must not blame capabilities.
    expect(denial?.summary).toContain("junior");
    expect(denial?.summary).not.toContain("missing capability");
  });

  it("does not escalate authority after repeated transient command failures", async () => {
    const router = makeRouter({ caller_tier: "junior" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const command = pruneCommand();
      const denial = refusal(await router.dispatchCommand({
        ...command,
        metadata: { ...command.metadata, operation_id: `transient-${attempt}`, idempotency_key: `transient-key-${attempt}` },
      }));
      expect(denial).toMatchObject({ code: "permission" });
      expect(denial?.summary).toContain("junior");
    }
  });

  it("does not refuse a senior caller on tier — the gate discriminates, it does not simply block", async () => {
    const denial = refusal(await makeRouter({ caller_tier: "senior" }).dispatchCommand(pruneCommand()));

    // Asserting "not refused on permission" rather than "accepted": whether the
    // prune itself succeeds is the manager's business, not this gate's, and
    // pinning it here would couple this test to unrelated domain rules.
    expect(denial?.code).not.toBe("permission");
  });

  it("refuses a junior caller on the interruption path too, which reports failures a different way", async () => {
    const denial = refusal(await makeRouter({ caller_tier: "junior" }).dispatchCommand({
      schema_version: 1,
      // The interruption path additionally requires expected_version.
      metadata: { ...metadata, expected_version: "v1" },
      command: {
        kind: "tree.interrupt" as const,
        campaign_id: "campaign",
        node_id: "root",
        scope: "subtree" as const,
        reason: "operator stop",
        provenance: { tag: "claimed" as const, claimant: "operator" },
      },
    }));

    expect(denial).not.toBeNull();
    expect(denial?.code).toBe("permission");
    expect(denial?.summary).toContain("junior");
  });

  it("still lets a junior caller read", async () => {
    const result = makeRouter({ caller_tier: "junior" }).executeQuery({
      schema_version: 1,
      query_id: "campaigns",
      query: { kind: "campaign.list", limit: 10 },
    });

    expect((result as { ok: boolean }).ok).toBe(true);
  });

  it("defaults to senior, so every existing composition root keeps working untouched", async () => {
    const denial = refusal(await makeRouter().dispatchCommand(pruneCommand()));
    expect(denial?.code).not.toBe("permission");
  });

  it("keeps the capability policy live and independent of tier", async () => {
    // A senior caller who was not granted the capability is refused on the
    // capability, proving both checks run rather than one shadowing the other.
    const denial = refusal(
      await makeRouter({ caller_tier: "senior", granted_capabilities: new Set<string>() }).dispatchCommand(pruneCommand()),
    );

    expect(denial?.summary).toContain("missing capability");
  });
});
