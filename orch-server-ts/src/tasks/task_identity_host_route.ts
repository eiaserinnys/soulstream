import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { parseInitialTaskContextWire } from "@soulstream/page-model";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { PageMutationActor } from "../page/page_mutation_core.js";
import type { TaskIdentityService } from "./task_identity_service.js";

export interface TaskIdentityHostRouteOptions {
  service: Pick<
    TaskIdentityService,
    "create" | "promoteExistingPage" | "mutateFromTask" | "backfillLegacyTask"
  >;
  authBearerToken: string;
}

const id = z.string().trim().min(1);
const uuid = z.string().uuid();
const actorFields = {
  actor_kind: z.enum(["agent", "user", "system"]),
  actor_session_id: id.nullable().optional(),
  actor_user_id: id.nullable().optional(),
};
const mutationFields = {
  ...actorFields,
  idempotency_key: id,
  reason: z.string().nullable().optional(),
};
const schemas = {
  create: z.object({
    title: id,
    description: z.string().optional(),
    folder_id: id,
    task_id: uuid.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    initial_context: z.unknown().optional(),
    ...mutationFields,
  }),
  "promote-page": z.object({
    page_id: id,
    folder_id: id,
    title: id,
    x: z.number().optional(),
    y: z.number().optional(),
    ...mutationFields,
  }),
  "backfill-legacy": z.object({
    task_id: id,
    page_id: id.optional(),
    ...mutationFields,
  }),
  update: z.object({
    task_id: id,
    expected_version: z.number().int().positive(),
    title: id,
    ...mutationFields,
  }),
  archive: z.object({
    task_id: id,
    expected_version: z.number().int().positive(),
    ...mutationFields,
  }),
  unarchive: z.object({
    task_id: id,
    expected_version: z.number().int().positive(),
    ...mutationFields,
  }),
} as const;

export function registerTaskIdentityHostRoute(
  app: FastifyInstance,
  options: TaskIdentityHostRouteOptions,
): void {
  app.post<{ Params: { operation: string } }>(
    "/api/task-identities/host/:operation",
    async (request, reply) => {
      const authorization = verifyServiceBearerAuthorization(
        request.headers.authorization,
        options.authBearerToken,
      );
      if (!authorization.ok) {
        return errorReply(reply, 401, "UNAUTHORIZED", `bearer token is ${authorization.reason}`);
      }
      const operation = request.params.operation as keyof typeof schemas;
      const schema = schemas[operation];
      if (!schema) {
        return errorReply(reply, 404, "TASK_IDENTITY_OPERATION_NOT_FOUND", `unknown operation: ${operation}`);
      }
      const parsed = schema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return errorReply(reply, 422, "INVALID_TASK_IDENTITY_REQUEST", parsed.error.message);
      }
      const actor = toActor(parsed.data);
      if ((actor.actorKind === "agent" && !actor.actorSessionId)
        || (actor.actorKind === "user" && !actor.actorUserId)) {
        return errorReply(reply, 422, "INVALID_TASK_IDENTITY_ACTOR", "actor provenance is required");
      }
      try {
        const input = parsed.data as Record<string, unknown>;
        const common = {
          actor,
          idempotencyKey: input.idempotency_key as string,
        };
        if (operation === "create") {
          const initialContext = parseInitialTaskContextWire(input.initial_context);
          if (!initialContext.ok) {
            return errorReply(reply, 422, "INVALID_TASK_IDENTITY_REQUEST", initialContext.error);
          }
          return reply.send(await options.service.create({
            title: input.title as string,
            description: input.description as string | undefined,
            folderId: input.folder_id as string,
            taskId: input.task_id as string | undefined,
            x: input.x as number | undefined,
            y: input.y as number | undefined,
            ...(initialContext.value ? { initialContext: initialContext.value } : {}),
            ...common,
          }));
        }
        if (operation === "promote-page") {
          return reply.send(await options.service.promoteExistingPage({
            pageId: input.page_id as string,
            folderId: input.folder_id as string,
            title: input.title as string,
            x: input.x as number | undefined,
            y: input.y as number | undefined,
            ...common,
          }));
        }
        if (operation === "backfill-legacy") {
          return reply.send(await options.service.backfillLegacyTask({
            taskId: input.task_id as string,
            existingPageId: input.page_id as string | undefined,
            ...common,
          }));
        }
        return reply.send(await options.service.mutateFromTask({
          taskId: input.task_id as string,
          expectedVersion: input.expected_version as number,
          ...(operation === "update"
            ? { title: input.title as string }
            : { archived: operation === "archive" }),
          reason: input.reason as string | null | undefined,
          ...common,
        }));
      } catch (error) {
        request.log.error({ err: error, operation }, "Task identity host operation failed");
        return errorReply(
          reply,
          conflictStatus(error),
          "TASK_IDENTITY_OPERATION_FAILED",
          error instanceof Error ? error.message : "Task identity operation failed",
        );
      }
    },
  );
}

function toActor(input: Record<string, unknown>): PageMutationActor {
  return {
    actorKind: input.actor_kind as PageMutationActor["actorKind"],
    actorSessionId: input.actor_session_id as string | null | undefined,
    actorUserId: input.actor_user_id as string | null | undefined,
  };
}

function conflictStatus(error: unknown): number {
  if (!(error instanceof Error)) return 500;
  return error.message.includes("version conflict")
      || error.message.includes("already")
      || error.message.includes("mapping changed")
    ? 409
    : 500;
}

function errorReply(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ detail: { error: { code, message } } });
}
