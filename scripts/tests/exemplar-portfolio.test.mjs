import { describe, expect, it } from "vitest";
import { assertPortfolioContract } from "../exemplar-portfolio.mjs";

const hash = `sha256:${"a".repeat(64)}`;
const entry = (id, claimCount) => ({ id, source_manifest_sha256: hash, claim_count: claimCount, verified: true, href: `../../${id}/index.html`, media: `../../${id}/trailer.webm` });

describe("commercial exemplar portfolio contract", () => {
  it("accepts the complete evidence-bound package sequence", () => {
    expect(() => assertPortfolioContract({ artifact_kind: "commercial_exemplar_portfolio", all_packages_verified: true, total_verified_claims: 36, packages: [entry("flight-control", 8), entry("self-host", 11), entry("webui", 8), entry("generalist", 9)] })).not.toThrow();
  });

  it("rejects missing claims and absolute publication links", () => {
    const catalog = { artifact_kind: "commercial_exemplar_portfolio", all_packages_verified: true, total_verified_claims: 35, packages: [entry("flight-control", 8), entry("self-host", 10), entry("webui", 8), entry("generalist", 9)] };
    expect(() => assertPortfolioContract(catalog)).toThrow(/complete verified claim set/);
    catalog.total_verified_claims = 36;
    catalog.packages[2].media = "/tmp/trailer.webm";
    expect(() => assertPortfolioContract(catalog)).toThrow(/portable relative links/);
  });
});
