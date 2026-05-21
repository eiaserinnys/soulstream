/**
 * McpRuntime — MCP 도구 핸들러가 의존하는 런타임 객체 집합.
 *
 * 도구 모듈은 *이 인터페이스*에만 의존하여 main.ts wiring과 절연 (design-principles §1 깊이).
 * 테스트는 fake runtime을 주입하여 도구 동작만 검증.
 */
import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { CatalogService } from "../catalog/catalog_service.js";
import type { SessionDB } from "../db/session_db.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";

export interface OrchProxyConfig {
  /** http[s]://host[:port] base. ws→http 변환 후. */
  baseUrl: string;
  /** AUTH_BEARER_TOKEN을 포함한 추가 헤더. */
  headers: Record<string, string>;
}

export interface McpRuntime {
  nodeId: string;
  agentsConfigPath: string;
  db: SessionDB;
  taskManager: TaskManager;
  taskExecutor: TaskExecutor;
  agentRegistry: AgentRegistry;
  catalogService: CatalogService;
  logger: Logger;
  /** 미설정 시 multi-node 도구는 등록되되 호출 시 `{error: ...}` 반환. */
  orch?: OrchProxyConfig;
}
