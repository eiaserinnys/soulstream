import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { BoardYjsService } from "./board_yjs_service.js";
import {
  dispatchBoardProjectionHostOperation,
  getBoardProjectionHostOperationSchema,
  isBoardProjectionHostOperation,
} from "./board_projection_host_operations.js";
import {
  CustomViewRevisionConflictError,
  type BoardProjectionHost,
} from "./board_projection_types.js";
import { BOARD_ITEM_TYPES } from "@soulstream/wire-schema";
const boardItemTypeInputSchema = z.enum(BOARD_ITEM_TYPES);

export interface BoardYjsHostOperationOptions {
  service: BoardYjsService;
  projectionHost?: BoardProjectionHost;
  authBearerToken: string;
  environment?: string;
}


const scopeSchema = z.object({
  folderId: z.string().min(1),
});

const rawBoardItemSchema = z.object({
  id: z.string().min(1),
  folderId: z.string().min(1),
  membershipKind: z.enum(["primary", "reference"]).nullable().optional(),
  itemType: boardItemTypeInputSchema,
  itemId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const boardItemSchema = rawBoardItemSchema.transform((item) => {
  const {
    membershipKind,
    metadata,
    ...rest
  } = item;
  return {
    ...rest,
    ...(membershipKind ? { membershipKind } : {}),
    metadata: metadata ?? {},
  };
});

const schemas = {
  "create-markdown-document": z.object({
    folderId: z.string().min(1),
    title: z.string(),
    body: z.string(),
    x: z.number(),
    y: z.number(),
    documentId: z.string().min(1),
  }),
  "upsert-session-board-item": z.object({
    folderId: z.string().min(1),
    sessionId: z.string().min(1),
    x: z.number(),
    y: z.number(),
  }),
  "move-session-to-folder": z.object({
    sessionId: z.string().min(1),
    folderId: z.string().min(1).nullable(),
  }),
  "upsert-custom-view-board-item": z.object({
    folderId: z.string().min(1),
    boardItemId: z.string().min(1),
    customViewId: z.string().min(1),
    title: z.string(),
    html: z.string(),
    revision: z.number().int(),
    x: z.number(),
    y: z.number(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  "remove-board-item": z.object({
    folderId: z.string().min(1),
    boardItemId: z.string().min(1),
  }),
  "update-board-item-position": z.object({
    folderId: z.string().min(1),
    boardItemId: z.string().min(1),
    x: z.number(),
    y: z.number(),
  }),
  "move-board-item-to-folder": z.object({
    boardItem: boardItemSchema,
    folderId: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    idempotencyKey: z.string().min(1).optional(),
  }),
  "update-markdown-document": z.object({
    folderId: z.string().min(1),
    documentId: z.string().min(1),
    fields: z.object({
      title: z.string().optional(),
      body: z.string().optional(),
      expectedVersion: z.number().int().positive(),
    }),
  }),
  "delete-markdown-document": z.object({
    folderId: z.string().min(1),
    documentId: z.string().min(1),
  }),
} as const;

export function getBoardYjsHostOperationSchema(operation: string): z.ZodType | undefined {
  return schemas[operation as keyof typeof schemas] ?? getBoardProjectionHostOperationSchema(operation);
}

export async function handleBoardYjsHostOperation(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: string,
  options: BoardYjsHostOperationOptions,
): Promise<FastifyReply> {
  const schema = getBoardYjsHostOperationSchema(operation);
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
    options.environment,
  );
  if (!authorization.ok) {
    return reply.status(authorization.statusCode).send({
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
      options,
    ));
  } catch (error) {
    if (error instanceof CustomViewRevisionConflictError) {
      return reply.status(409).send({
        detail: {
          error: {
            code: "CUSTOM_VIEW_REVISION_CONFLICT",
            message: error.message,
            customViewId: error.customViewId,
            expectedRevision: error.expectedRevision,
            actualRevision: error.actualRevision,
          },
        },
      });
    }
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

export async function dispatchBoardYjsHostOperation(
  operation: string,
  input: unknown,
  options: BoardYjsHostOperationOptions,
): Promise<unknown> {
  if (isBoardProjectionHostOperation(operation)) {
    if (!options.projectionHost) {
      throw new Error("Orchestrator board projection host is required");
    }
    return await dispatchBoardProjectionHostOperation(
      operation,
      input,
      options.projectionHost,
    );
  }
  const service = options.service;
  switch (operation) {
    case "create-markdown-document":
      return await service.createMarkdownDocument(
        input as z.infer<typeof schemas["create-markdown-document"]>,
      );
    case "upsert-session-board-item":
      return await service.upsertSessionBoardItem(
        input as z.infer<typeof schemas["upsert-session-board-item"]>,
      );
    case "move-session-to-folder": {
      const value = input as z.infer<typeof schemas["move-session-to-folder"]>;
      return await service.moveSessionToFolder(value.sessionId, value.folderId);
    }
    case "upsert-custom-view-board-item":
      return await service.upsertCustomViewBoardItem(
        input as z.infer<typeof schemas["upsert-custom-view-board-item"]>,
      );
    case "remove-board-item": {
      const value = input as z.infer<typeof schemas["remove-board-item"]>;
      await service.removeBoardItem({ folderId: value.folderId }, value.boardItemId);
      return { ok: true };
    }
    case "update-board-item-position": {
      const value = input as z.infer<typeof schemas["update-board-item-position"]>;
      await service.updateBoardItemPosition(
        { folderId: value.folderId },
        value.boardItemId,
        value.x,
        value.y,
      );
      return { ok: true };
    }
    case "move-board-item-to-folder":
      { const value = input as z.infer<typeof schemas["move-board-item-to-folder"]>;
        return await service.moveBoardItemToContainer({ ...value, targetScope: { folderId: value.folderId } }); }
    case "update-markdown-document": {
      const value = input as z.infer<typeof schemas["update-markdown-document"]>;
      return await service.updateMarkdownDocument(
        { folderId: value.folderId },
        value.documentId,
        value.fields,
      );
    }
    case "delete-markdown-document": {
      const value = input as z.infer<typeof schemas["delete-markdown-document"]>;
      await service.deleteMarkdownDocument({ folderId: value.folderId }, value.documentId);
      return { ok: true };
    }
    default:
      throw new Error(`Unknown Board Yjs host operation: ${operation}`);
  }
}
