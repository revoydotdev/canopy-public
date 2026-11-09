import { readFileSync, writeFileSync } from "node:fs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function mergeJsonlTexts(texts) {
  const records = new Map();
  for (const text of texts) {
    for (const line of text.split("\n").filter((entry) => entry.trim())) {
      const value = JSON.parse(line);
      const rendered = canonical(value);
      const key = typeof value.id === "string" ? `id:${value.id}` : `record:${rendered}`;
      const previous = records.get(key);
      if (previous && previous !== rendered) {
        throw new Error(`semantic JSONL conflict for ${key}`);
      }
      records.set(key, rendered);
    }
  }
  return [...records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value).join("\n") + (records.size ? "\n" : "");
}

export function mergeFiles(basePath, currentPath, otherPath) {
  const merged = mergeJsonlTexts([basePath, currentPath, otherPath].map((path) => readFileSync(path, "utf8")));
  writeFileSync(currentPath, merged, "utf8");
}

if (import.meta.main) {
  const [basePath, currentPath, otherPath] = process.argv.slice(2);
  if (!basePath || !currentPath || !otherPath) {
    console.error("usage: union-sorted-jsonl-merge.mjs %O %A %B");
    process.exit(2);
  }
  try {
    mergeFiles(basePath, currentPath, otherPath);
  } catch (error) {
    console.error(`union-sorted-jsonl: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
