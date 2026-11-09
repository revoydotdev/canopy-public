import { describe, expect, it } from "vitest";
import { CONTROL_DISABLED_GUIDANCE, controlScreen } from "../src/screens/control.js";

describe("flight control screen", () => {
  it("renders explicit setup guidance while unconfigured", () => { const projection = controlScreen.project({ availability: "disabled", kind: "control.status" }, { width: 100, height: 10 }); expect(projection.variant).toBe("disabled"); expect(projection.caption).toBe(CONTROL_DISABLED_GUIDANCE); expect(controlScreen.render({ projection, width: 100, height: 10 }).join("\n")).toContain("ARBOR_DISTRIBUTED_CONTROL_CONFIG"); });
  it("projects status, live hosts, and redacted inbox without payload bodies", () => {
    const status = controlScreen.project({ availability: "configured", kind: "control.status", updated_at: "2030-01-01T00:00:00.000Z", value: { role: "join", state: "started", host_id: "host-a", coordinator: { reachable: true }, registration: { heartbeat_at: "2030-01-01T00:00:00.000Z" }, bridge: { status: "ready", outbox_pending: 1, dead_letters: 0 } } }, { width: 120, height: 10 }); expect(status.rows[0]).toMatchObject({ host: "host-a", coordinator: "reachable", bridge: "ready" });
    const hosts = controlScreen.project({ availability: "configured", kind: "control.discover", value: { hosts: [{ host_id: "host-b", repo_id: "repo-b", session_id: "s", capabilities: ["messages"] }] } }, { width: 120, height: 10 }); expect(hosts.rows[0]).toMatchObject({ host: "host-b", repo: "repo-b" });
    const inbox = controlScreen.project({ availability: "configured", kind: "control.inbox", value: { messages: [{ message_id: "m", sequence: 4, sender_host_id: "host-b", kind: "peer.query", payload_bytes: 42, payload: { secret: "super-secret-body" } }] } }, { width: 120, height: 10 }); expect(JSON.stringify(inbox)).not.toContain("super-secret-body"); expect(inbox.rows[0]).toMatchObject({ sequence: 4, sender: "host-b", bytes: 42 });
  });
});

describe("control screen guidance at narrow width", () => {
  it("wraps the setup guidance instead of cutting the remedy", () => {
    const projection = controlScreen.project({ availability: "disabled" }, { width: 132, height: 10 });
    const lines = controlScreen.render({ projection, width: 132, height: 10 });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toContain("restart this runtime.");
  });
});
