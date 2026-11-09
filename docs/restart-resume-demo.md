# Hard-crash continuation demo

This empirical flight exercises revoy2 across a real process boundary. A governed native campaign is killed with `SIGKILL` while a provider operation is dispatched. A second CLI process must discover the orphaned durable checkpoint, preview the required effect decision without mutation, reconcile the expanding node into a ledger-witnessed interruption, obtain an explicit operator disposition, re-run every fresh admission, continue under a new session identity, verify the bounded output, and adopt it.

```bash
bun run demo:restart-resume -- --run-id restart-resume-reference
```

The default publication root is `/mnt/sda2/revoy2/exemplars/restart-resume`. Each package includes a WebM, responsive gallery, time-indexed terminal capture, manifest, and `SHA256SUMS`.

The flight uses a deterministic local OpenAI-compatible reference endpoint. This isolates and proves restart, replay, collision, disposition, authority-rebinding, verification, and adoption semantics. It is not evidence of hosted-provider quality; provider-backed generalist flights remain separate artifacts.

Worktree recovery remains fail-closed. Every new lease records its owning process. A live owner blocks continuation, and an older lease without a verifiable owner remains ambiguous. Only a lease whose recorded owner is demonstrably dead can be fenced: recovery compare-and-swaps that exact lease to a fresh operation identity while retaining the isolated checkout and any partial work. A concurrent renewal or identity mismatch makes takeover fail rather than guess.

The operator-facing command is:

```bash
arbor resume --preview
arbor resume --disposition <operation-id>=retry
```

The preview prints the exact dispositions required. Decisions are `retry`, `accept_observed`, `compensate`, or `abandon`; the correct choice depends on external-effect evidence, not convenience.

When several branches are recoverable, `arbor resume` refuses to choose implicitly and lists the session IDs. When an in-flight effect is indeterminate or compensatable, preview lists the exact operation identities requiring decisions. No constructor, dashboard view, or preview performs provider replay.
