import { randomUUID } from "node:crypto";
import { constantTimeStringEqual } from "@soulstream/mcp-contract";
import { WebhookError, type WebhookPost } from "../external_events/webhook_transport.js";
import { standardWebhookHeaders } from "./standard_webhook_signature.js";

export type VerificationChallengeOptions = {
  post: WebhookPost;
  url: string;
  secret: string;
  /** Epoch milliseconds; defaults to the current time. */
  now?: () => number;
  /** Headers carried alongside the Standard Webhooks signature (external events adds its subscription id). */
  extraHeaders?: Record<string, string>;
};

/**
 * Sends the Standard Webhooks-signed registration challenge and requires the
 * receiver to echo the same challenge from a 2xx response. A WebhookError from
 * the transport keeps its reason so management routes can report it; every
 * other failure surfaces as verification_failed.
 */
export async function sendVerificationChallenge(
  options: VerificationChallengeOptions,
): Promise<void> {
  const challenge = randomUUID();
  const body = JSON.stringify({ type: "verification", challenge });
  const headers: Record<string, string> = {
    ...standardWebhookHeaders({
      secret: options.secret,
      webhookId: `verification_${randomUUID()}`,
      body,
      ...(options.now === undefined ? {} : { now: options.now() }),
    }),
    ...options.extraHeaders,
  };

  let response: Awaited<ReturnType<WebhookPost>>;
  try {
    response = await options.post(options.url, body, headers);
  } catch (error) {
    if (error instanceof WebhookError) throw error;
    throw new WebhookError("verification_failed");
  }

  let echo: unknown;
  try {
    echo = JSON.parse(response.body);
  } catch {
    throw new WebhookError("verification_failed");
  }
  if (
    response.status < 200 || response.status >= 300 ||
    echo === null || typeof echo !== "object" ||
    !("challenge" in echo) || typeof echo.challenge !== "string" ||
    !constantTimeStringEqual(challenge, echo.challenge)
  ) {
    throw new WebhookError("verification_failed");
  }
}
