/**
 * card #1458 — inbound webhook signature verification over the raw received
 * bytes. The standardwebhooks package canonicalizes a Buffer payload through a
 * string, so the verifier builds the HMAC itself; the package stays the signer
 * and the compatibility oracle for UTF-8 payloads.
 */
import { createHmac } from "node:crypto";

import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";

import { verifyStandardWebhookSignature } from
  "../src/webhooks/standard_webhook_signature.js";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const OTHER_SECRET = `whsec_${Buffer.from("another-signing-secret").toString("base64")}`;
const NOW_SECONDS = 1_766_000_000;
const WEBHOOK_ID = "msg_inbound_1";

function signedAt(seconds: number): Date {
  return new Date(seconds * 1000);
}

function signWithPackage(
  secret: string,
  body: string,
  seconds: number = NOW_SECONDS,
  id: string = WEBHOOK_ID,
): string {
  return new Webhook(secret).sign(id, signedAt(seconds), body);
}

/** The same HMAC the verifier must compute, over arbitrary raw bytes. */
function signRaw(
  body: Buffer,
  seconds: number = NOW_SECONDS,
  id: string = WEBHOOK_ID,
  secret: string = SECRET,
): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const mac = createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${id}.${seconds}.`, "utf8"), body]))
    .digest("base64");
  return `v1,${mac}`;
}

function verifyWith(headers: Record<string, string | string[] | undefined>, rawBody: Buffer) {
  return verifyStandardWebhookSignature({
    secret: SECRET,
    headers,
    rawBody,
    now: NOW_SECONDS,
  });
}

function verifySigned(
  signature: string,
  rawBody: Buffer,
  overrides: Record<string, string | string[] | undefined> = {},
) {
  return verifyWith({
    "webhook-id": WEBHOOK_ID,
    "webhook-timestamp": String(NOW_SECONDS),
    "webhook-signature": signature,
    ...overrides,
  }, rawBody);
}

describe("verifyStandardWebhookSignature", () => {
  it("accepts standardwebhooks signatures over UTF-8 bodies with spaces, newlines and reordered keys", () => {
    const bodies = [
      "{\"a\": 1,\n  \"b\": \"x y\"}",
      "{\"b\":\"x y\",\"a\":1}",
      "한글 본문\n둘째 줄\t탭",
      "plain text/plain body with trailing space ",
    ];
    for (const body of bodies) {
      const result = verifySigned(signWithPackage(SECRET, body), Buffer.from(body, "utf8"));
      expect(result, body).toEqual({ ok: true });
    }
  });

  it("verifies the HMAC over non-UTF-8 bytes and fails when one byte changes", () => {
    const raw = Buffer.from([0x7b, 0xff, 0x00, 0x80, 0x0a, 0xfe, 0x7d]);
    expect(verifySigned(signRaw(raw), raw)).toEqual({ ok: true });

    const mutated = Buffer.from(raw);
    mutated[1] = mutated[1]! ^ 0x01;
    expect(verifySigned(signRaw(raw), mutated)).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("accepts 299 seconds of clock skew and rejects 301 in both directions", () => {
    const body = Buffer.from("{\"text\":\"시각\"}", "utf8");
    for (const offset of [0, -299, 299]) {
      const seconds = NOW_SECONDS + offset;
      const result = verifySigned(signRaw(body, seconds), body, {
        "webhook-timestamp": String(seconds),
      });
      expect(result, `offset ${offset}`).toEqual({ ok: true });
    }
    for (const offset of [-301, 301]) {
      const seconds = NOW_SECONDS + offset;
      const result = verifySigned(signRaw(body, seconds), body, {
        "webhook-timestamp": String(seconds),
      });
      expect(result, `offset ${offset}`).toEqual({
        ok: false,
        reason: "timestamp_out_of_tolerance",
      });
    }
  });

  it("passes when any one of several signatures matches", () => {
    const body = Buffer.from("{\"text\":\"여럿\"}", "utf8");
    const good = signWithPackage(SECRET, body.toString("utf8"));
    const wrong = signWithPackage(OTHER_SECRET, body.toString("utf8"));
    expect(verifySigned(`${wrong} ${good}`, body)).toEqual({ ok: true });
    expect(verifySigned(`${good} ${wrong}`, body)).toEqual({ ok: true });
    expect(verifySigned(wrong, body)).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects malformed or missing headers", () => {
    const body = Buffer.from("{}", "utf8");
    const signature = signWithPackage(SECRET, "{}");
    const cases: Array<{
      name: string;
      headers: Record<string, string | string[] | undefined>;
      reason: string;
    }> = [
      {
        name: "missing id",
        headers: { "webhook-timestamp": String(NOW_SECONDS), "webhook-signature": signature },
        reason: "missing_headers",
      },
      {
        name: "blank id",
        headers: {
          "webhook-id": "   ",
          "webhook-timestamp": String(NOW_SECONDS),
          "webhook-signature": signature,
        },
        reason: "invalid_header",
      },
      {
        name: "id over 200 characters",
        headers: {
          "webhook-id": "a".repeat(201),
          "webhook-timestamp": String(NOW_SECONDS),
          "webhook-signature": signature,
        },
        reason: "invalid_header",
      },
      {
        name: "missing timestamp",
        headers: { "webhook-id": WEBHOOK_ID, "webhook-signature": signature },
        reason: "missing_headers",
      },
      {
        name: "non-numeric timestamp",
        headers: {
          "webhook-id": WEBHOOK_ID,
          "webhook-timestamp": "soon",
          "webhook-signature": signature,
        },
        reason: "invalid_header",
      },
      {
        name: "negative timestamp",
        headers: {
          "webhook-id": WEBHOOK_ID,
          "webhook-timestamp": "-1",
          "webhook-signature": signature,
        },
        reason: "invalid_header",
      },
      {
        name: "missing signature",
        headers: { "webhook-id": WEBHOOK_ID, "webhook-timestamp": String(NOW_SECONDS) },
        reason: "missing_headers",
      },
      {
        name: "unknown signature version",
        headers: {
          "webhook-id": WEBHOOK_ID,
          "webhook-timestamp": String(NOW_SECONDS),
          "webhook-signature": signature.replace(/^v1,/, "v0,"),
        },
        reason: "signature_mismatch",
      },
    ];
    for (const testCase of cases) {
      expect(verifyWith(testCase.headers, body), testCase.name).toEqual({
        ok: false,
        reason: testCase.reason,
      });
    }
  });

  it("accepts a 200-character webhook id signed over the same value", () => {
    const id = "b".repeat(200);
    const body = Buffer.from("{\"text\":\"긴 id\"}", "utf8");
    const result = verifyWith({
      "webhook-id": id,
      "webhook-timestamp": String(NOW_SECONDS),
      "webhook-signature": signRaw(body, NOW_SECONDS, id),
    }, body);
    expect(result).toEqual({ ok: true });
  });

  it("normalizes header names to lowercase and tolerates array header values", () => {
    const body = Buffer.from("{\"text\":\"배열 헤더\"}", "utf8");
    const signature = signWithPackage(SECRET, body.toString("utf8"));
    const result = verifyStandardWebhookSignature({
      secret: SECRET,
      headers: {
        "Webhook-Id": WEBHOOK_ID,
        "webhook-timestamp": [String(NOW_SECONDS), String(NOW_SECONDS)],
        "webhook-signature": signature,
      },
      rawBody: body,
      now: NOW_SECONDS,
    });
    expect(result).toEqual({ ok: true });
  });
});
