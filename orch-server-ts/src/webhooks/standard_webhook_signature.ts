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
