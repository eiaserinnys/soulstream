import { getMarkdownPreview } from "../../src/collaboration/board_yjs_preview.js";
import type { CatalogBoardYjsPort } from "../../src/catalog/catalog_board_item_service.js";
import type {
  BoardYjsContainerRef,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
  SqlClient,
} from "../../src/db/session_db.js";
interface TaskBoardYjsPort {
  upsertTaskBoardItem(input: {
    folderId: string;
    boardItemId: string;
    taskId: string;
    title: string;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  removeTaskBoardItem(folderId: string, boardItemId: string): Promise<void>;
}

/**
 * PostgreSQL integration-test double for the orchestrator-owned mutation port.
 * Production workers never write these tables; tests use this boundary double
 * so worker services can be exercised without starting an orchestrator.
 */
export class OrchestratorBoardYjsTestPort implements CatalogBoardYjsPort, TaskBoardYjsPort {
  constructor(private readonly sql: SqlClient) {}

  async close(): Promise<void> {}

  async upsertTaskBoardItem(input: {
    folderId: string;
    boardItemId: string;
    taskId: string;
    title: string;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  }): Promise<CatalogBoardItemRow> {
    const boardItem: CatalogBoardItemRow = {
      id: input.boardItemId,
      folderId: input.folderId,
      containerKind: "folder",
      containerId: input.folderId,
      membershipKind: "primary",
      sourceTaskItemId: null,
      itemType: "task",
      itemId: input.taskId,
      x: input.x,
      y: input.y,
      metadata: { ...input.metadata, title: input.title },
    };
    await this.upsertBoardItem(boardItem);
    return boardItem;
  }

  async removeTaskBoardItem(folderId: string, boardItemId: string): Promise<void> {
    await this.sql`
      DELETE FROM board_items
      WHERE id = ${boardItemId} AND folder_id = ${folderId}
    `;
  }

  async upsertSessionBoardItem(input: {
    folderId: string;
    container: BoardYjsContainerRef;
    sessionId: string;
    x: number;
    y: number;
    sourceTaskItemId?: string | null;
  }): Promise<CatalogBoardItemRow> {
    const boardItem: CatalogBoardItemRow = {
      id: `session:${input.sessionId}`,
      folderId: input.folderId,
      containerKind: input.container.containerKind,
      containerId: input.container.containerId,
      membershipKind: "primary",
      sourceTaskItemId: input.sourceTaskItemId ?? null,
      itemType: "session",
      itemId: input.sessionId,
      x: input.x,
      y: input.y,
      metadata: {},
    };
    await this.upsertBoardItem(boardItem);
    return boardItem;
  }

  async updateBoardItemPosition(
    _container: string | BoardYjsContainerRef,
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void> {
    await this.sql`
      UPDATE board_items
      SET x = ${x}, y = ${y}, updated_at = NOW()
      WHERE id = ${boardItemId}
    `;
  }

  async moveBoardItemToContainer(input: {
    boardItem: CatalogBoardItemRow;
    targetScope: {
      folderId: string;
      containerKind: BoardYjsContainerRef["containerKind"];
      containerId: string;
    };
    position?: { x: number; y: number };
    idempotencyKey: string;
  }): Promise<CatalogBoardItemRow> {
    const moved: CatalogBoardItemRow = {
      ...input.boardItem,
      folderId: input.targetScope.folderId,
      containerKind: input.targetScope.containerKind,
      containerId: input.targetScope.containerId,
      x: input.position?.x ?? input.boardItem.x,
      y: input.position?.y ?? input.boardItem.y,
    };
    await this.upsertBoardItem(moved);
    return moved;
  }

  async createMarkdownDocument(input: {
    folderId: string;
    container?: BoardYjsContainerRef;
    title: string;
    body: string;
    x: number;
    y: number;
    documentId: string;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
    const container = input.container ?? {
      containerKind: "folder" as const,
      containerId: input.folderId,
    };
    const document: MarkdownDocumentRow = {
      id: input.documentId,
      title: input.title,
      body: input.body,
      version: 1,
    };
    const boardItem: CatalogBoardItemRow = {
      id: `markdown:${input.documentId}`,
      folderId: input.folderId,
      containerKind: container.containerKind,
      containerId: container.containerId,
      membershipKind: "primary",
      sourceTaskItemId: null,
      itemType: "markdown",
      itemId: input.documentId,
      x: input.x,
      y: input.y,
      metadata: {
        title: input.title,
        preview: getMarkdownPreview(input.body),
        version: 1,
      },
    };
    await this.sql`
      INSERT INTO markdown_documents (id, title, body, version, updated_at)
      VALUES (${document.id}, ${document.title}, ${document.body}, ${document.version}, NOW())
      ON CONFLICT (id) DO UPDATE
      SET title = EXCLUDED.title,
          body = EXCLUDED.body,
          version = EXCLUDED.version,
          updated_at = EXCLUDED.updated_at
    `;
    await this.upsertBoardItem(boardItem);
    return { document, boardItem };
  }

  async updateMarkdownDocument(
    _container: string | BoardYjsContainerRef,
    documentId: string,
    fields: { title?: string; body?: string; expectedVersion: number },
  ): Promise<MarkdownDocumentRow | null> {
    const rows = await this.sql<Array<{
      id: string;
      title: string;
      body: string;
      version: number;
    }>>`
      SELECT id, title, body, version
      FROM markdown_documents
      WHERE id = ${documentId}
    `;
    const current = rows[0];
    if (!current) return null;
    if (current.version !== fields.expectedVersion) {
      throw new Error(`markdown document version conflict: ${documentId}`);
    }
    const document: MarkdownDocumentRow = {
      id: current.id,
      title: fields.title ?? current.title,
      body: fields.body ?? current.body,
      version: current.version + 1,
    };
    await this.sql`
      UPDATE markdown_documents
      SET title = ${document.title},
          body = ${document.body},
          version = ${document.version},
          updated_at = NOW()
      WHERE id = ${documentId}
    `;
    return document;
  }

  async deleteMarkdownDocument(
    _container: string | BoardYjsContainerRef,
    documentId: string,
  ): Promise<void> {
    await this.sql`DELETE FROM board_items WHERE item_type = 'markdown' AND item_id = ${documentId}`;
    await this.sql`DELETE FROM markdown_documents WHERE id = ${documentId}`;
  }

  private async upsertBoardItem(item: CatalogBoardItemRow): Promise<void> {
    await this.sql`
      INSERT INTO board_items (
        id, folder_id, container_kind, container_id, membership_kind,
        source_task_item_id, item_type, item_id, x, y, metadata, updated_at
      ) VALUES (
        ${item.id}, ${item.folderId}, ${item.containerKind ?? "folder"},
        ${item.containerId ?? item.folderId}, ${item.membershipKind ?? "primary"},
        ${item.sourceTaskItemId ?? null}, ${item.itemType}, ${item.itemId},
        ${item.x}, ${item.y}, ${this.sql.json(item.metadata)}::jsonb, NOW()
      )
      ON CONFLICT (id) DO UPDATE
      SET folder_id = EXCLUDED.folder_id,
          container_kind = EXCLUDED.container_kind,
          container_id = EXCLUDED.container_id,
          membership_kind = EXCLUDED.membership_kind,
          source_task_item_id = EXCLUDED.source_task_item_id,
          item_type = EXCLUDED.item_type,
          item_id = EXCLUDED.item_id,
          x = EXCLUDED.x,
          y = EXCLUDED.y,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
    `;
  }
}
