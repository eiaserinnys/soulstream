import { projectSessionBindingWarnings } from "@soulstream/page-model";

import type { ScheduleHostClient } from "../schedule/schedule_host_client.js";
import type {
  SessionDataHost,
  SessionReadOptions,
  SessionReadOrder,
  SessionResumeContext,
  SessionTurnExcerptResult,
} from "../control_plane/session_data_host_client.js";
import type {
  CardReferenceLookupResult,
  GenerationCheckpointMaterial,
  GenerationCheckpointReadLimits,
  SessionEventDetailRow,
  SessionEventRow,
  SessionEventSearchRow,
  SessionHistorySearchParams,
  SessionHistorySearchResult,
  SessionReadPeriod,
  SupervisedCardSnapshot,
  SessionDigestSearchMatch,
  SessionStoryTurnSummary,
  SessionStoryView,
  SessionSearchMetadata,
  SessionTurnSummaryCounts,
} from "@soulstream/mcp-contract";
import type { FlatFolderContentHostClient } from "../catalog/flat_folder_content_host_client.js";
import type { FolderHostClient } from "../folder/folder_host_client.js";
import type { FolderService } from "../folder/folder_service.js";
import type { ClaudeRuntimeHostClient, SessionPageBindingHostClient, SessionDeliveryHostClient } from "../control_plane/persistence_host_clients.js";
import type { CatalogBoardItemRow, ListFolderItemsParams, ListFolderItemsResult, MarkdownDocumentRow } from "@soulstream/wire-schema/catalog";
import type { CatalogFolderRow, CatalogSessionAssignmentRow, FolderRow, ListSessionSummaryRow, RunningSessionSummaryRow, SessionExecutionChain, SessionOwnerNode, SessionRow, FolderSnapshot, UpstreamSessionDumpRow } from "./session_db_types.js";

export type * from "./session_db_types.js";

export class SessionDB {
  private folderReader?: Pick<FolderService, "getFolder" | "getCard">;
  private scheduleHost?: ScheduleHostClient;
  private sessionPageBindingHost?: SessionPageBindingHostClient;
  private folderContentHost?: FlatFolderContentHostClient;
  private sessionDeliveryHost?: SessionDeliveryHostClient;
  private claudeBackgroundTaskHost?: ClaudeRuntimeHostClient;
  private sessionDataHost?: SessionDataHost;
  private folderHost?: FolderHostClient;

  configureFolderReader(reader: Pick<FolderService, "getFolder" | "getCard">): void {
    this.folderReader = reader;
  }

  async getFolderSnapshot(folderId: string): Promise<FolderSnapshot | null> {
    if (!this.folderReader) throw new Error("folder reader host is not configured");
    return await this.folderReader.getFolder(folderId);
  }

  async getCard(cardId: string, actorSessionId?: string) {
    if (!this.folderReader) throw new Error("folder reader host is not configured");
    return await this.folderReader.getCard(cardId, actorSessionId);
  }

  configureScheduleHost(host: ScheduleHostClient): void {
    this.scheduleHost = host;
  }

  configurePersistenceHosts(hosts: {
    deliveries: SessionDeliveryHostClient;
    claudeRuntime: ClaudeRuntimeHostClient;
    sessionPageBindings: SessionPageBindingHostClient;
    sessionData: SessionDataHost;
  }): void {
    this.configureSessionDeliveryHost(hosts.deliveries);
    this.configureClaudeBackgroundTaskHost(hosts.claudeRuntime);
    this.configureSessionPageBindingHost(hosts.sessionPageBindings);
    this.configureSessionDataHost(hosts.sessionData);
  }

  configureSessionDeliveryHost(host: SessionDeliveryHostClient): void {
    this.sessionDeliveryHost = host;
  }

  configureClaudeBackgroundTaskHost(host: ClaudeRuntimeHostClient): void {
    this.claudeBackgroundTaskHost = host;
  }

  configureSessionPageBindingHost(host: SessionPageBindingHostClient): void {
    this.sessionPageBindingHost = host;
  }

  configureSessionDataHost(host: SessionDataHost): void {
    this.sessionDataHost = host;
  }

  configureFolderContentHost(host: FlatFolderContentHostClient): void {
    this.folderContentHost = host;
  }

  schedules(): ScheduleHostClient {
    if (!this.scheduleHost) throw new Error("schedule host is not configured");
    return this.scheduleHost;
  }

  sessionPageBindings(): SessionPageBindingHostClient {
    if (!this.sessionPageBindingHost) throw new Error("session page binding host is not configured");
    return this.sessionPageBindingHost;
  }


  sessionDeliveries(): SessionDeliveryHostClient {
    if (!this.sessionDeliveryHost) throw new Error("session delivery host is not configured");
    return this.sessionDeliveryHost;
  }

  claudeBackgroundTasks(): ClaudeRuntimeHostClient {
    if (!this.claudeBackgroundTaskHost) throw new Error("Claude runtime host is not configured");
    return this.claudeBackgroundTaskHost;
  }

  async getSession(
    sessionId: string,
    options?: SessionReadOptions,
  ): Promise<SessionRow | null> {
    // Keep forwarding a single argument unless the caller opted in, so every
    // other getSession path reaches the host exactly as before (card #1350).
    const host = this.requireSessionDataHost();
    return options === undefined
      ? await host.getSession(sessionId)
      : await host.getSession(sessionId, options);
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
    period?: SessionReadPeriod,
  ): Promise<SessionStoryTurnSummary[]> {
    const host = this.requireSessionDataHost();
    return period === undefined
      ? await host.loadTurnSummaryRange(sessionId, fromTurnNumber, toTurnNumber, limit)
      : await host.loadTurnSummaryRange(sessionId, fromTurnNumber, toTurnNumber, limit, period);
  }

  async searchSessionDigests(
    query: string,
    sessionIds: string[] | null,
    limit: number,
    includeHighlight: boolean,
    includeStory: boolean,
    signal?: AbortSignal,
  ): Promise<SessionDigestSearchMatch[]> {
    return await this.requireSessionDataHost().searchSessionDigests(
      query,
      sessionIds,
      limit,
      includeHighlight,
      includeStory,
      signal,
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
  }> {
    return await this.requireFolderHost().getCatalog();
  }

  async getBoardItems(): Promise<CatalogBoardItemRow[]> {
    return await this.requireFolderContentHost().getBoardItems();
  }

  async getBoardItemsByFolder(folderId: string): Promise<CatalogBoardItemRow[]> {
    return await this.requireFolderContentHost().getBoardItemsByFolder(folderId);
  }

  listFolderItems(params: ListFolderItemsParams): Promise<ListFolderItemsResult> {
    return this.requireFolderContentHost().listFolderItems(params);
  }

  async getBoardItemById(boardItemId: string): Promise<CatalogBoardItemRow | null> {
    return await this.requireFolderContentHost().getBoardItemById(boardItemId);
  }

  async getBoardItemIdsForSession(sessionId: string): Promise<string[]> {
    return await this.requireFolderContentHost().getBoardItemIdsForSession(sessionId);
  }

  async getPrimarySessionBoardItem(sessionId: string): Promise<CatalogBoardItemRow | null> {
    return await this.requireFolderContentHost().getPrimarySessionBoardItem(sessionId);
  }

  async getMarkdownDocumentBoardItem(documentId: string): Promise<CatalogBoardItemRow | null> {
    return await this.requireFolderContentHost().getMarkdownDocumentBoardItem(documentId);
  }

  async getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null> {
    return await this.requireFolderContentHost().getMarkdownDocument(documentId);
  }

  async listSessionsSummary(params: {
    search?: string | null;
    limit: number;
    offset: number;
    folderId?: string | null;
    nodeId?: string | null;
    period?: SessionReadPeriod;
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
    period?: SessionReadPeriod,
    metadataTypes?: string[],
    order?: SessionReadOrder,
  ): Promise<SessionEventRow[]> {
    return await this.requireSessionDataHost().readEvents(
      sessionId,
      afterId,
      limit,
      eventTypes,
      period,
      metadataTypes,
      order,
    );
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

  getAssignedCardContext(sessionId: string) { return this.requireFolderHost().getAssignedCardContext(sessionId); }
  getSupervisedCardContext(params: {
    sessionId: string;
    folderIds: string[] | null;
    cardLimit: number;
    questionLimit: number;
  }): Promise<SupervisedCardSnapshot> {
    return this.requireFolderHost().getSupervisedCardContext(params);
  }
  resolveCardReferences(refs: string[]): Promise<CardReferenceLookupResult[]> { return this.requireFolderHost().resolveCardReferences(refs); }

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
    signal?: AbortSignal,
  ): Promise<SessionEventSearchRow[]> {
    return await this.requireSessionDataHost().searchEvents(query, sessionIds, limit, eventTypes, signal);
  }

  async searchEventsBySessionId(
    query: string,
    eventTypes: string[] | null,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SessionEventSearchRow[]> {
    return await this.requireSessionDataHost().searchEventsBySessionId(query, eventTypes, limit, signal);
  }

  async searchSessionHistory(
    params: SessionHistorySearchParams,
    signal?: AbortSignal,
  ): Promise<SessionHistorySearchResult> {
    return await this.requireSessionDataHost().searchSessionHistory(params, signal);
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

  async getGenerationCheckpointMaterial(
    sessionId: string,
    limits: GenerationCheckpointReadLimits,
  ): Promise<GenerationCheckpointMaterial> {
    return await this.requireSessionDataHost().getGenerationCheckpointMaterial(sessionId, limits);
  }

  async getSessionCallerChain(sessionId: string): Promise<SessionExecutionChain> {
    return await this.requireSessionDataHost().getSessionCallerChain(sessionId);
  }

  async getSessionOwnerNode(sessionId: string): Promise<SessionOwnerNode | null> {
    return await this.requireSessionDataHost().getSessionOwnerNode(sessionId);
  }

  async listExistingSessionIds(sessionIds: string[]): Promise<string[]> {
    return await this.requireSessionDataHost().listExistingSessionIds(sessionIds);
  }

  private requireSessionDataHost(): SessionDataHost {
    if (!this.sessionDataHost) throw new Error("session data host is not configured");
    return this.sessionDataHost;
  }

  private requireFolderContentHost(): FlatFolderContentHostClient {
    if (!this.folderContentHost) throw new Error("folder content host is not configured");
    return this.folderContentHost;
  }
}
