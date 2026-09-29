import { z } from "zod";

import { BOARD_ITEM_TYPES } from "@soulstream/wire-schema";
const boardItemTypeInputSchema = z.enum(BOARD_ITEM_TYPES);
import type { BoardProjectionHost } from "./board_projection_types.js";

const folderScopeSchema = z.object({ folderId: z.string().min(1) }).strict();

const actorKindSchema = z.enum(["agent", "user", "system", "llm"]);

const schemas = {
  "get-board-items": z.object({}),
  "get-board-items-by-folder": z.object({
    folderId: z.string().min(1),
  }),
  "get-board-item": z.object({ boardItemId: z.string().min(1) }),
  "get-primary-session-board-item": z.object({ sessionId: z.string().min(1) }),
  "get-markdown-document-board-item": z.object({ documentId: z.string().min(1) }),
  "get-board-item-ids-for-session": z.object({ sessionId: z.string().min(1) }),
  "list-folder-items": z.object({
    folderId: z.string().min(1),
    query: z.string().nullable(),
    includeArchived: z.boolean(),
    itemTypes: z.array(boardItemTypeInputSchema).nullable(),
    limit: z.number().int().positive(),
    cursor: z.number().int().nonnegative(),
    scanLimit: z.number().int().positive().nullable().optional(),
  }),
  "resolve-board-yjs-folder-scope": folderScopeSchema,
  "get-markdown-document": z.object({ documentId: z.string().min(1) }),
  "get-custom-view": z.object({ customViewId: z.string().min(1) }),
  "list-custom-views": z.object({
    folderId: z.string().min(1),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
  }),
  "create-custom-view-record": z.object({
    id: z.string().min(1),
    boardItemId: z.string().min(1),
    title: z.string(),
    html: z.string(),
    actorKind: actorKindSchema,
    actorSessionId: z.string().nullable(),
    idempotencyKey: z.string().min(1),
  }),
  "patch-custom-view-record": z.object({
    customViewId: z.string().min(1),
    boardItemId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    html: z.string(),
    title: z.string().nullable().optional(),
    actorKind: actorKindSchema,
    actorSessionId: z.string().nullable(),
    idempotencyKey: z.string().min(1),
  }),
} as const;

export function getBoardProjectionHostOperationSchema(
  operation: string,
): z.ZodType | undefined {
  return schemas[operation as keyof typeof schemas]?.strict();
}

export function isBoardProjectionHostOperation(operation: string): boolean {
  return operation in schemas;
}

export async function dispatchBoardProjectionHostOperation(
  operation: string,
  input: unknown,
  host: BoardProjectionHost,
): Promise<unknown> {
  switch (operation) {
    case "get-board-items":
      return await host.getBoardItems();
    case "get-board-items-by-folder": {
      const value = input as z.infer<typeof schemas["get-board-items-by-folder"]>;
      return await host.getBoardItemsByFolder(value.folderId);
    }
    case "get-board-item":
      return await host.getBoardItemById(
        (input as z.infer<typeof schemas["get-board-item"]>).boardItemId,
      );
    case "get-primary-session-board-item":
      return await host.getPrimarySessionBoardItem(
        (input as z.infer<typeof schemas["get-primary-session-board-item"]>).sessionId,
      );
    case "get-markdown-document-board-item":
      return await host.getMarkdownDocumentBoardItem(
        (input as z.infer<typeof schemas["get-markdown-document-board-item"]>).documentId,
      );
    case "get-board-item-ids-for-session":
      return await host.getBoardItemIdsForSession(
        (input as z.infer<typeof schemas["get-board-item-ids-for-session"]>).sessionId,
      );
    case "list-folder-items":
      return await host.listFolderItems(
        input as z.infer<typeof schemas["list-folder-items"]>,
      );
    case "resolve-board-yjs-folder-scope":
      return await host.resolveBoardYjsFolderScope(
        (input as z.infer<typeof schemas["resolve-board-yjs-folder-scope"]>),
      );
    case "get-markdown-document":
      return await host.getMarkdownDocument(
        (input as z.infer<typeof schemas["get-markdown-document"]>).documentId,
      );
    case "get-custom-view":
      return await host.getCustomView(
        (input as z.infer<typeof schemas["get-custom-view"]>).customViewId,
      );
    case "list-custom-views":
      return await host.listCustomViews(
        input as z.infer<typeof schemas["list-custom-views"]>,
      );
    case "create-custom-view-record":
      return await host.createCustomViewRecord(
        input as z.infer<typeof schemas["create-custom-view-record"]>,
      );
    case "patch-custom-view-record":
      return await host.patchCustomViewRecord(
        input as z.infer<typeof schemas["patch-custom-view-record"]>,
      );
    default:
      throw new Error(`Unknown board projection host operation: ${operation}`);
  }
}
