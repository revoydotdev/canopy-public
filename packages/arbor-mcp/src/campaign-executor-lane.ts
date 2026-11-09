/**
 * Which lane executes a campaign's model turns — and why.
 *
 * WHY THIS EXISTS (ADR-142). Until this module, no campaign turn in this
 * repository had ever been executed by the native harness. All three
 * `runCampaign` call sites constructed a connector executor directly:
 * `demo.ts` types its choice as `"real" | "deterministic"` where `"real"`
 * means opencode, `selfhost.ts` builds one unconditionally, and the
 * integration path selects among connectors. The one native-looking seam,
 * `createNativeLoopExecutor`, supervises a connector dispatch rather than
 * executing natively — it stamps every session
 * `OPENCODE_FALLBACK_SESSION_EXECUTION`, whose `connector_id` is the literal
 * `"opencode"`.
 *
 * The lane was therefore never a decision. It was a construction, made three
 * times, and a lane nobody selects is a lane nobody tests — which is how the
 * native harness arrived at zero campaign turns while being fully built.
 *
 * This module makes the lane an explicit, recorded resolution with one
 * definition, so a new campaign call site gets the default without opting in.
 * It decides only; it constructs nothing, which is what keeps it testable
 * without a model endpoint, a credential, or a subprocess.
 */

import type { ArborConfig } from "@arbor/config";
import { admitDeprecatedHarnessLane, describeDeprecatedHarnessAdmission, type DeprecatedHarnessAdmission } from "./canopy-lane-policy.js";

/** The lanes a campaign's model turns can run on. */
export type CampaignExecutorLane = "native" | "opencode" | "deterministic";

/**
 * What the operator asked for. `"real"` is retained as a deprecated alias
 * because it appears in existing scripts and `--help` output, but it no
 * longer *means* opencode: it means "whatever the resolved default is", which
 * is the whole point of demoting the connector to a lane.
 */
export type CampaignExecutorRequest = CampaignExecutorLane | "real" | undefined;

export interface CampaignLaneResolution {
  /** The lane that will actually run. */
  readonly lane: CampaignExecutorLane;
  /** What was asked for, before availability was considered. */
  readonly requested: CampaignExecutorLane | "default";
  /**
   * Set only when the lane is a deprecated (non-Canopy) connector the
   * operator opted into. The run records it as evidence; there is no other
   * way to reach a connector lane.
   */
  readonly deprecated_admission?: DeprecatedHarnessAdmission;
  /** Human-readable justification, suitable for a ledger entry. */
  readonly reason: string;
}

export interface CampaignLaneInput {
  /** An explicit `--executor` value, if the operator gave one. */
  readonly requested?: CampaignExecutorRequest;
  /**
   * Whether the native lane can actually run here: a complete endpoint/model
   * selection with a usable credential. Supplied by the composition root,
   * which is the only place that knows.
   */
  readonly native_available: boolean;
  /** Why the native lane is unavailable, when it is. Carried into the refusal. */
  readonly native_unavailable_reason?: string;
  /** The `connectors` policy that alone can admit a deprecated connector lane. */
  readonly config: Pick<ArborConfig, "connectors">;
}

/** The Canopy lane was required (by default or by name) and cannot run; there is no connector fallback. */
export class CanopyLaneUnavailableError extends Error {
  constructor(readonly why: string) {
    super(`the Canopy harness (revoy-native) is unavailable (${why}) and there is no connector fallback. Configure the native lane (run \`arbor doctor\` for what is missing), or pass --executor deterministic for an offline run.`);
    this.name = "CanopyLaneUnavailableError";
  }
}

/**
 * Resolve the lane.
 *
 * Canopy-only (amends ADR-061): the default is **native**, and nothing falls
 * back. An unavailable native lane is an error, whether it was requested by
 * name or by default — a default that quietly degrades to a connector is the
 * silent lane ADR-142 set out to end. The opencode connector runs only when
 * named explicitly AND admitted by `connectors.allow_deprecated`; otherwise
 * its request throws the typed `DeprecatedHarnessRefusal`. `deterministic`
 * is a seeded offline double, not a harness, and stays available.
 */
export function resolveCampaignExecutorLane(input: CampaignLaneInput): CampaignLaneResolution {
  const requested = input.requested === undefined || input.requested === "real" ? "default" : input.requested;

  if (requested === "deterministic") {
    return { lane: "deterministic", requested, reason: "deterministic executor requested; no model calls are made" };
  }
  if (requested === "opencode") {
    const admission = admitDeprecatedHarnessLane("opencode", "--executor opencode", input.config);
    return { lane: "opencode", requested, deprecated_admission: admission, reason: describeDeprecatedHarnessAdmission(admission) };
  }

  // `native` requested, or nothing requested (default is native).
  if (input.native_available) {
    return {
      lane: "native",
      requested,
      reason: requested === "native"
        ? "the native harness was requested and is available"
        : "the native harness is the default campaign executor and is available",
    };
  }
  throw new CanopyLaneUnavailableError(input.native_unavailable_reason ?? "no reason was supplied by the composition root");
}

/**
 * Parse an `--executor` value into a request, rejecting anything else rather
 * than silently treating an unknown lane as the default. A typo that resolves
 * to "whatever the default is" is how an operator ends up believing they
 * selected a lane they did not.
 */
export function parseCampaignExecutorRequest(value: string | undefined): CampaignExecutorRequest {
  if (value === undefined) return undefined;
  if (value === "native" || value === "opencode" || value === "deterministic" || value === "real") return value;
  throw new Error(`unknown --executor "${value}": expected native, opencode, or deterministic (\`real\` is a deprecated alias for the default)`);
}
