import type {
  Options as ClaudeSdkOptions,
  Query as ClaudeSdkQuery,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { ModelCatalogGetter } from "./claude_sdk_event_mapper.js";
import type {
  ClaudeDetachedEventSink,
  ClaudeRuntimeEventSink,
} from "./claude_sdk_persistent_session.js";

export type ClaudeSdkQueryParams = {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: ClaudeSdkOptions;
};

export type ClaudeSdkQueryFn = (params: ClaudeSdkQueryParams) => ClaudeSdkQuery;

export interface ClaudeSdkClientConfig {
  query?: ClaudeSdkQueryFn;
  inputRequestTimeoutMs?: number;
  /**
   * Result 메시지 도착 후 prompt_suggestion 1메시지를 기다리는 best-effort drain timeout.
   * 기본 2초 — Python `PROMPT_SUGGESTION_DRAIN_TIMEOUT` 정합. 테스트에서 가속용으로만 override.
   */
  postResultDrainMs?: number;
  /**
   * Result 이후 Claude runtime task/session이 idle로 settle되길 기다리는 안전 상한.
   * ScheduleWakeup 같은 장기 실행을 허용하되 프로세스가 영원히 붙잡히지는 않게 한다.
   */
  runtimeDrainMaxMs?: number;
  resolveClaudeExecutablePath?: () => string | undefined;
  detachedEventSink?: ClaudeDetachedEventSink;
  runtimeEventSink?: ClaudeRuntimeEventSink;
  /** Maximum gap between user-visible foreground activity frames. */
  persistentTurnInactivityTimeoutMs?: number;
  runtimeFollowupNoOutputTimeoutMs?: number;
  /** 내부 MCP 리스너를 기다리는 상한(ms). 시험에서만 줄인다. */
  internalMcpReadyTimeoutMs?: number;
  /** 내부 MCP 리스너 재확인 간격(ms). 시험에서만 줄인다. */
  internalMcpReadyIntervalMs?: number;
  getModelCatalog?: ModelCatalogGetter; // Read once per terminal result message.
}
