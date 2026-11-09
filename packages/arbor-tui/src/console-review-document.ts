import { wrapDisplay } from "./widgets.js";

/** Presentation only. Model-authored review fields never grant verified provenance. */
export function reviewDocument(text: string, width: number, expanded: boolean): readonly string[] {
  const wrap = (value: string) => wrapDisplay(value, width);
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || typeof (value as Record<string, unknown>).approved !== "boolean"
    || typeof (value as Record<string, unknown>).rationale !== "string") {
    return [...wrap("REVIEW - unstructured reviewer output"), "", ...wrap(text)];
  }
  const review = value as Record<string, unknown>;
  const checks = Array.isArray(review.checks) ? review.checks.filter((check): check is { name: string; passed: boolean; detail?: string } =>
    typeof check === "object" && check !== null && typeof check.name === "string" && typeof check.passed === "boolean"
    && (check.detail === undefined || typeof check.detail === "string")) : [];
  const rationale = wrap(review.rationale as string);
  const failed = checks.filter((check) => !check.passed);
  const lines = [
    ...wrap(`REVIEW - ${review.approved ? "APPROVED" : "CHANGES REQUESTED"}`),
    ...wrap("Reviewer judgment, not independent execution proof."), "",
    ...(expanded ? rationale : rationale.slice(0, 3)),
    ...(!expanded && rationale.length > 3 ? wrap("Rationale continues in review details.") : []),
    "", ...wrap(`Reviewer checks: ${checks.length - failed.length}/${checks.length} reported passed`),
    ...failed.flatMap((check) => wrap(`FAIL: ${check.name.replaceAll("_", " ")}${check.detail ? ` - ${check.detail}` : ""}`)),
    ...(typeof review.root_cause === "string" && review.root_cause.trim() ? wrap(`Root cause: ${review.root_cause}`) : []),
  ];
  if (expanded) {
    lines.push("", ...wrap("REVIEW DETAILS"), ...checks.flatMap((check) => wrap(
      `${check.passed ? "PASS" : "FAIL"}: ${check.name.replaceAll("_", " ")}${check.detail ? ` - ${check.detail}` : ""}`)));
  } else {
    lines.push("", ...wrap("Scroll for review details; Harness Sessions retains the source events."));
  }
  return lines;
}
