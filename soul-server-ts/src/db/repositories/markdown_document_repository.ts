import { MarkdownDocumentVersionConflictError } from "../markdown_document_version.js";
import type {
  BoardContainerKind,
  BoardYjsContainerRef,
  BoardItemType,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
  SqlClient,
} from "../session_db_types.js";
import {
  toCatalogBoardItemRow,
  toMarkdownDocumentRow,
} from "./repository_helpers.js";

export class MarkdownDocumentRepository {
  constructor(private readonly sql: SqlClient) {}

  async createMarkdownDocument(params: {
    documentId: string;
    folderId: string;
    container?: BoardYjsContainerRef | null;
    title: string;
    body: string;
    x: number;
    y: number;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
    const containerKind: BoardContainerKind = params.container?.containerKind ?? "folder";
    const containerId = params.container?.containerId ?? params.folderId;
    const rows = await this.sql<
      Array<{
        doc_id: string;
        doc_title: string;
        doc_body: string;
        doc_version: string | number | null;
        doc_created_at: Date | string | null;
        doc_updated_at: Date | string | null;
        item_id: string;
        item_folder_id: string;
        item_container_kind: BoardContainerKind;
        item_container_id: string;
        item_membership_kind: "primary" | "reference";
        item_source_runbook_item_id: string | null;
        item_type: BoardItemType;
        item_ref_id: string;
        item_x: string | number;
        item_y: string | number;
        item_metadata: unknown;
        item_created_at: Date | string | null;
        item_updated_at: Date | string | null;
      }>
    >`
      WITH doc AS (
        INSERT INTO markdown_documents (id, title, body)
        VALUES (${params.documentId}, ${params.title}, ${params.body})
        RETURNING *
      ),
      item AS (
        INSERT INTO board_items (
          id,
          folder_id,
          container_kind,
          container_id,
          membership_kind,
          item_type,
          item_id,
          x,
          y
        )
        VALUES (
          ${"markdown:" + params.documentId},
          ${params.folderId},
          ${containerKind},
          ${containerId},
          ${"primary"},
          ${"markdown"},
          ${params.documentId},
          ${params.x},
          ${params.y}
        )
        RETURNING *
      )
      SELECT
        doc.id AS doc_id,
        doc.title AS doc_title,
        doc.body AS doc_body,
        doc.version AS doc_version,
        doc.created_at AS doc_created_at,
        doc.updated_at AS doc_updated_at,
        item.id AS item_id,
        item.folder_id AS item_folder_id,
        item.container_kind AS item_container_kind,
        item.container_id AS item_container_id,
        item.membership_kind AS item_membership_kind,
        item.source_runbook_item_id AS item_source_runbook_item_id,
        item.item_type AS item_type,
        item.item_id AS item_ref_id,
        item.x AS item_x,
        item.y AS item_y,
        item.metadata AS item_metadata,
        item.created_at AS item_created_at,
        item.updated_at AS item_updated_at
      FROM doc, item
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("Markdown document creation returned no rows");
    }
    const document = toMarkdownDocumentRow({
      id: row.doc_id,
      title: row.doc_title,
      body: row.doc_body,
      version: row.doc_version,
      created_at: row.doc_created_at,
      updated_at: row.doc_updated_at,
    });
    const boardItem = toCatalogBoardItemRow({
      id: row.item_id,
      folder_id: row.item_folder_id,
      container_kind: row.item_container_kind,
      container_id: row.item_container_id,
      membership_kind: row.item_membership_kind,
      source_runbook_item_id: row.item_source_runbook_item_id,
      item_type: row.item_type,
      item_id: row.item_ref_id,
      x: row.item_x,
      y: row.item_y,
      metadata: row.item_metadata,
      created_at: row.item_created_at,
      updated_at: row.item_updated_at,
    });
    boardItem.metadata = {
      title: params.title,
      preview: params.body.replace(/\s+/g, " ").trim().slice(0, 180),
    };
    return { document, boardItem };
  }

  async getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null> {
    const rows = await this.sql<
      Array<{
        id: string;
        title: string;
        body: string;
        version: string | number | null;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }>
    >`SELECT * FROM markdown_documents WHERE id = ${documentId}`;
    return rows[0] ? toMarkdownDocumentRow(rows[0]) : null;
  }

  async updateMarkdownDocument(
    documentId: string,
    fields: { title?: string; body?: string; expectedVersion: number },
  ): Promise<MarkdownDocumentRow | null> {
    const rows = await this.sql<
      Array<{
        id: string;
        title: string;
        body: string;
        version: string | number | null;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }>
    >`
      UPDATE markdown_documents
      SET title = CASE WHEN ${fields.title !== undefined} THEN ${fields.title ?? ""} ELSE title END,
          body = CASE WHEN ${fields.body !== undefined} THEN ${fields.body ?? ""} ELSE body END,
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${documentId}
        AND version = ${fields.expectedVersion}
      RETURNING *
    `;
    if (rows[0]) {
      return toMarkdownDocumentRow(rows[0]);
    }
    const existing = await this.getMarkdownDocument(documentId);
    if (existing) {
      throw new MarkdownDocumentVersionConflictError(
        documentId,
        fields.expectedVersion,
        existing.version,
      );
    }
    return null;
  }

  async deleteMarkdownDocument(documentId: string): Promise<void> {
    await this.sql`DELETE FROM markdown_documents WHERE id = ${documentId}`;
  }
}
