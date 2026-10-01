import type { FastifyInstance, FastifyReply } from "fastify";
import {
  parseOrchestrationPolicy,
  ORCHESTRATION_DECISION_PURPOSE,
} from "@soulstream/wire-schema/card-orchestration";
import {
  requireAdmin,
  type AdminAccessProvider,
} from "../admin/admin_access.js";
import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import {
  CardOrchestrationSettingsError,
  type OrchestrationSettings,
} from "./card_orchestration_settings.js";
export type CardOrchestrationRouteOptions = AdminAccessProvider & {
  get(): Promise<OrchestrationSettings>;
  put(input: {
    policy: unknown;
    expectedVersion: number;
    updatedBy: string;
  }): Promise<OrchestrationSettings>;
  authBearerToken: string;
  environment?: string;
  resolveCaller(
    sessionId: string,
  ): Promise<{ ownerEmail: string; purpose?: string | null } | null>;
  validateFolder(id: string, ownerEmail: string): Promise<boolean>;
  readStatus?(): Promise<unknown>;
};
export const cardOrchestrationRouteAuthRequirements = {
  "GET /api/settings/card-orchestration": true,
  "PUT /api/settings/card-orchestration": true,
  "POST /api/card-orchestration/host/:operation": false,
} as const;
export function registerCardOrchestrationRoutes(
  app: FastifyInstance,
  options: CardOrchestrationRouteOptions,
): void {
  const read = async () => ({
    settings: await options.get(),
    ...(options.readStatus ? { status: await options.readStatus() } : {}),
  });
  const write = async (body: unknown, email: string) => {
    try {
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new TypeError("body must be an object");
      const input = body as Record<string, unknown>,
        policy = parseOrchestrationPolicy(input.policy);
      for (const id of [policy.sessionFolderId, policy.systemFolderParentId])
        if (id !== null && !(await options.validateFolder(id, email)))
          throw new TypeError(
            "Explicit folder is missing, archived or inaccessible",
          );
      const settings = await options.put({
        policy,
        expectedVersion: input.expectedVersion as number,
        updatedBy: email,
      });
      return {
        settings,
        ...(options.readStatus ? { status: await options.readStatus() } : {}),
      };
    } catch (error) {
      if (error instanceof TypeError)
        throw new CardOrchestrationSettingsError(
          422,
          "CARD_ORCHESTRATION_INVALID",
          error.message,
        );
      throw error;
    }
  };
  for (const method of ["GET", "PUT"] as const)
    app.route({
      method,
      url: "/api/settings/card-orchestration",
      handler: async (request, reply) => {
        const email = await requireAdmin(request, reply, options);
        if (!email) return reply;
        try {
          return method === "GET"
            ? await read()
            : await write(request.body, email);
        } catch (error) {
          return handleError(reply, error);
        }
      },
    });
  app.post<{ Params: { operation: string } }>(
    "/api/card-orchestration/host/:operation",
    async (request, reply) => {
      const auth = verifyServiceBearerAuthorization(
        request.headers.authorization,
        options.authBearerToken,
        options.environment,
      );
      if (!auth.ok)
        return reply
          .code(auth.statusCode)
          .send({ detail: "Service authentication required" });
      if (!["get", "update"].includes(request.params.operation))
        return reply.code(404).send({ detail: "Unknown policy operation" });
      const body = request.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof body.callerSessionId !== "string" ||
        !body.callerSessionId.trim()
      )
        return reply
          .code(403)
          .send({ detail: "Persisted caller session required" });
      const caller = await options.resolveCaller(body.callerSessionId);
      const email = caller?.ownerEmail?.trim().toLowerCase();
      if (
        !caller ||
        !email ||
        caller.purpose === ORCHESTRATION_DECISION_PURPOSE ||
        !(await options.isAdminEmail(email))
      )
        return reply
          .code(403)
          .send({ detail: "Verified administrator session required" });
      try {
        return request.params.operation === "get"
          ? await read()
          : await write(body, email);
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );
}
function handleError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof CardOrchestrationSettingsError)) throw error;
  return reply
    .code(error.statusCode)
    .send({ detail: { error: { code: error.code, message: error.message } } });
}
