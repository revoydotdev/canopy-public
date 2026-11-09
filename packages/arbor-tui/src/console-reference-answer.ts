import { wrapDisplay } from "./widgets.js";

type RecordValue = Readonly<Record<string, unknown>>;
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }

export interface ConsoleReferenceAnswer {
  readonly id: string;
  readonly task: string;
  readonly status: "planning" | "answered" | "failed" | "cancelled";
  readonly answer: string | null;
  readonly error: string | null;
  readonly references: readonly string[];
  readonly session_id: string | null;
  readonly model_identity: string | null;
  readonly usage: string;
}

/** Latest intent owns the foreground; an old answer must not hide newer work. */
export function selectConsoleReferenceAnswer(input: unknown): ConsoleReferenceAnswer | null {
  if (!record(input) || !Array.isArray(input.items)) return null;
  const latest = input.items.filter(record).filter(item => text(item.id) !== null)
    .sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")))[0];
  if (latest?.mode !== "answer") return null;
  const planner = record(latest.planner) ? latest.planner : {};
  const response = record(latest.reference_answer) ? latest.reference_answer : {};
  const provenance = record(response.provenance) ? response.provenance : {};
  const validAnswer = provenance.tag === "claimed" && provenance.claimant === "native-reference-answer" && text(response.text) !== null;
  const status = latest.status === "planning" || latest.status === "cancelled" ? latest.status
    : latest.status === "answered" && validAnswer ? "answered" : "failed";
  const usage = record(planner.usage) ? planner.usage : {};
  const measured = usage.counter_source === "provider_counter" && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number";
  return {
    id: String(latest.id), task: text(latest.task) ?? "Reference question", status,
    answer: status === "answered" ? String(response.text) : null,
    error: status === "failed" ? text(planner.error) ?? "The reference answer is unavailable or has invalid provenance." : null,
    references: Array.isArray(latest.attachments) ? latest.attachments.filter(record).map(item => text(item.display_name) ?? "Reference") : [],
    session_id: text(planner.session_id), model_identity: text(planner.model_identity),
    usage: measured ? `${usage.input_tokens} input / ${usage.output_tokens} output tokens` : "Token usage unavailable",
  };
}

/** Content is bounded to the viewport; raw model controls never reach the renderer. */
export function renderConsoleReferenceAnswer(reference: ConsoleReferenceAnswer, width: number, height: number, offset = 0): string[] {
  const heading = reference.status === "planning" ? "READING REFERENCE - read-only - Esc cancel"
    : reference.status === "answered" ? "REFERENCE ANSWER - claimed, not verified"
      : reference.status === "cancelled" ? "REFERENCE ANSWER STOPPED" : "REFERENCE ANSWER UNAVAILABLE";
  const body = [
    ...wrapDisplay(`Question: ${reference.task}`, width),
    ...(reference.references.length > 0 ? wrapDisplay(`Sources: ${reference.references.join(", ")}`, width) : []),
    "",
    ...(reference.status === "planning" ? ["Preparing an answer from the captured references. No tools or campaign admission."]
      : reference.status === "answered" ? reference.answer!.split("\n")
        : reference.status === "cancelled" ? ["No campaign was created. Retry this draft from Tasks to ask again."]
          : [reference.error!, "Resolve the provider issue, then retry this read-only draft from Tasks."]),
    "",
    ...(reference.status === "planning" ? [] : ["No campaign created. The answer is not independent verification.",
      `${reference.model_identity ?? "Model unavailable"} | ${reference.usage}`,
      ...(reference.session_id === null ? [] : [`Session: ${reference.session_id}`])]),
  ].flatMap(line => line === "" ? [""] : wrapDisplay(line, width));
  const header = [...wrapDisplay(heading, width), ...wrapDisplay("PgUp/PgDn scroll | Home/End | Enter focus input", width)];
  const space = Math.max(0, height - header.length);
  const maximum = Math.max(0, body.length - space);
  const requested = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  // End uses the shared reducer sentinel. Preserve distance back from End
  // so Page Up after End moves rather than clamping to the last page again.
  const absolute = requested > Number.MAX_SAFE_INTEGER / 2
    ? maximum - (Number.MAX_SAFE_INTEGER - requested) : requested;
  const start = Math.max(0, Math.min(absolute, maximum));
  return [...header, ...body.slice(start, start + space)].slice(0, Math.max(0, height));
}
