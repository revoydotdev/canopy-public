import { clipDisplay, wrapDisplay } from "./widgets.js";
import { clipLabelWithEllipsis } from "./screens/region.js";

export type CrashBoundaryAction = "copy_issue" | "restart" | "quit";
export interface CrashProjection {
  readonly title: "revoy2 crashed";
  readonly message: string;
  readonly stack: string;
  readonly stack_truncated: boolean;
  readonly issue_text: string;
  readonly actions: readonly ["c · copy as issue", "r · restart", "q · quit"];
}

function boundedUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  const suffix = "\n… stack truncated to protect the crash screen";
  const room = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  return { text: bytes.subarray(0, room).toString("utf8").replace(/\uFFFD$/u, "") + suffix, truncated: true };
}

export function projectCrash(error: unknown, maxStackBytes = 8 * 1024): CrashProjection {
  if (!Number.isSafeInteger(maxStackBytes) || maxStackBytes < 256 || maxStackBytes > 64 * 1024) throw new Error("maxStackBytes must be from 256 through 65536");
  const message = error instanceof Error ? error.message : String(error);
  const rawStack = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  const stack = boundedUtf8(rawStack, maxStackBytes);
  const issue = boundedUtf8(`## Crash report\n\n${message}\n\n\`\`\`text\n${stack.text}\n\`\`\``, 16 * 1024).text;
  return { title: "revoy2 crashed", message, stack: stack.text, stack_truncated: stack.truncated, issue_text: issue, actions: ["c · copy as issue", "r · restart", "q · quit"] };
}

/** Full-screen replacement, not an overlay on potentially corrupt application state. */
export function renderCrashScreen(projection: CrashProjection, columns = 100): string {
  const width = Math.max(20, Math.min(240, Number.isSafeInteger(columns) ? columns : 100));
  const esc = String.fromCharCode(27);
  // The MESSAGE wraps; only the stack is clipped. Clipping every line lost the
  // half that says WHY: a read-only `.arbor` produced "could not durably save
  // KB stream <120-char absolute path>: Error: EACCES: permission denied",
  // and at 150 columns the path consumed the whole line, so the operator saw
  // the failed operation and never the cause, with `r · restart` offering to
  // do it again (EC-040). Claude Code draws the same distinction —
  // `wrap:"wrap"` for error/message/description text, `wrap:"truncate"` for
  // paths, names and titles.
  const lines = [
    ...wrapDisplay(projection.title, width),
    "",
    ...wrapDisplay(projection.message, width),
    "",
    ...projection.stack.split("\n").map((frame) => clipLabelWithEllipsis(frame, width)),
    "",
    clipDisplay(projection.actions.join("    "), width),
  ];
  return `${esc}[0m${esc}[2J${esc}[H${lines.join("\n")}\n`;
}

export function crashActionForKey(key: string): CrashBoundaryAction | null {
  if (key === "c") return "copy_issue";
  if (key === "r") return "restart";
  if (key === "q" || key === "\u0003" || key === "\u001b") return "quit";
  return null;
}
