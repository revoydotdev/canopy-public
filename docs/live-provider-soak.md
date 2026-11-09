# Live provider soak

`bun run soak:provider` is the opt-in proof that the OpenCode server transport
actually crossed a hosted-provider boundary. It is scheduled separately from
pull-request CI because credentials, network availability, latency, and model
behavior are not deterministic.

The pass condition is deliberately stronger than process success. The soak
requires, for the same campaign:

- a successful Specialist `role_model_identity` record naming a concrete model;
- positive token usage whose counter source is `provider_counter`; and
- checksums of the canonical audit and tree files carrying those facts.

Once that evidence exists, the wrapper sends `SIGTERM` and records
`termination: "proof_threshold"`. This matters because `arbor run` performs a
graceful shutdown and may exit zero after an external signal. Exit zero without
the evidence above is a failed soak, never a pass.

The emitted `live-provider-soak-result.json` is secret-free. It includes model
identities, aggregate token counts, campaign IDs, evidence-file basenames and
hashes, source revision, elapsed time, and the termination reason. Raw provider
output is drained but never copied into the publication envelope. During a
run, bounded heartbeats report elapsed time, identity count, and attributed
token count so a multi-minute provider call does not look hung.

If the subprocess fails before producing proof, the failed envelope also
contains an 8 KiB diagnostic tail with terminal controls, repository/home
paths, account identifiers, and credential-shaped values removed. This field
is diagnostic evidence, not provider proof, and is absent from successful
envelopes.

Supported credentials are `OPENROUTER_API_KEY`, `ZAI_API_KEY`, or
`ZHIPU_API_KEY`. An existing OpenCode OpenRouter/Z.AI login is also accepted for
local runs. CI uses the secrets-gated `.github/workflows/live-provider-soak.yml`
workflow and uploads only the result envelope.

## Render the evidence reel

Capture the soak's heartbeat stream with `tee`, then render a WebM whose timing
comes from those recorded heartbeats and the terminal result:

```bash
bun run demo:provider-soak-reel -- \
  --result /mnt/sda2/revoy2/exemplars/live-provider-soak/<run>/live-provider-soak-result.json \
  --heartbeat /mnt/sda2/revoy2/exemplars/live-provider-soak/<run>/heartbeat.log \
  --output /mnt/sda2/revoy2/exemplars/live-provider-soak/<run>
```

The renderer refuses failed, exit-only, estimated-usage, unordered, or
identity-free inputs. A successful package contains `provider-proof.webm`, an
HTML player, a reel manifest, the source result and heartbeat log, and
`SHA256SUMS`.
