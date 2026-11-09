/**
 * arbor-eval/stage0/stubs — the body-stub task generator's text transforms.
 *
 * A body-stub task removes one upstream function body and keeps its
 * signature, its documentation and every upstream test. The upstream tests
 * are the specification; the removed body is the reference fix. These
 * functions are pure line-oriented transforms over source text, deliberately
 * conservative: anything they cannot delimit with certainty (decorators,
 * one-line bodies, unbalanced signatures) is not a candidate.
 */

export interface StubCandidate {
  /** Name used in the task text, e.g. `chunked`, `Version::new`, `Queue#peek`. */
  readonly symbol: string;
  readonly name: string;
  /** Human-readable location, e.g. `impl Ord for Prerelease` or `module level`. */
  readonly context: string;
  /** 0-based line of the item's own declaration (`def`, `fn`, method head). */
  readonly item_start: number;
  /** 0-based first and last line (inclusive) of the replaced body. */
  readonly body_start: number;
  readonly body_end: number;
  readonly body_lines: number;
  readonly stub: string;
}

export function applyStub(source: string, candidate: StubCandidate): string {
  const lines = source.split("\n");
  return [...lines.slice(0, candidate.body_start), candidate.stub, ...lines.slice(candidate.body_end + 1)].join("\n");
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

// ---------------------------------------------------------------- Python

/**
 * Top-level `def` functions in `source`. The docstring is kept; every
 * statement after it is replaced by `raise NotImplementedError`.
 */
export function pythonStubCandidates(source: string): StubCandidate[] {
  const lines = source.split("\n");
  const out: StubCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^def ([A-Za-z_]\w*)\(/.exec(lines[i]);
    if (match === null) continue;
    if (i > 0 && lines[i - 1].startsWith("@")) continue;
    // Signature ends at the first line ending in ':' once parentheses balance.
    let depth = 0;
    let signatureEnd = -1;
    for (let j = i; j < lines.length && j < i + 30; j++) {
      for (const ch of lines[j]) {
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
      }
      if (depth === 0 && /:\s*(#.*)?$/.test(lines[j])) {
        signatureEnd = j;
        break;
      }
    }
    if (signatureEnd < 0) continue;
    let end = signatureEnd;
    for (let j = signatureEnd + 1; j < lines.length; j++) {
      if (lines[j].trim().length === 0) continue;
      if (indentOf(lines[j]) === 0) break;
      end = j;
    }
    let bodyStart = signatureEnd + 1;
    const first = lines[bodyStart]?.trim() ?? "";
    const quote = /^[rRbBuU]?("""|''')/.exec(first);
    if (quote !== null) {
      const delimiter = quote[1];
      const rest = first.slice(quote[0].length);
      let docEnd = bodyStart;
      if (!rest.includes(delimiter)) {
        docEnd = -1;
        for (let j = bodyStart + 1; j <= end; j++) {
          if (lines[j].includes(delimiter)) {
            docEnd = j;
            break;
          }
        }
      }
      if (docEnd < 0) continue;
      bodyStart = docEnd + 1;
    }
    if (bodyStart > end) continue;
    const bodyLines = lines.slice(bodyStart, end + 1).filter((line) => line.trim().length > 0 && !line.trim().startsWith("#")).length;
    const indent = " ".repeat(indentOf(lines[bodyStart].trim().length === 0 ? lines[end] : lines[bodyStart]));
    out.push({
      symbol: `more_itertools.${match[1]}`,
      name: match[1],
      context: "module level",
      item_start: i,
      body_start: bodyStart,
      body_end: end,
      body_lines: bodyLines,
      stub: `${indent}raise NotImplementedError`,
    });
    i = end;
  }
  return out;
}

/** Names in a module's `__all__ = [...]` list. */
export function pythonAllNames(source: string): string[] {
  const match = /__all__\s*=\s*\[([\s\S]*?)\]/.exec(source);
  if (match === null) return [];
  return [...match[1].matchAll(/['"]([A-Za-z_]\w*)['"]/g)].map((m) => m[1]);
}

/** Occurrences of `name` as a whole word, excluding comments-free heuristics. */
export function wordOccurrences(source: string, name: string): number {
  return [...source.matchAll(new RegExp(`(?<![\\w.])${name.replace(/[$]/g, "\\$")}(?!\\w)`, "g"))].length;
}

// ---------------------------------------------------------------- Rust

/**
 * Brace-delimited `fn` items in a Rust source file. A candidate's body is
 * everything strictly between the line ending the signature with `{` and the
 * closing `}` at the signature's own indentation.
 */
export function rustStubCandidates(source: string): StubCandidate[] {
  const lines = source.split("\n");
  const out: StubCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(const\s+)?(unsafe\s+)?fn\s+([A-Za-z_]\w*)/.exec(lines[i]);
    if (match === null) continue;
    if (match[3] !== undefined) continue;
    const indent = match[1];
    let signatureEnd = -1;
    for (let j = i; j < lines.length && j < i + 15; j++) {
      if (/;\s*$/.test(lines[j]) && !lines[j].includes("{")) break;
      if (/\{\s*$/.test(lines[j])) {
        signatureEnd = j;
        break;
      }
    }
    if (signatureEnd < 0) continue;
    let close = -1;
    for (let j = signatureEnd + 1; j < lines.length; j++) {
      if (lines[j] === `${indent}}`) {
        close = j;
        break;
      }
      if (lines[j].trim().length > 0 && indentOf(lines[j]) < indent.length) break;
    }
    if (close < 0 || close === signatureEnd + 1) continue;
    let context = "module level";
    if (indent.length > 0) {
      for (let j = i - 1; j >= 0; j--) {
        if (indentOf(lines[j]) < indent.length && lines[j].trim().length > 0 && !lines[j].trim().startsWith("//") && !lines[j].trim().startsWith("#")) {
          context = lines[j].trim().replace(/\s*\{\s*$/, "");
          break;
        }
      }
    }
    const typeName = /^impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/.exec(context)?.[1];
    out.push({
      symbol: typeName === undefined ? match[4] : `${typeName}::${match[4]}`,
      name: match[4],
      context,
      item_start: i,
      body_start: signatureEnd + 1,
      body_end: close - 1,
      body_lines: lines.slice(signatureEnd + 1, close).filter((line) => line.trim().length > 0 && !line.trim().startsWith("//")).length,
      stub: `${indent}    unimplemented!()`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- JavaScript (yocto-queue class methods)

/** A one-tab-indented method of a class body, e.g. `\tpeek() {` … `\t}`. */
export function jsMethodStubCandidate(source: string, member: string): StubCandidate | null {
  const lines = source.split("\n");
  const escaped = member.replace(/[[\]().*]/g, (ch) => `\\${ch}`);
  const pattern = new RegExp(`^\\t(?:\\* ?)?${escaped}\\(.*\\)\\s*\\{\\s*$`);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start < 0) return null;
  const close = lines.findIndex((line, index) => index > start && line === "\t}");
  if (close < 0 || close === start + 1) return null;
  return {
    symbol: `Queue#${member}`,
    name: member,
    context: "class Queue",
    item_start: start,
    body_start: start + 1,
    body_end: close - 1,
    body_lines: lines.slice(start + 1, close).filter((line) => line.trim().length > 0 && !line.trim().startsWith("//")).length,
    stub: "\t\tthrow new Error('Not implemented');",
  };
}

/** Insert `text` before the last line equal to `}` (the closing brace of the file's class). */
export function insertBeforeClassEnd(source: string, text: string): string {
  const lines = source.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === "}") return [...lines.slice(0, i), text.replace(/\n$/, ""), ...lines.slice(i)].join("\n");
  }
  throw new Error("no closing class brace found");
}
