/**
 * card #1457 — the per-grant token bucket caps send and read bursts and reports
 * Retry-After seconds instead of silently dropping calls.
 */
import { describe, expect, it } from "vitest";

import { ExternalAccessTokenBucket } from
  "../src/external_access/external_access_token_bucket.js";

describe("ExternalAccessTokenBucket", () => {
  it("caps a burst per grant key and refills over time", () => {
    let now = 0;
    const bucket = new ExternalAccessTokenBucket({ now: () => now });

    for (let index = 0; index < 30; index += 1) {
      expect(bucket.take("send:grant-a", 30)).toEqual({ allowed: true });
    }
    expect(bucket.take("send:grant-a", 30)).toEqual({
      allowed: false,
      retryAfterSeconds: 2,
    });
    // 다른 grant는 자기 버킷을 가진다.
    expect(bucket.take("send:grant-b", 30)).toEqual({ allowed: true });

    now += 2_000;
    expect(bucket.take("send:grant-a", 30)).toEqual({ allowed: true });
  });
});
