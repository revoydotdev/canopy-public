import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeApprovalAllowedTools, resolveCliBrowserProvider, resolveCliOrganizationPolicy, resolveCliWebSearchProvider } from "../src/cli.js";
import { DEFAULT_CONFIG } from "@arbor/config";
import { RUNTIME_CATALOG, RuntimeCatalogRouter, catalogActionClass } from "../src/runtime-catalog.js";
import { ArborRuntime } from "../src/runtime.js";

describe("D48 production reachability", () => {
  it("keeps the forbidden class empty and refuses an unregistered attempted action", async () => {
    expect(RUNTIME_CATALOG.filter((entry) => catalogActionClass(entry) === "forbidden")).toEqual([]);
    const router = new RuntimeCatalogRouter(new ArborRuntime());
    const response = await router.dispatchCommand({
      schema_version: 1,
      metadata: { operation_id: "d48-unregistered", idempotency_key: "d48-unregistered", correlation_id: "d48-unregistered", actor_id: "operator", requested_at: "2026-08-24T00:00:00.000Z" },
      command: { kind: "forbidden.never-registered" },
    } as never);
    expect(response).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("loads the committed organization floor at the CLI boundary and intersects approvals", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-org-policy-"));
    try {
      writeFileSync(join(root, "org.jsonc"), JSON.stringify({ schema_version: 1, policy_id: "org-v1", network: { allowed_domains: ["docs.example.test"] }, native_approval: { allowed_tools: ["file.write"] }, startup: { safe_mode: true } }));
      const policy = resolveCliOrganizationPolicy(root, { ARBOR_ORGANIZATION_POLICY: "org.jsonc" });
      expect(policy).toMatchObject({ startup: { safe_mode: true }, network: { allowed_domains: ["docs.example.test"] } });
      expect(nativeApprovalAllowedTools("reviewed", ["file.write", "file.patch"], policy!.native_approval.allowed_tools)).toEqual(["file.write"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("resolves deployable search and browser providers at the production CLI boundary", () => {
    const config = { ...DEFAULT_CONFIG, native: { ...DEFAULT_CONFIG.native, web_search: { provider: "searxng" } } };
    expect(resolveCliWebSearchProvider(config, { ARBOR_WEB_SEARCH_ENDPOINT: "https://search.example.test/v1" })).toMatchObject({ provider_id: "searxng", endpoint_url: "https://search.example.test/v1" });
    expect(resolveCliBrowserProvider({ ARBOR_NATIVE_BROWSER_ENDPOINT: "https://browser.example.test/v1" })).toMatchObject({ provider_id: "https-json-browser", endpoint_url: "https://browser.example.test/v1" });
  });
});
