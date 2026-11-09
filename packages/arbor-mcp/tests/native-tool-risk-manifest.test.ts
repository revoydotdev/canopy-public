import { describe, expect, it } from "vitest";
import { NATIVE_BROWSER_TOOL_RISKS } from "../src/native-browser-tools.js";
import { NATIVE_SUBAGENT_TOOL_RISKS } from "../src/native-agent-executor.js";
import { NATIVE_TOOL_RISK_MANIFEST } from "../src/native-tool-risk-manifest.js";
import { NATIVE_IMAGE_TOOL_RISKS, NATIVE_REPOSITORY_TOOL_RISKS, NATIVE_SKILL_TOOL_RISKS, NATIVE_USERINPUT_TOOL_RISKS } from "../src/native-tool-host.js";
import { NATIVE_WEB_TOOL_RISKS } from "../src/native-web-tools.js";
import { NATIVE_PEER_TOOL_RISKS } from "../src/native-peer-tools.js";
import { NATIVE_BUS_THREAD_MODEL_TOOLS, NATIVE_REPOSITORY_MODEL_TOOLS } from "../src/cli.js";

describe("native tool risk manifest", () => {
  it("is the exact source of the host-local risk views", () => {
    const hostViews = {
      ...NATIVE_REPOSITORY_TOOL_RISKS,
      ...NATIVE_SUBAGENT_TOOL_RISKS,
      ...NATIVE_SKILL_TOOL_RISKS,
      ...NATIVE_USERINPUT_TOOL_RISKS,
      ...NATIVE_IMAGE_TOOL_RISKS,
      ...NATIVE_WEB_TOOL_RISKS,
      ...NATIVE_BROWSER_TOOL_RISKS,
    };
    const nonHostNames = new Set([...Object.keys(NATIVE_PEER_TOOL_RISKS), "bus.thread.send", "bus.thread.ack", "sibling.status"]);
    const expectedHost = Object.fromEntries(Object.entries(NATIVE_TOOL_RISK_MANIFEST).filter(([name]) => !nonHostNames.has(name)));
    expect(hostViews).toEqual(expectedHost);
  });

  it("is the exact source of every advertised native tool risk", () => {
    const advertised = [...NATIVE_REPOSITORY_MODEL_TOOLS, ...NATIVE_BUS_THREAD_MODEL_TOOLS];
    expect(advertised.every((tool) => Object.hasOwn(NATIVE_TOOL_RISK_MANIFEST, tool.name))).toBe(true);
    const peerNames = new Set(Object.keys(NATIVE_PEER_TOOL_RISKS));
    const expectedStatic = Object.fromEntries(Object.entries(NATIVE_TOOL_RISK_MANIFEST).filter(([name]) => !peerNames.has(name)));
    expect(Object.fromEntries(advertised.map((tool) => [tool.name, tool.risk])))
      .toEqual(expectedStatic);
  });
});
