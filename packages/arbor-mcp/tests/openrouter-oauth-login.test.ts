import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOpenRouterAuthorizationUrl, createOpenRouterPkceParameters } from "../src/openrouter-oauth-login.js";

describe("OpenRouter provider OAuth PKCE", () => {
  it("uses S256, a one-time verifier challenge, callback and independent state", () => {
    const pkce = createOpenRouterPkceParameters(Buffer.alloc(32, 1));
    expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
    expect(pkce.state).toMatch(/^[A-Za-z0-9_-]+$/u);
    const url = new URL(buildOpenRouterAuthorizationUrl(`http://localhost:43567/callback?state=${pkce.state}`, pkce.challenge));
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("callback_url")).toContain(`state=${pkce.state}`);
    expect(url.searchParams.has("code_verifier")).toBe(false);
  });
});
