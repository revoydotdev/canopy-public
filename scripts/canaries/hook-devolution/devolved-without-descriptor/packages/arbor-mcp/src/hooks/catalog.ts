/**
 * CANARY STUB — not the real `packages/arbor-mcp/src/hooks/catalog.ts`.
 *
 * `DEFAULT_HOOK_SET` ships a descriptor whose `hook_id` is deliberately NOT the
 * one the fixture's ledger row claims. That disagreement is the fixture: the
 * handler is registered, the seam is real, and nothing activates the pair.
 */
const DEFAULT_HOOK_SET: readonly HookDescriptor[] = Object.freeze([
  Object.freeze({
    schema_version: 1, hook_id: "some-other-hook", version: "1.0.0", kind: "veto", event: "tool_preflight",
    handler_ref: "veto.git-write-guard",
    why: "a descriptor that exists, for a hook_id the ledger does not claim",
  }),
]);

export const DEFAULT_HOOK_DESCRIPTORS: readonly DefaultHookDescriptor[] = Object.freeze(
  DEFAULT_HOOK_SET.map((descriptor) => Object.freeze({
    filename: `${descriptor.hook_id}@${descriptor.version}.json`,
    contents: `${JSON.stringify(descriptor, null, 2)}\n`,
  })),
);
