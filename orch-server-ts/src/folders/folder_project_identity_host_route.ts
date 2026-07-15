import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { PageMutationActor } from "../page/page_mutation_core.js";
import type { FolderProjectIdentityService } from "./folder_project_identity_service.js";

export interface FolderProjectIdentityHostRouteOptions {
  service: Pick<
    FolderProjectIdentityService,
    "create" | "mutateFromFolder" | "backfillLegacyFolder"
  >;
  authBearerToken: string;
}

const id = z.string().trim().min(1);
const actorFields = {
  actor_kind: z.enum(["agent", "user", "system"]),
  actor_session_id: id.nullable().optional(),
  actor_user_id: id.nullable().optional(),
  idempotency_key: id,
  reason: z.string().nullable().optional(),
};
const schemas = {
  create: z.object({
    name: id,
    sort_order: z.number().int().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    parent_folder_id: id.nullable().optional(),
    ...actorFields,
  }),
  update: z.object({
    folder_id: id,
    name: id,
    sort_order: z.number().int().nullable().optional(),
    settings: z.record(z.string(), z.unknown()).nullable().optional(),
    parent_folder_id: id.nullable().optional(),
    ...actorFields,
  }),
  archive: z.object({ folder_id: id, ...actorFields }),
  unarchive: z.object({ folder_id: id, ...actorFields }),
  "backfill-legacy": z.object({
    folder_id: id,
    page_id: id.optional(),
    ...actorFields,
  }),
} as const;

export function registerFolderProjectIdentityHostRoute(
  app: FastifyInstance,
  options: FolderProjectIdentityHostRouteOptions,
): void {
  app.post<{ Params: { operation: string } }>(
    "/api/folder-project-identities/host/:operation",
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
      if (!schema) return errorReply(reply, 404, "OPERATION_NOT_FOUND", `unknown operation: ${operation}`);
      const parsed = schema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return errorReply(reply, 422, "INVALID_FOLDER_PROJECT_REQUEST", parsed.error.message);
      }
      const values = parsed.data as Record<string, unknown>;
      const actor = toActor(values);
      if ((actor.actorKind === "agent" && !actor.actorSessionId)
        || (actor.actorKind === "user" && !actor.actorUserId)) {
        return errorReply(reply, 422, "INVALID_FOLDER_PROJECT_ACTOR", "actor provenance is required");
      }
      const common = {
        actor,
        idempotencyKey: values.idempotency_key as string,
        reason: values.reason as string | null | undefined,
      };
      try {
        if (operation === "create") {
          return reply.send(await options.service.create({
            name: values.name as string,
            sortOrder: values.sort_order as number | undefined,
            settings: values.settings as Record<string, unknown> | undefined,
            parentFolderId: values.parent_folder_id as string | null | undefined,
            ...common,
          }));
        }
        if (operation === "backfill-legacy") {
          return reply.send(await options.service.backfillLegacyFolder({
            folderId: values.folder_id as string,
            existingPageId: values.page_id as string | undefined,
            ...common,
          }));
        }
        return reply.send(await options.service.mutateFromFolder({
          folderId: values.folder_id as string,
          ...(operation === "update"
            ? { update: {
                name: values.name as string,
                ...(Object.hasOwn(values, "sort_order")
                  ? { sortOrder: values.sort_order as number | null }
                  : {}),
                ...(Object.hasOwn(values, "settings")
                  ? { settings: values.settings as Record<string, unknown> | null }
                  : {}),
                ...(Object.hasOwn(values, "parent_folder_id")
                  ? { parentFolderId: values.parent_folder_id as string | null }
                  : {}),
              } }
            : { archived: operation === "archive" }),
          ...common,
        }));
      } catch (error) {
        request.log.error({ err: error, operation }, "Folder project identity host operation failed");
        return errorReply(
          reply,
          conflictStatus(error),
          "FOLDER_PROJECT_OPERATION_FAILED",
          error instanceof Error ? error.message : "Folder project operation failed",
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
  return /conflict|already|mapping changed|not found/.test(error.message) ? 409 : 500;
}

function errorReply(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ detail: { error: { code, message } } });
}
