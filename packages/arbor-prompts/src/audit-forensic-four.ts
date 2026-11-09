/**
 * audit-forensic-four.ts — the `forensic-four` 1×4 fan-out audit template.
 *
 * Four agents, one repository, four different proofs of correctness:
 *
 *   1. Constitutional  — is the code justified and semantically correct?
 *   2. Structural      — is the code actually connected and reachable?
 *   3. Resilience      — does behaviour hold across time, failure, concurrency?
 *   4. Runtime         — does the deployed system produce the claimed effects?
 *
 * The division is intentionally asymmetric. Agent 1 proves legitimacy, Agent 2
 * proves connectivity, Agent 3 proves durability, Agent 4 proves operational
 * reality. Because no two lenses accept the same thing as proof, they can
 * corroborate or falsify one another — which a team split by directory cannot.
 *
 * Tool `status` fields were established by inspection, not assumption. The
 * `proposed` entries are explicitly NOT available in revoy2 today and must not
 * be cited as evidence by an agent running this template.
 */

import type { AuditArchetype, AuditFanoutTemplate } from "./audit-templates.js";

const constitutional: AuditArchetype = {
  id: "constitutional",
  ordinal: 1,
  role: "Constitutional and Contract Auditor",
  auditing: "the codebase's meaning and legitimacy",
  primaryQuestion:
    "What is each component supposed to mean, who authorizes it, what rules must it preserve, "
    + "and does the implementation actually honor those rules?",
  anchors: [
    "intent", "requirements", "ADRs and architectural decisions", "contracts",
    "preconditions", "postconditions", "error contracts", "invariants",
    "identity", "authority", "ownership", "trust", "provenance", "governance",
    "policy", "capability boundaries", "security obligations",
    "supersession and deprecation", "documentation-to-implementation drift",
  ],
  work: [
    {
      title: "Build the constitutional chain",
      directives: [
        "For every major feature or subsystem, construct: requirement -> ADR/decision -> specification -> interface -> implementation -> test -> runtime evidence.",
        "Identify every broken or missing link, and say which link is missing rather than that the chain is 'incomplete'.",
        "Classify each implementation as: explicitly authorized; implicitly justified but undocumented; contradicting a governing decision; outliving or bypassing its original justification; implementing only part of the declared intent; or introducing behaviour never approved by the governing architecture.",
        "An ADR marked Accepted that no human ratified is a finding, not a chain link. No agent both proposes and approves.",
      ],
    },
    {
      title: "Extract contracts",
      directives: [
        "For significant interfaces, functions, services, events, commands, files and APIs, document accepted inputs, rejected inputs, preconditions, postconditions, side-effect expectations, error representations, security assumptions, idempotency expectations, performance expectations and compatibility guarantees.",
        "Compare each contract across documentation, types, schemas, implementations, callers, tests and runtime behaviour.",
        "Flag contract disagreements even where every individual component is locally valid — the disagreement is the defect.",
      ],
    },
    {
      title: "Mine invariants",
      directives: [
        "Infer invariants from ADRs, database constraints, assertions, validation logic, state checks, tests, error handling, repeated code patterns, operational documentation and security policy.",
        "For each invariant record: scope, authority, the component responsible for maintaining it, every operation capable of violating it, existing enforcement, missing enforcement, and detection/recovery mechanisms.",
        "An invariant documented but not enforced is worse than none — it creates false confidence. Rank those highest.",
      ],
    },
    {
      title: "Audit authority and ownership",
      directives: [
        "For every important resource or state, identify creator, canonical owner, mutators, readers, validators, deleters, cleanup owner, final authority and derived consumers.",
        "Look specifically for: multiple writers without coordination; no clear owner; frontends treated as authoritative; caches becoming de facto authorities; workers mutating state owned by another service; authorization applied only at presentation boundaries; privilege inherited accidentally through shared infrastructure; cleanup owned by nobody.",
      ],
    },
    {
      title: "Audit identity",
      directives: [
        "Determine how entities are identified across UI, API, services, events, persistence, logs and external systems.",
        "Find identity collisions, mutable natural keys, lost correlation IDs, reused identifiers, ambiguous tenant identity, mismatched user/actor identity, missing idempotency identity, and records that cannot be traced to their origin.",
        "Watch for identifiers that are unqualified across namespaces — a bare id shared by two authorities is a collision waiting to be resolved silently and wrongly.",
      ],
    },
    {
      title: "Audit provenance",
      directives: [
        "Determine whether important artifacts, records, decisions, generated files and operations trace to their source, creator, governing decision, transformation history, version, predecessor and consumers.",
        "Inference must never be recorded at the same confidence as declaration. If a link was derived rather than declared, it must say so.",
      ],
    },
  ],
  exclusions:
    "Do not own detailed runtime call-graph reconstruction, concurrency proof, performance profiling, or operational telemetry analysis. "
    + "You may identify issues in those areas, but they become handoffs to the responsible agent, not conclusions of your own.",
  deliverables: [
    "Constitutional traceability matrix",
    "Contract registry",
    "Invariant registry",
    "Authority and ownership matrix",
    "Identity and provenance map",
    "ADR-to-implementation drift report",
    "List of unjustified, undocumented, superseded or contradictory components",
    "Ranked findings",
    "Explicit handoffs to agents 2, 3 and 4",
  ],
  concludingQuestions: [
    "What does the system claim to guarantee?",
    "Which guarantees are actually enforceable?",
    "Which guarantees exist only in documentation?",
    "Where is authority ambiguous?",
    "Which components cannot justify their existence?",
    "Which architectural decisions have drifted from implementation?",
  ],
  tools: [
    {
      invocation: "node scripts/docs-truth.mjs --json",
      answers: "Which documented claims carry a proof comment binding them to a real symbol and a collected round-trip test.",
      status: "available",
      limits: "Only reads ROADMAP.md. Claims in decisions/ and docs/ are outside every gate — prose there rots unwitnessed, which is itself a finding class for this lens.",
    },
    {
      invocation: "node scripts/closed-enum-hygiene.mjs --json",
      answers: "Whether closed vocabularies quoted in prose still match their authoritative definition in contracts.ts.",
      status: "available",
      limits: "Covers the enums it was told about. An enum nobody registered drifts freely.",
    },
    {
      invocation: "arbor-mcp governance --json",
      answers: "Record status, obligation coverage and drift over the real decisions/ corpus, as a GovernanceResult envelope.",
      status: "available",
      limits: "Obligation coverage is computed from proof comments; a record with zero obligations reports as covered-by-vacuum, so read the obligation count too.",
    },
    {
      invocation: "@arbor/governance: classifyCorpusCitations(scanDecisionsCorpus(dir))",
      answers: "Which ADR-to-ADR citations resolve, by what method, at what confidence, and which are unresolvable.",
      status: "available",
      limits: "Authority is the local corpus only. Cross-namespace citations correctly resolve to `none` rather than guessing.",
    },
    {
      invocation: "A materialized policy->surface manifest with `declared_in` provenance on every edge.",
      answers: "Which policy governs which surface, sourced from a checked-in ownership declaration rather than inferred per audit.",
      status: "proposed",
      limits: "Not built in revoy2. Adapted from revoy-spec's surface-manifest.json + governance/surface-ownership.json (CC-BY-4.0, attribution required). Until built, this lens must derive ownership per run and say so.",
    },
  ],
};

const structural: AuditArchetype = {
  id: "structural",
  ordinal: 2,
  role: "Structural Graph and Reachability Auditor",
  auditing: "the codebase's nervous system",
  primaryQuestion:
    "Can intended behaviour actually travel through the system from initiator to terminal consumer, "
    + "or does the repository merely contain disconnected pieces that resemble an implementation?",
  anchors: [
    "callers", "callees", "call graphs", "dependency graphs", "control flow",
    "dispatch", "reachability", "liveness", "integration boundaries", "routes",
    "events", "queues", "workers", "UI actions", "CLI commands", "plugins",
    "middleware", "configuration-based wiring", "reflection",
    "dependency injection", "dynamic imports", "feature flags",
    "generated registries", "build and deployment inclusion",
  ],
  work: [
    {
      title: "Construct multiple graphs and compare them",
      directives: [
        "Build the declared-architecture graph, the static caller graph, the runtime-observed graph, the configuration-derived graph, the deployment graph and the intended-feature graph.",
        "Do not assume these agree. The disagreements are the product.",
        "Mark every edge by how it was obtained: direct call, dynamic call, event subscription, queue dispatch, HTTP/RPC, database-mediated, filesystem-mediated, dependency injection, plugin registration, reflection, generated linkage, human invocation, or inferred.",
      ],
    },
    {
      title: "Trace feature round trips",
      directives: [
        "From each initiating surface (UI control, API request, CLI command, scheduled task, queue message, event, webhook, plugin, external integration) trace through validation, auth, routing, middleware, dispatch, business logic, persistence, external effects, return path, state refresh, user-visible outcome and downstream consumers.",
        "Do not stop when a backend function executes. Verify that its result is USED. A function that runs and whose output nothing reads is a terminated round trip.",
      ],
    },
    {
      title: "Classify reachability for every significant component",
      directives: [
        "Assign exactly one of: proven reachable; conditionally reachable; feature-flag reachable; test-only reachable; development-only reachable; deployment-excluded; dynamically reachable but statically obscure; declared but unwired; called but unable to complete; orphaned; dead; unknown.",
        "Distinguish code that is uncalled from code invoked through non-obvious mechanisms. Bias conservatively: a false 'live' is acceptable, a false 'dead' is not — deleting live code on a wrong verdict is unrecoverable.",
      ],
    },
    {
      title: "Audit dispatch systems",
      directives: [
        "Inspect routers, registries, command maps, event registries, worker registries, plugin loaders, DI containers, handler maps, state-machine transition tables, generated bindings and UI action maps.",
        "Find duplicate registrations, shadowed handlers, unreachable branches, unsatisfiable predicates, missing registrations, incorrect ordering, middleware that swallows control, fallback handlers masking failure, no-op adapters, placeholder dispatch, events with no consumers, and consumers for events never emitted.",
      ],
    },
    {
      title: "Audit boundaries",
      directives: [
        "At every architectural boundary check that inputs serialize correctly, outputs are consumed correctly, errors translate correctly, auth context survives, identity survives, version expectations agree, timeouts and cancellation propagate, retry semantics agree, and naming/schema/nullability agree.",
        "A boundary where both sides are individually correct but their shapes do not line up is a degraded seam — wired, and still broken.",
      ],
    },
    {
      title: "Detect architectural disconnection",
      directives: [
        "Search systematically for UI controls with no handler; endpoints with no clients; clients targeting nonexistent endpoints; backend capabilities never surfaced; queue producers without consumers and vice versa; events emitted under mismatched names; config options never read; environment variables documented but unused; services defined but not deployed; code excluded by build configuration; modules imported only by tests; duplicate endpoint families with divergent behaviour; legacy and replacement paths both partially active.",
      ],
    },
  ],
  exclusions:
    "Do not own semantic interpretation of ADRs, detailed concurrency correctness, or telemetry quality. Turn those into precise handoffs.",
  deliverables: [
    "Whole-repository component graph",
    "Caller/callee registry",
    "Producer/consumer registry",
    "Route, command, event and worker registry",
    "End-to-end feature trace matrix",
    "Reachability classification for every significant component",
    "Orphan, dead-code and partial-wiring report",
    "Boundary mismatch report",
    "Ranked findings",
    "Explicit handoffs to agents 1, 3 and 4",
  ],
  concludingQuestions: [
    "Which features are genuinely end-to-end?",
    "Which features terminate prematurely?",
    "Which components are present but unreachable?",
    "Which effects occur but are never consumed or surfaced?",
    "Which dynamic mechanisms evade ordinary static inspection?",
    "Where does the implemented graph diverge from the intended graph?",
  ],
  tools: [
    {
      invocation: "node scripts/reachability.mjs --json",
      answers: "Which exported symbols are reachable from a declared entry point, and which carry a dated waiver.",
      status: "available",
      limits: "Module-graph reachability, not call-level. A symbol imported by a reachable module counts as reached even if no code path calls it.",
    },
    {
      invocation: "node scripts/registration-integrity.mjs --json",
      answers: "Dead entrypoints, CLI dispatch/help drift, unregistered MCP tools, catalog/dispatch drift, orphaned scripts.",
      status: "available",
      limits: "Deliberately biased so a false LIVE is acceptable and a false DEAD is not; it will under-report rather than over-accuse.",
    },
    {
      invocation: "packages/arbor-mcp/tests/roundtrip/manifest.ts",
      answers: "Which catalog capabilities have a real end-to-end conformance test, by name, verified to exist on disk.",
      status: "available",
      limits: "Proves a roundtrip test EXISTS and is named correctly; does not prove it asserts anything meaningful.",
    },
    {
      invocation: "A code-intel MCP over the TypeScript compiler API (find_symbol / get_references / get_call_graph / get_code_snippet).",
      answers: "Call-level callers and callees, at a fraction of the tokens of reading files.",
      status: "proposed",
      limits:
        "Not built in revoy2. Note the build-vs-depend calculus differs from revoy-spec's ADR-042, which justified ~12k LOC of Python over depending on a Go binary because of the subprocess/IPC seam: revoy2 is TypeScript and ALREADY depends on the `typescript` compiler, so the compiler API is a better symbol source than a tree-sitter reimplementation and the seam cost is near zero. revoy-spec's own wired `revoy.edit.mcp_lsp` (lsp_find_references / lsp_diagnostics / lsp_rename) is the closest working prior art.",
    },
  ],
};

const resilience: AuditArchetype = {
  id: "resilience",
  ordinal: 3,
  role: "State, Time, and Resilience Auditor",
  auditing: "the codebase's behaviour through time",
  primaryQuestion:
    "Does the system preserve correctness across transitions, interruption, concurrency, partial completion, replay and recovery?",
  anchors: [
    "state", "state machines", "transitions", "lifecycles", "temporal semantics",
    "ordering", "concurrency", "coordination", "atomicity", "transactions",
    "idempotency", "retries", "timeouts", "cancellation", "leases", "locks",
    "backpressure", "partial failure", "compensation", "recovery", "replay",
    "eventual consistency", "crash consistency", "distributed failure",
  ],
  work: [
    {
      title: "Extract state models",
      directives: [
        "Identify explicit AND implicit state machines for workflows, jobs, tasks, sessions, agents, requests, connections, files, resources, locks, deployments, approvals, records and external integrations.",
        "For each: states, initial, terminal, transitional, valid transitions, invalid transitions, initiators, guards, effects, persistence, recovery path, timeout behaviour.",
        "Look hardest for state encoded indirectly — combinations of booleans, nullable fields, timestamps, filesystem presence, or the existence of a distributed record. Implicit state machines are where invalid states hide.",
      ],
    },
    {
      title: "Test representability and reachability of states",
      directives: [
        "Determine whether invalid states are representable; valid states unreachable; terminal states able to transition again; partial states visible; transitions able to occur twice or be skipped; concurrent actors able to produce contradictory state; state able to survive restart; derived state able to diverge from authoritative state.",
      ],
    },
    {
      title: "Identify atomic units",
      directives: [
        "For each important workflow identify the intended atomic unit, the actual commit point, effects before and after commit, irreversible effects, rollback behaviour, compensation behaviour and visibility of partial state.",
        "Treat any workflow spanning databases, queues, filesystems, APIs or event buses as a distributed transaction even if the code never uses that word.",
      ],
    },
    {
      title: "Audit concurrency",
      directives: [
        "Inspect for check-then-act races, lost updates, double execution, reentrancy bugs, deadlocks, livelocks, starvation, lock abandonment, lease expiry mid-work, split-brain ownership, unsafe optimistic concurrency, missing compare-and-swap, duplicate queue delivery, multiple workers claiming the same work, cancellation races and shutdown races.",
      ],
    },
    {
      title: "Audit temporal assumptions",
      directives: [
        "Find assumptions about event order, clock accuracy, wall-clock versus monotonic time, timeout duration, credential expiry, lease duration, cache freshness, debounce/throttle windows, scheduled execution, delayed delivery, retry delay and dependency recovery.",
        "For each, determine whether the assumption is explicit, tested and observable. An assumption that is none of the three is a latent outage.",
      ],
    },
    {
      title: "Audit failure semantics",
      directives: [
        "Classify failures as expected rejection, programmer defect, transient dependency failure, permanent dependency failure, timeout, cancellation, partial success, corruption, authorization failure, resource exhaustion or unknown.",
        "For each class determine retryability, retry limits, backoff, idempotency protection, escalation, dead-letter handling, compensation, user-visible status, operator-visible status and preservation of diagnostic evidence.",
      ],
    },
    {
      title: "Perform recovery analysis",
      directives: [
        "Reason through or actually test: crash before persistence; crash after persistence but before acknowledgement; crash after an external effect but before the local record; duplicate delivery; out-of-order delivery; late delivery; lost acknowledgement; empty or stale cache; database restoration; worker restart; network partition; partial deployment; mixed-version execution; configuration change during operation; lock holder disappearance.",
        "Prefer real fault injection over reasoning. Making the failure actually happen is the difference between testing the mechanism and testing a description of it.",
      ],
    },
  ],
  exclusions:
    "Do not own whole-repository graph generation, ADR interpretation, or logging-quality assessment. Request evidence from the other agents and produce explicit handoffs.",
  deliverables: [
    "State-machine registry",
    "Lifecycle registry",
    "Transition and guard matrix",
    "Transaction and atomicity map",
    "Concurrency hazard report",
    "Failure taxonomy",
    "Retry, timeout and cancellation matrix",
    "Recovery and replay matrix",
    "Fault-injection test recommendations",
    "Ranked findings",
    "Explicit handoffs to agents 1, 2 and 4",
  ],
  concludingQuestions: [
    "Which invalid states can occur?",
    "Which operations can execute more than once?",
    "Where can partial completion leak?",
    "Which workflows cannot recover cleanly?",
    "Which retries can amplify damage?",
    "Which temporal or concurrency assumptions are unsafe?",
    "What happens when the process dies at every meaningful interruption point?",
  ],
  tools: [
    {
      invocation: "packages/arbor-governance/tests/redteam/*.test.ts",
      answers: "Whether a named attack succeeds. Each suite pairs the attack with the defence so the before/after contrast is explicit.",
      status: "available",
      limits: "Only covers attacks someone thought of. Absence of a red-team case is not evidence of safety — extend the suite rather than concluding from it.",
    },
    {
      invocation: "arbor-mcp ledger verify --dir <d> --campaign <id> --json",
      answers: "Chain continuity, external tip-sentinel completeness, and recorded sanctioned repairs, as distinct outcomes.",
      status: "available",
      limits: "Cannot detect removal of the whole evidence directory; an anchor outside the store would be required.",
    },
    {
      invocation: "Real fault injection, e.g. chmod a directory read-only to make a write genuinely fail mid-operation.",
      answers: "Whether the crash-safety ordering claim holds when the failure is real rather than mocked.",
      status: "available",
      limits: "Covers the interruption points you choose. A mocked fs proves the mock's behaviour, not the system's — prefer the real fault.",
    },
    {
      invocation: "A crash-point matrix harness that replays a workflow, killing it at each durable step in turn.",
      answers: "Systematic recovery behaviour at every interruption point rather than the handful chosen by hand.",
      status: "proposed",
      limits: "Not built in revoy2. The existing chmod-based injection is the manual precedent it would generalize.",
    },
  ],
};

const runtime: AuditArchetype = {
  id: "runtime",
  ordinal: 4,
  role: "Runtime, Data, and Evidence Auditor",
  auditing: "the codebase's observable reality",
  primaryQuestion:
    "What actually happens at runtime, where does the data go, what external effects occur, "
    + "and is there enough evidence to prove or diagnose the outcome?",
  anchors: [
    "dataflow", "data lineage", "effects", "persistence", "consistency",
    "caching", "serialization", "schemas", "resources", "performance budgets",
    "backpressure", "observability", "logs", "metrics", "traces",
    "audit records", "runtime configuration", "determinism", "versioning",
    "compatibility", "deployment behaviour", "executable evidence",
  ],
  work: [
    {
      title: "Trace data lineage",
      directives: [
        "For each important datum trace: origin -> validation -> normalization -> transformation -> persistence -> retrieval -> presentation -> downstream use -> retention/deletion.",
        "Record source, schema, trust level, sensitivity, validation, transformation, copies, serialization formats, persistence locations, cache locations, consumers, retention, deletion and provenance fields.",
        "Look for lost fields, silently defaulted fields, schema drift, nullability mismatch, precision loss, encoding mismatch, stale transformations, sensitive-data leakage, data written but never read, data read but never populated, and UI fields disconnected from canonical data.",
      ],
    },
    {
      title: "Build an effect registry",
      directives: [
        "For every significant operation record database reads/writes, filesystem reads/writes, network requests, queue publications, event emissions, process creation, cache mutation, notifications, secret access, clock access, randomness, model calls, external provider calls and logging/metrics effects.",
        "For each effect determine whether it is declared, authorized, idempotent, observable, retry-safe, versioned, compensatable, tested and properly bounded.",
        "Model calls and process creation deserve special attention: they cost money and outlive the process that started them.",
      ],
    },
    {
      title: "Audit consistency between duplicated representations",
      directives: [
        "Identify every duplicated or derived representation: database and cache; source and materialized view; backend and frontend state; event log and projections; configuration and generated artifacts; filesystem and index; local and remote state; decision record and implementation metadata.",
        "For each pair identify the authoritative source, consistency model, synchronization mechanism, staleness allowance, reconciliation mechanism, failure behaviour and observability.",
      ],
    },
    {
      title: "Audit observability",
      directives: [
        "For every critical operation determine whether an investigator can answer: did it begin; which actor initiated it; which version ran; what input was accepted; what state was observed; what decision was made; what effects were attempted; which succeeded; which failed; was a retry scheduled; what is the current state; what happens next.",
        "Inspect structured logs, correlation IDs, trace propagation, metrics, audit records, health and readiness checks, diagnostic endpoints, operator commands, error reporting and user-visible failure states.",
        "Flag observability that produces noise without reconstructability. Volume is not evidence.",
      ],
    },
    {
      title: "Audit determinism",
      directives: [
        "Identify sources of nondeterminism: time, randomness, concurrency, unordered iteration, external APIs, model inference, filesystem ordering, environment variables, unpinned dependencies, dynamic discovery, network behaviour.",
        "Construct a determinism envelope distinguishing fully deterministic; deterministic under captured inputs; nondeterministic but replayable; nondeterministic and merely observable; uncaptured and irreproducible.",
        "Locale-sensitive comparison is a specific and easily missed source: the same two records can order differently on two machines.",
      ],
    },
    {
      title: "Audit resources and budgets",
      directives: [
        "Inspect CPU, memory, disk, connections, file descriptors, threads, worker capacity, queue depth, API quotas, rate limits, token budgets, context windows, retry budgets, cache capacity and human-review requirements.",
        "For each: acquisition, accounting, limits, backpressure, fairness, release, exhaustion behaviour and leak detection.",
        "An unbounded autonomous loop against a paid provider is a resource finding, not a feature.",
      ],
    },
    {
      title: "Audit versions and compatibility",
      directives: [
        "Inspect API versions, database migrations, event schemas, configuration formats, file formats, plugin interfaces, generated artifacts, model versions, dependency pinning and rolling-deployment assumptions.",
        "Test or reason about new code reading old state, old code encountering new state, mixed-version operation, rollback after migration, event replay across versions, stale clients and partial deployment.",
      ],
    },
    {
      title: "Dynamically verify claims",
      directives: [
        "Use unit, integration, end-to-end, property, contract and mutation tests; request replay; CLI invocation; browser interaction; trace inspection; database inspection; fault injection; resource exhaustion; runtime profiling.",
        "Do not rely solely on the existing test suite. Existing tests may encode exactly the same incorrect assumptions as the implementation they cover.",
        "Where you cannot execute something, say UNVERIFIABLE and name the blocker. An unverifiable claim is a finding in itself.",
      ],
    },
  ],
  exclusions:
    "Do not own ADR interpretation, whole-system static call-graph construction, or formal state-machine extraction. Hand those off precisely when runtime evidence implicates them.",
  deliverables: [
    "Data-lineage maps",
    "Effect registry",
    "Persistence and cache consistency map",
    "Observability coverage matrix",
    "Determinism envelope",
    "Resource and budget report",
    "Version and compatibility matrix",
    "Runtime verification report",
    "Reproduction scripts or exact reproduction procedures",
    "Ranked findings",
    "Explicit handoffs to agents 1, 2 and 3",
  ],
  concludingQuestions: [
    "What does the system actually do at runtime?",
    "Which data transformations are lossy, stale or untraceable?",
    "Which external effects are hidden or unsafe?",
    "Which claims cannot be proven from available telemetry?",
    "Which failures cannot be reconstructed?",
    "Which operations cannot be reproduced?",
    "Where do runtime and source-level interpretations disagree?",
  ],
  tools: [
    {
      invocation: "arbor-mcp run --executor deterministic --once --persistence-dir <d>",
      answers: "A full campaign round trip with no network and no model spend, reproducible run to run.",
      status: "available",
      limits: "The deterministic executor does not simulate provider usage, so token/cost telemetry is genuinely absent rather than zero. Do not read the absence as a measurement.",
    },
    {
      invocation: "arbor-mcp devtools tail  /  .arbor/devtools/devtools.log",
      answers: "The externally observable event stream a run actually emitted, in order, with campaign and node ids.",
      status: "available",
      limits: "Shows what was emitted, not what was consumed. Pair with the structural lens to prove an event has a reader.",
    },
    {
      invocation: "arbor-mcp ledger verify --json  /  @arbor/audit EvidenceLedger.verifyIntegrity()",
      answers: "Whether the evidence backing a claim is continuous, complete and free of unrecorded repair.",
      status: "available",
      limits: "Verifies the chain, not the truthfulness of what was written into it.",
    },
    {
      invocation: "@arbor/mcp metrics-projector / memory-projector",
      answers: "Deterministic, integrity-gated projections derived purely from the ledger.",
      status: "available",
      limits: "Pure projections — losing one is a non-event, and a disagreement with the ledger means the projection is wrong, never the ledger.",
    },
    {
      invocation: "captest npx vitest run",
      answers: "The full suite under a memory-capped systemd scope.",
      status: "available",
      limits: "MUST be used instead of bare vitest on this workstation; uncapped runs are the main OOM risk. A killed run is not a failing test.",
    },
    {
      invocation: "A data-lineage extractor that walks a datum from origin to terminal consumer across package boundaries.",
      answers: "Field-level lineage without hand-tracing every hop.",
      status: "proposed",
      limits: "Not built in revoy2. Until it exists, lineage is hand-traced and should be reported as INFERRED unless each hop was read.",
    },
  ],
};

export const FORENSIC_FOUR: AuditFanoutTemplate = {
  id: "forensic-four",
  sourcePath: "packages/arbor-prompts/src/audit-forensic-four.ts",
  title: "Four-Agent Forensic Codebase Audit",
  summary:
    "A 1×4 fan. Four auditors traverse the entire repository through four different proofs of correctness — "
    + "legitimacy, connectivity, durability, observable reality — so that their conclusions can corroborate or falsify one another.",
  fanWidth: 4,
  sharedMission:
    "You are one member of a four-agent forensic code-audit team examining a medium-to-large software repository.\n\n"
    + "The team must determine not merely whether code exists or compiles, but whether the system is semantically justified, "
    + "structurally connected, behaviourally correct, resilient under failure and concurrency, operationally observable, "
    + "and supported by reproducible evidence.\n\n"
    + "Inspect the ENTIRE repository through your assigned lens. Do not limit yourself to a single language, directory, "
    + "service, interface or deployment tier. A team divided by directory creates gaps at exactly the boundaries where the "
    + "serious defects live.\n\n"
    + "## Reconciling repository-wide inspection with a dispatch scope\n\n"
    + "A real dispatch of this template commonly scopes each agent to one package or directory (a `--scope` argument, "
    + "a caller-imposed brief). That scope does not contradict the instruction above; it divides two different verbs:\n\n"
    + "    READ broadly.       Follow call graphs, dependency edges, package boundaries and consumers wherever they\n"
    + "                        lead, across the whole repository, for context — the same way you would if unscoped.\n"
    + "    ORIGINATE narrowly. Findings, deliverables and handoffs you author belong to your assigned scope only.\n\n"
    + "A defect you notice outside your assigned scope while reading for context is not yours to report as a finding. "
    + "Note it as an observation and route it as a handoff to whichever sibling's scope actually owns it (see Handoff "
    + "protocol) — do not silently expand your deliverables to cover it, and do not silently drop it either.",
  completenessRule:
    "Do not describe a feature as implemented merely because a function exists, a route is declared, a component renders, "
    + "a test is present, a type is defined, documentation claims it, or an endpoint returns a placeholder success.\n\n"
    + "A feature is complete only when its round trip is evidenced:\n\n"
    + "    intent -> interface -> dispatch -> implementation -> effects -> persistence -> consumption -> surfaced outcome",
  coverageRule:
    "Several deliverables below ask for whole-repository registries. Against a repository of this size you will not "
    + "enumerate everything AND observe everything you claim. Choosing breadth or depth is legitimate; hiding which one "
    + "you chose is not.\n\n"
    + "Label every deliverable with exactly one coverage mode, and say how you know:\n\n"
    + "    Caller/callee registry — SAMPLED (31 of ~240 exported symbols; every symbol crossing a package boundary,\n"
    + "    selected mechanically by grep, plus the 6 the reachability gate reports as waived)\n\n"
    + "The same vocabulary also labels individual required rows inside a deliverable, not only the deliverable as a "
    + "whole — the shared work sections below enumerate items (interruption points, effect categories, boundary "
    + "checks) that will not all exist in every assigned scope:\n\n"
    + "    network partition — NOT_APPLICABLE (this component makes no network calls; there is nothing to interrupt)\n\n"
    + "Reach for NOT_APPLICABLE only when the item genuinely does not exist on your component's actual surface — it "
    + "was never in budget because there was nothing there, not because you ran out of budget. Reach for "
    + "NOT_ATTEMPTED when the item does exist and you did not get to it: blocked, or out of budget. Conflating the "
    + "two hides which gaps are real.\n\n"
    + "An unlabelled registry is read as CLAIMED_ONLY however long it is, and a registry labelled EXHAUSTIVE without a "
    + "stated basis for that claim is a finding against you. Prefer a SAMPLED deliverable whose claims are observed to "
    + "an exhaustive-LOOKING one whose claims are inferred: a complete-seeming registry built by reading names is the "
    + "unwitnessed claim this audit exists to catch, produced by its own auditor.\n\n"
    + "This is the synthesis rule — systemic defects over raw finding count — stated where the trade-off is actually "
    + "made, which is while the work is done and not when it is merged.",
  distinctionsRequired: [
    "Absence of evidence versus evidence of absence",
    "Intentional incompleteness versus accidental incompleteness",
    "Dead code versus dormant but reachable code",
    "Feature-flagged code versus partially wired code",
    "Mock, fixture, scaffold or demonstration code versus production implementation",
  ],
  findingFormat: [
    "finding_id:", "title:", "severity:", "confidence:", "evidence_status:", "",
    "component:", "locations:", "governing_artifacts:", "",
    "expected:", "observed:", "discrepancy:", "",
    "impact:", "failure_scenario:", "reproduction:", "",
    "responsible_boundary:", "likely_root_cause:", "",
    "recommended_remediation:", "verification_required:", "",
    "handoff_to:", "related_findings:",
  ].join("\n"),
  handoffProtocol:
    "Do not silently expand into another agent's domain. When an issue crosses a boundary, emit a structured handoff:\n\n"
    + "    handoff_id:\n    from_agent:\n    to_agent:\n    triggering_finding:\n    question_to_resolve:\n"
    + "    known_evidence:\n    required_evidence:\n    affected_components:\n    urgency:\n\n"
    + "The four agents in this fan run CONCURRENTLY. You cannot see any sibling's output while you work, and no "
    + "sibling can see yours — there is no point during dispatch at which corroboration from the receiving agent "
    + "could exist. A handoff has two distinct steps that happen at two distinct times: it is RAISED by you, now, "
    + "during dispatch; it is RESOLVED later, in synthesis, once every agent's findings exist to compare against "
    + "one another. Recording a handoff's resolution as unresolved/open at dispatch time is correct compliance with "
    + "this protocol, not a gap in your audit — do not fabricate a sibling's corroboration or contradiction to make "
    + "a handoff look closed before synthesis has actually happened.",
  synthesisInstruction:
    "After the individual audits, merge findings BY SYSTEM BEHAVIOUR rather than by agent. For every major subsystem "
    + "synthesize: intended purpose, governing decision, contract, authority and ownership, caller topology, state and "
    + "lifecycle, dataflow and effects, failure and recovery behaviour, runtime evidence, verification status.\n\n"
    + "Resolve conflicting conclusions explicitly — a conflict between two lenses is a finding, not a rounding error. "
    + "Assign every component exactly one final classification, and prioritise systemic defects and broken chains over raw finding count.",
  archetypes: [constitutional, structural, resilience, runtime],
};
