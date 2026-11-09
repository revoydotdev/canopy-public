/**
 * Pure capability-action gate for mutation control (revoy2 port of the
 * revoy-spec `revoy.q.capability` enforcement shape, ADR-071 C6/C8).
 *
 * Unlike a read-time redaction (the envelope `absence` pattern), this is a
 * hard pre-mutation gate: a caller that attempts a *mutating* class of action
 * without the required capability tier raises `CapabilityError` BEFORE any
 * side effect occurs. `forbidden` actions are never permitted through this
 * gate regardless of tier.
 *
 * Pure and dependency-free so any mutating surface (MCP tool handler, CLI
 * mutator, the ops edit server) can enforce it identically with no authority
 * of its own.
 */

/** The closed set of action classes every mutating surface classifies into. */
export type ActionClass = "read" | "plan" | "preview-confirm" | "forbidden";

export const ACTION_CLASSES: readonly ActionClass[] = [
  "read",
  "plan",
  "preview-confirm",
  "forbidden",
];

/**
 * Minimum capability tier required for an action class. `null` means the class
 * is never executed through this gate regardless of tier (`forbidden`).
 */
/**
 * WHY `forbidden` HAS NO MEMBERS, checked 2026-08-19.
 *
 * `catalogActionClass` (runtime-catalog.ts) returns only `preview-confirm` or
 * `read`, so nothing in this repository ever produces `forbidden` and the
 * `required === null` branch below cannot fire. A survey looking for kinds that
 * genuinely warrant it found none, for two reasons worth recording so the next
 * reader does not repeat the search:
 *
 * 1. The destructive-sounding catalog kinds — `campaign.halt`, `fold.rollback`,
 *    `harness.rollback`, `harness.quarantine`, `tree.prune`, `tree.interrupt`,
 *    `recovery.abandon`, `harness.session.interrupt` — are all legitimate
 *    OPERATOR controls. "Dangerous" is not the same as "no caller may ever
 *    reach it"; those are exactly the actions an operator is there to take.
 *
 * 2. An unsupported catalog entry is already refused earlier and better.
 *    `RuntimeCatalogRouter` checks `!entry.supported` in three places
 *    (runtime-catalog.ts:442, :465, :559) and returns `unavailable` with the
 *    entry's own reason, before `enforceAction` is reached. Routing that case
 *    through `forbidden` would duplicate a guard that already exists and
 *    degrade its error.
 *
 * This repository's actual answer to "no caller should ever reach this" is
 * OMISSION — it does not register the kind. ADR-016's phase-message decision is
 * the worked example: `runtime-catalog.ts:295` records that no
 * `phase_message.record` command exists deliberately, because a write surface
 * would let a caller fabricate the evidence the ledger exists to prove. A kind
 * registered and then forbidden would be strictly worse: the catalog would
 * advertise a capability that can never be used.
 *
 * So `forbidden` stays a closed-set guard that would fire correctly if such a
 * kind were ever classified, and stays empty deliberately rather than by
 * oversight. See ADR-084 for the related finding that the tier comparison
 * below is also currently unable to fire.
 */
const REQUIRED_CAP_FOR_ACTION: Record<ActionClass, "junior" | "senior" | null> = {
  read: "junior",
  plan: "junior",
  "preview-confirm": "senior",
  forbidden: null,
};

const TIER_LEVELS: Record<"junior" | "senior", number> = { junior: 0, senior: 1 };

/** Raised by {@link enforceAction} when a mutation is not permitted. */
export class CapabilityError extends Error {
  readonly actionClass: ActionClass;
  readonly tier: "junior" | "senior";
  readonly attemptedAction: string;

  constructor(
    actionClass: ActionClass,
    tier: "junior" | "senior",
    attemptedAction = "",
  ) {
    const required = REQUIRED_CAP_FOR_ACTION[actionClass];
    super(
      `CapabilityError: action ${attemptedAction || actionClass} requires ` +
      `${required === null ? "a class no caller may perform" : `capability ${required}`} ` +
      `but caller is ${tier}`,
    );
    this.name = "CapabilityError";
    this.actionClass = actionClass;
    this.tier = tier;
    this.attemptedAction = attemptedAction;
  }
}

export type CapabilityTier = "junior" | "senior";

/** True if an action class may mutate state or remote services. */
export function isMutating(actionClass: ActionClass): boolean {
  return actionClass === "preview-confirm";
}

/**
 * The action classes a tier is entitled to perform. `forbidden` is never
 * included — it is not a tier a caller can be entitled to, it is a class no
 * caller may ever perform through this gate.
 */
export function entitledActionClasses(tier: CapabilityTier): ActionClass[] {
  const level = TIER_LEVELS[tier];
  return ACTION_CLASSES.filter((cls) => {
    const required = REQUIRED_CAP_FOR_ACTION[cls];
    return required !== null && TIER_LEVELS[required] <= level;
  });
}

/** Minimum tier required for an action class; `null` for `forbidden`. */
export function requiredCapability(actionClass: ActionClass): "junior" | "senior" | null {
  return REQUIRED_CAP_FOR_ACTION[actionClass];
}

/**
 * The enforcing gate: raises `CapabilityError` when a mutating
 * (`preview-confirm`) action is attempted by a caller who does not hold the
 * required tier. Callers that mutate MUST call this before the side effect,
 * not after. `forbidden` always raises.
 */
export function enforceAction(
  actionClass: ActionClass,
  tier: CapabilityTier,
  attemptedAction = "",
): void {
  const required = REQUIRED_CAP_FOR_ACTION[actionClass];
  const level = TIER_LEVELS[tier];
  if (required === null || TIER_LEVELS[required] > level) {
    throw new CapabilityError(actionClass, tier, attemptedAction);
  }
}
