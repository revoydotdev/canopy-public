import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { LspClient, viLspRegistration } from "../lib/lsp-client.mjs";

/**
 * ADR-090: proves the LSP seam is REAL — it drives actual language servers
 * (no stubs) and gets back exactly the two static
 * facts VI's static plane needs: symbol existence (documentSymbol) and
 * find-callers (prepareCallHierarchy + incomingCalls). The TypeScript and Rust
 * cases prove that one protocol client, rather than a
 * language-specific extractor, yields the same facts across languages.
 */

function serverAvailable(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_SERVER = serverAvailable("typescript-language-server");
const suite = HAVE_SERVER ? describe : describe.skip;
const TSSERVER_PATH = realpathSync(new URL("../../node_modules/typescript/lib/tsserver.js", import.meta.url));

describe("VI LSP registrations", () => {
  it("labels compiler and dynamic-language soundness explicitly", () => {
    expect(viLspRegistration("typescript").soundness).toBe("compiler-grade");
    expect(viLspRegistration("rust").soundness).toBe("compiler-grade");
    expect(viLspRegistration("python").soundness).toBe("best-effort");
    expect(() => viLspRegistration("unregistered-language")).toThrow("no LSP registration");
  });

  it("recognizes tsserver's signalled exit for both tsserver-backed languages", () => {
    for (const language of ["typescript", "javascript"]) {
      const { backendExitPattern } = viLspRegistration(language);
      expect(backendExitPattern.test("[lspserver] [tsclient] [tsserver] Exited. Code: null. Signal: SIGKILL")).toBe(true);
      expect(backendExitPattern.test("[tsserver] Error processing request")).toBe(false);
    }
  });
});

describe("LspClient terminal failures", () => {
  it("rejects future requests promptly and shutdown does not wait after a missing spawn", async () => {
    const client = new LspClient({ command: ["definitely-not-an-lsp-server"], rootPath: tmpdir(), requestTimeoutMs: 10_000 });
    client.start();
    await once(client.proc, "error");
    const started = Date.now();
    await expect(client.initialize()).rejects.toThrow("unavailable");
    await client.shutdown();
    expect(Date.now() - started).toBeLessThan(500);
  });
});

async function eventually(probe, accept, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await probe().catch(() => null);
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return probe();
}

suite("LspClient drives a real typescript-language-server", () => {
  let root;
  let client;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arbor-lsp-"));
    // A real caller relationship: caller() in a.ts invokes target() from b.ts.
    writeFileSync(join(root, "b.ts"), "export function target(): number {\n  return 42;\n}\n");
    writeFileSync(
      join(root, "a.ts"),
      "import { target } from \"./b\";\n\nexport function caller(): number {\n  return target() + 1;\n}\n",
    );
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "commonjs", strict: true }, include: ["*.ts"] }, null, 2),
    );
  });

  afterEach(async () => {
    if (client) await client.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves symbol existence and find-callers against the live server", async () => {
    client = new LspClient({ command: ["typescript-language-server", "--stdio"], rootPath: root });
    client.start();
    await client.initialize({ tsserverPath: TSSERVER_PATH });

    const bPath = join(root, "b.ts");
    const aPath = join(root, "a.ts");
    client.didOpen(bPath, "typescript", "export function target(): number {\n  return 42;\n}\n");
    client.didOpen(aPath, "typescript", "import { target } from \"./b\";\n\nexport function caller(): number {\n  return target() + 1;\n}\n");

    // Symbol existence: documentSymbol names `target`.
    const symbols = await client.documentSymbol(bPath);
    const names = (symbols ?? []).map((s) => s.name);
    expect(names).toContain("target");

    // Find-callers: prepareCallHierarchy on `target` (line 0, the "target"
    // identifier at column 16), then incomingCalls names `caller`.
    const items = await client.prepareCallHierarchy(bPath, { line: 0, character: 16 });
    expect(Array.isArray(items) && items.length > 0).toBe(true);

    const incoming = await client.incomingCalls(items[0]);
    const callerNames = (incoming ?? []).map((c) => c.from?.name);
    expect(callerNames).toContain("caller");
  }, 40000);

  // The full-corpus failure this guards: tsserver died on a signal (heap
  // abort / OOM kill), typescript-language-server stayed up, and every later
  // references request answered `[]`. Kill the real backend with SIGKILL and
  // require the session to turn terminal instead of answering emptily.
  it("turns terminal when tsserver dies on a signal behind a live front end", async () => {
    const registration = viLspRegistration("typescript");
    client = new LspClient({
      command: registration.command,
      rootPath: root,
      backendExitPattern: registration.backendExitPattern,
    });
    client.start();
    await client.initialize({ tsserverPath: TSSERVER_PATH });
    const bPath = join(root, "b.ts");
    client.didOpen(bPath, "typescript", "export function target(): number {\n  return 42;\n}\n");
    client.didOpen(join(root, "a.ts"), "typescript", "import { target } from \"./b\";\n\nexport function caller(): number {\n  return target() + 1;\n}\n");
    expect((await client.references(bPath, { line: 0, character: 16 })).length).toBeGreaterThan(0);
    client.assertHealthy();

    const children = execFileSync("pgrep", ["-P", String(client.proc.pid)], { encoding: "utf8" })
      .split("\n").filter(Boolean).map(Number);
    expect(children.length).toBeGreaterThan(0);
    for (const pid of children) process.kill(pid, "SIGKILL");

    const deadline = Date.now() + 10_000;
    while (!client.terminalError && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    // The front end itself is still running: this is not the process-exit path.
    expect(client.proc.exitCode).toBeNull();
    expect(client.serverErrors.some((text) => registration.backendExitPattern.test(text))).toBe(true);
    expect(() => client.assertHealthy()).toThrow("lost its backend");
    await expect(client.references(bPath, { line: 0, character: 16 })).rejects.toThrow("lost its backend");
  }, 40000);
});

const HAVE_RUST_ANALYZER = serverAvailable("rust-analyzer");
const rustSuite = HAVE_RUST_ANALYZER ? describe : describe.skip;

rustSuite("LspClient drives a real rust-analyzer", () => {
  let root;
  let client;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arbor-lsp-rust-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), "[package]\nname = \"arbor_lsp_fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFileSync(
      join(root, "src", "lib.rs"),
      "pub fn target() -> i32 {\n    42\n}\n\npub fn caller() -> i32 {\n    target() + 1\n}\n",
    );
  });

  afterEach(async () => {
    if (client) await client.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves the same symbol and caller facts through the shared client", async () => {
    client = new LspClient({ command: ["rust-analyzer"], rootPath: root, requestTimeoutMs: 40000 });
    client.start();
    await client.initialize();

    const libPath = join(root, "src", "lib.rs");
    const source = "pub fn target() -> i32 {\n    42\n}\n\npub fn caller() -> i32 {\n    target() + 1\n}\n";
    client.didOpen(libPath, "rust", source);

    const symbols = await client.documentSymbol(libPath);
    expect((symbols ?? []).map((symbol) => symbol.name)).toContain("target");

    // rust-analyzer completes workspace indexing asynchronously after the LSP
    // initialize handshake, so wait for the semantic call-hierarchy fact.
    const items = await eventually(
      () => client.prepareCallHierarchy(libPath, { line: 5, character: 6 }),
      (value) => Array.isArray(value) && value.length > 0,
    );
    expect(Array.isArray(items) && items.length > 0).toBe(true);

    const incoming = await eventually(
      () => client.incomingCalls(items[0]),
      (value) => (value ?? []).some((call) => call.from?.name === "caller"),
    );
    expect((incoming ?? []).map((call) => call.from?.name)).toContain("caller");
  }, 60000);
});
