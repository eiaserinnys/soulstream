import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import type { McpAuthConfig } from "./mcp/auth.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { registerMcpRoutes } from "./mcp/transport.js";
import {
  registerCogitoSearchRoute,
  type CogitoSearchRouteConfig,
} from "./cogito/search_route.js";
import { registerLlmRoutes, type LlmRouteConfig } from "./llm/router.js";
import {
  registerBoardYjsRoutes,
  type BoardYjsRouteConfig,
} from "./collaboration/board_yjs_route.js";
import {
  registerBoardYjsHostRoutes,
  type BoardYjsHostRouteConfig,
} from "./collaboration/board_yjs_host_route.js";
import {
  registerRunbookHttpRoutes,
  type RunbookHttpRouteConfig,
} from "./runbook/runbook_http_route.js";
import {
  registerBoardItemHttpRoutes,
  type BoardItemHttpRouteConfig,
} from "./catalog/board_item_http_route.js";
import {
  registerMarkdownDocumentHttpRoutes,
  type MarkdownDocumentHttpRouteConfig,
} from "./catalog/markdown_document_http_route.js";

export interface ServerParams {
  host: string;
  port: number;
  nodeId: string;
  /**
   * fastify 5 호환 — pino `Logger`는 `FastifyBaseLogger`의 superset이므로 자동 narrowing.
   * 본 시그니처가 fastify의 default generic(`FastifyBaseLogger`) 추론을 허용하여
   * `FastifyInstance` 반환 타입과의 contravariance 충돌을 회피한다.
   */
  logger: FastifyBaseLogger;
  /**
   * MCP Streamable HTTP 라우트 mount 설정. 미지정 시 MCP 라우트 미등록.
   * MCP_ENABLED=true일 때 main.ts가 채워 전달.
   */
  mcp?: {
    runtime: McpRuntime;
    path: string;
    auth: McpAuthConfig;
  };
  /** Node-local cogito HTTP search route used by orchestrator fan-out. */
  cogito?: CogitoSearchRouteConfig;
  /** LLM proxy route 설정. 미지정 시 `/llm/completions` 미등록. */
  llm?: LlmRouteConfig;
  /** Board workspace Yjs collaboration route 설정. */
  boardYjs?: BoardYjsRouteConfig;
  /** Internal board host write route 설정. */
  boardYjsHost?: BoardYjsHostRouteConfig;
  /** Runbook dashboard write routes. */
  runbook?: RunbookHttpRouteConfig;
  /** Board item dashboard write routes. */
  boardItem?: BoardItemHttpRouteConfig;
  /** Markdown document dashboard write routes. */
  markdownDocument?: MarkdownDocumentHttpRouteConfig;
}

export type ServerInstance = FastifyInstance & {
  /** MCP 라우트 등록 시 채워지는 transport map cleanup. graceful shutdown에서 호출. */
  closeMcp?: () => Promise<void>;
};

/**
 * fastify HTTP 서버 빌드. `/health`는 초기 TS worker 이행기부터 유지된 엔드포인트다:
 * - `GET /health` → 노드 헬스 응답 (Haniel `ready: port:4205` 점검용)
 *
 * 외부 API(create_session 등)는 *없음* — 모든 통신은 orch WS reverse 채널을 통해 이루어진다.
 *
 * 본 카드(soul-server-ts Streamable HTTP MCP) 추가:
 * - `params.mcp` 지정 시 POST/GET/DELETE {path} 라우트 등록.
 */
export async function buildServer(params: ServerParams): Promise<ServerInstance> {
  // fastify 5 breaking change: pino 인스턴스는 `loggerInstance` 별 키로 받는다.
  // `logger` 키는 boolean 또는 config object만 허용 (fastify.d.ts L128-129 정본).
  // fastify 4 패턴 `logger: pinoInstance`는 `FST_ERR_LOG_INVALID_LOGGER_CONFIG` throw.
  const fastify: ServerInstance = Fastify({
    loggerInstance: params.logger,
    disableRequestLogging: false,
  });

  fastify.get("/health", async () => ({
    status: "ok",
    node_id: params.nodeId,
    service: "soul-server-ts",
    phase: "B-1",
  }));

  if (params.mcp) {
    fastify.closeMcp = registerMcpRoutes(fastify, params.mcp.runtime, {
      path: params.mcp.path,
      auth: params.mcp.auth,
    });
  }
  if (params.cogito) {
    registerCogitoSearchRoute(fastify, params.cogito);
  }
  if (params.llm) {
    registerLlmRoutes(fastify, params.llm);
  }
  if (params.boardYjs) {
    await registerBoardYjsRoutes(fastify, params.boardYjs);
  }
  if (params.boardYjsHost) {
    registerBoardYjsHostRoutes(fastify, params.boardYjsHost);
  }
  if (params.runbook) {
    registerRunbookHttpRoutes(fastify, params.runbook);
  }
  if (params.boardItem) {
    registerBoardItemHttpRoutes(fastify, params.boardItem);
  }
  if (params.markdownDocument) {
    registerMarkdownDocumentHttpRoutes(fastify, params.markdownDocument);
  }

  return fastify;
}

export async function startServer(server: FastifyInstance, host: string, port: number): Promise<void> {
  await server.listen({ host, port });
}
