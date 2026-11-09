#!/usr/bin/env bun
/** One-time release-key pinning with an independently supplied SPKI digest. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeReleaseTrustStore } from "../../packages/arbor-mcp/src/distribution.ts";

const [stateDir, keyId, publicKeyFile, expectedFingerprint] = process.argv.slice(2);
if (!stateDir || !keyId || !publicKeyFile || !expectedFingerprint || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
  throw new Error("usage: bun scripts/distribution/trust.mjs <state-dir> <key-id> <public-key.pem> <expected-spki-sha256>");
}
const store = initializeReleaseTrustStore(
  resolve(stateDir),
  [{ key_id: keyId, public_key: readFileSync(resolve(publicKeyFile), "utf8") }],
  new Map([[keyId, expectedFingerprint]]),
);
process.stdout.write(`Pinned ${store.roots.length} Revoy release trust root(s) in ${resolve(stateDir)}\n`);
