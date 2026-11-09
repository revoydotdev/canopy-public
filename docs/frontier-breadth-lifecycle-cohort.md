# Frontier breadth and lifecycle cohort

Revoy2's frontier evidence is a cohort, not a single idealized run. The cohort tests three distinct product properties:

- **Provider breadth:** the same governed campaign protocol runs through both Claude Code and OpenCode integrations.
- **Repository breadth:** TypeScript, Python, Go, and Rust repositories use their native acceptance commands rather than a harness-specific test substitute.
- **Lifecycle depth:** long-running lanes accept successive committed requirements. Every child campaign names the prior accepted campaign as its parent, then repeats independent review, adoption, and language-native acceptance.

The operator-facing model intentionally compresses the governance machinery into five stable actions:

1. Plan
2. Work
3. Review
4. Verify
5. Adopt

This is a presentation boundary, not a weaker governance mode. Provenance rules, separation of proposer and critic, evidence gates, and failed-closed adoption remain active behind every step.

## Recording the cohort

```bash
bun run demo:generalist -- --run-id revoy2-generalist-YYYYMMDD-a
bun run demo:frontier-cohort -- --run-id revoy2-frontier-cohort-YYYYMMDD-a
```

Artifacts are written under `/mnt/sda2/revoy2/exemplars/`. Each package contains real-time WebM capture, the sanitized campaign result, failing baseline and passing final acceptance logs, a manifest, a privacy scan result, and checksums.

The OpenCode cohort intentionally repeats TypeScript on a second provider and extends Rust through multiple lineage-linked requirements. It therefore tests provider portability and sustained lifecycle behavior instead of treating language count as a proxy for either.

## Evidence boundary

These fixtures demonstrate bounded, provider-backed repository work. They do not by themselves establish performance on arbitrary production monorepos, every build system, every credential topology, or campaigns lasting days. Those claims require an expanding repository corpus and longitudinal reliability measurements; the artifact manifest is designed to carry that evidence without changing the operator model.
