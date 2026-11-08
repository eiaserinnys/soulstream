import { z } from "zod";

import { BOARD_ITEM_TYPES } from "@soulstream/wire-schema";
const boardItemTypeInputSchema = z.enum(BOARD_ITEM_TYPES);
import type { FlatFolderContentHost } from "./flat_folder_content_host.js";

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

export function getFlatReadOperationSchema(
  operation: string,
): z.ZodType | undefined {
  return schemas[operation as keyof typeof schemas]?.strict();
}

export function isFlatReadOperation(operation: string): boolean {
  return operation in schemas;
}

export async function dispatchFlatReadOperation(
  operation: string,
  input: unknown,
  host: FlatFolderContentHost,
): Promise<unknown> {
  switch (operation) {
    case "get-board-items":
      return await host.reads.getBoardItems();
    case "get-board-items-by-folder": {
      const value = input as z.infer<typeof schemas["get-board-items-by-folder"]>;
      return await host.reads.getBoardItemsByFolder(value.folderId);
    }
    case "get-board-item":
      return await host.reads.getBoardItemById(
        (input as z.infer<typeof schemas["get-board-item"]>).boardItemId,
      );
    case "get-primary-session-board-item":
      return await host.reads.getPrimarySessionBoardItem(
        (input as z.infer<typeof schemas["get-primary-session-board-item"]>).sessionId,
      );
    case "get-markdown-document-board-item":
      return await host.reads.getMarkdownDocumentBoardItem(
        (input as z.infer<typeof schemas["get-markdown-document-board-item"]>).documentId,
      );
    case "get-board-item-ids-for-session":
      return await host.reads.getBoardItemIdsForSession(
        (input as z.infer<typeof schemas["get-board-item-ids-for-session"]>).sessionId,
      );
    case "list-folder-items":
      return await host.reads.listFolderItems(
        input as z.infer<typeof schemas["list-folder-items"]>,
      );
    case "get-markdown-document":
      return await host.reads.getMarkdownDocument(
        (input as z.infer<typeof schemas["get-markdown-document"]>).documentId,
      );
    case "get-custom-view":
      return await host.customViews.getCustomView(
        (input as z.infer<typeof schemas["get-custom-view"]>).customViewId,
      );
    case "list-custom-views":
      return await host.customViews.listCustomViews(
        input as z.infer<typeof schemas["list-custom-views"]>,
      );
    case "create-custom-view-record":
      return await host.customViews.createCustomViewRecord(
        input as z.infer<typeof schemas["create-custom-view-record"]>,
      );
    case "patch-custom-view-record":
      return await host.customViews.patchCustomViewRecord(
        input as z.infer<typeof schemas["patch-custom-view-record"]>,
      );
    default:
      throw new Error(`Unknown board projection host operation: ${operation}`);
  }
}
