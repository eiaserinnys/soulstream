/**
 * SessionDB — worker persistence facade. Session/event/story reads cross the
 * orchestrator host boundary. Worker-local SQL remains only for the
 * board/markdown/custom-view/checklist surfaces in Phase 6 and the runtime
 * schema/index bootstrap scheduled for Phase 12.
 */

import postgres from "postgres";
import { projectSessionBindingWarnings } from "@soulstream/page-model";

import { DEFAULT_FOLDERS as SYSTEM_DEFAULT_FOLDERS } from "../system_folders.js";
import type { ScheduleHostClient } from "../schedule/schedule_host_client.js";
import type {
  SessionDataHost,
  SessionEventDetailRow,
  SessionEventRow,
  SessionEventSearchRow,
  SessionResumeContext,
  SessionTurnExcerptResult,
} from "../control_plane/session_data_host_client.js";
import type { SessionPageBindingRepository } from "../page/session_page_binding_repository.js";
import { ChecklistTaskProjectionRepository } from "../page/checklist_task_projection_repository.js";
import { BoardRepository } from "./repositories/board_repository.js";
import { BoardYjsRepository } from "./repositories/board_yjs_repository.js";
import type { FolderHostClient } from "../folder/folder_host_client.js";
import type { ClaudeTranscriptRepository } from "./repositories/claude_transcript_repository.js";
import type { ClaudeBackgroundTaskRepository } from "./repositories/claude_background_task_repository.js";
import { CustomViewRepository } from "./repositories/custom_view_repository.js";
import { EventRepository } from "./repositories/event_repository.js";
import { MarkdownDocumentRepository } from "./repositories/markdown_document_repository.js";
import { SessionRepository } from "./repositories/session_repository.js";
import {
  type SessionDigestSearchMatch,
  type SessionStoryTurnSummary,
  type SessionStoryView,
  type SessionSearchMetadata,
  type SessionTurnSummaryCounts,
} from "./session_story_types.js";
import type { SessionDeliveryRepository } from "./repositories/session_delivery_repository.js";
import { assertRuntimeSchemaReady } from "./runtime_schema_preflight.js";
import type { RepositorySql } from "./repositories/repository_helpers.js";
import type { AppendEventParams, BoardYjsContainerRef, BoardYjsContainerScope, CatalogBoardItemRow, CatalogFolderRow, CatalogSessionAssignmentRow, ClaudeTranscriptEntry, ClaudeTranscriptKey, ClaudeTranscriptSessionSummary, FolderRow, ListContainerItemsParams, ListContainerItemsResult, ListSessionSummaryRow, MarkdownDocumentRow, RunningSessionSummaryRow, SessionRow, SqlClient, TaskRow, TaskSnapshot, UpstreamSessionDumpRow } from "./session_db_types.js";

export type * from "./session_db_types.js";

/** 표시 이름 하위 호환 export. 기본 폴더 식별 정본은 system_folders.ts의 id 상수다. */
export const DEFAULT_FOLDERS = SYSTEM_DEFAULT_FOLDERS;

export class SessionDB {
  private readonly sql: SqlClient;
  private readonly ownsSql: boolean;
  private taskReader?: { getTask(taskId: string): Promise<TaskSnapshot | null> };
  private customViewRepository?: CustomViewRepository;
  private scheduleHost?: ScheduleHostClient;
  private sessionPageBindingRepository?: SessionPageBindingRepository;
  private checklistTaskProjectionRepository?: ChecklistTaskProjectionRepository;
  private sessionDeliveryRepository?: SessionDeliveryRepository;
  private claudeBackgroundTaskRepository?: ClaudeBackgroundTaskRepository;
  private readonly sessionRepository: SessionRepository;
  private sessionDataHost?: SessionDataHost;
  private readonly boardRepository: BoardRepository;
  private folderHost?: FolderHostClient;
  private readonly markdownDocumentRepository: MarkdownDocumentRepository;
  private readonly boardYjsRepository: BoardYjsRepository;
  private readonly eventRepository: EventRepository;
  private claudeTranscriptRepository?: ClaudeTranscriptRepository;

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

    this.sql = sql;
    this.ownsSql = ownsSql;

    this.sessionRepository = new SessionRepository(this.sql);
    this.boardRepository = new BoardRepository(this.sql);
    this.markdownDocumentRepository = new MarkdownDocumentRepository(this.sql);
    this.boardYjsRepository = new BoardYjsRepository(this.sql);
    this.eventRepository = new EventRepository(this.sql);
  }

  async close(): Promise<void> {
    if (this.ownsSql) await this.sql.end({ timeout: 5 });
  }
  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  async assertRuntimeSchemaReady(): Promise<void> {
    await assertRuntimeSchemaReady(this.sql);
  }

  async ensureStableSessionOrderIndex(): Promise<void> {
    await this.sessionRepository.ensureStableSessionOrderIndex();
  }

  configureTaskReader(reader: { getTask(taskId: string): Promise<TaskSnapshot | null> }): void {
    this.taskReader = reader;
  }

  tasks(): { getTask(taskId: string): Promise<TaskRow | null> } {
    if (!this.taskReader) throw new Error("task reader host is not configured");
    return {
      getTask: async (taskId) => (await this.taskReader!.getTask(taskId))?.task ?? null,
    };
  }

  customViews(): CustomViewRepository {
    this.customViewRepository ??= new CustomViewRepository(this.sql);
    return this.customViewRepository;
  }

  configureScheduleHost(host: ScheduleHostClient): void {
    this.scheduleHost = host;
  }

  configurePersistenceHosts(hosts: {
    deliveries: SessionDeliveryRepository;
    claudeRuntime: ClaudeBackgroundTaskRepository & ClaudeTranscriptRepository;
    sessionPageBindings: SessionPageBindingRepository;
    sessionData: SessionDataHost;
  }): void {
    this.configureSessionDeliveryHost(hosts.deliveries);
    this.configureClaudeBackgroundTaskHost(hosts.claudeRuntime);
    this.configureClaudeTranscriptHost(hosts.claudeRuntime);
    this.configureSessionPageBindingHost(hosts.sessionPageBindings);
    this.configureSessionDataHost(hosts.sessionData);
  }

  configureSessionDeliveryHost(host: SessionDeliveryRepository): void {
    this.sessionDeliveryRepository = host;
  }

  configureClaudeBackgroundTaskHost(host: ClaudeBackgroundTaskRepository): void {
    this.claudeBackgroundTaskRepository = host;
  }

  configureClaudeTranscriptHost(host: ClaudeTranscriptRepository): void {
    this.claudeTranscriptRepository = host;
  }

  configureSessionPageBindingHost(host: SessionPageBindingRepository): void {
    this.sessionPageBindingRepository = host;
  }

  configureSessionDataHost(host: SessionDataHost): void {
    this.sessionDataHost = host;
  }

  schedules(): ScheduleHostClient {
    if (!this.scheduleHost) throw new Error("schedule host is not configured");
    return this.scheduleHost;
  }

  sessionPageBindings(): SessionPageBindingRepository {
    if (!this.sessionPageBindingRepository) throw new Error("session page binding host is not configured");
    return this.sessionPageBindingRepository;
  }

  checklistTaskProjections(): ChecklistTaskProjectionRepository {
    this.checklistTaskProjectionRepository ??= new ChecklistTaskProjectionRepository(this.sql);
    return this.checklistTaskProjectionRepository;
  }

  sessionDeliveries(): SessionDeliveryRepository {
    if (!this.sessionDeliveryRepository) throw new Error("session delivery host is not configured");
    return this.sessionDeliveryRepository;
  }

  claudeBackgroundTasks(): ClaudeBackgroundTaskRepository {
    if (!this.claudeBackgroundTaskRepository) throw new Error("Claude runtime host is not configured");
    return this.claudeBackgroundTaskRepository;
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    return await this.requireSessionDataHost().getSession(sessionId);
  }

  async getSessionStory(sessionId: string): Promise<SessionStoryView> {
    return await this.requireSessionDataHost().getSessionStory(sessionId);
  }

  async getSessionSearchMetadata(
    sessionIds: string[],
  ): Promise<Map<string, SessionSearchMetadata>> {
    return await this.requireSessionDataHost().getSessionSearchMetadata(sessionIds);
  }

  async countTurnSummaries(sessionId: string): Promise<SessionTurnSummaryCounts> {
    return await this.requireSessionDataHost().countTurnSummaries(sessionId);
  }

  async loadTurnSummaryRange(
    sessionId: string,
    fromTurnNumber: number,
    toTurnNumber: number | null,
    limit: number,
  ): Promise<SessionStoryTurnSummary[]> {
    return await this.requireSessionDataHost().loadTurnSummaryRange(
      sessionId,
      fromTurnNumber,
      toTurnNumber,
      limit,
    );
  }

  async searchSessionDigests(
    query: string,
    sessionIds: string[] | null,
    limit: number,
    includeHighlight: boolean,
    includeStory: boolean,
  ): Promise<SessionDigestSearchMatch[]> {
    return await this.requireSessionDataHost().searchSessionDigests(
      query,
      sessionIds,
      limit,
      includeHighlight,
      includeStory,
    );
  }

  async assignSessionToFolder(
    sessionId: string,
    folderId: string | null,
  ): Promise<void> {
    await this.requireFolderHost().assignSessionToFolder(sessionId, folderId);
  }

  async getDefaultFolder(name: string): Promise<{ id: string; name: string } | null> {
    return await this.requireFolderHost().getDefaultFolder(name);
  }

  async getFolderById(folderId: string): Promise<FolderRow | null> {
    return await this.requireFolderHost().getFolderById(folderId);
  }

  async getCatalog(): Promise<{
    folders: CatalogFolderRow[];
    sessions: Record<string, { folderId: string | null; displayName: string | null }>;
    boardItems: CatalogBoardItemRow[];
  }> {
    return await this.requireFolderHost().getCatalog();
  }

  invalidateBoardYjsCatalogCache(container?: string | BoardYjsContainerRef | null): void {
    this.boardRepository.invalidateBoardYjsCatalogCache(container);
  }

  async getBoardItems(): Promise<CatalogBoardItemRow[]> {
    return await this.boardRepository.getBoardItems();
  }

  listContainerItems(params: ListContainerItemsParams): Promise<ListContainerItemsResult> {
    return this.boardRepository.listContainerItems(params);
  }

  async getBoardItemById(boardItemId: string): Promise<CatalogBoardItemRow | null> {
    return await this.boardRepository.getBoardItemById(boardItemId);
  }

  async getBoardItemIdsForSession(sessionId: string): Promise<string[]> {
    return await this.boardRepository.getBoardItemIdsForSession(sessionId);
  }

  async getPrimarySessionBoardItem(sessionId: string): Promise<CatalogBoardItemRow | null> {
    return await this.boardRepository.getPrimarySessionBoardItem(sessionId);
  }

  async getMarkdownDocumentBoardItem(documentId: string): Promise<CatalogBoardItemRow | null> {
    return await this.boardRepository.getMarkdownDocumentBoardItem(documentId);
  }

  async getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null> {
    return await this.markdownDocumentRepository.getMarkdownDocument(documentId);
  }

  async resolveBoardYjsContainerScope(
    container: string | BoardYjsContainerRef,
  ): Promise<BoardYjsContainerScope | null> {
    return await this.boardYjsRepository.resolveBoardYjsContainerScope(container);
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
    return await this.requireSessionDataHost().listSessionsSummary(params);
  }

  async listSessionsForUpstreamDump(params: {
    limit: number;
    offset: number;
    nodeId: string;
  }): Promise<{ sessions: UpstreamSessionDumpRow[]; total: number }> {
    const result = await this.requireSessionDataHost().listSessionsForUpstreamDump(params);
    const bindings = await this.sessionPageBindings().listForSessions(
      result.sessions.map((session) => session.session_id),
    );
    const bySession = new Map(bindings.map((binding) => [binding.session_id, binding]));
    return {
      ...result,
      sessions: result.sessions.map((session) => {
        const binding = bySession.get(session.session_id);
        return {
          ...session,
          binding_warnings: projectSessionBindingWarnings({
            pageState: binding?.page_state ?? null,
            legacyState: binding?.legacy_state ?? null,
          }),
        };
      }),
    };
  }

  async listRunningSessionsSummary(params: {
    limit: number;
    excludeSessionId?: string | null;
  }): Promise<{
    sessions: RunningSessionSummaryRow[];
    total: number;
  }> {
    return await this.requireSessionDataHost().listRunningSessionsSummary(params);
  }

  async getAllFolders(): Promise<FolderRow[]> {
    return await this.requireFolderHost().getAllFolders();
  }

  async getSessionAssignmentsByIds(
    sessionIds: readonly string[],
  ): Promise<CatalogSessionAssignmentRow[]> {
    return await this.requireFolderHost().getSessionAssignmentsByIds(sessionIds);
  }

  async countEvents(sessionId: string): Promise<number> {
    return await this.requireSessionDataHost().countEvents(sessionId);
  }

  async readEvents(
    sessionId: string,
    afterId: number,
    limit: number,
    eventTypes?: string[],
  ): Promise<SessionEventRow[]> {
    return await this.requireSessionDataHost().readEvents(sessionId, afterId, limit, eventTypes);
  }

  async readOneEvent(
    sessionId: string,
    eventId: number,
  ): Promise<SessionEventDetailRow | null> {
    return await this.requireSessionDataHost().readOneEvent(sessionId, eventId);
  }

  async streamEventsRaw(
    sessionId: string,
    afterId = 0,
  ): Promise<
    Array<{ id: number; event_type: string; payload_text: string }>
  > {
    return await this.requireSessionDataHost().streamEventsRaw(sessionId, afterId);
  }

  async createFolder(
    id: string,
    name: string,
    sortOrder: number,
    parentFolderId: string | null = null,
  ): Promise<void> {
    throw new Error(`folder creation must use identity host: ${id}:${name}:${sortOrder}:${parentFolderId ?? "root"}`);
  }

  async updateFolder(
    folderId: string,
    columns: ReadonlyArray<"name" | "sort_order" | "settings" | "parent_folder_id">,
    values: ReadonlyArray<string | null>,
  ): Promise<void> {
    await this.requireFolderHost().updateFolder(folderId, columns, values);
  }

  configureFolderHost(host: FolderHostClient): void {
    this.folderHost = host;
  }

  private requireFolderHost(): FolderHostClient {
    if (!this.folderHost) throw new Error("folder host is not configured");
    return this.folderHost;
  }

  async searchEvents(
    query: string,
    sessionIds: string[] | null,
    limit: number,
    eventTypes?: string[] | null,
  ): Promise<SessionEventSearchRow[]> {
    return await this.requireSessionDataHost().searchEvents(query, sessionIds, limit, eventTypes);
  }

  async searchEventsBySessionId(
    query: string,
    eventTypes: string[] | null,
    limit: number,
  ): Promise<SessionEventSearchRow[]> {
    return await this.requireSessionDataHost().searchEventsBySessionId(query, eventTypes, limit);
  }

  async getTurnExcerpt(
    sessionId: string,
    maxResponseChars = 500,
  ): Promise<SessionTurnExcerptResult> {
    return await this.requireSessionDataHost().getTurnExcerpt(sessionId, maxResponseChars);
  }

  async getResumeContext(
    sessionId: string,
    limit: number,
  ): Promise<SessionResumeContext> {
    return await this.requireSessionDataHost().getResumeContext(sessionId, limit);
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

  async appendClaudeTranscriptEntries(
    key: ClaudeTranscriptKey,
    entries: ClaudeTranscriptEntry[],
  ): Promise<number> {
    return await this.claudeTranscripts().appendClaudeTranscriptEntries(key, entries);
  }

  async loadClaudeTranscriptEntries(
    key: ClaudeTranscriptKey,
  ): Promise<ClaudeTranscriptEntry[] | null> {
    return await this.claudeTranscripts().loadClaudeTranscriptEntries(key);
  }

  async listClaudeTranscriptSessions(
    projectKey: string,
  ): Promise<ClaudeTranscriptSessionSummary[]> {
    return await this.claudeTranscripts().listClaudeTranscriptSessions(projectKey);
  }

  async listClaudeTranscriptSubkeys(
    key: Pick<ClaudeTranscriptKey, "projectKey" | "sessionId">,
  ): Promise<string[]> {
    return await this.claudeTranscripts().listClaudeTranscriptSubkeys(key);
  }

  async deleteClaudeTranscript(key: ClaudeTranscriptKey): Promise<void> {
    await this.claudeTranscripts().deleteClaudeTranscript(key);
  }

  private claudeTranscripts(): ClaudeTranscriptRepository {
    if (!this.claudeTranscriptRepository) throw new Error("Claude runtime host is not configured");
    return this.claudeTranscriptRepository;
  }

  private requireSessionDataHost(): SessionDataHost {
    if (!this.sessionDataHost) throw new Error("session data host is not configured");
    return this.sessionDataHost;
  }
}
