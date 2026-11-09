/** A copy chord over visible selected text is never an exit/navigation intent. */
export function copySelectedTerminalText(
  key: { readonly name: string; readonly ctrl: boolean; readonly meta: boolean },
  port: { selectedText(): string | null; copyText(text: string): boolean },
): boolean {
  if (key.name.toLowerCase() !== "c" || !key.ctrl || key.meta) return false;
  const selected = port.selectedText();
  if (selected === null || selected.length === 0) return false;
  // Preserve selection and consume the intent even when clipboard delivery
  // fails. Falling through to Ctrl+C exit would turn a copy failure into loss.
  try { port.copyText(selected); } catch { /* no exit or selection mutation */ }
  return true;
}
