import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function readOperatorLine(timeoutMs = 5 * 60_000, input = process.stdin) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    input.setEncoding("utf8");
    input.resume();
    const cleanup = () => {
      clearTimeout(timer);
      input.off("data", onData);
      input.pause();
    };
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.search(/[\r\n]/);
      if (newline < 0) return;
      const answer = buffer.slice(0, newline).trim();
      cleanup();
      if (!answer || answer.length > 2000) reject(new Error("operator keypress answer is empty or over the bounded limit"));
      else resolve(answer);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("operator keypress interview timed out"));
    }, timeoutMs);
    input.on("data", onData);
  });
}

export async function requestOperatorKeypress({ scratch, sequence, purpose, question, timeoutMs = 5 * 60_000, onRequested, onReceived }) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("operator keypress sequence must be a positive integer");
  if (!purpose || !question) throw new Error("operator keypress purpose and question are required");
  const requestPath = join(scratch, `interview-request-${String(sequence).padStart(2, "0")}.json`);
  mkdirSync(dirname(requestPath), { recursive: true, mode: 0o700 });
  writeFileSync(requestPath, `${JSON.stringify({ schema_version: 1, sequence, purpose, question })}\n`, { mode: 0o600 });
  await onRequested?.({ requestPath, sequence, purpose, question });
  process.stdout.write(`\nOPERATOR INTERVIEW ${sequence}\n${question}\nWAITING FOR TMUX KEYPRESSES > `);
  const answer = await readOperatorLine(timeoutMs);
  await onReceived?.({ requestPath, sequence, purpose, question, answer });
  process.stdout.write("\nkeypress answer admitted; routing through governed task control\n");
  return answer;
}
