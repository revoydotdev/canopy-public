import type { MachineVerificationCommandPort, MachineVerificationCommandRequest, MachineVerificationCommandResult, VerificationNetworkEgress, VerificationNetworkPolicy } from "../worktree-machine-verifier.js";
import { createSandboxBroker } from "./sandbox-broker.js";
import type { SandboxBroker } from "./contracts.js";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const MAX_LINKED_DEPENDENCY_ROOTS = 256;

/**
 * Resolve only dependency targets reachable from a context's top-level
 * package links (plus one scoped-package level). This is intentionally not a
 * common-ancestor mount: a copied monorepo link farm must expose its external
 * workspace packages, but never the rest of the source repository or home.
 */
export function resolveLinkedDependencyRoots(contextRoot: string): readonly string[] {
  const context = realpathSync(contextRoot);
  const modules = join(context, "node_modules");
  let entries: string[];
  try { entries = readdirSync(modules).slice(0, 4_096); } catch { return []; }
  const roots = new Set<string>();
  const inspect = (candidate: string): void => {
    if (roots.size >= MAX_LINKED_DEPENDENCY_ROOTS) return;
    try {
      const target = realpathSync(candidate);
      const delta = relative(context, target);
      if (delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta))) return;
      const marker = `${sep}node_modules${sep}`;
      const index = target.lastIndexOf(marker);
      const root = index > 0 ? target.slice(0, index + `${sep}node_modules`.length) : target;
      if (statSync(root).isDirectory()) roots.add(root);
    } catch { /* broken or non-directory dependency links grant no mount */ }
  };
  for (const entry of entries) {
    const candidate = join(modules, entry);
    inspect(candidate);
    if (entry.startsWith("@")) {
      let scoped: string[] = [];
      try { scoped = readdirSync(candidate).slice(0, 1_024); } catch { /* broken scope */ }
      for (const child of scoped) inspect(join(candidate, child));
    }
    // At the cap, keep the bounded set already collected. Returning [] here
    // (the previous behaviour) discarded every resolved root the moment a
    // large link farm crossed the limit, so a sandboxed verification in a big
    // monorepo silently lost all of its dependency mounts (audit 2026-08-23,
    // WA-47 / J8-03). The cap bounds the mount list; it is not a refusal.
    if (roots.size >= MAX_LINKED_DEPENDENCY_ROOTS) break;
  }
  return [...roots].sort();
}

/** One operator grant from `verification.network_egress` (structurally `@arbor/config`'s `VerificationNetworkEgressGrant`). */
export interface VerifierNetworkEgressGrant {
  readonly argv: readonly string[];
  readonly reason: string;
}

/**
 * The network posture of one verifier command. The default is
 * `enforced_denied`: a private network namespace whose own loopback is up,
 * so a test that binds a localhost server still works but nothing can reach
 * the host's network — including services listening on the host's
 * 127.0.0.1. Host network is granted only to an argv EXACTLY equal to one an
 * operator declared in `verification.network_egress`, and the grant carries
 * the declared reason into the verification evidence. Nothing is inferred
 * from the command text. Model-generated test commands (amplifier, killer
 * tests) never consult this policy: their caller pins them to denied.
 */
export function verifierNetworkFor(argv: readonly string[], grants: readonly VerifierNetworkEgressGrant[] | undefined): { readonly network: VerificationNetworkPolicy; readonly network_egress?: VerificationNetworkEgress } {
  const grant = (grants ?? []).find((candidate) => candidate.argv.length === argv.length && candidate.argv.every((part, index) => part === argv[index]));
  return grant === undefined ? { network: "enforced_denied" } : { network: "unrestricted", network_egress: Object.freeze({ reason: grant.reason }) };
}

/** Machine verifier adapter over the one shared sandbox broker. */
export class SandboxedVerificationCommandPort implements MachineVerificationCommandPort {
  constructor(private readonly broker: SandboxBroker = createSandboxBroker()) {}

  async run(request: MachineVerificationCommandRequest): Promise<MachineVerificationCommandResult> {
    const result = await this.broker.run({
      ...request, workspace_root: request.cwd, workspace_writable: true,
      ...(request.context_root === undefined ? {} : { readonly_context_root: request.context_root }),
      ...(request.dependency_root === undefined ? {} : { readonly_dependency_root: request.dependency_root }),
      ...(request.dependency_roots === undefined ? {} : { readonly_dependency_roots: request.dependency_roots }),
      network_denied: request.network === "enforced_denied",
    });
    return result;
  }
}
