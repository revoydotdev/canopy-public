/**
 * scripts/observation/dist-resolve-hook.mjs — a Node module-customization
 * hook that redirects `@arbor/<pkg>` bare specifiers to that package's
 * COMPILED dist/index.js, instead of the src/index.ts every workspace
 * package.json's "exports" field points at.
 *
 * WHY THIS EXISTS. ADR-042's observation pipeline needs V8 coverage
 * attributed to `packages/*\/dist/**.js` files, mappable back to
 * `packages/*\/src/*.ts` via the tsc-emitted `.js.map` sitting next to each
 * dist file (see vi-observe.mjs). That only works if the code that actually
 * RUNS is the compiled dist output.
 *
 * It is not, by default. Every `packages/*\/package.json` in this repo
 * declares `"main"` and `"exports"` pointing at `./src/index.ts` (see
 * `packages/arbor-mcp/bin/arbor-mcp.mjs`'s header comment for the same
 * observation) — so running `node packages/arbor-mcp/dist/cli.js` directly
 * DOES start (cli.js's own relative imports already resolve within dist,
 * since tsc preserves the `./sibling.js` specifiers your source already
 * writes), but the first `@arbor/*` cross-package import Node resolves via
 * node_modules walks straight back to that package's src/index.ts —
 * unparseable-as-plain-ESM TypeScript with `.js`-suffixed relative imports
 * that don't exist as files (`ERR_MODULE_NOT_FOUND`, verified empirically:
 * `packages/arbor-core/src/governed-context.js` does not exist, only
 * `governed-context.ts` does).
 *
 * The repository's only known-working direct invocation is
 * `bin/arbor-mcp.mjs`, which esbuild-bundles `cli.ts` fresh into one file.
 * ADR-042 explicitly forbids that entry for observation scenarios: a fresh
 * temp bundle has no stable, committed `packages/*\/dist/**.js` sourcemap
 * pair for vi-observe.mjs to resolve function offsets through, which is
 * this pipeline's whole resolution mechanism.
 *
 * So: neither existing invocation works for this purpose. This hook is the
 * closest hermetic equivalent — it makes cross-package resolution follow
 * dist output too, with zero source changes and zero new dependencies,
 * using only Node's built-in module customization hooks (stable since
 * Node 20.6 / 22).
 *
 * SCOPE. Only bare `@arbor/<name>` (no subpath) is redirected — confirmed
 * empirically to be the only import shape used anywhere in packages/*\/src
 * (`grep -rhoE 'from "@arbor/[a-z-]+"'`); no in-repo import uses a subpath
 * of an `@arbor/*` package. Anything else (relative imports, node builtins,
 * third-party bare specifiers) passes through to the default resolver
 * unchanged.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(join(HOOK_DIR, "..", ".."));

const ARBOR_BARE_SPECIFIER = /^@arbor\/([a-z][a-z-]*)$/;

export async function resolve(specifier, context, nextResolve) {
  const match = ARBOR_BARE_SPECIFIER.exec(specifier);
  if (match) {
    const distEntry = join(REPO_ROOT, "packages", `arbor-${match[1]}`, "dist", "index.js");
    if (existsSync(distEntry)) {
      return { url: pathToFileURL(distEntry).href, shortCircuit: true, format: "module" };
    }
    // Package has no dist build — fall through so the default resolver
    // produces its ordinary error rather than a confusing hook-internal one.
  }
  return nextResolve(specifier, context);
}
