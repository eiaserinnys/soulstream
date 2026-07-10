import { createHash, timingSafeEqual } from "node:crypto";

export type ServiceBearerVerification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "missing" | "malformed" | "invalid";
    };

export function verifyServiceBearerAuthorization(
  authorization: string | string[] | undefined,
  configuredToken: string,
): ServiceBearerVerification {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (header === undefined) return { ok: false, reason: "missing" };

  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    return { ok: false, reason: "malformed" };
  }
  if (!constantTimeStringEqual(parts[1] ?? "", configuredToken)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
