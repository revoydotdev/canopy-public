/** Canary fixture: one supported catalog kind, and no TUI disposition for it. */
export const RUNTIME_CATALOG = [
  { kind: "canary.kind", direction: "query", summary: "canary", supported: true },
] as const;
