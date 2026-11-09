/**
 * A real pty session driven from Bun, observed through `@xterm/headless`.
 *
 * Why not tmux: EC-026 established that tmux is evidence for RENDERING, not
 * input routing — it consumes `;`, ignores `S-` on letters, cannot send
 * ctrl+shift, and its capture-pane reads positioned partial updates only
 * approximately. This session writes exact bytes to the pty and reads the
 * emulator's own cell grid, so the instrument is the same on both sides.
 *
 * Why a real pty at all: the app must see a TTY to pick its default renderer
 * (`tuimain` requires `stdin.isTTY && stdout.isTTY` for OpenTUI) and to enter
 * raw mode. `Bun.spawn({ terminal })` allocates one.
 *
 * Terminal replies: xterm answers the queries it implements (DA, DSR) through
 * `onData`; those answers are written back to the pty so the app experiences
 * a terminal that talks back — the path EC-010/044 lived on. Every reply is
 * logged as an input event tagged `reply`.
 */
import { Terminal } from "@xterm/headless";
import { snapshotScreen } from "./screen.mjs";


// Sequences an app writes to interrogate the terminal. Which of these appear
// is the renderer's fingerprint: the stdout renderer writes none of them.
const TERMINAL_QUERIES = Object.freeze([
  ["kitty_push", /\u001b\[>\d*u/u], ["kitty_query", /\u001b\[\?u/u], ["kitty_pop", /\u001b\[<\d*u/u],
  ["xtversion", /\u001b\[>0?q/u], ["da1", /\u001b\[0?c/u], ["da2", /\u001b\[>0?c/u],
  ["sync_query", /\u001b\[\?2026\$p/u], ["bg_color_query", /\u001b\]11;\?/u], ["fg_color_query", /\u001b\]10;\?/u],
  ["pixel_size_query", /\u001b\[1[46]t/u], ["cursor_position_query", /\u001b\[6n/u], ["xtgettcap", /\u001bP\+q/u],
  ["alt_screen_enter", /\u001b\[\?1049h/u], ["alt_screen_leave", /\u001b\[\?1049l/u],
  ["mouse_enable", /\u001b\[\?100[026]h/u], ["focus_enable", /\u001b\[\?1004h/u], ["bracketed_paste", /\u001b\[\?2004h/u],
]);

export class PtySession {
  #proc = null;
  #term;
  #decoder = new TextDecoder("utf-8");
  #writeChain = Promise.resolve();
  #started = 0;
  #raw = [];        // raw output chunks (Uint8Array) for fingerprinting
  #rawBytes = 0;
  #exit = null;
  events = [];      // asciicast-style event log: [elapsed_s, kind, data]
  cols; rows;

  constructor({ cmd, cwd, env, cols, rows, scrollback = 0 }) {
    this.cmd = cmd; this.cwd = cwd; this.env = env; this.cols = cols; this.rows = rows;
    this.#term = new Terminal({ cols, rows, allowProposedApi: true, scrollback });
    this.#term.onData((data) => this.#reply(data));
    this.#term.onBinary((data) => this.#reply(data));
  }

  get elapsedMs() { return Date.now() - this.#started; }
  get exited() { return this.#exit !== null; }
  get exitCode() { return this.#exit; }

  start() {
    this.#started = Date.now();
    this.#proc = Bun.spawn({
      cmd: this.cmd, cwd: this.cwd, env: this.env,
      terminal: { cols: this.cols, rows: this.rows, data: (_terminal, chunk) => this.#ingest(chunk) },
    });
    this.#proc.exited.then((code) => { this.#exit = code; this.#event("x", String(code)); });
    this.#event("h", JSON.stringify({ cmd: this.cmd, cwd: this.cwd, cols: this.cols, rows: this.rows }));
    return this;
  }

  #event(kind, data) { this.events.push([Number((this.elapsedMs / 1000).toFixed(3)), kind, data]); }

  #ingest(chunk) {
    this.#raw.push(chunk); this.#rawBytes += chunk.byteLength;
    const text = this.#decoder.decode(chunk, { stream: true });
    this.#event("o", text);
    this.#writeChain = this.#writeChain.then(() => new Promise((resolve) => this.#term.write(text, resolve)));
  }

  #reply(data) {
    if (this.exited) return;
    this.#event("i", data); this.#event("m", `reply ${JSON.stringify(data)}`);
    this.#proc.terminal.write(data);
  }

  /** Wait until every byte received so far has been applied to the emulator. */
  async settle() { await this.#writeChain; }

  /** Write bytes to the pty as if typed. */
  write(bytes, label = null) {
    if (this.exited) throw new Error("session has exited");
    this.#event("i", bytes);
    if (label) this.#event("m", label);
    this.#proc.terminal.write(bytes);
  }

  mark(label) { this.#event("m", label); }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.#event("r", `${cols}x${rows}`);
    this.#term.resize(cols, rows);
    this.#proc.terminal.resize(cols, rows);
  }

  async snapshot() { await this.settle(); return snapshotScreen(this.#term); }

  /** Poll the screen until `pattern` matches or the deadline passes. Calls `onTick(snapshot)` per poll. */
  async waitFor(pattern, { timeoutMs = 60_000, intervalMs = 250, onTick = null } = {}) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, "iu");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = await this.snapshot();
      if (onTick) onTick(snap);
      if (re.test(snap.text)) return { matched: true, snapshot: snap };
      if (this.exited) return { matched: false, snapshot: snap, reason: "exited" };
      await Bun.sleep(intervalMs);
    }
    return { matched: false, snapshot: await this.snapshot(), reason: "timeout" };
  }

  /** Hold for `ms`, polling snapshots through `onTick`. */
  async hold(ms, { intervalMs = 250, onTick = null } = {}) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const snap = await this.snapshot();
      if (onTick) onTick(snap);
      if (this.exited) return;
      await Bun.sleep(Math.min(intervalMs, Math.max(1, until - Date.now())));
    }
  }

  /** Which terminal queries the app issued, with counts. */
  observedQueries() {
    const text = this.#rawText();
    const counts = {};
    for (const [name, re] of TERMINAL_QUERIES) {
      const n = (text.match(new RegExp(re.source, "gu")) ?? []).length;
      if (n > 0) counts[name] = n;
    }
    return counts;
  }

  /** The renderer the OUTPUT proves, independent of what was requested (EC-045). */
  observedRenderer() {
    const q = this.observedQueries();
    if (q.kitty_push || q.kitty_query || q.xtversion || q.xtgettcap) return "opentui";
    if (q.alt_screen_enter) return "stdout";
    return "unknown";
  }

  rawByteCount() { return this.#rawBytes; }
  #rawText() {
    const total = new Uint8Array(this.#rawBytes);
    let offset = 0;
    for (const chunk of this.#raw) { total.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: false }).decode(total);
  }
  rawText() { return this.#rawText(); }

  /** Interrupt, then terminate. Returns the exit code. */
  async close({ graceMs = 10_000 } = {}) {
    if (!this.exited) {
      try { this.write("\u0003", "close: Ctrl+C"); } catch { /* already gone */ }
      const deadline = Date.now() + graceMs;
      while (!this.exited && Date.now() < deadline) await Bun.sleep(50);
    }
    if (!this.exited) { this.#event("m", "close: SIGTERM"); this.#proc.kill("SIGTERM"); await Bun.sleep(300); }
    if (!this.exited) { this.#event("m", "close: SIGKILL"); this.#proc.kill("SIGKILL"); }
    await this.#proc.exited;
    await this.settle();
    return this.#exit;
  }

  /** asciicast v2 text for `stream.cast` (input/reply/marker/resize events included). */
  asciicast() {
    const header = { version: 2, width: this.cols, height: this.rows, timestamp: Math.floor(this.#started / 1000), env: { TERM: this.env?.TERM ?? "xterm-256color" } };
    return [JSON.stringify(header), ...this.events.map((e) => JSON.stringify(e))].join("\n") + "\n";
  }
}
