import { closeSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export interface ConsoleDocumentEntry { readonly path: string; readonly title: string }

/** Bounded local navigation, not a governance record or an authority source. */
export function discoverConsoleDocuments(root: string): readonly ConsoleDocumentEntry[] {
  const entries: ConsoleDocumentEntry[] = [];
  let visited = 0;
  const walk = (directory: string, depth: number): void => {
    let children;
    try { children = readdirSync(join(root, directory), { withFileTypes: true }); } catch { return; }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 512 || entries.length >= 128) return;
      if (child.isSymbolicLink()) continue;
      const path = join(directory, child.name);
      if (child.isFile() && /\.(md|mdx|markdown|txt)$/i.test(child.name)) {
        entries.push({ path, title: basename(child.name) });
      } else if (child.isDirectory() && depth < 3 && (directory !== "" || child.name === "docs")) {
        walk(path, depth + 1);
      }
    }
  };
  walk("", 0);
  return entries;
}

/** Resolve symlinks before reading; never follow a document outside the checkout. */
export function readConsoleDocument(root: string, path: string): string {
  const base = realpathSync(root);
  const absolute = realpathSync(resolve(base, path));
  const scoped = relative(base, absolute);
  if (!scoped || scoped === ".." || scoped.startsWith(`..${sep}`) || !/\.(md|mdx|markdown|txt)$/i.test(scoped)) {
    throw new Error("Document is outside the checkout or is not supported text.");
  }
  const fd = openSync(absolute, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, Math.min(length, 64 * 1024)).toString("utf8")
      + (length > 64 * 1024 ? "\n[Preview limited to 64 KiB]" : "");
  } finally { closeSync(fd); }
}
