/**
 * Engine 모듈 — 백엔드-중립 어댑터 layer.
 *
 * Phase B-2: TS EnginePort interface + CodexEngineAdapter.
 * 후속 ClaudeEngineAdapter 추가 시 본 index에서 함께 re-export.
 */

export type {
  BackendId,
  CompactCallback,
  EngineExecuteParams,
  EnginePort,
  EventCallback,
  InterventionCallback,
  ProgressCallback,
  SessionCallback,
  SSEEventPayload,
  SupportsCompact,
  SupportsThreadFork,
} from "./protocol.js";

export { CodexEngineAdapter } from "./codex_adapter.js";
export type { CodexAdapterConfig } from "./codex_adapter.js";
export { ClaudeEngineAdapter, ClaudeSdkClient } from "./claude_adapter.js";
export type {
  ClaudeAdapterConfig,
  ClaudeClient,
  ClaudeClientEvent,
  ClaudeRunOptions,
} from "./claude_adapter.js";
export type { ClaudeSdkClientConfig, ClaudeSdkQueryFn } from "./claude_sdk_client.js";
export { AgentsEngineAdapter } from "./agents_adapter.js";
export type { AgentsAdapterConfig } from "./agents_adapter.js";
export {
  AppServerRpcError,
  buildCodexAppServerArgs,
  CODEX_APP_SERVER_METHODS,
  CODEX_APP_SERVER_PROTOCOL_SOURCE,
  CodexAppServerClient,
  createStdioAppServerTransport,
  JsonRpcAppServerClient,
  toCodexUserInput,
} from "./codex_app_server/index.js";
export type {
  AppServerJsonMessage,
  AppServerNotification,
  AppServerRequestId,
  AppServerServerRequest,
  AppServerThread,
  AppServerTransport,
  AppServerTransportLogger,
  AppServerTransportUrl,
  AppServerTurn,
  AppServerUserInput,
  CodexAppServerMethod,
  CodexAppServerMethodMap,
  CodexAppServerRequest,
  InitializeParams,
  InitializeResponse,
  JsonRpcAppServerClientOptions,
  StdioAppServerTransportOptions,
  StdioSpawnProcess,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "./codex_app_server/index.js";

export { mapThreadEvent } from "./codex_event_mapper.js";
export { mapClaudeClientEvent } from "./claude_event_mapper.js";
export { mapAgentsGuardrailError, mapAgentsRunStreamEvent } from "./agents_event_mapper.js";
