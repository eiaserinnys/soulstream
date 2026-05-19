/**
 * @seosoyoung/soul-ui - Shared Barrel
 *
 * 상수, 타입, 매퍼를 한 곳에서 재노출합니다.
 * 내부 도메인 타입은 types.ts가 이미 sse-events/session-types/tree-nodes/api-types/catalog-types/stream-events를 barrel합니다.
 */

// === Constants ===
export { SYSTEM_FOLDERS, DEFAULT_FOLDER_KEY, SSE_EVENT_TYPES } from "./constants";

// === Types (types.ts is itself a barrel) ===
export type {
  SSEEventType,
  ProgressEvent,
  MemoryEvent,
  SessionEvent,
  InterventionSentEvent,
  ContextItem,
  CallerInfo,
  UserMessageEvent,
  DebugEvent,
  CompleteEvent,
  ErrorEvent,
  ContextUsageEvent,
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
  ReconnectEvent,
  HistorySyncEvent,
  InputRequestQuestion,
  InputRequestEvent,
  InputRequestExpiredEvent,
  InputRequestRespondedEvent,
  AssistantMessageEvent,
  SoulSSEEvent,
  EventRecord,
  SessionStatus,
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
  ResultNode,
  CompactNode,
  CompleteNode,
  ErrorNode,
  InputRequestNodeDef,
  AssistantMessageNode,
  EventTreeNode,
  CreateSessionRequest,
  CreateSessionResponse,
  SendMessageRequest,
  InterveneResponse,
  SendRespondRequest,
  RespondResponse,
  SessionListResponse,
  ApiError,
  DashboardSSEEvent,
  SessionListStreamEvent,
  SessionCreatedStreamEvent,
  SessionUpdatedStreamEvent,
  SessionDeletedStreamEvent,
  SessionStreamEvent,
  FolderSettings,
  CatalogFolder,
  CatalogAssignment,
  CatalogState,
  CatalogUpdatedStreamEvent,
  MetadataEntry,
  MetadataUpdatedStreamEvent,
  AgentInfo,
  AgentProfile,
} from "./types";

// === Mappers ===
export { toSessionSummary } from "./mappers";
export { normalizeSessionStatus } from "./session-status";
