import type { CardRow, FolderRow, FolderSnapshot, FolderOperationRow, SqlClient, RepositorySql } from "./card_types.js";
import { normalizeOperation } from "./card_models.js";
import { projectCardActivity } from "../card_latest_activity.js";
import { completedCardCursor, type CompletedCardQuery } from "../completed_card_query.js";

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
  async getSnapshot(folderId: string, includeCompleted = true): Promise<FolderSnapshot | null> {
    const folder = await this.getFolder(folderId);
    if (!folder) return null;
    return { folder, cards: await this.projectCards(await this.listCards({ folderId, includeArchived: true, includeCompleted })) };
  }
  async listFolders(params: { folderId: string | null; includeArchived?: boolean; limit?: number; offset?: number }) {
    return await this.sql<FolderRow[]>`SELECT * FROM folders
      WHERE parent_folder_id IS NOT DISTINCT FROM ${params.folderId}
        AND (${params.includeArchived ?? false} OR archived=FALSE) AND id NOT IN ('claude','llm')
      ORDER BY sort_order,name,id LIMIT ${params.limit ?? 100} OFFSET ${params.offset ?? 0}`;
  }
  async listCards(params: { folderId?: string | null; status?: string | null; includeArchived?: boolean; includeCompleted?: boolean; allowedFolderIds?: readonly string[] | null } = {}) {
    return await this.sql<CardRow[]>`SELECT * FROM cards
      WHERE (${params.folderId ?? null}::text IS NULL OR folder_id=${params.folderId ?? null})
        AND (${params.status ?? null}::text IS NULL OR status=${params.status ?? null})
        AND (${params.includeArchived ?? false} OR archived=FALSE)
        AND (${params.includeCompleted ?? true} OR status <> 'done')
        AND (${params.allowedFolderIds ?? null}::text[] IS NULL OR folder_id=ANY(${params.allowedFolderIds ?? null}::text[]))
      ORDER BY folder_id COLLATE "C",position_key COLLATE "C",id`;
  }
  async listCompletedCards(params: CompletedCardQuery) {
    const rows = await this.sql<(CardRow & { cursor_time: string })[]>`SELECT cards.*,completed_at::text AS cursor_time FROM cards
      WHERE status='done' AND archived=FALSE AND completed_at IS NOT NULL
        AND (${params.folderId ?? null}::text IS NULL OR folder_id=${params.folderId ?? null})
        AND (${params.allowedFolderIds ?? null}::text[] IS NULL OR folder_id=ANY(${params.allowedFolderIds ?? null}::text[]))
        AND (${params.completedFrom ?? null}::timestamptz IS NULL OR completed_at >= ${params.completedFrom ?? null}::timestamptz)
        AND (${params.completedBefore ?? null}::timestamptz IS NULL OR completed_at < ${params.completedBefore ?? null}::timestamptz)
        AND (${params.q ?? ""} = '' OR strpos(lower(title),lower(${params.q ?? ""})) > 0 OR strpos(lower(request),lower(${params.q ?? ""})) > 0)
        AND (${params.after?.time ?? null}::text::timestamptz IS NULL OR (completed_at,id COLLATE "C") < (${params.after?.time ?? null}::text::timestamptz,${params.after?.id ?? null}::text COLLATE "C"))
      ORDER BY completed_at DESC,id COLLATE "C" DESC LIMIT ${params.limit + 1}`;
    const page = rows.slice(0,params.limit), last = page.at(-1);
    const nextCursor = rows.length > params.limit && last ? completedCardCursor(last.cursor_time,last.id) : null;
    const cards = page.map(({ cursor_time: _cursorTime, ...card }) => card as CardRow);
    return { cards: await this.projectCards(cards), nextCursor };
  }
  async getCard(cardId: string): Promise<CardRow | null> {
    return (await this.sql<CardRow[]>`SELECT * FROM cards WHERE id=${cardId}`)[0] ?? null;
  }
  projectCards(cards: readonly CardRow[]) { return projectCardActivity(this.sql, cards); }
  async listReports(cardId: string) {
    return await this.sql<Record<string, unknown>[]>`SELECT * FROM card_reports WHERE card_id=${cardId} ORDER BY created_at DESC,id DESC`;
  }
  async listQuestions(cardId: string) {
    return await this.sql<Record<string, unknown>[]>`SELECT * FROM card_questions WHERE card_id=${cardId} ORDER BY asked_at,id`;
  }
  async listComments(cardId: string) {
    return await this.sql<Record<string, unknown>[]>`SELECT * FROM card_comments WHERE card_id=${cardId} ORDER BY created_at,id`;
  }
  async getComment(cardId: string, commentId: string) {
    return (await this.sql<Record<string, unknown>[]>`SELECT * FROM card_comments WHERE card_id=${cardId} AND id=${commentId}`)[0] ?? null;
  }
  async markCommentDelivered(cardId: string, commentId: string) {
    const rows = await this.sql`UPDATE card_comments SET delivered_at=NOW()
      WHERE card_id=${cardId} AND id=${commentId} AND delivered_at IS NULL RETURNING id`;
    return rows.length > 0;
  }
  async listSessions(cardId: string) {
    return await this.sql<Record<string, unknown>[]>`SELECT session_id,card_id,display_name,node_id,agent_id,status,created_at,caller_session_id,updated_at
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
