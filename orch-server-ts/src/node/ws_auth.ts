import {
  serviceBearerFailure,
  verifyServiceBearerAuthorization,
} from "../auth/service_bearer.js";
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
  if (!verification.ok) return serviceBearerFailure(verification);
  return verification.principal === undefined
    ? { ok: true }
    : { ok: true, principal: verification.principal };
}
