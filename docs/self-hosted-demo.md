# Self-hosted governed campaign demo

This package records a real revoy2 campaign from task admission through review, adoption, and proof sealing. It is for technical diligence and product demonstrations where a short edited reel is not enough: viewers can inspect the same campaign's timecoded public evidence, verification result, and adoption receipt.

The package is designed for an 8-12 minute proof cut and a 60-90 second edited cut. Both derive from one reviewed timeline. The proof cut preserves real-time pacing at operator and campaign transitions. The edited cut may compress inactive intervals, but its `timeline.json` records the source and rendered durations for every edit.

## What the demonstration proves

- A project is enrolled and a bounded task is admitted under an explicit policy.
- Crown plans and coordinates without approving its own work.
- Specialists operate in isolated worktrees and communicate through admitted channels.
- The tree branches, selects work, records a rejection or backtrack when one occurs, and promotes only evidence-backed work.
- Critic approval and machine verification remain visibly distinct.
- Review validates the patch and current target state before selective adoption.
- A separately labeled safety exercise demonstrates writer collision denial, cancellation, stale-lease recovery, and a fenced retry.
- The campaign, repositories, and evidence ledger finish with verifiable integrity.

The demo must identify its executor at the start of the recording. A deterministic executor can demonstrate runtime mechanics, but must be labeled as deterministic. A provider-backed run must name the provider class and model revision without exposing account, prompt, or credential data. Constructed collision and recovery scenarios are safety exercises, not spontaneous production incidents.

## Recorded operator interview

The operator portion is a real, bounded interview inside a dedicated tmux pane. The recorder sends the same commands an operator would type and captures the resulting application state, rather than substituting scripted status text for a campaign.

```bash
tmux send-keys -t "$SESSION:demo.0" 'arbor task "Inspect the selected repository issue, propose a narrow change, and verify the acceptance criteria"' Enter
tmux send-keys -t "$SESSION:demo.0" 'arbor task show <draft-id>' Enter
tmux send-keys -t "$SESSION:demo.0" 'arbor task answer <draft-id> <revision> <question-id> "<operator answer>"' Enter
tmux send-keys -t "$SESSION:demo.0" 'arbor task confirm <draft-id> <revision> --wait' Enter
```

The actual draft ID, revision, and question ID are read from the campaign response; they are never invented by the capture script. The recording shows the proposed plan before confirmation, the operator's answer where clarification is required, and the explicit confirmation that grants the campaign authority to start.

Claimed output, an out-of-scope result, or a result that fails independent verification is rejected at the result boundary. It is not relabeled as successful work for the video. A rejected campaign branch can create a governed follow-up: the operator reviews the reason, starts or confirms a fresh bounded task, and the new work receives fresh scope, isolation, and authority rather than resuming a failed branch by implication.

## Campaign outcomes and safety fixtures

The main campaign and the flight-safety exercise are distinct chapters with distinct labels and evidence streams.

- A real campaign failure or backtrack is shown only when its own critic, verification, or scope evidence records it. Its recovery is a governed follow-up task or authorized retry tied to that campaign lineage.
- The flight-safety fixture deliberately introduces contention, cancellation, and stale-lease conditions to demonstrate collision denial and recovery controls. It is never represented as a failure of the customer task or as an unplanned production incident.

Both chapters use the same publication rules, but the fixture's `labeled_safety_exercise` marker must remain visible in the timeline and proof matrix.

## Capture plan

Record the same run through three correlated sources:

| Source | Purpose | Publication boundary |
|---|---|---|
| TUI Cockpit | Live tree, attention states, sessions, review and evidence | Dedicated tmux panes only; text is scrubbed and scanned before rendering |
| WebUI | Task composition, result review and adoption | Dedicated application window captured to private scratch, then visually reviewed before publication |
| Canonical evidence | Event order, authority, verification, safety, adoption and integrity | Public allowlisted projection only, with a contiguous hash chain |

Use one `run_id` across the campaign, event ledger, capture timeline, manifests, and gallery. `timeline.json` is the authority joining a visible chapter to its source evidence. Every chapter must state the source event hashes, capture timecode, rendered timecode, and whether its timing is real-time or compressed.

## Required chapters

| Chapter | Required evidence |
|---|---|
| Readiness | Project identity, policy digest, runtime revision and executor disclosure |
| Admission | Task draft, scope, capability decision and operator confirmation |
| Search | Branch creation, selection, admitted specialist scope and durable communication |
| Independent review | Critic outcome distinct from verification outcome |
| Recovery | Explicit backtrack or rejection, plus a separately labeled collision/recovery exercise |
| Result boundary | Patch digest, target-state check, selected paths and adoption receipt |
| Seal | Repository integrity, evidence-ledger verification, manifest and checksum closure |

The run fails closed if a chapter is absent, an event hash cannot be resolved, a claimed or critic-approved result is presented as verified, an actor proposes and approves the same action, a specialist lacks worktree isolation evidence, or an adoption receipt is missing.

## Privacy and publication

Publication is a separate authorization step. The runtime recording is not public merely because a campaign completed.

- Never capture a general desktop, shell history, `.env`, credential prompt, provider response, raw tool arguments, environment variables, or unreviewed browser pixels.
- Scan public JSON, tmux text frames, generated frame sources, captions, manifests, and encoder diagnostics. A secret-shaped match aborts publication rather than attempting automatic redaction.
- Keep raw WebUI video in private scratch storage. Publish it only after human visual review records the approved derivative hash in `publication-review.json`.
- The privacy report must distinguish automated text scanning from human pixel review. It must not claim that arbitrary pixels were automatically secret-free.
- Copy only reviewed public derivatives and public-safe source projections to `/mnt/sda2`.

## Package layout

```text
/mnt/sda2/revoy2/demos/<run-id>/
  proof.webm
  proof.mp4
  trailer.webm
  trailer.mp4
  index.html
  chapters.json
  timeline.json
  proof-matrix.json
  privacy-report.json
  publication-review.json
  manifest.json
  SHA256SUMS
  source/
    public-events.jsonl
    safety-fixture-events.jsonl
    verification-summary.json
    adoption-receipt.json
    runtime-projection.json
  capture/
    tmux-capture.json
    webui-capture-index.json
  logs/
    encoder-proof.log
    encoder-trailer.log
```

An `.incomplete` sentinel remains until all media probes, privacy checks, proof claims, event-chain validation, and checksums succeed. The root manifest names every public artifact and its SHA-256 digest. A detached signature may be added for external distribution, but checksums and the evidence chain are mandatory.

## Diligence workflow

1. Watch `proof.webm` with `chapters.json` and `timeline.json` available.
2. Select a chapter and resolve its event hashes against `source/public-events.jsonl`.
3. Inspect the verification summary and adoption receipt independently of the critic outcome.
4. Verify `SHA256SUMS` and compare the root manifest's run identity and ledger tip.
5. Review `privacy-report.json` and `publication-review.json` before treating browser footage as approved material.

The short trailer is a navigation surface, not standalone proof. It links to the proof package and uses the same chapter identifiers.
