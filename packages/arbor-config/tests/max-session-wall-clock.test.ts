import { describe, expect, it } from "vitest";
import { loadConfigFromString } from "../src/index.js";
import { CONFIG_JSON_SCHEMA } from "../src/index.js";

/**
 * `max_session_wall_clock_ms` is the operator's only lever on a native
 * session's wall-clock ceiling. The ceiling previously existed solely as a
 * `NativeAgentExecutor` option that no composition root ever passed, so no
 * operator could raise it.
 *
 * That is fatal on a transport where each model turn is a separate provider
 * process: measured on sonnet over the 25-tool catalogue, a single-function
 * fix needed ~10 turns and blew the 600s default with `max_turns` nowhere near
 * its own ceiling. The only symptom was
 * `timeout: session wall-clock limit exceeded`.
 */
describe("native.max_session_wall_clock_ms", () => {
  it("is accepted and reaches the loaded config", () => {
    const config = loadConfigFromString('{ "native": { "max_session_wall_clock_ms": 1800000 } }');
    expect(config.native.max_session_wall_clock_ms).toBe(1_800_000);
  });

  it("stays absent unless an operator sets it, preserving the executor default", () => {
    expect(loadConfigFromString("{}").native.max_session_wall_clock_ms).toBeUndefined();
  });

  it("is env-overridable through the standard config overlay", () => {
    const config = loadConfigFromString('{ "native": { "max_session_wall_clock_ms": 1800000 } }');
    expect(config.native.max_session_wall_clock_ms).toBe(1_800_000);
  });

  it("is declared in the published schema with a bounded range", () => {
    const native = (CONFIG_JSON_SCHEMA as { properties: { native: { properties: Record<string, { type?: string; minimum?: number; maximum?: number }> } } }).properties.native.properties;
    expect(native.max_session_wall_clock_ms).toMatchObject({ type: "integer", minimum: 1, maximum: 7_200_000 });
  });

  it("rejects a non-integer or out-of-range ceiling", () => {
    expect(() => loadConfigFromString('{ "native": { "max_session_wall_clock_ms": 0 } }')).toThrow();
    expect(() => loadConfigFromString('{ "native": { "max_session_wall_clock_ms": 99999999 } }')).toThrow();
  });

  it("is independent of max_turns: both ceilings coexist", () => {
    const config = loadConfigFromString('{ "native": { "max_turns": 64, "max_session_wall_clock_ms": 1800000 } }');
    expect(config.native.max_turns).toBe(64);
    expect(config.native.max_session_wall_clock_ms).toBe(1_800_000);
  });
});
