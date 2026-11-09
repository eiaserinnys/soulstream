import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { NodeCredentialResolver } from "../node_credentials/types.js";
const identitySchema = z
  .object({
    sessionId: z.uuid(),
    runId: z.uuid(),
    executionToken: z.uuid(),
    nodeId: z.string().trim().min(1),
  })
  .strict();
const workerIdentitySchema = identitySchema
  .extend({ cardId: z.uuid() })
  .strict();
type ExecutionIdentity = z.infer<typeof identitySchema>;
export type CardOrchestrationDecisionRouteOptions = {
  authBearerToken: string;
  environment?: string;
  nodeCredentials: NodeCredentialResolver | null;
  authorizeDecision(input: ExecutionIdentity): Promise<boolean>;
  authorizeWorker(
    input: ExecutionIdentity & { cardId: string },
  ): Promise<boolean>;
};
export const cardOrchestrationDecisionRouteAuthRequirements = {
  "POST /api/card-orchestration/decision/authorize": false,
  "POST /api/card-orchestration/worker/authorize": false,
} as const;
/** Node-only one-shot claims. Queue mutation and decision submission are not exposed here. */
export function registerCardOrchestrationDecisionRoutes(
  app: FastifyInstance,
  options: CardOrchestrationDecisionRouteOptions,
) {
  const registerClaim = <T extends ExecutionIdentity>(
    path: string,
    schema: z.ZodType<T>,
    authorize: (input: T) => Promise<boolean>,
  ) => {
    app.post(path, async (request, reply) => {
      const auth = verifyServiceBearerAuthorization(
        request.headers.authorization,
        {
          configuredToken: options.authBearerToken,
          environment: options.environment,
          nodeCredentials: options.nodeCredentials,
        },
      );
      if (!auth.ok)
        return reply
          .code(auth.statusCode)
          .send({ detail: "Service authentication required" });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(422)
          .send({
            detail: {
              error: {
                code: "CARD_ORCHESTRATION_IDENTITY_INVALID",
                message: "Exact execution identity is required",
              },
            },
          });
      return { allowed: await authorize(parsed.data) };
    });
  };
  registerClaim(
    "/api/card-orchestration/decision/authorize",
    identitySchema,
    options.authorizeDecision,
  );
  registerClaim(
    "/api/card-orchestration/worker/authorize",
    workerIdentitySchema,
    options.authorizeWorker,
  );
}
