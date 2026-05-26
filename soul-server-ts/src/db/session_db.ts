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
 * 사용 안 함 (B-3 범위 외): event_search, viewport 등.
 */

import postgres from "postgres";

import type { TaskStatus } from "../task/task_models.js";
import { TaskTreeRepository } from "../task_tree/task_tree_repository.js";

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
  private taskTreeRepository?: TaskTreeRepository;

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

  /** Lightweight liveness probe for runtime reflection. */
  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  taskTree(): TaskTreeRepository {
    this.taskTreeRepository ??= new TaskTreeRepository(this.sql);
    return this.taskTreeRepository;
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
   * Startup repair: this process cannot resume in-memory tasks from a previous
   * process. Same-node DB rows left as running must become terminal before the
   * server accepts new traffic.
   */
  async interruptRunningSessionsForNode(nodeId: string): Promise<number> {
    const rows = await this.sql<Array<{ interrupted_count: string | number }>>`
      WITH updated AS (
        UPDATE sessions
        SET status = 'interrupted',
            was_running_at_shutdown = FALSE,
            updated_at = NOW()
        WHERE node_id = ${nodeId}
          AND status = 'running'
        RETURNING 1
      )
      SELECT COUNT(*) AS interrupted_count FROM updated
    `;
    return Number(rows[0]?.interrupted_count ?? 0);
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
   * Python `append_metadata` → `session_append_metadata` stored procedure 호출.
   *
   * caller_info 같은 세션 단위 metadata를 session_created 이전에 DB와 Task 양쪽에 맞춰
   * 박는 데 사용한다. stored proc은 metadata 배열 append와 metadata 이벤트 삽입을 원자적으로
   * 수행한다.
   */
  async appendMetadata(
    sessionId: string,
    entry: Record<string, unknown>,
  ): Promise<number> {
    const now = new Date();
    const entryJson = JSON.stringify([entry]);
    const searchable = `${String(entry.type ?? "")}: ${String(entry.value ?? "")} ${String(entry.label ?? "")}`;
    const eventPayload = JSON.stringify({
      type: "metadata",
      metadata_type: entry.type,
      value: entry.value,
      label: entry.label,
    });
    const rows = await this.sql<{ session_append_metadata: number }[]>`
      SELECT session_append_metadata(
        ${sessionId},
        ${entryJson},
        ${"metadata"},
        ${eventPayload},
        ${searchable},
        ${now}
      )
    `;
    return rows[0]?.session_append_metadata ?? 0;
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
   * folder_id로 단일 폴더 조회 (B-6 context_builder가 folder.settings.folderPrompt /
   * atomContextNode 추출에 사용).
   *
   * Python `PostgresSessionDB.get_folder` 정본
   * (`packages/soul-common/.../db/postgres/folders.py` get_folder). 본 PR은 schema에
   * `folder_get_by_id` stored proc이 없어 folders 테이블 직접 SELECT로 처리.
   *
   * 부재 시 null. settings 컬럼은 jsonb라 postgres.js가 자동 parse — Record로 반환.
   */
  async getFolderById(
    folderId: string,
  ): Promise<{ id: string; name: string; sort_order: number; settings: Record<string, unknown> } | null> {
    const rows = await this.sql<
      { id: string; name: string; sort_order: number; settings: unknown }[]
    >`SELECT id, name, sort_order, settings FROM folders WHERE id = ${folderId}`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      sort_order: row.sort_order,
      settings:
        row.settings && typeof row.settings === "object"
          ? (row.settings as Record<string, unknown>)
          : {},
    };
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

  // ---------------------------------------------------------------------
  // MCP cogito 도구용 신규 메서드 (본 카드 — Streamable HTTP MCP 패리티)
  // ---------------------------------------------------------------------

  /**
   * `session_rename` stored procedure (schema.sql L469-475) — 세션 표시 이름 갱신.
   *
   * Python `set_session_name` 도구 + `CatalogService.rename_session` 정본 경로 정합:
   *   CatalogService.renameSession → db.renameSession + broadcastCatalog().
   *
   * displayName이 null이면 이름 제거. trim·empty→null 정규화 책임은 *호출자*
   * (도구 핸들러 또는 CatalogService).
   */
  async renameSession(
    sessionId: string,
    displayName: string | null,
  ): Promise<void> {
    await this.sql`SELECT session_rename(${sessionId}, ${displayName})`;
  }

  /**
   * `session_list_summary` stored procedure (schema.sql L731-768) — 세션 경량 요약 페이지네이션.
   *
   * Python `session_query_service.list_sessions_summary` 정본 정합. session_type
   * 필터는 본 카드 도구에서 노출하지 않으므로 항상 null 전달 (모든 백엔드 통합).
   *
   * 반환: total은 결과 전체 행수(필터 적용 후), sessions는 limit/offset 적용 행.
   * total_count는 LATERAL subquery로 모든 행에 같은 값으로 박혀 나옴 — 첫 행에서 추출.
   */
  async listSessionsSummary(params: {
    search?: string | null;
    limit: number;
    offset: number;
    folderId?: string | null;
    nodeId?: string | null;
  }): Promise<{
    sessions: Array<{
      session_id: string;
      display_name: string | null;
      status: string | null;
      session_type: string | null;
      created_at: Date;
      updated_at: Date;
      event_count: number;
      away_summary: string | null;
      caller_session_id: string | null;
    }>;
    total: number;
  }> {
    const rows = await this.sql<
      Array<{
        session_id: string;
        display_name: string | null;
        status: string | null;
        session_type: string | null;
        created_at: Date;
        updated_at: Date;
        event_count: string | number;
        away_summary: string | null;
        caller_session_id: string | null;
        total_count: string | number;
      }>
    >`
      SELECT * FROM session_list_summary(
        ${params.search ?? null},
        ${null},
        ${params.limit},
        ${params.offset},
        ${params.folderId ?? null},
        ${params.nodeId ?? null}
      )
    `;
    const total = rows.length > 0 && rows[0] ? Number(rows[0].total_count) : 0;
    const sessions = rows.map((r) => ({
      session_id: r.session_id,
      display_name: r.display_name,
      status: r.status,
      session_type: r.session_type,
      created_at: r.created_at,
      updated_at: r.updated_at,
      event_count: Number(r.event_count),
      away_summary: r.away_summary,
      caller_session_id: r.caller_session_id,
    }));
    return { sessions, total };
  }

  /**
   * `folder_get_all` stored procedure (schema.sql L827-830) — 모든 폴더 행 그대로.
   *
   * Python `session_query_service.get_all_folders` 정본 정합. settings는 jsonb 자동 parse.
   * 본 메서드는 raw row를 그대로 반환하여 도구 핸들러가 wire 모양 결정.
   */
  async getAllFolders(): Promise<
    Array<{
      id: string;
      name: string;
      sort_order: number;
      settings: Record<string, unknown>;
    }>
  > {
    const rows = await this.sql<
      Array<{ id: string; name: string; sort_order: number; settings: unknown }>
    >`SELECT * FROM folder_get_all()`;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      sort_order: r.sort_order,
      settings:
        r.settings && typeof r.settings === "object"
          ? (r.settings as Record<string, unknown>)
          : {},
    }));
  }

  /**
   * `event_count` stored procedure (schema.sql L635-640) — 세션 이벤트 총 개수.
   */
  async countEvents(sessionId: string): Promise<number> {
    const rows = await this.sql<Array<{ event_count: string | number }>>`
      SELECT event_count(${sessionId}) AS event_count
    `;
    return Number(rows[0]?.event_count ?? 0);
  }

  /**
   * `event_read` stored procedure (schema.sql L580-601) — 페이지네이션 이벤트 조회.
   *
   * Python `db.read_events` 정본 정합. afterId 이후 events.id를 기준으로 limit개 반환.
   * eventTypes는 화이트리스트 필터 (null이면 전체).
   *
   * payload는 jsonb 자동 parse — Record로 반환.
   */
  async readEvents(
    sessionId: string,
    afterId: number,
    limit: number,
    eventTypes?: string[],
  ): Promise<
    Array<{
      id: number;
      session_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      searchable_text: string;
      created_at: Date;
    }>
  > {
    const types = eventTypes && eventTypes.length > 0 ? eventTypes : null;
    const rows = await this.sql<
      Array<{
        id: number;
        session_id: string;
        event_type: string;
        payload: unknown;
        searchable_text: string;
        created_at: Date;
      }>
    >`
      SELECT * FROM event_read(
        ${sessionId},
        ${afterId},
        ${limit},
        ${types as unknown as string[] | null}
      )
    `;
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      event_type: r.event_type,
      payload:
        r.payload && typeof r.payload === "object"
          ? (r.payload as Record<string, unknown>)
          : {},
      searchable_text: r.searchable_text,
      created_at: r.created_at,
    }));
  }

  /**
   * `event_read_one` stored procedure (schema.sql L603-618) — 단일 이벤트 전문.
   *
   * Python `db.read_one_event` 정본 정합. 부재 시 null.
   */
  async readOneEvent(
    sessionId: string,
    eventId: number,
  ): Promise<{
    id: number;
    session_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    searchable_text: string;
    created_at: Date;
  } | null> {
    const rows = await this.sql<
      Array<{
        id: number;
        session_id: string;
        event_type: string;
        payload: unknown;
        searchable_text: string;
        created_at: Date;
      }>
    >`
      SELECT * FROM event_read_one(${sessionId}, ${eventId})
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      session_id: row.session_id,
      event_type: row.event_type,
      payload:
        row.payload && typeof row.payload === "object"
          ? (row.payload as Record<string, unknown>)
          : {},
      searchable_text: row.searchable_text,
      created_at: row.created_at,
    };
  }

  /**
   * `event_stream_raw` stored procedure (schema.sql L620-633) — JSONL 다운로드용 raw 스트림.
   *
   * Python `db.stream_events_raw` 정본 정합. payload는 *문자열*로 반환 (jsonb::text).
   * 본 메서드는 download_session_history 도구가 파일에 line-by-line 직렬화하는 용도.
   *
   * 본 카드는 단일 fetch 후 array를 반환 (true streaming은 후속 — postgres.js cursor API
   * 사용 시 호출 패턴 복잡화. 본 카드 세션 크기는 메모리 적재 안전).
   */
  async streamEventsRaw(
    sessionId: string,
    afterId = 0,
  ): Promise<
    Array<{ id: number; event_type: string; payload_text: string }>
  > {
    const rows = await this.sql<
      Array<{ id: number; event_type: string; payload_text: string }>
    >`
      SELECT * FROM event_stream_raw(${sessionId}, ${afterId})
    `;
    return rows;
  }

  /**
   * `folder_create` stored procedure (schema.sql L771-777). id는 호출자가 발급.
   *
   * Python `catalog_service.create_folder`에서 uuid 발급 후 호출하는 패턴 정합.
   */
  async createFolder(id: string, name: string, sortOrder: number): Promise<void> {
    await this.sql`SELECT folder_create(${id}, ${name}, ${sortOrder})`;
  }

  /**
   * `folder_update` stored procedure (schema.sql L780-810). 화이트리스트:
   * `name`, `sort_order`, `settings`. settings는 JSON 문자열로 직렬화 (stored proc이 jsonb cast).
   */
  async updateFolder(
    folderId: string,
    columns: ReadonlyArray<"name" | "sort_order" | "settings">,
    values: ReadonlyArray<string>,
  ): Promise<void> {
    await this.sql`
      SELECT folder_update(
        ${folderId},
        ${this.sql.array(columns as unknown as string[])},
        ${this.sql.array(values as unknown as string[])}
      )
    `;
  }

  /**
   * `folder_delete` stored procedure (schema.sql L820-824).
   */
  async deleteFolderById(folderId: string): Promise<void> {
    await this.sql`SELECT folder_delete(${folderId})`;
  }

  /**
   * `event_search` stored procedure — BM25 ranked event search.
   *
   * Python `SessionSearchEngine`과 같은 `event_search` stored procedure 경로. PostgreSQL
   * `event_search_terms`에 저장된 term frequency를 사용하여 BM25 점수를 계산한다.
   *
   * 응답 모양은 Python 도구의 results dict와 키 호환 — 도구 핸들러가 preview/event_type/score
   * 키로 재포장.
   */
  async searchEvents(
    query: string,
    sessionIds: string[] | null,
    limit: number,
    eventTypes?: string[] | null,
  ): Promise<
    Array<{
      id: number;
      session_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      searchable_text: string;
      created_at: Date;
      score: number;
    }>
  > {
    const ids = sessionIds && sessionIds.length > 0 ? sessionIds : null;
    const types = eventTypes && eventTypes.length > 0 ? eventTypes : null;
    const rows = await this.sql<
      Array<{
        id: number;
        session_id: string;
        event_type: string;
        payload: unknown;
        searchable_text: string;
        created_at: Date;
        score: number;
      }>
    >`
      SELECT * FROM event_search(
        ${query},
        ${ids as unknown as string[] | null},
        ${limit},
        ${types as unknown as string[] | null}
      )
    `;
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      event_type: r.event_type,
      payload:
        r.payload && typeof r.payload === "object"
          ? (r.payload as Record<string, unknown>)
          : {},
      searchable_text: r.searchable_text,
      created_at: r.created_at,
      score: Number(r.score),
    }));
  }

  async searchEventsBySessionId(
    query: string,
    eventTypes: string[] | null,
    limit: number,
  ): Promise<
    Array<{
      id: number;
      session_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      searchable_text: string;
      created_at: Date;
      score: number;
    }>
  > {
    const types = eventTypes && eventTypes.length > 0 ? eventTypes : null;
    const rows = await this.sql<
      Array<{
        id: number;
        session_id: string;
        event_type: string;
        payload: unknown;
        searchable_text: string;
        created_at: Date;
        score: number;
      }>
    >`
      SELECT * FROM session_id_search(
        ${query},
        ${types as unknown as string[] | null},
        ${limit}
      )
    `;
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      event_type: r.event_type,
      payload:
        r.payload && typeof r.payload === "object"
          ? (r.payload as Record<string, unknown>)
          : {},
      searchable_text: r.searchable_text,
      created_at: r.created_at,
      score: Number(r.score),
    }));
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
