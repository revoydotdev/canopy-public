import { describe, expect, it, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { lookup as dnsLookup } from "node:dns/promises";
import type { NativeToolRequest } from "@arbor/harness";
import { createNativeWebToolPorts, createSearxngWebSearchProvider, NATIVE_WEB_TOOL_RISKS, type WebSearchProvider } from "../src/native-web-tools.js";

/** Fakes only the `{all:true,verbatim:true}` overload `admitFetchUrl` actually calls. */
function fakeLookup(addresses: readonly { address: string; family: number }[]): typeof dnsLookup {
  return (async () => addresses) as unknown as typeof dnsLookup;
}

function request(input: unknown): NativeToolRequest {
  return { session_id: "session-a", turn: 1, call_id: "call-a", input, workspace_roots: [], filesystem: "read_only", intent_evidence: [], network_allowed: true };
}

function output(response: { model_output: string }): Record<string, unknown> {
  return JSON.parse(response.model_output) as Record<string, unknown>;
}

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function startFixtureServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<number> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server!.address() as AddressInfo).port;
}

// The fixture server only ever speaks plain HTTP on 127.0.0.1 with no TLS
// certificate, so these tests decouple the two things `web.fetch` couples in
// production: the resolved address used for SSRF admission (stubbed here to
// a real public address so admission passes) and the actual transport
// (stubbed via `fetch_impl` to dial the local fixture directly). Address
// admission's *denial* path is exercised directly against a real private
// address below, independent of the fixture transport.
function publicResolver(): typeof dnsLookup {
  return fakeLookup([{ address: "93.184.216.34", family: 4 }]); // example.com, a real public address
}
const policy = { allowed_domains: ["fixture.test", "internal.example", "localhost", "example.com"], authorize: () => true } as const;

describe("NATIVE_WEB_TOOL_RISKS", () => {
  it("classifies both web tools as high risk (unsandboxed network egress, LR-NH-07)", () => {
    expect(NATIVE_WEB_TOOL_RISKS).toEqual({ "web.fetch": "high", "web.search": "high" });
  });
});

describe("web.fetch policy", () => {
  it("refuses a non-https scheme", async () => {
    const [port] = await Promise.all([startFixtureServer((_req, res) => res.end("ok"))]);
    const ports = createNativeWebToolPorts({ fetch: { policy, resolve_hostname: publicResolver() } });
    const tool = ports.find((p) => p.tool === "web.fetch")!;
    const result = output(await tool.execute(request({ url: `http://localhost:${port}/` }), null, new AbortController().signal));
    expect(result.outcome).toBe("refused");
    expect(result.code).toBe("scheme_denied");
  });

  it("refuses a URL that resolves to a private/loopback address", async () => {
    const ports = createNativeWebToolPorts({ fetch: { policy, resolve_hostname: fakeLookup([{ address: "127.0.0.1", family: 4 }]) } });
    const tool = ports.find((p) => p.tool === "web.fetch")!;
    const result = output(await tool.execute(request({ url: "https://internal.example/" }), null, new AbortController().signal));
    expect(result.outcome).toBe("refused");
    expect(result.code).toBe("private_address_denied");
  });

  it("requires an explicit request authorization and an allowed domain", async () => {
    const denied = createNativeWebToolPorts({ fetch: { policy: { allowed_domains: ["fixture.test"], authorize: () => false }, resolve_hostname: publicResolver() } }).find((p) => p.tool === "web.fetch")!;
    expect(output(await denied.execute(request({ url: "https://fixture.test/" }), null, new AbortController().signal))).toMatchObject({ outcome: "refused", code: "request_not_authorized" });
    const outside = createNativeWebToolPorts({ fetch: { policy: { allowed_domains: ["fixture.test"], authorize: () => true }, resolve_hostname: publicResolver() } }).find((p) => p.tool === "web.fetch")!;
    expect(output(await outside.execute(request({ url: "https://outside.test/" }), null, new AbortController().signal))).toMatchObject({ outcome: "refused", code: "domain_denied" });
  });

  it("revalidates every redirect and refuses an escape from the allowed domain", async () => {
    const ports = createNativeWebToolPorts({ fetch: { policy, resolve_hostname: publicResolver(), fetch_impl: async () => new Response(null, { status: 302, headers: { location: "https://outside.test/" } }) } });
    const tool = ports.find((p) => p.tool === "web.fetch")!;
    expect(output(await tool.execute(request({ url: "https://fixture.test/" }), null, new AbortController().signal))).toMatchObject({ outcome: "refused", code: "domain_denied" });
  });

  it("refuses an RFC1918 literal address without a DNS round trip", async () => {
    const ports = createNativeWebToolPorts({ fetch: { policy, resolve_hostname: async () => { throw new Error("must not resolve a literal"); } } });
    const tool = ports.find((p) => p.tool === "web.fetch")!;
    const result = output(await tool.execute(request({ url: "https://10.0.0.5/" }), null, new AbortController().signal));
    expect(result.outcome).toBe("refused");
    expect(result.code).toBe("private_address_denied");
  });

  it("refuses a disallowed content-type", async () => {
    const port = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("binary");
    });
    const ports = createNativeWebToolPorts({ fetch: { policy, resolve_hostname: publicResolver(), fetch_impl: (_url, init) => fetch(`http://127.0.0.1:${port}/`, init) } });
    const tool = ports.find((p) => p.tool === "web.fetch")!;
    const result = output(await tool.execute(request({ url: "https://fixture.test/" }), null, new AbortController().signal));
    expect(result.outcome).toBe("refused");
    expect(result.code).toBe("content_type_denied");
  });

  it("truncates a body larger than max_body_bytes and marks it", async () => {
    const bigBody = "x".repeat(4096);
    const port = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(bigBody);
    });
    const ports = createNativeWebToolPorts({ fetch: { policy, resolve_hostname: publicResolver(), max_body_bytes: 100, fetch_impl: (_url, init) => fetch(`http://127.0.0.1:${port}/`, init) } });
    const tool = ports.find((p) => p.tool === "web.fetch")!;
    const result = output(await tool.execute(request({ url: "https://fixture.test/" }), null, new AbortController().signal));
    expect(result.outcome).toBe("succeeded");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(100);
  });

  it("succeeds on an allowed content-type, reduces HTML to text, and emits typed evidence (url, status, bytes, content hash)", async () => {
    const port = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body><script>evil()</script><p>Hello <b>World</b></p></body></html>");
    });
    const ports = createNativeWebToolPorts({ fetch: { policy, resolve_hostname: publicResolver(), fetch_impl: (_url, init) => fetch(`http://127.0.0.1:${port}/`, init) } });
    const tool = ports.find((p) => p.tool === "web.fetch")!;
    const response = await tool.execute(request({ url: "https://fixture.test/" }), null, new AbortController().signal);
    const result = output(response);
    expect(result.outcome).toBe("succeeded");
    expect(result.status).toBe(200);
    expect(typeof result.bytes).toBe("number");
    expect(result.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("World");
    expect(result.text).not.toContain("evil()");
    expect(response.evidence.outcome).toBe("succeeded");
    expect(response.evidence.confinement).toBe("application_validated");
  });

  it("refuses malformed input before any network call", async () => {
    const ports = createNativeWebToolPorts({ fetch: { policy, resolve_hostname: async () => { throw new Error("must not resolve"); } } });
    const tool = ports.find((p) => p.tool === "web.fetch")!;
    const result = output(await tool.execute(request({}), null, new AbortController().signal));
    expect(result.outcome).toBe("refused");
    expect(result.code).toBe("url_invalid");
  });

  it("cancels immediately on an already-aborted signal", async () => {
    const ports = createNativeWebToolPorts({ fetch: { policy, resolve_hostname: async () => { throw new Error("must not resolve"); } } });
    const tool = ports.find((p) => p.tool === "web.fetch")!;
    const controller = new AbortController();
    controller.abort();
    const result = output(await tool.execute(request({ url: "https://fixture.test/" }), null, controller.signal));
    expect(result.outcome).toBe("cancelled");
  });
});

describe("web.search provider seam", () => {
  it("refuses with a typed provider_unconfigured error naming the config leaf when no provider is composed", async () => {
    const ports = createNativeWebToolPorts({ search: { policy } });
    const tool = ports.find((p) => p.tool === "web.search")!;
    const result = output(await tool.execute(request({ query: "revoy" }), null, new AbortController().signal));
    expect(result.outcome).toBe("refused");
    expect(result.code).toBe("provider_unconfigured");
    expect(result.config_leaf).toBe("native.web_search.provider");
  });

  it("dispatches to a composed provider and returns bounded results", async () => {
    const provider: WebSearchProvider = {
      provider_id: "stub",
      search: async (query) => ({ ok: true, results: [{ title: "Result", url: "https://fixture.test/a", snippet: `about ${query}` }] }),
    };
    const ports = createNativeWebToolPorts({ search: { policy, provider } });
    const tool = ports.find((p) => p.tool === "web.search")!;
    const result = output(await tool.execute(request({ query: "revoy" }), null, new AbortController().signal));
    expect(result.outcome).toBe("succeeded");
    expect(result.provider).toBe("stub");
    expect(result.results).toEqual([{ title: "Result", url: "https://fixture.test/a", snippet: "about revoy" }]);
  });

  it("runs the built-in SearXNG provider through endpoint admission and bounded JSON parsing", async () => {
    let requested = "";
    const provider = createSearxngWebSearchProvider({
      endpoint_url: "https://search.fixture.test/search",
      fetch_impl: async (input) => {
        requested = input.toString();
        return new Response(JSON.stringify({ results: [{ title: "Revoy", url: "https://fixture.test/revoy", content: "governed result" }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const tool = createNativeWebToolPorts({ search: { policy, provider, resolve_hostname: publicResolver() } }).find((item) => item.tool === "web.search")!;
    const result = output(await tool.execute(request({ query: "tree cognition" }), null, new AbortController().signal));
    expect(requested).toContain("q=tree+cognition");
    expect(requested).toContain("format=json");
    expect(result).toMatchObject({ outcome: "succeeded", provider: "searxng", results: [{ title: "Revoy", url: "https://fixture.test/revoy", snippet: "governed result" }] });
  });

  it("refuses a SearXNG endpoint outside the governed domain set before transport", async () => {
    let called = false;
    const provider = createSearxngWebSearchProvider({ endpoint_url: "https://outside.test/search", fetch_impl: async () => { called = true; return new Response("{}"); } });
    const tool = createNativeWebToolPorts({ search: { policy, provider, resolve_hostname: publicResolver() } }).find((item) => item.tool === "web.search")!;
    expect(output(await tool.execute(request({ query: "revoy" }), null, new AbortController().signal))).toMatchObject({ outcome: "refused", code: "domain_denied" });
    expect(called).toBe(false);
  });

  it("surfaces a provider failure as a typed failed outcome", async () => {
    const provider: WebSearchProvider = { provider_id: "stub", search: async () => ({ ok: false, code: "provider_error", summary: "upstream 503" }) };
    const ports = createNativeWebToolPorts({ search: { policy, provider } });
    const tool = ports.find((p) => p.tool === "web.search")!;
    const result = output(await tool.execute(request({ query: "revoy" }), null, new AbortController().signal));
    expect(result.outcome).toBe("failed");
    expect(result.code).toBe("provider_error");
  });
});

// CI has no guaranteed egress, and this box's own environment can be
// firewalled/offline too — real DNS + a real HTTPS round trip is a live
// dependency, not a fixture. Skipped unless explicitly opted into, per the
// task's testing constraint ("A live-internet test may exist but must be
// skipped-by-default with an env opt-in").
const liveInternet = process.env.ARBOR_TEST_LIVE_INTERNET === "1" ? describe : describe.skip;
liveInternet("web.fetch against the real internet (ARBOR_TEST_LIVE_INTERNET=1)", () => {
  it("fetches https://example.com over real DNS resolution and returns readable text", async () => {
    const { lookup } = await import("node:dns/promises");
    const ports = createNativeWebToolPorts({ fetch: { policy, resolve_hostname: lookup } });
    const tool = ports.find((p) => p.tool === "web.fetch")!;
    const result = output(await tool.execute(request({ url: "https://example.com/" }), null, new AbortController().signal));
    expect(result.outcome).toBe("succeeded");
    expect(result.status).toBe(200);
    expect(String(result.text)).toContain("Example Domain");
  }, 20_000);
});

describe("createNativeWebToolPorts composition", () => {
  it("only constructs the ports it is given options for (deny-by-default gate lives at the caller)", () => {
    expect(createNativeWebToolPorts({}).map((p) => p.tool)).toEqual([]);
    expect(createNativeWebToolPorts({ fetch: { policy } }).map((p) => p.tool)).toEqual(["web.fetch"]);
    expect(createNativeWebToolPorts({ search: { policy } }).map((p) => p.tool)).toEqual(["web.search"]);
    expect(createNativeWebToolPorts({ fetch: { policy }, search: { policy } }).map((p) => p.tool)).toEqual(["web.fetch", "web.search"]);
  });
});
