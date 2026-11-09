/**
 * Revoy-owned structured contract for a native critic decision.
 *
 * The provider may enforce this JSON Schema as a convenience, but that is not
 * the trust boundary. `validate` is run by the native worker before a review
 * session can complete, and `parse` only accepts that same closed shape. This
 * keeps the campaign loop from deriving a verdict from free-form model text.
 */
import type { CriticCheck, CriticVerdict } from "@arbor/core";
import type {
  NativeStructuredOutputContract,
  NativeStructuredOutputValidation,
  OpenAICompatibleStructuredSchema,
} from "@arbor/harness";

export const NATIVE_CRITIC_VERDICT_SCHEMA_ID = "revoy.native.critic-verdict.v1";

/**
 * Typed classification for a verdict that has the contract's shape but not
 * its content: a rationale, root cause or check detail that is placeholder
 * or template text. It is malformed critic output, never a review outcome,
 * so it can neither approve nor reject the work it names.
 */
export const NATIVE_CRITIC_MALFORMED_VERDICT = "malformed_critic_verdict";

/**
 * Exact-match placeholder vocabulary, compared after normalisation. It is
 * deliberately closed: a short but genuine finding ("not applicable: docs
 * only") must never be mistaken for a template, so only whole-field
 * placeholders count.
 */
const PLACEHOLDER_TEXT = new Set([
  "placeholder", "todo", "tbd", "tbc", "fixme", "xxx", "string", "text", "detail", "details", "rationale",
  "reason", "root cause", "root_cause", "explanation", "description", "lorem ipsum", "null", "undefined",
  "required non-empty on rejection", "your rationale here", "rationale here", "detail here", "insert rationale",
]);

const CHECK_NAMES = [
  "root_cause",
  "measurement_validation",
  "guardrail_enforcement",
  "introspection",
  "stability_monitoring",
] as const satisfies readonly CriticCheck["name"][];

/**
 * X-2 (patch-overfitting #2, arXiv 2306.09896 evidence-bottleneck finding):
 * `completeness` is an OPTIONAL sixth check name accepted in the `checks`
 * array, mirroring exactly how `confidence` (E-3) was added — never required,
 * so an older payload that omits it entirely still parses as a valid
 * verdict. Unlike `confidence` it carries no dedicated top-level boolean
 * (the manifest asks only for a `checks` entry); a present-but-failed
 * `completeness` check is already treated like any other failed mandate by
 * the existing `checks.some((check) => !check.passed)` approval guard below
 * -- no new gate was invented for it.
 */
const OPTIONAL_CHECK_NAMES = ["completeness"] as const;
type OptionalCheckName = (typeof OPTIONAL_CHECK_NAMES)[number];
const ALL_CHECK_NAMES = [...CHECK_NAMES, ...OPTIONAL_CHECK_NAMES] as const satisfies readonly (CriticCheck["name"] | OptionalCheckName)[];

type NativeCriticCheck = Readonly<{
  name: CriticCheck["name"];
  passed: boolean;
  detail: string;
}>;

export interface NativeCriticStructuredVerdict {
  readonly approved: boolean;
  readonly rationale: string;
  /** Always present: null is the canonical absence when an approval has no blocker. */
  readonly root_cause: string | null;
  readonly measurement_validated: boolean;
  readonly guardrails_enforced: boolean;
  readonly introspection_passed: boolean;
  readonly stability_ok: boolean;
  readonly checks: readonly NativeCriticCheck[];
  /**
   * E-3 (arXiv 2607.05391): a self-reported confidence in [0, 1], present
   * only when the raw payload carried a valid one. Absent, non-numeric, or
   * out-of-range values are dropped here (never fail the whole verdict) --
   * the caller sees exactly today's behavior for a verdict with no usable
   * confidence signal.
   */
  readonly confidence?: number;
}

/** A structured-output validator plus the only parser allowed to feed a critic result. */
export interface NativeCriticVerdictContract extends NativeStructuredOutputContract {
  parse(value: unknown, critic: string): CriticVerdict | null;
}

/**
 * Provider-facing schema. It deliberately has no escape hatch for extra
 * fields: acceptance is governed by the matching local parser below, not by
 * provider claims about JSON-schema conformance.
 */
export const NATIVE_CRITIC_VERDICT_SCHEMA: OpenAICompatibleStructuredSchema = Object.freeze({
  schema_id: NATIVE_CRITIC_VERDICT_SCHEMA_ID,
  name: "revoy_native_critic_verdict",
  strict: true,
  schema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: [
      "approved",
      "rationale",
      "root_cause",
      "measurement_validated",
      "guardrails_enforced",
      "introspection_passed",
      "stability_ok",
      "checks",
      "confidence",
    ],
    properties: {
      approved: { type: "boolean" },
      rationale: { type: "string", minLength: 1 },
      root_cause: { type: ["string", "null"] },
      measurement_validated: { type: "boolean" },
      guardrails_enforced: { type: "boolean" },
      introspection_passed: { type: "boolean" },
      stability_ok: { type: "boolean" },
      checks: {
        type: "array",
        // X-2: the mandatory five checks stay required; a sixth
        // `completeness` entry is accepted (never required) alongside them.
        minItems: CHECK_NAMES.length,
        maxItems: ALL_CHECK_NAMES.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "passed", "detail"],
          properties: {
            name: { type: "string", enum: ALL_CHECK_NAMES },
            passed: { type: "boolean" },
            detail: { type: "string", minLength: 1 },
          },
        },
      },
      /**
       * E-3: required-but-nullable (the OpenAI strict-schema convention this
       * file already uses for `root_cause`) so a compliant provider always
       * addresses it. The LOCAL parser below (the real trust boundary, per
       * this file's header comment) does NOT require the key to be present
       * at all -- an older or malformed payload missing it entirely still
       * parses as a valid verdict, just with no confidence signal.
       */
      confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
    },
    // Keep the provider-facing form to the portable structural subset. The
    // OpenAI-compatible and other provider schema dialects may support only
    // a subset of JSON Schema; cross-field approval semantics are enforced
    // below by the Revoy-owned parser, never delegated to this hint.
  }),
});

/** The worker receives this fixed, composition-owned contract for every native review. */
export const NATIVE_CRITIC_VERDICT_CONTRACT: NativeCriticVerdictContract = Object.freeze({
  schema_id: NATIVE_CRITIC_VERDICT_SCHEMA_ID,
  validate(value: unknown): NativeStructuredOutputValidation {
    const checked = checkNativeCriticStructuredVerdict(value);
    if (checked.verdict !== null) return { valid: true };
    // Every defect is named in one reason, so the bounded correction turn
    // tells the critic everything to fix at once. A placeholder anywhere is
    // classified malformed, so an exhausted correction fails the review as
    // malformed output rather than standing as a rejection of the work.
    return nativeCriticVerdictPlaceholderFields(value).length === 0
      ? { valid: false, reason: `native critic response did not satisfy ${NATIVE_CRITIC_VERDICT_SCHEMA_ID}: ${nativeCriticDefectList(checked.defects)}` }
      : { valid: false, reason: `${NATIVE_CRITIC_MALFORMED_VERDICT}: ${nativeCriticDefectList(checked.defects)}` };
  },
  // H7 (UCT Stage 0 Revision 2.2): a critic reply with no JSON value at all
  // gets the same bounded correction turns as JSON the contract refused, with
  // a reason that says exactly what to send. Once the corrections are spent
  // the review fails under this reason, so `review()` reports it as
  // malformed critic output and the node is parked, never failed (ADR-184).
  unparsed_reason: nativeCriticUnparsedReason,
  parse: parseNativeCriticVerdict,
});

/**
 * The correction, and the exhausted review's failure reason, for a critic
 * reply from which no JSON value could be recovered. It starts with
 * `malformed_critic_verdict` because a reply that is not a verdict is
 * malformed critic output, not a review of the work.
 */
export function nativeCriticUnparsedReason(detail: string): string {
  return `${NATIVE_CRITIC_MALFORMED_VERDICT}: your reply was not a JSON object (${detail.slice(0, 160)}); reply with only the verdict object per ${NATIVE_CRITIC_VERDICT_SCHEMA_ID}: one JSON object with approved, rationale, root_cause, measurement_validated, guardrails_enforced, introspection_passed, stability_ok, checks and confidence, and no prose, reasoning or markdown before or after it`;
}

/**
 * Convert only a locally validated payload into the core verdict type. The
 * critic identity is composition-owned; a provider cannot nominate itself.
 */
export function parseNativeCriticVerdict(value: unknown, critic: string): CriticVerdict | null {
  const parsed = parseNativeCriticStructuredVerdict(value);
  if (parsed === null || !critic.trim()) return null;
  return Object.freeze({
    approved: parsed.approved,
    critic,
    rationale: parsed.rationale,
    ...(parsed.root_cause === null ? {} : { root_cause: parsed.root_cause }),
    measurement_validated: parsed.measurement_validated,
    guardrails_enforced: parsed.guardrails_enforced,
    introspection_passed: parsed.introspection_passed,
    stability_ok: parsed.stability_ok,
    checks: parsed.checks.map((check) => ({ ...check })),
    // E-3: this transport never has provider logprobs available (verified:
    // no such field anywhere in @arbor/harness's response types), so a
    // present confidence is always self-reported.
    ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence, confidence_source: "self_report" as const }),
  });
}

/**
 * E-3 (arXiv 2607.05391): best-effort extraction of a self-reported
 * confidence score from raw critic response text, independent of whichever
 * (looser, opencode-executor-owned) parser produced the verdict itself.
 * Never throws; absent, non-numeric, or out-of-[0,1]-range confidence all
 * return null -- callers that don't merge anything in see exactly today's
 * behavior.
 *
 * DEVIATION FROM SPEC: the brief asks for logprobs-derived confidence when
 * the provider supports it. `@arbor/harness`'s `NativeModelPort`/native
 * worker surfaces carry no logprobs field today, so only the self-reported
 * path is implemented; `confidence_source` is therefore always
 * `"self_report"`, never `"logprobs"`.
 */
export function extractCriticConfidence(raw: string): { readonly confidence: number; readonly confidence_source: "self_report" } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try { value = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!isRecord(value)) return null;
  const confidence = value.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { confidence, confidence_source: "self_report" };
}

/**
 * Shape examples shown to the critic (D7, UCT Stage 0 pilot 4: 18 of 19
 * critics that produced JSON first keyed `checks` by name, because the prompt
 * named the checks but never stated their shape). Every prose field is an
 * angle-bracket slot, which the contract refuses as placeholder text, so a
 * critic that copies an example instead of reviewing is corrected rather
 * than accepted; with the slots filled, each example is a valid verdict.
 */
export const NATIVE_CRITIC_VERDICT_EXAMPLES = Object.freeze({
  approve: Object.freeze({
    approved: true,
    rationale: "<why the change is correct, citing the evidence>",
    root_cause: null,
    measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true,
    checks: Object.freeze([
      Object.freeze({ name: "root_cause", passed: true, detail: "<why no blocker remains>" }),
      Object.freeze({ name: "measurement_validation", passed: true, detail: "<what measured the change and its result>" }),
      Object.freeze({ name: "guardrail_enforcement", passed: true, detail: "<what you checked for scope and weakened tests>" }),
      Object.freeze({ name: "introspection", passed: true, detail: "<what you checked in the specialist's own reasoning>" }),
      Object.freeze({ name: "stability_monitoring", passed: true, detail: "<what you checked for new failures>" }),
    ]),
    confidence: 0.8,
  }),
  reject: Object.freeze({
    approved: false,
    rationale: "<why the change cannot be accepted>",
    root_cause: "<the concrete blocker>",
    measurement_validated: false, guardrails_enforced: true, introspection_passed: true, stability_ok: true,
    checks: Object.freeze([
      Object.freeze({ name: "root_cause", passed: false, detail: "<the blocker and where it is>" }),
      Object.freeze({ name: "measurement_validation", passed: false, detail: "<what failed or was not measured>" }),
      Object.freeze({ name: "guardrail_enforcement", passed: true, detail: "<what you checked for scope and weakened tests>" }),
      Object.freeze({ name: "introspection", passed: true, detail: "<what you checked in the specialist's own reasoning>" }),
      Object.freeze({ name: "stability_monitoring", passed: true, detail: "<what you checked for new failures>" }),
    ]),
    confidence: 0.7,
  }),
});

/**
 * Prompt guidance only; the schema and local validator remain authoritative.
 * `tools: "none"` is for a review composed with no tools (every native critic
 * profile): it says so, and forbids writing tool-call syntax as text, which a
 * tool-less critic otherwise spends its correction turns on (UCT Stage 0
 * pilot 4, 9 of 25 review sessions).
 */
export function nativeCriticVerdictInstruction(options: { readonly tools?: "none" | "composed" } = {}): string {
  return [
    ...(options.tools === "none" ? ["No tools are available in this review. Do not call tools and do not write tool-call syntax (such as <tool_call>, <function_call>, function-call JSON or XML tags) as text; judge from the task, the specialist output and the evidence above, and answer with the verdict."] : []),
    `Return exactly one JSON object matching the composed revoy native critic verdict contract (${NATIVE_CRITIC_VERDICT_SCHEMA_ID}). Its fields are exactly:`,
    "approved (boolean);",
    "rationale (non-empty string);",
    "root_cause (null when approved; a non-empty string naming the blocker when not approved);",
    "measurement_validated, guardrails_enforced, introspection_passed and stability_ok (booleans);",
    `checks: an ARRAY of objects, each exactly {"name": string, "passed": boolean, "detail": non-empty string}, with exactly one entry each for ${CHECK_NAMES.join(", ")}. checks is never an object keyed by check name, and the text field of a check is named detail (not evidence, reason or anything else);`,
    "confidence (a number between 0 and 1 inclusive giving your calibrated confidence that this verdict is correct, or null if you cannot estimate it).",
    "Optionally add one more check named completeness: does the change address every site/aspect of the root cause, not merely enough to satisfy the declared test? Include it only when you have a genuine judgment to report; a failed completeness check is treated as a failed mandate.",
    "The two views must agree or the verdict is rejected: checks[measurement_validation].passed must equal measurement_validated, checks[guardrail_enforcement].passed must equal guardrails_enforced, checks[introspection].passed must equal introspection_passed, checks[stability_monitoring].passed must equal stability_ok, and checks[root_cause].passed must be true exactly when root_cause is null (passed means no blocker was found, so a rejection that names a blocker has checks[root_cause].passed false). An approval asserts every check passed.",
    "The shape of an approval (replace every <...> slot with your own concrete finding; slot text is refused as a placeholder):",
    JSON.stringify(NATIVE_CRITIC_VERDICT_EXAMPLES.approve),
    "The shape of a rejection, here one whose measurement failed:",
    JSON.stringify(NATIVE_CRITIC_VERDICT_EXAMPLES.reject),
    "Reply with that one JSON object only: no prose, markdown, code fences or fields outside the contract.",
  ].join(" ");
}

/**
 * Base verdict keys required on every payload. `confidence` (E-3) is
 * deliberately NOT in this list even though the provider-facing schema marks
 * it required-but-nullable: this local check is the trust boundary, and a
 * payload that omits the new field is still a valid governance verdict.
 */
const REQUIRED_VERDICT_KEYS = ["approved", "rationale", "root_cause", "measurement_validated", "guardrails_enforced", "introspection_passed", "stability_ok", "checks"] as const;
/** Keys a payload may optionally carry in addition to the required set, without being rejected as "free-form extras". */
const OPTIONAL_VERDICT_KEYS = ["confidence"] as const;

function parseNativeCriticStructuredVerdict(value: unknown): NativeCriticStructuredVerdict | null {
  return checkNativeCriticStructuredVerdict(value).verdict;
}

/**
 * The local trust boundary. A refusal names every rule the payload broke, and
 * that text is what the worker's bounded correction turn hands back to the
 * critic. A bare "did not satisfy the contract" left a critic that approved
 * while failing one check (UCT Stage 0, 2026-10-07: `approved: true` with
 * `introspection: false`, three times) nothing to correct, so it re-sent the
 * same verdict until the corrections ran out and the node was parked. Naming
 * only the first defect was the D7 shape (UCT Stage 0 pilot 4): a critic that
 * sent name-keyed `checks`, then entries with `evidence` for `detail`, spent
 * both of its corrections on the shape alone. So the whole payload is checked
 * and every defect is reported at once; acceptance is unchanged.
 */
function checkNativeCriticStructuredVerdict(value: unknown): { readonly verdict: NativeCriticStructuredVerdict; readonly defects?: undefined } | { readonly verdict: null; readonly defects: readonly string[] } {
  if (!isRecord(value)) return { verdict: null, defects: ["the response must be one JSON object"] };
  const defects: string[] = [];
  const missing = REQUIRED_VERDICT_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) defects.push(`missing required field(s): ${missing.join(", ")}`);
  const allowed = new Set<string>([...REQUIRED_VERDICT_KEYS, ...OPTIONAL_VERDICT_KEYS]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) defects.push(`field(s) outside the contract: ${extra.slice(0, 4).map((key) => key.slice(0, 48)).join(", ")}`);
  // A schema-shaped verdict whose prose is template text was never a review.
  for (const field of nativeCriticVerdictPlaceholderFields(value)) defects.push(`${field} holds placeholder or template text instead of a review finding; state the concrete finding`);

  const approved = typeof value.approved === "boolean" ? value.approved : null;
  if (Object.hasOwn(value, "approved") && approved === null) defects.push("approved must be a boolean");
  if (Object.hasOwn(value, "rationale") && !nonEmpty(value.rationale)) defects.push("rationale must be a non-empty string");
  const rootCauseValid = value.root_cause === null || nonEmpty(value.root_cause);
  if (Object.hasOwn(value, "root_cause") && !rootCauseValid) defects.push("root_cause must be null or a non-empty string");
  const flags = ["measurement_validated", "guardrails_enforced", "introspection_passed", "stability_ok"] as const;
  for (const flag of flags) if (Object.hasOwn(value, flag) && typeof value[flag] !== "boolean") defects.push(`${flag} must be a boolean`);
  // A rejection without a concrete blocker is not a governed review result;
  // an approval must carry the canonical null absence rather than a spurious
  // blocker that downstream views could mistake for a warning.
  if (approved === false && !nonEmpty(value.root_cause)) defects.push("approved is false, so root_cause must name the blocker");
  if (approved === true && Object.hasOwn(value, "root_cause") && value.root_cause !== null) defects.push("approved is true, so root_cause must be null");

  // X-2: `checks` must carry at least the five mandatory names; it may
  // additionally carry one optional `completeness` entry, never more.
  const checks: NativeCriticCheck[] = [];
  let checksComplete = false;
  if (Object.hasOwn(value, "checks")) {
    if (!Array.isArray(value.checks)) {
      defects.push(isRecord(value.checks)
        ? `checks must be an array of {name, passed, detail} objects, not an object keyed by check name: send [{"name": "root_cause", "passed": true, "detail": "..."}, ...] with one entry each for ${CHECK_NAMES.join(", ")}`
        : `checks must be an array of {name, passed, detail} objects, one each for ${CHECK_NAMES.join(", ")}`);
    } else {
      if (value.checks.length < CHECK_NAMES.length || value.checks.length > ALL_CHECK_NAMES.length) {
        defects.push(`checks must be an array of one entry each for ${CHECK_NAMES.join(", ")}, plus at most one completeness entry (got ${value.checks.length} entries)`);
      }
      // `seen` holds every recognised name, even on an otherwise malformed
      // entry, so a misshapen entry is not also reported as a missing check.
      const seen = new Set<CriticCheck["name"]>();
      let entriesValid = true;
      value.checks.forEach((candidate: unknown, index: number) => {
        const entryDefects = checkEntryDefects(candidate);
        const name = isRecord(candidate) && isCheckName(candidate.name) ? candidate.name : null;
        const label = isRecord(candidate) && typeof candidate.name === "string" ? `checks[${index}] (${candidate.name.slice(0, 48)})` : `checks[${index}]`;
        if (name !== null && seen.has(name)) { entriesValid = false; defects.push(`checks names ${name} more than once`); return; }
        if (name !== null) seen.add(name);
        if (entryDefects.length > 0) {
          entriesValid = false;
          defects.push(`${label} ${entryDefects.join(", ")}; every check must be exactly {name, passed, detail}`);
          return;
        }
        const entry = candidate as { name: CriticCheck["name"]; passed: boolean; detail: string };
        checks.push(Object.freeze({ name: entry.name, passed: entry.passed, detail: entry.detail }));
      });
      // Every mandatory name must be present exactly once; `isCheckName`
      // bounds membership to `ALL_CHECK_NAMES`, so only the optional
      // `completeness` name can push `seen.size` past `CHECK_NAMES.length`.
      const absent = CHECK_NAMES.filter((name) => !seen.has(name));
      if (absent.length > 0) defects.push(`checks is missing ${absent.join(", ")}`);
      checksComplete = entriesValid && absent.length === 0;
    }
  }

  // The concise boolean summary and the named check list are two views of
  // the same decision.  Letting a provider say "approved" while either view
  // records a failed mandatory guard would turn the schema into a cosmetic
  // wrapper around an ungoverned approval.  JSON Schema cannot correlate
  // array members by their `name`, so this locally enforced correspondence is
  // the authority boundary (not a best-effort prompt convention).
  const passedByName = new Map(checks.map((check) => [check.name, check.passed] as const));
  for (const [name, flag] of [
    ["measurement_validation", "measurement_validated"],
    ["guardrail_enforcement", "guardrails_enforced"],
    ["introspection", "introspection_passed"],
    ["stability_monitoring", "stability_ok"],
  ] as const) {
    const passed = passedByName.get(name);
    if (passed !== undefined && typeof value[flag] === "boolean" && passed !== value[flag]) defects.push(`checks[${name}].passed must equal ${flag}`);
  }
  // checks[root_cause].passed means "no blocker was found", not "a root cause
  // was identified". Critics read it the second way (UCT Stage 0 re-pilot,
  // observation O1: three correct rejections refused with a blocker in
  // root_cause and checks[root_cause].passed true), so the refusal names the
  // direction to fix rather than restating the rule.
  const rootCausePassed = passedByName.get("root_cause");
  if (rootCausePassed !== undefined && Object.hasOwn(value, "root_cause") && rootCauseValid && rootCausePassed !== (value.root_cause === null)) {
    defects.push(value.root_cause === null
      ? "checks[root_cause].passed is false but root_cause is null; checks[root_cause].passed means no blocker was found, so either set it to true or name the blocker in root_cause"
      : "root_cause names a blocker, so checks[root_cause].passed must be false (passed means no blocker was found, not that a root cause was identified); keep approved and root_cause as they are and set checks[root_cause].passed to false");
  }
  // A native approval is a positive claim that all five mandatory review
  // checks passed.  A rejection may retain the same evidence while one or
  // more checks failed, but it can never be promoted to approval by a
  // contradictory top-level boolean. This iterates the FULL checks array, so
  // a present-but-failed optional `completeness` (X-2) check blocks approval
  // exactly like a failed mandate, with no separate gate needed for it.
  const failed = checks.filter((check) => !check.passed).map((check) => check.name);
  if (approved === true && failed.length > 0) {
    // The critic decides; the contract only refuses the contradiction. Both
    // ways out are named, so the correction turn can resolve it either way
    // instead of re-sending the same verdict.
    defects.push(`approved is true but ${failed.map((name) => `checks[${name}]`).join(", ")} failed; an approval asserts every check passed. Resolve the contradiction with your own judgement: if that failure blocks the change, set approved to false and name it in root_cause; if on reflection the check did pass, mark it and its summary flag passed and keep any reservation in its detail`);
  }
  if (defects.length > 0 || !checksComplete) return { verdict: null, defects: defects.length > 0 ? defects : ["checks is incomplete"] };
  // E-3: a present-but-malformed confidence (non-numeric, null, or outside
  // [0, 1]) is dropped rather than failing the whole verdict — see the field
  // doc on `NativeCriticStructuredVerdict.confidence`.
  const rawConfidence = value.confidence;
  const confidence = typeof rawConfidence === "number" && Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
    ? rawConfidence
    : undefined;
  return { verdict: Object.freeze({
    approved: value.approved as boolean,
    rationale: value.rationale as string,
    root_cause: value.root_cause as string | null,
    measurement_validated: value.measurement_validated as boolean,
    guardrails_enforced: value.guardrails_enforced as boolean,
    introspection_passed: value.introspection_passed as boolean,
    stability_ok: value.stability_ok as boolean,
    checks: Object.freeze(checks),
    ...(confidence === undefined ? {} : { confidence }),
  }) };
}

/** Everything wrong with one `checks` entry, so a correction can fix it in one pass. */
function checkEntryDefects(candidate: unknown): string[] {
  if (!isRecord(candidate)) return ["is not an object"];
  const defects: string[] = [];
  const extra = Object.keys(candidate).filter((key) => key !== "name" && key !== "passed" && key !== "detail");
  if (extra.length > 0) {
    const renamesDetail = !Object.hasOwn(candidate, "detail");
    defects.push(`has field(s) outside the contract: ${extra.slice(0, 4).map((key) => key.slice(0, 48)).join(", ")}${renamesDetail ? " (put that text in detail)" : ""}`);
  }
  if (!isCheckName(candidate.name)) defects.push(`name must be one of ${ALL_CHECK_NAMES.join(", ")}`);
  if (typeof candidate.passed !== "boolean") defects.push("passed must be a boolean");
  if (!nonEmpty(candidate.detail)) defects.push("detail must be a non-empty string");
  return defects;
}

/** Joins every defect into the one correction the critic receives. */
function nativeCriticDefectList(defects: readonly string[]): string {
  const text = defects.length === 1 ? defects[0]! : `${defects.length} violations, fix all of them in one reply: ${defects.map((defect, index) => `(${index + 1}) ${defect}`).join("; ")}`;
  return text.slice(0, MAX_CORRECTION_CHARS);
}
const MAX_CORRECTION_CHARS = 4_000;

/**
 * The first field of a candidate verdict whose text is a placeholder, or
 * null. `root_cause` is checked only when it is a string, since null is its
 * canonical absence on an approval.
 */
export function nativeCriticVerdictPlaceholderField(value: unknown): string | null {
  return nativeCriticVerdictPlaceholderFields(value)[0] ?? null;
}

/** Every field of a candidate verdict whose text is a placeholder, in contract order. */
function nativeCriticVerdictPlaceholderFields(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const fields: string[] = [];
  if (isPlaceholderText(value.rationale)) fields.push("rationale");
  if (typeof value.root_cause === "string" && isPlaceholderText(value.root_cause)) fields.push("root_cause");
  if (Array.isArray(value.checks)) {
    for (const check of value.checks) {
      if (isRecord(check) && isPlaceholderText(check.detail)) fields.push(`checks[${typeof check.name === "string" ? check.name : "?"}].detail`);
    }
  }
  return fields;
}

/** Whole-field placeholder: template vocabulary, an angle-bracket slot, or punctuation alone. */
function isPlaceholderText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/^[\p{P}\p{S}\s]+$/u.test(trimmed)) return true;
  const unquoted = trimmed.toLowerCase().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (/^<[^<>]*>$/.test(unquoted) || /^\{\{[^{}]*\}\}$/.test(unquoted)) return true;
  return PLACEHOLDER_TEXT.has(unquoted.replace(/[.:;!]+$/g, "").trim());
}

function isCheckName(value: unknown): value is CriticCheck["name"] {
  return typeof value === "string" && (ALL_CHECK_NAMES as readonly string[]).includes(value);
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
