import { z } from "zod";

import {
  boardContainerKindInputSchema,
  boardItemTypeInputSchema,
} from "./board_container_kind_compat.js";
import type { BoardProjectionHost } from "./board_projection_types.js";

const containerSchema = z.object({
  containerKind: boardContainerKindInputSchema,
  containerId: z.string().min(1),
});

const actorKindSchema = z.enum(["agent", "user", "system", "llm"]);

const checklistRowSchema = z.object({
  block_id: z.string().min(1),
  page_id: z.string().min(1),
  source_hash: z.string().min(1),
  actor_kind: actorKindSchema,
  actor_session_id: z.string().nullable(),
  actor_user_id: z.string().nullable(),
  routing_session_id: z.string().min(1),
  attempts: z.number().int().nonnegative(),
});

const schemas = {
  "get-board-items": z.object({}),
  "get-board-item": z.object({ boardItemId: z.string().min(1) }),
  "get-primary-session-board-item": z.object({ sessionId: z.string().min(1) }),
  "get-markdown-document-board-item": z.object({ documentId: z.string().min(1) }),
  "get-board-item-ids-for-session": z.object({ sessionId: z.string().min(1) }),
  "list-container-items": z.object({
    container: containerSchema,
    query: z.string().nullable(),
    includeArchived: z.boolean(),
    itemTypes: z.array(boardItemTypeInputSchema).nullable(),
    limit: z.number().int().positive(),
    cursor: z.number().int().nonnegative(),
    scanLimit: z.number().int().positive().nullable().optional(),
  }),
  "resolve-board-yjs-container-scope": z.object({ container: containerSchema }),
  "get-markdown-document": z.object({ documentId: z.string().min(1) }),
  "get-custom-view": z.object({ customViewId: z.string().min(1) }),
  "list-custom-views": z.object({
    container: containerSchema,
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
  "claim-checklist-task-projections": z.object({
    nodeId: z.string().min(1),
    limit: z.number().int().positive().optional(),
    leaseMs: z.number().int().positive().optional(),
  }),
  "mark-checklist-task-projection-success": z.object({
    row: checklistRowSchema,
    nodeId: z.string().min(1),
  }),
  "mark-checklist-task-projection-failure": z.object({
    row: checklistRowSchema,
    nodeId: z.string().min(1),
    error: z.string(),
  }),
  "mark-checklist-task-projection-dead-letter": z.object({
    row: checklistRowSchema,
    nodeId: z.string().min(1),
    error: z.string(),
  }),
} as const;

export function getBoardProjectionHostOperationSchema(
  operation: string,
): z.ZodType | undefined {
  return schemas[operation as keyof typeof schemas];
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
    case "list-container-items":
      return await host.listContainerItems(
        input as z.infer<typeof schemas["list-container-items"]>,
      );
    case "resolve-board-yjs-container-scope":
      return await host.resolveBoardYjsContainerScope(
        (input as z.infer<typeof schemas["resolve-board-yjs-container-scope"]>).container,
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
    case "claim-checklist-task-projections": {
      const value = input as z.infer<typeof schemas["claim-checklist-task-projections"]>;
      return await host.claimChecklistTaskProjections(
        value.nodeId,
        value.limit,
        value.leaseMs,
      );
    }
    case "mark-checklist-task-projection-success": {
      const value = input as z.infer<
        typeof schemas["mark-checklist-task-projection-success"]
      >;
      return await host.markChecklistTaskProjectionSuccess(value.row, value.nodeId);
    }
    case "mark-checklist-task-projection-failure": {
      const value = input as z.infer<
        typeof schemas["mark-checklist-task-projection-failure"]
      >;
      await host.markChecklistTaskProjectionFailure(value.row, value.nodeId, value.error);
      return { ok: true };
    }
    case "mark-checklist-task-projection-dead-letter": {
      const value = input as z.infer<
        typeof schemas["mark-checklist-task-projection-dead-letter"]
      >;
      return await host.markChecklistTaskProjectionDeadLetter(
        value.row,
        value.nodeId,
        value.error,
      );
    }
    default:
      throw new Error(`Unknown board projection host operation: ${operation}`);
  }
}
