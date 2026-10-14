import { describe, expect, it } from "vitest";

import { canonicalRequest, signCanonical } from "../src/partner-client.js";
import { issuerModules } from "./helpers/issuer.js";

describe("partner request signature", () => {
  it("matches the service's canonical request and HMAC", async () => {
    const { signing } = await issuerModules();
    const body = Buffer.from(JSON.stringify({ admitted: [170, 484] }), "utf8");
    const material = { method: "put", path: "/v1/assets/84532001/jurisdictions", timestamp: "1797000000", nonce: "abcdef0123456789", body };
    const mine = canonicalRequest(material.method, material.path, material.timestamp, material.nonce, body);
    expect(mine).toBe(signing.canonicalRequest(material));
    expect(signCanonical("partner-secret", mine)).toBe(signing.signRequest("partner-secret", material));
  });

  it("signs an empty body for a request without one", async () => {
    const { signing } = await issuerModules();
    const material = { method: "GET", path: "/v1/access-log?limit=5", timestamp: "1797000000", nonce: "abcdef0123456789", body: Buffer.alloc(0) };
    expect(signCanonical("s", canonicalRequest("GET", material.path, material.timestamp, material.nonce, Buffer.alloc(0)))).toBe(
      signing.signRequest("s", material),
    );
  });
});
