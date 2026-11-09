/**
 * audit-closure-adversarial.ts — the `closure-adversarial` 1×2 fan-out template.
 *
 * A DIFFERENT SHAPE FROM forensic-four, deliberately. That template is a 1×4
 * EXPLORATORY sweep: four disjoint lenses hunting unknown defects across a whole
 * repository, handing findings laterally to whichever sibling owns them. This
 * one is a 1×2 ADJUDICATIVE fan: two agents over the SAME ground, on ONE named
 * claim of completeness, carrying opposed burdens of proof and no lateral
 * handoffs at all — they are adversaries, not collaborators.
 *
 * WHY revoy2 NEEDS THIS SHAPE. Exploration finds defects nobody suspected.
 * It does not settle a specific disputed claim, and this repository has
 * repeatedly produced claims of closure that did not hold:
 *
 *   - ROADMAP tranches marked ✅ and later downgraded to 🟡 on re-audit,
 *     each downgrade dated in the document itself.
 *   - Reachability waivers justified by "a concurrent lane is wiring this",
 *     still unreached after that lane finished.
 *   - Three S1 defects found in code whose test suite was fully green.
 *   - An audit finding reported as citation rot that was a false positive:
 *     the cited sections existed in a differently-named document.
 *
 * Every one of those is a CLAIM, asserted in good faith, that survived because
 * nothing was obliged to attack it. A single reviewer asked "is this done?"
 * tends to confirm; two reviewers with opposed obligations cannot both be
 * lazy in the same direction.
 *
 * THE ANTI-ADVOCACY GUARD is what stops this becoming theatre. Each agent must
 * surface the strongest evidence AGAINST its own assigned position that it
 * found, and is judged on that as much as on its own case. An adversarial fan
 * without that rule degenerates into two motivated briefs, which is worse than
 * one honest review — it launders advocacy as process.
 */

import type { AuditArchetype, AuditFanoutTemplate } from "./audit-templates.js";

const challenger: AuditArchetype = {
  id: "challenger",
  ordinal: 1,
  role: "Closure Challenger",
  auditing: "the claim's weakest evidenced point",
  primaryQuestion:
    "What is the strongest EVIDENCED case that this claim of completeness does not hold, "
    + "and what is the smallest concrete demonstration that would settle it?",
  anchors: [
    "the exact wording of the claim", "what the claim would have to mean to be true",
    "unexercised branches", "untested failure paths", "the gap between a passing test and the behaviour it names",
    "callers that do not exist", "configuration under which the claim fails",
    "concurrency, restart and partial-failure conditions", "stale premises in the justification itself",
  ],
  work: [
    {
      title: "Fix the claim before attacking it",
      directives: [
        "Quote the claim verbatim and cite where it is asserted — a roadmap marker, a status field, a waiver reason, a code comment, a commit message, a prior audit's conclusion.",
        "Restate what the claim must mean to be TRUE, in terms that could be checked. An unfalsifiable restatement is a finding in itself: say so and stop, rather than attacking a claim you had to invent.",
        "Name the evidence that WOULD satisfy you. Do this before looking, so the bar is not moved after the fact.",
      ],
    },
    {
      title: "Attack the strongest form, not a weak paraphrase",
      directives: [
        "Attack the claim as its author would state it. Defeating a weaker version proves nothing and wastes the fan.",
        "Prefer one reproduced failure over ten plausible concerns. A single demonstration that the claim does not hold settles the matter; a list of worries does not.",
        "Where the claim rests on a test, read what the test actually asserts, then ask what it would still pass with. A green suite is evidence about the assertions, not about the behaviour.",
        "Where the claim rests on a justification (a waiver reason, a deferral, a cited decision), check whether that justification is still true TODAY. Premises expire silently.",
      ],
    },
    {
      title: "Report what would have convinced you",
      directives: [
        "State the strongest evidence FOR the claim that you found. This is mandatory, not a courtesy — an attack that reports no supporting evidence has not looked for any.",
        "If you could not break the claim, say so plainly and in full. A failed attack by a competent adversary is the single most valuable evidence this fan produces.",
        "Never present a concern you could not reproduce as though it were a demonstration. Label it as the unreproduced concern it is.",
      ],
    },
  ],
  exclusions:
    "Do not broaden into a general audit of the component. Findings unrelated to THIS claim belong to an exploratory template "
    + "(forensic-four), not here — raising them dilutes the adjudication this fan exists to produce. "
    + "Do not propose or implement fixes: your output is evidence about a claim, not a remediation plan.",
  deliverables: [
    "The claim, quoted verbatim with its source",
    "The falsifiable restatement, written before investigation",
    "The evidence bar you set in advance",
    "Reproduced counter-demonstrations, each with its exact command and output",
    "Unreproduced concerns, explicitly labelled as such",
    "The strongest evidence FOR the claim that you found",
    "Verdict: broken, standing, or unfalsifiable-as-stated",
  ],
  concludingQuestions: [
    "Does the claim hold?",
    "What is the smallest change to the world that would make it false?",
    "What evidence would have changed your verdict?",
    "Which part of the claim was never actually tested by anything?",
  ],
  tools: [
    {
      invocation: "captest npx vitest run <path>",
      answers: "What the existing tests actually assert about the claimed behaviour, and whether they still pass.",
      status: "available",
      limits: "Never run uncapped on this machine. A green run proves the assertions hold, not that the behaviour is correct — read what is asserted before citing a pass as evidence.",
    },
    {
      invocation: "node scripts/reachability.mjs --json",
      answers: "Whether the symbols the claim depends on have a real non-test caller, and which are permitted only by a dated waiver.",
      status: "available",
      limits: "Reports allowlisted symbols as permitted, not as reached. Read `.allowlisted` and each entry's expiry, not just the top-level ok flag.",
    },
    {
      invocation: "git log -S '<symbol>' --oneline -- <path>",
      answers: "When the claimed behaviour actually landed, and whether the justification cited for it predates or postdates the code.",
      status: "available",
      limits: "Shows commits touching a string, not intent. A justification written before the code it excuses is a signal, not a proof.",
    },
    {
      invocation: "node scripts/docs-truth.mjs --json",
      answers: "Whether a documented claim carries a proof comment binding it to a real symbol and a collected test.",
      status: "available",
      limits: "Only reads ROADMAP.md. A claim asserted in decisions/, docs/ or a code comment is outside every gate.",
    },
  ],
};

const defender: AuditArchetype = {
  id: "defender",
  ordinal: 2,
  role: "Closure Defender",
  auditing: "the claim's actual evidentiary support",
  primaryQuestion:
    "What is the strongest EVIDENCED case that this claim of completeness holds, "
    + "and exactly which part of it rests on something nobody has checked?",
  anchors: [
    "the exact wording of the claim", "the evidence actually produced for it",
    "real non-test callers", "executed behaviour rather than declared behaviour",
    "the round trip from intent to surfaced outcome", "what the claim does NOT assert",
    "the boundary between what was verified and what was assumed",
  ],
  work: [
    {
      title: "Build the case from evidence, not from the claim's own confidence",
      directives: [
        "Assemble the strongest EVIDENCED support: executed commands, real call sites, observed outputs, tests whose assertions genuinely cover the claimed behaviour.",
        "A claim's own assertion of itself is not support for it. Neither is a comment, a status marker, or a prior audit's conclusion — those are the thing under examination.",
        "Cite the round trip where one exists: intent -> interface -> dispatch -> implementation -> effects -> persistence -> consumption -> surfaced outcome. Name the hop you could not evidence.",
      ],
    },
    {
      title: "Define the claim's real boundary",
      directives: [
        "State precisely what the claim does NOT cover. A defence that quietly widens the claim is a worse failure than conceding it — it manufactures assurance.",
        "Separate what you verified from what you assumed. The assumed part is the claim's true exposure regardless of how strong the rest is.",
        "Where the claim holds only under conditions, name the conditions. 'Holds when a single process owns the directory' is a defence; 'holds' is not.",
      ],
    },
    {
      title: "Concede what does not survive",
      directives: [
        "State the strongest evidence AGAINST the claim that you found. This is mandatory: a defence that reports no contrary evidence has not looked for any, and will be read as advocacy.",
        "Concede specific points cleanly rather than defending the claim as an indivisible whole. Most claims of closure are partly true, and which part matters.",
        "If the claim cannot be evidenced at all, say so. Reporting that is a successful defence brief — the fan's purpose is an accurate verdict, not a win.",
      ],
    },
  ],
  exclusions:
    "Do not remediate, and do not argue that the claim COULD be made true — only whether it IS true as stated, today, on this revision. "
    + "Do not audit ground the claim never covered; a defence of unclaimed territory is noise.",
  deliverables: [
    "The claim, quoted verbatim with its source",
    "Evidenced support, each item with its command, call site or output",
    "The verified/assumed split, stated explicitly",
    "The claim's real boundary — what it does not cover, and under what conditions it holds",
    "Conceded points",
    "The strongest evidence AGAINST the claim that you found",
    "Verdict: evidenced, partially evidenced, or unevidenced",
  ],
  concludingQuestions: [
    "Which part of the claim is genuinely evidenced?",
    "Which part rests on something nobody checked?",
    "Under what conditions does the claim stop holding?",
    "What would you need in order to defend it without qualification?",
  ],
  tools: [
    {
      invocation: "captest npx vitest run <path>",
      answers: "Whether the tests covering the claimed behaviour pass, and precisely what they assert.",
      status: "available",
      limits: "Never run uncapped on this machine. Citing a pass without reading the assertion is the failure mode this whole template exists to catch.",
    },
    {
      invocation: "node node_modules/.bin/arbor-mcp governance --json",
      answers: "Record status, obligation coverage and drift across the real decisions/ corpus.",
      status: "available",
      limits: "A record with zero obligations reports as covered by vacuum — read the obligation count alongside the coverage verdict.",
    },
    {
      invocation: "node node_modules/.bin/arbor-mcp ledger verify --dir <dir> --campaign <id> --json",
      answers: "Whether a campaign's evidence ledger is intact, tail-truncated, or sealed by a missing sentinel, and how many repairs it has recorded.",
      status: "available",
      limits: "Answers integrity of the record, never truth of what was recorded. A perfectly intact ledger of wrong claims verifies clean.",
    },
    {
      invocation: "node scripts/docs-truth.mjs --json",
      answers: "Whether the claim, if it lives in ROADMAP.md, is bound to a real symbol and a collected test.",
      status: "available",
      limits: "Only reads ROADMAP.md, and only checks that a proof comment resolves — not that the proof is adequate to the claim.",
    },
  ],
};

export const CLOSURE_ADVERSARIAL: AuditFanoutTemplate = Object.freeze({
  id: "closure-adversarial",
  sourcePath: "packages/arbor-prompts/src/audit-closure-adversarial.ts",
  title: "Closure adversarial — two opposed briefs on one claim of completeness",
  summary:
    "A 1x2 adjudicative fan. Both agents examine the SAME named claim that something is done, "
    + "under opposed burdens of proof: one must break it, one must evidence it, and each must report the "
    + "strongest evidence against its own side. Use it to settle a specific disputed claim of closure, "
    + "not to explore for unknown defects — forensic-four is the template for that.",
  fanWidth: 2,
  sharedMission:
    "You are one of TWO agents examining a single named claim that some component, tranche, gap or "
    + "obligation is complete. Unlike an exploratory fan, you and your counterpart cover the SAME ground "
    + "with OPPOSED obligations: one of you must build the strongest evidenced case that the claim fails, "
    + "the other the strongest evidenced case that it holds. The dispatcher assigns which.\n\n"
    + "This only works if both briefs are honest. Neither of you is trying to win; the fan produces a "
    + "verdict, and a verdict built on a motivated brief is worth less than no verdict at all. Concretely: "
    + "you MUST report the strongest evidence against your own assigned position that you found, and you "
    + "are judged on that as much as on your own case. Fabricating, overstating, or quietly omitting "
    + "contrary evidence is the one failure this template cannot tolerate, because it is invisible in the "
    + "output and corrupts the adjudication that follows.\n\n"
    + "Scope: read as widely as you need to establish context, but confine findings to the assigned claim. "
    + "Defects you notice elsewhere are real and worth recording — they are simply not this fan's output, "
    + "and belong to an exploratory template instead.",
  completenessRule:
    "A claim of completeness is not evidenced by the existence of a function, a passing test, a status "
    + "marker, a checked-in document, or a prior audit's conclusion — every one of those is a claim in its "
    + "own right, and in this repository each has been wrong at least once.\n\n"
    + "A claim is evidenced only when its round trip is:\n\n"
    + "    intent -> interface -> dispatch -> implementation -> effects -> persistence -> consumption -> surfaced outcome\n\n"
    + "Name the hop you could not evidence. Both roles must do this — the Challenger to aim, the Defender "
    + "to bound.",
  coverageRule:
    "State how far you actually swept, per deliverable. Both roles are prone to the same shortcut: the "
    + "Challenger to stop at the first thing that looks broken, the Defender to stop at the first thing "
    + "that looks fine.\n\n"
    + "Label every deliverable with exactly one coverage mode, and say how you know:\n\n"
    + "    Reproduced counter-demonstrations — SAMPLED (3 of the 7 conditions named in the falsifiable\n"
    + "    restatement; the other 4 need a multi-process harness this pass did not build)\n\n"
    + "An unlabelled deliverable is read as CLAIMED_ONLY however confident it sounds. A Challenger who "
    + "swept one condition and found nothing has NOT established that the claim holds, and must not let "
    + "the shape of a report imply otherwise.",
  distinctionsRequired: [
    "A reproduced demonstration versus a plausible concern",
    "The claim as stated versus the claim as you restated it",
    "Evidence that the behaviour is correct versus evidence that a test asserts it",
    "A justification that was true when written versus one that is true now",
    "Absence of evidence versus evidence of absence",
    "What you verified versus what you assumed",
  ],
  findingFormat: [
    "finding_id: <role>-<n>",
    "claim_under_test: <verbatim quote>",
    "position: supports | undermines | bounds",
    "severity: S0..S4",
    "evidence_status: <one of the evidence statuses>",
    "coverage: <one of the coverage modes>",
    "demonstration: |",
    "  the exact command, call site or observation, and its actual output",
    "reproduced: yes | no — if no, say what stopped you",
    "against_my_own_position: |",
    "  what this cost your assigned side, or 'nothing found' if you genuinely found none",
  ].join("\n"),
  handoffProtocol:
    "This fan has NO lateral handoffs, and that is a deliberate difference from the exploratory templates. "
    + "You and your counterpart are adversaries on the same ground: passing a finding across would let one "
    + "side shape the other's brief, which is exactly the contamination the opposed-burden design exists to "
    + "prevent. You will not see their output and they will not see yours.\n\n"
    + "Everything that would have been a handoff is instead recorded in your own report under "
    + "`against_my_own_position`, where the adjudicator can see it. If you find a defect outside the claim "
    + "entirely, record it as an out-of-scope observation and carry on — do not adopt it, and do not let it "
    + "displace the claim you were dispatched to examine.",
  synthesisInstruction:
    "Adjudicate; do not merge. The two briefs are not complementary views to be combined — they are "
    + "opposed cases on one question, and the synthesis is a verdict on that question.\n\n"
    + "The claim STANDS only if the Defender's evidence survives the Challenger's strongest reproduced "
    + "attack. A Challenger demonstration the Defender did not rebut settles the matter against the claim, "
    + "however strong the rest of the defence. A Challenger who reproduced nothing, having set an evidence "
    + "bar in advance and swept it, is strong support FOR the claim — record that explicitly, because a "
    + "failed attack by a competent adversary is the most valuable output this fan produces and reads as "
    + "an empty report if nobody names it.\n\n"
    + "Weigh each side's `against_my_own_position` section heavily. A brief that found nothing against "
    + "itself either did not look or did not report, and should be discounted accordingly. Then assign the "
    + "claim exactly one final classification.",
  archetypes: [challenger, defender],
});
