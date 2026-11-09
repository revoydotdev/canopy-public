# Governed WebUI campaign demo

This recorder can create empirical browser footage of Revoy's operator workspace while a provider-backed campaign runs. It complements the terminal-first self-hosting dossier: sealed packages expose their own scoped evidence for task entry, planning, live tree search, independent review, verified result capture, and operator inspection. Neither package establishes general provider quality or frontier parity from one campaign.

## Record

Prerequisites are Bun, Git, FFmpeg/FFprobe, Vivaldi, Tesseract, and an authenticated Claude Code integration. Start from a clean checkout:

```bash
bun run demo:webui -- --run-id revoy2-webui-demo
```

The command works in a disposable clone and writes only beneath `/mnt/sda2/revoy2/exemplars/webui/<run-id>/`. It selects the WebUI's explicit Governed tier, then types and submits the task through Chrome DevTools Protocol input against a dedicated Vivaldi profile. Auto remains the normal product default; the explicit selection is durably recorded as an operator override. Screenshots contain page pixels only, never arbitrary desktop pixels.

After encoding, the recorder pauses with a contact-sheet path and hash. Inspect that image, then type the exact `ATTEST sha256:...` line shown by the recorder. Any rejection, missing attestation, failed OCR scan, secret-shaped text, missing runtime evidence, unverified result, invalid codec, or checksum failure leaves `.incomplete` in place.

## Evidence in a sealed run

- `proof.mp4` and `proof.webm` preserve real campaign timing.
- `trailer.mp4` and `trailer.webm` compress the same footage for editorial use.
- `visual-review-contact-sheet.jpg` is the artifact covered by the operator attestation.
- `source/public-events.jsonl` is a recomputed hash chain joining browser actions to runtime events.
- `capture/browser-capture-index.json` records every frame time, focus region, state projection, and screenshot hash.
- `proof-matrix.json`, `timeline.json`, `chapters.json`, privacy evidence, media probes, `manifest.json`, and `SHA256SUMS` make the presentation auditable.

The provider identity and raw provider content remain private. The public package discloses the Claude Code integration, command verification, source revision, campaign identity, and bounded evidence needed to support its claims.
