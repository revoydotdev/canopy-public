/**
 * CANARY STUB — not the real `packages/arbor-mcp/src/hooks/handlers.ts`.
 *
 * Carries only the shape `gate:hook-devolution` parses: the keys of the closed
 * `HOOK_HANDLERS` registry. `veto.git-write-guard` IS registered here, so the
 * fixture's failure cannot be check (b); it is check (c), the descriptor.
 */
export const HOOK_HANDLERS: HookHandlerRegistry = Object.freeze({
  "veto.git-write-guard": Object.freeze({ kind: "veto", handler: gitWriteGuard }),
  "inject.governance-orient": Object.freeze({ kind: "inject", handler: governanceOrient }),
  "observe.tool-audit-notes": Object.freeze({ kind: "observe", handler: toolAuditNotes }),
}) satisfies HookHandlerRegistry;
