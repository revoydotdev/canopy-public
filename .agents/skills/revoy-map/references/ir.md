# Revoy Map IR reference

Every document requires `schema_version: 1`, the matching `diagram_type`, and `meta.title`. IDs match `^[A-Za-z][A-Za-z0-9_-]*$` and are unique within their semantic collection.

## Shared fields

`meta` supports `title`, `subtitle`, `viewBox: [width,height]`, `animation: none|trace`, `visual_preset: classic|signal-flow|blueprint|editorial`, `quality_profile: standard|showcase`, `locale: en|zh-CN`, an optional `legend` (`mode: auto|all|hidden` plus per-kind label/visibility entries), and up to five guided `views` with `id`, `label`, `focus`, and optional `note`. `cards[]` use `title` and `body`.

Nodes use `id`, `label`, and optional `type`, `description`, `tag`, `x`, `y`, `width`, `height`, and `brand`. Relationships use optional `id`, `from`, `to`, `label`, and `variant`; `source`/`target` are compatibility aliases. Coordinates are optional; source order supplies deterministic layout.

Architecture may set `meta.repository` to `{ "url": "https://github.com/owner/repo", "revision": "<40-char-sha>" }`. A component may then carry one to three `sources` with repository-relative `path`, optional `start_line`, `end_line`, and `label`. Validation requires `--repo-root`, verifies origin/revision/blob/line facts through Git, and embeds pinned source links only after proof.

## Collections

- Architecture: `components[]`, `connections[]`, optional `boundaries[]` with `id`, `label`, `type`, and `members`.
- Workflow: `nodes[]`, `edges[]`, optional `lanes`, `phases`, `groups`, and `mainPath`.
- Sequence: `participants[]`, `messages[]`, optional `segments` and `activations`.
- Data flow: `nodes[]`, `flows[]`, optional `stages[]`.
- Lifecycle: `states[]`, `transitions[]`, optional `lanes[]`.

## Deployment ownership profile

For architecture only, `meta.engineering_profile: "deployment-ownership"` requires every non-external component to carry a non-empty owner in `tag`, exactly one `region` boundary membership, at least one `security-group` boundary, every database inside one security group, and a non-empty relationship label whenever region or security-group membership changes.

## Digest-pinned marks

Run `bun run map -- brands capture <official-direct-image-url> --json`. Use the returned `{ "url", "sha256" }` as `brand`. The local cache is ignored and is required when validating or rendering that IR.
