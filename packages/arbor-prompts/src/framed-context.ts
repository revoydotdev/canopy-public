/**
 * The one framing every context-only prompt block shares.
 *
 * It lives apart from `index.ts` because the native role-prompt path
 * (`role-profiles.ts`) needs the same frame, and importing `index.ts` from
 * there would close a cycle. One definition is the point: a trust label that
 * could differ between the opencode and native surfaces is a trust label
 * that eventually does.
 */
const MAX_PROMPT_CONTEXT_FRAGMENT_BYTES = 64 * 1024;

export function framedContext(label: string, value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_PROMPT_CONTEXT_FRAGMENT_BYTES) throw new Error(`${label} exceeds ${MAX_PROMPT_CONTEXT_FRAGMENT_BYTES} bytes`);
  return `<${label} instruction-authority="context-only">\n${value}\n</${label}>`;
}
