import type { CardRow, FolderRow, FolderSnapshot, FolderOperationRow, SqlClient, RepositorySql } from "./card_types.js";
import { normalizeOperation } from "./card_models.js";

export class CardRepositoryRead {
  constructor(protected readonly sql: SqlClient) {}
  transaction<T>(callback: (sql: RepositorySql) => Promise<T>): Promise<T> { return this.sql.begin(callback); }
  async getFolder(folderId: string): Promise<FolderRow | null> {
    return (await this.sql<FolderRow[]>`SELECT * FROM folders WHERE id=${folderId}`)[0] ?? null;
  }
  async getFolderForUpdateTx(sql: RepositorySql, folderId: string): Promise<FolderRow> {
    const folder=(await sql<FolderRow[]>`SELECT * FROM folders WHERE id=${folderId} FOR UPDATE`)[0];
    if (!folder) throw Object.assign(new Error("Folder not found"),{ statusCode:404 });
    return folder;
  }
  async getSnapshot(folderId: string): Promise<FolderSnapshot | null> {
    const folder = await this.getFolder(folderId);
    if (!folder) return null;
    return { folder, cards: await this.listCards({ folderId, includeArchived: true }) };
  }
  async listFolders(params: { folderId: string | null; includeArchived?: boolean; limit?: number; offset?: number }) {
    return await this.sql<FolderRow[]>`SELECT * FROM folders
      WHERE parent_folder_id IS NOT DISTINCT FROM ${params.folderId}
        AND (${params.includeArchived ?? false} OR archived=FALSE) AND id NOT IN ('claude','llm')
      ORDER BY sort_order,name,id LIMIT ${params.limit ?? 100} OFFSET ${params.offset ?? 0}`;
  }
  async listCards(params: { folderId?: string | null; status?: string | null; includeArchived?: boolean } = {}) {
    return await this.sql<CardRow[]>`SELECT * FROM cards
      WHERE (${params.folderId ?? null}::text IS NULL OR folder_id=${params.folderId ?? null})
        AND (${params.status ?? null}::text IS NULL OR status=${params.status ?? null})
        AND (${params.includeArchived ?? false} OR archived=FALSE)
      ORDER BY folder_id COLLATE "C",position_key COLLATE "C",id`;
  }
  async getCard(cardId: string): Promise<CardRow | null> {
    return (await this.sql<CardRow[]>`SELECT * FROM cards WHERE id=${cardId}`)[0] ?? null;
  }
  async listReports(cardId: string) {
    return await this.sql<Record<string, unknown>[]>`SELECT * FROM card_reports WHERE card_id=${cardId} ORDER BY created_at DESC,id DESC`;
  }
  async listQuestions(cardId: string) {
    return await this.sql<Record<string, unknown>[]>`SELECT * FROM card_questions WHERE card_id=${cardId} ORDER BY asked_at,id`;
  }
  async listSessions(cardId: string) {
    return await this.sql<Record<string, unknown>[]>`SELECT session_id,card_id,display_name,node_id,agent_id,status,created_at
      FROM sessions WHERE card_id=${cardId} ORDER BY created_at,session_id`;
  }
  async getOperationByIdempotencyKey(key: string): Promise<FolderOperationRow | null> {
    const row=(await this.sql<FolderOperationRow[]>`SELECT * FROM folder_operations WHERE idempotency_key=${key}`)[0];
    return row ? normalizeOperation(row) : null;
  }
  async listOperations(folderId: string, limit=50, offset=0) {
    return (await this.sql<FolderOperationRow[]>`SELECT * FROM folder_operations WHERE folder_id=${folderId}
      ORDER BY created_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`).map(normalizeOperation);
  }
}
