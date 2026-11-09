/**
 * Deterministic startup selection for an untrusted directory.  This is kept
 * outside CLI parsing so every transport can compose the same conservative
 * participant set.  Safe mode is a subtraction only: it never disables the
 * governance plane that records, approves, and audits the remaining work.
 */
export type SafeStartupParticipantKind = "governance" | "integration" | "customization";
export type SafeStartupTrust = "builtin" | "trusted" | "untrusted";

export interface SafeStartupParticipant {
  readonly id: string;
  readonly kind: SafeStartupParticipantKind;
  readonly trust: SafeStartupTrust;
  readonly start?: () => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
}

export interface SafeStartupDiagnostic {
  readonly code: "safe_mode_active" | "participant_started" | "participant_skipped" | "participant_start_failed" | "participant_closed";
  readonly participant_id?: string;
  readonly summary: string;
}

export interface SafeStartupPlan {
  readonly safe_mode: boolean;
  readonly active: readonly SafeStartupParticipant[];
  readonly skipped: readonly Readonly<{ participant: SafeStartupParticipant; reason: "customization" | "untrusted_integration" }>[];
  readonly diagnostics: readonly SafeStartupDiagnostic[];
}

function assertParticipants(participants: readonly SafeStartupParticipant[]): void {
  const seen = new Set<string>();
  for (const participant of participants) {
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(participant.id)) throw new Error(`invalid startup participant id: ${participant.id}`);
    if (seen.has(participant.id)) throw new Error(`duplicate startup participant id: ${participant.id}`);
    seen.add(participant.id);
  }
}

/**
 * Applies safe mode in the stable caller order. Governance is retained even
 * if a caller incorrectly labels it untrusted: authority planes are not
 * customizations and must remain observable when stand-down mode is active.
 */
export function planSafeStartup(participants: readonly SafeStartupParticipant[], safeMode: boolean): SafeStartupPlan {
  assertParticipants(participants);
  const active: SafeStartupParticipant[] = [];
  const skipped: Array<{ participant: SafeStartupParticipant; reason: "customization" | "untrusted_integration" }> = [];
  const diagnostics: SafeStartupDiagnostic[] = safeMode ? [{ code: "safe_mode_active", summary: "safe mode enabled; untrusted and customization participants are disabled" }] : [];
  for (const participant of participants) {
    if (!safeMode || participant.kind === "governance") { active.push(participant); continue; }
    if (participant.kind === "customization") {
      skipped.push({ participant, reason: "customization" });
    } else if (participant.trust === "untrusted") {
      skipped.push({ participant, reason: "untrusted_integration" });
    } else {
      active.push(participant);
      continue;
    }
    diagnostics.push({ code: "participant_skipped", participant_id: participant.id, summary: `${participant.id} disabled in safe mode (${skipped.at(-1)!.reason})` });
  }
  return Object.freeze({ safe_mode: safeMode, active: Object.freeze(active), skipped: Object.freeze(skipped), diagnostics: Object.freeze(diagnostics) });
}

/**
 * Starts only the plan's active participants and closes a partially started
 * set on failure.  This makes safe startup executable rather than a UI hint.
 */
export class SafeStartupController {
  readonly name = "safe-startup";
  private readonly plan: SafeStartupPlan;
  private readonly events: SafeStartupDiagnostic[];
  private started: SafeStartupParticipant[] = [];

  constructor(participants: readonly SafeStartupParticipant[], safeMode: boolean) {
    this.plan = planSafeStartup(participants, safeMode);
    this.events = [...this.plan.diagnostics];
  }

  startupPlan(): SafeStartupPlan { return this.plan; }
  diagnostics(): readonly SafeStartupDiagnostic[] { return Object.freeze([...this.events]); }

  async start(): Promise<void> {
    if (this.started.length > 0) return;
    try {
      for (const participant of this.plan.active) {
        await participant.start?.();
        this.started.push(participant);
        this.events.push({ code: "participant_started", participant_id: participant.id, summary: `${participant.id} started` });
      }
    } catch (error) {
      const failed = this.plan.active[this.started.length];
      this.events.push({ code: "participant_start_failed", participant_id: failed?.id, summary: `${failed?.id ?? "startup participant"} failed to start` });
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const started = this.started.splice(0).reverse();
    for (const participant of started) {
      await participant.close?.();
      this.events.push({ code: "participant_closed", participant_id: participant.id, summary: `${participant.id} closed` });
    }
  }
}
