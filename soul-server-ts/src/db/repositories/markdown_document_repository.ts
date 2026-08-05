import type {
  MarkdownDocumentRow,
  SqlClient,
} from "../session_db_types.js";
import { toMarkdownDocumentRow } from "./repository_helpers.js";

/** Worker-side read boundary. Markdown writes are orchestrator-owned. */
export class MarkdownDocumentRepository {
  constructor(private readonly sql: SqlClient) {}

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
}
