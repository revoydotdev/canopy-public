/** Small dependency-free syntax highlighter for code shown in the diff viewer. */
import { ANSI } from "./player-piano.js";

export type SyntaxLanguage = "typescript" | "json" | "shell" | "python" | "plain";

const TYPESCRIPT = new Set(["as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "else", "export", "extends", "finally", "for", "from", "function", "if", "implements", "import", "interface", "let", "new", "return", "switch", "throw", "try", "type", "typeof", "var", "while"]);
const JSON = new Set(["false", "null", "true"]);
const SHELL = new Set(["case", "do", "done", "echo", "else", "esac", "export", "fi", "for", "function", "if", "in", "then", "while"]);
const PYTHON = new Set(["and", "as", "async", "await", "class", "def", "elif", "else", "except", "False", "finally", "for", "from", "if", "import", "in", "lambda", "None", "not", "or", "pass", "return", "True", "try", "while", "with", "yield"]);

export function syntaxLanguageForPath(path: string): SyntaxLanguage {
  const clean = path.toLowerCase();
  if (/\.(?:ts|tsx|js|jsx|mts|cts)$/u.test(clean)) return "typescript";
  if (/\.jsonc?$/u.test(clean)) return "json";
  if (/\.(?:sh|bash|zsh|fish)$/u.test(clean) || /(?:^|\/)\.?(?:bashrc|zshrc)$/u.test(clean)) return "shell";
  if (/\.py$/u.test(clean)) return "python";
  return "plain";
}

function keywords(language: SyntaxLanguage): ReadonlySet<string> {
  if (language === "typescript") return TYPESCRIPT;
  if (language === "json") return JSON;
  if (language === "shell") return SHELL;
  if (language === "python") return PYTHON;
  return new Set();
}

function commentStart(language: SyntaxLanguage, text: string, index: number): number | null {
  if ((language === "typescript" || language === "json") && text.startsWith("//", index)) return 2;
  if ((language === "shell" || language === "python") && text[index] === "#") return 1;
  return null;
}

/**
 * Highlight a single source line. It is intentionally lexical, not a parser:
 * malformed/incomplete diff hunks remain safe and still make strings,
 * comments, numbers, and language keywords visually distinct.
 */
export function highlightSyntax(text: string, language: SyntaxLanguage): string {
  if (language === "plain" || text.length === 0) return text;
  let output = "";
  let index = 0;
  const words = keywords(language);
  while (index < text.length) {
    const comment = commentStart(language, text, index);
    if (comment !== null) return `${output}${ANSI.dim}${text.slice(index)}${ANSI.reset}`;
    const char = text[index]!;
    if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") { end += 2; continue; }
        if (text[end] === char) { end += 1; break; }
        end += 1;
      }
      output += `${ANSI.green}${text.slice(index, end)}${ANSI.reset}`;
      index = end;
      continue;
    }
    if (/\d/u.test(char)) {
      let end = index + 1;
      while (end < text.length && /[\d._xXa-fA-F]/u.test(text[end]!)) end += 1;
      output += `${ANSI.magenta}${text.slice(index, end)}${ANSI.reset}`;
      index = end;
      continue;
    }
    if (/[A-Za-z_$]/u.test(char)) {
      let end = index + 1;
      while (end < text.length && /[A-Za-z0-9_$]/u.test(text[end]!)) end += 1;
      const word = text.slice(index, end);
      output += words.has(word) ? `${ANSI.cyan}${word}${ANSI.reset}` : word;
      index = end;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}
