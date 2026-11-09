import { describe, expect, it } from "vitest";

import { signAwsSigV4Request, AwsSigV4Error } from "../src/aws-sigv4.js";

/**
 * Vectors transcribed verbatim from AWS's own SigV4 conformance test suite,
 * fetched 2026-08-26 from `gems/aws-sigv4/spec/suite/` in the official
 * `aws/aws-sdk-ruby` repository (AWS's canonical archive of the suite after
 * the original standalone `aws4_testsuite.zip` was retired from
 * docs.aws.amazon.com) -- the same fixtures that repo's own `Signer` spec
 * (`suite_spec.rb`) asserts against, using the well-known `AKIDEXAMPLE` /
 * `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY` documentation credential pair.
 * Each case asserts the canonical request, the string-to-sign, and the
 * final `Authorization` header byte-for-byte against the suite's
 * `.creq`/`.sts`/`.authz` fixtures -- never network, never a live AWS call.
 */
const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const DATE = new Date("2015-08-30T12:36:00Z");
const REGION = "us-east-1";
const SERVICE = "service";

describe("signAwsSigV4Request against AWS's published test-suite vectors", () => {
  it("matches get-vanilla: a bare GET with only host/date signed", () => {
    const signed = signAwsSigV4Request(
      { method: "GET", url: "https://example.amazonaws.com/", region: REGION, service: SERVICE, date: DATE },
      { access_key_id: ACCESS_KEY_ID, secret_access_key: SECRET_ACCESS_KEY },
    );
    expect(signed.canonical_request).toBe(
      "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(signed.string_to_sign).toBe(
      "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
    );
    expect(signed.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(signed.headers.host).toBe("example.amazonaws.com");
    expect(signed.headers["x-amz-date"]).toBe("20150830T123600Z");
  });

  it("matches post-vanilla: an empty-body POST", () => {
    const signed = signAwsSigV4Request(
      { method: "POST", url: "https://example.amazonaws.com/", region: REGION, service: SERVICE, date: DATE, body: "" },
      { access_key_id: ACCESS_KEY_ID, secret_access_key: SECRET_ACCESS_KEY },
    );
    expect(signed.canonical_request).toBe(
      "POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(signed.string_to_sign).toBe(
      "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n553f88c9e4d10fc9e109e2aeb65f030801b70c2f6468faca261d401ae622fc87",
    );
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    );
  });

  it("matches get-vanilla-query-order-key-case: query params are encoded, sorted, and joined", () => {
    const signed = signAwsSigV4Request(
      { method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1", region: REGION, service: SERVICE, date: DATE },
      { access_key_id: ACCESS_KEY_ID, secret_access_key: SECRET_ACCESS_KEY },
    );
    expect(signed.canonical_request).toBe(
      "GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(signed.string_to_sign).toBe(
      "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0",
    );
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  it("signs a real Bedrock-shaped request with a JSON body and a session token", () => {
    const body = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    const signed = signAwsSigV4Request(
      {
        method: "POST",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke-with-response-stream",
        region: "us-east-1",
        service: "bedrock",
        date: DATE,
        headers: { "content-type": "application/json" },
        body,
      },
      { access_key_id: ACCESS_KEY_ID, secret_access_key: SECRET_ACCESS_KEY, session_token: "session-token-example" },
    );
    expect(signed.headers["x-amz-security-token"]).toBe("session-token-example");
    expect(signed.headers.authorization).toContain("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token");
    expect(signed.canonical_request.split("\n")[1]).toBe("/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke-with-response-stream");
    // Deterministic against itself: re-signing identical input yields an identical signature.
    const resigned = signAwsSigV4Request(
      { method: "POST", url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke-with-response-stream", region: "us-east-1", service: "bedrock", date: DATE, headers: { "content-type": "application/json" }, body },
      { access_key_id: ACCESS_KEY_ID, secret_access_key: SECRET_ACCESS_KEY, session_token: "session-token-example" },
    );
    expect(resigned.signature).toBe(signed.signature);
  });

  it("rejects an empty credential rather than signing with a blank key", () => {
    expect(() => signAwsSigV4Request(
      { method: "GET", url: "https://example.amazonaws.com/", region: REGION, service: SERVICE, date: DATE },
      { access_key_id: "", secret_access_key: SECRET_ACCESS_KEY },
    )).toThrow(AwsSigV4Error);
  });
});
