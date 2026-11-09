/**
 * Real cockpit sources for the `arbor tui` / `arbor demo` harness.
 *
 * PROD-STUB FIX: `runTui` (and the demo) previously wired a hardcoded zero
 * telemetry source to the HeadlessHarness — `{ campaign_id: "boot",
 * source_record_count: 0, counters: [], ... }` — even though the runtime can
 * project real telemetry. This module supplies the real, ledger-derived source
 * so the telemetry view shows actual phase-duration / provider-cost data
 * (ADR-017), never fabricated zeros.
 */
import { freezeTelemetrySnapshot, type TelemetrySourcePort, type TelemetrySnapshot } from "@arbor/tui";
import type { ArborRuntime } from "./runtime.js";

/**
 * A real `TelemetrySourcePort` backed by the canonical runtime's
 * ledger-derived telemetry projection (ADR-017).
 *
 * `projectTelemetry` (metrics-projector.ts) does NOT throw for the honest
 * "nothing observed yet" case — a campaign with zero telemetry records still
 * projects a valid snapshot with `source_record_count: 0` and empty series,
 * because the record scan simply finds nothing to fold in. It only throws
 * `AuditIntegrityError` for a genuine fault: an empty campaign id, an
 * unverifiable/tampered ledger, or a projection that exceeds its bound.
 *
 * The previous version of this function caught every one of those genuine
 * faults and silently substituted the same all-zero snapshot a real "nothing
 * happened yet" campaign produces — so a corrupted ledger and an empty
 * campaign were indistinguishable on screen (this was the pilot run's stuck
 * "2 of 30 observations" telemetry: a transient projection failure rendered
 * identically to true emptiness). `fetch` no longer swallows that distinction:
 * a genuine projection failure now rejects, which `HeadlessHarness`'s
 * existing `fetch_telemetry` effect handler (headless.ts) already turns into
 * a visible `error_raised` notification (`fingerprint:
 * "telemetry:fetch-failed"`) instead of a fabricated zero snapshot.
 */
export function createCockpitTelemetrySource(runtime: ArborRuntime): TelemetrySourcePort {
  return {
    async fetch(campaignId: string): Promise<TelemetrySnapshot> {
      const projection = runtime.manager.projectTelemetry(campaignId);
      return freezeTelemetrySnapshot(projection as unknown as TelemetrySnapshot);
    },
  };
}
