import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

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
}

/**
 * fastify HTTP 서버 빌드. 본 B-1은 단일 엔드포인트만:
 * - `GET /health` → 노드 헬스 응답 (Haniel `ready: port:4205` 점검용)
 *
 * 외부 API(create_session 등)는 *없음* — 모든 통신은 orch WS reverse 채널을 통해 이루어진다.
 */
export async function buildServer(params: ServerParams): Promise<FastifyInstance> {
  // fastify 5 breaking change: pino 인스턴스는 `loggerInstance` 별 키로 받는다.
  // `logger` 키는 boolean 또는 config object만 허용 (fastify.d.ts L128-129 정본).
  // fastify 4 패턴 `logger: pinoInstance`는 `FST_ERR_LOG_INVALID_LOGGER_CONFIG` throw.
  const fastify = Fastify({
    loggerInstance: params.logger,
    disableRequestLogging: false,
  });

  fastify.get("/health", async () => ({
    status: "ok",
    node_id: params.nodeId,
    service: "soul-server-ts",
    phase: "B-1",
  }));

  return fastify;
}

export async function startServer(server: FastifyInstance, host: string, port: number): Promise<void> {
  await server.listen({ host, port });
}
