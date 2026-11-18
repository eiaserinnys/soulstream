import { randomBytes } from "node:crypto";

/**
 * Standard Webhooks signing secret shared by outbound subscriptions (#1458)
 * and inbound webhook grants (#1458). The value stays in the grant or
 * subscription row because both directions need the original for HMAC.
 */
export function generateSigningSecret(): string {
  return "whsec_" + randomBytes(32).toString("base64");
}
