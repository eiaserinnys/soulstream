/**
 * SessionDB — postgres.js 기반 stored procedure 호출자 (Phase B-3).
 *
 * design-principles §3 정본 하나: Schema DDL 정본은 Python `soul-server/sql/schema.sql`.
 * TS는 *호출만* — DDL 발행 안 함, schema 변경 안 함. 운영 시 Python 서비스가 먼저
 * startup하며 schema apply → TS는 ready 후 connect.
 *
 * Python `soul_common.db.PostgresSessionDB`의 *최소 동작 등가*만 구현:
 *   - session_register (불변 필드 박기)
 *   - session_update (가변 필드, 화이트리스트 가드)
 *   - session_update_last_message
 *   - session_get
 *   - session_delete
 *   - event_append
 *
 * 사용 안 함 (B-3 범위 외): event_search, viewport, metadata_append 등.
 */

import postgres from "postgres";

import type { TaskStatus } from "../task/task_models.js";

export type SessionType = "claude" | "llm";

/**
 * Python `soul_common.db.session_db_base.DEFAULT_FOLDERS` 정본 (line 47-50). session_type별
 * 자동 배정 기본 폴더 이름. codex 백엔드의 task.session_type은 "claude"이므로 (task_models 코멘트
 * "컬럼 의미는 LLM proxy 분리용"), codex 세션도 같은 폴더로 폴백.
 */
export const DEFAULT_FOLDERS: Readonly<Record<string, string>> = Object.freeze({
  claude: "⚙️ 클로드 코드 세션",
  llm: "⚙️ LLM 세션",
});

/**
 * `session_update` stored procedure 화이트리스트 (schema.sql L257-262).
 *
 * 위반 키 포함 시 stored proc이 RAISE EXCEPTION — TS는 *진입 가드*로 같은 검증
 * 미리 수행하여 runtime 폭발을 *명시 throw*로 격상.
 */
const SESSION_UPDATE_ALLOWED = new Set([
  "folder_id",
  "display_name",
  "status",
  "prompt",
  "client_id",
  "last_message",
  "metadata",
  "was_running_at_shutdown",
  "last_event_id",
  "last_read_event_id",
]);

/** 화이트리스트 컬럼만 허용. 위반 시 진입 시점 throw. */
export interface SessionUpdateFields {
  folder_id?: string | null;
  display_name?: string | null;
  status?: TaskStatus;
  prompt?: string;
  client_id?: string | null;
  last_message?: LastMessageRow;
  metadata?: unknown[];
  was_running_at_shutdown?: boolean;
  last_event_id?: number;
  last_read_event_id?: number;
}

export interface LastMessageRow {
  type: string;
  preview: string;
  timestamp: string;
}

/** `session_get` 반환 행 (sessions 테이블 컬럼 매핑). */
export interface SessionRow {
  session_id: string;
  folder_id: string | null;
  display_name: string | null;
  node_id: string | null;
  session_type: string | null;
  status: string | null;
  prompt: string | null;
  client_id: string | null;
  claude_session_id: string | null;
  last_message: unknown;
  metadata: unknown;
  was_running_at_shutdown: boolean;
  last_event_id: number | null;
  last_read_event_id: number | null;
  created_at: Date;
  updated_at: Date;
  agent_id: string | null;
  caller_session_id: string | null;
  away_summary: string | null;
}

export interface RegisterSessionParams {
  sessionId: string;
  nodeId: string;
  agentId: string | null;
  /** Codex thread id (또는 claude session id — 컬럼 의미는 "backend session id"). */
  claudeSessionId: string | null;
  sessionType: SessionType;
  prompt: string;
  clientId: string | null;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  callerSessionId: string | null;
}

export interface AppendEventParams {
  sessionId: string;
  eventType: string;
  /** JSON-encoded payload string. */
  payload: string;
  searchableText: string;
  createdAt: Date;
}

/**
 * postgres.js 인스턴스를 외부에서 주입 가능하게 한 type alias.
 *
 * 테스트 시 fake sql 함수를 주입하여 stored proc 호출을 검증한다.
 * production은 `postgres(databaseUrl, options)`로 생성된 인스턴스.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlClient = postgres.Sql<any>;

export class SessionDB {
  private readonly sql: SqlClient;
  private readonly ownsSql: boolean;

  /**
   * @param sqlOrUrl `postgres()` 인스턴스 또는 DATABASE_URL 문자열.
   *                 문자열일 경우 본 클래스가 인스턴스 소유(close 시 end).
   */
  constructor(sqlOrUrl: SqlClient | string) {
    if (typeof sqlOrUrl === "string") {
      this.sql = postgres(sqlOrUrl, {
        max: 10,
        idle_timeout: 60,
      });
      this.ownsSql = true;
    } else {
      this.sql = sqlOrUrl;
      this.ownsSql = false;
    }
  }

  async close(): Promise<void> {
    if (this.ownsSql) {
      await this.sql.end({ timeout: 5 });
    }
  }

  /** Python `session_register` stored procedure 호출 (schema.sql L196-218). */
  async registerSession(params: RegisterSessionParams): Promise<void> {
    await this.sql`
      SELECT session_register(
        ${params.sessionId},
        ${params.nodeId},
        ${params.agentId},
        ${params.claudeSessionId},
        ${params.sessionType},
        ${params.prompt},
        ${params.clientId},
        ${params.status},
        ${params.createdAt},
        ${params.updatedAt},
        ${params.callerSessionId}
      )
    `;
  }

  /**
   * Python `session_update` stored procedure 호출 (schema.sql L249-299).
   *
   * 화이트리스트 가드 — 위반 키 포함 시 *진입 시점*에 throw.
   * stored proc의 RAISE EXCEPTION을 사전 차단 + 호출자에게 명확한 오류 신호.
   */
  async updateSession(
    sessionId: string,
    fields: SessionUpdateFields,
  ): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;

    const columns: string[] = [];
    const values: (string | null)[] = [];

    for (const [col, val] of entries) {
      if (!SESSION_UPDATE_ALLOWED.has(col)) {
        throw new Error(
          `SessionDB.updateSession: column "${col}" not in session_update whitelist`,
        );
      }
      columns.push(col);
      values.push(stringifyForStoredProc(col, val));
    }

    await this.sql`
      SELECT session_update(
        ${sessionId},
        ${this.sql.array(columns)},
        ${this.sql.array(values)},
        ${new Date()}
      )
    `;
  }

  /**
   * Codex thread id를 sessions.claude_session_id 컬럼에 영속화 (F-3B).
   *
   * Python `session_set_claude_id` stored procedure 호출 (schema.sql L220-247):
   *   - NULL → SET (최초 설정)
   *   - 같은 값 → no-op (idempotent, 재시작·재진입 안전)
   *   - 다른 값 → RAISE EXCEPTION (claude_session_id immutability violation)
   *
   * 호출자(task_executor)는 `!task.codexThreadId` 메모리 가드로 통상 1회만 호출하지만,
   * stored proc 자체가 idempotent하므로 race에도 안전.
   */
  async setClaudeSessionId(
    sessionId: string,
    claudeSessionId: string,
  ): Promise<void> {
    await this.sql`
      SELECT session_set_claude_id(${sessionId}, ${claudeSessionId})
    `;
  }

  /** Python `session_update_last_message` stored procedure 호출 (schema.sql L435-443). */
  async updateLastMessage(
    sessionId: string,
    lastMessage: LastMessageRow,
  ): Promise<void> {
    await this.sql`
      SELECT session_update_last_message(
        ${sessionId},
        ${JSON.stringify(lastMessage)},
        ${new Date()}
      )
    `;
  }

  /** Python `session_get` (schema.sql L302-306). null = 부재. */
  async getSession(sessionId: string): Promise<SessionRow | null> {
    const rows = await this.sql<SessionRow[]>`
      SELECT * FROM session_get(${sessionId})
    `;
    return rows[0] ?? null;
  }

  /** Python `session_delete` (schema.sql L389-394). */
  async deleteSession(sessionId: string): Promise<void> {
    await this.sql`SELECT session_delete(${sessionId})`;
  }

  /**
   * 세션을 폴더에 배정 (Python `db.assign_session_to_folder` 정본,
   * `packages/soul-common/.../db/postgres/folders.py:114-120`).
   *
   * Python stored proc `session_assign_folder` (schema.sql L477-483) 호출:
   * `UPDATE sessions SET folder_id = p_folder_id WHERE session_id = p_session_id`.
   *
   * folderId=null → folder_id 컬럼을 NULL로 설정 (폴더 해제).
   *
   * Codex 세션 폴더 배정 누락 사고 회로 차단 — task_manager.createTask 직후 호출.
   */
  async assignSessionToFolder(
    sessionId: string,
    folderId: string | null,
  ): Promise<void> {
    await this.sql`
      SELECT session_assign_folder(${sessionId}, ${folderId})
    `;
  }

  /**
   * 이름으로 폴더 조회 (Python `db.get_default_folder` 정본,
   * `packages/soul-common/.../db/postgres/folders.py:93-97`).
   *
   * Python stored proc `folder_get_default(p_name TEXT) → SETOF folders` (schema.sql L833-838).
   * 0 또는 1 행 반환. 부재 시 null.
   */
  async getDefaultFolder(name: string): Promise<{ id: string; name: string } | null> {
    const rows = await this.sql<{ id: string; name: string }[]>`
      SELECT * FROM folder_get_default(${name})
    `;
    return rows[0] ?? null;
  }

  /**
   * 전체 카탈로그(폴더 + 세션) 조회 (Python `db.get_catalog` 정본,
   * `packages/soul-common/.../db/postgres/folders.py:128-150`).
   *
   * folders + sessions 두 stored proc 결과를 합쳐 `catalog_updated` wire envelope의
   * `catalog` 필드 형상으로 반환.
   */
  async getCatalog(): Promise<{
    folders: Array<{ id: string; name: string; sortOrder: number; settings: Record<string, unknown> }>;
    sessions: Record<string, { folderId: string | null; displayName: string | null }>;
  }> {
    const folderRows = await this.sql<
      { id: string; name: string; sort_order: number; settings: unknown }[]
    >`SELECT * FROM folder_get_all()`;
    const folders = folderRows.map((f) => ({
      id: f.id,
      name: f.name,
      sortOrder: f.sort_order,
      settings: (typeof f.settings === "object" && f.settings !== null
        ? (f.settings as Record<string, unknown>)
        : {}),
    }));

    const sessionRows = await this.sql<
      { session_id: string; folder_id: string | null; display_name: string | null }[]
    >`SELECT * FROM catalog_get_sessions()`;
    const sessions: Record<string, { folderId: string | null; displayName: string | null }> = {};
    for (const r of sessionRows) {
      sessions[r.session_id] = {
        folderId: r.folder_id,
        displayName: r.display_name,
      };
    }

    return { folders, sessions };
  }

  /**
   * Python `event_append` (schema.sql L537-578) — 이벤트 INSERT + last_event_id 갱신.
   *
   * 반환: 새 events.id (1-based, session 안에서 단조 증가).
   */
  async appendEvent(params: AppendEventParams): Promise<number> {
    const rows = await this.sql<{ event_append: number }[]>`
      SELECT event_append(
        ${params.sessionId},
        ${params.eventType},
        ${params.payload},
        ${params.searchableText},
        ${params.createdAt}
      ) AS event_append
    `;
    const id = rows[0]?.event_append;
    if (typeof id !== "number") {
      throw new Error(
        `event_append returned non-number: ${JSON.stringify(rows[0])}`,
      );
    }
    return id;
  }
}

/**
 * stored proc은 모든 컬럼을 TEXT[]로 받음 — JSON·boolean·integer 변환 책임은 호출자.
 *
 * jsonb_cols: last_message, metadata → JSON.stringify
 * bool_cols: was_running_at_shutdown → 'true'/'false'
 * int_cols: last_event_id, last_read_event_id → String(num)
 * 나머지: 그대로 String(val) (status, prompt 등)
 */
function stringifyForStoredProc(col: string, val: unknown): string | null {
  if (val === null) return null;
  if (col === "last_message" || col === "metadata") {
    return JSON.stringify(val);
  }
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  return String(val);
}
