import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { NodeCredentialResolver, NodePrincipal } from "../node_credentials/types.js";

export type NodeWsAuthInput = {
  readonly environment: string;
  readonly configuredToken: string;
  readonly nodeCredentials: NodeCredentialResolver | null;
  readonly authorization: string | string[] | undefined;
};

export type NodeWsAuthResult =
  | { readonly ok: true; readonly principal?: NodePrincipal }
  | {
      readonly ok: false;
      readonly statusCode: 401 | 403 | 503;
      readonly detail: string;
    };

export function verifyNodeWsBearer(input: NodeWsAuthInput): NodeWsAuthResult {
  const verification = verifyServiceBearerAuthorization(
    input.authorization,
    {
      configuredToken: input.configuredToken,
      environment: input.environment,
      nodeCredentials: input.nodeCredentials,
    },
  );
  if (verification.ok) {
    return verification.principal === undefined
      ? { ok: true }
      : { ok: true, principal: verification.principal };
  }
  if (verification.reason === "not_configured") {
    return {
      ok: false,
      statusCode: 503,
      detail: "Service authentication is not configured",
    };
  }
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
    statusCode: 401,
    detail: "Invalid token",
  };
}
