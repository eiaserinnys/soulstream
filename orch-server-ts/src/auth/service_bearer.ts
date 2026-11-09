import { createHash, timingSafeEqual } from "node:crypto";

import type { NodeCredentialResolver, NodePrincipal } from "../node_credentials/types.js";

export type ServiceBearerVerification =
  | {
      readonly ok: true;
      readonly developmentBypass?: boolean;
      readonly principal?: NodePrincipal;
    }
  | {
      readonly ok: false;
      readonly reason: "missing" | "malformed" | "invalid" | "not_configured";
      readonly statusCode: 401 | 503;
    };

export type ServiceBearerOptions = {
  readonly configuredToken: string;
  readonly environment?: string;
  /**
   * Node pairing credentials. `null` is explicit in tests and non-production
   * composition; production always passes the initialized credential store.
   */
  readonly nodeCredentials: NodeCredentialResolver | null;
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
  options: ServiceBearerOptions,
): ServiceBearerVerification {
  const environment = options.environment ?? "production";
  if (options.configuredToken.length === 0) {
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
  if (constantTimeStringEqual(parsed.token, options.configuredToken)) {
    return { ok: true };
  }
  const principal = options.nodeCredentials?.resolve(parsed.token) ?? null;
  if (principal !== null) {
    return { ok: true, principal };
  }
  return { ok: false, reason: "invalid", statusCode: 401 };
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
