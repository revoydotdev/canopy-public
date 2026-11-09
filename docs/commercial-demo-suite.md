# Empirical commercial demo suite

The commercial demo suite assembles four evidence-linked demonstrations into a trailer-ready dossier when their required captures seal successfully. It is intended for product walkthroughs, technical diligence, enterprise architecture reviews, and edited launch material. It does not treat attractive video as proof: every published headline maps to a machine-readable check and a hashed source artifact.

## Build a fresh suite

```bash
bun run demo:commercial-suite -- \
  --run-id revoy2-commercial-demo \
  --cockpit-duration 16 \
  --campaign-tree-package /mnt/sda2/revoy2/campaigns/<sealed-campaign-run> \
  --campaign-tree-outcome failure_backtracking
```

`--campaign-tree-package` must name a sealed campaign-tree publication containing its MP4, WebM, public event projection, manifest, privacy report, and checksum ledger. `--campaign-tree-outcome` is closed: `verified_adopted`, `failure_backtracking`, or `controlled_fixture`. A `verified_adopted` label requires sealed adoption evidence; Campaign I uses `failure_backtracking`.

The command writes exclusively beneath `/mnt/sda2/revoy2/exemplars/<run-id>/`. It fails closed if a required flight-control event is absent, the tmux panes do not show real runtime motion, Specialist/Critic/verification events are missing, a secret-shaped string is found, an encoder or media probe fails, any proof-matrix claim is false, or the campaign-tree package does not verify. It does not copy an unsealed hero asset into a commercial dossier.

## Package contents

| Package | Visible demonstration | Evidence in a sealed suite |
|---|---|---|
| Operator cockpit | Real TUI and DevTools panes from a dedicated tmux session | Secret-scanned text frames, frame hashes, observed event counts, H.264/VP9 probes |
| Flight control | Two concurrent repositories and governed agents moving through failure and recovery | Hash-chained public events plus an allowlisted check-ID/verdict projection of the internal stress report |
| Campaign cognition | Campaign I: a real campaign growing from one point, traversing branches, rejecting work, and backtracking | Sealed public structural fixture, MP4/WebM, provenance sidecars, captions, and transcript; a failure/recovery trace, not a completion claim |
| Evidence dossier | Single browser gallery and practical claim cards | `proof-matrix.json`, nested manifests, privacy reports, `SHA256SUMS`, captions, and transcripts |

The operator capture is not a screen recording of the desktop. `tmux capture-pane` reads only the two dedicated application panes. Repository and scratch roots are replaced with stable public labels, terminal control sequences are removed, every frame is scanned, and the videos are rendered from those reviewed text frames.

## Standalone tmux capture

```bash
bun run demo:record:tmux -- \
  --run-id operator-cockpit-demo \
  --duration 16 \
  --fps 4
```

This is useful when an editor wants a fresh cockpit insert without re-running the longer distributed flight-control package.

## Reading the dossier

Open `index.html` for the presentation layer. Every gallery video includes a caption track and links to a public transcript; the operator-cockpit transcript deliberately excludes terminal and provider text. During technical diligence, use `proof-matrix.json` to move from each claim to its evidence files, then verify `SHA256SUMS`. Package-level manifests contain the media codec, dimensions, duration, source identities, privacy posture and empirical checks.

The reproducible suite deliberately does not claim live-model quality. Its cockpit uses the deterministic executor to exercise orchestration, review separation, verification, and observability without hidden provider cost or non-reproducible model output. Pair it with the [self-hosted governed demo](self-hosted-governed-demo.md) when a presentation also needs a disclosed, provider-backed campaign working on Revoy itself. The two packages keep deterministic architecture evidence distinct from live-provider behavior instead of blurring their claims.

For a provider-backed product trailer rather than a deterministic architecture reel, pair the suite with `bun run demo:upstream-lifecycle`. That package demonstrates a pinned third-party repository moving through a governed root campaign and a lineage-linked follow-up, with literal operator confirmations, independent acceptance after both adoptions, and one audit-bound tree replay per campaign. Its claim remains bounded to the named provider, tasks, revisions, and acceptance commands; it does not imply arbitrary repository compatibility or upstream endorsement.

Campaign I is presented for what it demonstrates: a branch can be rejected, recorded, and backtracked without being relabeled as a successful result. A campaign-tree publication binds its replay to the canonical tree, audit ledger, external audit-tip sentinel, source revision, and clean generator revision before its MP4/WebM derivatives can join a sealed package. The commercial suite validates those sidecars before copying the chapter and carries its outcome label forward. See [Sizzle capture](sizzle-capture.md) for the publication contract.
