import { readFileSync } from "node:fs";

/** Decode a JSON record without coupling storage parsing to process execution. */
export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
