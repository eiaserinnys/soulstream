import type { RepositorySql, SqlClient } from "./card_types.js";

export const CARD_MCP_READ_KINDS = [
  "request", "brief", "attachments", "comments", "notes", "reports", "sessions", "now_history", "questions_history",
] as const;
export type CardMcpReadKind = (typeof CARD_MCP_READ_KINDS)[number];
export type CardMcpCursorPosition = { timestamp: string; id: string } | { offset: number };

export interface CardMcpListQuery {
  folderId: string | null;
  status: string | null;
  limit: number;
  all: boolean;
  allowedFolderIds: readonly string[] | null;
  after: { folderId: string; positionKey: string; id: string } | null;
}

export interface CardMcpListRow extends Record<string, unknown> {
  id: string;
  number: number | null;
  folder_id: string;
  position_key: string;
  title: string;
  status: string;
  assignee_kind: string | null;
  assignee_agent_id: string | null;
  assignee_session_id: string | null;
  assignee_user_id: string | null;
  updated_at: Date;
}

export interface CardMcpCurrent {
  card: Record<string, unknown>;
  available: {
    request: boolean; brief: boolean; attachments: boolean;
    comments: number; notes: number; reports: number; sessions: number; now_history: number;
  };
  fingerprints: Record<string, string>;
}

export interface CardMcpSnapshot { sql: RepositorySql; current: CardMcpCurrent }
export type CardMcpSectionPage =
  | { kind: "text"; text: string; nextOffset: number | null; truncated: boolean }
  | { kind: "items"; items: Record<string, unknown>[]; next: { timestamp: string; id: string } | { offset: number } | null; truncated: boolean };

interface RecordCursorRow extends Record<string, unknown> { cursor_time: string; cursor_id: string }
const SYSTEM_FOLDER_IDS = ["claude", "llm"] as const;

function httpError(statusCode: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

export class CardMcpReadRepository {
  constructor(private readonly sql: SqlClient) {}

  async listCards(query: CardMcpListQuery): Promise<{ rows: CardMcpListRow[]; truncated: boolean }> {
    if (query.folderId && SYSTEM_FOLDER_IDS.includes(query.folderId as (typeof SYSTEM_FOLDER_IDS)[number]))
      return { rows: [], truncated: false };
    if (query.folderId && query.allowedFolderIds !== null && !query.allowedFolderIds.includes(query.folderId))
      throw httpError(403, "Folder access denied", "FOLDER_ACCESS_DENIED");

    const rows = await this.sql<CardMcpListRow[]>`
      SELECT id,number,folder_id,position_key,title,status,assignee_kind,assignee_agent_id,
        assignee_session_id,assignee_user_id,updated_at
      FROM cards
      WHERE archived=FALSE AND folder_id NOT IN ('claude','llm')
        AND (${query.folderId}::text IS NULL OR folder_id=${query.folderId})
        AND (${query.status}::text IS NULL OR status=${query.status})
        AND (${query.allowedFolderIds}::text[] IS NULL OR folder_id=ANY(${query.allowedFolderIds}::text[]))
        AND (${query.after?.folderId ?? null}::text IS NULL OR
          (folder_id COLLATE "C",position_key COLLATE "C",id COLLATE "C") >
          (${query.after?.folderId ?? null}::text COLLATE "C",${query.after?.positionKey ?? null}::text COLLATE "C",
           ${query.after?.id ?? null}::text COLLATE "C"))
      ORDER BY folder_id COLLATE "C",position_key COLLATE "C",id COLLATE "C"
      LIMIT ${query.all ? null : query.limit + 1}
    `;
    const truncated = !query.all && rows.length > query.limit;
    return { rows: truncated ? rows.slice(0, query.limit) : rows, truncated };
  }

  async withCardSnapshot<T>(
    cardId: string,
    allowedFolderIds: readonly string[] | null,
    read: (snapshot: CardMcpSnapshot) => Promise<T>,
  ): Promise<T> {
    return this.sql.begin(async (transaction) => {
      await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      const access = (await transaction<{ folder_id: string }[]>`SELECT folder_id FROM cards WHERE id=${cardId}`)[0];
      if (!access) throw httpError(404, "Card not found");
      if (SYSTEM_FOLDER_IDS.includes(access.folder_id as (typeof SYSTEM_FOLDER_IDS)[number]))
        throw httpError(404, "Card not found");
      if (allowedFolderIds !== null && !allowedFolderIds.includes(access.folder_id))
        throw httpError(403, "Folder access denied", "FOLDER_ACCESS_DENIED");
      const current = await this.readCurrent(transaction, cardId);
      return read({ sql: transaction, current });
    });
  }

  async readQuestionPage(sql: RepositorySql, cardId: string, limit: number, cursor: { timestamp: string; id: string } | null) {
    return this.readRecordPage(limit, () => sql<RecordCursorRow[]>`
      SELECT id,card_id,session_id,text,options,asked_at,answer,answered_at,answered_by,
        asked_at::text AS cursor_time,id AS cursor_id
      FROM card_questions
      WHERE card_id=${cardId} AND answer IS NULL
        AND (${cursor?.timestamp ?? null}::text IS NULL OR
          (asked_at,id COLLATE "C") < (${cursor?.timestamp ?? null}::text::timestamptz,${cursor?.id ?? null}::text COLLATE "C"))
      ORDER BY asked_at DESC,id COLLATE "C" DESC LIMIT ${limit + 1}
    `);
  }

  async readSectionPage(
    sql: RepositorySql, cardId: string, kind: CardMcpReadKind, limit: number, textLimit: number,
    cursor: CardMcpCursorPosition | null,
  ): Promise<CardMcpSectionPage> {
    if (kind === "request" || kind === "brief") {
      const offset = cursor && "offset" in cursor ? cursor.offset : 0;
      const [page] = kind === "request"
        ? await sql<{ text: string; total: number }[]>`
            SELECT substr(request,${offset + 1}::int,${textLimit}::int) AS text,char_length(request)::int AS total
            FROM cards WHERE id=${cardId}
          `
        : await sql<{ text: string; total: number }[]>`
            SELECT substr(brief,${offset + 1}::int,${textLimit}::int) AS text,char_length(brief)::int AS total
            FROM cards WHERE id=${cardId}
          `;
      const text = page?.text ?? "";
      const nextOffset = offset + [...text].length;
      const truncated = nextOffset < (page?.total ?? 0);
      return { kind: "text", text, nextOffset: truncated ? nextOffset : null, truncated };
    }

    if (kind === "attachments") {
      const offset = cursor && "offset" in cursor ? cursor.offset : 0;
      const rows = await sql<{ item: unknown }[]>`
        SELECT attachment AS item
        FROM cards c
        CROSS JOIN LATERAL jsonb_array_elements(c.attachments) WITH ORDINALITY AS attachments(attachment,ordinality)
        WHERE c.id=${cardId} AND ordinality > ${offset}
        ORDER BY ordinality LIMIT ${limit + 1}
      `;
      const truncated = rows.length > limit;
      return {
        kind: "items",
        items: rows.slice(0, limit).map((row) => row.item as Record<string, unknown>),
        next: truncated ? { offset: offset + limit } : null,
        truncated,
      };
    }

    const afterTime = cursor && "timestamp" in cursor ? cursor.timestamp : null;
    const afterId = cursor && "timestamp" in cursor ? cursor.id : null;
    if (kind === "comments" || kind === "notes") {
      const notesOnly = kind === "notes";
      return this.readRecordPage(limit, () => sql<RecordCursorRow[]>`
        SELECT id,card_id,author_kind,author_id,session_id,kind,body,item_id,delivered_at,created_at,
          created_at::text AS cursor_time,id AS cursor_id
        FROM card_comments
        WHERE card_id=${cardId} AND (${notesOnly}::boolean AND kind='note' OR NOT ${notesOnly}::boolean AND kind<>'note')
          AND (${afterTime}::text IS NULL OR
            (created_at,id COLLATE "C") < (${afterTime}::text::timestamptz,${afterId}::text COLLATE "C"))
        ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT ${limit + 1}
      `);
    }
    if (kind === "reports") {
      return this.readRecordPage(limit, () => sql<RecordCursorRow[]>`
        SELECT id,card_id,title,format,body,session_id,created_at,created_at::text AS cursor_time,id AS cursor_id
        FROM card_reports
        WHERE card_id=${cardId}
          AND (${afterTime}::text IS NULL OR
            (created_at,id COLLATE "C") < (${afterTime}::text::timestamptz,${afterId}::text COLLATE "C"))
        ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT ${limit + 1}
      `);
    }
    if (kind === "questions_history") {
      return this.readRecordPage(limit, () => sql<RecordCursorRow[]>`
        SELECT id,card_id,session_id,text,options,answer,asked_at,answered_at,answered_by,
          asked_at::text AS cursor_time,id AS cursor_id
        FROM card_questions
        WHERE card_id=${cardId}
          AND (${afterTime}::text IS NULL OR
            (asked_at,id COLLATE "C") < (${afterTime}::text::timestamptz,${afterId}::text COLLATE "C"))
        ORDER BY asked_at DESC,id COLLATE "C" DESC LIMIT ${limit + 1}
      `);
    }
    if (kind === "sessions") {
      return this.readRecordPage(limit, () => sql<RecordCursorRow[]>`
        SELECT session_id,card_id,display_name,node_id,agent_id,status,created_at,caller_session_id,updated_at,
          created_at::text AS cursor_time,session_id AS cursor_id
        FROM sessions
        WHERE card_id=${cardId}
          AND (${afterTime}::text IS NULL OR
            (created_at,session_id COLLATE "C") < (${afterTime}::text::timestamptz,${afterId}::text COLLATE "C"))
        ORDER BY created_at DESC,session_id COLLATE "C" DESC LIMIT ${limit + 1}
      `);
    }
    return this.readRecordPage(limit, () => sql<RecordCursorRow[]>`
      SELECT id,payload_json->>'text' AS text,payload_json->>'turn' AS turn,payload_json->'ask' AS ask,
        created_at AS at,created_at::text AS cursor_time,id AS cursor_id
      FROM folder_operations
      WHERE target_kind='card' AND target_id=${cardId} AND operation_type='update_card_now'
        AND (${afterTime}::text IS NULL OR
          (created_at,id COLLATE "C") < (${afterTime}::text::timestamptz,${afterId}::text COLLATE "C"))
      ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT ${limit + 1}
    `);
  }

  private async readCurrent(sql: RepositorySql, cardId: string): Promise<CardMcpCurrent> {
    const row = (await sql<{
      id: string; number: number | null; folder_id: string; title: string; status: string; archived: boolean; version: number;
      assignee_kind: string | null; assignee_agent_id: string | null; assignee_session_id: string | null; assignee_user_id: string | null;
      now: unknown; items: unknown; blocked_kind: string | null; blocked_detail: string | null;
      request_available: boolean; brief_available: boolean; attachments_available: boolean;
      comments_count: number; notes_count: number; reports_count: number; sessions_count: number; now_history_count: number;
      fp_card: string; fp_request: string; fp_brief: string; fp_attachments: string; fp_questions: string;
      fp_questions_history: string; fp_comments: string; fp_notes: string; fp_reports: string; fp_sessions: string;
      fp_now_history: string;
    }[]>`
      SELECT c.id,c.number,c.folder_id,c.title,c.status,c.archived,c.version,
        c.assignee_kind,c.assignee_agent_id,c.assignee_session_id,c.assignee_user_id,c.now,c.items,c.blocked_kind,c.blocked_detail,
        (c.request<>'') AS request_available,(c.brief<>'') AS brief_available,
        (c.attachments<>'[]'::jsonb) AS attachments_available,
        (SELECT count(*)::int FROM card_comments WHERE card_id=c.id AND kind<>'note') AS comments_count,
        (SELECT count(*)::int FROM card_comments WHERE card_id=c.id AND kind='note') AS notes_count,
        (SELECT count(*)::int FROM card_reports WHERE card_id=c.id) AS reports_count,
        (SELECT count(*)::int FROM sessions WHERE card_id=c.id) AS sessions_count,
        (SELECT count(*)::int FROM folder_operations WHERE target_kind='card' AND target_id=c.id AND operation_type='update_card_now') AS now_history_count,
        md5(jsonb_build_object(
          'id',c.id,'number',c.number,'folder_id',c.folder_id,'title',c.title,'status',c.status,'archived',c.archived,
          'version',c.version,'assignee_kind',c.assignee_kind,'assignee_agent_id',c.assignee_agent_id,
          'assignee_session_id',c.assignee_session_id,'assignee_user_id',c.assignee_user_id,'now',c.now,'items',c.items,
          'blocked_kind',c.blocked_kind,'blocked_detail',c.blocked_detail
        )::text) AS fp_card,
        md5(c.request) AS fp_request,md5(c.brief) AS fp_brief,md5(c.attachments::text) AS fp_attachments,
        md5(COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'card_id',q.card_id,'session_id',q.session_id,
          'text',q.text,'options',q.options,'answer',q.answer,'asked_at',q.asked_at,
          'answered_at',q.answered_at,'answered_by',q.answered_by) ORDER BY q.id COLLATE "C")::text
          FROM card_questions q WHERE q.card_id=c.id AND q.answer IS NULL),'[]')) AS fp_questions,
        md5(COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'card_id',q.card_id,'session_id',q.session_id,
          'text',q.text,'options',q.options,'answer',q.answer,'asked_at',q.asked_at,'answered_at',q.answered_at,
          'answered_by',q.answered_by) ORDER BY q.id COLLATE "C")::text
          FROM card_questions q WHERE q.card_id=c.id),'[]')) AS fp_questions_history,
        md5(COALESCE((SELECT jsonb_agg(jsonb_build_object('id',cc.id,'card_id',cc.card_id,'author_kind',cc.author_kind,
          'author_id',cc.author_id,'session_id',cc.session_id,'kind',cc.kind,'body',cc.body,'item_id',cc.item_id,
          'delivered_at',cc.delivered_at,'created_at',cc.created_at) ORDER BY cc.id COLLATE "C")::text
          FROM card_comments cc WHERE cc.card_id=c.id AND cc.kind<>'note'),'[]')) AS fp_comments,
        md5(COALESCE((SELECT jsonb_agg(jsonb_build_object('id',cc.id,'card_id',cc.card_id,'author_kind',cc.author_kind,
          'author_id',cc.author_id,'session_id',cc.session_id,'kind',cc.kind,'body',cc.body,'item_id',cc.item_id,
          'delivered_at',cc.delivered_at,'created_at',cc.created_at) ORDER BY cc.id COLLATE "C")::text
          FROM card_comments cc WHERE cc.card_id=c.id AND cc.kind='note'),'[]')) AS fp_notes,
        md5(COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'card_id',r.card_id,'title',r.title,'format',r.format,
          'body',r.body,'session_id',r.session_id,'created_at',r.created_at) ORDER BY r.id COLLATE "C")::text
          FROM card_reports r WHERE r.card_id=c.id),'[]')) AS fp_reports,
        md5(COALESCE((SELECT jsonb_agg(jsonb_build_object('session_id',s.session_id,'card_id',s.card_id,
          'display_name',s.display_name,'node_id',s.node_id,'agent_id',s.agent_id,'status',s.status,
          'created_at',s.created_at,'caller_session_id',s.caller_session_id,'updated_at',s.updated_at)
          ORDER BY s.session_id COLLATE "C")::text FROM sessions s WHERE s.card_id=c.id),'[]')) AS fp_sessions,
        md5(COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'text',o.payload_json->'text',
          'turn',o.payload_json->'turn','ask',o.payload_json->'ask','at',o.created_at) ORDER BY o.id COLLATE "C")::text
          FROM folder_operations o WHERE o.target_kind='card' AND o.target_id=c.id AND o.operation_type='update_card_now'),'[]')) AS fp_now_history
      FROM cards c WHERE c.id=${cardId}
    `)[0];
    if (!row) throw httpError(404, "Card not found");
    return {
      card: {
        id: row.id, number: row.number, folder_id: row.folder_id, title: row.title, status: row.status,
        archived: row.archived, version: row.version, assignee_kind: row.assignee_kind,
        assignee_agent_id: row.assignee_agent_id, assignee_session_id: row.assignee_session_id,
        assignee_user_id: row.assignee_user_id, now: row.now, items: row.items,
        blocked_kind: row.blocked_kind, blocked_detail: row.blocked_detail,
      },
      available: {
        request: row.request_available, brief: row.brief_available, attachments: row.attachments_available,
        comments: row.comments_count, notes: row.notes_count, reports: row.reports_count,
        sessions: row.sessions_count, now_history: row.now_history_count,
      },
      fingerprints: {
        card: row.fp_card, request: row.fp_request, brief: row.fp_brief, attachments: row.fp_attachments,
        questions: row.fp_questions, questions_history: row.fp_questions_history, comments: row.fp_comments,
        notes: row.fp_notes, reports: row.fp_reports, sessions: row.fp_sessions,
        now_history: row.fp_now_history,
      },
    };
  }

  private async readRecordPage(limit: number, fetch: () => Promise<RecordCursorRow[]>): Promise<CardMcpSectionPage> {
    const rows = await fetch();
    const truncated = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      kind: "items",
      items: page.map(({ cursor_time: _time, cursor_id: _id, ...row }) => row),
      next: truncated && last ? { timestamp: last.cursor_time, id: last.cursor_id } : null,
      truncated,
    };
  }
}
