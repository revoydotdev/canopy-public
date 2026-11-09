import { describe, expect, it } from "vitest";
import type { lookup as dnsLookup } from "node:dns/promises";
import type { NativeToolRequest } from "@arbor/harness";
import { createHttpBrowserAutomationProvider, createNativeBrowserToolPorts, NATIVE_BROWSER_TOOL_RISKS, type BrowserAutomationProvider } from "../src/native-browser-tools.js";

const request = (input: unknown, network_allowed = true): NativeToolRequest => ({ session_id: "session", turn: 1, call_id: "call", input, workspace_roots: [], filesystem: "read_only", network_allowed, intent_evidence: [] });
const output = (value: { model_output: string }) => JSON.parse(value.model_output) as Record<string, unknown>;
const lookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof dnsLookup;
const policy = { allowed_domains: ["fixture.test"], authorize: () => true } as const;

describe("governed browser ports", () => {
  it("declares high risk and honestly refuses when browser authority is absent", async () => {
    expect(NATIVE_BROWSER_TOOL_RISKS).toEqual({ "browser.observe": "high", "browser.interact": "high" });
    const observe = createNativeBrowserToolPorts({ policy, resolve_hostname: lookup }).find((port) => port.tool === "browser.observe")!;
    expect(output(await observe.execute(request({ url: "https://fixture.test/" }), null, new AbortController().signal))).toMatchObject({ outcome: "refused", code: "browser_uncomposed" });
  });

  it("requires network and request-specific authority, then delegates only bounded actions", async () => {
    const calls: string[] = [];
    const provider: BrowserAutomationProvider = { provider_id: "fixture", observe: async ({ url }) => { calls.push(url); return { url, title: "Fixture", text: "observed" }; }, interact: async ({ action }) => ({ url: "https://fixture.test/", title: action, text: "changed" }) };
    const ports = createNativeBrowserToolPorts({ policy, provider, resolve_hostname: lookup });
    const observe = ports.find((port) => port.tool === "browser.observe")!;
    expect(output(await observe.execute(request({ url: "https://fixture.test/" }, false), null, new AbortController().signal))).toMatchObject({ code: "network_not_authorized" });
    expect(output(await observe.execute(request({ url: "https://fixture.test/" }), null, new AbortController().signal))).toMatchObject({ outcome: "succeeded", provider: "fixture", provenance: { tag: "observed" } });
    expect(calls).toEqual(["https://fixture.test/"]);
    const interact = ports.find((port) => port.tool === "browser.interact")!;
    expect(output(await interact.execute(request({ action: "click", target: "#go" }), null, new AbortController().signal))).toMatchObject({ outcome: "succeeded", title: "click" });
  });

  it("refuses domains and browser interactions when composed authority does not authorize them", async () => {
    const provider: BrowserAutomationProvider = { provider_id: "fixture", observe: async () => ({ url: "https://fixture.test/", title: "x", text: "x" }), interact: async () => ({ url: "https://fixture.test/", title: "x", text: "x" }) };
    const denied = createNativeBrowserToolPorts({ policy: { allowed_domains: ["fixture.test"], authorize: () => false }, provider, resolve_hostname: lookup });
    expect(output(await denied[0]!.execute(request({ url: "https://fixture.test/" }), null, new AbortController().signal))).toMatchObject({ code: "request_not_authorized" });
    expect(output(await denied[1]!.execute(request({ action: "click", target: "#go" }), null, new AbortController().signal))).toMatchObject({ code: "request_not_authorized" });
  });

  it("composes the bounded HTTPS JSON browser provider and governs both bridge and observed URLs", async () => {
    const calls: string[] = [];
    const provider = createHttpBrowserAutomationProvider({
      endpoint_url: "https://bridge.fixture.test/v1/",
      fetch_impl: async (url, init) => {
        calls.push(`${init?.method} ${url.toString()}`);
        return new Response(JSON.stringify({ url: "https://fixture.test/page", title: "Fixture", text: "observed" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const observe = createNativeBrowserToolPorts({ policy, provider, resolve_hostname: lookup }).find((port) => port.tool === "browser.observe")!;
    expect(output(await observe.execute(request({ url: "https://fixture.test/page" }), null, new AbortController().signal))).toMatchObject({ outcome: "succeeded", provider: "https-json-browser", title: "Fixture" });
    expect(calls).toEqual(["POST https://bridge.fixture.test/v1/observe"]);
  });

  it("rejects invalid browser bridge endpoint authority before any request can be issued", () => {
    expect(() => createHttpBrowserAutomationProvider({ endpoint_url: "not a url" })).toThrow("absolute URL");
    expect(() => createHttpBrowserAutomationProvider({ endpoint_url: "http://bridge.fixture.test" })).toThrow("credential-free HTTPS");
    expect(() => createHttpBrowserAutomationProvider({ endpoint_url: "https://user:secret@bridge.fixture.test" })).toThrow("credential-free HTTPS");
  });

  it("refuses bridge redirects, failed responses, non-JSON bodies, declared oversize bodies, and malformed JSON", async () => {
    const cases: readonly [string, () => Response, string][] = [
      ["redirect", () => new Response(null, { status: 302 }), "redirect refused"],
      ["failed", () => new Response(null, { status: 503 }), "HTTP 503"],
      ["html", () => new Response("not json", { status: 200, headers: { "content-type": "text/html" } }), "non-JSON"],
      ["large", () => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": String(128 * 1024 + 1) } }), "exceeded the bound"],
      ["malformed", () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }), "invalid JSON"],
    ];
    for (const [, reply, message] of cases) {
      const provider = createHttpBrowserAutomationProvider({ endpoint_url: "https://bridge.fixture.test", fetch_impl: async () => reply() });
      await expect(provider.observe({ url: "https://fixture.test/" }, new AbortController().signal)).rejects.toThrow(message);
    }
  });

  it("refuses oversized streamed and structurally invalid bridge observations", async () => {
    const oversized = createHttpBrowserAutomationProvider({
      endpoint_url: "https://bridge.fixture.test",
      fetch_impl: async () => new Response(new Uint8Array(128 * 1024 + 1), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(oversized.observe({ url: "https://fixture.test/" }, new AbortController().signal)).rejects.toThrow("exceeded the bound");

    for (const value of [null, { url: "https://fixture.test/", title: "x", text: "x", screenshot_hash: "sha256:not-a-hash" }, { url: 1, title: "x", text: "x" }]) {
      const provider = createHttpBrowserAutomationProvider({
        endpoint_url: "https://bridge.fixture.test",
        fetch_impl: async () => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }),
      });
      await expect(provider.observe({ url: "https://fixture.test/" }, new AbortController().signal)).rejects.toThrow("invalid");
    }
  });

  it("surfaces preflight/recovery contracts and refuses cancelled, malformed, and failed native calls", async () => {
    const provider: BrowserAutomationProvider = {
      provider_id: "fixture",
      observe: async () => { throw new Error("provider unavailable"); },
      interact: async () => { throw new Error("provider unavailable"); },
    };
    const [observe, interact] = createNativeBrowserToolPorts({ policy, provider, resolve_hostname: lookup });
    expect(observe!.preflight!(request({}, false))).toMatchObject({ allowed: false, code: "network_not_authorized" });
    expect(interact!.preflight!(request({}, true))).toEqual({ allowed: true });
    expect(observe!.recovery_protection!(request({ url: "https://fixture.test/" }))).toMatchObject({ effect_kind: "external", repeatable: true });
    expect(interact!.recovery_protection!(request({ action: "click", target: "#go" }))).toMatchObject({ effect_kind: "external", repeatable: false });

    const aborted = new AbortController(); aborted.abort();
    expect(output(await observe!.execute(request({ url: "https://fixture.test/" }), null, aborted.signal))).toMatchObject({ outcome: "cancelled", code: "cancelled" });
    expect(output(await interact!.execute(request({ action: "click", target: "#go" }), null, aborted.signal))).toMatchObject({ outcome: "cancelled", code: "cancelled" });
    expect(output(await observe!.execute(request("not-an-object"), null, new AbortController().signal))).toMatchObject({ outcome: "failed", code: "input_invalid" });
    expect(output(await observe!.execute(request({ url: "short" }), null, new AbortController().signal))).toMatchObject({ outcome: "refused", code: "url_invalid" });
    expect(output(await observe!.execute(request({ url: "https://fixture.test/" }), null, new AbortController().signal))).toMatchObject({ outcome: "failed", code: "browser_observe_failed" });
    expect(output(await interact!.execute(request({ action: "drag", target: "#go" }), null, new AbortController().signal))).toMatchObject({ outcome: "refused", code: "interaction_invalid" });
    expect(output(await interact!.execute(request({ action: "type", target: "#go", value: 7 }), null, new AbortController().signal))).toMatchObject({ outcome: "refused", code: "interaction_invalid" });
    expect(output(await interact!.execute(request({ action: "click", target: "#go" }), null, new AbortController().signal))).toMatchObject({ outcome: "failed", code: "browser_interact_failed" });
  });

  it("bounds observation text, retains valid screenshot evidence, and refuses an observed URL outside policy", async () => {
    const screenshot_hash = `sha256:${"a".repeat(64)}`;
    const provider: BrowserAutomationProvider = {
      provider_id: "fixture",
      observe: async () => ({ url: "https://fixture.test/page", title: "title", text: "abcdefgh", screenshot_hash }),
      interact: async () => ({ url: "https://outside.test/", title: "title", text: "text" }),
    };
    const [observe, interact] = createNativeBrowserToolPorts({ policy, provider, resolve_hostname: lookup, max_text_bytes: 3 });
    expect(output(await observe!.execute(request({ url: "https://fixture.test/page" }), null, new AbortController().signal))).toMatchObject({ outcome: "succeeded", text: "abc", screenshot_hash });
    // Interact deliberately collapses provider/policy failures to its stable
    // execution error envelope rather than leaking bridge-policy detail.
    expect(output(await interact!.execute(request({ action: "select", target: "#kind", value: "one" }), null, new AbortController().signal))).toMatchObject({ outcome: "failed", code: "browser_interact_failed" });
  });
});
