# Self-hosted governed demo

This recorder is designed to capture Revoy changing its own publication pipeline under the same governance model it exposes to operators. It is intended for product trailers, technical diligence, and live walkthroughs where attractive footage must remain traceable to machine-readable evidence.

## Record a campaign

Prerequisites are Bun, Git, tmux, FFmpeg/FFprobe, and an authenticated Claude Code integration. Start from a clean checkout:

```bash
bun run demo:self-hosted -- --run-id revoy2-selfhost-demo
```

Use `--keep-private-scratch` only for local diagnosis. Private scratch contains provider output and is excluded from publication. The default removes it when the recorder exits.

The recorder runs a provider-backed campaign in a disposable clone. Plans that require clarification are answered through literal `tmux send-keys` input, with a separate confirmation before execution. Specialists work in isolated leases; critics remain independent; only command-evidenced verified work can become adoptable. The selected patch is reviewed and adopted through the product result boundary before a package can seal.

## Claims a sealed package can support

The proof matrix fails unless the public evidence establishes all of these claims:

- specialist dispatch and isolated execution;
- independent critic review;
- a command-evidenced verified result;
- literal operator-keypress interview pairing;
- governed result adoption with a content identity;
- collision denial, cancellation, stale-lease recovery, and fenced retry;
- execution of the adopted integrity guard;
- campaign-ledger integrity;
- publication privacy, media, checksum, and hash-chain integrity.

The controlled flight exercise is labeled as constructed evidence. The campaign and its timing are real; the safety scenario is deterministic so collision and recovery behavior can be reproduced.

## Published files

Successful runs are written beneath `/mnt/sda2/revoy2/demos/<run-id>/`:

```text
proof.mp4
proof.webm
trailer.mp4
trailer.webm
index.html
manifest.json
SHA256SUMS
proof-matrix.json
timeline.json
chapters.json
privacy-report.json
publication-review.json
capture/
logs/
source/
```

`proof.mp4` and `proof.webm` preserve real campaign pacing. Trailer derivatives compress the same footage for editorial use. The gallery links the presentation to its timecoded event chain, verification summary, adoption receipt, safety events, privacy posture, encoder logs, and checksums.

## Failure behavior

The output directory is created with `.incomplete`. That marker is removed only after all evidence claims pass, both proof codecs are verified at 1920x1080, the run is at least two minutes long, public text is secret-scanned, the adopted code validates the public event chain, and the manifest and checksums are written.

An incomplete directory is diagnostic output, not a publishable exemplar. Do not remove `.incomplete` manually or combine files from different attempts.

## Sealed exemplar

`revoy2-selfhost-20260821-r` is one fully sealed self-hosting package. It records 362.071 seconds of campaign time and publishes a 361-second proof plus a 74.766-second trailer in both H.264 MP4 and VP9 WebM. Its manifest reports every required empirical check as passing and its privacy report records zero findings. Its evidence is specific to that disclosed run; it is not a claim of general provider quality or frontier parity.
