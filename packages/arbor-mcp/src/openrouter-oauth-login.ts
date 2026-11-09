import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { storeOpenRouterOAuthApiKey } from "@arbor/config";

const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export interface OpenRouterOAuthLoginDependencies {
  readonly output: (message: string) => void;
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

export function createOpenRouterPkceParameters(random = randomBytes(32)) {
  const verifier = random.toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  return Object.freeze({ verifier, challenge, state });
}

export function buildOpenRouterAuthorizationUrl(callbackUrl: string, challenge: string): string {
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("key_label", "Canopy native provider");
  return url.toString();
}

/** Provider-owned PKCE consent; only the resulting API key enters Canopy's private credential overlay. */
export async function loginOpenRouterOAuth(deps: OpenRouterOAuthLoginDependencies): Promise<string> {
  const fetcher = deps.fetch ?? fetch;
  const pkce = createOpenRouterPkceParameters();
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not bind local OpenRouter OAuth callback");
  const callbackUrl = `http://localhost:${address.port}/callback?state=${encodeURIComponent(pkce.state)}`;
  const authorizationUrl = buildOpenRouterAuthorizationUrl(callbackUrl, pkce.challenge);
  deps.output(`Open this OpenRouter authorization URL in a browser:\n${authorizationUrl}\nWaiting for the localhost callback (10 minute limit).`);

  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("OpenRouter authorization timed out; run native-auth openrouter login again")), LOGIN_TIMEOUT_MS);
      server.on("request", (request, response) => {
        let url: URL;
        try { url = new URL(request.url ?? "/", callbackUrl); } catch { response.writeHead(400).end("Invalid callback"); return; }
        const expected = new URL(callbackUrl);
        if (request.method !== "GET" || url.pathname !== expected.pathname || url.searchParams.get("state") !== pkce.state) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("OpenRouter login state did not match.");
          return;
        }
        const code = url.searchParams.get("code");
        if (!code || code.length > 4096) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("OpenRouter did not return an authorization code.");
          return;
        }
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("OpenRouter connected. You can close this page and return to Canopy.");
        resolve(code);
      });
    });
    const exchange = await fetcher(OPENROUTER_EXCHANGE_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: pkce.verifier, code_challenge_method: "S256" }),
    });
    if (!exchange.ok) throw new Error(`OpenRouter OAuth code exchange failed (HTTP ${exchange.status}); authorization details were suppressed`);
    let payload: unknown;
    try { payload = await exchange.json(); } catch { throw new Error("OpenRouter OAuth exchange returned invalid JSON"); }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload) || typeof (payload as Record<string, unknown>).key !== "string") throw new Error("OpenRouter OAuth exchange did not return an API key");
    const path = storeOpenRouterOAuthApiKey((payload as { key: string }).key, deps.env ?? process.env);
    deps.output(`OpenRouter OAuth key stored in the user-private credential store: ${path}`);
    return path;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
