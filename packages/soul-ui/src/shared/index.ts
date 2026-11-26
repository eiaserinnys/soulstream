/**
 * @seosoyoung/soul-ui - Shared Barrel
 *
 * 상수, 타입, 매퍼를 한 곳에서 재노출합니다.
 * 내부 도메인 타입은 types.ts가 이미 sse-events/session-types/tree-nodes/api-types/catalog-types/stream-events를 barrel합니다.
 */

// === Constants ===
export {
  SYSTEM_FOLDER_IDS,
  DEFAULT_FOLDER_KEY,
  DEFAULT_FOLDER_ID,
  isSystemFolderId,
  SSE_EVENT_TYPES,
} from "./constants";
export type { SystemFolderKey, SystemFolderId } from "./constants";
export { fetchNodeModelPresets } from "./model-presets";
export { fetchSessionStory } from "./session-story-api";
export type { SessionStory } from "./session-story-api";
export { resolveSearchChatFocus } from "./search-focus";
export type { ChatFocusTarget, SearchChatFocus } from "./search-focus";

// === Types (types.ts is itself a barrel) ===
export type {
  ProgressEvent,
  SessionEvent,
  InterventionSentEvent,
  UserMessageEvent,
  DebugEvent,
  CompleteEvent,
  ErrorEvent,
  ContextUsageEvent,
  ContextManifestEvent,
  CompactEvent,
  ThinkingEvent,
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ToolStartEvent,
  ToolResultEvent,
  ResultEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  HistorySyncEvent,
  InputRequestQuestion,
  InputRequestEvent,
  InputRequestExpiredEvent,
  InputRequestRespondedEvent,
  AssistantMessageEvent,
  SoulSSEEvent,
  EventRecord,
  LlmUsage,
  SessionSummary,
  SessionDetail,
  EventTreeNodeType,
  SessionNode,
  UserMessageNode,
  InterventionNode,
  ThinkingNode,
  TextNode,
  ToolNode,
  TokenUsage,
  ResultNode,
  CompactNode,
  CompleteNode,
  ErrorNode,
  InputRequestNodeDef,
  AssistantMessageNode,
  EventTreeNode,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionCreationWarning,
  SendMessageRequest,
  InterveneResponse,
  SendRespondRequest,
  RespondResponse,
  SessionListResponse,
  ApiError,
  SessionListStreamEvent,
  SessionCreatedStreamEvent,
  SessionUpdatedStreamEvent,
  SessionDeletedStreamEvent,
  PageUpdatedStreamEvent,
  SessionStreamEvent,
  FolderSettings,
  CatalogFolder,
  CatalogFolderReorderItem,
  CatalogBoardItemsDelta,
  BoardContainerRef,
  CatalogBoardItem,
  CatalogBoardItemType,
  CustomViewDocument,
  MarkdownDocument,
  CatalogState,
  CatalogUpdatedStreamEvent,
  MetadataEntry,
  AgentInfo,
  AgentProfile,
} from "./types";

// === Mappers ===
export { toSessionSummary } from "./mappers";
export { applyCatalogSessionDisplayName } from "./session-projections";
export { normalizeSessionStatus } from "./session-status";
export {
  compareSessionActivityDesc,
  getSessionActivityMs,
  getSessionActivityTimestamp,
  normalizeLastMessage,
} from "./session-activity";
export type {
  NormalizedLastMessage,
  ReadableMessageType,
} from "./session-activity";
