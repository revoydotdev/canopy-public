/**
 * scan.ts — build the ArtifactIdentity set for packages/*\/src/**\/*.ts.
 *
 * Deterministic and pure w.r.t. repo content: no clock, no env, no random
 * ids. Two calls against the same checkout produce byte-identical output
 * (see tests/artifact/scan.test.ts's determinism assertion) — that is what
 * makes a before/after diff over this output meaningful at all: any
 * difference in scan() output must come from a real content change, never
 * from scan jitter. `artifact/duplicates.ts` is the real, wired consumer:
 * one call to `scan()` per check, fed into `identity.ts`'s
 * `duplicateSymbolIds` to render a POL-06 finding.
 *
 * Two identities per file:
 *   - one `kind: "file"` identity (path + whole-file content_hash,
 *     symbol_id null);
 *   - one `kind: "symbol"` identity per top-level EXPORTED declaration
 *     (function/class/enum/const-or-let/default export), hashed on just
 *     that declaration's own source text so an edit to one export does not
 *     perturb its neighbors' identities.
 *
 * Scope is exported declarations only (mirrors scripts/reachability.mjs's
 * own checklist, which is also exports-only) — this module tracks the
 * governed public surface, not every internal helper.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import type { ArtifactIdentity } from "../contracts.js";
import { contentHashOfString, createArtifactIdentity, symbolId } from "./identity.js";

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

function packageNameFromPath(relPath: string, sourceRoots: readonly string[]): string | null {
  for (const root of sourceRoots) {
    const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^${escapedRoot}/([^/]+)/src/`).exec(relPath);
    if (match) return match[1];
  }
  return null;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Top-level exported declaration names in `stmt`, paired with the source-text node to hash. Empty when `stmt` declares nothing exported. */
function topLevelExports(stmt: ts.Statement, sourceFile: ts.SourceFile): Array<{ name: string; text: string }> {
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
    if (hasExportModifier(stmt) && stmt.name) return [{ name: stmt.name.text, text: stmt.getText(sourceFile) }];
    return [];
  }
  if (ts.isEnumDeclaration(stmt)) {
    if (hasExportModifier(stmt)) return [{ name: stmt.name.text, text: stmt.getText(sourceFile) }];
    return [];
  }
  if (ts.isVariableStatement(stmt)) {
    if (!hasExportModifier(stmt)) return [];
    const out: Array<{ name: string; text: string }> = [];
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) out.push({ name: decl.name.text, text: decl.getText(sourceFile) });
    }
    return out;
  }
  if (ts.isExportAssignment(stmt)) {
    return [{ name: "default", text: stmt.expression.getText(sourceFile) }];
  }
  return [];
}

function scanFile(absPath: string, repoRoot: string, sourceRoots: readonly string[]): ArtifactIdentity[] {
  const relPath = relative(repoRoot, absPath).replace(/\\/g, "/");
  const source = readFileSync(absPath, "utf8");
  const identities: ArtifactIdentity[] = [
    createArtifactIdentity({
      kind: "file",
      path: relPath,
      symbol_id: null,
      content_hash: contentHashOfString(source),
    }),
  ];

  const pkg = packageNameFromPath(relPath, sourceRoots);
  if (!pkg) return identities; // defensive: walk() only descends packages/<pkg>/src, so this should not occur

  const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.ES2022, true);
  for (const stmt of sourceFile.statements) {
    for (const { name, text } of topLevelExports(stmt, sourceFile)) {
      identities.push(
        createArtifactIdentity({
          kind: "symbol",
          path: relPath,
          symbol_id: symbolId(pkg, name),
          content_hash: contentHashOfString(text),
        }),
      );
    }
  }
  return identities;
}

/** Options controlling which directories `scan` treats as source roots. */
export interface ScanOptions {
  /**
   * Repo-relative directories to scan for `<root>/*\/src/**\/*.ts` —
   * `arbor.profile.jsonc`'s `source_roots` (ADR-073). Defaults to
   * `["packages"]`, revoy2's own convention, so an omitted option behaves
   * exactly as before. A foreign project whose sources live in `src/` rather
   * than `packages/` previously scanned to an empty identity list — a
   * project with zero symbols is indistinguishable from a `packages/`-typed
   * scanner that never looked at the right directory. Threading
   * `sourceRoots` through here and into `packageNameFromPath` closes that.
   */
  readonly sourceRoots?: readonly string[];
}

/** Scan every packages/*\/src/**\/*.ts under `repoRoot` into an ArtifactIdentity list, in deterministic (sorted-path) order. */
export function scan(repoRoot: string, options: ScanOptions = {}): readonly ArtifactIdentity[] {
  const sourceRoots = options.sourceRoots ?? ["packages"];
  const files: string[] = [];
  for (const root of sourceRoots) {
    const rootDir = join(repoRoot, root);
    let packageDirs: string[];
    try {
      packageDirs = readdirSync(rootDir).sort();
    } catch {
      continue;
    }
    for (const pkg of packageDirs) {
      const srcDir = join(rootDir, pkg, "src");
      try {
        if (statSync(srcDir).isDirectory()) walk(srcDir, files);
      } catch {
        // package has no src/ — nothing to scan
      }
    }
  }
  files.sort();

  const identities: ArtifactIdentity[] = [];
  for (const file of files) {
    identities.push(...scanFile(file, repoRoot, sourceRoots));
  }
  return identities;
}
