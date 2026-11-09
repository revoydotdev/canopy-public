# ADR-044: Native Tools Use Graded Brokered OS Confinement

**Status:** Accepted
**Date:** 2026-08-12

Authored as Proposed: implementation authority is not acceptance authority.

## Context

The native repository host validates canonical paths and bounds child
processes in application code. Those checks are valuable defense in depth but
cannot close filesystem time-of-check/time-of-use races, isolate a hostile
process tree, or enforce network denial. Consequently the host honestly
refuses arbitrary commands when network is denied.

A single `sandboxed` boolean would erase the most important fact: whether the
operating system actually enforced the boundary. Linux deployments also vary;
Bubblewrap may be absent or user namespaces may be disabled.

## Decision

1. Confinement is the closed, ordered vocabulary `application_validated`,
   `os_confined`, `container_confined`, and `remote_attested`. Every native
   tool result records the grade that actually governed that operation.
2. A separately injectable sandbox broker probes its complete Linux
   Bubblewrap profile with a real child process. It may report `os_confined`
   only after that probe succeeds. Missing executables, unsupported platforms,
   namespace denial, or probe failure select `application_validated`.
3. The Linux profile creates mount, user, PID, IPC, UTS, and (when denied)
   network namespaces; exposes only immutable runtime directories and the
   admitted workspace; clears the environment; establishes resource limits;
   and dies with its parent. Writable workspace access is an explicit bind,
   never an ambient host-root mount.
4. Native repository operations retain their current canonicalization,
   sensitivity, exact action-scope, and executable-allowlist checks. The OS
   worker is an additional enforcement layer, not a replacement for them.
5. Commands requesting enforced network denial run only through a successfully
   probed OS broker. The fallback continues to refuse them. Unrestricted
   commands may use the bounded application runner when the broker is absent,
   and truthfully report `application_validated`.
6. Machine verification consumes the same broker and the same bounded command
   primitive. There is no verifier-specific sandbox authority.
7. Grades are observations, never promotions of provenance. OS confinement
   cannot manufacture `!verified`; verification still requires the ordinary
   zero-exit evidence and independent critic path.

## Consequences

Linux hosts with a working Bubblewrap profile can execute denied-network
commands inside a real OS boundary without adding a runtime package. Other
hosts retain existing behavior and visibly report the weaker grade. The broker
is part of the trusted computing base and its argument construction and
adversarial tests require security review.

Bubblewrap is an external host capability, not a bundled container runtime.
The runtime probe makes its absence explicit. Future Landlock, Seatbelt,
Windows restricted-token, container, or remote implementations can satisfy
the same broker contract without changing the evidence vocabulary.

## Obligations

### O1 — A broker reports OS confinement only after its complete namespace and mount profile succeeds in a real probe

<!-- proof: symbol=createSandboxBroker file=packages/arbor-mcp/src/sandbox/sandbox-broker.ts roundtrip=packages/arbor-mcp/tests/sandbox-broker.test.ts -->

### O2 — Denied-network commands execute only inside the OS profile and are refused by the application fallback

<!-- proof: symbol=SandboxedVerificationCommandPort file=packages/arbor-mcp/src/sandbox/confined-command.ts roundtrip=packages/arbor-mcp/tests/sandbox-broker.test.ts -->

### O3 — Every native tool result carries the actual closed confinement grade without changing provenance authority

<!-- proof: symbol=NativeToolExecutionEvidence file=packages/arbor-harness/src/protocol.ts roundtrip=packages/arbor-mcp/tests/native-tool-host.test.ts -->
