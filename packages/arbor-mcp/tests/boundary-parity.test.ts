import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { decodeTerminalInput, navigationKeyFromChar, buildDefaultCatalog } from "@arbor/tui";
import { RUNTIME_CATALOG } from "../src/runtime-catalog.js";
import { validateProductIntegrationCommand, type ProductIntegrationCommandEnvelope } from "../src/product-integration-contracts.js";

/**
 * packages/arbor-mcp/tests/boundary-parity.test.ts — item 1, boundary-constant
 * parity (T5.2, 2026-08-23 remediation, "gates that catch the Hollow shape").
 *
 * Every existing wiring gate proves a symbol EXISTS and is EXECUTED. None of
 * them prove a constant crossing a package boundary (a TUI key union, a
 * default-catalog keybinding, a client-side runtime-command literal) still
 * NAMES the same thing on both sides. WA-24/WA-25/WA-27 (audit/2026-08-23-50-defects.md)
 * are exactly this shape. Item 1(a) — every `NATIVE_REPOSITORY_TOOL_RISKS`
 * tool advertised to the native model — already has a dedicated test
 * (`native-tool-schema.test.ts`, from T0.3); it is intentionally not
 * duplicated here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** Parse a `export type <name> = "a" | "b" | ...;` string-literal union from TS source text. */
export function parseStringUnion(source: string, typeName: string): string[] {
  const start = source.indexOf(`export type ${typeName} =`);
  if (start < 0) throw new Error(`type ${typeName} not found`);
  const end = source.indexOf(";", start);
  if (end < 0) throw new Error(`unterminated type ${typeName}`);
  const body = source.slice(start, end);
  return [...body.matchAll(/"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]);
}

describe("item 1(b): runtime-port.ts structural mirror matches RUNTIME_CATALOG direction", () => {
  const runtimePortSource = readRepoFile("packages/arbor-tui/src/runtime-port.ts");
  const catalogByKind = new Map<string, (typeof RUNTIME_CATALOG)[number]>(RUNTIME_CATALOG.map((entry) => [entry.kind, entry]));

  // Pure fixture-level unit test for the comparison logic itself, independent
  // of the real source files, so a future refactor of this test's own
  // plumbing cannot silently stop testing anything.
  it("[fixture] flags a query kind claimed by a command-only catalog entry, and a command kind claimed by a query-only entry", () => {
    const fixtureCatalog = new Map([
      ["real.query", { kind: "real.query", direction: "query" as const }],
      ["real.command", { kind: "real.command", direction: "command" as const }],
    ]);
    function findMismatches(kinds: string[], expectedDirection: "command" | "query") {
      return kinds.filter((kind) => {
        const entry = fixtureCatalog.get(kind);
        return entry === undefined || entry.direction !== expectedDirection;
      });
    }
    // Deliberately broken fixture: "real.command" is claimed as a query kind.
    expect(findMismatches(["real.query", "real.command"], "query")).toEqual(["real.command"]);
    // Deliberately broken fixture: an entirely absent kind.
    expect(findMismatches(["ghost.kind"], "command")).toEqual(["ghost.kind"]);
    // Correct fixture passes.
    expect(findMismatches(["real.query"], "query")).toEqual([]);
  });

  it("every RuntimeQueryKind member is a RUNTIME_CATALOG entry with direction: query", () => {
    const queryKinds = parseStringUnion(runtimePortSource, "RuntimeQueryKind");
    expect(queryKinds.length).toBeGreaterThan(0);
    // "devtools.stream" is a documented, permanent exception, not an open
    // defect (T5.3, 2026-08-23 remediation — resolved from the T5.2-era
    // pinned finding this test used to carry): it is intercepted by
    // `RuntimePortAdapter.query()` before it ever reaches
    // `RuntimeCatalogRouter` — see packages/arbor-mcp/src/tui-adapter.ts's
    // justification comment (CS-11), packages/arbor-mcp/src/tui.ts's
    // `runTui` grant comment, and runtime-port.ts's own inline comment on
    // this union member. The devtools ring is this process's own ephemeral
    // in-memory buffer, not campaign/governance state the router owns;
    // giving the router a back-reference to it would invert ADR-011's
    // adapter-wraps-router direction and make a catalog-level
    // authorization check theater (any caller able to invoke
    // `adapter.query()` is already inside the same single-operator
    // process as the ring it would be reading). It intentionally has no
    // RUNTIME_CATALOG entry, so it is excluded here rather than compared.
    const CATALOG_EXTERNAL_QUERY_KINDS = new Set(["devtools.stream"]);
    const mismatches = queryKinds.filter((kind) => {
      if (CATALOG_EXTERNAL_QUERY_KINDS.has(kind)) return false;
      const entry = catalogByKind.get(kind);
      return entry === undefined || entry.direction !== "query";
    });
    // Every OTHER query kind still has to genuinely mirror the catalog —
    // this test still fails immediately on any new, undocumented mismatch.
    expect(mismatches).toEqual([]);
  });

  it("every RuntimeCommandKind member is a RUNTIME_CATALOG entry with direction: command", () => {
    const commandKinds = parseStringUnion(runtimePortSource, "RuntimeCommandKind");
    expect(commandKinds.length).toBeGreaterThan(0);
    const mismatches = commandKinds.filter((kind) => {
      const entry = catalogByKind.get(kind);
      return entry === undefined || entry.direction !== "command";
    });
    expect(mismatches).toEqual([]);
  });
});

describe("item 1(c): default-catalog.ts keybindings are producible from a real terminal byte stream", () => {
  const ESC = String.fromCharCode(27);
  const CSI_SEQUENCES: Record<string, string> = {
    "[A": "up", "[B": "down", "[C": "right", "[D": "left",
    "[5~": "pageup", "[6~": "pagedown", "[H": "home", "[F": "end",
  };
  // VT220-style function-key sequences (ui-spec §3's F6/Shift+F6 zone-cycle
  // and Shift+F10 context menu), each mapped to the full "mods+key" token
  // `default-catalog.ts` binds — decoded.ts's `CSI_KEY_SEQUENCES` already
  // recognizes these (input-terminal.ts); this just proves it the same way
  // the plain-cursor-key entries above already do, rather than leaving F6/
  // F10 out of the producible set the fixture below actually checks.
  const CSI_FUNCTION_KEY_TOKENS: Record<string, string> = {
    "[17~": "f6", "[17;2~": "shift+f6",
    "[21~": "f10", "[21;2~": "shift+f10",
  };

  /** The producible set, built entirely from the real exported decoder functions — never hand-duplicated. */
  function buildProducibleTokenChecker() {
    const csiProducible = new Set<string>();
    for (const [seq, name] of Object.entries(CSI_SEQUENCES)) {
      const decoded = decodeTerminalInput(ESC + seq);
      if (decoded.keys.length === 1 && decoded.keys[0]!.key === name && (decoded.keys[0]!.modifiers ?? []).length === 0) {
        csiProducible.add(name);
      }
    }
    for (const [seq, token] of Object.entries(CSI_FUNCTION_KEY_TOKENS)) {
      const decoded = decodeTerminalInput(ESC + seq);
      if (decoded.keys.length !== 1) continue;
      const decodedKey = decoded.keys[0]!;
      const parts = token.split("+");
      const expectedKey = parts[parts.length - 1]!;
      const expectedMods = parts.slice(0, -1);
      if (decodedKey.key === expectedKey && (decodedKey.modifiers ?? []).length === expectedMods.length
        && expectedMods.every((mod) => (decodedKey.modifiers ?? []).includes(mod as never))) {
        csiProducible.add(token);
      }
    }
    const ctrlProducible = new Set<string>();
    for (let code = 1; code <= 26; code++) {
      const decoded = decodeTerminalInput(String.fromCharCode(code));
      if (decoded.keys.length === 1 && (decoded.keys[0]!.modifiers ?? []).includes("ctrl")) {
        ctrlProducible.add(decoded.keys[0]!.key);
      }
    }
    return function isProducible(token: string): boolean {
      if (token === "enter" || token === "escape") return true;
      if (csiProducible.has(token)) return true;
      const parts = token.split("+");
      const key = parts[parts.length - 1]!;
      const mods = parts.slice(0, -1);
      if (mods.length === 0) {
        if (key.length !== 1) return false;
        const normalized = navigationKeyFromChar(key);
        return normalized.key === key && (normalized.modifiers ?? []).length === 0;
      }
      if (mods.length === 1 && mods[0] === "shift" && key.length === 1 && key >= "a" && key <= "z") {
        const normalized = navigationKeyFromChar(key.toUpperCase());
        return normalized.key === key && (normalized.modifiers ?? []).includes("shift");
      }
      if (mods.length === 1 && mods[0] === "ctrl" && key.length === 1) return ctrlProducible.has(key);
      return false;
    };
  }

  it("[fixture] flags a bound token no real byte sequence can produce, and accepts a producible one", () => {
    const isProducible = buildProducibleTokenChecker();
    expect(isProducible("ctrl+shift+x")).toBe(false); // WA-style: no raw byte sequence encodes this
    expect(isProducible("ctrl+;")).toBe(false); // semicolon is outside the ctrl+<a-z> byte range
    expect(isProducible("alt+y")).toBe(false); // this decoder never emits an alt modifier
    expect(isProducible("shift+r")).toBe(true); // an uppercase "R" byte
    expect(isProducible("ctrl+b")).toBe(true); // byte 0x02
    expect(isProducible("pageup")).toBe(true); // ESC [ 5 ~
    expect(isProducible("1")).toBe(true); // plain printable
  });

  function nativeProducibleTokens(tokens: readonly string[]): Set<string> {
    // Native OpenTUI cannot load in Node/Vitest workers. Exercise its actual
    // parser in Bun instead of pretending the fallback decoder represents it.
    const script = `
      import { parseKeypress } from "@opentui/core";
      const tokens = JSON.parse(process.argv[1]);
      const supported = tokens.filter((token) => {
        const parts = token.split("+");
        const key = parts.pop();
        if (key.length !== 1 || parts.some((part) => !["ctrl", "alt", "shift"].includes(part))) return false;
        const modifier = 1 + (parts.includes("shift") ? 1 : 0) + (parts.includes("alt") ? 2 : 0) + (parts.includes("ctrl") ? 4 : 0);
        const bytes = "\\u001b[" + key.codePointAt(0) + ";" + modifier + "u";
        const parsed = parseKeypress(bytes, { useKittyKeyboard: true });
        return parsed !== null && parsed.name === key
          && Boolean(parsed.ctrl) === parts.includes("ctrl")
          && Boolean(parsed.meta || parsed.option) === parts.includes("alt")
          && Boolean(parsed.shift) === parts.includes("shift");
      });
      process.stdout.write(JSON.stringify(supported));
    `;
    return new Set(JSON.parse(execFileSync("bun", ["--eval", script, JSON.stringify(tokens)], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 10_000,
    })) as string[]);
  }

  it("distinguishes native Kitty support from fallback decoder limitations", () => {
    const tokens = ["alt+b", "alt+y", "ctrl+;", "ctrl+shift+x"];
    expect(nativeProducibleTokens(tokens)).toEqual(new Set(tokens));
    const fallback = buildProducibleTokenChecker();
    for (const token of tokens) expect(fallback(token)).toBe(false);
  });

  it("every non-empty catalog binding token is producible or listed in palette-only.json with a reason", () => {
    const isProducible = buildProducibleTokenChecker();
    const catalog = buildDefaultCatalog();
    const native = nativeProducibleTokens([...new Set(catalog.actions.flatMap((action) => action.bindings.flatMap((binding) => [...binding.keys])))]);
    const paletteOnly: { entries: { kind: string; reason: string }[] } = JSON.parse(readRepoFile("scripts/hollow-parity/palette-only.json"));
    const allowlist = new Set(paletteOnly.entries.filter((e) => e.reason?.trim()).map((e) => e.kind));
    const findings = new Set<string>();
    for (const action of catalog.actions) {
      for (const binding of action.bindings) {
        for (const key of binding.keys) {
          if (!isProducible(key) && !native.has(key) && !allowlist.has(key)) findings.add(key);
        }
      }
    }
    // Every bound token must have an observed decoder path or an explicit
    // palette-only disposition. No frozen list of untested native chords.
    // This proves decoding, not dispatch, focus routing, or terminal support.
    expect([...findings].sort()).toEqual([]);
  });
});

describe("item 1(d): webui.ts served-script command literals name real, correctly-shaped catalog commands", () => {
  const webuiSource = readRepoFile("packages/arbor-mcp/src/webui.ts");
  const catalogByKind = new Map<string, (typeof RUNTIME_CATALOG)[number]>(RUNTIME_CATALOG.map((entry) => [entry.kind, entry]));

  function extractLiteralKinds(source: string): string[] {
    const kinds = new Set<string>();
    for (const match of source.matchAll(/\b(?:runtimeCommand|confirmOperation)\(\s*'([a-zA-Z_.]+)'/g)) kinds.add(match[1]!);
    return [...kinds].sort();
  }

  it("[fixture] flags a literal that names no catalog command, or names a query", () => {
    const fixtureCatalog = new Map([
      ["real.command", { kind: "real.command", direction: "command" as const }],
      ["real.query", { kind: "real.query", direction: "query" as const }],
    ]);
    function findBadLiterals(kinds: string[]) {
      return kinds.filter((kind) => {
        const entry = fixtureCatalog.get(kind);
        return entry === undefined || entry.direction !== "command";
      });
    }
    expect(findBadLiterals(["renamed.commnad"])).toEqual(["renamed.commnad"]); // typo'd constant
    expect(findBadLiterals(["real.query"])).toEqual(["real.query"]); // wrong-direction constant
    expect(findBadLiterals(["real.command"])).toEqual([]);
  });

  it("every static runtimeCommand()/confirmOperation() literal in the served script names a real catalog command", () => {
    const literalKinds = extractLiteralKinds(webuiSource);
    expect(literalKinds.length).toBeGreaterThan(15); // sanity: the extractor is actually matching something
    const badLiterals = literalKinds.filter((kind) => {
      const entry = catalogByKind.get(kind);
      return entry === undefined || entry.direction !== "command";
    });
    expect(badLiterals).toEqual([]);
  });

  // Extends the WA-28 regression test in webui.test.ts (which proves this for
  // the two rendered-button call sites) to every remote.control/
  // scheduler.control literal payload found anywhere in the served script,
  // including ones with no rendered button today. These are the only two
  // kinds `isProductIntegrationCommandEnvelope`/`validateProductIntegrationCommand`
  // actually apply kind-specific validation to (see product-integration-contracts.ts);
  // every other static literal above is checked for catalog-membership only,
  // since the generic runtime-catalog validator applies no kind-specific
  // shape rule to them beyond acknowledge_risk/provenance, which the
  // confirmOperation() wrapper always injects.
  it("every static remote.control/scheduler.control literal payload in the served script passes the real product-integration validator", () => {
    const siteRegex = /confirmOperation\(\s*'(remote\.control|scheduler\.control)'\s*,\s*\{([^}]*)\}/g;
    const sites: { kind: string; fields: string; source: string }[] = [];
    for (const match of webuiSource.matchAll(siteRegex)) sites.push({ kind: match[1]!, fields: match[2]!, source: match[0] });
    expect(sites.length).toBeGreaterThanOrEqual(3); // suspend/resume/revoke found earlier in this lane's investigation

    // Representative values keyed by FIELD NAME, standing in for the runtime
    // template expressions (`s.session_id`, `schedule_id`, `reason.trim()`)
    // each site interpolates. Which fields a given site actually sends is
    // read from that site's own literal source text (`fieldNames` below) —
    // this is what makes the check meaningful: a site that forgot `reason`
    // on a suspend action, or sent the wrong `action` literal, produces a
    // params object that is missing/wrong for exactly the reason the real
    // site is missing/wrong, not a fixed stand-in shape.
    const representativeValue: Record<string, unknown> = {
      session_id: "remote-1", schedule_id: "schedule-1", reason: "operator review",
    };
    for (const site of sites) {
      const actionLiteral = site.fields.match(/action\s*:\s*'([a-z]+)'/)?.[1];
      // Split on top-level commas (the regex above already stripped the outer
      // `{...}` and forbids nested braces) and take the identifier before an
      // optional `:` — this also matches ES6 shorthand properties like the
      // bare `schedule_id` in `{action:'suspend', schedule_id, reason:...}`.
      const fieldNames = site.fields.split(",").map((part) => part.trim().split(":")[0]!.trim()).filter((name) => name.length > 0);
      const params: Record<string, unknown> = {};
      for (const field of fieldNames) params[field] = field === "action" ? actionLiteral : representativeValue[field];
      const envelope: ProductIntegrationCommandEnvelope = {
        schema_version: 1,
        metadata: { operation_id: "op", idempotency_key: "op", actor_id: "webui-operator", requested_at: new Date().toISOString() },
        command: {
          kind: site.kind as "remote.control" | "scheduler.control",
          ...params,
          confirmed: true,
          acknowledge_risk: true,
          provenance: { tag: "claimed", claimant: "webui-operator", note: "test" },
        } as never,
      };
      expect(validateProductIntegrationCommand(envelope), `${site.kind} (${fieldNames.join(",")}): ${site.source}`).toEqual([]);
    }
  });
});
