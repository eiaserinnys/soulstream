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

import { DEFAULT_FOLDERS as SYSTEM_DEFAULT_FOLDERS } from "../system_folders.js";
import type { TaskStatus } from "../task/task_models.js";
import type { TerminationReason } from "../task/task_models.js";
import { SoulstreamScheduleRepository } from "../schedule/schedule_repository.js";
import { TaskTreeRepository } from "../task_tree/task_tree_repository.js";
import {
  getFolderIdFromBoardYjsDocumentName,
} from "../collaboration/board_yjs_model.js";
import type { SupervisorWakeDispatchState } from "../supervisor/wake_dispatch_state.js";
import {
  MarkdownDocumentVersionConflictError,
  normalizeMarkdownVersion,
} from "./markdown_document_version.js";

export type SessionType = "claude" | "llm";

/**
 * 표시 이름 하위 호환 export. 기본 폴더 식별 정본은 system_folders.ts의 id 상수다.
 */
export const DEFAULT_FOLDERS = SYSTEM_DEFAULT_FOLDERS;

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
  "termination_reason",
  "termination_detail",
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
  termination_reason?: TerminationReason | null;
  termination_detail?: string | null;
}

export interface LastMessageRow {
  type: string;
  preview: string;
  timestamp: string;
}

export interface FolderRow {
  id: string;
  name: string;
  sort_order: number;
  settings: Record<string, unknown>;
  parent_folder_id: string | null;
  created_at?: Date | string;
}

export interface CatalogFolderRow {
  id: string;
  name: string;
  sortOrder: number;
  settings: Record<string, unknown>;
  parentFolderId: string | null;
  createdAt?: string;
}

export type BoardItemType = "session" | "markdown" | "subfolder" | "asset";

export interface CatalogBoardItemRow {
  id: string;
  folderId: string;
  itemType: BoardItemType;
  itemId: string;
  x: number;
  y: number;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface MarkdownDocumentRow {
  id: string;
  title: string;
  body: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface BoardYjsSeed {
  boardItems: CatalogBoardItemRow[];
  markdownDocuments: MarkdownDocumentRow[];
}

export interface BoardYjsReplica {
  boardItems: CatalogBoardItemRow[];
  markdownDocuments: MarkdownDocumentRow[];
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
  termination_reason: string | null;
  termination_detail: string | null;
}

export interface RunningSessionSummaryRow {
  session_id: string;
  display_name: string | null;
  node_id: string | null;
  folder_id: string | null;
  folder_name: string | null;
  updated_at: Date;
}

export interface ListSessionSummaryRow {
  session_id: string;
  display_name: string | null;
  status: string | null;
  session_type: string | null;
  created_at: Date;
  updated_at: Date;
  event_count: number;
  away_summary: string | null;
  caller_session_id: string | null;
  last_event_id: number | null;
  last_read_event_id: number | null;
  node_id: string | null;
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

export interface AppendSupervisorEventParams {
  sourceNode: string;
  sourceSessionId: string;
  sourceEventId: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface SupervisorAppendResult {
  offset: number;
  inserted: boolean;
  contiguousUpto: number;
  highestSeenEventId: number;
  gapStart: number | null;
  gapEnd: number | null;
}

export interface SupervisorEventRow {
  offset: number;
  sourceNode: string;
  sourceSessionId: string;
  sourceEventId: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  insertedAt: Date;
}

export interface SupervisorSourceCursorRow {
  sourceNode: string;
  sourceSessionId: string;
  contiguousUpto: number;
  highestSeenEventId: number;
  gapStart: number | null;
  gapEnd: number | null;
  updatedAt: Date;
}

export interface SupervisorRegistryUpsertParams {
  role: string;
  activeSessionId: string | null;
  epoch: number;
  cursorOffset: number;
  handoverState: string;
  cumulativeTokens: number;
  compactionCount: number;
  lastSeenAt: Date | null;
}

export interface SupervisorRegistryRow extends SupervisorRegistryUpsertParams {
  wakeDispatchState?: SupervisorWakeDispatchState;
  wakeLastSignature?: string | null;
  wakeRepeatCount?: number;
  wakeBlockedReason?: string | null;
  wakeBlockedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupervisorWakeDispatchStateParams {
  role: string;
  state: SupervisorWakeDispatchState;
  lastSignature?: string | null;
  repeatCount: number;
  blockedReason?: string | null;
  blockedAt?: Date | null;
}

export interface ClaudeTranscriptKey {
  projectKey: string;
  sessionId: string;
  subpath?: string | null;
}

export type ClaudeTranscriptEntry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  [k: string]: unknown;
};

export interface ClaudeTranscriptSessionSummary {
  sessionId: string;
  mtime: number;
}

/**
 * postgres.js 인스턴스를 외부에서 주입 가능하게 한 type alias.
 *
 * 테스트 시 fake sql 함수를 주입하여 stored proc 호출을 검증한다.
 * production은 `postgres(databaseUrl, options)`로 생성된 인스턴스.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlClient = postgres.Sql<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReplicaSyncSql = postgres.Sql<any> | postgres.TransactionSql<any>;
type PostgresJsonValue = Parameters<ReplicaSyncSql["json"]>[0];
const BOARD_ITEMS_ADVISORY_LOCK_KEY = "soulstream:board_items";

function asPostgresJsonValue(value: unknown): PostgresJsonValue {
  return value as PostgresJsonValue;
}

function numberFromDb(value: string | number | null | undefined, field: string): number {
  if (value === null || value === undefined) {
    throw new Error(`${field} returned null`);
  }
  return Number(value);
}

function recordFromDb(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function mapSupervisorAppendRow(row: {
  offset: string | number;
  inserted: boolean;
  contiguous_upto: string | number;
  highest_seen_event_id: string | number;
  gap_start: string | number | null;
  gap_end: string | number | null;
}): SupervisorAppendResult {
  return {
    offset: numberFromDb(row.offset, "supervisor_event_append.offset"),
    inserted: row.inserted,
    contiguousUpto: numberFromDb(row.contiguous_upto, "supervisor_event_append.contiguous_upto"),
    highestSeenEventId: numberFromDb(
      row.highest_seen_event_id,
      "supervisor_event_append.highest_seen_event_id",
    ),
    gapStart: row.gap_start === null ? null : numberFromDb(row.gap_start, "supervisor_event_append.gap_start"),
    gapEnd: row.gap_end === null ? null : numberFromDb(row.gap_end, "supervisor_event_append.gap_end"),
  };
}

function mapSupervisorSourceCursorRow(row: {
  source_node: string;
  source_session_id: string;
  contiguous_upto: string | number;
  highest_seen_event_id: string | number;
  gap_start: string | number | null;
  gap_end: string | number | null;
  updated_at: Date;
}): SupervisorSourceCursorRow {
  return {
    sourceNode: row.source_node,
    sourceSessionId: row.source_session_id,
    contiguousUpto: numberFromDb(row.contiguous_upto, "supervisor_source_cursor.contiguous_upto"),
    highestSeenEventId: numberFromDb(
      row.highest_seen_event_id,
      "supervisor_source_cursor.highest_seen_event_id",
    ),
    gapStart: row.gap_start === null ? null : numberFromDb(row.gap_start, "supervisor_source_cursor.gap_start"),
    gapEnd: row.gap_end === null ? null : numberFromDb(row.gap_end, "supervisor_source_cursor.gap_end"),
    updatedAt: row.updated_at,
  };
}

function mapSupervisorRegistryRow(row: {
  role: string;
  active_session_id: string | null;
  epoch: string | number;
  cursor_offset: string | number;
  handover_state: string;
  cumulative_tokens: string | number;
  compaction_count: string | number;
  last_seen_at: Date | null;
  wake_dispatch_state?: string | null;
  wake_last_signature?: string | null;
  wake_repeat_count?: string | number | null;
  wake_blocked_reason?: string | null;
  wake_blocked_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}): SupervisorRegistryRow {
  return {
    role: row.role,
    activeSessionId: row.active_session_id,
    epoch: numberFromDb(row.epoch, "supervisor_registry.epoch"),
    cursorOffset: numberFromDb(row.cursor_offset, "supervisor_registry.cursor_offset"),
    handoverState: row.handover_state,
    cumulativeTokens: numberFromDb(row.cumulative_tokens, "supervisor_registry.cumulative_tokens"),
    compactionCount: numberFromDb(row.compaction_count, "supervisor_registry.compaction_count"),
    lastSeenAt: row.last_seen_at,
    wakeDispatchState: normalizeSupervisorWakeDispatchState(row.wake_dispatch_state),
    wakeLastSignature: row.wake_last_signature ?? null,
    wakeRepeatCount: numberFromDb(
      row.wake_repeat_count ?? 0,
      "supervisor_registry.wake_repeat_count",
    ),
    wakeBlockedReason: row.wake_blocked_reason ?? null,
    wakeBlockedAt: row.wake_blocked_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSupervisorWakeDispatchState(
  state: string | null | undefined,
): SupervisorWakeDispatchState {
  if (state === "retrying" || state === "blocked") return state;
  return "active";
}

export class SessionDB {
  private readonly sql: SqlClient;
  private readonly ownsSql: boolean;
  private taskTreeRepository?: TaskTreeRepository;
  private scheduleRepository?: SoulstreamScheduleRepository;
  private readonly boardYjsCatalogCache = new Map<string, CatalogBoardItemRow[]>();

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

  schedules(): SoulstreamScheduleRepository {
    this.scheduleRepository ??= new SoulstreamScheduleRepository(this.sql);
    return this.scheduleRepository;
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
            termination_reason = 'unknown',
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
  ): Promise<FolderRow | null> {
    const rows = await this.sql<
      { id: string; name: string; sort_order: number; settings: unknown; parent_folder_id: string | null; created_at: Date | string }[]
    >`SELECT id, name, sort_order, settings, parent_folder_id, created_at FROM folders WHERE id = ${folderId}`;
    const row = rows[0];
    if (!row) return null;
    const createdAt = row.created_at ? { created_at: row.created_at } : {};
    return {
      id: row.id,
      name: row.name,
      sort_order: row.sort_order,
      parent_folder_id: row.parent_folder_id,
      ...createdAt,
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
    folders: CatalogFolderRow[];
    sessions: Record<string, { folderId: string | null; displayName: string | null }>;
    boardItems: CatalogBoardItemRow[];
  }> {
    // Catalog reads stay read-only: cache first, legacy board_items read fallback only.
    const folderRows = await this.sql<
      { id: string; name: string; sort_order: number; settings: unknown; parent_folder_id: string | null; created_at: Date | string | null }[]
    >`SELECT * FROM folder_get_all()`;
    const folders = folderRows.map((f) => {
      const createdAt = toIsoString(f.created_at);
      return {
        id: f.id,
        name: f.name,
        sortOrder: f.sort_order,
        parentFolderId: f.parent_folder_id,
        ...(createdAt ? { createdAt } : {}),
        settings: (typeof f.settings === "object" && f.settings !== null
          ? (f.settings as Record<string, unknown>)
          : {}),
      };
    });

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

    const boardItems = await this.getCatalogBoardItemsForCatalog(folders);

    return { folders, sessions, boardItems };
  }

  invalidateBoardYjsCatalogCache(folderId?: string | null): void {
    if (folderId) {
      this.boardYjsCatalogCache.delete(folderId);
      return;
    }
    this.boardYjsCatalogCache.clear();
  }

  private async getCatalogBoardItemsForCatalog(
    folders: readonly CatalogFolderRow[],
  ): Promise<CatalogBoardItemRow[]> {
    const folderIds = folders.map((folder) => folder.id);
    if (folderIds.length === 0) return [];

    const cachedRows = await this.sql<
      Array<{ folder_id: string; board_items: unknown }>
    >`
      SELECT folder_id, board_items
      FROM board_yjs_catalog_cache
      WHERE folder_id = ANY(${this.sql.array(folderIds)})
    `;
    const result: CatalogBoardItemRow[] = [];
    const cachedFolderIds = new Set<string>();
    for (const row of cachedRows) {
      cachedFolderIds.add(row.folder_id);
      result.push(...parseCatalogBoardItems(row.board_items));
    }

    const missingFolderIds = folderIds.filter((folderId) => !cachedFolderIds.has(folderId));
    if (missingFolderIds.length > 0) {
      const legacyRows = await this.sql<
        Array<{
          id: string;
          folder_id: string;
          item_type: BoardItemType;
          item_id: string;
          x: string | number;
          y: string | number;
          metadata: unknown;
          created_at: Date | string | null;
          updated_at: Date | string | null;
        }>
      >`
        SELECT *
        FROM board_items
        WHERE folder_id = ANY(${this.sql.array(missingFolderIds)})
      `;
      result.push(...legacyRows.map(toCatalogBoardItemRow));
    }

    return result.sort((a, b) => (
      a.folderId.localeCompare(b.folderId) ||
      a.y - b.y ||
      a.x - b.x ||
      a.id.localeCompare(b.id)
    ));
  }

  async ensureBoardItems(): Promise<void> {
    await this.sql`SELECT board_seed_items()`;
  }

  async getBoardItems(): Promise<CatalogBoardItemRow[]> {
    // Legacy seed/read-replica access. getCatalog uses direct read fallback only.
    const rows = await this.sql<
      Array<{
        id: string;
        folder_id: string;
        item_type: BoardItemType;
        item_id: string;
        x: string | number;
        y: string | number;
        metadata: unknown;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }>
    >`SELECT * FROM board_item_get_all()`;
    return rows.map(toCatalogBoardItemRow);
  }

  async getBoardItemById(boardItemId: string): Promise<CatalogBoardItemRow | null> {
    const rows = await this.sql<
      Array<{
        id: string;
        folder_id: string;
        item_type: BoardItemType;
        item_id: string;
        x: string | number;
        y: string | number;
        metadata: unknown;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }>
    >`
      SELECT *
      FROM board_items
      WHERE id = ${boardItemId}
      LIMIT 1
    `;
    return rows[0] ? toCatalogBoardItemRow(rows[0]) : null;
  }

  async getMarkdownDocumentBoardItem(documentId: string): Promise<CatalogBoardItemRow | null> {
    const rows = await this.sql<
      Array<{
        id: string;
        folder_id: string;
        item_type: BoardItemType;
        item_id: string;
        x: string | number;
        y: string | number;
        metadata: unknown;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }>
    >`
      SELECT *
      FROM board_items
      WHERE item_type = ${"markdown"}
        AND item_id = ${documentId}
      LIMIT 1
    `;
    return rows[0] ? toCatalogBoardItemRow(rows[0]) : null;
  }

  async updateBoardItemPosition(
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

  async createMarkdownDocument(params: {
    documentId: string;
    folderId: string;
    title: string;
    body: string;
    x: number;
    y: number;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
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
        INSERT INTO board_items (id, folder_id, item_type, item_id, x, y)
        VALUES (${"markdown:" + params.documentId}, ${params.folderId}, ${"markdown"}, ${params.documentId}, ${params.x}, ${params.y})
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

  async getBoardYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    const rows = await this.sql<Array<{ snapshot: Buffer | Uint8Array }>>`
      SELECT snapshot FROM board_yjs_documents WHERE name = ${documentName}
    `;
    const snapshot = rows[0]?.snapshot;
    return snapshot ? new Uint8Array(snapshot) : null;
  }

  async storeBoardYjsSnapshot(
    documentName: string,
    snapshot: Uint8Array,
  ): Promise<void> {
    await this.sql`
      INSERT INTO board_yjs_documents (name, snapshot, updated_at)
      VALUES (${documentName}, ${Buffer.from(snapshot)}, NOW())
      ON CONFLICT (name) DO UPDATE
      SET snapshot = EXCLUDED.snapshot,
          updated_at = EXCLUDED.updated_at
    `;
    this.invalidateBoardYjsCatalogCache(
      getFolderIdFromBoardYjsDocumentName(documentName),
    );
  }

  async appendBoardYjsUpdate(
    documentName: string,
    update: Uint8Array,
  ): Promise<void> {
    await this.sql`
      INSERT INTO board_yjs_documents (name, snapshot)
      VALUES (${documentName}, ${Buffer.alloc(0)})
      ON CONFLICT (name) DO NOTHING
    `;
    await this.sql`
      INSERT INTO board_yjs_updates (document_name, update)
      VALUES (${documentName}, ${Buffer.from(update)})
    `;
    this.invalidateBoardYjsCatalogCache(
      getFolderIdFromBoardYjsDocumentName(documentName),
    );
  }

  async getBoardYjsUpdates(documentName: string): Promise<Uint8Array[]> {
    const rows = await this.sql<Array<{ update: Buffer | Uint8Array }>>`
      SELECT update FROM board_yjs_updates
      WHERE document_name = ${documentName}
      ORDER BY id ASC
    `;
    return rows.map((row) => new Uint8Array(row.update));
  }

  async loadBoardYjsSeed(folderId: string): Promise<BoardYjsSeed> {
    // One-time migration seed from the pre-Yjs board_items replica.
    await this.ensureBoardItems();
    const boardItems = (await this.getBoardItems()).filter((item) => item.folderId === folderId);
    const markdownIds = boardItems
      .filter((item) => item.itemType === "markdown")
      .map((item) => item.itemId);
    if (markdownIds.length === 0) {
      return { boardItems, markdownDocuments: [] };
    }
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
      SELECT * FROM markdown_documents WHERE id = ANY(${this.sql.array(markdownIds)})
    `;
    return {
      boardItems,
      markdownDocuments: rows.map(toMarkdownDocumentRow),
    };
  }

  async syncBoardYjsReplica(
    folderId: string,
    replica: BoardYjsReplica,
  ): Promise<void> {
    this.invalidateBoardYjsCatalogCache(folderId);
    await this.sql.begin(async (sql) => {
      await this.syncBoardYjsReplicaWithSql(sql, folderId, replica);
    });
  }

  private async syncBoardYjsReplicaWithSql(
    sql: ReplicaSyncSql,
    folderId: string,
    replica: BoardYjsReplica,
  ): Promise<void> {
    await this.lockBoardItemsReplica(sql);

    const boardItemIds = replica.boardItems.map((item) => item.id);
    if (boardItemIds.length === 0) {
      await sql`DELETE FROM board_items WHERE folder_id = ${folderId}`;
    } else {
      await sql`
        DELETE FROM board_items
        WHERE folder_id = ${folderId}
          AND id <> ALL(${sql.array(boardItemIds)})
      `;
    }

    for (const item of replica.boardItems) {
      await sql`
        INSERT INTO board_items (id, folder_id, item_type, item_id, x, y, metadata, updated_at)
        VALUES (
          ${item.id},
          ${folderId},
          ${item.itemType},
          ${item.itemId},
          ${item.x},
          ${item.y},
          ${sql.json(asPostgresJsonValue(item.metadata ?? {}))}::jsonb,
          NOW()
        )
        ON CONFLICT (id) DO UPDATE
        SET folder_id = EXCLUDED.folder_id,
            item_type = EXCLUDED.item_type,
            item_id = EXCLUDED.item_id,
            x = EXCLUDED.x,
            y = EXCLUDED.y,
            metadata = EXCLUDED.metadata,
            updated_at = EXCLUDED.updated_at
      `;
    }

    for (const document of replica.markdownDocuments) {
      await sql`
        INSERT INTO markdown_documents (id, title, body, version, updated_at)
        VALUES (${document.id}, ${document.title}, ${document.body}, ${document.version}, NOW())
        ON CONFLICT (id) DO UPDATE
        SET title = EXCLUDED.title,
            body = EXCLUDED.body,
            version = EXCLUDED.version,
            updated_at = EXCLUDED.updated_at
      `;
    }

    await sql`
      INSERT INTO board_yjs_catalog_cache (folder_id, board_items, markdown_documents, updated_at)
      VALUES (
        ${folderId},
        ${sql.json(asPostgresJsonValue(replica.boardItems))}::jsonb,
        ${sql.json(asPostgresJsonValue(replica.markdownDocuments))}::jsonb,
        NOW()
      )
      ON CONFLICT (folder_id) DO UPDATE
      SET board_items = EXCLUDED.board_items,
          markdown_documents = EXCLUDED.markdown_documents,
          updated_at = EXCLUDED.updated_at
    `;
  }

  private async lockBoardItemsReplica(sql: ReplicaSyncSql): Promise<void> {
    await sql`
      SELECT pg_advisory_xact_lock(hashtext(${BOARD_ITEMS_ADVISORY_LOCK_KEY})::bigint)
    `;
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
    sessions: ListSessionSummaryRow[];
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
        last_event_id: string | number | null;
        last_read_event_id: string | number | null;
        node_id: string | null;
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
      last_event_id: r.last_event_id == null ? null : Number(r.last_event_id),
      last_read_event_id:
        r.last_read_event_id == null ? null : Number(r.last_read_event_id),
      node_id: r.node_id,
    }));
    return { sessions, total };
  }

  /**
   * Context builder용 running 세션 경량 조회.
   *
   * 클러스터 공유 sessions 테이블을 updated_at DESC로 읽는다. cross-node HTTP wire에
   * 의존하지 않으므로 노드 간 wire 실패가 context 조립 전체로 번지지 않는다.
   */
  async listRunningSessionsSummary(params: {
    limit: number;
    excludeSessionId?: string | null;
  }): Promise<{
    sessions: RunningSessionSummaryRow[];
    total: number;
  }> {
    const rows = await this.sql<
      Array<{
        session_id: string;
        display_name: string | null;
        node_id: string | null;
        folder_id: string | null;
        folder_name: string | null;
        updated_at: Date;
        total_count: string | number;
      }>
    >`
      WITH filtered AS (
        SELECT
          s.session_id,
          s.display_name,
          s.node_id,
          s.folder_id,
          f.name AS folder_name,
          s.updated_at
        FROM sessions s
        LEFT JOIN folders f ON f.id = s.folder_id
        WHERE s.status = 'running'
          AND (
            ${params.excludeSessionId ?? null}::text IS NULL
            OR s.session_id <> ${params.excludeSessionId ?? null}
          )
        ORDER BY s.updated_at DESC
      )
      SELECT f.*, (SELECT COUNT(*) FROM filtered)::BIGINT AS total_count
      FROM filtered f
      LIMIT ${params.limit}
    `;
    const total = rows.length > 0 && rows[0] ? Number(rows[0].total_count) : 0;
    return {
      sessions: rows.map((r) => ({
        session_id: r.session_id,
        display_name: r.display_name,
        node_id: r.node_id,
        folder_id: r.folder_id,
        folder_name: r.folder_name,
        updated_at: r.updated_at,
      })),
      total,
    };
  }

  /**
   * `folder_get_all` stored procedure (schema.sql L827-830) — 모든 폴더 행 그대로.
   *
   * Python `session_query_service.get_all_folders` 정본 정합. settings는 jsonb 자동 parse.
   * 본 메서드는 raw row를 그대로 반환하여 도구 핸들러가 wire 모양 결정.
   */
  async getAllFolders(): Promise<
    FolderRow[]
  > {
    const rows = await this.sql<
      Array<{ id: string; name: string; sort_order: number; settings: unknown; parent_folder_id: string | null; created_at: Date | string | null }>
    >`SELECT * FROM folder_get_all()`;
    return rows.map((r) => {
      const createdAt = r.created_at ? { created_at: r.created_at } : {};
      return {
        id: r.id,
        name: r.name,
        sort_order: r.sort_order,
        parent_folder_id: r.parent_folder_id,
        ...createdAt,
        settings:
          r.settings && typeof r.settings === "object"
            ? (r.settings as Record<string, unknown>)
            : {},
      };
    });
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
    parent_event_id: number | null;
    payload: Record<string, unknown>;
    searchable_text: string;
    created_at: Date;
  } | null> {
    const rows = await this.sql<
      Array<{
        id: number;
        session_id: string;
        event_type: string;
        parent_event_id: number | null;
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
      parent_event_id: row.parent_event_id,
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
  async createFolder(
    id: string,
    name: string,
    sortOrder: number,
    parentFolderId: string | null = null,
  ): Promise<void> {
    await this.sql`SELECT folder_create(${id}, ${name}, ${sortOrder}, ${parentFolderId})`;
  }

  /**
   * `folder_update` stored procedure (schema.sql L780-810). 화이트리스트:
   * `name`, `sort_order`, `settings`. settings는 JSON 문자열로 직렬화 (stored proc이 jsonb cast).
   */
  async updateFolder(
    folderId: string,
    columns: ReadonlyArray<"name" | "sort_order" | "settings" | "parent_folder_id">,
    values: ReadonlyArray<string | null>,
  ): Promise<void> {
    await this.sql`
      SELECT folder_update(
        ${folderId},
        ${this.sql.array(columns as unknown as string[])},
        ${this.sql.array(values as unknown as (string | null)[])}
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

  async appendSupervisorEvent(
    params: AppendSupervisorEventParams,
  ): Promise<SupervisorAppendResult> {
    const rows = await this.sql<
      Array<{
        offset: string | number;
        inserted: boolean;
        contiguous_upto: string | number;
        highest_seen_event_id: string | number;
        gap_start: string | number | null;
        gap_end: string | number | null;
      }>
    >`
      SELECT * FROM supervisor_event_append(
        ${params.sourceNode},
        ${params.sourceSessionId},
        ${params.sourceEventId},
        ${params.eventType},
        ${JSON.stringify(params.payload)},
        ${params.createdAt}
      )
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("supervisor_event_append returned no row");
    }
    return mapSupervisorAppendRow(row);
  }

  async readSupervisorEventsAfter(
    afterOffset = 0,
    limit = 100,
  ): Promise<SupervisorEventRow[]> {
    const rows = await this.sql<
      Array<{
        offset: string | number;
        source_node: string;
        source_session_id: string;
        source_event_id: string | number;
        event_type: string;
        payload: unknown;
        created_at: Date;
        inserted_at: Date;
      }>
    >`
      SELECT * FROM supervisor_event_read_after(${afterOffset}, ${limit})
    `;
    return rows.map((row) => ({
      offset: numberFromDb(row.offset, "supervisor_events.offset"),
      sourceNode: row.source_node,
      sourceSessionId: row.source_session_id,
      sourceEventId: numberFromDb(row.source_event_id, "supervisor_events.source_event_id"),
      eventType: row.event_type,
      payload: recordFromDb(row.payload),
      createdAt: row.created_at,
      insertedAt: row.inserted_at,
    }));
  }

  async getSupervisorEventHeadOffset(): Promise<number> {
    const rows = await this.sql<Array<{ head: string | number | null }>>`
      SELECT COALESCE(MAX(offset), 0) AS head FROM supervisor_events
    `;
    return rows[0]?.head == null
      ? 0
      : numberFromDb(rows[0].head, "supervisor_events.head");
  }

  async getSupervisorSourceCursor(
    sourceNode: string,
    sourceSessionId: string,
  ): Promise<SupervisorSourceCursorRow | null> {
    const rows = await this.sql<
      Array<{
        source_node: string;
        source_session_id: string;
        contiguous_upto: string | number;
        highest_seen_event_id: string | number;
        gap_start: string | number | null;
        gap_end: string | number | null;
        updated_at: Date;
      }>
    >`
      SELECT * FROM supervisor_source_cursor_get(${sourceNode}, ${sourceSessionId})
    `;
    const row = rows[0];
    return row ? mapSupervisorSourceCursorRow(row) : null;
  }

  async setSupervisorSourceCursor(params: {
    sourceNode: string;
    sourceSessionId: string;
    contiguousUpto: number;
    highestSeenEventId: number;
    gapStart?: number | null;
    gapEnd?: number | null;
  }): Promise<SupervisorSourceCursorRow> {
    const rows = await this.sql<
      Array<{
        source_node: string;
        source_session_id: string;
        contiguous_upto: string | number;
        highest_seen_event_id: string | number;
        gap_start: string | number | null;
        gap_end: string | number | null;
        updated_at: Date;
      }>
    >`
      SELECT * FROM supervisor_source_cursor_set(
        ${params.sourceNode},
        ${params.sourceSessionId},
        ${params.contiguousUpto},
        ${params.highestSeenEventId},
        ${params.gapStart ?? null},
        ${params.gapEnd ?? null}
      )
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("supervisor_source_cursor_set returned no row");
    }
    return mapSupervisorSourceCursorRow(row);
  }

  async getSupervisorConsumerCursor(supervisorId: string): Promise<number> {
    const rows = await this.sql<
      Array<{ supervisor_consumer_cursor_get: string | number }>
    >`
      SELECT supervisor_consumer_cursor_get(${supervisorId}) AS supervisor_consumer_cursor_get
    `;
    return Number(rows[0]?.supervisor_consumer_cursor_get ?? 0);
  }

  async setSupervisorConsumerCursor(
    supervisorId: string,
    cursorOffset: number,
  ): Promise<number> {
    const rows = await this.sql<
      Array<{ supervisor_consumer_cursor_set: string | number }>
    >`
      SELECT supervisor_consumer_cursor_set(
        ${supervisorId},
        ${cursorOffset}
      ) AS supervisor_consumer_cursor_set
    `;
    return Number(rows[0]?.supervisor_consumer_cursor_set ?? 0);
  }

  async setSupervisorWakeDispatchState(
    params: SupervisorWakeDispatchStateParams,
  ): Promise<SupervisorRegistryRow> {
    const rows = await this.sql<
      Array<{
        role: string;
        active_session_id: string | null;
        epoch: string | number;
        cursor_offset: string | number;
        handover_state: string;
        cumulative_tokens: string | number;
        compaction_count: string | number;
        last_seen_at: Date | null;
        wake_dispatch_state: string;
        wake_last_signature: string | null;
        wake_repeat_count: string | number;
        wake_blocked_reason: string | null;
        wake_blocked_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>
    >`
      SELECT * FROM supervisor_registry_set_wake_dispatch_state(
        ${params.role},
        ${params.state},
        ${params.lastSignature ?? null},
        ${params.repeatCount},
        ${params.blockedReason ?? null},
        ${params.blockedAt ?? null}
      )
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("supervisor_registry_set_wake_dispatch_state returned no row");
    }
    return mapSupervisorRegistryRow(row);
  }

  async upsertSupervisorRegistry(
    params: SupervisorRegistryUpsertParams,
  ): Promise<SupervisorRegistryRow> {
    const rows = await this.sql<
      Array<{
        role: string;
        active_session_id: string | null;
        epoch: string | number;
        cursor_offset: string | number;
        handover_state: string;
        cumulative_tokens: string | number;
        compaction_count: string | number;
        last_seen_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>
    >`
      SELECT * FROM supervisor_registry_upsert(
        ${params.role},
        ${params.activeSessionId},
        ${params.epoch},
        ${params.cursorOffset},
        ${params.handoverState},
        ${params.cumulativeTokens},
        ${params.compactionCount},
        ${params.lastSeenAt}
      )
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("supervisor_registry_upsert returned no row");
    }
    return mapSupervisorRegistryRow(row);
  }

  async getSupervisorRegistry(role: string): Promise<SupervisorRegistryRow | null> {
    const rows = await this.sql<
      Array<{
        role: string;
        active_session_id: string | null;
        epoch: string | number;
        cursor_offset: string | number;
        handover_state: string;
        cumulative_tokens: string | number;
        compaction_count: string | number;
        last_seen_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>
    >`
      SELECT * FROM supervisor_registry_get(${role})
    `;
    const row = rows[0];
    return row ? mapSupervisorRegistryRow(row) : null;
  }

  async listSupervisorRegistries(): Promise<SupervisorRegistryRow[]> {
    const rows = await this.sql<
      Array<{
        role: string;
        active_session_id: string | null;
        epoch: string | number;
        cursor_offset: string | number;
        handover_state: string;
        cumulative_tokens: string | number;
        compaction_count: string | number;
        last_seen_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>
    >`
      SELECT * FROM supervisor_registry_list()
    `;
    return rows.map((row) => mapSupervisorRegistryRow(row));
  }

  async touchSupervisorRegistry(
    role: string,
    lastSeenAt: Date,
  ): Promise<SupervisorRegistryRow | null> {
    const rows = await this.sql<
      Array<{
        role: string;
        active_session_id: string | null;
        epoch: string | number;
        cursor_offset: string | number;
        handover_state: string;
        cumulative_tokens: string | number;
        compaction_count: string | number;
        last_seen_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>
    >`
      SELECT * FROM supervisor_registry_touch(${role}, ${lastSeenAt})
    `;
    const row = rows[0];
    return row ? mapSupervisorRegistryRow(row) : null;
  }

  async recordSupervisorUsageDelta(params: {
    role: string;
    tokenDelta: number;
    compactionDelta?: number;
    lastSeenAt?: Date | null;
  }): Promise<SupervisorRegistryRow> {
    const rows = await this.sql<
      Array<{
        role: string;
        active_session_id: string | null;
        epoch: string | number;
        cursor_offset: string | number;
        handover_state: string;
        cumulative_tokens: string | number;
        compaction_count: string | number;
        last_seen_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>
    >`
      SELECT * FROM supervisor_registry_record_usage_delta(
        ${params.role},
        ${params.tokenDelta},
        ${params.compactionDelta ?? 0},
        ${params.lastSeenAt ?? null}
      )
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("supervisor_registry_record_usage_delta returned no row");
    }
    return mapSupervisorRegistryRow(row);
  }

  async deleteSupervisorRegistry(role: string): Promise<boolean> {
    const rows = await this.sql<Array<{ supervisor_registry_delete: boolean }>>`
      SELECT supervisor_registry_delete(${role}) AS supervisor_registry_delete
    `;
    return Boolean(rows[0]?.supervisor_registry_delete);
  }

  async appendClaudeTranscriptEntries(
    key: ClaudeTranscriptKey,
    entries: ClaudeTranscriptEntry[],
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const rows = await this.sql<{ claude_transcript_append: string | number }[]>`
      SELECT claude_transcript_append(
        ${key.projectKey},
        ${key.sessionId},
        ${normalizeTranscriptSubpath(key.subpath)},
        ${JSON.stringify(entries)},
        ${new Date()}
      ) AS claude_transcript_append
    `;
    return Number(rows[0]?.claude_transcript_append ?? 0);
  }

  async loadClaudeTranscriptEntries(
    key: ClaudeTranscriptKey,
  ): Promise<ClaudeTranscriptEntry[] | null> {
    const rows = await this.sql<Array<{ entry: unknown }>>`
      SELECT * FROM claude_transcript_load(
        ${key.projectKey},
        ${key.sessionId},
        ${normalizeTranscriptSubpath(key.subpath)}
      )
    `;
    if (rows.length === 0) return null;
    return rows
      .map((row) => row.entry)
      .filter(isClaudeTranscriptEntry);
  }

  async listClaudeTranscriptSessions(
    projectKey: string,
  ): Promise<ClaudeTranscriptSessionSummary[]> {
    const rows = await this.sql<Array<{ session_id: string; mtime: string | number }>>`
      SELECT * FROM claude_transcript_list_sessions(${projectKey})
    `;
    return rows.map((row) => ({
      sessionId: row.session_id,
      mtime: Number(row.mtime),
    }));
  }

  async listClaudeTranscriptSubkeys(
    key: Pick<ClaudeTranscriptKey, "projectKey" | "sessionId">,
  ): Promise<string[]> {
    const rows = await this.sql<Array<{ subpath: string }>>`
      SELECT * FROM claude_transcript_list_subkeys(${key.projectKey}, ${key.sessionId})
    `;
    return rows.map((row) => row.subpath);
  }

  async deleteClaudeTranscript(key: ClaudeTranscriptKey): Promise<void> {
    await this.sql`
      SELECT claude_transcript_delete(
        ${key.projectKey},
        ${key.sessionId},
        ${normalizeTranscriptSubpath(key.subpath)}
      )
    `;
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

function toIsoString(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toCatalogBoardItemRow(row: {
  id: string;
  folder_id: string;
  item_type: BoardItemType;
  item_id: string;
  x: string | number;
  y: string | number;
  metadata: unknown;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}): CatalogBoardItemRow {
  return {
    id: row.id,
    folderId: row.folder_id,
    itemType: row.item_type,
    itemId: row.item_id,
    x: Number(row.x),
    y: Number(row.y),
    metadata: isRecord(row.metadata) ? row.metadata : {},
    ...(toIsoString(row.created_at) ? { createdAt: toIsoString(row.created_at) } : {}),
    ...(toIsoString(row.updated_at) ? { updatedAt: toIsoString(row.updated_at) } : {}),
  };
}

function parseCatalogBoardItems(value: unknown): CatalogBoardItemRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = typeof item.id === "string" ? item.id : null;
    const folderId = typeof item.folderId === "string" ? item.folderId : null;
    const itemType = isBoardItemType(item.itemType) ? item.itemType : null;
    const itemId = typeof item.itemId === "string" ? item.itemId : null;
    if (!id || !folderId || !itemType || !itemId) return [];

    const x = Number(item.x);
    const y = Number(item.y);
    return [{
      id,
      folderId,
      itemType,
      itemId,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      metadata: isRecord(item.metadata) ? item.metadata : {},
      ...(toIsoString(typeof item.createdAt === "string" ? item.createdAt : null)
        ? { createdAt: toIsoString(typeof item.createdAt === "string" ? item.createdAt : null) }
        : {}),
      ...(toIsoString(typeof item.updatedAt === "string" ? item.updatedAt : null)
        ? { updatedAt: toIsoString(typeof item.updatedAt === "string" ? item.updatedAt : null) }
        : {}),
    }];
  });
}

function isBoardItemType(value: unknown): value is BoardItemType {
  return value === "session" ||
    value === "markdown" ||
    value === "subfolder" ||
    value === "asset";
}

function toMarkdownDocumentRow(row: {
  id: string;
  title: string;
  body: string;
  version?: string | number | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}): MarkdownDocumentRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    version: normalizeMarkdownVersion(row.version),
    ...(toIsoString(row.created_at) ? { createdAt: toIsoString(row.created_at) } : {}),
    ...(toIsoString(row.updated_at) ? { updatedAt: toIsoString(row.updated_at) } : {}),
  };
}

function normalizeTranscriptSubpath(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function isClaudeTranscriptEntry(value: unknown): value is ClaudeTranscriptEntry {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === "string"
  );
}
