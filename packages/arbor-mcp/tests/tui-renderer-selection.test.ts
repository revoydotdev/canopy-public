import { describe, it, expect, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { createRenderer, resolveRendererKind, type TuiLaunchOptions } from "../src/tui.js";
import { StdoutRenderer, OpenTuiRenderer } from "@arbor/tui";

function capture(): { stream: PassThrough; text(): string } {
  const stream = new PassThrough();
  let data = "";
  stream.on("data", (chunk: Buffer) => { data += chunk.toString(); });
  return { stream, text: () => data };
}

function makeOptions(): TuiLaunchOptions {
  return {
    cwd: process.cwd(),
    stdin: capture().stream,
    stdout: capture().stream,
    stderr: capture().stream,
  };
}

const ENV_KEY = "ARBOR_TUI_RENDERER";
const originalEnv = process.env[ENV_KEY];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  delete (globalThis as { Bun?: unknown }).Bun;
});

describe("resolveRendererKind (opentui is the shipped default; stdout is the opt-out)", () => {
  it("defaults to opentui when neither an explicit option nor the env var is set", () => {
    // ADR-036 adopted OpenTUI behind RendererPort and deferred the swap to "a
    // later, separately reviewed change, gated on feat/bun-runtime-migration
    // landing". That gate is satisfied — the shipped launcher is
    // `#!/usr/bin/env bun` — and the operator directed the swap.
    delete process.env[ENV_KEY];
    expect(resolveRendererKind(undefined, { isTTY: true } as Partial<NodeJS.WriteStream>)).toBe("opentui");
  });

  it("falls back to stdout with no TTY, because the native renderer takes over a screen that is not there", () => {
    // Defaulting unconditionally broke frontier-interface-native-cli's
    // recorder, which runs the CLI with captured stdio.
    delete process.env[ENV_KEY];
    expect(resolveRendererKind(undefined, { isTTY: false } as Partial<NodeJS.WriteStream>)).toBe("stdout");
    expect(resolveRendererKind(undefined)).toBe("stdout");
  });

  it("ARBOR_TUI_RENDERER=opentui still forces it without a TTY", () => {
    process.env[ENV_KEY] = "opentui";
    expect(resolveRendererKind(undefined, { isTTY: false } as Partial<NodeJS.WriteStream>)).toBe("opentui");
  });

  it("reads ARBOR_TUI_RENDERER=opentui when no explicit option is given", () => {
    process.env[ENV_KEY] = "opentui";
    expect(resolveRendererKind(undefined)).toBe("opentui");
  });

  it("treats ARBOR_TUI_RENDERER=stdout as the explicit opt-out", () => {
    process.env[ENV_KEY] = "stdout";
    expect(resolveRendererKind(undefined)).toBe("stdout");
  });

  it("treats any other env value as the default path", () => {
    process.env[ENV_KEY] = "something-else";
    expect(resolveRendererKind(undefined, { isTTY: true } as Partial<NodeJS.WriteStream>)).toBe("opentui");
  });

  it("an explicit option always wins over the env var", () => {
    process.env[ENV_KEY] = "opentui";
    expect(resolveRendererKind("stdout")).toBe("stdout");
    process.env[ENV_KEY] = "";
    expect(resolveRendererKind("opentui")).toBe("opentui");
  });
});

describe("createRenderer (task 3: reachable OpenTUI renderer, graceful Node fallback)", () => {
  it('kind "stdout" always builds a StdoutRenderer', () => {
    const options = makeOptions();
    const renderer = createRenderer("stdout", options);
    expect(renderer).toBeInstanceOf(StdoutRenderer);
  });

  it('kind "opentui" under Node (this vitest worker has no Bun global) falls back to StdoutRenderer and reports why on stderr, rather than throwing the raw FFI error', () => {
    delete (globalThis as { Bun?: unknown }).Bun;
    const options = makeOptions();
    const stderrCapture = capture();
    options.stderr = stderrCapture.stream;
    const renderer = createRenderer("opentui", options);
    expect(renderer).toBeInstanceOf(StdoutRenderer);
    // The notice must not blame an env var the operator never set, now that
    // opentui is the default rather than an opt-in.
    expect(stderrCapture.text()).toContain("the OpenTUI renderer requires the Bun runtime");
    expect(stderrCapture.text()).toContain("Falling back to the stdout renderer");
    expect(stderrCapture.text()).not.toContain("ARBOR_TUI_RENDERER=opentui requires");
  });

  it('kind "opentui" under a Bun-shaped runtime constructs the real OpenTuiRenderer instead of falling back', () => {
    // OpenTuiRenderer's constructor performs no native FFI call (only its
    // async enter() does — verified in opentui-renderer.ts's own doc
    // comment), so exercising this branch under vitest's Node worker by
    // faking the Bun global is a real check of the routing logic, not a
    // stub of the renderer itself.
    (globalThis as { Bun?: unknown }).Bun = { version: "1.3.14-test" };
    const options = makeOptions();
    const renderer = createRenderer("opentui", options);
    expect(renderer).toBeInstanceOf(OpenTuiRenderer);
  });
});
