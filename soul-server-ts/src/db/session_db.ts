/**
 * SessionDB — postgres.js 기반 stored procedure facade. Stored procedure DDL 정본은
 * `packages/db-schema/sql/schema.sql`이고, 외부 호출자는 기존처럼 `SessionDB`를 사용한다.
 */

import postgres from "postgres";

import { DEFAULT_FOLDERS as SYSTEM_DEFAULT_FOLDERS } from "../system_folders.js";
import { RunbookRepository } from "../runbook/runbook_repository.js";
import { SoulstreamScheduleRepository } from "../schedule/schedule_repository.js";
import { TaskTreeRepository } from "../task_tree/task_tree_repository.js";
import { BoardRepository } from "./repositories/board_repository.js";
import { BoardYjsRepository } from "./repositories/board_yjs_repository.js";
import { CatalogRepository } from "./repositories/catalog_repository.js";
import { ClaudeTranscriptRepository } from "./repositories/claude_transcript_repository.js";
import { CustomViewRepository } from "./repositories/custom_view_repository.js";
import { EventRepository } from "./repositories/event_repository.js";
import { MarkdownDocumentRepository } from "./repositories/markdown_document_repository.js";
import { SessionRepository } from "./repositories/session_repository.js";
import type { RepositorySql } from "./repositories/repository_helpers.js";
import type { AcknowledgeReviewOutcome, AppendEventParams, BoardYjsContainerRef, BoardYjsContainerScope, BoardYjsReplica, BoardYjsSeed, CatalogBoardItemRow, CatalogFolderRow, ClaudeTranscriptEntry, ClaudeTranscriptKey, ClaudeTranscriptSessionSummary, FolderRow, LastMessageRow, ListSessionSummaryRow, MarkdownDocumentRow, RegisterSessionParams, RunningSessionSummaryRow, SessionRow, SessionUpdateFields, SqlClient, UpstreamSessionDumpRow } from "./session_db_types.js";
import { SupervisorSessionDbFacade } from "./supervisor_session_db_facade.js";

export type * from "./session_db_types.js";

/** 표시 이름 하위 호환 export. 기본 폴더 식별 정본은 system_folders.ts의 id 상수다. */
export const DEFAULT_FOLDERS = SYSTEM_DEFAULT_FOLDERS;

export class SessionDB extends SupervisorSessionDbFacade {
  private readonly sql: SqlClient;
  private readonly ownsSql: boolean;
  private runbookRepository?: RunbookRepository;
  private customViewRepository?: CustomViewRepository;
  private taskTreeRepository?: TaskTreeRepository;
  private scheduleRepository?: SoulstreamScheduleRepository;
  private readonly sessionRepository: SessionRepository;
  private readonly boardRepository: BoardRepository;
  private readonly catalogRepository: CatalogRepository;
  private readonly markdownDocumentRepository: MarkdownDocumentRepository;
  private readonly boardYjsRepository: BoardYjsRepository;
  private readonly eventRepository: EventRepository;
  private readonly claudeTranscriptRepository: ClaudeTranscriptRepository;

  /** @param sqlOrUrl `postgres()` 인스턴스 또는 DATABASE_URL 문자열. 문자열이면 close 시 end. */
  constructor(sqlOrUrl: SqlClient | string) {
    let sql: SqlClient;
    let ownsSql: boolean;
    if (typeof sqlOrUrl === "string") {
      sql = postgres(sqlOrUrl, {
        max: 10,
        idle_timeout: 60,
      });
      ownsSql = true;
    } else {
      sql = sqlOrUrl;
      ownsSql = false;
    }

    super(sql);
    this.sql = sql;
    this.ownsSql = ownsSql;

    this.sessionRepository = new SessionRepository(this.sql);
    this.boardRepository = new BoardRepository(this.sql);
    this.catalogRepository = new CatalogRepository(this.sql, this.boardRepository);
    this.markdownDocumentRepository = new MarkdownDocumentRepository(this.sql);
    this.boardYjsRepository = new BoardYjsRepository(this.sql, this.boardRepository);
    this.eventRepository = new EventRepository(this.sql);
    this.claudeTranscriptRepository = new ClaudeTranscriptRepository(this.sql);
  }

  async close(): Promise<void> {
    if (this.ownsSql) await this.sql.end({ timeout: 5 });
  }

  /** Lightweight liveness probe for runtime reflection. */
  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  async ensureStableSessionOrderIndex(): Promise<void> {
    await this.sessionRepository.ensureStableSessionOrderIndex();
  }

  taskTree(): TaskTreeRepository {
    this.taskTreeRepository ??= new TaskTreeRepository(this.sql);
    return this.taskTreeRepository;
  }

  runbooks(): RunbookRepository {
    this.runbookRepository ??= new RunbookRepository(this.sql);
    return this.runbookRepository;
  }

  customViews(): CustomViewRepository {
    this.customViewRepository ??= new CustomViewRepository(this.sql);
    return this.customViewRepository;
  }

  schedules(): SoulstreamScheduleRepository {
    this.scheduleRepository ??= new SoulstreamScheduleRepository(this.sql);
    return this.scheduleRepository;
  }

  async registerSession(params: RegisterSessionParams): Promise<void> {
    await this.sessionRepository.registerSession(params);
  }

  async updateSession(
    sessionId: string,
    fields: SessionUpdateFields,
  ): Promise<void> {
    await this.sessionRepository.updateSession(sessionId, fields);
  }

  async acknowledgeSessionReview(
    sessionId: string,
  ): Promise<AcknowledgeReviewOutcome> {
    return await this.sessionRepository.acknowledgeSessionReview(sessionId);
  }

  async interruptRunningSessionsForNode(nodeId: string): Promise<number> {
    return await this.sessionRepository.interruptRunningSessionsForNode(nodeId);
  }

  async setClaudeSessionId(
    sessionId: string,
    claudeSessionId: string,
  ): Promise<void> {
    await this.sessionRepository.setClaudeSessionId(sessionId, claudeSessionId);
  }

  async updateLastMessage(
    sessionId: string,
    lastMessage: LastMessageRow,
  ): Promise<void> {
    await this.sessionRepository.updateLastMessage(sessionId, lastMessage);
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    return await this.sessionRepository.getSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.sessionRepository.deleteSession(sessionId);
  }

  async appendMetadata(
    sessionId: string,
    entry: Record<string, unknown>,
  ): Promise<number> {
    return await this.sessionRepository.appendMetadata(sessionId, entry);
  }

  async assignSessionToFolder(
    sessionId: string,
    folderId: string | null,
  ): Promise<void> {
    await this.catalogRepository.assignSessionToFolder(sessionId, folderId);
  }

  async getDefaultFolder(name: string): Promise<{ id: string; name: string } | null> {
    return await this.catalogRepository.getDefaultFolder(name);
  }

  async getFolderById(
    folderId: string,
  ): Promise<FolderRow | null> {
    return await this.catalogRepository.getFolderById(folderId);
  }

  async getCatalog(): Promise<{
    folders: CatalogFolderRow[];
    sessions: Record<string, { folderId: string | null; displayName: string | null }>;
    boardItems: CatalogBoardItemRow[];
  }> {
    return await this.catalogRepository.getCatalog();
  }

  invalidateBoardYjsCatalogCache(container?: string | BoardYjsContainerRef | null): void {
    this.boardRepository.invalidateBoardYjsCatalogCache(container);
  }

  async ensureBoardItems(): Promise<void> {
    await this.boardRepository.ensureBoardItems();
  }

  async getBoardItems(): Promise<CatalogBoardItemRow[]> {
    return await this.boardRepository.getBoardItems();
  }

  async getBoardItemById(boardItemId: string): Promise<CatalogBoardItemRow | null> {
    return await this.boardRepository.getBoardItemById(boardItemId);
  }

  async getPrimarySessionBoardItem(sessionId: string): Promise<CatalogBoardItemRow | null> {
    return await this.boardRepository.getPrimarySessionBoardItem(sessionId);
  }

  async getMarkdownDocumentBoardItem(documentId: string): Promise<CatalogBoardItemRow | null> {
    return await this.boardRepository.getMarkdownDocumentBoardItem(documentId);
  }

  async updateBoardItemPosition(
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void> {
    await this.boardRepository.updateBoardItemPosition(boardItemId, x, y);
  }

  async createMarkdownDocument(params: {
    documentId: string;
    folderId: string;
    container?: BoardYjsContainerRef | null;
    title: string;
    body: string;
    x: number;
    y: number;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
    return await this.markdownDocumentRepository.createMarkdownDocument(params);
  }

  async getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null> {
    return await this.markdownDocumentRepository.getMarkdownDocument(documentId);
  }

  async updateMarkdownDocument(
    documentId: string,
    fields: { title?: string; body?: string; expectedVersion: number },
  ): Promise<MarkdownDocumentRow | null> {
    return await this.markdownDocumentRepository.updateMarkdownDocument(documentId, fields);
  }

  async deleteMarkdownDocument(documentId: string): Promise<void> {
    await this.markdownDocumentRepository.deleteMarkdownDocument(documentId);
  }

  async getBoardYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    return await this.boardYjsRepository.getBoardYjsSnapshot(documentName);
  }

  async storeBoardYjsSnapshot(
    documentName: string,
    snapshot: Uint8Array,
  ): Promise<void> {
    await this.boardYjsRepository.storeBoardYjsSnapshot(documentName, snapshot);
  }

  async appendBoardYjsUpdate(
    documentName: string,
    update: Uint8Array,
  ): Promise<void> {
    await this.boardYjsRepository.appendBoardYjsUpdate(documentName, update);
  }

  async getBoardYjsUpdates(documentName: string): Promise<Uint8Array[]> {
    return await this.boardYjsRepository.getBoardYjsUpdates(documentName);
  }

  async backfillRunbookBoardItemsIntoBoardYjsSnapshot(
    documentName: string,
    container: string | BoardYjsContainerRef,
    snapshot: Uint8Array,
  ): Promise<Uint8Array> {
    return await this.boardYjsRepository.backfillRunbookBoardItemsIntoSnapshot(
      documentName,
      container,
      snapshot,
    );
  }

  async resolveBoardYjsContainerScope(
    container: string | BoardYjsContainerRef,
  ): Promise<BoardYjsContainerScope | null> {
    return await this.boardYjsRepository.resolveBoardYjsContainerScope(container);
  }

  async markBoardYjsDocumentSynced(documentName: string): Promise<void> {
    await this.boardYjsRepository.markBoardYjsDocumentSynced(documentName);
  }

  async loadBoardYjsSeed(container: string | BoardYjsContainerRef): Promise<BoardYjsSeed> {
    return await this.boardYjsRepository.loadBoardYjsSeed(container);
  }

  async syncBoardYjsReplica(
    container: string | BoardYjsContainerRef,
    replica: BoardYjsReplica,
    documentName?: string,
  ): Promise<void> {
    await this.boardYjsRepository.syncBoardYjsReplica(container, replica, documentName);
  }

  async renameSession(
    sessionId: string,
    displayName: string | null,
  ): Promise<void> {
    await this.sessionRepository.renameSession(sessionId, displayName);
  }

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
    return await this.sessionRepository.listSessionsSummary(params);
  }

  async listSessionsForUpstreamDump(params: {
    limit: number;
    offset: number;
    nodeId: string;
  }): Promise<{ sessions: UpstreamSessionDumpRow[]; total: number }> {
    return await this.sessionRepository.listSessionsForUpstreamDump(params);
  }

  async listRunningSessionsSummary(params: {
    limit: number;
    excludeSessionId?: string | null;
  }): Promise<{
    sessions: RunningSessionSummaryRow[];
    total: number;
  }> {
    return await this.sessionRepository.listRunningSessionsSummary(params);
  }

  async getAllFolders(): Promise<FolderRow[]> {
    return await this.catalogRepository.getAllFolders();
  }

  async countEvents(sessionId: string): Promise<number> {
    return await this.eventRepository.countEvents(sessionId);
  }

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
    return await this.eventRepository.readEvents(sessionId, afterId, limit, eventTypes);
  }

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
    return await this.eventRepository.readOneEvent(sessionId, eventId);
  }

  async streamEventsRaw(
    sessionId: string,
    afterId = 0,
  ): Promise<
    Array<{ id: number; event_type: string; payload_text: string }>
  > {
    return await this.eventRepository.streamEventsRaw(sessionId, afterId);
  }

  async createFolder(
    id: string,
    name: string,
    sortOrder: number,
    parentFolderId: string | null = null,
  ): Promise<void> {
    await this.catalogRepository.createFolder(id, name, sortOrder, parentFolderId);
  }

  async updateFolder(
    folderId: string,
    columns: ReadonlyArray<"name" | "sort_order" | "settings" | "parent_folder_id">,
    values: ReadonlyArray<string | null>,
  ): Promise<void> {
    await this.catalogRepository.updateFolder(folderId, columns, values);
  }

  async deleteFolderById(folderId: string): Promise<void> {
    await this.catalogRepository.deleteFolderById(folderId);
  }

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
    return await this.eventRepository.searchEvents(query, sessionIds, limit, eventTypes);
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
    return await this.eventRepository.searchEventsBySessionId(query, eventTypes, limit);
  }

  async appendEvent(params: AppendEventParams): Promise<number> {
    return await this.eventRepository.appendEvent(params);
  }

  async appendEventTx(
    sql: RepositorySql,
    params: AppendEventParams,
  ): Promise<number> {
    return await this.eventRepository.appendEventTx(sql, params);
  }

  async findEventIdByDedupeKey(
    sessionId: string,
    dedupeKey: string,
  ): Promise<number | null> {
    return await this.eventRepository.findEventIdByDedupeKey(sessionId, dedupeKey);
  }

  async appendClaudeTranscriptEntries(
    key: ClaudeTranscriptKey,
    entries: ClaudeTranscriptEntry[],
  ): Promise<number> {
    return await this.claudeTranscriptRepository.appendClaudeTranscriptEntries(key, entries);
  }

  async loadClaudeTranscriptEntries(
    key: ClaudeTranscriptKey,
  ): Promise<ClaudeTranscriptEntry[] | null> {
    return await this.claudeTranscriptRepository.loadClaudeTranscriptEntries(key);
  }

  async listClaudeTranscriptSessions(
    projectKey: string,
  ): Promise<ClaudeTranscriptSessionSummary[]> {
    return await this.claudeTranscriptRepository.listClaudeTranscriptSessions(projectKey);
  }

  async listClaudeTranscriptSubkeys(
    key: Pick<ClaudeTranscriptKey, "projectKey" | "sessionId">,
  ): Promise<string[]> {
    return await this.claudeTranscriptRepository.listClaudeTranscriptSubkeys(key);
  }

  async deleteClaudeTranscript(key: ClaudeTranscriptKey): Promise<void> {
    await this.claudeTranscriptRepository.deleteClaudeTranscript(key);
  }
}
