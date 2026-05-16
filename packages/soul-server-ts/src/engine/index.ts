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

export { CodexEngineAdapter, isCodexEngineRunning } from "./codex_adapter.js";
export type { CodexAdapterConfig } from "./codex_adapter.js";

export { mapThreadEvent } from "./codex_event_mapper.js";
