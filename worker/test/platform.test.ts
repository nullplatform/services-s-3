import { describe, expect, test } from "bun:test";
import { createPlatform, matchesSpecification } from "../src/platform";

describe("platform", () => {
  test("matches specification slugs exactly or by prefix", () => {
    expect(matchesSpecification("aws-s3-bucket", ["aws-s3-bucket"])).toBe(true);
    expect(matchesSpecification("aws-s3-bucket-agent-k8s", ["aws-s3-bucket"])).toBe(false);
    expect(matchesSpecification("aws-s3-bucket-agent-k8s", ["aws-s3-bucket*"])).toBe(true);
    expect(matchesSpecification(undefined, ["aws-s3-bucket*"])).toBe(false);
  });

  test("exchanges the API key once and caches service reads", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ id: "svc-1", specification_id: "spec-s3" }), { status: 200 });
    }) as typeof fetch;
    const client = createPlatform({ apiUrl: "https://api.test", apiKey: "k", fetchImpl });
    await client.getService("svc-1");
    await client.getService("svc-1");
    expect(seen).toEqual(["POST https://api.test/token", "GET https://api.test/service/svc-1"]);
  });
});
