import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_HOOK_DESCRIPTORS, HookCatalog } from "../../src/hooks/catalog.js";
import { TROPISM_BYTE_BUDGET } from "@arbor/prompts";
import { HOOK_ALL_EVENTS, HookCatalogError, type HookHandlerRegistry } from "../../src/hooks/contracts.js";

const descriptor = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1, hook_id: "deny-shell", version: "1.0.0", kind: "veto", event: "tool_preflight",
  handler_ref: "veto.deny-shell-execute", why: "block shell execution regardless of approval policy", ...overrides,
});
const bytes = (value: unknown): string => JSON.stringify(value);

describe("HookCatalog", () => {
  it("loads a valid frozen descriptor from the governed directory", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-hooks-")); const directory = join(root, ".arbor", "hooks"); mkdirSync(directory, { recursive: true });
    try {
      writeFileSync(join(directory, "deny-shell@1.0.0.json"), bytes(descriptor()));
      const catalog = HookCatalog.fromDirectory(directory); const hook = catalog.resolve("deny-shell", "1.0.0");
      expect(hook).toMatchObject({ hook_id: "deny-shell", version: "1.0.0", kind: "veto", event: "tool_preflight", handler_ref: "veto.deny-shell-execute" });
      expect(Object.isFrozen(hook)).toBe(true);
      expect(catalog.diagnostics()).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("redacts a secret-shaped why field before it is retained", () => {
    const catalog = new HookCatalog();
    const hook = catalog.register(bytes(descriptor({ why: "token=abcd1234efgh5678 must be denied" })));
    expect(hook.why).not.toContain("abcd1234efgh5678");
  });

  it.each([
    ["hook_escalation", { kind: "veto", event: "session_start", handler_ref: "veto.deny-shell-execute" }, "a veto kind may not fire at a lifecycle event"],
    ["hook_escalation", { kind: "observe", event: "tool_preflight", handler_ref: "observe.tool-audit-notes" }, "an observe kind may not fire pre-tool"],
    ["hook_escalation", { kind: "lifecycle", event: "node_start", handler_ref: "lifecycle.deny-session-start" }, "only session_start may bind a deny-capable lifecycle handler"],
    ["hook_escalation", { kind: "veto", event: "tool_preflight", handler_ref: "observe.tool-audit-notes" }, "handler_ref kind must match the descriptor kind"],
    ["contract", { handler_ref: "veto.not-a-real-handler" }, "handler_ref must be in the closed registry"],
    ["version", { version: "01.0.0" }, "version must be canonical SemVer"],
    ["kind", { kind: "mutate" }, "kind must be one of the three closed kinds"],
    ["identity", { hook_id: "Deny-Shell" }, "hook_id must be bounded canonical kebab-case"],
  ])("rejects %s descriptors with a typed error (%s)", (code, override, _why) => {
    const catalog = new HookCatalog();
    try { catalog.register(bytes(descriptor(override))); throw new Error("expected validation failure"); }
    catch (error) { expect(error).toBeInstanceOf(HookCatalogError); expect((error as HookCatalogError).code).toBe(code); }
  });

  it("accepts a lifecycle hook at session_start bound to a plain observe-only handler", () => {
    const catalog = new HookCatalog();
    const hook = catalog.register(bytes(descriptor({ hook_id: "note-session-start", kind: "lifecycle", event: "session_start", handler_ref: "lifecycle.session-boundary-notes" })));
    expect(hook.handler_ref).toBe("lifecycle.session-boundary-notes");
  });

  it("accepts a lifecycle hook at a non-start event bound to the observe-only handler", () => {
    const catalog = new HookCatalog();
    const hook = catalog.register(bytes(descriptor({ hook_id: "note-node-start", kind: "lifecycle", event: "node_start", handler_ref: "lifecycle.session-boundary-notes" })));
    expect(hook.event).toBe("node_start");
  });

  it("treats changed bytes for one immutable identity as a conflict", () => {
    const catalog = new HookCatalog(); catalog.register(bytes(descriptor()));
    expect(() => catalog.register(bytes(descriptor({ why: "a different, still valid rationale for the same identity" })))).toThrowError(expect.objectContaining({ code: "immutable_conflict" }));
  });

  it("requires the filename to match hook_id@version.json for governed files", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-hooks-name-")); const directory = join(root, ".arbor", "hooks"); mkdirSync(directory, { recursive: true });
    try {
      writeFileSync(join(directory, "wrong-name.json"), bytes(descriptor()));
      const catalog = HookCatalog.fromDirectory(directory);
      expect(catalog.list()).toEqual([]);
      expect(catalog.diagnostics()).toMatchObject([{ source: "wrong-name.json", code: "identity" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("captures malformed governed files as bounded diagnostics and exposes no hook", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-hooks-bad-")); const directory = join(root, ".arbor", "hooks"); mkdirSync(directory, { recursive: true });
    try {
      writeFileSync(join(directory, "broken@1.0.0.json"), "{not-json"); const catalog = HookCatalog.fromDirectory(directory);
      expect(catalog.list()).toEqual([]); expect(catalog.diagnostics()).toMatchObject([{ source: "broken@1.0.0.json", code: "malformed" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a directory with more descriptors than the bound", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-hooks-bound-")); const directory = join(root, ".arbor", "hooks"); mkdirSync(directory, { recursive: true });
    try {
      for (let index = 0; index < 65; index += 1) writeFileSync(join(directory, `h${index}@1.0.0.json`), bytes(descriptor({ hook_id: `h${index}` })));
      const catalog = HookCatalog.fromDirectory(directory);
      expect(catalog.list()).toEqual([]);
      expect(catalog.diagnostics()).toMatchObject([{ code: "descriptor_bound" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an oversized descriptor", () => {
    const catalog = new HookCatalog();
    expect(() => catalog.register(bytes(descriptor({ why: "x".repeat(3 * 1024) })))).toThrowError(expect.objectContaining({ code: "malformed" }));
  });

  it("resolves an unknown identity to null rather than throwing", () => {
    const catalog = new HookCatalog();
    expect(catalog.resolve("nope", "1.0.0")).toBeNull();
  });

  // WA-43/J3-23: the documented default hook set must itself be a valid,
  // loadable governed directory -- proves the descriptors this module hands
  // to project enrollment/repair are real, not aspirational JSON.
  it("materializes a documented default hook set that loads cleanly from a directory", () => {
    expect(DEFAULT_HOOK_DESCRIPTORS.length).toBeGreaterThanOrEqual(2);
    const root = mkdtempSync(join(tmpdir(), "arbor-hooks-defaults-")); const directory = join(root, ".arbor", "hooks"); mkdirSync(directory, { recursive: true });
    try {
      for (const descriptor of DEFAULT_HOOK_DESCRIPTORS) writeFileSync(join(directory, descriptor.filename), descriptor.contents);
      const catalog = HookCatalog.fromDirectory(directory);
      expect(catalog.diagnostics()).toEqual([]);
      expect(catalog.list()).toHaveLength(DEFAULT_HOOK_DESCRIPTORS.length);
      expect(catalog.list().some((hook) => hook.event === "plan_confirm")).toBe(true);
      expect(catalog.list().some((hook) => hook.event === "tool_audit")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("HOOK_ALL_EVENTS is the exact union of the three closed per-kind event lists", () => {
    expect(new Set(HOOK_ALL_EVENTS)).toEqual(new Set([
      "tool_preflight", "tool_audit", "tool_write", "phase", "ledger_transition", "user_prompt_submit", "pre_compact", "notification", "turn_end",
      "session_start", "session_end", "node_start", "node_end", "plan_confirm", "interruption",
    ]));
  });

  it("accepts tool_write as an observe-kind event, never a veto one", () => {
    // The lane that replaced vi-dirty-track.sh. It is observe-only for the same
    // reason every other added event is: it must never be able to deny.
    const catalog = new HookCatalog();
    const hook = catalog.register(bytes(descriptor({ hook_id: "dirty-tracker", kind: "observe", event: "tool_write", handler_ref: "observe.vi-dirty-tracker" })));
    expect(hook.event).toBe("tool_write");
    expect(() => catalog.register(bytes(descriptor({ hook_id: "veto-tool-write", kind: "veto", event: "tool_write", handler_ref: "veto.deny-shell-execute" })))).toThrowError(expect.objectContaining({ code: "hook_escalation" }));
  });

  // ADR-111 decision 4: the three added events are observe-kind only.
  it.each(["user_prompt_submit", "pre_compact", "notification", "turn_end"])("accepts %s as an observe-kind event, never a veto one", (event) => {
    const catalog = new HookCatalog();
    const hook = catalog.register(bytes(descriptor({ hook_id: "note-added-event", kind: "observe", event, handler_ref: "observe.tool-audit-notes" })));
    expect(hook.event).toBe(event);
    expect(() => catalog.register(bytes(descriptor({ hook_id: "veto-added-event", kind: "veto", event, handler_ref: "veto.deny-shell-execute" })))).toThrowError(expect.objectContaining({ code: "hook_escalation" }));
  });

  // ADR-111 decision 1/2: a plugin-supplied tool_preflight veto hook is
  // refused below T4 -- regardless of whether handler_ref names a built-in
  // handler or a plugin-authored one -- and a built-in (non-plugin) hook is
  // unaffected by the new gate.
  describe("plugin-supplied veto hooks require T4 (ADR-111)", () => {
    it.each(["T1", "T2", "T3"] as const)("refuses a %s plugin's tool_preflight veto hook", (tier) => {
      const catalog = new HookCatalog();
      expect(() => catalog.register(bytes(descriptor()), "deny-shell@1.0.0.json", undefined, "some-plugin", false, tier))
        .toThrowError(expect.objectContaining({ code: "plugin_tier" }));
    });

    it("admits a T4 plugin's tool_preflight veto hook bound to a built-in handler", () => {
      const catalog = new HookCatalog();
      const hook = catalog.register(bytes(descriptor()), "deny-shell@1.0.0.json", undefined, "some-plugin", false, "T4");
      expect(hook.handler_ref).toBe("veto.deny-shell-execute");
    });

    it("leaves a non-plugin (built-in) tool_preflight veto hook unaffected by the tier gate", () => {
      const catalog = new HookCatalog();
      const hook = catalog.register(bytes(descriptor()));
      expect(hook.handler_ref).toBe("veto.deny-shell-execute");
    });

    it("refuses a T2 plugin's session_start lifecycle veto hook too", () => {
      const catalog = new HookCatalog();
      expect(() => catalog.register(bytes(descriptor({ hook_id: "plugin-session-gate", kind: "lifecycle", event: "session_start", handler_ref: "lifecycle.deny-session-start" })), "plugin-session-gate@1.0.0.json", undefined, "some-plugin", false, "T2"))
        .toThrowError(expect.objectContaining({ code: "plugin_tier" }));
    });
  });

  // ADR-111 decision 1: addPluginHandlers admits only self-attributed
  // "plugin"-kind entries, and never one that shadows a closed handlers.ts key.
  describe("addPluginHandlers (ADR-111)", () => {
    it("registers a self-attributed plugin handler and lets a descriptor bind to it", () => {
      const catalog = new HookCatalog();
      catalog.addPluginHandlers("some-plugin", { "plugin:some-plugin:denyEverything": { kind: "plugin", plugin_id: "some-plugin", export_name: "denyEverything", handler: () => ({ allow: false, reason: "denied by plugin export" }) } });
      const hook = catalog.register(bytes(descriptor({ handler_ref: "plugin:some-plugin:denyEverything" })), "deny-shell@1.0.0.json", undefined, "some-plugin", false, "T4");
      expect(hook.handler_ref).toBe("plugin:some-plugin:denyEverything");
    });

    it("refuses a handler entry not self-attributed to the registering plugin", () => {
      const catalog = new HookCatalog();
      expect(() => catalog.addPluginHandlers("some-plugin", { "plugin:other-plugin:x": { kind: "plugin", plugin_id: "other-plugin", export_name: "x", handler: () => ({ allow: true }) } }))
        .toThrowError(expect.objectContaining({ code: "contract" }));
    });

    it("refuses a plugin handler_ref that collides with the closed built-in registry", () => {
      const catalog = new HookCatalog();
      expect(() => catalog.addPluginHandlers("some-plugin", { "veto.deny-shell-execute": { kind: "plugin", plugin_id: "some-plugin", export_name: "x", handler: () => ({ allow: true }) } }))
        .toThrowError(expect.objectContaining({ code: "contract" }));
    });

    it("refuses a descriptor binding to another plugin's handler_ref", () => {
      const catalog = new HookCatalog();
      catalog.addPluginHandlers("plugin-a", { "plugin:plugin-a:denyIt": { kind: "plugin", plugin_id: "plugin-a", export_name: "denyIt", handler: () => ({ allow: false, reason: "no" }) } });
      expect(() => catalog.register(bytes(descriptor({ handler_ref: "plugin:plugin-a:denyIt" })), "deny-shell@1.0.0.json", undefined, "plugin-b", false, "T4"))
        .toThrowError(expect.objectContaining({ code: "contract" }));
    });
  });
  // Proposal §5.3's two lints. These are the checks that keep the injection
  // lane from becoming OMO's prompt lane: a CODE tropism is a claim that
  // the plane enforces the thing, and an ADVISORY one may not ask for
  // behaviour at all. Both are refused by the catalog rather than the bus,
  // because the catalog is the only component that knows which enforcement
  // surfaces are actually declared.
  describe("tropism lints (proposal §5.3)", () => {
    const tropism = (overrides: Record<string, unknown> = {}) => ({
      id: "orient", trigger: "session_start", lane: "ADVISORY", provenance: "generated",
      derived_from: ["ring:a1b2c3"], body: "Leased node n-7.", expires_after_turns: 3, enforcing_ref: null, ...overrides,
    });
    const withVeto = () => {
      const catalog = new HookCatalog();
      catalog.register(bytes(descriptor()));
      return catalog;
    };

    it("accepts a well-formed ADVISORY tropism", () => {
      expect(withVeto().validateTropism(tropism())).toBeNull();
    });

    it("(ii) refuses an ADVISORY tropism whose body opens with imperative text", () => {
      const diagnostic = withVeto().validateTropism(tropism({ body: "Always run gate:all before committing." }));
      expect(diagnostic?.code).toBe("advisory_imperative");
      expect(diagnostic?.message).toContain("must declare lane CODE");
    });

    it.each(["must", "shall", "never", "always", "should", "do not", "don't", "do-not"])(
      "(ii) refuses an ADVISORY body opening with '%s'", (lead) => {
        expect(withVeto().validateTropism(tropism({ body: `${lead} touch the ledger.` }))?.code).toBe("advisory_imperative");
      },
    );

    it("(ii) does not fire on a non-leading match", () => {
      expect(withVeto().validateTropism(tropism({ body: "The gate list must be run before commit; it is currently stale." }))).toBeNull();
    });

    it("(ii) accepts the same body once it declares the CODE lane and names its enforcement", () => {
      expect(withVeto().validateTropism(tropism({ lane: "CODE", body: "Always run gate:all before committing.", enforcing_ref: "deny-shell" }))).toBeNull();
    });

    it("(iii) refuses a CODE tropism with no enforcing_ref", () => {
      const diagnostic = withVeto().validateTropism(tropism({ lane: "CODE", enforcing_ref: null }));
      expect(diagnostic?.code).toBe("code_unenforced");
      expect(diagnostic?.message).toContain("has no enforcing_ref");
    });

    it("(iii) refuses a CODE tropism naming a ref that resolves to no declared hook", () => {
      const diagnostic = withVeto().validateTropism(tropism({ lane: "CODE", enforcing_ref: "no-such-veto" }));
      expect(diagnostic?.code).toBe("code_unenforced");
      expect(diagnostic?.message).toContain("resolves to no declared hook");
    });

    it("(iii) distinguishes the two CODE refusals so an operator sees which one they hit", () => {
      const catalog = withVeto();
      expect(catalog.validateTropism(tropism({ lane: "CODE", enforcing_ref: null }))?.message)
        .not.toBe(catalog.validateTropism(tropism({ lane: "CODE", enforcing_ref: "no-such-veto" }))?.message);
    });

    it("refuses an ADVISORY tropism that declares an enforcing_ref — it asks for nothing", () => {
      expect(withVeto().validateTropism(tropism({ enforcing_ref: "deny-shell" }))?.code).toBe("tropism_malformed");
    });

    it("refuses a tropism whose provenance claims more than the plane established", () => {
      expect(withVeto().validateTropism(tropism({ provenance: "verified" }))?.message).toContain("provenance must be 'generated'");
    });

    it("refuses a constant tropism — §5.3 rule 2 requires a non-empty derivation", () => {
      expect(withVeto().validateTropism(tropism({ derived_from: [] }))?.code).toBe("tropism_malformed");
    });

    it("refuses a non-positive expiry", () => {
      expect(withVeto().validateTropism(tropism({ expires_after_turns: 0 }))?.code).toBe("tropism_malformed");
    });

    it("refuses an oversized body rather than letting it reach the prompt unbounded", () => {
      expect(withVeto().validateTropism(tropism({ body: "x".repeat(TROPISM_BYTE_BUDGET + 1) }))?.code).toBe("tropism_bound");
    });

    it("binds an inject descriptor to an inject handler and refuses any other handler kind", () => {
      const handlers: HookHandlerRegistry = { "inject.orient": { kind: "inject", handler: () => null } };
      const catalog = new HookCatalog({ handlers });
      const hook = catalog.register(bytes(descriptor({ hook_id: "orient-tropism", kind: "inject", event: "session_start", handler_ref: "inject.orient" })));
      expect(hook.kind).toBe("inject");
      expect(() => new HookCatalog().register(bytes(descriptor({ hook_id: "bad-inject", kind: "inject", event: "session_start", handler_ref: "veto.deny-shell-execute" }))))
        .toThrowError(expect.objectContaining({ code: "hook_escalation" }));
    });

    it("keeps inject off the veto and observe event sets", () => {
      for (const event of ["tool_preflight", "tool_audit", "user_prompt_submit"]) {
        expect(() => new HookCatalog().register(bytes(descriptor({ hook_id: "bad-event", kind: "inject", event, handler_ref: "lifecycle.session-boundary-notes" }))))
          .toThrowError(expect.objectContaining({ code: "hook_escalation" }));
      }
    });
  });
});
