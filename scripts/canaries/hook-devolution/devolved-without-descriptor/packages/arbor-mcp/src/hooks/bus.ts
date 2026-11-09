/**
 * CANARY STUB — not the real `packages/arbor-mcp/src/hooks/bus.ts`.
 *
 * Carries the public method list of `class HookBus`, which is what the gate
 * reads for a row's `seam`. `wrapToolPort` is present and real, so the
 * fixture's failure cannot be check (d). The gate ALSO derives which event
 * each seam dispatches; this fixture's row names a descriptor that is not in
 * `DEFAULT_HOOK_SET`, so that derivation has nothing to bind to here and the
 * stubs above carry the event sets it would need.
 */
export class HookBus {
  static fromDirectory(directory: string): HookBus { void directory; return new HookBus(); }

  wrapToolPort(port: NativeToolPort): NativeToolPort { return port; }

  observeToolAudit(record: NativeToolAuditRecord): void { void record; }

  injectForSession(event: HookLifecycleEvent, input: unknown): TropismScope { void event; void input; }

  private runBounded<T>(fn: () => T): BoundedOutcome<T> { return { ok: true, value: fn() }; }
}
