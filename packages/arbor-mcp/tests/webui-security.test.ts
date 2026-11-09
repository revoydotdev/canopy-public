import { describe, expect, it } from "vitest";
import * as http from "node:http";
import * as vm from "node:vm";
import { toCommandEnvelope, ArborWebUIServer } from "../src/webui.js";
import { ArborRuntime } from "../src/runtime.js";

describe("web UI command envelopes", () => {
  it("generates a distinct idempotency identity for each bare command", () => {
    const first = toCommandEnvelope({ kind: "taskcomposer.submit" }) as { metadata: { operation_id: string; idempotency_key: string } };
    const second = toCommandEnvelope({ kind: "taskcomposer.submit" }) as { metadata: { operation_id: string; idempotency_key: string } };
    expect(first.metadata.operation_id).toBe(first.metadata.idempotency_key);
    expect(second.metadata.operation_id).toBe(second.metadata.idempotency_key);
    expect(second.metadata.operation_id).not.toBe(first.metadata.operation_id);
  });
});

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    }).on("error", reject);
  });
}

/**
 * A real browser HTML-parser entity-decodes an attribute value (per the
 * HTML5 spec) before handing the decoded text to the JS engine as an event
 * handler body. `esc()` in webui.ts only ever emits these five references,
 * so decoding exactly this set reproduces, deterministically, what a
 * browser does to the `onclick="..."` attribute before executing it -- no
 * jsdom dependency required for this narrow, well-defined step.
 */
function decodeHtmlAttributeEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("web UI remote/schedule control buttons escape their onclick attribute", () => {
  // remoteSessionControls/scheduleControls (webui.ts ~1515-1526) build an
  // onclick="..." attribute value that embeds JSON.stringify(session_id) /
  // JSON.stringify(schedule_id) directly. JSON.stringify's own escaping is
  // for *JavaScript string* syntax (backslash-escaped quotes) -- an HTML
  // attribute parser does not understand backslash escapes, so any literal
  // `"` in that JSON output (which JSON.stringify always emits at least two
  // of, for the wrapping quotes) closes the onclick="..." attribute early.
  // Every rendered Revoke/Suspend/Resume button was therefore malformed
  // markup, and a session/schedule id containing HTML metacharacters could
  // inject a live, attacker-controlled attribute onto the button element.
  it("does not let a session_id with HTML metacharacters break out of the onclick attribute", async () => {
    const runtime = new ArborRuntime();
    const webui = new ArborWebUIServer(runtime);
    await new Promise<void>((resolve) => webui.start(0, resolve));
    try {
      const port = webui.getPort()!;
      const { status, body } = await httpGet(port, "/");
      expect(status).toBe(200);
      const script = body.split("<script>")[1]?.split("</script>")[0] ?? "";
      const pick = (name: string): string => {
        const start = script.indexOf(`function ${name}(`);
        expect(start, name).toBeGreaterThanOrEqual(0);
        let depth = 0; let i = script.indexOf("{", start);
        for (; i < script.length; i++) { if (script[i] === "{") depth++; else if (script[i] === "}") { depth--; if (depth === 0) break; } }
        return script.slice(start, i + 1);
      };
      const escLine = script.split("\n").find((line) => line.startsWith("const esc = "));
      expect(escLine).toBeDefined();
      const source = [escLine, pick("operationButton"), pick("remoteSessionControls")].join("\n")
        + "\nglobalThis.__out = remoteSessionControls([{session_id: globalThis.__sessionId, state: 'active'}]);";

      const maliciousSessionId = '1" onmouseover="alert(document.cookie)';
      const sandbox: Record<string, unknown> = { __sessionId: maliciousSessionId, JSON, String, Array, Object };
      vm.createContext(sandbox);
      vm.runInContext(source, sandbox);
      const html = sandbox.__out as string;

      const onclickMatch = /onclick="([^]*?)">/.exec(html);
      expect(onclickMatch, html).not.toBeNull();
      const rawOnclickAttribute = onclickMatch![1];

      // The defect: the raw attribute text itself contains a literal,
      // unescaped `"` -- proof the real onclick="..." attribute terminates
      // early in an actual browser, before the injected
      // onmouseover="alert(...)" text, which becomes a second, live,
      // attacker-controlled attribute on the <button> element.
      expect(rawOnclickAttribute, html).not.toMatch(/"/);

      // And once a browser HTML-decodes the (now correctly escaped)
      // attribute value, it must still be the exact, syntactically valid JS
      // call the button is meant to invoke -- not mangled by escaping.
      const decoded = decodeHtmlAttributeEntities(rawOnclickAttribute);
      expect(() => new Function(decoded)).not.toThrow();
      const dispatched: Array<{ kind: string; params: Record<string, unknown> }> = [];
      const clickSandbox = {
        confirmOperation: (kind: string, params: Record<string, unknown>) => { dispatched.push({ kind, params }); },
      };
      vm.createContext(clickSandbox);
      vm.runInContext(decoded, clickSandbox);
      expect(dispatched).toEqual([{ kind: "remote.control", params: { action: "revoke", session_id: maliciousSessionId } }]);
    } finally {
      await webui.stop();
    }
  });
});
