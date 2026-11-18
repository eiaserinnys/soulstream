import { createHmac, timingSafeEqual } from "node:crypto";

import { Webhook } from "standardwebhooks";

export type PreviousSigningSecret = { secret: string; until: number };

export type StandardWebhookHeaderInput = {
  secret: string;
  webhookId: string;
  body: string;
  previousSecret?: PreviousSigningSecret;
  /** Epoch milliseconds; defaults to the current time. */
  now?: number;
};

/**
 * Standard Webhooks headers shared by every outbound delivery path. The
 * previous secret is signed only while its rotation window is open.
 */
export function standardWebhookHeaders(
  input: StandardWebhookHeaderInput,
): Record<string, string> {
  const now = input.now ?? Date.now();
  const signedAt = new Date(now);
  const signatures = [new Webhook(input.secret).sign(input.webhookId, signedAt, input.body)];
  if (input.previousSecret !== undefined && input.previousSecret.until > now) {
    signatures.push(
      new Webhook(input.previousSecret.secret).sign(input.webhookId, signedAt, input.body),
    );
  }
  return {
    "Content-Type": "application/json",
    "webhook-id": input.webhookId,
    "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
    "webhook-signature": signatures.join(" "),
  };
}

/** Standard Webhooks tolerance: five minutes on either side of the clock. */
export const STANDARD_WEBHOOK_TOLERANCE_SECONDS = 300;
const WEBHOOK_ID_MAX_LENGTH = 200;
const WEBHOOK_SECRET_PREFIX = "whsec_";

export type StandardWebhookVerificationFailure =
  | "missing_headers"
  | "invalid_header"
  | "timestamp_out_of_tolerance"
  | "signature_mismatch";

export type StandardWebhookVerificationResult =
  | { ok: true }
  | { ok: false; reason: StandardWebhookVerificationFailure };

export interface VerifyStandardWebhookSignatureInput {
  /** `whsec_` followed by the base64 signing key. */
  secret: string;
  /** Request headers; names are matched case-insensitively. */
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The received body bytes exactly as they arrived. */
  rawBody: Buffer;
  /** Epoch seconds; defaults to the wall clock. */
  now?: number;
}

/**
 * Verifies a Standard Webhooks signature against the raw received bytes.
 *
 * The `standardwebhooks` package is the signer but its `verify` turns a Buffer
 * into a string before signing again, so arbitrary bytes would not verify. Here
 * the signed content is the `id.timestamp.` prefix followed by the exact body
 * bytes, and any one of the space-separated `v1,<base64>` signatures may match.
 */
export function verifyStandardWebhookSignature(
  input: VerifyStandardWebhookSignatureInput,
): StandardWebhookVerificationResult {
  const headers = normalizeHeaders(input.headers);
  const webhookId = singleHeader(headers["webhook-id"]);
  const timestampHeader = singleHeader(headers["webhook-timestamp"]);
  const signatureHeader = joinedHeader(headers["webhook-signature"]);
  if (webhookId === undefined || timestampHeader === undefined
    || signatureHeader === undefined) {
    return { ok: false, reason: "missing_headers" };
  }
  if (webhookId.trim().length === 0 || webhookId.length > WEBHOOK_ID_MAX_LENGTH) {
    return { ok: false, reason: "invalid_header" };
  }
  if (!/^[0-9]+$/.test(timestampHeader)) {
    return { ok: false, reason: "invalid_header" };
  }
  const timestamp = Number(timestampHeader);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > STANDARD_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  const key = decodeSigningSecret(input.secret);
  if (key === null) return { ok: false, reason: "signature_mismatch" };
  const expected = createHmac("sha256", key)
    .update(Buffer.concat([
      Buffer.from(`${webhookId}.${timestampHeader}.`, "utf8"),
      input.rawBody,
    ]))
    .digest();
  for (const candidate of signatureHeader.split(" ")) {
    const separator = candidate.indexOf(",");
    if (separator < 0 || candidate.slice(0, separator) !== "v1") continue;
    const provided = Buffer.from(candidate.slice(separator + 1), "base64");
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}

function normalizeHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | string[] | undefined> {
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function joinedHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 0 ? undefined : value.join(" ");
  return value;
}

function decodeSigningSecret(secret: string): Buffer | null {
  const encoded = secret.startsWith(WEBHOOK_SECRET_PREFIX)
    ? secret.slice(WEBHOOK_SECRET_PREFIX.length)
    : secret;
  if (encoded.length === 0) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length === 0 ? null : key;
}
