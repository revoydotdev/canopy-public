# Commercial exemplar portfolio

The portfolio generator builds a curated entry point from independently sealed Revoy2 evidence packages. It does not re-label screenshots or copy clips into a new context. Before publication, it verifies every source checksum ledger, source manifest, empirical check, proof chapter bound, and required media file.

Generate a portfolio from the named sealed packages:

```bash
bun run demo:portfolio -- \
  --run-id revoy2-commercial-evidence-20260821 \
  --commercial /mnt/sda2/revoy2/exemplars/revoy2-commercial-flight-20260821-c \
  --selfhost /mnt/sda2/revoy2/demos/revoy2-selfhost-20260821-r \
  --webui /mnt/sda2/revoy2/exemplars/webui/revoy2-webui-20260821-h \
  --generalist /mnt/sda2/revoy2/exemplars/generalist/revoy2-generalist-20260821-a
```

The output is written below `/mnt/sda2/revoy2/portfolio`. Its gallery links to the complete sibling evidence packages using relative paths, while `catalog.json` binds every entry to the source manifest hash. `SHA256SUMS` seals the catalog and gallery themselves.

Publication fails closed when a source package is incomplete, a checksum disagrees, a required claim is false, recorded chapter timing exceeds the campaign duration, or required media is absent.
