import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";

export type NodeWsAuthInput = {
  readonly environment: string;
  readonly configuredToken: string;
  readonly authorization: string | string[] | undefined;
};

export type NodeWsAuthResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly statusCode: 401 | 403 | 503;
      readonly detail: string;
    };

export function verifyNodeWsBearer(input: NodeWsAuthInput): NodeWsAuthResult {
  if (input.configuredToken.length === 0) {
    if (input.environment.toLowerCase() !== "production") return { ok: true };
    return {
      ok: false,
      statusCode: 503,
      detail: "Node WebSocket authentication is not configured",
    };
  }

  const verification = verifyServiceBearerAuthorization(
    input.authorization,
    input.configuredToken,
  );
  if (verification.ok) return { ok: true };
  if (verification.reason === "missing") {
    return {
      ok: false,
      statusCode: 401,
      detail: "Authorization header is required",
    };
  }
  if (verification.reason === "malformed") {
    return {
      ok: false,
      statusCode: 401,
      detail: "Bearer token format is invalid",
    };
  }
  return {
    ok: false,
    statusCode: 403,
    detail: "Invalid token",
  };
}
