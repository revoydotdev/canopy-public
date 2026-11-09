import { describe, expect, it } from "vitest";
import { evaluateRepoFlightProfile, REPO_FLIGHT_PROVIDERS, type RepoFlightProfileInput } from "../src/repo-flight-profile.js";

const providerFacts = () => ({ launch_interceptor: true, identity_enrollment: true, mutation_interceptor: true });
function enforced(overrides: Partial<RepoFlightProfileInput> = {}): RepoFlightProfileInput {
  return {
    schema_version: 1,
    repository_id: `repo:v1:${"a".repeat(64)}`,
    required_providers: [...REPO_FLIGHT_PROVIDERS],
    providers: { claude: providerFacts(), codex: providerFacts(), opencode: providerFacts(), native: providerFacts() },
    controls: {
      stores: { authority: true, enrollment: true, lifecycle: true },
      canonical_shared_checkout: "mechanical_read_only",
      unmanaged_sessions_present: false,
      raw_shell_mutation_interceptor: true,
      gate_broker: true,
      effect_interceptor: true,
      approval_closure: true,
      a2a_receipt_adapter: true,
      adoption_fencing: true,
    },
    federation: { enabled: false, authenticated: false, fenced: false },
    ...overrides,
  };
}

describe("repository flight-control deployment truth", () => {
  it("derives enforced only when every required production control is mechanically present", () => {
    const one = evaluateRepoFlightProfile(enforced()), two = evaluateRepoFlightProfile(enforced({ required_providers: ["native", "claude", "codex", "opencode"] }));
    expect(one.status).toBe("enforced");
    expect(one.missing_controls).toEqual([]);
    expect(one.provider_coverage).toEqual(REPO_FLIGHT_PROVIDERS.map((provider) => ({ provider, required: true, launch_interceptor: true, identity_enrollment: true, mutation_interceptor: true, fully_intercepted: true })));
    expect(one.profile_digest).toBe(two.profile_digest);
  });

  it.each(REPO_FLIGHT_PROVIDERS)("requires mutation interception for the %s provider", (provider) => {
    const input = enforced(), providers = { ...input.providers, [provider]: { ...input.providers[provider], mutation_interceptor: false } };
    const profile = evaluateRepoFlightProfile({ ...input, providers });
    expect(profile.status).toBe("cooperative");
    expect(profile.missing_controls).toEqual([{ control: `provider.${provider}.mutation`, remediation: `Route every ${provider} repository mutation through the effect interceptor.` }]);
    expect(profile.provider_coverage.find((item) => item.provider === provider)).toMatchObject({ required: true, fully_intercepted: false });
  });

  it("prevents enforced truth when a raw shell or unmanaged writer can mutate the repository", () => {
    const input = enforced({ controls: { ...enforced().controls, canonical_shared_checkout: "advisory", unmanaged_sessions_present: true, raw_shell_mutation_interceptor: false } });
    const profile = evaluateRepoFlightProfile(input);
    expect(profile.status).toBe("cooperative");
    expect(profile.missing_controls).toEqual([
      { control: "checkout.shared_read_only", remediation: "Mechanically make the canonical shared checkout read-only to governed workers." },
      { control: "session.unmanaged", remediation: "Enroll, drain, or terminate every unmanaged repository-writing session." },
      { control: "shell.raw_mutation_interceptor", remediation: "Route raw-shell repository mutations through an enforcing interceptor." },
    ]);
  });

  it("distinguishes observable-but-unadmitted providers from degraded durable observation", () => {
    const missingAdmission = enforced({ providers: { claude: { ...providerFacts(), launch_interceptor: false }, codex: providerFacts(), opencode: providerFacts(), native: providerFacts() } });
    expect(evaluateRepoFlightProfile(missingAdmission)).toMatchObject({ status: "observed_only", missing_controls: [{ control: "provider.claude.launch", remediation: "Install the claude launch admission interceptor." }] });
    const missingStore = enforced({ controls: { ...enforced().controls, stores: { authority: true, enrollment: false, lifecycle: true } } });
    expect(evaluateRepoFlightProfile(missingStore)).toMatchObject({ status: "degraded", missing_controls: [{ control: "store.enrollment", remediation: "Configure the durable process-enrollment store." }] });
  });

  it("keeps federation optional but degrades an enabled, unauthenticated or unfenced federation", () => {
    const repoLocal: Record<string, unknown> = { ...enforced() }; delete repoLocal.federation;
    expect(evaluateRepoFlightProfile(repoLocal).status).toBe("enforced");
    const profile = evaluateRepoFlightProfile({ ...enforced(), federation: { enabled: true, authenticated: false, fenced: false } });
    expect(profile.status).toBe("degraded");
    expect(profile.missing_controls).toEqual([
      { control: "federation.authenticated", remediation: "Authenticate every enabled federation peer and delegation chain." },
      { control: "federation.fenced", remediation: "Require repository-local fencing for every federated effect." },
    ]);
  });

  it("rejects caller-supplied status, unknown providers, duplicate requirements, and non-boolean facts", () => {
    expect(() => evaluateRepoFlightProfile({ ...enforced(), status: "enforced" })).toThrow(/unknown or missing/);
    expect(() => evaluateRepoFlightProfile({ ...enforced(), required_providers: ["codex", "codex"] })).toThrow(/unique/);
    expect(() => evaluateRepoFlightProfile({ ...enforced(), required_providers: ["unknown"] })).toThrow(/closed provider/);
    const providers = { ...enforced().providers, claude: { ...providerFacts(), mutation_interceptor: "yes" } };
    expect(() => evaluateRepoFlightProfile({ ...enforced(), providers })).toThrow(/must be boolean/);
    const extraProvider = { ...enforced().providers, other: providerFacts() };
    expect(() => evaluateRepoFlightProfile({ ...enforced(), providers: extraProvider })).toThrow(/unknown or missing/);
  });

  it("ignores non-required provider gaps without hiding their coverage", () => {
    const input = enforced({ required_providers: ["codex"], providers: { ...enforced().providers, claude: { launch_interceptor: false, identity_enrollment: false, mutation_interceptor: false } } });
    const profile = evaluateRepoFlightProfile(input);
    expect(profile.status).toBe("enforced");
    expect(profile.missing_controls).toEqual([]);
    expect(profile.provider_coverage.find((item) => item.provider === "claude")).toMatchObject({ required: false, fully_intercepted: false });
  });
});
