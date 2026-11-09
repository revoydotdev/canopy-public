import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";

/**
 * C1: `arbor evidence refresh` is the CLI verb `evidence.refresh`
 * (`native-tools/evidence-refresh.ts`) never had — reachable only from the
 * MCP tool surface before this. This exercises the real dispatch through
 * `main()` (the exported entry point every other `arbor <verb>` test in this
 * package uses), not a reimplementation of `runEvidenceRefresh`'s own
 * ordering logic — that is already covered exhaustively by
 * `evidence-refresh.test.ts` and reused here without modification.
 */
function makeEnv(cwd: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  return { env: { cwd, persistence_dir: join(cwd, ".arbor"), stdin: new PassThrough(), stdout, stderr }, out: () => out, err: () => err };
}

describe("arbor evidence refresh (CLI)", () => {
  it("rejects an unknown action with a usage error naming the real grammar", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-evidence-cli-"));
    try {
      const { env, err } = makeEnv(root);
      const code = await main(["evidence", "bogus"], env);
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(err()).toContain("Usage: arbor evidence refresh");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an unknown flag", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-evidence-cli-"));
    try {
      const { env, err } = makeEnv(root);
      const code = await main(["evidence", "refresh", "--wat"], env);
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(err()).toContain("Unknown evidence refresh option: --wat");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an unknown store name in --scope with a USAGE exit and names every known store", async () => {
    // Explicit scope validation precedes freshness inspection: a typo is a
    // deterministic usage error and must not be masked by unrelated store
    // drift. The real repository still proves the production CLI path.
    const { env, out } = makeEnv(process.cwd());
    const code = await main(["evidence", "refresh", "--scope", "not-a-real-store", "--json"], env);
    expect(code).toBe(EXIT_CODES.USAGE);
    const parsed = JSON.parse(out());
    expect(parsed.error).toContain("scope named unknown store(s): not-a-real-store");
    expect(parsed.error).toContain("claim-ledger");
  });

  it("--dry-run against the real repository reaches the real evidence.refresh port without claiming concurrent drift is clean", async () => {
    const { env, out } = makeEnv(process.cwd());
    const code = await main(["evidence", "refresh", "--scope", "all", "--dry-run", "--json"], env);
    const parsed = JSON.parse(out());
    expect(parsed.dry_run).toBe(true);
    if (parsed.error === null) {
      expect(parsed.stores).toHaveLength(4);
      for (const store of parsed.stores) expect(["would_refresh", "skipped"]).toContain(store.action);
      expect(code === EXIT_CODES.SUCCESS || code === EXIT_CODES.VIOLATION).toBe(true);
    } else {
      // The full suite intentionally exercises store mutation in other worker
      // processes. The real gate must fail closed if it observes that
      // transaction in flight; that still proves this command reached the
      // production port and, because this invocation is dry-run, did not join
      // or mutate the transaction itself.
      expect(parsed.error).toMatch(/^store-freshness-gate\.mjs --json could not be read:/);
      expect(parsed.stores).toEqual([]);
      expect(code).toBe(EXIT_CODES.FAILURE);
    }
    // dry_run never runs a refresh command, so nothing about exit-code plumbing
    // should ever surface a "refreshed"/"failed"/"refused" action here.
    // A fresh VI graph makes dry-run execute the LSP-backed reproducibility
    // check. That measured ~137s under the full parallel suite on 2026-08-24;
    // keep a bounded margin for shared-runner contention without weakening the
    // production step deadline or turning a real timeout into success.
  }, 300_000);
});
