/**
 * workspace-publishability.test.mjs — the `@arbor` scope is never published,
 * and now something says so.
 *
 * THE CLAIM THAT WAS UNWITNESSED. `.github/workflows/ci.yml` records a real
 * incident against "the never-published @arbor registry scope" (sibling
 * workspace deps pinned at a stale 0.1.0, 404ing on `npm ci`), and
 * docs/public-readiness.md refers to that scope again while assessing whether
 * this repo can go public. Both treat "never published" as settled fact. Yet
 * every one of the eleven workspace manifests omitted `private`, so each was
 * publishable by default — `npm publish` from any package directory would have
 * attempted a real registry push.
 *
 * WHY IT WOULD HAVE SHIPPED SOMETHING BROKEN. Every workspace manifest points
 * `main`/`types`/`exports` at `./src/index.ts`. That is deliberate, not a
 * defect: the repo resolves `@arbor/*` through bundler-aware tooling (vitest,
 * vite-node, esbuild, tsc project references) and scripts/eval-regression-gate.ts
 * documents the consequence explicitly — "plain `node` cannot resolve
 * (`node dist/cli.js` fails cross-package resolution; confirmed empirically)".
 * A package whose entry point only resolves under a bundler is coherent as an
 * internal workspace member and incoherent as a published artifact.
 *
 * So the invariant enforced here is the COUPLING, not a bare flag: a manifest
 * whose entry points reference TypeScript sources must not be publishable.
 * Stated that way it stays correct in both future directions — if a package
 * ever grows a genuine compiled `dist` entry point, it may drop `private` and
 * this check keeps passing; if someone drops `private` while the entry points
 * still name `.ts` files, it fails.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname;

function manifest(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath, "package.json"), "utf-8"));
}

/**
 * Every entry-point specifier a package manager or runtime could follow:
 * the top-level fields plus every string leaf of the `exports` tree, so a
 * conditional or subpath export cannot smuggle a source path past the check.
 */
function entryPoints(pkg) {
  const found = [];
  for (const field of ["main", "module", "types", "typings", "browser"]) {
    if (typeof pkg[field] === "string") found.push(pkg[field]);
  }
  const walk = (node) => {
    if (typeof node === "string") { found.push(node); return; }
    if (node && typeof node === "object") for (const value of Object.values(node)) walk(value);
  };
  walk(pkg.exports);
  return found;
}

/**
 * A `.d.ts` is a declaration file — the legitimate `types` entry of a REAL
 * published package — and must not be mistaken for a TypeScript source that
 * only a bundler can load. That distinction is the whole reason this is a
 * predicate rather than a substring match.
 */
function referencesTypeScriptSources(pkg) {
  return entryPoints(pkg).some((specifier) => specifier.endsWith(".ts") && !specifier.endsWith(".d.ts"));
}

function isPublishable(pkg) {
  return pkg.private !== true;
}

/** The violation this file exists to prevent. */
function violates(pkg) {
  return referencesTypeScriptSources(pkg) && isPublishable(pkg);
}

const workspaces = manifest(".").workspaces;

describe("the @arbor scope is not publishable", () => {
  it("covers every workspace the root manifest declares", () => {
    // Derived from the root manifest rather than a hard-coded list, so a new
    // package cannot be added and silently escape the invariant below.
    expect(workspaces.length).toBeGreaterThan(0);
    expect(workspaces).toEqual([...workspaces].filter((entry) => entry.startsWith("packages/")));
  });

  it.each(workspaces)("%s is private, because its entry points name TypeScript sources", (workspace) => {
    const pkg = manifest(workspace);
    // Both halves are asserted, so this fails loudly either if a package
    // becomes publishable OR if the premise stops holding and this test
    // silently becomes vacuous.
    expect(referencesTypeScriptSources(pkg)).toBe(true);
    expect(pkg.private).toBe(true);
    expect(violates(pkg)).toBe(false);
  });
});

describe("the check itself fires on a violation and stays quiet on valid content", () => {
  it("FLAGS a TypeScript-entry package that is publishable — the pre-fix state of all eleven", () => {
    expect(violates({ name: "@arbor/x", main: "./src/index.ts", types: "./src/index.ts" })).toBe(true);
  });

  it("FLAGS a source path hidden in a nested conditional export", () => {
    // The top-level fields alone would have missed this one.
    expect(violates({ name: "@arbor/x", exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" } } }))
      .toBe(true);
    expect(violates({ name: "@arbor/x", exports: { "./sub": { import: "./src/sub.ts" } } })).toBe(true);
  });

  it("ALLOWS a TypeScript-entry package that is private — the fixed state", () => {
    expect(violates({ name: "@arbor/x", private: true, main: "./src/index.ts" })).toBe(false);
  });

  it("ALLOWS a genuinely publishable package with compiled entry points", () => {
    // A check that flagged this would be forcing `private` on packages that
    // have no reason to carry it, which is exactly the cry-wolf failure.
    expect(violates({
      name: "real-package",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    })).toBe(false);
  });

  it("does not mistake a .d.ts declaration entry for a TypeScript source", () => {
    expect(referencesTypeScriptSources({ types: "./dist/index.d.ts" })).toBe(false);
    expect(referencesTypeScriptSources({ types: "./src/index.ts" })).toBe(true);
  });

  it("treats a missing private field and an explicit false as equally publishable", () => {
    expect(isPublishable({})).toBe(true);
    expect(isPublishable({ private: false })).toBe(true);
    expect(isPublishable({ private: true })).toBe(false);
  });
});
