import { randomUUID } from "node:crypto";

import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { FolderContentSqlResolver } from "./folder_content_sql.js";
import { toCatalogBoardItemRow, toMarkdownDocumentRow, type BoardItemDbRow, type MarkdownDbRow } from "./folder_content_serialization.js";
import type { CatalogBoardItemRow, MarkdownDocumentRow } from "./folder_content_types.js";
import { MarkdownDocumentVersionConflictError } from "./markdown_document_version.js";

export interface MarkdownMutation {
  documentId: string;
  version: number;
  folderIds: readonly string[];
  boardItems?: readonly CatalogBoardItemRow[];
  deletedBoardItemIds?: readonly string[];
}

export class MarkdownDocumentService {
  private readonly resolver: FolderContentSqlResolver;

  constructor(resolver: LiveDbSqlResolver, private readonly notify: (mutation: MarkdownMutation) => Promise<void>) {
    this.resolver = new FolderContentSqlResolver(resolver);
  }

  async create(input: { documentId?: string; folderId: string; title: string; body: string; x?: number; y?: number }):
    Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
    const id = input.documentId ?? randomUUID();
    if (!id.trim() || id.length > 200) throw Object.assign(new Error("Invalid documentId"), { statusCode: 422 });
    const sql = await this.resolver.resolveSql();
    const result = await sql.begin(async tx => {
      const inserted = await tx<readonly MarkdownDbRow[]>`
        INSERT INTO markdown_documents (id, folder_id, title, body)
        VALUES (${id}, ${input.folderId}, ${input.title}, ${input.body})
        ON CONFLICT (id) DO NOTHING RETURNING *
      `;
      const rows = inserted.length ? inserted : await tx<readonly MarkdownDbRow[]>`
        SELECT * FROM markdown_documents WHERE id = ${id} FOR UPDATE
      `;
      const doc = rows[0]!;
      if (doc.folder_id !== input.folderId || doc.title !== input.title || doc.body !== input.body) {
        throw Object.assign(new Error("Document ID already exists with different contents"), { statusCode: 409 });
      }
      if (inserted.length) {
        await tx`
          INSERT INTO board_items (id, folder_id, membership_kind, item_type, item_id, x, y, metadata)
          VALUES (${'markdown:' + id}, ${input.folderId}, 'primary', 'markdown', ${id}, 0, 0,
            ${tx.json({ title: input.title, preview: preview(input.body), version: Number(doc.version) })}::jsonb)
        `;
      }
      const items = await tx<readonly BoardItemDbRow[]>`
        SELECT * FROM board_items WHERE item_type = 'markdown' AND item_id = ${id}
          AND membership_kind = 'primary' LIMIT 1
      `;
      const document = toMarkdownDocumentRow(doc);
      const boardItem = items[0] ? toCatalogBoardItemRow(items[0]) : {
        id: `markdown:${id}`, folderId: input.folderId, membershipKind: "primary" as const,
        itemType: "markdown" as const, itemId: id, x: 0, y: 0,
        metadata: { title: doc.title, preview: preview(doc.body), version: document.version },
        ...(document.createdAt ? { createdAt: document.createdAt } : {}),
        ...(document.updatedAt ? { updatedAt: document.updatedAt } : {}),
      };
      return { document, boardItem, created: inserted.length > 0 };
    });
    if (result.created) await this.notify({ documentId: id, version: result.document.version, folderIds: [input.folderId], boardItems: [result.boardItem] });
    return { document: result.document, boardItem: result.boardItem };
  }

  async update(id: string, fields: { expectedVersion: number; title?: string; body?: string }): Promise<MarkdownDocumentRow | null> {
    const sql = await this.resolver.resolveSql();
    const result = await sql.begin(async tx => {
      const rows = await tx<readonly MarkdownDbRow[]>`
        UPDATE markdown_documents SET title = COALESCE(${fields.title ?? null}, title),
          body = COALESCE(${fields.body ?? null}, body), version = version + 1, updated_at = NOW()
        WHERE id = ${id} AND version = ${fields.expectedVersion} RETURNING *
      `;
      const doc = rows[0];
      if (!doc) {
        const existing = await tx<readonly { version: number }[]>`SELECT version FROM markdown_documents WHERE id = ${id}`;
        if (existing[0]) throw new MarkdownDocumentVersionConflictError(id, fields.expectedVersion, Number(existing[0].version));
        return null;
      }
      const items = await tx<readonly BoardItemDbRow[]>`
        UPDATE board_items SET metadata = metadata || ${tx.json({ title: doc.title, preview: preview(doc.body), version: Number(doc.version) })}::jsonb,
          updated_at = NOW() WHERE item_type = 'markdown' AND item_id = ${id} RETURNING *
      `;
      return { document: toMarkdownDocumentRow(doc), boardItems: items.map(toCatalogBoardItemRow) };
    });
    if (!result) return null;
    await this.notify({ documentId: id, version: result.document.version, folderIds: result.document.folderId ? [result.document.folderId] : [], boardItems: result.boardItems });
    return result.document;
  }

  async delete(id: string): Promise<void> {
    const sql = await this.resolver.resolveSql();
    const result = await sql.begin(async tx => {
      const docs = await tx<readonly MarkdownDbRow[]>`SELECT * FROM markdown_documents WHERE id = ${id} FOR UPDATE`;
      const items = await tx<readonly { id: string }[]>`DELETE FROM board_items WHERE item_type = 'markdown' AND item_id = ${id} RETURNING id`;
      await tx`DELETE FROM markdown_documents WHERE id = ${id}`;
      return { document: docs[0], ids: items.map(item => item.id) };
    });
    if (result.document) await this.notify({ documentId: id, version: Number(result.document.version), folderIds: result.document.folder_id ? [result.document.folder_id] : [], deletedBoardItemIds: result.ids });
  }

  async move(id: string, folderId: string): Promise<CatalogBoardItemRow> {
    const sql = await this.resolver.resolveSql();
    const result = await sql.begin(async tx => {
      const docs = await tx<readonly MarkdownDbRow[]>`SELECT * FROM markdown_documents WHERE id = ${id} FOR UPDATE`;
      if (!docs[0]) throw Object.assign(new Error("Document not found"), { statusCode: 404 });
      const references = await tx<readonly { id: string }[]>`
        DELETE FROM board_items WHERE folder_id = ${folderId} AND item_type = 'markdown'
          AND item_id = ${id} AND membership_kind <> 'primary' RETURNING id
      `;
      await tx`UPDATE markdown_documents SET folder_id = ${folderId} WHERE id = ${id}`;
      let items = await tx<readonly BoardItemDbRow[]>`
        UPDATE board_items SET folder_id = ${folderId}, updated_at = NOW()
        WHERE item_type = 'markdown' AND item_id = ${id} AND membership_kind = 'primary' RETURNING *
      `;
      if (!items[0]) {
        items = await tx<readonly BoardItemDbRow[]>`
          INSERT INTO board_items (id, folder_id, membership_kind, item_type, item_id, x, y, metadata)
          VALUES (${'markdown:' + id}, ${folderId}, 'primary', 'markdown', ${id}, 0, 0,
            ${tx.json({ title: docs[0].title, preview: preview(docs[0].body), version: Number(docs[0].version) })}::jsonb)
          RETURNING *
        `;
      }
      return { source: docs[0].folder_id, version: Number(docs[0].version), boardItem: toCatalogBoardItemRow(items[0]!),
        deletedBoardItemIds: references.map(reference => reference.id) };
    });
    await this.notify({ documentId: id, version: result.version, folderIds: [...new Set([result.source, folderId].filter((value): value is string => value !== null))], boardItems: [result.boardItem], deletedBoardItemIds: result.deletedBoardItemIds });
    return result.boardItem;
  }
}

function preview(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 180);
}
