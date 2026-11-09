# Interactive governed lifecycle demo

This demonstration shows Revoy handling a changing Rust repository across three lineage-linked campaigns. Each requirement starts from a failing language-native acceptance suite. Revoy plans the bounded work, pauses for operator confirmation, delegates implementation, obtains independent review and machine verification, adopts only the verified result, and reruns acceptance outside the agent worktree.

## Run it

Prerequisites are Bun, Git, tmux, FFmpeg/FFprobe, Rust, and an authenticated Claude Code integration.

```bash
bun run demo:frontier-interactive
```

The default output root is `/mnt/sda2/revoy2/exemplars/frontier-interactive`. Pass the equivalent `scripts/generalist-demo.mjs` arguments directly to select another run ID, output root, lane, or supported integration.

## What the recording proves

- The initial implementation and two later requirements are separate governed campaigns with explicit parent-child lineage.
- Every campaign pauses at a reviewable plan before execution.
- The recorder answers each pause through literal `tmux send-keys`; timecoded request and response evidence is retained in `capture.json` and summarized in `manifest.json`.
- Every newly introduced requirement fails its baseline acceptance command before work begins.
- Specialists work in isolated worktrees and cannot approve their own work.
- Adoption is unavailable unless the captured patch is command-verified, critic-approved, and within its declared write scope.
- The language-native acceptance command runs independently after every adoption and once more after recording.
- The WebM uses the real one-second capture clock. Provider, review, retry, and operator-wait time is not presented as instantaneous.

## Published package

The reference package produced on 2026-08-22 is:

```text
/mnt/sda2/revoy2/exemplars/frontier-interactive/revoy2-frontier-interactive-claude-20260822-a
```

Its Rust reel is 369 seconds of 1920x1080 VP9 WebM. The package contains the gallery, reel, sanitized terminal capture, campaign result, baseline and final acceptance logs, manifest, package verification report, and `SHA256SUMS`.

Verify it from the package root:

```bash
sha256sum -c SHA256SUMS
```

## Scope integrity

The recorder work exposed and closed a write-scope enforcement gap. Earlier machine verification ignored every untracked addition to avoid treating harness logs as product changes. That exemption also allowed a specialist to create an undeclared source file, report a verified tree node, and be rejected only later at adoption.

Scope verification now evaluates both tracked changes and untracked additions. Only the explicit harness-owned `.arbor/`, `.arbor-evidence/`, and `.arbor-session/` namespaces are excluded. An undeclared new product file therefore blocks an authored governed scope before the campaign can claim a verified result; mined scopes retain their documented audit-only behavior.
