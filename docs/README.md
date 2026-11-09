# revoy2 documentation

This index separates maintained product documentation from the engineering records that explain how the system evolved.

The product pages describe available interfaces, workflows, and evidence-package
contracts. A recorder is not itself an exemplar: treat a package as published
evidence only when its manifest and checksums are present and its `.incomplete`
marker is absent.

## Start here

- [Canopy/revoy2 documentation governance and 1.0.0 roadmap](roadmap-1.0.0-and-documentation-governance.md)
- [Five-minute quickstart](five-minute-quickstart.md)
- [Guided operator journey and recovery decisions](operator-journey-1.0.md)
- [Operator guide](operator-guide.md)
- [Operator workflows](operator-workflows.md)
- [Campaign replay and interface showcase](interface-showcase.html)
- [Architecture](architecture.md)

## Operate and integrate

- [Recovery guide](recovery-guide.md)
- [Runtime tuning](runtime-tuning.md)
- [MCP guide](mcp-guide.md)
- [Evaluation guide](evaluation-guide.md)
- [Sizzle capture](sizzle-capture.md)
- [Self-hosted governed demo](self-hosted-governed-demo.md)
- [Empirical commercial demo suite](commercial-demo-suite.md)
- [Developer tools](devtools-guide.md)

## Trust and deployment

- [Governance model](governance-manifest.md)
- [Release readiness](release-readiness.md)
- [1.0.0 release boundaries and checklist](release-boundaries-1.0.0.md)
- [Persistence migration](persistence-migration-guide.md)

## Release-document checklist

Before publishing a release or making a release-grade capability claim, review
the [canonical 1.0.0 roadmap and documentation governance](roadmap-1.0.0-and-documentation-governance.md)
and confirm that the release documents:

- identify the exact source revision, date, environment, and evidence scope;
- separate behavior observed in code or a run from inference, release targets,
  and unavailable evidence;
- link each implementation claim to code, tests, a reproducible command, or a
  sealed evidence artifact, and state known limits;
- reconcile release readiness, self-hosting, MCP, token-economy, TUI, and
  comparative-baseline claims with evidence from that revision;
- label stale snapshots as historical and link a current successor where one
  exists; and
- record failed or incomplete runs with their failure class and preserved
  artifacts, rather than presenting them as successful evidence.

This checklist governs documentation review. It does not itself certify a
release or replace the roadmap's acceptance gates.

## Engineering records

The `roadmaps/`, `proposals/`, `research/`, `postmortems/`, `position-papers/`, `adr-governance-audit/`, `tui-cockpit/`, and `tui-overhaul/` directories preserve design rationale and historical implementation work. They are useful for maintainers and due diligence, but they are not current product instructions. The maintained documents above take precedence whenever historical language differs from shipped behavior.

Historical audits, prior-art research, comparison matrices, and clean-room
records are engineering material rather than product claims. Read them for
their stated date and scope; do not use an archived finding or roadmap as a
statement of current capability.
