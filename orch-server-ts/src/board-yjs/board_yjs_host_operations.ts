import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { BoardYjsService } from "./board_yjs_service.js";

export interface BoardYjsHostOperationOptions {
  service: BoardYjsService;
  authBearerToken: string;
}

const containerSchema = z.object({
  containerKind: z.enum(["folder", "runbook"]),
  containerId: z.string().min(1),
});

const scopeSchema = z.object({
  folderId: z.string().min(1),
  containerKind: z.enum(["folder", "runbook"]),
  containerId: z.string().min(1),
});

const rawBoardItemSchema = z.object({
  id: z.string().min(1),
  folderId: z.string().min(1),
  containerKind: z.enum(["folder", "runbook"]).nullable().optional(),
  containerId: z.string().nullable().optional(),
  membershipKind: z.enum(["primary", "reference"]).nullable().optional(),
  sourceRunbookItemId: z.string().nullable().optional(),
  itemType: z.enum([
    "session",
    "markdown",
    "subfolder",
    "asset",
    "frame",
    "runbook",
    "custom_view",
  ]),
  itemId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const boardItemSchema = rawBoardItemSchema.transform((item) => {
  const {
    containerKind,
    containerId,
    membershipKind,
    sourceRunbookItemId,
    metadata,
    ...rest
  } = item;
  return {
    ...rest,
    ...(containerKind ? { containerKind } : {}),
    ...(containerId ? { containerId } : {}),
    ...(membershipKind ? { membershipKind } : {}),
    sourceRunbookItemId: sourceRunbookItemId ?? null,
    metadata: metadata ?? {},
  };
});

const schemas = {
  "create-markdown-document": z.object({
    folderId: z.string().min(1),
    container: containerSchema.optional(),
    title: z.string(),
    body: z.string(),
    x: z.number(),
    y: z.number(),
    documentId: z.string().min(1),
  }),
  "upsert-session-board-item": z.object({
    folderId: z.string().min(1),
    container: containerSchema,
    sessionId: z.string().min(1),
    x: z.number(),
    y: z.number(),
    sourceRunbookItemId: z.string().nullable().optional(),
  }),
  "upsert-runbook-board-item": z.object({
    folderId: z.string().min(1),
    boardItemId: z.string().min(1),
    runbookId: z.string().min(1),
    title: z.string(),
    x: z.number(),
    y: z.number(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  "upsert-custom-view-board-item": z.object({
    folderId: z.string().min(1),
    container: containerSchema,
    boardItemId: z.string().min(1),
    customViewId: z.string().min(1),
    title: z.string(),
    html: z.string(),
    revision: z.number().int(),
    x: z.number(),
    y: z.number(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  "remove-runbook-board-item": z.object({
    folderId: z.string().min(1),
    boardItemId: z.string().min(1),
  }),
  "remove-board-item": z.object({
    container: containerSchema,
    boardItemId: z.string().min(1),
  }),
  "update-board-item-position": z.object({
    container: containerSchema,
    boardItemId: z.string().min(1),
    x: z.number(),
    y: z.number(),
  }),
  "move-board-item-to-container": z.object({
    boardItem: boardItemSchema,
    targetScope: scopeSchema,
    position: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
  "update-markdown-document": z.object({
    container: containerSchema,
    documentId: z.string().min(1),
    fields: z.object({
      title: z.string().optional(),
      body: z.string().optional(),
      expectedVersion: z.number().int().positive(),
    }),
  }),
  "delete-markdown-document": z.object({
    container: containerSchema,
    documentId: z.string().min(1),
  }),
} as const;

export async function handleBoardYjsHostOperation(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: string,
  options: BoardYjsHostOperationOptions,
): Promise<FastifyReply> {
  const schema = schemas[operation as keyof typeof schemas];
  if (schema === undefined) {
    return reply.status(404).send({
      detail: {
        error: {
          code: "BOARD_YJS_HOST_OPERATION_NOT_FOUND",
          message: `Unknown Board Yjs host operation: ${operation}`,
        },
      },
    });
  }

  const authorization = verifyServiceBearerAuthorization(
    request.headers.authorization,
    options.authBearerToken,
  );
  if (!authorization.ok) {
    return reply.status(401).send({
      detail: {
        error: {
          code: "UNAUTHORIZED",
          message: `Board Yjs host bearer token is ${authorization.reason}`,
        },
      },
    });
  }

  const parsed = schema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.status(422).send({
      detail: {
        error: {
          code: "INVALID_BOARD_YJS_HOST_REQUEST",
          message: parsed.error.message,
        },
      },
    });
  }

  try {
    return reply.send(await dispatchBoardYjsHostOperation(
      operation,
      parsed.data,
      options.service,
    ));
  } catch (error) {
    request.log.error({ err: error, operation }, "Board Yjs host operation failed");
    return reply.status(500).send({
      detail: {
        error: {
          code: "BOARD_YJS_HOST_OPERATION_FAILED",
          message: error instanceof Error ? error.message : "Board Yjs host operation failed",
        },
      },
    });
  }
}

async function dispatchBoardYjsHostOperation(
  operation: string,
  input: unknown,
  service: BoardYjsService,
): Promise<unknown> {
  switch (operation) {
    case "create-markdown-document":
      return await service.createMarkdownDocument(
        input as z.infer<typeof schemas["create-markdown-document"]>,
      );
    case "upsert-session-board-item":
      return await service.upsertSessionBoardItem(
        input as z.infer<typeof schemas["upsert-session-board-item"]>,
      );
    case "upsert-runbook-board-item":
      return await service.upsertRunbookBoardItem(
        input as z.infer<typeof schemas["upsert-runbook-board-item"]>,
      );
    case "upsert-custom-view-board-item":
      return await service.upsertCustomViewBoardItem(
        input as z.infer<typeof schemas["upsert-custom-view-board-item"]>,
      );
    case "remove-runbook-board-item": {
      const value = input as z.infer<typeof schemas["remove-runbook-board-item"]>;
      await service.removeRunbookBoardItem(value.folderId, value.boardItemId);
      return { ok: true };
    }
    case "remove-board-item": {
      const value = input as z.infer<typeof schemas["remove-board-item"]>;
      await service.removeBoardItem(value.container, value.boardItemId);
      return { ok: true };
    }
    case "update-board-item-position": {
      const value = input as z.infer<typeof schemas["update-board-item-position"]>;
      await service.updateBoardItemPosition(
        value.container,
        value.boardItemId,
        value.x,
        value.y,
      );
      return { ok: true };
    }
    case "move-board-item-to-container":
      return await service.moveBoardItemToContainer(
        input as z.infer<typeof schemas["move-board-item-to-container"]>,
      );
    case "update-markdown-document": {
      const value = input as z.infer<typeof schemas["update-markdown-document"]>;
      return await service.updateMarkdownDocument(
        value.container,
        value.documentId,
        value.fields,
      );
    }
    case "delete-markdown-document": {
      const value = input as z.infer<typeof schemas["delete-markdown-document"]>;
      await service.deleteMarkdownDocument(value.container, value.documentId);
      return { ok: true };
    }
    default:
      throw new Error(`Unknown Board Yjs host operation: ${operation}`);
  }
}
