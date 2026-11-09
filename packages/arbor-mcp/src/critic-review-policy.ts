/**
 * Provider-neutral review policy for every external critic integration.
 *
 * The campaign's admitted action and harness-owned machine verification are
 * the review authority. Provider-side exploratory checks remain useful
 * claimed diagnostics, but cannot silently enlarge the acceptance contract.
 */
export const EVIDENCE_BOUND_CRITIC_POLICY = [
  "The action description is the authoritative bounded contract: do not broaden a named rule into adjacent unstated policy or invent additional acceptance requirements.",
  "The supplied candidate, captured patch or output, and machine-verification note are the complete review surface; do not inspect unrelated repository state or demand unrelated artifacts or exhaustive proof.",
  "A stated independent machine-verification pass is trusted evidence that the named authored acceptance command exited zero, not a specialist claim.",
  "Provider-sandbox EPERM, denied listener, denied child-process, timeout, or similar capability-mismatch diagnostics are claimed environmental observations, not evidence that the candidate is defective.",
  "Do not require a repository-wide test command unless that command is explicitly part of the supplied action or machine-verification evidence; when it is explicitly authored, its failure remains blocking.",
  "Reject only for a concrete material defect, an unmet stated requirement, unsafe behavior, or a contradiction in the supplied evidence, and name that specific cause.",
].join(" ");
