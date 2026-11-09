/**
 * Session-scoped, route-scoped cache for declarative tool schemas.
 *
 * The cache is an optimization only: callers supply the currently eligible
 * tool names on every lookup, and returned manifests are filtered to that
 * exact set. A cache hit can therefore never grant a tool that this call did
 * not already admit.
 *
 * Governing record: ADR-024 (tool admission is a host trust boundary; a cache hit never grants a tool).
 */
export type ToolSchemaRoute = "tool_capable" | "non_tool";

export interface ToolSchemaManifestEntry<TSchema = unknown> {
  readonly tool_name: string;
  readonly schema_id: string;
  readonly schema: TSchema;
}

export interface ToolSchemaManifest<TSchema = unknown> {
  readonly session_id: string;
  readonly route: ToolSchemaRoute;
  readonly revision: string;
  readonly entries: readonly ToolSchemaManifestEntry<TSchema>[];
  readonly cache: "hit" | "miss";
}

export interface ToolSchemaManifestCacheOptions {
  readonly max_entries?: number;
  readonly max_schemas_per_manifest?: number;
}

/** Bounded LRU cache keyed by (session, route, model revision). */
export class BoundedToolSchemaManifestCache<TSchema = unknown> {
  private readonly manifests = new Map<string, Map<string, ToolSchemaManifestEntry<TSchema>>>();
  private readonly maxEntries: number;
  private readonly maxSchemas: number;

  constructor(options: ToolSchemaManifestCacheOptions = {}) {
    this.maxEntries = boundedPositiveInteger(options.max_entries ?? 64, "max_entries");
    this.maxSchemas = boundedPositiveInteger(options.max_schemas_per_manifest ?? 128, "max_schemas_per_manifest");
  }

  resolve(input: {
    readonly session_id: string;
    readonly route: ToolSchemaRoute;
    readonly revision: string;
    /** Names already filtered by the caller's capability and authority policy. */
    readonly eligible_tool_names: readonly string[];
    readonly load: (eligible_tool_names: readonly string[]) => readonly ToolSchemaManifestEntry<TSchema>[];
  }): ToolSchemaManifest<TSchema> {
    nonEmpty(input.session_id, "session_id");
    nonEmpty(input.revision, "revision");
    if (input.route !== "tool_capable" && input.route !== "non_tool") throw new TypeError("invalid schema route");
    const eligible = uniqueNames(input.eligible_tool_names);
    if (input.route === "non_tool" && eligible.length > 0) throw new TypeError("non_tool route cannot load tool schemas");

    const key = cacheKey(input.session_id, input.route, input.revision);
    const hit = this.manifests.get(key);
    if (hit !== undefined) this.manifests.delete(key);
    const loaded = hit ?? new Map<string, ToolSchemaManifestEntry<TSchema>>();
    const allowed = new Set(eligible.slice(0, this.maxSchemas));
    for (const toolName of loaded.keys()) if (!allowed.has(toolName)) loaded.delete(toolName);
    const missing = [...allowed].filter((toolName) => !loaded.has(toolName));
    if (missing.length > 0) {
      const additions = input.load(Object.freeze(missing));
      if (!Array.isArray(additions)) throw new TypeError("schema loader must return an array");
      for (const entry of additions) {
        validateEntry(entry);
        if (!allowed.has(entry.tool_name)) throw new TypeError(`schema loader returned an ineligible tool: ${entry.tool_name}`);
        loaded.set(entry.tool_name, freezeEntry(entry));
      }
    }
    // Move this key to the LRU tail, keeping its footprint bounded.
    this.manifests.set(key, loaded);
    while (this.manifests.size > this.maxEntries) this.manifests.delete(this.manifests.keys().next().value!);

    const entries = [...allowed].flatMap((toolName) => {
      const entry = loaded.get(toolName);
      return entry === undefined ? [] : [entry];
    });
    return Object.freeze({
      session_id: input.session_id,
      route: input.route,
      revision: input.revision,
      entries: Object.freeze(entries),
      cache: hit === undefined ? "miss" : "hit",
    });
  }

  invalidateSession(sessionId: string): number {
    let removed = 0;
    for (const key of this.manifests.keys()) if (key.startsWith(`${sessionId.length}:${sessionId}|`)) {
      this.manifests.delete(key);
      removed += 1;
    }
    return removed;
  }

  invalidateAll(): number {
    const removed = this.manifests.size;
    this.manifests.clear();
    return removed;
  }

  get size(): number { return this.manifests.size; }
  get max_entries(): number { return this.maxEntries; }

  get schema_count(): number {
    let count = 0;
    for (const entries of this.manifests.values()) count += entries.size;
    return count;
  }
}

function cacheKey(session: string, route: ToolSchemaRoute, revision: string): string {
  return `${session.length}:${session}|${route.length}:${route}|${revision.length}:${revision}`;
}

function uniqueNames(names: readonly string[]): string[] {
  if (!Array.isArray(names)) throw new TypeError("eligible_tool_names must be an array");
  const result = [...new Set(names.map((name) => nonEmpty(name, "eligible tool name")))];
  return result;
}

function validateEntry<TSchema>(entry: ToolSchemaManifestEntry<TSchema>): void {
  if (entry === null || typeof entry !== "object") throw new TypeError("schema loader returned an invalid entry");
  nonEmpty(entry.tool_name, "tool_name");
  nonEmpty(entry.schema_id, "schema_id");
}

function freezeEntry<TSchema>(entry: ToolSchemaManifestEntry<TSchema>): ToolSchemaManifestEntry<TSchema> {
  return Object.freeze({ tool_name: entry.tool_name, schema_id: entry.schema_id, schema: snapshot(entry.schema) });
}

function snapshot<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot)) as T;
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("tool schema must contain only plain JSON data");
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = snapshot(item);
    return Object.freeze(copy) as T;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new TypeError("tool schema must contain only JSON values");
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be non-empty`);
  return value;
}

function boundedPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}
