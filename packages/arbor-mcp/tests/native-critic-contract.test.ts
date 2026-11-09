import { describe, expect, it } from "vitest";
import {
  NATIVE_CRITIC_MALFORMED_VERDICT,
  NATIVE_CRITIC_VERDICT_CONTRACT,
  NATIVE_CRITIC_VERDICT_SCHEMA,
  NATIVE_CRITIC_VERDICT_EXAMPLES,
  NATIVE_CRITIC_VERDICT_SCHEMA_ID,
  extractCriticConfidence,
  nativeCriticVerdictInstruction,
  nativeCriticUnparsedReason,
  parseNativeCriticVerdict,
} from "../src/native-critic-contract.js";

interface TestCriticCheck { readonly name: string; readonly passed: boolean; readonly detail: string }
interface TestCriticVerdict {
  readonly approved: boolean; readonly rationale: string; readonly root_cause: string | null;
  readonly measurement_validated: boolean; readonly guardrails_enforced: boolean;
  readonly introspection_passed: boolean; readonly stability_ok: boolean;
  readonly checks: readonly TestCriticCheck[];
}

function verdict(overrides: Partial<TestCriticVerdict> = {}): TestCriticVerdict {
  return {
    approved: true,
    rationale: "bounded evidence is sufficient",
    root_cause: null,
    measurement_validated: true,
    guardrails_enforced: true,
    introspection_passed: true,
    stability_ok: true,
    checks: [
      { name: "root_cause", passed: true, detail: "no blocker" },
      { name: "measurement_validation", passed: true, detail: "measurements are attributable" },
      { name: "guardrail_enforcement", passed: true, detail: "no review tools were composed" },
      { name: "introspection", passed: true, detail: "scope was examined" },
      { name: "stability_monitoring", passed: true, detail: "no instability was observed" },
    ],
    ...overrides,
  };
}

describe("native critic structured verdict contract", () => {
  it("has a stable, fixed schema identity and produces a core verdict only from the closed shape", () => {
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.schema_id).toBe(NATIVE_CRITIC_VERDICT_SCHEMA_ID);
    expect(NATIVE_CRITIC_VERDICT_SCHEMA).toMatchObject({ schema_id: NATIVE_CRITIC_VERDICT_SCHEMA_ID, strict: true });
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(verdict())).toEqual({ valid: true });
    const parsed = parseNativeCriticVerdict(verdict(), "lenticel");
    expect(parsed).toMatchObject({ approved: true, critic: "lenticel" });
    expect(parsed?.checks.map((check) => check.name)).toEqual([
      "root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring",
    ]);
  });

  it("fails closed for free-form extras, missing required checks, and a rejection without a concrete blocker", () => {
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate({ ...verdict(), surprise: true })).toMatchObject({ valid: false });
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(verdict({ checks: verdict().checks.slice(0, 4) }))).toMatchObject({ valid: false });
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(verdict({ approved: false, root_cause: null }))).toMatchObject({ valid: false });
    expect(parseNativeCriticVerdict({ approved: true }, "lenticel")).toBeNull();
  });

  it("rejects a syntactically valid but internally contradictory approval", () => {
    // This is the production trust boundary: a provider cannot retire a
    // branch by setting `approved: true` while its own required evidence says
    // measurement or a guard failed.
    const failedMeasurement = verdict({
      measurement_validated: false,
      checks: verdict().checks.map((check) => check.name === "measurement_validation"
        ? { ...check, passed: false, detail: "no attributable measurement" }
        : check),
    });
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(failedMeasurement)).toMatchObject({ valid: false });
    expect(parseNativeCriticVerdict(failedMeasurement, "lenticel")).toBeNull();

    // The compact status booleans and named checklist cannot drift either.
    const mismatchedChecklist = verdict({
      checks: verdict().checks.map((check) => check.name === "stability_monitoring"
        ? { ...check, passed: false, detail: "contradictory provider payload" }
        : check),
    });
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(mismatchedChecklist)).toMatchObject({ valid: false });
  });

  it("names the broken rule in the refusal, so the correction turn tells the critic what to fix (UCT Stage 0)", () => {
    const reason = (value: unknown): string => {
      const validation = NATIVE_CRITIC_VERDICT_CONTRACT.validate(value);
      expect(validation.valid).toBe(false);
      return validation.valid ? "" : validation.reason;
    };
    // The live shape: an approval whose introspection check (and flag) failed.
    const approvedWithFailedCheck = verdict({
      introspection_passed: false,
      checks: verdict().checks.map((check) => check.name === "introspection" ? { ...check, passed: false, detail: "the specialist never ran the suite" } : check),
    });
    const contradiction = reason(approvedWithFailedCheck);
    expect(contradiction).toContain("approved is true but checks[introspection] failed");
    expect(contradiction).toContain("set approved to false and name it in root_cause");
    expect(contradiction.startsWith(NATIVE_CRITIC_MALFORMED_VERDICT)).toBe(false);
    expect(reason({ ...verdict(), surprise: true })).toContain("field(s) outside the contract: surprise");
    expect(reason(verdict({ checks: verdict().checks.slice(0, 4) }))).toContain("checks must be an array of one entry each for");
    expect(reason(verdict({ checks: [...verdict().checks.slice(0, 4), { name: "completeness", passed: true, detail: "every site handled" }] }))).toContain("checks is missing stability_monitoring");
    expect(reason(verdict({ approved: false, root_cause: null }))).toContain("root_cause must name the blocker");
    expect(reason(verdict({ root_cause: "a spurious blocker" }))).toContain("root_cause must be null");
    expect(reason(verdict({ checks: verdict().checks.map((check) => check.name === "stability_monitoring" ? { ...check, passed: false } : check) })))
      .toContain("checks[stability_monitoring].passed must equal stability_ok");
    const { checks: _omitted, ...withoutChecks } = verdict();
    expect(reason(withoutChecks)).toContain("missing required field(s): checks");
    // Every refusal still parses to nothing: the reason is advice, not a widening.
    expect(parseNativeCriticVerdict(approvedWithFailedCheck, "lenticel")).toBeNull();
  });
});

describe("E-3 (arXiv 2607.05391): critic confidence", () => {
  it("accepts a valid confidence and stamps confidence_source as self_report (no logprobs path exists in this transport)", () => {
    const withConfidence = { ...verdict(), confidence: 0.87 };
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(withConfidence)).toEqual({ valid: true });
    const parsed = parseNativeCriticVerdict(withConfidence, "lenticel");
    expect(parsed).toMatchObject({ confidence: 0.87, confidence_source: "self_report" });
  });

  it("an older/absent-confidence payload still parses as a fully valid verdict, with no confidence signal — exactly pre-E-3 behavior", () => {
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(verdict())).toEqual({ valid: true });
    const parsed = parseNativeCriticVerdict(verdict(), "lenticel");
    expect(parsed?.confidence).toBeUndefined();
    expect(parsed?.confidence_source).toBeUndefined();
  });

  it("a malformed confidence (non-numeric, null, or out of [0,1]) does NOT fail the whole verdict — it is dropped, not rejected", () => {
    for (const bad of [null, "high", -0.1, 1.5, Number.NaN]) {
      const malformed = { ...verdict(), confidence: bad };
      expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(malformed)).toEqual({ valid: true });
      const parsed = parseNativeCriticVerdict(malformed, "lenticel");
      expect(parsed).not.toBeNull();
      expect(parsed?.confidence).toBeUndefined();
      expect(parsed?.confidence_source).toBeUndefined();
    }
  });

  it("boundary values 0 and 1 are both accepted", () => {
    expect(parseNativeCriticVerdict({ ...verdict(), confidence: 0 }, "lenticel")?.confidence).toBe(0);
    expect(parseNativeCriticVerdict({ ...verdict(), confidence: 1 }, "lenticel")?.confidence).toBe(1);
  });

  it("extractCriticConfidence: reads a valid confidence out of raw response text independent of the verdict parser", () => {
    const raw = JSON.stringify({ ...verdict(), confidence: 0.42 });
    expect(extractCriticConfidence(raw)).toEqual({ confidence: 0.42, confidence_source: "self_report" });
  });

  it("extractCriticConfidence: returns null for absent, non-numeric, out-of-range, or unparseable raw text", () => {
    expect(extractCriticConfidence(JSON.stringify(verdict()))).toBeNull();
    expect(extractCriticConfidence(JSON.stringify({ ...verdict(), confidence: "high" }))).toBeNull();
    expect(extractCriticConfidence(JSON.stringify({ ...verdict(), confidence: 1.2 }))).toBeNull();
    expect(extractCriticConfidence("not json at all")).toBeNull();
  });
});

describe("X-2 (patch-overfitting #2, arXiv 2306.09896): optional completeness check", () => {
  it("a verdict with a failed completeness check cannot be approved (BLOCK path)", () => {
    const withFailedCompleteness = {
      ...verdict(),
      approved: false,
      root_cause: "fix did not cover a sibling site",
      checks: [
        { name: "root_cause", passed: false, detail: "sibling site left unfixed" },
        ...verdict().checks.slice(1),
        { name: "completeness", passed: false, detail: "sibling site left unfixed" },
      ],
    };
    const parsed = parseNativeCriticVerdict(withFailedCompleteness, "lenticel");
    expect(parsed?.approved).toBe(false);
    expect(parsed?.checks.find((check) => check.name === "completeness")).toMatchObject({ passed: false });
    // An approval that also claims a failed completeness check is
    // internally contradictory and must fail closed, exactly like a failed
    // mandate check does today.
    const contradictoryApproval = {
      ...verdict(),
      checks: [...verdict().checks, { name: "completeness", passed: false, detail: "sibling site left unfixed" }],
    };
    expect(parseNativeCriticVerdict(contradictoryApproval, "lenticel")).toBeNull();
  });

  it("a verdict with a passed completeness check parses normally and can be approved", () => {
    const withPassedCompleteness = {
      ...verdict(),
      checks: [...verdict().checks, { name: "completeness", passed: true, detail: "every site was addressed" }],
    };
    const parsed = parseNativeCriticVerdict(withPassedCompleteness, "lenticel");
    expect(parsed?.approved).toBe(true);
    expect(parsed?.checks).toHaveLength(6);
  });

  it("a verdict without the completeness check parses exactly as before (unchanged behavior)", () => {
    const parsed = parseNativeCriticVerdict(verdict(), "lenticel");
    expect(parsed?.approved).toBe(true);
    expect(parsed?.checks).toHaveLength(5);
    expect(parsed?.checks.some((check) => check.name === "completeness")).toBe(false);
  });

  it("rejects a checks array missing a mandatory name even when completeness is present", () => {
    const missingMandatory = {
      ...verdict(),
      checks: [...verdict().checks.slice(0, 4), { name: "completeness", passed: true, detail: "n/a" }],
    };
    expect(parseNativeCriticVerdict(missingMandatory, "lenticel")).toBeNull();
  });

  it("rejects duplicate completeness entries and unknown check names", () => {
    const duplicated = {
      ...verdict(),
      checks: [...verdict().checks, { name: "completeness", passed: true, detail: "a" }, { name: "completeness", passed: true, detail: "b" }],
    };
    expect(parseNativeCriticVerdict(duplicated, "lenticel")).toBeNull();
    const unknown = { ...verdict(), checks: [...verdict().checks, { name: "bogus", passed: true, detail: "x" }] };
    expect(parseNativeCriticVerdict(unknown, "lenticel")).toBeNull();
  });

  it("refuses schema-shaped template text as a malformed verdict, naming the field, without flagging a short genuine finding", () => {
    // Observed on a live provider (2026-10-06 cohort): every field present,
    // every string the word "placeholder", counted as a real rejection.
    const placeholderRejection = verdict({ approved: false, rationale: "placeholder", root_cause: "placeholder", measurement_validated: false, checks: verdict().checks.map((check) => ({ ...check, detail: "placeholder", passed: check.name !== "root_cause" && check.name !== "measurement_validation" })) });
    expect(parseNativeCriticVerdict(placeholderRejection, "lenticel")).toBeNull();
    const validation = NATIVE_CRITIC_VERDICT_CONTRACT.validate(placeholderRejection);
    expect(validation).toEqual({ valid: false, reason: expect.stringMatching(new RegExp(`^${NATIVE_CRITIC_MALFORMED_VERDICT}: .*\\(1\\) rationale holds placeholder`)) });
    // D7: every placeholder field is named in the one correction, not only the first.
    for (const field of ["root_cause", ...verdict().checks.map((check) => `checks[${check.name}].detail`)]) expect(validation.valid ? "" : validation.reason).toContain(`${field} holds placeholder`);
    for (const template of ["...", "<rationale>", "{{detail}}", "TODO", "\"string\"", "required non-empty on rejection"]) {
      expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(verdict({ checks: verdict().checks.map((check) => check.name === "introspection" ? { ...check, detail: template } : check) }))).toEqual({ valid: false, reason: expect.stringContaining("checks[introspection].detail") });
    }
    // Brevity is not a placeholder: only a whole-field template is refused.
    for (const genuine of ["no blocker", "not applicable: documentation-only change", "N/A", "none found"]) {
      expect(parseNativeCriticVerdict(verdict({ checks: verdict().checks.map((check) => check.name === "introspection" ? { ...check, detail: genuine } : check) }), "lenticel")).not.toBeNull();
    }
  });
});

describe("native critic correction reasons (UCT Stage 0 pilots)", () => {
  it("H7: names a reply with no JSON value as malformed critic output and says exactly what to send", () => {
    const reason = NATIVE_CRITIC_VERDICT_CONTRACT.unparsed_reason!("the reply was prose with no JSON value");
    expect(reason).toBe(nativeCriticUnparsedReason("the reply was prose with no JSON value"));
    expect(reason.startsWith(`${NATIVE_CRITIC_MALFORMED_VERDICT}: your reply was not a JSON object (the reply was prose with no JSON value)`)).toBe(true);
    expect(reason).toContain(NATIVE_CRITIC_VERDICT_SCHEMA_ID);
    expect(reason).toContain("no prose, reasoning or markdown");
  });

  it("O1: a correct rejection that marks checks[root_cause] passed is told to set it false, not to restate the rule", () => {
    const rejection = verdict({
      approved: false, root_cause: "the edit never reached the queue's remove path", rationale: "the change does not implement remove",
      checks: verdict().checks.map((check) => check.name === "root_cause" ? { ...check, passed: true, detail: "root cause identified" } : check),
    });
    const validation = NATIVE_CRITIC_VERDICT_CONTRACT.validate(rejection);
    expect(validation).toEqual({ valid: false, reason: expect.stringContaining("root_cause names a blocker, so checks[root_cause].passed must be false") });
    expect(validation.valid ? "" : validation.reason).toContain("passed means no blocker was found");
    // The corrected rejection, with only that flag changed, is a valid verdict.
    const corrected = { ...rejection, checks: rejection.checks.map((check) => check.name === "root_cause" ? { ...check, passed: false } : check) };
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(corrected)).toEqual({ valid: true });
  });
});

describe("D7 (UCT Stage 0 pilot 4): the critic is shown the checks shape and corrected in one pass", () => {
  const reasonOf = (value: unknown): string => {
    const validation = NATIVE_CRITIC_VERDICT_CONTRACT.validate(value);
    expect(validation.valid).toBe(false);
    return validation.valid ? "" : validation.reason ?? "";
  };

  it("lists every violation of a name-keyed, mis-typed verdict in one correction", () => {
    // The live first reply: checks keyed by name, plus an extra field and a
    // non-boolean flag. All three are named at once.
    const nameKeyed = {
      ...verdict(), stability_ok: "yes", summary: "looks fine",
      checks: Object.fromEntries(verdict().checks.map((check) => [check.name, { passed: check.passed, detail: check.detail }])),
    };
    const reason = reasonOf(nameKeyed);
    expect(reason).toContain("3 violations, fix all of them in one reply");
    expect(reason).toContain("field(s) outside the contract: summary");
    expect(reason).toContain("stability_ok must be a boolean");
    expect(reason).toContain("checks must be an array of {name, passed, detail} objects, not an object keyed by check name");
  });

  it("names every malformed check entry, including evidence used in place of detail", () => {
    // The live second reply: an array whose entries say evidence, not detail.
    const evidenceEntries = { ...verdict(), checks: verdict().checks.map((check) => ({ name: check.name, passed: check.passed, evidence: check.detail })) };
    const reason = reasonOf(evidenceEntries);
    expect(reason).toContain("5 violations");
    for (const [index, check] of verdict().checks.entries()) {
      expect(reason).toContain(`checks[${index}] (${check.name}) has field(s) outside the contract: evidence (put that text in detail), detail must be a non-empty string`);
    }
    // Fixing exactly what the correction named yields a valid verdict.
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate({ ...evidenceEntries, checks: evidenceEntries.checks.map(({ evidence, ...rest }) => ({ ...rest, detail: evidence })) })).toEqual({ valid: true });
  });

  it("reports independent semantic defects together rather than the first one found", () => {
    const reason = reasonOf(verdict({
      root_cause: "a spurious blocker",
      checks: verdict().checks.map((check) => check.name === "stability_monitoring" || check.name === "guardrail_enforcement" ? { ...check, passed: false } : check),
    }));
    expect(reason).toContain("approved is true, so root_cause must be null");
    expect(reason).toContain("checks[guardrail_enforcement].passed must equal guardrails_enforced");
    expect(reason).toContain("checks[stability_monitoring].passed must equal stability_ok");
    expect(reason).toContain("root_cause names a blocker, so checks[root_cause].passed must be false");
    expect(reason).toContain("approved is true but checks[guardrail_enforcement], checks[stability_monitoring] failed");
  });

  it("shows the exact schema with approve and reject examples that are valid once their slots are filled", () => {
    const instruction = nativeCriticVerdictInstruction({ tools: "none" });
    expect(instruction).toContain(NATIVE_CRITIC_VERDICT_SCHEMA_ID);
    expect(instruction).toContain('checks: an ARRAY of objects, each exactly {"name": string, "passed": boolean, "detail": non-empty string}');
    expect(instruction).toContain("never an object keyed by check name");
    expect(instruction).toContain(JSON.stringify(NATIVE_CRITIC_VERDICT_EXAMPLES.approve));
    expect(instruction).toContain(JSON.stringify(NATIVE_CRITIC_VERDICT_EXAMPLES.reject));
    for (const name of ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"]) {
      expect(NATIVE_CRITIC_VERDICT_EXAMPLES.approve.checks.map((check) => check.name)).toContain(name);
      expect(NATIVE_CRITIC_VERDICT_EXAMPLES.reject.checks.map((check) => check.name)).toContain(name);
    }
    const fill = (value: unknown): unknown => typeof value === "string" ? value.replace(/^<(.*)>$/, "reviewed: $1") : Array.isArray(value) ? value.map(fill) : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)])) : value;
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(fill(NATIVE_CRITIC_VERDICT_EXAMPLES.approve))).toEqual({ valid: true });
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(fill(NATIVE_CRITIC_VERDICT_EXAMPLES.reject))).toEqual({ valid: true });
    expect(parseNativeCriticVerdict(fill(NATIVE_CRITIC_VERDICT_EXAMPLES.reject), "lenticel")).toMatchObject({ approved: false });
    // Copied verbatim, an example is refused as placeholder text, never accepted as a review.
    expect(NATIVE_CRITIC_VERDICT_CONTRACT.validate(NATIVE_CRITIC_VERDICT_EXAMPLES.approve)).toMatchObject({ valid: false, reason: expect.stringMatching(new RegExp(`^${NATIVE_CRITIC_MALFORMED_VERDICT}: `)) });
  });

  it("tells a tool-less critic that no tools exist and not to write tool-call syntax, and says nothing of the kind otherwise", () => {
    expect(nativeCriticVerdictInstruction({ tools: "none" })).toMatch(/^No tools are available in this review\. Do not call tools and do not write tool-call syntax/);
    expect(nativeCriticVerdictInstruction()).not.toContain("No tools are available");
  });
});
