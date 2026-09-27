import { createHash, timingSafeEqual } from "node:crypto";

export type ServiceBearerVerification =
  | { readonly ok: true; readonly developmentBypass?: boolean }
  | {
      readonly ok: false;
      readonly reason: "missing" | "malformed" | "invalid" | "not_configured";
      readonly statusCode: 401 | 503;
    };

type ParsedBearerAuthorization =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "bearer"; readonly token: string };

export function extractBearerToken(
  authorization: string | string[] | undefined,
): string | undefined {
  const parsed = parseBearerAuthorization(authorization);
  return parsed.kind === "bearer" ? parsed.token : undefined;
}

export function verifyServiceBearerAuthorization(
  authorization: string | string[] | undefined,
  configuredToken: string,
  environment = "production",
): ServiceBearerVerification {
  if (configuredToken.length === 0) {
    return environment.toLowerCase() === "production"
      ? { ok: false, reason: "not_configured", statusCode: 503 }
      : { ok: true, developmentBypass: true };
  }

  const parsed = parseBearerAuthorization(authorization);
  if (parsed.kind === "missing") {
    return { ok: false, reason: "missing", statusCode: 401 };
  }
  if (parsed.kind === "malformed") {
    return { ok: false, reason: "malformed", statusCode: 401 };
  }
  if (!constantTimeStringEqual(parsed.token, configuredToken)) {
    return { ok: false, reason: "invalid", statusCode: 401 };
  }
  return { ok: true };
}

function parseBearerAuthorization(
  authorization: string | string[] | undefined,
): ParsedBearerAuthorization {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (header === undefined) return { kind: "missing" };
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    return { kind: "malformed" };
  }
  return { kind: "bearer", token: parts[1] ?? "" };
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
