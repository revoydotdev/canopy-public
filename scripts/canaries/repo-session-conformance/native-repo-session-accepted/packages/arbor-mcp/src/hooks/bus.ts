// Fixture stub: the campaign hook bus, in the exact shapes the gate reads. The
// single veto-capable lifecycle event is excluded from the observe lane, and the
// observe lane refuses anything that is not an observe-shaped handler.
import type { HookLifecycleContext, HookLifecycleEvent, HookLifecycleObserveHandler, HookObserveOutcome } from "./contracts.js";

export class HookBus {
  lifecycleObserve(event: Exclude<HookLifecycleEvent, "session_start">, input: { readonly session_id: string }): void {
    const context: HookLifecycleContext = { event, session_id: input.session_id };
    const entry = this.resolveHandler();
    if (entry === undefined || (entry.kind !== "lifecycle_observe" && entry.kind !== "plugin")) throw new Error("hook handler is not a registered lifecycle observe handler");
    const outcome: HookObserveOutcome = entry.handler(context);
    void outcome;
  }

  private resolveHandler(): { readonly kind: string; readonly handler: HookLifecycleObserveHandler } | undefined { return undefined; }
}