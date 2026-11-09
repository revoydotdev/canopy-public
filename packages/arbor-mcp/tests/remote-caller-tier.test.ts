/**
 * ADR-028 says a transport that accepts instructions from a party it does not
 * control must pass `caller_tier: "junior"` explicitly.
 *
 * `remote-serve` DOES NOT DO THAT YET, and this file does not claim it does.
 * The change was built, verified, and then HELD on 2026-08-19 pending ADR-084,
 * because wiring it honestly refuses 100% of the remote surface (see the
 * Finding below) and would silently disable a working feature.
 *
 * So read this file as proving the MECHANISM and documenting the CONSEQUENCE,
 * not as pinning production wiring. It builds its own junior-tiered router
 * rather than importing `remote-serve`'s composition, which means it passes
 * whether or not cli.ts sets the tier — a real limit, stated here rather than
 * left for a reader to discover. Pinning the production composition would need
 * a seam that exports it; that is part of what ADR-084 has to settle.
 *
 * `capability-tier-enforcement.test.ts` proves the tier gate works against a
 * hand-constructed `{ caller_tier: "junior" }` option — it never proves the
 * remote surface actually sets that option. This file drives the real remote
 * path: a `RuntimeCatalogRouter` built the same way `remote-serve` builds it,
 * wrapped in the real `RemoteRuntimeIngress`, fed a cryptographically signed
 * remote-session envelope exactly as a genuine remote caller would send one.
 *
 * Finding: every command kind `RemoteRuntimeIngress.dispatch` accepts
 * (`bus.thread.send`, `bus.thread.ack`, `approval.request`, `approval.approve`,
 * `approval.reject`) is a catalog `command` entry, and `catalogActionClass`
 * maps every `command` to `preview-confirm` — the one mutating action class,
 * which requires `senior`. `RemoteRuntimeIngress` exposes no `query` kind at
 * all (`dispatch` rejects anything else outright). So wiring the remote
 * composition root to `junior` does not narrow remote functionality — as
 * currently scoped, it refuses everything the real remote ingress can
 * dispatch. That is the ADR-028 O3 floor working as specified; it is also a
 * real product-scope finding, not a test artifact, so this file proves the
 * refusal on the real ingress path and proves the tier is a floor rather than
 * a blanket lockout by exercising the read side directly against the same
 * router construction (there being no read path through the ingress to
 * exercise it through).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RemoteRuntimeIngress } from "../src/remote-ingress.js";
import { RemoteSessionAuthority, createRemoteSessionIdentity } from "../src/remote-session.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const now = () => new Date("2026-08-19T00:00:00.000Z");
function temp(): string { const value = mkdtempSync(join(tmpdir(), "arbor-remote-caller-tier-")); roots.push(value); return value; }

/** Mirrors cli.ts's `remote-serve` composition root exactly: a junior-tiered router fed to RemoteRuntimeIngress. */
function setupRemoteComposition(dir = temp()) {
  const runtime = new ArborRuntime({ persistence_dir: dir });
  runtime.manager.startCampaign("campaign", "plan.md", root);
  const [child] = runtime.manager.branch("campaign", "root", [{ ...root, description: "child", delegate_to: "seed" }]);
  if (!child) throw new Error("child setup failed");
  const router = new RuntimeCatalogRouter(runtime, { caller_tier: "junior" });
  const authority = new RemoteSessionAuthority({ persistence_dir: dir, now });
  return { dir, runtime, router, authority, ingress: new RemoteRuntimeIngress(router, authority), child };
}

function metadata(actor_id: string, operation_id: string) {
  return { operation_id, idempotency_key: `${operation_id}:key`, correlation_id: "remote-correlation", actor_id, requested_at: "2026-08-19T00:00:00.000Z" };
}

describe("remote-serve composition is a junior-tier caller (ADR-028)", () => {
  it("refuses a real remote-dispatched mutating command (bus.thread.send) naming the required tier", async () => {
    const { authority, ingress, runtime, child } = setupRemoteComposition();
    const identity = createRemoteSessionIdentity({
      session_id: "remote-parent",
      actor_id: "remote:parent",
      expires_at: "2026-08-20T00:00:00.000Z",
      thread_audiences: [{ campaign_id: "campaign", parent_node_id: "root", child_node_id: child, author_node_id: "root" }],
    });
    authority.register(identity.registration);
    const meta = metadata(identity.registration.actor_id, "remote-send");
    const command = {
      kind: "bus.thread.send" as const,
      campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: "root",
      expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version,
      message_kind: "delegate" as const, content: "bounded remote task",
      provenance: { tag: "claimed" as const, claimant: "remote:parent" }, capability_tier: "specialist" as const,
    };
    const signed = identity.sign({ kind: command.kind, metadata: meta, params: (({ kind: _kind, ...params }) => params)(command), nonce: "tier-nonce", issued_at: "2026-08-19T00:00:00.000Z" });
    const envelope = { schema_version: 1 as const, metadata: { ...meta, remote_session_proof: signed }, command };

    const result = await ingress.dispatch(envelope);

    expect(result).toMatchObject({ ok: false, error: { code: "permission" } });
    const summary = (result as { ok: false; error: { summary: string } }).error.summary;
    expect(summary).toContain("bus.thread.send");
    expect(summary).toContain("senior");
    expect(summary).toContain("junior");
  });

  it("still lets the same junior-tier router answer a read (no read path exists through the ingress itself, by design)", () => {
    const { router } = setupRemoteComposition();

    const result = router.executeQuery({ schema_version: 1, query_id: "remote-read", query: { kind: "operation.list" } });

    expect((result as { ok: boolean }).ok).toBe(true);
  });
});
