/**
 * Proposal §5.3 rule 2 — "derived, never constant" — at the dispatch
 * layer, plus the trust-boundary claim that a handler proposes a tropism
 * rather than asserting one.
 *
 * The mechanism under test is a per-session claim on each derivation. It is
 * the whole of what keeps a per-turn trigger from becoming a per-turn
 * prompt tax: a tropism whose `derived_from` did not change is already in
 * the model's context, so re-rendering it buys nothing and costs a
 * re-read of the same bytes on every subsequent turn.
 *
 * Every assertion here is on what the *bus* decided — the returned scope
 * and the ledger row — never on handler output, because a handler that
 * could assert its own validity would make this whole file vacuous.
 */
import { describe, expect, it } from "vitest";
import type { Tropism, TropismScope } from "@arbor/prompts";
import { HookBus } from "../../src/hooks/bus.js";
import { HookCatalog } from "../../src/hooks/catalog.js";
import type { HookHandlerRegistry, HookInjectHandler } from "../../src/hooks/contracts.js";

const tropism = (overrides: Partial<Tropism> = {}): Tropism => ({
  id: "orient", trigger: "session_start", lane: "ADVISORY", provenance: "generated",
  derived_from: ["ring:a1b2c3"], body: "Leased node n-7.", expires_after_turns: 3, enforcing_ref: null, ...overrides,
});

const wire = (handler: HookInjectHandler, hookId = "orient-tropism") => {
  const handlers: HookHandlerRegistry = { "inject.orient": { kind: "inject", handler } };
  const catalog = new HookCatalog({ handlers });
  catalog.register(JSON.stringify({ schema_version: 1, hook_id: hookId, version: "1.0.0", kind: "inject", event: "session_start", handler_ref: "inject.orient", why: "inject the session's current state as advisory prompt context" }));
  return new HookBus({ catalog, handlers });
};

const at = (bus: HookBus, turn: number): Promise<TropismScope> => bus.injectForSession("session_start", { session_id: "s-1", campaign_id: "c-1", node_id: "n-1", turn });

describe("inject lane — proposal §5.3 rule 2", () => {
  it("(iv) renders one block for two injections with an identical derived_from", async () => {
    const bus = wire(() => tropism());
    expect((await at(bus, 0)).content).toContain("Leased node n-7.");
    expect((await at(bus, 1)).content).toBe("");
  });

  it("records the derivation on the fired row so rule 2 is auditable from the ledger", async () => {
    const bus = wire(() => tropism());
    await at(bus, 0);
    await at(bus, 1);
    const injected = bus.ledger().find((entry) => entry.evidence_ref.includes("injected=orient"));
    const deduped = bus.ledger().find((entry) => entry.evidence_ref.includes("deduped=orient"));
    expect(injected?.derived_from).toEqual(["ring:a1b2c3"]);
    expect(deduped?.derived_from).toEqual(["ring:a1b2c3"]);
  });

  it("re-injects once the tropism's own expiry window has closed", async () => {
    const bus = wire(() => tropism({ expires_after_turns: 2 }));
    expect((await at(bus, 0)).content).not.toBe("");
    expect((await at(bus, 1)).content).toBe("");
    expect((await at(bus, 2)).content).not.toBe("");
  });

  it("treats a changed derivation as immediately fresh, whatever the clock", async () => {
    let generation = 0;
    const bus = wire(() => tropism({ derived_from: [`ring:gen-${generation}`] }));
    expect((await at(bus, 0)).content).not.toBe("");
    expect((await at(bus, 1)).content).toBe("");
    generation = 1;
    expect((await at(bus, 1)).content).not.toBe("");
  });

  it("keeps two tropisms sharing one ring event — the fingerprint is composite, not the derivation alone", async () => {
    const handlers: HookHandlerRegistry = {
      "inject.orient": { kind: "inject", handler: () => tropism({ id: "orient" }) },
      "inject.sink": { kind: "inject", handler: () => tropism({ id: "sink", body: "Evidence is stale." }) },
    };
    const catalog = new HookCatalog({ handlers });
    for (const hookId of ["orient-tropism", "sink-tropism"]) {
      catalog.register(JSON.stringify({ schema_version: 1, hook_id: hookId, version: "1.0.0", kind: "inject", event: "session_start", handler_ref: `inject.${hookId === "orient-tropism" ? "orient" : "sink"}`, why: "inject session state" }));
    }
    const bus = new HookBus({ catalog, handlers });
    const scope = await at(bus, 0);
    expect(scope.content).toContain("orient");
    expect(scope.content).toContain("Evidence is stale.");
  });

  it("keeps the dedupe per session — one session's derivation never suppresses another's", async () => {
    const bus = wire(() => tropism());
    expect((await at(bus, 0)).content).not.toBe("");
    const other = await bus.injectForSession("session_start", { session_id: "s-2", campaign_id: "c-1", node_id: "n-1", turn: 0 });
    expect(other.content).toContain("Leased node n-7.");
  });

  it("renders nothing when the handler returns null — the ordinary case", async () => {
    const bus = wire(() => null);
    expect((await at(bus, 0)).content).toBe("");
    expect(bus.ledger()).toMatchObject([{ decision: "observed" }]);
  });

  it("renders nothing when no inject hook is declared", async () => {
    const catalog = new HookCatalog();
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "audit", version: "1.0.0", kind: "observe", event: "tool_audit", handler_ref: "observe.tool-audit-notes", why: "unrelated" }));
    expect((await new HookBus({ catalog }).injectForSession("session_start", { session_id: "s-1", campaign_id: "c-1", node_id: "n-1", turn: 0 })).content).toBe("");
  });
});

describe("inject lane — the bus, not the handler, validates", async () => {
  it("drops an imperative ADVISORY tropism the handler nonetheless returned", async () => {
    const bus = wire(() => tropism({ body: "Always run gate:all." }));
    expect((await at(bus, 0)).content).toBe("");
    expect(bus.ledger()[0]?.evidence_ref).toContain("refused=advisory_imperative");
  });

  it("drops a CODE tropism with no enforcing_ref", async () => {
    const bus = wire(() => tropism({ lane: "CODE", enforcing_ref: null, body: "Run gate:all." }));
    expect((await at(bus, 0)).content).toBe("");
    expect(bus.ledger()[0]?.evidence_ref).toContain("refused=code_unenforced");
  });

  it("keeps firing the hook after a refusal — a bad tropism is a firing outcome, not a dead descriptor", async () => {
    const bus = wire(() => tropism({ lane: "CODE", enforcing_ref: null, body: "Run gate:all." }));
    await at(bus, 0);
    expect(bus.neverFired()).toEqual([]);
  });

  it("fails closed on a throwing handler rather than rendering a half-built block", async () => {
    const bus = wire(() => { throw new Error("handler exploded"); });
    expect((await at(bus, 0)).content).toBe("");
    expect(bus.ledger()[0]?.evidence_ref).toContain("error=hook_handler_failed");
  });

  it("cannot be wired to a veto-shaped handler", () => {
    const handlers: HookHandlerRegistry = { "veto.deny-shell-execute": { kind: "veto", handler: () => ({ allow: true }) } };
    const catalog = new HookCatalog({ handlers });
    expect(() => catalog.register(JSON.stringify({ schema_version: 1, hook_id: "escalate", version: "1.0.0", kind: "inject", event: "session_start", handler_ref: "veto.deny-shell-execute", why: "try to gain a decision" })))
      .toThrowError(expect.objectContaining({ code: "hook_escalation" }));
  });
});
